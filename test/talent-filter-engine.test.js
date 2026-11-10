// 第 5 批 8.1（2026-10-08）：人才筛选评估引擎（modules/talent/filter-engine.js）的纯函数。
//   每个字段、每个运算符的语义（评级按选项下标、近 N 期三种 mode 与 missing、periodKind、日历满月司龄与 2-29、九宫格、
//   潜力 freshOnly、违纪与荣誉的时间窗和严重度、record 字段值中英文归一、自定义字段各输入类型、培训用伪造的完成口径）；
//   且 / 或 / 条件组；忽略（模块关闭）与值不可用的区别；explain；人工名单的优先顺序；loader 按需且最多一次；
//   1,000 人 × 20 条的耗时上限；口径对照（迁移后的默认筛选 ≡ 按设置页文案写的旧规则，逐人一致）；分页、排序、导出单元格。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../modules/talent/filter-model.js");
const E = require("../modules/talent/filter-engine.js");

const TODAY = "2026-10-08";
const RANKS = [
  { rank: "PD1", grade: "D", level: 1, track: "P" }, { rank: "PD2", grade: "D", level: 2, track: "P" },
  { rank: "PC1", grade: "C", level: 3, track: "P" }, { rank: "PC2", grade: "C", level: 4, track: "P" },
  { rank: "MC1", grade: "C", level: 5, track: "M" }, { rank: "MC3", grade: "C", level: 5, track: "M" },
  { rank: "MC2", grade: "C", level: 5, track: "M" }, { rank: "MB3", grade: "B", level: 6, track: "M" },
];
const RECORD_TYPES = [
  { key: "performance", label: "Performance", label_zh: "绩效", fields: [
    { key: "period", input: "text" },
    { key: "rating", input: "select", options: ["A+", "A", "B+", "B", "C", "D"] }] },
  { key: "award", label: "Award", label_zh: "荣誉", fields: [{ key: "awardName", input: "suggest", options: ["Top learner", "Most improved"], options_zh: ["优秀学员", "最佳进步"] }] },
  { key: "violation", label: "Violation", label_zh: "违纪", fields: [{ key: "severity", input: "select", options: ["Minor", "Major"], options_zh: ["轻微", "重大"] }] },
  { key: "promotion", label: "Promotion", label_zh: "晋升", fields: [
    { key: "result", label: "Result", label_zh: "结果", input: "select", options: ["Passed", "Failed"], options_zh: ["通过", "未通过"], filterable: true },
    { key: "method", label: "Method", label_zh: "方式", input: "select", options: ["Defense", "Direct"], options_zh: ["答辩", "直接"] }] },
  { key: "culture-program", label: "Behavior practice", label_zh: "行为实践", moduleOff: true, fields: [] },
];
const CUSTOM = [
  { key: "lang", label: "Language", label_zh: "语言", input: "select", options: ["English", "Tagalog"], options_zh: ["英语", "他加禄语"] },
  { key: "cert", label: "Certificate", label_zh: "证书", input: "text" },
  { key: "score", label: "Score", label_zh: "分数", input: "number" },
  { key: "certDate", label: "Cert date", label_zh: "取证日期", input: "date" },
  { key: "remote", label: "Remote", label_zh: "远程", input: "checkbox" },
  { key: "targetLevel", label: "Target level", label_zh: "目标职级", input: "level" },
  { key: "homeDept", label: "Home dept", label_zh: "归属部门", input: "department" },
];
const ALL_ON = { performance: true, learning: true, talent: true };
function catalog(mods, extra) {
  return M.buildCatalog({
    modules: mods || ALL_ON, ranks: RANKS, recordTypes: RECORD_TYPES, customFields: CUSTOM,
    deptOptions: [{ id: "d-fin", name: "Finance", path: "Finance" }, { id: "d-ap", name: "Finance AP", path: "Finance › Finance AP" }, { id: "d-sales", name: "Sales", path: "Sales" }],
    programs: [{ id: "p1", title: "Safety" }, { id: "p2", title: "Leadership" }, { id: "p3", title: "Excel" }],
    ...(extra || {}),
  });
}
const CAT = catalog();

