// Batch 3 regression tests: exam preparation/resume/draft flow and the
// employee Learning Record (session-user only, answer-visibility honoured).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient, completeAllModules } = require("./helpers.js");

let srv, admin, emp;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  await completeAllModules(emp, "nho");
});
after(() => srv.stop());

// 用户决定（2026-10）：中途离开考试，重新打开后重新开始考试，之前未保存的不记录 —— 不再恢复草稿。
test("start returns a server deadline; a second start discards the open attempt and starts over", async () => {
  const first = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(first.status, 200);
  assert.equal(first.data.resumed, false);
  assert.ok(first.data.deadline, "server-computed deadline present (timed exam)");
  assert.ok(new Date(first.data.deadline) > new Date(), "deadline is in the future");

  // The heartbeat/draft endpoint still answers (an old client may still send answers).
  const draft = await emp.raw("PUT", `/api/exam-attempts/${first.data.attemptId}/draft`, { answers: { q1: 2, q5: "hello" } });
  assert.equal(draft.status, 200);

  // Starting again (refresh / leave and come back) = a NEW attempt; nothing restored.
  const start = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(start.status, 200);
  assert.equal(start.data.resumed, false);
  assert.notEqual(start.data.attemptId, first.data.attemptId, "a fresh attempt was created");
  assert.equal(start.data.draftAnswers, undefined);
  // The abandoned attempt is gone.
  assert.equal((await emp.post(`/api/exam/${first.data.attemptId}/submit`, { answers: {} })).status, 404);

  // Heartbeats are private: another user can't write to this attempt.
  const other = await loginAs(srv.base, ADMIN);
  const stolen = await other.raw("PUT", `/api/exam-attempts/${start.data.attemptId}/draft`, { answers: { q1: 0 } });
  assert.equal(stolen.status, 404);

  // Submit, then heartbeats are refused.
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: { q1: 2 } });
  assert.equal(submit.status, 200);
  const late = await emp.raw("PUT", `/api/exam-attempts/${start.data.attemptId}/draft`, { answers: {} });
  assert.equal(late.status, 400);

  // After submitting, a new start creates a FRESH attempt.
  const fresh = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(fresh.data.resumed, false);
  assert.notEqual(fresh.data.attemptId, start.data.attemptId);
  await emp.post(`/api/exam/${fresh.data.attemptId}/submit`, { answers: {} });
});

test("learning record lists own programs with status and attempt counts", async () => {
  const r = await emp.get("/api/me/learning-record");
  assert.equal(r.status, 200);
  const nho = r.data.find((x) => x.id === "nho");
  assert.ok(nho);
  assert.equal(nho.progress, 100);
  assert.ok(nho.attemptCount >= 2);
  assert.ok(["ready", "failed", "passed", "overdue"].includes(nho.status));
  assert.equal(nho.courseCount, 3);
  assert.equal(nho.examCount, 1);
});

test("program record shows module completion times and numbered exam history", async () => {
  const r = await emp.get("/api/me/programs/nho/record");
  assert.equal(r.status, 200);
  assert.equal(r.data.courses.length, 3);
  for (const c of r.data.courses) for (const m of c.modules) assert.ok(m.doneAt, "every module completed with a timestamp");
  const exam = r.data.exams.find((e) => e.id === "exam-nho");
  assert.ok(exam.attempts.length >= 2);
  assert.deepEqual(exam.attempts.map((a) => a.n), exam.attempts.map((_, i) => i + 1), "attempts numbered chronologically");
  for (const a of exam.attempts) {
    assert.ok(a.submittedAt);
    assert.equal(typeof a.percent, "number");
  }
});

test("my attempt view is private and honours showAnswersAfterExam", async () => {
  const { data: rec } = await emp.get("/api/me/programs/nho/record");
  const attemptId = rec.exams[0].attempts[0].id;

  // Own attempt: visible, with answers by default.
  const mine = await emp.get("/api/me/attempts/" + attemptId);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.showAnswers, true);
  const mcq = mine.data.detail.find((d) => d.type === "mcq");
  if (mcq) assert.notEqual(mcq.correct, undefined);

  // Another logged-in user cannot read it.
  const other = await loginAs(srv.base, ADMIN);
  assert.equal((await other.get("/api/me/attempts/" + attemptId)).status, 404);

  // Hide answers on the exam → correct/explanation stripped from the record.
  const { data: exam } = await admin.get("/api/admin/exams/exam-nho");
  await admin.put("/api/admin/exams/exam-nho", { ...exam, showAnswersAfterExam: false });
  const hidden = await emp.get("/api/me/attempts/" + attemptId);
  assert.equal(hidden.data.showAnswers, false);
  for (const d of hidden.data.detail) {
    if (d.type === "open") continue;
    assert.equal(d.correct, undefined, "correct answer hidden");
    assert.equal(d.explanation, undefined, "explanation hidden");
    assert.equal(d.accepted, undefined, "accepted fill answers hidden");
  }
  await admin.put("/api/admin/exams/exam-nho", { ...exam, showAnswersAfterExam: true });
});

test("learning record rejects anonymous users and ignores any userId parameter", async () => {
  const anon = makeClient(srv.base);
  assert.equal((await anon.get("/api/me/learning-record")).status, 401);
  // A userId query string changes nothing — still the session user's data.
  const r = await emp.get("/api/me/learning-record?userId=u-admin");
  assert.equal(r.status, 200);
  assert.ok(r.data.find((x) => x.id === "nho"), "still MY records");
});
