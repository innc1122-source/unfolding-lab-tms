"use strict";
// 匹配题（4b，设计 §1.4 / §1.5）。题库存 2–8 组「左项 → 右项」与 0–3 个只在右栏出现的干扰项。
// 开考：左栏按考试的选项顺序设置（打乱或按题库顺序）；右栏 = 各组右项 + 干扰项，永远打乱，且不会与左栏整体对齐。
// 作答 = 每个左项选一个右栏下标（或 null）；同一右项可以选给多个左项，但只对它自己那一组算对。
// 部分给分：答对的左项 ÷ 左项数；关闭时全对才得分。
const { LIMITS } = require("./spec.js");
const U = require("./util.js");

const L = LIMITS.matching;

function validate(q) {
  const raw = q.pairs;
  if (!Array.isArray(raw) || raw.length < L.min || raw.length > L.max)
    return U.fail("bad_pairs", `Matching needs ${L.min}–${L.max} pairs.`, `匹配题需要 ${L.min}–${L.max} 组配对。`);
  const pairs = [];
  for (let i = 0; i < raw.length; i++) {
    const p = U.isPlainObject(raw[i]) ? raw[i] : {};
    const l = U.biText(p.left, [`Pair ${i + 1} (left)`, `第 ${i + 1} 组左项`]);
    if (l.error) return l;
    const r = U.biText(p.right, [`Pair ${i + 1} (right)`, `第 ${i + 1} 组右项`]);
    if (r.error) return r;
    pairs.push({ left: l.value, right: r.value });
  }
  const dRaw = q.distractors == null ? [] : q.distractors;
  if (!Array.isArray(dRaw) || dRaw.length > L.distractorsMax)
    return U.fail("bad_distractors", `At most ${L.distractorsMax} distractors.`, `干扰项最多 ${L.distractorsMax} 个。`);
  const distractors = [];
  for (let i = 0; i < dRaw.length; i++) {
    const t = U.biText(dRaw[i], [`Distractor ${i + 1}`, `干扰项 ${i + 1}`]);
    if (t.error) return t;
    distractors.push(t.value);
  }
  const lefts = pairs.map((p) => p.left);
  if (U.dupIndex(lefts, "text") >= 0 || U.dupIndex(lefts, "text_zh") >= 0)
    return U.fail("duplicate_lefts", "Left-hand items must all be different.", "左项不能重复。");
  const rights = [...pairs.map((p) => p.right), ...distractors];
  if (U.dupIndex(rights, "text") >= 0 || U.dupIndex(rights, "text_zh") >= 0)
    return U.fail("duplicate_rights", "Right-hand items (including distractors) must all be different.", "右项（含干扰项）不能重复。");
  return { fields: { pairs, distractors, ...U.explanationFields(q) } };
}

module.exports = {
  key: "matching", group: "objective",
  fromRow(r) {
    const d = U.parseJson(r.data, {});
    const pairs = (Array.isArray(d.pairs) ? d.pairs : []).map((p) => ({ left: U.cleanText(p && p.left), right: U.cleanText(p && p.right) }));
    const distractors = (Array.isArray(d.distractors) ? d.distractors : []).map(U.cleanText);
    return { pairs, distractors, explanation: r.explanation, explanation_zh: r.explanation_zh };
  },
  toRow(q) {
    return U.dataColumns(q, {
      pairs: (q.pairs || []).map((p) => ({ left: U.cleanText(p && p.left), right: U.cleanText(p && p.right) })),
      distractors: (q.distractors || []).map(U.cleanText),
    });
  },
  validate,
  snapshot(q, ctx) {
    const pairs = (q.pairs || []).map((p) => ({ left: U.cleanText(p && p.left), right: U.cleanText(p && p.right) }));
    const pool = [...pairs.map((p) => p.right), ...(q.distractors || []).map(U.cleanText)];
    const n = pairs.length;
    const leftOrder = U.noShuffle(ctx) ? U.range(n) : ctx.shuffle(U.range(n)); // 快照左项 i = 第 leftOrder[i] 组
    const aligned = (r) => n > 1 && leftOrder.every((p, i) => r[i] === p);
    let rightOrder = ctx.shuffle(U.range(pool.length));
    for (let t = 0; t < 20 && aligned(rightOrder); t++) rightOrder = ctx.shuffle(U.range(pool.length));
    if (aligned(rightOrder)) { rightOrder = rightOrder.slice(); [rightOrder[0], rightOrder[1]] = [rightOrder[1], rightOrder[0]]; }
    const snap = {
      id: q.id, type: "matching", question: q.question, question_zh: q.question_zh || null,
      lefts: leftOrder.map((p) => pairs[p].left),
      rights: rightOrder.map((k) => pool[k]),
      key: leftOrder.map((p) => rightOrder.indexOf(p)),
      partialCredit: U.flagOn(ctx.partialCredit),
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(s) {
    const c = {
      id: s.id, type: "matching", question: s.question, question_zh: s.question_zh,
      lefts: s.lefts.map((o) => ({ text: o.text, text_zh: o.text_zh })),
      rights: s.rights.map((o) => ({ text: o.text, text_zh: o.text_zh })),
    };
    if (s.points != null) c.points = s.points;
    return c;
  },
  parseAnswer(raw, s) { return U.intSlots(raw, s.lefts.length, s.rights.length); },
  grade(s, resp) {
    const n = s.lefts.length;
    const leftRight = s.key.map((k, i) => !!resp && resp[i] === k);
    const right = leftRight.filter(Boolean).length;
    const credit = !resp || !n ? 0 : right === n ? 1 : s.partialCredit !== false ? right / n : 0;
    const d = {
      id: s.id, type: "matching", question: s.question, question_zh: s.question_zh || null,
      lefts: s.lefts, rights: s.rights, key: s.key, response: resp || null, leftRight,
      ...U.creditFields(credit),
      explanation: s.explanation, explanation_zh: s.explanation_zh || null,
    };
    if (s.points != null) d.points = s.points;
    return d;
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const out = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, lefts: d.lefts, rights: d.rights, response: d.response, credit: d.credit, isRight: d.isRight, partial: d.partial };
    if (d.points != null) out.points = d.points;
    return out;
  },
  totals(d) { const pts = U.ptsOf(d); return { earned: pts * U.creditOf(d), max: pts }; },
  isUsable(q) { return Array.isArray(q.pairs) && q.pairs.length >= 1; },
};
