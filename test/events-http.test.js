// 领域事件：每一个发布点的 HTTP 测试（真实服务 + 临时库，直接读临时库的 event_outbox 断言）。
//
// 覆盖的写入路径（server.js 里改员工部门/上级/在职状态、建号、改部门树的全部接口）：
//   POST /api/admin/employees、POST /api/admin/employees/bulk           → employee.hired
//   PUT  /api/admin/employees/:id                                       → transferred / manager_changed / terminated / reactivated
//   POST /api/admin/employees/bulk-update                               → 同上（批量）
//   POST /api/admin/employees/:id/records、PUT /api/admin/records/:rid  → 调动（syncDept）、离职（syncStatus）副作用
//   POST /api/admin/records/bulk                                        → 不产生事件（历史导入从不改主数据）
//   PUT / DELETE /api/admin/departments/:id、POST /api/admin/departments（新建 / 认领孤儿 / 旧版 rename / delete）
//                                                                        → department.renamed / moved / deactivated
// Lark 首次登录自动建号走的是同一个 store.createUser，由 test/events-store.test.js 以同一参数形状覆盖；
// 它的 actorId（浏览器里残留别人的会话时仍为 null）由 test/lark-jit-actor.test.js 走真实回调验证。
// 回滚：LMS_TEST_FAIL_BULK_AT 让批量接口在第 3 行抛异常，断言发件箱一行不留、数据不变；单条记录接口的
// 副作用与记录同一事务，用库里的触发器让记录写失败来验。记录 PUT 只在同步内容变了时重跑副作用。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { startServer, loginAs, ADMIN, DEMO_ADMIN } = require("./helpers.js");

const CORE_EVENTS = new Set([
  "employee.hired", "employee.transferred", "employee.manager_changed", "employee.terminated", "employee.reactivated",
  "department.renamed", "department.moved", "department.deactivated",
]);
const FORBIDDEN_KEY = /pass(word|wd)?(hash)?$|secret|token|session|cookie|credential|e[-_]?mail|phone|mobile|address|salt/i;
// 登记 culture（2026-09-26）之后，这 6 个 core 事件有了订阅方（modules/culture/hooks.js）：写入时不再记为已分发，
// 而是最外层提交后经总线分发、再把结果写回（dispatchedAt = 回写时刻、attempts 1）。本套服务没写配置，culture 按
// defaultOn:false 关闭 —— 分发照常进行、它的处理函数不运行，仍按成功回写。employee.hired / manager_changed 仍没有
// 订阅方，写入即已分发（dispatchedAt = occurredAt、attempts 0）。下面有一条测试核对这份清单与注册表一致。
// Unfolding Lab 版（2026-10-12）：culture 模块已删除，core 事件目前没有任何订阅方 —— 全部写入即已分发（attempts 0）。
const SUBSCRIBED = new Set([]);

let srv, admin;
const D = {};   // department ids by name

function q(dbPath, sql, ...args) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
const mark = (s = srv) => q(s.dbPath, "SELECT COALESCE(MAX(rowid), 0) AS n FROM event_outbox")[0].n;
const since = (m, s = srv) => q(s.dbPath, "SELECT rowid, * FROM event_outbox WHERE rowid > ? ORDER BY rowid", m).map((r) => ({ ...r, data: JSON.parse(r.data) }));
const uid = (employeeId, s = srv) => q(s.dbPath, "SELECT id FROM users WHERE lower(employeeId) = lower(?)", employeeId)[0].id;
const userRow = (id, s = srv) => q(s.dbPath, "SELECT * FROM users WHERE id = ?", id)[0];
const types = (evs) => evs.map((e) => e.type);

