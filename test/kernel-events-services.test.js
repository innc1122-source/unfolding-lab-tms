// 第二段内核 · kernel/events.js 按模块惰性提供各自的 services（modules/culture/CONTRACT.md 4.13 末段、6.2；PHASE2-KERNEL.md 3.1）：
//   · moduleServices(moduleId) 返回对象 → ctx.services 就是它（同一引用，culture 的钩子与工厂拿到同一个冻结对象）；
//   · 返回 undefined → 照旧用共用的 services（每轮一次的工厂，core 与 M0 模块）；
//   · 返回 null / 抛异常 → 该模块 services 尚未组装：跳过处理函数、按失败记，不回退到共用对象，每轮每模块只记一行日志；
//   · 与 store 的集成：钩子里 ctx.services.transaction + moduleDb 写库可用；4,000 个 employee.transferred 一轮分发的耗时。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-events-svc-"));
process.env.LMS_DB_PATH = path.join(TMP, "events.db");
process.env.LMS_ATTACH_DIR = path.join(TMP, "attachments");
process.env.LMS_CONFIG_PATH = path.join(TMP, "config.json");
const store = require("../store.js");
const events = require("../kernel/events.js");
const registry = require("../kernel/registry.js");
const { DatabaseSync } = require("node:sqlite");

