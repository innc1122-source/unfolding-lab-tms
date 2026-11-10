// 课程「需要结业考试」开关 + 统一完成口径 programDone + 中途离开考试 = 重新开始。
//   - 关：下线该课所有已发布考试（历史保留）、noExam 写在包装程序上；被培养项目的「考试」活动引用时拒绝。
//   - 开：重新发布最近下线的考试；没有可恢复的考试时提示去考试页新建。
//   - 无考试的课程：学完（100%）即完成 —— 学习记录、我的课程、总览、完成率导出、逾期提醒口径一致。
//   - 重新开始考试：未交卷的旧答卷被丢弃，不计入次数（maxAttempts）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, loginAs } = require("./helpers.js");

let srv, admin, emp, empId;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  const { data: users } = await admin.get("/api/admin/employees");
  empId = users.find((u) => u.employeeId === EMPLOYEE.employeeId).id;
});
after(() => srv.stop());

const PAST = "2020-01-01";

// A published one-module online course (→ invisible wrapper "pw-<id>"), two
// objective questions, one published exam drawing 1, assigned to the employee.
async function makeCourseWithExam(cid, examRules = {}) {
  const put = await admin.put("/api/admin/content/courses/" + cid, {
    id: cid, title: "No-exam test " + cid, title_zh: "无考试测试 " + cid, status: "published", mode: "online",
    modules: [{ id: cid + "-m1", title: "Module 1", minutes: 5, sections: [] }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const pid = "pw-" + cid;
  for (const n of [1, 2]) {
    const q = await admin.post("/api/admin/questions", {
      courseId: cid, type: "mcq", question: `Q${n} for ${cid}?`,
      options: [{ text: "right", ok: true }, { text: "wrong", ok: false }],
    });
    assert.equal(q.status, 200, JSON.stringify(q.data));
  }
  const ex = await admin.post("/api/admin/exams", {
    programId: pid, title: "Exam " + cid, courseIds: [cid],
    passingScore: 50, mcqCount: 1, openCount: 0, status: "published", ...examRules,
  });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  const asg = await admin.post("/api/admin/assignments", { userId: empId, items: [{ programId: pid, assigned: true, dueAt: examRules.dueAt || null }] });
  assert.equal(asg.status, 200);
  return { pid, examId: ex.data.id, moduleId: cid + "-m1" };
}
const examStatus = async (id) => (await admin.get("/api/admin/exams/" + id)).data.status;

test("turning the final exam off archives the course's exam; finishing the course then counts as completed everywhere", async () => {
  const cid = "nx-off";
  const { pid, examId, moduleId } = await makeCourseWithExam(cid, { dueAt: PAST });

  // With an exam: finishing the content is only "ready", not done.
  await emp.post(`/api/courses/${cid}/modules/${moduleId}/complete`);
  let rec = (await emp.get("/api/me/learning-record")).data.find((x) => x.id === pid);
  assert.notEqual(rec.status, "passed");
  let mine = (await emp.get("/api/programs")).data.find((x) => x.id === pid);
  assert.equal(mine.hasExam, true);
  assert.equal(mine.done, false);

  const off = await admin.post(`/api/admin/programs/${pid}/exam-required`, { required: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.deepEqual(off.data.archived, [examId]);
  assert.equal(await examStatus(examId), "archived", "exam retired, not deleted");
  const content = (await admin.get("/api/admin/content")).data;
  assert.equal(content.programs.find((p) => p.id === pid).noExam, true, "UI flag stored on the wrapper");

  // Employee side: no exam, 100% → completed (even though the due date has passed).
  mine = (await emp.get("/api/programs")).data.find((x) => x.id === pid);
  assert.equal(mine.hasExam, false);
  assert.equal(mine.done, true);
  const cat = (await emp.get("/api/catalog")).data.find((x) => x.id === pid);
  assert.equal(cat.hasExam, false);
  rec = (await emp.get("/api/me/learning-record")).data.find((x) => x.id === pid);
  assert.equal(rec.status, "passed", "completion beats overdue");
  assert.equal(rec.hasExam, false);
  assert.ok(rec.passedAt, "completion time = last module completion");
  const detail = (await emp.get("/api/programs/" + pid)).data;
  assert.equal(detail.hasExam, false);
  assert.equal(detail.done, true);

  // Admin side: overview counts it as done, not overdue.
  const ov = (await admin.get("/api/admin/overview")).data.perProgram.find((x) => x.id === pid);
  assert.equal(ov.done, 1);
  assert.equal(ov.overdue, 0);
  // Employee list carries the same verdict.
  const row = (await admin.get("/api/admin/employees")).data.find((u) => u.id === empId);
  assert.equal(row.programs[pid].done, true);
  assert.equal(row.programs[pid].hasExam, false);

  // completion.csv: COMPLETED / Passed YES, never "EXAM PENDING".
  const csv = await (await admin.raw("GET", "/api/admin/export/completion.csv")).text();
  const line = csv.split(/\r?\n/).find((l) => l.includes(EMPLOYEE.employeeId) && l.includes("No-exam test " + cid));
  assert.ok(line, "row present");
  assert.match(line, /COMPLETED/);
  assert.doesNotMatch(line, /EXAM PENDING|OVERDUE/);

  // remind-overdue: a completed examless course is not chased.
  const rem = await admin.post("/api/admin/training/remind-overdue", { programId: pid });
  assert.equal(rem.status, 200);
  assert.equal(rem.data.reminded, 0);

  // Turning it back on re-publishes the archived exam → the exam counts again.
  const on = await admin.post(`/api/admin/programs/${pid}/exam-required`, { required: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.republished, examId);
  assert.equal(await examStatus(examId), "published");
  assert.equal((await admin.get("/api/admin/content")).data.programs.find((p) => p.id === pid).noExam, false);
  mine = (await emp.get("/api/programs")).data.find((x) => x.id === pid);
  assert.equal(mine.hasExam, true);
  assert.equal(mine.done, false);
  rec = (await emp.get("/api/me/learning-record")).data.find((x) => x.id === pid);
  assert.notEqual(rec.status, "passed");
  const rem2 = await admin.post("/api/admin/training/remind-overdue", { programId: pid });
  assert.equal(rem2.data.reminded, 1, "exam pending again → overdue reminder goes out");
});

test("turning the final exam off is refused while a development program uses the exam", async () => {
  const cid = "nx-proj";
  const { pid, examId } = await makeCourseWithExam(cid);
  const tp = await admin.post("/api/admin/tprojects", { title: "Exam user project", title_zh: "引用考试的项目" });
  assert.equal(tp.status, 200);
  const saved = await admin.put("/api/admin/tprojects/" + tp.data.id, {
    cohorts: [{
      id: "c-nx", name: "NX Cohort", startAt: "2026-08-01", endAt: "2026-12-01", capacity: 10, classes: [],
      phases: [{ id: "ph-1", title: "Phase 1", activities: [{ id: "act-ex", type: "exam", refId: examId, title: "Exam" }] }],
    }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const off = await admin.post(`/api/admin/programs/${pid}/exam-required`, { required: false });
  assert.equal(off.status, 409);
  assert.equal(off.data.code, "exam_in_project");
  assert.equal(off.data.projects[0].id, tp.data.id);
  assert.match(off.data.error, /Exam user project/);
  assert.match(off.data.error_zh, /引用考试的项目/);
  assert.equal(await examStatus(examId), "published", "nothing changed");
});

test("turning the final exam on with no exam to restore asks for one on the Exams page", async () => {
  const cid = "nx-none";
  const put = await admin.put("/api/admin/content/courses/" + cid, {
    id: cid, title: "Bare course", status: "published", mode: "online",
    modules: [{ id: cid + "-m1", title: "Module 1", minutes: 5, sections: [] }],
  });
  assert.equal(put.status, 200);
  const pid = "pw-" + cid;
  const off = await admin.post(`/api/admin/programs/${pid}/exam-required`, { required: false });
  assert.equal(off.status, 200);
  assert.deepEqual(off.data.archived, []);
  const on = await admin.post(`/api/admin/programs/${pid}/exam-required`, { required: true });
  assert.equal(on.status, 200);
  assert.equal(on.data.needsExam, true);
  assert.equal(on.data.republished, null);
  assert.ok(on.data.message_zh);
  assert.equal((await admin.post("/api/admin/programs/pw-nope/exam-required", { required: false })).status, 404);
});

test("restarting an exam discards the unsubmitted attempt: fresh paper, fresh timer, no attempt used", async () => {
  const cid = "nx-restart";
  const { examId, moduleId } = await makeCourseWithExam(cid, { maxAttempts: 1, autoRetrain: false, timeLimitMinutes: 30 });
  await emp.post(`/api/courses/${cid}/modules/${moduleId}/complete`);

  const first = await emp.post("/api/exam/start", { examId });
  assert.equal(first.status, 200);
  assert.equal(first.data.resumed, false);
  assert.equal(first.data.draftAnswers, undefined, "no draft to restore any more");
  // An old client may still autosave answers — they are not brought back.
  await emp.raw("PUT", `/api/exam-attempts/${first.data.attemptId}/draft`, { answers: { x: 1 } });

  // Leaving and coming back = starting over, even with maxAttempts 1.
  const second = await emp.post("/api/exam/start", { examId });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.notEqual(second.data.attemptId, first.data.attemptId, "a fresh attempt");
  assert.equal(second.data.resumed, false);
  assert.ok(new Date(second.data.deadline) >= new Date(first.data.deadline), "fresh timer");
  // The discarded attempt is gone: it can't be submitted and doesn't count.
  const stale = await emp.post(`/api/exam/${first.data.attemptId}/submit`, { answers: {} });
  assert.equal(stale.status, 404);
  const rec = (await emp.get("/api/me/programs/pw-" + cid + "/record")).data;
  assert.equal(rec.exams.find((e) => e.id === examId).attempts.length, 0, "no attempt recorded yet");

  // Submitting the fresh one uses the single allowed attempt…
  const sub = await emp.post(`/api/exam/${second.data.attemptId}/submit`, { answers: {} });
  assert.equal(sub.status, 200);
  assert.equal(sub.data.passed, false, "blank paper fails");
  // …after which the limit bites (proving the discarded one never counted).
  const third = await emp.post("/api/exam/start", { examId });
  assert.equal(third.status, 400);
  assert.equal(third.data.code, "exhausted");
});
