import express from "express";
import mongoose from "mongoose";
import User from "../models/user.js";
import Task from "../models/task.js";
import {
  ok, created, badRequest, notFound,
  parseJsonParam, sanitizeSelect, parseNonNegInt,
  toIdStr, toIdStrArray,
} from "./_shared.js";

const router = express.Router();

/* ----------------- helpers: query builders ----------------- */
function buildFindQuery(req) {
  const where = parseJsonParam("where", req.query.where, {});
  return where || {};
}
function buildSort(req) {
  return parseJsonParam("sort", req.query.sort, undefined);
}
function buildSelect(req) {
  // 兼容老脚本的 filter= 作为 select 的别名
  const sel = parseJsonParam(
    "select",
    req.query.select,
    parseJsonParam("filter", req.query.filter, undefined)
  );
  return sanitizeSelect(sel);
}
function parsePagination(req, { defaultLimit = null } = {}) {
  const skip = parseNonNegInt("skip", req.query.skip, 0);
  const limit = parseNonNegInt("limit", req.query.limit, defaultLimit);
  return { skip, limit };
}

/* ------------------------- ROUTES -------------------------- */

// GET /api/users  — where/sort/select/skip/limit/count
router.get("/", async (req, res, next) => {
  try {
    const where = buildFindQuery(req);
    const sort = buildSort(req);
    const select = buildSelect(req);
    const countOnly = String(req.query.count).toLowerCase() === "true";
    const { skip, limit } = parsePagination(req, { defaultLimit: null }); // users 默认不限

    if (countOnly) {
      const c = await User.countDocuments(where);
      return ok(res, c);
    }

    const q = User.find(where);
    if (sort) q.sort(sort);
    if (select) q.select(select);
    q.skip(skip);                     // 显式调用，哪怕是 0
    if (limit != null) q.limit(limit);

    const data = await q.lean();
    return ok(res, data);
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    return next(e);
  }
});

// POST /api/users  — 必填 name/email；email 唯一
router.post("/", async (req, res, next) => {
  try {
    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const u = await User.create({
      name,
      email,
      pendingTasks: Array.isArray(req.body.pendingTasks)
        ? req.body.pendingTasks.map(String)
        : [],
    });
    return created(res, u.toObject());
  } catch (e) {
    if (e?.code === 11000) return badRequest(res, "email already exists");
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

// GET /api/users/:id — 支持 select；非法/不存在 → 404
router.get("/:id", async (req, res, next) => {
  try {
    const select = buildSelect(req);
    const q = User.findById(req.params.id);
    if (select) q.select(select);
    const u = await q.lean();
    if (!u) return notFound(res, "user not found");
    return ok(res, u);
  } catch (e) {
    if (e?.name === "CastError") return notFound(res, "user not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

// PUT /api/users/:id — full replace；同步任务；改名同步 assignedUserName
router.put("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return notFound(res, "user not found");
    }

    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, "user not found");

    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const oldName = user.name;
    const oldSet = new Set((user.pendingTasks || []).map((x) => String(x)));
    const nowIds =
      req.body.pendingTasks !== undefined ? toIdStrArray(req.body.pendingTasks) : null;

    // 不得把“已完成任务”加入 pendingTasks
    if (nowIds && nowIds.length) {
      const doneIds = await Task.find({
        _id: { $in: nowIds },
        completed: true,
      }).distinct("_id");
      if (doneIds.length) {
        return badRequest(
          res,
          `cannot add completed tasks to pendingTasks: ${doneIds.map(String).join(",")}`
        );
      }
    }

    // 保存用户本体
    user.name = name;
    user.email = email;
    if (nowIds) user.pendingTasks = nowIds;
    await user.save();

    // 双向维护
    if (nowIds) {
      const added = nowIds.filter((x) => !oldSet.has(x));
      const removed = [...oldSet].filter((x) => !nowIds.includes(x));

      if (added.length) {
        await Task.updateMany(
          { _id: { $in: added }, completed: { $ne: true } },
          { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
        );
      }
      if (removed.length) {
        await Task.updateMany(
          { _id: { $in: removed }, assignedUser: String(user._id) },
          { $set: { assignedUser: "", assignedUserName: "unassigned" } }
        );
      }
    }

    // 改名 → 同步其所有任务的 assignedUserName
    if (oldName !== name) {
      await Task.updateMany(
        { assignedUser: String(user._id) },
        { $set: { assignedUserName: name } }
      );
    }

    return ok(res, user.toObject(), "Updated");
  } catch (e) {
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    if (e?.code === 11000) return badRequest(res, "email already exists");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

// DELETE /api/users/:id — 将其所有任务设为未指派
router.delete("/:id", async (req, res, next) => {
  try {
    const u = await User.findById(req.params.id);
    if (!u) return notFound(res, "user not found");

    await User.deleteOne({ _id: u._id });
    await Task.updateMany(
      { assignedUser: String(u._id) },
      { $set: { assignedUser: "", assignedUserName: "unassigned" } }
    );

    return ok(res, { _id: String(u._id) }, "Deleted");
  } catch (e) {
    if (e?.name === "CastError") return notFound(res, "user not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

export default router;
