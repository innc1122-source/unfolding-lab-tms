// 第二段 · server.js 接线（接入方式 B）的 HTTP 验证 —— 用测试专用的演示模块 demo：
//   在系统临时目录起服务器副本（server.js、store.js、kernel/、M0 四个模块原样复制，modules/ 多装一个 demo，
//   store.js 的能力域清单里 demo 顶替 culture 的位置），经 test/helpers.js 启动
//   （临时 config、实例指纹核对）。副本用自己的临时库与临时 config，不碰仓库的 lms.db / config.json。
// 覆盖 modules/culture/CONTRACT.md 3.5（分发前置顺序与固定应答、access 判定、GET 只读、非 GET 事务、审计与事件在
// 提交之后、CSV / 204 应答）、第 4 节 services 的接线、第 7 节任务调度（启动补跑）、第 8 节模块迁移（重启不重跑、
// 一次备份、改动已执行文件拒绝启动）、9.1 静态挂载、9.5 登录回跳与改密 code、6.1 core 订阅写人才记录，
// 以及 defaultOn（没写配置时模块关闭：API 与静态目录都 404，任务与钩子不跑，迁移与工厂照常）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { DatabaseSync } = require("node:sqlite");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs, tempDir } = require("./helpers.js");

// ---------- 演示模块 ----------
const FAKE_NOW = "2026-10-20T01:00:00+08:00";
const RATER_KEY = "k".repeat(40);
const DEMO = {
  "manifest.js": `"use strict";
module.exports = {
  id: "demo", name: { zh: "演示", en: "Demo" }, version: "0.0.1", sellable: true, defaultOn: false,
  requires: ["core"], optional: [],
  domains: [{ id: "demo", name: { zh: "演示", en: "Demo" }, order: 45 }],
  gate: ["/api/v1/demo", "/api/v1/me/demo"],
  static: [{ prefix: "/demo", dir: "./public", entry: "index.html" }],
  routes: [
    { method: "GET", path: "/api/v1/me/demo/hello", domain: null, access: "participant", handler: "me.hello" },
    { method: "GET", path: /^\\/api\\/v1\\/me\\/demo\\/echo\\/([^/]+)$/, params: ["value"], domain: null, access: "participant", handler: "me.echo" },
    { method: "POST", path: "/api/v1/me/demo/items", domain: null, access: "participant", handler: "me.add" },
    { method: "PUT", path: /^\\/api\\/v1\\/me\\/demo\\/items\\/(\\d+)$/, params: ["itemId"], domain: null, access: "participant", handler: "me.rename" },
    { method: "POST", path: "/api/v1/me/demo/boom", domain: null, access: "participant", handler: "me.boom" },
    { method: "POST", path: "/api/v1/me/demo/reject", domain: null, access: "participant", handler: "me.reject" },
    { method: "GET", path: "/api/v1/me/demo/sneaky", domain: null, access: "participant", handler: "me.sneaky" },
    { method: "GET", path: "/api/v1/me/demo/bad-result", domain: null, access: "participant", handler: "me.badResult" },
    { method: "GET", path: "/api/v1/demo/items", domain: null, access: "demo:read", handler: "items.list" },
    { method: "GET", path: "/api/v1/demo/items.csv", domain: null, access: "demo:read", handler: "items.csv" },
    { method: "POST", path: "/api/v1/demo/reports", domain: null, access: "demo:read", readonly: true, handler: "reports.create" },
    { method: "PUT", path: "/api/v1/demo/settings", domain: null, access: "demo:manage", handler: "settings.save" },
    { method: "POST", path: "/api/v1/demo/programs/complete", domain: null, access: "demo:manage", handler: "programs.complete" },
  ],
  migrations: "./migrations",
  tables: ["demo_items"],
  publishes: ["demo.item.added", "culture.program.completed"],
  subscribes: ["employee.transferred"],
  jobs: [{ id: "tick", cron: "0 0 * * *" }],
};
`,
  "hooks.js": `"use strict";
module.exports = {
  // 钩子拿到的 services 必须就是工厂拿到的那一个（同一引用）；写库自己开事务。
  "employee.transferred": (event, ctx) => {
    const same = ctx.services === require("./index.js").lastServices;
    ctx.services.transaction(() => ctx.services.db.prepare("INSERT INTO demo_items (userId, name, source, createdAt) VALUES (?, ?, ?, ?)")
      .run(event.subject.userId || null, same ? "same-services" : "other-services", "hook", new Date(ctx.services.now()).toISOString()));
  },
};
`,
  "index.js": `"use strict";
const hooks = require("./hooks.js");
function factory(services) {
  factory.lastServices = services;
  const db = services.db;
  const ins = (userId, name, source) => db.prepare("INSERT INTO demo_items (userId, name, source, createdAt) VALUES (?, ?, ?, ?)")
    .run(userId, name, source, new Date(services.now()).toISOString());
  // 工厂在模块迁移之后才被调用：表已存在。userId 列记本进程的 pid：helpers.startServer 遇到端口撞车会用同一个库
  // 重启一次，撞车的那次在 listen 之前已经跑过工厂 —— 断言按进程核对，不按行数。
  services.transaction(() => ins(String(process.pid), "factory", "factory"));
  const handlers = {
    "me.hello": (ctx) => ({ body: {
      user: ctx.user, query: ctx.query, lang: ctx.lang, method: ctx.method, path: ctx.path, requestId: ctx.requestId,
      route: ctx.route, idempotencyKey: ctx.idempotencyKey, now: ctx.now, frozen: Object.isFrozen(ctx) && Object.isFrozen(ctx.user),
      bodyKeys: Object.keys(ctx.body), serviceKeys: Object.keys(services).sort(), servicesFrozen: Object.isFrozen(services) && Object.isFrozen(services.org),
      tz: services.tz, isProduction: services.isProduction(), raterKeyLength: typeof services.raterKey === "string" ? services.raterKey.length : 0,
    } }),
    "me.echo": (ctx) => ({ body: { params: ctx.params } }),
    "me.add": (ctx) => {
      const name = String(ctx.body.name || "");
      if (!name) throw services.httpError(400, "bad_request", "缺少名称。", "Name is required.", { field: "name" });
      const id = Number(ins(ctx.user.id, name, "request").lastInsertRowid);
      services.events.publish("demo.item.added", { userId: ctx.user.id }, { itemId: id });
      services.audit({ action: "items.add", target: ctx.user.id, after: { itemId: id } });
      services.notify(ctx.user.id, { type: "demo.added", title: "Item added", title_zh: "已添加", link: "/demo/#/items" });
      return { status: 201, body: { id } };
    },
    "me.rename": (ctx) => {
      const r = db.prepare("UPDATE demo_items SET name = ? WHERE id = ? AND userId = ?").run(String(ctx.body.name || ""), Number(ctx.params.itemId), ctx.user.id);
      if (!r.changes) throw services.httpError(404, "not_found", "未找到。", "Not found.");
      return { body: { ok: true, itemId: ctx.params.itemId } };
    },
    "me.boom": (ctx) => {
      ins(ctx.user.id, "boom", "request");
      services.events.publish("demo.item.added", { userId: ctx.user.id }, { itemId: -1 });
      services.audit({ action: "items.boom", target: ctx.user.id });
      services.notify(ctx.user.id, { type: "demo.boom", title: "boom" });
      services.afterCommit(() => ins(ctx.user.id, "after-commit", "request"), "boom");
      throw new Error("secret 0123456789abcdef0123456789abcdef0123 exploded");
    },
    "me.reject": () => { throw services.httpError(409, "demo_rejected", "不行。", "Nope.", { error: "overridden?", code: "x", extra: 1 }); },
    "me.sneaky": (ctx) => {
      const what = ctx.query.what;
      if (what === "tx") services.transaction(() => ins(ctx.user.id, "sneaky", "get"));
      else if (what === "db") ins(ctx.user.id, "sneaky", "get");
      else if (what === "publish") services.events.publish("demo.item.added", { userId: ctx.user.id }, { itemId: 0 });
      else if (what === "notify") services.notify(ctx.user.id, { type: "demo.sneaky", title: "sneaky" });
      else if (what === "audit") services.audit({ action: "items.view", target: ctx.user.id });
      return { body: { ok: true } };
    },
    "me.badResult": (ctx) => (ctx.query.kind === "promise" ? Promise.resolve({ body: {} }) : ctx.query.kind === "status" ? { status: 302, body: {} } : ctx.query.kind === "text" ? { body: "text" } : undefined),
    "items.list": () => ({ body: { items: db.prepare("SELECT id, userId, name, source FROM demo_items ORDER BY id").all() } }),
    "items.csv": () => ({ csv: { filename: "demo-items.csv", text: services.csv([["=1+1", "a,b"], ["x", "line\\nbreak"]], ["名称 Name", "备注 Note"]) } }),
    "reports.create": (ctx) => ({ status: 202, body: { id: Number(ins(ctx.user.id, "report", "readonly-post").lastInsertRowid) } }),
    "settings.save": () => ({ status: 204 }),
    "programs.complete": (ctx) => {
      const ids = Array.isArray(ctx.body.userIds) ? ctx.body.userIds : [];
      for (const userId of ids) services.events.publish("culture.program.completed", { userId }, {
        programId: ctx.body.programId, programName: "Demo Program", startDate: "2026-10-26", endDate: ctx.body.endDate,
        track: "leader", participantStatus: "active", dept1Id: null, dept1: "Ops", weeksRequired: 6, weeksMet: 5, totalPoints: 321,
        tasksSubmitted: 6, tasksWitnessed: 4, cardsGiven: 3, cardsReceived: 2,
      });
      return { body: { published: ids.length } };
    },
  };
  const jobs = {
    tick: (jobCtx) => {
      services.transaction(() => ins(null, "tick:" + jobCtx.trigger, "job"));
      services.audit({ action: "job.tick", after: { trigger: jobCtx.trigger } });
      return { ok: 1 };
    },
  };
  return { handlers, hooks, jobs };
}
module.exports = factory;
`,
  "migrations/demo-0001.sql": "CREATE TABLE IF NOT EXISTS demo_items (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  userId TEXT,\n  name TEXT NOT NULL,\n  source TEXT NOT NULL,\n  createdAt TEXT NOT NULL\n);\n",
  "public/index.html": "<!doctype html><title>demo learner app</title>\n",
  "public/app.js": "window.DEMO_APP = 1;\n",
  "public/app.css": "body{margin:0}\n",
  "public/notes.txt": "not in the MIME table\n",
  "public/.hidden.js": "window.HIDDEN = 1;\n",
  "public/sub/page.js": "window.SUB = 1;\n",
  "secret/leak.js": "window.LEAK = 1;\n",
};

