// 第四批 6.1：题库校验（设计 §1.4）。各题型上限；双语字数；多空填空标记（各出现一次、中英一致）；匹配题右项重复；
// 分类题空类别；案例小题题型限制（不含简答 / 案例，2–8 道）；未知或未开放题型 → bad_type；ENABLED 阶段开关；
// 批量导入同一套校验；写列 → 读行往返不丢字段。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const REG = require("../modules/learning/qtypes/index.js");
const SPEC = require("../modules/learning/qtypes/spec.js");

const T = (t) => ({ text: t, text_zh: t + "（中）" });
const v = (body, ctx) => REG.itemFromBody({ courseId: "c-1", question: "Q", ...body }, ctx);
const code = (body, ctx) => v(body, ctx).code;
const ok = (body, ctx) => { const r = v(body, ctx); assert.ok(r.item, JSON.stringify(r)); return r.item; };
const steps = (n) => Array.from({ length: n }, (_, i) => T("Step " + (i + 1)));
const pairs = (n) => Array.from({ length: n }, (_, i) => ({ left: T("L" + i), right: T("R" + i) }));

test("spec: ten types in catalogue order, every enabled type has an implementation, groups and defaults as designed", () => {
  assert.deepEqual(SPEC.TYPE_ORDER, ["mcq", "multi", "tf", "fill", "cloze", "ordering", "matching", "classify", "open", "case"]);
  assert.deepEqual(SPEC.ENABLED.slice(0, 4), ["mcq", "multi", "fill", "open"], "old four first, new types appended");
  for (const k of SPEC.TYPE_ORDER) { assert.ok(REG.get(k), k); assert.equal(REG.get(k).key, k); assert.equal(REG.get(k).group, SPEC.TYPES[k].group); }
  assert.deepEqual(REG.typePointsKeys(), ["mcq", "multi", "tf", "fill", "cloze", "ordering", "matching", "classify", "open"]);
  assert.deepEqual(REG.objectiveKeys(), ["mcq", "multi", "tf", "fill", "cloze", "ordering", "matching", "classify"]);
  assert.equal(REG.groupOf("case"), "case");
  assert.equal(REG.isAuto("open"), false);
  assert.equal(REG.isAuto("cloze"), true);
  assert.equal(REG.get("__proto__"), null);
  assert.equal(REG.get("toString"), null);
});

test("ordering: 3–8 steps, English text required, 300 characters per language, no duplicates", () => {
  assert.equal(code({ type: "ordering", items: steps(2) }), "bad_items");
  assert.deepEqual(ok({ type: "ordering", items: steps(3) }).items.length, 3);
  ok({ type: "ordering", items: steps(8) });
  assert.equal(code({ type: "ordering", items: steps(9) }), "bad_items");
  assert.equal(code({ type: "ordering", items: [...steps(2), { text: "", text_zh: "中" }] }), "empty_text");
  assert.equal(code({ type: "ordering", items: [...steps(2), { text: "x".repeat(301) }] }), "text_too_long");
  assert.equal(code({ type: "ordering", items: [...steps(2), { text: "ok", text_zh: "中".repeat(301) }] }), "text_too_long");
  ok({ type: "ordering", items: [...steps(2), { text: "x".repeat(300), text_zh: "中".repeat(300) }] });
  assert.equal(code({ type: "ordering", items: [...steps(2), { text: "step 1" }] }), "duplicate_items", "case-insensitive");
  const it = ok({ type: "ordering", items: [{ text: "  A  ", text_zh: "  " }, T("B"), "C"] });
  assert.deepEqual(it.items, [{ text: "A", text_zh: null }, T("B"), { text: "C", text_zh: null }], "trimmed; empty zh → null; plain strings accepted");
});