function assertNoForbiddenKeys(v, where) {
  if (Array.isArray(v)) return v.forEach((x, i) => assertNoForbiddenKeys(x, `${where}[${i}]`));
  if (v && typeof v === "object") for (const k of Object.keys(v)) {
    assert.ok(!FORBIDDEN_KEY.test(k), `${where}.${k} must not be in event data`);
    assertNoForbiddenKeys(v[k], `${where}.${k}`);
  }
}
// Every published row: envelope columns; a type nobody subscribes to is written already settled
// (dispatchedAt = occurredAt, attempts 0 — see store.setEventSink needsDispatch); a subscribed type is
// dispatched after the commit and written back (dispatchedAt set, attempts 1, no error); data hygiene.
function assertSettled(e) {
  if (SUBSCRIBED.has(e.type)) {
    assert.ok(e.dispatchedAt && e.dispatchedAt.endsWith("Z") && Date.parse(e.dispatchedAt) >= Date.parse(e.occurredAt), `${e.type} dispatched after the commit and written back (${e.dispatchedAt})`);
    assert.equal(e.attempts, 1, `${e.type} dispatched exactly once`);
  } else {
    assert.equal(e.dispatchedAt, e.occurredAt, `${e.type} settled at write time (no subscribers)`);
    assert.equal(e.attempts, 0);
  }
  assert.equal(e.lastError, null);
}
function assertRow(e, { actorId = "u-admin" } = {}) {
  assert.ok(CORE_EVENTS.has(e.type), e.type);
  assert.match(e.id, /^ev-[0-9a-f-]{36}$/);
  assert.ok(e.occurredAt.endsWith("Z") && !Number.isNaN(Date.parse(e.occurredAt)));
  assert.equal(e.actorId, actorId, `${e.type} actorId`);
  assert.equal(e.version, 1);
  assertSettled(e);
  assertNoForbiddenKeys(e.data, e.type);
}
const ref = (department, levels) => ({ department, deptId: levels.deptId, level1: levels.level1, level1Id: levels.level1Id, level2: levels.level2, level2Id: levels.level2Id, isDirect: levels.isDirect,
  level3: levels.level3 || null, level3Id: levels.level3Id || null, isDirect2: !!levels.isDirect2 });
const REF = () => ({
  night: ref("Ops East Night", { deptId: D["Ops East Night"], level1: "Ops", level1Id: D.Ops, level2: "Ops East", level2Id: D["Ops East"], isDirect: false, level3: "Ops East Night", level3Id: D["Ops East Night"] }),
  east: ref("Ops East", { deptId: D["Ops East"], level1: "Ops", level1Id: D.Ops, level2: "Ops East", level2Id: D["Ops East"], isDirect: false, isDirect2: true }),
  ops: ref("Ops", { deptId: D.Ops, level1: "Ops", level1Id: D.Ops, level2: null, level2Id: null, isDirect: true }),
  sales: ref("Sales", { deptId: D.Sales, level1: "Sales", level1Id: D.Sales, level2: null, level2Id: null, isDirect: true }),
  none: ref(null, { deptId: null, level1: null, level1Id: null, level2: null, level2Id: null, isDirect: false }),
});