const LARK_USER = { name: "Lara Demo", union_id: "on_demo_next", open_id: "ou_demo_next", user_id: "LKDEMO-001", email: "" };
const LARK_STUB = [
  '"use strict";',
  "const realFetch = globalThis.fetch;",
  `const USER = ${JSON.stringify(LARK_USER)};`,
  "globalThis.fetch = async (url, init) => {",
  "  const u = String(url);",
  '  if (!u.startsWith("https://open.larksuite.com/")) return realFetch(url, init);',
  '  const body = u.includes("/auth/v3/app_access_token/") ? { code: 0, app_access_token: "t-app" }',
  '    : u.includes("/authen/v1/oidc/access_token") ? { code: 0, data: { access_token: "t-user" } }',
  "    : { code: 0, data: USER };",
  '  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });',
  "};",
  "",
].join("\n");

const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
function makeCopy() {
  const dir = tempDir("module-host-http-");   // 测试进程退出时由 helpers 兜底删除（after 没跑到也不留残余）
  for (const f of ["server.js", "notify.js", "content.js", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  // 副本不装 culture（2026-09-26 起已登记进仓库的 modules/index.js）：demo 与 culture 的能力域都是 order 45，demo 还发布
  // culture.program.completed 来验证 core 的订阅 —— 这两处与 culture 同装会被注册表拒绝。culture 自己在真实服务上的接线
  // 由 test/culture-http.test.js 验证。
  // store.js：能力域清单里 demo 顶替 culture（排在 talent 之后，与 manifest 的 order 45 一致）—— 否则自定义角色存不下 demo 授权。
  const storeSrc = fs.readFileSync(path.join(ROOT, "store.js"), "utf8");
  const from = 'const RBAC_DOMAINS = ["people", "learning", "performance", "talent", "fields",';   // Unfolding Lab 版：清单里已无 culture，demo 插在 talent 之后
  assert.equal(storeSrc.split(from).length, 2, "store.js RBAC_DOMAINS literal");
  fs.writeFileSync(path.join(dir, "store.js"), storeSrc.replace(from, 'const RBAC_DOMAINS = ["people", "learning", "performance", "talent", "demo", "fields",'));
  fs.cpSync(path.join(ROOT, "kernel"), path.join(dir, "kernel"), { recursive: true });
  // ai（AI 辅助，2026-09-29 登记）一并装进副本：server.js 直接 require modules/ai/ 下的服务与功能文件
  const installed = require("../modules/index.js").filter((id) => id !== "culture");
  assert.deepEqual(installed, ["core", "learning", "performance", "talent", "ai"]);
  for (const id of installed) fs.cpSync(path.join(ROOT, "modules", id), path.join(dir, "modules", id), { recursive: true });
  fs.writeFileSync(path.join(dir, "modules", "index.js"), crlf('"use strict";\nmodule.exports = ' + JSON.stringify([...installed, "demo"]) + ";\n"));
  for (const [rel, text] of Object.entries(DEMO)) {
    const f = path.join(dir, "modules", "demo", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, crlf(text));
  }
  // public/ 里一个真实路径越出 public/ 的目录链接（Windows 用 junction，不需要管理员权限；其它系统按符号链接处理）：
  // 路径形状在 public/ 之内，只有 serveModuleStatic 的 realpath 判定能把它挡住。
  fs.symlinkSync(path.join(dir, "modules", "demo", "secret"), path.join(dir, "modules", "demo", "public", "linked"), "junction");
  fs.mkdirSync(path.join(dir, "public", "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "dist", "index.html"), "<!doctype html><title>TMS shell</title>");
  fs.writeFileSync(path.join(dir, "lark-fetch-stub.js"), LARK_STUB);
  return dir;
}

let dir, A, B;   // A: demo 开启（config modules.demo = true）；B: 没写配置（defaultOn:false → 关闭）
let people;
const rows = (srv, sql, ...args) => { const db = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return db.prepare(sql).all(...args).map((r) => ({ ...r })); } finally { db.close(); } };
const aDir = () => path.join(dir, "a");
// 工厂每次启动恰好运行一次：正在服务的那个进程恰好写了一行、每个进程至多一行（端口撞车时 helpers.startServer 用同一个库
// 重启，撞车那次在 listen 之前也跑过工厂，所以不能按总行数断言）。返回各行记下的 pid。
function factoryOncePerProcess(srv) {
  const pids = rows(srv, "SELECT userId, name FROM demo_items WHERE source = 'factory' ORDER BY id").map((r) => { assert.equal(r.name, "factory"); return r.userId; });
  assert.equal(new Set(pids).size, pids.length, "at most one factory row per process: " + pids.join(", "));
  assert.equal(pids.filter((p) => p === String(srv.child.pid)).length, 1, `the serving process (pid ${srv.child.pid}) ran the factory exactly once: ${pids.join(", ")}`);
  return pids;
}

async function bootA() {
  return startServer({
    root: dir, dbPath: path.join(aDir(), "a.db"),
    env: { LMS_FAKE_NOW: FAKE_NOW, NODE_OPTIONS: `--require "${path.join(dir, "lark-fetch-stub.js").replace(/\\/g, "/")}"` },
  });
}

// 建员工 → 改首登密码（changePw 为 false 时保留临时密码）→ { id, client, password }。
async function makePerson(base, admin, empId, patch, changePw = true) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId + " " + JSON.stringify(created.data));
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  if (patch) assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  const c = await loginAs(base, { employeeId: empId, password: created.data.password });
  let password = created.data.password;
  if (changePw) {
    password = empId + "-pw-2026";
    assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: password })).status, 200);
  }
  return { id: u.id, client: c, password };
}
async function makeRole(admin, name, grants) {
  const r = await admin.post("/api/admin/roles", { name, grants });
  assert.equal(r.status, 200, "role " + name + " " + JSON.stringify(r.data));
  return r.data.role ? r.data.role.id : r.data.id;
}

