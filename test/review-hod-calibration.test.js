// 第二批 2.2 / 2.7（2026-10-08，波次 1 W1-A）：HoD 部门校准与 HR 部门明细共用的视图（reviewCalibView）、HoD 代评、一次保存、
// 提醒上级、提交口径与离职者。
//   · 契约：GET /api/me/reviews/hod?v=2 与 GET /api/admin/review-cycles/:id/depts/:unit 的字段逐个钉住（波次 1 出口条件，
//     共享组件 DeptCalibration 按这份契约开发）；波次 3（W3-S）起不带 ?v=2 的 /hod 也返回同一视图，旧的 groups[].items 已删。
//   · 代评（审查 P0-2 / P0-3）：只在上级已离职 / 停用 / 没有上级，或已过评级截止日时；HoD 是直属上级 → use_manager_entry；
//     代评须写理由，记 review_items.hodProxy 与审计 review.hod.proxy，通知在职的上级；HR 的评级从不算代评。
//   · 一次保存：全部成功或全部不写（bulk_invalid + errors[{id, code}]），expect 不一致 → stale。
//   · 提交：不要求面谈；离职者不计入、不阻断；季度另有 self_missing（退回过的组自评已锁定，不再检查）；通知 HR 直达部门明细。
//     提交后有人离职不报成员变动，配额基数保持提交时的人数（离职后又改了部门也一样）；全部部门确认后通知可以关闭周期。
//   · HR 部门明细在范围不全时，部门行也只按范围内的人算；HoD「提醒他们的上级」跳过 HoD 本人的直属下级（hod_is_manager）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

const DAY = 24 * 60 * 60 * 1000;
const FAKE_NOW = Date.now() + 10 * DAY;
const ymd = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

let srv, admin, adminId, scoped;
const people = {};
const dept = {};
let Q, LEGACY, unit;
const items = {};
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
const auditRows = (action) => dbRead((d) => d.prepare("SELECT target, beforeJson, afterJson FROM audit_logs WHERE action = ? ORDER BY id").all(action))
  .map((r) => ({ target: r.target, before: JSON.parse(r.beforeJson || "null"), after: JSON.parse(r.afterJson || "null") }));
const notes = (uid) => dbRead((d) => d.prepare("SELECT title, title_zh, body, body_zh, link FROM notifications WHERE userId = ? ORDER BY createdAt, id").all(uid));
const hodProxyCol = (id) => dbRead((d) => d.prepare("SELECT hodProxy FROM review_items WHERE id = ?").get(id)).hodProxy;

async function newPerson(employeeId, name, department, managerEid) {
  const r = await admin.post("/api/admin/employees", { name, employeeId, ...(department ? { department } : {}), jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: r.data.password });
  await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: "hc-pass-123" });
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(employeeId)).id;
  if (managerEid) assert.equal((await admin.put(`/api/admin/employees/${id}`, { managerId: people[managerEid].id })).status, 200);
  people[employeeId] = { id, client: c };
}
const exit = async (eid) => assert.equal((await admin.put(`/api/admin/employees/${people[eid].id}`, { empStatus: "exited" })).status, 200);
const hod = () => people["HC-HOD"].client;
const viewOf = async () => {
  const r = await hod().get("/api/me/reviews/hod?v=2");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.groups.find((g) => g.cycleId === Q).view;
};
const rowOf = (view, eid) => view.rows.find((r) => r.employeeId === eid);
const saveAll = (changes) => hod().put("/api/me/reviews/hod/items", { cycleId: Q, dept1Id: unit, changes });
const selfOf = async (eid) => assert.equal((await people[eid].client.post(`/api/me/reviews/${items[eid]}/self`, selfBody)).status, 200, eid + " self");

