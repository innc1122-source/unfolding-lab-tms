// M0 等价性证明：manifest → kernel/registry.js 生成的表，与 M0 之前 server.js 手写的表
// （逐字冻结在 test/fixtures/m0-legacy-tables.js）逐条相等、顺序相等；并且用新旧两套
// 判定逻辑（moduleOfPath / rbacGate / modulesOn / 静态门）对全部已知路由 × 5 个方法 ×
// 多组授权逐一比对，结果必须完全一致。
//
// 纯静态测试：不起服务、不开库。server.js 里的函数是按源码文本截取后注入依赖求值的，
// 所以测的是 server.js 里真正在跑的那段代码，而不是一份抄本。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const registry = require("../kernel/registry.js");
const LEGACY = require("./fixtures/m0-legacy-tables.js");
const { scanServerRoutes, samplePath } = require("./fixtures/route-scan.js");

// M0 的证明对象是 M0 当时的四个模块。之后新增的模块（如 culture）不在冻结夹具里，
// 所以逐条相等 / 行为比对都针对「只装这四个模块」时注册表生成的表（REG0）；
// 另有一项测试断言：装上后来的模块之后，这四个模块生成的条目仍原样、同序地出现在
// 全量表里，且 M0 已知路径的判定一个都不变（新模块只能新增，不能改动或抢先匹配旧路径）。
// 这样「加一个模块目录 + 在 modules/index.js 登记」不会让本文件失败，也不需要（也不允许）
// 更新冻结夹具。
const M0_IDS = ["core", "learning", "performance", "talent"];
const REG = registry.load();
const cloneDeep = (v) => (v instanceof RegExp ? new RegExp(v.source, v.flags)
  : Array.isArray(v) ? v.map(cloneDeep)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneDeep(x)])) : v);
// 只装 M0 四个模块时的 manifest 与 hooks。registry.build 要求「声明了 subscribes 的模块必须带 hooks」，
// 而 hooks 只有 load() 会从 modules/<id>/hooks.js 读 —— 不传的话，四个模块里任何一个将来声明订阅
// （ARCHITECTURE-MODULAR.md §4 的示例就是 talent 订阅 employee.terminated），本文件在加载时就整体报错、
// 一项都不跑。所以从已加载注册表的 events.subscriptions 还原 hooks（{ 模块: { 事件: fn } }）。
// 订阅了只有非 M0 模块才发布的事件的条目一并去掉：只装四个模块时它没有发布方，build 会拒绝。
// 冻结夹具不描述订阅，去掉这些条目不影响下面任何一条等价性证明。
function m0Parts(reg) {
  const manifests = reg.manifests.filter((m) => M0_IDS.includes(m.id)).map(cloneDeep);
  const published = new Set(manifests.flatMap((m) => m.publishes || []));
  const hooks = {};
  for (const m of manifests) {
    if (!Array.isArray(m.subscribes)) continue;
    m.subscribes = m.subscribes.filter((t) => published.has(t));
    for (const s of reg.events.subscriptions)
      if (s.module === m.id && m.subscribes.includes(s.type)) (hooks[m.id] = hooks[m.id] || {})[s.type] = s.fn;
  }
  return { manifests, hooks };
}
const m0Only = (reg) => { const p = m0Parts(reg); return registry.build(p.manifests, { hooks: p.hooks }); };
// 全部模块的 hooks（从已加载注册表还原），给就地改 manifest 再 build 的测试用。
const regHooks = (reg) => {
  const out = {};
  for (const s of reg.events.subscriptions) (out[s.module] = out[s.module] || {})[s.type] = s.fn;
  return out;
};
const REG0 = m0Only(REG);

