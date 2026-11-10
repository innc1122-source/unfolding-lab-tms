// M0 活体差分：把 server.js 还原成「M0 之前」的样子（手写表从冻结夹具原样贴回、REGISTRY 删掉、
// modulesOn 与 /videos 静态门换回 M0 前的原句），与现行 server.js 各起一台服务器，在相同的
// 模块开关下对同一批请求逐条比对状态码 —— 行为等价的第二道证明，覆盖的是「真实服务器的整条
// 请求链路」（关门 404、RBAC 闸门、dashboard 裁剪、/videos 静态门），而不只是两张表相等。
//
// 两台服务器都跑在系统临时目录里的副本上（各自空的 public/、临时库、临时 config），不碰仓库
// 里的 public/、lms.db、config.json。只发 GET 给超管；非 GET 只发给受限角色，且排除上传端点
// 与会注销会话的端点。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { ROOT, ADMIN, loginAs } = require("./helpers.js");

const registry = require("../kernel/registry.js");
const LEGACY = require("./fixtures/m0-legacy-tables.js");
const REG = registry.load();
// 只比 M0 当时的四个模块：两份副本都只装这四个（modules/index.js 改写），探针也只取它们的路由。
// 以后新增的模块（culture 等）不在冻结夹具里：表级的「只许新增」由 m0-registry-equivalence.test.js 的
// 「later modules may only ADD」一项保证；真实请求链路上另有一组副本（FULL）装**全部已登记模块**（culture 缺省关闭、
// 以及在 config 里打开各起一台），对同一批 M0 探针与「M0 前」那台逐条比对状态码与闸门正文 —— 见最后一项测试。
const M0_IDS = ["core", "learning", "performance", "talent"];
// 只装四个模块重建时要带上 hooks（registry.build 要求「声明了 subscribes 的模块必须带 hooks」，hooks 只有
// load() 会从磁盘读）：从已加载注册表的 events.subscriptions 还原；订阅了只有后来模块才发布的事件的条目
// 去掉（只装四个模块时没有发布方）。与 m0-registry-equivalence.test.js 的 m0Parts 同一做法。
function m0Registry() {
  const manifests = REG.manifests.filter((m) => M0_IDS.includes(m.id));
  const published = new Set(manifests.flatMap((m) => m.publishes || []));
  const hooks = {};
  const trimmed = manifests.map((m) => {
    if (!Array.isArray(m.subscribes)) return m;
    const subscribes = m.subscribes.filter((t) => published.has(t));
    for (const s of REG.events.subscriptions) if (s.module === m.id && subscribes.includes(s.type)) (hooks[m.id] = hooks[m.id] || {})[s.type] = s.fn;
    return { ...m, subscribes };
  });
  return registry.build(trimmed, { hooks });
}
const REG0 = REG.manifests.every((m) => M0_IDS.includes(m.id)) ? REG : m0Registry();
// M0 之后给这四个模块**新增**的后台路由（第一例：core 的 GET /api/admin/departments/hods 与 hods.csv）
// 也不进探针：「M0 前」那台服务器用的是冻结夹具里的 RBAC 表，里面本来就没有它们的条目（fail closed
// 403 / 被旧通配认领），与现行服务器的差异是**有意的新增**，不是回归。判定方式与
// m0-registry-equivalence.test.js 的 m0AddedRoutes 相同：路由生成的 RBAC 条目（正则 + 方法 + 能力域）
// 在冻结表里找不到即为新增。新增只认领新路径、旧路径判定一个不变，由那个文件的
// assertM0Additions 与行为比对保证；改动旧路由仍会让冻结条目消失，被那边的逐条相等测试拦下。
const reSig = (re) => re.source + "/" + re.flags;
const LEGACY_RB = new Set(LEGACY.RBAC_ROUTES.map((r) => reSig(r.re) + " " + JSON.stringify(r.methods || null) + " -> " + r.domain));
const LEGACY_SHELL = new Set(LEGACY.RBAC_SHELL.map(reSig));
const ADDED_SIGS = new Set([
  ...REG0.RBAC_ROUTES.filter((r) => !LEGACY_RB.has(reSig(r.re) + " " + JSON.stringify(r.methods || null) + " -> " + r.domain)).map((r) => reSig(r.re)),
  ...REG0.RBAC_SHELL.map(reSig).filter((k) => !LEGACY_SHELL.has(k)),
]);
// rbac:"custom" 路由没有 RBAC 条目：挂在 M0 之后**新增**的 gate 下（第一例：第二批 2.8 的 "/api/admin/review-appeals"）即为新增 ——
// 「M0 前」那台没有这条 gate，关门时它照样放行到 handler，状态码不同是有意的。新增 gate = 生成的 MODULE_ROUTES 减去冻结表。
// 与 m0-registry-equivalence.test.js 的 customUnderNewGate 同一规则。
const gateK = ([p, m]) => m + " " + (typeof p === "string" ? "s:" + p : "r:" + p.source + "/" + p.flags);
const LEGACY_GATES = new Set(LEGACY.MODULE_ROUTES.map(gateK));
const NEW_GATES = REG0.MODULE_ROUTES.filter((g) => !LEGACY_GATES.has(gateK(g)));
const underNewGate = (r) => { const p = registry.samplePath(r.path); return NEW_GATES.some(([g, m]) => m === r.module && (typeof g === "string" ? p === g || p.startsWith(g + "/") : g.test(p))); };
const isAddedRoute = (r) => ((typeof r.domain === "string" || r.shell) && ADDED_SIGS.has(reSig(registry.exactRe(r.rbacPath || r.path))))
  || (r.rbac === "custom" && underNewGate(r));