test("matching: 2–8 pairs, at most 3 distractors, right-hand texts (incl. distractors) unique, lefts unique", () => {
  assert.equal(code({ type: "matching", pairs: pairs(1) }), "bad_pairs");
  ok({ type: "matching", pairs: pairs(2) });
  ok({ type: "matching", pairs: pairs(8), distractors: [T("D1"), T("D2"), T("D3")] });
  assert.equal(code({ type: "matching", pairs: pairs(9) }), "bad_pairs");
  assert.equal(code({ type: "matching", pairs: pairs(2), distractors: [T("D1"), T("D2"), T("D3"), T("D4")] }), "bad_distractors");
  assert.equal(code({ type: "matching", pairs: pairs(3), distractors: [{ text: "r1" }] }), "duplicate_rights");
  assert.equal(code({ type: "matching", pairs: [...pairs(2), { left: T("X"), right: { text: "R0 " } }] }), "duplicate_rights");
  assert.equal(code({ type: "matching", pairs: [...pairs(2), { left: { text: "l0" }, right: T("New") }] }), "duplicate_lefts");
  assert.equal(code({ type: "matching", pairs: [{ left: T("a"), right: T("b") }, { left: T("c") }] }), "empty_text");
});

test("classification: 2–5 categories, 2–12 items, every category used, item category must exist", () => {
  const cats = (n) => Array.from({ length: n }, (_, i) => T("Cat" + i));
  const items = (n, k) => Array.from({ length: n }, (_, i) => ({ ...T("Item" + i), cat: i % k }));
  ok({ type: "classify", categories: cats(2), items: items(2, 2) });
  ok({ type: "classify", categories: cats(5), items: items(12, 5) });
  assert.equal(code({ type: "classify", categories: cats(1), items: items(2, 1) }), "bad_categories");
  assert.equal(code({ type: "classify", categories: cats(6), items: items(12, 6) }), "bad_categories");
  assert.equal(code({ type: "classify", categories: cats(2), items: items(1, 2) }), "bad_items");
  assert.equal(code({ type: "classify", categories: cats(2), items: items(13, 2) }), "bad_items");
  const empty = v({ type: "classify", categories: cats(3), items: items(4, 2) });
  assert.equal(empty.code, "empty_category");
  assert.equal(empty.index, 2);
  assert.equal(code({ type: "classify", categories: cats(2), items: [{ ...T("a"), cat: 0 }, { ...T("b"), cat: 2 }] }), "bad_category_ref");
  assert.equal(code({ type: "classify", categories: cats(2), items: [{ ...T("a"), cat: 0 }, { ...T("b"), cat: "1" }] }), "bad_category_ref");
  assert.equal(code({ type: "classify", categories: [T("Same"), { text: "same" }], items: items(2, 2) }), "duplicate_categories");
});

test("true/false: answer must be a boolean", () => {
  assert.equal(ok({ type: "tf", answer: false }).answer, false);
  assert.equal(code({ type: "tf" }), "bad_answer");
  assert.equal(code({ type: "tf", answer: "true" }), "bad_answer");
  assert.equal(code({ type: "tf", answer: 1 }), "bad_answer");
});

test("multi-blank fill: markers {{1}}…{{n}} once each in the stem and (when given) the Chinese stem; 1–10 blanks; 1–10 answers of ≤100 characters", () => {
  const b = (n) => Array.from({ length: n }, (_, i) => ({ answers: ["a" + i] }));
  ok({ type: "cloze", question: "x {{1}} y {{2}}", question_zh: "甲 {{2}} 乙 {{1}}", blanks: b(2) });
  assert.equal(code({ type: "cloze", question: "x {{1}}", blanks: b(2) }), "bad_markers");
  assert.equal(code({ type: "cloze", question: "x {{1}} {{1}} {{2}}", blanks: b(2) }), "bad_markers");
  assert.equal(code({ type: "cloze", question: "x {{1}} {{2}} {{3}}", blanks: b(2) }), "bad_markers");
  assert.equal(code({ type: "cloze", question: "x {{0}} {{1}} {{2}}", blanks: b(2) }), "bad_markers");
  const zh = v({ type: "cloze", question: "x {{1}} {{2}}", question_zh: "只有 {{1}}", blanks: b(2) });
  assert.equal(zh.code, "bad_markers");
  assert.equal(zh.lang, "zh");
  ok({ type: "cloze", question: "x {{1}}", question_zh: "", blanks: b(1) });
  assert.equal(code({ type: "cloze", question: "x", blanks: [] }), "bad_blanks");
  ok({ type: "cloze", question: Array.from({ length: 10 }, (_, i) => `{{${i + 1}}}`).join(" "), blanks: b(10) });
  assert.equal(code({ type: "cloze", question: Array.from({ length: 11 }, (_, i) => `{{${i + 1}}}`).join(" "), blanks: b(11) }), "bad_blanks");
  assert.equal(code({ type: "cloze", question: "{{1}}", blanks: [{ answers: ["", "  "] }] }), "bad_answers");
  assert.equal(code({ type: "cloze", question: "{{1}}", blanks: [{ answers: Array.from({ length: 11 }, (_, i) => "a" + i) }] }), "bad_answers");
  assert.equal(code({ type: "cloze", question: "{{1}}", blanks: [{ answers: ["x".repeat(101)] }] }), "text_too_long");
  assert.deepEqual(ok({ type: "cloze", question: "{{1}}", blanks: [{ answers: [" One ", "", "1"] }] }).blanks, [{ answers: ["One", "1"] }]);
});

