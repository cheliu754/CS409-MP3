// routes/_shared.js
import mongoose from "mongoose";

/* ---------- Response helpers ---------- */
export const ok = (res, data, msg = "OK") => res.status(200).json({ message: msg, data });
export const created = (res, data, msg = "Created") => res.status(201).json({ message: msg, data });
export const noContent = (res) => res.status(204).send();
export const badRequest = (res, msg) => res.status(400).json({ message: msg, data: {} });
export const notFound = (res, msg) => res.status(404).json({ message: msg, data: {} });

/* ---------- ID / params ---------- */
export const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

export function toIdStr(val) {
  if (val === undefined || val === null) return "";
  const s = String(val).trim();
  return s.length ? s : "";
}
export const isEmptyId = (s) => s === "" || s === undefined || s === null;

export function toIdStrArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const s = toIdStr(x);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/* ---------- Query helpers ---------- */
export function parseJsonParam(name, raw, fallback) {
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error(`Invalid JSON for '${name}'`);
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Mongo 投影：禁止包含式与排除式混用（除 _id 外）
 */
export function sanitizeSelect(sel) {
  if (!sel) return undefined;
  const entries = Object.entries(sel);
  if (entries.length === 0) return undefined;

  const isInc = entries.some(([, v]) => v === 1 || v === true);
  const isExc = entries.some(([, v]) => v === 0 || v === false);

  if (isInc && isExc) {
    // 只允许 _id 例外
    const { _id, ...rest } = sel;
    const restHasExc = Object.values(rest).some((v) => v === 0 || v === false);
    if (restHasExc) {
      const err = new Error("Cannot mix inclusion and exclusion in select (except _id).");
      err.statusCode = 400;
      throw err;
    }
  }
  return sel;
}

/**
 * 解析非负整数（用于 skip/limit）。非法则抛 400。
 */
export function parseNonNegInt(name, raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    const err = new Error(`${name} must be a non-negative integer`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}
