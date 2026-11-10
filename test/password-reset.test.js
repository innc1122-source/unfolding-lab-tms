// B1 — self-service password reset (forgot password, mailed token).
//
// What this suite is really guarding, in order of importance:
//   1. ANTI-ENUMERATION. POST /api/auth/forgot must answer the SAME BYTES for an
//      id that exists, one that doesn't, one with no email on file and one that
//      has been deactivated. That is asserted on the raw response body, not on a
//      parsed object, because "same information" here means "same bytes".
//   2. The token is a one-shot, short-lived bearer credential: single use,
//      expires, superseded by a newer request, and never usable for a
//      deactivated account.
//   3. A successful reset is a full credential rotation: new password works, old
//      one doesn't, every existing session of that account is killed, and the
//      temporary-password flag is cleared.
//   4. The token NEVER appears in the database in the clear, and neither the
//      token nor the new password ever appears in the audit log.
//   5. The capability flag: /api/env reports passwordResetEnabled false unless
//      config.json actually has a usable email block — the front end must never
//      offer a flow that ends in a mail nobody can send.
//
// Mail is captured with the LMS_EMAIL_SINK test seam (notify.js): one JSON line
// per message, so nothing leaves the machine and no API key is needed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ADMIN, startServer, makeClient, loginAs, tempDir } = require("./helpers.js");

const tmp = tempDir("lms-pwreset-");
// A config with a COMPLETE email block (provider + apiKey + from) — that triple
// is what emailConfigured() requires, and therefore what switches the whole
// feature on. The key is fake: LMS_EMAIL_SINK intercepts before any network call.
const MAIL_CONFIG = { email: { provider: "resend", apiKey: "re_test_fake_key", from: "TMS <noreply@example.com>" } };
function writeConfig(name, obj) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
const sinkPath = (name) => path.join(tmp, name);

