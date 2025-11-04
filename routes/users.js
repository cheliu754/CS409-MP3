// routes/users.js
import express from "express";
import mongoose from "mongoose";
import User from "../models/user.js";
import Task from "../models/task.js";

const router = express.Router();

/* ---------- helpers: responses ---------- */
const json = (res, code, data = null, message = "OK") =>
  res.status(code).json({ message, data });

const ok = (res, data, message = "OK") => json(res, 200, data, message);
const created = (res, data, message = "Created") => json(res, 201, data, message);
const badRequest = (res, message = "Bad Request", data = null) =>
  json(res, 400, data, message);
const notFound = (res, message = "Not Found") => json(res, 404, null, message);

/* ---------- helpers ---------- */
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id); // 仅用于“请求体”字段
const toIdStr = (v) => (v ? String(v) : "");
const toIdStrArray = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x)) : []);
const bad400 = (msg) => {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
};

function parseJsonParam(name, raw, fallback) {
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error(`Invalid JSON for '${name}'`);
    err.statusCode = 400;
    throw err;
  }
}
function sanitizeSelect(sel) {
  if (!sel) return undefined;
  const entries = Object.entries(sel);
  if (entries.length === 0) return undefined;
  const isInc = entries.some(([, v]) => v === 1 || v === true);
  const isExc = entries.some(([, v]) => v === 0 || v === false);
  if (isInc && isExc) {
    const { _id, ...rest } = sel;
    const restHasExc = Object.values(rest).some((v) => v === 0 || v === false);
    if (restHasExc) {
      const err = new Error("select cannot mix include and exclude");
      err.statusCode = 400;
      throw err;
    }
  }
  return sel;
}

function parsePagination(req, { defaultLimit = null } = {}) {
  const skipRaw = req.query.skip;
  const limitRaw = req.query.limit;

  let skip = 0;
  if (skipRaw !== undefined) {
    if (!/^\d+$/.test(String(skipRaw))) throw bad400("skip must be a non-negative integer");
    skip = Number(skipRaw);
  }

  let limit = defaultLimit; // users 默认无限制
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(String(limitRaw))) throw bad400("limit must be a non-negative integer");
    limit = Number(limitRaw);
  }

  return { skip, limit };
}

function buildFindQuery(req) {
  const where = parseJsonParam("where", req.query.where, {});
  return where || {};
}
function buildSort(req) {
  return parseJsonParam("sort", req.query.sort, undefined);
}
function buildSelect(req) {
  const sel = parseJsonParam("select", req.query.select, undefined);
  return sanitizeSelect(sel);
}

/* ---------- ROUTES ---------- */

/**
 * GET /api/users
 * 支持 where/sort/select/skip/limit/count
 * 默认不限制 limit；count=true 返回整数且忽略 select
 */
router.get("/", async (req, res, next) => {
  try {
    const where = buildFindQuery(req);
    const sort = buildSort(req);
    const select = buildSelect(req);

    const countOnly = String(req.query.count).toLowerCase() === "true";
    const { skip, limit } = parsePagination(req, { defaultLimit: null });

    const q = User.find(where);
    if (sort) q.sort(sort);
    if (!countOnly) {
      if (select) q.select(select);
      if (skip) q.skip(skip);
      if (limit != null) q.limit(limit);
    }

    if (countOnly) {
      const c = await User.countDocuments(where);
      return ok(res, c);
    }

    const data = await q.lean();
    return ok(res, data);
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

/**
 * POST /api/users
 * - 必填：name, email
 * - email 唯一（11000 捕获）
 */
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
    if (e?.name === "ValidationError" || e?.name === "CastError")
      return badRequest(res, "invalid field type or value");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

/**
 * GET /api/users/:id
 * - 路径 id 非法或不存在 → 404
 * - 支持 select
 */
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

/**
 * PUT /api/users/:id
 * - 路径 id 非法/不存在 → 404
 * - 必填：name + email
 * - 若提供 pendingTasks：
 *   * 不得包含已完成任务 → 400
 *   * 差异同步：新增的任务指派到该用户；移除的任务解绑
 * - 无论 pendingTasks 是否变化，若名字变更，需同步其所有任务的 assignedUserName
 */
router.put("/:id", async (req, res, next) => {
  try {
    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, "user not found");

    const oldName = user.name;
    const oldSet = new Set((user.pendingTasks || []).map((x) => String(x)));
    const nowIds =
      req.body.pendingTasks !== undefined ? toIdStrArray(req.body.pendingTasks) : null;

    // 校验：pendingTasks 中不可包含已完成任务（语义错误 → 400）
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

    // 写用户
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

    // 名字变更 → 同步全部任务的 assignedUserName
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

/**
 * DELETE /api/users/:id
 * - 路径 id 非法/不存在 → 404
 * - 将其所有任务设为未指派（assignedUser=""，assignedUserName="unassigned"）
 */
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
