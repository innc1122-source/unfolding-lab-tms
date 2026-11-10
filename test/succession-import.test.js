// 第 5 批 8.2（2026-10-08）：继任计划批量导入的服务端逐行校验（modules/talent/succession-import.js）。
//   每个校验码、就绪度的各种写法、岗位名归并（F23「岗位重名」）、文件内重复、已有行的更新与无变化、备注为空时保留原备注、
//   2,000 行上限、previewHash 与入参行序无关且随数据变化、范围外的行不回填库里的姓名。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../modules/talent/succession-import.js");

const USERS = [
  { id: "u1", employeeId: "T-00001", name: "Ana Cruz", position: "Finance Manager", active: 1, empStatus: "regular", department: "Finance" },
  { id: "u2", employeeId: "T-00002", name: "Ben Lim", position: "AP Clerk", active: 1, empStatus: "regular", department: "Finance" },
  { id: "u3", employeeId: "T-00003", name: "Cy Tan", position: "Sales Lead", active: 1, empStatus: "regular", department: "Sales" },
  { id: "u4", employeeId: "T-00004", name: "Di Reyes", position: "Analyst", active: 0, empStatus: "exited", department: "Finance" },
  { id: "u5", employeeId: "T-00005", name: "Ed Go", position: "Head of Finance", active: 1, empStatus: "regular", department: "Finance" },
];
function lookups(over) {
  return {
    getUserByEmployeeId: (eid) => USERS.find((u) => u.employeeId.toLowerCase() === String(eid).trim().toLowerCase()) || null,
    scopeAllows: (u) => u.department === "Finance",
    knownPositions: ["Finance Manager", "Head of Finance", "AP Clerk", "Analyst"],
    existing: [
      { id: "s1", positionName: "Head of Finance", userId: "u1", readiness: "oneYear", note: "Strong pipeline" },
      { id: "s2", positionName: "Finance Manager", userId: "u2", readiness: "ready", note: null },
    ],
    ...(over || {}),
  };
}
const row = (line, positionName, employeeId, readiness, extra) => ({ line, positionName, employeeId, readiness, name: "", note: "", ...(extra || {}) });
const codesOf = (r) => r.codes.map((c) => c.code).sort();

test("parseReadiness: every accepted spelling in both languages, en-dash = hyphen, case and spaces ignored", () => {
  const cases = {
    ready: ["ready", "READY", "即刻就绪", "Ready now", "ready  NOW", "即刻"],
    oneYear: ["oneYear", "oneyear", "1–2 年内就绪", "1-2 年内就绪", "1-2年", "1–2年", "Ready in 1–2 years", "ready in 1-2 years", "１－２年"],
    twoYears: ["twoYears", "2 年以上就绪", "2年以上", "Ready in 2+ years", "ready in 2+ YEARS"],
  };
  for (const [want, list] of Object.entries(cases)) for (const s of list) assert.equal(S.parseReadiness(s), want, s);
  for (const s of ["", "soon", "3年", "Ready in 3 years", null]) assert.equal(S.parseReadiness(s), null, String(s));
});

test("validateRows: one row per error code; errors are actions 'error' and never written", () => {
  const rows = [
    row(2, "", "T-00002", "ready"),                                   // position_required
    row(3, "x".repeat(81), "T-00002", "ready"),                       // position_too_long
    row(4, "Head of Finance", "", "ready"),                           // employee_required
    row(5, "Head of Finance", "T-09999", "ready"),                    // employee_not_found
    row(6, "Head of Finance", "T-00003", "ready", { name: "Typed Name" }), // employee_out_of_scope
    row(7, "Head of Finance", "T-00004", "ready"),                     // employee_inactive
    row(8, "Head of Finance", "T-00002", ""),                          // readiness_required
    row(9, "Head of Finance", "T-00002", "someday"),                   // readiness_invalid
    row(10, "Finance Manager", "T-00005", "ready", { note: "n".repeat(301) }), // note_too_long
    row(11, "Analyst", "T-00002", "ready"),
    row(12, "analyst", "t-00002", "twoYears"),                         // duplicate_in_file（第一次出现的第 11 行有效）
  ];
  const r = S.validateRows(rows, lookups());
  const by = Object.fromEntries(r.rows.map((x) => [x.line, x]));
  const expect = { 2: "position_required", 3: "position_too_long", 4: "employee_required", 5: "employee_not_found", 6: "employee_out_of_scope",
    7: "employee_inactive", 8: "readiness_required", 9: "readiness_invalid", 10: "note_too_long", 12: "duplicate_in_file" };
  for (const [line, code] of Object.entries(expect)) {
    assert.equal(by[line].action, "error", `line ${line}`);
    assert.ok(codesOf(by[line]).includes(code), `line ${line}: ${JSON.stringify(by[line].codes)}`);
    assert.equal(by[line].codes.find((c) => c.code === code).level, "error");
  }
  assert.equal(by[11].action, "create");
  assert.deepEqual(r.summary, { create: 1, update: 0, unchanged: 0, error: 10 });
  assert.deepEqual(r.writes.map((w) => w.line), [11]);
  assert.equal(r.outOfScope, 1);
  // 范围外的行只回填写的原文，不借预览查人
  assert.equal(by[6].name, "Typed Name");
  assert.equal(by[6].employeeId, "T-00003");
  assert.ok(!JSON.stringify(r.rows).includes("Cy Tan"));
  assert.ok(!JSON.stringify(r.rows).includes("Sales Lead"));
  // 每个码都在 CODES 里登记了级别
  for (const x of r.rows) for (const c of x.codes) assert.equal(S.CODES[c.code], c.level);
});

