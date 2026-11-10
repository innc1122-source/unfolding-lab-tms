"use strict";
// 情境案例题组（4b，设计 §1.4 / §1.5）。一段案例材料（最多 4,000 字）+ 2–8 道小题；小题只能是已开放的客观题型（D3：
// 不含简答、不能嵌套案例）。小题编号 sid = s1…s8 由服务端按顺序分配。题目本身的分值不用：每道小题有自己的分值，
// 没设时取考试的该题型默认分值，旧口径（考试没设题型分值）每道小题 1 分；案例总分 = 各小题之和。
// 小题顺序固定；每道小题按自己的题型规则打乱选项。作答 = { [sid]: 该小题的作答 }。
const { TYPES, ENABLED, LIMITS } = require("./spec.js");
const U = require("./util.js");

const L = LIMITS.case;
// 小题题型的实现（直接引用各题型文件，避免与 index.js 循环引用）
const SUBS = {
  mcq: require("./mcq.js"), multi: require("./multi.js"), tf: require("./tf.js"), fill: require("./fill.js"),
  cloze: require("./cloze.js"), ordering: require("./ordering.js"), matching: require("./matching.js"), classify: require("./classify.js"),
};
const subTypeOk = (t) => typeof t === "string" && !!SUBS[t] && !!TYPES[t] && TYPES[t].caseItem && ENABLED.includes(t);
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function validate(q, ctx = {}) {
  const passage = String(q.passage ?? "").trim();
  const passageZh = q.passage_zh == null ? "" : String(q.passage_zh).trim();
  if (!passage) return U.fail("empty_passage", "Scenario case needs the case text.", "情境案例题组需要填写案例材料。");
  if (passage.length > LIMITS.passage || passageZh.length > LIMITS.passage)
    return U.fail("text_too_long", `Case text: at most ${LIMITS.passage} characters per language.`, `案例材料每种语言最多 ${LIMITS.passage} 字。`);
  const raw = q.items;
  if (!Array.isArray(raw) || raw.length < L.min || raw.length > L.max)
    return U.fail("bad_items", `Scenario case needs ${L.min}–${L.max} sub-questions.`, `情境案例题组需要 ${L.min}–${L.max} 道小题。`);
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const sub = U.isPlainObject(raw[i]) ? raw[i] : {};
    const no = i + 1;
    if (!subTypeOk(sub.type))
      return U.fail("bad_sub_type", `Sub-question ${no}: only objective question types can be used inside a case.`, `第 ${no} 小题：案例中只能使用客观题型。`, { sub: no });
    const question = String(sub.question ?? "").trim();
    if (!question) return U.fail("empty_question", `Sub-question ${no}: the question text is required.`, `第 ${no} 小题：题干不能为空。`, { sub: no });
    const v = SUBS[sub.type].validate({ ...sub, question }, { ...ctx, inCase: true });
    if (v.error) return { ...v, error: `Sub-question ${no}: ${v.error}`, error_zh: `第 ${no} 小题：${v.error_zh || v.error}`, sub: no };
    const zh = sub.question_zh == null ? "" : String(sub.question_zh).trim();
    items.push({ sid: "s" + no, type: sub.type, question, question_zh: zh || null, points: U.pointsOf(sub.points), ...v.fields });
  }
  return { fields: { passage, passage_zh: passageZh || null, items, ...U.explanationFields(q) } };
}

// 小题分值：小题自己的 points > 考试的该题型默认分值（ctx.pointsFor(sub) 或 ctx.typePoints[type]）> 1
function subPoints(sub, ctx) {
  if (sub.points != null && Number.isFinite(Number(sub.points))) return Number(sub.points);
  let p = null;
  if (typeof ctx.pointsFor === "function") p = ctx.pointsFor(sub);
  else if (ctx.typePoints && typeof ctx.typePoints === "object") p = ctx.typePoints[sub.type];
  return p != null && Number.isFinite(Number(p)) ? Number(p) : 1;
}

