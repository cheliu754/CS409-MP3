// routes/tasks.js
import { Router } from "express";
import Task from "../models/task.js";
import User from "../models/user.js";
import {
  parseJsonParam,
  sanitizeSelect,
  ok,
  created,
  badRequest,
  notFound,
  noContent,
  isValidObjectId,
  toIdStr,
  isEmptyId,
} from "./_shared.js";

const router = Router();

/**
 * 双向同步（严格版）
 * 规则：
 * - 若 taskAfter.completed === true：仅从所有用户 pendingTasks 移除该任务；不改 assignedUser/assignedUserName
 * - 若换人：从旧负责人 $pull，给新负责人 $addToSet（前提：任务未完成）
 * - 若无人负责：从所有用户 $pull
 */
async function syncUserPendingStrict(taskBefore, taskAfter) {
  const tid = String(taskAfter._id);
  const oldUid = toIdStr(taskBefore?.assignedUser);
  const newUid = toIdStr(taskAfter.assignedUser);

  // 任务完成：从所有用户 pendingTasks 清理，但不改 assignedUser
  if (taskAfter.completed === true) {
    await User.updateMany({ pendingTasks: tid }, { $pull: { pendingTasks: tid } });
    return;
  }

  // 若换人：先从旧人移除
  if (!isEmptyId(oldUid) && oldUid !== newUid) {
    await User.updateOne({ _id: oldUid }, { $pull: { pendingTasks: tid } });
  }

  // 若有新负责人且未完成：加入新负责人的 pendingTasks
  if (!isEmptyId(newUid)) {
    await User.updateOne({ _id: newUid }, { $addToSet: { pendingTasks: tid } });
  }

  // 若无人负责：从所有用户移除
  if (isEmptyId(newUid)) {
    await User.updateMany({ pendingTasks: tid }, { $pull: { pendingTasks: tid } });
  }
}

/* ======================= Routes ======================= */

// GET /api/tasks
router.get("/", async (req, res, next) => {
  try {
    const where = parseJsonParam("where", req.query.where, {});
    const sort = parseJsonParam("sort", req.query.sort, undefined);
    const select = sanitizeSelect(parseJsonParam("select", req.query.select, undefined));
    const skip = Number.isFinite(+req.query.skip) ? +req.query.skip : 0;
    const limit = req.query.limit !== undefined ? +req.query.limit : 100;
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

// POST /api/tasks
router.post("/", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    // 规范 assignedUser / assignedUserName
    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";
    if (!isEmptyId(assignedUser)) {
      const u = await User.findById(assignedUser);
      if (!u) return badRequest(res, "assignedUser does not exist");
      assignedUserName = u.name;
    } else {
      assignedUser = "";
    }

    const payload = {
      description: "",
      completed: false,
      ...req.body,
      assignedUser,
      assignedUserName,
    };

    const t = await Task.create(payload);
    await syncUserPendingStrict(null, t.toObject());
    return created(res, t.toObject());
  } catch (e) { next(e); }
});

// GET /api/tasks/:id
router.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return notFound(res, "task not found");
    const select = sanitizeSelect(parseJsonParam("select", req.query.select, undefined));
    const t = await Task.findById(id).select(select).lean();
    if (!t) return notFound(res, "task not found");
    return ok(res, t);
  } catch (e) { next(e); }
});

// PUT /api/tasks/:id
router.put("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return notFound(res, "task not found");
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    const task = await Task.findById(id);
    if (!task) return notFound(res, "task not found");
    const before = task.toObject();

    // 规则（老师说明）：若数据库里该任务已完成，禁止任何更新（包括改名、改指派）。
    if (before.completed === true) {
      const err = new Error("cannot update a completed task");
      err.statusCode = 400;
      throw err;
    }

    // 规范 assignedUser / assignedUserName
    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";
    if (!isEmptyId(assignedUser)) {
      const u = await User.findById(assignedUser);
      if (!u) return badRequest(res, "assignedUser does not exist");
      assignedUserName = u.name;
    } else {
      assignedUser = "";
    }

    task.set({
      name,
      description: req.body.description ?? "",
      deadline,
      completed: !!req.body.completed, // 如果这次把未完成改为完成，允许；同步器会处理 pendingTasks
      assignedUser,
      assignedUserName,
    });
    await task.save();
    await syncUserPendingStrict(before, task.toObject());
    return ok(res, task.toObject(), "Updated");
  } catch (e) { next(e); }
});

// DELETE /api/tasks/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return notFound(res, "task not found");
    const task = await Task.findById(id);
    if (!task) return notFound(res, "task not found");

    const tid = String(task._id);
    await User.updateMany({ pendingTasks: tid }, { $pull: { pendingTasks: tid } });
    await task.deleteOne();
    return noContent(res);
  } catch (e) { next(e); }
});

export default router;