before(async () => {
  srv = await startServer({ env: { LMS_FAKE_NOW: new Date(FAKE_NOW).toISOString() } });
  admin = await loginAs(srv.base, ADMIN);
  adminId = (await admin.get("/api/me")).data.id;
  await newPerson("HC-HOD", "Hope Hod", "HC Dept");
  dept["HC Dept"] = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "HC Dept").id;
  assert.equal((await admin.put(`/api/admin/departments/${dept["HC Dept"]}`, { ownerId: people["HC-HOD"].id })).status, 200);
  const sub = await admin.post("/api/admin/departments", { name: "HC Sub", parentId: dept["HC Dept"] });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  dept["HC Sub"] = sub.data.department.id;
  await newPerson("HC-M1", "Mila Mgr", "HC Dept", "HC-HOD");
  await newPerson("HC-M2", "Milo Mgr", "HC Dept", "HC-HOD");
  for (const e of ["HC-E1", "HC-E2", "HC-E5"]) await newPerson(e, "Emp " + e, "HC Dept", "HC-M1");
  await newPerson("HC-E3", "Emp HC-E3", "HC Dept", "HC-M2");
  await newPerson("HC-E4", "Emp HC-E4", "HC Dept", "HC-HOD");
  await newPerson("HC-E6", "Emp HC-E6", "HC Sub");
  await newPerson("HC-N1", "No Dept", null, "HC-M1");
  await newPerson("HC-HOD2", "Hugh Hod", "HC Two");
  dept["HC Two"] = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "HC Two").id;
  assert.equal((await admin.put(`/api/admin/departments/${dept["HC Two"]}`, { ownerId: people["HC-HOD2"].id })).status, 200);
  await newPerson("HC-T1", "Two One", "HC Two", "HC-HOD2");
  const ids = ["HC-M1", "HC-M2", "HC-E1", "HC-E2", "HC-E3", "HC-E4", "HC-E5", "HC-E6", "HC-N1", "HC-T1"].map((k) => people[k].id);
  const c = await admin.post("/api/admin/review-cycles", { name: "HC 2026Q4", flow: "v2", kind: "quarter", dueAt: ymd(FAKE_NOW + 5 * DAY), dueRateAt: ymd(FAKE_NOW + 7 * DAY), dueCalibAt: ymd(FAKE_NOW + 9 * DAY), userIds: ids });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  Q = c.data.cycle.id;
  unit = dept["HC Dept"];
  for (const i of (await admin.get(`/api/admin/review-cycles/${Q}`)).data.items) items[i.employeeId] = i.id;
  const l = await admin.post("/api/admin/review-cycles", { name: "HC Legacy", userIds: [people["HC-E1"].id] });
  LEGACY = l.data.cycle.id;
  // 范围受限的 HR：绩效只读，范围只有 HC Sub（HC Dept 的下级）
  const role = await admin.post("/api/admin/roles", { name: "HC Scoped Perf", name_zh: "HC 范围绩效", grants: { performance: "read" }, scope: { departments: [{ id: dept["HC Sub"], includeChildren: true }] } });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const hr = await admin.post("/api/admin/employees", { name: "HC Scoped HR", employeeId: "HC-HR", programIds: [] });
  const hrId = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = 'HC-HR'").get()).id;
  assert.equal((await admin.put("/api/admin/employees/" + hrId, { department: "HC Two", jobLevel: "P5", adminRoleId: role.data.role.id })).status, 200);
  scoped = await loginAs(srv.base, { employeeId: "HC-HR", password: hr.data.password });
  assert.equal((await scoped.post("/api/auth/change-password", { currentPassword: hr.data.password, newPassword: "hc-hr-pass-2026" })).status, 200);
});
after(async () => { if (srv) await srv.stopAsync(); });

