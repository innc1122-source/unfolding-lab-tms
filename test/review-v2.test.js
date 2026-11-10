// 绩效流程 v2（迁移 65，2026-10-06 负责人决定）：
//   员工填表 → 1 对 1 面谈（员工与上级各自确认）→ 上级评级（A+/A 与 C/D 须写关键亮点）
//   → HoD 按一级部门比例校准（改上级评级须写理由）并提交 → HR 按部门确认或退回 → 关闭（须全部部门已确认）。
//   年度周期：员工与上级不填，HoD 提出评级、HR 审核；人数 ≥ 10 的部门超出配额不能提交。
//   旧流程周期（不传 flow）行为不变，见 test/review.test.js。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin;
const people = {};   // employeeId → { id, client }
async function newPerson(employeeId, name, department, managerEmployeeId) {
  const r = await admin.post("/api/admin/employees", { name, employeeId, department, jobLevel: "PB2" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: r.data.password });
  await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: "v2-pass-123" });
  const id = (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === employeeId).id;
  if (managerEmployeeId) assert.equal((await admin.put(`/api/admin/employees/${id}`, { managerId: people[managerEmployeeId].id })).status, 200);
  people[employeeId] = { id, client: c };
  return people[employeeId];
}
async function setOwner(deptName, userId) {
  const d = (await admin.get("/api/admin/departments")).data.find((x) => x.name === deptName);
  assert.ok(d, "department " + deptName);
  assert.equal((await admin.put(`/api/admin/departments/${d.id}`, { ownerId: userId })).status, 200);
  return d.id;
}
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };

let cycleId, deptId, items;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // QA 部门：HoD → 经理 → 两名员工
  await newPerson("V2-HOD", "Hana Hod", "QA Dept");
  deptId = await setOwner("QA Dept", people["V2-HOD"].id);
  await newPerson("V2-MGR", "Mark Mgr", "QA Dept", "V2-HOD");
  await newPerson("V2-E1", "Eve One", "QA Dept", "V2-MGR");
  await newPerson("V2-E2", "Ed Two", "QA Dept", "V2-MGR");
});
after(() => srv.stop());

