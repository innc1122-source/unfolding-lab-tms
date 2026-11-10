// 绩效看板第二、三期（负责人 2026-10-10「开工」，方案 docs/PROPOSAL-20261010-performance-dashboard.md 第三、四节）：
//   1. 纯函数：perfdash.js 的 appealSummary / trendDist / trendDepts / talentSignals，calibOverview.js（HoD 部门校准概览），
//      myperf.js（我的绩效概要），appealcats.js 与 server.js APPEAL_CATEGORIES 逐项一致；
//   2. 接口：申诉原因分类（迁移 97）—— 员工端 GET 给分类表、提交时校验分类、可不带（记未分类）；后台列表行带 reasonCategory；
//      有处理权的人可以改正分类（审计 review.appeal.category），只读角色 403，已撤回 409；
//      周期明细只给能读人才发展的人带 flight / successor（第三期「高绩效保留」）；
//   3. 静态：员工端新组件不引 Semi；后台看板有四个页签。
// 真服务 + 一次性库（fixtures/appeal-world），永不碰 lms.db。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const W = require("./fixtures/appeal-world.js");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const SCALE = ["A+", "A", "B+", "B", "C", "D"];

// ---------- 1. 纯函数 ----------
test("appeal categories: the web copy matches server.js key for key, in the same order, in both languages", async () => {
  const AC = await imp("web/src/appealcats.js");
  const src = read("server.js");
  const m = src.match(/const APPEAL_CATEGORIES = Object\.freeze\((\[[\s\S]*?\])\);/);
  assert.ok(m, "APPEAL_CATEGORIES literal found in server.js");
  const server = vm.runInNewContext(m[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(AC.APPEAL_CATEGORIES)), JSON.parse(JSON.stringify(server)));
  assert.equal(AC.categoryLabel("process", "zh"), "评估过程不规范（如未面谈、反馈不足）");
  assert.equal(AC.categoryLabel(null, "zh"), "未分类");
  assert.equal(AC.categoryLabel("nope", "en"), "Not categorised");
});

test("perfdash.appealSummary: open / overdue / due soon, outcomes and rating changes, split by department, HRBP and reason", async () => {
  const PD = await imp("web/src/pages/admin/perfdash.js");
  const ap = (id, o) => ({ id, status: "submitted", overdue: false, workdaysLeft: 8, deptPath: ["d1"], handler: null, reasonCategory: "process", ratingAtSubmit: "B", currentRating: "B", ...o });
  const rows = [
    ap("a1"), ap("a2", { workdaysLeft: 2 }), ap("a3", { status: "in_review", overdue: true, workdaysLeft: null, handler: { id: "h1", name: "Hera" } }),
    ap("a4", { status: "maintained", handler: { id: "h1", name: "Hera" }, reasonCategory: null, deptPath: ["d2"] }),
    ap("a5", { status: "adjusted", handler: { id: "h2", name: "Hank" }, ratingAtSubmit: "B", currentRating: "B+", reasonCategory: "calibration", deptPath: ["d2"] }),
    ap("a6", { status: "adjusted", handler: { id: "h2", name: "Hank" }, ratingAtSubmit: "B", currentRating: "B+", reasonCategory: "calibration", deptPath: ["d2"] }),
    ap("a7", { status: "withdrawn" }),
  ];
  const s = PD.appealSummary(rows, [{ id: "d1", name: "Sales" }, { id: "d2", name: "Ops" }], [{ key: "process" }, { key: "calibration" }]);
  assert.equal(s.total, 7);
  assert.equal(s.withdrawn.length, 1);
  assert.equal(s.live.length, 6, "withdrawn appeals are not in the breakdowns");
  assert.deepEqual([s.open.length, s.overdue.length, s.dueSoon.length], [3, 1, 1], "a2 has 2 working days left = due soon; a3 is overdue");
  assert.deepEqual([s.decided.length, s.maintained.length, s.adjusted.length, s.adjustPct], [3, 1, 2, 66.7]);
  assert.deepEqual(s.changes.map((c) => [c.key, c.rows.length]), [["B → B+", 2]]);
  assert.deepEqual(s.byDept.map((d) => [d.label, d.n, d.open.length, d.adjusted.length]), [["Ops", 3, 0, 2], ["Sales", 3, 3, 0]], "ties sorted by name");
  assert.deepEqual(s.byHrbp.map((h) => [h.key, h.label, h.n]), [["h1", "Hera", 2], ["h2", "Hank", 2], ["__none", null, 2]], "not started goes last");
  assert.deepEqual(s.byCategory.map((c) => [c.key, c.n]), [["process", 3], ["calibration", 2], ["__none", 1]], "catalogue order, uncategorised last");
  // QA 34-1：申诉率与「申诉」KPI 同口径，不含已撤回（3 件未撤回 / 4 名可申诉 = 75）
  assert.equal(PD.appealRate(3, 4), 75);
  assert.equal(PD.appealRate(3, 0), null);
  const pg = read("web/src/pages/admin/PerfDashboard.jsx");
  assert.ok(pg.includes("PD.appealRate(apStat.appeals - apStat.withdrawn, apStat.eligible)") && !pg.includes("apStat.appealRate"), "rate = (appeals − withdrawn) / eligible, both from the same /stats row (same scope, conflicts excluded)");
});

