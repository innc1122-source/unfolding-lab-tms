"use strict";
// 简答题（4a 原样移植，设计 §1.3）。交卷时不给分（score 为空），由评分队列 / HR 复核给分；
// 学员端明细一律经 learnerDetail（= 旧 clientOpenDetail）：AI 建议分、评分依据、置信度与注入标记只给 HR。
const { legacyColumns } = require("./util.js");

function clientOpenDetail(d) {
  const out = { id: d.id, type: "open", question: d.question, question_zh: d.question_zh || null, answer: d.answer, maxPoints: d.maxPoints, score: d.score == null ? null : d.score };
  if (d.points != null) out.points = d.points;
  const review = d.review || (d.score == null ? "pending" : "legacy");
  out.review = review;
  if (review === "ai_provisional" || review === "confirmed") {
    out.feedback = d.feedback || (d.ai && d.ai.feedback) || null;
    if (d.ai) out.ai = { model: d.ai.modelReturned || d.ai.model || null, generatedAt: d.ai.generatedAt || null };
  } else if (review === "legacy" || review === "overridden" || review === "manual") {
    out.feedback = d.feedback || null;
  }
  if (d.demoEstimate != null) out.demoEstimate = d.demoEstimate;
  if (d.overridden) out.overridden = true;
  return out;
}

module.exports = {
  key: "open", group: "open",
  fromRow(r) { return { rubric: r.rubric, rubric_zh: r.rubric_zh, maxPoints: r.maxPoints }; },
  toRow(q) { return legacyColumns(q); },
  // 单题 POST / PUT 不限 maxPoints；批量导入夹到 1–100（两处旧行为都保留）
  validate(q, ctx = {}) {
    const maxPoints = ctx.bulk ? Math.min(100, Math.max(1, Number(q.maxPoints) || 10)) : q.maxPoints || 10;
    return { fields: { rubric: q.rubric || "", rubric_zh: q.rubric_zh || null, maxPoints } };
  },
  snapshot(q, ctx) {
    const snap = { id: q.id, type: "open", question: q.question, question_zh: q.question_zh || null, rubric: q.rubric, maxPoints: q.maxPoints };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(q) {
    const c = { id: q.id, type: "open", question: q.question, question_zh: q.question_zh, maxPoints: q.maxPoints };
    if (q.points != null) c.points = q.points;
    return c;
  },
  parseAnswer(raw) { return raw; },
  // 简答题：先不给分（score 为空）；评分队列或 HR 复核后才有分数
  grade(q, ans) {
    const d = { id: q.id, type: "open", question: q.question, question_zh: q.question_zh || null, answer: String(ans || ""), score: null, maxPoints: q.maxPoints, feedback: null, review: "pending" };
    if (q.points != null) d.points = q.points;
    return d;
  },
  learnerDetail(d) { return clientOpenDetail(d); },
  totals() { return null; },
  clientOpenDetail,
};
