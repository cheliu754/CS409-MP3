// routes/tasks.js
import express from "express";
import mongoose from "mongoose";
import Task from "../models/task.js";
import User from "../models/user.js";

const router = express.Router();

//  helpers: responses
const json = (res, code, data = null, message = "OK") =>
  res.status(code).json({ message, data });

const ok = (res, data, message = "OK") => json(res, 200, data, message);
const created = (res, data, message = "Created") => json(res, 201, data, message);
const badRequest = (res, message = "Bad Request", data = null) => json(res, 400, data, message);
const notFound = (res, message = "Not Found") => json(res, 404, null, message);

//  helpers: ids
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id); // 仅用于“请求体”校验
const toIdStr = (v) => (v ? String(v) : "");

//  helpers: select & query parsing
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

const bad400 = (msg) => {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
};

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

//  helpers: GET query build
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

/*  helpers: two-way reference maintenance - */
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

//  ROUTES

// GET /api/tasks
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

// POST /api/tasks
router.post("/", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";

    if (assignedUser) {
      // 请求体字段 → 400
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

// GET /api/tasks/:id  —— 路径 id：非法格式或不存在都 404
router.get("/:id", async (req, res, next) => {
  try {
    const select = buildSelect(req);
    const q = Task.findById(req.params.id);
    if (select) q.select(select);
    const t = await q.lean();
    if (!t) return notFound(res, "task not found");
    return ok(res, t);
  } catch (e) {
    if (e?.name === "CastError") return notFound(res, "task not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

// PUT /api/tasks/:id —— 路径 id 非法/不存在 → 404；请求体错误 → 400
router.put("/:id", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) return badRequest(res, "name and deadline are required");

    const task = await Task.findById(req.params.id);
    if (!task) return notFound(res, "task not found");
    const before = task.toObject();

    if (before.completed === true) {
      return badRequest(res, "cannot update a completed task");
    }

    let assignedUser = toIdStr(req.body.assignedUser);
    let assignedUserName = "unassigned";

    if (assignedUser) {
      // 请求体字段 → 400
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
    if (e?.name === "CastError") return notFound(res, "task not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

// DELETE /api/tasks/:id —— 路径 id 非法/不存在 → 404
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
    if (e?.name === "CastError") return notFound(res, "task not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    next(e);
  }
});

export default router;
