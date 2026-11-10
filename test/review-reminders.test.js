// 评估按阶段批量提醒（2026-10-07 批量操作第二批 B6）：POST /api/admin/review-reminders
//   { stage: "self"|"one_on_one"|"manager"|"hod", by: "cycle"|"dept"|"item", ids, cycleId? }
//   · 自评：按条目勾 3 人 = 上级单条提醒 3 次（标题、审计 review.nudge 相同），正文是中性说法；与单条共用 1 小时节流。
//   · 上级评级：同一上级的多个条目合并成 1 条通知（审计 review.remind，items = 他全部待评级的人数）；
//     员工未交自评 → self_pending；没有在职上级 → no_manager。
//   · 面谈确认：上级还没登记面谈 → manager_pending（第二批 2.1 起不再要求先交自评）；已确认 = 未改动。
//   · HoD：部门未提交就照常提醒 HoD（第二批 G5：HoD 可以代评，不再有 hod_not_ready）；没有 HoD → no_hod；已提交 = 未改动；年度用年度文案。
//   · 不适用 → stage_not_applicable；按条目选 HoD → 400 bad_stage；周期已关闭 → cycle_closed；收件人已离职 → recipient_inactive。
//   · 范围：按条目选越界整批 404；按部门选 HoD 阶段组里有范围外的人整批 404；按周期、按部门选其余阶段收窄到范围内。
//   · 站内通知的条数始终等于返回的 reminded（收件人 id 传错时通知与审计会悄悄全丢，这里钉住）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin, scoped;
const people = {};   // employeeId → { id, client }
const dept = {};     // name → id
let Q, A, V1;        // 季度 v2、年度、旧流程周期 id
let items = {};      // employeeId → Q 的评估条目 id
let qDepts = {};     // 部门名 → Q 的 dept1Id

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
const one = (sql, ...a) => dbRead((d) => d.prepare(sql).get(...a));
const all = (sql, ...a) => dbRead((d) => d.prepare(sql).all(...a));
const notifCount = () => one("SELECT COUNT(*) AS n FROM notifications").n;
// 只取提醒（发起周期时给参与者的「请提交自评」通知不算）
const reviewNotes = (uid) => all("SELECT title, title_zh, body, body_zh, link FROM notifications WHERE userId = ? AND type = 'review' AND title LIKE 'Reminder:%' ORDER BY createdAt, id", uid);
const auditRows = (action) => all("SELECT target, afterJson FROM audit_logs WHERE action = ? ORDER BY id", action).map((r) => ({ target: r.target, after: JSON.parse(r.afterJson || "null") }));