const FIXTURE_SRC = fs.readFileSync(path.join(__dirname, "fixtures", "m0-legacy-tables.js"), "utf8").replace(/\r\n/g, "\n");
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").replace(/\r\n/g, "\n");

function fixtureBlock(start, endMarker) {
  const i = FIXTURE_SRC.indexOf(start);
  assert.ok(i >= 0, "fixture block " + start);
  const j = FIXTURE_SRC.indexOf(endMarker, i);
  return FIXTURE_SRC.slice(i, j + endMarker.length);
}
function replaceOnce(src, from, to) {
  const n = src.split(from).length - 1;
  assert.equal(n, 1, `expected exactly one occurrence of:\n${from}`);
  return src.replace(from, () => to);
}

// M0 之前的 server.js（今天其它批次的改动都保留，只把 M0 的改动还原）。
function legacyServerSource() {
  let s = SERVER_SRC;
  const regStart = s.indexOf("const REGISTRY = (() => {");
  const regEnd = s.indexOf("})();\n", regStart) + "})();\n".length;
  assert.ok(regStart > 0 && regEnd > regStart);
  s = s.slice(0, regStart) + "const REGISTRY = null; // pre-M0 oracle: any leftover REGISTRY use crashes\n" + s.slice(regEnd);
  s = replaceOnce(s, "  const out = {};\n  for (const k of REGISTRY.SELLABLE) out[k] = on(k);\n  return out;\n",
    "  return { learning: on(\"learning\"), performance: on(\"performance\"), talent: on(\"talent\") };\n");
  // 第二段（2026-09-25，M0 之后）：modulesOn 支持 manifest 的 defaultOn。M0 之前只有「显式 false 才关」一条规则 ——
  // 还原成原句（现行的四个模块都没写 defaultOn，两句对它们的结果逐一相同，m0-registry-equivalence 另有穷举比对）。
  s = replaceOnce(s, "  const on = (k) => (typeof cfg[k] === \"boolean\" ? cfg[k] : REGISTRY.DEFAULT_ON[k] !== false) && !off.has(k);\n",
    "  const on = (k) => cfg[k] !== false && !off.has(k);\n");
  s = replaceOnce(s, "const MODULE_ROUTES = REGISTRY.MODULE_ROUTES;", fixtureBlock("const MODULE_ROUTES = [", "\n];"));
  s = replaceOnce(s, "const RBAC_DOMAINS = REGISTRY.RBAC_DOMAINS;", fixtureBlock("const RBAC_DOMAINS = [", "];"));
  s = replaceOnce(s, "const RBAC_SHELL = REGISTRY.RBAC_SHELL;", fixtureBlock("const RBAC_SHELL = [", "\n];"));
  s = replaceOnce(s, "const RBAC_READONLY = REGISTRY.RBAC_READONLY;", fixtureBlock("const RBAC_READONLY = [", "\n];"));
  s = replaceOnce(s, "const RBAC_ROUTES = REGISTRY.RBAC_ROUTES;", fixtureBlock("const RBAC_ROUTES = [", "\n];"));
  s = replaceOnce(s, "  const staticModule = REGISTRY.moduleOfStatic(normLower);\n  if (staticModule && !modulesOn()[staticModule]) {\n",
    "  if (isVideoPath && !modulesOn().learning) {\n");
  // 领域事件（2026-09-25，M0 之后的批次，保留）：分发总线的订阅表取自 REGISTRY.events。M0 之前没有
  // manifest，也就没有任何订阅方 —— 还原成空订阅表；发件箱写入、分发与写回的其余接线两台服务器完全相同。
  // 这个替换对 M0 副本无害的依据是：M0 副本只装四个 M0 模块（makeCopy 改写 modules/index.js），这四个模块之间没有
  // 订阅（core 唯一的订阅 culture.program.completed 只有 culture 发布，四个模块时它没有发布方），新服务器的订阅表同样
  // 为空。（装全部模块时 core 与 culture 都带 hooks.js，test/events-registry.test.js 钉住；那一组 FULL 副本比对的是
  // 状态码与闸门正文，不经过这个替换。）
  s = replaceOnce(s, "  subscriptions: REGISTRY.events.subscriptions,\n", "  subscriptions: [],\n");
  // 员工档案页签扩展点（2026-09-25，M0 之后的批次，保留）：页签清单取自 manifest 的 extensions["profile.tabs"]。
  // M0 之前没有 manifest，也就没有任何页签 —— 还原成恒返回 []。对 M0 副本无害的依据是：副本只装四个 M0 模块，
  // 它们都没有登记页签（test/profile-tabs-registry.test.js 钉住「四个 M0 模块没有页签」；culture 登记了自己的页签，
  // 只在 FULL 副本里出现，那一组不比档案接口的响应体）。
  s = replaceOnce(s, "  return REGISTRY.profileTabs({ audience, modulesOn, canRead: (domain) => canRead(user, domain) });\n", "  return [];\n");
  // 模块宿主（第二段，2026-09-25，M0 之后的批次，保留）：handler 路由分发、模块静态挂载、模块迁移、任务调度、
  // 登录回跳白名单都取自注册表（HANDLER_MODULES / STATIC_MOUNTS / MIGRATIONS / JOBS …）。M0 之前没有 manifest，
  // 也就没有任何这类模块 —— 还原成一张空表：宿主不分发任何路径（dispatch 恒为 null、gate 内判定恒为 false）、
  // 没有静态挂载与任务、模块迁移为空。对 M0 副本无害的依据是：副本只装四个 M0 模块，它们都没有 handler 路由与静态目录
  // （test/kernel-registry-handlers.test.js 以「M0 四个模块」为底钉住）；装了 culture 的 FULL 副本另行比对。
  s = replaceOnce(s, "  registry: REGISTRY,\n",
    "  registry: { HANDLER_MODULES: [], STATIC_MOUNTS: [], MIGRATIONS: [], JOBS: [], manifests: [], tableModule: {},\n"
    + "    isModuleHandlerPath: () => false, matchModuleRoute: () => null, staticMountOf: () => null, validateFactory: () => {} },\n");
  const leftover = s.split("\n").filter((l) => l.includes("REGISTRY.") && !l.trim().startsWith("//"));
  assert.deepEqual(leftover, [], "pre-M0 oracle still references REGISTRY in code");
  // 不带点的引用（把注册表整个传给别的函数）同样算：运行时那边拿到的是 null。
  const bare = s.split("\n").filter((l) => /\bREGISTRY\b/.test(l) && !l.trim().startsWith("//") && !l.startsWith("const REGISTRY = null;"));
  assert.deepEqual(bare, [], "pre-M0 oracle still hands REGISTRY to other code");
  return s;
}