test("scenario case: passage required (≤4000), 2–8 objective sub-questions, no short answer or nested case, sub errors are numbered, sids assigned in order", () => {
  const sub = (type, extra) => ({ type, question: "Sub?", ...extra });
  const mcq = sub("mcq", { options: [{ text: "a", ok: true }, { text: "b" }] });
  const tf = sub("tf", { answer: true });
  const base = { type: "case", passage: "Text.", items: [mcq, tf] };
  const item = ok({ ...base, points: 5, question_zh: "案例" });
  assert.deepEqual(item.items.map((x) => x.sid), ["s1", "s2"]);
  assert.equal(item.points, undefined, "a case has no question-level points");
  assert.equal(code({ ...base, passage: "  " }), "empty_passage");
  assert.equal(code({ ...base, passage: "x".repeat(4001) }), "text_too_long");
  ok({ ...base, passage: "x".repeat(4000), passage_zh: "中".repeat(4000) });
  assert.equal(code({ ...base, items: [mcq] }), "bad_items");
  assert.equal(code({ ...base, items: Array(9).fill(tf) }), "bad_items");
  ok({ ...base, items: Array(8).fill(tf) });
  assert.equal(code({ ...base, items: [mcq, sub("open", { rubric: "r" })] }), "bad_sub_type");
  assert.equal(code({ ...base, items: [mcq, { ...base, question: "nested" }] }), "bad_sub_type");
  assert.equal(code({ ...base, items: [mcq, sub("essay")] }), "bad_sub_type");
  const e = v({ ...base, items: [mcq, sub("ordering", { items: steps(2) })] });
  assert.equal(e.code, "bad_items");
  assert.equal(e.sub, 2);
  assert.match(e.error, /^Sub-question 2: /);
  assert.match(e.error_zh, /^第 2 小题：/);
  assert.equal(code({ ...base, items: [mcq, sub("tf", { question: "  ", answer: true })] }), "empty_question");
  const pts = ok({ ...base, items: [{ ...mcq, points: 3 }, { ...tf, points: 0 }] });
  assert.deepEqual(pts.items.map((x) => x.points), [3, null]);
  const all = ok({ ...base, items: [mcq, sub("multi", { options: [{ text: "a", ok: true }, { text: "b" }] }), sub("fill", { answers: ["x"] }), tf, sub("cloze", { question: "a {{1}}", blanks: [{ answers: ["x"] }] }), sub("ordering", { items: steps(3) }), sub("matching", { pairs: pairs(2) }), sub("classify", { categories: [T("A"), T("B")], items: [{ ...T("i"), cat: 0 }, { ...T("j"), cat: 1 }] })] });
  assert.equal(all.items.length, 8);
});

