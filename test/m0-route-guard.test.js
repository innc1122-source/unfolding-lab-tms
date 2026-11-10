// M0 未登记路由守卫 + 注册表校验。
//
//   1. 静态扫描 server.js handleApi 里的全部 /api 分支（pathname === "…"、
//      const x = pathname.match(/…/)、pathname.startsWith("…")）：任何一条没被某个
//      modules/<id>/manifest.js 的 routes 认领即失败，失败信息写明 server.js 行号、方法与路径。
//   2. 反向：manifest 登记了、server.js 里却找不到处理分支的路由也报出来。带 handler 的路由（第二段，culture 起）
//      不在 server.js 里写分支，改为对照模块工厂返回的 handlers（经模块自己的 test/harness.js 调用一次工厂）。
//   3. store.js 与 modules/*/migrations/*.sql 建的每张表必须恰好归属一个 manifest（tables；模块迁移建的表归该模块），
//      manifest 里的表必须真的有地方建。
//   4. kernel/registry.js 的校验规则逐条有反例测试；server.js 在清单无效时拒绝启动。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const registry = require("../kernel/registry.js");
const { scanServerRoutes } = require("./fixtures/route-scan.js");
// 临时目录一律经 helpers.tempDir 建：本进程退出时统一删除（失败的用例也不留残余目录）
const { tempDir } = require("./helpers.js");

const REG = registry.load();
const SCAN = scanServerRoutes();

const keyOfScan = (r) => (r.kind === "string" ? "s:" + r.path : "r:" + r.source + "/" + r.flags);
const keyOfManifest = (p) => (p instanceof RegExp ? "r:" + p.source + "/" + p.flags : "s:" + p);
const showScan = (r) => (r.kind === "string" ? r.path : "/" + r.source + "/" + r.flags);

// manifest 认领表：pathKey → Map(method → "module routes[i]")
const CLAIMS = new Map();
for (const r of REG.routes) {
  const k = keyOfManifest(r.path);
  if (!CLAIMS.has(k)) CLAIMS.set(k, new Map());
  for (const m of r.methods) CLAIMS.get(k).set(m, `${r.module} routes[${r.index}]`);
}

test("M0 guard: every pathname reference in handleApi is a recognised route form", () => {
  const bad = SCAN.unrecognized.map((u) => `server.js:${u.line}  ${u.text}`);
  assert.deepEqual(bad, [], "unrecognised route branch(es) — write them as pathname === \"…\" or const x = pathname.match(/…/), then register them in a manifest:\n" + bad.join("\n"));
  assert.ok(SCAN.routes.length >= 130, `scanner found only ${SCAN.routes.length} route patterns — is it still reading handleApi?`);
});

test("M0 guard: every /api route branch in server.js is claimed by a manifest", () => {
  const missing = [];
  for (const r of SCAN.routes) {
    const c = CLAIMS.get(keyOfScan(r));
    for (const m of r.methods) {
      if (!c || !(c.has(m) || c.has("*"))) missing.push(`server.js:${r.lines.join(",")}  ${m} ${showScan(r)}`);
    }
  }
  assert.deepEqual(missing, [], "route(s) not registered in any modules/<id>/manifest.js:\n" + missing.join("\n"));
});

test("M0 guard: every manifest route has a handler branch in server.js (same path, same methods) — except handler routes, which must have none", () => {
  const scanned = new Map(SCAN.routes.map((r) => [keyOfScan(r), r]));
  const orphans = [];
  for (const r of REG.routes) {
    const s = scanned.get(keyOfManifest(r.path));
    const label = `modules/${r.module}/manifest.js routes[${r.index}]  ${r.methods.join(",")} ${r.path instanceof RegExp ? String(r.path) : r.path}`;
    // 带 handler 的路由由内核分发给模块工厂的处理函数（server.js 只有一处 dispatchModuleRoute 调用），server.js
    // 里不得另有同路径的分支；它与工厂的对应关系见下一条。
    if (r.handler) { if (s) orphans.push(label + `  — a handler route must not also have a server.js branch (line ${s.lines.join(",")})`); continue; }
    if (!s) { orphans.push(label + "  — no handler branch found"); continue; }
    for (const m of r.methods) if (!s.methods.has(m)) orphans.push(label + `  — server.js handles ${[...s.methods].join(",")} (line ${s.lines.join(",")}), not ${m}`);
  }
  assert.deepEqual(orphans, [], "manifest route(s) with no matching server.js branch:\n" + orphans.join("\n"));
});

