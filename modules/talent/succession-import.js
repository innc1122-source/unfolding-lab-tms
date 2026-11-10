"use strict";
// 继任计划批量导入 · 服务端逐行校验（第 5 批 8.2，2026-10-08；设计 scratchpad/b5-design.md 第 9.3、9.4 节）
// 纯函数，不读库：查人、范围判定、已有岗位与已有继任行都由 server.js（A 组）以 lookups 注入。
// 只依赖 node:crypto（previewHash）与同目录 filter-model.js（positionKey）。
//
// ───────────────────────────── 导出 API ─────────────────────────────
//   MAX_ROWS = 2000、POSITION_MAX = 80、NOTE_MAX = 300、READINESS = ["ready","oneYear","twoYears"]
//   CODES = { [code]: "error" | "info" }（第 9.3 节的校验码与级别）
//   parseReadiness(text) → "ready" | "oneYear" | "twoYears" | null
//       认的写法（不分大小写，en-dash / 全角连字符与 "-" 相同，空白不计）：
//       ready、即刻就绪、Ready now、即刻；oneYear、1–2 年内就绪、1-2年、Ready in 1–2 years；twoYears、2 年以上就绪、2年以上、Ready in 2+ years
//   validateRows(rows, lookups) →
//       { error:{ code:"over_cap", cap, count } }                         超过 2,000 行（server.js 回 400，不静默截断）
//     | { rows, writes, summary:{create,update,unchanged,error}, outOfScope, previewHash }
//     rows（入参，浏览器解析结果，全部是原始字符串）= [{ line, positionName, employeeId, name, readiness, note }]
//     lookups = {
//       getUserByEmployeeId(eid) → user | null    按工号查人（不分大小写）
//       scopeAllows(user) → bool                 当前管理员的数据范围（scopeAllowsFor）
//       knownPositions: [string]                 范围内员工的 position + 范围内继任行的 positionName
//       existing: [{ id, positionName, userId, readiness, note }]   范围内的继任行
//     }
//     返回的 rows（给前端预览）= [{ line, action:"create"|"update"|"unchanged"|"error", codes:[{code,level}],
//                                  positionName, employeeId, name, readiness, note }]
//       范围外、查无此人的行只回填写的原文（姓名不回填库里的值，免得借预览查人）。
//       update / unchanged 行的 note 是写入后的备注（文件里备注为空时保留原备注）。
//     writes（只给 server.js，不下发）= [{ line, action:"create"|"update", userId, positionName, readiness, note, existingId|null }]
//     outOfScope = employee_out_of_scope 的行数（> 0 时提交必须整批拒绝：sendScopeBulkReject）
//     previewHash = 归一化后的（行号、动作、校验码、userId、岗位、就绪度、备注）排序后 sha256 的前 16 位：
//       与入参行序无关；预览后库里数据变了（动作或校验码变了）哈希就不同 → 提交时回 409 preview_stale。
//   positionKey(name)（转出 filter-model.js）

const crypto = require("crypto");
const { positionKey } = require("./filter-model.js");

const MAX_ROWS = 2000, POSITION_MAX = 80, NOTE_MAX = 300;
const READINESS = Object.freeze(["ready", "oneYear", "twoYears"]);
const CODES = Object.freeze({
  position_required: "error", position_too_long: "error", employee_required: "error", employee_not_found: "error",
  employee_out_of_scope: "error", employee_inactive: "error", readiness_required: "error", readiness_invalid: "error",
  note_too_long: "error", duplicate_in_file: "error",
  position_merged: "info", position_new: "info", name_mismatch: "info", successor_is_holder: "info",
});

const str = (v) => (v === null || v === undefined ? "" : String(v));
const clean = (v) => str(v).replace(/\s+/g, " ").trim();
const READINESS_WORDS = (() => {
  const m = new Map();
  const add = (key, words) => { for (const w of words) m.set(rKey(w), key); };
  add("ready", ["ready", "即刻就绪", "Ready now", "即刻", "readynow"]);
  add("oneYear", ["oneYear", "1-2 年内就绪", "1-2年", "Ready in 1-2 years", "1-2 years", "1-2年内"]);
  add("twoYears", ["twoYears", "2 年以上就绪", "2年以上", "Ready in 2+ years", "2+ years", "2年+"]);
  return m;
})();
function rKey(s) {
  return str(s).normalize("NFKC").toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, "");
}
function parseReadiness(text) {
  const k = rKey(text);
  return k ? READINESS_WORDS.get(k) || null : null;
}
function inactive(u) {
  return u.active === 0 || u.active === false || u.active === "0" || u.empStatus === "exited";
}

