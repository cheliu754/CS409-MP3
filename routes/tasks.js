import express from "express";
import mongoose from "mongoose";
import Task from "../models/task.js";
import User from "../models/user.js";
import {
  ok, created, badRequest, notFound,
  parseJsonParam, sanitizeSelect, parseNonNegInt,
} from "./_shared.js";

const router = express.Router();

function toNumberIfNumericString(v) {
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v);
  return v;
}
function buildFindQuery(req) {
  const where = parseJsonParam("where", req.query.where, {});
  return where || {};
}
function buildSort(req) {
  return parseJsonParam("sort", req.query.sort, undefined);
}
function buildSelect(req) {
  const sel = parseJsonParam(
    "select",
    req.query.select,
    parseJsonParam("filter", req.query.filter, undefined)
  );
  return sanitizeSelect(sel);
}
function parsePagination(req, { defaultLimit = 100 } = {}) {
  const skip = parseNonNegInt("skip", req.query.skip, 0);
  const limit = parseNonNegInt("limit", req.query.limit, defaultLimit);
  return { skip, limit };
}

async function syncUserPendingStrict(before, after) {
  const prevUser = (before?.assignedUser ? String(before.assignedUser) : "");
  const nextUser = (after?.assignedUser ? String(after.assignedUser) : "");
  const nextCompleted = !!after?.completed;

  if (prevUser && prevUser !== nextUser) {
    await User.updateOne({ _id: prevUser }, { $pull: { pendingTasks: String(after._id) } });
  }
  if (nextUser) {
    if (nextCompleted) {
      await User.updateOne({ _id: nextUser }, { $pull: { pendingTasks: String(after._id) } });
    } else {
      await User.updateOne({ _id: nextUser }, { $addToSet: { pendingTasks: String(after._id) } });
    }
  }
}

router.get("/", async (req, res, next) => {
  try {
    const where = buildFindQuery(req);
    const sort = buildSort(req);
    const select = buildSelect(req);
    const countOnly = String(req.query.count).toLowerCase() === "true";
    const { skip, limit } = parsePagination(req, { defaultLimit: 100 });

    if (countOnly) {
      const c = await Task.countDocuments(where);
      return ok(res, c);
    }

    const q = Task.find(where);
    if (sort) q.sort(sort);
    if (select) q.select(select);
    q.skip(skip);              
    if (limit != null) q.limit(limit);

    const data = await q.lean();
    return ok(res, data);
  } catch (e) {
    if (e?.statusCode === 400) return badRequest(res, e.message);
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    return next(e);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || deadline === undefined || deadline === null)
      return badRequest(res, "name and deadline are required");

    req.body.deadline = toNumberIfNumericString(req.body.deadline);

    let assignedUser = req.body.assignedUser ? String(req.body.assignedUser) : "";
    let assignedUserName = "unassigned";

    if (assignedUser) {
      if (!mongoose.Types.ObjectId.isValid(assignedUser))
        return badRequest(res, "invalid assignedUser id format");
      const u = await User.findById(assignedUser).lean();
      if (!u) return badRequest(res, "assignedUser does not exist");
      if (req.body.assignedUserName !== undefined && req.body.assignedUserName !== u.name)
        return badRequest(res, "assignedUserName must match the user's name");
      assignedUserName = u.name;
    }

    const payload = {
      description: "",
      ...req.body,
      completed: req.body.completed ?? false, 
      assignedUser,
      assignedUserName,
    };

    const t = await Task.create(payload);
    await syncUserPendingStrict(null, t.toObject());
    return created(res, t.toObject());
  } catch (e) {
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return notFound(res, "task not found");

    const select = buildSelect(req);
    const q = Task.findById(req.params.id);
    if (select) q.select(select);
    const t = await q.lean();
    if (!t) return notFound(res, "task not found");
    return ok(res, t);
  } catch (e) {
    if (e?.name === "CastError") return notFound(res, "task not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return notFound(res, "task not found");

    const task = await Task.findById(req.params.id);
    if (!task) return notFound(res, "task not found");

    const { name, deadline } = req.body || {};
    if (!name || deadline === undefined || deadline === null)
      return badRequest(res, "name and deadline are required");

    req.body.deadline = toNumberIfNumericString(req.body.deadline);

    const before = task.toObject();

    let assignedUser = req.body.assignedUser ? String(req.body.assignedUser) : "";
    let assignedUserName = "unassigned";
    if (assignedUser) {
      if (!mongoose.Types.ObjectId.isValid(assignedUser))
        return badRequest(res, "invalid assignedUser id format");
      const u = await User.findById(assignedUser).lean();
      if (!u) return badRequest(res, "assignedUser does not exist");
      if (req.body.assignedUserName !== undefined && req.body.assignedUserName !== u.name)
        return badRequest(res, "assignedUserName must match the user's name");
      assignedUserName = u.name;
    }

    task.set({
      name,
      description: req.body.description ?? "",
      deadline: req.body.deadline, 
      completed: req.body.completed ?? false,  
      assignedUser,
      assignedUserName,
    });

    await task.save();             
    await syncUserPendingStrict(before, task.toObject());
    return ok(res, task.toObject(), "Updated");
  } catch (e) {
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return notFound(res, "task not found");

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
    return next(e);
  }
});

export default router;
