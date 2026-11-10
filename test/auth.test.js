// Baseline regression tests: authentication, lockout, password lifecycle,
// deactivation. All against a throwaway test database (see helpers.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, DEMO_ADMIN, EMPLOYEE, startServer, makeClient, loginAs } = require("./helpers.js");

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

test("wrong password is rejected", async () => {
  const c = makeClient(srv.base);
  const r = await c.login({ employeeId: EMPLOYEE.employeeId, password: "nope-nope" });
  assert.equal(r.status, 401);
});

test("unknown employee id is rejected", async () => {
  const c = makeClient(srv.base);
  const r = await c.login({ employeeId: "DP-9999", password: "whatever" });
  assert.equal(r.status, 401);
});

test("admin can log in and /api/me reports the admin role", async () => {
  const c = await loginAs(srv.base, ADMIN);
  const me = await c.get("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.role, "admin");
  assert.equal(me.data.employeeId, "ADMIN");
});

test("public demo administrator can open the management console", async () => {
  const c = await loginAs(srv.base, DEMO_ADMIN);
  const me = await c.get("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.role, "admin");
  assert.equal(me.data.employeeId, "DEMO-ADMIN");
  assert.equal((await c.get("/api/admin/employees")).status, 200);
});

test("public demo includes a protected PDF and an HTTPS course video", async () => {
  const c = await loginAs(srv.base, DEMO_ADMIN);

  const record = await c.get("/api/courses/culture-conduct");
  assert.equal(record.status, 200);
  const guide = record.data.modules[0].sections[0].attachments.find(
    (attachment) => attachment.id === "att-demo-unfolding-guide",
  );
  assert.equal(guide.kind, "pdf");

  const pdf = await c.raw("GET", "/api/attachments/" + guide.id);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type"), /application\/pdf/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");

  const coaching = await c.get("/api/courses/data-privacy");
  assert.equal(coaching.status, 200);
  assert.match(coaching.data.modules[0].sections[0].videoEmbed, /^https:\/\//);
});

test("employee can log in, then log out (session dies)", async () => {
  const c = await loginAs(srv.base, EMPLOYEE);
  assert.equal((await c.get("/api/me")).status, 200);
  await c.post("/api/auth/logout");
  assert.equal((await c.get("/api/me")).status, 401);
});

test("5 failed logins lock the account for that client", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const { data: created } = await admin.post("/api/admin/employees", { name: "Lockout Test", employeeId: "DP-LOCK" });
  const c = makeClient(srv.base);
  for (let i = 0; i < 5; i++) {
    const r = await c.login({ employeeId: "DP-LOCK", password: "wrong-" + i });
    assert.equal(r.status, 401);
  }
  // Even the CORRECT password is now refused while locked.
  const locked = await c.login({ employeeId: "DP-LOCK", password: created.password });
  assert.equal(locked.status, 429);
});

test("HR-created accounts must change password; self-change clears the flag", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const { data: created } = await admin.post("/api/admin/employees", { name: "PW Test", employeeId: "DP-PW01" });
  assert.ok(created.password, "initial password returned once");

  const c = await loginAs(srv.base, { employeeId: "DP-PW01", password: created.password });
  let me = await c.get("/api/me");
  assert.equal(me.data.mustChangePassword, true);

  // Wrong current password / too-short new password are rejected.
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: "bad", newPassword: "longenough1" })).status, 400);
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "short" })).status, 400);

  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "my-own-pass-1" })).status, 200);
  me = await c.get("/api/me");
  assert.equal(me.data.mustChangePassword, false);

  // Old password no longer works, new one does.
  assert.equal((await makeClient(srv.base).login({ employeeId: "DP-PW01", password: created.password })).status, 401);
  assert.equal((await makeClient(srv.base).login({ employeeId: "DP-PW01", password: "my-own-pass-1" })).status, 200);
});

