// S1 regression tests: /videos/* used to be served by serveStatic with NO
// identity check at all — static files never reach handleApi's 401 gate, so
// anybody who knew (or guessed) an uploaded file name could download the
// training videos. The rule now mirrors GET /api/attachments/:id:
//   session required · learning-domain reader always · otherwise the video must
//   be referenced by a course reachable through a published package assigned to
//   this employee · orphan uploads are back-office only.
// HTTP Range must survive the new gate untouched (the player's seek depends on
// it), and the video→course index must expire with the content cache.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

// Uploads live in the repo's public/videos (no env override), so every probe
// file is uniquely named and removed again in after().
const VIDEO_DIR = path.join(ROOT, "public", "videos");
const STAMP = `${process.pid}-${Date.now()}`;
const ASSIGNED = `s1-assigned-${STAMP}.mp4`;
const PRIVATE = `s1-private-${STAMP}.mp4`;
const ORPHAN = `s1-orphan-${STAMP}.mp4`;
const PROBES = [ASSIGNED, PRIVATE, ORPHAN];
// 4 KB of deterministic bytes — big enough for a meaningful byte range.
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
let madeDir = false;

// culture-conduct sits in the seeded "nho" package, which the demo employee
// DP-1001 is assigned; PRIVATE_COURSE is created below and assigned to nobody.
const PRIVATE_COURSE = "s1-private-course";

let srv, admin, emp, la, auditor;

// Create an employee, optionally give it an admin role, log in and clear the
// forced-password-change flag (same shape as test/rbac.test.js).
async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  const r = await admin.put("/api/admin/employees/" + u.id, { adminRoleId });
  assert.equal(r.status, 200, "assign role to " + empId);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  const cp = await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" });
  assert.equal(cp.status, 200, "clear mustChangePassword for " + empId);
  return c;
}

before(async () => {
  madeDir = !fs.existsSync(VIDEO_DIR);
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  for (const name of PROBES) fs.writeFileSync(path.join(VIDEO_DIR, name), BYTES);

  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);

  const roles = await admin.get("/api/admin/roles");
  assert.equal(roles.status, 200);
  const roleId = {};
  for (const r of roles.data.roles) if (r.key) roleId[r.key] = r.id;
  // Both console identities are created BEFORE the private course: a new
  // employee is auto-assigned every published mandatory package, and an
  // accidental assignment would let them through the learner path and hide a
  // broken grant check.
  la = await makeAdminUser("S1-LA", roleId["learning-admin"]);
  auditor = await makeAdminUser("S1-AUD", roleId["auditor"]);

  // Reference ASSIGNED from a section of the employee's assigned course.
  const { data: content } = await admin.get("/api/admin/content");
  const cc = content.courses.find((c) => c.id === "culture-conduct");
  cc.modules[0].sections[0].video = "/videos/" + ASSIGNED;
  assert.equal((await admin.put("/api/admin/content/courses/culture-conduct", cc)).status, 200);

  // A course nobody is assigned, referencing PRIVATE.
  const priv = {
    id: PRIVATE_COURSE, title: "S1 Private Course", status: "published", enrollType: "mandatory",
    modules: [{ id: "s1m1", title: "Only module", minutes: 5, sections: [{ heading: "clip", html: "<p>x</p>", video: "/videos/" + PRIVATE }] }],
  };
  assert.equal((await admin.put("/api/admin/content/courses/" + PRIVATE_COURSE, priv)).status, 200);
  // ORPHAN is referenced by nothing on purpose.
});

after(() => {
  if (srv) srv.stop();
  for (const name of PROBES) { try { fs.unlinkSync(path.join(VIDEO_DIR, name)); } catch {} }
  if (madeDir) { try { fs.rmdirSync(VIDEO_DIR); } catch {} }
});

