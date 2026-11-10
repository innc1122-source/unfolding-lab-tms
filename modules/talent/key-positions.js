"use strict";
// 关键岗位清单 · 校验、导入预览与继任覆盖（12.2 工作台改版 组 1，2026-10-09；设计 scratchpad/b12-design.md 第 4 节、2.1、2.8）
// 纯函数，不读库：部门解析、范围判定、已有岗位、继任行与人员都由 server.js（组 2）以参数注入。
// 只依赖 node:crypto（previewHash）与同目录 filter-model.js（positionKey），形状对齐 succession-import.js。
//
// ───────────────────────────── 导出 API ─────────────────────────────
// 常量
//   MAX_ROWS = 1000、NAME_MAX = 80（= SUCC_IMPORT.POSITION_MAX）、NOTE_MAX = 300
//   READINESS = ["ready","oneYear","twoYears"]；COVER_READINESS = ["ready","oneYear"]（计入覆盖率的「1 年内就绪」）
//   SOURCES = ["manual","import","succession"]（key_positions.source）
//   CODES = { [code]: "error" | "info" }
//     error：name_required、name_too_long、dept_required、dept_unknown、dept_out_of_scope、dup_in_file、is_key_invalid、
//            note_too_long、position_out_of_scope
//     info ：name_merged
//     与设计 4.4 相比多两条（偏差，已在报告中说明）：
//       position_out_of_scope（error，计入 outOfScope）—— 同键岗位已存在、但它所在部门不在当前范围内（lookups.rowAllows 为假），
//                               不能经导入改写范围外的行；
//       name_merged（info）      —— 同键岗位已存在且写法不同：沿用清单里的写法，导入不改名。
// 单条校验（POST / PUT 用）
//   parseIsKey(text) → 1 | 0 | null      空 → 1（缺省是）；是 / Y / Yes / 1 / True / 关键 / Key → 1；
//                                        否 / N / No / 0 / False / 非关键 / Non-key → 0；其余 → null（is_key_invalid）
//                                        布尔与数字 1 / 0 原样认
//   validateOne(body, { partial }) → { ok:true, value } | { ok:false, code, field }
//       body = { name, isKey, note }（deptId 由 server.js 自己按范围判定：dept_required / dept_out_of_scope）
//       value = { name（压缩空白后）, nameKey, isKey: 0|1, note: string|null }；partial = true（PUT）时只校验并返回 body 里出现的字段
//       code：name_required | name_too_long | is_key_invalid | note_too_long
//   auditView(row) → { name, dept, isKey: bool, note }      审计 before / after（dept = row.deptName）
// 导入（4.4）
//   validateRows(rows, lookups) →
//       { error:{ code:"over_cap", cap, count } }                       超过 1,000 行（server.js 回 400，不静默截断）
//     | { rows, writes, summary:{ create, update, unchanged, error }, outOfScope, previewHash }
//     rows（入参，浏览器解析结果，原始字符串）= [{ line, name, dept, isKey, note }]
//     lookups = {
//       resolveDept(text) → { id, name } | null     部门名或部门路径 → 部门；查不到 → null（dept_unknown）
//       deptAllows(dept) → bool                     当前管理员范围（scopeDeptPredicate）；假 → dept_out_of_scope，计入 outOfScope
//       existing: [{ id, name, nameKey?, deptId, deptName, isKey, note }]   全部已有关键岗位（不只范围内：唯一性是全局的）
//       rowAllows(existingRow) → bool               已有行是否在范围内（缺省全为真）；假 → position_out_of_scope，计入 outOfScope
//       source: "import" | "succession"             writes 的 source（缺省 import）
//     }
//     返回 rows（给前端预览）= [{ line, action:"create"|"update"|"unchanged"|"error", codes:[{ code, level }],
//                                name, dept, deptId, isKey, note, existingId }]
//       name：合并后的写法；dept：解析出的部门名（解析不到时为原文）；isKey：0 / 1（无效时为原文）；
//       update / unchanged 行的 note 是写入后的备注（文件里备注为空时保留原备注）。
//     动作：清单里没有同键 → create；有 → 部门、是否关键、备注任一有变化 → update，否则 unchanged。同键在文件里重复 → 后出现的行
//           dup_in_file（按行号，第一行有效，与入参顺序无关；重复行不再判 name_merged / position_out_of_scope）。
//     writes（只给 server.js）= [{ line, action:"create"|"update", existingId|null, name, nameKey, deptId, deptName, isKey, note|null, source }]
//     outOfScope = dept_out_of_scope + position_out_of_scope 的行数（> 0 时提交整批拒绝：sendScopeBulkReject）
//     previewHash = 归一化后（行号、动作、校验码、键、部门 id、是否关键、备注）排序后 sha256 前 16 位；与行序无关，库里数据变了就不同
//                   → 提交时回 409 preview_stale（同继任导入）。
//   unmatchedSuccessionPositions(successions, positions) → [{ name, nameKey, count }]
//       继任行里出现、清单里没有的岗位（按 positionKey 归并，name 取第一次出现的写法，count = 继任行数），按 name 排序。
//       successions 由调用方先按范围过滤（GET /api/admin/key-positions 的 unmatchedSuccessionPositions）。
//   rowsFromSuccession(unmatched, holders) → [{ line, name, dept, isKey:"", note:"" }]
//       「从继任计划带入」的预览行（line 从 1 起）：holders = 范围内在职员工 [{ position, deptName }]（或 department）；
//       同键在任者的部门唯一 → dept 填该部门名，否则留空（预览报 dept_required，由 HR 补选）。再交给 validateRows（source:"succession"）。
// 继任覆盖（2.1、4.3）
//   coverageByKey(successions, successorOk) → Map(nameKey → { ready, oneYear, twoYears, total, userIds:[] })
//       successions = [{ positionName, userId, readiness }]；successorOk(row) → bool（在职且在查看者范围内，由调用方判定）。
//       同一岗位同一人多行只算一次（取最高就绪度）。
//   bestReadiness(c) → "ready" | "oneYear" | "twoYears" | null
//   successionCoverage(positions, successions, successorOk) →
//       { den, num, noSuccessor, value, empty, rows:[{ id, name, nameKey, deptId, deptName, ready, oneYear, twoYears, total, best, covered }] }
//       positions = 查看者范围内的关键岗位行（调用方先按 deptName 过滤）；只有 isKey 为真的计入 den 与 rows。
//       num = 至少 1 名 ready / oneYear 继任者的岗位数；noSuccessor = 没有任何继任者的岗位数；value = 百分比一位小数（den 0 → null）；
//       empty = den 为 0 时 "no_key_positions"，否则 null。
//   successionSnapshotRows(positions, successions, { userById, deptNameOf?, inService? }) →
//       [{ subjectId, deptName, data:{ name, nameKey, isKey, successors:[{ userId, deptName, readiness, inService }] } }]
//       快照 metric = "succession"（2.8），全公司口径，不按范围裁剪；deptNameOf 缺省 u.department。
//   successionFromSnapshot(rows, deptAllows) → 与 successionCoverage 同形
//       岗位按 row.deptName、继任者按 successor.deptName 用 deptAllows 过滤（deptName 为空时由 deptAllows 自己决定），
//       继任者另须 inService；id = subjectId。
//   positionKey(name)（转出 filter-model.js）

