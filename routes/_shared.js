// routes/_shared.js
import mongoose from "mongoose";

/* ---------------- HTTP helpers (统一 envelope) ---------------- */
export const ok = (res, data, msg = "OK") =>
  res.status(200).json({ message: msg, data });

export const created = (res, data, msg = "Created") =>
  res.status(201).json({ message: msg, data });

export const noContent = (res) => res.status(204).send();

export const badRequest = (res, msg) =>
  res.status(400).json({ message: msg, data: {} });

export const notFound = (res, msg) =>
  res.status(404).json({ message: msg, data: {} });

/* ---------------- utils ---------------- */
export const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

export const parseJsonParam = (name, raw, fallback) => {
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error(`Invalid JSON for '${name}'`);
    err.statusCode = 400;
    throw err;
  }
};

export const sanitizeSelect = (sel) => {
  if (!sel) return undefined;
  const entries = Object.entries(sel);
  if (entries.length === 0) return undefined;
  const isInc = entries.some(([, v]) => v === 1 || v === true);
  const isExc = entries.some(([, v]) => v === 0 || v === false);
  if (isInc && isExc) {
    // 允许 _id 例外
    const { _id, ...rest } = sel;
    const restHasExc = Object.values(rest).some((v) => v === 0 || v === false);
    if (restHasExc) {
      const err = new Error("Cannot mix inclusion and exclusion in select (except _id).");
      err.statusCode = 400;
      throw err;
    }
  }
  return sel;
};

export const toIdStr = (v) => {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  return s;
};

export const isEmptyId = (s) => !s || s === "0" || s === "null" || s === "undefined";

export const toIdStrArray = (arr) => {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x)).filter((x) => x && x !== "null" && x !== "undefined");
};