async function mkDept(name, parentId) {
  const r = await admin.post("/api/admin/departments", parentId ? { name, parentId } : { name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  D[name] = r.data.department.id;
  return D[name];
}
async function mkEmployee(employeeId, extra = {}) {
  const r = await admin.post("/api/admin/employees", { name: "Person " + employeeId, employeeId, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return uid(employeeId);
}
async function put(id, body, c = admin) {
  const r = await c.put("/api/admin/employees/" + id, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  await mkDept("Ops");
  await mkDept("Ops East", D.Ops);
  await mkDept("Ops East Night", D["Ops East"]);
  await mkDept("Sales");
});
after(() => srv && srv.stop());

test("events http: creating departments publishes nothing (department.created is not in the first batch)", () => {
  assert.equal(mark(), 0);
});

test("events http: POST /api/admin/employees → one employee.hired with org levels, the actor, and no password / email / phone", async () => {
  const mgr = await mkEmployee("EV-MGR", { department: "Ops" });
  const m = mark();
  const r = await admin.post("/api/admin/employees", {
    name: "Evie Hire", employeeId: "EV-001", department: "Ops East Night", managerId: mgr,
    email: "evie.hire@example.com", phone: "0917-555-0101", position: "Agent", hireDate: "2026-09-01",
  });
  assert.equal(r.status, 200);
  const evs = since(m);
  assert.deepEqual(types(evs), ["employee.hired"]);
  const [e] = evs;
  assertRow(e);
  assert.equal(e.subjectUserId, uid("EV-001"));
  assert.equal(e.subjectDeptId, null);
  assert.deepEqual(e.data, { employeeId: "EV-001", role: "employee", empStatus: "probation", hireDate: "2026-09-01", managerId: mgr, org: REF().night });
  const raw = JSON.stringify(e);
  for (const s of ["evie.hire@example.com", "0917-555-0101", r.data.password, "Evie Hire"]) assert.ok(!raw.includes(s), `event must not carry ${s}`);
});

test("events http: POST /api/admin/employees/bulk → one hired per created row, none for skipped rows", async () => {
  const m = mark();
  const r = await admin.post("/api/admin/employees/bulk", { rows: [
    { employeeId: "EV-B1", name: "Bulk One", department: "Sales" },
    { employeeId: "EV-001", name: "Duplicate" },                        // already exists → skipped
    { employeeId: "EV-B2", name: "Bulk Two", department: "Ops East", managerEmployeeId: "EV-B1" },
    { employeeId: "x", name: "Bad id" },                                // invalid → skipped
    { employeeId: "EV-B3", name: "Bulk Three", department: "Ops East Night" },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x) => x.status), ["created", "skipped", "created", "skipped", "created"]);
  const evs = since(m);
  assert.deepEqual(types(evs), ["employee.hired", "employee.hired", "employee.hired"]);
  evs.forEach((e) => assertRow(e));
  assert.deepEqual(evs.map((e) => e.data.employeeId), ["EV-B1", "EV-B2", "EV-B3"]);
  assert.deepEqual(evs.map((e) => e.subjectUserId), ["EV-B1", "EV-B2", "EV-B3"].map((x) => uid(x)));
  assert.deepEqual(evs[0].data.org, REF().sales);
  assert.equal(evs[1].data.managerId, uid("EV-B1"));
  assert.deepEqual(evs[1].data.org, REF().east);
});

test("events http: PUT /api/admin/employees/:id → transferred (with from/to level 1 and 2), manager_changed; nothing for case-only or unrelated edits", async () => {
  const id = uid("EV-001");
  const mgr = uid("EV-MGR");
  let m = mark();
  await put(id, { department: "Sales" });
  let evs = since(m);
  assert.deepEqual(types(evs), ["employee.transferred"]);
  assertRow(evs[0]);
  assert.equal(evs[0].subjectUserId, id);
  assert.deepEqual(evs[0].data, { employeeId: "EV-001", from: REF().night, to: REF().sales });

  m = mark();
  await put(id, { department: "sales" });                          // same department, different case
  await put(id, { position: "Team Lead", jobLevel: "P3", hireDate: "2026-08-01", name: "Evie H." });
  assert.deepEqual(since(m), [], "case-only department change and non-org fields publish nothing");
  assert.equal(userRow(id).department, "Sales", "the department table's spelling is stored, not the typed one (canonicalDept)");

  m = mark();
  await put(id, { managerId: uid("EV-B1") });
  await put(id, { managerId: "" });
  evs = since(m);
  assert.deepEqual(types(evs), ["employee.manager_changed", "employee.manager_changed"]);
  evs.forEach((e) => assertRow(e));
  assert.deepEqual(evs.map((e) => [e.data.from, e.data.to]), [[mgr, uid("EV-B1")], [uid("EV-B1"), null]]);

  m = mark();
  await put(id, { department: "Ops East", managerId: mgr });        // both in one PUT → two events, fixed order
  evs = since(m);
  assert.deepEqual(types(evs), ["employee.transferred", "employee.manager_changed"]);
  assert.deepEqual(evs[0].data.from, REF().sales, "the case variant was stored in the canonical spelling");
  assert.deepEqual(evs[0].data.to, REF().east);
});

test("events http: PUT /api/admin/employees/:id → terminated (deactivated / exited) and reactivated", async () => {
  const id = uid("EV-B3");
  const seq = [
    [{ active: false }, ["employee.terminated"], (e) => { assert.equal(e.data.reason, "deactivated"); assert.deepEqual(e.data.active, { from: true, to: false }); }],
    [{ active: true }, ["employee.reactivated"], (e) => assert.deepEqual(e.data.active, { from: false, to: true })],
    [{ empStatus: "exited" }, ["employee.terminated"], (e) => { assert.equal(e.data.reason, "exited"); assert.deepEqual(e.data.empStatus, { from: "probation", to: "exited" }); assert.deepEqual(e.data.active, { from: true, to: true }); }],
    [{ empStatus: "regular" }, ["employee.reactivated"], (e) => assert.deepEqual(e.data.empStatus, { from: "exited", to: "regular" })],
    [{ empStatus: "exited", active: false }, ["employee.terminated"], (e) => { assert.equal(e.data.reason, "exited", "both at once → one event, reason exited"); assert.deepEqual(e.data.active, { from: true, to: false }); }],
    [{ active: true }, [], null],                                    // account back on but still exited → not in service
    [{ empStatus: "regular" }, ["employee.reactivated"], null],
    [{ empStatus: "probation" }, [], null],                          // regular → probation is not a lifecycle event
  ];
  for (const [body, want, check] of seq) {
    const m = mark();
    await put(id, body);
    const evs = since(m);
    assert.deepEqual(types(evs), want, JSON.stringify(body));
    evs.forEach((e) => { assertRow(e); assert.equal(e.subjectUserId, id); assert.deepEqual(e.data.org, REF().night); });
    if (check) check(evs[0]);
  }
});

test("events http: POST /api/admin/employees/bulk-update → one event per person per changed field; a new department name is registered like single PUT", async () => {
  const ids = ["EV-B1", "EV-B2", "EV-B3"].map((x) => uid(x));
  const mgr = uid("EV-MGR");
  let m = mark();
  let r = await admin.post("/api/admin/employees/bulk-update", { userIds: ids, fields: { department: "Ops", managerId: mgr } });
  assert.equal(r.status, 200);
  let evs = since(m);
  evs.forEach((e) => assertRow(e));
  const transferred = evs.filter((e) => e.type === "employee.transferred");
  const managers = evs.filter((e) => e.type === "employee.manager_changed");
  assert.deepEqual(transferred.map((e) => e.subjectUserId), ids);
  for (const e of transferred) assert.deepEqual(e.data.to, REF().ops);
  assert.deepEqual(managers.map((e) => e.subjectUserId), ids, "each of the three had a different (or no) manager before");
  assert.equal(evs.length, 6);

  m = mark();
  r = await admin.post("/api/admin/employees/bulk-update", { userIds: ids, fields: { department: "Ops", managerId: mgr } });
  assert.equal(r.status, 200);
  assert.deepEqual(since(m), [], "re-applying the same values publishes nothing");

  m = mark();
  r = await admin.post("/api/admin/employees/bulk-update", { userIds: ids.slice(0, 2), fields: { active: false } });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectUserId, e.data.reason]), ids.slice(0, 2).map((x) => ["employee.terminated", x, "deactivated"]));

  // 新部门名：与单人 PUT 一样登记进部门表（成为一级部门），事件里解析得出 id 与一级/二级 ——
  // 以前 bulk-update 不登记，事件的 to 全空、HoD 名单把这些人算作未归属。
  m = mark();
  r = await admin.post("/api/admin/employees/bulk-update", { userIds: [ids[2]], fields: { department: "Ghost Team" } });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(types(evs), ["employee.transferred"]);
  const ghost = q(srv.dbPath, "SELECT id, parentId FROM departments WHERE name = 'Ghost Team'");
  assert.equal(ghost.length, 1, "the department was registered");
  assert.equal(ghost[0].parentId, null, "as a level-1 department");
  assert.deepEqual(evs[0].data.to, ref("Ghost Team", { deptId: ghost[0].id, level1: "Ghost Team", level1Id: ghost[0].id, level2: null, level2Id: null, isDirect: true }));
  // 大小写变体存部门表里的写法。
  r = await admin.post("/api/admin/employees/bulk-update", { userIds: [ids[2]], fields: { department: "GHOST TEAM" } });
  assert.equal(r.status, 200);
  assert.equal(userRow(ids[2]).department, "Ghost Team");
  assert.equal(q(srv.dbPath, "SELECT COUNT(*) AS n FROM departments WHERE lower(name) = 'ghost team'")[0].n, 1, "no duplicate department");
});

test("events http: records — transfer + syncDept and exit + syncStatus publish (POST and PUT); plain records, regularization and records/bulk do not", async () => {
  const id = await mkEmployee("EV-R1", { department: "Ops East Night" });
  let m = mark();
  let r = await admin.post(`/api/admin/employees/${id}/records`, { type: "transfer", date: "2026-09-10", fields: { fromDept: "Ops East Night", toDept: "Sales", syncDept: true } });
  assert.equal(r.status, 200);
  let evs = since(m);
  assert.deepEqual(types(evs), ["employee.transferred"]);
  assertRow(evs[0]);
  assert.deepEqual(evs[0].data, { employeeId: "EV-R1", from: REF().night, to: REF().sales });

  m = mark();
  r = await admin.post(`/api/admin/employees/${id}/records`, { type: "transfer", date: "2026-09-11", fields: { toDept: "Ops", reason: "history only" } });
  assert.equal(r.status, 200);
  r = await admin.post(`/api/admin/employees/${id}/records`, { type: "regularization", date: "2026-09-12", fields: { result: "On time", syncStatus: true } });
  assert.equal(r.status, 200);
  assert.equal(userRow(id).empStatus, "regular");
  assert.deepEqual(since(m), [], "a transfer without syncDept and probation → regular publish nothing");

  // PUT on an existing record re-applies the side effect
  const recId = (await admin.post(`/api/admin/employees/${id}/records`, { type: "transfer", date: "2026-09-13", fields: { toDept: "Sales" } })).data.record.id;
  m = mark();
  r = await admin.put("/api/admin/records/" + recId, { type: "transfer", date: "2026-09-13", fields: { toDept: "Ops East", syncDept: true } });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(types(evs), ["employee.transferred"]);
  assert.deepEqual([evs[0].data.from, evs[0].data.to], [REF().sales, REF().east]);

  m = mark();
  r = await admin.post(`/api/admin/employees/${id}/records`, { type: "exit", date: "2026-09-20", fields: { exitType: "Voluntary", syncStatus: true } });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(types(evs), ["employee.terminated"]);
  assertRow(evs[0]);
  assert.equal(evs[0].data.reason, "exited");
  assert.deepEqual(evs[0].data.empStatus, { from: "regular", to: "exited" });
  assert.deepEqual(evs[0].data.active, { from: true, to: false });

  // records/bulk is a historical import: it never touches master data, so no events even with syncDept
  const id2 = await mkEmployee("EV-R2", { department: "Ops" });
  m = mark();
  r = await admin.post("/api/admin/records/bulk", { rows: [
    { employeeId: "EV-R2", type: "transfer", date: "2026-01-05", fields: { toDept: "Sales", syncDept: true } },
    { employeeId: "EV-R2", type: "exit", date: "2026-02-05", fields: { exitType: "Voluntary", syncStatus: true } },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results.map((x) => x.status), ["created", "created"]);
  assert.deepEqual(since(m), []);
  assert.equal(userRow(id2).department, "Ops");
  assert.equal(userRow(id2).active, 1);
});

test("events http: records PUT — editing only the date / title / note of a synced transfer or exit record re-applies nothing and publishes nothing; changing what it syncs does", async () => {
  const id = await mkEmployee("EV-P1", { department: "Ops" });
  // 1) 调动记录：同步把人调到 Sales；HR 之后又把他调回 Ops。
  let r = await admin.post(`/api/admin/employees/${id}/records`, { type: "transfer", date: "2026-09-01", title: "Move to Sales", fields: { fromDept: "Ops", toDept: "Sales", syncDept: true } });
  assert.equal(r.status, 200);
  const rec = r.data.record;
  assert.equal(rec.detail.synced, true);
  await put(id, { department: "Ops" });
  // 修旧记录的错字：界面回传整张表单（含 syncDept 与原 toDept，见 People.jsx RecordModal）。
  let m = mark();
  r = await admin.put("/api/admin/records/" + rec.id, { type: "transfer", date: "2026-09-02", title: "Move to Sales (typo fixed)", fields: { ...rec.detail, note: "fixed a typo" } });
  assert.equal(r.status, 200);
  assert.deepEqual(since(m), [], "no employee.transferred for a typo fix");
  assert.equal(userRow(id).department, "Ops", "the person is NOT moved back to the record's toDept");
  assert.equal(r.data.record.detail.synced, true, "the synced marker is carried over");
  assert.equal(r.data.record.title, "Move to Sales (typo fixed)");
  // 换了调入部门 → 同步的内容变了，照常重跑。
  m = mark();
  r = await admin.put("/api/admin/records/" + rec.id, { type: "transfer", date: "2026-09-02", fields: { ...rec.detail, toDept: "Ops East" } });
  assert.equal(r.status, 200);
  let evs = since(m);
  assert.deepEqual(types(evs), ["employee.transferred"]);
  assert.deepEqual([evs[0].data.from, evs[0].data.to], [REF().ops, REF().east]);
  // 只改大小写不算换部门。
  m = mark();
  r = await admin.put("/api/admin/records/" + rec.id, { type: "transfer", date: "2026-09-02", fields: { ...rec.detail, toDept: "OPS EAST" } });
  assert.equal(r.status, 200);
  assert.deepEqual(since(m), []);

  // 2) 离职记录：同步离职；HR 之后让他复职；再改离职记录的备注。
  r = await admin.post(`/api/admin/employees/${id}/records`, { type: "exit", date: "2026-09-10", fields: { exitType: "Voluntary", syncStatus: true } });
  assert.equal(r.status, 200);
  const exitRec = r.data.record;
  await put(id, { active: true, empStatus: "regular" });
  const revokedAudits = () => q(srv.dbPath, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.sessions_revoked' AND target = 'EV-P1'")[0].n;
  const revokedBefore = revokedAudits();
  m = mark();
  r = await admin.put("/api/admin/records/" + exitRec.id, { type: "exit", date: "2026-09-10", fields: { ...exitRec.detail, note: "exit interview done" } });
  assert.equal(r.status, 200);
  assert.deepEqual(since(m), [], "no employee.terminated for a note edit");
  assert.equal(userRow(id).active, 1, "the reinstated person is NOT offboarded again");
  assert.equal(userRow(id).empStatus, "regular");
  assert.equal(revokedAudits(), revokedBefore, "no sessions revoked");

  // 3) 历史导入（records/bulk，从未同步过）：编辑它的非同步字段不会补做同步。
  const id2 = await mkEmployee("EV-P2", { department: "Ops" });
  r = await admin.post("/api/admin/records/bulk", { rows: [{ employeeId: "EV-P2", type: "transfer", date: "2025-01-05", fields: { toDept: "Sales", syncDept: true } }] });
  assert.equal(r.status, 200);
  const hist = q(srv.dbPath, "SELECT id, detail FROM talent_records WHERE userId = ?", id2)[0];
  m = mark();
  r = await admin.put("/api/admin/records/" + hist.id, { type: "transfer", date: "2025-01-06", fields: { ...JSON.parse(hist.detail), reason: "reorg" } });
  assert.equal(r.status, 200);
  assert.deepEqual(since(m), []);
  assert.equal(userRow(id2).department, "Ops");
});

test("events http: records POST / PUT — the master-data side effect and the record commit together; a failed record write leaves no transfer, no exit and no outbox row", async () => {
  const exec = (sql) => { const db = new DatabaseSync(srv.dbPath); try { db.exec(sql); } finally { db.close(); } };
  const id = await mkEmployee("EV-T1", { department: "Ops" });
  const existing = (await admin.post(`/api/admin/employees/${id}/records`, { type: "transfer", date: "2026-09-01", fields: { toDept: "Sales" } })).data.record;
  const records = () => q(srv.dbPath, "SELECT COUNT(*) AS n FROM talent_records WHERE userId = ?", id)[0].n;
  // 记录表的写入失败（等价于脚本持写锁时的 SQLITE_BUSY 之类）：用触发器让它在库里失败。
  exec("CREATE TRIGGER evt_fail_ins BEFORE INSERT ON talent_records BEGIN SELECT RAISE(ABORT, 'injected record failure'); END;"
    + "CREATE TRIGGER evt_fail_upd BEFORE UPDATE ON talent_records BEGIN SELECT RAISE(ABORT, 'injected record failure'); END;");
  try {
    const n0 = records();
    const cases = [
      ["POST transfer", () => admin.post(`/api/admin/employees/${id}/records`, { type: "transfer", date: "2026-09-10", fields: { toDept: "Sales", syncDept: true } })],
      ["POST exit", () => admin.post(`/api/admin/employees/${id}/records`, { type: "exit", date: "2026-09-11", fields: { exitType: "Voluntary", syncStatus: true } })],
      ["PUT transfer (syncDept newly ticked)", () => admin.put("/api/admin/records/" + existing.id, { type: "transfer", date: "2026-09-01", fields: { toDept: "Sales", syncDept: true } })],
    ];
    for (const [label, call] of cases) {
      const m = mark();
      const r = await call();
      assert.equal(r.status, 500, label);
      assert.equal(r.data.code, "record_save_failed", label);
      assert.match(r.data.error, /nothing was changed/);
      assert.match(r.data.error, /未做任何修改/);
      assert.ok(!/injected|SQLITE|trigger/i.test(JSON.stringify(r.data)), label + ": no raw error text in the response");
      assert.deepEqual(since(m), [], label + ": no outbox row");
      const u = userRow(id);
      assert.deepEqual([u.department, u.active, u.empStatus], ["Ops", 1, "probation"], label + ": master data untouched");
      assert.equal(records(), n0, label + ": no record row");
    }
  } finally {
    exec("DROP TRIGGER IF EXISTS evt_fail_ins; DROP TRIGGER IF EXISTS evt_fail_upd;");
  }
  // 触发器去掉之后同一请求照常成功，事件照常发布。
  const m = mark();
  const ok = await admin.post(`/api/admin/employees/${id}/records`, { type: "transfer", date: "2026-09-10", fields: { toDept: "Sales", syncDept: true } });
  assert.equal(ok.status, 200);
  assert.deepEqual(types(since(m)), ["employee.transferred"]);
  assert.equal(userRow(id).department, "Sales");
});

test("events http: departments — PUT rename / move / deactivate, owner change silent, DELETE with a child, legacy rename (registered and free-text) and delete, adopt", async () => {
  const hq = await mkDept("Evt HQ");
  const unit = await mkDept("Evt Unit", hq);
  const cell = await mkDept("Evt Cell", unit);
  const member = await mkEmployee("EV-D1", { department: "Evt Cell" });

  let m = mark();
  let r = await admin.put("/api/admin/departments/" + cell, { name: "Evt Cell Renamed" });
  assert.equal(r.status, 200);
  let evs = since(m);
  assert.deepEqual(types(evs), ["department.renamed"], "members' department text cascades without per-person transfers");
  assertRow(evs[0]);
  assert.equal(evs[0].subjectDeptId, cell);
  assert.equal(evs[0].subjectUserId, null);
  assert.deepEqual(evs[0].data, { from: "Evt Cell", to: "Evt Cell Renamed", registered: true, members: 1 });
  assert.equal(userRow(member).department, "Evt Cell Renamed");

  m = mark();
  r = await admin.put("/api/admin/departments/" + unit, { parentId: D.Sales });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(types(evs), ["department.moved"]);
  assertRow(evs[0]);
  assert.deepEqual(evs[0].data, {
    name: "Evt Unit", reason: "updated",
    from: { parentId: hq, parentName: "Evt HQ", level: 2, level1: "Evt HQ", level1Id: hq },
    to: { parentId: D.Sales, parentName: "Sales", level: 2, level1: "Sales", level1Id: D.Sales },
  });

  m = mark();
  r = await admin.put("/api/admin/departments/" + unit, { ownerId: member, sort: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(since(m), [], "owner / sort changes publish nothing");

  m = mark();
  r = await admin.put("/api/admin/departments/" + hq, { active: false });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(types(evs), ["department.deactivated"]);
  assertRow(evs[0]);
  assert.deepEqual(evs[0].data, { name: "Evt HQ", deleted: false, parentId: null, parentName: null, level: 1, level1: "Evt HQ", level1Id: hq });

  // DELETE a department that has a child department (and no people): deactivated(deleted) + the child becomes level 1
  const parent = await mkDept("Evt Parent");
  const child = await mkDept("Evt Child", parent);
  m = mark();
  r = await admin.del("/api/admin/departments/" + parent);
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectDeptId]), [["department.deactivated", parent], ["department.moved", child]]);
  evs.forEach((e) => assertRow(e));
  assert.deepEqual(evs[0].data, { name: "Evt Parent", deleted: true, wasActive: true, parentId: null, parentName: null, level: 1, level1: "Evt Parent", level1Id: parent });
  assert.deepEqual(evs[1].data, {
    name: "Evt Child", reason: "parent_deleted",
    from: { parentId: parent, parentName: "Evt Parent", level: 2, level1: "Evt Parent", level1Id: parent },
    to: { parentId: null, parentName: null, level: 1, level1: "Evt Child", level1Id: child },
  });

  // legacy POST {action:"rename"} on a registered department
  m = mark();
  r = await admin.post("/api/admin/departments", { action: "rename", name: "Evt Child", newName: "Evt Child 2" });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectDeptId, e.data.registered]), [["department.renamed", child, true]]);

  // legacy rename of a free-text department that is not in the departments table. Every API path
  // now registers the department it writes (bulk-update included), so the free-text name can only
  // come from a direct database write / legacy data — made here the same way.
  const loose = await mkEmployee("EV-D2");
  { const db = new DatabaseSync(srv.dbPath); try { db.prepare("UPDATE users SET department = 'Free Text Team' WHERE id = ?").run(loose); } finally { db.close(); } }
  m = mark();
  r = await admin.post("/api/admin/departments", { action: "rename", name: "free text team", newName: "Phantom Team" });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(types(evs), ["department.renamed"]);
  assertRow(evs[0]);
  assert.equal(evs[0].subjectDeptId, null);
  assert.deepEqual(evs[0].data, { from: "free text team", to: "Phantom Team", registered: false, members: 1 }, "case-insensitive match, like every other department lookup");
  assert.equal(userRow(loose).department, "Phantom Team");

  // legacy POST {action:"delete"} on an empty registered department
  const empty = await mkDept("Evt Empty");
  m = mark();
  r = await admin.post("/api/admin/departments", { action: "delete", name: "Evt Empty" });
  assert.equal(r.status, 200);
  evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectDeptId, e.data.deleted]), [["department.deactivated", empty, true]]);

  // adopting an orphan: POST {name, parentId} for an existing root department
  const orphan = await mkDept("Evt Orphan");
  m = mark();
  r = await admin.post("/api/admin/departments", { name: "Evt Orphan", parentId: D.Ops });
  assert.equal(r.status, 200);
  assert.equal(r.data.adopted, true);
  evs = since(m);
  assert.deepEqual(types(evs), ["department.moved"]);
  assert.equal(evs[0].subjectDeptId, orphan);
  assert.equal(evs[0].data.reason, "adopted");
  assert.deepEqual(evs[0].data.to, { parentId: D.Ops, parentName: "Ops", level: 2, level1: "Ops", level1Id: D.Ops });
});