const USERS = [
  { id: "u1", name: "Ana", employeeId: "T-1", department: "Finance", jobLevel: "PD1", position: "Analyst", managerId: "u5", hireDate: "2024-05-20", empStatus: "regular",
    potential: "High", potentialAt: "2026-03-01T02:00:00Z", talentTags: JSON.stringify(["Successor", "Mobile"]),
    extras: JSON.stringify({ lang: "English", cert: "CPA Board", score: 88, certDate: "2026-01-15", remote: true, targetLevel: "pd2", homeDept: "finance" }) },
  { id: "u2", name: "Ben", employeeId: "T-2", department: "Finance AP", jobLevel: "PD2", position: "AP Clerk", managerId: "u5", hireDate: "2025-10-20", empStatus: "probation",
    potential: "Medium", potentialAt: "2024-01-01", talentTags: JSON.stringify(["Mobile"]), extras: JSON.stringify({ lang: "Tagalog", score: "55", remote: false }) },
  { id: "u3", name: "Cy", employeeId: "T-3", department: "Sales", jobLevel: "PC2", position: "Sales Lead", managerId: "u6", hireDate: "2016-01-05", empStatus: "regular",
    potential: "Low", potentialAt: "2026-01-01" },
  { id: "u4", name: "Di", employeeId: "T-4", department: "", jobLevel: "V4", position: null, managerId: null, hireDate: null, empStatus: null },
  { id: "u5", name: "Ed", employeeId: "T-5", department: "Finance", jobLevel: "MC2", position: "Finance Manager", managerId: null, hireDate: "2019-07-15", empStatus: "regular", potential: "High", potentialAt: null },
  { id: "u6", name: "Fay", employeeId: "T-6", department: "Ops", jobLevel: "MB3", managerId: null, hireDate: "2015-03-01", empStatus: "exited", active: 0 },
  { id: "u7", name: "Root", employeeId: "ADMIN", role: "admin" },
  { id: "u8", name: "Gus", employeeId: "T-8", department: "Legacy", jobLevel: "", position: "Intern", managerId: null, hireDate: "2026-09-01", empStatus: "regular" },
];
const POP = E.basePopulation(USERS);
const REC = {
  performance: [
    { id: "pf1", userId: "u1", date: "2026-06-30", detail: { rating: "A", period: "2026 H1 review" } },
    { id: "pf3", userId: "u1", date: "2025-12-31", detail: { rating: "A+", period: "2025 Annual" } },
    { id: "pf2", userId: "u1", date: "2026-03-31", detail: { rating: "B+", period: "2026 Q1" } },
    { id: "pf4", userId: "u2", date: "2026-06-30", detail: { rating: "B" } },
    { id: "pf5", userId: "u3", date: "2026-06-30", detail: { rating: "C" } },
    { id: "pf6", userId: "u3", date: "2026-03-31", detail: { rating: "A" } },
    { id: "pf7", userId: "u5", date: "2026-06-30", detail: { rating: "A+" } },
    { id: "pf8", userId: "u5", date: "2025-12-31", detail: { rating: "A", period: "FY2025" } },
    { id: "pf9", userId: "u6", date: "2026-06-30", detail: { rating: "A+" } },
  ],
  award: [
    { id: "aw1", userId: "u1", date: "2026-01-10", detail: { awardName: "优秀学员" } },
    { id: "aw2", userId: "u1", date: "2024-01-10", detail: { awardName: "Top learner" } },
    { id: "aw3", userId: "u3", date: "2026-05-05", detail: { awardName: "Hackathon" } },
  ],
  violation: [
    { id: "v1", userId: "u2", date: "2026-02-02", detail: { severity: "Minor" } },
    { id: "v2", userId: "u3", date: "2025-12-01", detail: { severity: "Major 重大" } },
    { id: "v3", userId: "u5", date: "2024-06-01", detail: { severity: "Major" } },
  ],
  promotion: [
    { id: "pr1", userId: "u1", date: "2025-06-01", detail: { result: "Passed", method: "Defense" } },
    { id: "pr2", userId: "u2", date: "2025-07-01", detail: { result: "Failed" } },
  ],
  "culture-program": [{ id: "cp1", userId: "u1", date: "2026-05-01", detail: {} }],
};
const ASG = {
  u1: [{ programId: "p1", mandatory: true, done: true }, { programId: "p2", mandatory: false, done: false }, { programId: "p3", mandatory: true, self: true, done: false }],
  u2: [{ programId: "p1", mandatory: true, done: false }],
  u5: [{ programId: "p1", mandatory: true, done: true }, { programId: "p2", mandatory: true, done: true }],
};
const DONE = { u1: ["p1"], u3: ["p3"], u5: ["p1", "p2"] };
const SUCC = [{ id: "s1", userId: "u1", positionName: "Head of Finance" }, { id: "s2", userId: "u6", positionName: "Ops Lead" }, { id: "s3", userId: "u5", positionName: "COO" }];
function makeLoaders(spy) {
  const hit = (k) => { if (spy) spy[k] = (spy[k] || 0) + 1; };
  return {
    records: (type) => { hit("records:" + type); return REC[type] || []; },
    periodKinds: () => { hit("periodKinds"); return { pf1: "quarter", pf7: "quarter" }; },
    training: () => { hit("training"); return { assignments: (uid) => ASG[uid] || [], programDone: (uid, pid) => (DONE[uid] || []).includes(pid) }; },
    succession: () => { hit("succession"); return SUCC; },
    users: () => { hit("users"); return USERS; },
  };
}
const DEPTS = { "d-fin": ["finance", "finance ap"], "d-ap": ["finance ap"], "d-sales": ["sales"] };
function deptParse(id) {
  if (id === "__none") return (d) => !String(d || "").trim();
  if (String(id).startsWith("name:")) { const w = String(id).slice(5); return (d) => String(d || "").trim().toLowerCase() === w; }
  const names = DEPTS[id];
  return names ? (d) => names.includes(String(d || "").trim().toLowerCase()) : null; // d-ops：范围外 → null
}
function mk(items, logic, cat) {
  const r = M.validateFilter({ v: 1, logic: logic || "and", items }, cat || CAT);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.filter;
}
function runF(items, o = {}) {
  return E.run({
    population: o.population || POP, filter: mk(items, o.logic, o.catalog), catalog: o.catalog || CAT,
    ctx: { today: TODAY, deptParse, inScope: o.inScope || null }, loaders: o.loaders || makeLoaders(), members: o.members,
    all: true, columns: o.columns || ["name"], explain: o.explain, includeUnmatched: o.includeUnmatched, sort: o.sort,
  });
}
const ids = (items, o) => runF(items, o).rows.map((r) => r.id).sort();
const leaf = (field, op, value, params) => ({ field, op, ...(value !== undefined ? { value } : {}), ...(params ? { params } : {}) });

test("dates: calendar full months (incl. 2-29 and month ends), months-before, period kinds from text", () => {
  assert.equal(E.fullMonths("2025-10-08", TODAY), 12);
  assert.equal(E.fullMonths("2025-10-09", TODAY), 11);
  assert.equal(E.fullMonths("2024-02-29", "2025-02-28"), 11);
  assert.equal(E.fullMonths("2024-02-29", "2025-03-01"), 12);
  assert.equal(E.fullMonths("2026-01-31", "2026-02-28"), 0);
  assert.equal(E.fullMonths("2026-01-31", "2026-03-01"), 1);
  assert.equal(E.fullMonths("2027-01-01", TODAY), 0);
  assert.equal(E.fullMonths(null, TODAY), null);
  assert.equal(E.monthsBefore("2026-03-31", 1), "2026-02-28");
  assert.equal(E.monthsBefore("2024-03-31", 1), "2024-02-29");
  assert.equal(E.monthsBefore(TODAY, 12), "2025-10-08");
  assert.equal(E.monthsBefore("2026-01-15", 13), "2024-12-15");
  assert.deepEqual(["2026 Q1", "第三季度", "2026 H1", "上半年", "2025 Annual", "2025 年度", "FY2025", "2025", ""].map(E.periodKindOfText),
    ["quarter", "quarter", "half", "half", "annual", "annual", "annual", null, null]);
});

test("job-grade ladder: next rank per track with the same ordering as nextRankOf; ranksInRange", () => {
  const L = E.buildLadder(RANKS);
  assert.deepEqual(["PD1", "PD2", "PC1", "PC2"].map((r) => L.info(r).next), ["PD2", "PC1", "PC2", null]);
  assert.deepEqual(["MC3", "MC2", "MC1", "MB3"].map((r) => L.info(r).next), ["MC2", "MC1", "MB3", null]);
  assert.equal(L.info("pd1").rank, "PD1");
  assert.equal(L.info("V4"), null);
  assert.equal(L.info(""), null);
  assert.deepEqual(E.ranksInRange(RANKS, "PD2", "PC2"), ["PD2", "PC1", "PC2"]);
  assert.deepEqual(E.ranksInRange(RANKS, "PD1", "X9"), ["PD1", "X9"]);
});

test("basePopulation: in service, not admin, scope applied once; includeExited adds exited people", () => {
  assert.deepEqual(POP.map((u) => u.id), ["u1", "u2", "u3", "u4", "u5", "u8"]);
  assert.deepEqual(E.basePopulation(USERS, { includeExited: true }).map((u) => u.id), ["u1", "u2", "u3", "u4", "u5", "u6", "u8"]);
  assert.deepEqual(E.basePopulation(USERS, { inScope: (u) => u.department === "Finance" }).map((u) => u.id), ["u1", "u5"]);
});