test("perfdash trends: distribution per cycle (and per department), unstable / C-D twice / A twice with flight and successor flags", async () => {
  const PD = await imp("web/src/pages/admin/perfdash.js");
  const p = (u, r, o) => ({ id: "i" + u + r, userId: "u" + u, name: "N" + u, dept1Id: "d1", dept1: "Sales", recordRating: r, ...o });
  const series = [
    { cycle: { id: "c1", name: "Q1", closedAt: "2026-04-01" }, items: [p(1, "A"), p(2, "C"), p(3, "A+"), p(4, "B+"), p(5, "B", { dept1Id: "d2", dept1: "Ops" })] },
    { cycle: { id: "c2", name: "Q2", closedAt: "2026-07-01" }, items: [p(1, "C"), p(2, "D"), p(3, "A", { flight: true, successor: true }), p(4, "A+", { flight: false, successor: false }),
      p(5, "B", { dept1Id: "d2", dept1: "Ops", flight: false, successor: false }), p(6, "A", { notCounted: "departed", flight: true })] },
  ];
  const all = PD.trendDist(series, null);
  assert.deepEqual(all.map((r) => [r.label, r.n, (r.tiers["C/D"] || []).length]), [["Q1", 5, 1], ["Q2", 5, 2]], "the departed person is not counted");
  assert.deepEqual(PD.trendDist(series, "d2").map((r) => r.n), [1, 1]);
  assert.deepEqual(PD.trendDepts(series).map((d) => d.name), ["Ops", "Sales"]);
  const sg = PD.talentSignals(series, SCALE);
  assert.equal(sg.prev.name, "Q1");
  assert.deepEqual(sg.unstable.map((r) => [r.userId, r.prevRating, r.lastRating]).sort(), [["u1", "A", "C"], ["u4", "B+", "A+"]], "A → C moved three levels, B+ → A+ two; A+ → A and C → D only one");
  assert.deepEqual(sg.lowTwice.map((r) => r.userId), ["u2"]);
  assert.deepEqual(sg.highTwice.map((r) => r.userId), ["u3"]);
  assert.deepEqual([sg.highFlight.map((r) => r.userId), sg.highSuccessor.map((r) => r.userId), sg.flagsKnown], [["u3"], ["u3"], true]);
  assert.equal(PD.talentSignals(series.slice(0, 1), SCALE).prev, null, "one cycle is not enough");
  const noFlags = [series[0], { ...series[1], items: series[1].items.map(({ flight, successor, ...x }) => x) }];
  assert.equal(PD.talentSignals(noFlags, SCALE).flagsKnown, false, "without talent read the flags are unknown, not false");
});

test("perfdash trends: B+ → A+ counts as a two-level move", async () => {
  const PD = await imp("web/src/pages/admin/perfdash.js");
  const s = [{ cycle: { id: "a", name: "A" }, items: [{ userId: "u", recordRating: "B+" }] }, { cycle: { id: "b", name: "B" }, items: [{ userId: "u", recordRating: "A+" }] }];
  assert.equal(PD.talentSignals(s, SCALE).unstable.length, 1);
});