test("admin password reset forces a change and kills sessions", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const { data: created } = await admin.post("/api/admin/employees", { name: "Reset Test", employeeId: "DP-RST1" });
  const c = await loginAs(srv.base, { employeeId: "DP-RST1", password: created.password });

  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === "DP-RST1");
  const reset = await admin.post(`/api/admin/employees/${u.id}/reset`);
  assert.equal(reset.status, 200);
  assert.ok(reset.data.password);

  // Old session is dead, old password dead, new password requires a change.
  assert.equal((await c.get("/api/me")).status, 401);
  assert.equal((await makeClient(srv.base).login({ employeeId: "DP-RST1", password: created.password })).status, 401);
  const c2 = await loginAs(srv.base, { employeeId: "DP-RST1", password: reset.data.password });
  assert.equal((await c2.get("/api/me")).data.mustChangePassword, true);
});

test("deactivating an employee kicks them out and blocks login", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const { data: created } = await admin.post("/api/admin/employees", { name: "Offboard Test", employeeId: "DP-OFF1" });
  const c = await loginAs(srv.base, { employeeId: "DP-OFF1", password: created.password });

  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === "DP-OFF1");
  const r = await admin.put(`/api/admin/employees/${u.id}`, { active: false });
  assert.equal(r.status, 200);

  assert.equal((await c.get("/api/me")).status, 401);
  assert.equal((await makeClient(srv.base).login({ employeeId: "DP-OFF1", password: created.password })).status, 401);
});

/* ---------------- access log (S2) ----------------
   Sign-in / sign-out land in the SAME audit_logs table as every other action,
   read back through /api/admin/audit. The load-bearing assertion in here is the
   NEGATIVE one: no submitted password, or any fragment of one, may ever appear
   in a log row — including when the password is typed into the employee-ID box. */

// All auth.* rows currently in the log, newest first.
async function authRows(admin, action) {
  const r = await admin.get("/api/admin/audit?limit=5000");
  assert.equal(r.status, 200);
  return (r.data.rows || []).filter((x) => x.action === action);
}
// Whole-row haystack, so a leak can't hide in `before`, `after` or a label.
const rowText = (r) => JSON.stringify(r);

test("successful login writes one auth.login row", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const { data: created } = await admin.post("/api/admin/employees", { name: "Log In", employeeId: "DP-LOG01" });
  const before = (await authRows(admin, "auth.login")).length;
  await loginAs(srv.base, { employeeId: "DP-LOG01", password: created.password });

  const rows = await authRows(admin, "auth.login");
  assert.equal(rows.length, before + 1);
  const row = rows.find((x) => x.target === "DP-LOG01");
  assert.ok(row, "the new row is targeted at the employee id that signed in");
  assert.equal(row.after.method, "password");
  // The actor is the person who signed in — not "System" and not the admin.
  assert.equal(row.actor, "Log In");
  // The id resolves to a name for the 对象 column.
  assert.match(row.targetLabel || "", /Log In \(DP-LOG01\)/);
  assert.equal(rowText(row).includes(created.password), false, "the password is never logged");
});

test("failed login writes auth.login_failed with a reason and no password", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  await admin.post("/api/admin/employees", { name: "Bad Pass", employeeId: "DP-LOG02" });
  const SECRET = "Zq7-guessed-this-one";

  const bad = await makeClient(srv.base).login({ employeeId: "DP-LOG02", password: SECRET });
  assert.equal(bad.status, 401);
  // Unknown id: same 401 to the caller, a different reason in the log.
  assert.equal((await makeClient(srv.base).login({ employeeId: "DP-NOBODY", password: SECRET })).status, 401);

  const rows = await authRows(admin, "auth.login_failed");
  const mine = rows.find((x) => x.target === "DP-LOG02");
  assert.ok(mine, "a row for the guessed account");
  assert.equal(mine.after.reason, "bad_password");
  assert.equal(mine.after.method, "password");
  assert.equal(mine.actor, "Bad Pass", "actor is the account under attack, so the log can be filtered by victim");

  const unknown = rows.find((x) => x.target === "DP-NOBODY");
  assert.ok(unknown, "a row for the id that doesn't exist");
  assert.equal(unknown.after.reason, "unknown_id");
  assert.equal(unknown.targetLabel, null, "nothing to resolve, so the raw id is shown");

  for (const r of rows) {
    assert.equal(rowText(r).includes(SECRET), false, "no failed-login row carries the submitted password");
    assert.equal(rowText(r).includes("password:"), false);
  }
});