test("unknown or disabled type → bad_type (single and bulk); bulk uses the same validation for new types", () => {
  assert.equal(code({ type: "essay" }), "bad_type");
  assert.equal(code({ type: "essay" }, { bulk: true, courseId: "c" }), "bad_type");
  assert.equal(v({ type: "essay" }).error, "Invalid question");
  assert.equal(code({ type: "ordering", question: "  " }, { bulk: true, courseId: "c" }), "empty_question");
  const b = ok({ type: "ordering", question: "  Order these  ", question_zh: " 排序 ", items: steps(3), courseId: "ignored" }, { bulk: true, courseId: "c-9" });
  assert.equal(b.courseId, "c-9");
  assert.equal(b.question, "Order these");
  assert.equal(b.question_zh, "排序");
  assert.equal(b.moduleId, null);
  assert.equal(code({ type: "ordering", items: steps(2) }, { bulk: true, courseId: "c" }), "bad_items");
});

test("ENABLED phase gate: a type left out of ENABLED is refused as a question and as a case sub-question", () => {
  const ids = ["index.js", "case.js"].map((f) => require.resolve("../modules/learning/qtypes/" + f));
  const saved = SPEC.ENABLED.slice();
  try {
    SPEC.ENABLED.splice(SPEC.ENABLED.indexOf("cloze"), 1);
    for (const id of ids) delete require.cache[id];
    const R2 = require("../modules/learning/qtypes/index.js");
    assert.equal(R2.isEnabled("cloze"), false);
    assert.ok(!R2.enabled().includes("cloze"));
    assert.ok(!R2.typePointsKeys().includes("cloze"));
    assert.equal(R2.itemFromBody({ courseId: "c", type: "cloze", question: "{{1}}", blanks: [{ answers: ["a"] }] }).code, "bad_type");
    assert.equal(R2.itemFromBody({ courseId: "c", type: "case", question: "Q", passage: "P", items: [{ type: "tf", question: "a", answer: true }, { type: "cloze", question: "{{1}}", blanks: [{ answers: ["a"] }] }] }).code, "bad_sub_type");
    assert.equal(R2.isUsable({ type: "cloze", blanks: [{ answers: ["a"] }] }), false);
  } finally {
    SPEC.ENABLED.splice(0, SPEC.ENABLED.length, ...saved);
    for (const id of ids) delete require.cache[id];
  }
});

test("bank round trip: validate → columns → row → question keeps every type field; bad data JSON never throws", () => {
  const bodies = [
    { type: "ordering", items: steps(3), explanation: "e", explanation_zh: "解" },
    { type: "matching", pairs: pairs(2), distractors: [T("D")] },
    { type: "classify", categories: [T("A"), T("B")], items: [{ ...T("i"), cat: 0 }, { ...T("j"), cat: 1 }] },
    { type: "tf", answer: false },
    { type: "cloze", question: "{{1}}", blanks: [{ answers: ["a", "b"] }] },
    { type: "case", passage: "P", passage_zh: "材料", items: [{ type: "tf", question: "a", answer: true }, { type: "mcq", question: "b", options: [{ text: "x", ok: true }, { text: "y" }] }] },
  ];
  for (const body of bodies) {
    const item = ok(body);
    const cols = REG.questionColumns(item);
    assert.equal(cols.options, null);
    assert.equal(typeof cols.data, "string");
    const q = REG.rowToQuestion({ id: "q1", courseId: "c-1", moduleId: null, type: item.type, question: item.question, question_zh: null, ...cols, points: null });
    // 空讲解 "" 照旧存成 NULL（与旧题型同一列映射）
    for (const [k, val] of Object.entries(item)) if (!["courseId", "moduleId", "question_zh"].includes(k)) assert.deepEqual(val === "" ? q[k] ?? "" : q[k], val, `${item.type}.${k}`);
    assert.ok(REG.isUsable(q), item.type);
    const broken = REG.rowToQuestion({ id: "q2", type: item.type, question: "Q", data: "{not json", points: null });
    assert.equal(REG.isUsable(broken), false, `${item.type}: broken data is not drawn into papers`);
    assert.doesNotThrow(() => REG.snapshot(broken, { shuffle: (a) => a.slice() }));
  }
  assert.equal(REG.itemCount(ok(bodies[5])), 2);
  assert.equal(REG.itemCount(ok(bodies[0])), 1);
});