// ---------- M0 之后给 M0 模块**新增**的路由 ----------
// 冻结夹具只描述 M0 当时的表。之后往 core/learning/performance/talent 里新增路由是正常演进
// （第一例：core 的 GET /api/admin/departments/hods 与 hods.csv —— 3+3 行为实践前置的 HoD 名单），
// 既不能改冻结夹具（永远不改），也不该让本文件因此失败。原来「逐条相等」的断言因此放宽为
// 三条，缺一不可（assertM0Additions）：
//   1. 冻结表的每一条仍然存在、相对顺序不变（新增条目只能插在它们之间或之后）；
//   2. 冻结探针路径（M0 当时已知的全部路径）的判定结果一个都不变（下面的行为比对照旧跑，
//      用的是含新增条目的全量 M0 表）；
//   3. 新增条目只认领新路径：它的正则不匹配任何冻结探针路径 —— 不许抢先匹配旧路径，
//      哪怕判定碰巧相同。
// 「新增」是**算出来的**，不是手写白名单：M0 模块里一条后台路由生成的 RBAC 条目（正则 +
// 方法 + 能力域）在冻结表里找不到，它就算新增。改动旧路由（换正则、换能力域、给旧路径加
// 一个别的能力域的方法）会同时让一条冻结条目消失，断言 1 照样报出来 —— 那种改动仍然必须
// 显式登记，不会被当成「新增」放过。另外，去掉这些新增路由后生成的表（REG0_FROZEN）必须与
// 冻结夹具逐条相等：原来的四项逐条相等测试就跑在 REG0_FROZEN 上，证明新增之外一字未改。
const reSig = (re) => re.source + "/" + re.flags;
const rbacEntryKey = (r) => reSig(r.re) + " " + JSON.stringify(r.methods || null) + " -> " + r.domain;
const LEGACY_RB = new Set(LEGACY.RBAC_ROUTES.map(rbacEntryKey));
const LEGACY_SHELL = new Set(LEGACY.RBAC_SHELL.map(reSig));
const routeKey = (r) => (r.path instanceof RegExp ? "r:" + r.path.source + "/" + r.path.flags : "s:" + r.path);
function m0AddedRoutes(reg) {
  const base = m0Only(reg);
  const extraRb = base.RBAC_ROUTES.filter((e) => !LEGACY_RB.has(rbacEntryKey(e)));
  const extraShell = new Set(base.RBAC_SHELL.map(reSig).filter((k) => !LEGACY_SHELL.has(k)));
  return base.routes.filter((r) => {
    if (typeof r.domain === "string") {
      const sig = reSig(registry.exactRe(r.rbacPath || r.path));
      return extraRb.some((e) => reSig(e.re) === sig && e.domain === r.domain
        && (!e.methods || r.methods.includes("*") || r.methods.some((m) => e.methods.includes(m))));
    }
    if (r.rbac === "custom") return customUnderNewGate(reg, r);
    return !!r.shell && extraShell.has(reSig(registry.exactRe(r.path)));
  });
}
// rbac:"custom" 路由没有能力域，不进 RBAC_ROUTES，上面两条规则数不到它。M0 时唯一的一条（core 的 /api/admin/dept-tree）
// 没有 gate；第二批 2.8（2026-10-08）的绩效申诉台是第一条挂在 **M0 之后新增的 gate**（"/api/admin/review-appeals"）下的
// custom 路由。规则：样例路径被同一模块的一条新增 gate 认领（不在冻结表里）→ 算新增。新增 gate 本身只许认领新路径
// （下面的 gate 断言），所以这条规则放不过任何改动旧路径的条目。
function customUnderNewGate(reg, r) {
  const sample = registry.samplePath(r.path);
  const m = reg.manifests.find((x) => x.id === r.module);
  return !!m && (m.gate || []).some((g) => !LEGACY_GATE.has(gateKey(g, m.id)) && gateClaims(g, sample));
}
// M0 之后给 M0 模块新增的 gate 条目（同样是算出来的：冻结表里没有的 [模式, 模块]）。例如 2026-09-29 AI 治理给 talent 加的
// "/api/admin/talent-portraits"。新增 gate 只许认领新路径：它不得匹配冻结表里的任何字符串路径（见下方断言）。
const gateKey = (p, mod) => mod + " " + (typeof p === "string" ? "s:" + p : "r:" + p.source + "/" + p.flags);
const LEGACY_GATE = new Set(LEGACY.MODULE_ROUTES.map(([p, m]) => gateKey(p, m)));
const gateClaims = (pat, pathname) => (typeof pat === "string" ? pathname === pat || pathname.startsWith(pat + "/") : pat.test(pathname));
// 去掉新增路由与新增 gate 条目之后的 M0 表 —— 必须与冻结夹具逐条相等。
function m0Frozen(reg) {
  const added = new Set(m0AddedRoutes(reg).map((r) => r.module + "#" + r.index));
  const p = m0Parts(reg);
  return registry.build(p.manifests.map((m) => ({
    ...m,
    routes: m.routes.filter((_, i) => !added.has(m.id + "#" + i)),
    gate: (m.gate || []).filter((g) => LEGACY_GATE.has(gateKey(g, m.id))),
  })), { hooks: p.hooks });
}
test("M0: gate entries added after M0 claim only new paths — none of them matches a frozen pre-M0 gate path", () => {
  const legacyPaths = LEGACY.MODULE_ROUTES.map(([p]) => p).filter((p) => typeof p === "string");
  for (const m of m0Parts(REG).manifests)
    for (const g of m.gate || []) {
      if (LEGACY_GATE.has(gateKey(g, m.id))) continue;
      for (const lp of legacyPaths) assert.equal(gateClaims(g, lp), false, `[${m.id}] new gate ${String(g)} claims the pre-M0 path ${lp}`);
    }
});
const REG0_FROZEN = m0Frozen(REG);
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").replace(/\r\n/g, "\n");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// 截取 server.js 顶格定义的函数原文（从 `function name(` 到下一行顶格的 `}`）。
function serverFunction(name) {
  const lines = SERVER_SRC.split("\n");
  const s = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(s >= 0, `server.js: function ${name} not found`);
  const e = lines.findIndex((l, i) => i > s && l === "}");
  return lines.slice(s, e + 1).join("\n");
}

