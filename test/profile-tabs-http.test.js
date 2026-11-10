// 员工档案页签扩展点（ARCHITECTURE-MODULAR.md §5.4 profile.tabs）—— 接口一侧：
//   A. 现状：没有模块登记页签，三个档案接口（后台 /api/admin/employees/:id/profile、汇报线 /api/me/reports/:userId、
//      本人 /api/me/growth）的响应都带 tabs: []，其余字段不变；越界 404 的正文仍与「不存在」逐字相同、不带 tabs。
//   B. 接线：在系统临时目录起一份服务器副本（server.js 与依赖原样复制，modules/ 多装一个演示模块 demo，
//      它登记三个页签），验证每个接口传的是自己的位置（admin / line / self）、后台按当前用户的能力域过滤、
//      模块开关按请求现读 config（关掉 demo 即全部消失）。副本用临时库与临时 config，不碰仓库的 lms.db / config.json。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs } = require("./helpers.js");

// 建员工 → 改首登密码 → 返回 { id, client }。patch 走 PUT /api/admin/employees/:id（上级、后台角色等）。
async function makePerson(base, admin, empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId + " " + JSON.stringify(created.data));
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  if (patch) assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  const c = await loginAs(base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  return { id: u.id, client: c };
}

// 一套固定的人：经理 MGR、下属 REP（上级 = MGR）、局外人 OUT、HRBP（people=manage，talent=none）。
// HRBP 是自定义角色：迁移 64（2026-10-06）删掉了没有成员的内置 HRBP，这里按它原来的授权（people 管理 + culture 只读）建一个。
async function cast(base) {
  const admin = await loginAs(base, ADMIN);
  const made = await admin.post("/api/admin/roles", { name: "PT HRBP", name_zh: "PT HRBP", grants: { people: "manage", culture: "read" } });
  assert.equal(made.status, 200, "create the HRBP role " + JSON.stringify(made.data));
  const hrbpRole = made.data.role;
  const mgr = await makePerson(base, admin, "PT-MGR", { department: "PT Line" });
  const rep = await makePerson(base, admin, "PT-REP", { department: "PT Line", managerId: mgr.id });
  const out = await makePerson(base, admin, "PT-OUT", { department: "PT Elsewhere" });
  const hrbp = await makePerson(base, admin, "PT-HRBP", { adminRoleId: hrbpRole.id });
  return { admin, mgr, rep, out, hrbp };
}

// 三个位置各取一次 tabs（后台位置分别以超管与 HRBP 身份）。
async function tabsEverywhere(c) {
  const growth = await c.rep.client.get("/api/me/growth");
  const line = await c.mgr.client.get("/api/me/reports/" + c.rep.id);
  const adminProf = await c.admin.get("/api/admin/employees/" + c.rep.id + "/profile");
  const hrbpProf = await c.hrbp.client.get("/api/admin/employees/" + c.rep.id + "/profile");
  for (const [name, r] of Object.entries({ growth, line, adminProf, hrbpProf })) assert.equal(r.status, 200, name + " " + JSON.stringify(r.data));
  return { self: growth.data.tabs, line: line.data.tabs, admin: adminProf.data.tabs, hrbp: hrbpProf.data.tabs, bodies: { growth, line, adminProf, hrbpProf } };
}

// ---------- A. 现状（仓库里的真实 server.js 与 modules/）----------

let srvA, castA;   // 由文件末尾那一个 before 建立（见那里的说明）