test("validateRows: info codes — position_merged, position_new, name_mismatch, successor_is_holder", () => {
  const r = S.validateRows([
    row(2, "head of  FINANCE", "T-00002", "Ready now", { name: "ben lim" }),
    row(3, "Head-of Finance", "T-00005", "ready"),
    row(4, "Chief Data Officer", "T-00001", "2年以上", { name: "Someone Else" }),
    row(5, "chief data-officer", "T-00002", "twoYears"),
  ], lookups());
  const [a, b, c, d] = r.rows;
  assert.deepEqual(codesOf(a), ["position_merged"]);
  assert.equal(a.positionName, "Head of Finance");
  assert.equal(a.name, "Ben Lim");
  assert.equal(a.readiness, "ready");
  assert.deepEqual(codesOf(b), ["position_merged", "successor_is_holder"]);
  assert.equal(b.action, "create");
  assert.deepEqual(codesOf(c), ["name_mismatch", "position_new"]);
  assert.equal(c.codes.find((x) => x.code === "name_mismatch").level, "info");
  assert.deepEqual(codesOf(d), ["position_merged", "position_new"]);
  assert.equal(d.positionName, "Chief Data Officer", "a new position is spelled the way the file first wrote it");
  assert.ok(r.rows.every((x) => x.action === "create"));
  assert.deepEqual(r.writes.map((w) => [w.positionName, w.userId, w.readiness]), [
    ["Head of Finance", "u2", "ready"], ["Head of Finance", "u5", "ready"], ["Chief Data Officer", "u1", "twoYears"], ["Chief Data Officer", "u2", "twoYears"]]);
});

test("validateRows: existing (position, successor) → update or unchanged; an empty note keeps the old note", () => {
  const r = S.validateRows([
    row(2, "Head of Finance", "T-00001", "oneYear"),                         // 与库里相同、备注为空 → unchanged，保留原备注
    row(3, "Finance Manager", "T-00002", "即刻就绪"),                          // 相同 → unchanged
    row(4, "head of finance", "T-00001", "Ready now", { note: "" }),           // 文件内重复 → error
  ], lookups());
  assert.deepEqual(r.rows.map((x) => x.action), ["unchanged", "unchanged", "error"]);
  assert.equal(r.rows[0].note, "Strong pipeline");
  assert.deepEqual(r.writes, []);
  const r2 = S.validateRows([
    row(2, "Head of Finance", "T-00001", "ready"),                           // 就绪度变了 → update，备注保留
    row(3, "Finance Manager", "T-00002", "ready", { note: "Covers AP close" }), // 备注变了 → update
  ], lookups());
  assert.deepEqual(r2.rows.map((x) => x.action), ["update", "update"]);
  assert.deepEqual(r2.writes, [
    { line: 2, action: "update", userId: "u1", positionName: "Head of Finance", readiness: "ready", note: "Strong pipeline", existingId: "s1" },
    { line: 3, action: "update", userId: "u2", positionName: "Finance Manager", readiness: "ready", note: "Covers AP close", existingId: "s2" },
  ]);
  assert.deepEqual(r2.summary, { create: 0, update: 2, unchanged: 0, error: 0 });
});

test("validateRows: 2,000-row cap is a hard stop (over_cap), not a silent truncation", () => {
  const many = Array.from({ length: 2001 }, (_, i) => row(i + 2, "Analyst", "T-00002", "ready"));
  assert.deepEqual(S.validateRows(many, lookups()), { error: { code: "over_cap", cap: 2000, count: 2001 } });
  const ok = S.validateRows(many.slice(0, 2000), lookups());
  assert.equal(ok.rows.length, 2000);
  assert.equal(ok.summary.create, 1);
  assert.equal(ok.summary.error, 1999);
  assert.equal(S.MAX_ROWS, 2000);
});

test("previewHash: independent of row order, changes when the data or the outcome changes", () => {
  const rows = [row(2, "Head of Finance", "T-00002", "ready"), row(3, "Analyst", "T-00001", "oneYear", { note: "x" }), row(4, "Analyst", "T-00001", "ready")];
  const h1 = S.validateRows(rows, lookups()).previewHash;
  assert.match(h1, /^[0-9a-f]{16}$/);
  const shuffled = [rows[2], rows[0], rows[1]];
  const r2 = S.validateRows(shuffled, lookups());
  assert.equal(r2.previewHash, h1);
  assert.deepEqual(r2.rows.map((x) => x.line), [2, 3, 4], "processed by line, so line 3 stays the valid one and 4 the duplicate");
  assert.equal(r2.rows[2].action, "error");
  // 预览后有人把同一组合加进了继任名单 → 动作从 create 变成 update → 哈希不同（提交时 409 preview_stale）
  const changed = lookups();
  changed.existing = changed.existing.concat([{ id: "s9", positionName: "Analyst", userId: "u1", readiness: "twoYears", note: null }]);
  assert.notEqual(S.validateRows(rows, changed).previewHash, h1);
  // 文件内容变了也不同
  assert.notEqual(S.validateRows([row(2, "Head of Finance", "T-00002", "twoYears"), rows[1], rows[2]], lookups()).previewHash, h1);
  // 范围变了（某行变成范围外）也不同
  assert.notEqual(S.validateRows(rows, lookups({ scopeAllows: (u) => u.id !== "u2" })).previewHash, h1);
});
