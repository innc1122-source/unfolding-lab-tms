// Brand Settings admin API contract tests (the admin console 「品牌设置」 page).
// Three endpoints, all admin-only, all reading/writing the LIVE config file
// (LMS_CONFIG_PATH — the same source readConfig() uses, so a save is visible on
// the very next request, no restart):
//   GET  /api/admin/brand-config → { brand: merged effective values,
//        configured: the raw brand block actually stored in config } — and
//        NOTHING else: config.json also holds Lark secrets and the AI key,
//        which must never be serialized into this response (test 2 greps the
//        serialized JSON for the key names AND canary secret values).
//   PUT  /api/admin/brand-config → body IS the brand block (bare object, the
//        house style for PUT bodies — same as PUT content/courses/:id). It runs
//        the same sanitize rules as serving (text trim+clamp, asset path rules,
//        colors whitelist) BEFORE writing, then replaces ONLY the brand key of
//        the config file — modules/lark/email/anthropicApiKey must survive
//        untouched. A missing file is created with just the brand key.
//        Audited as brand.update with before/after images.
//   POST /api/admin/brand-assets?slot=logo|logoLight|favicon → raw image bytes;
//        type judged by CONTENT (png/jpg magic bytes, svg text head) — never by
//        the client filename or content-type; filename SERVER-generated
//        (slot-timestamp.ext) under public/assets/brand/uploads/; ≤512KB (over
//        → 413, the house status for every upload cap); SVG defanged on the
//        way in (<script> / on* handlers / javascript: hrefs /
//        <foreignObject>) AND served back with a scriptless CSP so a directly
//        opened URL cannot execute either. Response: { url } — a path that
//        drops straight into brand.logo/logoLight/favicon.
//
// 并行开发说明: the server side of this page lands in the same change-set as
// this file. Any red here before those endpoints exist is EXPECTED and must
// turn green with them — do not "fix" these assertions to match a missing
// implementation.
//
// The suite boots its servers on throwaway LMS_CONFIG_PATH files (the repo-root
// config.json is never created — house rule). Uploads, however, land in the
// REAL public/assets/brand/uploads/ (that is the point: the returned URL must
// be servable), so after() deletes exactly the files this run added.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

// Leak canaries: if any of these VALUES ever appears in a brand-config
// response, the endpoint is serializing the whole config file. The key NAMES
// are asserted too — lark/email/apiKey/anthropicApiKey/modules may not even be
// mentioned by the response.
const LARK_SECRET = "lark-app-secret-LEAK-CANARY";
const EMAIL_KEY = "re-email-key-LEAK-CANARY";
const AI_KEY = "sk-ant-ai-key-LEAK-CANARY";
const PRELOADED = {
  brand: { tagline: "Preloaded tagline", tagline_zh: "预置标语" },
  modules: { learning: false }, // functional canary: /api/catalog must STAY 404 across brand saves
  lark: { appId: "cli_leakcanary", appSecret: LARK_SECRET, base: "feishu" },
  email: { provider: "resend", apiKey: EMAIL_KEY, from: "no-reply@example.com" },
  anthropicApiKey: AI_KEY,
};

// CX-071（10/11）：上传写在数据目录（LMS_BRAND_UPLOAD_DIR，缺省为附件目录下的 _brand），不再写进代码目录 public/。
// 两台测试服务指向同一个临时目录，对外地址仍是 /assets/brand/uploads/<name>。
const UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tms-brand-"));
const listUploads = () => { try { return fs.readdirSync(UPLOADS_DIR); } catch { return []; } };

// A tiny REAL png (signature + IHDR + IEND): passes a magic-byte check without
// a bundled fixture. The endpoint sniffs content — it does not decode pixels.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TINY_PNG = Buffer.concat([
  PNG_MAGIC,
  Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]), Buffer.from([0x3a, 0x7e, 0x9b, 0x55]),
  Buffer.from([0, 0, 0, 0]), Buffer.from("IEND"), Buffer.from([0xae, 0x42, 0x60, 0x82]),
]);

