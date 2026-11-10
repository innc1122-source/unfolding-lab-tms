"use strict";
// 多选题（4a 原样移植，设计 §1.3）。部分给分沿用考试的 multiPartial（开考时快照为 partialCredit）。
const U = require("./util.js");
const { legacyColumns, parseJson } = U;

module.exports = {
  key: "multi", group: "objective",
  fromRow(r) {
    return { options: parseJson(r.options, []), explanation: r.explanation, explanation_zh: r.explanation_zh };
  },
  toRow(q) { return legacyColumns(q); },
  validate(q, ctx = {}) {
    if (ctx.bulk) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length < 1)
        return { error: "multiple-answer needs ≥2 options and ≥1 correct", error_zh: "多选题至少 2 个选项，且至少 1 个正确答案", code: "bad_options" };
      return { fields: {
        options: q.options.map((o) => ({ text: String(o.text || ""), text_zh: o.text_zh ? String(o.text_zh) : null, ok: !!o.ok })),
        explanation: q.explanation || "", explanation_zh: q.explanation_zh || null,
      } };
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length < 1)
      return { error: "Multiple-answer needs at least 2 options with one or more correct answers", error_zh: "多选题至少需要 2 个选项，且至少有 1 个正确答案。", code: "bad_options" };
    return { fields: {
      options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null, ok: !!o.ok })),
      explanation: q.explanation || "", explanation_zh: q.explanation_zh || null,
    } };
  },
  snapshot(q, ctx) {
    const opts = q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null, ok: !!o.ok }));
    const snap = {
      id: q.id, type: q.type, question: q.question, question_zh: q.question_zh || null,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
      options: U.noShuffle(ctx) ? opts : ctx.shuffle(opts),
    };
    if (ctx.points != null) snap.points = ctx.points;
    snap.partialCredit = ctx.multiPartial !== false;
    return snap;
  },
  client(q) {
    const c = { id: q.id, type: q.type, question: q.question, question_zh: q.question_zh, options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh })) };
    if (q.points != null) c.points = q.points;
    return c;
  },
  parseAnswer(raw) { return raw; },
  // Multiple-answer: all correct = full credit, correct subset = half, any wrong pick = zero.
  grade(q, raw) {
    const picked = Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : [];
    const correct = q.options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0);
    const anyWrong = picked.some((i) => !correct.includes(i));
    const allCorrect = !anyWrong && picked.length > 0 && correct.every((i) => picked.includes(i));
    // 「多选题部分正确给一半分」按开考时快照的考试设置（partialCredit），默认开 = 原规则
    const credit = allCorrect ? 1 : (q.partialCredit !== false && !anyWrong && picked.length > 0) ? 0.5 : 0;
    const d = {
      id: q.id, type: "multi", question: q.question, question_zh: q.question_zh || null,
      options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null })),
      picked, correct, isRight: allCorrect, partial: credit === 0.5,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    };
    if (q.points != null) d.points = q.points;
    return d;
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const base = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, isRight: d.isRight, partial: d.partial || false };
    if (d.points != null) base.points = d.points;
    base.options = d.options; base.picked = d.picked;
    return base;
  },
  totals() { return null; },
};
