// routes/tasks.js
import express from "express";
import mongoose from "mongoose";
import Task from "../models/task.js";
import User from "../models/user.js";

const router = express.Router();

/* ---------- helpers: responses ---------- */
const json = (res, code, data = null, message = "OK") =>
  res.status(code).json({ message, data });

const ok = (res, data, message = "OK") => json(res, 200, data, message);
const created = (res, data, message = "Created") => json(res, 201, data, message);
const badRequest = (res, message = "Bad Request", data = null) =>
  json(res, 400, data, message);
const notFound = (res, message = "Not Found") => json(res, 404, null, message);

/* ---------- helpers: ids & parsing ---------- */
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id); // 仅用于“请求体”字段
const toIdStr = (v) => (v ? String(v) : "");
const bad400 = (msg) => {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
};

// 简单的 ISO8601 可解析性检查（能够被 Date.parse 解析即可）
const isISODateLike = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

// query: JSON 参数解析
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

// query: select 清洗（不可混用包含/排除，_id 例外）
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

  let limit = defaultLimit;
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

/* ---------- helpers: two-way reference maintenance ---------- */
/**
 * 根据 before/after 的差异维护 User.pendingTasks
 * - 指派变更：从旧用户移除 → 加入新用户（仅未完成）
 * - 完成状态变为 true：从新用户 pendingTasks 移除（assignment 保留）
 * - 不允许从完成 → 未完成（由外层逻辑保护）
 */
async function syncUserPendingStrict(before, after) {
  const prevUser = toIdStr(before?.assignedUser);
  const nextUser = toIdStr(after?.assignedUser);
  const nextCompleted = !!after?.completed;

  if (prevUser && prevUser !== nextUser) {
    await User.updateOne(
      { _id: prevUser },
      { $pull: { pendingTasks: String(after._id) } }
    );
  }

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

/* ---------- ROUTES ---------- */

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
    return next(e);
  }
});

/**
 * POST /api/tasks
 * - 必填：name, deadline（deadline 必须可解析为日期）
 * - 若提供 assignedUser：必须存在；assignedUserName（若提供）必须匹配真实 name
 * - 创建后维护 pendingTasks（未完成则加入）
 */
router.post("/", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");
    if (!isISODateLike(deadline)) return badRequest(res, "invalid deadline format");

    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";

    if (assignedUser) {
      if (!isValidObjectId(assignedUser))
        return badRequest(res, "invalid assignedUser id format");
      const u = await User.findById(assignedUser).lean();
      if (!u) return badRequest(res, "assignedUser does not exist");
      if (
        req.body.assignedUserName !== undefined &&
        req.body.assignedUserName !== u.name
      ) {
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
    // ★ 保存阶段的类型/校验错误 → 400
    if (e?.name === "CastError" || e?.name === "ValidationError") {
      return badRequest(res, "invalid field type or value");
    }
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

/**
 * GET /api/tasks/:id
 * - 路径 id 非法或不存在 → 404
 * - 支持 select
 */
router.get("/:id", async (req, res, next) => {
  try {
    const select = buildSelect(req);
    const q = Task.findById(req.params.id);
    if (select) q.select(select);
    const t = await q.lean();
    if (!t) return notFound(res, "task not found");
    return ok(res, t);
  } catch (e) {
    // ★ findById 阶段的 CastError 视为“路径 id 非法” → 404
    if (e?.name === "CastError") return notFound(res, "task not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

/**
 * PUT /api/tasks/:id
 * - 路径 id 非法/不存在 → 404
 * - 必填：name, deadline（deadline 必须可解析）
 * - 不允许更新“已完成”的任务 → 400
 * - assignedUser（若提供）必须存在，且 assignedUserName（若提供）要匹配
 * - 同步维护用户 pendingTasks
 */
router.put("/:id", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");
    if (!isISODateLike(deadline)) return badRequest(res, "invalid deadline format");

    const task = await Task.findById(req.params.id);
    if (!task) return notFound(res, "task not found");
    const before = task.toObject();

    if (before.completed === true) {
      return badRequest(res, "cannot update a completed task");
    }

    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";

    if (assignedUser) {
      if (!isValidObjectId(assignedUser))
        return badRequest(res, "invalid assignedUser id format");
      const u = await User.findById(assignedUser).lean();
      if (!u) return badRequest(res, "assignedUser does not exist");
      if (
        req.body.assignedUserName !== undefined &&
        req.body.assignedUserName !== u.name
      ) {
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
    // ★ 保存阶段/字段类型错误 → 400；唯独路径 id 的 CastError（发生在 findById）另处已处理
    if (e?.name === "ValidationError" || e?.name === "CastError") {
      return badRequest(res, "invalid field type or value");
    }
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

/**
 * DELETE /api/tasks/:id
 * - 路径 id 非法/不存在 → 404
 * - 同步清理用户 pendingTasks
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const t = await Task.findById(req.params.id);
    if (!t) return notFound(res, "task not found");

    const before = t.toObject();
    await Task.deleteOne({ _id: t._id });

    if (before.assignedUser) {
      await User.updateOne(
        { _id: String(before.assignedUser) },
        { $pull: { pendingTasks: String(before._id) } }
      );
    }

    return ok(res, { _id: String(before._id) }, "Deleted");
  } catch (e) {
    // findById 阶段 CastError → 404
    if (e?.name === "CastError") return notFound(res, "task not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

export default router;
