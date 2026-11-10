// 第四批 6.1（2026-10-08，G3）：web/src/qtypes/model.js 的纯函数（vm 跑，与 spec.js 拼在同一上下文）。
//   · toDraft → toBody 往返：每种题型的请求体能通过服务端注册表的 itemFromBody（G2）校验，题型数据原样保留；
//   · validateDraft 的错误码（与服务端同样的限制）；isAnswered（排序题没动过 = 未作答）；答题卡 slotsOf；
//   · earnedOf / maxOf / stateOf（旧口径含 points、新题型 points × credit、案例按小题合计）；
//   · translatePairs 覆盖编辑稿里每一个双语字段；AI 草稿转换；多空填空的标记工具；
//   · 考前说明页 ExamPrep 的题目数（itemCount）与案例行。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadEsm(rels) {
  const names = [];
  let code = "";
  for (const rel of rels) {
    let src = fs.readFileSync(path.join(WEB, rel), "utf8");
    names.push(...[...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]));
    src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "").replace(/^export\s+/gm, "");
    code += src + "\n";
  }
  const ctx = vm.createContext({ Math, Number, String, Array, Object, Set, Map, JSON });
  vm.runInContext(code + "\n;globalThis.__x = {" + names.join(",") + "};", ctx);
  return ctx.__x;
}
const M = loadEsm(["qtypes/spec.js", "qtypes/model.js"]);
const REG_PATH = path.join(ROOT, "modules", "learning", "qtypes", "index.js");
const REG = fs.existsSync(REG_PATH) ? require(REG_PATH) : null;

const bt = (text, text_zh = null) => ({ text, text_zh });
// 题库里的一题（/api/admin/questions 的形状 = 服务端 rowToQuestion）
const BANK = {
  mcq: { id: "q1", courseId: "c1", moduleId: "m1", type: "mcq", question: "Which is laundering?", question_zh: "哪项属于洗钱？", options: [{ ...bt("Layering", "分层"), ok: true }, { ...bt("Saving", "储蓄"), ok: false }, { ...bt("Paying tax"), ok: false }], explanation: "Layering hides the source.", explanation_zh: "分层用于掩盖来源。", points: 2 },
  multi: { id: "q2", courseId: "c1", type: "multi", question: "Pick red flags", question_zh: null, options: [{ ...bt("Cash"), ok: true }, { ...bt("Structuring"), ok: true }, { ...bt("Payroll"), ok: false }], explanation: "", explanation_zh: null, points: null },
  tf: { id: "q3", courseId: "c1", type: "tf", question: "KYC is optional.", question_zh: "KYC 可以不做。", answer: false, explanation: "It is required.", explanation_zh: null, points: null },
  fill: { id: "q4", courseId: "c1", type: "fill", question: "CDD stands for ___", question_zh: "CDD 的全称是 ___", answers: ["customer due diligence", "客户尽职调查"], explanation: "", explanation_zh: null, points: null },
  cloze: { id: "q5", courseId: "c1", type: "cloze", question: "Report to {{1}} within {{2}} days.", question_zh: "在 {{2}} 天内向 {{1}} 报告。", blanks: [{ answers: ["AMLC", "the AMLC"] }, { answers: ["5", "five"] }], explanation: "", explanation_zh: null, points: 3 },
  open: { id: "q6", courseId: "c1", type: "open", question: "Explain CDD.", question_zh: "说明 CDD。", rubric: "Mentions ID checks", rubric_zh: "提到身份核验", maxPoints: 10, points: null },
  ordering: { id: "q7", courseId: "c1", type: "ordering", question: "Order the steps", question_zh: "排列步骤", items: [bt("Identify", "识别"), bt("Verify", "核验"), bt("Report", "报告")], explanation: "ID first.", explanation_zh: null, points: null },
  matching: { id: "q8", courseId: "c1", type: "matching", question: "Match terms", question_zh: null, pairs: [{ left: bt("KYC"), right: bt("Know your customer") }, { left: bt("STR"), right: bt("Suspicious transaction report") }], distractors: [bt("Cash ledger")], explanation: "", explanation_zh: null, points: null },
  classify: { id: "q9", courseId: "c1", type: "classify", question: "Classify", question_zh: "分类", categories: [bt("Low risk", "低风险"), bt("High risk", "高风险")], items: [{ ...bt("Payroll"), cat: 0 }, { ...bt("Shell company"), cat: 1 }, { ...bt("Cash couriers"), cat: 1 }], explanation: "", explanation_zh: null, points: null },
  case: {
    id: "q10", courseId: "c1", type: "case", question: "Branch case", question_zh: "分行案例", passage: "A customer deposits cash daily just under the threshold.", passage_zh: "一位客户每天存入略低于申报线的现金。",
    items: [
      { sid: "s1", type: "mcq", question: "What is this?", question_zh: "这是什么？", points: 2, explanation: "", explanation_zh: null, options: [{ ...bt("Structuring"), ok: true }, { ...bt("Saving"), ok: false }] },
      { sid: "s2", type: "ordering", question: "Order the response", question_zh: null, points: null, explanation: "", explanation_zh: null, items: [bt("Flag"), bt("Review"), bt("File STR")] },
    ],
    explanation: "", explanation_zh: null, points: null,
  },
};
// 题型专属字段（往返比较用）
const FIELDS = {
  mcq: ["options"], multi: ["options"], tf: ["answer"], fill: ["answers"], cloze: ["blanks"], open: ["rubric", "rubric_zh", "maxPoints"],
  ordering: ["items"], matching: ["pairs", "distractors"], classify: ["categories", "items"], case: ["passage", "passage_zh", "items"],
};

