// 领域事件内核（kernel/events.js）单测：信封形状与 data 卫生、请求上下文（跨 await 不串）、
// 分发总线（顺序、异常隔离、日志不含明细、写回结果、模块关闭、处理函数里再触发、死循环保护）。
// 纯内存，不起服务、不读库。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const events = require("../kernel/events.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (type, data = {}, subject = { userId: "u-1" }) => events.createEnvelope({ type, subject, data, actorId: "u-admin" });

// ---------- 信封 ----------

test("envelope: exactly { id, type, occurredAt, actorId, subject, data, version:1 }, deep-frozen, detached from the caller's object", () => {
  const data = { employeeId: "E-1", from: { department: "Ops" } };
  const e = events.createEnvelope({ type: "employee.transferred", subject: { userId: "u-9" }, data, actorId: "u-admin" });
  assert.deepEqual(Object.keys(e).sort(), ["actorId", "data", "id", "occurredAt", "subject", "type", "version"]);
  assert.match(e.id, /^ev-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(e.type, "employee.transferred");
  assert.ok(!Number.isNaN(Date.parse(e.occurredAt)) && e.occurredAt.endsWith("Z"), "ISO 8601 with a zone");
  assert.equal(e.actorId, "u-admin");
  assert.deepEqual(e.subject, { userId: "u-9" });
  assert.equal(e.version, 1);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.data) && Object.isFrozen(e.data.from) && Object.isFrozen(e.subject));
  data.from.department = "changed later";
  assert.equal(e.data.from.department, "Ops", "the envelope does not share objects with the caller");
  assert.throws(() => { "use strict"; e.data.employeeId = "x"; }, TypeError);
  assert.notEqual(ev("employee.hired").id, ev("employee.hired").id, "ids are unique");
});