test("profile tabs: with no module registering a tab, all three profile endpoints answer tabs: [] (super-admin, limited role, manager, self)", async () => {
  const t = await tabsEverywhere(castA);
  assert.deepEqual(t.self, []);
  assert.deepEqual(t.line, []);
  assert.deepEqual(t.admin, []);
  assert.deepEqual(t.hrbp, []);
  // the seeded employee reading their own record, too
  const emp = await loginAs(srvA.base, EMPLOYEE);
  assert.deepEqual((await emp.get("/api/me/growth")).data.tabs, []);
  // the rest of each payload is still there (tabs is an addition, not a reshaping)
  const { growth, line, adminProf } = t.bodies;
  for (const k of ["me", "stats", "events"]) assert.ok(k in growth.data, "growth keeps " + k);
  for (const k of ["user", "chain", "stats", "events", "performance", "assignments", "secondaryLines"]) assert.ok(k in line.data, "reports keeps " + k);
  for (const k of ["user", "stats", "events", "assignments", "secondaryLines", "secondaryReports", "config", "suggestions"]) assert.ok(k in adminProf.data, "profile keeps " + k);
  assert.deepEqual(Object.keys(growth.data).slice(-1), ["tabs"]);
  assert.deepEqual(Object.keys(line.data).slice(-1), ["tabs"]);
  assert.deepEqual(Object.keys(adminProf.data).slice(-1), ["tabs"]);
});

test("profile tabs: the guarded exits are unchanged — out-of-line / out-of-reach answers carry no tabs and match 'no such person' byte for byte", async () => {
  const out = await castA.mgr.client.raw("GET", "/api/me/reports/" + castA.out.id);
  const ghost = await castA.mgr.client.raw("GET", "/api/me/reports/u-no-such-person");
  assert.equal(out.status, 404);
  assert.equal(await out.text(), await ghost.text());
  // an employee without a back-office role never reaches the admin profile (and so never its tabs)
  assert.equal((await castA.rep.client.get("/api/admin/employees/" + castA.mgr.id + "/profile")).status, 403);
});

// ---------- B. 接线：服务器副本 + 演示模块 ----------

const DEMO_MANIFEST = [
  '"use strict";',
  "module.exports = {",
  '  id: "demo", name: { zh: "演示模块", en: "Demo" }, sellable: true, requires: ["core"], optional: [],',
  "  domains: [], gate: [], routes: [], static: [], tables: [],",
  "  extensions: {",
  '    "profile.tabs": [',
  '      { id: "demo-all", title: { zh: "行为实践", en: "Practice" }, order: 20, audiences: ["self", "line", "admin"] },',
  '      { id: "demo-talent", title: { zh: "人才视图", en: "Talent view" }, order: 10, audiences: ["admin"], domain: "talent" },',
  '      { id: "demo-self", title: { zh: "我的", en: "Mine" }, order: 30, audiences: ["self"] },',
  "    ],",
  "  },",
  "};",
  "",
].join("\r\n");

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-tabs-srv-"));
  // 仓库根目录的全部 .js（server.js、store.js、notify.js、content.js …）与 package.json：以后根目录多一个被 require 的文件，副本照样起得来
  for (const f of fs.readdirSync(ROOT).filter((n) => /\.js$/.test(n) || n === "package.json")) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, "kernel"), path.join(dir, "kernel"), { recursive: true });
  fs.cpSync(path.join(ROOT, "modules"), path.join(dir, "modules"), { recursive: true });
  fs.mkdirSync(path.join(dir, "modules", "demo"));
  fs.writeFileSync(path.join(dir, "modules", "demo", "manifest.js"), DEMO_MANIFEST);
  const installed = require("../modules/index.js");
  fs.writeFileSync(path.join(dir, "modules", "index.js"), '"use strict";\r\nmodule.exports = ' + JSON.stringify([...installed, "demo"]) + ";\r\n");
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "index.html"), "<!doctype html><title>x</title>");
  return dir;
}