test("model: toDraft → validateDraft → toBody round-trip for all ten types; the body passes the server registry", () => {
  for (const [type, q] of Object.entries(BANK)) {
    const draft = M.toDraft(q);
    assert.equal(draft.type, type);
    assert.deepEqual(plain(M.validateDraft(draft)), [], type + ": a valid bank question has no draft errors");
    const body = plain(M.toBody(draft));
    assert.equal(body.type, type);
    assert.equal(body.courseId, "c1");
    assert.equal(body.question, q.question, type + " stem");
    assert.equal(body.question_zh, q.question_zh || null, type + " zh stem");
    for (const f of FIELDS[type]) {
      const want = type === "case" && f === "items" ? q.items.map(({ sid, ...rest }) => rest) : q[f]; // eslint-disable-line no-unused-vars
      assert.deepEqual(body[f], plain(want), `${type}.${f} survives the round-trip`);
    }
    if (type !== "open") {
      assert.equal(body.explanation, q.explanation || "", type + " explanation");
      assert.equal(body.explanation_zh, q.explanation_zh || null);
    }
    assert.equal(body.points, type === "case" ? null : q.points, type + " points");
    if (REG && typeof REG.itemFromBody === "function") {
      const r = REG.itemFromBody(body);
      assert.ok(!r.error, `${type}: server validate accepts the body (${r.error || ""})`);
      for (const f of FIELDS[type]) {
        if (type === "case" && f === "items") assert.deepEqual(r.item.items.map((s) => s.type), q.items.map((s) => s.type));
        else assert.deepEqual(r.item[f], body[f], `${type}.${f} as stored`);
      }
    }
  }
});

