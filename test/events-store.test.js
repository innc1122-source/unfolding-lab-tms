// store.js 的领域事件捕获与发件箱（进程内直接驱动 store，库在系统临时目录）：
//   · 事件行与数据变更同事务；最外层提交之后才分发；整笔回滚 / 内层 SAVEPOINT 回滚时行与分发都不发生；
//   · 没接分发器（脚本进程）时行留在发件箱里、attempts = 0；
//   · 接上真实总线后的写回：成功 → dispatchedAt，处理函数抛异常 → attempts + lastError，请求不受影响；
//   · 处理函数里再经 store 写库 → 新事件在自己的提交之后、下一轮分发（不递归）；
//   · HTTP 测试够不着的两条路径：Lark 首次登录自动建号（createUser 的同一形状，actor 为空）与
//     clearDepartment（接口在调用前拦下了「部门里还有人」）。
// node --test 每个文件一个进程，所以这里可以在 require store.js 之前设好 LMS_DB_PATH 等变量。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lms-events-store-"));
process.env.LMS_DB_PATH = path.join(TMP, "events.db");
process.env.LMS_ATTACH_DIR = path.join(TMP, "attachments");
process.env.LMS_CONFIG_PATH = path.join(TMP, "config.json");   // 不存在 → 默认配置，非生产
const store = require("../store.js");
const events = require("../kernel/events.js");
const { DatabaseSync } = require("node:sqlite");

store.init({ hashPassword: (pw) => "test-hash:" + pw });