// Every message the sink has captured so far, newest last.
function mails(sink) {
  if (!fs.existsSync(sink)) return [];
  return fs.readFileSync(sink, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
// The reset flow answers before it sends (that is the timing guarantee), so the
// mail lands a tick later — poll for it instead of sleeping a magic number.
async function waitForMail(sink, to, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = mails(sink).filter((m) => m.to === to).pop();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
// For the negative case there is nothing to poll for: give the deferred work a
// generous head start, then assert the sink is still empty for that address.
async function assertNoMail(sink, to, waitMs = 800) {
  await new Promise((r) => setTimeout(r, waitMs));
  const hit = mails(sink).find((m) => m.to === to);
  assert.equal(hit, undefined, `no mail may be sent to ${to} — got: ${JSON.stringify(hit)}`);
}
const tokenOf = (mail) => {
  const m = /token=([A-Za-z0-9_-]+)/.exec(mail.html);
  assert.ok(m, "the mail must carry a reset link with a token");
  return decodeURIComponent(m[1]);
};
const sha256Hex = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

// Creates an employee (optionally with an email) and returns { id, employeeId,
// email, password } — password is the HR-issued temporary one.
let seq = 0;
async function makeEmployee(srv, admin, opts = {}) {
  const employeeId = opts.employeeId || ("PR-" + String(++seq).padStart(3, "0"));
  const email = opts.noEmail ? undefined : `${employeeId.toLowerCase()}@example.com`;
  const r = await admin.post("/api/admin/employees", { name: opts.name || ("Reset " + employeeId), employeeId, email });
  assert.equal(r.status, 200, `create ${employeeId}: ${JSON.stringify(r.data)}`);
  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === employeeId);
  return { id: u.id, employeeId, email, password: r.data.password };
}

// ---- servers -----------------------------------------------------------------
// srv        : email configured + sink → the whole happy path lives here.
// srvNoMail  : LMS_CONFIG_PATH pointing at a file that does NOT exist, so the
//              capability is off no matter what the repo-root config.json holds.
// srvExpired : same as srv but with a 1 ms token TTL (LMS_RESET_TTL_MS seam).
// srvLimit   : own process, because the throttle counters are per-process
//              in-memory and tripping them here would poison the other tests
//              (every test client comes from the same 127.0.0.1).
let srv, srvNoMail, srvExpired, srvLimit;
let sink, sinkNoMail, sinkExpired, sinkLimit;
before(async () => {
  const cfg = writeConfig("config-mail.json", MAIL_CONFIG);
  sink = sinkPath("mail.jsonl");
  sinkNoMail = sinkPath("mail-none.jsonl");
  sinkExpired = sinkPath("mail-expired.jsonl");
  sinkLimit = sinkPath("mail-limit.jsonl");
  [srv, srvNoMail, srvExpired, srvLimit] = await Promise.all([
    startServer({ env: { LMS_CONFIG_PATH: cfg, LMS_EMAIL_SINK: sink } }),
    startServer({ env: { LMS_CONFIG_PATH: path.join(tmp, "config-absent.json"), LMS_EMAIL_SINK: sinkNoMail } }),
    startServer({ env: { LMS_CONFIG_PATH: cfg, LMS_EMAIL_SINK: sinkExpired, LMS_RESET_TTL_MS: "1" } }),
    startServer({ env: { LMS_CONFIG_PATH: cfg, LMS_EMAIL_SINK: sinkLimit } }),
  ]);
});
after(() => { for (const s of [srv, srvNoMail, srvExpired, srvLimit]) if (s) s.stop(); });

// ---- capability flag ---------------------------------------------------------

test("/api/env: passwordResetEnabled is true only when config.json has a usable email block — with no mailer the flag is false, so the UI never offers a link it cannot send", async () => {
  const on = await makeClient(srv.base).get("/api/env");
  assert.equal(on.status, 200);
  assert.equal(on.data.passwordResetEnabled, true, "a complete email block (provider+apiKey+from) must switch the capability on");

  const off = await makeClient(srvNoMail.base).get("/api/env");
  assert.equal(off.status, 200);
  assert.equal(off.data.passwordResetEnabled, false, "no email config = no self-service reset advertised");
  // It is a GLOBAL flag: nothing about it depends on an employee id, so it is
  // not an enumeration surface. The brand block is display copy (the default
  // login tagline mentions "employee" since IA B-G08), so it is left out here.
  const { brand, ...flags } = off.data;
  assert.ok(brand && typeof brand === "object", "brand copy is still advertised");
  assert.equal(JSON.stringify(flags).includes("employee"), false);
});

test("with no mailer configured, /api/auth/forgot still answers the SAME generic 200 (the endpoint exists either way) but mints no token and sends nothing", async () => {
  const admin = await loginAs(srvNoMail.base, ADMIN);
  const emp = await makeEmployee(srvNoMail, admin);

  const r = await makeClient(srvNoMail.base).raw("POST", "/api/auth/forgot", { employeeId: emp.employeeId });
  assert.equal(r.status, 200);
  await assertNoMail(sinkNoMail, emp.email);
  assert.equal(mails(sinkNoMail).length, 0, "an install without a mailer must not queue any reset mail at all");
  // And no token exists to spend: any link is refused with the generic answer.
  const spend = await makeClient(srvNoMail.base).post("/api/auth/reset", { token: "x".repeat(43), newPassword: "brand-new-pass-1" });
  assert.equal(spend.status, 400);
  assert.equal(spend.data.code, "invalid_token");
});

// ---- 1. anti-enumeration -----------------------------------------------------

test("ENUMERATION: /api/auth/forgot answers byte-for-byte identically for an id that exists, one that does not, one with no email, and a deactivated one", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const known = await makeEmployee(srv, admin, { name: "Known Person" });
  const noEmail = await makeEmployee(srv, admin, { noEmail: true });
  const disabled = await makeEmployee(srv, admin, { name: "Gone Person" });
  assert.equal((await admin.put(`/api/admin/employees/${disabled.id}`, { active: false })).status, 200);

  const bodies = [];
  for (const employeeId of [known.employeeId, "PR-NOBODY", noEmail.employeeId, disabled.employeeId]) {
    const res = await makeClient(srv.base).raw("POST", "/api/auth/forgot", { employeeId });
    assert.equal(res.status, 200, `${employeeId} must get 200`);
    bodies.push({ id: employeeId, status: res.status, ctype: res.headers.get("content-type"), buf: Buffer.from(await res.arrayBuffer()) });
  }
  const first = bodies[0];
  for (const b of bodies.slice(1)) {
    assert.equal(b.status, first.status, `${b.id}: status must not differ`);
    assert.equal(b.ctype, first.ctype, `${b.id}: content-type must not differ`);
    assert.equal(b.buf.equals(first.buf), true,
      `${b.id}: response body must be byte-identical to the known-account one — any difference is an account-enumeration oracle.\n` +
      `known: ${first.buf.toString()}\nthis : ${b.buf.toString()}`);
  }
  // The wording itself must not assert that THIS id exists.
  const text = first.buf.toString();
  assert.match(text, /If that employee ID exists/i);
  assert.equal(text.includes(known.employeeId), false, "the reply must not echo the submitted id");

  // Only the real, active, emailed account actually receives anything.
  assert.ok(await waitForMail(sink, known.email), "the known account does get its mail");
  await assertNoMail(sink, noEmail.email);
  await assertNoMail(sink, disabled.email);

  // Same body for a blank / malformed submission — no shape oracle either.
  for (const bad of [undefined, "", "not an id at all!!"]) {
    const res = await makeClient(srv.base).raw("POST", "/api/auth/forgot", { employeeId: bad });
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).equals(first.buf), true, `malformed input ${JSON.stringify(bad)} must get the same bytes`);
  }
});

