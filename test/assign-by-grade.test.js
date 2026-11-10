// 第三批 8.6（2026-10-08）：按部门 × 职级指派课程、加培养项目学员。
//   预览 GET /api/admin/assignments/preview（人数、没有职级而不纳入的人数、扣除已指派 / 已在训）；
//   POST /api/admin/assignments/bulk 与 POST /api/admin/tprojects/:id/members 接受 select；只含在职的人；
//   前端自己圈人时随 userIds 带 criteria，只写进审计。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin, tpId;
const dept = {}, emp = {};
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["GR Finance", null], ["GR Finance AP", "GR Finance"], ["GR Sales", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    dept[name] = r.data.department.id;
  }
  const people = [["GR-1", "GR Finance", "PD1"], ["GR-2", "GR Finance AP", "PD2"], ["GR-3", "GR Finance", "PD3"], ["GR-4", "GR Finance", "PD4"],
    ["GR-5", "GR Finance AP", ""], ["GR-6", "GR Sales", "PD2"], ["GR-7", "GR Finance", "PD2"], ["GR-8", "GR Finance", "PD1"]];
  for (const [eid, d, g] of people) {
    const r = await admin.post("/api/admin/employees", { name: "Gr " + eid, employeeId: eid, department: d, jobLevel: g || undefined, programIds: [] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  for (const u of (await admin.get("/api/admin/roster")).data) if (/^GR-/.test(u.employeeId)) emp[u.employeeId] = u.id;
  assert.equal((await admin.put("/api/admin/employees/" + emp["GR-7"], { active: false })).status, 200, "GR-7 deactivated");
  const db = new DatabaseSync(srv.dbPath);
  try { db.prepare("UPDATE users SET empStatus = 'exited' WHERE id = ?").run(emp["GR-8"]); } finally { db.close(); }
  tpId = (await admin.post("/api/admin/tprojects", { title: "Grade Project" })).data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + tpId, { cohorts: [{ id: "gr-co", name: "C1", capacity: 0, classes: [], phases: [] }] })).status, 200);
});
after(() => srv.stop());

const qs = (o) => "?" + new URLSearchParams(o).toString();

test("preview: department incl. sub-departments × grade range; active only; people without a grade counted apart", async () => {
  const r = await admin.get("/api/admin/assignments/preview" + qs({ depts: dept["GR Finance"], gradeFrom: "PD1", gradeTo: "PD3", programId: "nho" }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.matched, r.data.noGrade, r.data.alreadyAssigned, r.data.toAdd], [3, 1, 0, 3], "GR-1, GR-2 (child dept), GR-3; GR-5 has no grade; GR-7 inactive, GR-8 exited");
  assert.ok(r.data.gradeOptions.some((g) => g.grade === "PD2"));
  const multi = await admin.get("/api/admin/assignments/preview" + qs({ grades: "PD2,PD4" }));
  assert.ok(multi.data.matched >= 3, "grades alone, company-wide");
  assert.equal((await admin.get("/api/admin/assignments/preview")).status, 400);
  assert.equal((await admin.get("/api/admin/assignments/preview" + qs({ gradeFrom: "PD1", gradeTo: "QX3" }))).data.code, "bad_grade_range");
  assert.equal((await admin.get("/api/admin/assignments/preview" + qs({ depts: "no-such" }))).data.code, "bad_dept");
  const deptOnly = await admin.get("/api/admin/assignments/preview" + qs({ depts: dept["GR Finance"] }));
  assert.deepEqual([deptOnly.data.matched, deptOnly.data.noGrade], [5, 0], "no grade condition → no-grade people are included");
});

test("course assignment by select: only the matched, minus those already assigned; audited with the selector", async () => {
  const sel = { depts: [dept["GR Finance"]], gradeFrom: "PD1", gradeTo: "PD3" };
  assert.equal((await admin.post("/api/admin/assignments/bulk", { userIds: [emp["GR-1"]], programId: "nho", action: "assign", criteria: { depts: [dept["GR Finance"]], grades: ["PD1"] } })).status, 200);
  const r = await admin.post("/api/admin/assignments/bulk", { select: sel, programId: "nho", action: "assign", dueAt: "2026-12-31" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.count, r.data.alreadyAssigned, r.data.noGrade], [2, 1, 1]);
  const again = await admin.post("/api/admin/assignments/bulk", { select: sel, programId: "nho", action: "assign" });
  assert.deepEqual([again.data.count, again.data.alreadyAssigned], [0, 3]);
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT afterJson FROM audit_logs WHERE action = 'assignments.bulk' ORDER BY id").all().map((x) => JSON.parse(x.afterJson));
    assert.deepEqual(rows[0].criteria, { depts: [dept["GR Finance"]], grades: ["PD1"] }, "client-side selection: criteria recorded");
    assert.deepEqual(rows[1].select, { depts: [dept["GR Finance"]], grades: [], gradeFrom: "PD1", gradeTo: "PD3" });
    assert.equal(rows[1].alreadyAssigned, 1);
  } finally { db.close(); }
});

test("development program add learners by select: minus those already in the program", async () => {
  const sel = { depts: [dept["GR Finance"]], grades: ["PD2", "PD4"] };
  const pv = await admin.get("/api/admin/assignments/preview" + qs({ depts: dept["GR Finance"], grades: "PD2,PD4", projectId: tpId }));
  assert.deepEqual([pv.data.matched, pv.data.alreadyAssigned], [2, 0], "GR-2, GR-4");
  const r = await admin.post(`/api/admin/tprojects/${tpId}/members`, { cohortId: "gr-co", select: sel });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.count, r.data.alreadyAssigned, r.data.noGrade], [2, 0, 1]);
  const again = await admin.post(`/api/admin/tprojects/${tpId}/members`, { cohortId: "gr-co", select: sel });
  assert.deepEqual([again.data.count, again.data.alreadyAssigned], [0, 2]);
});
