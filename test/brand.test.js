// White-label brand-as-config contract tests. CONTRACT FLIPPED 2026-08 (user
// decision): the unconfigured default used to be "DigiPlus, pixel-identical";
// it is now the GENERIC brand ("Talent Platform" / 「人才管理平台」) and
// DigiPlus is just one preset in config.json.example. What each test protects:
//   1. zero-config default — /api/env and /api/me must carry a `brand` object
//      equal to the generic BRAND_DEFAULTS, logo:null (text wordmark) and
//      favicon:null (neutral geometric mark), and — the core of the flip —
//      NOTHING they serve may grep to "DigiPlus";
//   2. LMS_CONFIG_PATH — an external config file must feed the brand block:
//      configured fields win, omitted fields fall back to the generic
//      defaults, and /api/env and /api/me must agree;
//   3. colors sanitisation — brand.colors values land in CSS custom properties,
//      an injection surface: unsafe keys/values must be dropped SERVER-side;
//   4. LMS_CONFIG_PATH must drive the module switches through the same file
//      (config path injection and modulesOn() share one readConfig());
//   5. new configurable fields — welcome/subtitle/pillA/pillB/brandSub/console
//      (bilingual pairs) and favicon must override on BOTH endpoints;
//   6. logo/favicon asset guards — non-string, over-256-chars and data: URIs
//      are refused server-side (fall back to the default, never truncated);
//      text fields are clamped to 128 chars;
//   7. DigiPlus preset regression — the preset published in config.json.example
//      must bring back today's DigiPlus visual verbatim (name, footer, logo,
//      favicon, colors), and its asset paths must actually resolve: an old
//      customer who configures the preset gets the pre-flip look back;
//   8. seed neutrality guard — content.js (the demo seed) must never grow the
//      Unfolding / 其间 / DigiPlus brand words back (anti-drift tripwire);
//   9. shell neutrality guard — web/index.html (tab <title> + inline favicon,
//      served before any JS runs) must carry no DigiPlus trace, and the BUILT
//      shell public/dist/index.html must match (goes red until the web bundle
//      is rebuilt after the flip — that red is the acceptance criterion);
//  10. built-bundle neutrality guard — every served JS/CSS chunk under
//      public/dist/assets must grep clean of DigiPlus: minification strips
//      comments, so any hit is a STRING LITERAL the unconfigured UI renders.
//      Added by review 2026-08-26: RED until web/src/pages/admin/OrgChart.jsx
//      (company:'DigiPlus' root label) and web/src/pages/admin/Employees.jsx
//      (name@digiplus.com.ph placeholders) are neutralised and web/ rebuilt.
//
// Temp configs are written to throwaway dirs under os.tmpdir() and removed in
// after(); the repo-root config.json is never created or touched. readConfig()
// is uncached (read per request), so the srvMut tests rewrite ONE config file
// between requests instead of booting a server per case.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

// The generic default brand, transcribed VERBATIM from the agreed flip spec
// (server.js BRAND_DEFAULTS). Deliberately NOT imported from the server: this
// transcription is what pins the values — if the server defaults drift, this
// goes red. Every *_zh pairs with an en twin (bilingual-pair discipline).
// Login copy re-finalised 2026-08-26 (Brand Settings work): tagline/heroLine/
// subtitle/footer switched to the product-oriented lines below (定稿逐字);
// welcome and the rest are unchanged. Red here = server.js drifted.
const DEFAULTS = {
  name: "Talent Platform", name_zh: "人才管理平台",
  tagline: "Making every employee's growth visible", tagline_zh: "让每位员工的成长清晰可见",
  heroLine: "Employee profiles, performance reviews, learning and talent review in one platform", heroLine_zh: "员工档案、绩效评估、培训与人才盘点，集中在一个平台",
  footer: "Authorized users only · Access is monitored", footer_zh: "仅供授权用户使用 · 访问受监控",
  welcome: "Welcome back", welcome_zh: "欢迎回来",
  subtitle: "Sign in to continue", subtitle_zh: "请登录以继续",
  pillA: "Profiles · Organization · Performance", pillA_zh: "员工档案 · 组织 · 绩效",
  pillB: "Learning · Exams · Talent Review", pillB_zh: "培训 · 考试 · 人才盘点",
  brandSub: "Talent Management", brandSub_zh: "人才管理",
  console: "Talent Console", console_zh: "人才管理后台",
};