test("v2 cycle: created with kind / deadlines / quota; employees see the flow flag", async () => {
  const r = await admin.post("/api/admin/review-cycles", {
    name: "2026Q3 QA", flow: "v2", kind: "quarter", dueAt: "2026-10-20", dueRateAt: "2026-10-25", dueCalibAt: "2026-10-30",
    userIds: ["V2-MGR", "V2-E1", "V2-E2"].map((k) => people[k].id),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  cycleId = r.data.cycle.id;
  assert.equal(r.data.cycle.flow, "v2");
  assert.equal(r.data.cycle.kind, "quarter");
  const mine = (await people["V2-E1"].client.get("/api/me/reviews")).data;
  assert.equal(mine.mine.length, 1);
  assert.equal(mine.mine[0].flow, "v2");
  assert.equal(mine.isHod, false);
  const detail = (await admin.get(`/api/admin/review-cycles/${cycleId}`)).data;
  assert.deepEqual(detail.cycle.quota, { "A+": 2, "A": 8, "B+": 15, "B": 70, "C/D": 5 });
  assert.equal(detail.depts.length, 1);
  assert.equal(detail.depts[0].dept1, "QA Dept");
  assert.equal(detail.depts[0].hod.name, "Hana Hod");
  items = Object.fromEntries(detail.items.map((i) => [i.employeeId, i.id]));
});

test("v2: the 1-on-1 is logged independently of the self-review and the rating (2.1); manager needs highlights for A+/A/C/D", async () => {
  const e1 = people["V2-E1"].client, e2 = people["V2-E2"].client, m = people["V2-MGR"].client;
  // 第二批 2.1（2026-10-08）：员工登记面谈不再以自评为前提（原来是 400 self_required）；撤销照常
  const early = await e2.post(`/api/me/reviews/${items["V2-E2"]}/one-on-one`, { done: true });
  assert.equal(early.status, 200, JSON.stringify(early.data));
  assert.equal((await e2.post(`/api/me/reviews/${items["V2-E2"]}/one-on-one`, { done: false })).status, 200);
  assert.equal((await e1.post(`/api/me/reviews/${items["V2-E1"]}/self`, selfBody)).status, 200);
  assert.equal((await e1.post(`/api/me/reviews/${items["V2-E1"]}/one-on-one`, { done: true })).status, 200);
  assert.ok((await e1.get("/api/me/reviews")).data.mine[0].employeeOneOnOneAt);
  const noHl = await m.post(`/api/me/reviews/${items["V2-E1"]}/manager`, { rating: "A" });
  assert.equal(noHl.status, 400);
  assert.equal(noHl.data.code, "highlights_required");
  // 评级不以面谈为前提：不勾选面谈也能评，且不会顺带替上级登记面谈
  assert.equal((await m.post(`/api/me/reviews/${items["V2-E1"]}/manager`, { rating: "A", highlights: "把夜班交接做成了标准流程", text: "稳定可靠" })).status, 200);
  let d = (await admin.get(`/api/admin/review-cycles/${cycleId}`)).data;
  assert.equal(d.items.find((i) => i.employeeId === "V2-E1").oneOnOneAt, null, "rating no longer logs the manager's side of the 1-on-1");
  // 补丁语义：只改评级不清掉上级评语与关键亮点
  assert.equal((await m.post(`/api/me/reviews/${items["V2-E1"]}/manager`, { rating: "A" })).status, 200);
  d = (await admin.get(`/api/admin/review-cycles/${cycleId}`)).data;
  const it1 = d.items.find((i) => i.employeeId === "V2-E1");
  assert.equal(it1.managerText, "稳定可靠");
  assert.equal(it1.highlights, "把夜班交接做成了标准流程");
  assert.equal((await m.post(`/api/me/reviews/${items["V2-E1"]}/one-on-one`, { done: true })).status, 200, "the manager logs their side separately");
  // U5：v2 进行中员工本人看不到上级原评级（只知道上级已评），也没有 HoD 理由与最终评级
  const mineE1 = (await e1.get("/api/me/reviews")).data.mine[0];
  assert.equal(mineE1.managerDone, true);
  assert.ok(!("managerRating" in mineE1), "U5: no managerRating in mine[] for a v2 cycle");
  assert.ok(!("hodText" in mineE1) && !("finalRating" in mineE1));
  // 第二批 2.1：上级评语、关键亮点、评级时间同样不给员工本人
  assert.ok(!("managerText" in mineE1) && !("highlights" in mineE1) && !("managerAt" in mineE1), JSON.stringify(Object.keys(mineE1)));
  assert.equal(mineE1.managerGone, false);
  assert.equal(mineE1.selfLocked, false);
  // HoD 提交前员工仍可改自评
  assert.equal((await e1.post(`/api/me/reviews/${items["V2-E1"]}/self`, selfBody)).status, 200);
  // B 不需要关键亮点
  assert.equal((await e2.post(`/api/me/reviews/${items["V2-E2"]}/self`, selfBody)).status, 200);
  assert.equal((await e2.post(`/api/me/reviews/${items["V2-E2"]}/one-on-one`, { done: true })).status, 200);
  assert.equal((await m.post(`/api/me/reviews/${items["V2-E2"]}/manager`, { rating: "B", oneOnOneDone: true })).status, 200);
});

test("v2: the HoD sees the department, cannot submit with open items, must give a reason to change a rating", async () => {
  const hod = people["V2-HOD"].client;
  const r = (await hod.get("/api/me/reviews")).data;
  assert.equal(r.isHod, true);
  // 波次 3（W3-S）：/hod 只有部门校准视图一种形状（旧的 groups[].items 已删），部门数字在 view.dept、行在 view.rows
  const g = (await hod.get("/api/me/reviews/hod")).data.groups;
  assert.equal(g.length, 1);
  assert.equal(g[0].dept1, "QA Dept");
  assert.equal(g[0].view.rows.filter((r) => !r.notCounted).length, 3);
  // 第二批：manager_rating_missing 改为 rating_missing（上级评级或 HoD 评级任一即可），带条目 ids；面谈不再阻断
  const iss = g[0].view.dept.issues;
  assert.ok(iss.some((x) => x.code === "rating_missing" && x.n === 1 && x.ids.length === 1 && x.ids[0] === items["V2-MGR"]), "Mark has no rating yet: " + JSON.stringify(iss));
  assert.ok(!iss.some((x) => x.code === "one_on_one_unconfirmed"), "the 1-on-1 no longer blocks submission");
  const blocked = await hod.post("/api/me/reviews/hod/submit", { cycleId, dept1Id: deptId });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.code, "submit_blocked");
  // HoD 是 Mark 的直属上级：先完成 Mark 的自评、双方面谈与评级
  const m = people["V2-MGR"].client;
  assert.equal((await m.post(`/api/me/reviews/${items["V2-MGR"]}/self`, selfBody)).status, 200);
  assert.equal((await m.post(`/api/me/reviews/${items["V2-MGR"]}/one-on-one`, { done: true })).status, 200);
  assert.equal((await hod.post(`/api/me/reviews/${items["V2-MGR"]}/manager`, { rating: "B+", oneOnOneDone: true })).status, 200);
  // 改上级评级要理由
  const noReason = await hod.put(`/api/me/reviews/hod/items/${items["V2-E2"]}`, { rating: "B+" });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, "reason_required");
  assert.equal((await hod.put(`/api/me/reviews/hod/items/${items["V2-E2"]}`, { rating: "B+", reason: "客户满意度全组第一" })).status, 200);
  // 非 HoD 不能校准
  assert.equal((await m.put(`/api/me/reviews/hod/items/${items["V2-E2"]}`, { rating: "A", reason: "x" })).status, 404);
  // 小部门（3 人）超额只提示：A 档名额 floor(3×8%) = 0，Eve 是 A
  const g2 = (await hod.get("/api/me/reviews/hod")).data.groups[0].view.dept;
  assert.equal(g2.small, true);
  assert.ok(g2.over.some((o) => o.tier === "A"));
  assert.equal(g2.issues.length, 0, "small department: over-quota does not block");
  assert.equal((await hod.post("/api/me/reviews/hod/submit", { cycleId, dept1Id: deptId })).status, 200);
  // 提交后上级与 HoD 都不能再改
  const locked = await m.post(`/api/me/reviews/${items["V2-E1"]}/manager`, { rating: "A+", oneOnOneDone: true, highlights: "x" });
  assert.equal(locked.status, 400);
  assert.equal(locked.data.code, "dept_locked");
  assert.equal((await hod.put(`/api/me/reviews/hod/items/${items["V2-E1"]}`, { rating: "A" })).data.code, "dept_locked");
  // U3：HoD 提交后员工自评锁定
  const e1 = people["V2-E1"].client;
  const selfLocked = await e1.post(`/api/me/reviews/${items["V2-E1"]}/self`, selfBody);
  assert.equal(selfLocked.status, 409);
  assert.equal(selfLocked.data.code, "self_locked");
  assert.equal((await e1.get("/api/me/reviews")).data.mine[0].selfLocked, true);
});

