// 第二段内核 · kernel/module-host.js（modules/culture/CONTRACT.md 第 3、4 节；PHASE2-KERNEL.md 4.2–4.4）：
//   services 组装（成员清单、冻结、PersonRow 投影、org / rbac / line 的包装、now 与 isProduction 的缓存、
//   GET 只读期间的 write_in_get、事件发布方校验、审计与通知的提交后执行、defer 恢复上下文、csv）、
//   工厂启动校验与 raterKey 注入、事件总线的 moduleServices、dispatch 的判定顺序与应答形状、站内回跳白名单。
// 进程内驱动：真实 store（系统临时目录里的库）+ 真实注册表（现有模块 + 临时目录里的演示模块），server.js 侧的
// 权限与组织函数用可控的假实现（真实接线由 test/module-host-http.test.js 验证）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-host-"));
process.env.LMS_DB_PATH = path.join(TMP, "host.db");
process.env.LMS_ATTACH_DIR = path.join(TMP, "attachments");
process.env.LMS_CONFIG_PATH = path.join(TMP, "config.json");
const store = require("../store.js");
const events = require("../kernel/events.js");
const registry = require("../kernel/registry.js");
const orgLib = require("../modules/core/org.js");
const host = require("../kernel/module-host.js");
const { DatabaseSync } = require("node:sqlite");