const reKey = (re) => ({ source: re.source, flags: re.flags });

test("M0: generated MODULE_ROUTES (minus post-M0 additions) equals the frozen pre-M0 table, entry by entry and in order", () => {
  assert.equal(REG0_FROZEN.MODULE_ROUTES.length, LEGACY.MODULE_ROUTES.length);
  REG0_FROZEN.MODULE_ROUTES.forEach(([pat, mod], i) => {
    const [lp, lm] = LEGACY.MODULE_ROUTES[i];
    assert.equal(mod, lm, `MODULE_ROUTES[${i}] module`);
    assert.equal(typeof pat, typeof lp, `MODULE_ROUTES[${i}] pattern kind`);
    if (typeof lp === "string") assert.equal(pat, lp, `MODULE_ROUTES[${i}]`);
    else assert.deepEqual(reKey(pat), reKey(lp), `MODULE_ROUTES[${i}]`);
  });
});

test("M0: generated RBAC_DOMAINS (minus post-M0 additions) equals the frozen list (same ids, same order)", () => {
  assert.deepEqual(REG0_FROZEN.RBAC_DOMAINS, LEGACY.RBAC_DOMAINS);
});

test("M0: generated RBAC_SHELL / RBAC_READONLY (minus post-M0 additions) equal the frozen lists (source, flags, order)", () => {
  assert.deepEqual(REG0_FROZEN.RBAC_SHELL.map(reKey), LEGACY.RBAC_SHELL.map(reKey));
  assert.deepEqual(REG0_FROZEN.RBAC_READONLY.map(reKey), LEGACY.RBAC_READONLY.map(reKey));
});

test("M0: generated RBAC_ROUTES (minus post-M0 additions) equals the frozen table row for row (regex, methods, domain, first-match order)", () => {
  assert.equal(REG0_FROZEN.RBAC_ROUTES.length, LEGACY.RBAC_ROUTES.length);
  REG0_FROZEN.RBAC_ROUTES.forEach((r, i) => {
    const l = LEGACY.RBAC_ROUTES[i];
    assert.deepEqual(reKey(r.re), reKey(l.re), `RBAC_ROUTES[${i}] regex`);
    assert.deepEqual(r.methods, l.methods, `RBAC_ROUTES[${i}] methods (${l.re})`);
    assert.equal(r.domain, l.domain, `RBAC_ROUTES[${i}] domain (${l.re})`);
    assert.deepEqual(Object.keys(r).sort(), Object.keys(l).sort(), `RBAC_ROUTES[${i}] keys`);
  });
});

test("M0: server.js reads the generated tables — no hand-written copies left, gate functions untouched", () => {
  for (const name of ["MODULE_ROUTES", "RBAC_DOMAINS", "RBAC_SHELL", "RBAC_READONLY", "RBAC_ROUTES"]) {
    assert.match(SERVER_SRC, new RegExp(`^const ${name} = REGISTRY\\.${name};$`, "m"), `${name} must come from the registry`);
    assert.doesNotMatch(SERVER_SRC, new RegExp(`^const ${name} = \\[`, "m"), `${name} is hand-written again`);
  }
  // The two decision functions are byte-identical to pre-M0, so equal tables ⇒ equal behaviour.
  assert.equal(serverFunction("moduleOfPath"), LEGACY.LEGACY_SOURCE.moduleOfPath);
  assert.equal(serverFunction("rbacGate"), LEGACY.LEGACY_SOURCE.rbacGate);
});

// ---------- behavioural comparison over every known route ----------

