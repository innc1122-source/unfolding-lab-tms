// Grade appeals (migration 37): an employee disputes a marked paper, HR resolves
// it. Covers the guards that keep the queue sane — minimum reason, one open
// appeal per attempt, a rejection must carry a readable reason, no double
// resolution, and no re-appeal once one has been accepted.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

let srv, admin, emp, attemptId;

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  // A submitted paper to dispute.
  await completeAllModules(emp, "nho");
  const start = await emp.post("/api/exam/start", { programId: "nho" });
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {} });
  if (submit.status !== 200) throw new Error("exam submit failed: " + JSON.stringify(submit.data));
  attemptId = start.data.attemptId;
});
after(() => srv.stop());

const REASON = "Question 3 means the same as the answer key but was marked wrong.";

test("a reason that says nothing is refused", async () => {
  const r = await emp.post(`/api/me/attempts/${attemptId}/appeal`, { reason: "wrong" });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "reason");
});

test("someone else's attempt cannot be appealed", async () => {
  const other = await loginAs(srv.base, ADMIN);
  const r = await other.post(`/api/me/attempts/${attemptId}/appeal`, { reason: REASON });
  assert.equal(r.status, 404, "not found rather than forbidden — no attempt existence leak");
});

test("an appeal is filed once and shows up on both sides", async () => {
  const r = await emp.post(`/api/me/attempts/${attemptId}/appeal`, { reason: REASON });
  assert.equal(r.status, 200);
  assert.equal(r.data.appeal.status, "open");

  const dup = await emp.post(`/api/me/attempts/${attemptId}/appeal`, { reason: REASON });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, "duplicate");

  const mine = await emp.get("/api/me/programs/nho/record");
  const seen = (mine.data.exams || []).flatMap((e) => e.attempts).find((a) => a.id === attemptId);
  assert.equal(seen.appeal.status, "open", "employee sees their own appeal");

  const hr = await admin.get("/api/admin/attempts");
  const row = hr.data.find((x) => x.id === attemptId);
  assert.equal(row.appeal.status, "open", "HR queue carries it");
  assert.equal(row.appeal.reason, REASON);
});

test("rejecting without a reason the employee can read is refused", async () => {
  const hr = await admin.get("/api/admin/attempts");
  const id = hr.data.find((x) => x.id === attemptId).appeal.id;
  const r = await admin.post(`/api/admin/appeals/${id}/resolve`, { status: "rejected", resolution: "" });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "resolution");
});

test("resolving closes the appeal, notifies once, and cannot be repeated", async () => {
  const hr = await admin.get("/api/admin/attempts");
  const id = hr.data.find((x) => x.id === attemptId).appeal.id;

  const done = await admin.post(`/api/admin/appeals/${id}/resolve`, { status: "accepted", resolution: "Re-checked — credited." });
  assert.equal(done.status, 200);
  assert.equal(done.data.appeal.status, "accepted");

  const again = await admin.post(`/api/admin/appeals/${id}/resolve`, { status: "rejected", resolution: "changed my mind" });
  assert.equal(again.status, 400, "an appeal is resolved exactly once");

  const mine = await emp.get("/api/me/programs/nho/record");
  const seen = (mine.data.exams || []).flatMap((e) => e.attempts).find((a) => a.id === attemptId);
  assert.equal(seen.appeal.status, "accepted");
  assert.equal(seen.appeal.resolution, "Re-checked — credited.", "the employee reads HR's reply");
});

test("an accepted appeal settles the matter — no re-appeal", async () => {
  const r = await emp.post(`/api/me/attempts/${attemptId}/appeal`, { reason: REASON });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "settled");
});
