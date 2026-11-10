// F57（负责人 10/9 拍板）及格判定口径：用未四舍五入的得分比例与及格线比较，页面仍显示整数百分比。
//   86.5% 对 87% → 不通过（显示 87%）；87.0% 对 87% → 通过。
// 唯一的判定函数是 modules/learning/qtypes/index.js 的 passedOf / passedOfDetail；交卷与 HR 重新评分（settleAttempt）都走它，
// 成绩列表、CSV、学习记录、通知读交卷 / 重评时存下的 passed，不在读取时重算（旧答卷的结论不变）。
// 同一场考试两份答卷都显示 87%（86.5 未过、87.0 已过）时，「最好成绩」取已通过的那份。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const QT = require("../modules/learning/qtypes/index.js");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

test("passedOf：未四舍五入的比例与及格线比较", () => {
  assert.equal(QT.passedOf(173, 200, 87), false, "86.5% vs 87% fails");
  assert.equal(QT.passedOf(174, 200, 87), true, "87.0% vs 87% passes");
  assert.equal(QT.passedOf(27, 31, 87), true, "87.1% vs 87% passes (float noise absorbed)");
  assert.equal(QT.passedOf(87, 100, 87), true);
  assert.equal(QT.passedOf(0, 0, 60), false, "empty paper never passes");
  // 卷面显示仍是整数
  const detail = [{ type: "mcq", points: 100, isRight: true }, { type: "mcq", points: 73, isRight: true }, { type: "mcq", points: 27, isRight: false }];
  assert.equal(QT.scoreDetail(detail), 87);
  assert.equal(QT.passedOfDetail(detail, 87), false);
});

let srv, admin, emp, courseId;
const qid = {};
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  await completeAllModules(emp, "nho");
  const program = (await admin.get("/api/admin/content")).data.programs.find((p) => p.id === "nho");
  courseId = program.courseIds[0];
  const mcq = async (key, points) => {
    const r = await admin.post("/api/admin/questions", { courseId, type: "mcq", question: "F57 " + key, points, options: [{ text: "R-" + key, ok: true }, { text: "W-" + key, ok: false }], explanation: "" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    qid[key] = r.data.id || (r.data.question && r.data.question.id);
    assert.ok(qid[key], JSON.stringify(r.data));
  };
  await mcq("A", 100); await mcq("B", 73); await mcq("C", 26); await mcq("D", 1);
  await mcq("E", 20);
  const o = await admin.post("/api/admin/questions", { courseId, type: "open", question: "F57 open", rubric: "r", maxPoints: 80, points: 80 });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  qid.O = o.data.id || (o.data.question && o.data.question.id);
  const o2 = await admin.post("/api/admin/questions", { courseId, type: "open", question: "F57 open 73", rubric: "r", maxPoints: 73, points: 73 });
  assert.equal(o2.status, 200, JSON.stringify(o2.data));
  qid.P = o2.data.id || (o2.data.question && o2.data.question.id);
});
after(() => srv.stop());

async function fixedExam(title, ids) {
  const r = await admin.post("/api/admin/exams", { programId: "nho", title, status: "published", courseIds: [courseId], passingScore: 87, mcqCount: 1, openCount: 0, mode: "fixed", questionIds: ids, maxAttempts: 0, retakeCooldownHours: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
// right: 答对的题（key）；其余选择题答错；简答写一句话
function answers(questions, right) {
  const out = {};
  for (const q of questions) {
    const key = Object.keys(qid).find((k) => qid[k] === q.id);
    if (q.type === "open") { out[q.id] = "an answer"; continue; }
    const want = (right.includes(key) ? "R-" : "W-") + key;
    out[q.id] = q.options.findIndex((o) => o.text === want);
  }
  return out;
}
async function sit(examId, right) {
  const start = await emp.post("/api/exam/start", { examId });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const sub = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: answers(start.data.questions, right) });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  return sub.data;
}
async function csvRow(title, n) {
  const res = await admin.raw("GET", "/api/admin/export/attempts.csv");
  assert.equal(res.status, 200);
  const lines = (await res.text()).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split(","));
  const head = lines[0];
  const row = lines.find((c) => c[3] === title && c[4] === String(n));
  assert.ok(row, "CSV row for " + title + " #" + n);
  return { score: row[head.indexOf("Score %")], passed: row[head.indexOf("Passed")] };
}
const hrRow = async (attemptId) => (await admin.get("/api/admin/attempts")).data.find((r) => r.id === attemptId) ||
  ((await admin.get("/api/admin/attempts")).data.items || []).find((r) => r.id === attemptId);

