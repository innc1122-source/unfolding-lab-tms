// 第四批 6.1 阶段 4a：旧四种题型（mcq / multi / fill / open）移进题型注册表后行为逐字节不变（设计 §1.11）。
// 对照物是 test/fixtures/qtypes-legacy.js —— 在 G1 改 server.js / store.js 之前从当日代码逐字剪下的冻结副本。
// 用带种子的随机数生成约 2,000 组用例，逐步比对：校验（单题 + 批量的差异）、列映射与读行、开考快照（同一种子打乱）、
// 学员题目副本、作答评分、学员明细（显示 / 不显示答案）、整卷计分（含没有 points 的旧答卷）。比对用 JSON 文本相等（键顺序也一致）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const LEG = require("./fixtures/qtypes-legacy.js");
const REG = require("../modules/learning/qtypes/index.js");
const { rngOf, shuffleOf } = require("./fixtures/qtypes-rng.js");

const rng = rngOf(20261008);
const R = (n) => Math.floor(rng() * n);
const pick = (arr) => arr[R(arr.length)];
const chance = (p) => rng() < p;
const same = (a, b, msg) => { assert.deepStrictEqual(b, a, msg); assert.equal(JSON.stringify(b), JSON.stringify(a), msg + " (JSON)"); };
// 比对可能抛错的调用：两边要么都抛，要么结果相同
function call(fn) { try { return { v: fn() }; } catch (e) { return { threw: e.constructor.name }; } }

const WORDS = ["Escalate", "  padded  ", "Finance desk", "ONE", "one", "One  Day", "", "   ", "数据隐私", "上报", "a\tb", "x".repeat(40)];
const word = () => pick(WORDS);
const maybe = (v) => (chance(0.3) ? pick([undefined, null, "", v]) : v);
const POINTS = [undefined, null, "", "abc", 0, 1, 2, 5, 50.4, 99.5, 100, 101, -3, "30", "7.6", Infinity];
const MAXP = [undefined, null, 0, -5, 3, 10, 12, 150, "7", "x"];
function genOptions() {
  if (chance(0.06)) return pick([undefined, null, "a,b", {}, []]);
  const n = R(7);
  return Array.from({ length: n }, () => ({ text: maybe(word()), text_zh: maybe(word()), ok: pick([true, false, false, 1, 0, "yes", undefined]) }));
}
function genAnswers() {
  if (chance(0.08)) return pick([undefined, null, "one", {}, []]);
  return Array.from({ length: R(4) }, () => pick(["one", " One ", "1", "", "   ", "day", 0, 7]));
}
function genBody() {
  const type = chance(0.92) ? pick(["mcq", "multi", "fill", "open"]) : pick(["", "essay", undefined, "MCQ", "tf2"]);
  const b = {};
  if (chance(0.95)) b.courseId = pick(["c-1", "c-2"]);
  b.type = type;
  if (chance(0.95)) b.question = pick(["What first?", "  Spaced stem  ", "", "   ", "Escalate within ____ day."]);
  if (chance(0.5)) b.question_zh = pick(["中文题干", "  空格  ", "", null]);
  if (chance(0.5)) b.moduleId = pick(["m1", "", null]);
  b.options = genOptions();
  b.answers = genAnswers();
  if (chance(0.6)) b.explanation = maybe("Because.");
  if (chance(0.5)) b.explanation_zh = maybe("因为。");
  if (chance(0.5)) b.rubric = maybe("Mentions X");
  if (chance(0.4)) b.rubric_zh = maybe("提到 X");
  if (chance(0.6)) b.maxPoints = pick(MAXP);
  if (chance(0.6)) b.points = pick(POINTS);
  return b;
}

