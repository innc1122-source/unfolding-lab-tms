// brand.legal — optional login-page legal links (privacy policy / terms of
// service). Contract pinned here:
//   1. "configured-or-absent": with no legal block (or no config at all) the
//      resolved brand on /api/env AND /api/me has NO `legal` key — the login
//      page then renders exactly as before;
//   2. a valid block is served identically on both endpoints;
//   3. URL whitelist: only absolute http(s) URLs or single-slash site-relative
//      paths survive; javascript:/data:/mailto:/ftp:, protocol-relative //x,
//      backslashes, whitespace, quotes, angle brackets, non-strings and
//      over-512-char values are DROPPED one by one (the valid sibling stays),
//      and a block with nothing valid left disappears entirely;
//   4. PUT /api/admin/brand-config applies the same filter at write time, so a
//      Brand Settings save keeps a valid legal block and never stores a bad URL.
// Temp configs live under os.tmpdir(); the repo-root config.json is never read
// or written (every server here gets its own LMS_CONFIG_PATH).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

const tmpDirs = [];
let srvNone, srvMut, mutFile;
function setMut(cfg) { fs.writeFileSync(mutFile, JSON.stringify(cfg, null, 2)); }

before(async () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "lms-legal-cfg-"));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "lms-legal-cfg-"));
  tmpDirs.push(d1, d2);
  mutFile = path.join(d2, "config.json");
  setMut({});
  [srvNone, srvMut] = await Promise.all([
    // A path that does not exist = "no config at all", independent of the
    // developer's real config.json.
    startServer({ env: { LMS_CONFIG_PATH: path.join(d1, "absent.json") } }),
    startServer({ env: { LMS_CONFIG_PATH: mutFile } }),
  ]);
});
after(() => {
  for (const s of [srvNone, srvMut]) if (s) s.stop();
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test("unconfigured: with no config at all, neither /api/env nor /api/me carries a brand.legal key", async () => {
  const env = await makeClient(srvNone.base).get("/api/env");
  assert.equal(env.status, 200);
  assert.ok(env.data.brand && typeof env.data.brand === "object");
  assert.ok(!("legal" in env.data.brand), "no legal config → the key must be absent, not null/{} (the login page shows nothing)");
  const me = await (await loginAs(srvNone.base, EMPLOYEE)).get("/api/me");
  assert.ok(!("legal" in me.data.brand), "/api/me must agree: no legal key");
});

test("a brand block WITHOUT legal (other fields configured) still serves no legal key", async () => {
  setMut({ brand: { name: "Acme", footer: "Acme only" } });
  const b = (await makeClient(srvMut.base).get("/api/env")).data.brand;
  assert.equal(b.name, "Acme", "sibling field lands — proves the config was read");
  assert.ok(!("legal" in b));
});

test("valid legal block (https URL + site-relative path) is served verbatim and identically on /api/env and /api/me", async () => {
  const legal = { privacyUrl: "https://example.com/privacy?lang=en#top", termsUrl: "/legal/terms.html" };
  setMut({ brand: { legal } });
  const env = await makeClient(srvMut.base).get("/api/env");
  assert.deepEqual(env.data.brand.legal, legal);
  const me = await (await loginAs(srvMut.base, EMPLOYEE)).get("/api/me");
  assert.deepEqual(me.data.brand, env.data.brand, "/api/me must serve the same merged brand, legal included");
  // Surrounding whitespace is trimmed; a single valid URL stands alone.
  setMut({ brand: { legal: { termsUrl: "  http://intranet.local/terms  " } } });
  assert.deepEqual((await makeClient(srvMut.base).get("/api/env")).data.brand.legal, { termsUrl: "http://intranet.local/terms" });
});

test("illegal URLs are dropped one by one — the valid sibling survives — and a block with nothing valid disappears entirely", async () => {
  const c = makeClient(srvMut.base);
  const BAD = [
    "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "mailto:legal@example.com",
    "ftp://example.com/terms", "//evil.example/terms", "/\\evil.example", "\\\\evil\\share",
    "https://exa mple.com/x", "/legal/terms.html\" onmouseover=\"x", "/legal/<script>", "relative/path.html",
    "https://", "http:///nohost", "", "   ", "/" + "a".repeat(600), 42, null, { url: "/x" }, ["https://example.com"],
  ];
  for (const bad of BAD) {
    setMut({ brand: { name: "Guard Co", legal: { privacyUrl: bad, termsUrl: "/legal/terms.html" } } });
    const b = (await c.get("/api/env")).data.brand;
    assert.equal(b.name, "Guard Co", "sibling brand field lands — proves the config was read");
    assert.deepEqual(b.legal, { termsUrl: "/legal/terms.html" }, `privacyUrl ${JSON.stringify(bad)} must be dropped while the valid termsUrl stays`);
  }
  setMut({ brand: { legal: { privacyUrl: "javascript:alert(1)", termsUrl: "//evil.example" } } });
  assert.ok(!("legal" in (await c.get("/api/env")).data.brand), "nothing valid left → no legal key at all");
  for (const shape of ["https://example.com", ["https://example.com"], 7, null]) {
    setMut({ brand: { legal: shape } });
    assert.ok(!("legal" in (await c.get("/api/env")).data.brand), `legal of shape ${JSON.stringify(shape)} is not an object → ignored`);
  }
  // Unknown keys inside legal never pass through.
  setMut({ brand: { legal: { privacyUrl: "/p", extra: "https://example.com" } } });
  assert.deepEqual((await c.get("/api/env")).data.brand.legal, { privacyUrl: "/p" });
});

test("PUT /api/admin/brand-config sanitizes legal at write time: a valid URL is stored and served, an illegal one never reaches the file", async () => {
  setMut({ brand: {} });
  const admin = await loginAs(srvMut.base, ADMIN);
  const r = await admin.put("/api/admin/brand-config", {
    brand: { name: "Legal Co", legal: { privacyUrl: "https://example.com/privacy", termsUrl: "javascript:alert(1)" } },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.configured.legal, { privacyUrl: "https://example.com/privacy" });
  const stored = JSON.parse(fs.readFileSync(mutFile, "utf8"));
  assert.deepEqual(stored.brand.legal, { privacyUrl: "https://example.com/privacy" }, "the config file must hold only the sanitized legal block");
  assert.doesNotMatch(fs.readFileSync(mutFile, "utf8"), /javascript:/i);
  assert.deepEqual((await makeClient(srvMut.base).get("/api/env")).data.brand.legal, { privacyUrl: "https://example.com/privacy" });
  // A save carrying no legal (what an older Brand Settings page would send)
  // leaves no legal behind — which is why the page now round-trips it.
  const r2 = await admin.put("/api/admin/brand-config", { brand: { name: "Legal Co", legal: { termsUrl: "//evil.example" } } });
  assert.equal(r2.status, 200);
  assert.ok(!("legal" in r2.data.configured), "an all-invalid legal block is dropped from the stored config");
  assert.ok(!("legal" in (await makeClient(srvMut.base).get("/api/env")).data.brand));
});

test("Brand Settings round-trip: GET exposes the configured legal block and PUTting it back (what the page's save does) keeps it intact", async () => {
  const legal = { privacyUrl: "https://example.com/privacy", termsUrl: "/legal/terms.html" };
  setMut({ brand: { name: "Round Trip Co", legal } });
  const admin = await loginAs(srvMut.base, ADMIN);
  const g = await admin.get("/api/admin/brand-config");
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.configured.legal, legal, "the page reads configured.legal to carry it through a save");
  assert.deepEqual(g.data.brand.legal, legal);
  // The page PUTs the bare brand block (texts it holds + configured.legal).
  const r = await admin.put("/api/admin/brand-config", { name: "Round Trip Co", tagline: "New tagline", legal: g.data.configured.legal });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(mutFile, "utf8")).brand.legal, legal, "a save from Brand Settings must not erase legal");
  assert.deepEqual((await makeClient(srvMut.base).get("/api/env")).data.brand.legal, legal);
});

test("URL boundaries: 512 chars is kept, 513 dropped; an unparsable port or a bare scheme-host mix is dropped", async () => {
  const c = makeClient(srvMut.base);
  const at512 = "/" + "a".repeat(511);
  const at513 = "/" + "a".repeat(512);
  setMut({ brand: { legal: { privacyUrl: at512, termsUrl: at513 } } });
  assert.deepEqual((await c.get("/api/env")).data.brand.legal, { privacyUrl: at512 });
  for (const bad of ["https://example.com:99999/x", "https:example.com", "http:/example.com", "/legal/ terms", "/legal/ terms"]) {
    setMut({ brand: { legal: { privacyUrl: bad, termsUrl: "/t" } } });
    assert.deepEqual((await c.get("/api/env")).data.brand.legal, { termsUrl: "/t" }, `${JSON.stringify(bad)} must be dropped`);
  }
  // Scheme is case-insensitive; the value is served as configured (trimmed only).
  setMut({ brand: { legal: { privacyUrl: "HTTPS://Example.com/Privacy" } } });
  assert.deepEqual((await c.get("/api/env")).data.brand.legal, { privacyUrl: "HTTPS://Example.com/Privacy" });
});