async function newPerson(employeeId, name, department, managerEmployeeId) {
  const r = await admin.post("/api/admin/employees", { name, employeeId, ...(department ? { department } : {}), jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: r.data.password });
  await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: "rr-pass-123" });
  const id = one("SELECT id FROM users WHERE employeeId = ?", employeeId).id;
  if (managerEmployeeId) assert.equal((await admin.put(`/api/admin/employees/${id}`, { managerId: people[managerEmployeeId].id })).status, 200);
  people[employeeId] = { id, client: c };
  return people[employeeId];
}
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };
const remind = (c, body) => c.post("/api/admin/review-reminders", body);
const submitSelf = async (e) => assert.equal((await people[e].client.post(`/api/me/reviews/${items[e]}/self`, selfBody)).status, 200, e + " self");
const rate = async (mgr, e) => { const r = await people[mgr].client.post(`/api/me/reviews/${items[e]}/manager`, { rating: "B", oneOnOneDone: true }); assert.equal(r.status, 200, e + " rated: " + JSON.stringify(r.data)); };
const confirmOne = async (e) => assert.equal((await people[e].client.post(`/api/me/reviews/${items[e]}/one-on-one`, { done: true })).status, 200, e + " 1-on-1");
// 每次调用：通知条数的增量必须等于 reminded
async function remindChecked(c, body) {
  const n0 = notifCount();
  const r = await remind(c, body);
  if (r.status === 200) assert.equal(notifCount() - n0, r.data.reminded, "notifications written = reminded: " + JSON.stringify(r.data));
  else assert.equal(notifCount(), n0, "nothing written on " + r.status);
  return r;
}
const codes = (r) => r.data.results.map((x) => (x.ok ? (x.unchanged ? "unchanged" : "ok") : x.code));

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["RR Dept", null], ["RR Other", null], ["RR Child", "RR Other"]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, "create department " + name + ": " + JSON.stringify(r.data));
    dept[name] = r.data.department.id;
  }
  await newPerson("RR-HOD", "Rita Hod", "RR Dept");
  assert.equal((await admin.put(`/api/admin/departments/${dept["RR Dept"]}`, { ownerId: people["RR-HOD"].id })).status, 200);
  await newPerson("RR-HOD2", "Otto Hod", "RR Other");
  assert.equal((await admin.put(`/api/admin/departments/${dept["RR Other"]}`, { ownerId: people["RR-HOD2"].id })).status, 200);
  await newPerson("RR-M1", "Mia Mgr", "RR Dept", "RR-HOD");
  await newPerson("RR-M2", "Max Mgr", "RR Dept", "RR-HOD");
  for (const e of ["RR-E1", "RR-E2", "RR-E3", "RR-X1"]) await newPerson(e, "Emp " + e, "RR Dept", "RR-M1");
  for (const e of ["RR-E4", "RR-E5", "RR-E6"]) await newPerson(e, "Emp " + e, "RR Dept", "RR-M2");
  await newPerson("RR-E7", "No Manager", "RR Dept");
  await newPerson("RR-O1", "Other One", "RR Other", "RR-HOD2");
  await newPerson("RR-C1", "Child One", "RR Child", "RR-HOD2");
  await newPerson("RR-N1", "No Dept", null);
  const qIds = ["RR-M1", "RR-M2", "RR-E1", "RR-E2", "RR-E3", "RR-X1", "RR-E4", "RR-E5", "RR-E6", "RR-E7", "RR-O1", "RR-C1", "RR-N1"].map((k) => people[k].id);
  const q = await admin.post("/api/admin/review-cycles", { name: "RR 2026Q4", flow: "v2", kind: "quarter", dueAt: "2026-12-20", dueRateAt: "2026-12-25", dueCalibAt: "2026-12-30", userIds: qIds });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  Q = q.data.cycle.id;
  const detail = (await admin.get(`/api/admin/review-cycles/${Q}`)).data;
  items = Object.fromEntries(detail.items.map((i) => [i.employeeId, i.id]));
  qDepts = Object.fromEntries(detail.depts.map((d) => [d.dept1 || "__none", d.dept1Id]));
  assert.ok(qDepts["RR Dept"] && qDepts["RR Other"] && qDepts.__none, JSON.stringify(detail.depts));
  const a = await admin.post("/api/admin/review-cycles", { name: "RR 2026 Annual", kind: "annual", dueCalibAt: "2026-12-31", userIds: ["RR-E1", "RR-E2"].map((k) => people[k].id) });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  A = a.data.cycle.id;
  const v = await admin.post("/api/admin/review-cycles", { name: "RR Legacy", dueAt: "2026-12-20", userIds: [people["RR-E1"].id] });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  V1 = v.data.cycle.id;
  // 范围受限的 HR：绩效管理，范围只有「RR Child」（不含上级部门 RR Other）
  const role = await admin.post("/api/admin/roles", { name: "RR Scoped Perf", name_zh: "RR 范围绩效", grants: { performance: "manage" }, scope: { departments: [{ id: dept["RR Child"], includeChildren: true }] } });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const hr = await admin.post("/api/admin/employees", { name: "RR Scoped HR", employeeId: "RR-HR", programIds: [] });
  const hrId = one("SELECT id FROM users WHERE employeeId = 'RR-HR'").id;
  assert.equal((await admin.put("/api/admin/employees/" + hrId, { department: "RR Dept", jobLevel: "P5", adminRoleId: role.data.role.id })).status, 200);
  scoped = await loginAs(srv.base, { employeeId: "RR-HR", password: hr.data.password });
  assert.equal((await scoped.post("/api/auth/change-password", { currentPassword: hr.data.password, newPassword: "rr-hr-pass-2026" })).status, 200);
});
after(async () => { if (srv) await srv.stopAsync(); });