const tmpDirs = [];
function tempConfigPath(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-brandset-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "config.json");
  if (cfg !== undefined) fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file; // cfg === undefined → path only, no file (fresh-install case)
}

let srv, admin, emp, cfgFile; // main server, config preloaded with secrets
let srvFresh, freshCfgFile; // LMS_CONFIG_PATH points at a NOT-yet-existing file
let uploadsBaseline;
before(async () => {
  uploadsBaseline = new Set(listUploads());
  cfgFile = tempConfigPath(PRELOADED);
  freshCfgFile = tempConfigPath(undefined);
  [srv, srvFresh] = await Promise.all([
    startServer({ env: { LMS_CONFIG_PATH: cfgFile, LMS_BRAND_UPLOAD_DIR: UPLOADS_DIR } }),
    startServer({ env: { LMS_CONFIG_PATH: freshCfgFile, LMS_BRAND_UPLOAD_DIR: UPLOADS_DIR } }),
  ]);
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(() => {
  if (srv) srv.stop();
  if (srvFresh) srvFresh.stop();
  // The uploads dir is shared repo state — remove only what THIS run added.
  for (const f of listUploads()) {
    if (!uploadsBaseline.has(f)) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {} }
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// Tests run in file order (node:test default): the GET-shape test reads the
// PRELOADED brand block, so it must run before the first PUT replaces it.

test("admin-only surface: an employee gets 403 from GET and PUT /api/admin/brand-config and from POST /api/admin/brand-assets — branding is tenant configuration, not a user preference", async () => {
  assert.equal((await emp.get("/api/admin/brand-config")).status, 403, "employee GET brand-config must be 403");
  assert.equal((await emp.put("/api/admin/brand-config", { tagline: "nope" })).status, 403, "employee PUT brand-config must be 403");
  const up = await emp.upload("/api/admin/brand-assets?slot=logo", TINY_PNG);
  assert.equal(up.status, 403, "employee POST brand-assets must be 403");
  assert.deepEqual(listUploads().filter((f) => !uploadsBaseline.has(f)), [], "a refused upload must not leave a file behind");
});

test("GET /api/admin/brand-config returns ONLY brand content — { brand: merged, configured: raw stored block } — and the serialized response greps clean of lark/email/apiKey/modules key names and of the actual secret values (config.json holds Lark and AI secrets; this endpoint must never hand the whole file down)", async () => {
  const r = await admin.get("/api/admin/brand-config");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data).sort(), ["brand", "configured"], "exactly the two documented keys — any extra key is a new leak surface");
  assert.equal(r.data.brand.tagline, "Preloaded tagline", "brand must be the MERGED effective value: the configured tagline wins");
  assert.equal(r.data.brand.welcome, "Welcome back", "brand must be the MERGED effective value: unconfigured welcome falls back to the default");
  assert.equal(r.data.configured.tagline, "Preloaded tagline", "configured must echo the raw stored block");
  assert.ok(!("welcome" in r.data.configured), "configured carries ONLY what the config file stores — no defaults mixed in (the page must tell 'customised' apart from 'default')");
  // THE hard assertion: grep the serialized JSON for sensitive key names and
  // for the canary secret VALUES. Any hit = the config file is leaking.
  const raw = JSON.stringify(r.data).toLowerCase();
  for (const needle of ["lark", "appsecret", "apikey", "anthropicapikey", '"email"', '"modules"', LARK_SECRET.toLowerCase(), EMAIL_KEY.toLowerCase(), AI_KEY.toLowerCase()])
    assert.ok(!raw.includes(needle), `brand-config response contains "${needle}" — it is serializing more of config.json than the brand block`);
});

test("PUT /api/admin/brand-config is live in the SAME process (config is read per request): the very next GET /api/env serves the new copy, and every non-brand key of the config file — modules/lark/email/anthropicApiKey — survives the rewrite untouched (secrets still present byte-for-byte, learning still functionally off)", async () => {
  const put = await admin.put("/api/admin/brand-config", {
    tagline: "Brand new tagline", tagline_zh: "全新标语",
    welcome: "Hello again", welcome_zh: "又见面了",
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const env = await makeClient(srv.base).get("/api/env");
  assert.equal(env.status, 200);
  assert.equal(env.data.brand.tagline, "Brand new tagline", "the save must be visible on the very next /api/env — no restart, no cache");
  assert.equal(env.data.brand.welcome_zh, "又见面了", "the zh twin must land too");
  // The file was rewritten — but ONLY the brand key may have changed.
  const text = fs.readFileSync(cfgFile, "utf8");
  const cfg = JSON.parse(text);
  assert.equal(cfg.brand.tagline, "Brand new tagline", "the PUT must write through to the LMS_CONFIG_PATH file — the same source readConfig() reads");
  assert.deepEqual(cfg.modules, PRELOADED.modules, "modules must come through the brand rewrite untouched");
  assert.deepEqual(cfg.lark, PRELOADED.lark, "lark (incl. appSecret) must come through the brand rewrite untouched");
  assert.deepEqual(cfg.email, PRELOADED.email, "email (incl. apiKey) must come through the brand rewrite untouched");
  assert.equal(cfg.anthropicApiKey, AI_KEY, "anthropicApiKey must come through the brand rewrite untouched");
  for (const secret of [LARK_SECRET, EMAIL_KEY, AI_KEY])
    assert.ok(text.includes(secret), `secret value "${secret}" vanished from the config file during a brand save — the write clobbered a non-brand key`);
  // Functional half of the same guarantee: learning was preloaded off and must
  // STILL be off — brand saves and module switches share one config file.
  assert.equal(env.data.modules.learning, false, "/api/env must still report learning off after a brand save");
  assert.equal((await emp.get("/api/catalog")).status, 404, "/api/catalog must still be gated after a brand save");
});

test("PUT sanitize: smuggled colors are dropped by the key/value whitelist, a 300-char welcome is clamped to 128, a data: logo is refused — and the config FILE stores only the sanitized block (sanitize-at-write, not just at serve)", async () => {
  const put = await admin.put("/api/admin/brand-config", {
    welcome: "W".repeat(300),
    logo: "data:text/html,<script>alert(1)</script>",
    colors: {
      "--brand": "#123456", // legal — must survive
      "--evil": "red;url(evil)", // ';' + 'url(' — must be dropped
      "--x;inject": "#ffffff", // key smuggles ';' — must be dropped
    },
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const b = (await makeClient(srv.base).get("/api/env")).data.brand;
  assert.deepEqual(b.colors, { "--brand": "#123456" }, "only the legal colour may be served — smuggled ';' 'url(' keys/values must be dropped");
  assert.equal(b.welcome, "W".repeat(128), "over-long text must be clamped to 128 chars, same rule as serving");
  assert.equal(b.logo, null, "a data: logo must be refused and fall back to the default (null) — assets are files, not inline payloads");
  const text = fs.readFileSync(cfgFile, "utf8");
  const cfg = JSON.parse(text);
  assert.deepEqual(cfg.brand.colors || {}, { "--brand": "#123456" }, "the FILE must hold only sanitized colors — PUT sanitizes before writing");
  assert.ok(String(cfg.brand.welcome || "").length <= 128, "the FILE must hold the clamped text, not the 300-char paste");
  assert.ok(!/^data:/i.test(String(cfg.brand.logo || "")), "the FILE must not hold a data: logo");
  assert.ok(!text.includes("url(evil"), "the smuggled url( value must not reach the file at all");
});

test("brand asset upload: a real PNG is accepted, stored under /assets/brand/uploads/ with a SERVER-generated name (slot-timestamp.ext — the client filename is never used), served back byte-identical, and the returned url drops straight into brand.logo", async () => {
  const up = await admin.upload("/api/admin/brand-assets?slot=logo&name=" + encodeURIComponent("my company logo (final).png"), TINY_PNG);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const url = up.data && up.data.url;
  assert.equal(typeof url, "string", "response must carry { url } — the path the admin saves into brand");
  assert.ok(url.startsWith("/assets/brand/uploads/"), `returned url must live under /assets/brand/uploads/ (got ${url})`);
  const base = url.slice("/assets/brand/uploads/".length);
  assert.match(base, /^logo-[A-Za-z0-9_.-]+\.png$/, "filename must be server-generated from slot + timestamp, extension from the SNIFFED type");
  assert.ok(!/company/i.test(base), "no fragment of the client filename may survive into the stored name");
  const res = await admin.raw("GET", url);
  assert.equal(res.status, 200, "the returned url must be immediately servable");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.equals(TINY_PNG), "the served file must be the uploaded bytes");
  // The whole point of the returned path: it passes the brand asset rules.
  const put = await admin.put("/api/admin/brand-config", { logo: url });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const env = await makeClient(srv.base).get("/api/env");
  assert.equal(env.data.brand.logo, url, "the uploaded url must round-trip through PUT brand-config into /api/env");
});

test("brand asset upload rejects by CONTENT and SIZE: plain text named .png gets 400 (type is judged by magic bytes, never the filename), a >512KB file gets 413 (the codebase-wide upload-cap status, same as video/attachment uploads) — and neither refusal leaves a file in uploads/", async () => {
  const beforeFiles = listUploads();
  const fake = await admin.upload("/api/admin/brand-assets?slot=logo&name=totally-a.png", Buffer.from("MZ this is not an image at all"));
  assert.equal(fake.status, 400, "text masquerading as .png must be refused by the content sniff");
  const big = await admin.upload("/api/admin/brand-assets?slot=logo&name=big.png", Buffer.concat([TINY_PNG, Buffer.alloc(512 * 1024, 0)]));
  assert.equal(big.status, 413, "a file over the 512KB cap must be refused with 413 — the same status every other upload cap in this codebase answers with");
  assert.deepEqual(listUploads(), beforeFiles, "refused uploads must not leave files behind");
});

test("SVG uploads are defanged server-side across CASE-MIXED smuggling — lower/UPPER/Mixed <script>, on* handlers (incl. ONLOAD / ONMOUSEOVER), spaced and mixed-case javascript: hrefs, and <FOREIGNOBJECT> are ALL gone from the stored file while the drawing survives — and /assets/brand/uploads/ is served with the scriptless CSP that stops a directly-opened SVG from executing anything", async () => {
  // Browsers lower-case attribute/tag names at PARSE time, so `ONLOAD=` in the
  // stored bytes fires exactly like `onload=` when the file is opened directly.
  // A sanitiser that only matches lowercase is a real bypass — this payload
  // mixes case on EVERY vector so the case-insensitive assertions below bite.
  const EVIL_SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" ONMOUSEOVER="alert(9)">' +
      '<script>fetch("/api/me")</script>' +
      '<ScRiPt>fetch("/api/leak")</ScRiPt>' + // mixed-case tag
      '<rect ONLOAD="alert(2)" width="1" height="1"/>' + // UPPERCASE handler on a child
      '<a xlink:href="javascript:alert(3)"><text>x</text></a>' +
      '<a xlink:href = "  JaVaScRiPt:alert(4)"><text>y</text></a>' + // spaced + mixed-case scheme
      '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>' +
      '<FOREIGNOBJECT><iframe src="https://evil2.example"></iframe></FOREIGNOBJECT>' + // mixed-case tag
      '<rect width="10" height="10" fill="#123456"/>' +
      "</svg>", "utf8");
  const up = await admin.upload("/api/admin/brand-assets?slot=favicon&name=mark.svg", EVIL_SVG);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.match(String(up.data.url), /\.svg$/, "an svg body must be stored as .svg (sniffed from the text head)");
  const res = await admin.raw("GET", up.data.url);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /<script/i, "stored svg must not contain <script> — img contexts don't execute it, but a direct URL open would");
  assert.doesNotMatch(text, /\son[a-z]+\s*=/i, "stored svg must not contain on* event handler attributes");
  assert.doesNotMatch(text, /javascript:/i, "stored svg must not contain javascript: hrefs");
  assert.doesNotMatch(text, /foreignObject/i, "stored svg must not contain <foreignObject> (HTML smuggling)");
  assert.match(text, /<rect/, "sanitisation must strip the attack, not the drawing");
  const csp = res.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'none'/, "uploads must be served with default-src 'none' — belt-and-braces against anything the sanitiser misses");
  assert.match(csp, /style-src 'unsafe-inline'/, "the CSP must still let the svg's own inline styles paint");
});

test("path traversal: a client filename of ../../evil-escape.png cannot steer where the file lands — exactly one new file appears INSIDE uploads/ (directory listing is the proof) and no escaped file appears in any parent directory", async () => {
  const beforeFiles = new Set(listUploads());
  const up = await admin.upload("/api/admin/brand-assets?slot=logoLight&name=" + encodeURIComponent("../../evil-escape.png"), TINY_PNG);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.ok(String(up.data.url).startsWith("/assets/brand/uploads/"), "returned url must stay under uploads/");
  assert.ok(!String(up.data.url).includes(".."), "returned url must not carry a traversal fragment");
  const added = listUploads().filter((f) => !beforeFiles.has(f));
  assert.equal(added.length, 1, "exactly one new file must appear INSIDE uploads/");
  assert.match(added[0], /^logoLight-[A-Za-z0-9_.-]+\.png$/, "the landed filename is server-generated — no trace of the client's traversal name");
  for (const dir of [path.join(ROOT, "public", "assets", "brand"), path.join(ROOT, "public", "assets"), path.join(ROOT, "public"), ROOT]) {
    const hits = fs.readdirSync(dir).filter((f) => f.includes("evil-escape"));
    assert.deepEqual(hits, [], `traversal escaped uploads/: found ${hits.join(", ")} in ${dir}`);
  }
});

test("audit: a brand save lands in /api/admin/audit as brand.update with a real actor and NON-EMPTY before/after images — branding changes must be attributable", async () => {
  const put = await admin.put("/api/admin/brand-config", { tagline: "Audited tagline", tagline_zh: "留痕标语" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const log = await admin.get("/api/admin/audit");
  assert.equal(log.status, 200);
  const rows = log.data.rows.filter((r) => r.action === "brand.update");
  assert.ok(rows.length >= 1, "PUT brand-config must append a brand.update audit row");
  // listAudit is newest-first; find the row for THIS save via its after-image.
  const hit = rows.find((r) => JSON.stringify(r.after || {}).includes("Audited tagline"));
  assert.ok(hit, "this save's after-image must record the new copy");
  assert.ok(hit.actor, "the actor must be recorded");
  assert.ok(hit.before && typeof hit.before === "object" && Object.keys(hit.before).length > 0, "before must be the non-empty previous block (this suite always has one configured)");
  assert.ok(hit.after && typeof hit.after === "object" && Object.keys(hit.after).length > 0, "after must be the non-empty new block");
});

test("fresh install: with LMS_CONFIG_PATH pointing at a file that does not exist yet, PUT brand-config CREATES it containing ONLY the brand key — and the new copy is live on that same process's /api/env", async () => {
  assert.ok(!fs.existsSync(freshCfgFile), "precondition: the config file must not exist before the first save");
  const adminFresh = await loginAs(srvFresh.base, ADMIN);
  const put = await adminFresh.put("/api/admin/brand-config", { name: "Fresh Co", name_zh: "新装公司" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.ok(fs.existsSync(freshCfgFile), "the config file must be created by the first save");
  const cfg = JSON.parse(fs.readFileSync(freshCfgFile, "utf8"));
  assert.deepEqual(Object.keys(cfg), ["brand"], "a freshly created config must contain ONLY the brand key — no invented modules/lark stubs");
  assert.equal(cfg.brand.name, "Fresh Co");
  const env = await makeClient(srvFresh.base).get("/api/env");
  assert.equal(env.data.brand.name, "Fresh Co", "the save must be live immediately on the fresh server too");
  assert.equal(env.data.brand.name_zh, "新装公司", "the zh twin must land too");
});
