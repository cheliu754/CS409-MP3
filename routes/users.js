import express from "express";
import User from "../models/user.js";
import Task from "../models/task.js";

const router = express.Router();

/* Helpers */
const safeJson = (s, fb) => {
  if (s === undefined) return fb;
  try { return JSON.parse(s); } catch { return fb; }
};

const ok = (res, data, message = "OK") => res.status(200).json({ message, data });
const created = (res, data, message = "Created") => res.status(201).json({ message, data });
const badRequest = (res, message = "Bad Request", data = {}) => res.status(400).json({ message, data });
const notFound = (res, message = "Not Found") => res.status(404).json({ message, data: {} });
const noContent = (res) => res.status(204).send();

/* GET /api/users */
router.get("/", async (req, res, next) => {
  try {
    const where = safeJson(req.query.where, {});
    const sort = safeJson(req.query.sort, undefined);
    const select = safeJson(req.query.select, undefined);
    const skip = Number.isFinite(+req.query.skip) ? +req.query.skip : 0;
    const limit = req.query.limit !== undefined ? +req.query.limit : 0; // users 默认无限制
    const count = String(req.query.count).toLowerCase() === "true";

    if (count) {
      const c = await User.countDocuments(where);
      return ok(res, c, "Count");
    }
    let q = User.find(where);
    if (sort) q = q.sort(sort);
    if (select) q = q.select(select);
    if (skip) q = q.skip(skip);
    if (limit) q = q.limit(limit); // 0 = 不限制
    const docs = await q.lean();
    return ok(res, docs);
  } catch (e) { next(e); }
});

/* POST /api/users */
router.post("/", async (req, res, next) => {
  try {
    const { name, email, pendingTasks = [] } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const user = await User.create({ name, email, pendingTasks });

    // 将提交的 pendingTasks 指派给该用户（未完成任务）
    if (pendingTasks.length) {
      await Task.updateMany(
        { _id: { $in: pendingTasks }, completed: { $ne: true } },
        { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
      );
    }
    return created(res, user.toObject());
  } catch (e) {
    if (e?.code === 11000) return badRequest(res, "email already exists");
    next(e);
  }
});

/* GET /api/users/:id (支持 ?select=JSON) */
router.get("/:id", async (req, res, next) => {
  try {
    const select = safeJson(req.query.select, undefined);
    const doc = await User.findById(req.params.id).select(select).lean();
    if (!doc) return notFound(res, "user not found");
    return ok(res, doc);
  } catch (e) { next(e); }
});

/* PUT /api/users/:id —— 整体替换 */
router.put("/:id", async (req, res, next) => {
  try {
    const { name, email, pendingTasks = [] } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, "user not found");

    const old = new Set(user.pendingTasks.map(String));
    const now = new Set((pendingTasks || []).map(String));

    user.name = name;
    user.email = email;
    user.pendingTasks = Array.from(now);
    await user.save();

    // 新增的任务：指派给该用户
    const added = [...now].filter(id => !old.has(id));
    if (added.length) {
      await Task.updateMany(
        { _id: { $in: added }, completed: { $ne: true } },
        { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
      );
    }
    // 移除的任务：若原本指向该用户，则解绑
    const removed = [...old].filter(id => !now.has(id));
    if (removed.length) {
      await Task.updateMany(
        { _id: { $in: removed }, assignedUser: String(user._id) },
        { $set: { assignedUser: "", assignedUserName: "unassigned" } }
      );
    }
    return ok(res, user.toObject(), "Updated");
  } catch (e) {
    if (e?.code === 11000) return badRequest(res, "email already exists");
    next(e);
  }
});

/* DELETE /api/users/:id —— 解绑该用户所有任务后删除用户 */
router.delete("/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, "user not found");

    await Task.updateMany(
      { assignedUser: String(user._id) },
      { $set: { assignedUser: "", assignedUserName: "unassigned" } }
    );
    await user.deleteOne();
    return noContent(res);
  } catch (e) { next(e); }
});

export default router;