const VIEW_KEYS = ["bucketOf", "cycle", "dept", "deptOptions", "highlightRatings", "mode", "quotaMinHeadcount", "ratingOptions", "ratingOptions_desc", "ratingOptions_desc_zh", "ratingOptions_zh", "rows", "tiers", "today"];
const CYCLE_KEYS = ["dueAt", "dueCalibAt", "dueRateAt", "flow", "id", "kind", "name", "quota", "status"];
const DEPT_KEYS = ["allowed", "counts", "departedN", "dept1", "headcount", "hod", "issues", "locked", "notices", "over", "quotaBase", "small", "status", "unit"];
const DEPT_HR_KEYS = [...DEPT_KEYS, "confirmIssues", "deptInactive", "hodOwned", "hodUnresolved", "membershipChanged", "ratingsChanged", "scopePartial"].sort();
const ROW_KEYS = ["adjusted", "bucket", "department", "deptPath", "editable", "effective", "employeeId", "employeeOneOnOneAt", "finalRating", "highlights", "hodProxy",
  "hodText", "id", "jobGrade", "jobLevel", "jobTrack", "locked", "manager", "managerId", "managerRating", "managerStatus", "managerText", "name", "notCounted",
  "oneOnOneAt", "oneState", "overQuota", "overdue", "pending", "position", "proxyEligible", "selfAt", "selfReview", "userId"];   // position：第三批 9.1（员工端显示职位，不显示工号）
const ROW_HR_KEYS = [...ROW_KEYS, "hodAt", "hrCalibratable", "oneOnOneNotes"].sort();
const keys = (o) => Object.keys(o).sort();

