// 绩效看板第一期（负责人 2026-10-10 拍板，docs/PROPOSAL-20261010-performance-dashboard.md）：
//   1. web/src/pages/admin/perfdash.js 的计算（后台「周期进度」「结果与一致性」两个页签的全部数字都来自它）；
//   2. GET /api/me/reviews/team-dashboard（经理「我的团队」）：只含本人作为直属上级的人；进行中周期给我给出的分布与配额；
//      已关闭周期给最终（档案）评级与「我给的 → 最终」变动（HoD 代评不计）；关注名单 = 连续两期 C / D、较上期降两档及以上；
//      不下发人才标签与自评正文；不是上级的人拿到空数据；
//   3. 页面登记与员工端包不引 Semi（静态）。
// 真服务 + 一次性库（helpers.startServer），永不碰 lms.db。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ymd = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "无", goalsNext: ["下季度目标"] };

// ---------- 1. 纯函数 ----------
let PD;
const SCALE = ["A+", "A", "B+", "B", "C", "D"];
const it = (id, o) => ({ id, userId: "u-" + id, name: "N" + id, employeeId: "E" + id, dept1Id: "d1", manager: "M1", managerId: "m1", oneState: "both", selfAt: "x", overdue: [], ...o });

test("perfdash: progress rows, overdue, department status", async () => {
  PD = await import(pathToFileURL(path.join(ROOT, "web", "src", "pages", "admin", "perfdash.js")).href);
  const items = [
    it(1, { managerRating: "A" }), it(2, { managerRating: null, overdue: ["rate"] }), it(3, { selfAt: null, oneState: "none", finalRating: "C", hodProxy: { by: "h" }, overdue: ["self"] }),
    it(4, { dept1Id: "d2", managerRating: "B" }), it(5, { dept1Id: "d2", notCounted: "departed" }),
  ];
  const depts = [{ dept1Id: "d1", dept1: "Sales", hod: { id: "h" }, status: { hodSubmittedAt: null } }, { dept1Id: "d2", dept1: "Ops", hod: null, status: { hrConfirmedAt: "2026-10-01" } }];
  const p = PD.progressRows(items, depts, "quarter");
  assert.equal(p.total.n, 4, "the departed person is not counted");
  assert.deepEqual(p.rows.map((r) => [r.label, r.n, r.self.length, r.one.length, r.rated.length, r.overSelf.length, r.overRate.length]),
    [["Sales", 3, 2, 2, 1, 1, 1], ["Ops", 1, 1, 1, 1, 0, 0]]);
  assert.equal(p.total.ratedPct, 50);
  assert.deepEqual(p.total.proxy.map((x) => x.id), [3]);
  assert.equal(p.total.proxyPct, 25);
  assert.equal(p.rows[0].below, true, "Sales 33% < company 50%");
  assert.equal(p.rows[1].below, false);
  // 名单与数字同源
  for (const r of p.rows) assert.equal(r.people.length, r.n);
  const o = PD.overdueGroups(items);
  assert.deepEqual([o.self.map((x) => x.id), o.rate.map((x) => x.id)], [[3], [2]]);
  const st = PD.deptStatus(depts);
  assert.deepEqual([st.pendingHod.length, st.confirmed.length, st.noHod.length], [1, 1, 1]);
  const annual = PD.progressRows(items, depts, "annual");
  assert.equal(annual.total.selfPct, null, "annual cycles have no self-review stage");
});