test("calibOverview: progress by sub-department and by manager, distribution, manager tendency, adjustment record", async () => {
  const CO = await imp("web/src/calibOverview.js");
  // 代码审查 10/11：deptPath 用服务端真实格式 —— reviewCalibView 已去掉一级部门本身，[] = 本部门直属（原夹具 ["d1","s1"] 与服务端不符，没测出分组错层）
  const r = (id, o) => ({ id, name: "N" + id, deptPath: ["s1"], managerId: "m1", manager: "Mia", selfAt: "x", oneState: "both", managerRating: "B", finalRating: null, overdue: [], ...o });
  const rows = [
    r(1, { managerRating: "A", finalRating: "B+", hodText: "对标同级" }), r(2), r(3, { selfAt: null, oneState: "mgr", managerRating: null, overdue: ["self"] }),
    r(4, { deptPath: ["s2"], managerId: "m2", manager: "Max", managerRating: "C", finalRating: "B" }),
    r(5, { deptPath: [], managerId: "m2", manager: "Max", managerRating: "C" }), r(6, { deptPath: [], managerId: "m2", manager: "Max", managerRating: "C" }),
    r(9, { deptPath: ["s1", "s1a"], managerId: "m1", manager: "Mia", managerRating: null, selfAt: null, oneState: "none", notCounted: "departed" }),
    r(7, { notCounted: "departed", managerRating: "A" }),
    r(8, { managerId: null, manager: null, managerRating: null, finalRating: "B", hodProxy: { by: "h", reason: "x" } }),
  ];
  const names = new Map([["s1", "Team One"], ["s2", "Team Two"]]);
  const pu = CO.progressBy(rows, CO.byUnit(names), CO.unitLabel(names), false);
  assert.deepEqual(pu.map((g) => [g.label, g.n, g.self.length, g.one.length, g.rated.length, g.overdue.length]),
    [["Team One", 4, 3, 3, 3, 1], ["Team Two", 1, 1, 1, 1, 0], [null, 2, 2, 2, 2, 0]], "departed not counted; direct reports of the department go last; a proxy rating counts as rated");
  const pm = CO.progressBy(rows, CO.byManager, CO.managerLabel, false);
  assert.deepEqual(pm.map((g) => [g.key, g.n]), [["m2", 3], ["m1", 3], ["__nomgr", 1]], "ties by name (Max before Mia), no manager last");
  const dist = CO.distBy(rows, CO.byUnit(names), CO.unitLabel(names));
  assert.deepEqual(dist.map((g) => [g.label, g.n, g.all, Object.fromEntries(Object.entries(g.tiers).map(([k, v]) => [k, v.length]))]),
    [["Team One", 3, 4, { "B+": 1, B: 2 }], ["Team Two", 1, 1, { B: 1 }], [null, 2, 2, { "C/D": 2 }]], "effective rating = final || manager");
  const len = CO.leniencyRows(rows, SCALE);
  assert.deepEqual(len.map((x) => [x.managerId, x.n, x.flag]), [["m2", 3, "strict"]], "Mia rated only 2 counted people (minimum 3); Max is well below the department average");
  const adj = CO.adjustSummary(rows, SCALE);
  assert.deepEqual([adj.adjusted.length, adj.up.length, adj.down.length, adj.proxies.length], [2, 1, 1, 1], "proxy ratings are not adjustments");
  assert.deepEqual(adj.reasons.map((x) => [x.from, x.to, x.text]), [["A", "B+", "对标同级"]]);
  // QA 34-3：有调整、没写理由时写「还没有填写调整理由」，不是「还没有调整」
  const ov = read("web/src/components/DeptCalibOverview.jsx");
  assert.ok(ov.includes("adj.adjusted.length ? s.reasonsEmpty : s.reasonsNone") && ov.includes("reasonsEmpty: '还没有填写调整理由。'"));
});