test("events http: actorId follows each requester even when two admins' requests interleave across awaits", async () => {
  const demo = await loginAs(srv.base, DEMO_ADMIN);
  const targets = ["EV-MGR", "EV-001", "EV-R2"].map((x) => uid(x));
  const rows = Array.from({ length: 24 }, (_, i) => ({ employeeId: "EV-C" + String(i + 1).padStart(2, "0"), name: "Concurrent " + (i + 1), department: "Sales" }));
  const m = mark();
  const [bulk, ...puts] = await Promise.all([
    admin.post("/api/admin/employees/bulk", { rows }),     // awaits password hashing before its transaction
    ...targets.map((id, i) => demo.put("/api/admin/employees/" + id, { department: i % 2 ? "Ops East Night" : "Ops East" })),
  ]);
  assert.equal(bulk.status, 200);
  for (const p of puts) assert.equal(p.status, 200);
  const evs = since(m);
  const hired = evs.filter((e) => e.type === "employee.hired");
  const transferred = evs.filter((e) => e.type === "employee.transferred");
  assert.equal(hired.length, 24);
  assert.equal(transferred.length, 3);
  for (const e of hired) assertRow(e, { actorId: "u-admin" });
  for (const e of transferred) assertRow(e, { actorId: "u-demo-admin" });
});