// 探针：server.js 静态扫描出的全部分支 + MODULES.md §2.1 路由清单 + 边界探针。
// mdText 缺省读仓库里的 MODULES.md（不存在时为空）；测试可以传入改过的文本。
const MD_PATH = path.join(ROOT, "MODULES.md");
const MD_TEXT = fs.existsSync(MD_PATH) ? fs.readFileSync(MD_PATH, "utf8").replace(/\r\n/g, "\n") : "";
function probePaths(reg = REG, mdText = MD_TEXT) {
  const set = new Set();
  // 后来模块认领的分支、以及 M0 之后给 M0 模块新增的分支（m0AddedRoutes），都不是 M0 的已知
  // 路由，不进探针（旧表里它们本来就不存在）。新增分支不会抢先匹配这些冻结探针，由
  // assertM0Additions 的第 3 条保证。
  const laterRoutes = [...reg.routes.filter((r) => !M0_IDS.includes(r.module)), ...m0AddedRoutes(reg)];
  const later = new Set(laterRoutes.map(routeKey));
  for (const r of scanServerRoutes().routes) if (!later.has(r.kind === "string" ? "s:" + r.path : "r:" + r.source + "/" + r.flags)) set.add(samplePath(r));
  // MODULES.md is an internal planning doc and is NOT shipped in the handover
  // zip (scripts/package-handover.js INCLUDE), so the unpacked test suite must
  // run without it; the scan + manifest probes above/below still cover every route.
  // MODULES.md §2.1 是**活文档**：给新接口补登记是正常维护（第一例：hods / hods.csv）。它解析出的
  // 路径若恰好就是某条后来新增路由的样例路径，就不是 M0 的已知路径，与上面的扫描探针同样剔除 ——
  // 否则一次正常的文档维护会让这里报「新增路由认领了冻结路径」。只剔除与新增路由样例路径**完全相同**
  // 的路径：新增路由若抢先匹配了别的旧路径，那条旧路径仍在探针里，照样被 assertM0Additions 第 3 条拦下。
  const laterSamples = new Set(laterRoutes.map((r) => registry.samplePath(r.path)));
  const md = mdText || "";
  const sec = md ? md.slice(md.indexOf("### 2.1"), md.indexOf("### 2.2")) : "";
  for (const m of sec.matchAll(/^\|[^|]*\|\s*(\/api\/[^\s|]*)\s*\|/gm)) {
    const p = m[1].replace(/:[A-Za-z]+/g, "123");
    if (!laterSamples.has(p)) set.add(p);
  }
  for (const r of REG0_FROZEN.routes) set.add(registry.samplePath(r.path));
  for (const [p] of LEGACY.MODULE_ROUTES) if (typeof p === "string") { set.add(p); set.add(p + "/x"); set.add(p + "x"); }
  const extra = [
    "/api/admin/employees/bulk", "/api/admin/employees/bulk-update", "/api/admin/employees/bulk-reset",
    "/api/admin/employees/bulk/x", "/api/admin/employees/E-1/detail/x", "/api/admin/employees/a.b/detail",
    "/api/admin/roles/abc", "/api/admin/roles/12", "/api/admin/Roles", "/api/admin/", "/api/admin/unknown",
    "/api/admin/dashboard/", "/api/admin/export/records.csv", "/api/admin/export/recordsXcsv", "/api/admin/export/other.csv",
    "/api/me/sessions/a.b/checkin", "/api/me/classes/p/checkin/a", "/api/me/classes/p/checkin", "/api/me/reports/u1",
    "/api/me/growth", "/api/me/team/x", "/api/examx", "/api/exam", "/api/exam-attempts", "/api/", "/api/nope",
    "/API/ADMIN/PROGRAMS", "/api/admin/programs/", "/api/admin/tprojects/t1/checkin/a1/mark",
  ];
  extra.forEach((p) => set.add(p));
  return [...set].sort();
}

const GRANT_PROFILES = (() => {
  const out = [{}];
  for (const d of LEGACY.RBAC_DOMAINS) { out.push({ [d]: "read" }); out.push({ [d]: "manage" }); }
  out.push(Object.fromEntries(LEGACY.RBAC_DOMAINS.map((d) => [d, "read"])));
  out.push(Object.fromEntries(LEGACY.RBAC_DOMAINS.map((d) => [d, "manage"])));
  out.push({ people: "manage", learning: "read", talent: "read", fields: "read" });
  return out;
})();

function stubsFor(grants) {
  // resolveGrants: non-super-admin shape (roles forced none, as in server.js).
  const resolveGrants = () => ({ ...grants, roles: "none" });
  const canRead = (_u, d) => { const l = resolveGrants()[d]; return l === "read" || l === "manage"; };
  return { resolveGrants, canRead };
}

function newRbacGateFactory() {
  const src = serverFunction("rbacGate");
  // eslint-disable-next-line no-new-func
  return new Function("RBAC_SHELL", "RBAC_READONLY", "RBAC_ROUTES", "canRead", "resolveGrants", `${src}\nreturn rbacGate;`);
}

test("M0: moduleOfPath — new (server.js + generated table) and old (frozen) agree on every probe", () => {
  // eslint-disable-next-line no-new-func
  const newModuleOfPath = new Function("MODULE_ROUTES", `${serverFunction("moduleOfPath")}\nreturn moduleOfPath;`)(REG0.MODULE_ROUTES);
  const probes = probePaths();
  assert.ok(probes.length > 150, `expected a broad probe set, got ${probes.length}`);
  for (const p of probes) assert.equal(newModuleOfPath(p), LEGACY.moduleOfPath(p), `moduleOfPath(${p})`);
});