test("organization fields: dept (incl. sub-units, __none, name:, out of scope), position, retired isManager, manager, empStatus", () => {
  assert.deepEqual(ids([leaf("dept", "in", ["d-fin"])]), ["u1", "u2", "u5"]);
  assert.deepEqual(ids([leaf("dept", "in", ["d-ap"])]), ["u2"]);
  assert.deepEqual(ids([leaf("dept", "notIn", ["d-fin"])]), ["u3", "u4", "u8"]);
  assert.deepEqual(ids([leaf("dept", "in", ["__none"])]), ["u4"]);
  assert.deepEqual(ids([leaf("dept", "in", ["name:legacy"])]), ["u8"]);
  // 范围外 / 已删除的部门：值不可用，不能当成「不筛选」
  const r = runF([leaf("dept", "in", ["d-ops"])]);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.warnings, [{ id: "c1", code: "value_unavailable", count: 1 }]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(ids([leaf("dept", "notIn", ["d-ops"])]), [], "notIn with nothing usable left still matches nobody");
  assert.deepEqual(ids([leaf("dept", "in", ["d-ops", "d-sales"])]), ["u3"]);
  assert.deepEqual(ids([leaf("position", "contains", "analyst")]), ["u1"]);
  assert.deepEqual(ids([leaf("position", "in", ["ap clerk", "Sales Lead"])]), ["u2", "u3"]);
  // F61：「管理者 / 个人贡献者」已停用（并入职级通道，见 jobTrack 用例）：叶子被忽略、警告 field_retired，不按直属下属人数筛人
  const retired = runF([leaf("isManager", "isTrue")]);
  assert.deepEqual(retired.rows.map((x) => x.id), ["u1", "u2", "u3", "u4", "u5", "u8"]);
  assert.deepEqual(retired.skipped, [{ id: "c1", reason: "field_retired" }]);
  assert.deepEqual(retired.warnings, [{ id: "c1", code: "field_retired" }]);
  assert.deepEqual(ids([leaf("manager", "in", ["u5"])]), ["u1", "u2"]);
  assert.deepEqual(ids([leaf("manager", "in", ["u6"])]), ["u3"]);
  assert.deepEqual(ids([leaf("manager", "in", ["u6"])], { inScope: (m) => m.department !== "Ops" }), [], "out-of-scope manager = value unavailable");
  assert.deepEqual(ids([leaf("manager", "in", ["nobody"])]), []);
  assert.deepEqual(ids([leaf("empStatus", "in", ["probation"])]), ["u2"]);
  assert.deepEqual(ids([leaf("empStatus", "in", ["__none"])]), ["u4"]);
  assert.deepEqual(ids([leaf("empStatus", "in", ["exited"])], { population: E.basePopulation(USERS, { includeExited: true }) }), ["u6"]);
});

test("job level fields: jobLevel in / notIn / between, jobGrade (__nogrid, __none), jobTrack, nextLevelExists + unmapped", () => {
  assert.deepEqual(ids([leaf("jobLevel", "in", ["pd1"])]), ["u1"]);
  assert.deepEqual(ids([leaf("jobLevel", "notIn", ["PD1"])]), ["u2", "u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("jobLevel", "between", { from: "PD2", to: "PC2" })]), ["u2", "u3"]);
  assert.deepEqual(ids([leaf("jobGrade", "in", ["D"])]), ["u1", "u2"]);
  assert.deepEqual(ids([leaf("jobGrade", "in", ["C"])]), ["u3", "u5"]);
  assert.deepEqual(ids([leaf("jobGrade", "in", ["__nogrid"])]), ["u4"]);
  assert.deepEqual(ids([leaf("jobGrade", "in", ["__none"])]), ["u8"]);
  assert.deepEqual(ids([leaf("jobGrade", "notIn", ["D", "__none"])]), ["u3", "u4", "u5"]);
  assert.deepEqual(ids([leaf("jobTrack", "in", ["M"])]), ["u5"]);
  assert.deepEqual(ids([leaf("jobTrack", "in", ["P"])]), ["u1", "u2", "u3"]);
  const r = runF([leaf("nextLevelExists", "isTrue")]);
  assert.deepEqual(r.rows.map((x) => x.id).sort(), ["u1", "u2", "u5"]);
  assert.deepEqual(r.unmapped.map((x) => x.id).sort(), ["u4", "u8"]);
  assert.deepEqual(r.unmapped.find((x) => x.id === "u4"), { id: "u4", name: "Di", employeeId: "T-4", jobLevel: "V4" });
  assert.deepEqual(ids([leaf("nextLevelExists", "isFalse")]), ["u3", "u4", "u8"]);
  assert.equal(runF([leaf("jobTrack", "in", ["M"])]).unmapped, undefined, "unmapped only when nextLevelExists is used");
});

test("tenureMonths: calendar months, gte / lte / between; no hire date never matches", () => {
  // u1 28 · u2 11 · u3 129 · u5 86 · u8 1 · u4 no date
  assert.deepEqual(ids([leaf("tenureMonths", "gte", 12)]), ["u1", "u3", "u5"]);
  assert.deepEqual(ids([leaf("tenureMonths", "lte", 11)]), ["u2", "u8"]);
  assert.deepEqual(ids([leaf("tenureMonths", "between", { from: 11, to: 28 })]), ["u1", "u2"]);
  assert.deepEqual(ids([leaf("tenureMonths", "gte", 0)]), ["u1", "u2", "u3", "u5", "u8"]);
});

test("F62 perfRecent withinMonths: every rating inside the window; no rating in the window follows missing", () => {
  // TODAY 2026-10-08；12 个月窗 = 2025-10-08 起。u1 A / B+ / A+（都在窗内）、u2 B、u3 C + A、u5 A+ / A、u4 / u8 无记录
  const P = (params) => [leaf("perfRecent", "atLeast", "B", params)];
  assert.deepEqual(ids(P({ withinMonths: 12, mode: "all", missing: "ignore" })), ["u1", "u2", "u4", "u5", "u8"], "u3 has a C inside the window; people without ratings pass with missing = ignore");
  assert.deepEqual(ids(P({ withinMonths: 12, mode: "all", missing: "fail" })), ["u1", "u2", "u5"]);
  assert.deepEqual(ids(P({ withinMonths: 12, mode: "any" })), ["u1", "u2", "u3", "u5"], "any: u3's A counts");
  assert.deepEqual(ids(P({ withinMonths: 3, mode: "all", missing: "ignore" })), ["u1", "u2", "u3", "u4", "u5", "u8"], "nobody has a rating after 2026-07-08 → everyone passes");
  assert.deepEqual(ids(P({ withinMonths: 3, mode: "all", missing: "fail" })), []);
  // n 在时间窗模式下不生效（窗内全部记录）：u1 n=1 也要看 3 条
  assert.deepEqual(ids([leaf("perfRecent", "atLeast", "A", { withinMonths: 12, n: 1, mode: "all" })]), ["u5"], "u1's B+ is inside the window → not all ≥ A");
  assert.deepEqual(ids([leaf("perfRecent", "atLeast", "A", { n: 1 })]), ["u1", "u5"], "without the window the latest rating alone is checked");
  // 近 2 期任一期 ≥ B+（F62 条件 ③，missing = ignore 让只有 1 期评级的人也能判）：u2 只有一期 B → 不满足；u3 A 在第 2 期 → 满足
  assert.deepEqual(ids([leaf("perfRecent", "atLeast", "B+", { n: 2, mode: "any", missing: "ignore" })]), ["u1", "u3", "u5"]);
});

test("F62 levelTenureMonths: months since the last level-changing promotion / transfer, else hire date; boundaries", () => {
  // TODAY 2026-10-08。u1：晋升 2025-10-08（PC3 → PD1，通过）= 恰好 12 个月；u2：晋升未通过 → 按入职 2025-10-20 = 11 个月；
  // u3：调动 2026-01-05 带职级变化（PC1 → PC2）比 2020 年的晋升新 → 9 个月；u5：晋升记录职级没变 → 按入职 2019-07-15 = 86；
  // u8：没有记录 → 入职 2026-09-01 = 1；u4：没有入职日期 → 永不匹配
  const recs = {
    promotion: [
      { id: "lp1", userId: "u1", date: "2025-10-08", detail: { fromLevel: "PC3", toLevel: "PD1", result: "Passed" } },
      { id: "lp2", userId: "u2", date: "2026-01-01", detail: { fromLevel: "PD2", toLevel: "PD1", result: "未通过 Failed" } },
      { id: "lp3", userId: "u3", date: "2020-01-05", detail: { fromLevel: "PB1", toLevel: "PC1", result: "Passed" } },
      { id: "lp4", userId: "u5", date: "2025-11-08", detail: { fromLevel: "mc2", toLevel: "MC2", result: "Passed" } },
    ],
    transfer: [
      { id: "lt1", userId: "u3", date: "2026-01-05", detail: { fromDept: "Ops", toDept: "Sales", fromLevel: "PC1", toLevel: "PC2" } },
      { id: "lt2", userId: "u1", date: "2026-05-01", detail: { fromDept: "Ops", toDept: "Finance" } },
    ],
  };
  const loaders = { ...makeLoaders(), records: (t) => recs[t] || REC[t] || [] };
  const L = (op, v) => [leaf("levelTenureMonths", op, v)];
  assert.deepEqual(ids(L("gte", 12), { loaders }), ["u1", "u5"], "exactly 12 months counts as met");
  assert.deepEqual(ids(L("gte", 13), { loaders }), ["u5"]);
  assert.deepEqual(ids(L("lte", 11), { loaders }), ["u2", "u3", "u8"]);
  assert.deepEqual(ids(L("between", { from: 9, to: 12 }), { loaders }), ["u1", "u2", "u3"]);
  const r = runF([leaf("tenureMonths", "gte", 0)], { loaders, columns: ["name", "levelTenure", "tenure"] });
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x.values.levelTenure]));
  assert.deepEqual(by, { u1: 12, u2: 11, u3: 9, u5: 86, u8: 1 }, "u4 has no date and no row");
  assert.equal(E.columnText("levelTenure", 12, CAT, "zh"), "1 年 0 个月");
  assert.equal(E.levelSinceDay(USERS[0], E.createFacts(POP, loaders, { today: TODAY })), "2025-10-08");
});