test("events http: no installed module subscribes to the core events (culture removed in the Unfolding Lab edition)", () => {
  const reg = require("../kernel/registry.js").load();
  const subscribed = new Set(reg.events.subscriptions.filter((s) => CORE_EVENTS.has(s.type)).map((s) => s.type));
  assert.deepEqual(subscribed, SUBSCRIBED);
});

test("events http: every row in the outbox is a core event, settled (written settled when nobody subscribes; dispatched and written back when culture does — even switched off), with clean data", () => {
  const all = since(0);
  assert.ok(all.length > 50, `outbox has ${all.length} rows`);
  for (const e of all) {
    assert.ok(CORE_EVENTS.has(e.type), e.type);
    assert.equal(e.version, 1);
    assertSettled(e);
    assertNoForbiddenKeys(e.data, e.type);
    assert.ok(e.subjectUserId || e.subjectDeptId || e.type === "department.renamed", `${e.type} has a subject`);
  }
  assert.deepEqual(new Set(all.map((e) => e.type)), CORE_EVENTS, "this suite exercised every first-batch event type");
});

test("events http: a batch rolled back by LMS_TEST_FAIL_BULK_AT leaves no outbox rows and no data change; a batch below the fault line publishes", async () => {
  const b = await startServer({ env: { LMS_TEST_FAIL_BULK_AT: "3" } });
  try {
    const a = await loginAs(b.base, ADMIN);
    for (const name of ["Roll A", "Roll B"]) assert.equal((await a.post("/api/admin/departments", { name })).status, 200);
    const ids = [];
    for (let i = 1; i <= 4; i++) {
      assert.equal((await a.post("/api/admin/employees", { name: "Roll " + i, employeeId: "RB-" + i, department: "Roll A" })).status, 200);
      ids.push(uid("RB-" + i, b));
    }
    let m = mark(b);
    let r = await a.post("/api/admin/employees/bulk-update", { userIds: ids, fields: { department: "Roll B", managerId: ids[0] } });
    assert.equal(r.status, 500);
    assert.equal(r.data.code, "batch_failed");
    assert.equal(r.data.line, 3);
    assert.deepEqual(since(m, b), [], "rows 1–2 wrote events inside the transaction; the rollback took them away");
    for (const id of ids) assert.equal(userRow(id, b).department, "Roll A");

    r = await a.post("/api/admin/employees/bulk-update", { userIds: ids, fields: { active: false } });
    assert.equal(r.status, 500);
    assert.deepEqual(since(m, b), []);
    for (const id of ids) assert.equal(userRow(id, b).active, 1);

    r = await a.post("/api/admin/employees/bulk", { rows: [1, 2, 3, 4].map((i) => ({ employeeId: "RB-N" + i, name: "New " + i, department: "Roll B" })) });
    assert.equal(r.status, 500);
    assert.equal(r.data.code, "batch_failed");
    assert.deepEqual(since(m, b), []);
    assert.equal(q(b.dbPath, "SELECT COUNT(*) AS n FROM users WHERE employeeId LIKE 'RB-N%'")[0].n, 0);

    // the same endpoint with two people (rows 1–2, below the fault line) commits and publishes
    m = mark(b);
    r = await a.post("/api/admin/employees/bulk-update", { userIds: ids.slice(0, 2), fields: { department: "Roll B" } });
    assert.equal(r.status, 200);
    const evs = since(m, b);
    assert.deepEqual(evs.map((e) => [e.type, e.subjectUserId]), ids.slice(0, 2).map((id) => ["employee.transferred", id]));
    evs.forEach((e) => assertRow(e));
  } finally { b.stop(); }
});
