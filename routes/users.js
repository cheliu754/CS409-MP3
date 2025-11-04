// routes/users.js
import { Router } from "express";
import User from "../models/user.js";
import Task from "../models/task.js";
import {
  parseJsonParam,
  sanitizeSelect,
  ok,
  created,
  noContent,
  badRequest,
  notFound,
  isValidObjectId,
  toIdStr,
  toIdStrArray,
} from "./_shared.js";

const router = Router();

/* ======================= Users ======================= */

// GET /api/users
router.get("/", async (req, res, next) => {
  try {
    const where = parseJsonParam("where", req.query.where, {});
    const sort = parseJsonParam("sort", req.query.sort, undefined);
    const select = sanitizeSelect(parseJsonParam("select", req.query.select, undefined));
    const skip = Number.isFinite(+req.query.skip) ? +req.query.skip : 0;
    const limit = req.query.limit !== undefined ? +req.query.limit : 0; // users 默认不限制
    const count = String(req.query.count).toLowerCase() === "true";

    if (count) {
      const c = await User.countDocuments(where);
      return ok(res, c, "Count");
    }

    let q = User.find(where);
    if (sort) q = q.sort(sort);
    if (select) q = q.select(select);
    if (skip) q = q.skip(skip);
    if (limit) q = q.limit(limit);
    const docs = await q.lean();
    return ok(res, docs);
  } catch (e) {
    next(e);
  }
});

// POST /api/users
router.post("/", async (req, res, next) => {
  try {
    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const pendingIds = toIdStrArray(req.body.pendingTasks);

    // （可选严格）不允许把已完成任务装入初始 pendingTasks
    if (pendingIds.length) {
      const done = await Task.find({ _id: { $in: pendingIds }, completed: true }).distinct("_id");
      if (done.length) {
        const err = new Error(
          `cannot add completed tasks to pendingTasks: ${done.map(String).join(",")}`
        );
        err.statusCode = 400;
        throw err;
      }
    }

    const user = await User.create({ name, email, pendingTasks: pendingIds });

    // 同步任务归属：把这些未完成 task 指派给该用户
    if (pendingIds.length) {
      await Task.updateMany(
        { _id: { $in: pendingIds }, completed: { $ne: true } },
        { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
      );
    }

    return created(res, user.toObject());
  } catch (e) {
    if (e?.code === 11000) return badRequest(res, "email already exists");
    next(e);
  }
});

// GET /api/users/:id
router.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return notFound(res, "user not found");
    const select = sanitizeSelect(parseJsonParam("select", req.query.select, undefined));
    const doc = await User.findById(id).select(select).lean();
    if (!doc) return notFound(res, "user not found");
    return ok(res, doc);
  } catch (e) {
    next(e);
  }
});

// PUT /api/users/:id
router.put("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return notFound(res, "user not found");

    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const user = await User.findById(id);
    if (!user) return notFound(res, "user not found");

    const oldSet = new Set((user.pendingTasks || []).map((x) => String(x)));
    const nowIds = toIdStrArray(req.body.pendingTasks);

    // 规则（老师说明）：不得把“已完成”的任务加入 pendingTasks
    if (nowIds.length) {
      const completedIds = await Task.find({
        _id: { $in: nowIds },
        completed: true,
      }).distinct("_id");
      if (completedIds.length) {
        const err = new Error(
          `cannot add completed tasks to pendingTasks: ${completedIds
            .map(String)
            .join(",")}`
        );
        err.statusCode = 400;
        throw err;
      }
    }

    user.name = name;
    user.email = email;
    user.pendingTasks = nowIds;
    await user.save();

    const added = nowIds.filter((x) => !oldSet.has(x));
    const removed = [...oldSet].filter((x) => !nowIds.includes(x));

    // 新增的任务 → 指派给该用户（仅限未完成）
    if (added.length) {
      await Task.updateMany(
        { _id: { $in: added }, completed: { $ne: true } },
        { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
      );
    }

    // 从 pending 中移除的任务 → 置为未分配
    if (removed.length) {
      await Task.updateMany(
        { _id: { $in: removed }, assignedUser: String(user._id) },
        { $set: { assignedUser: "", assignedUserName: "unassigned" } }
      );
    }

    // 兜底：若仍有“已完成”的任务混入 pending（理论上不会，因为前面已拒绝），清理掉
    if (nowIds.length) {
      const doneIds = await Task.find({
        _id: { $in: nowIds },
        completed: true,
      }).distinct("_id");
      if (doneIds.length) {
        await User.updateOne(
          { _id: user._id },
          { $pull: { pendingTasks: { $in: doneIds.map((x) => String(x)) } } }
        );
      }
    }

    return ok(res, user.toObject(), "Updated");
  } catch (e) {
    if (e?.code === 11000) return badRequest(res, "email already exists");
    next(e);
  }
});

// DELETE /api/users/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return notFound(res, "user not found");
    const user = await User.findById(id);
    if (!user) return notFound(res, "user not found");

    // 把该用户的任务全部设为未分配（无论完成与否）
    await Task.updateMany(
      { assignedUser: String(user._id) },
      { $set: { assignedUser: "", assignedUserName: "unassigned" } }
    );

    await user.deleteOne();
    return noContent(res);
  } catch (e) {
    next(e);
  }
});

export default router;