// Partial override: tagline_zh and footer are DELIBERATELY missing so the
// fallback-to-default half of the merge contract is exercised.
const BRAND_OVERRIDE = {
  brand: {
    name: "Acme Learning",
    name_zh: "极致学堂",
    tagline: "Practice-first enablement",
    footer_zh: "仅供 Acme 员工使用",
    logo: "/assets/brand/acme.svg",
  },
};

const COLORS_CONFIG = {
  brand: {
    colors: {
      "--brand": "#23304a", // legal #hex — must survive
      "--gold": "rgb(212,160,23)", // legal rgb() — must survive
      "--x;inject": "#ffffff", // key smuggles ';' — must be dropped
      "--evil": "red;url(evil)", // value smuggles ';' and 'url(' — must be dropped
      "--curly": "#fff}body{color:red", // value smuggles '}' '{' — must be dropped
    },
  },
};

const MODULES_CONFIG = { modules: { learning: false } };

// Every NEW configurable field overridden as a bilingual pair, plus a favicon
// path — name is DELIBERATELY absent so one legacy field is seen falling back
// to the generic default in the same merge.
const NEW_FIELDS_CONFIG = {
  brand: {
    welcome: "Hello again", welcome_zh: "又见面啦",
    subtitle: "Your growth cockpit", subtitle_zh: "你的成长驾驶舱",
    pillA: "Learn · Practice", pillA_zh: "学 · 练",
    pillB: "Review · Grow", pillB_zh: "盘 · 长",
    brandSub: "Academy", brandSub_zh: "学苑",
    console: "Acme Console", console_zh: "极致后台",
    favicon: "/assets/brand/acme-favicon.svg",
  },
};

// The DigiPlus preset, transcribed VERBATIM from config.json.example's _brand
// notes (the "DigiPlus 预设" block). tagline/heroLine/welcome etc. are absent
// on purpose: the generic defaults already carry the copy DigiPlus always
// used, so the preset only re-adds the vendor marks (name, footer, assets)
// and pins the stock colors.
const DIGIPLUS_PRESET = {
  brand: {
    name: "DigiPlus", name_zh: "DigiPlus",
    footer: "For DigiPlus employees only · Access is monitored",
    footer_zh: "仅供 DigiPlus 员工使用 · 访问受监控",
    logo: "/assets/brand/digiplus-logo.png",
    favicon: "/assets/brand/digiplus-favicon.svg",
    colors: {
      // 2026-10-06 起为界面优化方案 Layout v2 的靛蓝（原电光蓝 #2000f7 家族已退役，见 theme-parity 的 leak guard）
      "--brand": "#6355d9", "--brand-hover": "#5042c0", "--brand-active": "#4435a7",
      "--brand-050": "#f0edff", "--brand-100": "#ded8fc", "--gold": "#9f91ff",
    },
  },
};