test("perfRecent: rating order follows the option list; last N periods with all / any / atLeastK; missing fail / ignore; periodKind; noRecord", () => {
  const P = (op, value, params) => [leaf("perfRecent", op, value, params)];
  assert.deepEqual(ids(P("atLeast", "B+")), ["u1", "u5"]);
  assert.deepEqual(ids(P("atMost", "B")), ["u2", "u3"]);
  assert.deepEqual(ids(P("in", ["A", "A+"])), ["u1", "u5"]);
  assert.deepEqual(ids(P("atLeast", "A", { n: 2 })), ["u5"]);
  assert.deepEqual(ids(P("atLeast", "A", { n: 2, mode: "any" })), ["u1", "u3", "u5"]);
  assert.deepEqual(ids(P("atLeast", "B", { n: 2 })), ["u1", "u5"]);
  assert.deepEqual(ids(P("atLeast", "B", { n: 2, missing: "ignore" })), ["u1", "u2", "u5"]);
  assert.deepEqual(ids(P("atLeast", "A", { n: 3, mode: "atLeastK", k: 2 })), ["u1"]);
  assert.deepEqual(ids(P("atLeast", "A", { n: 3, mode: "atLeastK", k: 2, missing: "ignore" })), ["u1", "u5"]);
  // periodKind：周期归档的按周期 kind（periodKinds），导入的按 detail.period 文字；认不出的不计入
  // u1：pf1（周期 kind = quarter）A + pf2（文字 Q1）B+ → 近 2 个季度均 ≥ B+；u5 只有 1 个季度 → missing = fail 不满足
  assert.deepEqual(ids(P("atLeast", "B+", { n: 2, periodKind: "quarter" })), ["u1"]);
});

test("perfRecent periodKind details", () => {
  const P = (op, value, params) => [leaf("perfRecent", op, value, params)];
  // u1 季度：pf1（周期 kind=quarter）A、pf2（文字 Q1）B+ → 近 2 个季度均 ≥ B+
  assert.deepEqual(ids(P("atLeast", "B+", { n: 2, periodKind: "quarter", missing: "ignore" })), ["u1", "u5"]);
  assert.deepEqual(ids(P("atLeast", "B+", { n: 1, periodKind: "half" })), [], "pf1 is a quarter by its cycle even though its text says H1");
  assert.deepEqual(ids(P("atLeast", "A", { n: 1, periodKind: "annual" })), ["u1", "u5"]);
  assert.deepEqual(ids(P("noRecord", undefined)), ["u4", "u8"]);
  assert.deepEqual(ids(P("noRecord", undefined, { periodKind: "annual" })), ["u2", "u3", "u4", "u8"]);
});

test("potential (freshOnly = assessed within 12 months) and the 9-box cell", () => {
  assert.deepEqual(ids([leaf("potential", "in", ["High"])]), ["u1", "u5"]);
  assert.deepEqual(ids([leaf("potential", "in", ["High"], { freshOnly: true })]), ["u1"]);
  assert.deepEqual(ids([leaf("potential", "in", ["__none"], { freshOnly: true })]), ["u2", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("potential", "in", ["Low", "Medium"])]), ["u2", "u3"]);
  assert.deepEqual(ids([leaf("nineBox", "in", ["2-2"])]), ["u1", "u5"]);
  assert.deepEqual(ids([leaf("nineBox", "in", ["1-1", "0-0"])]), ["u2", "u3"]);
  assert.deepEqual(ids([leaf("nineBox", "in", ["__unplaced"])]), ["u4", "u8"]);
});

