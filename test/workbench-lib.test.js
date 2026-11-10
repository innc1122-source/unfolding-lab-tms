// 工作台口径纯函数（modules/core/workbench.js，以及 talent 库里的继任覆盖、标签状态重建；12.2 组 1，设计 b12-design 第 2、3、8 节）：
//   试用期到期日（月末、闰年）；转正通过率含试用期内离职；平均周期；管理幅度（0 人只对管理序列 / 部门负责人、≥10、范围内计数、
//   directsByDept 求和）；继任覆盖（就绪度、在职、范围、同键归并、快照）；标签状态重建（迁移事件 / 无事件视为自始持有、离职日当天
//   remove 的边界）；高潜与关键人才保留；阶段按时（截止日当天完成算按时、未到期不计入、无截止日不计入）；季度键与上期窗口；
//   落后标记与小样本；前端镜像 web/src/controlledTags.js 与服务端定义逐项一致（源码共享段逐字相同 + 行为一致）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const WB = require("../modules/core/workbench.js");
const KP = require("../modules/talent/key-positions.js");
const CT = require("../modules/talent/controlled-tags.js");

const ROOT = path.join(__dirname, "..");
const WEB_CT = path.join(ROOT, "web", "src", "controlledTags.js");
const SRV_CT = path.join(ROOT, "modules", "talent", "controlled-tags.js");
const E = (...cps) => String.fromCodePoint(...cps);