test("validation: bad step / selection, by:item + hod, dept without a cycle, unknown or closed cycle, empty ids", async () => {
  const bad = [
    [{ stage: "nope", by: "cycle", ids: [Q] }, 400, "bad_stage"],
    [{ stage: "hod", by: "item", ids: [items["RR-E1"]] }, 400, "bad_stage"],
    [{ stage: "self", by: "people", ids: [Q] }, 400, "bad_by"],
    [{ stage: "self", by: "dept", ids: [qDepts["RR Dept"]] }, 400, "cycle_required"],
    [{ stage: "self", by: "item", cycleId: "rc-nope", ids: [items["RR-E1"]] }, 404, "cycle_not_found"],
    [{ stage: "self", by: "cycle", ids: [] }, 400, "no_items"],
  ];
  for (const [body, status, code] of bad) {
    const r = await remindChecked(admin, body);
    assert.equal(r.status, status, JSON.stringify(body) + " → " + JSON.stringify(r.data));
    assert.equal(r.data.code, code);
    assert.ok(r.data.error && r.data.error_zh, code + " is bilingual");
  }
});

test("self by item: 3 people = the manager's single nudge 3 times (same title and review.nudge audit), neutral body; shared 1-hour throttle", async () => {
  const n0 = auditRows("review.nudge").length;
  for (const e of ["RR-E4", "RR-E5", "RR-E6"]) assert.equal((await people["RR-M2"].client.post(`/api/me/reviews/${items[e]}/nudge`)).status, 200, e);
  const r = await remindChecked(admin, { stage: "self", by: "item", ids: ["RR-E1", "RR-E2", "RR-E3"].map((e) => items[e]) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.done, r.data.skipped, r.data.reminded, r.data.stage], [3, 0, 3, "self"]);
  const single = reviewNotes(people["RR-E4"].id)[0], bulk = reviewNotes(people["RR-E1"].id)[0];
  assert.equal(bulk.title, single.title);
  assert.equal(bulk.title_zh, single.title_zh);
  assert.equal(bulk.link, single.link);
  assert.match(single.body, /Your manager Max Mgr/);
  assert.equal(bulk.body, "Please submit your self-review for RR 2026Q4 under Performance Reviews by 2026-12-20.");
  assert.equal(bulk.body_zh, "请在 2026-12-20 前在「绩效评估」中提交「RR 2026Q4」自评。");
  const nudges = auditRows("review.nudge").slice(n0);
  assert.equal(nudges.length, 6);
  const byUser = new Map(Object.entries(people).map(([k, p]) => [p.id, k]));
  for (const x of nudges) {
    assert.deepEqual(Object.keys(x.after).sort(), ["cycle", "userId"], "single and bulk audit rows have the same payload");
    assert.equal(x.after.cycle, "RR 2026Q4");
    assert.equal(x.target, items[byUser.get(x.after.userId)], "target = the review item");
  }
  // 1 小时节流：HR 再提醒同一人 → cooldown；上级刚提醒过的人 → cooldown；HR 提醒过的人上级再提醒 → 429
  const again = await remindChecked(admin, { stage: "self", by: "item", ids: [items["RR-E1"], items["RR-E4"]] });
  assert.deepEqual(codes(again), ["cooldown", "cooldown"]);
  assert.equal(again.data.reminded, 0);
  assert.equal(again.data.skippedPeople, 2);
  const mgr = await people["RR-M1"].client.post(`/api/me/reviews/${items["RR-E2"]}/nudge`);
  assert.equal(mgr.status, 429);
  assert.equal(mgr.data.code, "cooldown");
});

test("self: a leaver is recipient_inactive; done people are unchanged, not failures", async () => {
  assert.equal((await admin.put(`/api/admin/employees/${people["RR-X1"].id}`, { empStatus: "exited" })).status, 200);
  await submitSelf("RR-E7");
  const r = await remindChecked(admin, { stage: "self", by: "item", cycleId: Q, ids: [items["RR-X1"], items["RR-E7"]] });
  assert.deepEqual(codes(r), ["recipient_inactive", "unchanged"]);
  assert.equal(r.data.unchanged, 1);
  assert.equal(r.data.skippedPeople, 1, "the done one is not counted as skipped");
});

