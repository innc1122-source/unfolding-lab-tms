// P0 第一组 1.1 / 1.2（负责人 2026-10-07，docs/REQ-20261007-consolidated.md 一）：
//   1.1 新流程（v2）周期里 HR 对 HoD 校准只读 —— 只能确认 / 退回；旧流程维持 HR 校准。
//   1.2 HR 确认部门时同样检查配额（10 人以上超额即拦截，与 HoD 提交同口径），并检查有人没评级。
// 连同开工前拍板的 E1–E4：
//   E1 「归 HoD」= 现在有 HoD 或曾有 HoD 提交过（HoD 消失后已提交的部门仍只读）；「HoD 待确认」（多个顶端、负责人
//      离职、一级部门停用）HR 也只读，确认返回 hod_unresolved；只有真正无 HoD 的组（__none、无在职成员）由 HR 评级。
//   E2 确认 / 退回人就是该组 HoD → 409 self_confirm。
//   E3 HoD 提交与 HR 确认时存成员快照（meta），确认时成员变了 → membership_changed；关闭时已确认部门成员变了 → depts_changed。
//   E4 「__none」组按小部门处理（超额只提示），确认后上级评级、自评、面谈确认同样锁定。
// 以及 S3（未提交不能退回）、S4（已提交部门不能增补）、S5（提交后不能改配额，审计带配额）、S7（锁定后不能取消面谈确认）。
// 用临时服务器（test/helpers.js），不碰 lms.db。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin, adminId;
const C = {};          // employeeId → 已登录的 client（只给需要登录的人）
let roster = [];
const idOf = (eid) => { const r = roster.find((x) => x.employeeId === eid); assert.ok(r, "no employee " + eid); return r.id; };
async function refreshRoster() { roster = (await admin.get("/api/admin/employees")).data; }
// GET /api/me/reviews/hod 的部门校准视图里计入配额的行。波次 3（W3-S）删掉了旧的 groups[].items 形状，这里从 view.rows 取，
// 范围与旧 items 相同：不含 HoD 本人与离职者。
const hodRows = (g) => g.view.rows.filter((r) => !r.notCounted);
async function newPerson(employeeId, name, department, managerEid) {
  const r = await admin.post("/api/admin/employees", { name, employeeId, department, jobLevel: "PB2" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: r.data.password });
  await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: "p0-pass-123" });
  C[employeeId] = c;
  await refreshRoster();
  if (managerEid) assert.equal((await admin.put(`/api/admin/employees/${idOf(employeeId)}`, { managerId: idOf(managerEid) })).status, 200);
}
async function bulk(rows) {
  const r = await admin.post("/api/admin/employees/bulk", {
    rows: rows.map(([employeeId, name, department, managerEmployeeId]) => ({ employeeId, name, department, jobLevel: "PB2", ...(managerEmployeeId ? { managerEmployeeId } : {}) })),
    programIds: [],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await refreshRoster();
}
async function deptIdOf(name) {
  const d = (await admin.get("/api/admin/departments")).data.find((x) => x.name === name);
  assert.ok(d, "department " + name);
  return d.id;
}
async function setOwner(name, userId) { assert.equal((await admin.put(`/api/admin/departments/${await deptIdOf(name)}`, { ownerId: userId })).status, 200); }
async function setDeptActive(name, active) { assert.equal((await admin.put(`/api/admin/departments/${await deptIdOf(name)}`, { active })).status, 200); }
async function setActive(eid, active) { const r = await admin.put(`/api/admin/employees/${idOf(eid)}`, { active }); assert.equal(r.status, 200, JSON.stringify(r.data)); }
async function moveTo(eid, department) { const r = await admin.put(`/api/admin/employees/${idOf(eid)}`, { department }); assert.equal(r.status, 200, JSON.stringify(r.data)); }
const detail = async (cid) => (await admin.get(`/api/admin/review-cycles/${cid}`)).data;
const itemOf = (d, eid) => d.items.find((i) => i.employeeId === eid);
const deptRow = (d, name) => d.depts.find((g) => (g.dept1 || "__none") === name);
async function auditRows(action) {
  return (await admin.get(`/api/admin/audit?action=${action}`)).data.rows.filter((r) => r.action === action)
    .map((r) => ({ target: r.target, before: r.before, after: r.after }));   // 接口已把 beforeJson / afterJson 解析成 before / after
}
const notes = async (eid) => (await C[eid].get("/api/me/notifications")).data.items;
// 第二批（2026-10-08）：与人有关的阻断项带 ids（条目 id，部门校准页据此筛人）；逐字比较时先去掉 ids，需要时单独断言
const strip = (xs) => (xs || []).map(({ ids, ...x }) => x);
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };
const FEMP = Array.from({ length: 10 }, (_, i) => "FEMP" + i);

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  adminId = (await admin.get("/api/me")).data.id;
  // 先把用到的部门建好（Elsewhere Dept 一开始没有人，只能单独建；其余也可以由新建员工自动建）
  for (const name of ["Own Dept", "Self Dept", "Elsewhere Dept", "Gone Dept", "Nine Dept", "Orphan Dept", "Shut Dept"])
    assert.equal((await admin.post("/api/admin/departments", { name })).status, 200, name);
  // Fin Dept：HoD（部门页负责人）+ 10 名向 HoD 汇报的员工；FLATE 留给「提交后增补」
  await newPerson("FHOD", "Fin Hod", "Fin Dept");
  await setOwner("Fin Dept", idOf("FHOD"));
  await bulk([...FEMP.map((e, i) => [e, "Fin Emp " + i, "Fin Dept", "FHOD"]), ["FLATE", "Fin Late", "Fin Dept", "FHOD"]]);
  // Own Dept：发起时两人都没有上级（需确认，谁也不是 HoD → 都进周期），之后把 OWN1 设为负责人 → OWN1 那条是「HoD 本人的评估项」
  await bulk([["OWN1", "Owen One", "Own Dept"], ["OWN2", "Olga Two", "Own Dept"]]);
  // Self Dept：负责人是 ADMIN 本人（E2：HR 确认自己当 HoD 的部门）
  await bulk([["SELF1", "Sam Self", "Self Dept"]]);
  await setOwner("Self Dept", adminId);
  // 真正无 HoD 的一级部门：发起后全员离开在职状态（推算 source none）→ HR 评级
  await bulk([...Array.from({ length: 10 }, (_, i) => ["GONE" + i, "Gone " + i, "Gone Dept"]), ...Array.from({ length: 9 }, (_, i) => ["NINE" + i, "Nine " + i, "Nine Dept"])]);
  // HoD 待确认：两名都没有上级（多个顶端）；Shut Dept 有负责人，但一级部门随后被停用
  await bulk([["ORP1", "Orla Orphan", "Orphan Dept"], ["ORP2", "Otto Orphan", "Orphan Dept"], ["SHUT0", "Shut Owner", "Shut Dept"], ["SHUT1", "Shut Emp", "Shut Dept", "SHUT0"]]);
  await setOwner("Shut Dept", idOf("SHUT0"));
  // 「__none」组：部门为空的 10 人，上级 NMGR 在别的部门（季度周期，上级评级）
  await newPerson("NMGR", "Nora Mgr", "NM Dept");
  await newPerson("NN1", "Nn One", "", "NMGR");
  await bulk([...Array.from({ length: 9 }, (_, i) => ["NN" + (i + 2), "Nn " + (i + 2), "", "NMGR"]), ["NN11", "Nn Late", "", "NMGR"]]);
});
after(() => srv.stop());