test("model: old four types build the same request body as the Questions.jsx editor did", () => {
  const body = plain(M.toBody(M.toDraft(BANK.mcq)));
  assert.deepEqual(body, {
    courseId: "c1", type: "mcq", question: "Which is laundering?", question_zh: "哪项属于洗钱？", points: 2,
    explanation: "Layering hides the source.", explanation_zh: "分层用于掩盖来源。",
    options: [{ text: "Layering", text_zh: "分层", ok: true }, { text: "Saving", text_zh: "储蓄", ok: false }, { text: "Paying tax", text_zh: null, ok: false }],
  });
  // 中文单语：英文栏空时 text 回落中文（与原 buildBody 一样）
  const d = M.emptyDraft("mcq", { courseId: "c1" });
  d.stem = { zh: "问", en: "" };
  d.options = [{ zh: "甲", en: "", ok: false }, { zh: "", en: "", ok: false }, { zh: "乙", en: "", ok: true }];
  const b = plain(M.toBody(d));
  assert.equal(b.question, "问");
  assert.equal(b.question_zh, "问");
  assert.deepEqual(b.options, [{ text: "甲", text_zh: "甲", ok: false }, { text: "乙", text_zh: "乙", ok: true }], "empty rows dropped, the correct flag travels with its option");
  // 填空：去重、去空白
  const f = M.emptyDraft("fill", { courseId: "c1" });
  f.stem = { zh: "空", en: "" }; f.answers = [" a ", "a", "", "b"];
  assert.deepEqual(plain(M.toBody(f)).answers, ["a", "b"]);
  // 简答：rubric 英文缺省回落中文，maxPoints 默认 10，没有 explanation
  const o = M.emptyDraft("open", { courseId: "c1" });
  o.stem = { zh: "说明", en: "" }; o.rubric = { zh: "要点", en: "" };
  const ob = plain(M.toBody(o));
  assert.equal(ob.rubric, "要点"); assert.equal(ob.rubric_zh, "要点"); assert.equal(ob.maxPoints, 10);
  assert.ok(!("explanation" in ob));
  // 案例没填标题时，题干用案例材料的第一行（服务端题干必填）
  const c = M.toDraft(BANK.case); c.stem = { zh: "", en: "" };
  const cb = plain(M.toBody(c));
  assert.equal(cb.question, BANK.case.passage);
  assert.equal(cb.question_zh, BANK.case.passage_zh);
  if (REG) assert.ok(!REG.itemFromBody(cb).error);
});

