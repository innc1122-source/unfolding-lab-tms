"use strict";
// 填空题（4a 原样移植，设计 §1.3）。可接受答案存在 options 列（JSON 数组）。
const { legacyColumns, parseJson, normFill } = require("./util.js");

module.exports = {
  key: "fill", group: "objective",
  fromRow(r) {
    // Accepted answers are stored in the options column as a JSON array.
    return { answers: parseJson(r.options, []), explanation: r.explanation, explanation_zh: r.explanation_zh };
  },
  toRow(q) { return legacyColumns(q); },
  validate(q, ctx = {}) {
    if (!Array.isArray(q.answers) || !q.answers.filter((a) => String(a).trim()).length)
      return ctx.bulk
        ? { error: "fill-in needs at least one accepted answer", error_zh: "填空题至少需要 1 个可接受答案", code: "bad_answers" }
        : { error: "Fill-in-the-blank needs at least one accepted answer", error_zh: "填空题至少需要 1 个可接受答案。", code: "bad_answers" };
    return { fields: {
      answers: q.answers.map((a) => String(a).trim()).filter(Boolean),
      explanation: q.explanation || "", explanation_zh: q.explanation_zh || null,
    } };
  },
  snapshot(q, ctx) {
    const snap = { id: q.id, type: "fill", question: q.question, question_zh: q.question_zh || null, answers: q.answers, explanation: q.explanation, explanation_zh: q.explanation_zh || null };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(q) {
    const c = { id: q.id, type: "fill", question: q.question, question_zh: q.question_zh };
    if (q.points != null) c.points = q.points;
    return c;
  },
  parseAnswer(raw) { return raw; },
  grade(q, ans) {
    const raw = String(ans || "");
    const isRight = normFill(raw) !== "" && q.answers.some((a) => normFill(a) === normFill(raw));
    const d = {
      id: q.id, type: "fill", question: q.question, question_zh: q.question_zh || null,
      answer: raw, accepted: q.answers, isRight,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    };
    if (q.points != null) d.points = q.points;
    return d;
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const base = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, isRight: d.isRight, partial: d.partial || false };
    if (d.points != null) base.points = d.points;
    base.answer = d.answer;
    return base;
  },
  totals() { return null; },
};