let A, finId;   // 年度 v2 周期：Fin Dept 10 人 + Own Dept 2 人 + Self Dept 1 人
test("1.1 before the HoD submits: HR is read-only on the HoD's department (409), the HoD's view is unchanged; confirm / return → not_submitted", async () => {
  finId = await deptIdOf("Fin Dept");
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Annual A", kind: "annual", dueAt: "2026-12-20", userIds: [...FEMP, "OWN1", "OWN2", "SELF1"].map(idOf) });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.participants, 13);
  A = c.data.cycle.id;
  let d = await detail(A);
  for (const e of FEMP) assert.equal(itemOf(d, e).hrCalibratable, false, e);
  assert.equal(itemOf(d, "SELF1").hrCalibratable, false, "Self Dept 有 HoD（ADMIN）");
  assert.equal(itemOf(d, "OWN1").hrCalibratable, false, "Own Dept 需确认（两个顶端）→ HoD 待确认，HR 只读");
  assert.deepEqual(strip(deptRow(d, "Fin Dept").confirmIssues), [{ code: "rating_missing", n: 10 }]);
  assert.deepEqual(deptRow(d, "Fin Dept").confirmIssues[0].ids.slice().sort(), FEMP.map((e) => itemOf(d, e).id).sort(), "ids = the items without a rating");
  assert.equal(deptRow(d, "Fin Dept").hodUnresolved, undefined);
  const pre = await admin.put(`/api/admin/review-items/${itemOf(d, "FEMP9").id}`, { finalRating: "A" });
  assert.equal(pre.status, 409);
  assert.equal(pre.data.code, "hod_calibration_readonly");
  assert.match(pre.data.error, /HR can only confirm or return.*HR 只能确认或退回/);
  const hodItem = (await C.FHOD.get("/api/me/reviews/hod")).data.groups.find((g) => g.cycle.id === A).view.rows.find((i) => i.employeeId === "FEMP9");
  assert.equal(hodItem.finalRating, null, "HR 的改动没有写进 HoD 的评级");
  // 未提交：不能确认，也不能退回（S3：退回会把员工侧提前锁住）
  const conf = await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/confirm`, {});
  assert.equal(conf.status, 400);
  assert.equal(conf.data.code, "not_submitted");
  const ret = await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/return`, { reason: "early" });
  assert.equal(ret.status, 400);
  assert.equal(ret.data.code, "not_submitted");
  assert.equal(deptRow(await detail(A), "Fin Dept").status, null, "退回失败没有写状态");
});

