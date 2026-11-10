// 每题分值（2026-10-06 需求单 #4）：
//   - 考试按题型设默认分值（typePoints），题目可单独设分值（points）覆盖；开考时分值快照进答卷；
//   - 计分 = 各题得分之和 ÷ 卷面总分，及格仍按百分比；多选题「部分正确给一半分」可按考试关闭；
//   - 没有设置分值的旧考试（typePoints 为空）口径不变：客观题 1 分、简答按满分/10 折算，答卷里没有 points 字段。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

let srv, admin, emp, program, courseId, bank;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  await completeAllModules(emp, "nho");
  const content = await admin.get("/api/admin/content");
  program = content.data.programs.find((p) => p.id === "nho");
  courseId = program.courseIds[0];
  bank = (await admin.get("/api/admin/questions")).data;
});
after(() => srv.stop());

const objectiveOf = (cid) => bank.filter((q) => q.courseId === cid && ["mcq", "multi", "fill"].includes(q.type));
// 用题库（含正确项）为一张卷拼出全对 / 指定答案
function answersFor(questions, overrides = {}) {
  const out = {};
  for (const q of questions) {
    if (overrides[q.id] !== undefined) { out[q.id] = overrides[q.id]; continue; }
    const src = bank.find((b) => b.id === q.id);
    if (q.type === "mcq") {
      // 客户端拿到的选项顺序是打乱的：按文字找回正确项的位置
      const okText = src.options.find((o) => o.ok).text;
      out[q.id] = q.options.findIndex((o) => o.text === okText);
    } else if (q.type === "multi") {
      const okTexts = src.options.filter((o) => o.ok).map((o) => o.text);
      out[q.id] = q.options.map((o, i) => (okTexts.includes(o.text) ? i : -1)).filter((i) => i >= 0);
    } else if (q.type === "fill") out[q.id] = src.answers[0];
    else out[q.id] = "answer";
  }
  return out;
}

async function createExam(extra) {
  const r = await admin.post("/api/admin/exams", {
    programId: "nho", title: "Points exam " + Math.random().toString(36).slice(2, 6), status: "published",
    courseIds: [courseId], passingScore: 60, openCount: 0, ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 新建接口只回 { ok, id }，完整字段（含 typePoints / multiPartial）从详情接口取
  return (await admin.get(`/api/admin/exams/${r.data.id}`)).data;
}

test("legacy exam (no typePoints) is unchanged: no points on the paper, totalPoints null, percent by the old rule", async () => {
  const exam = (await admin.get("/api/admin/exams")).data.find((e) => e.id === "exam-nho");
  assert.equal(exam.typePoints, null);
  assert.equal(exam.multiPartial, true);
  const start = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(start.status, 200);
  assert.equal(start.data.totalPoints, null);
  assert.ok(start.data.questions.every((q) => q.points === undefined), "legacy paper carries no points");
});

test("typePoints: every drawn question carries the per-type default; totalPoints is their sum; all correct = 100% and earned == total", async () => {
  const pool = objectiveOf(courseId);
  const exam = await createExam({ mcqCount: pool.length, typePoints: { mcq: 2, multi: 3, fill: 2, open: 10 } });
  assert.deepEqual(exam.typePoints, { mcq: 2, multi: 3, fill: 2, open: 10 });
  const start = await emp.post("/api/exam/start", { examId: exam.id });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const qs = start.data.questions;
  assert.equal(qs.length, pool.length);
  for (const q of qs) assert.equal(q.points, { mcq: 2, multi: 3, fill: 2 }[q.type], q.type);
  const total = qs.reduce((n, q) => n + q.points, 0);
  assert.equal(start.data.totalPoints, total);
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: answersFor(qs) });
  assert.equal(submit.status, 200, JSON.stringify(submit.data));
  assert.equal(submit.data.percent, 100);
  const mine = await emp.get(`/api/me/attempts/${start.data.attemptId}`);
  assert.equal(mine.data.totalPoints, total);
  assert.equal(mine.data.earned, total);
  assert.ok(mine.data.detail.every((d) => d.points != null), "detail rows carry their points");
});