test("contract: /hod (with or without ?v=2) and the HR department detail return the calibration view field for field; the old groups[].items is gone", async () => {
  // 波次 3（W3-S）：旧形状已删，不带 v=2 也返回部门校准视图（与 ?v=2 逐字相同）
  const plain = (await hod().get("/api/me/reviews/hod")).data;
  assert.equal(plain.v, 2);
  const pg = plain.groups.find((g) => g.cycleId === Q);
  assert.ok(pg && !("items" in pg) && pg.view && pg.view.rows.length === 8, "no groups[].items any more");
  const v2 = (await hod().get("/api/me/reviews/hod?v=2")).data;
  assert.deepEqual(plain, v2, "same payload with or without ?v=2");
  assert.equal(v2.v, 2);
  const g = v2.groups.find((x) => x.cycleId === Q);
  assert.deepEqual(keys(g), ["cycle", "cycleId", "dept1", "locked", "unit", "view"]);
  assert.equal(g.unit, unit);
  const view = g.view;
  assert.deepEqual(keys(view), VIEW_KEYS);
  assert.equal(view.mode, "hod");
  assert.deepEqual(keys(view.cycle), CYCLE_KEYS);
  assert.deepEqual(keys(view.dept), DEPT_KEYS);
  assert.deepEqual(view.dept.hod, { id: people["HC-HOD"].id, name: "Hope Hod" });
  assert.equal(view.dept.headcount, 8);
  for (const r of view.rows) assert.deepEqual(keys(r), ROW_KEYS, r.employeeId);
  assert.deepEqual(view.rows.map((r) => r.employeeId).sort(), ["HC-E1", "HC-E2", "HC-E3", "HC-E4", "HC-E5", "HC-E6", "HC-M1", "HC-M2"], "no HoD row");
  // 部门：按 id 去掉本一级部门；HC Sub 是二级
  assert.deepEqual(view.deptOptions.map((o) => [o.name, o.level, keys(o).join(",")]), [["HC Sub", 2, "id,level,name,parentId,path"]]);
  assert.deepEqual(rowOf(view, "HC-E6").deptPath, [dept["HC Sub"]]);
  assert.deepEqual(rowOf(view, "HC-E1").deptPath, []);
  assert.deepEqual([rowOf(view, "HC-E6").managerStatus, rowOf(view, "HC-E1").managerStatus], ["none", "active"]);
  assert.deepEqual(view.tiers, ["A+", "A", "B+", "B", "C/D"]);
  assert.deepEqual(view.bucketOf, { C: "C/D", D: "C/D" });
  assert.equal(rowOf(view, "HC-E1").selfReview, null, "not proxy-eligible: the HoD doesn't get the self-review text");
  assert.deepEqual(keys(rowOf(view, "HC-E6").selfReview), ["goalsNext", "prevGoals", "selfChallenges", "selfExtra", "selfFeedback", "selfOutcomes"], "no manager: proxy-eligible, self-review readable (P1-5)");
  // HR 部门明细（只读）
  const hr = await admin.get(`/api/admin/review-cycles/${Q}/depts/${unit}`);
  assert.equal(hr.status, 200, JSON.stringify(hr.data));
  assert.deepEqual(keys(hr.data), ["row", "view"]);
  assert.equal(hr.data.view.mode, "hr");
  assert.deepEqual(keys(hr.data.view.dept), DEPT_HR_KEYS);
  for (const r of hr.data.view.rows) assert.deepEqual(keys(r), ROW_HR_KEYS, r.employeeId);
  assert.equal(hr.data.view.dept.hodOwned, true);
  assert.ok(hr.data.view.rows.every((r) => r.editable === false && r.hrCalibratable === false), "HoD-owned department: HR is read-only");
  assert.equal(hr.data.row.dept1Id, unit);
  assert.equal(hr.data.row.departedN, 0);
  assert.equal((await admin.get(`/api/admin/review-cycles/${Q}/depts/nope`)).data.code, "not_found");
  assert.equal((await admin.get(`/api/admin/review-cycles/${LEGACY}/depts/${unit}`)).data.code, "cycle_not_found");
  // 范围收窄：只给范围内的人，人数、名额、阻断项给 null（审查 P1-2）；整组在范围外 → 404
  const sc = await scoped.get(`/api/admin/review-cycles/${Q}/depts/${unit}`);
  assert.equal(sc.status, 200, JSON.stringify(sc.data));
  assert.deepEqual(sc.data.view.rows.map((r) => r.employeeId), ["HC-E6"]);
  assert.equal(sc.data.view.dept.scopePartial, true);
  for (const k of ["headcount", "quotaBase", "counts", "allowed", "over", "small", "issues", "notices", "departedN", "confirmIssues"]) assert.equal(sc.data.view.dept[k], null, k);
  assert.equal(sc.data.view.rows[0].editable, false, "read-only role");
  assert.equal(sc.data.view.rows[0].overQuota, null, "over-quota is computed on the whole group: not shown when the scope is partial");
  // 部门行与周期详情的 depts[] 同一口径：只按范围内的人算（审查：原先用整组，人数 8、各档人数会带出范围外的人）
  const scRow = sc.data.row;
  assert.deepEqual([scRow.headcount, scRow.quotaBase, scRow.departedN, scRow.rated, scRow.selfDone, scRow.scopePartial, scRow.confirmIssues], [1, 1, 0, 0, 0, true, null]);
  assert.deepEqual(scRow.counts, {});
  const scDet = (await scoped.get(`/api/admin/review-cycles/${Q}`)).data.depts.find((d) => d.dept1Id === unit);
  assert.deepEqual([scDet.headcount, scDet.quotaBase, scDet.counts], [scRow.headcount, scRow.quotaBase, scRow.counts], "same numbers as the cycle detail");
  assert.equal((await scoped.get(`/api/admin/review-cycles/${Q}/depts/${dept["HC Two"]}`)).status, 404);
  // 周期详情 items 补的字段（不带上级工号）
  const det = (await admin.get(`/api/admin/review-cycles/${Q}`)).data;
  const it = det.items.find((i) => i.employeeId === "HC-E1");
  for (const k of ["managerId", "managerStatus", "notCounted", "hodProxy", "oneState", "jobGrade", "jobTrack", "locked", "overdue"]) assert.ok(k in it, k);
  assert.equal(typeof it.locked, "boolean");
  assert.ok(Array.isArray(it.overdue));
  assert.ok(!("managerEmployeeId" in it));
  assert.ok(det.depts.every((d) => "departedN" in d && "quotaBase" in d));
});