const rows = (sql, ...a) => {
  const db = new DatabaseSync(process.env.LMS_DB_PATH, { readOnly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};
const mark = () => rows("SELECT COALESCE(MAX(rowid), 0) AS n FROM event_outbox")[0].n;
const since = (m) => rows("SELECT rowid, * FROM event_outbox WHERE rowid > ? ORDER BY rowid", m).map((r) => ({ ...r, data: JSON.parse(r.data) }));
let seq = 0;
const newUser = (extra = {}) => {
  seq++;
  return store.createUser({ id: "u-ev-" + seq, employeeId: "EVS-" + seq, name: "Event Person " + seq, role: "employee", passwordHash: "h", ...extra });
};

// a recording sink: remembers each call and whether it ran inside a transaction
let sinkCalls = [];
const recordingSink = (evs) => sinkCalls.push({ types: evs.map((e) => e.type), ids: evs.map((e) => e.id), inTx: store.inTransaction() });

test.after(() => { try { store.close(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("store events: the migration created event_outbox with the agreed columns and indexes", () => {
  const cols = rows("PRAGMA table_info(event_outbox)").map((c) => c.name);
  assert.deepEqual(cols, ["id", "type", "occurredAt", "actorId", "subjectUserId", "subjectDeptId", "data", "version", "dispatchedAt", "attempts", "lastError"]);
  const idx = rows("PRAGMA index_list(event_outbox)").map((i) => i.name);
  assert.ok(idx.includes("idx_outbox_type_time") && idx.includes("idx_outbox_subject_user"));
  assert.deepEqual(rows("PRAGMA index_info(idx_outbox_type_time)").map((c) => c.name), ["type", "occurredAt"]);
  assert.deepEqual(rows("PRAGMA index_info(idx_outbox_subject_user)").map((c) => c.name), ["subjectUserId"]);
  assert.equal(rows("SELECT COUNT(*) AS n FROM event_outbox")[0].n, 0, "seeding a fresh database produces no events");
});

test("store events: with no sink (a script process) rows are written but left undispatched (attempts 0)", () => {
  store.setEventSink(null);
  const m = mark();
  const u = newUser({ department: "Scripted Dept" });
  store.updateUser(u.id, { department: "Scripted Dept 2" });
  const evs = since(m);
  assert.deepEqual(evs.map((e) => e.type), ["employee.hired", "employee.transferred"]);
  for (const e of evs) {
    assert.equal(e.dispatchedAt, null);
    assert.equal(e.attempts, 0);
    assert.equal(e.lastError, null);
    assert.equal(e.actorId, null, "no request context → actor null");
  }
});

test("store events: inside a transaction the sink is only called after the outermost COMMIT, once, with every event in order", () => {
  sinkCalls = [];
  store.setEventSink(recordingSink);
  const a = newUser(), b = newUser();
  sinkCalls = [];
  const m = mark();
  store.transaction(() => {
    store.updateUser(a.id, { managerId: b.id });
    store.transaction(() => store.updateUser(b.id, { active: false }));   // nested (SAVEPOINT) commit does not flush
    assert.equal(sinkCalls.length, 0, "nothing dispatched before the outer commit");
    assert.equal(since(m).length, 0, "uncommitted rows are invisible to another connection");
  });
  assert.equal(sinkCalls.length, 1);
  assert.deepEqual(sinkCalls[0].types, ["employee.manager_changed", "employee.terminated"]);
  assert.equal(sinkCalls[0].inTx, false, "dispatch happens outside the transaction");
  assert.deepEqual(since(m).map((e) => e.id), sinkCalls[0].ids, "the dispatched envelopes are exactly the committed rows");
});

test("store events: a rolled-back transaction leaves neither rows nor a dispatch, and the data change is undone", () => {
  store.setEventSink(recordingSink);
  const u = newUser({ department: "Before" });
  sinkCalls = [];
  const m = mark();
  assert.throws(() => store.transaction(() => {
    store.updateUser(u.id, { department: "After", managerId: "u-admin" });
    throw new Error("abort");
  }), /abort/);
  assert.equal(since(m).length, 0);
  assert.equal(sinkCalls.length, 0);
  assert.equal(store.getUserById(u.id).department, "Before");
  assert.equal(store.getUserById(u.id).managerId, null);
});

test("store events: an inner SAVEPOINT rollback discards only the inner events; the outer ones commit and dispatch", () => {
  store.setEventSink(recordingSink);
  const a = newUser(), b = newUser();
  sinkCalls = [];
  const m = mark();
  store.transaction(() => {
    store.updateUser(a.id, { department: "Kept" });
    try {
      store.transaction(() => { store.updateUser(b.id, { department: "Dropped" }); throw new Error("inner"); });
    } catch {}
  });
  const evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectUserId]), [["employee.transferred", a.id]]);
  assert.deepEqual(sinkCalls.map((c) => c.ids), [evs.map((e) => e.id)]);
  assert.equal(store.getUserById(b.id).department, null);
});

test("store events: an autocommit write (no caller transaction) is wrapped with its event in one transaction and dispatched right after", () => {
  store.setEventSink(recordingSink);
  const u = newUser();
  sinkCalls = [];
  const m = mark();
  store.updateUser(u.id, { department: "Solo" });
  assert.equal(sinkCalls.length, 1);
  assert.equal(sinkCalls[0].inTx, false);
  assert.deepEqual(since(m).map((e) => e.type), ["employee.transferred"]);
  // unrelated fields: no transaction wrapper, no event
  sinkCalls = [];
  const m2 = mark();
  store.updateUser(u.id, { position: "Analyst", jobLevel: "P2", talentTags: ["x"] });
  assert.equal(since(m2).length, 0);
  assert.equal(sinkCalls.length, 0);
});

test("store events: Lark first sign-in (createUser with larkUserId, no department, no signed-in actor) → employee.hired with an empty org", () => {
  store.setEventSink(null);
  const m = mark();
  // the same argument shape server.js passes in the /api/auth/lark/callback JIT branch
  const u = store.createUser({ id: "u-lark1", employeeId: "LK-ABC123", name: "Lark User", role: "employee", passwordHash: "h",
    department: null, email: "lark.user@example.com", managerId: null, larkUserId: "on_123", mustChangePassword: 0 });
  const [e] = since(m);
  assert.equal(e.type, "employee.hired");
  assert.equal(e.subjectUserId, u.id);
  assert.equal(e.actorId, null);
  assert.deepEqual(e.data, {
    employeeId: "LK-ABC123", role: "employee", empStatus: "probation", hireDate: null, managerId: null,
    org: { department: null, deptId: null, level1: null, level1Id: null, level2: null, level2Id: null, isDirect: false, level3: null, level3Id: null, isDirect2: false },
  });
  assert.ok(!JSON.stringify(e).includes("lark.user@example.com") && !JSON.stringify(e).includes("on_123"), "no email / Lark identity in the event");
});

test("store events: the actor comes from the request context, across awaits", async () => {
  store.setEventSink(null);
  const m = mark();
  await events.runWithContext({ actorId: "u-admin", requestId: "r-x" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    newUser();
  });
  assert.equal(since(m)[0].actorId, "u-admin");
});

test("store events: clearDepartment emits one employee.transferred per person it empties (to = no department)", () => {
  store.setEventSink(null);
  store.ensureDepartment("Clear Me");
  const a = newUser({ department: "Clear Me" }), b = newUser({ department: "Clear Me" });
  const m = mark();
  assert.equal(store.clearDepartment("Clear Me"), 2);
  const evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectUserId]).sort(), [["employee.transferred", a.id], ["employee.transferred", b.id]].sort());
  for (const e of evs) {
    assert.equal(e.data.from.department, "Clear Me");
    assert.ok(e.data.from.deptId && e.data.from.level1 === "Clear Me" && e.data.from.isDirect === true);
    assert.equal(e.data.to.department, null);
  }
});

