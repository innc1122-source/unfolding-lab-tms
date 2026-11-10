"use strict";
// 分类题（4c，设计 §1.4 / §1.5）。题库存 2–5 个类别与 2–12 个分类项（cat = 类别下标），每个类别至少一项。
// 开考：类别按题库顺序；分类项按考试的选项顺序设置。作答 = 每个分类项选一个类别下标（或 null）。
// 部分给分：分对的项 ÷ 项数；关闭时全对才得分。
const { LIMITS } = require("./spec.js");
const U = require("./util.js");

const L = LIMITS.classify;

function validate(q) {
  const cRaw = q.categories;
  if (!Array.isArray(cRaw) || cRaw.length < L.catMin || cRaw.length > L.catMax)
    return U.fail("bad_categories", `Classification needs ${L.catMin}–${L.catMax} categories.`, `分类题需要 ${L.catMin}–${L.catMax} 个类别。`);
  const categories = [];
  for (let i = 0; i < cRaw.length; i++) {
    const t = U.biText(cRaw[i], [`Category ${i + 1}`, `类别 ${i + 1}`]);
    if (t.error) return t;
    categories.push(t.value);
  }
  if (U.dupIndex(categories, "text") >= 0 || U.dupIndex(categories, "text_zh") >= 0)
    return U.fail("duplicate_categories", "Categories must all be different.", "类别不能重复。");
  const iRaw = q.items;
  if (!Array.isArray(iRaw) || iRaw.length < L.itemMin || iRaw.length > L.itemMax)
    return U.fail("bad_items", `Classification needs ${L.itemMin}–${L.itemMax} items.`, `分类题需要 ${L.itemMin}–${L.itemMax} 个分类项。`);
  const items = [];
  for (let i = 0; i < iRaw.length; i++) {
    const t = U.biText(iRaw[i], [`Item ${i + 1}`, `分类项 ${i + 1}`]);
    if (t.error) return t;
    const cat = iRaw[i] && iRaw[i].cat;
    if (!U.isInt(cat) || cat < 0 || cat >= categories.length)
      return U.fail("bad_category_ref", `Item ${i + 1}: choose one of the categories.`, `分类项 ${i + 1}：请选择所属类别。`);
    items.push({ ...t.value, cat });
  }
  if (U.dupIndex(items, "text") >= 0 || U.dupIndex(items, "text_zh") >= 0)
    return U.fail("duplicate_items", "Items must all be different.", "分类项不能重复。");
  const empty = categories.findIndex((_, c) => !items.some((it) => it.cat === c));
  if (empty >= 0)
    return U.fail("empty_category", `Category ${empty + 1} has no items.`, `类别 ${empty + 1} 下没有分类项。`, { index: empty });
  return { fields: { categories, items, ...U.explanationFields(q) } };
}

const cleanItem = (o) => ({ ...U.cleanText(o), cat: o && U.isInt(o.cat) ? o.cat : -1 });

module.exports = {
  key: "classify", group: "objective",
  fromRow(r) {
    const d = U.parseJson(r.data, {});
    return {
      categories: (Array.isArray(d.categories) ? d.categories : []).map(U.cleanText),
      items: (Array.isArray(d.items) ? d.items : []).map(cleanItem),
      explanation: r.explanation, explanation_zh: r.explanation_zh,
    };
  },
  toRow(q) { return U.dataColumns(q, { categories: (q.categories || []).map(U.cleanText), items: (q.items || []).map(cleanItem) }); },
  validate,
  snapshot(q, ctx) {
    const items = (q.items || []).map(cleanItem);
    const order = U.noShuffle(ctx) ? U.range(items.length) : ctx.shuffle(U.range(items.length));
    const snap = {
      id: q.id, type: "classify", question: q.question, question_zh: q.question_zh || null,
      categories: (q.categories || []).map(U.cleanText),
      items: order.map((i) => ({ text: items[i].text, text_zh: items[i].text_zh })),
      key: order.map((i) => items[i].cat),
      partialCredit: U.flagOn(ctx.partialCredit),
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(s) {
    const c = {
      id: s.id, type: "classify", question: s.question, question_zh: s.question_zh,
      categories: s.categories.map((o) => ({ text: o.text, text_zh: o.text_zh })),
      items: s.items.map((o) => ({ text: o.text, text_zh: o.text_zh })),
    };
    if (s.points != null) c.points = s.points;
    return c;
  },
  parseAnswer(raw, s) { return U.intSlots(raw, s.items.length, s.categories.length); },
  grade(s, resp) {
    const n = s.items.length;
    const itemRight = s.key.map((k, i) => !!resp && resp[i] === k);
    const right = itemRight.filter(Boolean).length;
    const credit = !resp || !n ? 0 : right === n ? 1 : s.partialCredit !== false ? right / n : 0;
    const d = {
      id: s.id, type: "classify", question: s.question, question_zh: s.question_zh || null,
      categories: s.categories, items: s.items, key: s.key, response: resp || null, itemRight,
      ...U.creditFields(credit),
      explanation: s.explanation, explanation_zh: s.explanation_zh || null,
    };
    if (s.points != null) d.points = s.points;
    return d;
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const out = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, categories: d.categories, items: d.items, response: d.response, credit: d.credit, isRight: d.isRight, partial: d.partial };
    if (d.points != null) out.points = d.points;
    return out;
  },
  totals(d) { const pts = U.ptsOf(d); return { earned: pts * U.creditOf(d), max: pts }; },
  isUsable(q) { return Array.isArray(q.categories) && q.categories.length >= 2 && Array.isArray(q.items) && q.items.length >= 1; },
};