test("remind their managers (HoD): one notification per manager with by:'hod' in the audit; skips explain why; only this department's people", async () => {
  await exit("HC-M2");
  await selfOf("HC-E2");
  const r = await hod().post("/api/me/reviews/hod/remind", { cycleId: Q, dept1Id: unit, itemIds: [items["HC-E1"], items["HC-E2"], items["HC-E3"]] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.results.map((x) => (x.ok ? "ok" : x.code)), ["self_pending", "ok", "no_manager"]);
  assert.equal(r.data.reminded, 1);
  const n = notes(people["HC-M1"].id).filter((x) => /^Reminder:/.test(x.title)).pop();
  assert.equal(n.link, "/review?view=team");
  const a = auditRows("review.remind").pop();
  assert.deepEqual([a.after.stage, a.after.userId, a.after.by], ["manager", people["HC-M1"].id, "hod"]);
  const again = await hod().post("/api/me/reviews/hod/remind", { cycleId: Q, dept1Id: unit, itemIds: [items["HC-E2"]] });
  assert.deepEqual(again.data.results.map((x) => x.code), ["cooldown"]);
  const outside = await hod().post("/api/me/reviews/hod/remind", { cycleId: Q, dept1Id: unit, itemIds: [items["HC-T1"]] });
  assert.equal(outside.status, 404);
  assert.ok(outside.data.error && outside.data.error_zh);
  assert.equal((await people["HC-M1"].client.post("/api/me/reviews/hod/remind", { cycleId: Q, dept1Id: unit, itemIds: [items["HC-E2"]] })).status, 404, "not the HoD");
  assert.equal((await hod().post("/api/me/reviews/hod/remind", { cycleId: Q, dept1Id: unit, itemIds: [] })).data.code, "no_items");
});

test("proxy rules: only when the manager is gone / missing or the rating deadline passed; never for the HoD's own reports; reason required; HR ratings are never proxies", async () => {
  const put = (eid, body) => hod().put(`/api/me/reviews/hod/items/${items[eid]}`, body);
  const notYet = await put("HC-E1", { rating: "B", reason: "x" });
  assert.equal(notYet.status, 409);
  assert.equal(notYet.data.code, "manager_not_overdue");
  assert.match(notYet.data.error, /rating deadline hasn't passed.*未过评级截止日/);
  const own = await put("HC-E4", { rating: "B", reason: "x" });
  assert.equal(own.status, 409);
  assert.equal(own.data.code, "use_manager_entry");
  const noReason = await put("HC-E3", { rating: "B" });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, "proxy_reason_required");
  assert.equal((await put("HC-E3", { rating: "B", reason: "上级已离职" })).status, 200);
  assert.equal((await put("HC-E6", { rating: "B", reason: "没有直属上级" })).status, 200);
  const a = auditRows("review.hod.proxy").find((x) => x.target === items["HC-E3"]);
  assert.deepEqual(a.after, { finalRating: "B", reason: "上级已离职", proxy: "manager_departed" });
  assert.equal(JSON.parse(hodProxyCol(items["HC-E3"])).by, people["HC-HOD"].id);
  const view = await viewOf();
  assert.deepEqual([rowOf(view, "HC-E3").hodProxy, rowOf(view, "HC-E6").hodProxy, rowOf(view, "HC-E3").managerStatus], ["manager_departed", "manager_departed", "departed"]);
  assert.ok(rowOf(view, "HC-E3").selfReview, "proxied row: the self-review stays readable");
  assert.ok(!notes(people["HC-M2"].id).some((x) => /on your behalf/.test(x.title)), "a manager who has left is not notified");
  // HR 在无 HoD 的组（__none）给上级未评的人评级：不写 hodProxy，上级照常能评（审查 P0-2）
  const hrPut = await admin.put(`/api/admin/review-items/${items["HC-N1"]}`, { finalRating: "B" });
  assert.equal(hrPut.status, 200, JSON.stringify(hrPut.data));
  assert.equal(hodProxyCol(items["HC-N1"]), null);
  assert.equal((await people["HC-M1"].client.post(`/api/me/reviews/${items["HC-N1"]}/manager`, { rating: "B" })).status, 200);
});

test("save all: all-or-nothing with per-row codes, stale detection by expect; a successful save returns the fresh view and notifies an active manager of a proxy", async () => {
  await exit("HC-E5");
  let r = await saveAll([{ id: items["HC-E2"], rating: "B", reason: "x" }, { id: items["HC-T1"], rating: "B" }, { id: items["HC-E5"], rating: "B", reason: "x" }, { id: items["HC-E2"], rating: "A" }]);
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.code, "bulk_invalid");
  assert.deepEqual(r.data.errors, [
    { id: items["HC-E2"], code: "manager_not_overdue" }, { id: items["HC-T1"], code: "not_found" },
    { id: items["HC-E5"], code: "participant_departed" }, { id: items["HC-E2"], code: "duplicate" },
  ]);
  assert.match(r.data.error, /nothing was changed.*本次未做任何修改/);
  assert.equal(rowOf(await viewOf(), "HC-E2").finalRating, null, "nothing written");
  assert.equal((await saveAll([])).data.code, "no_items");
  // 评级截止日过了：上级在职也可代评
  assert.equal((await admin.put(`/api/admin/review-cycles/${Q}/due`, { dueRateAt: ymd(FAKE_NOW - DAY) })).status, 200);
  // 打开页面时 E2 还没有上级评级；保存前上级评了 B+ → stale（不会悄悄从「代评」变成「调整」，审查 P1-4）
  assert.equal((await people["HC-M1"].client.post(`/api/me/reviews/${items["HC-E2"]}/manager`, { rating: "B+" })).status, 200);
  r = await saveAll([{ id: items["HC-E2"], rating: "A", reason: "跨部门项目", expect: { managerRating: null, finalRating: null } }]);
  assert.deepEqual(r.data.errors, [{ id: items["HC-E2"], code: "stale" }]);
  r = await saveAll([
    { id: items["HC-E2"], rating: "A", reason: "跨部门项目", expect: { managerRating: "B+", finalRating: null } },
    { id: items["HC-E1"], rating: "B", reason: "上级逾期未评", expect: { managerRating: null, finalRating: null } },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.saved, 2);
  const view = r.data.view;
  assert.deepEqual(keys(view), VIEW_KEYS);
  assert.deepEqual([rowOf(view, "HC-E2").adjusted, rowOf(view, "HC-E2").hodProxy, rowOf(view, "HC-E1").hodProxy], [true, null, "manager_pending"]);
  assert.equal(rowOf(view, "HC-E5").notCounted, "departed");
  assert.equal(rowOf(view, "HC-E5").editable, false);
  assert.equal(auditRows("review.hod.calibrate").pop().target, items["HC-E2"]);
  assert.deepEqual(auditRows("review.hod.proxy").pop().after, { finalRating: "B", reason: "上级逾期未评", proxy: "manager_pending" });
  assert.ok(notes(people["HC-M1"].id).some((x) => x.title === "The HoD rated Emp HC-E1 on your behalf for HC 2026Q4"));
  const blocked = await people["HC-M1"].client.post(`/api/me/reviews/${items["HC-E1"]}/manager`, { rating: "A", highlights: "x" });
  assert.equal(blocked.data.code, "hod_proxied");
});

test("submit: leavers don't count or block, the 1-on-1 isn't required, open self-reviews block (self_missing); HR is sent straight to the department detail", async () => {
  let view = await viewOf();
  assert.equal(view.dept.headcount, 6, "M2 and E5 have left");
  assert.equal(view.dept.departedN, 2);
  const notice = view.dept.notices.find((x) => x.code === "participants_departed");
  assert.deepEqual(notice.ids.slice().sort(), [items["HC-M2"], items["HC-E5"]].sort());
  assert.ok(view.dept.notices.some((x) => x.code === "one_on_one_unconfirmed"));
  const self = view.dept.issues.find((x) => x.code === "self_missing");
  assert.deepEqual(self.ids.slice().sort(), ["HC-M1", "HC-E1", "HC-E3", "HC-E4", "HC-E6"].map((e) => items[e]).sort());
  const missing = view.dept.issues.find((x) => x.code === "rating_missing");
  assert.deepEqual(missing.ids.slice().sort(), [items["HC-M1"], items["HC-E4"]].sort());
  const blocked = await hod().post("/api/me/reviews/hod/submit", { cycleId: Q, dept1Id: unit });
  assert.equal(blocked.status, 400);
  assert.deepEqual(blocked.data.issues.map((x) => x.code).sort(), ["rating_missing", "self_missing"]);
  for (const e of ["HC-M1", "HC-E1", "HC-E3", "HC-E4", "HC-E6"]) await selfOf(e);
  // 「提醒他们的上级」：HoD 本人就是直属上级（M1、E4 已交自评、未评级）→ 不提醒（只会发给自己、占掉节流），记 hod_is_manager（审查）
  const hodNotes0 = notes(people["HC-HOD"].id).length;
  const own = await hod().post("/api/me/reviews/hod/remind", { cycleId: Q, dept1Id: unit, itemIds: [items["HC-M1"], items["HC-E4"]] });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.deepEqual(own.data.results.map((x) => x.code), ["hod_is_manager", "hod_is_manager"]);
  assert.ok(own.data.results[0].error && own.data.results[0].error_zh);
  assert.deepEqual([own.data.reminded, own.data.skippedPeople], [0, 2]);
  assert.equal(notes(people["HC-HOD"].id).length, hodNotes0, "the HoD is not notified about their own reports");
  for (const e of ["HC-M1", "HC-E4"]) assert.equal((await hod().post(`/api/me/reviews/${items[e]}/manager`, { rating: "B" })).status, 200, e);
  view = await viewOf();
  assert.deepEqual(view.dept.issues, [], "small department: the A over quota only warns; no 1-on-1 needed");
  assert.ok(rowOf(view, "HC-E2").overQuota);
  const ok = await hod().post("/api/me/reviews/hod/submit", { cycleId: Q, dept1Id: unit });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const n = notes(adminId).filter((x) => /submitted HC Dept/.test(x.title)).pop();
  assert.equal(n.link, `/admin/reviews?cycle=${Q}&view=depts&unit=${unit}`);
  assert.equal(n.body, "Open the department detail to confirm or return it.");
  assert.equal(n.body_zh, "点击打开该部门明细，确认或退回。");
  view = await viewOf();
  assert.equal(view.dept.locked, true);
  assert.ok(view.rows.every((r) => !r.editable));
  assert.equal((await saveAll([{ id: items["HC-E1"], rating: "A", reason: "x" }])).data.code, "dept_locked");
});

test("after submit: a leaver is not a membership change and the quota base keeps them; all departments confirmed → admins are told to close; rated leavers are archived", async () => {
  await exit("HC-E2");
  let row = (await admin.get(`/api/admin/review-cycles/${Q}/depts/${unit}`)).data.row;
  assert.deepEqual([row.headcount, row.quotaBase, row.departedN], [5, 6, 3], "P1-1: the base still counts E2, who left after the submit");
  assert.equal(row.membershipChanged, undefined);
  // 离职后又被改了部门（清理名册）：基数仍按提交快照算，不跟着变少（审查）
  assert.equal((await admin.put(`/api/admin/employees/${people["HC-E2"].id}`, { department: "HC Two" })).status, 200);
  row = (await admin.get(`/api/admin/review-cycles/${Q}/depts/${unit}`)).data.row;
  assert.deepEqual([row.headcount, row.quotaBase, row.departedN], [5, 6, 2], "E2 now maps to HC Two but stays in the HC Dept base");
  assert.equal(row.membershipChanged, undefined);
  assert.equal((await admin.put(`/api/admin/employees/${people["HC-E2"].id}`, { department: "HC Dept" })).status, 200);
  row = (await admin.get(`/api/admin/review-cycles/${Q}/depts/${unit}`)).data.row;
  assert.deepEqual(row.confirmIssues, []);
  assert.equal((await admin.post(`/api/admin/review-cycles/${Q}/depts/${unit}/confirm`, {})).status, 200);
  assert.equal(notes(people["HC-HOD"].id).filter((x) => /HR confirmed/.test(x.title)).pop().link, `/review?view=hod&cycle=${Q}&unit=${unit}`);
  const allDone = () => notes(adminId).filter((x) => /are confirmed\. You can close the cycle\./.test(x.title));
  assert.equal(allDone().length, 0, "HC Two and the __none group are still open");
  assert.equal((await admin.post(`/api/admin/review-cycles/${Q}/depts/__none/confirm`, {})).status, 200);
  await selfOf("HC-T1");
  assert.equal((await people["HC-HOD2"].client.post(`/api/me/reviews/${items["HC-T1"]}/manager`, { rating: "B" })).status, 200);
  assert.equal((await people["HC-HOD2"].client.post("/api/me/reviews/hod/submit", { cycleId: Q, dept1Id: dept["HC Two"] })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${Q}/depts/${dept["HC Two"]}/confirm`, {})).status, 200);
  const done = allDone();
  assert.equal(done.length, 1);
  assert.equal(done[0].title, 'All departments in "HC 2026Q4" are confirmed. You can close the cycle.');
  assert.equal(done[0].title_zh, "「HC 2026Q4」所有部门已确认，可以关闭周期");
  assert.equal(done[0].link, `/admin/reviews?cycle=${Q}`);
  const cl = await admin.post(`/api/admin/review-cycles/${Q}/close`, {});
  assert.equal(cl.status, 200, JSON.stringify(cl.data));
  assert.equal(cl.data.written, 8, "6 rated in HC Dept (E2 left after the submit) + N1 + T1; unrated leavers are skipped");
});

// 审查：退回之后全组自评都已锁定（reviewSelfLocked），退回后增补的人交不了自评 —— self_missing 不能再拦重新提交，
// 否则 HoD 与 HR 只能干等到自评截止日
test("after a return the self-reviews are locked, so self_missing doesn't block the re-submit (person added after the return)", async () => {
  const two = dept["HC Two"];
  const c = await admin.post("/api/admin/review-cycles", { name: "HC 2027Q1", flow: "v2", kind: "quarter", dueAt: ymd(FAKE_NOW + 5 * DAY), dueRateAt: ymd(FAKE_NOW + 7 * DAY), userIds: [people["HC-T1"].id] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const Q2 = c.data.cycle.id;
  const itemOf = async (eid) => (await admin.get(`/api/admin/review-cycles/${Q2}`)).data.items.find((i) => i.employeeId === eid).id;
  const hod2 = people["HC-HOD2"].client;
  const t1 = await itemOf("HC-T1");
  assert.equal((await people["HC-T1"].client.post(`/api/me/reviews/${t1}/self`, selfBody)).status, 200);
  assert.equal((await hod2.post(`/api/me/reviews/${t1}/manager`, { rating: "B" })).status, 200);
  assert.equal((await hod2.post("/api/me/reviews/hod/submit", { cycleId: Q2, dept1Id: two })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${Q2}/depts/${two}/return`, { reason: "补一个人" })).status, 200);
  await newPerson("HC-T2", "Two Two", "HC Two", "HC-HOD2");
  const add = await admin.post(`/api/admin/review-cycles/${Q2}/participants`, { userIds: [people["HC-T2"].id] });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const t2 = await itemOf("HC-T2");
  assert.equal((await people["HC-T2"].client.post(`/api/me/reviews/${t2}/self`, selfBody)).data.code, "self_locked");
  assert.equal((await hod2.post(`/api/me/reviews/${t2}/manager`, { rating: "B" })).status, 200);
  const v = (await hod2.get("/api/me/reviews/hod?v=2")).data.groups.find((g) => g.cycleId === Q2).view;
  assert.ok(!v.dept.issues.some((x) => x.code === "self_missing"), JSON.stringify(v.dept.issues));
  const re = await hod2.post("/api/me/reviews/hod/submit", { cycleId: Q2, dept1Id: two });
  assert.equal(re.status, 200, JSON.stringify(re.data));
});