test("model: validateDraft codes mirror the server limits", () => {
  const codes = (d) => plain(M.validateDraft(d)).map((e) => `${e.field}:${e.code}`);
  const base = (type) => M.toDraft(BANK[type]);
  let d = base("mcq"); d.options = d.options.map((o) => ({ ...o, ok: false }));
  assert.deepEqual(codes(d), ["options:mcq_one_correct"]);
  d = base("multi"); d.options = d.options.map((o) => ({ ...o, ok: false }));
  assert.deepEqual(codes(d), ["options:multi_correct"]);
  d = base("mcq"); d.options = [d.options[0]];
  assert.deepEqual(codes(d), ["options:options_min"]);
  d = base("fill"); d.answers = ["  "];
  assert.deepEqual(codes(d), ["answers:fill_answers"]);
  d = base("tf"); d.answer = null;
  assert.deepEqual(codes(d), ["answer:tf_answer"]);
  d = base("cloze"); d.stem = { ...d.stem, en: "Report to {{1}} soon." };
  assert.deepEqual(codes(d), ["stem.en:cloze_markers"], "en stem lost {{2}}");
  d = base("cloze"); d.stem = { ...d.stem, zh: "{{1}} {{1}} {{2}}" };
  assert.deepEqual(codes(d), ["stem.zh:cloze_markers"], "a repeated marker");
  d = base("cloze"); d.blanks = [d.blanks[0], { answers: [] }];
  assert.deepEqual(codes(d), ["blanks.1:cloze_answers"]);
  d = base("ordering"); d.items = d.items.slice(0, 2);
  assert.deepEqual(codes(d), ["items:items_count"]);
  d = base("ordering"); d.items = [...d.items, { zh: "", en: "identify" }];
  assert.deepEqual(codes(d), ["items.3:duplicate"], "steps must differ (case-insensitive)");
  d = base("ordering"); d.items = [...d.items, { zh: "", en: "x".repeat(301) }];
  assert.deepEqual(codes(d), ["items.3:too_long"]);
  d = base("matching"); d.distractors = [{ zh: "", en: "know your customer" }];
  assert.deepEqual(codes(d), ["distractors.0:right_duplicate"], "a distractor may not repeat a right-hand item");
  d = base("matching"); d.distractors = [1, 2, 3, 4].map((n) => ({ zh: "", en: "D" + n }));
  assert.deepEqual(codes(d), ["distractors:distractors_max"]);
  d = base("matching"); d.pairs = [{ left: { zh: "", en: "KYC" }, right: { zh: "", en: "" } }, d.pairs[1]];
  assert.deepEqual(codes(d), ["pairs.0.right:required"]);
  d = base("classify"); d.items = d.items.map((it) => ({ ...it, cat: 1 }));
  assert.deepEqual(codes(d), ["categories.0:category_empty"]);
  d = base("classify"); d.items = [...d.items, { zh: "", en: "Trust", cat: -1 }];
  assert.deepEqual(codes(d), ["items.3:cat_required"]);
  d = base("case"); d.subs = [d.subs[0]];
  assert.deepEqual(codes(d), ["subs:subs_count"]);
  d = base("case"); d.subs = [d.subs[0], { ...M.emptySub("open"), stem: { zh: "x", en: "" } }];
  assert.deepEqual(codes(d), ["subs.1.type:case_sub_type"], "no short answer inside a case (D3)");
  d = base("case"); d.subs = [d.subs[0], { ...d.subs[0], options: d.subs[0].options.map((o) => ({ ...o, ok: false })) }];
  assert.deepEqual(codes(d), ["subs.1.options:mcq_one_correct"], "sub-question errors carry the subs.i. prefix");
  d = base("case"); d.passage = { zh: "", en: "" };
  assert.deepEqual(codes(d), ["passage:required"]);
  d = base("mcq"); d.points = 0.5;
  assert.deepEqual(codes(d), ["points:points_range"]);
  d = base("mcq"); d.points = 101;
  assert.deepEqual(codes(d), ["points:points_range"]);
  d = base("mcq"); d.courseId = null;
  assert.deepEqual(codes(d), ["courseId:required"]);
  d = base("mcq"); d.stem = { zh: " ", en: "" };
  assert.deepEqual(codes(d), ["stem:required"]);
  assert.deepEqual(codes({ ...base("mcq"), type: "hotspot" }), ["type:bad_type"]);
  // errorsAt 命中下级字段
  assert.equal(M.errorsAt([{ field: "pairs.1.left", code: "required" }], "pairs.1").length, 1);
  assert.equal(M.errorsAt([{ field: "pairs.10.left", code: "required" }], "pairs.1").length, 0);
});

test("model: changeType keeps stem / explanation / course and resets type fields; hasTypeContent", () => {
  const d = M.toDraft(BANK.mcq);
  assert.equal(M.hasTypeContent(d), true);
  const o = M.changeType(d, "ordering");
  assert.deepEqual(plain(o.stem), plain(d.stem));
  assert.deepEqual(plain(o.explanation), plain(d.explanation));
  assert.equal(o.courseId, "c1"); assert.equal(o.id, "q1"); assert.equal(o.points, 2);
  assert.equal(o.items.length, 3);
  assert.ok(!("options" in o));
  assert.equal(M.hasTypeContent(o), false);
  assert.equal(M.changeType(d, "case").points, null, "a case has no question-level points");
  for (const t of M.TYPE_ORDER) assert.equal(M.emptyDraft(t).type, t);
});

