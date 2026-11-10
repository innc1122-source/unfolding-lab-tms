// 上线前全覆盖 N 组（课程、考试、题库、成绩，10/11）：
//   CX-146 已发布固定题目考试使用的题不能删（409 question_in_use，列出考试）；未被使用的照常删；
//   CX-145 人工评分只收数字：abc、null、空串、超上限 → 400 bad_score，答卷不变；
//   CX-147 删除课程时，题库里属于它的题一并删除（被其他考试使用的保留）；
//   CX-152 考试记录 CSV：马尼拉时间、末尾两列中文名、UTF-8 BOM；
//   CX-154 考试英文名留空就存空，读出时 title 回落中文名、titleEn 为空。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

let srv, admin, emp, courseId;
const qid = {};
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  await completeAllModules(emp, "nho");
  courseId = (await admin.get("/api/admin/content")).data.programs.find((p) => p.id === "nho").courseIds[0];
  for (const k of ["A", "B", "FREE"]) {
    const r = await admin.post("/api/admin/questions", { courseId, type: "mcq", question: "N " + k, points: 10, options: [{ text: "R-" + k, ok: true }, { text: "W-" + k, ok: false }], explanation: "" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    qid[k] = r.data.id || (r.data.question && r.data.question.id);
  }
  const o = await admin.post("/api/admin/questions", { courseId, type: "open", question: "N open", rubric: "r", maxPoints: 10, points: 10 });
  qid.O = o.data.id || (o.data.question && o.data.question.id);
});
after(() => srv.stop());

const fixedExam = async (title, ids, extra) => {
  const r = await admin.post("/api/admin/exams", { programId: "nho", title, status: "published", courseIds: [courseId], passingScore: 60, mcqCount: 1, openCount: 0, mode: "fixed", questionIds: ids, maxAttempts: 0, retakeCooldownHours: 0, ...(extra || {}) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
};

test("CX-146: a question used by a published fixed-question exam cannot be deleted; an unused one can", async () => {
  const examId = await fixedExam("N fixed", [qid.A, qid.B]);
  const r = await admin.del("/api/admin/questions/" + qid.A);
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, "question_in_use");
  assert.deepEqual(r.data.exams.map((e) => e.id), [examId]);
  assert.match(r.data.error_zh, /N fixed/);
  const still = (await admin.get("/api/admin/questions")).data;
  assert.ok((Array.isArray(still) ? still : still.items || []).some((q) => q.id === qid.A), "still in the bank");
  assert.equal((await admin.del("/api/admin/questions/" + qid.FREE)).status, 200);
});

test("CX-145 / CX-152: manual grading accepts numbers only; the attempts CSV uses Manila time, adds Chinese names and a BOM", async () => {
  const examId = await fixedExam("N open exam", [qid.O], { title_zh: "N 简答考试", openCount: 1, mcqCount: 0 });
  const start = await emp.post("/api/exam/start", { examId });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const sub = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: { [qid.O]: "an answer" } });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  for (const score of ["abc", null, "", 11, -1]) {
    const g = await admin.post(`/api/admin/attempts/${start.data.attemptId}/regrade`, { questionId: qid.O, score });
    assert.equal(g.status, 400, "score " + JSON.stringify(score) + " → " + JSON.stringify(g.data));
    assert.equal(g.data.code, "bad_score");
  }
  assert.equal((await admin.post(`/api/admin/attempts/${start.data.attemptId}/regrade`, { questionId: qid.O, score: "7" })).status, 200, "a numeric string is fine");
  // CX-209：题号不在答卷里 → 400 带中文与 code
  const nq = await admin.post(`/api/admin/attempts/${start.data.attemptId}/regrade`, { questionId: "no-such-q", score: 1 });
  assert.equal(nq.status, 400);
  assert.equal(nq.data.code, "question_not_found");
  assert.ok(nq.data.error_zh);
  const res = await admin.raw("GET", "/api/admin/export/attempts.csv");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM");
  const lines = buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split(","));
  const head = lines[0];
  assert.ok(head.includes("Submitted (UTC+8 Manila)") && head.includes("考试（中文）"), head.join("|"));
  assert.ok(head.includes("Voided 已作废"), "CX-202: voided column");
  const row = lines.find((c) => c[3] === "N open exam");
  assert.equal(row[head.indexOf("考试（中文）")], "N 简答考试");
  const att = (await admin.get("/api/admin/attempts")).data;
  const a = (Array.isArray(att) ? att : att.items || []).find((x) => x.id === start.data.attemptId);
  const manila = new Date(Date.parse(a.submittedAt) + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  assert.equal(row[head.indexOf("Submitted (UTC+8 Manila)")], manila);
});

test("CX-154: an exam saved without an English name keeps it empty; reads fall back to the Chinese name", async () => {
  const r = await admin.post("/api/admin/exams", { programId: "nho", title: "", title_zh: "只有中文名", status: "draft", courseIds: [courseId], passingScore: 60, mcqCount: 1, openCount: 0, mode: "random", maxAttempts: 0, retakeCooldownHours: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = (await admin.get("/api/admin/exams")).data.find((x) => x.id === r.data.id);
  assert.equal(e.titleEn, "");
  assert.equal(e.title, "只有中文名", "display falls back to the Chinese name");
  const none = await admin.post("/api/admin/exams", { programId: "nho", title: "", title_zh: "", status: "draft", courseIds: [courseId], passingScore: 60, mcqCount: 1, openCount: 0 });
  assert.equal(none.status, 400);
});

test("CX-147: deleting a course deletes its questions from the bank", async () => {
  const pkg = (await admin.get(`/api/admin/content/courses/${courseId}/export`)).data;
  const imp = await admin.post("/api/admin/content/courses/import", { package: pkg, title: "N temp course", title_zh: "N 临时课程" });
  assert.equal(imp.status, 200, JSON.stringify(imp.data) + JSON.stringify(Object.keys(pkg || {})));
  const cid = imp.data.id;
  const mk = async (k) => (await admin.post("/api/admin/questions", { courseId: cid, type: "mcq", question: "T " + k, points: 10, options: [{ text: "R", ok: true }, { text: "W", ok: false }], explanation: "" })).data;
  const q1 = await mk("1"), q2 = await mk("2");
  const id1 = q1.id || q1.question.id, id2 = q2.id || q2.question.id;
  const del = await admin.del("/api/admin/content/courses/" + cid);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(del.data.deletedQuestions, 2);
  assert.equal(del.data.keptQuestions, 0);
  const bank = (await admin.get("/api/admin/questions")).data;
  const ids = (Array.isArray(bank) ? bank : bank.items || []).map((q) => q.id);
  assert.ok(!ids.includes(id1) && !ids.includes(id2), "the course's questions are deleted");
  // CX-206 / CX-208：课程删除后，审计对象列取记下的课程名，详情带删除 / 保留题数
  const au = await admin.get("/api/admin/audit?action=question.course-deleted");
  const rowsA = Array.isArray(au.data) ? au.data : au.data.rows || au.data.items || [];
  const mine = rowsA.find((r) => r.target === cid);
  assert.ok(mine, "audited");
  assert.equal(mine.targetLabel, "N temp course");
  assert.equal(mine.targetLabel_zh, "N 临时课程");
  assert.deepEqual([mine.after.questionsDeleted, mine.after.questionsKept], [2, 0]);
});