test("myperf: steps and who acts next; recent results; active appeals", async () => {
  const MP = await imp("web/src/myperf.js");
  const base = { flow: "v2", dueAt: "2026-10-20", dueRateAt: "2026-10-25", dueCalibAt: "2026-10-30" };
  const st = (o) => MP.stepsOf({ ...base, ...o });
  assert.deepEqual([st({}).current, st({}).who, st({}).due], ["self", "me", "2026-10-20"]);
  assert.deepEqual([st({ selfAt: "x" }).current, st({ selfAt: "x" }).who], ["one", "both"]);
  assert.equal(st({ selfAt: "x", oneOnOneAt: "x" }).who, "me", "the manager recorded it; the employee still has to");
  assert.equal(st({ selfAt: "x", employeeOneOnOneAt: "x" }).who, "manager");
  const r = st({ selfAt: "x", oneOnOneAt: "x", employeeOneOnOneAt: "x" });
  assert.deepEqual([r.current, r.who, r.due], ["rate", "manager", "2026-10-25"]);
  assert.equal(st({ selfAt: "x", oneOnOneAt: "x", employeeOneOnOneAt: "x", managerGone: true }).who, "hod");
  const c = st({ selfAt: "x", oneOnOneAt: "x", employeeOneOnOneAt: "x", managerDone: true });
  assert.deepEqual([c.current, c.who, c.due, c.steps.map((x) => x.state).join(",")], ["calib", "hod", "2026-10-30", "done,done,done,current,todo"]);
  // QA 34-2：上级已评级、面谈还没登记 → 面谈「可补登记」，当前步到部门校准（面谈不是评级前提）
  const late = st({ selfAt: "x", oneOnOneAt: null, employeeOneOnOneAt: null, managerDone: true });
  assert.deepEqual([late.current, late.who, late.due, late.steps.map((x) => x.state).join(",")], ["calib", "hod", "2026-10-30", "done,late,done,current,todo"]);
  assert.equal(st({ managerDone: true }).steps[0].state, "late", "an unsent (not yet locked) self-review can still be submitted");
  const missed = st({ selfLocked: true });
  assert.deepEqual([missed.steps[0].state, missed.current], ["missed", "one"], "a locked, unsent self-review is marked and the flow moves on");
  assert.equal(MP.stepsOf(null), null);
  const items = [
    { id: 1, cycle: "Q1", kind: "quarter", rating: "B", closedAt: "2026-04-01" }, { id: 2, cycle: "2025", kind: "annual", rating: "B+", closedAt: "2026-02-01" },
    { id: 3, cycle: "Q2", kind: "quarter", rating: "A", closedAt: "2026-07-01", appeal: { state: "open" } },
    { id: 4, cycle: "Q3", kind: "quarter", rating: "B+", closedAt: "2026-10-01", appeal: { state: "closed", submittedAt: "x", decidedAt: "y" } },
  ];
  const rr = MP.recentResults(items, 2);
  assert.deepEqual([rr.latest.id, rr.quarters.map((q) => q.id)], [4, [3, 4]]);
  assert.deepEqual(MP.activeAppeals(items).map((i) => i.id), [3]);
  assert.deepEqual(MP.activeAppeals([{ id: 9, appeal: { state: "filed", submittedAt: "x" } }]).map((i) => i.id), [9], "submitted, no decision yet");
});

// ---------- 2. 接口 ----------
const NOW0 = "2026-10-09T10:00:00+08:00";
let w, Q;
before(async () => {
  w = await W.bootWorld(new Date(NOW0).toISOString());
  await W.buildAppealWorld(w, {});
  await w.cover("Dept B", ["P-HB"]);
  Q = await w.runV2Cycle("2026Q3 Phase2", { "E-A": "B+", "E-A1": "B", "E-B": "A", "E-C": "B", "E-D": "C" });
});
after(async () => { if (w) await w.stop(); });

test("appeal category: the form gets the catalogue; a bad key is refused; a good one is stored and shown back; leaving it out is allowed (not categorised)", async () => {
  const g = await (await w.as("E-B")).get(`/api/me/reviews/${Q.items["E-B"]}/appeal`);
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.deepEqual(g.data.categories.map((c) => c.key), ["rating_mismatch", "unclear_criteria", "process", "wrong_facts", "calibration", "other"]);
  const bad = await w.submit("E-B", Q.items["E-B"], { reason: W.text(80), category: "money" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "appeal_category");
  assert.equal(w.appealRow(Q.items["E-B"]), undefined, "nothing written");
  const ok = await w.submit("E-B", Q.items["E-B"], { reason: W.text(80), category: "process" });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.appeal.category, "process");
  assert.equal(w.appealRow(Q.items["E-B"]).reasonCategory, "process");
  const au = w.audits("review.appeal.submit").find((a) => a.target === Q.items["E-B"]);
  assert.equal(au.after.category, "process");
  const none = await w.submit("E-C", Q.items["E-C"], { reason: W.text(80) });
  assert.equal(none.status, 201, JSON.stringify(none.data));
  assert.equal(none.data.appeal.category, null);
  assert.equal(w.appealRow(Q.items["E-C"]).reasonCategory, null);
});