test("envelope: ids are UUIDv7-shaped and strictly increasing within the process (sortable, so outbox inserts append)", () => {
  const ids = Array.from({ length: 6000 }, () => ev("employee.hired").id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice().sort(), ids, "lexical order = creation order, even for thousands created in the same millisecond");
  for (const id of ids.slice(0, 50)) assert.match(id, /^ev-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const msOf = (id) => parseInt(id.slice(3, 11) + id.slice(12, 16), 16);
  assert.ok(Math.abs(msOf(ids[0]) - Date.now()) < 60000, "the leading 48 bits are the creation time in ms");
});

test("envelope: subject keeps only userId / deptId; blank ids are dropped; unknown keys are rejected", () => {
  assert.deepEqual(events.createEnvelope({ type: "department.renamed", subject: { deptId: "d-3" } }).subject, { deptId: "d-3" });
  assert.deepEqual(events.createEnvelope({ type: "department.renamed", subject: { userId: "", deptId: null } }).subject, {});
  assert.deepEqual(events.createEnvelope({ type: "department.renamed" }).subject, {});
  assert.throws(() => events.createEnvelope({ type: "employee.hired", subject: { employeeId: "E-1" } }), /unknown key "employeeId"/);
});

test("envelope: the type must look like entity.action", () => {
  for (const bad of ["hired", "Employee.hired", "employee.", ".hired", "employee hired", "", null, 7])
    assert.throws(() => events.createEnvelope({ type: bad }), /must look like "entity\.action"/, String(bad));
  for (const good of ["employee.hired", "employee.manager_changed", "talent.succession.changed", "att-sheet.closed"])
    assert.equal(events.createEnvelope({ type: good }).type, good);
});

test("envelope: data refuses credentials, sessions and contact details at any depth", () => {
  const bad = [
    { password: "x" }, { passwordHash: "x" }, { newPassword: "x" }, { token: "x" }, { sessionId: "x" },
    { email: "a@b.c" }, { e_mail: "x" }, { contactEmail: "x" }, { phone: "0917" }, { mobile: "0917" }, { homeAddress: "x" },
    { secret: "x" }, { cookie: "x" }, { salt: "x" },
    { to: { email: "a@b.c" } }, { list: [{ phone: "1" }] },
  ];
  for (const data of bad) assert.throws(() => events.createEnvelope({ type: "employee.hired", data }), /not allowed in event data/, JSON.stringify(data));
  assert.throws(() => events.createEnvelope({ type: "employee.hired", data: [] }), /plain object/);
  assert.throws(() => events.createEnvelope({ type: "employee.hired", data: { when: new Date() } }), /plain objects/);
  assert.throws(() => events.createEnvelope({ type: "employee.hired", data: { f() {} } }), /not JSON data/);
  assert.throws(() => events.createEnvelope({ type: "employee.hired", data: { a: { b: [{ c: { d: 1 } }] } } }), /event data\.a\.b\[0\]\.c\.d: nested deeper than 4 levels/);
  assert.throws(() => events.createEnvelope({ type: "employee.hired", data: { list: [1, { phone: "1" }] } }), /event data\.list\[1\]: key "phone"/);
  // JSON semantics for the copy: undefined props dropped, undefined / non-finite array items → null
  assert.deepEqual(events.createEnvelope({ type: "employee.hired", data: { a: undefined, b: [undefined, NaN, 2], c: Infinity } }).data, { b: [null, null, 2], c: null });
  // the fields core actually sends pass
  events.createEnvelope({ type: "employee.terminated", data: {
    employeeId: "E-1", reason: "exited", empStatus: { from: "regular", to: "exited" }, active: { from: true, to: false },
    org: { department: "Ops", deptId: "d-1", level1: "Ops", level1Id: "d-1", level2: null, level2Id: null, isDirect: true, level3: null, level3Id: null, isDirect2: false },
  } });
});

test("envelope: encodeData refuses a data payload over the size cap (events carry ids, not whole records)", () => {
  const big = events.createEnvelope({ type: "employee.hired", data: { note: "x".repeat(events.MAX_DATA_BYTES + 1) } });
  assert.throws(() => events.encodeData(big), /larger than 4096 bytes/);
  assert.equal(events.encodeData(ev("employee.hired", { employeeId: "E-1" })), '{"employeeId":"E-1"}');
});

// ---------- 请求上下文 ----------

test("context: actorId comes from the current request context; explicit actorId (even null) wins; none outside a context", async () => {
  assert.equal(events.currentContext(), null);
  assert.equal(events.createEnvelope({ type: "employee.hired" }).actorId, null);
  await events.runWithContext({ actorId: "u-7", requestId: "r-1" }, async () => {
    assert.deepEqual(events.currentContext(), { actorId: "u-7", requestId: "r-1" });
    await sleep(5);
    assert.equal(events.createEnvelope({ type: "employee.hired" }).actorId, "u-7", "survives an await");
    assert.equal(events.createEnvelope({ type: "employee.hired", actorId: null }).actorId, null);
    assert.equal(events.createEnvelope({ type: "employee.hired", actorId: "u-8" }).actorId, "u-8");
  });
  assert.equal(events.currentContext(), null);
});

test("context: two interleaved async flows (like two concurrent requests) never see each other's actor", async () => {
  const seen = [];
  const flow = (actorId, delays) => new Promise((resolve) => setImmediate(async () => {
    events.enterContext({ actorId });   // what handleApi does at its top
    for (const d of delays) {
      await sleep(d);
      seen.push([actorId, events.createEnvelope({ type: "employee.hired" }).actorId]);
    }
    resolve();
  }));
  await Promise.all([flow("u-a", [15, 1, 12, 1]), flow("u-b", [1, 14, 1, 10]), flow(null, [7, 7, 7])]);
  assert.equal(seen.length, 11);
  for (const [want, got] of seen) assert.equal(got, want);
});

// ---------- 分发总线 ----------

function harness(subscriptions, opts = {}) {
  const logs = [];
  const recorded = [];
  const bus = events.createBus({
    subscriptions,
    log: (line) => logs.push(line),
    record: (results) => recorded.push(results),
    ...opts,
  });
  return { bus, logs, recorded };
}

test("bus: handlers run in registry order with (event, ctx); ctx carries the module id and the shared services", () => {
  const calls = [];
  const services = { hodOf: () => null };
  const { bus, recorded } = harness([
    { module: "learning", type: "employee.hired", fn: (e, ctx) => calls.push(["learning", e.id, ctx.moduleId, ctx.services === services]) },
    { module: "talent", type: "employee.hired", fn: (e, ctx) => calls.push(["talent", e.id, ctx.moduleId, Object.isFrozen(ctx)]) },
    { module: "talent", type: "employee.terminated", fn: () => calls.push(["talent-terminated"]) },
  ], { services });
  const a = ev("employee.hired"), b = ev("employee.transferred");
  bus.publish([a, b]);
  assert.deepEqual(calls, [["learning", a.id, "learning", true], ["talent", a.id, "talent", true]]);
  assert.deepEqual(recorded, [[
    { id: a.id, type: "employee.hired", ok: true, error: null, handlers: 2 },
    { id: b.id, type: "employee.transferred", ok: true, error: null, handlers: 0 },
  ]], "one write-back per round; an event nobody subscribes to still counts as dispatched");
  assert.deepEqual(bus.subscribers("employee.hired"), ["learning", "talent"]);
  assert.equal(bus.hasSubscribers("employee.terminated"), true);
  assert.equal(bus.hasSubscribers("employee.transferred"), false);
});

test("bus: a throwing handler is isolated — later handlers and events still run, publish does not throw, the log line has no data or message", () => {
  const ran = [];
  const { bus, logs, recorded } = harness([
    { module: "learning", type: "employee.transferred", fn: (e) => { throw new Error("boom for " + e.data.marker + " " + "a".repeat(40)); } },
    { module: "talent", type: "employee.transferred", fn: (e) => ran.push(["talent", e.id]) },
    { module: "talent", type: "employee.hired", fn: (e) => ran.push(["talent-hired", e.id]) },
  ]);
  const a = events.createEnvelope({ type: "employee.transferred", subject: { userId: "u-1" }, data: { marker: "ZZ-DATA-MARKER" } });
  const b = ev("employee.hired");
  assert.doesNotThrow(() => bus.publish([a, b]));
  assert.deepEqual(ran, [["talent", a.id], ["talent-hired", b.id]]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0], `[events] handler failed: employee.transferred ${a.id} (module learning, Error)`);
  assert.ok(!logs[0].includes("ZZ-DATA-MARKER") && !logs[0].includes("boom"), "log line carries only type, id, module and error class");
  const [r1, r2] = recorded[0];
  assert.equal(r1.ok, false);
  assert.match(r1.error, /^learning: Error: boom for ZZ-DATA-MARKER \[redacted\]$/, "lastError keeps the module and message, long hex runs redacted");
  assert.equal(r1.handlers, 2);
  assert.deepEqual(r2, { id: b.id, type: "employee.hired", ok: true, error: null, handlers: 1 });
});