test("store events: with a real bus — success sets dispatchedAt, a throwing handler records attempts + lastError, the write itself stands", () => {
  const logs = [];
  const bus = events.createBus({
    subscriptions: [
      { module: "demo", type: "employee.terminated", fn: () => { throw new Error("demo handler exploded"); } },
      { module: "demo", type: "employee.hired", fn: () => {} },
    ],
    log: (l) => logs.push(l),
    record: (results) => store.recordEventDispatch(results),
  });
  store.setEventSink((evs) => bus.publish(evs));
  const m = mark();
  const u = newUser();
  assert.doesNotThrow(() => store.updateUser(u.id, { active: false }));
  assert.equal(store.getUserById(u.id).active, 0, "the committed change is not undone by a failing subscriber");
  const [hired, terminated] = since(m);
  assert.equal(hired.type, "employee.hired");
  assert.ok(hired.dispatchedAt && !Number.isNaN(Date.parse(hired.dispatchedAt)));
  assert.equal(hired.attempts, 1);
  assert.equal(hired.lastError, null);
  assert.equal(terminated.type, "employee.terminated");
  assert.equal(terminated.dispatchedAt, null);
  assert.equal(terminated.attempts, 1);
  assert.equal(terminated.lastError, "demo: Error: demo handler exploded");
  assert.deepEqual(logs, [`[events] handler failed: employee.terminated ${terminated.id} (module demo, Error)`]);
  store.setEventSink(null);
});