module.exports = {
  key: "case", group: "case",
  fromRow(r) {
    const d = U.parseJson(r.data, {});
    return {
      passage: String(d.passage ?? ""), passage_zh: d.passage_zh ? String(d.passage_zh) : null,
      items: (Array.isArray(d.items) ? d.items : []).filter(U.isPlainObject),
      explanation: r.explanation, explanation_zh: r.explanation_zh,
    };
  },
  toRow(q) { return U.dataColumns(q, { passage: String(q.passage ?? ""), passage_zh: q.passage_zh || null, items: (q.items || []).filter(U.isPlainObject) }); },
  validate,
  snapshot(q, ctx) {
    const items = (q.items || []).filter((sub) => subTypeOk(sub.type)).map((sub) => {
      const points = subPoints(sub, ctx);
      const s = SUBS[sub.type].snapshot({ ...sub, id: `${q.id}.${sub.sid}` }, { ...ctx, points });
      s.sid = sub.sid;
      return s;
    });
    return {
      id: q.id, type: "case", question: q.question, question_zh: q.question_zh || null,
      passage: q.passage, passage_zh: q.passage_zh || null, items,
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
      points: items.reduce((n, s) => n + (Number(s.points) || 0), 0),
    };
  },
  client(s) {
    return {
      id: s.id, type: "case", question: s.question, question_zh: s.question_zh,
      passage: s.passage, passage_zh: s.passage_zh,
      items: s.items.map((sub) => ({ ...SUBS[sub.type].client(sub), sid: sub.sid })),
      points: s.points,
    };
  },
  // 只认快照里的小题编号；每道小题按自己的规则检查；一题都没答 → 未作答
  parseAnswer(raw, s) {
    if (!U.isPlainObject(raw)) return null;
    const out = {};
    let any = false;
    for (const sub of s.items) {
      if (!has(raw, sub.sid)) continue;
      const v = SUBS[sub.type].parseAnswer(raw[sub.sid], sub);
      if (v === null || v === undefined) continue;
      out[sub.sid] = v; any = true;
    }
    return any ? out : null;
  },
  grade(s, resp) {
    const items = s.items.map((sub) => {
      const d = SUBS[sub.type].grade(sub, resp && has(resp, sub.sid) ? resp[sub.sid] : null);
      d.sid = sub.sid;
      d.credit = U.creditOf(d);
      return d;
    });
    const max = items.reduce((n, d) => n + U.ptsOf(d), 0);
    const earned = items.reduce((n, d) => n + U.ptsOf(d) * U.creditOf(d), 0);
    const credit = max ? earned / max : 0;
    return {
      id: s.id, type: "case", question: s.question, question_zh: s.question_zh || null,
      passage: s.passage, passage_zh: s.passage_zh || null, items, response: resp || null,
      ...U.creditFields(credit),
      explanation: s.explanation, explanation_zh: s.explanation_zh || null,
      points: s.points,
    };
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const out = {
      id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, passage: d.passage, passage_zh: d.passage_zh,
      items: (d.items || []).map((sub) => {
        const def = SUBS[sub.type];
        const x = def ? def.learnerDetail(sub, false) : { id: sub.id, type: sub.type };
        x.sid = sub.sid;
        if (sub.points != null) x.points = sub.points;
        x.credit = U.creditOf(sub);
        return x;
      }),
      response: d.response, credit: d.credit, isRight: d.isRight, partial: d.partial,
    };
    if (d.points != null) out.points = d.points;
    return out;
  },
  totals(d) {
    if (!Array.isArray(d.items)) { const pts = U.ptsOf(d); return { earned: pts * U.creditOf(d), max: pts }; }
    return {
      earned: d.items.reduce((n, x) => n + U.ptsOf(x) * U.creditOf(x), 0),
      max: d.items.reduce((n, x) => n + U.ptsOf(x), 0),
    };
  },
  isUsable(q) {
    const subs = (q.items || []).filter((sub) => subTypeOk(sub.type));
    return !!String(q.passage || "").trim() && subs.length >= 1 && subs.every((sub) => !SUBS[sub.type].isUsable || SUBS[sub.type].isUsable(sub));
  },
  itemCount(q) { return (q.items || []).filter((sub) => subTypeOk(sub.type)).length; },
  SUBS,
};
