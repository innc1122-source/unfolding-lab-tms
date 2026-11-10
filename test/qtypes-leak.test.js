// 第四批 6.1：答案不外泄（设计 §1.5、§12 第 10–13 条）。
// · 每种题型（含案例的递归）学员拿到的题目副本里没有 key / ok / answers / answer / cat / accepted / correct / explanation / rubric，
//   多空填空只给空的个数；
// · 排序题 10,000 次带种子的抽题，学员看到的顺序从不等于正确顺序（打乱函数一直返回原顺序时也一样）；
// · 匹配题右栏从不与左栏整体对齐；
// · 考试不显示答案时，学员明细（含案例小题）去掉正确答案、讲解与逐项对错标记（多空填空的逐空对错除外，设计 §1.5）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const REG = require("../modules/learning/qtypes/index.js");
const { rngOf, shuffleOf, findKeys } = require("./fixtures/qtypes-rng.js");

let seq = 0;
function bank(body) {
  const r = REG.itemFromBody({ courseId: "c-1", question: "Q", ...body });
  assert.ok(r.item, JSON.stringify(r));
  const cols = REG.questionColumns(r.item);
  return REG.rowToQuestion({ id: "q" + ++seq, courseId: "c-1", moduleId: null, type: r.item.type, question: r.item.question, question_zh: r.item.question_zh, ...cols, origin: null, points: r.item.points ?? null });
}
const T = (t) => ({ text: t, text_zh: t + "（中）" });
const SAMPLES = {
  mcq: { type: "mcq", options: [{ text: "a", ok: true }, { text: "b" }], explanation: "why" },
  multi: { type: "multi", options: [{ text: "a", ok: true }, { text: "b", ok: true }, { text: "c" }], explanation: "why" },
  fill: { type: "fill", answers: ["one"], explanation: "why" },
  open: { type: "open", rubric: "Mentions X", maxPoints: 10 },
  tf: { type: "tf", answer: true, explanation: "why" },
  cloze: { type: "cloze", question: "{{1}} and {{2}}", blanks: [{ answers: ["x"] }, { answers: ["y"] }], explanation: "why" },
  ordering: { type: "ordering", items: ["A", "B", "C"].map(T), explanation: "why" },
  matching: { type: "matching", pairs: [["a", "1"], ["b", "2"]].map(([l, r]) => ({ left: T(l), right: T(r) })), distractors: [T("3")], explanation: "why" },
  classify: { type: "classify", categories: [T("X"), T("Y")], items: [{ ...T("i1"), cat: 0 }, { ...T("i2"), cat: 1 }], explanation: "why" },
};
SAMPLES.case = { type: "case", passage: "Scenario text.", items: ["mcq", "multi", "fill", "tf", "cloze", "ordering", "matching", "classify"].map((t) => ({ ...SAMPLES[t], question: SAMPLES[t].question || "Sub?" })), explanation: "why" };
const BANNED = ["key", "ok", "answers", "answer", "cat", "accepted", "correct", "explanation", "explanation_zh", "rubric", "rubric_zh"];

test("client copy of every type (and case sub-questions) carries no answer data", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...REG.TYPE_ORDER].sort(), "every type is covered");
  for (const [t, body] of Object.entries(SAMPLES)) {
    for (let i = 0; i < 20; i++) {
      const snap = REG.snapshot(bank(body), { shuffle: shuffleOf(rngOf(i + 1)), points: i % 2 ? 2 : null, pointsFor: () => 2 });
      const c = REG.clientQuestion(snap);
      assert.deepEqual(findKeys(c, BANNED), [], `${t}: ${JSON.stringify(c)}`);
      const blanks = [];
      (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (k === "blanks") blanks.push(v); walk(v); } })(c);
      for (const b of blanks) assert.equal(typeof b, "number", `${t}: cloze sends only the blank count`);
    }
  }
  const caseClient = REG.clientQuestion(REG.snapshot(bank(SAMPLES.case), { shuffle: shuffleOf(rngOf(9)) }));
  assert.equal(caseClient.items.length, 8);
  assert.deepEqual(caseClient.items.map((x) => x.sid), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
});