test("store events: needsDispatch — a type nobody subscribes to is settled at write time and never queued; a subscribed type is dispatched after commit", () => {
  const seen = [];
  const bus = events.createBus({
    subscriptions: [{ module: "demo", type: "employee.transferred", fn: (e) => seen.push(e.type) }],
    log: () => {},
    record: (results) => store.recordEventDispatch(results),
  });
  const published = [];
  store.setEventSink((evs) => { published.push(...evs.map((e) => e.type)); bus.publish(evs); }, { needsDispatch: (t) => bus.hasSubscribers(t) });
  const m = mark();
  const u = newUser();                                        // employee.hired: no subscriber
  store.updateUser(u.id, { department: "Dispatched Dept" }); // employee.transferred: subscribed
  const [hired, transferred] = since(m);
  assert.equal(hired.type, "employee.hired");
  assert.equal(hired.dispatchedAt, hired.occurredAt, "settled in the same insert");
  assert.equal(hired.attempts, 0);
  assert.equal(transferred.type, "employee.transferred");
  assert.ok(transferred.dispatchedAt && transferred.dispatchedAt >= transferred.occurredAt);
  assert.equal(transferred.attempts, 1);
  assert.deepEqual(published, ["employee.transferred"], "only the subscribed type reaches the bus");
  assert.deepEqual(seen, ["employee.transferred"]);
  // a rollback discards a settled row just the same
  const m2 = mark();
  assert.throws(() => store.transaction(() => { newUser(); throw new Error("abort"); }), /abort/);
  assert.equal(since(m2).length, 0);
  // a throwing needsDispatch falls back to "dispatch it"
  store.setEventSink((evs) => published.push(...evs.map((e) => e.type)), { needsDispatch: () => { throw new Error("x"); } });
  newUser();
  assert.equal(published[published.length - 1], "employee.hired");
  store.setEventSink(null);
});

test("store events: a handler that writes through the store gets its own events dispatched after its own commit, in the next round", () => {
  const order = [];
  let bus;
  bus = events.createBus({
    subscriptions: [
      { module: "demo", type: "employee.hired", fn: (e) => { order.push("hired"); store.updateUser(e.subject.userId, { managerId: "u-admin" }); order.push("hired:done"); } },
      { module: "demo", type: "employee.manager_changed", fn: (e) => order.push("manager_changed:" + e.data.to) },
    ],
    log: () => {},
    record: (results) => store.recordEventDispatch(results),
  });
  store.setEventSink((evs) => bus.publish(evs));
  const m = mark();
  newUser();
  assert.deepEqual(order, ["hired", "hired:done", "manager_changed:u-admin"]);
  const evs = since(m);
  assert.deepEqual(evs.map((e) => e.type), ["employee.hired", "employee.manager_changed"]);
  for (const e of evs) { assert.ok(e.dispatchedAt); assert.equal(e.attempts, 1); }
  store.setEventSink(null);
});

test("store events: a sink that throws is contained — the transaction still returns normally", () => {
  store.setEventSink(() => { throw new Error("sink down"); });
  const origError = console.error;
  const lines = [];
  console.error = (l) => lines.push(String(l));
  try {
    const u = newUser();
    assert.ok(store.getUserById(u.id));
  } finally { console.error = origError; store.setEventSink(null); }
  assert.deepEqual(lines, ["[events] dispatch of 1 committed event(s) failed: Error"]);
});