test("M0 guard: handler routes are served by their module's factory — the handlers it returns are exactly the manifest's, synchronous (checked by calling the factory once through the module's own test harness)", () => {
  const handlerModules = [...new Set(REG.routes.filter((r) => r.handler).map((r) => r.module))];
  assert.deepEqual(REG.HANDLER_MODULES, handlerModules);
  // Unfolding Lab 版（2026-10-12）：culture 已删除，目前没有模块声明 handler 路由；下面的循环对空列表不做检查。
  for (const id of handlerModules) {
    const harnessFile = path.join(ROOT, "modules", id, "test", "harness.js");
    assert.ok(fs.existsSync(harnessFile), `modules/${id} declares handler routes but ships no test/harness.js to exercise its factory (CONTRACT.md 12.1)`);
    const h = require(harnessFile).createHarness({});
    try {
      // 与 server.js 启动校验同一个函数：键集合一致、全部是同步函数、hooks 为注册表加载的同一对象
      assert.doesNotThrow(() => REG.validateFactory(id, h.module));
      const declared = REG.routes.filter((r) => r.module === id && r.handler).map((r) => r.handler).sort();
      assert.deepEqual(Object.keys(h.module.handlers).sort(), declared, `modules/${id}: factory handlers vs manifest routes`);
      assert.equal(new Set(declared).size, declared.length, `modules/${id}: handler names are unique`);
    } finally { h.close(); }
  }
});

test("M0 guard: the scanner really bites — an injected unregistered branch and an unknown form are both reported with line numbers", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").split(/\r?\n/);
  // 简化 10/11：后台接口分支已搬到 modules/*/routes.js，假分支插在 handleApi 后台块的管理员检查之后（仍在 handleApi 里）
  const at = src.findIndex((l) => l.includes('if (!isAdmin(user)) return send(res, 403')) + 1;
  assert.ok(at > 0);
  src.splice(at, 0,
    '    if (pathname === "/api/admin/new-thing" && req.method === "GET") return send(res, 200, {});',
    '    const newThing = pathname.match(/^\\/api\\/admin\\/new-thing\\/([\\w-]+)$/);',
    '    if (newThing && req.method === "DELETE") return send(res, 200, {});',
    '    if (pathname.endsWith("/sneaky")) return send(res, 200, {});');
  const tmp = path.join(tempDir("m0-scan-"), "server.js");
  fs.writeFileSync(tmp, src.join("\r\n"));
  const s = scanServerRoutes(tmp);
  const unclaimed = s.routes.filter((r) => { const c = CLAIMS.get(keyOfScan(r)); return [...r.methods].some((m) => !c || !(c.has(m) || c.has("*"))); });
  assert.deepEqual(unclaimed.map((r) => [showScan(r), [...r.methods], r.lines[0]]), [
    ["/api/admin/new-thing", ["GET"], at + 1],
    ["/^\\/api\\/admin\\/new-thing\\/([\\w-]+)$/", ["DELETE"], at + 2],
  ]);
  assert.deepEqual(s.unrecognized.map((u) => u.line), [at + 4]);
});

test("M0 guard: outside handleApi, pathname is only read by the kernel gates, serveStatic's pinned lines and the dispatcher", () => {
  const bad = SCAN.outside.map((o) => `server.js:${o.line}  [${o.fn}]  ${o.text}`);
  assert.deepEqual(bad, [], "path test(s) outside handleApi that no manifest knows about — move the route into handleApi and register it, or (static content) declare it in a manifest `static` list and pin the line in test/fixtures/route-scan.js OUTSIDE_LINES:\n" + bad.join("\n"));
});