test("S5 before any submit: quota can change (rounded to 0.1, audited with before / after, response quota is an object); a dates-only edit keeps dueAt", async () => {
  const q = { "A+": 3.04, "A": 8, "B+": 15, "B": 70, "C/D": 5 };
  const r = await admin.put(`/api/admin/review-cycles/${A}/due`, { quota: q });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.cycle.quota, { ...q, "A+": 3 });
  assert.equal(r.data.cycle.dueAt, "2026-12-20", "只传 quota 不清自评截止日（M9）");
  const cal = await admin.put(`/api/admin/review-cycles/${A}/due`, { dueCalibAt: "2026-12-28" });
  assert.equal(cal.data.cycle.dueAt, "2026-12-20");
  assert.equal(cal.data.cycle.dueCalibAt, "2026-12-28");
  const rows = await auditRows("review.cycle.due");
  // 改配额那一行：before 是默认 2%，after 是 3%（之后只改日期的那一行两侧都是 3%）
  const qRow = rows.find((x) => x.after && x.after.quota && x.after.quota["A+"] === 3 && x.before.quota["A+"] === 2);
  assert.ok(qRow, JSON.stringify(rows));
  assert.equal(qRow.after.dueAt, "2026-12-20");
  const dRow = rows.find((x) => x.after && x.after.dueCalibAt === "2026-12-28");
  assert.deepEqual(dRow.before.quota, dRow.after.quota, "只改日期：配额两侧相同");
  assert.deepEqual(Object.keys(qRow.after).sort(), ["dueAt", "dueCalibAt", "dueRateAt", "quota"]);
  // 改回默认，后面的配额断言按默认 2%
  assert.equal((await admin.put(`/api/admin/review-cycles/${A}/due`, { quota: { "A+": 2, "A": 8, "B+": 15, "B": 70, "C/D": 5 } })).status, 200);
});

test("1.1 after the HoD submits: still read-only; the HoD disappearing (department deactivated) does not open it up (E1); adding people → dept_locked; quota → quota_locked", async () => {
  const g = (await C.FHOD.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === A);
  for (const it of hodRows(g)) assert.equal((await C.FHOD.put(`/api/me/reviews/hod/items/${it.id}`, { rating: "B" })).status, 200);
  const sub = await C.FHOD.post("/api/me/reviews/hod/submit", { cycleId: A, dept1Id: finId });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  let d = await detail(A);
  const put = await admin.put(`/api/admin/review-items/${itemOf(d, "FEMP0").id}`, { finalRating: "A+" });
  assert.equal(put.status, 409);
  assert.equal(put.data.code, "hod_calibration_readonly");
  assert.deepEqual(deptRow(d, "Fin Dept").confirmIssues, []);
  // H1：停用一级部门 → hodOf 为空，但该组提交过（st.hodId）→ 仍只读
  await setDeptActive("Fin Dept", false);
  d = await detail(A);
  assert.equal(deptRow(d, "Fin Dept").hod, null);
  assert.equal(itemOf(d, "FEMP0").hrCalibratable, false);
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "FEMP0").id}`, { finalRating: "A+" })).data.code, "hod_calibration_readonly");
  await setDeptActive("Fin Dept", true);
  // S4：往已提交的部门增补 → 整批拒绝
  const add = await admin.post(`/api/admin/review-cycles/${A}/participants`, { userIds: [idOf("FLATE")] });
  assert.equal(add.status, 400);
  assert.equal(add.data.code, "dept_locked");
  assert.deepEqual(add.data.depts, ["Fin Dept"]);
  assert.ok(!itemOf(await detail(A), "FLATE"), "一个都没加");
  // S5：提交后改配额 → quota_locked；原样回传未改动的配额（顺带改日期）仍放行（M9）
  const ql = await admin.put(`/api/admin/review-cycles/${A}/due`, { quota: { "A+": 50, "A": 8, "B+": 15, "B": 70, "C/D": 5 } });
  assert.equal(ql.status, 400);
  assert.equal(ql.data.code, "quota_locked");
  const same = await admin.put(`/api/admin/review-cycles/${A}/due`, { dueAt: "2026-12-21", quota: { "A+": 2, "A": 8, "B+": 15, "B": 70, "C/D": 5 } });
  assert.equal(same.status, 200, JSON.stringify(same.data));
  assert.equal(same.data.cycle.dueAt, "2026-12-21");
  assert.equal(same.data.cycle.quota["A+"], 2);
});

test("E3: members changing after the HoD submitted block the confirm (membership_changed) until they are back", async () => {
  await moveTo("FEMP9", "Elsewhere Dept");
  let d = await detail(A);
  // ids = 提交后新加入的人（移出的人已不在本组，只给人数）
  assert.deepEqual(deptRow(d, "Fin Dept").confirmIssues, [{ code: "membership_changed", added: 0, removed: 1, ids: [] }]);
  const conf = await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/confirm`, {});
  assert.equal(conf.status, 400);
  assert.equal(conf.data.code, "confirm_blocked");
  assert.deepEqual(conf.data.issues, [{ code: "membership_changed", added: 0, removed: 1, ids: [] }]);
  await moveTo("FEMP9", "Fin Dept");
  d = await detail(A);
  assert.deepEqual(deptRow(d, "Fin Dept").confirmIssues, []);
});

test("E2: the department's own HoD can't confirm or return it (self_confirm)", async () => {
  const selfId = await deptIdOf("Self Dept");
  // 详情里看的人（ADMIN）就是该组 HoD：confirmIssues 另带 self_confirm，前端据此置灰
  assert.deepEqual(strip(deptRow(await detail(A), "Self Dept").confirmIssues), [{ code: "rating_missing", n: 1 }, { code: "self_confirm" }]);
  for (const act of ["confirm", "return"]) {
    const r = await admin.post(`/api/admin/review-cycles/${A}/depts/${selfId}/${act}`, { reason: "x" });
    assert.equal(r.status, 409, act);
    assert.equal(r.data.code, "self_confirm", act);
    assert.match(r.data.error, /another HR.*另一名 HR/);
  }
});