test("manager: one notification per manager (items = all reports awaiting their rating); self not submitted → self_pending; no manager → no_manager", async () => {
  for (const e of ["RR-E1", "RR-E2", "RR-E3"]) await submitSelf(e);
  const before = reviewNotes(people["RR-M1"].id).length;
  const r = await remindChecked(admin, { stage: "manager", by: "item", ids: ["RR-E1", "RR-E2", "RR-E3", "RR-E5", "RR-E7"].map((e) => items[e]) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(codes(r), ["ok", "ok", "ok", "self_pending", "no_manager"]);
  assert.equal(r.data.reminded, 1, "three items, one manager, one notification");
  const notes = reviewNotes(people["RR-M1"].id).slice(before);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Reminder: 3 direct report(s) awaiting your rating for RR 2026Q4 (due 2026-12-25)");
  assert.equal(notes[0].title_zh, "提醒：「RR 2026Q4」还有 3 位下属待你评级（截止 2026-12-25）");
  const audit = auditRows("review.remind").pop();
  assert.equal(audit.target, Q);
  assert.deepEqual(audit.after, { stage: "manager", userId: people["RR-M1"].id, items: 3, cycle: "RR 2026Q4" });
  // 同一上级 1 小时内再提醒 → 全部 cooldown
  const again = await remindChecked(admin, { stage: "manager", by: "item", ids: [items["RR-E1"]] });
  assert.deepEqual(codes(again), ["cooldown"]);
});

test("one_on_one: the manager has not logged it → manager_pending (no self-review precondition since 2.1); after the manager logs it → reminded; confirmed → unchanged", async () => {
  const early = await remindChecked(admin, { stage: "one_on_one", by: "item", ids: [items["RR-E1"], items["RR-E5"]] });
  assert.deepEqual(codes(early), ["manager_pending", "manager_pending"]);
  await rate("RR-M1", "RR-E1");
  await rate("RR-M1", "RR-E2");
  await confirmOne("RR-E2");
  const r = await remindChecked(admin, { stage: "one_on_one", by: "item", ids: [items["RR-E1"], items["RR-E2"]] });
  assert.deepEqual(codes(r), ["ok", "unchanged"]);
  assert.equal(r.data.reminded, 1);
  const note = reviewNotes(people["RR-E1"].id).pop();
  assert.equal(note.title, "Reminder: please confirm your 1-on-1 for RR 2026Q4");
  assert.deepEqual(auditRows("review.remind").pop().after, { stage: "one_on_one", userId: people["RR-E1"].id, items: 1, cycle: "RR 2026Q4" });
});

test("scope: by item one out-of-scope person → whole batch 404; by cycle and by dept (non-HoD steps) narrow to in-scope people; by dept HoD with out-of-scope members → 404", async () => {
  const oos = await remindChecked(scoped, { stage: "self", by: "item", ids: [items["RR-C1"], items["RR-O1"]] });
  assert.equal(oos.status, 404, JSON.stringify(oos.data));
  assert.equal(oos.data.code, "out_of_scope");
  assert.equal(oos.data.outOfScope, 1);
  // 周期详情：RR Other 组里有范围外的人 → scopePartial
  const det = (await scoped.get(`/api/admin/review-cycles/${Q}`)).data;
  assert.deepEqual(det.depts.map((d) => [d.dept1, !!d.scopePartial]), [["RR Other", true]]);
  // 部门面板读的字段名必须与服务端一致（曾因 partialScope / scopePartial 对不上，HoD 置灰整个失效）
  const rvcSrc = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "web", "src", "pages", "admin", "ReviewCycles.jsx"), "utf8");
  assert.match(rvcSrc, /r\.scopePartial\b/, "ReviewCycles.jsx reads depts[].scopePartial");
  assert.doesNotMatch(rvcSrc, /\bpartialScope\b/, "no stale field name");
  // 按周期选 HoD：范围内只有部分成员的部门不能提醒 HoD → 记跳过 hod_scope_partial，而不是「没有待完成的人」
  const hodByCycle = await remindChecked(scoped, { stage: "hod", by: "cycle", ids: [Q] });
  assert.equal(hodByCycle.status, 200, JSON.stringify(hodByCycle.data));
  assert.deepEqual(codes(hodByCycle), ["hod_scope_partial"]);
  assert.deepEqual([hodByCycle.data.reminded, hodByCycle.data.skippedPeople], [0, 1]);
  assert.deepEqual(hodByCycle.data.results[0].skippedBy, { hod_scope_partial: 1 });
  const byCycle = await remindChecked(scoped, { stage: "self", by: "cycle", ids: [Q] });
  assert.equal(byCycle.status, 200, JSON.stringify(byCycle.data));
  assert.deepEqual([byCycle.data.reminded, byCycle.data.results[0].pending, byCycle.data.results[0].reminded], [1, 1, 1], "only RR-C1 is in scope");
  assert.equal(reviewNotes(people["RR-C1"].id).length, 1);
  assert.equal(reviewNotes(people["RR-O1"].id).length, 0, "out of scope: not reminded");
  const byDept = await remindChecked(scoped, { stage: "self", by: "dept", cycleId: Q, ids: [qDepts["RR Other"]] });
  assert.equal(byDept.status, 200, JSON.stringify(byDept.data));
  assert.deepEqual(codes(byDept), ["cooldown"], "narrowed to RR-C1, who was just reminded");
  assert.equal(byDept.data.results[0].pending, 1, "RR-O1 is not counted");
  const hod = await remindChecked(scoped, { stage: "hod", by: "dept", cycleId: Q, ids: [qDepts["RR Other"]] });
  assert.equal(hod.status, 404, JSON.stringify(hod.data));
  assert.equal(hod.data.code, "out_of_scope");
});