test("a question's own points override the exam default, and the percent is weighted by points", async () => {
  // 一道 5 分的单选题 + 其余 1 分的题；只答对这道 5 分题
  const add = await admin.post("/api/admin/questions", {
    courseId, type: "mcq", question: "Five-point question", question_zh: "五分题", points: 5,
    options: [{ text: "Right", text_zh: "对", ok: true }, { text: "Wrong", text_zh: "错", ok: false }], explanation: "",
  });
  assert.equal(add.status, 200);
  bank = (await admin.get("/api/admin/questions")).data;
  const five = bank.find((q) => q.id === add.data.id);
  assert.equal(five.points, 5);
  const pool = objectiveOf(courseId);
  const exam = await createExam({ mcqCount: pool.length, typePoints: { mcq: 1, multi: 1, fill: 1, open: 10 } });
  const start = await emp.post("/api/exam/start", { examId: exam.id });
  const qs = start.data.questions;
  const mine = qs.find((q) => q.id === five.id);
  assert.equal(mine.points, 5, "override is snapshotted onto the paper");
  const total = qs.reduce((n, q) => n + q.points, 0);
  assert.equal(total, (qs.length - 1) * 1 + 5);
  // 其余全答错（选项下标 -1 / 空），只答对 5 分题
  const wrong = {}; for (const q of qs) if (q.id !== five.id) wrong[q.id] = q.type === "multi" ? [] : q.type === "fill" ? "zzz-wrong" : -1;
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: answersFor(qs, wrong) });
  assert.equal(submit.status, 200, JSON.stringify(submit.data));
  assert.equal(submit.data.percent, Math.round((5 / total) * 100));
  const got = await emp.get(`/api/me/attempts/${start.data.attemptId}`);
  assert.equal(got.data.earned, 5);
  assert.equal(got.data.totalPoints, total);
});

test("multiPartial off: a partially correct multiple-choice answer scores 0 instead of half", async () => {
  const add = await admin.post("/api/admin/questions", {
    courseId, type: "multi", question: "Pick both", question_zh: "两个都选", points: 4,
    options: [{ text: "A", ok: true }, { text: "B", ok: true }, { text: "C", ok: false }], explanation: "",
  });
  assert.equal(add.status, 200);
  bank = (await admin.get("/api/admin/questions")).data;
  const multiId = add.data.id;
  const pool = objectiveOf(courseId);
  for (const partial of [true, false]) {
    const exam = await createExam({ mcqCount: pool.length, typePoints: { mcq: 1, multi: 1, fill: 1, open: 10 }, multiPartial: partial });
    assert.equal(exam.multiPartial, partial);
    const start = await emp.post("/api/exam/start", { examId: exam.id });
    const qs = start.data.questions;
    const m = qs.find((q) => q.id === multiId);
    assert.equal(m.points, 4);
    const aIdx = m.options.findIndex((o) => o.text === "A");
    const total = qs.reduce((n, q) => n + q.points, 0);
    const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: answersFor(qs, { [multiId]: [aIdx] }) });
    assert.equal(submit.status, 200);
    const expectEarned = total - 4 + (partial ? 2 : 0);
    assert.equal(submit.data.percent, Math.round((expectEarned / total) * 100), "partial=" + partial);
    const got = await emp.get(`/api/me/attempts/${start.data.attemptId}`);
    assert.equal(got.data.earned, expectEarned);
    const row = got.data.detail.find((d) => d.id === multiId);
    // partial = 实际给了一半分；关闭部分给分时这题按 0 分、partial 为 false
    assert.equal(row.partial, partial);
    assert.equal(row.points, 4);
  }
});