test("1.2 confirm: the HoD is notified; confirming twice → already_confirmed; HR can't edit a confirmed department", async () => {
  const conf = await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/confirm`, {});
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  assert.ok((await notes("FHOD")).some((n) => n.title === "HR confirmed the calibration of Fin Dept for P0 Annual A" && /HR 已确认 Fin Dept/.test(n.title_zh)));
  const row = (await auditRows("review.dept.confirm")).find((x) => x.after.dept1 === "Fin Dept");
  assert.equal(row.after.headcount, 10);
  assert.equal(row.after.counts.B, 10);
  const again = await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/confirm`, {});
  assert.equal(again.status, 400);
  assert.equal(again.data.code, "already_confirmed");
  const d = await detail(A);
  assert.equal(itemOf(d, "FEMP1").hrCalibratable, false);
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "FEMP1").id}`, { finalRating: "A" })).data.code, "dept_confirmed");
});

test("S3: returning a confirmed department reopens it (wasConfirmed in the audit, the HoD is told); the HoD resubmits and HR confirms again", async () => {
  const r = await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/return`, { reason: "请复核 B 档" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = (await auditRows("review.dept.return")).find((x) => x.after.dept1 === "Fin Dept");
  assert.equal(row.after.wasConfirmed, true);
  assert.ok((await notes("FHOD")).some((n) => /HR returned the calibration of Fin Dept/.test(n.title)));
  let dep = deptRow(await detail(A), "Fin Dept");
  assert.equal(dep.status.hrConfirmedAt, null);
  assert.equal(dep.status.returnReason, "请复核 B 档");
  // 退回后不能直接确认（HoD 未重新提交）
  assert.equal((await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/confirm`, {})).data.code, "not_submitted");
  assert.equal((await C.FHOD.post("/api/me/reviews/hod/submit", { cycleId: A, dept1Id: finId })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${A}/depts/${finId}/confirm`, {})).status, 200);
});

test("1.1: the HoD's own review item stays with HR (annual: reason optional, recorded in hodText / audit)", async () => {
  await setOwner("Own Dept", idOf("OWN1"));
  const d = await detail(A);
  assert.equal(itemOf(d, "OWN1").hrCalibratable, true, "HoD 本人的评估项留给 HR");
  assert.equal(itemOf(d, "OWN2").hrCalibratable, false);
  const ok = await admin.put(`/api/admin/review-items/${itemOf(d, "OWN1").id}`, { finalRating: "A" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.item.finalRating, "A");
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "OWN2").id}`, { finalRating: "A" })).data.code, "hod_calibration_readonly");
  const row = (await auditRows("review.calibrate")).find((x) => x.target === itemOf(d, "OWN1").id);
  assert.deepEqual(row.after, { finalRating: "A", reason: null });
});

let B;   // 年度 v2：Gone Dept 10 人、Nine Dept 9 人，发起后全员离开在职状态 → 真正无 HoD，HR 评级
// 第二批 2.7（2026-10-08）：离职 / 停用的参与者不计入配额、不阻断确认。原来这两个用例用「全员停用」造出 10 人的无 HoD 部门来测
// 1.2 的配额拦截与关闭时的成员变动；按新规则这些人一个都不计入，所以改为验证 2.7 本身（1.2 的配额拦截见下面 bypass 用例的
// Rnd Dept：over_quota + ratings_changed；成员变动见 E3 的 Fin Dept）。
test("2.7 HoD-less departments whose members all left: nobody is counted (headcount 0, departedN, no blockers); HR may still rate them and confirm", async () => {
  const ids = [...Array.from({ length: 10 }, (_, i) => "GONE" + i), ...Array.from({ length: 9 }, (_, i) => "NINE" + i)];
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Annual B", kind: "annual", userIds: ids.map(idOf) });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  B = c.data.cycle.id;
  let d = await detail(B);
  assert.equal(deptRow(d, "Gone Dept").headcount, 10, "in service at launch: counted");
  assert.equal(deptRow(d, "Gone Dept").small, false);
  for (const e of ids) await setActive(e, false);
  d = await detail(B);
  const gone = deptRow(d, "Gone Dept"), nine = deptRow(d, "Nine Dept");
  assert.equal(gone.hod, null);
  assert.equal(gone.hodUnresolved, undefined, "无在职成员 = 真的无 HoD，不是待确认");
  assert.equal(gone.headcount, 0, "2.7: leavers are not counted");
  assert.equal(gone.departedN, 10);
  assert.equal(gone.small, true);
  assert.deepEqual(gone.confirmIssues, [], "2.7: leavers don't block the confirm");
  assert.equal(nine.departedN, 9);
  for (const e of ids) assert.equal(itemOf(d, e).hrCalibratable, true, e);
  assert.equal(itemOf(d, "GONE0").notCounted, "departed");
  // HR 仍可选择给离职者评级（D4），这些评级不进配额
  for (let i = 0; i < 5; i++) assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "GONE" + i).id}`, { finalRating: "B" })).status, 200);
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "GONE9").id}`, { finalRating: "A+" })).status, 200);
  d = await detail(B);
  assert.deepEqual(deptRow(d, "Gone Dept").over, [], "leavers' ratings are outside the quota");
  assert.deepEqual(deptRow(d, "Gone Dept").confirmIssues, []);
  assert.equal((await admin.post(`/api/admin/review-cycles/${B}/depts/${gone.dept1Id}/confirm`, {})).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "NINE" + i).id}`, { finalRating: i === 0 ? "A+" : "B" })).status, 200);
  assert.deepEqual(deptRow(await detail(B), "Nine Dept").confirmIssues, []);
  assert.equal((await admin.post(`/api/admin/review-cycles/${B}/depts/${nine.dept1Id}/confirm`, {})).status, 200);
});

