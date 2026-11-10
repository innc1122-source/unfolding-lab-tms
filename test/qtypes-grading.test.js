// 第四批 6.1：新题型评分（设计 §1.5）。每种新题型的满分 / 部分分 / 零分；排序题相邻对规则；匹配题干扰项与重复使用右项；
// 分类题；多空填空的比对口径与逐空给分；判断题；情境案例按小题汇总（含混合题型与分值回退）；部分给分关闭 = 全对才得分；
// 格式不对的作答 = 未作答、0 分；totals() 与 scoreTotals 的旧口径回退；百分比四舍五入。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const REG = require("../modules/learning/qtypes/index.js");
const { rngOf, shuffleOf } = require("./fixtures/qtypes-rng.js");

let seq = 0;
// 请求体 → 校验 → 写列 → 读行，得到与题库一致的题目对象
function bank(body) {
  const r = REG.itemFromBody({ courseId: "c-1", question: body.question || "Q", ...body });
  assert.ok(r.item, JSON.stringify(r));
  const id = "q" + ++seq;
  const cols = REG.questionColumns(r.item);
  return REG.rowToQuestion({ id, courseId: "c-1", moduleId: null, type: r.item.type, question: r.item.question, question_zh: r.item.question_zh, ...cols, origin: null, points: r.item.points == null ? null : r.item.points });
}
const ctxOf = (extra = {}) => ({ shuffle: shuffleOf(rngOf(++seq)), shuffleOptions: true, multiPartial: true, partialCredit: true, points: null, ...extra });
const gradeWith = (snap, raw) => REG.gradeOne(snap, { [snap.id]: raw });
const T = (t) => ({ text: t, text_zh: t + "（中）" });

test("ordering: adjacent-pair credit (ABCD → BCDA = 2/3, reversed = 0, exact = 1); off → all or nothing; untouched / malformed = 0", () => {
  const q = bank({ type: "ordering", items: ["A", "B", "C", "D"].map(T) });
  const s = REG.snapshot(q, ctxOf());
  const [a, b, c, d] = s.key; // 快照下标
  assert.deepEqual(s.key.map((k) => s.items[k].text), ["A", "B", "C", "D"]);
  assert.equal(gradeWith(s, [a, b, c, d]).credit, 1);
  const bcda = gradeWith(s, [b, c, d, a]);
  assert.equal(bcda.credit, 2 / 3);
  assert.equal(bcda.partial, true);
  assert.equal(bcda.isRight, false);
  assert.deepEqual(bcda.pairRight, [true, true, false]);
  assert.equal(gradeWith(s, [d, c, b, a]).credit, 0);
  assert.equal(gradeWith(s, [a, b, d, c]).credit, 1 / 3);
  const off = REG.snapshot(q, ctxOf({ partialCredit: false }));
  assert.equal(gradeWith(off, [off.key[1], off.key[2], off.key[3], off.key[0]]).credit, 0);
  assert.equal(gradeWith(off, off.key.slice()).credit, 1);
  for (const bad of [undefined, null, [a, a, b, c], [a, b, c], [a, b, c, d, 0], [0, 1, 2, 9], ["0", "1", "2", "3"], [0.5, 1, 2, 3], "0123", { 0: 0 }]) {
    const g = gradeWith(s, bad);
    assert.equal(g.credit, 0, JSON.stringify(bad));
    assert.equal(g.response, null);
  }
});

test("matching: pairs with distractors; a reused right-hand item counts only for its own pair; off → all or nothing", () => {
  const q = bank({ type: "matching", pairs: [["KYC", "Know your customer"], ["AML", "Anti-money laundering"], ["STR", "Suspicious transaction report"]].map(([l, r]) => ({ left: T(l), right: T(r) })), distractors: [T("Annual leave")] });
  const s = REG.snapshot(q, ctxOf());
  assert.equal(s.rights.length, 4);
  assert.equal(gradeWith(s, s.key.slice()).credit, 1);
  const reused = gradeWith(s, [s.key[0], s.key[0], s.key[2]]);
  assert.equal(reused.credit, 2 / 3);
  assert.deepEqual(reused.leftRight, [true, false, true]);
  const distractor = s.rights.findIndex((r) => r.text === "Annual leave");
  assert.equal(gradeWith(s, [distractor, s.key[1], null]).credit, 1 / 3);
  assert.equal(gradeWith(s, [null, null, null]).response, null, "all empty = unanswered");
  const off = REG.snapshot(q, ctxOf({ partialCredit: false }));
  assert.equal(gradeWith(off, [off.key[0], off.key[1], null]).credit, 0);
  for (const bad of [[0, 1], [0, 1, 2, 3], [0, 1, 9], [-1, 0, 1], ["0", 1, 2], 2]) assert.equal(gradeWith(s, bad).credit, 0, JSON.stringify(bad));
});