// ---------------------------------------------------------------- 日期与统计期
test("workbench: quarter keys and the previous-quarter window", () => {
  assert.deepEqual(WB.quarterOf("2026-10-09"), { key: "2026-Q4", from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(WB.quarterOf("2026-03-31"), { key: "2026-Q1", from: "2026-01-01", to: "2026-03-31" });
  assert.deepEqual(WB.prevQuarterOf("2026-02-10"), { key: "2025-Q4", from: "2025-10-01", to: "2025-12-31" });
  assert.deepEqual(WB.periodFor("2026-10-09"), { from: "2026-10-01", to: "2026-12-31", prevFrom: "2026-07-01", prevTo: "2026-09-30", key: "2026-Q4", prevKey: "2026-Q3", asOf: "2026-10-09" });
  // 与培训概览 period=quarter 同一窗口
  const TS = require("../modules/learning/training-stats.js");
  for (const d of ["2026-01-01", "2026-05-31", "2026-08-15", "2026-12-31", "2028-02-29"]) {
    const w = TS.periodWindows({ period: "quarter", today: d }), p = WB.periodFor(d);
    assert.deepEqual([p.from, p.to, p.prevFrom, p.prevTo], [w.win.from, w.win.to, w.prevWin.from, w.prevWin.to], d);
  }
  assert.equal(WB.oldestKeptPeriod("2026-10-09"), "2025-Q1", "8 quarters including the current one (2025-Q1 … 2026-Q4)");
  assert.equal(WB.oldestKeptPeriod("2026-10-09", 1), "2026-Q4");
  assert.ok("2024-Q4" < WB.oldestKeptPeriod("2026-10-09") && "2025-Q2" > WB.oldestKeptPeriod("2026-10-09"), "keys compare as strings");
});

test("workbench: Manila day, months arithmetic and the snapshot clock", () => {
  assert.equal(WB.manilaDay("2026-10-08T16:30:00.000Z"), "2026-10-09", "00:30 Manila");
  assert.equal(WB.manilaDay("2026-10-08T15:59:59.000Z"), "2026-10-08");
  assert.equal(WB.manilaDay("2026-10-08"), "2026-10-08");
  assert.equal(WB.manilaDay("bad"), null);
  assert.equal(WB.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(WB.addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(WB.addMonths("2026-10-09", -12), "2025-10-09");
  const at = (iso) => Date.parse(iso);
  assert.equal(WB.snapshotDue(at("2026-10-08T16:30:00Z"), "2026-10-08"), false, "00:30 Manila — before 01:00");
  assert.equal(WB.snapshotDue(at("2026-10-08T17:05:00Z"), "2026-10-08"), true, "01:05 Manila, not yet run today");
  assert.equal(WB.snapshotDue(at("2026-10-08T17:05:00Z"), "2026-10-09"), false, "already ran today");
  assert.equal(WB.snapshotDue(at("2026-10-08T16:30:00Z"), "2026-10-08", { startup: true }), true, "startup ignores the clock");
  assert.deepEqual(WB.configOf('{"spanMax":15,"lagPp":"x","probationMonths":-1}'), { ...WB.DEFAULT_CONFIG, spanMax: 15 });
  assert.deepEqual(WB.configOf("not json"), { ...WB.DEFAULT_CONFIG });
});

test("workbench: metric card shape (2.7)", () => {
  const period = { from: "2026-10-01", to: "2026-12-31", prevFrom: "2026-07-01", prevTo: "2026-09-30" };
  assert.deepEqual(WB.buildMetric({ key: "succession", domain: "talent", module: "talent", num: 10, den: 16, prev: 58.8, better: "up", period, extra: { noSuccessor: 3 } }),
    { key: "succession", domain: "talent", module: "talent", value: 62.5, unit: "pct", num: 10, den: 16, prev: 58.8, delta: 3.7, better: "up", period, extra: { noSuccessor: 3 }, empty: null });
  const c = WB.buildMetric({ key: "span", unit: "count", num: 4, better: "down" });
  assert.equal(c.value, 4);
  assert.equal(c.prev, null, "first launch: no previous period");
  assert.equal(c.delta, null);
  assert.equal(WB.buildMetric({ key: "x", num: 0, den: 0, empty: "no_data" }).value, null);
  assert.equal(WB.deltaOf(50, 66.7), -16.7);
});

// ---------------------------------------------------------------- 2.5 试用期
test("workbench: probation end date — month ends and leap years", () => {
  assert.equal(WB.probationEndOf("2026-01-15", 6), "2026-07-14");
  assert.equal(WB.probationEndOf("2026-01-01", 6), "2026-06-30");
  assert.equal(WB.probationEndOf("2026-08-31", 6), "2027-02-28", "Feb has no 31st → last day of Feb");
  assert.equal(WB.probationEndOf("2027-08-31", 6), "2028-02-29", "leap year");
  assert.equal(WB.probationEndOf("2027-08-29", 6), "2028-02-28", "Feb 29 exists → day before");
  assert.equal(WB.probationEndOf("2026-08-29", 6), "2027-02-28");
  assert.equal(WB.probationEndOf("2026-03-31", 6), "2026-09-30");
  assert.equal(WB.probationEndOf("2026-05-10", 3), "2026-08-09");
  assert.equal(WB.probationEndOf("", 6), null);
  assert.equal(WB.probationEndOf("2026-02-30", 6), null);
});

test("workbench: probation due list for the to-do layer", () => {
  const people = [
    { id: "a", empStatus: "probation", hireDate: "2026-04-20" },   // 到期 2026-10-19 → 30 天内
    { id: "b", empStatus: "probation", hireDate: "2026-03-01" },   // 到期 2026-08-31 → 已过期
    { id: "c", empStatus: "probation", hireDate: "2026-06-01" },   // 到期 2026-11-30 → 超出 30 天
    { id: "d", empStatus: "probation", hireDate: "2026-04-01" },   // 已有转正记录
    { id: "e", empStatus: "regular", hireDate: "2026-04-01" },
    { id: "f", empStatus: "probation", hireDate: "2026-04-01", active: 0 },
    { id: "g", empStatus: "probation", hireDate: null },
    { id: "h", empStatus: "probation", hireDate: "2026-05-08" },   // 到期 2026-11-07 = 今天 + 29
  ];
  const due = WB.probationDue(people, { hasRegularization: (u) => u.id === "d" }, "2026-10-09", null);
  assert.deepEqual(due, [
    { userId: "b", dueOn: "2026-08-31", overdue: true },
    { userId: "a", dueOn: "2026-10-19", overdue: false },
    { userId: "h", dueOn: "2026-11-07", overdue: false },
  ]);
});

test("workbench: regularization pass rate counts exits during probation; average cycle", () => {
  const win = { from: "2026-10-01", to: "2026-12-31" };
  const recs = {
    a: [{ type: "regularization", date: "2026-10-05", detail: { result: "On time" } }],
    b: [{ type: "regularization", date: "2026-07-01", detail: { result: "Failed" } }, { type: "regularization", date: "2026-10-20", detail: { result: "Extended" } }],
    c: [{ type: "regularization", date: "2026-11-02", detail: { result: "Failed" } }],
    e: [{ type: "regularization", date: "2026-09-30", detail: { result: "On time" } }],   // 上期
    g: [{ type: "regularization", date: "2026-10-01", detail: { result: "On time" } }],
  };
  const exits = { c: "2026-11-10", d: "2026-10-15", f: "2026-12-20", g: "2026-11-01", h: "2026-09-20" };
  const people = [
    { id: "a", hireDate: "2026-04-05" },
    { id: "b", hireDate: "2026-01-20" },
    { id: "c", hireDate: "2026-05-02" },     // 未通过（记录在本期；之后离职不重复计）
    { id: "d", hireDate: "2026-06-01" },     // 试用期内离职（到期 2026-11-30）
    { id: "e", hireDate: "2026-03-30" },     // 结论在上期
    { id: "f", hireDate: "2026-01-02" },     // 离职在试用期之后（到期 2026-07-01）→ 不计
    { id: "g", hireDate: "2026-04-01" },     // 通过后离职 → 只按转正记录计
    { id: "h", hireDate: "2026-06-01" },     // 离职在上期
  ];
  const r = WB.probationOutcomes(people, { recordsOf: (u) => recs[u.id] || [], exitDayOf: (u) => exits[u.id] || null }, win, null);
  const by = Object.fromEntries(r.rows.map((x) => [x.userId, x]));
  assert.deepEqual(Object.keys(by).sort(), ["a", "b", "c", "d", "g"]);
  assert.equal(by.a.result, "onTime");
  assert.equal(by.b.result, "extended", "latest regularization record in the period");
  assert.equal(by.c.result, "failed");
  assert.equal(by.d.result, "exitedInProbation");
  assert.equal(by.d.outcomeDay, "2026-10-15");
  assert.equal(r.den, 5);
  assert.equal(r.num, 3);
  assert.equal(r.value, 60);
  // 周期：a 183 天、b 273 天、g 183 天
  assert.deepEqual([by.a.days, by.b.days, by.g.days], [183, 273, 183]);
  assert.equal(r.avgDays, 213);
  assert.equal(r.avgMonths, 7);
  // 上一季度：e 通过、h 试用期内离职
  const prev = WB.probationOutcomes(people, { recordsOf: (u) => recs[u.id] || [], exitDayOf: (u) => exits[u.id] || null }, { from: "2026-07-01", to: "2026-09-30" }, null);
  assert.deepEqual(prev.rows.map((x) => [x.userId, x.result]).sort(), [["b", "failed"], ["e", "onTime"], ["h", "exitedInProbation"]]);
  assert.equal(WB.probationOutcomes([], {}, win, null).value, null);
});

// ---------------------------------------------------------------- 2.6 管理幅度
const RANKS = [{ rank: "MA1", grade: "A", level: 14, track: "M" }, { rank: "PA1", grade: "A", level: 14, track: "P" }, { rank: "PB1", grade: "B", level: 11, track: "P" }];
test("workbench: span of control — zero directs only for management grades / dept owners, >= 10 is wide, in-scope count", () => {
  const people = [
    { id: "m0", jobLevel: "MA1", department: "Sales" },                // 管理序列、0 直属 → none
    { id: "o0", jobLevel: "PA1", department: "IT" },                   // 部门负责人、0 直属 → none
    { id: "p0", jobLevel: "PA1", department: "IT" },                   // 专业序列、0 直属 → 不是管理者
    { id: "w", jobLevel: "PA1", department: "Ops" },                   // 13 名直属 → wide
    { id: "ok", jobLevel: "ma1", department: "Ops" },                  // 9 名直属 → 正常（不分大小写的职级）
    { id: "gone", jobLevel: "MA1", department: "Ops", active: 0 },     // 离职 → 不计
  ];
  for (let i = 0; i < 13; i++) people.push({ id: "w" + i, managerId: "w", department: i < 10 ? "Ops" : "HR" });
  for (let i = 0; i < 9; i++) people.push({ id: "k" + i, managerId: "ok", department: "Ops" });
  people.push({ id: "x1", managerId: "ok", department: "Ops", empStatus: "exited" });   // 离职下属不计
  const r = WB.spanOfControl(people, { ranks: RANKS, ownerIds: ["o0"] }, null);
  assert.deepEqual(r.rows.map((x) => [x.userId, x.type, x.directs]).sort(), [["m0", "none", 0], ["o0", "none", 0], ["w", "wide", 13]]);
  assert.deepEqual([r.none, r.wide, r.count], [2, 1, 3]);
  assert.deepEqual(r.ids.sort(), ["m0", "o0", "w"]);
  // 范围内计数：查看者只看 Ops（HR 的 3 名下属不在 people 里）→ w 刚好 10 名直属，仍为异常
  const scoped = people.filter((u) => u.department === "Ops");
  const s = WB.spanOfControl(scoped, { ranks: RANKS, ownerIds: new Set() }, null);
  assert.deepEqual(s.rows.map((x) => [x.userId, x.directs]), [["w", 10]]);
  assert.equal(WB.spanOfControl(people, { ranks: RANKS, ownerIds: [] }, { spanMax: 9 }).wide, 2, "configurable spanMax");
  assert.equal(WB.isManagementGrade("MA1", RANKS), true);
  assert.equal(WB.isManagementGrade("PA1", RANKS), false);
  assert.equal(WB.isManagementGrade("ZZ9", RANKS), false);
});

test("workbench: span snapshot rows and the directsByDept sum under a viewer's scope", () => {
  const people = [{ id: "w", jobLevel: "PA1", department: "Ops" }, { id: "m0", jobLevel: "MA1", department: "Sales" }, { id: "p", jobLevel: "PB1", department: "IT" }];
  for (let i = 0; i < 13; i++) people.push({ id: "w" + i, managerId: "w", department: i < 10 ? "Ops" : "HR" });
  const rows = WB.spanSnapshotRows(people, { ranks: RANKS, ownerIds: [] });
  assert.deepEqual(rows.map((r) => r.subjectId).sort(), ["m0", "w"]);
  const w = rows.find((r) => r.subjectId === "w");
  assert.deepEqual(w, { subjectId: "w", deptName: "Ops", data: { managerial: false, directsByDept: { Ops: 10, HR: 3 } } });
  const all = WB.spanFromSnapshot(rows, () => true, null);
  assert.deepEqual(all.rows.map((x) => [x.userId, x.type, x.directs]).sort(), [["m0", "none", 0], ["w", "wide", 13]]);
  const ops = WB.spanFromSnapshot(rows, (d) => d === "Ops", null);
  assert.deepEqual(ops.rows.map((x) => [x.userId, x.type, x.directs]), [["w", "wide", 10]], "the >=10 boundary applies inside a scoped view too; m0's dept is out of scope");
  const opsHr = WB.spanFromSnapshot(rows, (d) => d === "Ops" || d === "HR", null);
  assert.deepEqual(opsHr.rows.map((x) => [x.userId, x.directs]), [["w", 13]]);
  assert.deepEqual(WB.snapshotIds([{ subjectId: "a", deptName: "Ops" }, { subjectId: "b", deptName: "HR" }, { subjectId: "c", deptName: null }], (d) => d === "Ops"), ["a"]);
});

// ---------------------------------------------------------------- 2.1 继任覆盖（key-positions.js）
test("succession coverage: readiness, in-service, scope and same-key merge", () => {
  const positions = [
    { id: "kp1", name: "Finance Manager", deptName: "Finance", isKey: 1 },
    { id: "kp2", name: "IT Director", deptName: "IT", isKey: 1 },
    { id: "kp3", name: "Branch Head", deptName: "Ops", isKey: 1 },
    { id: "kp4", name: "Office Admin", deptName: "Ops", isKey: 0 },   // 非关键：不计入
  ];
  const users = { u1: { active: 1, department: "Finance" }, u2: { active: 1, department: "IT" }, u3: { active: 0, department: "IT" },
    u4: { active: 1, department: "HR" }, u5: { active: 1, department: "Ops" }, u6: { active: 1, department: "Ops" } };
  const succ = [
    { positionName: "finance-manager", userId: "u1", readiness: "oneYear" },   // 同键归并
    { positionName: "Finance Manager", userId: "u1", readiness: "twoYears" },  // 同人重复 → 取最高
    { positionName: "IT Director", userId: "u2", readiness: "twoYears" },      // 只有 2 年以上 → 不覆盖
    { positionName: "IT Director", userId: "u3", readiness: "ready" },         // 离职 → 不计
    { positionName: "IT Director", userId: "u4", readiness: "ready" },         // 范围外（HR）
    { positionName: "Office Admin", userId: "u5", readiness: "ready" },
    { positionName: "Branch Head", userId: "u6", readiness: "bogus" },
  ];
  const scope = new Set(["Finance", "IT", "Ops"]);
  const ok = (s) => { const u = users[s.userId]; return WB.isInService(u) && scope.has(u.department); };
  const r = KP.successionCoverage(positions, succ, ok);
  assert.equal(r.den, 3);
  assert.equal(r.num, 1);
  assert.equal(r.value, 33.3);
  assert.equal(r.noSuccessor, 1, "Branch Head");
  assert.equal(r.empty, null);
  const fm = r.rows.find((x) => x.id === "kp1");
  assert.deepEqual([fm.ready, fm.oneYear, fm.twoYears, fm.total, fm.best, fm.covered], [0, 1, 0, 1, "oneYear", true]);
  const it = r.rows.find((x) => x.id === "kp2");
  assert.deepEqual([it.total, it.best, it.covered], [1, "twoYears", false]);
  // 把继任者改为 twoYears / 设为离职 → 覆盖率下降（验收 C1）
  const lower = KP.successionCoverage(positions, succ.map((s) => (s.userId === "u1" ? { ...s, readiness: "twoYears" } : s)), ok);
  assert.equal(lower.num, 0);
  users.u1.active = 0;
  assert.equal(KP.successionCoverage(positions, succ, ok).num, 0);
  users.u1.active = 1;
  // 清单为空
  assert.deepEqual(KP.successionCoverage([], succ, ok), { den: 0, num: 0, noSuccessor: 0, value: null, empty: "no_key_positions", rows: [] });
  const byKey = KP.coverageByKey(succ, ok);
  assert.deepEqual(byKey.get(KP.positionKey("Finance Manager")).userIds, ["u1"]);
});

test("succession coverage from a snapshot filters positions and successors by department", () => {
  const positions = [{ id: "kp1", name: "Finance Manager", deptName: "Finance", isKey: 1 }, { id: "kp2", name: "IT Director", deptName: "IT", isKey: 1 }];
  const users = { u1: { active: 1, department: "HR" }, u2: { active: 1, department: "IT" }, u3: { empStatus: "exited", department: "IT" } };
  const succ = [
    { positionName: "Finance Manager", userId: "u1", readiness: "ready" },
    { positionName: "IT Director", userId: "u2", readiness: "oneYear" },
    { positionName: "IT Director", userId: "u3", readiness: "ready" },
  ];
  const snap = KP.successionSnapshotRows(positions, succ, { userById: (id) => users[id] });
  assert.deepEqual(snap.find((r) => r.subjectId === "kp2"), { subjectId: "kp2", deptName: "IT", data: { name: "IT Director", nameKey: KP.positionKey("IT Director"), isKey: 1,
    successors: [{ userId: "u2", deptName: "IT", readiness: "oneYear", inService: true }, { userId: "u3", deptName: "IT", readiness: "ready", inService: false }] } });
  const all = KP.successionFromSnapshot(snap, () => true);
  assert.deepEqual([all.den, all.num], [2, 2]);
  const fin = KP.successionFromSnapshot(snap, (d) => d === "Finance");
  assert.deepEqual([fin.den, fin.num, fin.noSuccessor], [1, 0, 1], "the HR successor is outside the viewer's scope");
});

// ---------------------------------------------------------------- 2.2 标签状态重建（controlled-tags.js）
test("tag state: migration events and tags without events count as held from the start; exit-day remove boundary", () => {
  const mig = { id: "e0", tagKey: "hipo", action: "add", source: "migration", effectiveOn: null, at: "2026-10-09T01:00:00Z" };
  assert.equal(CT.heldOn([mig], "hipo", "2020-01-01", false), true, "migration add = held since the beginning");
  assert.equal(CT.heldOn([], "hipo", "2026-01-01", true), true, "tag held but no event");
  assert.equal(CT.heldOn([], "hipo", "2026-01-01", false), false);
  const ev = [
    mig,
    { id: "e1", tagKey: "hipo", action: "remove", source: "manual", effectiveOn: "2026-11-10", at: "2026-11-10T02:00:00Z" },
    { id: "e2", tagKey: "key", action: "add", source: "manual", effectiveOn: "2026-10-20", at: "2026-10-20T02:00:00Z" },
  ];
  assert.equal(CT.heldOn(ev, "hipo", "2026-11-09", false), true);
  assert.equal(CT.heldOn(ev, "hipo", "2026-11-10", false), false, "removed on the exit day → not held that day");
  assert.equal(CT.heldOn(ev, "key", "2026-10-19", true), false, "manual add later → not held before it");
  assert.equal(CT.heldOn(ev, "key", "2026-10-20", true), true);
  // 只有更晚的 remove（无更早事件）→ 此前持有
  assert.equal(CT.heldOn([{ id: "r", tagKey: "flight", action: "remove", source: "script", at: "2026-10-05T03:00:00Z" }], "flight", "2026-10-01", false), true);
  // effectiveOn 为空的非迁移事件按 at 的马尼拉日
  assert.equal(CT.eventDay({ source: "script", at: "2026-10-04T17:00:00Z" }), "2026-10-05");
  assert.equal(CT.eventDay({ source: "migration", at: "2026-10-04T17:00:00Z" }), null);
  assert.equal(CT.eventDay({ source: "manual", effectiveOn: "2026-10-01", at: "2026-10-04T17:00:00Z" }), "2026-10-01");
});

test("tag state: high-potential / key-talent retention for the quarter", () => {
  const win = { from: "2026-10-01", to: "2026-12-31" };
  const migAdd = (k) => ({ id: "m-" + k, tagKey: k, action: "add", source: "migration", effectiveOn: null, at: "2026-10-09T00:00:00Z" });
  const people = [
    { id: "a", talentTags: ["高潜 HiPo"], hireDate: "2024-01-01", ev: [migAdd("hipo")], exit: "2026-11-15", type: "Voluntary" },     // 持有离职
    { id: "b", talentTags: ["关键人才 Key talent"], hireDate: "2024-01-01", ev: [], exit: "2026-10-20", type: "Involuntary" },     // 无事件 = 自始持有
    { id: "c", talentTags: ["高潜 HiPo"], hireDate: "2024-01-01", ev: [migAdd("hipo"),
      { id: "c1", tagKey: "hipo", action: "remove", source: "manual", effectiveOn: "2026-11-01", at: "2026-11-01T01:00:00Z" }], exit: "2026-11-01", type: "Voluntary" }, // 离职日当天取消 → 不计
    { id: "d", talentTags: ["高潜 HiPo"], hireDate: "2024-01-01", ev: [migAdd("hipo")], exit: null },                               // 在职持有 → 只进分母
    { id: "e", talentTags: ["高潜 HiPo"], hireDate: "2026-11-01", ev: [{ id: "e1", tagKey: "hipo", action: "add", source: "manual", effectiveOn: "2026-11-05", at: "2026-11-05T01:00:00Z" }], exit: null }, // 季度内新打上
    { id: "f", talentTags: ["流失风险 Flight risk"], hireDate: "2024-01-01", ev: [], exit: "2026-10-10", type: "Voluntary" },       // 不是高潜 / 关键人才
    { id: "g", talentTags: ["高潜 HiPo"], hireDate: "2024-01-01", ev: [migAdd("hipo")], exit: "2026-09-20", type: "Voluntary" },    // 上期离职
  ];
  const r = CT.retentionMetric(people, { exitDayOf: (u) => u.exit || null, exitTypeOf: (u) => u.type || null, eventsOf: (u) => u.ev }, win);
  assert.deepEqual(r.exitedIds, ["a", "b"]);
  assert.deepEqual(r.voluntaryIds, ["a"]);
  assert.deepEqual(r.baseIds.sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual([r.num, r.den, r.value], [2, 5, 40]);
  const prev = CT.retentionMetric(people, { exitDayOf: (u) => u.exit || null, exitTypeOf: (u) => u.type || null, eventsOf: (u) => u.ev }, { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(prev.exitedIds, ["g"]);
  // 流失风险：在职、精确 canonical
  const fr = [{ id: "x", talentTags: ["流失风险 Flight risk"] }, { id: "y", talentTags: ["Flight risk"] }, { id: "z", talentTags: ["流失风险 Flight risk"], active: 0 }];
  assert.deepEqual(CT.flightRiskIds(fr), ["x"]);
  assert.deepEqual(CT.flightSnapshotRows([{ id: "x", talentTags: ["流失风险 Flight risk"], department: "IT" }]), [{ subjectId: "x", deptName: "IT", data: {} }]);
});

// ---------------------------------------------------------------- 2.4 评估按时
test("review on-time: due-day completion is on time, not-yet-due and undated stages are excluded", () => {
  const cycle = { id: "rc-1", flow: "v2", dueAt: "2026-10-05", dueRateAt: "2026-10-09", dueCalibAt: null };
  const items = [
    { id: "i1", userId: "u1", selfAt: "2026-10-05T15:30:00Z", managerAt: null },   // 马尼拉 10/05 23:30 → 按时
    { id: "i2", userId: "u2", selfAt: "2026-10-05T16:30:00Z", managerAt: null },   // 马尼拉 10/06 00:30 → 逾期
    { id: "i3", userId: "u3", selfAt: null, managerAt: null },                      // 未完成
  ];
  const inst = WB.reviewStageInstances({ cycle, items, calibDepts: [{ dept1Id: "d1", dept1Name: "Sales", hodSubmittedAt: "2026-10-01T00:00:00Z" }], today: "2026-10-09" });
  assert.deepEqual(inst.map((x) => [x.stage, x.itemId, x.dueOn, x.doneOn, x.onTime]), [
    ["self", "i1", "2026-10-05", "2026-10-05", true],
    ["self", "i2", "2026-10-05", "2026-10-06", false],
    ["self", "i3", "2026-10-05", null, false],
  ], "rate stage due today is not yet counted; calib has no due date");
  const s = WB.onTimeSummary(inst);
  assert.deepEqual([s.num, s.den, s.value], [1, 3, 33.3]);
  assert.deepEqual(s.byStage.rate, { num: 0, den: 0, value: null });
  assert.deepEqual(s.lateIds, [1, 2]);
  // 第二天：上级评级阶段到期计入；HoD 校准有截止日后也计入
  const later = WB.reviewStageInstances({ cycle: { ...cycle, dueCalibAt: "2026-10-08" }, items: [{ id: "i1", userId: "u1", selfAt: "2026-10-01T00:00:00Z", managerAt: "2026-10-09T03:00:00Z" }],
    calibDepts: [{ dept1Id: "d1", dept1Name: "Sales", hodSubmittedAt: "2026-10-08T10:00:00Z" }], today: "2026-10-10" });
  assert.deepEqual(later.map((x) => [x.stage, x.onTime]), [["self", true], ["rate", true], ["calib", true]]);
  // 旧流程：没有 dueRateAt 不计上级评级；不是 v2 不计 HoD 校准
  const legacy = WB.reviewStageInstances({ cycle: { dueAt: "2026-10-01", dueCalibAt: "2026-10-01" }, items: [{ id: "i1", userId: "u1", managerAt: "2026-09-01T00:00:00Z" }],
    calibDepts: [{ dept1Id: "d1", hodSubmittedAt: null }], today: "2026-10-10" });
  assert.deepEqual(legacy.map((x) => x.stage), ["self"]);
  assert.deepEqual(WB.reviewStageInstances({ cycle: {}, items: [{ id: "i" }], today: "2026-10-10" }), [], "no due dates at all");
});

test("review cycles: current = latest open, else latest closed; previous = same kind", () => {
  const cycles = [
    { id: "q1", kind: "quarter", status: "closed", createdAt: "2026-01-05T00:00:00Z", closedAt: "2026-03-30T00:00:00Z" },
    { id: "an", kind: "annual", status: "closed", createdAt: "2026-02-01T00:00:00Z", closedAt: "2026-04-30T00:00:00Z" },
    { id: "q2", status: "closed", createdAt: "2026-04-05T00:00:00Z", closedAt: "2026-06-30T00:00:00Z" },
    { id: "q3", kind: "quarter", status: "open", createdAt: "2026-07-05T00:00:00Z" },
  ];
  assert.deepEqual(Object.values(WB.pickReviewCycles(cycles)).map((c) => c && c.id), ["q3", "q2"]);
  assert.deepEqual(Object.values(WB.pickReviewCycles(cycles.slice(0, 3))).map((c) => c && c.id), ["q2", "q1"]);
  assert.deepEqual(Object.values(WB.pickReviewCycles([cycles[1]])).map((c) => c && c.id), ["an", null]);
  assert.deepEqual(WB.pickReviewCycles([]), { current: null, prev: null });
});

// ---------------------------------------------------------------- 第三层与部门健康度
test("department health: lag flag at 10 pp below the total, small-sample guard, sorting", () => {
  const cfg = WB.configOf(null);
  assert.deepEqual(WB.healthCell({ num: 6, den: 10, headcount: 20 }, 70, cfg), { value: 60, num: 6, den: 10, state: "lag" }, "exactly 10 pp below → lag");
  assert.equal(WB.healthCell({ num: 61, den: 100, headcount: 20 }, 70.9, cfg).state, "ok", "9.9 pp below");
  assert.equal(WB.healthCell({ num: 1, den: 4, headcount: 4 }, 90, cfg).state, "small");
  assert.equal(WB.healthCell({ num: 1, den: 4, headcount: 4 }, 90, cfg).value, null, "no ratio for fewer than 5 people");
  assert.equal(WB.healthCell({ num: 0, den: 0, headcount: 9 }, 90, cfg).state, "empty");
  assert.equal(WB.healthCell({ num: 1, den: 10, headcount: 20 }, 90, cfg, { lag: false }).state, "ok", "total row / unflagged columns");
  assert.equal(WB.healthCell({ num: 1, den: 10, headcount: 20 }, null, cfg).state, "ok");
  const rows = WB.sortHealthRows([
    { deptName: "B", headcount: 30, cells: { a: { state: "ok" } } },
    { deptName: "A", headcount: 10, cells: { a: { state: "lag" }, b: { state: "lag" } } },
    { deptName: "C", headcount: 40, cells: { a: { state: "lag" } } },
    { deptName: "D", headcount: 40, cells: { a: { state: "small" } } },
  ]);
  assert.deepEqual(rows.map((r) => r.deptName), ["A", "C", "D", "B"]);
  assert.deepEqual(WB.lowestRate([{ deptId: "x", deptName: "X", num: 1, den: 4 }, { deptId: "y", deptName: "Y", num: 3, den: 6 }, { deptId: "z", deptName: "Z", num: 4, den: 5 }], 5),
    { deptId: "y", deptName: "Y", num: 3, den: 6, value: 50 }, "departments under 5 assignments are skipped");
  assert.equal(WB.lowestRate([], 5), null);
});

test("to-do ordering: severity, then due date, then count", () => {
  const out = WB.sortTodo([
    { key: "a", severity: "normal", count: 9 },
    { key: "b", severity: "soon", dueOn: "2026-10-12", count: 1 },
    { key: "c", severity: "overdue", dueOn: "2026-10-01", count: 2 },
    { key: "d", severity: "soon", dueOn: "2026-10-10", count: 1 },
    { key: "e", severity: "soon", count: 50 },
    { key: "f", severity: "overdue", dueOn: "2026-10-01", count: 5 },
  ]);
  assert.deepEqual(out.map((x) => x.key), ["f", "c", "d", "b", "e", "a"]);
});

test("third layer: quota deviation, 12-month promotion rate, pipeline gaps", () => {
  const q = WB.quotaDeviation([
    { dept1Id: "d1", dept1: "Sales", headcount: 20, counts: { "A+": 2, A: 2, "B+": 3, B: 12, "C/D": 1 } },
    { dept1Id: "d2", dept1: "Tiny", headcount: 5, counts: { "A+": 3 } },
    { dept1Id: "__none", dept1: null, headcount: 40, counts: { "A+": 20 } },
  ], { "A+": 2, A: 8, "B+": 15, B: 70, "C/D": 5 }, {});
  assert.deepEqual(q[0].tiers.find((t) => t.tier === "A+"), { tier: "A+", count: 2, actualPct: 10, quotaPct: 2, deviationPp: 8 });
  assert.deepEqual(q[0].over, { tier: "A+", pp: 8 });
  assert.equal(q[1].small, true);
  assert.equal(q[1].over, null, "small departments are not flagged");
  assert.equal(q[2].small, true);
  const recs = {
    a: [{ type: "promotion", date: "2026-03-01", detail: { result: "Passed" } }],
    b: [{ type: "promotion", date: "2025-10-09", detail: { result: "Passed" } }],   // 正好 12 个月前 → 不计
    c: [{ type: "promotion", date: "2026-06-01", detail: { result: "Failed" } }],
  };
  const pr = WB.promotionRate12m([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], (u) => recs[u.id] || [], "2026-10-09");
  assert.deepEqual([pr.num, pr.den, pr.value, pr.ids], [1, 4, 25, ["a"]]);
  const ranks = [
    { rank: "MO1", grade: "O", level: 20, track: "M" }, { rank: "MV1", grade: "V", level: 18, track: "M" }, { rank: "MA1", grade: "A", level: 14, track: "M" },
    { rank: "PB1", grade: "B", level: 11, track: "P" }, { rank: "PC1", grade: "C", level: 8, track: "P" },
  ];
  const people = [{ id: "o", jobLevel: "MO1" }, { id: "v", jobLevel: "MV1" }, { id: "a1", jobLevel: "MA1" }, { id: "b", jobLevel: "PB1" }, { id: "c", jobLevel: "PC1" }];
  assert.deepEqual(WB.pipelineGaps(ranks, people, ["v", "c"]), [
    { track: "M", grade: "V", lowerGrade: "A", headcount: 1, lowerCandidates: 0 },
  ]);
  assert.deepEqual(WB.pipelineGaps(ranks, people, []).map((g) => g.track + g.grade), ["MO", "MV", "PB"]);
});

// ---------------------------------------------------------------- 前端镜像一致
const sharedBlock = (src) => {
  const a = src.indexOf("// >>> shared"), b = src.indexOf("// <<< shared");
  assert.ok(a >= 0 && b > a, "shared markers present");
  return src.slice(src.indexOf("\n", a) + 1, b);
};
test("controlled tags: web/src/controlledTags.js mirrors the server definitions (source and behaviour)", async () => {
  const webSrc = fs.readFileSync(WEB_CT, "utf8"), srvSrc = fs.readFileSync(SRV_CT, "utf8");
  assert.equal(sharedBlock(webSrc), sharedBlock(srvSrc), "the shared block must be byte-identical");
  assert.equal(/^\s*import\s/m.test(webSrc), false, "import-free ESM");
  assert.equal(/require\(/.test(webSrc), false);
  const W = await import(pathToFileURL(WEB_CT).href);
  assert.deepEqual([...W.KEYS], [...CT.KEYS]);
  assert.deepEqual(W.CANONICAL, CT.CANONICAL);
  assert.deepEqual(W.LABELS, CT.LABELS);
  assert.deepEqual(JSON.parse(JSON.stringify(W.ALIASES)), JSON.parse(JSON.stringify(CT.ALIASES)));
  assert.deepEqual([W.REASON_MIN, W.REASON_MAX], [CT.REASON_MIN, CT.REASON_MAX]);
  const corpus = [];
  for (const k of CT.KEYS) {
    const { zh, en } = CT.ALIASES[k];
    corpus.push(CT.CANONICAL[k], ...zh, ...en);
    for (const z of zh) for (const e of en) corpus.push(z + " " + e, e + " " + z, E(0x1f31f) + " " + z + e);
  }
  corpus.push("高潜 HiPo（2025）", "核心人才", "Retention risk", "继任候选 Successor", "", "© 高潜", E(0x1f1f5, 0x1f1ed) + "流失风险", "ＨｉＰｏ", null, 3);
  for (const s of corpus) {
    assert.equal(W.normKey(s), CT.normKey(s), JSON.stringify(s));
    assert.equal(W.keyOf(s), CT.keyOf(s), JSON.stringify(s));
    assert.equal(W.canonicalOf(s), CT.canonicalOf(s), JSON.stringify(s));
  }
  const lists = [["HiPo", "骨干", "高潜 HiPo", "Flight risk"], ["高潜 HiPo", "关键人才 Key talent"], []];
  for (const l of lists) {
    assert.deepEqual(W.mapTags(l), CT.mapTags(l));
    assert.deepEqual(W.controlledKeysOf(l), CT.controlledKeysOf(l));
    assert.deepEqual(W.freeTagsOf(l), CT.freeTagsOf(l));
    assert.deepEqual(W.checkTagSubmission(["高潜 HiPo"], l), CT.checkTagSubmission(["高潜 HiPo"], l));
  }
  for (const fn of ["isCanonical", "isReservedSpelling", "parseTags", "heldKeysOf", "normalizeTags", "applyControlled", "diffControlled", "reasonOf", "labelOf", "tagLabel"]) {
    assert.equal(typeof W[fn], "function", fn);
  }
});