before(async () => {
  dir = makeCopy();
  fs.mkdirSync(aDir());
  fs.writeFileSync(path.join(aDir(), "config.json"), JSON.stringify({
    modules: { demo: true },
    demo: { raterKey: RATER_KEY },
    lark: { appId: "cli_test_only", appSecret: "test-only-secret", redirectUri: "http://127.0.0.1/api/auth/lark/callback" },
  }));
  fs.mkdirSync(path.join(dir, "b"));
  [A, B] = await Promise.all([bootA(), startServer({ root: dir, dbPath: path.join(dir, "b", "b.db") })]);
  const admin = await loginAs(A.base, ADMIN);
  const readRole = await makeRole(admin, "Demo reader", { demo: "read" });
  const manageRole = await makeRole(admin, "Demo operator", { demo: "manage" });
  const learningRole = (await admin.get("/api/admin/roles")).data.roles.find((r) => r.key === "learning-admin").id;
  people = {
    admin,
    employee: await loginAs(A.base, EMPLOYEE),
    reader: await makePerson(A.base, admin, "DM-READ", { adminRoleId: readRole }),
    operator: await makePerson(A.base, admin, "DM-OPS", { adminRoleId: manageRole }),
    otherAdmin: await makePerson(A.base, admin, "DM-LEARN", { adminRoleId: learningRole }),
    exited: await makePerson(A.base, admin, "DM-EXIT", { empStatus: "exited" }),
    temp: await makePerson(A.base, admin, "DM-TEMP", null, false),
  };
  people.employeeId = (await people.employee.get("/api/me")).data.id;
});
after(async () => {
  for (const s of [A, B]) if (s) await s.stopAsync();
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} }
});

const NOT_FOUND = { error: "Not found. 未找到。", code: "not_found" };
const FORBIDDEN = { error: "You don't have access to this. 你没有此项操作的权限。", code: "forbidden" };
const NOT_IN_SERVICE = { error: "Your account is not active. 你的账号不是在职状态。", code: "not_in_service" };
const BAD_BODY = { error: "The request body must be a JSON object. 请求内容必须是 JSON 对象。", code: "bad_body" };
const INTERNAL = { error: "Server error. Please try again later. 服务器错误，请稍后再试。", code: "internal" };
const c = (k) => (people[k].client || people[k]);
async function send(client, method, p, bodyText, headers) {
  // helpers 的 raw() 总把 body JSON.stringify；这里要发任意文本（非法 JSON、数组……），所以带上会话 cookie 直接 fetch。
  const cookie = COOKIES.get(client) || "";
  const r = await fetch(client.__base + p, { method, headers: { "content-type": "application/json", cookie, ...(headers || {}) }, body: bodyText, redirect: "manual" });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
// helpers 的客户端不暴露会话 cookie（只在登录时下发）：这里登录时自己留一份。
const COOKIES = new Map();
async function loginRaw(base, creds) {
  const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds) });
  const m = (r.headers.getSetCookie() || []).map((x) => /^sid=([^;]*)/.exec(x)).find(Boolean);
  return { status: r.status, data: await r.json(), cookie: m ? "sid=" + m[1] : "" };
}
async function rawClient(base, creds) {
  const l = await loginRaw(base, creds);
  assert.equal(l.status, 200, JSON.stringify(l.data));
  const client = { __base: base };
  COOKIES.set(client, l.cookie);
  client.req = (method, p, bodyText, headers) => send(client, method, p, bodyText, headers);
  client.json = async (method, p, obj, headers) => { const r = await send(client, method, p, obj === undefined ? undefined : JSON.stringify(obj), headers); return { ...r, data: r.text ? JSON.parse(r.text) : null }; };
  return client;
}

// ---------- 启动顺序：迁移 → 工厂 → 任务 ----------

