// 员工档案页签扩展点（ARCHITECTURE-MODULAR.md §5.4 profile.tabs）—— 注册表一侧：
//   1. extensions / profile.tabs 的校验，每条规则有正例与反例；
//   2. profileTabs({ audience, modulesOn, canRead }) 的过滤：用临时目录里的演示模块经 load() 在进程内建一份
//      注册表（与 m0-registry-equivalence.test.js「新增一个模块」同一做法），按位置、模块开关、能力域逐项验证；
//   3. 现状：M0 四个模块都没有登记页签；2026-09-26 登记的 culture 登记了一个页签（id culture，self / line / admin，
//      能力域 culture），真实注册表的 PROFILE_TABS 就是它，culture 关闭时 profileTabs 恒为 []；
//   4. 前端一半的静态核对：web/src/profileTabs.js 的注册表只登记 manifest 里声明过的页签 id；三个页面各自按
//      正确的位置渲染 <ProfileTabs>，四条文案中英成对；构建产物里带着页签区块（改了前端没重新构建就会变红）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const registry = require("../kernel/registry.js");
const REG = registry.load();

// 真实清单的可改副本（正则克隆）—— 校验规则的正反例以 M0 四个模块为底（不含已登记的 culture：它自带一个页签，
// 且声明了能力域 culture；下面的反例用「culture 不是已声明的能力域」，与登记前一致）。
// M0 四个模块的 hooks（从已加载注册表还原、去掉 culture，{ 模块: { 事件: fn } }）：core 订阅了 culture.program.completed
// （第二段），就地改 manifest 再 build 时必须一并交给 build（hooks 只有 load() 会从磁盘读）。
const M0_IDS = REG.ids.filter((id) => id !== "culture");
const REG_HOOKS = (() => { const h = {}; for (const s of REG.events.subscriptions) if (s.module !== "culture") (h[s.module] = h[s.module] || {})[s.type] = s.fn; return h; })();
function cloneManifests() {
  const clone = (v) => (v instanceof RegExp ? new RegExp(v.source, v.flags)
    : Array.isArray(v) ? v.map(clone)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);
  return REG.manifests.filter((m) => m.id !== "culture").map(clone);
}
const byId = (ms, id) => ms.find((m) => m.id === id);
const TITLE = { zh: "演示", en: "Demo" };
const tab = (id, extra = {}) => ({ id, title: TITLE, order: 10, audiences: ["self", "line", "admin"], ...extra });
function withTabs(tabsByModule) {
  const ms = cloneManifests();
  for (const [id, tabs] of Object.entries(tabsByModule)) byId(ms, id).extensions = { "profile.tabs": tabs };
  return ms;
}
function expectInvalid(ms, pattern) {
  assert.throws(() => registry.build(ms, { hooks: REG_HOOKS }), (e) => { assert.match(e.message, pattern); return true; });
}
const ALL_ON = { learning: true, performance: true, talent: true };

// ---------- 3. 现状 ----------

test("profile tabs: the four M0 modules register no tab — their PROFILE_TABS is empty and every audience gets [] without reading the module switches", () => {
  const m0 = registry.build(cloneManifests(), { hooks: REG_HOOKS });
  assert.deepEqual(m0.PROFILE_TABS, []);
  assert.ok(Object.isFrozen(m0.PROFILE_TABS));
  for (const m of REG.manifests.filter((x) => x.id !== "culture")) assert.ok(!m.extensions || !m.extensions["profile.tabs"] || m.extensions["profile.tabs"].length === 0, `[${m.id}] registers profile tabs`);
  for (const audience of registry.PROFILE_TAB_AUDIENCES) {
    const tabs = m0.profileTabs({ audience, modulesOn: () => { throw new Error("modulesOn must not be read when there is no candidate tab"); }, canRead: () => { throw new Error("canRead must not be called"); } });
    assert.deepEqual(tabs, [], audience);
  }
  assert.deepEqual(registry.PROFILE_TAB_AUDIENCES, ["self", "line", "admin"]);
  assert.deepEqual(registry.EXTENSION_POINTS, ["profile.tabs"]);
});


// ---------- 1. 校验：正例 ----------

