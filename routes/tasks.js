import express from "express";
import Task from "../models/task.js";
import User from "../models/user.js";

const router = express.Router();

/* Helpers */
const safeJson = (s, fb) => {
  if (s === undefined) return fb;
  try {
    return JSON.parse(s);
  } catch {
    return fb;
  }
};

const ok = (res, data, message = "OK") => res.status(200).json({ message, data });
const created = (res, data, message = "Created") => res.status(201).json({ message, data });
const badRequest = (res, message = "Bad Request", data = {}) => res.status(400).json({ message, data });
const notFound = (res, message = "Not Found") => res.status(404).json({ message, data: {} });
const noContent = (res) => res.status(204).send();

async function syncUserPendingForTask(taskDoc) {
  const taskId = String(taskDoc._id);
  // 先从所有用户 pendingTasks 移除
  await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } });
  // 若该任务被指派且未完成，添加到目标用户 pendingTasks
  if (taskDoc.assignedUser && !taskDoc.completed) {
    await User.updateOne(
      { _id: taskDoc.assignedUser },
      { $addToSet: { pendingTasks: taskId } }
    );
  }
}

/* GET /api/tasks */
router.get("/", async (req, res, next) => {
  try {
    const where = safeJson(req.query.where, {});
    const sort = safeJson(req.query.sort, undefined);
    const select = safeJson(req.query.select, undefined);
    const skip = Number.isFinite(+req.query.skip) ? +req.query.skip : 0;
    const limit = req.query.limit !== undefined ? +req.query.limit : 100; // tasks 默认 100
    const count = String(req.query.count).toLowerCase() === "true";

    if (count) {
      const c = await Task.countDocuments(where);
      return ok(res, c, "Count");
    }
    let q = Task.find(where);
    if (sort) q = q.sort(sort);
    if (select) q = q.select(select);
    if (skip) q = q.skip(skip);
    if (limit) q = q.limit(limit);
    const docs = await q.lean();
    return ok(res, docs);
  } catch (e) { next(e); }
});

/* POST /api/tasks */
router.post("/", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    const payload = {
      description: "",
      completed: false,
      assignedUser: "",
      assignedUserName: "unassigned",
      ...req.body,
    };

    if (payload.assignedUser) {
      const user = await User.findById(payload.assignedUser);
      if (!user) return badRequest(res, "assignedUser does not exist");
      payload.assignedUserName = user.name;
    }

    const task = await Task.create(payload);
    await syncUserPendingForTask(task);
    return created(res, task.toObject());
  } catch (e) { next(e); }
});

/* GET /api/tasks/:id (支持 ?select=JSON) */
router.get("/:id", async (req, res, next) => {
  try {
    const select = safeJson(req.query.select, undefined);
    const doc = await Task.findById(req.params.id).select(select).lean();
    if (!doc) return notFound(res, "task not found");
    return ok(res, doc);
  } catch (e) { next(e); }
});

/* PUT /api/tasks/:id —— 整体替换 */
router.put("/:id", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    const task = await Task.findById(req.params.id);
    if (!task) return notFound(res, "task not found");

    let assignedUserName = "unassigned";
    if (req.body.assignedUser) {
      const user = await User.findById(req.body.assignedUser);
      if (!user) return badRequest(res, "assignedUser does not exist");
      assignedUserName = user.name;
    }

    task.set({
      name: req.body.name,
      description: req.body.description ?? "",
      deadline: req.body.deadline,
      completed: !!req.body.completed,
      assignedUser: req.body.assignedUser ?? "",
      assignedUserName,
    });
    await task.save();

    await syncUserPendingForTask(task);
    return ok(res, task.toObject(), "Updated");
  } catch (e) { next(e); }
});

/* DELETE /api/tasks/:id —— 从用户 pendingTasks 移除后删除任务 */
router.delete("/:id", async (req, res, next) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return notFound(res, "task not found");

    const tid = String(task._id);
    await User.updateMany({ pendingTasks: tid }, { $pull: { pendingTasks: tid } });
    await task.deleteOne();

    return noContent(res);
  } catch (e) { next(e); }
});

export default router;