test("exam settings validation: typePoints are clamped to integers 1–100 and missing keys fall back to the defaults", async () => {
  const exam = await createExam({ mcqCount: 1, typePoints: { mcq: 2.6, multi: 500, open: 0 } });
  assert.deepEqual(exam.typePoints, { mcq: 3, multi: 1, fill: 1, open: 10 });
  const none = await createExam({ mcqCount: 1, typePoints: { mcq: "x" } });
  assert.equal(none.typePoints, null, "all-invalid typePoints = legacy rule");
});

test("exam-prep summary exposes typePoints and a total-points range; bulk import accepts a points column for every type", async () => {
  const pool = objectiveOf(courseId);
  await createExam({ mcqCount: Math.min(2, pool.length), typePoints: { mcq: 2, multi: 2, fill: 2, open: 10 } });
  const prog = await emp.get("/api/programs/nho");
  const ex = prog.data.exams.find((e) => e.typePoints && e.typePoints.mcq === 2);
  assert.ok(ex, "summary carries typePoints");
  assert.ok(ex.pointsRange && ex.pointsRange.min >= 4 && ex.pointsRange.max >= ex.pointsRange.min, JSON.stringify(ex.pointsRange));
  const legacy = prog.data.exams.find((e) => e.id === "exam-nho");
  assert.equal(legacy.pointsRange, null);
  const imp = await admin.post("/api/admin/questions/bulk", { courseId, items: [
    { type: "mcq", question: "Imported 3pt", options: [{ text: "a", ok: true }, { text: "b", ok: false }], explanation: "", points: 3 },
    { type: "open", question: "Imported open", rubric: "r", maxPoints: 20, points: 20 },
  ] });
  assert.equal(imp.status, 200);
  const all = (await admin.get("/api/admin/questions")).data;
  const r0 = all.find((q) => q.id === imp.data.results[0].id), r1 = all.find((q) => q.id === imp.data.results[1].id);
  assert.equal(r0.points, 3);
  assert.equal(r1.points, 20);
  assert.equal(r1.maxPoints, 20);
});

test("fixed-question mode: the paper is exactly the chosen questions in order, counts and total come from the list, random settings are ignored", async () => {
  const pool = objectiveOf(courseId);
  const chosen = pool.slice(0, 3).map((q) => q.id).reverse(); // 倒序，验证按设定顺序出题
  const exam = await createExam({ mcqCount: 1, mode: "fixed", questionIds: [...chosen, "q-not-in-pool", chosen[0]], typePoints: { mcq: 2, multi: 3, fill: 2, open: 10 } });
  assert.equal(exam.mode, "fixed");
  assert.deepEqual(exam.questionIds, chosen, "unknown ids dropped, duplicates removed, order kept");
  const prog = await emp.get("/api/programs/nho");
  const sum = prog.data.exams.find((e) => e.id === exam.id);
  assert.equal(sum.mode, "fixed");
  assert.equal(sum.mcqCount + sum.openCount, 3, "question count follows the list, not mcqCount");
  assert.equal(sum.pointsRange.min, sum.pointsRange.max, "fixed paper has an exact total");
  const start = await emp.post("/api/exam/start", { examId: exam.id });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.deepEqual(start.data.questions.map((q) => q.id), chosen, "same questions, same order");
  assert.equal(start.data.totalPoints, sum.pointsRange.min);
  // 发布一张没有题的固定卷会被拒绝
  const bad = await admin.post("/api/admin/exams", { programId: "nho", title: "Empty fixed", status: "published", courseIds: [courseId], passingScore: 60, mcqCount: 1, openCount: 0, mode: "fixed", questionIds: [] });
  assert.equal(bad.status, 400);
  // 草稿可以先存空清单
  const draft = await admin.post("/api/admin/exams", { programId: "nho", title: "Draft fixed", status: "draft", courseIds: [courseId], passingScore: 60, mcqCount: 1, openCount: 0, mode: "fixed", questionIds: [] });
  assert.equal(draft.status, 200);
});