test("profile tabs: valid registrations build; PROFILE_TABS is sorted by order, then modules/index.js order, then declaration order, and frozen", () => {
  const reg = registry.build(withTabs({
    talent: [tab("talent-b", { order: 20 }), tab("talent-a", { order: 20, audiences: ["admin"], domain: "talent" })],
    learning: [tab("learning-x", { order: 20, audiences: ["line"] })],
    core: [tab("core-first", { order: -5, audiences: ["self"], domain: null })],
  }), { hooks: REG_HOOKS });
  assert.deepEqual(reg.PROFILE_TABS.map((t) => [t.id, t.module, t.order]), [
    ["core-first", "core", -5],
    ["learning-x", "learning", 20],   // learning 在 modules/index.js 里排在 talent 前
    ["talent-b", "talent", 20],       // 同模块同 order：按声明顺序
    ["talent-a", "talent", 20],
  ]);
  const t = reg.PROFILE_TABS.find((x) => x.id === "talent-a");
  assert.deepEqual({ ...t, title: { ...t.title }, audiences: [...t.audiences] }, { id: "talent-a", module: "talent", title: TITLE, order: 20, audiences: ["admin"], domain: "talent" });
  assert.equal(reg.PROFILE_TABS.find((x) => x.id === "core-first").domain, null, "domain: null is the same as leaving it out");
  assert.ok(Object.isFrozen(reg.PROFILE_TABS) && reg.PROFILE_TABS.every((x) => Object.isFrozen(x) && Object.isFrozen(x.title) && Object.isFrozen(x.audiences)));
  // 注册表持有的是自己的副本：事后改清单对象不影响已建好的注册表。
  const ms = withTabs({ talent: [tab("talent-z")] });
  const reg2 = registry.build(ms, { hooks: REG_HOOKS });
  byId(ms, "talent").extensions["profile.tabs"][0].title.en = "changed";
  byId(ms, "talent").extensions["profile.tabs"][0].audiences.push("bogus");
  assert.equal(reg2.PROFILE_TABS[0].title.en, "Demo");
  assert.deepEqual([...reg2.PROFILE_TABS[0].audiences], ["self", "line", "admin"]);
});

test("profile tabs: extensions may be absent, an empty object, or carry an empty profile.tabs list", () => {
  for (const ext of [undefined, {}, { "profile.tabs": [] }]) {
    const ms = cloneManifests();
    if (ext === undefined) delete byId(ms, "talent").extensions; else byId(ms, "talent").extensions = ext;
    assert.deepEqual(registry.build(ms, { hooks: REG_HOOKS }).PROFILE_TABS, [], JSON.stringify(ext));
  }
});

test("profile tabs: domain may be any declared domain (another module's too) on a tab shown in the back office", () => {
  const reg = registry.build(withTabs({ talent: [tab("t1", { domain: "people" }), tab("t2", { audiences: ["admin"], domain: "talent" })] }), { hooks: REG_HOOKS });
  assert.deepEqual(reg.PROFILE_TABS.map((t) => t.domain), ["people", "talent"]);
});

// ---------- 1. 校验：反例 ----------

test("profile tabs: rejects a malformed extensions block and unknown extension points", () => {
  for (const bad of [[], "profile.tabs", 42, /x/]) {
    const ms = cloneManifests();
    byId(ms, "talent").extensions = bad;
    expectInvalid(ms, /\[talent\] extensions must be an object/);
  }
  const typo = cloneManifests();
  byId(typo, "talent").extensions = { "profile.tab": [tab("t1")] };
  expectInvalid(typo, /\[talent\] extensions: unknown extension point "profile\.tab" \(supported: profile\.tabs\)/);
  const unbuilt = cloneManifests();
  byId(unbuilt, "talent").extensions = { "dashboard.widgets": [{ id: "nine-box" }] };
  expectInvalid(unbuilt, /unknown extension point "dashboard\.widgets"/);
  const notArray = cloneManifests();
  byId(notArray, "talent").extensions = { "profile.tabs": tab("t1") };
  expectInvalid(notArray, /\[talent\] extensions\["profile\.tabs"\] must be an array/);
});

test("profile tabs: rejects entries that are not objects, unknown fields, bad ids, titles and orders", () => {
  expectInvalid(withTabs({ talent: [null] }), /\[talent\] extensions\["profile\.tabs"\]\[0\] must be an object/);
  expectInvalid(withTabs({ talent: [["t1"]] }), /\[0\] must be an object/);
  expectInvalid(withTabs({ talent: [tab("t1", { component: "X.jsx" })] }), /\[0\] unknown field "component"/);
  for (const id of [undefined, "", "Culture", "culture practice", "1tab", "culture_practice", 7])
    expectInvalid(withTabs({ talent: [tab(id)] }), /\[0\] id must match/);
  for (const title of [undefined, "Demo", { zh: "演示" }, { zh: "", en: "Demo" }, { zh: "演示", en: "  " }])
    expectInvalid(withTabs({ talent: [tab("t1", { title })] }), /\[0\] title must be \{ zh, en \} non-empty strings/);
  for (const order of [undefined, "10", NaN, Infinity, null])
    expectInvalid(withTabs({ talent: [tab("t1", { order })] }), /\[0\] order must be a number/);
});