test("M0: rbacGate — new and old agree for every probe × method × grants profile", () => {
  const factory = newRbacGateFactory();
  const probes = probePaths();
  let checked = 0;
  for (const grants of GRANT_PROFILES) {
    const stubs = stubsFor(grants);
    const oldGate = LEGACY.makeLegacyRbacGate(stubs);
    const newGate = factory(REG0.RBAC_SHELL, REG0.RBAC_READONLY, REG0.RBAC_ROUTES, stubs.canRead, stubs.resolveGrants);
    for (const p of probes) {
      for (const m of METHODS) {
        assert.deepEqual(newGate({}, p, m), oldGate({}, p, m), `rbacGate(${JSON.stringify(grants)}, ${m} ${p})`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10000, `checked ${checked}`);
});

test("M0: modulesOn — same keys, same order, same values for every config/env combination", () => {
  const src = serverFunction("modulesOn");
  const configs = [{}, { modules: {} }, { modules: { learning: false } }, { modules: { performance: false, talent: false } },
    { modules: { learning: false, performance: false, talent: false } }, { modules: { learning: "no", talent: 0 } }, { modules: { core: false } }];
  const envs = ["", "learning", "performance, TALENT", "core,unknown", " learning , talent ", "learning,performance,talent"];
  for (const cfg of configs) {
    for (const off of envs) {
      const env = off ? { LMS_MODULES_OFF: off } : {};
      const oldFn = LEGACY.makeLegacyModulesOn(() => cfg, env);
      // eslint-disable-next-line no-new-func
      const newFn = new Function("readConfig", "process", "REGISTRY", `${src}\nreturn modulesOn;`)(() => cfg, { env }, REG0);
      assert.equal(JSON.stringify(newFn()), JSON.stringify(oldFn()), `modulesOn(${JSON.stringify(cfg)}, ${JSON.stringify(off)})`);
    }
  }
});

test("M0: /videos static gate — registry decides exactly what the pre-M0 isVideoPath test decided", () => {
  // pre-M0: `normLower === "/videos" || normLower.startsWith("/videos/")` → learning
  const legacyGate = (normLower) => (normLower === "/videos" || normLower.startsWith("/videos/") ? "learning" : null);
  const probes = ["/videos", "/VIDEOS", "/videos/", "/videos/a.mp4", "/Videos/Clip.MP4", "/videos\\x.mp4", "/videos/../x",
    "/videosx", "/video", "/", "/index.html", "/assets/videos/a.mp4", "/videos/sub/dir/a.mp4", "//videos/a.mp4"];
  for (const p of probes) {
    const norm = path.normalize(p).replace(/\\/g, "/");
    const normLower = norm.toLowerCase();
    assert.equal(REG0.moduleOfStatic(normLower), legacyGate(normLower), `static gate ${p}`);
  }
  assert.deepEqual(REG0.STATIC_GATES, [{ prefix: "/videos", module: "learning" }]);
  assert.match(SERVER_SRC, /const staticModule = REGISTRY\.moduleOfStatic\(normLower\);/);
});

test("M0: SELLABLE comes from manifest sellable flags and matches the three pre-M0 switch keys", () => {
  assert.deepEqual(REG0.SELLABLE, ["learning", "performance", "talent"]);
  assert.deepEqual(Object.keys(LEGACY.makeLegacyModulesOn(() => ({}), {})()), REG0.SELLABLE);
});

// ---------- later modules may only ADD: the M0 part of the live registry is untouched ----------

// a 是 b 的有序子序列（按 key 比较），返回 b 中不属于 a 的条目。
function orderedExtras(a, b, key, label) {
  let i = 0;
  const extras = [];
  for (const x of b) { if (i < a.length && key(x) === key(a[i])) i++; else extras.push(x); }
  assert.equal(i, a.length, `${label}: the M0 entries are no longer all present in the same order (stopped at M0 entry #${i}: ${a[i] && key(a[i])})`);
  return extras;
}
const mrKey = ([p, m]) => (typeof p === "string" ? "s:" + p : "r:" + p.source + "/" + p.flags) + " -> " + m;
const rbKey = (r) => r.re.source + "/" + r.re.flags + " " + JSON.stringify(r.methods || null) + " -> " + r.domain;
const reK = (re) => re.source + "/" + re.flags;

function assertM0Preserved(reg, label) {
  const base = m0Only(reg);
  const later = reg.manifests.filter((m) => !M0_IDS.includes(m.id)).map((m) => m.id);
  // 1. 表级：M0 条目原样同序；多出来的条目只能属于后来的模块。
  const extraMR = orderedExtras(base.MODULE_ROUTES, reg.MODULE_ROUTES, mrKey, label + " MODULE_ROUTES");
  for (const [, m] of extraMR) assert.ok(later.includes(m), `${label}: extra MODULE_ROUTES entry for M0 module ${m}`);
  orderedExtras(base.RBAC_DOMAINS, reg.RBAC_DOMAINS, String, label + " RBAC_DOMAINS");
  orderedExtras(base.RBAC_SHELL, reg.RBAC_SHELL, reK, label + " RBAC_SHELL");
  orderedExtras(base.RBAC_READONLY, reg.RBAC_READONLY, reK, label + " RBAC_READONLY");
  orderedExtras(base.RBAC_ROUTES, reg.RBAC_ROUTES, rbKey, label + " RBAC_ROUTES");
  assert.deepEqual(reg.SELLABLE.filter((k) => M0_IDS.includes(k)), base.SELLABLE, label + " SELLABLE");
  // 2. 行为级：M0 已知路径上，全量表的判定与冻结表完全一致（新模块不得抢先匹配旧路径）。
  // eslint-disable-next-line no-new-func
  const mop = new Function("MODULE_ROUTES", `${serverFunction("moduleOfPath")}\nreturn moduleOfPath;`)(reg.MODULE_ROUTES);
  const factory = newRbacGateFactory();
  const probes = probePaths(reg);
  for (const p of probes) assert.equal(mop(p), LEGACY.moduleOfPath(p), `${label}: moduleOfPath(${p})`);
  // 第二段的模块路由分发（handler 路由，culture 起）：M0 已知路径在任何方法下都匹配不到模块路由，也不在任何
  // handler gate 内 —— 分发层对它们一律交回 handleApi 原有分支（PHASE2-KERNEL.md 8.2）。
  for (const p of probes) {
    for (const m of METHODS) assert.equal(reg.matchModuleRoute(m, p), null, `${label}: matchModuleRoute(${m} ${p})`);
    assert.equal(reg.isModuleHandlerPath(p), false, `${label}: isModuleHandlerPath(${p})`);
  }
  for (const grants of GRANT_PROFILES) {
    const stubs = stubsFor(grants);
    const oldGate = LEGACY.makeLegacyRbacGate(stubs);
    const newGate = factory(reg.RBAC_SHELL, reg.RBAC_READONLY, reg.RBAC_ROUTES, stubs.canRead, stubs.resolveGrants);
    for (const p of probes) for (const m of METHODS) assert.deepEqual(newGate({}, p, m), oldGate({}, p, m), `${label}: rbacGate(${JSON.stringify(grants)}, ${m} ${p})`);
  }
  for (const p of ["/videos", "/videos/a.mp4", "/assets/x.js", "/"]) assert.equal(reg.moduleOfStatic(p), base.moduleOfStatic(p), `${label}: static gate ${p}`);
}

test("M0: the live registry (with any modules installed after M0) keeps every M0 table entry in place and every M0 decision unchanged", () => {
  // Unfolding Lab 版（2026-10-12）：culture 已删除，目前没有模块声明 handler 路由；下面的分发检查对空表成立。
  assertM0Preserved(REG, "installed modules");
});

test("M0: adding a module is one directory + one line in modules/index.js — the registry accepts it and M0 behaviour is untouched", (t) => {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m0-newmod-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));   // 断言失败也删掉副本
  fs.cpSync(path.join(ROOT, "modules"), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "demo", "manifest.js"), [
    '"use strict";',
    "module.exports = {",
    '  id: "demo", name: { zh: "示例模块", en: "Demo" }, sellable: true, requires: ["core"], optional: [],',
    '  domains: [{ id: "demo", name: { zh: "示例", en: "Demo" }, order: 100 }],',
    '  gate: ["/api/demo", "/api/admin/demo"],',
    "  routes: [",
    '    { method: "GET", path: "/api/demo/items", domain: null },',
    '    { method: "GET", path: "/api/admin/demo", domain: "demo", order: 5 },',
    '    { methods: ["PUT", "DELETE"], path: /^\\/api\\/admin\\/demo\\/([\\w-]+)$/, domain: "demo", order: 6 },',
    "  ],",
    '  static: [],',
    '  tables: ["demo_items"],',
    "};",
  ].join("\r\n"));
  // the one registration line (not require()d here: a cached copy would hide the edit from load())
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = " + JSON.stringify([...REG.ids, "demo"]) + ";\r\n");
  const reg = registry.load({ dir });
  assert.ok(reg.ids.includes("demo"));
  assert.deepEqual(reg.SELLABLE, [...REG.SELLABLE, "demo"]);
  assert.ok(reg.RBAC_DOMAINS.includes("demo"));
  assert.equal(reg.MODULE_ROUTES.find(([p]) => p === "/api/demo")[1], "demo");
  assert.equal(reg.RBAC_ROUTES.find((r) => r.re.test("/api/admin/demo/x1")).domain, "demo");
  assertM0Preserved(reg, "with demo module");
});

