"use strict";
// 多空填空题（4c，设计 §1.4 / §1.5）。题干（及中文题干，若有）必须恰好含 {{1}}…{{n}} 各一次；
// 每空 1–10 个可接受答案（每个不超过 100 字），比对口径与填空题相同（normFill）。
// 作答 = n 个字符串（每个不超过 200 字）；部分给分：答对的空 ÷ n；关闭时全对才得分。
const { LIMITS } = require("./spec.js");
const U = require("./util.js");

const L = LIMITS.cloze;

// 题干里的空格标记：返回出错原因（null = 恰好 {{1}}…{{n}} 各一次、没有别的标记）
function markerProblem(text, n) {
  const found = [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const count = new Map();
  for (const k of found) count.set(k, (count.get(k) || 0) + 1);
  for (let k = 1; k <= n; k++) {
    if (!count.has(k)) return { code: "marker_missing", k };
    if (count.get(k) > 1) return { code: "marker_repeated", k };
  }
  const extra = found.find((k) => k < 1 || k > n);
  if (extra !== undefined) return { code: "marker_extra", k: extra };
  return null;
}
const markerMsg = (p, lang) => {
  const en = lang === "zh" ? "Chinese stem" : "Stem";
  const zh = lang === "zh" ? "中文题干" : "题干";
  if (p.code === "marker_missing") return U.fail("bad_markers", `${en}: blank {{${p.k}}} is missing.`, `${zh}缺少空格 {{${p.k}}}。`, { marker: p.k, lang });
  if (p.code === "marker_repeated") return U.fail("bad_markers", `${en}: blank {{${p.k}}} appears more than once.`, `${zh}中空格 {{${p.k}}} 出现了不止一次。`, { marker: p.k, lang });
  return U.fail("bad_markers", `${en}: {{${p.k}}} has no matching blank answers.`, `${zh}中的 {{${p.k}}} 没有对应的答案。`, { marker: p.k, lang });
};

function validate(q) {
  const raw = q.blanks;
  if (!Array.isArray(raw) || raw.length < L.min || raw.length > L.max)
    return U.fail("bad_blanks", `Multi-blank fill needs ${L.min}–${L.max} blanks.`, `多空填空题需要 ${L.min}–${L.max} 个空。`);
  const blanks = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    const list = U.isPlainObject(b) && Array.isArray(b.answers) ? b.answers : Array.isArray(b) ? b : null;
    const answers = (list || []).map((a) => String(a ?? "").trim()).filter(Boolean);
    if (!answers.length)
      return U.fail("bad_answers", `Blank ${i + 1} needs at least one accepted answer.`, `第 ${i + 1} 空至少需要 1 个可接受答案。`, { blank: i + 1 });
    if (answers.length > L.answersMax)
      return U.fail("bad_answers", `Blank ${i + 1}: at most ${L.answersMax} accepted answers.`, `第 ${i + 1} 空最多 ${L.answersMax} 个可接受答案。`, { blank: i + 1 });
    if (answers.some((a) => a.length > LIMITS.blankAnswer))
      return U.fail("text_too_long", `Blank ${i + 1}: each answer at most ${LIMITS.blankAnswer} characters.`, `第 ${i + 1} 空：每个答案最多 ${LIMITS.blankAnswer} 字。`, { blank: i + 1 });
    blanks.push({ answers });
  }
  const p = markerProblem(q.question, blanks.length);
  if (p) return markerMsg(p, "en");
  if (q.question_zh != null && String(q.question_zh).trim()) {
    const pz = markerProblem(q.question_zh, blanks.length);
    if (pz) return markerMsg(pz, "zh");
  }
  return { fields: { blanks, ...U.explanationFields(q) } };
}

const cleanBlanks = (list) => (Array.isArray(list) ? list : []).map((b) => ({ answers: (b && Array.isArray(b.answers) ? b.answers : []).map((a) => String(a)) }));

module.exports = {
  key: "cloze", group: "objective",
  fromRow(r) {
    const d = U.parseJson(r.data, {});
    return { blanks: cleanBlanks(d.blanks), explanation: r.explanation, explanation_zh: r.explanation_zh };
  },
  toRow(q) { return U.dataColumns(q, { blanks: cleanBlanks(q.blanks) }); },
  validate,
  snapshot(q, ctx) {
    const snap = {
      id: q.id, type: "cloze", question: q.question, question_zh: q.question_zh || null,
      blanks: cleanBlanks(q.blanks), partialCredit: U.flagOn(ctx.partialCredit),
      explanation: q.explanation, explanation_zh: q.explanation_zh || null,
    };
    if (ctx.points != null) snap.points = ctx.points;
    return snap;
  },
  client(s) {
    const c = { id: s.id, type: "cloze", question: s.question, question_zh: s.question_zh, blanks: s.blanks.length };
    if (s.points != null) c.points = s.points;
    return c;
  },
  // n 个字符串（null / undefined 记为空串）；长度不符、非字符串、超过 200 字 → 整题按未作答；全部为空 → 未作答
  parseAnswer(raw, s) {
    const n = s.blanks.length;
    if (!Array.isArray(raw) || raw.length !== n) return null;
    const out = [];
    for (const v of raw) {
      if (v === null || v === undefined) { out.push(""); continue; }
      if (typeof v !== "string" || v.length > LIMITS.responseText) return null;
      out.push(v);
    }
    return out.some((v) => v.trim()) ? out : null;
  },
  grade(s, resp) {
    const n = s.blanks.length;
    const blankRight = s.blanks.map((b, i) => {
      const r = resp ? U.normFill(resp[i]) : "";
      return r !== "" && b.answers.some((a) => U.normFill(a) === r);
    });
    const right = blankRight.filter(Boolean).length;
    const credit = !resp || !n ? 0 : right === n ? 1 : s.partialCredit !== false ? right / n : 0;
    const d = {
      id: s.id, type: "cloze", question: s.question, question_zh: s.question_zh || null,
      blankCount: n, blanks: s.blanks, response: resp || null, blankRight,
      ...U.creditFields(credit),
      explanation: s.explanation, explanation_zh: s.explanation_zh || null,
    };
    if (s.points != null) d.points = s.points;
    return d;
  },
  learnerDetail(d, showAnswers) {
    if (showAnswers !== false) return d;
    const out = { id: d.id, type: d.type, question: d.question, question_zh: d.question_zh, blankCount: d.blankCount, response: d.response, blankRight: d.blankRight, credit: d.credit, isRight: d.isRight, partial: d.partial };
    if (d.points != null) out.points = d.points;
    return out;
  },
  totals(d) { const pts = U.ptsOf(d); return { earned: pts * U.creditOf(d), max: pts }; },
  isUsable(q) { return Array.isArray(q.blanks) && q.blanks.length >= 1 && q.blanks.every((b) => b.answers.length); },
  markerProblem,
};