test("profile tabs: tab ids are globally unique — across modules and within one module", () => {
  expectInvalid(withTabs({ learning: [tab("shared")], talent: [tab("shared")] }),
    /\[talent\] extensions\["profile\.tabs"\]\[0\] tab id "shared" is already registered by module "learning"/);
  expectInvalid(withTabs({ talent: [tab("twice"), tab("twice")] }),
    /\[talent\] extensions\["profile\.tabs"\]\[1\] tab id "twice" is already registered by module "talent"/);
});

test("profile tabs: audiences must be a non-empty list of self / line / admin without repeats", () => {
  for (const audiences of [undefined, [], "admin", { admin: true }])
    expectInvalid(withTabs({ talent: [tab("t1", { audiences })] }), /\[0\] audiences must be a non-empty array drawn from self \/ line \/ admin/);
  expectInvalid(withTabs({ talent: [tab("t1", { audiences: ["admin", "manager"] })] }), /\[0\] audiences: unknown audience "manager" \(allowed: self, line, admin\)/);
  expectInvalid(withTabs({ talent: [tab("t1", { audiences: ["Self"] })] }), /unknown audience "Self"/);
  expectInvalid(withTabs({ talent: [tab("t1", { audiences: ["line", "line"] })] }), /\[0\] audiences lists an audience twice/);
});

test("profile tabs: domain must be a declared domain, and only makes sense on a tab the back office sees", () => {
  expectInvalid(withTabs({ talent: [tab("t1", { domain: "culture" })] }), /\[0\] domain "culture" is not declared by any manifest/);
  expectInvalid(withTabs({ talent: [tab("t1", { domain: ["people"] })] }), /\[0\] domain must be a domain id/);
  expectInvalid(withTabs({ talent: [tab("t1", { audiences: ["self", "line"], domain: "people" })] }),
    /\[0\] domain only gates the "admin" audience, so audiences must include "admin"/);
});

test("profile tabs: every problem is reported in one go, next to the other manifest errors", () => {
  const ms = withTabs({ talent: [tab("Bad"), tab("t2", { audiences: ["boss"] })], learning: [tab("t3", { domain: "nope" })] });
  byId(ms, "performance").extensions = { "profile.tab": [] };
  assert.throws(() => registry.build(ms, { hooks: REG_HOOKS }), (e) => {
    for (const re of [/\[talent\] extensions\["profile\.tabs"\]\[0\] id must match/, /\[talent\] extensions\["profile\.tabs"\]\[1\] audiences: unknown audience "boss"/,
      /\[learning\] extensions\["profile\.tabs"\]\[0\] domain "nope" is not declared/, /\[performance\] extensions: unknown extension point "profile\.tab"/])
      assert.match(e.message, re);
    return true;
  });
});

// ---------- 2. 过滤：临时目录里的演示模块，经 load() 在进程内建注册表 ----------

