"use strict";
// 判断题（4c，设计 §1.4 / §1.5）。独立题型，题库只存 { answer: true|false }；选项固定为「正确 / 错误」，永不打乱。
// 现有「单选题 + True/False 两个选项」的旧题照旧是单选题，不自动转换（D2）。
const U = require("./util.js");

module.exports = {
  key: "tf", group: "objective",
  fromRow(r) {
    const d = U.parseJson(r.data, {});
    return { answer: typeof d.answer === "boolean" ? d.answer : null, explanation: r.explanation, explanation_zh: r.explanation_zh };
  },
  toRow(q) { return U.dataColumns(q, { answer: q.answer === true }); },
  validate(q) {
    if (q.answer !== true && q.answer !== false)
      return U.fail("bad_answer", "True/false needs the correct answer (true or false).", "判断题需要设定正确答案（正确或错误）。");
    return { fields: { answer: q.answer, ...U.explanationFields(q) } };
  },
  snapshot(q, ctx) {
    const snap = {
      id: q.id, type: "tf", question: q.question, question_zh: q.question_zh || null,
      answer: q.answer === true,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(s) {
    const c = { id: s.id, type: "tf", question: s.question, question_zh: s.question_zh };
    if (s.points != null) c.points = s.points;
    return c;
  },
  parseAnswer(raw) { return raw === true || raw === false ? raw : null; },
  grade(s, resp) {
    const credit = resp === true || resp === false ? (resp === s.answer ? 1 : 0) : 0;
    const d = {
      id: s.id, type: "tf", question: s.question, question_zh: s.question_zh || null,
      key: s.answer, response: resp === true || resp === false ? resp : null,
      ...U.creditFields(credit),
      explanation: s.explanation, explanation_zh: s.explanation_zh || null,
    };
    if (s.points != null) d.points = s.points;
    return d;
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const out = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, response: d.response, credit: d.credit, isRight: d.isRight, partial: d.partial };
    if (d.points != null) out.points = d.points;
    return out;
  },
  totals(d) { const pts = U.ptsOf(d); return { earned: pts * U.creditOf(d), max: pts }; },
  isUsable(q) { return typeof q.answer === "boolean"; },
};
