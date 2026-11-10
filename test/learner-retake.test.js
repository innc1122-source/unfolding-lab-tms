// 第三批 5.4 / 10.8 / 10.9（2026-10-08）：学员课程列表的「待补考」状态与考前说明的题型构成。
//   /api/programs 与 /api/catalog（status assigned）每项带 learnStatus、attemptsLeft（null = 不限）、retakeAvailableAt（null = 现在可考）、
//   retakeExamId、retake { examId, state, retryAt, attemptsLeft }：未通过可再考 → retake_pending / ready；重考等待期 → waiting + 时间；
//   次数用完 → failed / usedUp；成绩待定 → result_pending；通过 → done。不限次数、无等待期的未通过考试能直接重新开始（验收 G5-4）。
//   /api/programs/:id 的每场考试带 typeSummary [{ type, count, points }] 与 totalPoints（旧考试 typePoints 为空也按旧口径算出）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

let srv, admin, emp, db;
const sql = (q, ...a) => db.prepare(q).run(...a);
const nho = async () => (await emp.get("/api/programs")).data.find((p) => p.id === "nho");
const cat = async () => (await emp.get("/api/catalog")).data.find((p) => p.id === "nho");
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  db = new DatabaseSync(srv.dbPath);
  sql("UPDATE exams SET maxAttempts = 0, retakeCooldownHours = 0, autoRetrain = 0 WHERE id = 'exam-nho'");
  await completeAllModules(emp, "nho");
});
after(() => { try { db.close(); } catch {} srv.stop(); });

test("before the exam: exam_pending, no retake info", async () => {
  const p = await nho();
  assert.equal(p.learnStatus, "exam_pending");
  assert.deepEqual([p.attemptsLeft, p.retakeAvailableAt, p.retakeExamId, p.retake], [null, null, null, null]);
});

test("failed with unlimited attempts and no wait: retake_pending, available now, and the exam starts again", async () => {
  const s = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const sub = await emp.post(`/api/exam/${s.data.attemptId}/submit`, { answers: {} });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  sql("UPDATE attempts SET gradingStatus = 'final', passed = 0, percent = 53 WHERE id = ?", s.data.attemptId);
  const p = await nho();
  assert.equal(p.learnStatus, "retake_pending");
  assert.equal(p.retakeExamId, "exam-nho");
  assert.equal(p.attemptsLeft, null, "unlimited");
  assert.equal(p.retakeAvailableAt, null, "no wait period");
  assert.deepEqual(p.retake, { examId: "exam-nho", state: "ready", retryAt: null, attemptsLeft: null });
  const c = await cat();
  assert.equal(c.status, "assigned");
  assert.equal(c.learnStatus, "retake_pending", "the home page reads /api/catalog");
  assert.equal(c.retakeExamId, "exam-nho");
  const again = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(again.status, 200, "去补考 can actually start: " + JSON.stringify(again.data));
});

test("retake wait period → retakeAvailableAt; attempts used up → failed with 0 left", async () => {
  sql("DELETE FROM attempts WHERE submittedAt IS NULL");
  sql("UPDATE exams SET retakeCooldownHours = 24, maxAttempts = 3 WHERE id = 'exam-nho'");
  let p = await nho();
  assert.equal(p.learnStatus, "retake_pending");
  assert.equal(p.retake.state, "waiting");
  assert.ok(p.retakeAvailableAt && Date.parse(p.retakeAvailableAt) > Date.now(), p.retakeAvailableAt);
  assert.equal(p.attemptsLeft, 2);
  sql("UPDATE exams SET retakeCooldownHours = 0, maxAttempts = 1 WHERE id = 'exam-nho'");
  p = await nho();
  assert.equal(p.learnStatus, "failed");
  assert.equal(p.attemptsLeft, 0);
  assert.equal(p.retake.state, "usedUp");
});

test("result pending → result_pending; passed → done", async () => {
  sql("UPDATE exams SET maxAttempts = 0 WHERE id = 'exam-nho'");
  sql("UPDATE attempts SET gradingStatus = 'pending_review' WHERE examId = 'exam-nho' AND submittedAt IS NOT NULL");
  let p = await nho();
  assert.equal(p.learnStatus, "result_pending");
  assert.equal(p.retake.state, "pending");
  sql("UPDATE attempts SET gradingStatus = 'final', passed = 1, percent = 95 WHERE examId = 'exam-nho' AND submittedAt IS NOT NULL");
  p = await nho();
  assert.equal(p.learnStatus, "done");
  assert.equal(p.retake, null);
});

test("pre-exam page: typeSummary lists only the types that occur, totalPoints is computed for old exams (typePoints null)", async () => {
  const d = (await emp.get("/api/programs/nho")).data;
  const e = d.exams.find((x) => x.id === "exam-nho");
  assert.equal(e.typePoints, null, "exam-nho is an old-rule exam");
  assert.ok(Array.isArray(e.typeSummary) && e.typeSummary.length, JSON.stringify(e.typeSummary));
  for (const t of e.typeSummary) {
    assert.ok(["mcq", "multi", "fill", "open"].includes(t.type));
    assert.ok(t.count === null || t.count > 0, "no zero-count rows");
  }
  const open = e.typeSummary.find((t) => t.type === "open");
  assert.equal(open.count, 1);
  assert.equal(open.points, 1, "old rule: an open question is worth maxPoints / 10");
  const objCount = e.typeSummary.filter((t) => t.type !== "open").reduce((n, t) => n + (t.count || 0), 0);
  const objTypes = e.typeSummary.filter((t) => t.type !== "open");
  if (objTypes.length === 1) assert.equal(objCount, 8);
  for (const t of objTypes) assert.equal(t.points, 1, "old rule: objective questions are worth 1");
  assert.equal(e.totalPoints, 9, "8 objective × 1 + 1 open × 1");
  // 每题分值的考试：题型默认分值
  sql("UPDATE exams SET typePoints = ? WHERE id = 'exam-nho'", JSON.stringify({ mcq: 2, multi: 2, fill: 2, open: 10 }));
  const e2 = (await emp.get("/api/programs/nho")).data.exams.find((x) => x.id === "exam-nho");
  assert.equal(e2.typeSummary.find((t) => t.type === "open").points, 10);
  assert.equal(e2.totalPoints, 26);
});