test("a deactivated account cannot be reset even though its request looks accepted: no token is minted, so nothing can be spent", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const emp = await makeEmployee(srv, admin, { name: "Offboarded" });
  // Get a real, valid token FIRST, then deactivate the account: the token must
  // stop working the moment the account does.
  const before = await makeClient(srv.base).post("/api/auth/forgot", { employeeId: emp.employeeId });
  assert.equal(before.status, 200);
  const token = tokenOf(await waitForMail(sink, emp.email));
  assert.equal((await admin.put(`/api/admin/employees/${emp.id}`, { active: false })).status, 200);

  const spend = await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: "still-not-allowed-1" });
  assert.equal(spend.status, 400, "a live token for a since-deactivated account must be refused");
  assert.equal(spend.data.code, "invalid_token");
});

// ---- 2/3. the happy path and the credential rotation -------------------------

test("full flow: the mail carries a bilingual one-shot link, the reset sets the new password, clears the temporary-password flag, kills every old session, and the old password dies", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const emp = await makeEmployee(srv, admin, { name: "Rotate Me" });
  // Two live sessions on this account (a desktop and a phone), both must die.
  const live1 = await loginAs(srv.base, { employeeId: emp.employeeId, password: emp.password });
  const live2 = await loginAs(srv.base, { employeeId: emp.employeeId, password: emp.password });
  assert.equal((await live1.get("/api/me")).status, 200);
  assert.equal((await live1.get("/api/me")).data.mustChangePassword, true, "HR-issued password starts flagged");

  assert.equal((await makeClient(srv.base).post("/api/auth/forgot", { employeeId: emp.employeeId })).status, 200);
  const mail = await waitForMail(sink, emp.email);
  assert.ok(mail, "a reset mail must reach the address on file");

  // ONE mail, both languages (the server has no idea which one the reader uses).
  assert.match(mail.subject + mail.html, /[一-鿿]/, "the mail must contain Chinese");
  assert.match(mail.html, /reset|password/i, "…and English");
  assert.match(mail.html, /30 (分钟|minutes)|30 minutes/, "the mail must state how long the link lives");
  assert.match(mail.html, /#\/reset-password\?token=/, "the link must point at the front-end reset route");
  // A mail is not a credential store: the password never travels by mail.
  assert.equal(mail.html.includes(emp.password), false, "the mail must never contain a password");

  const token = tokenOf(mail);
  const NEWPW = "rotated-pass-9";
  const done = await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: NEWPW });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.ok, true);

  // Sessions: both pre-reset sessions are gone.
  assert.equal((await live1.get("/api/me")).status, 401, "the desktop session must be revoked by the reset");
  assert.equal((await live2.get("/api/me")).status, 401, "…and the phone one too");
  // Passwords: old dead, new alive, and no forced change on the way in.
  assert.equal((await makeClient(srv.base).login({ employeeId: emp.employeeId, password: emp.password })).status, 401, "the old password must stop working");
  const fresh = await loginAs(srv.base, { employeeId: emp.employeeId, password: NEWPW });
  const me = await fresh.get("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.mustChangePassword, false, "a password the user chose themselves must not re-trigger the forced change");

  // 4. The plaintext token is nowhere in the database — only its sha256 is.
  const dbFiles = [srv.dbPath, srv.dbPath + "-wal", srv.dbPath + "-shm"].filter((p) => fs.existsSync(p));
  let hashSeen = false;
  for (const p of dbFiles) {
    const raw = fs.readFileSync(p);
    assert.equal(raw.includes(Buffer.from(token)), false, `the plaintext reset token must not appear in ${path.basename(p)}`);
    assert.equal(raw.includes(Buffer.from(NEWPW)), false, `the plaintext password must not appear in ${path.basename(p)}`);
    if (raw.includes(Buffer.from(sha256Hex(token)))) hashSeen = true;
  }
  assert.equal(hashSeen, true, "the sha256 of the token IS what gets stored (proof the row exists at all)");

  // Single use: the same link cannot be spent twice.
  const replay = await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: "another-pass-77" });
  assert.equal(replay.status, 400, "a spent token must be refused");
  assert.equal(replay.data.code, "invalid_token");
  assert.equal((await makeClient(srv.base).login({ employeeId: emp.employeeId, password: "another-pass-77" })).status, 401, "…and the refused attempt must not have changed anything");
});