test("model: isAnswered — an untouched ordering list is unanswered; partial matching / classify / cloze are unanswered", () => {
  const ord = { type: "ordering", items: [{}, {}, {}] };
  assert.equal(M.isAnswered(ord, undefined), false, "untouched shuffled list");
  assert.equal(M.isAnswered(ord, [0, 1, 2]), true, "confirmed order");
  assert.equal(M.isAnswered({ type: "mcq" }, 0), true, "option 0 is a valid answer");
  assert.equal(M.isAnswered({ type: "mcq" }, null), false);
  assert.equal(M.isAnswered({ type: "multi" }, []), false);
  assert.equal(M.isAnswered({ type: "tf" }, false), true);
  assert.equal(M.isAnswered({ type: "fill" }, "  "), false);
  const mt = { type: "matching", lefts: [{}, {}], rights: [{}, {}, {}] };
  assert.equal(M.isAnswered(mt, [2, null]), false);
  assert.equal(M.isAnswered(mt, [2, 2]), true, "a right item may be reused");
  assert.equal(M.isAnswered({ type: "classify", items: [{}, {}], categories: [{}, {}] }, [0, 1]), true);
  assert.equal(M.isAnswered({ type: "cloze", blanks: 2 }, ["a", ""]), false);
  assert.equal(M.isAnswered({ type: "cloze", blanks: 2 }, ["a", "b"]), true);
  const cs = { type: "case", items: [{ sid: "s1", type: "mcq" }, { sid: "s2", type: "tf" }] };
  assert.equal(M.isAnswered(cs, { s1: 1 }), false);
  assert.equal(M.isAnswered(cs, { s1: 1, s2: true }), true);
});

test("model: slotsOf numbers case sub-questions 3.1–3.4 and slotAnswered reads answers[caseId][sid]", () => {
  const qs = [
    { id: "a", type: "mcq" },
    { id: "b", type: "case", items: [{ sid: "s1", type: "mcq" }, { sid: "s2", type: "fill" }] },
    { id: "c", type: "open" },
  ];
  const slots = M.slotsOf(qs);
  assert.deepEqual(plain(slots.map((s) => s.label)), ["1", "2.1", "2.2", "3"]);
  assert.deepEqual(plain(slots.map((s) => s.key)), ["a", "b:s1", "b:s2", "c"]);
  assert.equal(slots[1].caseNo, 2);
  const answers = { a: 0, b: { s2: "x" } };
  assert.deepEqual(plain(slots.map((s) => M.slotAnswered(s, answers))), [true, false, true, false]);
  assert.deepEqual(plain(M.moveItem(["a", "b", "c", "d"], 3, 0)), ["d", "a", "b", "c"]);
  assert.deepEqual(plain(M.moveItem(["a", "b"], 0, 5)), ["a", "b"], "out of range is a no-op");
});

test("model: earnedOf / maxOf / stateOf — legacy rule incl. points, credit rule for new types, case sums its sub-questions", () => {
  assert.equal(M.earnedOf({ type: "mcq", isRight: true }), 1, "legacy attempt without points: 1 per objective question");
  assert.equal(M.earnedOf({ type: "multi", partial: true, points: 3 }), 1.5, "multi partial = half of its points");
  assert.equal(M.earnedOf({ type: "multi", partial: true }), 0.5);
  assert.equal(M.earnedOf({ type: "open", score: 7, maxPoints: 10, points: 5 }), 3.5);
  assert.equal(M.earnedOf({ type: "open", score: 5, maxPoints: 10 }), 0.5, "legacy open: maxPoints/10 scale");
  assert.equal(M.maxOf({ type: "open", maxPoints: 10 }), 1);
  assert.equal(M.earnedOf({ type: "open", score: null, maxPoints: 10, points: 5 }), 0);
  assert.equal(M.earnedOf({ type: "ordering", credit: 2 / 3, points: 1 }), 0.7, "「得分 0.7 / 1」");
  assert.equal(M.earnedOf({ type: "matching", credit: 0.5 }), 0.5, "no points → 1 point");
  const cs = { type: "case", points: 5, credit: 0.6, items: [{ type: "mcq", isRight: true, points: 2, credit: 1 }, { type: "ordering", credit: 1 / 3, points: 3 }] };
  assert.equal(M.earnedOf(cs), 3);
  assert.equal(M.maxOf(cs), 5);
  assert.equal(M.stateOf(cs), "partial");
  assert.equal(M.stateOf({ type: "ordering", credit: 1, isRight: true }), "ok");
  assert.equal(M.stateOf({ type: "cloze", credit: 0.5, partial: true }), "partial");
  assert.equal(M.stateOf({ type: "tf", credit: 0, isRight: false }), "bad");
  assert.equal(M.stateOf({ type: "open", score: null }), "pending");
  assert.equal(M.stateOf({ type: "open", score: 10, maxPoints: 10 }), "ok");
  // 排序题回顾：正确 ABCD、作答 BCDA → BC、CD 相邻正确
  assert.deepEqual(plain(M.orderingPairs([1, 2, 3, 0], [0, 1, 2, 3])), [true, true, false]);
  assert.deepEqual(plain(M.orderingPairs([3, 2, 1, 0], [0, 1, 2, 3])), [false, false, false], "reversed = 0");
});