store.init({ hashPassword: (pw) => "test-hash:" + pw });
test.after(() => { try { store.setEventSink(null); store.close(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// 已登记的模块里去掉 culture（2026-09-26 登记）：本文件只验证内核本身，用临时目录里的 hostdemo；演示注册表的
// 模块根目录是临时目录（dir: MODS），culture 的 public/、migrations/ 不在那里。culture 在真实服务上的接线由
// test/culture-http.test.js 验证。core 订阅 culture.program.completed 照样成立（culture 是 core 的 optional）。
const REG = registry.load();
const BASE_MANIFESTS = REG.manifests.filter((m) => m.id !== "culture");
const REG_HOOKS = (() => { const h = {}; for (const s of REG.events.subscriptions) if (s.module !== "culture") (h[s.module] = h[s.module] || {})[s.type] = s.fn; return h; })();
const rows = (sql, ...a) => { const db = new DatabaseSync(process.env.LMS_DB_PATH, { readOnly: true }); try { return db.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { db.close(); } };

// ---------- 演示模块（临时目录）----------
const MODS = path.join(TMP, "modules");
const DEMO_DIR = path.join(MODS, "hostdemo");
fs.mkdirSync(path.join(DEMO_DIR, "public"), { recursive: true });
fs.mkdirSync(path.join(DEMO_DIR, "migrations"), { recursive: true });
fs.writeFileSync(path.join(DEMO_DIR, "public", "index.html"), "<!doctype html>");
fs.writeFileSync(path.join(DEMO_DIR, "migrations", "hostdemo-0001.sql"), "CREATE TABLE IF NOT EXISTS hostdemo_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT, note TEXT NOT NULL);\n");
const MANIFEST = {
  id: "hostdemo", name: { zh: "演示", en: "Demo" }, version: "0.0.1", sellable: true, defaultOn: false,
  requires: ["core"], optional: [],
  domains: [{ id: "hostdemo", name: { zh: "演示", en: "Demo" }, order: 47 }],
  gate: ["/api/v1/hostdemo"],
  static: [{ prefix: "/hostdemo", dir: "./public", entry: "index.html" }],
  routes: [
    { method: "GET", path: "/api/v1/hostdemo/ctx", domain: null, access: "participant", handler: "x.ctx" },
    { method: "GET", path: /^\/api\/v1\/hostdemo\/p\/([^/]+)\/([^/]+)$/, params: ["a", "b"], domain: null, access: "participant", handler: "x.params" },
    { method: "POST", path: "/api/v1/hostdemo/run", domain: null, access: "participant", handler: "x.run" },
    { method: "GET", path: "/api/v1/hostdemo/read", domain: null, access: "hostdemo:read", handler: "x.read" },
    { method: "POST", path: "/api/v1/hostdemo/report", domain: null, access: "hostdemo:read", readonly: true, handler: "x.report" },
    { method: "PUT", path: "/api/v1/hostdemo/manage", domain: null, access: "hostdemo:manage", handler: "x.manage" },
  ],
  migrations: "./migrations",
  tables: ["hostdemo_rows"],
  publishes: ["hostdemo.thing.done"],
  jobs: [{ id: "nightly", cron: "0 3 * * *" }],
};
// 处理函数的行为由测试逐个指定（BEHAVIOR[handler] = (ctx, services) => result）。
const BEHAVIOR = {};
let factoryMode = "ok";
fs.writeFileSync(path.join(DEMO_DIR, "index.js"), `"use strict";
module.exports = function (services) { return global.__hostdemoFactory(services); };
`);
global.__hostdemoFactory = (services) => {
  if (factoryMode === "throw") throw new RangeError("factory exploded 0123456789abcdef0123456789abcdef00");
  if (factoryMode === "log") services.log("startup note: rater key not configured");   // 工厂在启动期记一行（如 culture）
  const names = MANIFEST.routes.map((r) => r.handler);
  const handlers = Object.fromEntries(names.map((n) => [n, (ctx) => BEHAVIOR[n](ctx, services)]));
  if (factoryMode === "missing") delete handlers["x.read"];
  if (factoryMode === "extra") handlers["x.extra"] = () => ({ body: {} });
  if (factoryMode === "async") handlers["x.ctx"] = async () => ({ body: {} });
  const jobs = { nightly: (jobCtx) => { services.transaction(() => services.db.prepare("INSERT INTO hostdemo_rows (who, note) VALUES (?, ?)").run(null, "job:" + jobCtx.trigger)); return { ok: 1 }; } };
  if (factoryMode === "no-jobs") return { handlers };
  return { handlers, jobs };
};
const DREG = registry.build([...BASE_MANIFESTS, MANIFEST], { dir: MODS, hooks: REG_HOOKS });

// ---------- 可控的 server.js 侧依赖 ----------
// 人员直接写进 users 表（store.createUser），权限按一张表判定：grants[userId] = { hostdemo: "read" | "manage" }，super 为超管。
const GRANTS = {};
const SUPER = new Set();
function mkUser(id, extra = {}) {
  store.createUser({ id, employeeId: id.toUpperCase(), name: "Name " + id, role: extra.role || "employee", passwordHash: "x", department: extra.department || null,
    email: id + "@example.test", phone: "0917", managerId: extra.managerId || null, larkUserId: "lark-" + id, mustChangePassword: 0, jobLevel: extra.jobLevel || null, empStatus: extra.empStatus || null });
  return store.getUserById(id);
}
const U = {
  emp: mkUser("u-emp", { department: "Ops", jobLevel: " mb2 " }),
  exited: mkUser("u-exit", { empStatus: "exited" }),
  reader: mkUser("u-read"),
  manager: mkUser("u-mgr"),
  root: mkUser("u-root"),
};
GRANTS["u-read"] = { hostdemo: "read" };
GRANTS["u-mgr"] = { hostdemo: "manage" };
SUPER.add("u-root");
const calls = { jobGrades: 0, snapshot: 0, notify: [], canRead: [] };
const baseDeps = (over = {}) => ({
  registry: DREG, store, events, orgLib, modulesDir: MODS,
  readConfig: () => ({ hostdemo: { raterKey: "r".repeat(40) } }),
  modulesOn: () => ({ learning: true, performance: true, talent: true, hostdemo: true }),
  isProduction: () => false,
  nowMs: () => Date.parse("2026-10-20T09:00:00+08:00"),
  notify: (userId, n) => { calls.notify.push([userId, n.type]); if (n.type === "explode") throw new Error("mail down"); },
  csv: (rows, headers) => "﻿" + [headers].concat(rows).map((r) => r.join(",")).join("\r\n"),
  csvLines: (rows) => rows.map((r) => r.join(",")).join("\r\n"),
  org: {
    snapshot: () => { calls.snapshot++; return orgLib.createOrgResolver(store.listDepartments(true), store.listUsers()); },
    hodOf: (dept, snap) => snap.hodOf(dept),
    deptLevelsOf: (user, snap) => {
      const lv = user ? (snap || orgLib.createOrgResolver(store.listDepartments(true), [])).levelsOf(user.department) : null;
      return lv ? { level1: lv.level1, level2: lv.level2, level3: lv.level3, isDirect: lv.isDirect, isDirect2: lv.isDirect2, level1Id: lv.level1Id, level2Id: lv.level2Id, level3Id: lv.level3Id }
        : { level1: null, level2: null, level3: null, isDirect: false, isDirect2: false, level1Id: null, level2Id: null, level3Id: null };
    },
    jobGrades: () => { calls.jobGrades++; return [{ rank: "MB2", track: "M" }, { rank: "PC1", track: "P" }]; },
  },
  rbac: {
    canRead: (u, d) => { calls.canRead.push(u && u.id); return !!u && (SUPER.has(u.id) || ["read", "manage"].includes((GRANTS[u.id] || {})[d])); },
    canWrite: (u, d) => !!u && (SUPER.has(u.id) || (GRANTS[u.id] || {})[d] === "manage"),
    isSuperAdmin: (u) => !!u && SUPER.has(u.id),
    scopeAllowsFor: (u, t) => !u || !t || t.department !== "Secret",
    scopePredicate: (u) => (u && u.id === "u-read" ? (p) => p.department !== "Secret" : null),
    scopeDeptPredicate: (u) => (u && u.id === "u-read" ? (name) => name !== "Secret Unit" : null),
  },
  line: {
    isInReportingLine: (m, t) => m === "u-mgr" && t === "u-emp",
    reportingSubtree: (m) => (m === "u-mgr" ? [{ user: store.getUserById("u-emp"), depth: 1 }] : []),
  },
  log: (line) => LOGS.push(line),
  warn: (line) => WARNS.push(line),
  ...over,
});
const LOGS = [];
const WARNS = [];

let H;   // 主宿主：init 过的
test.before(() => {
  H = host.createModuleHost(baseDeps());
  assert.deepEqual(H.migrate(), ["hostdemo-0001"]);
  H.init();
});

const req = (method, p, user, extra = {}) => H.dispatch({ method, path: p, query: extra.query || new URLSearchParams(), headers: extra.headers || {}, body: extra.body === undefined ? {} : extra.body, user, requestId: extra.requestId || "r-test" });
const parsed = (out) => ({ status: out.status, body: out.body ? JSON.parse(out.body) : null, headers: out.headers });

// ---------- services ----------

test("module host: each handler module gets one frozen services object with exactly the CONTRACT.md §4 members (raterKey from config.json <module>.raterKey), all synchronous", () => {
  const s = H.servicesOf("hostdemo");
  assert.ok(Object.isFrozen(s));
  assert.deepEqual(Object.keys(s).sort(), ["afterCommit", "audit", "bilingual", "csv", "csvLines", "db", "defer", "events", "httpError", "isProduction", "line", "log",
    "notify", "notifySentSince", "now", "org", "raterKey", "rbac", "transaction", "tz"]);
  assert.deepEqual(Object.keys(s.org).sort(), ["DIRECT_LABEL", "deptLevelsOf", "getUser", "getUserByEmployeeId", "hodDeptIdsOf", "hodOf", "jobChannelOf", "listLevel1Depts", "listUsers", "snapshot"]);
  assert.deepEqual(Object.keys(s.rbac).sort(), ["canRead", "canWrite", "isSuperAdmin", "scopeAllowsFor", "scopeAllowsLevel1", "scopeDeptPredicate", "scopePredicate"]);
  assert.deepEqual(Object.keys(s.line).sort(), ["isInReportingLine", "subtreeOf"]);
  assert.deepEqual(Object.keys(s.events), ["publish"]);
  for (const sub of [s.org, s.rbac, s.line, s.events, s.tz]) assert.ok(Object.isFrozen(sub));
  const fns = [s, s.org, s.rbac, s.line, s.events].flatMap((o) => Object.values(o).filter((v) => typeof v === "function"));
  assert.ok(fns.length > 30);
  for (const f of fns) assert.notEqual(f.constructor.name, "AsyncFunction");
  assert.equal(s.raterKey, "r".repeat(40));
  assert.deepEqual(s.tz, { offsetMinutes: 480, label: "+08:00" });
  assert.equal(s.bilingual("中文", "English"), "English 中文");
  assert.equal(H.servicesOf("core"), null, "only modules with handler routes get services");
  assert.deepEqual(WARNS, [], "a configured rater key raises no warning");
});

test("module host: now() honours LMS_FAKE_NOW (nowMs) outside production and ignores it in production; isProduction is evaluated once at init", () => {
  assert.equal(H.servicesOf("hostdemo").now(), Date.parse("2026-10-20T09:00:00+08:00"));
  assert.equal(H.servicesOf("hostdemo").isProduction(), false);
  let prodAsked = 0;
  const P = host.createModuleHost(baseDeps({ isProduction: () => { prodAsked++; return true; }, nowMs: () => 0 }));
  P.init();
  const s = P.servicesOf("hostdemo");
  const t = Date.now();
  assert.ok(Math.abs(s.now() - t) < 5000, "production: the real clock, not the fake one");
  assert.equal(s.isProduction(), true);
  s.now(); s.isProduction(); s.now();
  assert.equal(prodAsked, 1, "store.isProduction() re-reads config.json on every call — the host asks once");
});

test("module host: org returns frozen PersonRows (no password hash, e-mail, phone, Lark id or role), looks up employee ids trimmed and case-insensitively, renames the level fields, and reads the rank table once per snapshot", () => {
  const { org } = H.servicesOf("hostdemo");
  const p = org.getUser("u-emp");
  assert.ok(Object.isFrozen(p));
  assert.deepEqual(p, { id: "u-emp", employeeId: "U-EMP", name: "Name u-emp", department: "Ops", managerId: null, jobLevel: " mb2 ", position: null, active: true, empStatus: "probation", inService: true, system: false });   // position：CX-051（2026-10-09）
  assert.equal(org.getUser("u-exit").inService, false, "left the company: still returned, not in service");
  assert.equal(org.getUser("nobody"), null);
  assert.equal(org.getUser(null), null);
  assert.equal(org.getUserByEmployeeId("  u-emp ").id, "u-emp");
  assert.equal(org.getUserByEmployeeId(""), null);
  assert.ok(org.listUsers().every((x) => Object.isFrozen(x) && !("passwordHash" in x) && !("email" in x) && !("role" in x)));
  assert.deepEqual(org.deptLevelsOf(null), { dept1Id: null, dept1: null, dept2Id: null, dept2: null, dept3Id: null, dept3: null, isDirect: false, isDirect2: false });
  assert.equal(org.DIRECT_LABEL, orgLib.DIRECT_LABEL);
  // 职级 → 通道：去空白、不分大小写；同一快照只读一次职级表
  const before = calls.jobGrades;
  const snap = org.snapshot();
  for (let i = 0; i < 100; i++) { assert.equal(org.jobChannelOf(" mb2 ", snap), "M"); assert.equal(org.jobChannelOf("pc1", snap), "P"); }
  assert.equal(org.jobChannelOf("ZZ9", snap), null);
  assert.equal(org.jobChannelOf("", snap), null);
  assert.equal(calls.jobGrades - before, 1, "one read of the rank table for the whole snapshot");
  org.jobChannelOf("MB2"); org.jobChannelOf("MB2");
  assert.equal(calls.jobGrades - before, 3, "without a snapshot every call reads it (callers batching must pass snap)");
});

test("module host: org hodOf takes a level-1 id or name and renames level1 → dept1; hodDeptIdsOf / listLevel1Depts (two levels of children) and deptLevelsOf (three levels) follow the snapshot", () => {
  store.ensureDepartment("Host Ops");
  store.ensureDepartment("Host Ops Unit", store.getDepartmentByName("Host Ops").id);
  store.ensureDepartment("Host Ops Unit Night", store.getDepartmentByName("Host Ops Unit").id);
  store.ensureDepartment("Host Ops Unit Night B", store.getDepartmentByName("Host Ops Unit Night").id);   // 四级：并入三级
  const d1 = store.getDepartmentByName("Host Ops");
  mkUser("u-head", { department: "Host Ops" });
  mkUser("u-staff", { department: "Host Ops Unit", managerId: "u-head" });
  mkUser("u-night", { department: "Host Ops Unit Night B", managerId: "u-staff" });
  const { org } = H.servicesOf("hostdemo");
  const snap = org.snapshot();
  const byName = org.hodOf("Host Ops Unit", snap);
  assert.deepEqual(byName, { id: "u-head", name: "Name u-head", employeeId: "U-HEAD", source: "derived", dept1Id: d1.id, dept1: "Host Ops" });
  assert.deepEqual(org.hodOf(d1.id, snap), byName, "a level-1 id resolves to the same answer");
  assert.equal(org.hodOf("No Such Dept", snap), null);
  assert.deepEqual(org.hodDeptIdsOf("u-head", snap), [d1.id]);
  assert.deepEqual(org.hodDeptIdsOf("u-staff", snap), []);
  const l1 = org.listLevel1Depts(snap).find((x) => x.id === d1.id);
  const unit = store.getDepartmentByName("Host Ops Unit").id, night = store.getDepartmentByName("Host Ops Unit Night").id;
  assert.deepEqual(l1, { id: d1.id, name: "Host Ops", hod: { id: "u-head", name: "Name u-head", employeeId: "U-HEAD", source: "derived" }, hodStatus: "derived", memberCount: 3,
    children: [{ id: unit, name: "Host Ops Unit", children: [{ id: night, name: "Host Ops Unit Night" }] }] });
  assert.deepEqual(org.deptLevelsOf(store.getUserById("u-staff"), snap), { dept1Id: d1.id, dept1: "Host Ops", dept2Id: unit, dept2: "Host Ops Unit", dept3Id: null, dept3: null, isDirect: false, isDirect2: true });
  assert.deepEqual(org.deptLevelsOf(store.getUserById("u-night"), snap), { dept1Id: d1.id, dept1: "Host Ops", dept2Id: unit, dept2: "Host Ops Unit", dept3Id: night, dept3: "Host Ops Unit Night", isDirect: false, isDirect2: false });
  assert.deepEqual(org.deptLevelsOf(store.getUserById("u-head"), snap), { dept1Id: d1.id, dept1: "Host Ops", dept2Id: null, dept2: null, dept3Id: null, dept3: null, isDirect: true, isDirect2: false });
});

test("module host: rbac takes a PersonRow or a user id (the full user row is loaded by id); scopeAllowsLevel1 needs the whole subtree in scope; line projects the subtree", () => {
  const { rbac, line, org } = H.servicesOf("hostdemo");
  calls.canRead.length = 0;
  assert.equal(rbac.canRead("u-read", "hostdemo"), true);
  assert.equal(rbac.canRead(org.getUser("u-read"), "hostdemo"), true);
  assert.equal(rbac.canWrite("u-read", "hostdemo"), false);
  assert.equal(rbac.canWrite({ id: "u-mgr" }, "hostdemo"), true);
  assert.equal(rbac.canRead("nobody", "hostdemo"), false, "an unknown user id has no grants");
  assert.equal(rbac.isSuperAdmin("u-root"), true);
  assert.deepEqual(calls.canRead, ["u-read", "u-read"], "the server function received the full user row both times; an unknown id never reaches it");
  assert.equal(rbac.scopePredicate("u-root"), null);
  assert.equal(typeof rbac.scopePredicate("u-read"), "function");
  assert.equal(rbac.scopeAllowsFor("u-read", "u-emp"), true, "target given as an id");
  store.ensureDepartment("Secret");
  store.ensureDepartment("Secret Unit", store.getDepartmentByName("Secret").id);
  const snap = org.snapshot();
  assert.equal(rbac.scopeAllowsLevel1("u-root", store.getDepartmentByName("Secret").id, snap), true, "no scope → everything");
  assert.equal(rbac.scopeAllowsLevel1("u-read", store.getDepartmentByName("Secret").id, snap), false, "one sub-department out of scope → the level-1 department is out");
  assert.equal(rbac.scopeAllowsLevel1("u-read", store.getDepartmentByName("Host Ops").id, snap), true);
  assert.equal(line.isInReportingLine("u-mgr", "u-emp"), true);
  assert.deepEqual(line.subtreeOf("u-mgr"), [{ userId: "u-emp", depth: 1 }]);
});

test("module host: GET read-only — transaction, write statements, events.publish, notify and defer throw write_in_get; audit is allowed and written at once", async () => {
  BEHAVIOR["x.ctx"] = (ctx, sv) => {
    const errs = {};
    for (const [k, f] of Object.entries({
      tx: () => sv.transaction(() => {}),
      db: () => sv.db.prepare("INSERT INTO hostdemo_rows (who, note) VALUES (?, ?)").run("x", "get"),
      publish: () => sv.events.publish("hostdemo.thing.done", { userId: ctx.user.id }, {}),
      notify: () => sv.notify(ctx.user.id, { type: "t", title: "t" }),
      // defer 的回调在只读区退出之后才执行：GET 里登记它就等于绕开只读（评审 2026-09-26），同样拒绝
      defer: () => sv.defer("sneaky", () => sv.transaction(() => sv.db.prepare("INSERT INTO hostdemo_rows (who, note) VALUES (?, ?)").run("x", "deferred-from-get"))),
    })) { try { f(); errs[k] = "no error"; } catch (e) { errs[k] = e.code; } }
    sv.audit({ action: "read.view", target: ctx.user.id });
    return { body: errs };
  };
  // handleApi 在入口设置请求上下文（actorId、requestId）；这里用 runWithContext 模拟。
  const out = parsed(events.runWithContext({ actorId: "u-emp", requestId: "r-get" }, () => req("GET", "/api/v1/hostdemo/ctx", U.emp)));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { tx: "write_in_get", db: "write_in_get", publish: "write_in_get", notify: "write_in_get", defer: "write_in_get" });
  assert.deepEqual(rows("SELECT note FROM hostdemo_rows WHERE note = 'get'"), []);
  await new Promise((r) => setTimeout(r, 30));   // 之后的事件循环轮次里也没有延后的写入
  assert.deepEqual(rows("SELECT note FROM hostdemo_rows WHERE note = 'deferred-from-get'"), []);
  assert.deepEqual(rows("SELECT actorId, actorName, target, requestId FROM audit_logs WHERE action = 'hostdemo.read.view'"),
    [{ actorId: "u-emp", actorName: "Name u-emp", target: "u-emp", requestId: "r-get" }], "a read audit is written at once (no transaction in a GET)");
  // 只读标志在处理函数返回（或抛错）后复位：之后的写照常
  const s = H.servicesOf("hostdemo");
  store.transaction(() => s.db.prepare("INSERT INTO hostdemo_rows (who, note) VALUES (?, ?)").run("x", "after-get"));
  assert.equal(rows("SELECT COUNT(*) AS n FROM hostdemo_rows WHERE note = 'after-get'")[0].n, 1);
});

test("module host: events.publish is limited to the module's own publishes (event_not_declared) and needs a transaction; audit / notify / afterCommit wait for the commit and vanish on rollback", () => {
  const s = H.servicesOf("hostdemo");
  assert.throws(() => store.transaction(() => s.events.publish("employee.hired", {}, {})), (e) => e.code === "event_not_declared");
  assert.throws(() => s.events.publish("hostdemo.thing.done", {}, {}), /outside a transaction/);
  calls.notify.length = 0;
  const order = [];
  events.runWithContext({ actorId: "u-emp", requestId: "r-ctx1" }, () => {
    store.transaction(() => {
      s.db.prepare("INSERT INTO hostdemo_rows (who, note) VALUES (?, ?)").run("u-emp", "committed");
      s.audit({ action: "rows.add", target: "u-emp", after: { n: 1 } });
      s.notify("u-emp", { type: "hostdemo.done", title: "Done" });
      s.afterCommit(() => order.push("after"), "mine");
      assert.deepEqual(calls.notify, [], "notify inside a transaction waits for the commit");
      assert.equal(rows("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'hostdemo.rows.add'")[0].n, 0);
    });
  });
  assert.deepEqual(order, ["after"]);
  assert.deepEqual(calls.notify, [["u-emp", "hostdemo.done"]]);
  // 审计行排在 afterCommit 队列里（按登记顺序）：登记在它之前的回调看不到它，之后的回调看得到
  const seen = [];
  const hasOrderAudit = () => store.listAudit(20).some((a) => a.action === "hostdemo.rows.order");
  store.transaction(() => {
    s.afterCommit(() => seen.push(["before", hasOrderAudit()]), "before");
    s.audit({ action: "rows.order" });
    s.afterCommit(() => seen.push(["after", hasOrderAudit()]), "after");
  });
  assert.deepEqual(seen, [["before", false], ["after", true]]);
  const au = rows("SELECT actorId, actorName, target, afterJson, requestId FROM audit_logs WHERE action = 'hostdemo.rows.add'");
  assert.deepEqual(au, [{ actorId: "u-emp", actorName: "Name u-emp", target: "u-emp", afterJson: '{"n":1}', requestId: "r-ctx1" }]);
  // 回滚：什么都不留下
  calls.notify.length = 0;
  assert.throws(() => events.runWithContext({ actorId: "u-emp", requestId: "r-ctx2" }, () => store.transaction(() => {
    s.db.prepare("INSERT INTO hostdemo_rows (who, note) VALUES (?, ?)").run("u-emp", "rolled-back");
    s.audit({ action: "rows.gone" });
    s.notify("u-emp", { type: "hostdemo.gone", title: "Gone" });
    s.afterCommit(() => order.push("never"), "gone");
    throw new Error("abort");
  })), /abort/);
  assert.deepEqual(rows("SELECT note FROM hostdemo_rows WHERE note = 'rolled-back'"), []);
  assert.deepEqual(rows("SELECT id FROM audit_logs WHERE action = 'hostdemo.rows.gone'"), []);
  assert.deepEqual(calls.notify, []);
  assert.deepEqual(order, ["after"]);
  // 显式 actorId: null（系统）；非法动作名与不可 JSON 化的 before 当场抛出；通知失败只记日志
  events.runWithContext({ actorId: "u-emp", requestId: "r-ctx3" }, () => s.audit({ action: "sys.run", actorId: null }));
  assert.deepEqual(rows("SELECT actorId, requestId FROM audit_logs WHERE action = 'hostdemo.sys.run'"), [{ actorId: null, requestId: "r-ctx3" }]);
  assert.throws(() => s.audit({ action: "Bad Action" }), /audit: bad action/);
  assert.throws(() => s.audit({ action: "ok", before: { big: 1n } }), TypeError);
  LOGS.length = 0;
  s.notify("u-emp", { type: "explode", title: "x" });
  assert.deepEqual(LOGS, ["[hostdemo] notify failed (Error)"]);
});

test("module host: defer runs on a later turn with the registering request's context restored; a failure is one log line", async () => {
  const s = H.servicesOf("hostdemo");
  const seen = [];
  LOGS.length = 0;
  events.runWithContext({ actorId: "u-emp", requestId: "r-defer" }, () => {
    s.defer("ok", () => seen.push(events.currentContext()));
    s.defer("bad", () => { throw new SyntaxError("nope"); });
    assert.deepEqual(seen, [], "not run synchronously");
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [{ actorId: "u-emp", requestId: "r-defer" }]);
  assert.deepEqual(LOGS, ["[hostdemo] deferred bad failed (SyntaxError)"]);
  assert.throws(() => s.defer("x", null), /fn must be a function/);
});

test("module host: httpError only builds 4xx errors with a code; csv / csvLines are passed through; notifySentSince reads the notification log", () => {
  const s = H.servicesOf("hostdemo");
  const e = s.httpError(409, "already_done", "已完成。", "Already done.", { at: 1 });
  assert.deepEqual([e.status, e.code, e.message, e.details, e.expose], [409, "already_done", "Already done. 已完成。", { at: 1 }, true]);
  assert.throws(() => s.httpError(500, "x", "a", "b"), /400–499/);
  assert.throws(() => s.httpError(400, "Bad-Code", "a", "b"), /code/);
  assert.throws(() => s.httpError(400, "ok", "a", "b", ["not", "object"]), /details/);
  assert.equal(s.csv([["a", "b"]], ["H1", "H2"]), "﻿H1,H2\r\na,b");
  assert.equal(s.csvLines([["a"], ["b"]]), "a\r\nb");
  store.createNotification({ id: "n-host-1", userId: "u-emp", type: "hostdemo.done", title: "Done", link: "/hostdemo/#/x" });
  assert.equal(s.notifySentSince("u-emp", "hostdemo.done", "/hostdemo/#/x", "2000-01-01T00:00:00Z"), true);
  assert.equal(s.notifySentSince("u-emp", "hostdemo.never", null, "2000-01-01T00:00:00Z"), false);
});

// ---------- 工厂与启动校验 ----------

test("module host: init refuses a factory whose handlers / jobs do not match the manifest, an async handler, a factory that throws (message redacted) — and warns about a missing or short raterKey", () => {
  const tryInit = (mode, over) => {
    factoryMode = mode;
    try { const h = host.createModuleHost(baseDeps(over)); h.init(); return h; } finally { factoryMode = "ok"; }
  };
  assert.throws(() => tryInit("missing"), /module factory invalid \[hostdemo\][\s\S]*"x\.read" is declared in the manifest but the factory does not return it/);
  assert.throws(() => tryInit("extra"), /the factory returns "x\.extra", which the manifest does not declare/);
  assert.throws(() => tryInit("async"), /"x\.ctx" must be a synchronous function/);
  assert.throws(() => tryInit("no-jobs"), /jobs must be an object/);
  assert.throws(() => tryInit("throw"), (e) => { assert.match(e.message, /module hostdemo: the factory threw RangeError: factory exploded \[redacted\]/); return true; });
  WARNS.length = 0;
  const h1 = tryInit("ok", { readConfig: () => ({}) });
  assert.equal("raterKey" in h1.servicesOf("hostdemo"), false, "no raterKey member when config.json has none — the module falls back");
  assert.match(WARNS[0], /\[modules\] hostdemo: config\.json "hostdemo\.raterKey" is not set/);
  WARNS.length = 0;
  const h2 = tryInit("ok", { readConfig: () => ({ hostdemo: { raterKey: "  tiny-key-value  " } }) });
  assert.equal(h2.servicesOf("hostdemo").raterKey, "tiny-key-value");
  assert.match(WARNS[0], /shorter than 32 characters/);
  assert.ok(!WARNS.join("\n").includes("tiny-key-value"), "the key itself is never logged");
  assert.throws(() => H.init(), /init\(\) was already called/);
});

test("module host: a module switched off at start-up starts quietly — no raterKey warning, the factory's start-up log lines are not printed — while the key is still injected and later log lines print (2026-09-28)", () => {
  const tryInit = (mode, over) => {
    factoryMode = mode;
    try { const h = host.createModuleHost(baseDeps(over)); h.init(); return h; } finally { factoryMode = "ok"; }
  };
  const OFF = () => ({ learning: true, performance: true, talent: true, hostdemo: false });
  // 关闭 + 没配 raterKey：一行都不打
  WARNS.length = 0; LOGS.length = 0;
  const off = tryInit("log", { readConfig: () => ({}), modulesOn: OFF });
  assert.deepEqual(WARNS, [], "no raterKey warning for a switched-off module");
  assert.deepEqual(LOGS, [], "the factory's start-up log line is not printed either");
  off.servicesOf("hostdemo").log("after start-up");
  assert.deepEqual(LOGS, ["[hostdemo] after start-up"], "the gate closes when the factory returns — run-time log lines print as usual");
  // 关闭 + raterKey 过短：同样不报；key 照常注入（运行中改配置打开模块时用得上）
  WARNS.length = 0;
  const offShort = tryInit("ok", { readConfig: () => ({ hostdemo: { raterKey: "short-key" } }), modulesOn: OFF });
  assert.deepEqual(WARNS, []);
  assert.equal(offShort.servicesOf("hostdemo").raterKey, "short-key");
  // 开关读取失败按关闭处理（不出声，也不接受回跳）
  WARNS.length = 0; LOGS.length = 0;
  const broken = tryInit("log", { readConfig: () => ({}), modulesOn: () => { throw new Error("config unreadable"); } });
  assert.deepEqual([WARNS, LOGS], [[], []]);
  assert.equal(broken.pageLink("/hostdemo/"), null);
  // 开启 + 没配 raterKey：宿主告警、工厂的启动日志照常打印
  WARNS.length = 0; LOGS.length = 0;
  tryInit("log", { readConfig: () => ({}) });
  assert.equal(WARNS.length, 1);
  assert.match(WARNS[0], /\[modules\] hostdemo: config\.json "hostdemo\.raterKey" is not set/);
  assert.deepEqual(LOGS, ["[hostdemo] startup note: rater key not configured"]);
  // 开启 + 配好了：什么都不报
  WARNS.length = 0; LOGS.length = 0;
  tryInit("ok", {});
  assert.deepEqual([WARNS, LOGS], [[], []]);
});

test("module host: the event bus gets the module's own services (the very object its factory got), null before init, undefined for modules without handler routes", () => {
  const fresh = host.createModuleHost(baseDeps());
  assert.equal(fresh.eventServicesFor("hostdemo"), null, "not assembled yet → the bus skips the handlers and records a failure");
  assert.equal(fresh.eventServicesFor("core"), undefined);
  assert.equal(fresh.eventServicesFor("learning"), undefined);
  assert.strictEqual(H.eventServicesFor("hostdemo"), H.servicesOf("hostdemo"));
});

test("module host: startJobs hands the factory's jobs to kernel/jobs.js — today's missed run is caught up once, on the next turn", async () => {
  const sched = H.startJobs();
  assert.strictEqual(H.startJobs(), sched, "idempotent");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  H.stopJobs();
  assert.deepEqual(rows("SELECT note FROM hostdemo_rows WHERE note LIKE 'job:%'").map((r) => r.note), ["job:catchup"]);
  assert.equal(store.getMeta("job:hostdemo.nightly"), new Date(Date.parse("2026-10-20T09:00:00+08:00")).toISOString());
});

// ---------- dispatch ----------

test("dispatch: paths outside every handler gate are not ours (null); inside, misses, wrong methods, PATCH and DELETE are the fixed 404", () => {
  assert.equal(req("GET", "/api/me", U.emp), null);
  assert.equal(req("GET", "/api/v1/hostdemox", U.emp), null);
  assert.equal(req("GET", "/hostdemo/", U.emp), null);
  for (const [m, p] of [["GET", "/api/v1/hostdemo"], ["GET", "/api/v1/hostdemo/nope"], ["POST", "/api/v1/hostdemo/ctx"], ["PATCH", "/api/v1/hostdemo/run"], ["DELETE", "/api/v1/hostdemo/run"], ["GET", "/api/v1/hostdemo/p/1"]]) {
    const out = parsed(req(m, p, U.emp));
    assert.deepEqual([out.status, out.body], [404, host.FIXED.notFound], `${m} ${p}`);
    assert.equal(out.headers["cache-control"], "no-store");
  }
});

test("dispatch: non-GET bodies must be plain objects (400 bad_body) — checked after the route match and before access", () => {
  for (const body of [null, [], "text", 3, true, new Date()]) {
    const out = parsed(req("POST", "/api/v1/hostdemo/run", U.exited, { body }));
    assert.deepEqual([out.status, out.body], [400, host.FIXED.badBody], JSON.stringify(body));
  }
  BEHAVIOR["x.ctx"] = (ctx) => ({ body: { bodyKeys: Object.keys(ctx.body) } });
  assert.deepEqual(parsed(req("GET", "/api/v1/hostdemo/ctx", U.emp, { body: null })).body, { bodyKeys: [] }, "GET ignores whatever body it was given");
});

test("dispatch: access — participant needs in-service; :read without a grant is 404; :manage with read only is 403, without any grant 404; super-admin passes both", () => {
  BEHAVIOR["x.run"] = () => ({ body: { ran: true } });
  BEHAVIOR["x.read"] = () => ({ body: { read: true } });
  BEHAVIOR["x.report"] = () => ({ status: 202, body: { queued: true } });
  BEHAVIOR["x.manage"] = () => ({ status: 204 });
  const cases = [
    [U.exited, "POST", "/api/v1/hostdemo/run", 403, host.FIXED.notInService],
    [U.emp, "POST", "/api/v1/hostdemo/run", 200],
    [U.emp, "GET", "/api/v1/hostdemo/read", 404, host.FIXED.notFound],
    [U.reader, "GET", "/api/v1/hostdemo/read", 200],
    [U.root, "GET", "/api/v1/hostdemo/read", 200],
    [U.emp, "POST", "/api/v1/hostdemo/report", 404, host.FIXED.notFound],
    [U.reader, "POST", "/api/v1/hostdemo/report", 202],
    [U.emp, "PUT", "/api/v1/hostdemo/manage", 404, host.FIXED.notFound],
    [U.reader, "PUT", "/api/v1/hostdemo/manage", 403, host.FIXED.forbidden],
    [U.manager, "PUT", "/api/v1/hostdemo/manage", 204],
    [U.root, "PUT", "/api/v1/hostdemo/manage", 204],
  ];
  for (const [user, m, p, status, body] of cases) {
    const out = req(m, p, user);
    assert.equal(out.status, status, `${user.id} ${m} ${p}: ${out.body}`);
    if (body) assert.deepEqual(JSON.parse(out.body), body, `${user.id} ${m} ${p}`);
    if (status === 204) assert.deepEqual([out.body, out.headers], ["", { "cache-control": "no-store" }]);
  }
});

test("dispatch: ctx — frozen; PersonRow user; params from the already-decoded path (no second decode); first value of repeated query keys in a null-prototype object; lang; Idempotency-Key; now from services.now()", () => {
  BEHAVIOR["x.ctx"] = (ctx) => ({ body: { frozen: Object.isFrozen(ctx), user: ctx.user, query: { ...ctx.query }, proto: Object.getPrototypeOf(ctx.query), lang: ctx.lang, now: ctx.now,
    method: ctx.method, path: ctx.path, requestId: ctx.requestId, route: ctx.route, idem: ctx.idempotencyKey } });
  BEHAVIOR["x.params"] = (ctx) => ({ body: { params: ctx.params, frozen: Object.isFrozen(ctx.params) } });
  const q = new URLSearchParams("a=1&a=2&__proto__=x&b=");
  const out = parsed(req("GET", "/api/v1/hostdemo/ctx", U.emp, { query: q, headers: { "accept-language": "zh-TW", "idempotency-key": "   k1   " } }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { frozen: true, user: H.servicesOf("hostdemo").org.getUser("u-emp"), query: { a: "1", ["__proto__"]: "x", b: "" }, proto: null, lang: "zh",
    now: Date.parse("2026-10-20T09:00:00+08:00"), method: "GET", path: "/api/v1/hostdemo/ctx", requestId: "r-test", route: { handler: "x.ctx", access: "participant", check: null }, idem: "k1" });
  assert.equal(parsed(req("GET", "/api/v1/hostdemo/ctx", U.emp, { headers: { "x-lms-lang": "EN", "accept-language": "zh" } })).body.lang, "en");
  assert.equal(parsed(req("GET", "/api/v1/hostdemo/ctx", U.emp, { headers: { "x-lms-lang": "fr" } })).body.lang, "en");
  assert.equal(parsed(req("GET", "/api/v1/hostdemo/ctx", U.emp, { headers: { "idempotency-key": "  " } })).body.idem, null);
  assert.equal(parsed(req("GET", "/api/v1/hostdemo/ctx", U.emp, { headers: { "idempotency-key": "y".repeat(300) } })).body.idem, "y".repeat(128));
  assert.deepEqual(parsed(req("GET", "/api/v1/hostdemo/p/%41/a b", U.emp)).body, { params: { a: "%41", b: "a b" }, frozen: true });
});

test("dispatch: non-GET runs in one transaction — a throw rolls back rows, outbox events and after-commit work; results are shape-checked inside the transaction (bad shapes roll back too)", () => {
  const n = () => rows("SELECT COUNT(*) AS n FROM hostdemo_rows WHERE note = 'dispatch'")[0].n;
  const ev = () => rows("SELECT COUNT(*) AS n FROM event_outbox WHERE type = 'hostdemo.thing.done'")[0].n;
  const write = (sv, ctx) => {
    sv.db.prepare("INSERT INTO hostdemo_rows (who, note) VALUES (?, ?)").run(ctx.user.id, "dispatch");
    sv.events.publish("hostdemo.thing.done", { userId: ctx.user.id }, { k: 1 });
  };
  let after = 0;
  LOGS.length = 0;
  BEHAVIOR["x.run"] = (ctx, sv) => { write(sv, ctx); sv.afterCommit(() => after++, "count"); throw new Error("token 0123456789abcdef0123456789abcdef in message\nsecond line"); };
  let out = parsed(req("POST", "/api/v1/hostdemo/run", U.emp));
  assert.deepEqual([out.status, out.body], [500, host.FIXED.internal]);
  assert.deepEqual([n(), ev(), after], [0, 0, 0]);
  assert.deepEqual(LOGS, ["[hostdemo] x.run failed: Error: token [redacted] in message | second line"]);
  for (const bad of [undefined, null, "x", { status: 302, body: {} }, { body: "text" }, { body: null }, { csv: { filename: "a.txt", text: "x" } }, { csv: { filename: "a.csv" } }, Promise.resolve({ body: {} }), { body: { big: 1n } }]) {
    BEHAVIOR["x.run"] = (ctx, sv) => { write(sv, ctx); return bad; };
    out = parsed(req("POST", "/api/v1/hostdemo/run", U.emp));
    assert.deepEqual([out.status, out.body], [500, host.FIXED.internal], String(bad && JSON.stringify(bad, (k, v) => (typeof v === "bigint" ? "big" : v))));
    assert.deepEqual([n(), ev()], [0, 0], "rolled back");
  }
  BEHAVIOR["x.run"] = (ctx, sv) => { write(sv, ctx); sv.afterCommit(() => after++, "count"); return { status: 201, body: { ok: true } }; };
  out = parsed(req("POST", "/api/v1/hostdemo/run", U.emp));
  assert.deepEqual([out.status, out.body, n(), ev(), after], [201, { ok: true }, 1, 1, 1]);
  assert.equal(out.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(out.headers["cache-control"], "no-store");
});

test("dispatch: expected refusals — httpError → { error, code, ...details } (error / code cannot be overridden); a non-expose or out-of-range error is the fixed 500", () => {
  BEHAVIOR["x.run"] = (ctx, sv) => { throw sv.httpError(422, "too_late", "太晚了。", "Too late.", { from: "2026-10-01", error: "no", code: "no" }); };
  assert.deepEqual(parsed(req("POST", "/api/v1/hostdemo/run", U.emp)).body, { error: "Too late. 太晚了。", code: "too_late", from: "2026-10-01" });
  assert.equal(req("POST", "/api/v1/hostdemo/run", U.emp).status, 422);
  BEHAVIOR["x.run"] = () => { const e = new Error("looks public"); e.status = 409; e.code = "x"; throw e; };
  assert.deepEqual(parsed(req("POST", "/api/v1/hostdemo/run", U.emp)), { status: 500, body: host.FIXED.internal, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  BEHAVIOR["x.run"] = () => { const e = new Error("server-side"); e.status = 503; e.code = "x"; e.expose = true; throw e; };
  assert.equal(req("POST", "/api/v1/hostdemo/run", U.emp).status, 500);
});

test("dispatch: CSV results become an attachment; slow handlers are logged (threshold configurable)", () => {
  BEHAVIOR["x.read"] = (ctx, sv) => ({ csv: { filename: "rows-2026.csv", text: sv.csv([["1"]], ["h"]) } });
  const out = req("GET", "/api/v1/hostdemo/read", U.reader);
  assert.deepEqual(out, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="rows-2026.csv"', "cache-control": "no-store" }, body: "﻿h\r\n1" });
  const slow = host.createModuleHost(baseDeps({ slowMs: -1 }));
  slow.init();
  LOGS.length = 0;
  BEHAVIOR["x.ctx"] = () => ({ body: {} });
  slow.dispatch({ method: "GET", path: "/api/v1/hostdemo/ctx", query: new URLSearchParams(), headers: {}, body: {}, user: U.emp, requestId: "r" });
  assert.match(LOGS[0], /^\[hostdemo\] slow x\.ctx \d+ms$/);
});

test("dispatch: a module whose factory was never called answers the fixed 500 (the gate is still recognised)", () => {
  const raw = host.createModuleHost(baseDeps());
  LOGS.length = 0;
  const out = raw.dispatch({ method: "GET", path: "/api/v1/hostdemo/ctx", query: new URLSearchParams(), headers: {}, body: {}, user: U.emp, requestId: "r" });
  assert.deepEqual(parsed(out).body, host.FIXED.internal);
  assert.deepEqual(LOGS, ["[hostdemo] x.ctx failed: module not initialised"]);
  assert.equal(raw.isHandlerPath("/api/v1/hostdemo/anything"), true);
  assert.equal(raw.isHandlerPath("/api/v1/other"), false);
});

test("dispatch: an unexpected failure outside the handler (here: no session user at all) is still the fixed 500 with one redacted log line — never an exception for handleApi's outer catch", () => {
  LOGS.length = 0;
  const out = req("GET", "/api/v1/hostdemo/ctx", null);
  assert.deepEqual(parsed(out).body, host.FIXED.internal);
  assert.equal(LOGS.length, 1);
  assert.match(LOGS[0], /^\[modules\] dispatch of GET \/api\/v1\/hostdemo\/ctx failed: TypeError: /);
});

// ---------- 静态挂载与站内回跳白名单 ----------

test("module host: staticMountOf answers on the normalized lower-case shape; pageLink accepts only in-site paths under a module mount", () => {
  assert.equal(H.staticMountOf("/hostdemo/app.js").module, "hostdemo");
  assert.equal(H.staticMountOf("/hostdemo").prefix, "/hostdemo");
  assert.equal(H.staticMountOf("/hostdemox/app.js"), null);
  const ok = ["/hostdemo/", "/hostdemo/#/home", "/hostdemo/index.html?x=1&y=2", "/hostdemo/a/b.js"];
  const bad = ["/hostdemo", "/HOSTDEMO/", "/hostdemox/", "//hostdemo/", "https://evil.example/hostdemo/", "/hostdemo/../admin", "/hostdemo/./x",
    "/hostdemo/%2e%2e/", "/hostdemo\\x", "/hostdemo/..\\admin", "/hostdemo/a\\b.js", "/hostdemo/ x", "/hostdemo/é", "/hostdemo/#//evil", "/", "/#/login", "", null, undefined, 5, {}, "/hostdemo/" + "a".repeat(600)];
  for (const v of ok) assert.equal(H.pageLink(v), v, v);
  for (const v of bad) assert.equal(H.pageLink(v), null, JSON.stringify(v));
  assert.equal(host.pageLinkIn([], "/hostdemo/"), null, "no mounts (culture not installed) → nothing is accepted");
  for (const v of ok) assert.equal(H.pageLinker()(v), v, "pageLinker: " + v);
});

test("module host: pageLink only accepts pages of a switched-ON module — the switch is read live on every call, pageLinker reads it once (2026-09-28)", () => {
  let on = true;
  const h = host.createModuleHost(baseDeps({ modulesOn: () => ({ learning: true, performance: true, talent: true, hostdemo: on }) }));
  assert.equal(h.pageLink("/hostdemo/#/home"), "/hostdemo/#/home");
  const linkerOn = h.pageLinker();
  on = false;
  assert.equal(h.pageLink("/hostdemo/#/home"), null, "switched off → the next falls back (the mount is a 404)");
  assert.equal(h.pageLink("/hostdemo/"), null);
  assert.equal(h.pageLinker()("/hostdemo/"), null);
  assert.equal(linkerOn("/hostdemo/"), "/hostdemo/", "a linker keeps the switches it read when it was made (one request)");
  on = true;
  assert.equal(h.pageLink("/hostdemo/"), "/hostdemo/", "switched back on → accepted again, no restart");
  // 开关里没有这个模块的键（真实服务端对每个可售模块都给布尔值）：按关闭
  const h2 = host.createModuleHost(baseDeps({ modulesOn: () => ({ learning: true }) }));
  assert.equal(h2.pageLink("/hostdemo/"), null);
  // staticMountOf 不看开关（serveStatic 在它之前已按开关回 404）
  assert.equal(h2.staticMountOf("/hostdemo/app.js").module, "hostdemo");
});
