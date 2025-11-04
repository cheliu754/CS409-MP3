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
  toIdStrArray,
  parseNonNegInt,
} from "./_shared.js";

const router = Router();

/* ======================= Users ======================= */

// GET /api/users
router.get("/", async (req, res, next) => {
  try {
    const where = parseJsonParam("where", req.query.where, {});
    const sort = parseJsonParam("sort", req.query.sort, undefined);
    const select = sanitizeSelect(parseJsonParam("select", req.query.select, undefined));
    const skip = parseNonNegInt("skip", req.query.skip, 0);
    const limit = parseNonNegInt("limit", req.query.limit, 0); // users 默认不限制（0 表示不限制）
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
  } catch (e) { next(e); }
});

// POST /api/users
router.post("/", async (req, res, next) => {
  try {
    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const pendingIds = toIdStrArray(req.body.pendingTasks);

    // 不允许把已完成任务放入初始 pendingTasks
    if (pendingIds.length) {
      const done = await Task.find({ _id: { $in: pendingIds }, completed: true }).distinct("_id");
      if (done.length) {
        const err = new Error(`cannot add completed tasks to pendingTasks: ${done.map(String).join(",")}`);
        err.statusCode = 400;
        throw err;
      }
    }

    const user = await User.create({ name, email, pendingTasks: pendingIds });

    // 指派这些未完成任务给该用户
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
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");
    const select = sanitizeSelect(parseJsonParam("select", req.query.select, undefined));
    const doc = await User.findById(id).select(select).lean();
    if (!doc) return notFound(res, "user not found");
    return ok(res, doc);
  } catch (e) { next(e); }
});

// PUT /api/users/:id
router.put("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");

    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const user = await User.findById(id);
    if (!user) return notFound(res, "user not found");

    const oldSet = new Set((user.pendingTasks || []).map((x) => String(x)));
    const nowIds = toIdStrArray(req.body.pendingTasks);

    // 不得把“已完成”的任务加入 pendingTasks
    if (nowIds.length) {
      const completedIds = await Task.find({ _id: { $in: nowIds }, completed: true }).distinct("_id");
      if (completedIds.length) {
        const err = new Error(`cannot add completed tasks to pendingTasks: ${completedIds.map(String).join(",")}`);
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

    // 新增任务 → 指派给该用户（仅未完成）
    if (added.length) {
      await Task.updateMany(
        { _id: { $in: added }, completed: { $ne: true } },
        { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
      );
    }

    // 移除任务 → 置为未分配（若当前正由该用户负责）
    if (removed.length) {
      await Task.updateMany(
        { _id: { $in: removed }, assignedUser: String(user._id) },
        { $set: { assignedUser: "", assignedUserName: "unassigned" } }
      );
    }

    // 兜底：若仍有“已完成”的任务混入 pending（理论不应发生），清理掉
    if (nowIds.length) {
      const doneIds = await Task.find({ _id: { $in: nowIds }, completed: true }).distinct("_id");
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
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");
    const user = await User.findById(id);
    if (!user) return notFound(res, "user not found");

    // 将该用户的任务全部置为未分配
    await Task.updateMany(
      { assignedUser: String(user._id) },
      { $set: { assignedUser: "", assignedUserName: "unassigned" } }
    );

    await user.deleteOne();
    return noContent(res);
  } catch (e) { next(e); }
});

export default router;