store.init({ hashPassword: (pw) => "test-hash:" + pw });
test.after(() => { try { store.setEventSink(null); store.close(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const env = (type, n) => events.createEnvelope({ type, subject: { userId: "u-" + n }, data: { n }, actorId: null });

test("events services: a module's own services object is handed over as ctx.services (same reference, every round); undefined falls back to the shared per-round services", () => {
  const own = Object.freeze({ kind: "culture-services" });
  let shared = 0, asked = [];
  const seen = [];
  const bus = events.createBus({
    subscriptions: [
      { module: "culture", type: "employee.transferred", fn: (e, ctx) => seen.push(["culture", e.data.n, ctx.moduleId, ctx.services]) },
      { module: "learning", type: "employee.transferred", fn: (e, ctx) => seen.push(["learning", e.data.n, ctx.moduleId, ctx.services.round]) },
      { module: "talent", type: "employee.transferred", fn: (e, ctx) => seen.push(["talent", e.data.n, ctx.moduleId, ctx.services.round]) },
    ],
    services: () => ({ round: ++shared }),
    moduleServices: (id) => { asked.push(id); return id === "culture" ? own : undefined; },
  });
  assert.deepEqual(asked, [], "nothing is asked before the first dispatch (lazy)");
  bus.publish([env("employee.transferred", 1), env("employee.transferred", 2)]);
  assert.deepEqual(seen, [
    ["culture", 1, "culture", own], ["learning", 1, "learning", 1], ["talent", 1, "talent", 1],
    ["culture", 2, "culture", own], ["learning", 2, "learning", 1], ["talent", 2, "talent", 1],
  ]);
  assert.equal(shared, 1, "the shared factory still runs once per round, for the modules without their own services");
  assert.deepEqual(asked, ["culture", "learning", "talent"], "moduleServices is asked once per module per round");
  seen.length = 0;
  bus.publish([env("employee.transferred", 3)]);
  assert.strictEqual(seen[0][3], own, "the same object in the next round");
  assert.equal(seen[1][3], 2, "a fresh shared services object in the next round");
});

test("events services: a module whose services are not assembled yet (null, or moduleServices throws) is skipped and recorded as failed — no fallback to the shared object, one log line per module per round", () => {
  const logs = [];
  const results = [];
  const ran = [];
  let mode = "null";
  const bus = events.createBus({
    subscriptions: [
      { module: "culture", type: "employee.terminated", fn: () => ran.push("culture") },
      { module: "talent", type: "employee.terminated", fn: () => ran.push("talent") },
    ],
    services: () => ({ shared: true }),
    moduleServices: (id) => { if (id !== "culture") return undefined; if (mode === "throw") throw new Error("not yet"); return null; },
    record: (r) => results.push(...r),
    log: (line) => logs.push(line),
  });
  bus.publish([env("employee.terminated", 1), env("employee.terminated", 2), env("employee.terminated", 3)]);
  assert.deepEqual(ran, ["talent", "talent", "talent"], "the other module's handlers still run");
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.handlers, 1, "only the talent handler ran");
    assert.match(r.error, /^culture: kernel: the module's services are not ready \(handler not run\)$/);
  }
  assert.equal(logs.length, 1, "logged once for the whole round");
  assert.match(logs[0], /^\[events\] handler skipped: employee\.terminated ev-\S+ \(module culture, services not ready; logged once per round\)$/);
  mode = "throw";
  bus.publish([env("employee.terminated", 4)]);
  assert.equal(logs.length, 2, "a new round logs again");
  assert.equal(results[3].ok, false);
});

test("events services: modules without moduleServices keep the old behaviour exactly (object services passed through, factory per round)", () => {
  const services = { hodOf: () => null };
  const seen = [];
  const bus = events.createBus({ subscriptions: [{ module: "learning", type: "employee.hired", fn: (e, ctx) => seen.push(ctx.services === services) }], services });
  bus.publish([env("employee.hired", 1)]);
  assert.deepEqual(seen, [true]);
});

test("events services: a subscriber's own services can run a transaction and module-scoped writes inside the hook; 4,000 employee.transferred events dispatch in about a second", (t) => {
  // 演示模块：迁移 + 受限 db + 该模块自己的冻结 services（culture 钩子要用的 transaction / db / afterCommit / now / log 同形）
  const mig = path.join(TMP, "modules", "demo", "migrations");
  fs.mkdirSync(mig, { recursive: true });
  fs.writeFileSync(path.join(mig, "demo-0001.sql"), "CREATE TABLE IF NOT EXISTS demo_members (userId TEXT PRIMARY KEY, dept TEXT, seen INTEGER NOT NULL DEFAULT 0);\r\n");
  store.runModuleMigrations([{ module: "demo", dir: mig, tables: ["demo_members"] }]);
  const REG = registry.load();
  const mdb = store.moduleDb("demo", ["demo_members"], { ...REG.tableModule, demo_members: "demo" });
  const afterCount = { n: 0 };
  const services = Object.freeze({
    db: mdb.db,
    transaction: (fn) => { if (mdb.isReadOnly()) throw Object.assign(new Error("write_in_get"), { code: "write_in_get" }); return store.transaction(fn); },
    afterCommit: (fn, label) => store.afterCommit(fn, "demo:" + (label || "")),
    now: () => Date.now(),
    log: () => {},
  });
  const upsert = "INSERT INTO demo_members (userId, dept, seen) VALUES (?, ?, 1) ON CONFLICT(userId) DO UPDATE SET dept = excluded.dept, seen = seen + 1";
  let wrongServices = 0;
  const hook = (event, ctx) => {
    if (ctx.services !== services) wrongServices++;
    ctx.services.transaction(() => {
      ctx.services.db.prepare(upsert).run(event.subject.userId, event.data.to.department);
      ctx.services.afterCommit(() => { afterCount.n++; }, "count");
    });
  };
  const bus = events.createBus({
    subscriptions: [{ module: "demo", type: "employee.transferred", fn: hook }],
    services: () => { throw new Error("the shared factory must not be used for demo"); },
    moduleServices: (id) => (id === "demo" ? services : undefined),
    record: (results) => store.recordEventDispatch(results),
  });
  store.setEventSink((committed) => bus.publish(committed), { needsDispatch: (type) => bus.hasSubscribers(type) });

  const N = 4000;
  store.transaction(() => {
    for (let i = 0; i < N; i++) store.createUser({ id: "u-bulk-" + i, employeeId: "BULK-" + i, name: "Bulk " + i, role: "employee", passwordHash: "h", department: "Dept A" });
  });
  const t0 = Date.now();
  store.transaction(() => { for (let i = 0; i < N; i++) store.updateUser("u-bulk-" + i, { department: "Dept B" }); });
  const ms = Date.now() - t0;
  t.diagnostic(`4,000 employee.transferred: batch transaction + dispatch to a transactional hook + outbox write-back took ${ms}ms`);
  store.setEventSink(null);

  const ro = new DatabaseSync(process.env.LMS_DB_PATH, { readOnly: true });
  try {
    assert.equal(ro.prepare("SELECT COUNT(*) AS n FROM demo_members WHERE dept = 'Dept B' AND seen = 1").get().n, N);
    const outbox = ro.prepare("SELECT COUNT(*) AS n, SUM(attempts) AS a, SUM(dispatchedAt IS NULL) AS pending FROM event_outbox WHERE type = 'employee.transferred'").get();
    assert.deepEqual({ n: outbox.n, a: outbox.a, pending: outbox.pending }, { n: N, a: N, pending: 0 }, "every event dispatched once and written back as delivered");
  } finally { ro.close(); }
  assert.equal(wrongServices, 0, "the hook always received the module's own services object");
  assert.equal(afterCount.n, N, "afterCommit inside the hook's transaction ran after each commit");
  assert.ok(ms < 10000, `took ${ms}ms (expected on the order of a second)`);
});