test("model: earnedOf agrees with the server totals() for every new type", (t) => {
  if (!REG || typeof REG.get !== "function") { t.diagnostic("server registry missing — skipped"); return; }
  const ds = [
    { type: "ordering", credit: 2 / 3, isRight: false, partial: true, points: 3 },
    { type: "matching", credit: 0.5, isRight: false, partial: true },
    { type: "classify", credit: 1, isRight: true, partial: false, points: 2 },
    { type: "cloze", credit: 0, isRight: false, partial: false, points: 4 },
    { type: "tf", credit: 1, isRight: true, partial: false },
    { type: "case", credit: 0.6, items: [{ type: "mcq", isRight: true, points: 2, credit: 1 }, { type: "ordering", credit: 1 / 3, points: 3 }], points: 5 },
  ];
  for (const d of ds) {
    const tot = REG.get(d.type).totals(d);
    assert.equal(M.earnedOf(d), Math.round(tot.earned * 10) / 10, d.type + " earned");
    assert.equal(M.maxOf(d), tot.max, d.type + " max");
  }
});

test("model: translatePairs lists every bilingual field of a draft, and applyTranslations writes them back", () => {
  // 编辑稿里所有 { zh, en } 对象的路径
  const biPaths = (o, p = "", out = []) => {
    if (Array.isArray(o)) o.forEach((x, i) => biPaths(x, p ? `${p}.${i}` : String(i), out));
    else if (o && typeof o === "object") {
      if ("zh" in o && "en" in o) { out.push(p); return out; }
      for (const [k, v] of Object.entries(o)) biPaths(v, p ? `${p}.${k}` : k, out);
    }
    return out;
  };
  for (const q of Object.values(BANK)) {
    const d = M.toDraft(q);
    const keys = plain(M.translatePairs(d)).map((x) => x.key);
    const expected = biPaths(plain(d)).filter((k) => !(q.type === "open" && k === "explanation") && !(q.type === "case" && k === "explanation"));
    assert.deepEqual(keys.slice().sort(), expected.slice().sort(), q.type + ": every bilingual field is translatable");
  }
  const d = M.toDraft(BANK.matching);
  const next = M.applyTranslations(d, new Map([["pairs.1.right", "可疑交易报告"], ["stem", "匹配术语"]]), "zh");
  assert.equal(next.pairs[1].right.zh, "可疑交易报告");
  assert.equal(next.stem.zh, "匹配术语");
  assert.equal(d.stem.zh, "", "the original draft is untouched");
  const s = M.setAt(d, "pairs.0.left.zh", "了解你的客户");
  assert.equal(s.pairs[0].left.zh, "了解你的客户");
  assert.equal(d.pairs[0].left.zh, "");
  assert.ok(Array.isArray(s.pairs));
});

