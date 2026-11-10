"use strict";
// 题型注册表的公共工具（设计 §1.2）：纯函数、零依赖。
const { LIMITS } = require("./spec.js");

// 填空比对口径（与旧版交卷评分逐字相同）：小写、空白折叠、去首尾空白
const normFill = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
function clampText(v, max) {
  return String(v ?? "").trim().slice(0, max);
}
// JSON 列的防御式解析：坏 JSON / 类型不符 → 兜底值，永不抛错
function parseJson(s, fallback) {
  if (s == null || s === "") return fallback;
  try {
    const v = JSON.parse(s);
    if (Array.isArray(fallback)) return Array.isArray(v) ? v : fallback;
    if (fallback && typeof fallback === "object") return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
    return v;
  } catch { return fallback; }
}
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

// 统一的校验错误：{ error, error_zh, code }（批量导入把 error 用作逐行原因）
const fail = (code, en, zh, extra) => ({ error: en, error_zh: zh, code, ...(extra || {}) });

// 双语文字对 { text, text_zh }：text 必填、text_zh 可空，各自不超过 max 字（超长不截断，直接报错）
// 返回 { value } 或 { error… }。what = 出错时的中英文名（如 ["Step 2", "第 2 步"]）
function biText(o, what, max = LIMITS.text) {
  const src = isPlainObject(o) ? o : typeof o === "string" ? { text: o } : {};
  const text = String(src.text ?? "").trim();
  const zhRaw = src.text_zh == null ? "" : String(src.text_zh).trim();
  if (!text) return fail("empty_text", `${what[0]}: the English text is required.`, `${what[1]}：英文内容不能为空。`);
  if (text.length > max || zhRaw.length > max) return fail("text_too_long", `${what[0]}: at most ${max} characters per language.`, `${what[1]}：每种语言最多 ${max} 字。`);
  return { value: { text, text_zh: zhRaw || null } };
}
// 题库读出的双语对 → 干净的 { text, text_zh }（容忍缺字段，不抛错）
const cleanText = (o) => ({ text: String((o && o.text) ?? ""), text_zh: o && o.text_zh != null && o.text_zh !== "" ? String(o.text_zh) : null });
// 一组双语文字的重复检查（大小写不敏感；中文为空的不比）
function dupIndex(list, field) {
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const v = list[i][field];
    if (v == null || v === "") continue;
    const k = String(v).trim().toLowerCase();
    if (seen.has(k)) return i;
    seen.add(k);
  }
  return -1;
}
// 每题 / 每小题分值：1–100 的整数，其余视为未设置（与旧版口径相同）
function pointsOf(v) {
  const pts = Math.round(Number(v));
  return v != null && v !== "" && Number.isFinite(pts) && pts >= 1 && pts <= 100 ? pts : null;
}

// ---- 学员作答的边界检查 ----
// 0..n-1 的排列
function isPermutation(arr, n) {
  if (!Array.isArray(arr) || arr.length !== n) return false;
  const seen = new Set();
  for (const v of arr) { if (!isInt(v) || v < 0 || v >= n || seen.has(v)) return false; seen.add(v); }
  return true;
}
// 长度为 n 的数组，每项是 [0, max) 的整数或 null；全部为 null 视为未作答 → null；任何越界 → null
function intSlots(raw, n, max) {
  if (!Array.isArray(raw) || raw.length !== n) return null;
  const out = [];
  for (const v of raw) {
    if (v === null || v === undefined) { out.push(null); continue; }
    if (!isInt(v) || v < 0 || v >= max) return null;
    out.push(v);
  }
  return out.some((v) => v !== null) ? out : null;
}

// ---- 打乱 ----
const range = (n) => Array.from({ length: n }, (_, i) => i);
const isIdentity = (perm) => perm.every((v, i) => v === i);
// 打乱且保证不是原顺序（n ≥ 2）：排序题原顺序就是答案。注入的 shuffle 若一直返回原顺序（测试桩），
// 有限次后退化为整体右移一位，仍不是原顺序。返回的是下标排列。
function shuffleNonIdentity(n, shuffle) {
  const base = range(n);
  if (n < 2) return base;
  for (let t = 0; t < 20; t++) {
    const p = shuffle(base);
    if (!isIdentity(p)) return p;
  }
  return base.map((_, i) => (i + n - 1) % n);
}

// 考试开关（数据库里是 0/1，接口里是布尔）：只有明确的 false / 0 才算关；缺省 = 开
const flagOn = (v) => v !== false && v !== 0;
const noShuffle = (ctx) => !!ctx && !flagOn(ctx.shuffleOptions);
// 得分比例 → { credit, isRight, partial }
function creditFields(credit) {
  return { credit, isRight: credit === 1, partial: credit > 0 && credit < 1 };
}
// 任一明细项（新旧题型）的得分比例：新题型直接读 credit；旧题型按旧口径（答对 1、多选部分正确 0.5）
function creditOf(d) {
  if (d && typeof d.credit === "number" && Number.isFinite(d.credit)) return d.credit;
  return d && d.isRight ? 1 : d && d.partial ? 0.5 : 0;
}
// 新题型的分值：带 points 用 points，旧口径（考试没设题型分值）每题 1 分
const ptsOf = (d) => (d.points != null ? Number(d.points) || 0 : 1);

// 旧四种题型的列映射（store.js insertQuestionRow / updateQuestion 逐字照搬；不按题型分支，data 列恒为 null）
function legacyColumns(q) {
  return {
    options: q.options ? JSON.stringify(q.options) : q.answers ? JSON.stringify(q.answers) : null,
    data: null,
    explanation: q.explanation || null, explanation_zh: q.explanation_zh || null,
    rubric: q.rubric || null, rubric_zh: q.rubric_zh || null,
    maxPoints: q.maxPoints != null ? q.maxPoints : null,
  };
}
// 新题型的列映射：题型数据进 data 列（JSON），讲解沿用原有两列，其余列为空
function dataColumns(q, data) {
  return {
    options: null, data: JSON.stringify(data),
    explanation: q.explanation || null, explanation_zh: q.explanation_zh || null,
    rubric: null, rubric_zh: null, maxPoints: null,
  };
}
// 新题型共用的讲解字段（与旧题型同一口径）
const explanationFields = (q) => ({ explanation: q.explanation || "", explanation_zh: q.explanation_zh || null });

module.exports = {
  legacyColumns, dataColumns, explanationFields,
  flagOn, noShuffle,
  normFill, clampText, parseJson, isPlainObject, isInt, fail, biText, cleanText, dupIndex, pointsOf,
  isPermutation, intSlots, range, isIdentity, shuffleNonIdentity, creditFields, creditOf, ptsOf,
};