test("M0 guard: the scanner also bites on compound conditions, req.url, loose match-variable tests and branches outside handleApi", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").split(/\r?\n/);
  // 简化 10/11：后台接口分支已搬到 modules/*/routes.js，假分支插在 handleApi 后台块的管理员检查之后（仍在 handleApi 里）
  const at = src.findIndex((l) => l.includes('if (!isAdmin(user)) return send(res, 403')) + 1;
  assert.ok(at > 0);
  src.splice(at, 0,
    // (at+1) recognised string route + a hidden endsWith on the same line
    '    if (pathname === "/api/admin/roles" || pathname.endsWith("/sneaky")) return send(res, 200, {});',
    // (at+2) routing on req.url instead of pathname
    '    if (req.url === "/api/admin/secret") return send(res, 200, {});',
    // (at+3..at+5) a registered regex with a method hidden behind an extra condition
    '    const rolePeek = pathname.match(/^\\/api\\/admin\\/roles\\/(\\d+)$/);',
    '    if (rolePeek && req.method === "GET") return send(res, 200, {});',
    '    if (rolePeek && req.method === "POST" && user) return send(res, 200, {});');
  // a second dispatcher next to the real one, and a new top-level helper reading pathname
  const cs = src.findIndex((l) => l.includes('if (pathname.startsWith("/api/")) {'));
  assert.ok(cs > at);
  src.splice(cs, 0, '  if (pathname === "/healthz") { res.end("ok"); return; }');
  const ss = src.findIndex((l) => l.startsWith("function serveStatic("));
  src.splice(ss + 1, 0, '  if (pathname.startsWith("/exports/")) return serveExport(req, res, pathname);');
  src.push("function sideRoute(req, res, pathname) {", '  if (pathname === "/api/side") return true;', "}");
  const tmp = path.join(tempDir("m0-scan-"), "server.js");
  fs.writeFileSync(tmp, src.join("\r\n"));
  const s = scanServerRoutes(tmp);
  const lineOf = (needle) => src.findIndex((l) => l.includes(needle)) + 1;
  assert.deepEqual(s.unrecognized.map((u) => u.line).sort((a, b) => a - b),
    [lineOf('pathname.endsWith("/sneaky")'), lineOf("req.url ==="), lineOf('req.method === "POST" && user')]);
  assert.deepEqual(s.outside.map((o) => [o.line, o.fn]), [
    [lineOf('/exports/'), "serveStatic"],
    [lineOf('"/healthz"'), "http.createServer"],
    [lineOf("function sideRoute("), "sideRoute"],
    [lineOf('"/api/side"'), "sideRoute"],
  ]);
});

test("M0 guard: the hand-kept RBAC domain lists outside server.js still equal the manifests' RBAC_DOMAINS", () => {
  // store.js (fullGrants / seed roles) and the admin UI keep their own copy of
  // the domains until M2/M4 (10 since culture was registered on 2026-09-26). A domain added to a manifest but not to these
  // lists would be silently dropped from stored grants, so they must move together.
  const lists = {
    "store.js RBAC_DOMAINS": [fs.readFileSync(path.join(ROOT, "store.js"), "utf8"), /const RBAC_DOMAINS = \[([^\]]*)\]/],
    "web/src/rbac.js CAPABILITY_DOMAINS": [fs.readFileSync(path.join(ROOT, "web", "src", "rbac.js"), "utf8"), /export const CAPABILITY_DOMAINS = \[([^\]]*)\]/],
    "web/src/pages/admin/Roles.jsx DOMAINS": [fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "Roles.jsx"), "utf8"), /const DOMAINS = \[([^\]]*)\]/],
  };
  for (const [label, [text, re]] of Object.entries(lists)) {
    const m = text.match(re);
    assert.ok(m, `${label}: list not found`);
    const got = [...m[1].matchAll(/["']([\w-]+)["']/g)].map((x) => x[1]);
    assert.deepEqual(got, REG.RBAC_DOMAINS, `${label} differs from the domains declared in modules/*/manifest.js`);
  }
});

test("M0 guard: the /videos session gate in serveStatic and the manifests' static list name the same prefix", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(src, /const isVideoPath = normLower === "\/videos" \|\| normLower\.startsWith\("\/videos\/"\);/);
  assert.deepEqual(REG.STATIC_GATES.filter((g) => g.prefix === "/videos" || g.module === "learning"), [{ prefix: "/videos", module: "learning" }]);
});