function validateRows(rows, lookups) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > MAX_ROWS) return { error: { code: "over_cap", cap: MAX_ROWS, count: list.length } };
  const L = lookups || {};
  const getUser = typeof L.getUserByEmployeeId === "function" ? L.getUserByEmployeeId : () => null;
  const allows = typeof L.scopeAllows === "function" ? L.scopeAllows : () => true;
  // 已有岗位的规范写法：继任行在先（它们是「已有关键岗位」），员工职位在后
  const canonPos = new Map();
  for (const e of L.existing || []) { const k = positionKey(e && e.positionName); if (k && !canonPos.has(k)) canonPos.set(k, clean(e.positionName)); }
  for (const p of L.knownPositions || []) { const k = positionKey(p); if (k && !canonPos.has(k)) canonPos.set(k, clean(p)); }
  const existingBy = new Map();
  for (const e of L.existing || []) {
    if (!e) continue;
    const k = positionKey(e.positionName) + "|" + e.userId;
    if (!existingBy.has(k)) existingBy.set(k, e);
  }
  // 按行号处理（「文件里第一次出现的行有效」与入参顺序无关）
  const ordered = list.map((r, i) => ({ r: r || {}, i })).sort((a, b) => (Number(a.r.line) || 0) - (Number(b.r.line) || 0) || a.i - b.i);
  const filePos = new Map();    // 文件里新出现的岗位：第一次的写法
  const seen = new Set();
  const out = [], writes = [];
  const summary = { create: 0, update: 0, unchanged: 0, error: 0 };
  let outOfScope = 0;
  for (const { r } of ordered) {
    const codes = [];
    const add = (code) => { if (!codes.some((c) => c.code === code)) codes.push({ code, level: CODES[code] }); };
    const line = Number(r.line) || 0;
    const rawPos = clean(r.positionName), eid = clean(r.employeeId), typedName = clean(r.name);
    const rawReady = clean(r.readiness), note = str(r.note).trim();
    const row = { line, action: "error", codes, positionName: rawPos, employeeId: eid, name: typedName, readiness: rawReady, note };
    // 岗位
    let pos = rawPos, pk = "";
    if (!rawPos) add("position_required");
    else if (rawPos.length > POSITION_MAX) add("position_too_long");
    else {
      pk = positionKey(rawPos);
      if (canonPos.has(pk)) { pos = canonPos.get(pk); if (pos !== rawPos) add("position_merged"); }
      else if (filePos.has(pk)) { pos = filePos.get(pk); if (pos !== rawPos) add("position_merged"); add("position_new"); }
      else { filePos.set(pk, rawPos); add("position_new"); }
      row.positionName = pos;
    }
    // 继任人
    let u = null, scoped = false;
    if (!eid) add("employee_required");
    else {
      u = getUser(eid) || null;
      if (!u) add("employee_not_found");
      else if (!allows(u)) { add("employee_out_of_scope"); outOfScope++; }
      else {
        scoped = true;
        row.employeeId = u.employeeId || eid;
        row.name = u.name || typedName;
        if (inactive(u)) add("employee_inactive");
        if (typedName && clean(typedName).toLowerCase() !== clean(u.name).toLowerCase()) add("name_mismatch");
        if (pk && positionKey(u.position) === pk) add("successor_is_holder");
      }
    }
    // 就绪度、备注
    let ready = null;
    if (!rawReady) add("readiness_required");
    else if (!(ready = parseReadiness(rawReady))) add("readiness_invalid");
    else row.readiness = ready;
    if (note.length > NOTE_MAX) add("note_too_long");
    // 文件内重复（同一岗位、同一工号：第一次出现的行有效）
    if (pk && eid) {
      const dk = pk + "|" + (scoped ? u.id : "e:" + eid.toLowerCase());
      if (seen.has(dk)) add("duplicate_in_file");
      else seen.add(dk);
    }
    const hasError = codes.some((c) => c.level === "error");
    if (!hasError) {
      const ex = existingBy.get(pk + "|" + u.id) || null;
      if (!ex) row.action = "create";
      else {
        const nextNote = note || str(ex.note);   // 文件里备注为空 → 保留原备注
        row.note = nextNote;
        row.action = ex.readiness === ready && str(ex.note) === nextNote ? "unchanged" : "update";
      }
      if (row.action !== "unchanged") writes.push({ line, action: row.action, userId: u.id, positionName: pos, readiness: ready, note: row.note || null, existingId: ex ? ex.id : null });
      row._uid = u.id;
    }
    summary[row.action]++;
    out.push(row);
  }
  const hashLines = out.map((x) => JSON.stringify([x.line, x.action, x.codes.map((c) => c.code).sort(), x._uid || null, x.positionName, x.readiness, x.note])).sort();
  const previewHash = crypto.createHash("sha256").update(hashLines.join("\n"), "utf8").digest("hex").slice(0, 16);
  for (const x of out) delete x._uid;
  return { rows: out, writes, summary, outOfScope, previewHash };
}

module.exports = { MAX_ROWS, POSITION_MAX, NOTE_MAX, READINESS, CODES, parseReadiness, validateRows, positionKey };
