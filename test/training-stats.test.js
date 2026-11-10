// 第三批 4.1 / 4.2（2026-10-08）：培训概览统计引擎的纯函数（modules/learning/training-stats.js）。
//   窗口（月 / 季 / 年 / 自定义 / 全部，年与季度边界）、本期应完成 S(W)（含跨期结转）、按日状态、指标与环比（分母为 0 → null）、
//   风险排序（逾期优先，完成率偏低补位只要必修）、热力分档、周一分桶；以及课程类别目录（modules/learning/categories.js）。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const TS = require("../modules/learning/training-stats.js");
const CAT = require("../modules/learning/categories.js");

test("periodWindows: month / quarter / year with the previous window, incl. year and quarter boundaries", () => {
  assert.deepEqual(TS.periodWindows({ period: "month", today: "2026-01-15" }).win, { from: "2026-01-01", to: "2026-01-31" });
  assert.deepEqual(TS.periodWindows({ period: "month", today: "2026-01-15" }).prevWin, { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(TS.periodWindows({ period: "month", today: "2026-03-31" }).prevWin, { from: "2026-02-01", to: "2026-02-28" });
  const q = TS.periodWindows({ period: "quarter", today: "2026-10-08" });
  assert.deepEqual([q.win, q.prevWin, q.base], [{ from: "2026-10-01", to: "2026-12-31" }, { from: "2026-07-01", to: "2026-09-30" }, "quarter"]);
  const q1 = TS.periodWindows({ period: "quarter", today: "2026-02-01" });
  assert.deepEqual([q1.win, q1.prevWin], [{ from: "2026-01-01", to: "2026-03-31" }, { from: "2025-10-01", to: "2025-12-31" }]);
  const y = TS.periodWindows({ period: "year", today: "2026-10-08" });
  assert.deepEqual([y.win, y.prevWin], [{ from: "2026-01-01", to: "2026-12-31" }, { from: "2025-01-01", to: "2025-12-31" }]);
});

test("periodWindows: custom (equal-length previous window), lone ends, invalid → all; no period = all, or custom when from/to given", () => {
  const c = TS.periodWindows({ period: "custom", from: "2026-09-01", to: "2026-09-10", today: "2026-10-08" });
  assert.deepEqual([c.win, c.prevWin], [{ from: "2026-09-01", to: "2026-09-10" }, { from: "2026-08-22", to: "2026-08-31" }]);
  assert.equal(TS.periodWindows({ period: "custom", from: "2026-09-10", to: "2026-09-01", today: "2026-10-08" }).period, "all", "from > to");
  assert.equal(TS.periodWindows({ period: "custom", from: "2020-01-01", to: "2026-01-01", today: "2026-10-08" }).period, "all", "over 3 years");
  const legacy = TS.periodWindows({ from: "2999-01-01", today: "2026-10-08" });
  assert.deepEqual([legacy.period, legacy.win, legacy.prevWin], ["custom", { from: "2999-01-01", to: null }, null]);
  const all = TS.periodWindows({ today: "2026-10-08" });
  assert.deepEqual([all.period, all.win, all.prevWin], ["all", { from: null, to: null }, null]);
  assert.equal(TS.asOfDay({ from: "2026-07-01", to: "2026-09-30" }, "2026-10-08"), "2026-09-30");
  assert.equal(TS.asOfDay({ from: "2026-10-01", to: "2026-12-31" }, "2026-10-08"), "2026-10-08");
});

const cell = (o) => ({ userId: "u", programId: "p", dueDay: null, refDay: "2026-10-05", done: false, doneDay: null, started: false, published: true, mandatory: true, hours: 1, ...o });

test("S(W): in the window by reference day, plus backlog still open at the window start; future window is empty", () => {
  const W = { from: "2026-10-01", to: "2026-12-31" }, today = "2026-10-08";
  assert.equal(TS.inWindowSet(cell({ refDay: "2026-10-05" }), W, today), true);
  assert.equal(TS.inWindowSet(cell({ refDay: "2027-01-02" }), W, today), false, "after the window");
  assert.equal(TS.inWindowSet(cell({ refDay: "2026-08-01" }), W, today), true, "carried over: still open");
  assert.equal(TS.inWindowSet(cell({ refDay: "2026-08-01", done: true, doneDay: "2026-10-02" }), W, today), true, "done during the window counts here");
  assert.equal(TS.inWindowSet(cell({ refDay: "2026-08-01", done: true, doneDay: "2026-09-20" }), W, today), false, "done before the window: last period's");
  assert.equal(TS.inWindowSet(cell({}), { from: "2999-01-01", to: null }, today), false, "a window that has not started is empty");
  assert.equal(TS.inWindowSet(cell({ refDay: "1999-01-01" }), { from: null, to: null }, today), true, "all = everything");
});

test("statusAt: done by the day, overdue only when published and the due day is past, else in progress / not started", () => {
  assert.equal(TS.statusAt(cell({ done: true, doneDay: "2026-10-01" }), "2026-10-08"), "done");
  assert.equal(TS.statusAt(cell({ done: true, doneDay: "2026-10-07", dueDay: "2026-10-03" }), "2026-10-05"), "overdue", "as of an earlier day it was overdue");
  assert.equal(TS.statusAt(cell({ dueDay: "2026-10-07" }), "2026-10-07"), "notstarted", "due today is not overdue yet");
  assert.equal(TS.statusAt(cell({ dueDay: "2026-10-07" }), "2026-10-08"), "overdue");
  assert.equal(TS.statusAt(cell({ dueDay: "2026-10-07", published: false }), "2026-10-08"), "notstarted", "unpublished is never overdue");
  assert.equal(TS.statusAt(cell({ started: true }), "2026-10-08"), "inprog");
});

test("computeKpis: coverage, hours per head, required completion, people overdue, pass rate, deltas and null denominators", () => {
  const today = "2026-10-08";
  const wins = TS.periodWindows({ period: "quarter", today });
  const cells = [
    cell({ userId: "a", done: true, doneDay: "2026-10-02", hours: 2, refDay: "2026-10-02" }),
    cell({ userId: "b", dueDay: "2026-10-03", refDay: "2026-10-03" }),                       // overdue now
    cell({ userId: "b", programId: "q", mandatory: false, done: true, doneDay: "2026-08-10", hours: 3, refDay: "2026-08-10" }), // last quarter
    cell({ userId: "c", dueDay: "2026-09-15", refDay: "2026-09-15" }),                        // overdue since last quarter
  ];
  const k = TS.computeKpis({ cells, H: 4, wins, today, attemptsIn: (w) => (w.from === "2026-10-01" ? { passed: 1, total: 2 } : { passed: 0, total: 0 }) });
  assert.deepEqual([k.coverage.value, k.coverage.num, k.coverage.den], [25, 1, 4]);
  assert.deepEqual([k.coverage.prev, k.coverage.delta], [25, 0], "last quarter: b completed q");
  assert.deepEqual([k.hoursPerHead.value, k.hoursPerHead.prev, k.hoursPerHead.delta], [0.5, 0.8, -0.3]);
  assert.deepEqual([k.requiredCompletion.num, k.requiredCompletion.den, k.requiredCompletion.value], [1, 3, 33.3], "a done; b and c (carried over) open");
  assert.deepEqual([k.overduePeople.value, k.overduePeople.rows], [2, 2]);
  assert.equal(k.overduePeople.prev, 1, "as of 2026-09-30 only c was overdue");
  assert.equal(k.overduePeople.delta, 1);
  assert.deepEqual([k.passRate.value, k.passRate.prev, k.passRate.delta], [50, null, null], "no attempts last quarter → no delta");
  const all = TS.computeKpis({ cells, H: 4, wins: TS.periodWindows({ today }), today, attemptsIn: () => ({ passed: 0, total: 0 }) });
  assert.equal(all.coverage.delta, null, "period all: no deltas");
  assert.equal(all.coverage.num, 2);
  const none = TS.computeKpis({ cells: [], H: 0, wins, today, attemptsIn: () => ({ passed: 0, total: 0 }) });
  assert.deepEqual([none.coverage.value, none.hoursPerHead.value, none.requiredCompletion.value, none.passRate.value], [null, null, null, null]);
});

// 第四批 7（2026-10-08）：自主学习格子（self，mandatory = false，没有截止日）按来源拆分覆盖率与人均学时；
// 不进必修完成率、不逾期（没有截止日）；同一人两边都有完成时两边各算一次、合计只算一次。
test("computeKpis split (batch 4): self-directed cells split coverage and hours; never in required completion or overdue", () => {
  const today = "2026-10-08";
  const wins = TS.periodWindows({ period: "quarter", today });
  const cells = [
    cell({ userId: "a", done: true, doneDay: "2026-10-02", hours: 2, refDay: "2026-10-02" }),
    cell({ userId: "a", programId: "pub", self: true, mandatory: false, dueDay: null, done: true, doneDay: "2026-10-03", hours: 1, refDay: "2026-10-01" }),
    cell({ userId: "b", programId: "pub", self: true, mandatory: false, dueDay: null, done: true, doneDay: "2026-10-04", hours: 1, refDay: "2026-10-01" }),
    cell({ userId: "c", programId: "pub", self: true, mandatory: false, dueDay: null, refDay: "2026-09-01" }),   // 未完成、无截止日
  ];
  const k = TS.computeKpis({ cells, H: 4, wins, today, attemptsIn: () => ({ passed: 0, total: 0 }) });
  assert.deepEqual([k.coverage.num, k.coverage.value], [2, 50], "a and b, a counted once");
  assert.deepEqual(k.coverage.split, { assigned: { num: 1, value: 25 }, self: { num: 2, value: 50 } });
  assert.deepEqual([k.hoursPerHead.num, k.hoursPerHead.value], [4, 1]);
  assert.deepEqual(k.hoursPerHead.split, { assigned: { num: 2, value: 0.5 }, self: { num: 2, value: 0.5 } });
  assert.deepEqual([k.requiredCompletion.num, k.requiredCompletion.den], [1, 1], "self cells are not required");
  assert.equal(k.overduePeople.value, 0, "no due date → never overdue");
  assert.equal(TS.statusAt(cells[3], today), "notstarted");
  const none = TS.computeKpis({ cells: [], H: 0, wins, today, attemptsIn: () => ({ passed: 0, total: 0 }) });
  assert.deepEqual(none.coverage.split, { assigned: { num: 0, value: null }, self: { num: 0, value: null } });
});

test("rankRisk: overdue first (people desc, completion asc), then low-completion fill only for eligible rows with ≥10 assignments and <80%", () => {
  const rows = [
    { id: "a", overduePeople: 3, completion: 50, assigned: 20, kind: "m" },
    { id: "b", overduePeople: 3, completion: 40, assigned: 20, kind: "m" },
    { id: "c", overduePeople: 0, completion: 30, assigned: 12, kind: "e" },
    { id: "d", overduePeople: 0, completion: 60, assigned: 12, kind: "m" },
    { id: "e", overduePeople: 0, completion: 10, assigned: 5, kind: "m" },
    { id: "f", overduePeople: 0, completion: 90, assigned: 50, kind: "m" },
  ];
  const r = TS.rankRisk(rows, { eligible: (x) => x.kind === "m" });
  assert.deepEqual(r.map((x) => [x.id, x.reason]), [["b", "overdue"], ["a", "overdue"], ["d", "lowCompletion"]]);
  assert.equal(TS.rankRisk(rows, { limit: 1 }).length, 1);
});

test("bucketOf / weekBuckets (local Mondays)", () => {
  assert.deepEqual([49.9, 50, 69.9, 70, 84.9, 85, 94.9, 95, null].map(TS.bucketOf), [0, 1, 1, 2, 2, 3, 3, 4, null]);
  const wk = TS.weekBuckets("2026-10-08");   // a Thursday
  assert.equal(wk.weeks.length, 12);
  assert.equal(wk.weeks[11], "2026-10-05", "this week's Monday");
  assert.equal(wk.weeks[0], "2026-07-20");
  assert.equal(wk.idxOf("2026-10-11"), 11);
  assert.equal(wk.idxOf("2026-10-12"), -1, "next week is out");
  assert.equal(wk.idxOf("2026-07-19"), -1);
  assert.equal(TS.dayOf("2026-09-30T17:00:00.000Z"), new Date("2026-09-30T17:00:00.000Z").getTimezoneOffset() === -480 ? "2026-10-01" : TS.dayOf("2026-09-30T17:00:00.000Z"), "UTC instants bucket by the local day (Manila: 10-01)");
});

test("category catalogue: order, en labels, normalisation of en labels and old presets, custom values after 其他, uncategorized last", () => {
  assert.deepEqual(CAT.CATEGORIES.map((c) => c.key), ["合规", "健康与安全", "入职", "领导力", "管理", "专业技术", "产品与业务", "数字与数据", "通用", "团建", "其他"]);
  assert.equal(CAT.normalizeCategory(" Compliance "), "合规");
  assert.equal(CAT.normalizeCategory("team building"), "团建");
  for (const [v, k] of [["Safety", "健康与安全"], ["Skills", "专业技术"], ["Onboarding", "入职"], ["General", "通用"], ["安全", "健康与安全"], ["技能", "专业技术"]]) assert.equal(CAT.normalizeCategory(v), k, v);
  assert.equal(CAT.normalizeCategory("  "), null);
  assert.equal(CAT.normalizeCategory("Esports"), "Esports", "unknown values pass through");
  assert.equal(CAT.normalizeCategory("x".repeat(80)).length, 60);
  assert.deepEqual(["其他", null, "Esports", "合规", "Alpha"].sort(CAT.compareCategory), ["合规", "其他", "Alpha", "Esports", null]);
  assert.equal(CAT.categoryLabel(null, "en"), "Uncategorized");
  assert.equal(CAT.categoryLabel("通用", "en"), "General Skills");
  assert.equal(CAT.categoryLabel("通用", "zh"), "通用");
  const courses = { a: { category: "合规" }, b: { category: "合规" }, c: { category: "入职" } };
  assert.equal(CAT.programCategory({ courseIds: ["a", "b"] }, (id) => courses[id]), "合规");
  assert.equal(CAT.programCategory({ courseIds: ["a", "c"] }, (id) => courses[id]), null);
  assert.equal(CAT.programCategory({ category: "入职", courseIds: ["a"] }, (id) => courses[id]), "入职");
});