test("2.7 close: a leaver moving between departments is not a membership change, but their rating stays locked with the confirmed department (departedIds); rated leavers are archived", async () => {
  await moveTo("NINE8", "Elsewhere Dept");
  let d = await detail(B);
  assert.equal(deptRow(d, "Nine Dept").membershipChanged, undefined, "a leaver leaving is not 'removed'");
  // 快照里的离职者同样锁定：调到别的部门也改不了他的评级（审查 P2）
  const hr = await admin.put(`/api/admin/review-items/${itemOf(d, "NINE8").id}`, { finalRating: "A" });
  assert.equal(hr.status, 400, JSON.stringify(hr.data));
  assert.equal(hr.data.code, "dept_confirmed");
  await moveTo("NINE8", "Nine Dept");
  d = await detail(B);
  assert.equal(itemOf(d, "NINE8").finalRating, "B");
  const ok = await admin.post(`/api/admin/review-cycles/${B}/close`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.written, 15, "6 rated in Gone Dept + 9 in Nine Dept; unrated leavers are skipped");
});

test("E1 HoD unresolved (several possible heads; inactive level-1 department): HR read-only and confirm → hod_unresolved", async () => {
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Annual D", kind: "annual", userIds: ["ORP1", "ORP2", "SHUT1"].map(idOf) });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const D = c.data.cycle.id;
  let d = await detail(D);
  const orphan = deptRow(d, "Orphan Dept");
  assert.equal(orphan.hod, null);
  assert.equal(orphan.hodUnresolved, true);
  assert.deepEqual(strip(orphan.confirmIssues), [{ code: "hod_unresolved" }, { code: "rating_missing", n: 2 }]);
  assert.equal(itemOf(d, "ORP1").hrCalibratable, false);
  const put = await admin.put(`/api/admin/review-items/${itemOf(d, "ORP1").id}`, { finalRating: "B" });
  assert.equal(put.status, 409);
  assert.equal(put.data.code, "hod_unresolved");
  assert.match(put.data.error, /Departments page.*部门页指定负责人/);
  const conf = await admin.post(`/api/admin/review-cycles/${D}/depts/${orphan.dept1Id}/confirm`, {});
  assert.equal(conf.status, 409);
  assert.equal(conf.data.code, "hod_unresolved");
  // 一级部门停用 → HoD 消失；该组从没提交过 → 待确认，不是「无 HoD」。
  // 指定负责人解决不了（deriveHods 跳过停用的一级部门）→ 单独的 dept_inactive，提示重新启用或调整人员（审查）
  assert.equal(itemOf(d, "SHUT1").hrCalibratable, false, "停用前有 HoD（负责人）");
  await setDeptActive("Shut Dept", false);
  d = await detail(D);
  const shut = deptRow(d, "Shut Dept");
  assert.equal(shut.hodUnresolved, true);
  assert.equal(shut.deptInactive, true);
  assert.equal(shut.hodOwned, false);
  assert.deepEqual(strip(shut.confirmIssues), [{ code: "dept_inactive" }, { code: "rating_missing", n: 1 }]);
  const putShut = await admin.put(`/api/admin/review-items/${itemOf(d, "SHUT1").id}`, { finalRating: "B" });
  assert.equal(putShut.status, 409);
  assert.equal(putShut.data.code, "dept_inactive");
  assert.match(putShut.data.error, /Reactivate it.*重新启用该部门/);
  const confShut = await admin.post(`/api/admin/review-cycles/${D}/depts/${shut.dept1Id}/confirm`, {});
  assert.equal(confShut.status, 409);
  assert.equal(confShut.data.code, "dept_inactive");
  await setDeptActive("Shut Dept", true);
  assert.equal(deptRow(await detail(D), "Shut Dept").deptInactive, undefined);
});