test("交卷：86.5% 对 87% 不通过（显示 87%），成绩列表 / CSV / 学习记录一致；87.0% 通过，最好成绩取已通过的那份", async () => {
  const title = "F57 submit boundary";
  const examId = await fixedExam(title, [qid.A, qid.B, qid.C, qid.D]);   // 卷面 200 分
  // 第 1 次：A + B = 173 / 200 = 86.5%
  const s1 = await sit(examId, ["A", "B"]);
  assert.equal(s1.percent, 87, "page still shows the rounded integer");
  assert.equal(s1.passed, false, "86.5% < 87% → not passed (old rule rounded it up to a pass)");
  assert.equal(s1.gradingStatus, "final");
  const r1 = await hrRow(s1.attemptId);
  assert.equal(r1.percent, 87);
  assert.equal(r1.passed, false, "results list");
  assert.deepEqual(await csvRow(title, 1), { score: "87", passed: "NO" }, "attempts CSV");
  const rec1 = (await emp.get("/api/me/learning-record")).data.find((x) => x.id === "nho");
  assert.equal(rec1.bestPercent, 87);
  assert.equal(rec1.bestPassed, false, "learning record colours the 87% as a fail");
  const ex1 = (await emp.get("/api/programs/nho")).data.exams.find((e) => e.id === examId);
  assert.equal(ex1.best.passed, false);
  // 第 2 次：A + B + D = 174 / 200 = 87.0%
  const s2 = await sit(examId, ["A", "B", "D"]);
  assert.equal(s2.percent, 87);
  assert.equal(s2.passed, true, "87.0% vs 87% passes");
  assert.equal((await hrRow(s2.attemptId)).passed, true);
  assert.deepEqual(await csvRow(title, 2), { score: "87", passed: "YES" });
  assert.equal((await hrRow(s1.attemptId)).passed, false, "the first attempt keeps its stored result");
  // 两份都是 87%：最好成绩取已通过的那份
  const ex2 = (await emp.get("/api/programs/nho")).data.exams.find((e) => e.id === examId);
  assert.equal(ex2.best.percent, 87);
  assert.equal(ex2.best.passed, true, "tie on the rounded percent → the passed attempt is the best");
  const rec2 = (await emp.get("/api/me/learning-record")).data.find((x) => x.id === "nho");
  assert.equal(rec2.bestPassed, true);
});

test("HR 重新评分：结果 86.5% 对 87% 不通过，成绩列表 / CSV / 通知一致；87.0% 通过", async () => {
  const title = "F57 regrade boundary";
  const examId = await fixedExam(title, [qid.A, qid.E, qid.O]);   // 100 + 20 + 80 = 200 分
  // A 对、E 错，简答待评：0 分 50%、满分 90% —— 结论取决于简答 → 待复核（新旧口径都是）
  const s1 = await sit(examId, ["A"]);
  assert.equal(s1.gradingStatus, "pending_review");
  // HR 给 73/80 → 173 / 200 = 86.5%
  const g1 = await admin.post(`/api/admin/attempts/${s1.attemptId}/regrade`, { questionId: qid.O, score: 73 });
  assert.equal(g1.status, 200, JSON.stringify(g1.data));
  assert.equal(g1.data.percent, 87);
  assert.equal(g1.data.passed, false, "HR recompute: 86.5% vs 87% fails");
  assert.equal(g1.data.gradingStatus, "final");
  const r1 = await hrRow(s1.attemptId);
  assert.equal(r1.passed, false, "results list");
  assert.deepEqual(await csvRow(title, 1), { score: "87", passed: "NO" }, "attempts CSV");
  const notes = (await emp.get("/api/me/notifications")).data.items.filter((n) => n.type === "exam.graded" && /F57 regrade boundary/.test(n.title) && /Result ready/.test(n.title));
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0].title, /87%, not passed/);
  assert.match(notes[0].title_zh, /87%，未通过/);
  // 第 2 次：HR 给 74/80 → 174 / 200 = 87.0%
  const s2 = await sit(examId, ["A"]);
  assert.equal(s2.gradingStatus, "pending_review");
  const g2 = await admin.post(`/api/admin/attempts/${s2.attemptId}/regrade`, { questionId: qid.O, score: 74 });
  assert.equal(g2.status, 200, JSON.stringify(g2.data));
  assert.equal(g2.data.percent, 87);
  assert.equal(g2.data.passed, true, "HR recompute: 87.0% vs 87% passes");
  assert.equal((await hrRow(s2.attemptId)).passed, true);
  assert.deepEqual(await csvRow(title, 2), { score: "87", passed: "YES" });
});

test("交卷时的待复核判定也按未四舍五入：简答满分也只到 86.5% → 不决定结论，直接定为不通过（待 HR 评分）", async () => {
  const examId = await fixedExam("F57 decisive check", [qid.A, qid.C, qid.D, qid.P]);   // 100 + 26 + 1 + 73 = 200
  // 只答对 A：简答 0 分 = 50%，满分 = 173 / 200 = 86.5% —— 两头都不通过（旧口径把满分四舍五入成 87% 判为「决定性」→ 待复核）
  const s = await sit(examId, ["A"]);
  assert.equal(s.gradingStatus, "manual_pending", "the short answer cannot change the result");
  assert.equal(s.passed, false);
});
