// 第四批 6.1：AI 出题 questionGen@3（设计 §1.9）。结构在 schema.js 公共子集内；只请求原有五种题型时沿用原结构；
// 本地语义校验按新题型与案例计数、结构上限与题库校验一致；演示输出按 AI_TYPE_MAP 换成题库题型后能通过题库校验；
// 计数归一与总量（每组案例按 3 题计）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const prompts = require("../modules/ai/prompts.js");
const features = require("../modules/ai/features.js");
const { lintSchema, validate } = require("../modules/ai/schema.js");
const REG = require("../modules/learning/qtypes/index.js");

// AI 题型名 → 题库请求体（与 web/src/qtypes/spec.js AI_TYPE_MAP + model.js 的换算同一口径）
const AI_TYPE_MAP = { single: "mcq", multi: "multi", truefalse: "tf", fill: "fill", open: "open", ordering: "ordering", matching: "matching", classify: "classify", cloze: "cloze" };
function aiToBody(d) {
  const type = AI_TYPE_MAP[d.type];
  const b = { courseId: "c-1", type, question: d.question, question_zh: d.question_zh, explanation: d.explanation, explanation_zh: d.explanation_zh };
  const tx = (text, text_zh) => ({ text, text_zh });
  if (type === "mcq" || type === "multi") b.options = d.options.map((o) => ({ ...tx(o.text, o.text_zh), ok: o.correct }));
  if (type === "tf") b.answer = !!(d.options.find((o) => /^true$/i.test(o.text) || o.text_zh === "正确") || {}).correct;
  if (type === "fill") b.answers = d.answers;
  if (type === "open") { b.rubric = d.rubric; b.rubric_zh = d.rubric_zh; b.maxPoints = d.maxPoints; }
  if (type === "ordering") b.items = d.items.map((it) => tx(it.text, it.text_zh));
  if (type === "matching") {
    b.pairs = d.pairs.filter((p) => p.left || p.left_zh).map((p) => ({ left: tx(p.left, p.left_zh), right: tx(p.right, p.right_zh) }));
    b.distractors = d.pairs.filter((p) => !p.left && !p.left_zh).map((p) => tx(p.right, p.right_zh));
  }
  if (type === "classify") { b.categories = d.categories.map((c) => tx(c.text, c.text_zh)); b.items = d.items.map((it) => ({ ...tx(it.text, it.text_zh), cat: it.category })); }
  if (type === "cloze") b.blanks = d.blanks.map((x) => ({ answers: x.answers }));
  return b;
}
const caseToBody = (k) => ({ courseId: "c-1", type: "case", question: "Read the case and answer the questions.", passage: k.passage, passage_zh: k.passage_zh, items: k.questions.map(aiToBody) });

const MATERIAL = "Escalate every payment dispute to the finance desk within one business day. Record the case number in the log before you close the call. Large cash deposits split into several smaller ones are a red flag for structuring. ".repeat(2);
const ALL = { single: 1, multi: 1, truefalse: 1, fill: 1, open: 1, ordering: 1, matching: 1, classify: 1, cloze: 1, case: 2 };

test("version bump, schema lint, AI type names, and limits identical to the question bank's", () => {
  assert.equal(prompts.VERSIONS.questionGen, "questionGen@3");
  assert.deepEqual(lintSchema(prompts.QUESTION_GEN_SCHEMA), []);
  assert.deepEqual(lintSchema(prompts.QUESTION_GEN_SCHEMA_V2), []);
  assert.deepEqual(prompts.Q_TYPES, ["single", "multi", "truefalse", "fill", "open", "ordering", "matching", "classify", "cloze"]);
  assert.ok(!prompts.CASE_SUB_TYPES.includes("open"));
  for (const k of Object.keys(prompts.QGEN_LIMITS)) assert.deepEqual(prompts.QGEN_LIMITS[k], REG.LIMITS[k], `limit ${k}`);
  // 每个 AI 题型都映射到一个已开放的题库题型
  for (const t of prompts.Q_TYPES) assert.ok(REG.isEnabled(AI_TYPE_MAP[t]), t);
});

test("schema choice: only the original five types → the questionGen@2 shape (old replies still pass); new types or cases → the full shape", () => {
  assert.equal(prompts.questionGenSchema({ single: 2, open: 1 }), prompts.QUESTION_GEN_SCHEMA_V2);
  assert.equal(prompts.questionGenSchema({ single: 1, ordering: 1 }), prompts.QUESTION_GEN_SCHEMA);
  assert.equal(prompts.questionGenSchema({ case: 1 }), prompts.QUESTION_GEN_SCHEMA);
  const oldReply = { questions: [{ type: "single", question: "Q?", question_zh: "题？", options: [1, 2, 3, 4].map((i) => ({ text: "o" + i, text_zh: "项" + i, correct: i === 1 })), answers: [], explanation: "", explanation_zh: "", rubric: "", rubric_zh: "", maxPoints: 0, sourceQuote: "s", difficulty: "easy" }] };
  assert.equal(validate(prompts.QUESTION_GEN_SCHEMA_V2, oldReply), null);
  assert.equal(prompts.questionGenSemantic(features.normCounts({ single: 1 }))(oldReply), null);
  const builtOld = features.buildQuestionGen({ material: MATERIAL, counts: features.normCounts({ single: 1, open: 1 }), roster: [] });
  assert.equal(builtOld.schema, prompts.QUESTION_GEN_SCHEMA_V2);
  assert.ok(!/ordering|Scenario cases/.test(builtOld.system), "the original prompt text is unchanged for the original types");
  assert.match(builtOld.messages[0].content, /Create exactly these questions: 1 single, 1 open\./);
  const builtNew = features.buildQuestionGen({ material: MATERIAL, counts: features.normCounts({ ordering: 2, case: 2 }), roster: [] });
  assert.equal(builtNew.schema, prompts.QUESTION_GEN_SCHEMA);
  assert.match(builtNew.system, /ordering: 4–6 steps/);
  assert.match(builtNew.system, /80–200 words/);
  assert.match(builtNew.messages[0].content, /Create exactly these questions: 2 ordering, 2 scenario cases/);
  // 原结构的回复补成完整形状
  const p = features.processQuestionGen(oldReply);
  assert.deepEqual(p.cases, []);
  assert.deepEqual([p.questions[0].items, p.questions[0].pairs, p.questions[0].categories, p.questions[0].blanks], [[], [], [], []]);
});