test("M0 guard: pathname.startsWith is only used for the kernel's /api/admin/ dispatch", () => {
  const stray = SCAN.prefixes.filter((p) => p.prefix !== registry.ADMIN_PREFIX).map((p) => `server.js:${p.line}  startsWith(${JSON.stringify(p.prefix)})`);
  assert.deepEqual(stray, [], "prefix-matched route(s) — register them as explicit routes:\n" + stray.join("\n"));
  assert.ok(SCAN.prefixes.some((p) => p.prefix === "/api/admin/"), "the /api/admin/ dispatch branch was not found");
});

test("M0 guard: every table created in store.js or in modules/*/migrations/*.sql has exactly one owning manifest, and every owned table exists", () => {
  const src = fs.readFileSync(path.join(ROOT, "store.js"), "utf8");
  const where = new Map();   // table → 在哪里建（store.js 里同一张表可以在多条迁移里出现，按一处算）
  const twice = [];
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) where.set(m[1], "store.js");
  // 模块迁移（第二段）：modules/<id>/migrations/*.sql 建的表必须归 <id> 所有，且恰好是该模块 manifest 的 tables；
  // 不得与 store.js 或别的模块重名
  const wrongOwner = [];
  const migDirs = fs.readdirSync(path.join(ROOT, "modules"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, "modules", d.name, "migrations"))).map((d) => d.name);
  // Unfolding Lab 版（2026-10-12）：culture 已删除，目前没有模块自带 migrations 目录。
  for (const id of migDirs) {
    const dir = path.join(ROOT, "modules", id, "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const entry = REG.MIGRATIONS.find((m) => m.module === id);
    assert.ok(entry, `modules/${id}/migrations has .sql files but modules/${id} is not a registered module that declares migrations`);
    assert.deepEqual([...entry.files], files, `modules/${id}/migrations: the registry runs every .sql file there`);
    const mine = new Set();
    for (const f of files) {
      for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) {
        const at = `modules/${id}/migrations/${f}`;
        if (where.has(m[1]) && !where.get(m[1]).startsWith(`modules/${id}/`)) twice.push(`${m[1]}: ${where.get(m[1])} and ${at}`);
        else if (!where.has(m[1])) where.set(m[1], at);
        mine.add(m[1]);
        if (REG.tableModule[m[1]] !== id) wrongOwner.push(`${m[1]} (${at}) is owned by ${REG.tableModule[m[1]] || "no manifest"}`);
      }
    }
    assert.deepEqual([...mine].sort(), REG.manifests.find((m) => m.id === id).tables.slice().sort(), `modules/${id}: the tables its migrations create equal its manifest tables`);
  }
  const owned = new Set(Object.keys(REG.tableModule));
  const unowned = [...where.keys()].filter((t) => !owned.has(t));
  const ghost = [...owned].filter((t) => !where.has(t));
  assert.deepEqual(twice, [], "table(s) created in two places: " + twice.join("; "));
  assert.deepEqual(wrongOwner, [], "module migration table(s) owned by another manifest: " + wrongOwner.join("; "));
  assert.deepEqual(unowned, [], "table(s) not listed in any manifest tables: " + unowned.join(", "));
  assert.deepEqual(ghost, [], "manifest table(s) not created anywhere in store.js or modules/*/migrations: " + ghost.join(", "));
  assert.equal([...where.values()].filter((w) => w.startsWith("modules/culture/")).length, 0, "culture removed: no p33_ tables");
});

test("M0 guard: MODULES.md ownership of the three sellable modules' tables is what the manifests say", () => {
  // review_dept_status：绩效流程 v2 的一级部门 HoD 提交 / HR 确认状态（迁移 65）
  // review_appeals / review_appeal_consults / review_appeal_events / hrbp_assignments：绩效申诉与 HRBP 分工（迁移 70，第二批 2.8）
  assert.deepEqual(REG.manifests.find((m) => m.id === "performance").tables, ["review_cycles", "review_items", "review_dept_status", "review_appeals", "review_appeal_consults", "review_appeal_events", "hrbp_assignments", "orgperf_rounds", "orgperf_targets", "orgperf_raters", "orgperf_answers", "orgperf_results"]);   // orgperf_*：组织绩效（迁移 95，2026-10-10）
  // talent_portraits：AI 人才画像（迁移 58，AI 治理方案 2.1.1 / 5.4）
  // talent_filters / talent_filter_members：第五批 8.1 人才筛选与晋升人工名单（迁移 80）
  // key_positions / talent_tag_events：12.2 关键岗位清单与受控人才标签留痕（迁移 86）
  assert.deepEqual(REG.manifests.find((m) => m.id === "talent").tables, ["succession", "talent_portraits", "talent_filters", "talent_filter_members", "key_positions", "talent_tag_events"]);
  assert.equal(REG.manifests.find((m) => m.id === "learning").tables.length, 12);
});