test("validation: single POST/PUT and bulk import give the same items and the same error texts as before", () => {
  let ok = 0, bad = 0;
  for (let i = 0; i < 2500; i++) {
    const b = genBody();
    const L1 = call(() => LEG.questionItemFromBody(b));
    const R1 = call(() => REG.itemFromBody(b));
    assert.equal(!!R1.threw, !!L1.threw, `single #${i} throw parity ${JSON.stringify(b)}`);
    if (!L1.threw) {
      if (L1.v.error) { assert.equal(R1.v.error, L1.v.error, `single #${i}`); assert.ok(!R1.v.item); bad++; }
      else { same(L1.v.item, R1.v.item, `single #${i}`); ok++; }
    }
    const L2 = call(() => LEG.bulkItemFromBody(b, "c-bulk"));
    const R2 = call(() => REG.itemFromBody(b, { bulk: true, courseId: "c-bulk" }));
    assert.equal(!!R2.threw, !!L2.threw, `bulk #${i} throw parity`);
    if (!L2.threw) {
      if (!L2.v.ok) { assert.equal(R2.v.error, L2.v.reason, `bulk #${i}`); assert.ok(!R2.v.item); }
      else same(L2.v.item, R2.v.item, `bulk #${i}`);
    }
  }
  assert.ok(ok > 300 && bad > 300, `both branches exercised (ok ${ok}, bad ${bad})`);
});

test("validation quirks are kept: bulk clamps open maxPoints to 1–100, single does not", () => {
  const body = { courseId: "c", type: "open", question: "Q", maxPoints: 150 };
  assert.equal(REG.itemFromBody(body).item.maxPoints, 150);
  assert.equal(REG.itemFromBody(body, { bulk: true, courseId: "c" }).item.maxPoints, 100);
  assert.equal(REG.itemFromBody({ ...body, maxPoints: 0 }, { bulk: true, courseId: "c" }).item.maxPoints, 10);
});

// 从合法请求体造题库题目（带 id）
function genBankQuestion(i) {
  for (;;) {
    const b = genBody();
    const r = call(() => LEG.questionItemFromBody(b));
    if (r.threw || r.v.error) continue;
    const q = { ...r.v.item, id: "q" + i };
    if (q.type === "mcq" || q.type === "multi") q.options = q.options.map((o) => ({ ...o, text: o.text == null ? "t" : o.text }));
    return q;
  }
}
function rowOf(q) {
  const cols = LEG.questionColumns(q);
  return {
    id: q.id, courseId: q.courseId, moduleId: q.moduleId || null, type: q.type, question: q.question, question_zh: q.question_zh || null,
    ...cols, data: null,
    origin: pick([null, null, JSON.stringify({ kind: "ai", callId: 3 }), "{bad json"]),
    points: q.points != null ? q.points : chance(0.2) ? 4 : null,
  };
}

test("bank rows: column mapping and row reading are unchanged (data column stays NULL)", () => {
  for (let i = 0; i < 1500; i++) {
    const q = genBankQuestion(i);
    const legacyCols = LEG.questionColumns(q);
    const regCols = REG.questionColumns(q);
    assert.equal(regCols.data, null, "old types never write the data column");
    const { data, ...rest } = regCols;
    same(legacyCols, rest, `columns #${i}`);
    const row = rowOf(q);
    same(LEG.rowToQuestion(row), REG.rowToQuestion(row), `row #${i}`);
  }
  // 旧 store.js 把未知题型读成简答；注册表标为 unsupported（抽题跳过）。只这一处有意不同。
  const unk = REG.rowToQuestion({ id: "q9", courseId: "c", moduleId: null, type: "hologram", question: "Q", question_zh: null, options: null, data: null, points: null });
  assert.equal(unk.unsupported, true);
  // 坏 JSON 不再抛错（旧代码会抛）：读成空数组
  assert.deepEqual(REG.rowToQuestion({ id: "q8", type: "mcq", options: "{oops", points: null }).options, []);
});

function genExam() {
  const e = {};
  if (chance(0.6)) {
    e.typePoints = {};
    for (const t of ["mcq", "multi", "fill", "open"]) if (chance(0.7)) e.typePoints[t] = pick([1, 2, 3, 5, 10]);
  } else if (chance(0.2)) e.typePoints = null;
  if (chance(0.6)) e.multiPartial = pick([true, false, undefined]);
  return e;
}
function genAnswer(snap) {
  if (chance(0.1)) return undefined;
  const n = snap.options ? snap.options.length : 0;
  if (snap.type === "mcq") return pick([R(n + 2) - 1, R(n), R(n), "1", null, 1.5, [0], true]);
  if (snap.type === "multi") {
    if (chance(0.15)) return pick([0, "0,1", null, {}]);
    return Array.from({ length: R(n + 2) }, () => pick([R(n), R(n), R(n + 3) - 1, "1", null]));
  }
  if (snap.type === "fill") return pick([...(snap.answers || []).map((a) => pick([a, String(a).toUpperCase(), `  ${a}  `])), "wrong", "", "   ", 0, 7, {}, null]);
  return pick(["My answer", "", 12, null, "  spaced  "]);
}