// Anonymous fetch of a file that demonstrably exists and demonstrably serves to
// an authorised session below — so the 404 can only come from the new gate.
test("anonymous requests are refused for every /videos/ file, and refused as 404 so they cannot enumerate what exists", async () => {
  const anon = makeClient(srv.base);
  for (const name of PROBES) {
    const r = await anon.raw("GET", "/videos/" + name);
    assert.equal(r.status, 404, name + " must not serve without a session");
    const body = Buffer.from(await r.arrayBuffer());
    assert.notEqual(body.length, BYTES.length, "no bytes of " + name + " may reach an anonymous caller");
  }
  // A file that does not exist answers exactly the same way — nothing in the
  // response distinguishes "forbidden" from "no such video".
  const missing = await anon.raw("GET", "/videos/no-such-file-" + STAMP + ".mp4");
  assert.equal(missing.status, 404);
  // A Range header must not be a way past the gate either (serveVideo, which
  // answers 206, is only reached after authorization).
  const ranged = await fetch(srv.base + "/videos/" + ASSIGNED, { headers: { range: "bytes=0-99" } });
  assert.equal(ranged.status, 404, "an anonymous Range request must be refused, never answered 206");
});

test("an assigned employee gets the video of their course — 200 with the real bytes, and Range still answers 206 with a correct content-range", async () => {
  const full = await emp.raw("GET", "/videos/" + ASSIGNED);
  assert.equal(full.status, 200, "the assigned course's video must serve");
  assert.equal(full.headers.get("accept-ranges"), "bytes", "the range advertisement must survive the gate");
  assert.match(full.headers.get("content-type") || "", /video\/mp4/);
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.equal(bytes.length, BYTES.length);
  assert.ok(bytes.equals(BYTES), "the served bytes are the file's bytes");

  // Mid-file seek: this is what dragging the progress bar sends.
  const seek = await emp.raw("GET", "/videos/" + ASSIGNED, undefined, { range: "bytes=1000-1099" });
  assert.equal(seek.status, 206, "Range must still produce a partial response");
  assert.equal(seek.headers.get("content-range"), `bytes 1000-1099/${BYTES.length}`);
  assert.equal(seek.headers.get("content-length"), "100");
  const chunk = Buffer.from(await seek.arrayBuffer());
  assert.ok(chunk.equals(BYTES.subarray(1000, 1100)), "the partial body is the requested slice");
  // Open-ended range (the shape a player uses to start streaming).
  const tail = await emp.raw("GET", "/videos/" + ASSIGNED, undefined, { range: "bytes=4000-" });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-range"), `bytes 4000-${BYTES.length - 1}/${BYTES.length}`);
  // An unsatisfiable range keeps its own answer (416), not the gate's 404.
  const bad = await emp.raw("GET", "/videos/" + ASSIGNED, undefined, { range: "bytes=99999-" });
  assert.equal(bad.status, 416, "416 proves the request reached serveVideo, gate passed");
  assert.equal(bad.headers.get("content-range"), `bytes */${BYTES.length}`);
});

test("an employee cannot fetch the video of a course they are not assigned — same rule, and same 404, as the course itself", async () => {
  // Parity anchor: the course document is already 404 for this employee.
  assert.equal((await emp.get("/api/courses/" + PRIVATE_COURSE)).status, 404, "harness assumption: the private course is not assigned");
  const r = await emp.raw("GET", "/videos/" + PRIVATE);
  assert.equal(r.status, 404, "an unassigned course's video must not serve");
  const body = Buffer.from(await r.arrayBuffer());
  assert.notEqual(body.length, BYTES.length);
  // …while the same URL serves for the learning admin, so the 404 above is the
  // authorization decision and not a missing file.
  const ok = await la.raw("GET", "/videos/" + PRIVATE);
  assert.equal(ok.status, 200, "learning=manage may fetch any course video");
  assert.equal(Buffer.from(await ok.arrayBuffer()).length, BYTES.length);
});

test("orphan uploads (referenced by no course) are back-office only: learning reader yes, employee and auditor no", async () => {
  const laRes = await la.raw("GET", "/videos/" + ORPHAN);
  assert.equal(laRes.status, 200, "a learning admin must still reach an orphan upload (that is how HR previews one)");
  assert.equal(Buffer.from(await laRes.arrayBuffer()).length, BYTES.length);
  assert.equal((await admin.raw("GET", "/videos/" + ORPHAN)).status, 200, "super-admin reads every domain");

  const empRes = await emp.raw("GET", "/videos/" + ORPHAN);
  assert.equal(empRes.status, 404, "an employee has no course path to an orphan video");
  // The auditor is a console user, but its learning grant is none — a session
  // plus an admin role must not be enough on its own.
  const audRes = await auditor.raw("GET", "/videos/" + ORPHAN);
  assert.equal(audRes.status, 404, "audit=read must not open learning content");
});