// ---------- registry validation: each rule has a counter-example ----------

// 已安装模块的 hooks（从已加载注册表还原，{ 模块: { 事件: fn } }）：core 订阅了 culture.program.completed（第二段），
// 就地改 manifest 再 build 时必须一并交给 build（hooks 只有 load() 会从磁盘读）。
const REG_HOOKS = (() => { const h = {}; for (const s of REG.events.subscriptions) (h[s.module] = h[s.module] || {})[s.type] = s.fn; return h; })();
// Fresh, mutable copies of the real manifests (RegExps cloned).
function cloneManifests() {
  const clone = (v) => (v instanceof RegExp ? new RegExp(v.source, v.flags)
    : Array.isArray(v) ? v.map(clone)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);
  return REG.manifests.map(clone);
}
const byId = (ms, id) => ms.find((m) => m.id === id);
function expectInvalid(mutate, pattern) {
  const ms = cloneManifests();
  mutate(ms);
  assert.throws(() => registry.build(ms, { hooks: REG_HOOKS }), (e) => { assert.match(e.message, pattern); return true; });
}

test("M0 registry: the real manifests build cleanly, and a clean clone rebuilds identical tables", () => {
  const again = registry.build(cloneManifests(), { hooks: REG_HOOKS });
  assert.deepEqual(again.RBAC_DOMAINS, REG.RBAC_DOMAINS);
  assert.deepEqual(again.RBAC_ROUTES.map((r) => [r.re.source, r.methods, r.domain]), REG.RBAC_ROUTES.map((r) => [r.re.source, r.methods, r.domain]));
});

test("M0 registry: rejects duplicate module ids", () => {
  expectInvalid((ms) => { byId(ms, "talent").id = "learning"; }, /duplicate module id "learning"/);
});

test("M0 registry: rejects an unmet or out-of-order requires", () => {
  expectInvalid((ms) => { byId(ms, "talent").requires = ["core", "payroll"]; }, /requires "payroll", which is not installed/);
  expectInvalid((ms) => { byId(ms, "learning").requires = ["core", "talent"]; }, /requires "talent", which must be listed before it/);
});

test("M0 registry: rejects a route whose domain no manifest declares", () => {
  expectInvalid((ms) => { byId(ms, "talent").routes[0].domain = "payroll"; }, /domain "payroll" is not declared by any manifest/);
});

test("M0 registry: rejects the same method + path claimed twice (across modules or within one)", () => {
  expectInvalid((ms) => { byId(ms, "talent").routes.push({ method: "GET", path: "/api/admin/programs", domain: "talent", order: 9999 }); },
    /GET is already claimed by \[learning\]/);
  expectInvalid((ms) => { byId(ms, "core").routes.push({ method: "POST", path: "/api/me", domain: null }); }, /POST is already claimed by \[core\]/);
});

test("M0 registry: rejects malformed fields", () => {
  expectInvalid((ms) => { byId(ms, "talent").routes[0].metod = "GET"; }, /unknown field "metod"/);
  expectInvalid((ms) => { byId(ms, "talent").colour = "red"; }, /unknown manifest field "colour"/);
  expectInvalid((ms) => { byId(ms, "talent").routes[0].method = "FETCH"; }, /unknown method "FETCH"/);
  expectInvalid((ms) => { byId(ms, "talent").name = { zh: "人才" }; }, /name must be \{ zh, en \}/);
  expectInvalid((ms) => { byId(ms, "core").sellable = true; }, /\[core\] sellable must be false/);
  expectInvalid((ms) => { byId(ms, "talent").routes.push({ method: "GET", path: "/api/me/x", domain: "talent" }); }, /only \/api\/admin\/ routes carry domain/);
  expectInvalid((ms) => { byId(ms, "talent").routes.push({ method: "GET", path: "/api/admin/talent-x", domain: null }); }, /needs exactly one of domain \/ shell:true \/ rbac:"custom"/);
  expectInvalid((ms) => { byId(ms, "talent").routes.push({ method: "GET", path: "/api/admin/talent-x", domain: "talent" }); }, /order \(first-match position\) is required/);
});