test("a password typed into the employee-ID box is never stored verbatim", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  // Not employee-ID shaped (too long, illegal characters) — exactly what a
  // password looks like when it lands in the wrong field.
  const PASTED = "correct horse battery staple!42";

  assert.equal((await makeClient(srv.base).login({ employeeId: PASTED, password: PASTED })).status, 401);

  const rows = await authRows(admin, "auth.login_failed");
  assert.ok(rows.some((x) => x.target === "(malformed)"), "the id is replaced by a placeholder");
  const all = JSON.stringify(rows);
  assert.equal(all.includes(PASTED), false, "the pasted secret is nowhere in the log");
  assert.equal(all.includes("battery"), false, "not even a fragment of it");
});

test("lockout refusals are logged too, with the reason 'locked'", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  await admin.post("/api/admin/employees", { name: "Lock Log", employeeId: "DP-LOG03" });
  const c = makeClient(srv.base);
  for (let i = 0; i < 5; i++) await c.login({ employeeId: "DP-LOG03", password: "wrong-" + i });
  assert.equal((await c.login({ employeeId: "DP-LOG03", password: "wrong-again" })).status, 429);

  const rows = (await authRows(admin, "auth.login_failed")).filter((x) => x.target === "DP-LOG03");
  assert.equal(rows.filter((x) => x.after.reason === "bad_password").length, 5);
  const locked = rows.find((x) => x.after.reason === "locked");
  assert.ok(locked, "the refusal after the lock is its own row");
  assert.ok(locked.after.minutes >= 1);
});

test("a locked-out attacker cannot flood the log: one 'locked' row per lock period", async () => {
  // The refusal path returns before scrypt and before any DB work, so it is the
  // cheapest request an attacker can make. If it appended an audit row each
  // time, unauthenticated traffic could grow an append-only, never-pruned table
  // without limit AND evict every back-office row from the reader's 2000-row
  // window — the log would be worthless exactly when it is needed.
  const admin = await loginAs(srv.base, ADMIN);
  await admin.post("/api/admin/employees", { name: "Flood Log", employeeId: "DP-LOG08" });
  const c = makeClient(srv.base);
  for (let i = 0; i < 5; i++) await c.login({ employeeId: "DP-LOG08", password: "wrong-" + i });

  const mine = async () => (await authRows(admin, "auth.login_failed")).filter((x) => x.target === "DP-LOG08");
  const before = (await mine()).length;
  for (let i = 0; i < 25; i++) assert.equal((await c.login({ employeeId: "DP-LOG08", password: "x" })).status, 429);
  const rows = await mine();

  assert.equal(rows.length, before + 1, "25 refused requests added exactly one row");
  assert.equal(rows.filter((x) => x.after.reason === "locked").length, 1);
  // Still refused, still 429 — throttling itself is untouched by the log dedupe.
  assert.equal((await c.login({ employeeId: "DP-LOG08", password: "x" })).status, 429);
});