test("M0: the preservation check bites — a later entry that pre-empts an M0 path, or an M0 entry moved, is reported", () => {
  const withTables = (patch) => ({ ...REG, moduleOfStatic: REG.moduleOfStatic, ...patch });
  // a later module's RBAC entry placed first and matching an existing M0 path
  const swallow = { re: /^\/api\/admin\/programs(\/.*)?$/, domain: "talent" };
  assert.throws(() => assertM0Preserved(withTables({ RBAC_ROUTES: [swallow, ...REG.RBAC_ROUTES] }), "pre-empt"), /rbacGate/);
  // an M0 MODULE_ROUTES entry moved out of order
  const mr = REG.MODULE_ROUTES.slice();
  mr.push(mr.shift());
  assert.throws(() => assertM0Preserved(withTables({ MODULE_ROUTES: mr }), "moved"), /MODULE_ROUTES/);
});

// ---------- post-M0 additions to M0 modules: frozen entries in place, new entries only on new paths ----------

// 断言 1 与 3（断言 2 是上面的行为比对，跑在含新增条目的全量表上）：M0 四个模块生成的表里，
// 冻结条目原样同序；多出来的条目（M0 之后新增）一条都不匹配冻结探针路径。
function assertM0Additions(reg, label, mdText = MD_TEXT) {
  const base = m0Only(reg);
  const probes = probePaths(reg, mdText);
  const extraMR = orderedExtras(LEGACY.MODULE_ROUTES, base.MODULE_ROUTES, mrKey, label + " MODULE_ROUTES");
  orderedExtras(LEGACY.RBAC_DOMAINS, base.RBAC_DOMAINS, String, label + " RBAC_DOMAINS");
  const extraShell = orderedExtras(LEGACY.RBAC_SHELL, base.RBAC_SHELL, reK, label + " RBAC_SHELL");
  const extraRO = orderedExtras(LEGACY.RBAC_READONLY, base.RBAC_READONLY, reK, label + " RBAC_READONLY");
  const extraRB = orderedExtras(LEGACY.RBAC_ROUTES, base.RBAC_ROUTES, rbKey, label + " RBAC_ROUTES");
  const claims = (pat, p) => (typeof pat === "string" ? p === pat || p.startsWith(pat + "/") : pat.test(p));
  const bad = [];
  for (const [pat, m] of extraMR) for (const p of probes) if (claims(pat, p)) bad.push(`MODULE_ROUTES ${pat} (${m}) claims frozen path ${p}`);
  for (const re of [...extraShell, ...extraRO]) for (const p of probes) if (re.test(p)) bad.push(`${re} claims frozen path ${p}`);
  for (const e of extraRB) for (const p of probes) if (e.re.test(p)) bad.push(`RBAC_ROUTES ${e.re} -> ${e.domain} claims frozen path ${p}`);
  assert.deepEqual(bad, [], `${label}: post-M0 additions to M0 modules must only claim new paths`);
  return { MODULE_ROUTES: extraMR, RBAC_SHELL: extraShell, RBAC_READONLY: extraRO, RBAC_ROUTES: extraRB };
}