async function bootCopy(dir, attempt = 0) {
  const dbPath = path.join(dir, "test.db");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: { ...process.env, LMS_DB_PATH: dbPath, LMS_ATTACH_DIR: path.join(dir, "attachments"), LMS_CONFIG_PATH: path.join(dir, "config.json"),
      PORT: String(port), LMS_DISABLE_AI: "1", LMS_DISABLE_OFFICE_CONVERT: "1", LMS_MODULES_OFF: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  const want = crypto.createHash("sha256").update(path.resolve(dbPath)).digest("hex").slice(0, 8);
  const deadline = Date.now() + 20000;
  let stranger = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      // 有界的探测（同 helpers.js）：随机端口若被一个接了连接却不应答的本机进程占着，不带超时的 fetch 要等 300 秒
      const r = await fetch(base + "/api/env", { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        if ((await r.json()).instance === want) return { child, base, stop: () => child.kill() };
        stranger = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  if ((stranger || /EADDRINUSE/.test(stderr)) && attempt < 5) return bootCopy(dir, attempt + 1);
  throw new Error("server copy failed to start:\n" + stderr);
}

// 关掉一个子进程并等它退出（Windows 上 SQLite 文件要等进程结束才释放）。10 秒还没退出就断开 stderr 管道、unref，
// 不让一个关不掉的子进程把测试进程永远挂住。
async function stopChild(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000).unref())]);
    if (!done) { try { child.kill("SIGKILL"); } catch {} }
  }
  if (child.exitCode === null && child.signalCode === null) { try { child.stderr && child.stderr.destroy(); } catch {} child.unref(); }
}

let copyDir, srvB, castB;

// A、B 两节共用这一个 before / after（原来各有一对）。node:test 的顶层 before 一登记就开始执行、彼此并行；
// 其中一个失败时全部用例随即判败，顶层 after 马上运行 —— 另一个 before 这时还在起服务器，after 看不到它，
// 它随后起来的子进程没人关，stderr 管道让测试进程永远不退出（2026-10-07 全量跑在本文件卡了 90 分钟以上：
// A 段因迁移 64 删了内置 HRBP 角色先失败，B 段的副本服务器随后起来）。合成一个顺序执行的 before：
// 它结束（成功或失败）之前用例不会开始，after 一定在它之后运行，起过的每台服务器都由 after 关掉。
before(async () => {
  srvA = await startServer();
  castA = await cast(srvA.base);
  copyDir = makeCopy();
  srvB = await bootCopy(copyDir);
  castB = await cast(srvB.base);
});
after(async () => {
  await Promise.all([stopChild(srvA && srvA.child), stopChild(srvB && srvB.child)]);
  if (copyDir) { try { fs.rmSync(copyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} }
});

const ids = (tabs) => (tabs || []).map((t) => t.id);

test("profile tabs (wired): each endpoint asks for its own audience, and the back office filters by the viewer's domain grants", async () => {
  const env = await (await fetch(srvB.base + "/api/env")).json();
  assert.equal(env.modules.demo, true, "the demo module is installed and on in the copy");
  const t = await tabsEverywhere(castB);
  assert.deepEqual(ids(t.self), ["demo-all", "demo-self"], "GET /api/me/growth = audience self");
  assert.deepEqual(ids(t.line), ["demo-all"], "GET /api/me/reports/:userId = audience line");
  assert.deepEqual(ids(t.admin), ["demo-talent", "demo-all"], "super-admin reads every domain, so the talent-gated tab shows (order 10 first)");
  assert.deepEqual(ids(t.hrbp), ["demo-all"], "HRBP (people=manage, talent=none) does not get the talent-gated tab");
  assert.deepEqual(t.admin[0], { id: "demo-talent", module: "demo", title: { zh: "人才视图", en: "Talent view" }, order: 10 });
});

test("profile tabs (wired): switching the module off in config removes its tabs from every endpoint on the next request (read per request, no restart)", async () => {
  const cfg = path.join(copyDir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ modules: { demo: false } }));
  try {
    const t = await tabsEverywhere(castB);
    assert.deepEqual([t.self, t.line, t.admin, t.hrbp], [[], [], [], []]);
  } finally { fs.rmSync(cfg, { force: true }); }
  const back = await tabsEverywhere(castB);
  assert.deepEqual(ids(back.self), ["demo-all", "demo-self"], "and they come back when it is switched on again");
});

test("profile tabs (wired): a guarded 404 still carries no tabs even when a module registers some", async () => {
  const out = await castB.mgr.client.raw("GET", "/api/me/reports/" + castB.out.id);
  assert.equal(out.status, 404);
  assert.deepEqual(await out.json(), { error: "Not found" });
});
