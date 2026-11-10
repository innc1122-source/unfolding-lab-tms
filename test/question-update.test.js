// 题目原地修改（2026-10-06）：PUT /api/admin/questions/:id
//   - 题目 id 不变 —— 固定题目模式的考试按 id 引用题目，旧做法「新建再删旧」会让考试悄悄少一题；
//   - 表单不编辑的字段沿用原值：讲解（请求体不带时）、所属模块（不带 moduleId 且课程没变时）；换课程则模块清空；
//   - 校验与新建同一套；不存在的题 404。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin, courseId, otherCourseId, moduleId;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const content = (await admin.get("/api/admin/content")).data;
  const program = content.programs.find((p) => p.id === "nho");
  courseId = program.courseIds[0];
  const courses = content.courses || [];
  otherCourseId = (courses.find((c) => c.id !== courseId) || {}).id;
  const course = courses.find((c) => c.id === courseId);
  moduleId = (course && course.modules && course.modules[0] && course.modules[0].id) || "mod-x";
});
after(() => srv.stop());

const getQ = async (id) => (await admin.get("/api/admin/questions")).data.find((q) => q.id === id);

test("editing a question keeps its id, so a fixed-question exam still has it; explanation and module carry over", async () => {
  const add = await admin.post("/api/admin/questions", {
    courseId, moduleId, type: "mcq", question: "Original stem?", question_zh: "原题干？",
    options: [{ text: "A", ok: true }, { text: "B", ok: false }], explanation: "Because A.", explanation_zh: "因为 A。", points: 3,
  });
  assert.equal(add.status, 200);
  const id = add.data.id;
  const ex = await admin.post("/api/admin/exams", {
    programId: "nho", title: "Fixed exam for edit test", status: "draft", courseIds: [courseId], passingScore: 60,
    mcqCount: 1, openCount: 0, mode: "fixed", questionIds: [id],
  });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));

  // 表单发来的请求体：不带讲解、不带模块
  const put = await admin.put(`/api/admin/questions/${id}`, {
    courseId, type: "mcq", question: "Edited stem?", question_zh: "改过的题干？",
    options: [{ text: "A", ok: false }, { text: "B", ok: true }, { text: "C", ok: false }], points: 5,
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.id, id);
  const q = await getQ(id);
  assert.equal(q.question, "Edited stem?");
  assert.equal(q.question_zh, "改过的题干？");
  assert.equal(q.options.length, 3);
  assert.equal(q.options.findIndex((o) => o.ok), 1);
  assert.equal(q.points, 5);
  assert.equal(q.explanation, "Because A.", "explanation kept");
  assert.equal(q.explanation_zh, "因为 A。");
  assert.equal(q.moduleId, moduleId, "module kept when the course did not change");
  const exam = (await admin.get(`/api/admin/exams/${ex.data.id}`)).data;
  assert.deepEqual(exam.questionIds, [id], "the fixed exam still references the edited question");

  // 明确带讲解 = 按请求体改
  await admin.put(`/api/admin/questions/${id}`, { courseId, type: "mcq", question: "Edited stem?", options: [{ text: "A", ok: true }, { text: "B", ok: false }], explanation: "New why.", explanation_zh: null });
  assert.equal((await getQ(id)).explanation, "New why.");

  // 考试没有删除接口；草稿考试留在临时测试库里即可
  assert.equal((await admin.del(`/api/admin/questions/${id}`)).status, 200);
});

test("moving a question to another course clears its module; invalid bodies are rejected and leave the row unchanged; unknown id 404", async () => {
  const add = await admin.post("/api/admin/questions", { courseId, moduleId, type: "fill", question: "Fill?", answers: ["x"] });
  const id = add.data.id;
  const bad = await admin.put(`/api/admin/questions/${id}`, { courseId, type: "mcq", question: "Two right?", options: [{ text: "A", ok: true }, { text: "B", ok: true }] });
  assert.equal(bad.status, 400);
  const still = await getQ(id);
  assert.equal(still.type, "fill");
  assert.deepEqual(still.answers, ["x"]);
  if (otherCourseId) {
    const mv = await admin.put(`/api/admin/questions/${id}`, { courseId: otherCourseId, type: "fill", question: "Fill?", answers: ["x", "y"] });
    assert.equal(mv.status, 200);
    const q = await getQ(id);
    assert.equal(q.courseId, otherCourseId);
    assert.equal(q.moduleId, null, "module belongs to the old course, so it is cleared");
    assert.deepEqual(q.answers, ["x", "y"]);
  }
  assert.equal((await admin.put("/api/admin/questions/q-does-not-exist", { courseId, type: "fill", question: "?", answers: ["a"] })).status, 404);
  assert.equal((await admin.del(`/api/admin/questions/${id}`)).status, 200);
});