test("the gate cannot be side-stepped by spelling the prefix differently", async () => {
  const anon = makeClient(srv.base);
  // On Windows public/VIDEOS resolves to the same directory, so a
  // case-sensitive prefix test would have been an anonymous read.
  const upper = await anon.raw("GET", "/VIDEOS/" + ASSIGNED);
  assert.notEqual(upper.status, 200, "an upper-cased prefix must not serve");
  assert.notEqual(Buffer.from(await upper.arrayBuffer()).length, BYTES.length);
  const upperDir = await anon.raw("GET", "/Videos/" + ASSIGNED);
  assert.notEqual(upperDir.status, 200);
  // The gate must stay scoped to /videos: the SPA shell is still public.
  assert.equal((await anon.raw("GET", "/")).status, 200, "the gate must not swallow the rest of serveStatic");
});

test("the video→course index expires with the content cache: dropping the reference revokes the learner's access", async () => {
  // Sanity: it serves right now.
  assert.equal((await emp.raw("GET", "/videos/" + ASSIGNED)).status, 200);
  const { data: content } = await admin.get("/api/admin/content");
  const cc = content.courses.find((c) => c.id === "culture-conduct");
  cc.modules[0].sections[0].video = null;
  assert.equal((await admin.put("/api/admin/content/courses/culture-conduct", cc)).status, 200);
  // No restart, no cache flush of our own: the index is rebuilt by the same
  // refreshContent() the course save already calls, so the very next request
  // sees the video as an orphan again.
  const after1 = await emp.raw("GET", "/videos/" + ASSIGNED);
  assert.equal(after1.status, 404, "a video removed from the course must stop serving to the learner immediately");
  assert.equal((await la.raw("GET", "/videos/" + ASSIGNED)).status, 200, "…while the back office keeps its orphan access");
});

// 对抗复核 S1-a: the video→course index must authorise the file that is actually
// served, not a case-variant of it. It used to fall back to a case-INSENSITIVE
// union of every course referencing any spelling, so on a case-sensitive
// filesystem (production is Linux) /videos/clip.mp4 — an orphan upload — was
// granted because an assigned course referenced /videos/Clip.mp4.
test("an assigned video authorises only its exact file name, never a case-variant", async () => {
  const MIXED = `S1Case-${STAMP}.mp4`;
  fs.writeFileSync(path.join(VIDEO_DIR, MIXED), BYTES);
  PROBES.push(MIXED);
  const { data: content } = await admin.get("/api/admin/content");
  const dp = content.courses.find((c) => c.id === "data-privacy"); // also in the nho package
  dp.modules[0].sections[0].video = "/videos/" + MIXED;
  assert.equal((await admin.put("/api/admin/content/courses/data-privacy", dp)).status, 200);

  // The spelling the course stores is the one the player asks for: it serves.
  assert.equal((await emp.raw("GET", "/videos/" + MIXED)).status, 200, "the exact reference must serve");
  // Any other spelling is, as far as authorization goes, a different file.
  const lower = MIXED.toLowerCase();
  assert.notEqual((await emp.raw("GET", "/videos/" + lower)).status, 200,
    "a case-variant spelling must not inherit the grant");
  // On a case-insensitive filesystem that URL demonstrably resolves to the very
  // same bytes for the back office, so the learner's refusal above is an
  // authorization decision and not a missing file.
  if (fs.existsSync(path.join(VIDEO_DIR, lower)))
    assert.equal((await la.raw("GET", "/videos/" + lower)).status, 200, "learning readers still get it");
});

// 对抗复核 S1-b: since S1 the gate parses the Cookie header inside serveStatic,
// which — unlike handleApi — is not wrapped in a promise catch. A malformed
// percent-escape ("Cookie: sid=%") made decodeURIComponent throw and killed the
// whole process: one anonymous request, 925 users offline.
test("a malformed session cookie is refused, not a way to crash the server", async () => {
  for (const bad of ["%", "%zz", "%e0%a4%a", "a%"]) {
    const r = await fetch(srv.base + "/videos/" + ORPHAN, { headers: { cookie: "sid=" + bad } });
    assert.equal(r.status, 404, `cookie sid=${bad} must be refused, not honoured`);
    await r.arrayBuffer();
  }
  // …and the server is still there afterwards, still serving an authorised session.
  assert.equal((await la.raw("GET", "/videos/" + ORPHAN)).status, 200, "server must still be up");
});
