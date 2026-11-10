"use strict";
// 排序题（4b，设计 §1.4 / §1.5）。题库按正确顺序存 3–8 个步骤；开考时永远打乱且保证不是原顺序（原顺序就是答案）。
// 作答 = 快照下标的排列；部分给分按「相邻对」：学员顺序里相邻的两项，在正确顺序里也相邻且方向相同，算对一对，
// 得分 = 对的对数 ÷ (n−1)。例：正确 ABCD、作答 BCDA → BC、CD 对 → 2/3；完全倒序 → 0。
const { LIMITS } = require("./spec.js");
const U = require("./util.js");

const L = LIMITS.ordering;

function validate(q) {
  const raw = q.items;
  if (!Array.isArray(raw) || raw.length < L.min || raw.length > L.max)
    return U.fail("bad_items", `Ordering needs ${L.min}–${L.max} steps.`, `排序题需要 ${L.min}–${L.max} 个步骤。`);
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const t = U.biText(raw[i], [`Step ${i + 1}`, `第 ${i + 1} 步`]);
    if (t.error) return t;
    items.push(t.value);
  }
  if (U.dupIndex(items, "text") >= 0 || U.dupIndex(items, "text_zh") >= 0)
    return U.fail("duplicate_items", "Ordering steps must all be different.", "排序题的各步骤不能重复。");
  return { fields: { items, ...U.explanationFields(q) } };
}

// 学员顺序 resp 与正确顺序 key 的相邻对判定：pairRight[i] = resp[i] 之后紧跟 resp[i+1] 在 key 里也成立
function pairMarks(key, resp) {
  const pos = new Map(key.map((s, i) => [s, i]));
  const out = [];
  for (let i = 0; i + 1 < resp.length; i++) out.push(pos.get(resp[i + 1]) === pos.get(resp[i]) + 1);
  return out;
}

module.exports = {
  key: "ordering", group: "objective",
  fromRow(r) {
    const d = U.parseJson(r.data, {});
    return { items: (Array.isArray(d.items) ? d.items : []).map(U.cleanText), explanation: r.explanation, explanation_zh: r.explanation_zh };
  },
  toRow(q) { return U.dataColumns(q, { items: (q.items || []).map(U.cleanText) }); },
  validate,
  snapshot(q, ctx) {
    const src = (q.items || []).map(U.cleanText);
    const perm = U.shuffleNonIdentity(src.length, ctx.shuffle); // perm[s] = 快照第 s 项在正确顺序里的位置
    const items = perm.map((j) => src[j]);
    const key = src.map((_, j) => perm.indexOf(j)); // 正确顺序 → 快照下标
    const snap = {
      id: q.id, type: "ordering", question: q.question, question_zh: q.question_zh || null,
      items, key, partialCredit: U.flagOn(ctx.partialCredit),
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(s) {
    const c = { id: s.id, type: "ordering", question: s.question, question_zh: s.question_zh, items: s.items.map((o) => ({ text: o.text, text_zh: o.text_zh })) };
    if (s.points != null) c.points = s.points;
    return c;
  },
  parseAnswer(raw, s) { return U.isPermutation(raw, s.items.length) ? raw.slice() : null; },
  grade(s, resp) {
    const n = s.items.length;
    let credit = 0, pairRight = [];
    if (resp) {
      pairRight = pairMarks(s.key, resp);
      const exact = resp.every((v, i) => v === s.key[i]);
      if (exact) credit = 1;
      else if (s.partialCredit !== false && n > 1) credit = pairRight.filter(Boolean).length / (n - 1);
    }
    const d = {
      id: s.id, type: "ordering", question: s.question, question_zh: s.question_zh || null,
      items: s.items, key: s.key, response: resp || null, pairRight,
      ...U.creditFields(credit),
      explanation: s.explanation, explanation_zh: s.explanation_zh || null,
    };
    if (s.points != null) d.points = s.points;
    return d;
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const out = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, items: d.items, response: d.response, credit: d.credit, isRight: d.isRight, partial: d.partial };
    if (d.points != null) out.points = d.points;
    return out;
  },
  totals(d) { const pts = U.ptsOf(d); return { earned: pts * U.creditOf(d), max: pts }; },
  isUsable(q) { return Array.isArray(q.items) && q.items.length >= 2; },
  _pairMarks: pairMarks,
};