const tmpDirs = [];
function writeTempConfig(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-brand-cfg-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

// srvMut reads THIS file on every request (readConfig() is uncached), so the
// preset / new-field / guard cases below rewrite it instead of booting a
// server each. Tests within this file run serially, so no interleaving.
let mutFile;
function setMutConfig(cfg) { fs.writeFileSync(mutFile, JSON.stringify(cfg, null, 2)); }

let srvDefault, srvBrand, srvColors, srvModules, srvMut;
before(async () => {
  mutFile = writeTempConfig({});
  // srvDefault means "no config at all" — but a bare startServer() inherits the
  // workspace's real config.json (this repo legitimately carries one with the
  // owner's brand chips), which turns the zero-config assertions red on any
  // configured dev machine. Point LMS_CONFIG_PATH at a file that does not
  // exist: same no-config semantics (the fresh-install test proves a missing
  // file reads as {}), deterministic everywhere.
  const absentCfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lms-brand-cfg-")), "absent.json");
  tmpDirs.push(path.dirname(absentCfg));
  [srvDefault, srvBrand, srvColors, srvModules, srvMut] = await Promise.all([
    startServer({ env: { LMS_CONFIG_PATH: absentCfg } }),
    startServer({ env: { LMS_CONFIG_PATH: writeTempConfig(BRAND_OVERRIDE) } }),
    startServer({ env: { LMS_CONFIG_PATH: writeTempConfig(COLORS_CONFIG) } }),
    startServer({ env: { LMS_CONFIG_PATH: writeTempConfig(MODULES_CONFIG) } }),
    startServer({ env: { LMS_CONFIG_PATH: mutFile } }),
  ]);
});
after(() => {
  for (const s of [srvDefault, srvBrand, srvColors, srvModules, srvMut]) if (s) s.stop();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test("with no config at all, /api/env and /api/me carry the GENERIC brand block — logo:null (text wordmark), favicon:null (neutral mark) — and NOTHING served greps to DigiPlus (the flip's acceptance core)", async () => {
  const env = await makeClient(srvDefault.base).get("/api/env");
  assert.equal(env.status, 200);
  const b = env.data.brand;
  assert.ok(b && typeof b === "object", "/api/env must carry a merged brand object even with no config (the login page reads it pre-auth)");
  for (const [k, v] of Object.entries(DEFAULTS))
    assert.equal(b[k], v, `default brand.${k} must be the generic copy, character for character`);
  assert.equal(b.logo, null, "default logo must be null — the front end renders the text wordmark, never a bundled vendor image");
  assert.equal(b.favicon, null, "default favicon must be null — the neutral geometric mark inlined in index.html stays");
  assert.equal(b.logoLight, null, "default logoLight must be null — light-surface variant is opt-in, the front end falls back to logo then to the text wordmark");
  assert.deepEqual(b.colors, {}, "default colors must be an empty map — stock app.css palette");
  // THE hard assertion of the contract flip: an unconfigured deployment may
  // not serve the vendor's name anywhere on the pre-auth surface.
  assert.doesNotMatch(JSON.stringify(env.data), /digiplus/i, "unconfigured /api/env body must not contain 'DigiPlus' anywhere — the default product is brand-neutral");
  const emp = await loginAs(srvDefault.base, EMPLOYEE);
  const me = await emp.get("/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.brand, b, "/api/me must serve the SAME merged brand object as /api/env — login page and app shell may never disagree on branding");
  assert.doesNotMatch(JSON.stringify(me.data.brand), /digiplus/i, "unconfigured /api/me brand block must not contain 'DigiPlus'");
});

test("LMS_CONFIG_PATH feeds the brand block: configured fields override on both /api/env and /api/me, and fields the config omits fall back to the GENERIC defaults", async () => {
  const env = await makeClient(srvBrand.base).get("/api/env");
  assert.equal(env.status, 200);
  const b = env.data.brand;
  assert.ok(b && typeof b === "object", "/api/env must carry the brand object");
  assert.equal(b.name, "Acme Learning", "configured brand.name must win over the default");
  assert.equal(b.name_zh, "极致学堂", "configured brand.name_zh must win over the default");
  assert.equal(b.tagline, "Practice-first enablement", "configured brand.tagline must win over the default");
  assert.equal(b.footer_zh, "仅供 Acme 员工使用", "configured brand.footer_zh must win over the default");
  assert.equal(b.logo, "/assets/brand/acme.svg", "configured brand.logo must come through as a serveStatic URL path");
  assert.equal(b.tagline_zh, DEFAULTS.tagline_zh, "a field the config omits (tagline_zh) must fall back to the generic default — partial configs must not blank the UI");
  assert.equal(b.footer, DEFAULTS.footer, "a field the config omits (footer) must fall back to the generic default — partial configs must not blank the UI");
  assert.equal(b.welcome, DEFAULTS.welcome, "a NEW field the config omits (welcome) must fall back through the same merge as the legacy fields");
  assert.equal(b.favicon, null, "favicon not configured must stay null — the server never invents one from the logo (that pairing is a front-end concern)");
  const admin = await loginAs(srvBrand.base, ADMIN);
  const me = await admin.get("/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.brand, b, "/api/me must serve the SAME merged brand object as /api/env — login page and app shell may never disagree on branding");
});

test("brand.colors is sanitised server-side: keys must match ^--[a-z][a-z0-9-]*$ and values must be plain colour forms — ';' '{' '}' 'url(' smuggled through config must never reach the client", async () => {
  const env = await makeClient(srvColors.base).get("/api/env");
  assert.equal(env.status, 200);
  assert.ok(env.data.brand, "/api/env must carry the brand object");
  const colors = env.data.brand.colors;
  assert.ok(colors && typeof colors === "object", "legal colors were configured, so brand.colors must be served");
  assert.equal(colors["--brand"], "#23304a", "a legal #hex custom property must pass sanitisation untouched");
  assert.equal(colors["--gold"], "rgb(212,160,23)", "a legal rgb() value must pass sanitisation untouched");
  assert.ok(!("--x;inject" in colors), "a key containing ';' must be dropped — it would break out of the CSS declaration");
  assert.ok(!("--evil" in colors), "a value containing ';' / 'url(' must be dropped — CSS injection / exfiltration vector");
  assert.ok(!("--curly" in colors), "a value containing '{' '}' must be dropped — it could open a new CSS rule");
  // Belt-and-braces sweep: whatever future defaults get merged in, NOTHING in
  // the served map may carry an unsafe key or value.
  for (const [k, v] of Object.entries(colors)) {
    assert.match(k, /^--[a-z][a-z0-9-]*$/, `served colour key "${k}" escaped the key whitelist`);
    assert.doesNotMatch(String(v), /[;{}]|url\(/i, `served colour value for "${k}" contains an unsafe token`);
  }
});

test("LMS_CONFIG_PATH drives the module switches through the same file: {modules:{learning:false}} in an external config closes /api/catalog with the standard not-found body", async () => {
  const env = await makeClient(srvModules.base).get("/api/env");
  assert.equal(env.status, 200);
  assert.equal(env.data.modules.learning, false, "/api/env must report learning off when the injected config switches it off");
  assert.equal(env.data.modules.performance, true, "only the module the config lists goes off");
  assert.equal(env.data.modules.talent, true, "only the module the config lists goes off");
  const emp = await loginAs(srvModules.base, EMPLOYEE);
  const r = await emp.get("/api/catalog");
  assert.equal(r.status, 404, "/api/catalog must 404 when the injected config turns learning off — the config path must reach modulesOn(), not just the brand block");
  assert.match(String(r.data && r.data.error), /^Not found/, "the gate must use the standard not-found body, indistinguishable from a missing route");
});

test("new configurable fields — welcome/subtitle/pillA/pillB/brandSub/console (bilingual pairs) and favicon — override on BOTH /api/env and /api/me; a legacy field the config omits still falls back", async () => {
  setMutConfig(NEW_FIELDS_CONFIG);
  const env = await makeClient(srvMut.base).get("/api/env");
  assert.equal(env.status, 200);
  const b = env.data.brand;
  assert.ok(b && typeof b === "object", "/api/env must carry the brand object");
  for (const [k, v] of Object.entries(NEW_FIELDS_CONFIG.brand))
    assert.equal(b[k], v, `configured NEW field brand.${k} must win over the generic default on /api/env`);
  assert.equal(b.name, DEFAULTS.name, "name was not configured — it must fall back to the generic default in the same merge");
  const emp = await loginAs(srvMut.base, EMPLOYEE);
  const me = await emp.get("/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.brand, b, "/api/me must serve the SAME merged brand object — the admin console name (brand.console) and favicon come from here post-auth");
});

test("logo/favicon asset guards: non-string, longer than 256 chars, or data: URIs are refused server-side and fall back to the default — and text fields are clamped to 128 chars, never truncated into broken UI", async () => {
  const c = makeClient(srvMut.base);
  // (a) non-string favicon → default; the sibling field proves the config WAS read.
  setMutConfig({ brand: { name: "Guard Co", favicon: 12345 } });
  let b = (await c.get("/api/env")).data.brand;
  assert.equal(b.name, "Guard Co", "sibling field must land — proves this config file was read at all");
  assert.equal(b.favicon, null, "a non-string favicon must be refused and fall back to the default (null)");
  // (b) over-length favicon path (>256) → default, NOT truncated into a broken URL.
  setMutConfig({ brand: { favicon: "/assets/brand/" + "x".repeat(260) + ".svg" } });
  b = (await c.get("/api/env")).data.brand;
  assert.equal(b.favicon, null, "an over-256-char favicon path must be refused outright — truncating would serve a broken URL");
  // (c) data: URIs refused for BOTH asset slots — brand assets ship as real
  // files under public/, never as inline payloads smuggled through config.
  setMutConfig({ brand: { favicon: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E", logo: "data:text/html,hi" } });
  b = (await c.get("/api/env")).data.brand;
  assert.equal(b.favicon, null, "a data: favicon must be refused — assets are static files, not inline config payloads");
  assert.equal(b.logo, null, "a data: logo must be refused for the same reason");
  // (d) text clamp: a paste-gone-wrong 300-char welcome is cut at 128.
  setMutConfig({ brand: { welcome: "W".repeat(300) } });
  b = (await c.get("/api/env")).data.brand;
  assert.equal(b.welcome, "W".repeat(128), "text fields must be clamped to 128 chars so a bad paste cannot blow the login page apart");
});


test("seed neutrality guard: content.js must not contain Unfolding / 其间 / DigiPlus — demo seed content stays brand-neutral, brand copy lives only in config and the server defaults", () => {
  const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  for (const word of ["Unfolding", "其间", "DigiPlus"]) {
    const re = new RegExp(word, "i");
    assert.ok(!re.test(src), `content.js mentions "${word}" — brand copy drifted back into the neutral demo seed`);
  }
});

test("shell neutrality guard: web/index.html and the BUILT public/dist/index.html (tab <title> + inline favicon, served before any JS runs) carry no DigiPlus trace — dist goes red until the web bundle is rebuilt after the flip", () => {
  // 3d0bb5 / 2000f7 are the fills of the old DigiPlus purple-blue favicon
  // mark; their presence means the old icon (not just the word) drifted back.
  for (const rel of [path.join("web", "index.html"), path.join("public", "dist", "index.html")]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /digiplus/i, `${rel} still mentions DigiPlus — the unconfigured shell must be brand-neutral (<title>, alt, meta)`);
    for (const fill of ["3d0bb5", "2000f7"])
      assert.ok(!src.includes(fill), `${rel} still contains the old DigiPlus favicon fill #${fill} — the neutral geometric mark must replace the vendor icon`);
  }
});

test("built-bundle neutrality guard: every JS/CSS chunk under public/dist/assets greps clean of DigiPlus — minified bundles keep only string literals, so a hit IS text the unconfigured UI renders (known offenders: OrgChart company label, Employees email placeholders)", () => {
  const dir = path.join(ROOT, "public", "dist", "assets");
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(js|css)$/i.test(f)) continue;
    if (/digiplus/i.test(fs.readFileSync(path.join(dir, f), "utf8"))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `the unconfigured build still ships "DigiPlus" inside: ${offenders.join(", ")} — fix the source (web/src/pages/admin/OrgChart.jsx company:'DigiPlus'; web/src/pages/admin/Employees.jsx name@digiplus.com.ph placeholders / CSV examples), rebuild web/, and this goes green. The flip's acceptance ("不配 config 时渲染出的页面 grep 不到 DigiPlus") covers the whole rendered app, not just the login shell.`);
});