test("M0 registry: rejects an RBAC first-match order collision", () => {
  expectInvalid((ms) => { byId(ms, "talent").routes.push({ method: "GET", path: "/api/admin/talent-x", domain: "talent", order: 740 }); },
    /RBAC_ROUTES: order 740 is used by both/);
});

test("M0 registry: rejects a route that falls outside its own module's gate or inside another's", () => {
  // talent route that the talent gate does not cover
  expectInvalid((ms) => { byId(ms, "talent").routes.push({ method: "GET", path: "/api/admin/talent-x", domain: "talent", order: 745 }); },
    /sample \/api\/admin\/talent-x is gated as \(ungated\/core\), expected talent/);
  // core route swallowed by a learning gate
  expectInvalid((ms) => { byId(ms, "learning").gate.push("/api/me/notifications"); }, /sample \/api\/me\/notifications is gated as learning, expected \(ungated\/core\)/);
});

test("M0 registry: rejects duplicate domain / table ownership", () => {
  expectInvalid((ms) => { byId(ms, "talent").domains.push({ id: "people", name: { zh: "x", en: "x" }, order: 99 }); }, /domain "people" is already owned by module "core"/);
  expectInvalid((ms) => { byId(ms, "talent").tables.push("users"); }, /table "users" is already owned by module "core"/);
});

test("M0 registry: load() rejects a manifest whose id differs from its directory", () => {
  const dir = tempDir("m0-reg-");
  fs.mkdirSync(path.join(dir, "core"));
  fs.writeFileSync(path.join(dir, "index.js"), 'module.exports = ["core"];');
  fs.writeFileSync(path.join(dir, "core", "manifest.js"), 'module.exports = { id: "kore" };');
  assert.throws(() => registry.load({ dir }), /declares id "kore"/);
});

// ---------- startup refuses on an invalid registry ----------

test("M0 startup: server.js prints the reason and exits before opening the database when a manifest is invalid", () => {
  const tmp = tempDir("m0-boot-");
  for (const f of ["server.js", "store.js", "notify.js", "content.js", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, "kernel"), path.join(tmp, "kernel"), { recursive: true });
  fs.cpSync(path.join(ROOT, "modules"), path.join(tmp, "modules"), { recursive: true });
  // Break talent: point a route at a domain nobody declares.
  const mf = path.join(tmp, "modules", "talent", "manifest.js");
  const src = fs.readFileSync(mf, "utf8");
  const broken = src.replace('path: "/api/admin/talent-review", domain: "talent"', 'path: "/api/admin/talent-review", domain: "payroll"');
  assert.notEqual(broken, src, "fixture edit did not apply");
  fs.writeFileSync(mf, broken);
  const dbPath = path.join(tmp, "boot.db");
  const r = spawnSync(process.execPath, ["server.js"], {
    cwd: tmp,
    env: { ...process.env, LMS_DB_PATH: dbPath, LMS_CONFIG_PATH: path.join(tmp, "config.json"), LMS_ATTACH_DIR: path.join(tmp, "att"), PORT: "0", LMS_DISABLE_AI: "1", LMS_DISABLE_OFFICE_CONVERT: "1", LMS_DISABLE_VIDEO_TRANSCODE: "1" },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr:\n${r.stderr}`);
  assert.match(r.stderr, /refusing to start/);
  assert.match(r.stderr, /domain "payroll" is not declared by any manifest/);
  assert.equal(fs.existsSync(dbPath), false, "the database must not be opened when the registry is invalid");
  fs.rmSync(tmp, { recursive: true, force: true });
});