test("training: required-only completion excludes electives and self-enrolled; completion %, completed courses, unknown course", () => {
  assert.deepEqual(ids([leaf("trainingMandatoryDone", "isTrue")]), ["u1", "u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("trainingMandatoryDone", "isFalse")]), ["u2"]);
  assert.deepEqual(ids([leaf("trainingCompletion", "gte", 100)]), ["u1", "u5"]);
  assert.deepEqual(ids([leaf("trainingCompletion", "gte", 60, { scope: "all" })]), ["u5"]);
  assert.deepEqual(ids([leaf("trainingCompletion", "lte", 50, { scope: "all" })]), ["u1", "u2"]);
  assert.deepEqual(ids([leaf("trainingProgram", "allOf", ["p1", "p2"])]), ["u5"]);
  assert.deepEqual(ids([leaf("trainingProgram", "anyOf", ["p3"])]), ["u3"]);
  assert.deepEqual(ids([leaf("trainingProgram", "noneOf", ["p1"])]), ["u2", "u3", "u4", "u8"]);
  const r = runF([leaf("trainingProgram", "anyOf", ["p9", "p3"])]);
  assert.deepEqual(r.rows.map((x) => x.id), ["u3"]);
  assert.deepEqual(r.warnings, [{ id: "c1", code: "value_unavailable", count: 1 }]);
  assert.deepEqual(ids([leaf("trainingProgram", "anyOf", ["p9"])]), []);
});

test("awards and violations: time window, award names in either language, severity incl. legacy 'Major 重大'", () => {
  assert.deepEqual(ids([leaf("award", "countAtLeast", 1, { months: 12 })]), ["u1", "u3"]);
  assert.deepEqual(ids([leaf("award", "countAtLeast", 2)]), ["u1"]);
  assert.deepEqual(ids([leaf("award", "countAtLeast", 2, { names: ["Top learner"] })]), ["u1"]);
  assert.deepEqual(ids([leaf("award", "countAtLeast", 1, { names: ["优秀学员"], months: 12 })]), ["u1"]);
  assert.deepEqual(ids([leaf("award", "none", undefined, { months: 12 })]), ["u2", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("violation", "none", undefined, { months: 12 })]), ["u1", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("violation", "none", undefined, { months: 12, severity: ["Major"] })]), ["u1", "u2", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("violation", "none", undefined, { months: 12, severity: ["重大"] })]), ["u1", "u2", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("violation", "countAtLeast", 1)]), ["u2", "u3", "u5"]);
  assert.deepEqual(ids([leaf("violation", "countAtLeast", 1, { severity: ["Minor"] })]), ["u2"]);
});

test("record (generic profile records): field values normalized from Chinese, months window, exists / notExists / countAtLeast; switched-off type is ignored", () => {
  assert.deepEqual(ids([leaf("record", "exists", undefined, { type: "promotion", fields: { result: "通过" } })]), ["u1"]);
  assert.deepEqual(ids([leaf("record", "exists", undefined, { type: "promotion", fields: { result: "Failed", method: "Direct" } })]), []);
  assert.deepEqual(ids([leaf("record", "notExists", undefined, { type: "promotion" })]), ["u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("record", "countAtLeast", 1, { type: "promotion", months: 12 })]), []);
  assert.deepEqual(ids([leaf("record", "countAtLeast", 1, { type: "promotion", months: 18 })]), ["u1", "u2"]);
  // 保存时还开着、现在关掉了的类型：lenient 校验 + 引擎忽略（不是「不匹配任何人」）
  const f = M.validateFilter({ v: 1, logic: "and", items: [leaf("record", "exists", undefined, { type: "culture-program" })] }, CAT, { lenient: true });
  assert.ok(f.ok);
  const r = E.run({ population: POP, filter: f.filter, catalog: CAT, ctx: { today: TODAY, deptParse }, loaders: makeLoaders(), all: true, columns: ["name"] });
  assert.equal(r.rows.length, POP.length);
  assert.deepEqual(r.skipped, [{ id: "c1", reason: "module_off" }]);
});

test("talent tags and succession (position compared case- / space- / hyphen-insensitively)", () => {
  assert.deepEqual(ids([leaf("talentTag", "anyOf", ["successor"])]), ["u1"]);
  assert.deepEqual(ids([leaf("talentTag", "allOf", ["Successor", "Mobile"])]), ["u1"]);
  assert.deepEqual(ids([leaf("talentTag", "noneOf", ["mobile"])]), ["u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("succession", "listed")]), ["u1", "u5"]);
  assert.deepEqual(ids([leaf("succession", "listed", undefined, { position: "head-of  FINANCE" })]), ["u1"]);
  assert.deepEqual(ids([leaf("succession", "notListed")]), ["u2", "u3", "u4", "u8"]);
});

test("custom fields: select (zh label), text, number, date, checkbox, level, department", () => {
  assert.deepEqual(ids([leaf("custom:lang", "in", ["英语"])]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:lang", "notIn", ["English"])]), ["u2", "u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("custom:cert", "contains", "cpa")]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:cert", "equals", "cpa board")]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:cert", "isEmpty")]), ["u2", "u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("custom:cert", "notEmpty")]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:score", "gte", 60)]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:score", "between", { from: 50, to: 60 })]), ["u2"]);
  assert.deepEqual(ids([leaf("custom:score", "isEmpty")]), ["u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("custom:certDate", "onOrAfter", "2026-01-01")]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:certDate", "onOrBefore", "2025-12-31")]), []);
  assert.deepEqual(ids([leaf("custom:certDate", "between", { from: "2026-01-01", to: "2026-01-31" })]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:certDate", "withinMonths", 12)]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:certDate", "withinMonths", 6)]), []);
  assert.deepEqual(ids([leaf("custom:remote", "isTrue")]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:remote", "isFalse")]), ["u2", "u3", "u4", "u5", "u8"]);
  assert.deepEqual(ids([leaf("custom:targetLevel", "in", ["PD2"])]), ["u1"]);
  assert.deepEqual(ids([leaf("custom:homeDept", "equals", "Finance")]), ["u1"]);
  // 字段已删除：lenient 下忽略并警告 field_removed
  const f = M.validateFilter({ v: 1, logic: "and", items: [leaf("custom:gone", "contains", "x"), leaf("dept", "in", ["d-sales"])] }, CAT, { lenient: true });
  const r = E.run({ population: POP, filter: f.filter, catalog: CAT, ctx: { today: TODAY, deptParse }, loaders: makeLoaders(), all: true, columns: ["name"] });
  assert.deepEqual(r.rows.map((x) => x.id), ["u3"]);
  assert.deepEqual(r.skipped, [{ id: "c1", reason: "field_removed" }]);
  assert.ok(r.warnings.some((w) => w.code === "field_removed"));
});

test("and / or / groups; ignored (module off) vs value unavailable; a group whose leaves are all ignored counts as met", () => {
  assert.deepEqual(ids([leaf("dept", "in", ["d-fin"]), leaf("potential", "in", ["High"])]), ["u1", "u5"]);
  assert.deepEqual(ids([leaf("dept", "in", ["d-fin"]), leaf("potential", "in", ["High"])], { logic: "or" }), ["u1", "u2", "u5"]);
  assert.deepEqual(ids([leaf("jobTrack", "in", ["P"]), { logic: "or", items: [leaf("potential", "in", ["High"]), leaf("tenureMonths", "gte", 100)] }]), ["u1", "u3"]);
  const perfOff = catalog({ performance: false, learning: true, talent: true });
  // 绩效模块关闭：评级叶子被忽略（不是「没人满足」）
  const r1 = runF([leaf("perfRecent", "atLeast", "A+"), leaf("dept", "in", ["d-fin"])], { catalog: perfOff });
  assert.deepEqual(r1.rows.map((x) => x.id).sort(), ["u1", "u2", "u5"]);
  assert.deepEqual(r1.skipped, [{ id: "c1", reason: "module_off" }]);
  assert.deepEqual(r1.warnings, [{ id: "c1", code: "module_off" }]);
  assert.deepEqual(ids([leaf("dept", "in", ["d-fin"]), { logic: "or", items: [leaf("perfRecent", "atLeast", "A+"), leaf("nineBox", "in", ["2-2"])] }], { catalog: perfOff }), ["u1", "u2", "u5"]);
  // 全部条件都被忽略 = 全部人员
  assert.equal(runF([leaf("perfRecent", "atLeast", "A+")], { catalog: perfOff, logic: "or" }).rows.length, POP.length);
  // 值不可用：不匹配任何人（与忽略相反）
  assert.deepEqual(ids([leaf("dept", "in", ["d-ops"]), leaf("potential", "in", ["High"])], { logic: "or" }), ["u1", "u5"]);
  assert.deepEqual(ids([leaf("dept", "in", ["d-ops"]), leaf("potential", "in", ["High"])]), []);
  // 空条件 = 全部人员
  assert.equal(runF([]).rows.length, POP.length);
});