const crypto = require("crypto");
const { positionKey } = require("./filter-model.js");

const MAX_ROWS = 1000, NAME_MAX = 80, NOTE_MAX = 300;
const READINESS = Object.freeze(["ready", "oneYear", "twoYears"]);
const COVER_READINESS = Object.freeze(["ready", "oneYear"]);
const SOURCES = Object.freeze(["manual", "import", "succession"]);
const CODES = Object.freeze({
  name_required: "error", name_too_long: "error", dept_required: "error", dept_unknown: "error",
  dept_out_of_scope: "error", dup_in_file: "error", is_key_invalid: "error", note_too_long: "error",
  position_out_of_scope: "error", name_merged: "info",
});

const str = (v) => (v === null || v === undefined ? "" : String(v));
const clean = (v) => str(v).replace(/\s+/g, " ").trim();
const nChars = (s) => Array.from(s).length;
const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const inService = (u) => !!u && u.active !== 0 && u.active !== false && u.active !== "0" && u.empStatus !== "exited";

const IS_KEY_WORDS = (() => {
  const m = new Map();
  for (const w of ["是", "y", "yes", "1", "true", "关键", "關鍵", "key", "关键岗位"]) m.set(w, 1);
  for (const w of ["否", "n", "no", "0", "false", "非关键", "非關鍵", "nonkey", "notkey", "非关键岗位"]) m.set(w, 0);
  return m;
})();
function parseIsKey(text) {
  if (text === true || text === 1) return 1;
  if (text === false || text === 0) return 0;
  const k = str(text).normalize("NFKC").toLowerCase().replace(/[\s\-‐-―−_]+/g, "");
  if (!k) return 1;
  return IS_KEY_WORDS.has(k) ? IS_KEY_WORDS.get(k) : null;
}
function validateOne(body, opts) {
  const b = body || {};
  const partial = !!(opts && opts.partial);
  const value = {};
  const has = (f) => !partial || Object.prototype.hasOwnProperty.call(b, f);
  if (has("name")) {
    const name = clean(b.name);
    if (!name) return { ok: false, code: "name_required", field: "name" };
    if (nChars(name) > NAME_MAX) return { ok: false, code: "name_too_long", field: "name" };
    value.name = name;
    value.nameKey = positionKey(name);
  }
  if (has("isKey")) {
    const k = b.isKey === undefined || b.isKey === null ? 1 : parseIsKey(b.isKey);
    if (k === null) return { ok: false, code: "is_key_invalid", field: "isKey" };
    value.isKey = k;
  }
  if (has("note")) {
    const note = str(b.note).trim();
    if (nChars(note) > NOTE_MAX) return { ok: false, code: "note_too_long", field: "note" };
    value.note = note || null;
  }
  return { ok: true, value };
}
function auditView(row) {
  const r = row || {};
  return { name: r.name || null, dept: r.deptName || null, isKey: !!Number(r.isKey), note: r.note || null };
}

