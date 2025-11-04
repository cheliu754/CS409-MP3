// routes/tasks.js
import express from "express";
import mongoose from "mongoose";
import Task from "../models/task.js";
import User from "../models/user.js";

const router = express.Router();

/* -------------------------- helpers: responses -------------------------- */
const json = (res, code, data = null, message = "OK") =>
  res.status(code).json({ message, data });

const ok = (res, data, message = "OK") => json(res, 200, data, message);
const created = (res, data, message = "Created") => json(res, 201, data, message);
const badRequest = (res, message = "Bad Request", data = null) => json(res, 400, data, message);
const notFound = (res, message = "Not Found") => json(res, 404, null, message);

/* ------------------------------ helpers: ids ---------------------------- */
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
const toIdStr = (v) => (v ? String(v) : "");

/* ---------------------------- helpers: select --------------------------- */
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
    // MongoDB 规则：包含与排除不能混用（_id 除外）
    // 若除 _id 外仍混用，报 400
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

  let limit = defaultLimit;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(String(limitRaw))) throw bad400("limit must be a non-negative integer");
    limit = Number(limitRaw);
  }

  return { skip, limit };
}

const bad400 = (msg) => {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
};

/* ------------------------ helpers: GET query build ---------------------- */
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

/* ----------------- helpers: two-way reference maintenance --------------- */
/**
 * 强一致同步：根据 before/after 的差异，维护 User.pendingTasks
 * 规则：
 *  - 若指派用户变化：从旧用户 pendingTasks 移除、向新用户添加（仅当 next.completed === false）
 *  - 若从未完成 -> 完成：从（新）用户 pendingTasks 移除；保留 assignedUser/Name
 *  - 不允许从完成 -> 未完成（外层 PUT 已拦截）
 */
async function syncUserPendingStrict(before, after) {
  const prevUser = toIdStr(before?.assignedUser);
  const nextUser = toIdStr(after?.assignedUser);
  const nextCompleted = !!after?.completed;

  // 指派变更：先从旧用户移除
  if (prevUser && prevUser !== nextUser) {
    await User.updateOne(
      { _id: prevUser },
      { $pull: { pendingTasks: String(after._id) } }
    );
  }

  // 对新用户：未完成则加入，已完成则确保移除
  if (nextUser) {
    if (nextCompleted) {
      await User.updateOne(
        { _id: nextUser },
        { $pull: { pendingTasks: String(after._id) } }
      );
    } else {
      await User.updateOne(
        { _id: nextUser },
        { $addToSet: { pendingTasks: String(after._id) } }
      );
    }
  }
}

/* =============================== ROUTES ================================= */

/**
 * GET /api/tasks
 * 支持 where/sort/select/skip/limit/count
 * 默认 limit=100；count=true 时返回整数且忽略 select
 */
router.get("/", async (req, res, next) => {
  try {
    const where = buildFindQuery(req);
    const sort = buildSort(req);
    const select = buildSelect(req);

    const countOnly = String(req.query.count).toLowerCase() === "true";
    const { skip, limit } = parsePagination(req, { defaultLimit: 100 });

    const q = Task.find(where);
    if (sort) q.sort(sort);
    if (!countOnly) {
      if (select) q.select(select);
      if (skip) q.skip(skip);
      if (limit != null) q.limit(limit);
    }

    if (countOnly) {
      const c = await Task.countDocuments(where);
      return ok(res, c);
    }

    const data = await q.lean();
    return ok(res, data);
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

/**
 * POST /api/tasks
 * - name, deadline 必填
 * - 若提供 assignedUser：
 *   * 必须存在
 *   * 若也提供了 assignedUserName，必须与真实 user.name 一致；否则 400
 *   * 统一回填为真实 user.name
 * - 创建后维护 pendingTasks（未完成则加入）
 */
router.post("/", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";

    if (assignedUser) {
      if (!isValidObjectId(assignedUser)) return badRequest(res, "invalid assignedUser id format");
      const u = await User.findById(assignedUser).lean();
      if (!u) return badRequest(res, "assignedUser does not exist");
      if (req.body.assignedUserName !== undefined && req.body.assignedUserName !== u.name) {
        return badRequest(res, "assignedUserName must match the user's name");
      }
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
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

/**
 * GET /api/tasks/:id
 * - 仅支持 select
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");

    const select = buildSelect(req);
    const q = Task.findById(id);
    if (select) q.select(select);
    const t = await q.lean();
    if (!t) return notFound(res, "task not found");
    return ok(res, t);
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

/**
 * PUT /api/tasks/:id
 * - 完全替换（需要 name, deadline）
 * - 不允许更新“已完成”的任务（before.completed===true → 400）
 * - 若指定 assignedUser：
 *   * 必须存在
 *   * 若也给了 assignedUserName，必须与真实 user.name 一致；否则 400
 *   * 统一写为真实 user.name
 * - 同步维护用户 pendingTasks
 */
router.put("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");

    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    const task = await Task.findById(id);
    if (!task) return notFound(res, "task not found");
    const before = task.toObject();

    if (before.completed === true) {
      return badRequest(res, "cannot update a completed task");
    }

    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";

    if (assignedUser) {
      if (!isValidObjectId(assignedUser)) return badRequest(res, "invalid assignedUser id format");
      const u = await User.findById(assignedUser).lean();
      if (!u) return badRequest(res, "assignedUser does not exist");
      if (req.body.assignedUserName !== undefined && req.body.assignedUserName !== u.name) {
        return badRequest(res, "assignedUserName must match the user's name");
      }
      assignedUserName = u.name;
    } else {
      assignedUser = "";
    }

    task.set({
      name,
      description: req.body.description ?? "",
      deadline,
      completed: !!req.body.completed,
      assignedUser,
      assignedUserName,
    });

    await task.save();
    await syncUserPendingStrict(before, task.toObject());
    return ok(res, task.toObject(), "Updated");
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

/**
 * DELETE /api/tasks/:id
 * - 从其 assignedUser 的 pendingTasks 中移除
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return badRequest(res, "invalid id format");

    const t = await Task.findById(id);
    if (!t) return notFound(res, "task not found");

    const before = t.toObject();
    await Task.deleteOne({ _id: id });

    // 清理用户 pendingTasks
    if (before.assignedUser) {
      await User.updateOne(
        { _id: String(before.assignedUser) },
        { $pull: { pendingTasks: String(id) } }
      );
    }

    return ok(res, { _id: String(id) }, "Deleted");
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

export default router;