test("ordering: in 10,000 seeded draws the learner order never equals the correct order (also with a shuffle that returns its input)", () => {
  const rng = rngOf(424242);
  const shuffle = shuffleOf(rng);
  const qs = [3, 4, 5, 6, 7, 8].map((n) => bank({ type: "ordering", items: Array.from({ length: n }, (_, i) => T("Step " + (i + 1))) }));
  for (let i = 0; i < 10000; i++) {
    const q = qs[i % qs.length];
    const s = REG.snapshot(q, { shuffle, shuffleOptions: i % 3 === 0 ? false : true });
    assert.notDeepEqual(REG.clientQuestion(s).items.map((x) => x.text), q.items.map((x) => x.text), `draw ${i}`);
    assert.deepEqual(s.key.map((k) => s.items[k].text), q.items.map((x) => x.text), "key restores the correct order");
  }
  for (const q of qs) {
    const s = REG.snapshot(q, { shuffle: (a) => a.slice() });
    assert.notDeepEqual(s.items.map((x) => x.text), q.items.map((x) => x.text));
  }
});

test("matching: the right-hand column is never fully aligned with the left (10,000 draws, both option-order settings, identity shuffle)", () => {
  const shuffle = shuffleOf(rngOf(99));
  const qs = [2, 3, 5, 8].map((n) => bank({ type: "matching", pairs: Array.from({ length: n }, (_, i) => ({ left: T("L" + i), right: T("R" + i) })), distractors: n === 2 ? [] : [T("D")] }));
  const aligned = (s) => s.key.every((k, i) => k === i);
  for (let i = 0; i < 10000; i++) {
    const s = REG.snapshot(qs[i % qs.length], { shuffle, shuffleOptions: i % 2 === 0 });
    assert.ok(!aligned(s), `draw ${i}`);
    s.key.forEach((k, li) => assert.equal(s.rights[k].text, "R" + s.lefts[li].text.slice(1)));
  }
  for (const q of qs) for (const so of [true, false]) assert.ok(!aligned(REG.snapshot(q, { shuffle: (a) => a.slice(), shuffleOptions: so })));
  const fixedLeft = REG.snapshot(qs[2], { shuffle, shuffleOptions: false });
  assert.deepEqual(fixedLeft.lefts.map((x) => x.text), ["L0", "L1", "L2", "L3", "L4"], "lefts keep the authored order when option order is fixed");
});

test("learner detail with answers hidden strips keys, explanations and per-item marks recursively; shown = full detail", () => {
  // 旧题型的填空 / 简答明细里 answer 是学员自己的作答（不是正确答案），保留；新题型的正确答案一律叫 key
  const HIDDEN_BANNED = [...BANNED.filter((k) => k !== "answer"), "pairRight", "leftRight", "itemRight", "accepted"];
  for (const [t, body] of Object.entries(SAMPLES)) {
    const snap = REG.snapshot(bank(body), { shuffle: shuffleOf(rngOf(3)), points: 2 });
    const d = REG.gradeOne(snap, {});
    const hidden = REG.clientDetail([d], false)[0];
    // 多空填空的 blanks 只能是空的个数（这里不应出现）；简答题一律走 clientOpenDetail（不带 rubric）
    assert.deepEqual(findKeys(hidden, [...HIDDEN_BANNED, "blanks"]), [], `${t}: ${JSON.stringify(hidden)}`);
    assert.equal(hidden.points, t === "case" ? snap.points : 2);
    const shown = REG.clientDetail([d], true)[0];
    if (t !== "open") assert.deepEqual(shown, d, `${t}: shown = full detail`);
  }
  const cz = REG.gradeOne(REG.snapshot(bank(SAMPLES.cloze), { shuffle: (a) => a }), {});
  assert.ok("blankRight" in REG.clientDetail([cz], false)[0], "cloze keeps per-blank marks (design §1.5)");
  const caseHidden = REG.clientDetail([REG.gradeOne(REG.snapshot(bank(SAMPLES.case), { shuffle: (a) => a }), {})], false)[0];
  assert.equal(caseHidden.items.length, 8);
  assert.ok(caseHidden.items.every((x) => x.sid && typeof x.credit === "number"));
});