test("requesting again voids the previous link: only the newest token works", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const emp = await makeEmployee(srv, admin, { name: "Twice Asked" });

  assert.equal((await makeClient(srv.base).post("/api/auth/forgot", { employeeId: emp.employeeId })).status, 200);
  const first = tokenOf(await waitForMail(sink, emp.email));
  assert.equal((await makeClient(srv.base).post("/api/auth/forgot", { employeeId: emp.employeeId })).status, 200);
  // Wait for a SECOND, different mail before judging.
  let second = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const all = mails(sink).filter((m) => m.to === emp.email);
    if (all.length >= 2) { second = tokenOf(all[all.length - 1]); break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(second && second !== first, "the second request must mail a different token");

  const stale = await makeClient(srv.base).post("/api/auth/reset", { token: first, newPassword: "stale-link-pass-1" });
  assert.equal(stale.status, 400, "the superseded link must be dead (no pile-up of live tokens)");
  assert.equal((await makeClient(srv.base).post("/api/auth/reset", { token: second, newPassword: "newest-link-pass-1" })).status, 200);
});

test("an expired token is refused with the same generic answer (1 ms TTL instance)", async () => {
  const admin = await loginAs(srvExpired.base, ADMIN);
  const emp = await makeEmployee(srvExpired, admin, { name: "Too Slow" });
  assert.equal((await makeClient(srvExpired.base).post("/api/auth/forgot", { employeeId: emp.employeeId })).status, 200);
  const token = tokenOf(await waitForMail(sinkExpired, emp.email));

  const r = await makeClient(srvExpired.base).post("/api/auth/reset", { token, newPassword: "far-too-late-1" });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "invalid_token");
  assert.equal(r.data.error, "This reset link is invalid or has expired.",
    "expired / used / unknown must all produce the SAME message — the caller may not learn which");
  assert.equal((await makeClient(srvExpired.base).login({ employeeId: emp.employeeId, password: "far-too-late-1" })).status, 401);
});

test("password rules on reset: under 8 characters and 'password = my employee ID' are both refused, and a refused attempt does NOT burn the token", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  // An employee ID of 8+ characters, so that the "password = my employee ID"
  // rule is reachable at all: a shorter ID trips the 8-character floor first
  // (which is fine — it is refused either way, just with the other code).
  const emp = await makeEmployee(srv, admin, { name: "Weak Chooser", employeeId: "PR-WEAKID01" });
  assert.equal((await makeClient(srv.base).post("/api/auth/forgot", { employeeId: emp.employeeId })).status, 200);
  const token = tokenOf(await waitForMail(sink, emp.email));

  const short = await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: "short7!" });
  assert.equal(short.status, 400);
  assert.equal(short.data.code, "too_short");
  const asId = await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: emp.employeeId.toLowerCase() + "" });
  assert.equal(asId.status, 400);
  // 新规则（D-25 ①，R-371）：工号单独一个 code；缺字母或数字为 too_weak；与原密码相同为 same_as_current
  assert.equal(asId.data.code, "same_as_employee_id", "the employee ID is the one string the link-holder already knows");
  for (const [np, code] of [["lettersonlyxx", "too_weak"], ["1234567890", "too_weak"], [emp.password, "same_as_current"]]) {
    const r = await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: np });
    assert.equal(r.status, 400, np);
    assert.equal(r.data.code, code, np);
  }

  // Still spendable: a rejected password is a client mistake, not a used link.
  assert.equal((await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: "good-enough-pass-2" })).status, 200);
});

test("a missing / malformed / over-long token gets the one generic failure, never a hint", async () => {
  const c = makeClient(srv.base);
  for (const token of [undefined, "", "nope", "z".repeat(500)]) {
    const r = await c.post("/api/auth/reset", { token, newPassword: "whatever-pass-1" });
    assert.equal(r.status, 400, `token ${JSON.stringify(token && token.slice(0, 8))}`);
    assert.equal(r.data.code, "invalid_token");
    assert.equal(r.data.error, "This reset link is invalid or has expired.");
  }
});