// 一份可运行的临时副本：server.js（新或旧）+ 依赖文件 + 空 public（带一个测试视频）。
function makeCopy(tag, serverSrc, moduleIds = M0_IDS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m0-live-${tag}-`));
  fs.writeFileSync(path.join(dir, "server.js"), serverSrc.replace(/\n/g, "\r\n"));
  // 仓库根目录其余的 .js（store.js、notify.js、content.js …）与 package.json：以后根目录多一个被 require 的文件，副本照样起得来
  for (const f of fs.readdirSync(ROOT).filter((n) => (/\.js$/.test(n) && n !== "server.js") || n === "package.json")) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, "kernel"), path.join(dir, "kernel"), { recursive: true });
  fs.cpSync(path.join(ROOT, "modules"), path.join(dir, "modules"), { recursive: true });
  if (moduleIds) fs.writeFileSync(path.join(dir, "modules", "index.js"), '"use strict";\r\nmodule.exports = ' + JSON.stringify(moduleIds) + ";\r\n");
  fs.mkdirSync(path.join(dir, "public", "videos"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "videos", "m0-probe.mp4"), Buffer.alloc(64, 1));
  fs.writeFileSync(path.join(dir, "public", "index.html"), "<!doctype html><title>x</title>");
  return dir;
}

// 本文件起过的每个服务器子进程，在 spawn 的同一刻登记：before 中途失败时（某台没起来、Promise.all 里另一台已经起来，
// 或 roleClients 断言失败、这一组还没放进 pairs / full），after 照样能把它们全部关掉。漏关一个，它的 stderr 管道就让
// 测试进程永远不退出（全量跑曾在本文件卡住）。
const KIDS = new Set();
let tornDown = false;   // after 已经开始收尾

async function boot(dir, off, cfgName = "config.json", tag = "", attempt = 0) {
  if (tornDown) throw new Error("teardown has started; not booting another server");
  const dbPath = path.join(dir, `db-${off || "none"}${tag}.db`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: { ...process.env, LMS_DB_PATH: dbPath, LMS_ATTACH_DIR: path.join(dir, "att-" + (off || "none") + tag), LMS_CONFIG_PATH: path.join(dir, cfgName),
      PORT: String(port), LMS_DISABLE_AI: "1", LMS_DISABLE_OFFICE_CONVERT: "1", LMS_DISABLE_VIDEO_TRANSCODE: "1", LMS_MODULES_OFF: off || "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  KIDS.add(child);
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
        if ((await r.json()).instance === want) return { child, base };
        stranger = true;   // 别人的服务器占了这个随机端口（我们的子进程会以 EADDRINUSE 退出）
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  await stopChild(child);
  // 子进程最后几行 stderr 可能在退出之后才到：稍等管道关闭（最多 2 秒）再判断是不是端口撞车
  if (!child.stderr.closed) await Promise.race([new Promise((r) => child.stderr.once("close", r)), new Promise((r) => setTimeout(r, 2000).unref())]);
  // 端口撞车：换一个随机端口用同一个库重试（同 helpers.js startServer）
  if ((stranger || /EADDRINUSE/.test(stderr)) && attempt < 5) return boot(dir, off, cfgName, tag, attempt + 1);
  throw new Error(`server (${dir}, off=${off}) failed to start:\n${stderr}`);
}

// 关掉一个子进程并等它退出（Windows 上 SQLite 文件要等进程结束才释放）。10 秒还没退出就断开 stderr 管道、unref，
// 不让一个关不掉的子进程把测试进程永远挂住。
async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000).unref())]);
    if (!done) { try { child.kill("SIGKILL"); } catch {} }
  }
  if (child.exitCode === null && child.signalCode === null) { try { child.stderr.destroy(); } catch {} child.unref(); }
  KIDS.delete(child);
}

// 探针：manifest 全部路由（M0 之后新增的除外，见 isAddedRoute）+ 关门表的字符串前缀（及其子路径）+ 重叠边界。
function probes() {
  const set = new Set();
  for (const r of REG0.routes) if (!isAddedRoute(r)) set.add(registry.samplePath(r.path));
  for (const [p] of LEGACY.MODULE_ROUTES) if (typeof p === "string") { set.add(p); set.add(p + "/x"); }
  ["/api/admin/employees/bulk", "/api/admin/employees/bulk-update", "/api/admin/employees/bulk-reset", "/api/admin/employees/bulk/x",
    "/api/admin/questions/bulk", "/api/admin/assignments/bulk", "/api/admin/records/bulk", "/api/admin/secondary-lines/bulk",
    "/api/admin/roles/abc", "/api/admin/unknown", "/api/admin/export/other.csv", "/api/nope"].forEach((p) => set.add(p));
  return [...set].sort();
}
const SKIP_WRITE = [/^\/api\/auth\//, /^\/api\/admin\/(upload-video|attachments|brand-assets)$/, /^\/api\/me$/];
const SKIP_ALL = [/^\/api\/auth\/logout$/, /^\/api\/auth\/lark\//];

const CONFIGS = ["", "learning", "performance", "talent", "learning,performance,talent"];
const ROLE_KEYS = ["admin", "learning-admin", "performance-talent-admin"]; // 2026-10-06 内置角色收敛（迁移 64）
const pairs = [];
const full = [];   // FULL 副本：{ label, s: { child, base }, c: 角色会话, culture: 期望的开关 }
let dirs = [];

async function roleClients(base) {
  const admin = await loginAs(base, ADMIN);
  const roles = (await admin.get("/api/admin/roles")).data.roles;
  const out = { ADMIN: admin };
  for (const key of ROLE_KEYS) {
    const role = roles.find((r) => r.key === key);
    assert.ok(role, "built-in role " + key);
    const empId = ("M0-" + key.toUpperCase()).slice(0, 20); // 工号上限 20 字符（EMPLOYEE_ID_RE）：performance-talent-admin 会超长
    const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
    assert.equal(created.status, 200, "create " + empId);
    const u = (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === empId);
    assert.equal((await admin.put("/api/admin/employees/" + u.id, { adminRoleId: role.id })).status, 200);
    const c = await loginAs(base, { employeeId: empId, password: created.data.password });
    assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
    out[key] = c;
  }
  return out;
}

before(async () => {
  const legacySrc = legacyServerSource();   // 先做还原（断言失败时一个副本目录都还没建）
  const newDir = makeCopy("new", SERVER_SRC);
  dirs.push(newDir);
  const oldDir = makeCopy("old", legacySrc);
  dirs.push(oldDir);
  const fullDir = makeCopy("full", SERVER_SRC, null);   // modules/index.js 原样：全部已登记模块（含 culture）
  dirs.push(fullDir);
  for (const off of CONFIGS) {
    const [n, o] = await Promise.all([boot(newDir, off), boot(oldDir, off)]);
    pairs.push({ off, n, o, nc: await roleClients(n.base), oc: await roleClients(o.base) });
  }
  // culture 缺省关闭（manifest defaultOn:false，config 里没写）；另起一台在 config 里打开它
  fs.writeFileSync(path.join(fullDir, "config-culture-on.json"), JSON.stringify({ modules: { culture: true }, culture: { raterKey: "m0-live-diff-test-rater-key-0123456789" } }));
  const [off, on] = await Promise.all([boot(fullDir, "", "config.json", "-culture-off"), boot(fullDir, "", "config-culture-on.json", "-culture-on")]);
  full.push({ label: "culture off (default)", s: off, c: await roleClients(off.base), culture: false });
  full.push({ label: "culture on", s: on, c: await roleClients(on.base), culture: true });
});
after(async () => {
  tornDown = true;   // before 若因 Promise.all 里另一台先失败而提前结束，还在路上的 boot 不再起新进程
  // 先等子进程真正退出，再删目录：Windows 上 SQLite 文件在进程结束前一直被锁着，立刻删会静默失败、留下残余目录。
  // 关的是 spawn 时登记的全部子进程（KIDS），不只是已经放进 pairs / full 的那些。
  await Promise.all([...KIDS].map(stopChild));
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {} }
});

test("M0 live: pre-M0 server and M0 server answer every probe with the same status (super-admin GET, every module switch set)", async () => {
  const list = probes().filter((p) => !SKIP_ALL.some((re) => re.test(p)));
  assert.ok(list.length > 120, "probe count " + list.length);
  const diffs = [];
  // 各开关组合是互不相干的两台服务器，并行跑。
  await Promise.all(pairs.flatMap(({ off, nc, oc }) => [0, 1, 2, 3].map(async (lane) => {
    for (const p of list.filter((_, i) => i % 4 === lane)) { // 只读 GET，四路并发
      const [a, b] = await Promise.all([nc.ADMIN.raw("GET", p), oc.ADMIN.raw("GET", p)]);
      await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
      if (a.status !== b.status) diffs.push(`off=${off || "-"} GET ${p}: new ${a.status} / old ${b.status}`);
      // 关门判定：旧 moduleOfPath 说该路径属于已关模块 → 两边都必须是 404。
      const mod = LEGACY.moduleOfPath(p);
      if (mod && off.split(",").includes(mod) && a.status !== 404) diffs.push(`off=${off} GET ${p}: gated module ${mod} but new answered ${a.status}`);
    }
  })));
  assert.deepEqual(diffs.sort(), []);
});

test("M0 live: pre-M0 and M0 servers agree for every built-in limited role × probe × method (RBAC gate incl. bulk / :id overlaps, readonly, per-method domain split)", async () => {
  const list = probes().filter((p) => !SKIP_ALL.some((re) => re.test(p)));
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const diffs = [];
  let n = 0;
  // 全方法矩阵跑在「全开」上（RBAC 闸门在关门之后，关掉的模块两边都先 404）；「全关」只跑 GET。
  // 表级的穷举比对在 m0-registry-equivalence.test.js，这里验的是真实请求链路，控制在一分钟内。
  // 各角色的请求体都是 {}（写接口在校验处就被拒），角色之间并行不影响彼此的判定；新旧两台
  // 服务器收到的是同一条请求序列。
  const jobs = [];
  for (const { off, nc, oc } of pairs.filter((x) => x.off === "" || x.off === "learning,performance,talent")) {
    for (const key of ROLE_KEYS) jobs.push(async () => {
      for (const p of list) {
        for (const m of off === "" ? METHODS : ["GET"]) {
          if (m !== "GET" && SKIP_WRITE.some((re) => re.test(p))) continue;
          if (m !== "GET" && !p.startsWith("/api/admin/")) continue;
          const body = m === "GET" ? undefined : {};
          const [a, b] = await Promise.all([nc[key].raw(m, p, body), oc[key].raw(m, p, body)]);
          const [ta, tb] = await Promise.all([a.text(), b.text()]);
          n++;
          const gateBody = (s, t) => (s === 403 || s === 404 ? t : ""); // 闸门应答的正文也必须一致
          if (a.status !== b.status || gateBody(a.status, ta) !== gateBody(b.status, tb))
            diffs.push(`off=${off || "-"} ${key} ${m} ${p}: new ${a.status} ${gateBody(a.status, ta)} / old ${b.status} ${gateBody(b.status, tb)}`);
        }
      }
    });
  }
  await Promise.all(jobs.map((j) => j()));
  diffs.sort();
  assert.ok(n > 2000, "requests " + n); // 迁移 64 收敛为 3 个内置角色后约 2,600 次（原阈值 3000 按 5 个角色定）
  assert.deepEqual(diffs.slice(0, 40), [], `${diffs.length} difference(s)`);
});

test("M0 live: dashboard trimming and /api/env|/api/me module flags are identical on both servers for every switch set and role", async () => {
  const keysDeep = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).map((k) => [k, keysDeep(o[k])])) : Array.isArray(o) ? "array:" + o.length : typeof o);
  for (const { off, nc, oc } of pairs) {
    for (const key of ["ADMIN", ...ROLE_KEYS]) {
      const [a, b] = await Promise.all([nc[key].get("/api/admin/dashboard"), oc[key].get("/api/admin/dashboard")]);
      assert.equal(a.status, b.status, `dashboard status off=${off} ${key}`);
      assert.deepEqual(keysDeep(a.data), keysDeep(b.data), `dashboard shape off=${off} ${key}`);
      assert.deepEqual(a.data.modules, b.data.modules, `dashboard modules off=${off} ${key}`);
      const [ma, mb] = await Promise.all([nc[key].get("/api/me"), oc[key].get("/api/me")]);
      assert.equal(JSON.stringify(ma.data.modules), JSON.stringify(mb.data.modules), `/api/me modules off=${off} ${key}`);
      assert.equal(JSON.stringify(ma.data.grants), JSON.stringify(mb.data.grants), `/api/me grants key order off=${off} ${key}`);
    }
    const pair = pairs.find((x) => x.off === off);
    const [ea, eb] = await Promise.all([fetch(pair.n.base + "/api/env").then((r) => r.json()), fetch(pair.o.base + "/api/env").then((r) => r.json())]);
    assert.equal(JSON.stringify(ea.modules), JSON.stringify(eb.modules), `/api/env modules off=${off}`);
  }
});

test("M0 live: /videos static gate answers identically (session / no session, case and separator variants, learning on/off)", async () => {
  const variants = ["/videos/m0-probe.mp4", "/VIDEOS/m0-probe.mp4", "/Videos/M0-PROBE.MP4", "/videos%5Cm0-probe.mp4", "/videos/../index.html", "/videos", "/videosx", "/videos/missing.mp4"];
  for (const { off, n, o, nc, oc } of pairs) {
    for (const v of variants) {
      for (const who of ["admin", "anon", "limited-role"]) {
        const get = async (base, c) => (who === "anon" ? fetch(base + v) : c.raw("GET", v));
        const [a, b] = await Promise.all([get(n.base, who === "admin" ? nc.ADMIN : nc["learning-admin"]), get(o.base, who === "admin" ? oc.ADMIN : oc["learning-admin"])]);
        const [ba, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
        assert.equal(a.status, b.status, `off=${off || "-"} ${who} GET ${v}: new ${a.status} / old ${b.status}`);
        assert.equal(Buffer.from(ba).equals(Buffer.from(bb)), true, `off=${off || "-"} ${who} GET ${v}: bodies differ`);
      }
    }
    // learning 关掉时，连超管带会话都拿不到视频文件。
    if (off.split(",").includes("learning")) assert.equal((await nc.ADMIN.raw("GET", "/videos/m0-probe.mp4")).status, 404);
    else assert.equal((await nc.ADMIN.raw("GET", "/videos/m0-probe.mp4")).status, 200);
  }
});

test("M0 live: with every registered module installed (culture off by default, and switched on in config) the server still answers every M0 probe like the pre-M0 server — super-admin GET, limited roles × methods, module flags and grants minus the culture key", async () => {
  const list = probes().filter((p) => !SKIP_ALL.some((re) => re.test(p)));
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const ref = pairs.find((x) => x.off === "");
  assert.ok(ref && full.length === 2);
  const diffs = [];
  let n = 0;
  const gateBody = (s, t) => (s === 403 || s === 404 ? t : "");
  const jobs = [];
  for (const f of full) {
    jobs.push(async () => {   // 超管 GET
      for (const p of list) {
        const [a, b] = await Promise.all([f.c.ADMIN.raw("GET", p), ref.oc.ADMIN.raw("GET", p)]);
        await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
        n++;
        if (a.status !== b.status) diffs.push(`[${f.label}] ADMIN GET ${p}: full ${a.status} / old ${b.status}`);
      }
    });
    for (const key of ROLE_KEYS) jobs.push(async () => {
      for (const p of list) {
        for (const m of METHODS) {
          if (m !== "GET" && (SKIP_WRITE.some((re) => re.test(p)) || !p.startsWith("/api/admin/"))) continue;
          const body = m === "GET" ? undefined : {};
          const [a, b] = await Promise.all([f.c[key].raw(m, p, body), ref.oc[key].raw(m, p, body)]);
          const [ta, tb] = await Promise.all([a.text(), b.text()]);
          n++;
          if (a.status !== b.status || gateBody(a.status, ta) !== gateBody(b.status, tb))
            diffs.push(`[${f.label}] ${key} ${m} ${p}: full ${a.status} ${gateBody(a.status, ta)} / old ${b.status} ${gateBody(b.status, tb)}`);
        }
      }
    });
  }
  await Promise.all(jobs.map((j) => j()));
  diffs.sort();
  assert.ok(n > 4000, "requests " + n); // 迁移 64 收敛为 3 个内置角色后约 4,500 次（原阈值 6000 按 5 个角色定）
  assert.deepEqual(diffs.slice(0, 40), [], `${diffs.length} difference(s)`);
  // 模块开关与授权：去掉 culture 键之后逐字相同（键序也相同）；culture 键本身按配置
  // culture 与 ai（2026-09-29 登记，defaultOn:false）都是 M0 之后的模块：比较时去掉这两个键
  const minus = (o) => { const c = { ...(o || {}) }; delete c.culture; delete c.ai; return JSON.stringify(c); };
  for (const f of full) {
    for (const key of ["ADMIN", ...ROLE_KEYS]) {
      const [ma, mb] = await Promise.all([f.c[key].get("/api/me"), ref.oc[key].get("/api/me")]);
      assert.equal(minus(ma.data.modules), minus(mb.data.modules), `[${f.label}] /api/me modules ${key}`);
      assert.equal(ma.data.modules.culture, undefined, `[${f.label}] culture is not installed (Unfolding Lab edition) ${key}`);
      assert.equal(minus(ma.data.grants), minus(mb.data.grants), `[${f.label}] /api/me grants (minus culture) ${key}`);
    }
    const [ea, eb] = await Promise.all([fetch(f.s.base + "/api/env").then((r) => r.json()), fetch(ref.o.base + "/api/env").then((r) => r.json())]);
    assert.equal(minus(ea.modules), minus(eb.modules), `[${f.label}] /api/env modules`);
    assert.equal(ea.modules.culture, undefined);
  }
});