// modules/ 的临时副本 + 两个演示模块（demoa 自带能力域 demoa；demob 没有能力域）+ core 的一个汇报线页签。
// 不 require 临时目录的 index.js 以外的缓存：load() 自己按目录 require（每次都是新目录，不会命中缓存）。
function demoRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-tabs-reg-"));
  fs.cpSync(path.join(ROOT, "modules"), dir, { recursive: true });
  const manifest = (id, body) => {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, "manifest.js"), ['"use strict";', "module.exports = {", ...body, "};", ""].join("\r\n"));
  };
  manifest("demoa", [
    '  id: "demoa", name: { zh: "演示 A", en: "Demo A" }, sellable: true, requires: ["core"], optional: [],',
    '  domains: [{ id: "demoa", name: { zh: "演示 A", en: "Demo A" }, order: 100 }],',
    "  gate: [], routes: [], static: [], tables: [],",
    "  extensions: {",
    '    "profile.tabs": [',
    '      { id: "demoa-practice", title: { zh: "行为实践", en: "Practice" }, order: 20, audiences: ["self", "line", "admin"] },',
    '      { id: "demoa-hr", title: { zh: "HR 视图", en: "HR view" }, order: 10, audiences: ["admin"], domain: "demoa" },',
    '      { id: "demoa-people", title: { zh: "员工域", en: "People" }, order: 30, audiences: ["admin"], domain: "people" },',
    "    ],",
    "  },",
  ]);
  manifest("demob", [
    '  id: "demob", name: { zh: "演示 B", en: "Demo B" }, sellable: true, requires: ["core"], optional: [],',
    "  domains: [], gate: [], routes: [], static: [], tables: [],",
    '  extensions: { "profile.tabs": [{ id: "demob-self", title: { zh: "我的", en: "Mine" }, order: 20, audiences: ["self"] }] },',
  ]);
  // core（永开，不在 modulesOn 表里）也可以挂页签。
  const corePath = path.join(dir, "core", "manifest.js");
  const coreSrc = fs.readFileSync(corePath, "utf8");
  const patched = coreSrc.replace("  tables: [", '  extensions: { "profile.tabs": [{ id: "core-line", title: { zh: "汇报", en: "Line" }, order: 5, audiences: ["line"] }] },\r\n  tables: [');
  assert.notEqual(patched, coreSrc, "core manifest fixture edit did not apply");
  fs.writeFileSync(corePath, patched);
  // M0 四个模块 + 两个演示模块（不装 culture：它自带的页签会混进下面逐项比对的结果）
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = " + JSON.stringify([...M0_IDS, "demoa", "demob"]) + ";\r\n");
  try { return registry.load({ dir }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const DEMO = demoRegistry();
const DEMO_ON = { ...ALL_ON, demoa: true, demob: true };
const ids = (tabs) => tabs.map((t) => t.id);
const canReadOnly = (...domains) => (d) => domains.includes(d);

test("profile tabs (demo registry): load() reads extensions from disk and the new modules become switchable", () => {
  assert.deepEqual(DEMO.SELLABLE, [...REG.SELLABLE.filter((id) => id !== "culture"), "demoa", "demob"]);
  assert.deepEqual(ids(DEMO.PROFILE_TABS), ["core-line", "demoa-hr", "demoa-practice", "demob-self", "demoa-people"]);
});

test("profile tabs (demo registry): each audience gets only the tabs registered for it, sorted by order (ties by module order)", () => {
  const all = () => true;
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "self", modulesOn: DEMO_ON, canRead: all })), ["demoa-practice", "demob-self"]);
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "line", modulesOn: DEMO_ON, canRead: all })), ["core-line", "demoa-practice"]);
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "admin", modulesOn: DEMO_ON, canRead: all })), ["demoa-hr", "demoa-practice", "demoa-people"]);
});

test("profile tabs (demo registry): the back office also needs read on the tab's domain; tabs without a domain need nothing extra", () => {
  const admin = (canRead) => ids(DEMO.profileTabs({ audience: "admin", modulesOn: DEMO_ON, canRead }));
  assert.deepEqual(admin(canReadOnly("people")), ["demoa-practice", "demoa-people"]);
  assert.deepEqual(admin(canReadOnly("demoa")), ["demoa-hr", "demoa-practice"]);
  assert.deepEqual(admin(canReadOnly()), ["demoa-practice"]);
  assert.deepEqual(admin(undefined), ["demoa-practice"], "no canRead = cannot read (fail closed)");
  assert.deepEqual(admin(() => "yes"), ["demoa-hr", "demoa-practice", "demoa-people"], "truthy answers count as readable");
  // canRead is asked only about the domains tabs declare, and never for self / line.
  const asked = [];
  DEMO.profileTabs({ audience: "admin", modulesOn: DEMO_ON, canRead: (d) => { asked.push(d); return false; } });
  assert.deepEqual(asked.sort(), ["demoa", "people"]);
  for (const audience of ["self", "line"])
    DEMO.profileTabs({ audience, modulesOn: DEMO_ON, canRead: () => { throw new Error("canRead called for " + audience); } });
});

test("profile tabs (demo registry): a switched-off module's tabs disappear everywhere; always-on core tabs stay", () => {
  const off = { ...DEMO_ON, demoa: false };
  const all = () => true;
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "self", modulesOn: off, canRead: all })), ["demob-self"]);
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "line", modulesOn: off, canRead: all })), ["core-line"]);
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "admin", modulesOn: off, canRead: all })), []);
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "self", modulesOn: { ...DEMO_ON, demob: false }, canRead: all })), ["demoa-practice"]);
  // Other modules' switches are irrelevant to these tabs.
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "self", modulesOn: { learning: false, performance: false, talent: false, demoa: true, demob: true } })), ["demoa-practice", "demob-self"]);
  // A module missing from the map counts as on — same rule as the event bus (core is never in the map).
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "line", modulesOn: {} })), ["core-line", "demoa-practice"]);
});