test("a hostile employee-ID box cannot inject, overflow or smuggle text into the log", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  // The audit write is parameterized, but `target` is attacker-supplied text on
  // a PRE-AUTH route, so the shape guard is what keeps it from becoming a
  // storage/rendering problem: anything that is not employee-ID shaped is
  // replaced, never stored.
  const hostile = {
    oversize: "A".repeat(200000),
    sqli: "DP-1001'); DROP TABLE audit_logs; --",
    nul: "DP-1001 tail",
    newline: "DP-1001\nauth.login SUCCESS",
    html: "<script>alert(1)</script>",
    tooLong21: "A".repeat(21),
  };
  for (const [k, v] of Object.entries(hostile))
    assert.equal((await makeClient(srv.base).login({ employeeId: v, password: "pw-" + k })).status, 401, k);
  // Non-string bodies must not throw a 500 either.
  for (const v of [["a"], { a: 1 }, null])
    assert.equal((await makeClient(srv.base).login({ employeeId: v, password: "x" })).status, 401);

  const rows = await authRows(admin, "auth.login_failed");
  const all = JSON.stringify(rows);
  for (const [k, v] of Object.entries(hostile))
    assert.equal(all.includes(v.slice(0, 40)), false, k + " is not stored verbatim");
  assert.equal(all.includes("pw-"), false, "no submitted password reaches the log");
  // Every stored target is either a legal employee id (<= 20 chars) or a fixed
  // placeholder — so no row can carry an unbounded or control-character string.
  for (const r of rows) {
    assert.ok(typeof r.target === "string" || r.target === null);
    if (r.target && !["(malformed)", "(blank)"].includes(r.target)) {
      assert.match(r.target, /^[A-Za-z0-9][A-Za-z0-9-]{2,19}$/, "stored target is employee-ID shaped");
    }
  }
  // The DROP TABLE probe did not land: the table still answers.
  assert.ok((await admin.get("/api/admin/audit?limit=10")).data.total > 0);
});

test("a deactivated account's login attempt is logged as 'disabled'", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const { data: created } = await admin.post("/api/admin/employees", { name: "Off Log", employeeId: "DP-LOG04" });
  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === "DP-LOG04");
  await admin.put(`/api/admin/employees/${u.id}`, { active: false });

  assert.equal((await makeClient(srv.base).login({ employeeId: "DP-LOG04", password: created.password })).status, 401);
  const rows = (await authRows(admin, "auth.login_failed")).filter((x) => x.target === "DP-LOG04");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].after.reason, "disabled");
  assert.equal(rowText(rows[0]).includes(created.password), false);
});

test("logout writes auth.logout, and 'all devices' is a distinct scope", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const { data: created } = await admin.post("/api/admin/employees", { name: "Out Log", employeeId: "DP-LOG05" });

  const c = await loginAs(srv.base, { employeeId: "DP-LOG05", password: created.password });
  assert.equal((await c.post("/api/auth/logout")).status, 200);
  const c2 = await loginAs(srv.base, { employeeId: "DP-LOG05", password: created.password });
  assert.equal((await c2.post("/api/auth/logout", { all: true })).status, 200);

  const rows = (await authRows(admin, "auth.logout")).filter((x) => x.target === "DP-LOG05");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.after.scope).sort(), ["all", "session"]);
  assert.equal(rows[0].actor, "Out Log");
});

test("kicked sessions are logged: deactivation and password reset", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  await admin.post("/api/admin/employees", { name: "Kick A", employeeId: "DP-LOG06" });
  await admin.post("/api/admin/employees", { name: "Kick B", employeeId: "DP-LOG07" });
  const list = await admin.get("/api/admin/employees");
  const a = list.data.find((x) => x.employeeId === "DP-LOG06");
  const b = list.data.find((x) => x.employeeId === "DP-LOG07");

  await admin.put(`/api/admin/employees/${a.id}`, { active: false });
  const reset = await admin.post(`/api/admin/employees/${b.id}/reset`);
  assert.ok(reset.data.password);

  const rows = await authRows(admin, "auth.sessions_revoked");
  const ra = rows.find((x) => x.target === "DP-LOG06");
  const rb = rows.find((x) => x.target === "DP-LOG07");
  assert.equal(ra && ra.after.reason, "deactivated");
  assert.equal(rb && rb.after.reason, "password_reset");
  // The admin who pulled the trigger is the actor, not the person kicked.
  assert.equal(ra.actor, "Administrator");
  // The freshly issued password must not ride along in the trail.
  assert.equal(JSON.stringify(rows).includes(reset.data.password), false);
});

test("admin cannot deactivate or demote themself", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const list = await admin.get("/api/admin/employees");
  const self = list.data.find((x) => x.employeeId === "ADMIN");
  assert.equal((await admin.put(`/api/admin/employees/${self.id}`, { active: false })).status, 400);
  assert.equal((await admin.put(`/api/admin/employees/${self.id}`, { role: "employee" })).status, 400);
});