function validateRows(rows, lookups) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > MAX_ROWS) return { error: { code: "over_cap", cap: MAX_ROWS, count: list.length } };
  const L = lookups || {};
  const resolveDept = typeof L.resolveDept === "function" ? L.resolveDept : () => null;
  const deptAllows = typeof L.deptAllows === "function" ? L.deptAllows : () => true;
  const rowAllows = typeof L.rowAllows === "function" ? L.rowAllows : () => true;
  const source = L.source === "succession" ? "succession" : "import";
  const existingBy = new Map();
  for (const e of L.existing || []) {
    if (!e) continue;
    const k = e.nameKey || positionKey(e.name);
    if (k && !existingBy.has(k)) existingBy.set(k, e);
  }
  const ordered = list.map((r, i) => ({ r: r || {}, i })).sort((a, b) => (Number(a.r.line) || 0) - (Number(b.r.line) || 0) || a.i - b.i);
  const seen = new Set();
  const out = [], writes = [];
  const summary = { create: 0, update: 0, unchanged: 0, error: 0 };
  let outOfScope = 0;
  for (const { r } of ordered) {
    const codes = [];
    const add = (code) => { if (!codes.some((c) => c.code === code)) codes.push({ code, level: CODES[code] }); };
    const line = Number(r.line) || 0;
    const rawName = clean(r.name), rawDept = clean(r.dept), rawKey = clean(r.isKey), note = str(r.note).trim();
    const row = { line, action: "error", codes, name: rawName, dept: rawDept, deptId: null, isKey: rawKey, note, existingId: null };
    // 岗位名
    let nk = "", ex = null;
    if (!rawName) add("name_required");
    else if (nChars(rawName) > NAME_MAX) add("name_too_long");
    else {
      nk = positionKey(rawName);
      ex = existingBy.get(nk) || null;
      if (seen.has(nk)) add("dup_in_file");   // 重复行只报这一条（不再判同键已有行）
      else seen.add(nk);
      if (ex && !codes.length) {
        row.existingId = ex.id;
        if (!rowAllows(ex)) { add("position_out_of_scope"); outOfScope++; }
        else if (clean(ex.name) && clean(ex.name) !== rawName) { row.name = clean(ex.name); add("name_merged"); }
      }
    }
    // 部门
    let dept = null;
    if (!rawDept) add("dept_required");
    else {
      dept = resolveDept(rawDept) || null;
      if (!dept) add("dept_unknown");
      else if (!deptAllows(dept)) { add("dept_out_of_scope"); outOfScope++; dept = null; }
      else { row.dept = dept.name; row.deptId = dept.id; }
    }
    // 是否关键、备注
    const isKey = parseIsKey(rawKey);
    if (isKey === null) add("is_key_invalid");
    else row.isKey = isKey;
    if (nChars(note) > NOTE_MAX) add("note_too_long");
    const hasError = codes.some((c) => c.level === "error");
    if (!hasError) {
      if (!ex) row.action = "create";
      else {
        const nextNote = note || str(ex.note);
        row.note = nextNote;
        const same = str(ex.deptId) === str(dept.id) && Number(ex.isKey ? 1 : 0) === isKey && str(ex.note) === nextNote;
        row.action = same ? "unchanged" : "update";
      }
      if (row.action !== "unchanged") {
        writes.push({ line, action: row.action, existingId: ex ? ex.id : null, name: row.name, nameKey: nk,
          deptId: dept.id, deptName: dept.name, isKey, note: row.note || null, source });
      }
    }
    row._k = nk;
    summary[row.action]++;
    out.push(row);
  }
  const hashLines = out.map((x) => JSON.stringify([x.line, x.action, x.codes.map((c) => c.code).sort(), x._k, x.deptId, x.isKey, x.note])).sort();
  const previewHash = crypto.createHash("sha256").update(hashLines.join("\n"), "utf8").digest("hex").slice(0, 16);
  for (const x of out) delete x._k;
  return { rows: out, writes, summary, outOfScope, previewHash };
}