test("M0: routes added to M0 modules after M0 keep every frozen entry in place (same relative order) and only claim new paths", () => {
  const extras = assertM0Additions(REG, "installed modules");
  // 多出来的 RBAC 条目恰好就是 m0AddedRoutes 算出来的那一组（不多不少）：「新增」的判定与
  // 探针的排除用的是同一个集合，没有哪条新增逃过第 3 条检查。
  const addedSigs = new Set(m0AddedRoutes(REG).filter((r) => typeof r.domain === "string").map((r) => reSig(registry.exactRe(r.rbacPath || r.path))));
  assert.deepEqual(new Set(extras.RBAC_ROUTES.map((e) => reSig(e.re))), addedSigs);
  // 去掉新增之后与冻结夹具逐条相等（上面四项逐条测试的前提），这里再对条数兜一次底。
  assert.equal(REG0_FROZEN.RBAC_ROUTES.length, LEGACY.RBAC_ROUTES.length);
  assert.equal(REG0.RBAC_ROUTES.length, LEGACY.RBAC_ROUTES.length + extras.RBAC_ROUTES.length);
});

test("M0: the additions check bites — an added route that pre-empts a frozen path, or a changed M0 route, is reported", () => {
  const edited = (edit) => { const ms = REG.manifests.map(cloneDeep); edit(ms); return registry.build(ms, { hooks: regHooks(REG) }); };
  const core = (ms) => ms.find((m) => m.id === "core");
  // (a) 新增一条正则覆盖旧路径（/api/admin/org-chart、/api/admin/org-diagnostics）的路由：判定碰巧相同（都是 people），
  //     但它抢先匹配了冻结路径 —— 第 3 条报出来。
  const preempt = edited((ms) => core(ms).routes.push({ method: "GET", path: /^\/api\/admin\/org-([\w-]+)$/, domain: "people", order: 185 }));
  assert.throws(() => assertM0Additions(preempt, "pre-empt"), /only claim new paths/);
  // (b) 改动一条旧路由的能力域：冻结条目消失 —— 第 1 条报出来（不会被当成「新增」放过）。
  const changed = edited((ms) => { core(ms).routes.find((r) => r.path === "/api/admin/org-chart").domain = "talent"; });
  assert.throws(() => assertM0Additions(changed, "changed"), /no longer all present/);
  assert.notEqual(m0Frozen(changed).RBAC_ROUTES.length, LEGACY.RBAC_ROUTES.length);
  // (c) 纯新增、只认领新路径：通过。
  const clean = edited((ms) => core(ms).routes.push({ method: "GET", path: "/api/admin/m0-probe-new", domain: "people", order: 186 }));
  assert.doesNotThrow(() => assertM0Additions(clean, "clean"));
});