test("v2: HR can return (with a reason) or confirm; closing needs every department confirmed", async () => {
  const closeEarly = await admin.post(`/api/admin/review-cycles/${cycleId}/close`, {});
  assert.equal(closeEarly.status, 400);
  assert.equal(closeEarly.data.code, "depts_unconfirmed");
  assert.equal((await admin.post(`/api/admin/review-cycles/${cycleId}/depts/${deptId}/return`, {})).data.code, "reason_required");
  assert.equal((await admin.post(`/api/admin/review-cycles/${cycleId}/depts/${deptId}/return`, { reason: "A 档请再看一次" })).status, 200);
  let dep = (await admin.get(`/api/admin/review-cycles/${cycleId}`)).data.depts[0];
  assert.equal(dep.status.hodSubmittedAt, null);
  assert.equal(dep.status.returnReason, "A 档请再看一次");
  // U3：退回只回到 HoD 手里，员工侧仍锁定
  const e1 = people["V2-E1"].client;
  assert.equal((await e1.post(`/api/me/reviews/${items["V2-E1"]}/self`, selfBody)).data.code, "self_locked");
  assert.equal((await e1.get("/api/me/reviews")).data.mine[0].selfLocked, true);
  // 退回后不能直接确认（HoD 未重新提交）
  assert.equal((await admin.post(`/api/admin/review-cycles/${cycleId}/depts/${deptId}/confirm`, {})).data.code, "not_submitted");
  const hod = people["V2-HOD"].client;
  assert.equal((await hod.post("/api/me/reviews/hod/submit", { cycleId, dept1Id: deptId })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${cycleId}/depts/${deptId}/confirm`, {})).status, 200);
  dep = (await admin.get(`/api/admin/review-cycles/${cycleId}`)).data.depts[0];
  assert.ok(dep.status.hrConfirmedAt);
  // 已确认的部门 HR 也不能再直接改
  assert.equal((await admin.put(`/api/admin/review-items/${items["V2-E1"]}`, { finalRating: "B" })).data.code, "dept_confirmed");
  const closed = await admin.post(`/api/admin/review-cycles/${cycleId}/close`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.written, 3);
});

test("v2: My Performance lists the closed cycle with the final rating and comments, never the key highlights", async () => {
  const h1 = (await people["V2-E1"].client.get("/api/me/reviews/history")).data;
  assert.equal(h1.visible, true);
  const row = h1.items.find((i) => i.cycle === "2026Q3 QA");
  assert.equal(row.rating, "A");
  assert.equal(row.managerText, "稳定可靠");
  // 审查 P0-4（2026-10-08）：关键亮点一律不下发（亮点按上级原评级写，有无与档位能推断出被调整或代评）
  assert.ok(!("highlights" in row), JSON.stringify(row));
  assert.ok(!JSON.stringify(h1).includes("把夜班交接做成了标准流程"));
  const h2 = (await people["V2-E2"].client.get("/api/me/reviews/history")).data;
  assert.equal(h2.items.find((i) => i.cycle === "2026Q3 QA").rating, "B+", "HoD calibration is the final rating");
  assert.equal((await people["V2-E1"].client.get("/api/me/reviews")).data.hasHistory, true);
});

// 第二批 2.6 护栏（审查 P0-5，2026-10-08）：同一期已有周期归档的绩效记录，不能再新建 / 导入一条绕开「改评级须写理由」
test("2.6 guard: a performance record for a period already archived from a closed cycle can't be created, imported or edited into it (period_has_cycle_record)", async () => {
  const e1 = people["V2-E1"].id;
  const dup = await admin.post(`/api/admin/employees/${e1}/records`, { type: "performance", date: "2026-10-01", title: "manual", fields: { rating: "C", period: " 2026q3 qa ", summary: "x" } });
  assert.equal(dup.status, 409, JSON.stringify(dup.data));
  assert.equal(dup.data.code, "period_has_cycle_record");
  assert.match(dup.data.error, /Edit that record.*编辑原记录/);
  const bulk = await admin.post("/api/admin/records/bulk", { rows: [
    { employeeId: "V2-E1", type: "performance", date: "2026-10-02", title: "imp-1", fields: { rating: "C", period: "2026Q3 QA" } },
    { employeeId: "V2-E1", type: "performance", date: "2026-10-02", title: "imp-2", fields: { rating: "B", period: "2026Q2 QA" } },
  ] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.deepEqual(bulk.data.results.map((r) => [r.status, r.code || null]), [["skipped", "period_has_cycle_record"], ["created", null]]);
  // 不在那个周期里的人、其他期间不受影响
  const other = await admin.post(`/api/admin/employees/${people["V2-HOD"].id}/records`, { type: "performance", date: "2026-10-01", title: "hod", fields: { rating: "B", period: "2026Q3 QA" } });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  // 编辑同样拦（审查）：先建一条别的期间，再改成已归档的那一期 → 409；只改别的字段、期间不变照常
  const tmp = await admin.post(`/api/admin/employees/${e1}/records`, { type: "performance", date: "2026-10-03", title: "tmp", fields: { rating: "B", period: "temp" } });
  assert.equal(tmp.status, 200, JSON.stringify(tmp.data));
  const moved = await admin.put(`/api/admin/records/${tmp.data.record.id}`, { fields: { rating: "C", period: "2026Q3 QA" } });
  assert.equal(moved.status, 409, JSON.stringify(moved.data));
  assert.equal(moved.data.code, "period_has_cycle_record");
  // 第二批 2.6（波次 2）：改绩效评级须写理由（G6，所有绩效记录都要）
  assert.equal((await admin.put(`/api/admin/records/${tmp.data.record.id}`, { fields: { rating: "C", period: "temp" } })).data.code, "rating_reason_required");
  assert.equal((await admin.put(`/api/admin/records/${tmp.data.record.id}`, { fields: { rating: "C", period: "temp" }, ratingReason: "fixing the import" })).status, 200);
  // 改类型成绩效、期间撞上归档那一期 → 同样 409
  const note = await admin.post(`/api/admin/employees/${e1}/records`, { type: "note", date: "2026-10-04", title: "note", fields: { text: "x" } });
  assert.equal(note.status, 200, JSON.stringify(note.data));
  const retyped = await admin.put(`/api/admin/records/${note.data.record.id}`, { type: "performance", fields: { rating: "C", period: "2026Q3 QA" } });
  assert.equal(retyped.status, 409, JSON.stringify(retyped.data));
  assert.equal(retyped.data.code, "period_has_cycle_record");
  // 归档记录本身照常能改（排除自己）
  const archivedId = (await admin.get(`/api/admin/review-cycles/${cycleId}`)).data.items.find((i) => i.employeeId === "V2-E1").recordId;
  assert.ok(archivedId);
  // 评级不变、只改评语：不要理由（第二批 2.6 只对改评级要理由）
  const self = await admin.put(`/api/admin/records/${archivedId}`, { fields: { rating: "A", period: "2026Q3 QA", summary: "typo fixed" } });
  assert.equal(self.status, 200, JSON.stringify(self.data));
});

test("annual cycle: HoD proposes, quota blocks departments of 10+, employees and managers see nothing", async () => {
  await newPerson("V2-HOD2", "Hugo Hod", "Annual Dept");
  const d2 = await setOwner("Annual Dept", people["V2-HOD2"].id);
  const rows = Array.from({ length: 10 }, (_, i) => ({ employeeId: `V2-AN${i}`, name: `Ann ${i}`, department: "Annual Dept", jobLevel: "PB2", managerEmployeeId: "V2-HOD2" }));
  assert.equal((await admin.post("/api/admin/employees/bulk", { rows, programIds: [] })).status, 200);
  const roster = (await admin.get("/api/admin/employees")).data;
  const ids = rows.map((r) => roster.find((x) => x.employeeId === r.employeeId).id);
  const c = await admin.post("/api/admin/review-cycles", { name: "2026 Annual", kind: "annual", userIds: ids });
  assert.equal(c.status, 200);
  assert.equal(c.data.cycle.kind, "annual");
  assert.equal(c.data.cycle.flow, "v2", "annual cycles always use the v2 flow");
  const hod = people["V2-HOD2"].client;
  const mineV = (await hod.get("/api/me/reviews")).data;
  assert.equal(mineV.teamRows.length, 0, "annual items are not in the manager's team list");
  assert.ok(!("team" in mineV), "the old full team[] is gone (wave 3)");
  const hg = (await hod.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === c.data.cycle.id);
  const g = { ...hg.view.dept, items: hg.view.rows.filter((r) => !r.notCounted) };
  assert.equal(g.headcount, 10);
  assert.equal(g.small, false);
  assert.ok(g.issues.some((x) => x.code === "hod_rating_missing" && x.n === 10));
  // 两个 A+（名额 floor(10×2%) = 0）其余 B → 超额拦截
  for (const [i, it] of g.items.entries()) {
    const r = await hod.put(`/api/me/reviews/hod/items/${it.id}`, { rating: i < 2 ? "A+" : "B" });
    assert.equal(r.status, 200, "annual proposals need no reason");
  }
  const blocked = await hod.post("/api/me/reviews/hod/submit", { cycleId: c.data.cycle.id, dept1Id: d2 });
  assert.equal(blocked.status, 400);
  assert.ok(blocked.data.issues.some((x) => x.code === "over_quota" && x.over.some((o) => o.tier === "A+" && o.count === 2 && o.allowed === 0)));
  // 改成 B（B+ 名额 floor(10×15%) = 1，两个 B+ 仍超额）
  for (const it of g.items.slice(0, 2)) assert.equal((await hod.put(`/api/me/reviews/hod/items/${it.id}`, { rating: "B" })).status, 200);
  assert.equal((await hod.post("/api/me/reviews/hod/submit", { cycleId: c.data.cycle.id, dept1Id: d2 })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${c.data.cycle.id}/depts/${d2}/confirm`, {})).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${c.data.cycle.id}/close`, {})).data.written, 10);
});

test("U1: top-level department heads are never enrolled in v2 cycles — dry run reports them, explicit lists and later additions drop them", async () => {
  const before = (await admin.get("/api/admin/review-cycles")).data.length;
  const dry = await admin.post("/api/admin/review-cycles", { dryRun: true, flow: "v2", department: "QA Dept" });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.excludedHods, 1, "Hana Hod is the QA Dept head");
  assert.equal(dry.data.participants, 3);
  assert.deepEqual(dry.data.excludedHodNames, ["Hana Hod"]);
  assert.equal((await admin.get("/api/admin/review-cycles")).data.length, before, "a dry run creates nothing");
  const r = await admin.post("/api/admin/review-cycles", { name: "U1 explicit", flow: "v2", userIds: [people["V2-HOD"].id, people["V2-E1"].id] });
  assert.equal(r.status, 200);
  assert.equal(r.data.participants, 1);
  assert.equal(r.data.excludedHods, 1);
  const items = (await admin.get(`/api/admin/review-cycles/${r.data.cycle.id}`)).data.items;
  assert.ok(!items.some((i) => i.employeeId === "V2-HOD"));
  const add = await admin.post(`/api/admin/review-cycles/${r.data.cycle.id}/participants`, { userIds: [people["V2-HOD"].id] });
  assert.equal(add.data.added, 0);
  assert.equal(add.data.excludedHods, 1);
  // 旧流程周期（不传 flow）行为不变
  const legacy = await admin.post("/api/admin/review-cycles", { name: "U1 legacy", userIds: [people["V2-HOD"].id] });
  assert.equal(legacy.data.participants, 1);
  for (const id of [r.data.cycle.id, legacy.data.cycle.id]) assert.equal((await admin.del(`/api/admin/review-cycles/${id}`)).status, 200);
});