test("bus: a handler that returns a Promise is recorded as failed (handlers must be synchronous) and its rejection is swallowed", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { bus, recorded, logs } = harness([
      { module: "talent", type: "employee.hired", fn: () => Promise.reject(new Error("later")) },
    ]);
    bus.publish([ev("employee.hired")]);
    await sleep(10);
    assert.equal(recorded[0][0].ok, false);
    assert.match(recorded[0][0].error, /talent: TypeError: event handlers must be synchronous/);
    assert.match(logs[0], /^\[events\] handler failed: employee\.hired ev-.* \(module talent, TypeError\)$/);
    assert.equal(unhandled, 0);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("bus: handlers of a switched-off module do not run (a throwing isModuleOn counts as on)", () => {
  const ran = [];
  const off = new Set(["learning"]);
  const { bus, recorded } = harness([
    { module: "learning", type: "employee.hired", fn: () => ran.push("learning") },
    { module: "talent", type: "employee.hired", fn: () => ran.push("talent") },
  ], { isModuleOn: (id) => !off.has(id) });
  bus.publish([ev("employee.hired")]);
  assert.deepEqual(ran, ["talent"]);
  assert.equal(recorded[0][0].handlers, 1);
  const { bus: bus2 } = harness([{ module: "talent", type: "employee.hired", fn: () => ran.push("talent2") }], { isModuleOn: () => { throw new Error("config unreadable"); } });
  bus2.publish([ev("employee.hired")]);
  assert.deepEqual(ran, ["talent", "talent2"]);
});

test("bus: a services factory is called once per round and shared by every event in it; isModuleOn is asked once per module per round", () => {
  // server.js 的 ctx.services 是工厂：一轮分发共用一个组织快照。4,000 人的批量调动是一轮 4,000 个事件，
  // 逐个重建快照（全表读 users + 推算）会把请求卡住几十秒；isModuleOn 在 server.js 里要读 config.json。
  let built = 0, asked = 0;
  const seen = [];
  const { bus } = harness([
    { module: "learning", type: "employee.transferred", fn: (e, ctx) => seen.push(["learning", ctx.services.round]) },
    { module: "talent", type: "employee.transferred", fn: (e, ctx) => seen.push(["talent", ctx.services.round]) },
  ], { services: () => ({ round: ++built }), isModuleOn: () => { asked++; return true; } });
  bus.publish(Array.from({ length: 50 }, () => ev("employee.transferred")));
  assert.equal(built, 1, "one services object for the whole round");
  assert.equal(seen.length, 100);
  assert.ok(seen.every(([, r]) => r === 1));
  assert.equal(asked, 2, "one on/off lookup per module per round, not per event");
  bus.publish([ev("employee.transferred")]);
  assert.equal(built, 2, "the next publish (next request) gets a fresh one — nothing is cached across requests");
  assert.equal(asked, 4);
  // 没有处理函数要运行的轮次不调用工厂（不为没人订阅的事件建快照）。
  bus.publish([ev("employee.hired")]);
  assert.equal(built, 2);
  // 对象形式照旧原样交出去（ctx.services === services，见上面第一项）。
});

test("bus: when a handler writes and publishes, the rest of the round gets a fresh services object (no stale snapshot)", () => {
  let built = 0;
  const seen = [];
  let busRef;
  const { bus } = harness([
    { module: "learning", type: "employee.transferred", fn: (e, ctx) => {
      seen.push([e.data.n, ctx.services.round]);
      if (e.data.n === 2) busRef.publish([events.createEnvelope({ type: "employee.manager_changed", data: { n: 99 } })]);   // handler's own committed write
    } },
    { module: "learning", type: "employee.manager_changed", fn: (e, ctx) => seen.push([e.data.n, ctx.services.round]) },
  ], { services: () => ({ round: ++built }) });
  busRef = bus;
  bus.publish([1, 2, 3].map((n) => events.createEnvelope({ type: "employee.transferred", data: { n } })));
  assert.deepEqual(seen, [[1, 1], [2, 1], [3, 2], [99, 3]], "event 3 sees a snapshot taken after the handler's write; the queued round builds its own");
});

test("bus: events published from inside a handler are queued and dispatched after the current round, not recursively", () => {
  const order = [];
  let bus;
  const h = harness([
    { module: "talent", type: "employee.hired", fn: (e) => { order.push("hired:start"); bus.publish([ev("employee.manager_changed")]); order.push("hired:end"); } },
    { module: "talent", type: "employee.manager_changed", fn: () => order.push("manager_changed") },
  ]);
  bus = h.bus;
  bus.publish([ev("employee.hired"), ev("employee.transferred")]);
  assert.deepEqual(order, ["hired:start", "hired:end", "manager_changed"]);
  assert.equal(h.recorded.length, 2, "two rounds, two write-backs");
  assert.deepEqual(h.recorded.map((r) => r.map((x) => x.type)), [["employee.hired", "employee.transferred"], ["employee.manager_changed"]]);
});

test("bus: a subscriber loop is cut off after maxRounds and the stranded event is recorded as failed", () => {
  let bus;
  let n = 0;
  const h = harness([
    { module: "talent", type: "employee.manager_changed", fn: () => { n++; bus.publish([ev("employee.manager_changed")]); } },
  ], { maxRounds: 3 });
  bus = h.bus;
  bus.publish([ev("employee.manager_changed")]);
  assert.equal(n, 4, "rounds 0..3 dispatched");
  const last = h.recorded[h.recorded.length - 1][0];
  assert.equal(last.ok, false);
  assert.match(last.error, /dispatch chain deeper than 3 rounds/);
  assert.ok(h.logs.some((l) => /^\[events\] not dispatched: employee\.manager_changed ev-/.test(l)));
  // and the bus is usable again afterwards
  n = 0;
  bus.publish([ev("employee.hired")]);
  assert.equal(n, 0);
});

test("bus: a failing write-back is logged and never thrown back into the committed request", () => {
  const logs = [];
  const bus = events.createBus({ subscriptions: [], log: (l) => logs.push(l), record: () => { throw new Error("SQLITE_BUSY users.passwordHash"); } });
  assert.doesNotThrow(() => bus.publish([ev("employee.hired")]));
  assert.deepEqual(logs, ["[events] outbox write-back failed for 1 event(s) (Error)"]);
  // empty publishes are no-ops
  assert.doesNotThrow(() => bus.publish([]));
  assert.doesNotThrow(() => bus.publish(null));
});

test("errorText: one line, truncated, credential-looking hex redacted", () => {
  const e = new Error("line1\nline2 " + "ab".repeat(20) + " " + "x".repeat(600));
  const s = events.errorText(e);
  assert.ok(!s.includes("\n"));
  assert.ok(s.includes("[redacted]"));
  assert.ok(s.length <= 501);
});