test("M0: an rbac:\"custom\" route counts as an addition only under a gate that is itself new (first case: /api/admin/review-appeals, 2.8)", () => {
  const keyOf = (r) => r.module + " " + routeKey(r);
  const added = new Set(m0AddedRoutes(REG).map(keyOf));
  const appeal = REG.routes.filter((r) => r.rbac === "custom" && typeof r.path === "string" && r.path.startsWith("/api/admin/review-appeals"));
  assert.ok(appeal.length >= 3, "the appeal desk routes are registered");
  for (const r of appeal) assert.ok(added.has(keyOf(r)), "counted as added: " + routeKey(r));
  // 反例：M0 时就有的 custom 路由（core 的 /api/admin/dept-tree，没有 gate）不算新增；挂在旧 gate 下的新 custom 路由也不算
  const deptTree = REG.routes.find((r) => r.rbac === "custom" && r.path === "/api/admin/dept-tree");
  assert.ok(deptTree && !added.has(keyOf(deptTree)), "dept-tree stays a frozen route");
  const ms = REG.manifests.map(cloneDeep);
  ms.find((m) => m.id === "performance").routes.push({ method: "GET", path: "/api/admin/review-cycles/custom-probe/x", domain: null, rbac: "custom" });
  const reg2 = registry.build(ms, { hooks: regHooks(REG) });
  const probe = reg2.routes.find((r) => r.path === "/api/admin/review-cycles/custom-probe/x");
  assert.ok(probe && !m0AddedRoutes(reg2).some((r) => keyOf(r) === keyOf(probe)), "a custom route outside every new gate is not an addition");
});

test("M0: registering new M0 routes in MODULES.md §2.1 (routine doc upkeep) does not trip the additions check — only exact sample paths of added routes are skipped", () => {
  // 第一例：把 hods / hods.csv 补进 §2.1。以前 §2.1 解析出的路径不做剔除、直接当作「冻结探针」，
  // 这一次正常的文档维护会让本文件 5 项失败（新增路由「认领了冻结路径」、rbacGate 新旧表不一致）。
  assert.ok(MD_TEXT.includes("### 2.1"), "MODULES.md §2.1 present in this checkout");
  const rows = "| GET | /api/admin/departments/hods-probe | 0 | admin | core | probe |\n| GET | /api/admin/departments/hods | 0 | admin | core | probe |\n| GET | /api/admin/departments/hods.csv | 0 | admin | core | probe |\n";
  const md = MD_TEXT.replace("### 2.2", rows + "### 2.2");
  const probes = probePaths(REG, md);
  for (const p of ["/api/admin/departments/hods", "/api/admin/departments/hods.csv"]) assert.ok(!probes.includes(p), p + " is not a frozen probe");
  assert.ok(probes.includes("/api/admin/departments/hods-probe"), "any other documented path still becomes a probe");
  assert.doesNotThrow(() => assertM0Additions(REG, "doc upkeep", md));
  // 剔除只针对新增路由自己的样例路径：抢先匹配旧路径的新增照样被拦下（旧路径仍在探针里）。
  const ms = REG.manifests.map(cloneDeep);
  ms.find((m) => m.id === "core").routes.push({ method: "GET", path: /^\/api\/admin\/org-([\w-]+)$/, domain: "people", order: 185 });
  assert.throws(() => assertM0Additions(registry.build(ms, { hooks: regHooks(REG) }), "pre-empt + doc", md), /only claim new paths/);
});

test("M0: an M0 module that declares subscribes (e.g. talent → employee.terminated) does not break the M0-only rebuild", () => {
  // 以前 m0Only 调 registry.build 不传 hooks：四个模块里任何一个声明订阅，本文件在加载时就整体报错。
  const ms = REG.manifests.map(cloneDeep);
  ms.find((m) => m.id === "talent").subscribes = ["employee.terminated"];
  const hooks = { ...regHooks(REG), talent: { "employee.terminated": () => {} } };
  const reg = registry.build(ms, { hooks });
  const base = m0Only(reg);
  assert.deepEqual(base.events.subscriptions.map((x) => [x.module, x.type]), [["talent", "employee.terminated"]]);
  assert.equal(m0Frozen(reg).RBAC_ROUTES.length, LEGACY.RBAC_ROUTES.length, "the frozen comparison is unaffected by subscriptions");
  assert.doesNotThrow(() => assertM0Additions(reg, "talent subscribes"));
});