test("hod: an unsubmitted quarter department is reminded even with ratings missing (G5, no more hod_not_ready); no HoD → no_hod; submitted → unchanged", async () => {
  const notReady = await remindChecked(admin, { stage: "hod", by: "dept", cycleId: Q, ids: [qDepts["RR Dept"], qDepts.__none] });
  assert.deepEqual(codes(notReady), ["ok", "no_hod"], "the HoD can rate on the managers' behalf, so they are reminded now");
  assert.equal(reviewNotes(people["RR-HOD"].id).pop().link, `/review?view=hod&cycle=${encodeURIComponent(Q)}&unit=${encodeURIComponent(qDepts["RR Dept"])}`, "2.5: the reminder opens the HoD's department calibration");
  for (const e of ["RR-O1", "RR-C1"]) { await submitSelf(e); await rate("RR-HOD2", e); await confirmOne(e); }
  const ok = await remindChecked(admin, { stage: "hod", by: "dept", cycleId: Q, ids: [qDepts["RR Other"]] });
  assert.deepEqual(codes(ok), ["ok"]);
  assert.equal(ok.data.reminded, 1);
  const note = reviewNotes(people["RR-HOD2"].id).pop();
  assert.equal(note.title, "Reminder: please submit the calibration of RR Other for RR 2026Q4 by 2026-12-30");
  assert.deepEqual(auditRows("review.remind").pop().after, { stage: "hod", userId: people["RR-HOD2"].id, items: 2, cycle: "RR 2026Q4", dept1: "RR Other" });
  const sub = await people["RR-HOD2"].client.post("/api/me/reviews/hod/submit", { cycleId: Q, dept1Id: qDepts["RR Other"] });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const done = await remindChecked(admin, { stage: "hod", by: "dept", cycleId: Q, ids: [qDepts["RR Other"]] });
  assert.deepEqual(codes(done), ["unchanged"], "already submitted = nobody pending");
  // 年度周期：HoD 阶段用年度文案（按周期选）
  const annual = await remindChecked(admin, { stage: "hod", by: "cycle", ids: [A] });
  assert.equal(annual.data.reminded, 1, JSON.stringify(annual.data));
  assert.equal(reviewNotes(people["RR-HOD"].id).pop().title, "Reminder: please propose annual ratings for RR 2026 Annual by 2026-12-31");
});

test("not applicable: annual + self, legacy + hod, legacy + one_on_one → stage_not_applicable; a closed cycle → cycle_closed", async () => {
  const a = await remindChecked(admin, { stage: "self", by: "cycle", ids: [A, V1] });
  assert.deepEqual(codes(a)[0], "stage_not_applicable");
  const v = await remindChecked(admin, { stage: "hod", by: "cycle", ids: [V1] });
  assert.deepEqual(codes(v), ["stage_not_applicable"]);
  const o = await remindChecked(admin, { stage: "one_on_one", by: "cycle", ids: [V1] });
  assert.deepEqual(codes(o), ["stage_not_applicable"]);
  const close = await admin.post(`/api/admin/review-cycles/${V1}/close`, {});
  assert.equal(close.status, 200, JSON.stringify(close.data));
  const closed = await remindChecked(admin, { stage: "self", by: "cycle", ids: [V1, "rc-ghost"] });
  assert.deepEqual(codes(closed), ["cycle_closed", "not_found"]);
  const fixed = await remindChecked(admin, { stage: "self", by: "item", cycleId: V1, ids: ["x"] });
  assert.equal(fixed.status, 400);
  assert.equal(fixed.data.code, "cycle_closed");
});
