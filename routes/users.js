import express from "express";
import mongoose from "mongoose";
import User from "../models/user.js";
import Task from "../models/task.js";
import {
  ok, created, badRequest, notFound,
  parseJsonParam, sanitizeSelect, parseNonNegInt,
  toIdStr, toIdStrArray,
} from "./_shared.js";

const router = express.Router();

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
  );
  return sanitizeSelect(sel);
}

function parsePagination(req, { defaultLimit = null } = {}) {
  const skip = parseNonNegInt("skip", req.query.skip, 0);
  const limit = parseNonNegInt("limit", req.query.limit, defaultLimit);
  return {
    skip, limit
  };
}

async function syncTasksOnUserPendingChange(userId, userName, addedIds = [], removedIds = []) {
  const uid = String(userId);
  const add = (addedIds || []).map(String);
  const del = (removedIds || []).map(String);
  const addedTasks = await Task.find({ _id: { $in: add }, completed: { $ne: true } })
    .select("_id assignedUser")
    .lean();
  const prevOwnerIds = [...new Set(
    addedTasks
      .map(t => (t.assignedUser ? String(t.assignedUser) : ""))
      .filter(x => x && x !== uid)
  )];
  const addedTaskIds = addedTasks.map(t => String(t._id));
  if (addedTaskIds.length) {
    await Task.updateMany(
      { _id: { $in: addedTaskIds } },
      { $set: { assignedUser: uid, assignedUserName: userName } }
    );
  }
  if (prevOwnerIds.length && addedTaskIds.length) {
    await User.updateMany(
      { _id: { $in: prevOwnerIds } },
      { $pull: { pendingTasks: { $in: addedTaskIds } } }
    );
  }
  if (del.length) {
    await Task.updateMany(
      { _id: { $in: del }, assignedUser: uid },
      { $set: { assignedUser: "", assignedUserName: "unassigned" } }
    );
  }
}

// ROUTES
router.get("/", async (req, res, next) => {
  try {
    const where = buildFindQuery(req);
    const sort = buildSort(req);
    const select = buildSelect(req);
    const countOnly = String(req.query.count).toLowerCase() === "true";
    const { skip, limit } = parsePagination(req, { defaultLimit: null }); 

    if (countOnly) {
      const c = await User.countDocuments(where);
      return ok(res, c);
    }

    const q = User.find(where);
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
    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const nowIds =
      req.body.pendingTasks !== undefined ? toIdStrArray(req.body.pendingTasks) : null;

    if (nowIds && nowIds.length) {
      for (const item of nowIds) {
        if (!mongoose.Types.ObjectId.isValid(item)) {
          return badRequest(res, "task not vaild");
        }
        const t = await Task.findById(item);
        if (!t) return badRequest(res, "task not vaild");
      }
      const doneIds = await Task.find({
        _id: { $in: nowIds },
        completed: true,
      }).distinct("_id");
      if (doneIds.length) {
        return badRequest(
          res,
          `cannot add completed tasks to pendingTasks: ${doneIds.map(String).join(",")}`
        );
      }
    }

    const u = await User.create({
      name,
      email,
      pendingTasks: Array.isArray(req.body.pendingTasks)
        ? req.body.pendingTasks.map(String)
        : [],
    });

    if (nowIds && nowIds.length) {
      await syncTasksOnUserPendingChange(u._id, u.name, nowIds, []);
    }
    
    return created(res, u.toObject());
  } catch (e) {
    if (e?.code === 11000) return badRequest(res, "email already exists");
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const select = buildSelect(req);
    const q = User.findById(req.params.id);
    if (select) q.select(select);
    const u = await q.lean();
    if (!u) return notFound(res, "user not found");
    return ok(res, u);
  } catch (e) {
    if (e?.name === "CastError") return notFound(res, "user not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return notFound(res, "user not found");
    }

    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, "user not found");

    const { name, email } = req.body || {};
    if (!name || !email) return badRequest(res, "name and email are required");

    const oldName = user.name;
    const oldSet = new Set((user.pendingTasks || []).map((x) => String(x)));
    const nowIds =
      req.body.pendingTasks !== undefined ? toIdStrArray(req.body.pendingTasks) : null;

    if (nowIds && nowIds.length) {
      for (const item of nowIds) {
        if (!mongoose.Types.ObjectId.isValid(item)) {
          return badRequest(res, "task not vaild");
        }
        const t = await Task.findById(item);
        if (!t) return badRequest(res, "task not vaild");
      }
      const doneIds = await Task.find({
        _id: { $in: nowIds },
        completed: true,
      }).distinct("_id");
      if (doneIds.length) {
        return badRequest(
          res,
          `cannot add completed tasks to pendingTasks: ${doneIds.map(String).join(",")}`
        );
      }
    }

    user.name = name;
    user.email = email;
    if (nowIds) user.pendingTasks = nowIds;
    await user.save();

    if (nowIds) {
      const added = nowIds.filter(x => !oldSet.has(x));
      const removed = [...oldSet].filter(x => !nowIds.includes(x));
      await syncTasksOnUserPendingChange(user._id, user.name, added, removed);
    }

    if (oldName !== name) {
      await Task.updateMany(
        { assignedUser: String(user._id) },
        { $set: { assignedUserName: name } }
      );
    }

    return ok(res, user.toObject(), "Updated");
  } catch (e) {
    if (e?.name === "CastError" || e?.name === "ValidationError")
      return badRequest(res, "invalid field type or value");
    if (e?.code === 11000) return badRequest(res, "email already exists");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const u = await User.findById(req.params.id);
    if (!u) return notFound(res, "user not found");

    await User.deleteOne({ _id: u._id });
    await Task.updateMany(
      { assignedUser: String(u._id) },
      { $set: { assignedUser: "", assignedUserName: "unassigned" } }
    );

    return ok(res, { _id: String(u._id) }, "Deleted");
  } catch (e) {
    if (e?.name === "CastError") return notFound(res, "user not found");
    if (e?.statusCode === 400) return badRequest(res, e.message);
    return next(e);
  }
});

export default router;