test("model: AI drafts convert to valid drafts (truefalse → tf, matching distractors, classify categories, cases)", () => {
  const ai = [
    { type: "single", question: "Q1", question_zh: "问1", options: [{ text: "A", text_zh: "甲", correct: false }, { text: "B", text_zh: "乙", correct: true }], explanation: "e", explanation_zh: null },
    { type: "truefalse", question: "Q2", question_zh: null, options: [{ text: "True", text_zh: "正确", correct: false }, { text: "False", text_zh: "错误", correct: true }] },
    { type: "ordering", question: "Q3", items: [{ text: "a", text_zh: null, category: -1 }, { text: "b", text_zh: null, category: -1 }, { text: "c", text_zh: null, category: -1 }] },
    { type: "matching", question: "Q4", pairs: [{ left: "L1", left_zh: "", right: "R1", right_zh: "" }, { left: "L2", left_zh: "", right: "R2", right_zh: "" }, { left: "", left_zh: "", right: "R3", right_zh: "" }] },
    { type: "classify", question: "Q5", categories: [{ text: "A", text_zh: null }, { text: "B", text_zh: null }], items: [{ text: "x", text_zh: null, category: 0 }, { text: "y", text_zh: null, category: 1 }] },
    { type: "cloze", question: "Fill {{1}}", question_zh: null, blanks: [{ answers: ["x"] }] },
    { type: "open", question: "Q7", rubric: "r", rubric_zh: null, maxPoints: 10 },
  ];
  const drafts = ai.map((x) => M.fromAiDraft(x, { courseId: "c1" }));
  assert.deepEqual(drafts.map((d) => d.type), ["mcq", "tf", "ordering", "matching", "classify", "cloze", "open"]);
  assert.equal(drafts[1].answer, false);
  assert.equal(drafts[3].pairs.length, 2);
  assert.deepEqual(plain(drafts[3].distractors), [{ zh: "", en: "R3" }], "a pair without a left item is a distractor");
  for (const d of drafts) {
    assert.deepEqual(plain(M.validateDraft(d)), [], d.type + " draft valid");
    if (REG) assert.ok(!REG.itemFromBody(plain(M.toBody(d))).error, d.type + " accepted by the server");
  }
  const cs = M.fromAiCase({ passage: "Scenario", passage_zh: "情境", questions: [ai[0], ai[2]] }, { courseId: "c1" });
  assert.equal(cs.type, "case");
  assert.deepEqual(cs.subs.map((s) => s.type), ["mcq", "ordering"]);
  assert.ok(!("courseId" in cs.subs[0]));
  assert.deepEqual(plain(M.validateDraft(cs)), []);
  if (REG) assert.ok(!REG.itemFromBody(plain(M.toBody(cs))).error);
});

test("model: cloze marker helpers", () => {
  assert.deepEqual(plain(M.clozeParts("A {{1}} b {{2}}.")), [{ t: "text", s: "A " }, { t: "blank", n: 1 }, { t: "text", s: " b " }, { t: "blank", n: 2 }, { t: "text", s: "." }]);
  assert.equal(M.markersOk("{{2}} x {{1}}", 2), true);
  assert.equal(M.markersOk("{{1}} {{1}}", 1), false);
  assert.equal(M.markersOk("{{1}} {{3}}", 2), false);
  assert.deepEqual(plain(M.insertMarker("ab", 1, 3)), { text: "a{{3}}b", n: 3 });
  assert.deepEqual(plain(M.insertMarker("ab", null, 1)), { text: "ab{{1}}", n: 1 }, "no caret → at the end");
});

test("ExamPrep: question count uses itemCount, case lines keep their sub-question total", () => {
  const src = fs.readFileSync(path.join(WEB, "pages", "ExamPrep.jsx"), "utf8");
  const from = src.indexOf("export const totalOf");
  const to = src.indexOf("export default function ExamPrep");
  const H = vm.runInNewContext(src.slice(from, to).replace(/^export /gm, "") + "\n;({ typeLinesOf, questionCountOf, PROPORTIONAL_TYPES })", { Math, Number, String, Array, Object });
  assert.equal(H.questionCountOf({ itemCount: 12, mcqCount: 9, openCount: 1 }), 12);
  assert.equal(H.questionCountOf({ mcqCount: 9, openCount: 1 }), 10, "older payload");
  const lines = plain(H.typeLinesOf({ typeSummary: [{ type: "mcq", count: 5, points: 1 }, { type: "case", count: 2, items: 8, points: 4 }, { type: "ordering", count: 0, points: 1 }] }));
  assert.deepEqual(lines, [{ type: "mcq", count: 5, points: 1 }, { type: "case", count: 2, points: 4, items: 8 }]);
  assert.deepEqual(plain(H.PROPORTIONAL_TYPES), ["ordering", "matching", "classify", "cloze"]);
});
