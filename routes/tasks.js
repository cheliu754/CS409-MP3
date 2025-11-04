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
  parseNonNegInt,
} from "./_shared.js";

const router = Router();

/**
 * 双向同步（严格版，符合老师澄清）：
 * - 若 taskAfter.completed === true：仅从所有用户 pendingTasks 移除该任务；不改 assignedUser/assignedUserName
 * - 若换人：从旧负责人 $pull，给新负责人 $addToSet（仅当未完成）
 * - 若无人负责：从所有用户 $pull
 */
async function syncUserPendingStrict(taskBefore, taskAfter) {
  const tid = String(taskAfter._id);
  const oldUid = toIdStr(taskBefore?.assignedUser);
  const newUid = toIdStr(taskAfter.assignedUser);

  // 完成：仅清 pending，不改 assignedUser
  if (taskAfter.completed === true) {
    await User.updateMany({ pendingTasks: tid }, { $pull: { pendingTasks: tid } });
    return;
  }

  // 换人：先从旧人移除
  if (oldUid && oldUid !== newUid) {
    await User.updateOne({ _id: oldUid }, { $pull: { pendingTasks: tid } });
  }

  // 新负责人：加入 pending
  if (newUid) {
    await User.updateOne({ _id: newUid }, { $addToSet: { pendingTasks: tid } });
  }

  // 无人负责：清理所有 pending
  if (!newUid) {
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
    const skip = parseNonNegInt("skip", req.query.skip, 0);
    const limit = parseNonNegInt("limit", req.query.limit, 100); // 默认 100
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
    if (assignedUser) {
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
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");
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
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    const task = await Task.findById(id);
    if (!task) return notFound(res, "task not found");
    const before = task.toObject();

    // 老师规则：数据库里已完成的任务禁止任何更新
    if (before.completed === true) {
      const err = new Error("cannot update a completed task");
      err.statusCode = 400;
      throw err;
    }

    // 规范 assignedUser / assignedUserName
    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";
    if (assignedUser) {
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
      completed: !!req.body.completed, // 允许这次把未完成标记为完成
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
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");
    const task = await Task.findById(id);
    if (!task) return notFound(res, "task not found");

    const tid = String(task._id);
    await User.updateMany({ pendingTasks: tid }, { $pull: { pendingTasks: tid } });
    await task.deleteOne();
    return noContent(res);
  } catch (e) { next(e); }
});

export default router;