test("counts: 0–10 per key including case; the total weighs each case as 3 questions", () => {
  const c = features.normCounts({ single: 3.7, ordering: 99, cloze: -2, case: "2", bogus: 5 });
  assert.deepEqual(c, { single: 3, multi: 0, truefalse: 0, fill: 0, open: 0, ordering: 10, matching: 0, classify: 0, cloze: 0, case: 2 });
  assert.equal(features.countTotal(c), 19);
  assert.equal(features.countTotal(features.normCounts(ALL)), 9 + 6);
});

test("demo output: one valid example per requested type and case; passes the schema, the semantic check and, after AI_TYPE_MAP, the bank validation", () => {
  const counts = features.normCounts(ALL);
  const questions = features.questionGenDemo(MATERIAL, counts);
  const cases = features.questionGenDemoCases(MATERIAL, counts);
  assert.deepEqual(questions.map((q) => q.type), prompts.Q_TYPES);
  assert.equal(cases.length, 2);
  const strip = (q) => { const { demo, ...rest } = q; return rest; };
  const json = { questions: questions.map(strip), cases: cases.map((k) => { const { demo, ...rest } = k; return { ...rest, questions: rest.questions.map(strip) }; }) };
  assert.equal(validate(prompts.QUESTION_GEN_SCHEMA, json), null);
  assert.equal(prompts.questionGenSemantic(counts)(json), null);
  for (const q of questions) { const r = REG.itemFromBody(aiToBody(q)); assert.ok(r.item, `${q.type}: ${JSON.stringify(r)}`); }
  for (const k of cases) { const r = REG.itemFromBody(caseToBody(k)); assert.ok(r.item, JSON.stringify(r)); }
  // 材料里带花括号也不会让多空填空的标记出错
  const braces = features.questionGenDemo("Use the {{template}} form for every refund request over the limit. ".repeat(3), features.normCounts({ cloze: 1 }));
  assert.ok(REG.itemFromBody(aiToBody(braces[0])).item);
});

test("semantic check: per-type counts, case count and the same structural limits as the bank", () => {
  const counts = features.normCounts(ALL);
  const good = () => {
    const strip = (q) => { const { demo, ...rest } = q; return rest; };
    return {
      questions: features.questionGenDemo(MATERIAL, counts).map(strip),
      cases: features.questionGenDemoCases(MATERIAL, counts).map((k) => { const { demo, ...rest } = k; return { ...rest, questions: rest.questions.map(strip) }; }),
    };
  };
  const sem = prompts.questionGenSemantic(counts);
  const at = (type) => (j) => j.questions.find((q) => q.type === type);
  const cases = [
    ["missing ordering", (j) => { j.questions = j.questions.filter((q) => q.type !== "ordering"); }, /expected 1 ordering/],
    ["one case short", (j) => { j.cases.pop(); }, /expected 2 case/],
    ["ordering 2 items", (j) => { at("ordering")(j).items.splice(2); }, /ordering needs 3-8/],
    ["ordering duplicate", (j) => { const q = at("ordering")(j); q.items[1].text = q.items[0].text.toUpperCase(); }, /must all be different/],
    ["matching duplicate right", (j) => { const q = at("matching")(j); q.pairs[1].right = q.pairs[0].right; }, /right-hand texts/],
    ["matching 4 distractors", (j) => { const q = at("matching")(j); for (let i = 0; i < 3; i++) q.pairs.push({ left: "", left_zh: "", right: "X" + i, right_zh: "" }); }, /at most 3 distractors/],
    ["classify empty category", (j) => { const q = at("classify")(j); q.categories.push({ text: "Unused", text_zh: "" }); }, /every category needs/],
    ["classify bad index", (j) => { at("classify")(j).items[0].category = 7; }, /category index/],
    ["cloze marker missing", (j) => { const q = at("cloze")(j); q.question = q.question.replace("{{2}}", ""); }, /markers/],
    ["cloze zh marker repeated", (j) => { const q = at("cloze")(j); q.question_zh += " {{1}}"; }, /question_zh must contain/],
    ["cloze blank without answers", (j) => { at("cloze")(j).blanks[0].answers = [" "]; }, /blank 1 needs/],
    ["case with open sub", (j) => { j.cases[0].questions[0] = { ...j.questions.find((q) => q.type === "open") }; }, /only objective types/],
    ["case with one sub", (j) => { j.cases[1].questions.splice(1); }, /needs 2-8 sub-questions/],
    ["case without passage", (j) => { j.cases[0].passage = " "; }, /passage needs text/],
    ["case sub broken", (j) => { j.cases[0].questions[2].items.splice(1); }, /case 1 sub-question 3: ordering needs/],
  ];
  assert.equal(sem(good()), null);
  for (const [name, mutate, re] of cases) { const j = good(); mutate(j); assert.match(String(sem(j)), re, name); }
});