test("explain: one hit per top-level condition (leaf id or g<n>), null when ignored", () => {
  const perfOff = catalog({ performance: false, learning: true, talent: true });
  const r = runF([leaf("dept", "in", ["d-fin"]), { logic: "or", items: [leaf("potential", "in", ["High"]), leaf("tenureMonths", "gte", 100)] }, leaf("perfRecent", "atLeast", "A")],
    { catalog: perfOff, explain: true, includeUnmatched: true });
  assert.deepEqual(r.explainHeads, [
    { id: "c1", kind: "leaf", field: "dept", op: "in", tag: null },
    { id: "g2", kind: "group", logic: "or", leafIds: ["c2", "c3"] },
    { id: "c4", kind: "leaf", field: "perfRecent", op: "atLeast", tag: null },
  ]);
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.deepEqual(by.u1.hits, { c1: true, g2: true, c4: null });
  assert.deepEqual(by.u2.hits, { c1: true, g2: false, c4: null });
  assert.deepEqual(by.u3.hits, { c1: false, g2: true, c4: null });
  assert.equal(by.u1.matched, true);
  assert.equal(by.u3.matched, false);
  assert.equal(r.rows.length, POP.length);
  assert.deepEqual(r.rows.slice(0, 2).map((x) => x.id), ["u1", "u5"], "matched people first, then by name");
  assert.equal(r.matchedTotal, 2);
});

test("manual list: exclude always removes, include always adds; people outside the population are ignored", () => {
  const items = [leaf("potential", "in", ["High"])];
  const members = [{ userId: "u5", mode: "exclude", note: "Moved to a new role" }, { userId: "u2", mode: "include" }, { userId: "u6", mode: "include" }, { userId: "u1", mode: "bogus" }];
  const r = runF(items, { members, columns: ["name", "member"] });
  assert.deepEqual(r.rows.map((x) => [x.id, x.member, x.values.member]), [["u1", null, null], ["u2", "include", "include"]]);
  const all = runF(items, { members, includeUnmatched: true, explain: true });
  const by = Object.fromEntries(all.rows.map((x) => [x.id, x]));
  assert.equal(by.u5.matched, false);
  assert.equal(by.u5.member, "exclude");
  assert.deepEqual(by.u5.hits, { c1: true }, "conditions still shown as met for an excluded person");
  assert.equal(by.u2.matched, true);
  assert.deepEqual(by.u2.hits, { c1: false });
  assert.equal(by.u6, undefined);
  assert.equal(all.matchedTotal, 2);
});

test("loaders: only what the conditions and columns need, each at most once per request (records once per type)", () => {
  const spy = {};
  runF([leaf("dept", "in", ["d-fin"]), leaf("tenureMonths", "gte", 1)], { loaders: makeLoaders(spy), columns: ["name", "employeeId", "department", "tenure"] });
  assert.deepEqual(spy, {});
  const spy2 = {};
  runF([
    leaf("perfRecent", "atLeast", "B", { n: 2, mode: "any" }), leaf("perfRecent", "atMost", "A+"), leaf("nineBox", "in", ["2-2", "1-1", "0-0", "__unplaced"]),
    leaf("trainingMandatoryDone", "isTrue"), leaf("trainingProgram", "noneOf", ["p3"]), leaf("violation", "none", undefined, { months: 1 }),
    leaf("jobTrack", "in", ["P"]), leaf("succession", "notListed"), leaf("perfRecent", "atLeast", "D", { periodKind: "annual", missing: "ignore" }),
  ], { loaders: makeLoaders(spy2), logic: "or", columns: ["name", "latestRating", "recentRatings", "trainingMandatory", "trainingCompletion", "violationCount", "successionPositions", "manager", "nineBox"] });
  // 「或」逻辑下前面的条件已命中时后面的不再求值，所以 periodKinds 可能根本不加载；加载过的每类恰好一次
  for (const [k, n] of Object.entries(spy2)) assert.equal(n, 1, k);
  assert.deepEqual(Object.keys(spy2).filter((k) => k !== "periodKinds").sort(), ["records:performance", "records:violation", "succession", "training", "users"]);
  const spy3 = {};
  runF([leaf("perfRecent", "atLeast", "D", { periodKind: "annual", missing: "ignore" }), leaf("perfRecent", "noRecord", undefined, { periodKind: "quarter" })], { loaders: makeLoaders(spy3), logic: "or" });
  assert.deepEqual(spy3, { "records:performance": 1, periodKinds: 1 });
  const spy4 = {};
  runF([leaf("perfRecent", "atLeast", "D", { n: 3, missing: "ignore" })], { loaders: makeLoaders(spy4) });
  assert.deepEqual(spy4, { "records:performance": 1 }, "periodKind any never reads cycle kinds");
});