test("classification: correct items ÷ items; off → all or nothing", () => {
  const q = bank({ type: "classify", categories: [T("Risk"), T("Control")], items: [{ ...T("Large cash deposit"), cat: 0 }, { ...T("Dual approval"), cat: 1 }, { ...T("Structuring"), cat: 0 }, { ...T("Daily reconciliation"), cat: 1 }] });
  const s = REG.snapshot(q, ctxOf());
  assert.equal(gradeWith(s, s.key.slice()).credit, 1);
  const flipped = s.key.map((k, i) => (i === 0 ? 1 - k : k));
  assert.equal(gradeWith(s, flipped).credit, 3 / 4);
  assert.equal(gradeWith(s, [s.key[0], null, null, null]).credit, 1 / 4);
  const off = REG.snapshot(q, ctxOf({ partialCredit: false }));
  assert.equal(gradeWith(off, off.key.map((k, i) => (i === 0 ? 1 - k : k))).credit, 0);
  assert.equal(gradeWith(s, s.key.map(() => 2)).credit, 0, "category index out of range = malformed");
});

test("multi-blank fill: same normalisation as fill-in, credit per blank; empty never matches; off → all or nothing; malformed = 0", () => {
  const q = bank({ type: "cloze", question: "Report within {{1}} business {{2}}.", question_zh: "在 {{1}} 个工作{{2}}内上报。", blanks: [{ answers: ["one", "1"] }, { answers: ["day"] }] });
  const s = REG.snapshot(q, ctxOf());
  assert.equal(gradeWith(s, ["  ONE ", "Day"]).credit, 1);
  const half = gradeWith(s, ["1", "week"]);
  assert.equal(half.credit, 0.5);
  assert.deepEqual(half.blankRight, [true, false]);
  assert.equal(gradeWith(s, ["one", ""]).credit, 0.5);
  assert.equal(gradeWith(s, ["", "   "]).response, null, "all blank = unanswered");
  assert.equal(gradeWith(s, ["one", null]).credit, 0.5);
  const off = REG.snapshot(q, ctxOf({ partialCredit: 0 }));
  assert.equal(gradeWith(off, ["one", "week"]).credit, 0);
  for (const bad of [["one"], ["one", "day", "x"], ["one", 5], ["x".repeat(201), "day"], "one day"]) assert.equal(gradeWith(s, bad).credit, 0, JSON.stringify(bad));
});

test("true/false: only a real boolean is an answer", () => {
  const t = REG.snapshot(bank({ type: "tf", answer: true }), ctxOf());
  const f = REG.snapshot(bank({ type: "tf", answer: false }), ctxOf());
  assert.equal(gradeWith(t, true).isRight, true);
  assert.equal(gradeWith(t, false).credit, 0);
  assert.equal(gradeWith(f, false).credit, 1);
  for (const bad of ["true", 1, 0, null, undefined, [true]]) { const g = gradeWith(t, bad); assert.equal(g.credit, 0); assert.equal(g.response, null); }
});

function caseQuestion(subPoints = {}) {
  return bank({
    type: "case", question: "Read the case.", passage: "A customer deposits cash three times in one day, each just under the reporting limit.", passage_zh: "某客户一天内分三次存入现金，每次都略低于申报门槛。",
    items: [
      { type: "mcq", question: "What is this called?", options: [{ text: "Structuring", ok: true }, { text: "Layering" }, { text: "Netting" }], points: subPoints.s1 },
      { type: "multi", question: "Which apply?", options: [{ text: "Red flag", ok: true }, { text: "Report", ok: true }, { text: "Ignore" }] },
      { type: "tf", question: "Must it be reported?", answer: true },
      { type: "cloze", question: "File an {{1}} within {{2}} days.", blanks: [{ answers: ["STR"] }, { answers: ["5", "five"] }], points: subPoints.s4 },
      { type: "ordering", question: "Order the steps.", items: ["Spot", "Escalate", "File"].map(T) },
    ],
  });
}

