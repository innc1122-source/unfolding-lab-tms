// Module switches (commercial packaging, phase 1): learning / performance /
// talent can each be forced off via LMS_MODULES_OFF (comma list); core has no
// switch and can never close. Contract under test:
//   - a closed module's API routes 404 exactly like routes that never existed;
//   - /api/env and /api/me both advertise modules:{learning,performance,talent,culture}
//     (culture — registered 2026-09-26 — is defaultOn:false: off unless config.json says "culture": true);
//   - "core" and unknown names in the list are ignored;
//   - closing a module never freezes core data (P9: performance-type records in
//     the core talent_records table stay writable/readable);
//   - and the hard line: with no env and no config, behaviour is identical to
//     the pre-switch server (default = the three original modules on; culture,
//     which did not exist then, stays off and all of its paths 404).
// The switch is read from the environment at spawn time, so every combination
// gets its own server process (booted in parallel to keep the suite fast).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

let srvDefault, srvNoLearning, srvNoPerf, srvNoTalent, srvIgnored;
before(async () => {
  [srvDefault, srvNoLearning, srvNoPerf, srvNoTalent, srvIgnored] = await Promise.all([
    startServer(),
    startServer({ env: { LMS_MODULES_OFF: "learning" } }),
    startServer({ env: { LMS_MODULES_OFF: "performance" } }),
    startServer({ env: { LMS_MODULES_OFF: "talent" } }),
    startServer({ env: { LMS_MODULES_OFF: "core,bogus,learning" } }),
  ]);
});
after(() => { for (const s of [srvDefault, srvNoLearning, srvNoPerf, srvNoTalent, srvIgnored]) if (s) s.stop(); });

// A gated route must look like a route that never existed: 404 with the
// standard not-found error body. The generic catch-all appends the pathname
// ("Not found: /api/x"), so both spellings count as "not found" here — what
// must NOT leak is any hint that the route exists but is disabled (403 etc.).
async function assertGone(promise, label) {
  const r = await promise;
  assert.equal(r.status, 404, label + " must 404 when its module is off");
  assert.match(String(r.data && r.data.error), /^Not found/, label + " must use the standard not-found body, indistinguishable from a missing route");
}

test("with LMS_MODULES_OFF unset and no config, the three original modules report on and none of their routes is gated — the zero-config default must stay byte-identical in behaviour to the pre-switch server; culture (defaultOn:false) reports off", async () => {
  const env = await makeClient(srvDefault.base).get("/api/env");
  assert.equal(env.status, 200);
  assert.deepEqual(env.data.modules, { learning: true, performance: true, talent: true, ai: false }, "/api/env must advertise the three original modules on and culture and ai (defaultOn:false) off");
  const admin = await loginAs(srvDefault.base, ADMIN);
  const emp = await loginAs(srvDefault.base, EMPLOYEE);
  const me = await emp.get("/api/me");
  assert.deepEqual(me.data.modules, { learning: true, performance: true, talent: true, ai: false }, "/api/me must carry the same module map (useAuth reads it from here)");
  // Unfolding Lab 版：culture 模块已删除，它的 API 与学员端都是 404（超管也一样）
  for (const [client, p] of [[emp, "/api/v1/me/culture/entry"], [admin, "/api/v1/culture/programs"]]) {
    const r = await client.get(p);
    assert.equal(r.status, 404, p + " must 404 (Unfolding Lab edition: the culture module is not installed)");
  }
  for (const [client, p] of [[emp, "/api/catalog"], [emp, "/api/me/reviews"], [admin, "/api/admin/talent-review"]]) {
    const r = await client.get(p);
    assert.equal(r.status, 200, p + " must answer normally when nothing is configured off");
  }
});

test("LMS_MODULES_OFF=learning closes learning routes for employees and admins alike, leaves performance and core open, and the dashboard keeps its core fields with the training block empty", async () => {
  const admin = await loginAs(srvNoLearning.base, ADMIN);
  const emp = await loginAs(srvNoLearning.base, EMPLOYEE);
  await assertGone(emp.get("/api/catalog"), "/api/catalog");
  await assertGone(admin.get("/api/admin/exams"), "/api/admin/exams");
  assert.equal((await emp.get("/api/me/reviews")).status, 200, "performance was not listed and must stay open");
  assert.equal((await admin.get("/api/admin/roster")).status, 200, "core roster must stay open");
  const env = await makeClient(srvNoLearning.base).get("/api/env");
  assert.equal(env.status, 200);
  assert.equal(env.data.modules.learning, false, "/api/env must report learning off");
  assert.equal(env.data.modules.performance, true, "only the listed module goes off");
  assert.equal(env.data.modules.talent, true, "only the listed module goes off");
  // 裁定①: the dashboard endpoint is a core shell that never closes — the
  // learning-owned training[] field is cropped instead (empty or absent, but
  // never still reporting the seeded demo programs).
  const dash = await admin.get("/api/admin/dashboard");
  assert.equal(dash.status, 200, "the dashboard shell is core and must not close with learning");
  assert.equal(typeof dash.data.headcount, "number", "core KPI fields must survive the cropping");
  assert.ok(Array.isArray(dash.data.byDept), "core department breakdown must survive the cropping");
  assert.equal((dash.data.training || []).length, 0, "the learning training block must be empty when learning is off");
});