test("appeal category: the admin list carries reasonCategory and the catalogue; the handler corrects it (audited); read-only roles cannot; withdrawn appeals stay as they are", async () => {
  const hb = await w.as("P-HB");
  const list = await hb.get(`/api/admin/review-appeals?cycle=${Q.id}&status=all`);
  assert.equal(list.status, 200, JSON.stringify(list.data));
  const row = list.data.items.find((x) => x.itemId === Q.items["E-B"]);
  assert.ok(row, "the HRBP of Dept B sees E-B's appeal");
  assert.equal(row.reasonCategory, "process");
  assert.equal(list.data.categories.length, 6);
  const det = await hb.get(`/api/admin/review-appeals/${row.id}`);
  assert.equal(det.status, 200, JSON.stringify(det.data));
  assert.equal(det.data.permissions.canCategorize, true);
  assert.equal(det.data.appeal.reasonCategory, "process");
  const wrong = await hb.post(`/api/admin/review-appeals/${row.id}/category`, { category: "nope" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, "appeal_category");
  const fix = await hb.post(`/api/admin/review-appeals/${row.id}/category`, { category: "calibration" });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  assert.equal(fix.data.appeal.reasonCategory, "calibration");
  assert.equal(w.appealRow(Q.items["E-B"]).reasonCategory, "calibration");
  assert.equal(w.appealRow(Q.items["E-B"]).status, "submitted", "the status does not change");
  const au = w.audits("review.appeal.category");
  assert.equal(au.length, 1);
  assert.deepEqual([au[0].before.category, au[0].after.category], ["process", "calibration"]);
  const again = await hb.post(`/api/admin/review-appeals/${row.id}/category`, { category: "calibration" });
  assert.equal(again.status, 200);
  assert.equal(w.audits("review.appeal.category").length, 1, "no audit when nothing changes");
  // 只读（绩效读）看得到、改不了
  const pr = await w.as("P-PR");
  const prDet = await pr.get(`/api/admin/review-appeals/${row.id}`);
  assert.equal(prDet.status, 200, JSON.stringify(prDet.data));
  assert.equal(prDet.data.view, "meta", "performance-read sees the summary view");
  assert.ok(!prDet.data.permissions.canCategorize);
  const prFix = await pr.post(`/api/admin/review-appeals/${row.id}/category`, { category: "other" });
  assert.equal(prFix.status, 403);
  assert.equal(prFix.data.code, "appeal_no_permission");
  // 已撤回的不改
  assert.equal((await (await w.as("E-C")).post(`/api/me/reviews/${Q.items["E-C"]}/appeal/withdraw`, {})).status, 200);
  const sa = await w.as("SA");
  const cRow = (await sa.get(`/api/admin/review-appeals?cycle=${Q.id}&status=all`)).data.items.find((x) => x.itemId === Q.items["E-C"]);
  const wd = await sa.post(`/api/admin/review-appeals/${cRow.id}/category`, { category: "other" });
  assert.equal(wd.status, 409, JSON.stringify(wd.data));
  assert.equal(wd.data.code, "appeal_state");
  // 代码审查 10/11：处理中只有处理人能改分类；有结论后不能再改
  assert.equal((await hb.post(`/api/admin/review-appeals/${row.id}/start`, {})).status, 200);
  assert.equal((await hb.get(`/api/admin/review-appeals/${row.id}`)).data.permissions.canCategorize, true, "the handler can still correct it");
  const dec = await hb.post(`/api/admin/review-appeals/${row.id}/decide`, { outcome: "maintain", reply: W.text(80), expectRating: row.currentRating });
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  assert.equal((await hb.get(`/api/admin/review-appeals/${row.id}`)).data.permissions.canCategorize, false);
  const late = await hb.post(`/api/admin/review-appeals/${row.id}/category`, { category: "other" });
  assert.equal(late.status, 409, JSON.stringify(late.data));
  assert.equal(late.data.code, "appeal_state");
  assert.equal(w.appealRow(Q.items["E-B"]).reasonCategory, "calibration", "unchanged after the decision");
  // CX-065（负责人 10/11 定）：员工端仍显示本人提交时选的原因；HRBP 的改正只影响统计
  const emp = await (await w.as("E-B")).get(`/api/me/reviews/${Q.items["E-B"]}/appeal`);
  assert.equal(emp.data.appeal.category, "process", "the employee sees the reason they chose, not HRBP's correction (calibration)");
  assert.equal(w.appealRow(Q.items["E-B"]).reasonCategory, "calibration", "statistics use the corrected category");
});

test("cycle detail: flight / successor flags only for people who can read talent development", async () => {
  const sa = await w.as("SA");
  const tag = await sa.post(`/api/admin/employees/${w.id("E-B")}/controlled-tags`, { tag: "flight", action: "add", reason: "phase 3 test" });
  assert.equal(tag.status, 200, JSON.stringify(tag.data));
  const succ = await sa.post("/api/admin/succession", { positionName: "Head of B", userId: w.id("E-A"), readiness: "ready" });
  assert.equal(succ.status, 200, JSON.stringify(succ.data));
  const full = await sa.get(`/api/admin/review-cycles/${Q.id}`);
  assert.equal(full.status, 200);
  const by = (d, eid) => d.items.find((i) => i.userId === w.id(eid));
  assert.deepEqual([by(full.data, "E-B").flight, by(full.data, "E-B").successor], [true, false]);
  assert.deepEqual([by(full.data, "E-A").flight, by(full.data, "E-A").successor], [false, true]);
  const pr = await (await w.as("P-PR")).get(`/api/admin/review-cycles/${Q.id}`);
  assert.equal(pr.status, 200, JSON.stringify(pr.data));
  assert.ok(pr.data.items.length > 0);
  for (const i of pr.data.items) assert.ok(!("flight" in i) && !("successor" in i), "performance-read only: no talent flags");
  assert.equal(full.data.talentFlags, true);
  assert.equal(pr.data.talentFlags, false, "the page is told the flags are not available, not that nobody is at risk");
  // 代码审查 10/11：「绩效与人才」角色的 HR 本人在周期里且被标了流失风险 → 自己那一行不带 flight（与 tagsForViewer 同口径）
  assert.equal((await w.patch("E-D", { adminRoleId: await w.builtinRole("performance-talent-admin") })).status, 200);
  assert.equal((await sa.post(`/api/admin/employees/${w.id("E-D")}/controlled-tags`, { tag: "flight", action: "add", reason: "self view test" })).status, 200);
  const self = await (await w.as("E-D")).get(`/api/admin/review-cycles/${Q.id}`);
  assert.equal(self.status, 200, JSON.stringify(self.data));
  assert.ok(!("flight" in by(self.data, "E-D")), "no flight key on the viewer's own row");
  assert.equal(by(self.data, "E-B").flight, true, "other people's flags are still shown");
  const saNow = await sa.get(`/api/admin/review-cycles/${Q.id}`);
  assert.equal(by(saNow.data, "E-D").flight, true, "a super admin sees every flag");
});

// ---------- 3. 静态 ----------
test("static: employee-bundle files do not import Semi; the admin dashboard has four tabs; the calibration page mounts the overview for the HoD only", () => {
  for (const f of ["web/src/components/DeptCalibOverview.jsx", "web/src/calibOverview.js", "web/src/myperf.js", "web/src/appealcats.js", "web/src/pages/ReviewAppeal.jsx", "web/src/pages/Review.jsx"])
    assert.ok(!read(f).includes("@douyinfe/semi"), f + " stays Semi-free");
  const pd = read("web/src/pages/admin/PerfDashboard.jsx");
  for (const k of ["'progress', s.tabProgress", "'results', s.tabResults", "'appeals', s.tabAppeals", "'trends', s.tabTrends"]) assert.ok(pd.includes(k), k);
  const dc = read("web/src/components/DeptCalibration.jsx");
  assert.ok(/\{isHod && rows\.length > 0 && <DeptCalibOverview /.test(dc), "HoD only");
  const rv = read("web/src/pages/Review.jsx");
  assert.ok(rv.includes("<MyPerfSummary ") && rv.includes("mine={d.mine}"), "summary on My performance");
  const ap = read("web/src/pages/ReviewAppeal.jsx");
  assert.ok(ap.includes("category: cat") && /cat !== ''/.test(ap), "the form sends the category and requires it");
});