test("scenario case: each sub-question graded by its own type; case credit = Σ earned ÷ Σ points; sub points fall back to typePoints, then 1", () => {
  const q = caseQuestion({ s1: 4 });
  assert.deepEqual(q.items.map((x) => x.sid), ["s1", "s2", "s3", "s4", "s5"]);
  const s = REG.snapshot(q, ctxOf({ pointsFor: (sub) => ({ multi: 2, ordering: 3 })[sub.type] ?? null }));
  assert.deepEqual(s.items.map((x) => x.points), [4, 2, 1, 1, 3]);
  assert.equal(s.points, 11);
  const sub = (sid) => s.items.find((x) => x.sid === sid);
  const mcqRight = sub("s1").options.findIndex((o) => o.ok);
  const multiRight = sub("s2").options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0);
  const all = { s1: mcqRight, s2: multiRight, s3: true, s4: ["str", "five"], s5: sub("s5").key.slice() };
  const full = gradeWith(s, all);
  assert.equal(full.credit, 1);
  assert.equal(full.isRight, true);
  // mcq 错（0/4）、多选只选一个对的（0.5 × 2 = 1）、判断对（1）、多空对一空（0.5）、排序全对（3）→ 5.5 / 11
  const mixed = gradeWith(s, { ...all, s1: (mcqRight + 1) % 3, s2: [multiRight[0]], s4: ["str", "ten"] });
  assert.equal(mixed.credit, 5.5 / 11);
  assert.deepEqual(mixed.items.map((x) => x.credit), [0, 0.5, 1, 0.5, 1]);
  assert.deepEqual(REG.scoreTotals([mixed]), { earned: 5.5, max: 11, hasPoints: true });
  // 旧口径（考试没设题型分值）：每道小题 1 分
  const legacy = REG.snapshot(q, ctxOf({ points: null }));
  assert.deepEqual(legacy.items.map((x) => x.points), [4, 1, 1, 1, 1]);
  // 只答了不存在的小题 / 格式不对 → 未作答
  assert.equal(gradeWith(s, { s9: 1 }).response, null);
  assert.equal(gradeWith(s, [1, 2]).credit, 0);
  assert.equal(gradeWith(s, "s1").credit, 0);
});

test("totals(): points × credit for new types; old types fall back to the legacy rule; percent rounds as before", () => {
  const ord = REG.snapshot(bank({ type: "ordering", items: ["A", "B", "C"].map(T) }), ctxOf({ points: 3 }));
  const tfLegacy = REG.snapshot(bank({ type: "tf", answer: false }), ctxOf({ points: null }));
  const mcq = REG.snapshot(bank({ type: "mcq", options: [{ text: "a", ok: true }, { text: "b" }] }), ctxOf({ points: null }));
  const [k0, k1, k2] = ord.key;
  const detail = [gradeWith(ord, [k0, k2, k1]), gradeWith(tfLegacy, false), gradeWith(mcq, mcq.options.findIndex((o) => !o.ok))];
  assert.deepEqual(REG.get("ordering").totals(detail[0]), { earned: 0, max: 3 });
  assert.equal(REG.get("mcq").totals(detail[2]), null, "old types return null → legacy path");
  const t = REG.scoreTotals(detail);
  assert.deepEqual(t, { earned: 1, max: 5, hasPoints: true });
  assert.equal(REG.scoreDetail(detail), 20);
  // 排序全对 3 分 + 判断 1 分 + 单选 0 分 = 4 / 5 = 80%
  const d2 = [gradeWith(ord, [k0, k1, k2]), ...detail.slice(1)];
  assert.equal(REG.scoreDetail(d2), 80);
  const third = [gradeWith(REG.snapshot(bank({ type: "cloze", question: "{{1}} {{2}} {{3}}", blanks: [{ answers: ["a"] }, { answers: ["b"] }, { answers: ["c"] }] }), ctxOf({ points: 1 })), ["a", "x", "x"])];
  assert.equal(REG.scoreDetail(third), 33);
});
