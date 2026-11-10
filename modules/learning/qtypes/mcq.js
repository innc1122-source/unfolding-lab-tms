"use strict";
// 单选题（4a 原样移植，设计 §1.3）。每段逻辑都从 2026-10-08 的 server.js / store.js 逐字剪下，
// 冻结副本在 test/fixtures/qtypes-legacy.js，test/qtypes-legacy-parity.test.js 逐项比对。
const U = require("./util.js");
const { legacyColumns, parseJson } = U;

module.exports = {
  key: "mcq", group: "objective",
  fromRow(r) {
    return { options: parseJson(r.options, []), explanation: r.explanation, explanation_zh: r.explanation_zh };
  },
  toRow(q) { return legacyColumns(q); },
  // questionItemFromBody / 批量导入的单选分支
  validate(q, ctx = {}) {
    if (ctx.bulk) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length !== 1)
        return { error: "single-choice needs ≥2 options and exactly one correct", error_zh: "单选题至少 2 个选项，且只能有 1 个正确答案", code: "bad_options" };
      return { fields: {
        options: q.options.map((o) => ({ text: String(o.text || ""), text_zh: o.text_zh ? String(o.text_zh) : null, ok: !!o.ok })),
        explanation: q.explanation || "", explanation_zh: q.explanation_zh || null,
      } };
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.filter((o) => o.ok).length !== 1)
      return { error: "Single-choice needs at least 2 options with exactly one correct answer", error_zh: "单选题至少需要 2 个选项，且只能有 1 个正确答案。", code: "bad_options" };
    return { fields: {
      options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null, ok: !!o.ok })),
      explanation: q.explanation || "", explanation_zh: q.explanation_zh || null,
    } };
  },
  // /api/exam/start 的单题快照：选项按考试设置打乱（shuffleOptions 缺省 = 打乱，即原行为）
  snapshot(q, ctx) {
    const opts = q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null, ok: !!o.ok }));
    const snap = {
      id: q.id, type: q.type, question: q.question, question_zh: q.question_zh || null,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
      options: U.noShuffle(ctx) ? opts : ctx.shuffle(opts),
    };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(q) {
    const c = { id: q.id, type: q.type, question: q.question, question_zh: q.question_zh, options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh })) };
    if (q.points != null) c.points = q.points;
    return c;
  },
  // 旧题型原样把 answers[qid] 交给评分（旧代码在评分里自行容错，明细里记录的 picked 也是原值）
  parseAnswer(raw) { return raw; },
  grade(q, picked) {
    const correctIdx = q.options.findIndex((o) => o.ok);
    const isRight = picked === correctIdx;
    const d = {
      id: q.id, type: "mcq", question: q.question, question_zh: q.question_zh || null,
      options: q.options.map((o) => ({ text: o.text, text_zh: o.text_zh || null })),
      picked: typeof picked === "number" ? picked : null,
      correct: correctIdx, isRight, explanation: q.explanation, explanation_zh: q.explanation_zh || null,
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