test("scale: 1,000 people × 20 conditions evaluate well under the 1 s ceiling", () => {
  const users = [], perf = [], viol = [];
  for (let i = 0; i < 1000; i++) {
    const id = "x" + i;
    users.push({ id, name: "P" + i, employeeId: "S-" + i, department: ["Finance", "Finance AP", "Sales", "Ops"][i % 4], jobLevel: RANKS[i % RANKS.length].rank, position: "Role " + (i % 7),
      managerId: i > 10 ? "x" + (i % 10) : null, hireDate: `20${10 + (i % 15)}-0${1 + (i % 9)}-15`, empStatus: i % 9 ? "regular" : "probation",
      potential: ["High", "Medium", "Low", null][i % 4], talentTags: JSON.stringify(i % 3 ? ["Mobile"] : []), extras: JSON.stringify({ score: i % 100 }) });
    for (let k = 0; k < 4; k++) perf.push({ id: `pf-${i}-${k}`, userId: id, date: `202${2 + k}-06-30`, detail: { rating: ["A+", "A", "B+", "B", "C"][(i + k) % 5] } });
    if (i % 5 === 0) viol.push({ id: "v" + i, userId: id, date: "2026-01-0" + (1 + (i % 9)), detail: { severity: i % 2 ? "Minor" : "Major" } });
  }
  const items = [
    leaf("dept", "notIn", ["d-sales"]), leaf("jobLevel", "notIn", ["MB3"]), leaf("tenureMonths", "gte", 6), leaf("perfRecent", "atLeast", "C", { n: 3, mode: "atLeastK", k: 1 }),
    leaf("violation", "none", undefined, { months: 6, severity: ["Major"] }), leaf("potential", "in", ["High", "Medium", "Low"]), leaf("talentTag", "noneOf", ["Ghost"]),
    leaf("custom:score", "gte", 0), leaf("position", "contains", "role"), leaf("jobTrack", "in", ["P"]),
    { logic: "or", items: [leaf("nextLevelExists", "isTrue"), leaf("jobGrade", "in", ["B"]), leaf("empStatus", "in", ["regular"]), leaf("nineBox", "in", ["2-2", "1-1"])] },
    { logic: "or", items: [leaf("trainingMandatoryDone", "isTrue"), leaf("award", "none")] },
    leaf("jobTrack", "in", ["P", "M"]), leaf("succession", "notListed"), leaf("perfRecent", "noRecord", undefined, { periodKind: "annual" }), leaf("manager", "in", ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "x0"]),
  ];
  const filter = mk(items);
  let leaves = 0;
  M.walkLeaves(filter, () => leaves++);
  assert.equal(leaves, 20);
  const spy = {};
  const loaders = {
    records: (t) => { spy[t] = (spy[t] || 0) + 1; return t === "performance" ? perf : t === "violation" ? viol : []; },
    training: () => { spy.training = (spy.training || 0) + 1; return { assignments: () => [], programDone: () => false }; },
    succession: () => [], users: () => users, periodKinds: () => ({}),
  };
  const t0 = process.hrtime.bigint();
  const r = E.run({ population: users, filter, catalog: CAT, ctx: { today: TODAY, deptParse }, loaders, columns: [...M.DEFAULT_COLUMNS, "violationCount"], explain: true, pageSize: 200 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.ok(r.total > 0 && r.total < 1000, String(r.total));
  for (const k of Object.keys(spy)) assert.equal(spy[k], 1, k);
});

test("paging, sorting, idsOnly and column values", () => {
  const base = { population: POP, filter: mk([]), catalog: CAT, ctx: { today: TODAY, deptParse, inScope: (m) => m.department !== "Ops" }, loaders: makeLoaders() };
  const p1 = E.run({ ...base, pageSize: 2, page: 2, columns: ["name"] });
  assert.deepEqual([p1.total, p1.page, p1.pageSize, p1.rows.map((x) => x.name)], [6, 2, 2, ["Cy", "Di"]]);
  assert.equal(E.run({ ...base, pageSize: 5000 }).pageSize, 200);
  const byLevel = E.run({ ...base, sort: { col: "jobLevel", dir: "desc" }, all: true, columns: ["jobLevel"] });
  assert.deepEqual(byLevel.rows.map((x) => x.id), ["u5", "u3", "u2", "u1", "u4", "u8"], "level desc, unmapped last");
  const byRating = E.run({ ...base, sort: { col: "latestRating", dir: "desc" }, all: true, columns: ["latestRating"] });
  assert.deepEqual(byRating.rows.map((x) => x.values.latestRating), ["A+", "A", "B", "C", null, null]);
  const idsOnly = E.run({ ...base, idsOnly: true });
  assert.deepEqual([idsOnly.ids.length, idsOnly.truncated, idsOnly.rows.length], [6, false, 0]);
  const cols = ["name", "employeeId", "department", "jobLevel", "nextLevel", "jobGrade", "jobTrack", "hireDate", "tenure", "manager", "empStatus", "latestRating", "recentRatings",
    "potential", "nineBox", "trainingMandatory", "trainingCompletion", "awardCount", "violationCount", "successionPositions", "member", "talentTags", "custom:lang"];
  const r = E.run({ ...base, all: true, columns: cols, filter: mk([leaf("perfRecent", "atLeast", "D", { n: 2, missing: "ignore" }), leaf("award", "none", undefined, { months: 0 })], "or") });
  const v = Object.fromEntries(r.rows.map((x) => [x.id, x.values]));
  assert.deepEqual(v.u1, {
    name: "Ana", employeeId: "T-1", department: "Finance", jobLevel: "PD1", nextLevel: "PD2", jobGrade: "D", jobTrack: "P", hireDate: "2024-05-20", tenure: 28,
    manager: { id: "u5", name: "Ed", employeeId: "T-5" }, empStatus: "regular", latestRating: "A", recentRatings: ["A", "B+"],
    potential: { value: "High", at: "2026-03-01" }, nineBox: "2-2", trainingMandatory: { done: 1, total: 1 }, trainingCompletion: 50,
    awardCount: 2, violationCount: 0, successionPositions: ["Head of Finance"], member: null, talentTags: ["Successor", "Mobile"], "custom:lang": "English",
  });
  assert.deepEqual(v.u3.manager, { id: "u6", name: "Fay", employeeId: null }, "out-of-scope manager: name only");
  assert.equal(v.u4.nextLevel, null);
  assert.equal(v.u4.tenure, null);
  assert.deepEqual(r.columnMeta, { recentRatings: { n: 2 }, violationCount: { months: 12 }, awardCount: { months: 0 } });
});

test("columnText / csvRows: summary line first, bilingual headers, option values in the requested language", () => {
  const filter = mk([leaf("violation", "none", undefined, { months: 24 })]);
  const r = E.run({ population: POP, filter, catalog: CAT, ctx: { today: TODAY, deptParse }, loaders: makeLoaders(), all: true,
    columns: ["name", "tenure", "potential", "empStatus", "violationCount", "member", "custom:lang", "custom:remote", "nineBox", "trainingMandatory"] });
  const summary = M.summarize(filter, CAT, "zh");
  const zh = E.csvRows({ rows: r.rows, columns: r.columns, catalog: CAT, lang: "zh", summary, columnMeta: r.columnMeta });
  assert.deepEqual(zh[0], ["# 条件：满足全部：近 24 个月无违纪记录"]);
  assert.deepEqual(zh[1], ["姓名 Name", "司龄 Tenure", "潜力 Potential", "员工状态 Employment status", "违纪次数（近 24 个月） Violations (last 24 months)", "人工调整 Manual adjustment", "语言 Language", "远程 Remote", "九宫格 9-box", "必修课程完成 Required courses done"]);
  const ana = zh.find((row) => row[0] === "Ana");
  assert.deepEqual(ana, ["Ana", "2 年 4 个月", "高 (2026-03-01)", "正式", "0", "", "英语", "是", "潜力高 · 绩效高", "1/1"]);
  const en = E.csvRows({ rows: r.rows, columns: r.columns, catalog: CAT, lang: "en", summary: M.summarize(filter, CAT, "en"), columnMeta: r.columnMeta });
  assert.match(en[0][0], /^# Conditions: All of: No violation records in the last 24 months$/);
  assert.deepEqual(en.find((row) => row[0] === "Ana").slice(1), ["2 yr 4 mo", "High (2026-03-01)", "Regular", "0", "", "English", "Yes", "High potential · High performance", "1/1"]);
  assert.equal(E.columnText("member", "exclude", CAT, "zh"), "已排除");
  assert.equal(E.columnText("recentRatings", ["A", null], CAT, "en"), "A · —");
  assert.equal(E.columnText("manager", { name: "Ed", employeeId: null }, CAT, "en"), "Ed");
  assert.equal(E.columnText("tenure", 7, CAT, "zh"), "7 个月");
});

// ---------------------------------------------------------------------------------------------
// 口径对照：迁移后的默认筛选（promotionConfigToFilter）与「按设置页文案写的旧规则」逐人一致。
// 旧规则 = server.js 工作台 promotionPool 的写法（必修课程全部通过、选修与自主学习不计；违纪默认不限严重度，
// violationMajorOnly 时只看重大；performance / learning 关闭时对应门槛整条跳过）。旧代码的司龄用 monthsSince
// （每月 30.44 天）、违纪时间窗用 round(N × 30.44) 天，与日历月在边界日最多差几天 —— 合成数据避开边界日（入职日
// 与违纪日都落在月中，今天是 8 号）。
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function oldRule(cfg, mods, data, today) {
  const opts = ["A+", "A", "B+", "B", "C", "D"];
  const minIdx = cfg.minRating ? opts.indexOf(cfg.minRating) : -1;
  const latestPerf = {};
  for (const r of data.perf) if (!latestPerf[r.userId]) latestPerf[r.userId] = r; // 按 date DESC
  const todayMs = new Date(today + "T00:00:00").getTime();
  const dayOffset = (n) => { const d = new Date(todayMs + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const cutoff = cfg.noMajorViolationMonths > 0 ? dayOffset(-Math.round(cfg.noMajorViolationMonths * 30.44)) : null;
  const blocked = new Set();
  if (cutoff) for (const v of data.viol) {
    if (v.date < cutoff) continue;
    if (cfg.violationMajorOnly && !/major|重大/i.test(String(v.detail.severity || ""))) continue;
    blocked.add(v.userId);
  }
  const monthsSince = (s) => (s ? Math.floor((todayMs - new Date(s + "T00:00:00").getTime()) / (30.44 * 86400000)) : null);
  const ladder = E.buildLadder(RANKS);
  const out = [];
  for (const u of data.users) {
    if (u.role === "admin" || u.active === 0) continue;
    const i = u.jobLevel ? ladder.info(u.jobLevel) : null;
    if (!i || !i.next) continue;
    const perf = latestPerf[u.id];
    const rIdx = perf && perf.detail.rating ? opts.indexOf(perf.detail.rating) : -1;
    if (mods.performance && cfg.minRating && !(rIdx !== -1 && minIdx !== -1 && rIdx <= minIdx)) continue;
    const months = monthsSince(u.hireDate);
    if (cfg.minTenureMonths > 0 && !(months !== null && months >= cfg.minTenureMonths)) continue;
    if (mods.learning && cfg.requireTrainings) {
      const pids = (data.asg[u.id] || []).filter((a) => !a.self && a.mandatory);
      if (!pids.every((a) => a.done)) continue;
    }
    if (cutoff && blocked.has(u.id)) continue;
    out.push(u.id);
  }
  return out.sort();
}

test("口径对照: the migrated default promotion filter selects exactly the people the settings-page rule selects", () => {
  const rnd = mulberry32(20261008);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const users = [], perf = [], viol = [], asg = {};
  for (let i = 0; i < 400; i++) {
    const id = "k" + i;
    const yearsBack = Math.floor(rnd() * 8), monthBack = Math.floor(rnd() * 12);
    let y = 2026 - yearsBack, m = 10 - monthBack;
    while (m < 1) { m += 12; y--; }
    const hire = rnd() < 0.05 ? null : `${y}-${String(m).padStart(2, "0")}-20`;
    users.push({ id, name: "K" + i, employeeId: "K-" + i, department: "Finance", jobLevel: rnd() < 0.08 ? pick(["", "V4"]) : pick(RANKS).rank, hireDate: hire, empStatus: "regular" });
    const nPerf = Math.floor(rnd() * 4);
    for (let k = 0; k < nPerf; k++) perf.push({ id: `kp-${i}-${k}`, userId: id, date: `${2026 - k}-0${3 + (k % 3)}-30`, detail: { rating: rnd() < 0.07 ? (rnd() < 0.5 ? null : "Z") : pick(["A+", "A", "B+", "B", "C", "D"]) } });
    if (rnd() < 0.35) {
      const back = 1 + Math.floor(rnd() * 30);
      let vy = 2026, vm = 10 - back;
      while (vm < 1) { vm += 12; vy--; }
      viol.push({ id: "kv" + i, userId: id, date: `${vy}-${String(vm).padStart(2, "0")}-25`, detail: { severity: pick(["Minor", "Major", "Major 重大", "Minor 轻微"]) } });
    }
    const na = Math.floor(rnd() * 4);
    asg[id] = Array.from({ length: na }, (_, k) => ({ programId: "p" + k, mandatory: rnd() < 0.7, self: rnd() < 0.15, done: rnd() < 0.75 }));
  }
  perf.sort((a, b) => (a.date < b.date ? 1 : -1));
  const data = { users, perf, viol, asg };
  const loaders = { records: (t) => (t === "performance" ? perf : t === "violation" ? viol : []), training: () => ({ assignments: (uid) => asg[uid] || [], programDone: () => false }), users: () => users };
  const cfgs = [
    // F62 之后 PROMO_DEFAULTS 是公司晋升门槛；这里对照的是旧设置页规则，所以用 LEGACY_PROMO_DEFAULTS
    { ...M.LEGACY_PROMO_DEFAULTS },
    { ...M.LEGACY_PROMO_DEFAULTS, violationMajorOnly: true },
    { ...M.LEGACY_PROMO_DEFAULTS, minRating: "A", minTenureMonths: 24, noMajorViolationMonths: 24 },
    { ...M.LEGACY_PROMO_DEFAULTS, minRating: "", requireTrainings: false },
    { ...M.LEGACY_PROMO_DEFAULTS, minTenureMonths: 0, noMajorViolationMonths: 0 },
    { ...M.LEGACY_PROMO_DEFAULTS, minRating: "C", minTenureMonths: 6, noMajorViolationMonths: 6, violationMajorOnly: true },
  ];
  const modSets = [ALL_ON, { performance: false, learning: true, talent: true }, { performance: true, learning: false, talent: true }, { performance: false, learning: false, talent: true }];
  let compared = 0, nonEmpty = 0;
  for (const mods of modSets) {
    const cat = catalog(mods);
    for (const cfg of cfgs) {
      const def = M.promotionConfigToFilter(cfg, cat.ratingOptions);
      const v = M.validateFilter(def, cat);
      assert.ok(v.ok, JSON.stringify(v.errors));
      const r = E.run({ population: E.basePopulation(users), filter: v.filter, catalog: cat, ctx: { today: TODAY }, loaders, all: true, columns: ["name"] });
      const got = r.rows.map((x) => x.id).sort();
      const want = oldRule(cfg, mods, data, TODAY);
      assert.deepEqual(got, want, `cfg ${JSON.stringify(cfg)} mods ${JSON.stringify(mods)}`);
      compared++;
      if (want.length) nonEmpty++;
    }
  }
  assert.equal(compared, 24);
  assert.ok(nonEmpty >= 20, "the comparison must exercise real selections, not empty lists");
});