test("store events: department writes — rename (+cascade, no per-person transfers), move, deactivate, delete (children moved), adopt", () => {
  store.setEventSink(null);
  const root = store.ensureDepartment("Evt Root");
  const mid = store.ensureDepartment("Evt Mid", root.id);
  const leaf = store.ensureDepartment("Evt Leaf", mid.id);
  const other = store.ensureDepartment("Evt Other");
  newUser({ department: "Evt Leaf" });
  let m = mark();
  store.updateDepartment(leaf.id, { name: "Evt Leaf 2" });
  let evs = since(m);
  assert.deepEqual(evs.map((e) => e.type), ["department.renamed"], "users.department cascades without employee.transferred");
  assert.deepEqual(evs[0].data, { from: "Evt Leaf", to: "Evt Leaf 2", registered: true, members: 1 });
  assert.equal(evs[0].subjectDeptId, leaf.id);

  m = mark();
  store.updateDepartment(mid.id, { parentId: other.id });
  evs = since(m);
  assert.deepEqual(evs.map((e) => e.type), ["department.moved"]);
  assert.deepEqual(evs[0].data, {
    name: "Evt Mid", reason: "updated",
    from: { parentId: root.id, parentName: "Evt Root", level: 2, level1: "Evt Root", level1Id: root.id },
    to: { parentId: other.id, parentName: "Evt Other", level: 2, level1: "Evt Other", level1Id: other.id },
  });

  m = mark();
  store.updateDepartment(mid.id, { active: false, sort: 5, ownerId: "u-admin" });
  evs = since(m);
  assert.deepEqual(evs.map((e) => e.type), ["department.deactivated"]);
  assert.equal(evs[0].data.deleted, false);
  store.updateDepartment(mid.id, { ownerId: null, sort: 6 });
  assert.equal(since(m).length, 1, "owner / sort changes publish nothing");

  m = mark();
  store.deleteDepartment(mid.id);
  evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectDeptId]), [["department.deactivated", mid.id], ["department.moved", leaf.id]]);
  assert.equal(evs[0].data.deleted, true);
  assert.equal(evs[0].data.wasActive, false);
  assert.equal(evs[1].data.reason, "parent_deleted");
  assert.equal(evs[1].data.from.level, 3);
  assert.deepEqual(evs[1].data.to, { parentId: null, parentName: null, level: 1, level1: "Evt Leaf 2", level1Id: leaf.id });

  const orphan = store.ensureDepartment("Evt Orphan");
  m = mark();
  store.ensureDepartment("Evt Orphan", other.id);
  evs = since(m);
  assert.deepEqual(evs.map((e) => [e.type, e.subjectDeptId, e.data.reason]), [["department.moved", orphan.id, "adopted"]]);
  store.ensureDepartment("Evt Brand New", other.id);
  assert.equal(since(m).length, 1, "creating a department publishes nothing");
});
// ---------- 终审补充：两条只有 store 层兜得住的规则 ----------

test("store events: ensureDepartment never adopts a root under its own subtree — nothing written, no event (the HTTP adopt path answers 400 dept_cycle first; this is the store-level backstop)", () => {
  store.setEventSink(null);
  const root = store.ensureDepartment("Evt Cyc Root");
  const kid = store.ensureDepartment("Evt Cyc Kid", root.id);
  const grand = store.ensureDepartment("Evt Cyc Grand", kid.id);
  const other = store.ensureDepartment("Evt Cyc Other");
  assert.equal(store.departmentWouldCycle(root.id, grand.id), true);
  assert.equal(store.departmentWouldCycle(root.id, root.id), true);
  assert.equal(store.departmentWouldCycle(root.id, other.id), false);
  const m = mark();
  for (const pid of [kid.id, grand.id]) {
    const got = store.ensureDepartment("Evt Cyc Root", pid);
    assert.equal(got.id, root.id);
    assert.equal(got.parentId, null, "the root stays a root");
  }
  assert.deepEqual(since(m), [], "a refused adoption writes no outbox row");
  const tree = new Map(store.listDepartments(true).map((d) => [d.id, d]));
  assert.equal(tree.get(root.id).parentId, null);
  assert.equal(tree.get(kid.id).parentId, root.id);
  assert.equal(tree.get(grand.id).parentId, kid.id);
});

test("store events: moving a legacy case variant (\"evt case dept \" under \"Evt Case Dept\") onto the registered spelling is not a transfer; a real move still is", () => {
  store.setEventSink(null);
  store.ensureDepartment("Evt Case Dept");
  // createUser stores what it is given (the API canonicalizes first; legacy rows and scripts may not).
  const u = newUser({ department: "evt case dept " });
  const m = mark();
  store.updateUser(u.id, { department: "Evt Case Dept" });
  assert.equal(store.getUserById(u.id).department, "Evt Case Dept");
  assert.deepEqual(since(m), [], "same department, different spelling: no employee.transferred");
  store.updateUser(u.id, { department: "Evt Case Dept Two" });
  assert.deepEqual(since(m).map((e) => e.type), ["employee.transferred"]);
});