let Q;   // 季度 v2：「__none」组 10 人（部门为空），上级 NMGR
test("E4 / D4 HoD-less __none group (quarter): changing the manager rating needs a reason (written to hodText); over quota only warns; returning an unsubmitted group → not_submitted and the self-review stays open", async () => {
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Quarter Q", flow: "v2", kind: "quarter", userIds: Array.from({ length: 10 }, (_, i) => idOf("NN" + (i + 1))) });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  Q = c.data.cycle.id;
  let d = await detail(Q);
  const none = deptRow(d, "__none");
  assert.equal(none.dept1Id, "__none");
  assert.equal(none.headcount, 10);
  assert.equal(none.small, true, "E4：__none 按小部门处理");
  const ret = await admin.post(`/api/admin/review-cycles/${Q}/depts/__none/return`, { reason: "too early" });
  assert.equal(ret.status, 400);
  assert.equal(ret.data.code, "not_submitted");
  assert.equal((await C.NN1.post(`/api/me/reviews/${itemOf(d, "NN1").id}/self`, selfBody)).status, 200, "E 场景：自评没有被提前锁");
  for (let i = 1; i <= 10; i++) {
    const r = await C.NMGR.post(`/api/me/reviews/${itemOf(d, "NN" + i).id}/manager`, { rating: "B", oneOnOneDone: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const noReason = await admin.put(`/api/admin/review-items/${itemOf(d, "NN2").id}`, { finalRating: "A+" });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, "reason_required");
  const withReason = await admin.put(`/api/admin/review-items/${itemOf(d, "NN2").id}`, { finalRating: "A+", reason: "主导了支付对账改造" });
  assert.equal(withReason.status, 200, JSON.stringify(withReason.data));
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "NN3").id}`, { finalRating: "B" })).status, 200, "与上级评级相同不需要理由");
  d = await detail(Q);
  assert.equal(itemOf(d, "NN2").hodText, "主导了支付对账改造");
  assert.ok(itemOf(d, "NN2").hodAt);
  const row = (await auditRows("review.calibrate")).find((x) => x.target === itemOf(d, "NN2").id && x.after.finalRating === "A+");
  assert.deepEqual(row.after, { finalRating: "A+", reason: "主导了支付对账改造" });
  assert.ok(deptRow(d, "__none").over.some((o) => o.tier === "A+" && o.count === 1 && o.allowed === 0));
  assert.deepEqual(deptRow(d, "__none").confirmIssues, [], "E4：超额只提示");
  // 确认前员工可以确认、也可以取消面谈确认
  const one = `/api/me/reviews/${itemOf(d, "NN1").id}/one-on-one`;
  assert.equal((await C.NN1.post(one, { done: true })).status, 200);
  assert.equal((await C.NN1.post(one, { done: false })).status, 200);
  assert.equal((await C.NN1.post(one, { done: true })).status, 200);
});

test("E4 / S7: after HR confirms the __none group the manager, the self-review, 1-on-1 withdrawal and additions are all locked; reopening unlocks HR", async () => {
  const conf = await admin.post(`/api/admin/review-cycles/${Q}/depts/__none/confirm`, {});
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  let d = await detail(Q);
  const mgr = await C.NMGR.post(`/api/me/reviews/${itemOf(d, "NN4").id}/manager`, { rating: "A+", oneOnOneDone: true, highlights: "x" });
  assert.equal(mgr.status, 400);
  assert.equal(mgr.data.code, "dept_locked", "H4：确认过的 __none 组上级不能再改");
  const one = `/api/me/reviews/${itemOf(d, "NN1").id}/one-on-one`;
  const wd = await C.NN1.post(one, { done: false });
  assert.equal(wd.status, 409);
  assert.equal(wd.data.code, "self_locked");
  assert.equal((await C.NN1.post(one, { done: true })).status, 200, "确认面谈仍放行");
  assert.equal((await C.NN1.post(`/api/me/reviews/${itemOf(d, "NN1").id}/self`, selfBody)).data.code, "self_locked");
  assert.equal((await C.NN1.get("/api/me/reviews")).data.mine.find((m) => m.cycle === "P0 Quarter Q").selfLocked, true);
  const add = await admin.post(`/api/admin/review-cycles/${Q}/participants`, { userIds: [idOf("NN11")] });
  assert.equal(add.status, 400);
  assert.equal(add.data.code, "dept_locked");
  assert.equal(itemOf(d, "NN5").hrCalibratable, false);
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "NN5").id}`, { finalRating: "A" })).data.code, "dept_confirmed");
  // 撤销确认（无 HoD 的组也走退回接口，理由必填，不发通知）
  assert.equal((await admin.post(`/api/admin/review-cycles/${Q}/depts/__none/return`, {})).data.code, "reason_required");
  assert.equal((await admin.post(`/api/admin/review-cycles/${Q}/depts/__none/return`, { reason: "补一个评级" })).status, 200);
  const row = (await auditRows("review.dept.return")).find((x) => x.after.dept1 === null && x.after.reason === "补一个评级");
  assert.equal(row.after.wasConfirmed, true);
  d = await detail(Q);
  assert.equal(itemOf(d, "NN5").hrCalibratable, true);
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "NN5").id}`, { finalRating: "B+", reason: "补评" })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${Q}/depts/__none/confirm`, {})).status, 200);
});

// 审查（P0 修复轮，高）：锁定按「快照里的人」判断，不按「现在的部门」—— 把人调出已确认的组，上级、HR 都不能在新组里改他的评级
test("bypass: moving someone out of the confirmed __none group doesn't unlock the manager or HR (dept_locked / dept_confirmed)", async () => {
  await moveTo("NN4", "Elsewhere Dept");   // Elsewhere Dept 没有别人：NN4 成了推算的 HoD，那一条在新组里是「HoD 本人的评估项」
  let d = await detail(Q);
  assert.equal(itemOf(d, "NN4").hrCalibratable, false);
  assert.deepEqual(deptRow(d, "__none").membershipChanged, { added: 0, removed: 1 });
  const mgr = await C.NMGR.post(`/api/me/reviews/${itemOf(d, "NN4").id}/manager`, { rating: "A+", oneOnOneDone: true, highlights: "x" });
  assert.equal(mgr.status, 400);
  assert.equal(mgr.data.code, "dept_locked");
  const hr = await admin.put(`/api/admin/review-items/${itemOf(d, "NN4").id}`, { finalRating: "A+", reason: "x" });
  assert.equal(hr.status, 400);
  assert.equal(hr.data.code, "dept_confirmed");
  await moveTo("NN4", "");
  d = await detail(Q);
  assert.equal(itemOf(d, "NN4").managerRating, "B", "rating unchanged");
  assert.equal(deptRow(d, "__none").membershipChanged, undefined);
});