function unmatchedSuccessionPositions(successions, positions) {
  const have = new Set();
  for (const p of positions || []) { if (!p) continue; const k = p.nameKey || positionKey(p.name); if (k) have.add(k); }
  const by = new Map();
  for (const s of successions || []) {
    if (!s) continue;
    const k = positionKey(s.positionName);
    if (!k || have.has(k)) continue;
    if (!by.has(k)) by.set(k, { name: clean(s.positionName), nameKey: k, count: 0 });
    by.get(k).count++;
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function rowsFromSuccession(unmatched, holders) {
  const depts = new Map();
  for (const h of holders || []) {
    if (!h) continue;
    const k = positionKey(h.position);
    const d = clean(h.deptName !== undefined ? h.deptName : h.department);
    if (!k || !d) continue;
    if (!depts.has(k)) depts.set(k, new Set());
    depts.get(k).add(d);
  }
  return (unmatched || []).map((u, i) => {
    const k = u.nameKey || positionKey(u.name);
    const ds = depts.get(k);
    return { line: i + 1, name: clean(u.name), dept: ds && ds.size === 1 ? [...ds][0] : "", isKey: "", note: "" };
  });
}

const RANK = { ready: 0, oneYear: 1, twoYears: 2 };
function coverageByKey(successions, successorOk) {
  const ok = typeof successorOk === "function" ? successorOk : () => true;
  const best = new Map();   // nameKey → Map(userId → readiness)
  for (const s of successions || []) {
    if (!s || !READINESS.includes(s.readiness) || !ok(s)) continue;
    const k = positionKey(s.positionName);
    if (!k) continue;
    if (!best.has(k)) best.set(k, new Map());
    const m = best.get(k), cur = m.get(s.userId);
    if (cur === undefined || RANK[s.readiness] < RANK[cur]) m.set(s.userId, s.readiness);
  }
  const out = new Map();
  for (const [k, m] of best) {
    const c = { ready: 0, oneYear: 0, twoYears: 0, total: 0, userIds: [] };
    for (const [uid, r] of m) { c[r]++; c.total++; c.userIds.push(uid); }
    out.set(k, c);
  }
  return out;
}
function bestReadiness(c) {
  if (!c) return null;
  for (const r of READINESS) if (c[r] > 0) return r;
  return null;
}
const isKeyRow = (p) => !!p && (p.isKey === undefined || p.isKey === null ? true : !!Number(p.isKey));
function coverageResult(positions, cov) {
  const rows = [];
  let num = 0, noSuccessor = 0;
  for (const p of positions) {
    const k = p.nameKey || positionKey(p.name);
    const c = cov.get(k) || { ready: 0, oneYear: 0, twoYears: 0, total: 0 };
    const covered = COVER_READINESS.some((r) => c[r] > 0);
    if (covered) num++;
    if (!c.total) noSuccessor++;
    rows.push({ id: p.id, name: p.name, nameKey: k, deptId: p.deptId || null, deptName: p.deptName || null,
      ready: c.ready, oneYear: c.oneYear, twoYears: c.twoYears, total: c.total, best: bestReadiness(c), covered });
  }
  const den = rows.length;
  return { den, num, noSuccessor, value: pct1(num, den), empty: den ? null : "no_key_positions", rows };
}
function successionCoverage(positions, successions, successorOk) {
  return coverageResult((positions || []).filter(isKeyRow), coverageByKey(successions, successorOk));
}
function successionSnapshotRows(positions, successions, opts) {
  const o = opts || {};
  const userById = typeof o.userById === "function" ? o.userById : () => null;
  const deptNameOf = typeof o.deptNameOf === "function" ? o.deptNameOf : (u) => (u && u.department) || null;
  const live = typeof o.inService === "function" ? o.inService : inService;
  const byKey = new Map();
  for (const s of successions || []) {
    if (!s || !READINESS.includes(s.readiness)) continue;
    const k = positionKey(s.positionName);
    if (!k) continue;
    const u = userById(s.userId);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ userId: s.userId, deptName: u ? deptNameOf(u) || null : null, readiness: s.readiness, inService: !!(u && live(u)) });
  }
  return (positions || []).filter(Boolean).map((p) => {
    const k = p.nameKey || positionKey(p.name);
    return { subjectId: p.id, deptName: p.deptName || null,
      data: { name: p.name, nameKey: k, isKey: isKeyRow(p) ? 1 : 0, successors: byKey.get(k) || [] } };
  });
}
function successionFromSnapshot(rows, deptAllows) {
  const allows = typeof deptAllows === "function" ? deptAllows : () => true;
  const positions = [], succ = [];
  for (const r of rows || []) {
    if (!r || !r.data || !Number(r.data.isKey) || !allows(r.deptName || null)) continue;
    positions.push({ id: r.subjectId, name: r.data.name, nameKey: r.data.nameKey, deptName: r.deptName || null, isKey: 1 });
    for (const s of r.data.successors || []) {
      if (s && s.inService && allows(s.deptName || null)) succ.push({ positionName: r.data.name, userId: s.userId, readiness: s.readiness });
    }
  }
  // 快照里的 positionName 就是岗位名（同键），按 nameKey 归并即可
  return coverageResult(positions, coverageByKey(succ, () => true));
}

module.exports = {
  MAX_ROWS, NAME_MAX, NOTE_MAX, READINESS, COVER_READINESS, SOURCES, CODES,
  parseIsKey, validateOne, auditView, validateRows, unmatchedSuccessionPositions, rowsFromSuccession,
  coverageByKey, bestReadiness, successionCoverage, successionSnapshotRows, successionFromSnapshot, positionKey,
};