// ---- throttling --------------------------------------------------------------

test("throttling: the 6th request for one employee ID is refused, and the per-IP counter refuses a scan across many different IDs", async () => {
  const admin = await loginAs(srvLimit.base, ADMIN);
  const emp = await makeEmployee(srvLimit, admin, { name: "Hammered" });

  // Per-employeeId: FORGOT_MAX_PER_ID = 5.
  for (let i = 0; i < 5; i++)
    assert.equal((await makeClient(srvLimit.base).post("/api/auth/forgot", { employeeId: emp.employeeId })).status, 200, `request ${i + 1} still allowed`);
  const overId = await makeClient(srvLimit.base).post("/api/auth/forgot", { employeeId: emp.employeeId });
  assert.equal(overId.status, 429, "one mailbox must not be floodable");
  assert.equal(overId.data.code, "rate_limited");
  assert.ok(overId.data.minutes > 0, "the refusal tells the UI how long to wait");
  // The refusal says nothing about the account itself.
  assert.equal(JSON.stringify(overId.data).includes(emp.employeeId), false);

  // Per-IP: FORGOT_MAX_PER_IP = 20 across ALL ids from this client. The 6 calls
  // above already count, so keep walking fresh ids until the IP counter trips.
  let ipRefused = false;
  for (let i = 0; i < 40 && !ipRefused; i++) {
    const r = await makeClient(srvLimit.base).post("/api/auth/forgot", { employeeId: "PR-SCAN" + i });
    if (r.status === 429) { ipRefused = true; assert.equal(r.data.code, "rate_limited"); }
  }
  assert.equal(ipRefused, true, "a roster scan from one client must hit the per-IP limit");
});

// ---- audit -------------------------------------------------------------------

test("audit: auth.password_reset_requested and auth.password_reset are logged against the right account, and NO row anywhere carries the token or the new password", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const emp = await makeEmployee(srv, admin, { name: "Audited Reset" });
  assert.equal((await makeClient(srv.base).post("/api/auth/forgot", { employeeId: emp.employeeId })).status, 200);
  const mail = await waitForMail(sink, emp.email);
  const token = tokenOf(mail);
  const NEWPW = "audited-pass-31";
  assert.equal((await makeClient(srv.base).post("/api/auth/reset", { token, newPassword: NEWPW })).status, 200);

  // The request row is written by the deferred task — poll for it.
  let rows = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await admin.get("/api/admin/audit?limit=5000");
    assert.equal(r.status, 200);
    rows = r.data.rows || [];
    if (rows.some((x) => x.action === "auth.password_reset_requested" && x.target === emp.employeeId)) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const req = rows.find((x) => x.action === "auth.password_reset_requested" && x.target === emp.employeeId);
  assert.ok(req, "a request that actually mailed a link must be auditable");
  assert.equal(req.actor, "Audited Reset", "actor is the account the link was sent for, so the log can be filtered by victim");
  assert.equal(req.after.method, "email");
  assert.equal(req.after.ttlMinutes, 30);

  const done = rows.find((x) => x.action === "auth.password_reset" && x.target === emp.employeeId);
  assert.ok(done, "the completed reset must be auditable");
  assert.equal(done.actor, "Audited Reset");
  assert.equal(done.after.method, "email_token");

  // The load-bearing negative: scan EVERY row, not just these two.
  const all = JSON.stringify(rows);
  assert.equal(all.includes(token), false, "no audit row may contain the reset token");
  assert.equal(all.includes(token.slice(0, 12)), false, "not even a fragment of it");
  assert.equal(all.includes(NEWPW), false, "no audit row may contain the new password");
  assert.equal(all.includes(sha256Hex(token)), false, "not even the token hash belongs in the log");
});

test("an employee cannot read the reset trail: the audit log stays admin-only", async () => {
  const admin = await loginAs(srv.base, ADMIN);
  const emp = await makeEmployee(srv, admin, { name: "Curious" });
  const c = await loginAs(srv.base, { employeeId: emp.employeeId, password: emp.password });
  // mustChangePassword blocks everything but /api/me — which is itself the point:
  // there is no path from a fresh account to the access log.
  const r = await c.get("/api/admin/audit");
  assert.ok(r.status === 403 || r.status === 401, `employee must not read the audit log (got ${r.status})`);
});