test("wiring: module migrations ran before the factory (one module_migrations row, the factory wrote into the migrated table), and the pre-migration backup exists once", async () => {
  const mig = rows(A, "SELECT id, module, file FROM module_migrations");
  assert.deepEqual(mig.map((r) => [r.id, r.module, r.file]), [["demo-0001", "demo", "demo-0001.sql"]]);
  assert.equal(factoryOncePerProcess(A).length >= 1, true);
  const backups = fs.readdirSync(path.join(aDir(), "backups")).filter((f) => f.includes("-pre-migration-vmodules-"));
  assert.equal(backups.length, 1, backups.join(", "));
  assert.match(backups[0], /^lms-\d{8}-\d{6}-pre-migration-vmodules-demo-0001\.db$/);
  // 模块关闭（B）时同样迁移、同样调用工厂
  assert.deepEqual(rows(B, "SELECT id FROM module_migrations").map((r) => r.id), ["demo-0001"]);
  factoryOncePerProcess(B);
});

test("wiring: the scheduler caught up today's missed job at start-up (trigger catchup, services.now() = LMS_FAKE_NOW), with no acting user; a switched-off module's jobs never run", async () => {
  let ran = [];
  for (let i = 0; i < 50 && !ran.length; i++) {
    ran = rows(A, "SELECT name FROM demo_items WHERE source = 'job'");
    if (!ran.length) await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(ran.map((r) => r.name), ["tick:catchup"]);
  const meta = rows(A, "SELECT value FROM meta WHERE key = 'job:demo.tick'");
  assert.equal(meta.length, 1);
  assert.equal(Date.parse(meta[0].value), Date.parse(FAKE_NOW), "the run time comes from the module's services.now()");
  const audit = rows(A, "SELECT actorId, actorName, requestId, afterJson FROM audit_logs WHERE action = 'demo.job.tick'");
  assert.deepEqual(audit.map((a) => [a.actorId, a.actorName, a.requestId, JSON.parse(a.afterJson).trigger]), [[null, null, "job-demo.tick", "catchup"]]);
  assert.deepEqual(rows(B, "SELECT name FROM demo_items WHERE source = 'job'"), []);
  assert.deepEqual(rows(B, "SELECT value FROM meta WHERE key = 'job:demo.tick'"), [], "a switched-off module's job is skipped without recording a run");
  // 2026-09-28：raterKey 缺失的启动告警只在模块开启时打印 —— B 关闭且没配，不报（开启而没配的情况见
  // kernel-module-host.test.js 与 culture-switch.test.js）。
  assert.doesNotMatch(B.stderr(), /raterKey|rater key/i, "switched off on B: no rater key warning at start-up");
  assert.doesNotMatch(A.stderr(), /raterKey/, "configured on A");
});

test("wiring: services and ctx have the contract's shape — frozen, the full CONTRACT.md §4 member list, PersonRow user without sensitive fields, raterKey from config.json demo.raterKey", async () => {
  const r = await people.employee.get("/api/v1/me/demo/hello");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b = r.data;
  // CX-166（契约 v39）：services.dataDir = 模块数据目录
  assert.deepEqual(b.serviceKeys, ["afterCommit", "audit", "bilingual", "csv", "csvLines", "dataDir", "db", "defer", "events", "httpError", "isProduction", "line", "log",
    "notify", "notifySentSince", "now", "org", "raterKey", "rbac", "transaction", "tz"]);
  assert.equal(b.servicesFrozen, true);
  assert.equal(b.frozen, true);
  assert.deepEqual(Object.keys(b.user), ["id", "employeeId", "name", "department", "managerId", "jobLevel", "position", "active", "empStatus", "inService", "system"]);   // position：CX-051（2026-10-09）
  assert.equal(b.user.id, people.employeeId);
  assert.equal(b.user.inService, true);
  assert.deepEqual(b.bodyKeys, []);
  assert.deepEqual(b.tz, { offsetMinutes: 480, label: "+08:00" });
  assert.equal(b.isProduction, false);
  assert.equal(b.now, Date.parse(FAKE_NOW), "ctx.now = services.now(), which honours LMS_FAKE_NOW outside production");
  assert.equal(b.raterKeyLength, RATER_KEY.length);
  assert.deepEqual(b.route, { handler: "me.hello", access: "participant", check: null });
  assert.equal(b.method, "GET");
  assert.equal(b.path, "/api/v1/me/demo/hello");
  assert.match(b.requestId, /^r-[0-9a-f]{8}$/);
  assert.equal(b.idempotencyKey, null);
});

test("wiring: ctx.query keeps the first of repeated keys, params are not decoded a second time, lang follows X-LMS-Lang then Accept-Language, Idempotency-Key is trimmed and capped at 128", async () => {
  const emp = await rawClient(A.base, EMPLOYEE);
  const q = await emp.json("GET", "/api/v1/me/demo/hello?a=1&a=2&b=x%20y");
  assert.deepEqual(q.data.query, { a: "1", b: "x y" });
  assert.equal(q.data.lang, "en", "no language headers → en");
  assert.equal((await emp.json("GET", "/api/v1/me/demo/hello", undefined, { "accept-language": "zh-CN,zh;q=0.9" })).data.lang, "zh");
  assert.equal((await emp.json("GET", "/api/v1/me/demo/hello", undefined, { "x-lms-lang": "en", "accept-language": "zh-CN" })).data.lang, "en");
  assert.equal((await emp.json("GET", "/api/v1/me/demo/hello", undefined, { "x-lms-lang": "zh" })).data.lang, "zh");
  assert.equal((await emp.json("GET", "/api/v1/me/demo/hello", undefined, { "idempotency-key": "  key-1  " })).data.idempotencyKey, "key-1");
  assert.equal((await emp.json("GET", "/api/v1/me/demo/hello", undefined, { "idempotency-key": "x".repeat(200) })).data.idempotencyKey, "x".repeat(128));
  // %2541 → 路径解码一次得 %41，捕获组原样（二次解码会变成 A）
  assert.deepEqual((await emp.json("GET", "/api/v1/me/demo/echo/%2541")).data.params, { value: "%41" });
  assert.deepEqual((await emp.json("GET", "/api/v1/me/demo/echo/a%20b")).data.params, { value: "a b" });
});

// ---------- 分发前置与固定应答（CONTRACT.md 3.5、附录 B）----------

test("dispatch: 401 before anything module-specific; cross-origin writes 403; gate misses, wrong methods, PATCH and DELETE are the fixed 404; JSON answers are no-store", async () => {
  const anon = await fetch(A.base + "/api/v1/me/demo/hello");
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { error: "Not logged in" });
  const emp = await rawClient(A.base, EMPLOYEE);
  const xo = await emp.req("POST", "/api/v1/me/demo/items", JSON.stringify({ name: "x" }), { origin: "http://evil.example" });
  assert.equal(xo.status, 403);
  assert.deepEqual(JSON.parse(xo.text), { error: "Cross-origin request rejected." });
  const same = await emp.req("POST", "/api/v1/me/demo/reject", "{}", { origin: A.base });
  assert.equal(same.status, 409, "a same-origin write passes the Origin check");
  for (const [m, p] of [["GET", "/api/v1/demo"], ["GET", "/api/v1/demo/nope"], ["GET", "/api/v1/me/demo/items"], ["POST", "/api/v1/me/demo/hello"],
    ["PATCH", "/api/v1/me/demo/items/1"], ["DELETE", "/api/v1/me/demo/items/1"], ["PUT", "/api/v1/me/demo/items/abc"], ["GET", "/api/v1/me/demo/hello/"]]) {
    const r = await emp.req(m, p, m === "GET" ? undefined : "{}");
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.deepEqual(JSON.parse(r.text), NOT_FOUND, `${m} ${p}`);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  const ok = await emp.req("GET", "/api/v1/me/demo/hello");
  assert.equal(ok.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("dispatch: a body that is not a JSON object is 400 bad_body — invalid JSON too, inside the gate only (outside it keeps the old 'invalid JSON' body)", async () => {
  const emp = await rawClient(A.base, EMPLOYEE);
  for (const text of ["[]", "null", "\"str\"", "3", "true", "{bad", "{\"a\":"]) {
    const r = await emp.req("POST", "/api/v1/me/demo/items", text);
    assert.equal(r.status, 400, text);
    assert.deepEqual(JSON.parse(r.text), BAD_BODY, text);
  }
  const put = await emp.req("PUT", "/api/v1/me/demo/items/1", "[1]");
  assert.deepEqual([put.status, JSON.parse(put.text)], [400, BAD_BODY]);
  // 空请求体按 {} 处理
  const empty = await emp.req("POST", "/api/v1/me/demo/items", "");
  assert.deepEqual([empty.status, JSON.parse(empty.text)], [400, { error: "Name is required. 缺少名称。", code: "bad_request", field: "name" }]);
  // gate 外：原样
  const outside = await emp.req("POST", "/api/me/notifications/read", "{bad");
  assert.deepEqual([outside.status, JSON.parse(outside.text)], [400, { error: "invalid JSON" }]);
  // 请求体在登录闸门之前读取：未登录的非法 JSON 也是 bad_body（与模块测试夹具同一口径）
  const anon = await fetch(A.base + "/api/v1/me/demo/items", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
  assert.deepEqual([anon.status, await anon.json()], [400, BAD_BODY]);
});

test("dispatch: a temporary password answers 403 with code password_change_required (and /api/me still works)", async () => {
  const r = await people.temp.client.get("/api/v1/me/demo/hello");
  assert.equal(r.status, 403);
  assert.deepEqual(r.data, { error: "Please change your temporary password first.", code: "password_change_required" });
  const other = await people.temp.client.get("/api/me/notifications");
  assert.deepEqual(other.data, { error: "Please change your temporary password first.", code: "password_change_required" }, "the same answer outside the module");
  assert.equal((await people.temp.client.get("/api/me")).status, 200);
});

test("dispatch: access matrix — participant needs in-service; :read without a grant is the same 404 as a missing route; :manage with read only is 403; super-admin passes", async () => {
  const cases = [
    // [identity, method, path, body, expected status, expected body (for errors)]
    ["employee", "GET", "/api/v1/me/demo/hello", undefined, 200],
    ["exited", "GET", "/api/v1/me/demo/hello", undefined, 403, NOT_IN_SERVICE],
    ["exited", "POST", "/api/v1/me/demo/items", { name: "x" }, 403, NOT_IN_SERVICE],
    ["reader", "GET", "/api/v1/me/demo/hello", undefined, 200],
    ["employee", "GET", "/api/v1/demo/items", undefined, 404, NOT_FOUND],
    ["otherAdmin", "GET", "/api/v1/demo/items", undefined, 404, NOT_FOUND],
    ["exited", "GET", "/api/v1/demo/items", undefined, 404, NOT_FOUND],
    ["reader", "GET", "/api/v1/demo/items", undefined, 200],
    ["operator", "GET", "/api/v1/demo/items", undefined, 200],
    ["admin", "GET", "/api/v1/demo/items", undefined, 200],
    ["employee", "POST", "/api/v1/demo/reports", {}, 404, NOT_FOUND],
    ["reader", "POST", "/api/v1/demo/reports", {}, 202],
    ["operator", "POST", "/api/v1/demo/reports", {}, 202],
    ["employee", "PUT", "/api/v1/demo/settings", {}, 404, NOT_FOUND],
    ["otherAdmin", "PUT", "/api/v1/demo/settings", {}, 404, NOT_FOUND],
    ["reader", "PUT", "/api/v1/demo/settings", {}, 403, FORBIDDEN],
    ["operator", "PUT", "/api/v1/demo/settings", {}, 204],
    ["admin", "PUT", "/api/v1/demo/settings", {}, 204],
  ];
  for (const [who, method, p, body, status, errBody] of cases) {
    const r = await c(who).raw(method, p, body);
    const text = await r.text();
    assert.equal(r.status, status, `${who} ${method} ${p}: ${text}`);
    if (errBody) assert.deepEqual(JSON.parse(text), errBody, `${who} ${method} ${p}`);
    if (status === 204) { assert.equal(text, ""); assert.equal(r.headers.get("cache-control"), "no-store"); }
  }
  // 越权与不存在逐字同形
  const denied = await (await c("employee").raw("GET", "/api/v1/demo/items")).text();
  const missing = await (await c("employee").raw("GET", "/api/v1/demo/no-such-route")).text();
  assert.equal(denied, missing);
  // readonly 的 POST 仍在事务内执行：写入已提交
  assert.ok(rows(A, "SELECT COUNT(*) AS n FROM demo_items WHERE source = 'readonly-post'")[0].n >= 2);
});

// ---------- 事务、事件、审计、通知 ----------

test("dispatch: a write commits the row, the outbox event (actor = the caller), the audit line (prefixed, actor, request id) and the after-commit notification — whose link is flagged fullPage", async () => {
  const r = await people.employee.post("/api/v1/me/demo/items", { name: "first" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.id;
  assert.deepEqual(rows(A, "SELECT userId, name, source FROM demo_items WHERE id = ?", id), [{ userId: people.employeeId, name: "first", source: "request" }]);
  const ev = rows(A, "SELECT type, actorId, subjectUserId, data, dispatchedAt FROM event_outbox WHERE type = 'demo.item.added'");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actorId, people.employeeId);
  assert.equal(ev[0].subjectUserId, people.employeeId);
  assert.deepEqual(JSON.parse(ev[0].data), { itemId: id });
  const au = rows(A, "SELECT actorId, actorName, target, afterJson, requestId FROM audit_logs WHERE action = 'demo.items.add'");
  assert.equal(au.length, 1);
  assert.equal(au[0].actorId, people.employeeId);
  assert.ok(au[0].actorName, "actorName filled in from the user id");
  assert.equal(au[0].target, people.employeeId);
  assert.deepEqual(JSON.parse(au[0].afterJson), { itemId: id });
  assert.match(au[0].requestId, /^r-[0-9a-f]{8}$/);
  const n = await people.employee.get("/api/me/notifications");
  const added = n.data.items.find((x) => x.type === "demo.added");
  assert.ok(added, JSON.stringify(n.data));
  assert.equal(added.link, "/demo/#/items");
  assert.equal(added.fullPage, true, "a link into a module's own page opens as a full page");
  assert.ok(n.data.items.filter((x) => x.type !== "demo.added").every((x) => x.fullPage === false));
  // PUT：路径参数原样交给处理函数
  const put = await people.employee.put("/api/v1/me/demo/items/" + id, { name: "renamed" });
  assert.deepEqual([put.status, put.data], [200, { ok: true, itemId: String(id) }]);
});

test("dispatch: a handler that throws rolls everything back — row, outbox event, audit, notification and after-commit callback — and answers the fixed 500 with a redacted log line", async () => {
  const before = rows(A, "SELECT COUNT(*) AS n FROM event_outbox")[0].n;
  const r = await c("employee").raw("POST", "/api/v1/me/demo/boom", {});
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), INTERNAL);
  assert.deepEqual(rows(A, "SELECT name FROM demo_items WHERE name IN ('boom', 'after-commit')"), []);
  assert.equal(rows(A, "SELECT COUNT(*) AS n FROM event_outbox")[0].n, before);
  assert.deepEqual(rows(A, "SELECT id FROM audit_logs WHERE action = 'demo.items.boom'"), []);
  assert.deepEqual(rows(A, "SELECT id FROM notifications WHERE type = 'demo.boom'"), []);
  await new Promise((res) => setTimeout(res, 50));
  assert.match(A.stderr(), /\[demo\] me\.boom failed: Error: secret \[redacted\] exploded/);
  assert.doesNotMatch(A.stderr(), /0123456789abcdef0123456789abcdef/);
});

test("dispatch: httpError answers { error, code, ...details } (details cannot override error / code); bad result shapes are 500", async () => {
  const r = await people.employee.post("/api/v1/me/demo/reject", {});
  assert.deepEqual([r.status, r.data], [409, { error: "Nope. 不行。", code: "demo_rejected", extra: 1 }]);
  for (const kind of ["undefined", "promise", "status", "text"]) {
    const b = await people.employee.get("/api/v1/me/demo/bad-result?kind=" + kind);
    assert.deepEqual([b.status, b.data], [500, INTERNAL], kind);
  }
});

test("dispatch: a GET handler cannot write — transaction, a write statement, events.publish and notify are all write_in_get (500, nothing written); services.audit is the one allowed side effect", async () => {
  for (const what of ["tx", "db", "publish", "notify"]) {
    const r = await people.employee.get("/api/v1/me/demo/sneaky?what=" + what);
    assert.deepEqual([r.status, r.data], [500, INTERNAL], what);
  }
  assert.deepEqual(rows(A, "SELECT id FROM demo_items WHERE source = 'get'"), []);
  assert.deepEqual(rows(A, "SELECT id FROM notifications WHERE type = 'demo.sneaky'"), []);
  assert.deepEqual(rows(A, "SELECT id FROM event_outbox WHERE type = 'demo.item.added' AND data = '{\"itemId\":0}'"), []);
  await new Promise((res) => setTimeout(res, 50));
  assert.match(A.stderr(), /\[demo\] me\.sneaky failed: Error: write_in_get:/);
  const au = await people.employee.get("/api/v1/me/demo/sneaky?what=audit");
  assert.equal(au.status, 200);
  assert.equal(rows(A, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'demo.items.view'")[0].n, 1);
});

test("dispatch: a CSV result is sent as an attachment (BOM, CRLF, formula-injection guard, quoting) with no-store", async () => {
  const r = await c("reader").raw("GET", "/api/v1/demo/items.csv");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(r.headers.get("content-disposition"), 'attachment; filename="demo-items.csv"');
  assert.equal(r.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString("utf8"), "名称 Name,备注 Note\r\n'=1+1,\"a,b\"\r\nx,\"line\nbreak\"");
});

// ---------- 事件：模块钩子与 core 的订阅 ----------

test("events: an employee.transferred reaches the module's hook with the very services object its factory got (module on); nothing runs for a switched-off module", async () => {
  const target = await makePerson(A.base, people.admin, "DM-MOVE", null);
  assert.equal((await people.admin.put("/api/admin/employees/" + target.id, { department: "Demo Moved Dept" })).status, 200);
  assert.deepEqual(rows(A, "SELECT name FROM demo_items WHERE source = 'hook' AND userId = ?", target.id).map((r) => r.name), ["same-services"]);
  const ev = rows(A, "SELECT dispatchedAt, attempts, lastError FROM event_outbox WHERE type = 'employee.transferred' AND subjectUserId = ?", target.id);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].dispatchedAt && ev[0].attempts === 1 && ev[0].lastError === null, JSON.stringify(ev[0]));
  // B：demo 关闭，钩子不跑
  const adminB = await loginAs(B.base, ADMIN);
  const tB = await makePerson(B.base, adminB, "DM-MOVE-B", null);
  assert.equal((await adminB.put("/api/admin/employees/" + tB.id, { department: "Demo Moved Dept" })).status, 200);
  assert.deepEqual(rows(B, "SELECT id FROM demo_items WHERE source = 'hook'"), []);
});

test("events: core writes one formal talent record per participant for culture.program.completed (type culture-program, dated data.endDate), exactly once per programId + user; bad data is recorded as a handler failure", async () => {
  const u1 = people.reader.id, u2 = people.operator.id;
  const done = await people.operator.client.post("/api/v1/demo/programs/complete", { programId: "p-demo-1", endDate: "2026-12-09", userIds: [u1, u2] });
  assert.deepEqual([done.status, done.data], [200, { published: 2 }]);
  const recs = rows(A, "SELECT id, userId, type, date, title, detail, createdBy FROM talent_records WHERE type = 'culture-program' ORDER BY userId");
  assert.deepEqual(recs.map((r) => r.userId).sort(), [u1, u2].sort());
  for (const r of recs) {
    assert.equal(r.date, "2026-12-09", "the business date comes from data.endDate, not occurredAt");
    assert.equal(r.title, "Demo Program");
    assert.equal(r.createdBy, u2, "the operator whose request froze the program");
    assert.match(r.id, /^tr-cp-[0-9a-f]{24}$/);
    const d = JSON.parse(r.detail);
    // track / participantStatus 存字段选项里的值（数据迁移 54、55；事件的 leader / active → Leader / Full participation）
    assert.deepEqual(d, { programId: "p-demo-1", programName: "Demo Program", startDate: "2026-10-26", endDate: "2026-12-09", track: "Leader", participantStatus: "Full participation", dept1: "Ops",
      weeksRequired: 6, weeksMet: 5, totalPoints: 321, tasksSubmitted: 6, tasksWitnessed: 4, cardsGiven: 3, cardsReceived: 2 });
  }
  const outbox = rows(A, "SELECT dispatchedAt, attempts, lastError FROM event_outbox WHERE type = 'culture.program.completed'");
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every((e) => e.dispatchedAt && e.attempts === 1 && e.lastError === null));
  // 重复送达（同一项目再发一次）不写第二条，也不改写已写入的记录
  await people.operator.client.post("/api/v1/demo/programs/complete", { programId: "p-demo-1", endDate: "2027-01-15", userIds: [u1] });
  const again = rows(A, "SELECT userId, date FROM talent_records WHERE type = 'culture-program' ORDER BY userId");
  assert.equal(again.length, 2);
  assert.ok(again.every((r) => r.date === "2026-12-09"));
  // 另一个项目：另写一条
  await people.operator.client.post("/api/v1/demo/programs/complete", { programId: "p-demo-2", endDate: "2027-06-30", userIds: [u1] });
  assert.equal(rows(A, "SELECT COUNT(*) AS n FROM talent_records WHERE type = 'culture-program' AND userId = ?", u1)[0].n, 2);
  // data.endDate 不是真实日期：请求照常成功，处理函数按失败记入发件箱，不写记录
  const bad = await people.operator.client.post("/api/v1/demo/programs/complete", { programId: "p-demo-3", endDate: "2026-02-31", userIds: [u1] });
  assert.equal(bad.status, 200);
  const failed = rows(A, "SELECT dispatchedAt, attempts, lastError FROM event_outbox WHERE type = 'culture.program.completed' AND data LIKE '%p-demo-3%'");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].dispatchedAt, null);
  assert.match(failed[0].lastError, /^core: Error: culture\.program\.completed: data\.endDate must be a YYYY-MM-DD date/);
  assert.equal(rows(A, "SELECT COUNT(*) AS n FROM talent_records WHERE detail LIKE '%p-demo-3%'")[0].n, 0);
  // 记录出现在 HR 看的员工档案时间线里
  const prof = await people.admin.get("/api/admin/employees/" + u1 + "/profile");
  assert.ok(prof.data.events.some((e) => e.source === "record" && e.type === "culture-program" && e.date === "2026-12-09"), JSON.stringify(prof.data.events.map((e) => [e.source, e.type, e.date])));
});

// ---------- 静态挂载（CONTRACT.md 9.1）----------

// 原样发一条 GET（路径不经 fetch 的 URL 规范化）。
function rawGet(srv, p, headers = {}) {
  const u = new URL(srv.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method: "GET", path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("static mount: /demo → /demo/; the entry page needs a session (else TMS login with next, or Lark start inside the Lark client); assets are served no-cache on the normalized lower-case shape", async () => {
  const bare = await rawGet(A, "/demo");
  assert.deepEqual([bare.status, bare.headers.location], [302, "/demo/"]);
  const anon = await rawGet(A, "/demo/");
  assert.deepEqual([anon.status, anon.headers.location], [302, "/#/login?next=%2Fdemo%2F"]);
  const anonIdx = await rawGet(A, "/demo/index.html");
  assert.equal(anonIdx.status, 302);
  const lark = await rawGet(A, "/demo/", { "user-agent": "Mozilla/5.0 (Windows) Lark/7.30.8 LarkLocale/zh_CN" });
  assert.deepEqual([lark.status, lark.headers.location], [302, "/api/auth/lark/start?next=%2Fdemo%2F"]);
  const larkNoCfg = await rawGet(B, "/demo/", { "user-agent": "Feishu/7.1" });
  assert.equal(larkNoCfg.status, 404, "B has the module switched off");
  const emp = await rawClient(A.base, EMPLOYEE);
  const cookie = COOKIES.get(emp);
  const page = await rawGet(A, "/demo/", { cookie });
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["cache-control"], "no-store");   // CX-094（10/11）：入口页不进浏览器前进后退缓存
  assert.match(page.text, /demo learner app/);
  for (const p of ["/demo/app.js", "/DEMO/app.js", "/Demo/app.js", "/demo%5Capp.js", "/demo/./app.js", "/demo//app.js"]) {
    const r = await rawGet(A, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers["content-type"], "text/javascript; charset=utf-8", p);
    assert.equal(r.headers["cache-control"], "no-cache", p);
    assert.equal(r.text, "window.DEMO_APP = 1;\r\n", p);
  }
  assert.equal((await rawGet(A, "/demo/app.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await rawGet(A, "/demo/sub/page.js")).status, 200, "files in sub-directories of public/ are served");
});

test("static mount: nothing outside the module's public/ is reachable — traversal, directories, dot files, extensions outside the MIME table and misses are plain-text 404 (never the SPA shell)", async () => {
  const probes = ["/demo/..%2fsecret%2fleak.js", "/demo/%2e%2e/secret/leak.js", "/demo/..%5csecret%5cleak.js", "/demo/..%5c..%5cserver.js",
    "/demo/..%2f..%2fconfig.json", "/demo/..%2fmigrations%2fdemo-0001.sql", "/demo/notes.txt", "/demo/.hidden.js", "/demo/sub/", "/demo/sub",
    "/demo/missing.js", "/demo/deep/page", "/demo/app.js%00.css", "/demo/app.js::$DATA", "/demo/linked/leak.js", "/DEMO/Linked/leak.js"];
  for (const p of probes) {
    const r = await rawGet(A, p);
    assert.equal(r.status === 404 || r.status === 400, true, `${p}: ${r.status}`);
    assert.doesNotMatch(r.text, /TMS shell|LEAK|CREATE TABLE|window\./, p);
  }
  const dirReq = await rawGet(A, "/demo/sub/");
  assert.deepEqual([dirReq.status, dirReq.headers["content-type"], dirReq.text], [404, "text/plain; charset=utf-8", "Not found"]);
  // 路径里的 NUL 不再让进程退出（以前匿名的 GET /x%00.js 会让 fs 同步抛错，整个服务随之退出）
  assert.equal((await rawGet(A, "/x%00.js")).status, 404);
  assert.equal((await rawGet(A, "/videos/a%00.mp4")).status, 404);
  assert.equal((await fetch(A.base + "/api/env")).status, 200, "still serving");
});

test("static mount: with the module switched off (defaultOn: false and no config) /demo and /demo/* are 404, and the module API is the module-gate 404", async () => {
  for (const p of ["/demo", "/demo/", "/demo/app.js", "/DEMO/app.js"]) assert.equal((await rawGet(B, p)).status, 404, p);
  const adminB = await loginAs(B.base, ADMIN);
  const r = await adminB.get("/api/v1/me/demo/hello");
  assert.deepEqual([r.status, r.data], [404, { error: "Not found" }]);
  const anon = await fetch(B.base + "/api/v1/demo/items");
  assert.deepEqual([anon.status, await anon.json()], [404, { error: "Not found" }], "the module gate answers before the 401");
  const env = await (await fetch(B.base + "/api/env")).json();
  assert.equal(env.modules.demo, false);
  assert.equal((await adminB.get("/api/me")).data.modules.demo, false);
  const envA = await (await fetch(A.base + "/api/env")).json();
  assert.deepEqual(envA.modules, { learning: true, performance: true, talent: true, ai: false, demo: true });
});

// ---------- 登录回跳（CONTRACT.md 9.5）----------

test("login next: the password login echoes a whitelisted next — only in-site paths under a module mount — and keeps its old shape when no next is sent", async () => {
  const cases = [["/demo/", "/demo/"], ["/demo/#/home", "/demo/#/home"], ["/demo/index.html?x=1", "/demo/index.html?x=1"],
    ["https://evil.example/demo/", "/"], ["//evil.example/demo/", "/"], ["/demo", "/"], ["/DEMO/", "/"], ["/demo/../admin", "/"],
    ["/demo/%2e%2e/", "/"], ["/demo\\evil", "/"], ["/demo/..\\..\\admin", "/"], ["/demo/a\\b.js", "/"], ["/demo/ x", "/"], ["/api/admin/roles", "/"], ["/#/admin", "/"], [123, "/"], ["", "/"]];
  for (const [next, want] of cases) {
    const l = await loginRaw(A.base, { ...EMPLOYEE, next });
    assert.equal(l.status, 200);
    assert.deepEqual(l.data, { ok: true, role: "employee", next: want }, JSON.stringify(next));
  }
  assert.deepEqual((await loginRaw(A.base, EMPLOYEE)).data, { ok: true, role: "employee" });
});

test("login next: Lark start keeps next in the state ({ exp, next }); the callback lands on it, falls back to / when it was not whitelisted, and carries it back to the login page on failure", async () => {
  const flow = async (nextParam) => {
    const q = nextParam === undefined ? "" : "?next=" + encodeURIComponent(nextParam);
    const start = await fetch(A.base + "/api/auth/lark/start" + q, { redirect: "manual" });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cb = await fetch(`${A.base}/api/auth/lark/callback?code=test-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    return { status: cb.status, location: cb.headers.get("location"), state };
  };
  assert.deepEqual(await flow("/demo/#/home").then((r) => [r.status, r.location]), [302, "/demo/#/home"]);
  assert.deepEqual(await flow("/demo/").then((r) => r.location), "/demo/");
  for (const bad of ["https://evil.example/", "//evil.example/demo/", "/demo/../x", "/admin"]) assert.equal((await flow(bad)).location, "/", bad);
  assert.equal((await flow(undefined)).location, "/", "no next: unchanged behaviour");
  // state 用过一次就作废
  const once = await flow("/demo/");
  const replay = await fetch(`${A.base}/api/auth/lark/callback?code=test-code&state=${encodeURIComponent(once.state)}`, { redirect: "manual" });
  assert.equal(replay.headers.get("location"), "/#/login?sso=failed");
  // 失败（账号已停用）时回登录页，带上 next
  const lara = rows(A, "SELECT id FROM users WHERE larkUserId = ?", LARK_USER.union_id)[0];
  assert.ok(lara, "the Lark account was provisioned by the first callback");
  assert.equal((await people.admin.put("/api/admin/employees/" + lara.id, { active: false })).status, 200);
  assert.equal((await flow("/demo/")).location, "/#/login?sso=disabled&next=%2Fdemo%2F");
});

// ---------- 重启：迁移不重跑；改动已执行文件、工厂不合规都拒绝启动 ----------

test("restart: migrations are not re-run and no second backup is taken; an edited applied migration, an incomplete factory or a throwing factory each refuse to start with exit code 1", async () => {
  await A.stopAsync();
  A = await bootA();
  assert.equal(rows(A, "SELECT COUNT(*) AS n FROM module_migrations")[0].n, 1);
  assert.equal(fs.readdirSync(path.join(aDir(), "backups")).filter((f) => f.includes("-pre-migration-vmodules-")).length, 1);
  assert.ok(factoryOncePerProcess(A).length >= 2, "the factory runs once per start: the first start's row is still there, the restart added its own");
  assert.equal(rows(A, "SELECT COUNT(*) AS n FROM demo_items WHERE source = 'job'")[0].n, 1, "today's job already ran: the restart does not catch it up again");
  await A.stopAsync();
  A = null;
  const expectRefusal = async (edit, pattern) => {
    const undo = edit();
    // 本应拒绝启动却起来了的服务器：断言照样失败，但要把它停掉 —— 否则这个子进程会拖住测试进程，整个文件挂到超时。
    let stray = null;
    try {
      await assert.rejects(bootA().then((s) => { stray = s; return s; }), (e) => {
        assert.equal(e.exitCode, 1, e.message);
        assert.match(e.stderr, pattern);
        return true;
      });
    } finally {
      if (stray) await stray.stopAsync();
      undo();
    }
  };
  const editFile = (rel, change) => () => {
    const f = path.join(dir, "modules", "demo", rel);
    const orig = fs.readFileSync(f);
    fs.writeFileSync(f, change(orig.toString("utf8")));
    return () => fs.writeFileSync(f, orig);
  };
  await expectRefusal(editFile("migrations/demo-0001.sql", (s) => s + "CREATE INDEX IF NOT EXISTS idx_demo_items_name ON demo_items(name);\r\n"),
    /\[modules\] 模块迁移失败，拒绝启动 \/ module migration failed[\s\S]*demo-0001\.sql \(demo\) has changed since it was applied/);
  await expectRefusal(editFile("index.js", (s) => s.replace('  return { handlers, hooks, jobs };', '  delete handlers["me.echo"];\r\n  return { handlers, hooks, jobs };')),
    /\[modules\] 模块工厂启动失败[\s\S]*module factory invalid \[demo\][\s\S]*"me\.echo" is declared in the manifest but the factory does not return it/);
  await expectRefusal(editFile("index.js", (s) => s.replace("  factory.lastServices = services;", '  throw new TypeError("demo factory broke");')),
    /module demo: the factory threw TypeError: demo factory broke/);
  // 恢复原样后照常启动
  A = await bootA();
  assert.equal((await (await loginAs(A.base, EMPLOYEE)).get("/api/v1/me/demo/hello")).status, 200);
});