test("exam start → client copy → submit → learner detail → score: identical to the frozen code, step by step", () => {
  const seedBase = 777;
  for (let round = 0; round < 400; round++) {
    const exam = genExam();
    const bank = Array.from({ length: 1 + R(8) }, (_, i) => genBankQuestion(i)).map((q) => REG.rowToQuestion(rowOf(q)));
    const shA = shuffleOf(rngOf(seedBase + round)), shB = shuffleOf(rngOf(seedBase + round));
    const legSnaps = bank.map((q) => LEG.snapshotQuestion(q, exam, shA));
    const regSnaps = bank.map((q) => REG.snapshot(q, { shuffle: shB, shuffleOptions: exam.shuffleOptions, multiPartial: exam.multiPartial, partialCredit: exam.partialCredit, points: LEG.questionPoints(exam, q) }));
    same(legSnaps, regSnaps, `snapshot round ${round}`);
    same(LEG.clientQuestions(legSnaps), REG.clientQuestions(regSnaps), `client round ${round}`);
    const answers = {};
    for (const s of legSnaps) { const a = genAnswer(s); if (a !== undefined) answers[s.id] = a; }
    const legDetail = legSnaps.map((s) => LEG.gradeQuestion(s, answers));
    const regDetail = REG.gradeAll(regSnaps, answers);
    same(legDetail, regDetail, `grade round ${round}`);
    // 简答题评完分后的各种状态
    for (const d of legDetail.filter((x) => x.type === "open")) {
      const v = pick(["pending", "ai_provisional", "confirmed", "legacy", "overridden", "manual", undefined]);
      if (v === undefined) delete d.review; else d.review = v;
      d.score = pick([null, 0, 3, d.maxPoints]);
      if (chance(0.5)) d.ai = { model: "m", modelReturned: pick([null, "m2"]), generatedAt: "2026-10-08", feedback: "ai fb", confidence: "high" };
      if (chance(0.3)) d.feedback = "fb";
      if (chance(0.2)) d.demoEstimate = 4;
      if (chance(0.2)) d.overridden = true;
    }
    const legacyAttempt = chance(0.3) ? legDetail.map(({ points, ...d }) => d) : legDetail; // 没有 points 的旧答卷
    for (const show of [true, false, undefined]) same(LEG.clientDetail(legacyAttempt, show), REG.clientDetail(legacyAttempt, show), `detail round ${round} show ${show}`);
    same(LEG.scoreTotals(legacyAttempt), REG.scoreTotals(legacyAttempt), `totals round ${round}`);
    assert.equal(REG.scoreDetail(legacyAttempt), LEG.scoreDetail(legacyAttempt));
  }
});

test("shuffleOptions = 1 / true / missing all mean today's behaviour (options shuffled with the same draws)", () => {
  const q = REG.rowToQuestion({ id: "q1", courseId: "c", type: "mcq", question: "Q", options: JSON.stringify([{ text: "a", ok: true }, { text: "b" }, { text: "c" }, { text: "d" }]), points: null });
  const legacy = LEG.snapshotQuestion(q, {}, shuffleOf(rngOf(5)));
  for (const v of [undefined, null, true, 1]) same(legacy, REG.snapshot(q, { shuffle: shuffleOf(rngOf(5)), shuffleOptions: v, points: null }), `shuffleOptions ${v}`);
  for (const v of [false, 0]) assert.deepEqual(REG.snapshot(q, { shuffle: () => { throw new Error("must not shuffle"); }, shuffleOptions: v, points: null }).options.map((o) => o.text), ["a", "b", "c", "d"]);
});