test("perfdash: calibration transfer, raised/lowered by department, rating tendency, distribution", () => {
  const items = [
    it(1, { managerRating: "B", finalRating: "A" }),        // up
    it(2, { managerRating: "A", finalRating: "B+" }),       // down
    it(3, { managerRating: "B", finalRating: null }),       // same（最终 = 上级）
    it(4, { managerRating: null, finalRating: "C", hodProxy: { by: "h" } }),  // 代评：不计
    it(5, { dept1Id: "d2", managerId: "m2", manager: "M2", managerRating: "C", jobTrack: "M", jobGrade: 9 }),
    it(6, { dept1Id: "d2", managerId: "m2", manager: "M2", managerRating: "C", jobTrack: "M", jobGrade: 9 }),
    it(7, { dept1Id: "d2", managerId: "m2", manager: "M2", managerRating: "C", jobTrack: "P", jobGrade: 10 }),
    it(8, { dept1Id: "d2", managerId: "m3", manager: "M3", managerRating: "A", jobTrack: "P", jobGrade: 10 }),
    it(9, { dept1Id: "d2", managerId: "m3", manager: "M3", managerRating: "A" }),
    it(10, { dept1Id: "d2", managerId: "m3", manager: "M3", managerRating: "A" }),
  ];
  const t = PD.transfer(items, SCALE, false);
  assert.deepEqual([t.up.map((x) => x.id), t.down.map((x) => x.id)], [[1], [2]]);
  assert.equal(t.n, 9, "the HoD proxy row is excluded");
  assert.deepEqual(t.cells.B.A.map((x) => x.id), [1]);
  // 已关闭周期按档案评级
  const closed = PD.transfer([it(1, { managerRating: "B", finalRating: "B", recordRating: "A" })], SCALE, true);
  assert.equal(closed.up.length, 1);
  const mv = PD.moveRows(items, [{ dept1Id: "d1", dept1: "Sales" }, { dept1Id: "d2", dept1: "Ops" }], SCALE, false);
  assert.deepEqual(mv.map((r) => [r.label, r.n, r.up.length, r.down.length]), [["Sales", 3, 1, 1], ["Ops", 6, 0, 0]]);
  const ln = PD.leniency(items, SCALE);
  const m2 = ln.find((r) => r.managerId === "m2"), m3 = ln.find((r) => r.managerId === "m3");
  assert.deepEqual([m2.avg, m2.deptAvg, m2.diff, m2.flag], [2, 3.5, -1.5, "strict"]);
  assert.deepEqual([m3.avg, m3.diff, m3.flag], [5, 1.5, "lenient"]);
  assert.equal(ln.find((r) => r.managerId === "m1").n, 3, "the proxy row does not count toward M1");
  const byTrack = PD.distRows(items, (i) => i.jobTrack, false);
  assert.deepEqual(byTrack.map((r) => [r.key, r.n, (r.tiers["C/D"] || []).length]), [["M", 2, 2], ["P", 2, 1], ["__none", 6, 1]]);   // 代评那一行有最终评级 C，分布照计
  assert.equal(PD.scoreOf("A+", SCALE), 6);
  assert.equal(PD.scoreOf("D", SCALE), 1);
});