test("profile tabs (demo registry): modulesOn may be a function — read once per call, and only when a candidate tab exists", () => {
  let reads = 0;
  const fn = () => { reads++; return { ...DEMO_ON, demob: false }; };
  assert.deepEqual(ids(DEMO.profileTabs({ audience: "self", modulesOn: fn })), ["demoa-practice"]);
  assert.equal(reads, 1);
  const none = registry.build(cloneManifests(), { hooks: REG_HOOKS });
  assert.deepEqual(none.profileTabs({ audience: "self", modulesOn: fn }), []);
  assert.equal(reads, 1, "no candidate tab → modulesOn is not read");
});

test("profile tabs (demo registry): the result is a fresh, minimal list — no audiences / domain leak, and callers cannot corrupt the registry", () => {
  const got = DEMO.profileTabs({ audience: "admin", modulesOn: DEMO_ON, canRead: () => true });
  assert.deepEqual(got[0], { id: "demoa-hr", module: "demoa", title: { zh: "HR 视图", en: "HR view" }, order: 10 });
  for (const t of got) assert.deepEqual(Object.keys(t), ["id", "module", "title", "order"]);
  got[0].title.en = "tampered";
  got.push({ id: "injected" });
  const again = DEMO.profileTabs({ audience: "admin", modulesOn: DEMO_ON, canRead: () => true });
  assert.equal(again[0].title.en, "HR view");
  assert.deepEqual(ids(again), ["demoa-hr", "demoa-practice", "demoa-people"]);
});

test("profile tabs (demo registry): a wrong audience or a missing modulesOn is a programming error and throws", () => {
  for (const audience of [undefined, "manager", "Admin", ""])
    assert.throws(() => DEMO.profileTabs({ audience, modulesOn: DEMO_ON }), /profileTabs: audience must be one of self, line, admin/);
  assert.throws(() => DEMO.profileTabs(), /audience must be one of/);
  assert.throws(() => DEMO.profileTabs({ audience: "self" }), /profileTabs: modulesOn must be the modulesOn\(\) object/);
  assert.throws(() => DEMO.profileTabs({ audience: "self", modulesOn: () => null }), /modulesOn must be/);
});

// ---------- 4. 前端一半（静态核对）----------

const WEB = path.join(ROOT, "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8");


test("profile tabs (web): each profile page renders <ProfileTabs> for its own audience, from its own endpoint's tabs", () => {
  const pages = [
    [["pages", "admin", "People.jsx"], "admin", /<ProfileTabs tabs=\{p\.tabs\} userId=\{u\.id\} audience="admin"/, /api\.get\(`\/api\/admin\/employees\/\$\{id\}\/profile`\)/],
    [["pages", "ReportProfile.jsx"], "line", /<ProfileTabs tabs=\{d\.tabs\} userId=\{u\.id \|\| userId\} audience="line"/, /api\.get\(`\/api\/me\/reports\//],
    [["pages", "Record.jsx"], "self", /<ProfileTabs tabs=\{growthQ\.data && growthQ\.data\.tabs\} userId=\{user && user\.id\} audience="self"/, /const growthQ = useAsync\(\(\) => api\.get\('\/api\/me\/growth'\)/],
  ];
  for (const [rel, audience, render, fetch] of pages) {
    const src = read(...rel);
    assert.match(src, render, `${rel.join("/")} must render <ProfileTabs … audience="${audience}">`);
    assert.match(src, fetch, `${rel.join("/")} must take tabs from its own profile endpoint`);
    assert.equal((src.match(/<ProfileTabs tabs=/g) || []).length, 1, `${rel.join("/")} renders <ProfileTabs> once`);
    // the four strings live in the page's own bilingual T dictionary, once in zh and once in en
    for (const k of ["tabsLabel", "tabSoon", "tabLoading", "tabFailed"])
      assert.equal((src.match(new RegExp("\\b" + k + ":", "g")) || []).length, 2, `${rel.join("/")} T.${k} must appear in both zh and en`);
    assert.match(src, /s=\{\{ label: s\.tabsLabel, soon: s\.tabSoon, loading: s\.tabLoading, failed: s\.tabFailed \}\}/);
  }
  // Record.jsx fetches /api/me/growth exactly once (the growth pane reads the lifted query).
  assert.equal((read("pages", "Record.jsx").match(/api\.get\('\/api\/me\/growth'\)/g) || []).length, 1);
});

test("profile tabs (web): the built bundle carries the profile-tab section (rebuild web/ after editing web/src)", () => {
  const dir = path.join(ROOT, "public", "dist", "assets");
  const hit = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).some((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("data-profile-tabs"));
  assert.ok(hit, "public/dist has no chunk containing the <ProfileTabs> marker — run the vite build");
});
