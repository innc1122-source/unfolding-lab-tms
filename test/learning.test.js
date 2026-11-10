// Baseline regression tests: employee learning flow — program visibility,
// module progress, exam lifecycle (unlock → start → submit → review).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, makeClient, loginAs, completeAllModules } = require("./helpers.js");

let srv, emp, admin;
before(async () => {
  srv = await startServer();
  emp = await loginAs(srv.base, EMPLOYEE);
  admin = await loginAs(srv.base, ADMIN);
});
after(() => srv.stop());

test("employee sees their assigned program with 0 progress", async () => {
  const r = await emp.get("/api/programs");
  assert.equal(r.status, 200);
  const nho = r.data.find((p) => p.id === "nho");
  assert.ok(nho, "seeded NHO program is assigned via backfill");
  assert.equal(nho.progress, 0);
  assert.equal(nho.best, null);
});

test("program detail lists courses and keeps the exam locked", async () => {
  const r = await emp.get("/api/programs/nho");
  assert.equal(r.status, 200);
  assert.ok(r.data.courses.length >= 3);
  assert.equal(r.data.examUnlocked, false);
  // Exam start refused before coursework is done.
  const start = await emp.post("/api/exam/start", { programId: "nho" });
  assert.equal(start.status, 400);
});

test("completing modules drives course and program progress", async () => {
  const { data: program } = await emp.get("/api/programs/nho");
  const course = program.courses[0];
  const { data: full } = await emp.get("/api/courses/" + course.id);
  const first = full.modules[0];

  const done = await emp.post(`/api/courses/${course.id}/modules/${first.id}/complete`);
  assert.equal(done.status, 200);

  const { data: refreshed } = await emp.get("/api/courses/" + course.id);
  assert.ok(refreshed.done[first.id], "module marked complete with a timestamp");

  const { data: p2 } = await emp.get("/api/programs/nho");
  assert.ok(p2.progress > 0);
});

test("full exam flow: unlock, start, client copy is sanitized, submit, no resubmit", async () => {
  await completeAllModules(emp, "nho");
  const { data: p } = await emp.get("/api/programs/nho");
  assert.equal(p.progress, 100);
  assert.equal(p.examUnlocked, true);

  const start = await emp.post("/api/exam/start", { programId: "nho" });
  assert.equal(start.status, 200);
  assert.ok(start.data.attemptId);
  assert.equal(start.data.questions.length, p.examMcqCount + p.examOpenCount);

  // The client copy must never leak answers, rubrics or correct flags.
  for (const q of start.data.questions) {
    assert.equal(q.answers, undefined, "fill answers hidden");
    assert.equal(q.rubric, undefined, "rubric hidden");
    for (const o of q.options || []) assert.equal(o.ok, undefined, "correct flag hidden");
  }

  // Submit with every question answered wrong/blank — still a valid submission.
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {}, blurCount: 2 });
  assert.equal(submit.status, 200);
  assert.equal(typeof submit.data.percent, "number");
  assert.equal(submit.data.passed, false);
  assert.ok(Array.isArray(submit.data.detail));

  // Resubmitting the same attempt is refused.
  const again = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {} });
  // 重复交卷：409 already_submitted（AI 治理方案 2.5 交卷防重）
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "already_submitted");

  // The attempt (with blur count) is visible to HR.
  const attempts = await admin.get("/api/admin/attempts");
  const mine = attempts.data.find((a) => a.id === start.data.attemptId);
  assert.ok(mine);
  assert.equal(mine.blurCount, 2);
});

test("unassigning a program hides it from the employee", async () => {
  const employees = await admin.get("/api/admin/employees");
  const u = employees.data.find((x) => x.employeeId === EMPLOYEE.employeeId);
  await admin.post("/api/admin/assignments", { userId: u.id, items: [{ programId: "nho", assigned: false }] });

  const list = await emp.get("/api/programs");
  assert.equal(list.data.find((p) => p.id === "nho"), undefined);
  assert.equal((await emp.get("/api/programs/nho")).status, 404);

  // Re-assign with a due date; it comes back with the due date attached.
  await admin.post("/api/admin/assignments", { userId: u.id, items: [{ programId: "nho", assigned: true, dueAt: "2030-01-31" }] });
  const back = await emp.get("/api/programs");
  assert.equal(back.data.find((p) => p.id === "nho").dueAt, "2030-01-31");
});