test("LMS_MODULES_OFF=performance closes the review flow, but performance-type records still write and read through core talent-record CRUD — closing a module must not freeze core history (P9)", async () => {
  const admin = await loginAs(srvNoPerf.base, ADMIN);
  const emp = await loginAs(srvNoPerf.base, EMPLOYEE);
  await assertGone(admin.get("/api/admin/review-cycles"), "/api/admin/review-cycles");
  await assertGone(emp.get("/api/me/reviews"), "/api/me/reviews");
  // The records routes live in core; "performance" here is just a record TYPE
  // seeded in the core schema. HR must still be able to backfill 手工补录.
  const rec = await admin.post("/api/admin/employees/u-1001/records", {
    type: "performance",
    date: "2026-06-30",
    title: "2026-H1 manual entry 手工补录",
    fields: { period: "2026-H1", rating: "A" },
  });
  assert.equal(rec.status, 200, "core record create must still accept performance-type records: " + JSON.stringify(rec.data));
  const prof = await admin.get("/api/admin/employees/u-1001/profile");
  assert.equal(prof.status, 200, "the core profile page must stay up");
  const found = (prof.data.events || []).find((e) => e.source === "record" && e.type === "performance" && e.date === "2026-06-30");
  assert.ok(found, "the record written while performance is off must read back from the core profile timeline");
  assert.equal(found.detail.rating, "A", "the stored rating must round-trip intact");
});

test("LMS_MODULES_OFF=talent closes the 9-box and the AI portrait, while the core roster and the dashboard shell keep answering", async () => {
  const admin = await loginAs(srvNoTalent.base, ADMIN);
  await assertGone(admin.get("/api/admin/talent-review"), "/api/admin/talent-review");
  await assertGone(admin.post("/api/admin/employees/u-1001/ai-portrait"), "/api/admin/employees/:id/ai-portrait");
  assert.equal((await admin.get("/api/admin/roster")).status, 200, "core roster must stay open");
  assert.equal((await admin.get("/api/admin/dashboard")).status, 200, "the dashboard is a core shell (裁定①) and must not close with talent");
});

test("LMS_MODULES_OFF=core,bogus,learning ignores 'core' and unknown names — core can never be switched off, and the valid learning entry in the same list still applies", async () => {
  // loginAs itself proves POST /api/auth/login survived a list that names core.
  const emp = await loginAs(srvIgnored.base, EMPLOYEE);
  const me = await emp.get("/api/me");
  assert.equal(me.status, 200, "/api/me is core and must survive an LMS_MODULES_OFF that names core");
  assert.ok(me.data.modules, "/api/me must still carry the module map");
  assert.equal(me.data.modules.learning, false, "the valid learning entry in the same list must still apply");
  assert.equal(me.data.modules.performance, true, "the bogus entry must not knock out anything else");
  assert.equal(me.data.modules.talent, true, "the bogus entry must not knock out anything else");
  await assertGone(emp.get("/api/catalog"), "/api/catalog");
});

// /videos/ is the one gate point outside handleApi (MODULES.md 6.3). A bare 404
// proves nothing (a missing file also 404s), so the probe first shows the SAME
// file serving with learning on, then that the identical URL 404s with learning
// off: the only difference between the two requests is the switch, so the 404
// can only come from the gate.
// S1 added a session requirement in front of that gate, so the "on" probe is now
// made as an admin (the video is an orphan upload no course references, which
// only a learning-domain reader may fetch). The anonymous case is pinned in
// test/videos.test.js — here it would confuse the two gates.
test("a real file under /videos/ serves while learning is on and 404s on the learning-off server — the static video gate closes existing files, not just missing ones", async () => {
  const dir = path.join(ROOT, "public", "videos");
  const name = `modules-gate-probe-${process.pid}-${Date.now()}.mp4`;
  const probeBytes = "not a real mp4, just a byte probe for the module gate";
  const madeDir = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), probeBytes);
  try {
    const adminOn = await loginAs(srvDefault.base, ADMIN);
    const on = await adminOn.raw("GET", "/videos/" + name);
    assert.equal(on.status, 200, "with learning on the probe file must serve — otherwise the 404 below proves nothing");
    assert.equal((await on.arrayBuffer()).byteLength, Buffer.byteLength(probeBytes), "the probe must serve its actual bytes");
    // Same identity on the learning-off server: only the switch differs.
    const adminOff = await loginAs(srvNoLearning.base, ADMIN);
    const off = await adminOff.raw("GET", "/videos/" + name);
    assert.equal(off.status, 404, "with learning off the very same existing file must be unreachable even for an admin");
    // The gate must be scoped to /videos/ — the SPA shell keeps serving.
    const shell = await fetch(srvNoLearning.base + "/");
    assert.equal(shell.status, 200, "the gate must not swallow the rest of serveStatic");
  } finally {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
    // Only tidy the directory away if this test created it (and it is empty).
    if (madeDir) { try { fs.rmdirSync(dir); } catch {} }
  }
});