// 审查（P0 修复轮）：HoD 已提交 / HR 已确认的部门，调出再调回、对调部门负责人、HR 临时当 HoD、库里被直接改了评级 —— 都改不动或拦得住
let RV;   // 年度 v2：Rnd Dept 10 人（负责人 RHOD）+ Other Dept 1 人（负责人 XHOD）
test("bypass: a submitted / confirmed department can't be changed by moving people out and back (HR and another HoD), and a rating changed behind the routes' back blocks confirm and close", async () => {
  await newPerson("RHOD", "Rnd Hod", "Rnd Dept");
  await setOwner("Rnd Dept", idOf("RHOD"));
  const RND = Array.from({ length: 10 }, (_, i) => "RND" + i);
  await bulk(RND.map((e, i) => [e, "Rnd Emp " + i, "Rnd Dept", "RHOD"]));
  await newPerson("XHOD", "Other Hod", "Other Dept");
  await setOwner("Other Dept", idOf("XHOD"));
  await bulk([["XEMP", "Other Emp", "Other Dept", "XHOD"]]);
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Bypass R", kind: "annual", userIds: [...RND, "XEMP"].map(idOf) });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  RV = c.data.cycle.id;
  const rndId = await deptIdOf("Rnd Dept");
  const g = (await C.RHOD.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === RV);
  for (const it of hodRows(g)) assert.equal((await C.RHOD.put(`/api/me/reviews/hod/items/${it.id}`, { rating: "B" })).status, 200);
  assert.equal((await C.RHOD.post("/api/me/reviews/hod/submit", { cycleId: RV, dept1Id: rndId })).status, 200);
  let d = await detail(RV);
  // 调到空部门（__none）：HR 仍只读
  await moveTo("RND0", "");
  d = await detail(RV);
  assert.equal(itemOf(d, "RND0").dept1Id, "__none");
  assert.equal(itemOf(d, "RND0").hrCalibratable, false);
  const out = await admin.put(`/api/admin/review-items/${itemOf(d, "RND0").id}`, { finalRating: "B+" });
  assert.equal(out.status, 409);
  assert.equal(out.data.code, "hod_calibration_readonly");
  // 调到另一个 HoD 的部门：那个 HoD 也改不了
  await moveTo("RND1", "Other Dept");
  const other = await C.XHOD.put(`/api/me/reviews/hod/items/${itemOf(d, "RND1").id}`, { rating: "A+" });
  assert.equal(other.status, 400);
  assert.equal(other.data.code, "dept_locked");
  await moveTo("RND0", "Rnd Dept");
  await moveTo("RND1", "Rnd Dept");
  d = await detail(RV);
  assert.equal(itemOf(d, "RND0").finalRating, "B");
  assert.equal(itemOf(d, "RND1").finalRating, "B");
  assert.deepEqual(deptRow(d, "Rnd Dept").confirmIssues, []);
  // 绕过接口直接改库（兜底）：评级与提交快照不一致 → ratings_changed，确认被拦
  const { DatabaseSync } = require("node:sqlite");
  const setFinal = (eid, v) => { const db = new DatabaseSync(srv.dbPath); try { db.prepare("UPDATE review_items SET finalRating = ? WHERE id = ?").run(v, itemOf(d, eid).id); } finally { db.close(); } };
  setFinal("RND2", "A+");
  d = await detail(RV);
  assert.deepEqual(deptRow(d, "Rnd Dept").confirmIssues, [
    { code: "over_quota", over: [{ tier: "A+", count: 1, allowed: 0 }], ids: [itemOf(d, "RND2").id] },
    { code: "ratings_changed", n: 1, ids: [itemOf(d, "RND2").id] },
  ]);
  const blocked = await admin.post(`/api/admin/review-cycles/${RV}/depts/${rndId}/confirm`, {});
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.code, "confirm_blocked");
  setFinal("RND2", "B");
  assert.equal((await admin.post(`/api/admin/review-cycles/${RV}/depts/${rndId}/confirm`, {})).status, 200);
  // 确认之后：调出去 HR 也改不了（dept_confirmed）；库里被改 → 详情 ratingsChanged，关闭 → depts_changed
  await moveTo("RND3", "");
  d = await detail(RV);
  const after = await admin.put(`/api/admin/review-items/${itemOf(d, "RND3").id}`, { finalRating: "A+" });
  assert.equal(after.status, 400);
  assert.equal(after.data.code, "dept_confirmed");
  await moveTo("RND3", "Rnd Dept");
  setFinal("RND4", "B+");
  d = await detail(RV);
  assert.equal(deptRow(d, "Rnd Dept").ratingsChanged, 1);
  assert.equal(deptRow(d, "Rnd Dept").membershipChanged, undefined);
  // Other Dept 还没确认 → 先确认它（XHOD 评级、提交）
  const og = (await C.XHOD.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === RV);
  for (const it of hodRows(og)) assert.equal((await C.XHOD.put(`/api/me/reviews/hod/items/${it.id}`, { rating: "B" })).status, 200);
  assert.equal((await C.XHOD.post("/api/me/reviews/hod/submit", { cycleId: RV, dept1Id: await deptIdOf("Other Dept") })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${RV}/depts/${await deptIdOf("Other Dept")}/confirm`, {})).status, 200);
  const cl = await admin.post(`/api/admin/review-cycles/${RV}/close`, {});
  assert.equal(cl.status, 400);
  assert.equal(cl.data.code, "depts_changed");
  assert.deepEqual(cl.data.depts, ["Rnd Dept"]);
  setFinal("RND4", "B");
  const ok = await admin.post(`/api/admin/review-cycles/${RV}/close`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.written, 11);
});

test("bypass: after the HoD submits, swapping the department owner doesn't make an employee 'the HoD's own item' for HR", async () => {
  await newPerson("SHOD", "Swap Hod", "Swap Dept");
  await setOwner("Swap Dept", idOf("SHOD"));
  await bulk([["SWP1", "Swap One", "Swap Dept", "SHOD"], ["SWP2", "Swap Two", "Swap Dept", "SHOD"]]);
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Bypass S", kind: "annual", userIds: ["SWP1", "SWP2"].map(idOf) });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const S = c.data.cycle.id;
  const swapId = await deptIdOf("Swap Dept");
  const g = (await C.SHOD.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === S);
  for (const it of hodRows(g)) assert.equal((await C.SHOD.put(`/api/me/reviews/hod/items/${it.id}`, { rating: "B" })).status, 200);
  assert.equal((await C.SHOD.post("/api/me/reviews/hod/submit", { cycleId: S, dept1Id: swapId })).status, 200);
  await setOwner("Swap Dept", idOf("SWP1"));
  const d = await detail(S);
  assert.equal(itemOf(d, "SWP1").hrCalibratable, false);
  const put = await admin.put(`/api/admin/review-items/${itemOf(d, "SWP1").id}`, { finalRating: "A" });
  assert.equal(put.status, 409);
  assert.equal(put.data.code, "hod_calibration_readonly");
  await setOwner("Swap Dept", idOf("SHOD"));
  assert.equal(itemOf(await detail(S), "SWP1").finalRating, "B");
  assert.equal((await admin.post(`/api/admin/review-cycles/${S}/depts/${swapId}/confirm`, {})).status, 200);
});

test("E2 bypass: an HR who calibrated as a temporary HoD can't confirm or return that department afterwards (self_confirm)", async () => {
  await newPerson("AHOD", "Adv Hod", "Adv Dept");
  await setOwner("Adv Dept", idOf("AHOD"));
  await bulk([["ADV1", "Adv One", "Adv Dept", "AHOD"], ["ADV2", "Adv Two", "Adv Dept", "AHOD"]]);
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Bypass T", kind: "annual", userIds: ["ADV1", "ADV2"].map(idOf) });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const T = c.data.cycle.id;
  const advId = await deptIdOf("Adv Dept");
  await setOwner("Adv Dept", adminId);
  const g = (await admin.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === T);
  for (const it of hodRows(g)) assert.equal((await admin.put(`/api/me/reviews/hod/items/${it.id}`, { rating: "A" })).status, 200);
  await setOwner("Adv Dept", idOf("AHOD"));
  assert.equal((await C.AHOD.post("/api/me/reviews/hod/submit", { cycleId: T, dept1Id: advId })).status, 200);
  assert.ok(deptRow(await detail(T), "Adv Dept").confirmIssues.some((x) => x.code === "self_confirm"));
  for (const act of ["confirm", "return"]) {
    const r = await admin.post(`/api/admin/review-cycles/${T}/depts/${advId}/${act}`, { reason: "x" });
    assert.equal(r.status, 409, act);
    assert.equal(r.data.code, "self_confirm", act);
  }
});

test("returned department whose level-1 has no in-service members left goes back to HR (no deadlock); detail exposes status.hodId and hodOwned", async () => {
  await newPerson("LHOD", "Lone Hod", "Lone Dept");
  await bulk([["LE1", "Lee One", "Lone Dept", "LHOD"]]);
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Lone", kind: "annual", userIds: [idOf("LE1")] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const L = c.data.cycle.id;
  const loneId = await deptIdOf("Lone Dept");
  const g = (await C.LHOD.get("/api/me/reviews/hod")).data.groups.find((x) => x.cycle.id === L);
  assert.equal((await C.LHOD.put(`/api/me/reviews/hod/items/${hodRows(g)[0].id}`, { rating: "B" })).status, 200);
  assert.equal((await C.LHOD.post("/api/me/reviews/hod/submit", { cycleId: L, dept1Id: loneId })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${L}/depts/${loneId}/return`, { reason: "复核" })).status, 200);
  let row = deptRow(await detail(L), "Lone Dept");
  assert.equal(row.status.hodId, idOf("LHOD"));
  assert.equal(row.hodOwned, true, "the HoD is still there: returned to them");
  await setActive("LHOD", false);
  await setActive("LE1", false);
  const d = await detail(L);
  row = deptRow(d, "Lone Dept");
  assert.equal(row.hod, null);
  assert.equal(row.hodUnresolved, undefined, "no in-service members = truly no HoD");
  assert.equal(row.hodOwned, false);
  assert.equal(row.status.hodId, idOf("LHOD"));
  assert.equal(itemOf(d, "LE1").hrCalibratable, true);
  assert.equal((await admin.put(`/api/admin/review-items/${itemOf(d, "LE1").id}`, { finalRating: "B+" })).status, 200);
  const conf = await admin.post(`/api/admin/review-cycles/${L}/depts/${loneId}/confirm`, {});
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
});

test("legacy cycles keep HR calibration (no reason) and hrCalibratable follows the cycle status", async () => {
  const c = await admin.post("/api/admin/review-cycles", { name: "P0 Legacy", userIds: [idOf("FEMP1")] });
  assert.equal(c.status, 200);
  let d = await detail(c.data.cycle.id);
  assert.equal(d.items[0].hrCalibratable, true);
  assert.deepEqual(d.depts, []);
  assert.equal((await admin.put(`/api/admin/review-items/${d.items[0].id}`, { finalRating: "A" })).status, 200);
  assert.equal((await admin.post(`/api/admin/review-cycles/${c.data.cycle.id}/close`, {})).status, 200);
  d = await detail(c.data.cycle.id);
  assert.equal(d.items[0].hrCalibratable, false);
});
