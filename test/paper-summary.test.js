// 组卷页常驻概况（第四批 6.2）：web/src/pages/admin/exam/paperSummary.js 纯函数
//   题数 / 案例组 / 小题数、总分（题目自带分值 → 题型默认分值 → 旧口径）、及格线折算分、题型构成顺序、
//   模块覆盖与 0 题模块、不在关联课程题库里的题（不计入、单独列出）、试卷顺序调整 moveItem。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const lib = () => import(pathToFileURL(path.join(ROOT, "web", "src", "pages", "admin", "exam", "paperSummary.js")).href);

const BANK = [
  { id: "a", type: "mcq", courseId: "C1", moduleId: "M1" },
  { id: "b", type: "multi", courseId: "C1", moduleId: "M1", points: 3 },
  { id: "c", type: "ordering", courseId: "C1", moduleId: "M2" },
  { id: "d", type: "open", courseId: "C1", moduleId: "M3", maxPoints: 20 },
  { id: "e", type: "case", courseId: "C1", moduleId: "M2", points: 99, items: [{ type: "mcq" }, { type: "cloze", points: 4 }, { type: "tf" }] },
  { id: "f", type: "mcq", courseId: "C2", moduleId: "M9" },          // 不在关联课程
  { id: "g", type: "fill", courseId: "C1", moduleId: "M4" },          // M4 有题但不上卷
  { id: "h", type: "mcq", courseId: "C1", moduleId: "M1", unsupported: true },
];

test("paperSummary: counts, items with cases expanded, total from own points → typePoints → defaults, pass-mark points", async () => {
  const { paperSummary } = await lib();
  const tp = { mcq: 2, multi: 1, tf: 1, fill: 1, cloze: 1, ordering: 5, matching: 1, classify: 1, open: 10 };
  const s = paperSummary(["a", "b", "c", "d", "e"], BANK, { typePoints: tp, passingScore: 80, poolCourseIds: ["C1"] });
  assert.equal(s.count, 5);
  assert.equal(s.cases, 1);
  assert.equal(s.items, 7);
  // a 2（题型默认）+ b 3（自带）+ c 5 + d 10 + e (mcq 2 + cloze 4 + tf 1 = 7，案例自身的 99 不计)
  assert.deepEqual(s.points, { a: 2, b: 3, c: 5, d: 10, e: 7 });
  assert.equal(s.total, 27);
  assert.equal(s.passPct, 80);
  assert.equal(s.passPoints, 21.6);
  // typePoints 里缺的键按题型默认（简答 10、其余 1）
  const s2 = paperSummary(["c", "d"], BANK, { typePoints: { mcq: 1 }, passingScore: 60 });
  assert.deepEqual(s2.points, { c: 1, d: 10 });
});

test("paperSummary: legacy points (typePoints null) — objective 1, open maxPoints/10, case sub-questions 1 each", async () => {
  const { paperSummary, pointsOf } = await lib();
  const s = paperSummary(["a", "b", "d", "e"], BANK, { typePoints: null, passingScore: 50 });
  assert.deepEqual(s.points, { a: 1, b: 3, d: 2, e: 6 });
  assert.equal(s.total, 12);
  assert.equal(s.passPoints, 6);
  assert.equal(pointsOf({ type: "open" }, null), 1, "open without maxPoints = 10/10");
  assert.equal(pointsOf(null, null), 0);
});

test("paperSummary: type mix in registry order regardless of paper order", async () => {
  const { paperSummary } = await lib();
  const s = paperSummary(["e", "d", "c", "b", "a", "g"], BANK, { typePoints: {} });
  assert.deepEqual(s.typeMix, [
    { type: "mcq", count: 1 }, { type: "multi", count: 1 }, { type: "fill", count: 1 },
    { type: "ordering", count: 1 }, { type: "open", count: 1 }, { type: "case", count: 1 },
  ]);
});

test("paperSummary: module coverage over the linked courses' bank, zero-question modules listed in bank order", async () => {
  const { paperSummary } = await lib();
  const s = paperSummary(["a", "c"], BANK, { typePoints: {}, poolCourseIds: ["C1"] });
  // 关联课程题库有题的模块：M1 M2 M3 M4（unsupported 的 h 不算，C2 的 M9 不算）
  assert.deepEqual(s.modules, { covered: 2, total: 4, zero: ["M3", "M4"] });
  const all = paperSummary(["a", "c", "d", "g"], BANK, { typePoints: {}, poolCourseIds: ["C1"] });
  assert.deepEqual(all.modules, { covered: 4, total: 4, zero: [] });
});

test("paperSummary: out-of-pool and deleted questions are flagged and excluded from count and total; duplicates count once", async () => {
  const { paperSummary } = await lib();
  const s = paperSummary(["a", "f", "zzz", "a", "h"], BANK, { typePoints: { mcq: 1 }, poolCourseIds: ["C1"], passingScore: 100 });
  assert.equal(s.count, 1);
  assert.equal(s.total, 1);
  assert.deepEqual(s.outOfPool, ["f", "zzz", "h"]);
  assert.deepEqual(s.missing, ["zzz"]);
  // 题型未开放也算不在题库里
  const d = paperSummary(["c"], BANK, { typePoints: {}, enabled: ["mcq", "multi", "fill", "open"] });
  assert.deepEqual(d.outOfPool, ["c"]);
  // 空卷
  const e = paperSummary([], BANK, { typePoints: {}, passingScore: 80 });
  assert.equal(e.total, 0);
  assert.equal(e.passPoints, null);
});

test("moveItem: up / down / to position, clamped at both ends, original untouched", async () => {
  const { moveItem } = await lib();
  const a = ["p", "q", "r", "s"];
  assert.deepEqual(moveItem(a, 0, 1), ["q", "p", "r", "s"]);
  assert.deepEqual(moveItem(a, 3, 0), ["s", "p", "q", "r"]);
  assert.deepEqual(moveItem(a, 1, 99), ["p", "r", "s", "q"]);
  assert.deepEqual(moveItem(a, 2, -5), ["r", "p", "q", "s"]);
  assert.deepEqual(moveItem(a, 9, 0), a);
  assert.deepEqual(a, ["p", "q", "r", "s"]);
});