// ---------- 2. 经理「我的团队」接口 ----------
let srv, admin;
const people = {};
let unit;
function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
async function newPerson(eid, name, dept, mgr) {
  const r = await admin.post("/api/admin/employees", { name, employeeId: eid, department: dept, jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(eid)).id;
  if (mgr) assert.equal((await admin.put(`/api/admin/employees/${id}`, { managerId: people[mgr].id })).status, 200);
  const c = makeClient(srv.base);
  await c.login({ employeeId: eid, password: r.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: eid + "-pw-2026" })).status, 200);
  people[eid] = { id, client: c };
}
// 一个 v2 周期：E 自评 → 上级按 ratings 评级 →（可选）HoD 改评级 → HoD 提交 → HR 确认 →（可选）关闭
async function runCycle(name, ratings, { hod, close } = {}) {
  const ids = Object.keys(ratings).map((e) => people[e].id);
  const c = await admin.post("/api/admin/review-cycles", { name, flow: "v2", kind: "quarter", dueAt: ymd(NOW + 5 * DAY), dueRateAt: ymd(NOW + 7 * DAY), dueCalibAt: ymd(NOW + 9 * DAY), userIds: ids });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const cid = c.data.cycle.id;
  const items = {};
  for (const i of (await admin.get(`/api/admin/review-cycles/${cid}`)).data.items) items[i.employeeId] = i.id;
  for (const [e, r] of Object.entries(ratings)) {
    assert.equal((await people[e].client.post(`/api/me/reviews/${items[e]}/self`, selfBody)).status, 200);
    const mg = await people["PD-MGR"].client.post(`/api/me/reviews/${items[e]}/manager`, { rating: r, text: "ok", highlights: ["A+", "A", "C", "D"].includes(r) ? "关键亮点" : "" });
    assert.equal(mg.status, 200, e + ": " + JSON.stringify(mg.data));
  }
  for (const [e, r] of Object.entries(hod || {})) {
    const h = await people["PD-HOD"].client.put(`/api/me/reviews/hod/items/${items[e]}`, { rating: r, reason: "calibrated against peers" });
    assert.equal(h.status, 200, "hod " + e + ": " + JSON.stringify(h.data));
  }
  if (close) {
    const sub = await people["PD-HOD"].client.post("/api/me/reviews/hod/submit", { cycleId: cid, dept1Id: unit });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    assert.equal((await admin.post(`/api/admin/review-cycles/${cid}/depts/${unit}/confirm`, {})).status, 200);
    const cl = await admin.post(`/api/admin/review-cycles/${cid}/close`, {});
    assert.equal(cl.status, 200, JSON.stringify(cl.data));
  }
  await sleep(30);   // createdAt 递增，周期顺序确定
  return cid;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  await newPerson("PD-HOD", "Hana Hod", "PD Dept");
  unit = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "PD Dept").id;
  assert.equal((await admin.put(`/api/admin/departments/${unit}`, { ownerId: people["PD-HOD"].id })).status, 200);
  await newPerson("PD-MGR", "Milo Mgr", "PD Dept", "PD-HOD");
  await newPerson("PD-MGR2", "Mona Other", "PD Dept", "PD-HOD");
  for (const e of ["PD-E1", "PD-E2", "PD-E3", "PD-E4"]) await newPerson(e, "Emp " + e, "PD Dept", "PD-MGR");
  await newPerson("PD-X1", "Xavi Other Team", "PD Dept", "PD-MGR2");
  await runCycle("PD Q1", { "PD-E1": "C", "PD-E2": "B+", "PD-E3": "A", "PD-E4": "B" }, { close: true });
  await runCycle("PD Q2", { "PD-E1": "D", "PD-E2": "B+", "PD-E3": "B", "PD-E4": "B" }, { hod: { "PD-E2": "A" }, close: true });
  await runCycle("PD Q3", { "PD-E1": "B" });
});
after(async () => { if (srv) await srv.stopAsync(); });

test("team-dashboard: my team only; open cycle first with my distribution and quota; closed cycles carry final ratings and calibration moves", async () => {
  const r = await people["PD-MGR"].client.get("/api/me/reviews/team-dashboard");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.deepEqual(d.cycles.map((c) => [c.name, c.status]), [["PD Q3", "open"], ["PD Q2", "closed"], ["PD Q1", "closed"]]);
  const q3 = d.cycles[0], q2 = d.cycles[1];
  assert.deepEqual(q3.mine, { B: 1 });
  assert.equal(q3.final, null, "no final ratings for an open cycle");
  assert.ok(q3.quota && typeof q3.quota === "object", "v2 quota comes along");
  assert.deepEqual(q2.final, { D: 1, A: 1, B: 2 });
  assert.deepEqual(q2.moves, { up: 1, down: 0, same: 3 }, "the HoD raised PD-E2 from B+ to A");
  assert.equal(q2.people.find((p) => p.name === "Emp PD-E2").move, "up");
  // 只有本人作为直属上级的人
  const names = new Set(d.cycles.flatMap((c) => c.people.map((p) => p.name)));
  assert.ok(!names.has("Xavi Other Team"), "another manager's report never appears");
  // 不下发人才标签、自评正文
  const json = JSON.stringify(d);
  for (const k of ["talentTags", "selfFeedback", "selfOutcomes", "managerText", "employeeId"]) assert.ok(!json.includes(`"${k}"`), "no " + k);
});

test("team-dashboard: attention = C / D two closed cycles in a row, or down two levels or more", async () => {
  const d = (await people["PD-MGR"].client.get("/api/me/reviews/team-dashboard")).data;
  const att = new Map(d.attention.map((a) => [a.name, a]));
  assert.deepEqual(att.get("Emp PD-E1") && att.get("Emp PD-E1").reasons, ["low2"], "C then D");
  assert.deepEqual(att.get("Emp PD-E3") && [att.get("Emp PD-E3").reasons, att.get("Emp PD-E3").previous, att.get("Emp PD-E3").latest], [["drop2"], "A", "B"]);
  assert.ok(!att.has("Emp PD-E2") && !att.has("Emp PD-E4"));
  assert.ok(d.attention.every((a) => !("tags" in a)), "no talent tags");
});

test("team-dashboard: a person with no reports gets empty data; anonymous is refused", async () => {
  const e = (await people["PD-E1"].client.get("/api/me/reviews/team-dashboard")).data;
  assert.deepEqual([e.cycles, e.attention], [[], []]);
  const anon = await makeClient(srv.base).get("/api/me/reviews/team-dashboard");
  assert.equal(anon.status, 401);
});

test("QA 31-1: a legacy (non-v2) cycle's items carry their top-level department, so the dashboard does not lump everyone under 'no department'", async () => {
  PD = PD || await import(pathToFileURL(path.join(ROOT, "web", "src", "pages", "admin", "perfdash.js")).href);
  const c = await admin.post("/api/admin/review-cycles", { name: "PD Legacy", dueAt: ymd(NOW + 5 * DAY), userIds: [people["PD-E1"].id, people["PD-E2"].id] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const d = (await admin.get("/api/admin/review-cycles/" + c.data.cycle.id)).data;
  assert.notEqual(d.cycle.flow, "v2");
  assert.deepEqual(d.depts, [], "legacy cycles have no department groups");
  for (const i of d.items) assert.deepEqual([i.dept1Id, i.dept1], [unit, "PD Dept"], i.employeeId);
  const p = PD.progressRows(d.items, d.depts, "quarter");
  assert.deepEqual(p.rows.map((r) => [r.label, r.n]), [["PD Dept", 2]], "one row named after the department");
  const pg = read("web/src/pages/admin/PerfDashboard.jsx");
  assert.ok(pg.includes("...(v2 ? [{ title: s.pStatus"), "no department status column for legacy cycles");
  for (const k of ["columns={cardify(progCols)}", "columns={cardify(trCols)}", "columns={cardify(distCols(trackLabel))}", "columns={cardify(distCols(gradeLabel))}"]) assert.ok(pg.includes(k), "QA 31-2: phone cards carry column labels: " + k);
  // 第二、三期（10/10）：加了趋势分布表（cardify）与申诉三张拆分表（groupCols 内部 cardify，首列标题在 cardify 之前给定，手机卡片列名才对）
  assert.equal(pg.split("columns={cardify(").length - 1, 7, "all seven direct tables use cardify");
  assert.ok(pg.includes("const groupCols = (labelOf, firstTitle) => cardify([") && pg.split("columns={groupCols(").length - 1 === 3, "the three appeal breakdown tables go through cardify too");
  assert.ok(!/groupCols\([^)]*\)\)\.map\(/.test(pg) && !pg.includes(".map((c, k) => (k === 0 ? { ...c, title:"), "no column retitled after cardify (phone labels would be stale)");
});

// ---------- 3. 静态 ----------
test("pages are registered; the employee-side dashboard does not import Semi", () => {
  assert.match(read("web/src/rbac.js"), /\{ path: '\/admin\/perf-dashboard', group: 'performance', module: 'performance', domain: 'performance' \}/);
  assert.match(read("web/src/App.jsx"), /<Route path="perf-dashboard" element=\{<PerfDashboard \/>\} \/>/);
  const team = read("web/src/pages/ReviewTeamDashboard.jsx");
  assert.ok(!team.includes("@douyinfe/semi"), "employee bundle has no Semi");
  assert.match(read("web/src/pages/ReviewTeam.jsx"), /<TeamDashboard lang=\{lang\} label=\{label\} \/>/);
  const pg = read("web/src/pages/admin/PerfDashboard.jsx");
  for (const fn of ["progressRows", "overdueGroups", "deptStatus", "transfer", "moveRows", "leniency", "distRows"]) assert.ok(pg.includes("PD." + fn + "("), "page uses " + fn);
  assert.match(read("modules/performance/manifest.js"), /path: "\/api\/me\/reviews\/team-dashboard"/);
});
