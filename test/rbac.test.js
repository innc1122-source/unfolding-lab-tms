// RBAC P1 (角色与授权) contract tests. Boots the real server on a throwaway DB
// (via helpers.startServer) and exercises the whole authorization surface:
// migration v44 built-in roles, the privilege-escalation field guards, the
// per-domain route gate, roster W1, read-level no-method endpoints, the roles
// CRUD locks, the /api/me grants block, dashboard W4 field trimming, and the
// LMS_BULK_CAP explicit refusal.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, DEMO_ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin;
// role key -> id, filled from GET /api/admin/roles once the server is up.
const roleId = {};

// Create an employee, assign it an admin role (super-admin only), log in as it
// and clear the forced-password-change flag so it can reach admin endpoints.
async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  if (adminRoleId != null) {
    const r = await admin.put("/api/admin/employees/" + u.id, { adminRoleId });
    assert.equal(r.status, 200, "assign role to " + empId);
  }
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  const cp = await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" });
  assert.equal(cp.status, 200, "clear mustChangePassword for " + empId);
  return { client: c, id: u.id };
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const r = await admin.get("/api/admin/roles");
  assert.equal(r.status, 200, "super-admin can list roles");
  for (const role of r.data.roles) if (role.key) roleId[role.key] = role.id;
  // 2026-10-06 内置角色收敛后，audit=read 的「审计员」与 people=manage 的「HRBP」不再内置（迁移 64）。
  // 下面的用例要的只是「这样一组授权的角色」，所以按原授权建成自定义角色，键名沿用。
  for (const [k, body] of [["auditor", { name: "Test Auditor", name_zh: "测试审计员", grants: { audit: "read" } }], ["hrbp", { name: "Test HRBP", name_zh: "测试 HRBP", grants: { people: "manage", culture: "read" } }]]) {
    const c = await admin.post("/api/admin/roles", body);
    assert.equal(c.status, 200, "create custom role " + k);
    roleId[k] = c.data.role.id;
  }
});
after(() => srv.stop());

test("migrations v44 + v64 leave 4 built-in roles and map existing admins to super-admin", async () => {
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    // schema_migrations reached v44.
    const versions = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(versions.includes(44), "migration 44 applied");
    assert.ok(versions.includes(64), "migration 64 (role consolidation, 2026-10-06) applied");
    // The four built-in roles exist, keyed by slug, all builtin=1.
    const rows = db.prepare("SELECT key, grants, builtin FROM roles WHERE builtin = 1 ORDER BY id").all();
    const keys = rows.map((r) => r.key).sort();
    assert.deepEqual(keys, ["admin", "learning-admin", "performance-talent-admin", "super-admin"]);
    // super-admin holds all 8 domains at manage, incl. accounts.
    const sa = rows.find((r) => r.key === "super-admin");
    const saGrants = JSON.parse(sa.grants);
    for (const d of ["people", "learning", "performance", "talent", "fields", "brand", "audit", "accounts"])
      assert.equal(saGrants[d], "manage", "super-admin " + d + "=manage");
    // admin: every domain manage except roles (super-admin only).
    const adm = JSON.parse(rows.find((r) => r.key === "admin").grants);
    for (const d of ["people", "learning", "performance", "talent", "fields", "brand", "audit", "accounts"]) assert.equal(adm[d], "manage", "admin " + d + "=manage");
    assert.equal(adm.roles, "none", "admin never holds the roles domain");
    // performance-talent-admin: performance + talent manage, people read (2026-10-07 owner decision, batch 2 item 2.3:
    // read-only employee profiles; existing databases get it from data migration 68), nothing else.
    const pt = JSON.parse(rows.find((r) => r.key === "performance-talent-admin").grants);
    assert.deepEqual([pt.performance, pt.talent, pt.learning, pt.people], ["manage", "manage", "none", "read"]);
    for (const d of ["fields", "brand", "audit", "accounts", "roles"]) assert.equal(pt[d], "none", "performance-talent-admin " + d + "=none");
    assert.ok(versions.includes(68), "migration 68 (perf-talent-people-read) applied");
    // Every seeded admin (ADMIN + DEMO-ADMIN) was mapped to the super-admin role.
    const said = db.prepare("SELECT id FROM roles WHERE key = 'super-admin'").get().id;
    const admins = db.prepare("SELECT employeeId, adminRoleId FROM users WHERE role = 'admin'").all();
    assert.ok(admins.length >= 2, "seeded admins present");
    for (const a of admins) assert.equal(a.adminRoleId, said, a.employeeId + " -> super-admin");
  } finally {
    db.close();
  }
});

test("/api/me exposes grants + isSuperAdmin for super and non-super", async () => {
  const me = await admin.get("/api/me");
  assert.equal(me.data.isSuperAdmin, true, "ADMIN is super");
  for (const d of ["people", "learning", "performance", "talent", "fields", "brand", "audit", "accounts"])
    assert.equal(me.data.grants[d], "manage", "super grants " + d);

  const la = await makeAdminUser("RBAC-ME-LA", roleId["learning-admin"]);
  const meLa = await la.client.get("/api/me");
  assert.equal(meLa.data.isSuperAdmin, false, "learning-admin not super");
  assert.equal(meLa.data.grants.learning, "manage");
  assert.equal(meLa.data.grants.people, "none");
  assert.equal(meLa.data.grants.accounts, "none", "accounts never granted");
  assert.equal(meLa.data.adminRoleId, roleId["learning-admin"]);
  assert.equal(meLa.data.adminRoleName, "Learning Admin");
  assert.equal(meLa.data.adminRoleName_zh, "培训管理员");
});

test("privilege escalation: non-super carrying role/adminRoleId/active is 403", async () => {
  const hr = await makeAdminUser("RBAC-ESC-HR", roleId["hrbp"]);
  // A concrete target to point the writes at.
  const list = await admin.get("/api/admin/employees");
  const victim = list.data.find((x) => x.employeeId === "RBAC-ME-LA");
  assert.ok(victim, "victim exists");

  // PUT /employees/:id — each account-domain field is an outright 403 (not a
  // silent strip) for a non-super, even one with people=manage (HRBP).
  for (const body of [{ role: "admin" }, { adminRoleId: roleId["hrbp"] }, { active: false }]) {
    const r = await hr.client.put("/api/admin/employees/" + victim.id, body);
    assert.equal(r.status, 403, "PUT employees with " + Object.keys(body)[0] + " must 403");
  }
  // potential/talentTags are the talent domain — HRBP has talent=none.
  assert.equal((await hr.client.put("/api/admin/employees/" + victim.id, { potential: "High" })).status, 403, "potential needs talent=manage");
  assert.equal((await hr.client.put("/api/admin/employees/" + victim.id, { talentTags: ["hipo"] })).status, 403, "talentTags needs talent=manage");

  // bulk-update — same field guards.
  for (const fields of [{ role: "admin" }, { adminRoleId: roleId["hrbp"] }, { active: false }]) {
    const r = await hr.client.post("/api/admin/employees/bulk-update", { userIds: [victim.id], fields });
    assert.equal(r.status, 403, "bulk-update with " + Object.keys(fields)[0] + " must 403");
  }
  assert.equal((await hr.client.post("/api/admin/employees/bulk-update", { userIds: [victim.id], fields: { potential: "High" } })).status, 403, "bulk potential needs talent=manage");
  // people-domain fields ARE allowed for HRBP (people=manage) — proves the guard
  // is field-scoped, not a blanket block.
  assert.equal((await hr.client.post("/api/admin/employees/bulk-update", { userIds: [victim.id], fields: { department: "QA" } })).status, 200, "HRBP may set department");
});

test("domain gate: learning-admin writes learning, is walled off people/accounts", async () => {
  const la = await makeAdminUser("RBAC-GATE-LA", roleId["learning-admin"]);
  // read learning
  const content = await la.client.get("/api/admin/content");
  assert.equal(content.status, 200, "learning read allowed");
  // write learning (manage) — PUT a seeded program back unchanged.
  const prog = content.data.programs.find((p) => p.id === "nho");
  assert.ok(prog, "nho program present");
  assert.equal((await la.client.put("/api/admin/content/programs/nho", prog)).status, 200, "learning write allowed");
  // people domain = none -> 404 (indistinguishable from unknown route), read and write alike
  assert.equal((await la.client.get("/api/admin/departments")).status, 404, "people read -> 404 for none");
  assert.equal((await la.client.post("/api/admin/departments", { name: "X" })).status, 404, "people write -> 404 for none");
  // roles domain (D6) -> super-admin only -> 403
  assert.equal((await la.client.get("/api/admin/roles")).status, 403, "roles -> 403");
  assert.equal((await la.client.post("/api/admin/roles", { name: "Nope" })).status, 403, "roles write -> 403");
});

test("domain gate: auditor reads audit only", async () => {
  const au = await makeAdminUser("RBAC-AUD", roleId["auditor"]);
  assert.equal((await au.client.get("/api/admin/audit")).status, 200, "audit read allowed");
  assert.equal((await au.client.get("/api/admin/programs")).status, 404, "learning none -> 404");
  assert.equal((await au.client.get("/api/admin/roster")).status, 403, "roster needs a people/learning/perf/talent read");
});

test("roster W1: learning-admin can read the roster", async () => {
  const la = await makeAdminUser("RBAC-ROSTER-LA", roleId["learning-admin"]);
  const r = await la.client.get("/api/admin/roster");
  assert.equal(r.status, 200, "learning>=read is enough for roster");
  assert.ok(Array.isArray(r.data));
});

test("read level: no-method endpoints and talent-search POST are not write-blocked", async () => {
  // Custom read-only roles.
  const learnReadId = (await admin.post("/api/admin/roles", { name: "Learning Reader", name_zh: "培训只读", grants: { learning: "read" } })).data.role.id;
  const talentReadId = (await admin.post("/api/admin/roles", { name: "Talent Reader", name_zh: "人才只读", grants: { talent: "read" } })).data.role.id;

  const lr = await makeAdminUser("RBAC-LR", learnReadId);
  // /api/admin/attempts and the CSV exports are reads regardless of method (W3).
  assert.equal((await lr.client.get("/api/admin/attempts")).status, 200, "attempts readable at read level");
  const csv = await lr.client.raw("GET", "/api/admin/export/completion.csv");
  assert.equal(csv.status, 200, "completion.csv readable at read level");
  // But an actual learning WRITE at read level is 403.
  const content = await lr.client.get("/api/admin/content");
  assert.equal(content.status, 200, "content readable");
  const prog = content.data.programs.find((p) => p.id === "nho");
  assert.equal((await lr.client.put("/api/admin/content/programs/nho", prog)).status, 403, "learning write blocked at read level");

  // talent-search is a POST but classified read — a talent=read role may run it.
  const tr = await makeAdminUser("RBAC-TR", talentReadId);
  const ts = await tr.client.post("/api/admin/talent-search", { type: "performance" });
  assert.equal(ts.status, 200, "talent-search POST allowed at talent=read");
});

test("roles CRUD: create, update, delete; built-in and in-use locks", async () => {
  // create
  const created = await admin.post("/api/admin/roles", { name: "Temp Role", name_zh: "临时角色", grants: { learning: "manage" } });
  assert.equal(created.status, 200);
  const id = created.data.role.id;
  assert.equal(created.data.role.grants.learning, "manage");
  assert.equal(created.data.role.grants.roles, "none", "roles forced none (D6 lock)");

  // D6: reject roles=manage on create and update (roles is the ungrantable domain now).
  assert.equal((await admin.post("/api/admin/roles", { name: "Bad", grants: { roles: "manage" } })).status, 400, "create roles=manage rejected");
  assert.equal((await admin.put("/api/admin/roles/" + id, { grants: { roles: "manage" } })).status, 400, "update roles=manage rejected");

  // D6: accounts IS now grantable — a role may carry accounts=manage, and roles
  // stays forced none regardless.
  const acct = await admin.post("/api/admin/roles", { name: "Acct Role", grants: { accounts: "manage" } });
  assert.equal(acct.status, 200, "accounts=manage accepted (D6 grantable)");
  assert.equal(acct.data.role.grants.accounts, "manage", "accounts granted");
  assert.equal(acct.data.role.grants.roles, "none", "roles never granted");
  await admin.del("/api/admin/roles/" + acct.data.role.id);

  // update
  const upd = await admin.put("/api/admin/roles/" + id, { name: "Temp Role 2", grants: { learning: "read", performance: "manage" } });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.role.name, "Temp Role 2");
  assert.equal(upd.data.role.grants.performance, "manage");

  // built-in super-admin is locked (edit + delete)
  assert.equal((await admin.put("/api/admin/roles/" + roleId["super-admin"], { name: "Hacked" })).status, 400, "edit super-admin blocked");
  assert.equal((await admin.del("/api/admin/roles/" + roleId["super-admin"])).status, 400, "delete super-admin blocked");

  // in-use delete blocked
  const holder = await makeAdminUser("RBAC-HOLD", id);
  const delInUse = await admin.del("/api/admin/roles/" + id);
  assert.equal(delInUse.status, 400, "delete blocked while a member holds the role");
  assert.equal(delInUse.data.code, "in_use");
  // reassign the holder off, then delete succeeds
  assert.equal((await admin.put("/api/admin/employees/" + holder.id, { adminRoleId: null })).status, 200, "unassign holder");
  assert.equal((await admin.del("/api/admin/roles/" + id)).status, 200, "delete after reassign");
});

test("last active super-admin can never be zeroed out", async () => {
  const list = await admin.get("/api/admin/employees");
  const adminU = list.data.find((x) => x.employeeId === "ADMIN");
  const demoU = list.data.find((x) => x.employeeId === "DEMO-ADMIN");
  assert.ok(adminU && demoU, "both seeded supers present");
  // Demote DEMO-ADMIN (2 supers -> 1) — allowed.
  assert.equal((await admin.put("/api/admin/employees/" + demoU.id, { adminRoleId: roleId["auditor"] })).status, 200, "demote one of two supers");
  // Now ADMIN is the last active super — demoting it is refused.
  const lastTry = await admin.put("/api/admin/employees/" + adminU.id, { adminRoleId: roleId["auditor"] });
  assert.equal(lastTry.status, 400, "last super refused");
  // Restore DEMO-ADMIN to super so the suite leaves state sane.
  assert.equal((await admin.put("/api/admin/employees/" + demoU.id, { adminRoleId: roleId["super-admin"] })).status, 200, "restore demo super");
  // ADMIN is still super.
  assert.equal((await admin.get("/api/me")).data.isSuperAdmin, true, "ADMIN still super");
});

// C2 regression. The last-active-super guard runs when a PUT changes adminRoleId,
// and it compares "was a super" with "will be a super". `willBeSuper` has to be
// read off THIS REQUEST'S end state, because one PUT can carry role and
// adminRoleId together. Reading the STORED role made "promote to role=admin AND
// clear adminRoleId" look like a demotion to nobody and answered a bogus 400,
// even though the person stays a super through the legacy (role='admin' with
// adminRoleId IS NULL) fallback that countActiveSuperAdmins also counts.
// Both halves are pinned here: the bogus refusal must be gone AND the real
// refusal must remain, so the fix can never be widened into a lock-out hole.
test("C2: the last-super guard reads the PUT's final role, not the stored one", async () => {
  // A super whose STORED role is 'employee' (super only via adminRoleId) — the
  // exact shape the old code got wrong; ADMIN/DEMO-ADMIN are role='admin' and
  // would have masked the bug.
  const c2 = await makeAdminUser("RBAC-C2", roleId["super-admin"]);
  assert.equal((await c2.client.get("/api/me")).data.isSuperAdmin, true, "super via adminRoleId");
  // Read the roster while ADMIN still holds a domain that can read it.
  const list = await admin.get("/api/admin/employees");
  const adminU = list.data.find((x) => x.employeeId === "ADMIN");
  const demoU = list.data.find((x) => x.employeeId === "DEMO-ADMIN");
  assert.ok(adminU && demoU, "both seeded supers present");
  const put = (client, id, body) => client.put("/api/admin/employees/" + id, body);
  try {
    // Leave RBAC-C2 as the ONLY active super, so the guard is actually armed.
    assert.equal((await put(admin, demoU.id, { adminRoleId: roleId["auditor"] })).status, 200, "demote DEMO-ADMIN");
    assert.equal((await put(admin, adminU.id, { adminRoleId: roleId["auditor"] })).status, 200, "demote ADMIN (RBAC-C2 is still super, so this is allowed)");
    assert.equal((await admin.get("/api/me")).data.isSuperAdmin, false, "ADMIN is no longer a super");

    // Negative half — must NOT regress: clearing the last super's role with no
    // role in the body leaves nobody super, so it stays refused.
    const bare = await put(c2.client, c2.id, { adminRoleId: null });
    assert.equal(bare.status, 400, "clearing the last super's admin role alone is still refused");
    assert.match(bare.data.error, /last active super-admin/, "and refused BY the last-super guard, not something else");
    assert.equal((await c2.client.get("/api/me")).data.adminRoleId, roleId["super-admin"], "nothing was written");

    // Positive half — the bug: the same clear, but this request also promotes
    // them to role='admin', which keeps them a super via the legacy fallback.
    const combo = await put(c2.client, c2.id, { role: "admin", adminRoleId: null });
    assert.equal(combo.status, 200, "role=admin + adminRoleId=null in ONE PUT is allowed (was a bogus 400)");
    assert.equal(combo.data.user.role, "admin");
    assert.equal(combo.data.user.adminRoleId, null, "admin role cleared");
    const meAfter = await c2.client.get("/api/me");
    assert.equal(meAfter.data.isSuperAdmin, true, "still a super — through the legacy fallback");
    assert.equal(meAfter.data.adminRoleId, null);
  } finally {
    // Best-effort restore, no asserts: this test is the only one that has to
    // strip both seeded supers, so a failure above must not cascade into every
    // later test in the file (the assertion that matters is the one above).
    // RBAC-C2 is still a super on every path through the try, so it is the one
    // that can hand ADMIN its role back; parking RBAC-C2 itself has to be done
    // by somebody else (a super may not remove its own admin access).
    await put(c2.client, adminU.id, { adminRoleId: roleId["super-admin"] });
    await put(c2.client, demoU.id, { adminRoleId: roleId["super-admin"] });
    await put(admin, c2.id, { role: "employee", adminRoleId: null });
  }
  assert.equal((await admin.get("/api/me")).data.isSuperAdmin, true, "ADMIN is a super again");
  assert.equal((await c2.client.get("/api/me")).data.isSuperAdmin, false, "RBAC-C2 parked as a plain employee");
});

test("dashboard W4: non-super gets domain fields trimmed by grants", async () => {
  const full = await admin.get("/api/admin/dashboard");
  assert.equal(full.status, 200);
  for (const k of ["headcount", "training", "cycles", "promotionPool"])
    assert.ok(k in full.data, "super dashboard has " + k);

  const la = await makeAdminUser("RBAC-DASH-LA", roleId["learning-admin"]);
  const trimmed = await la.client.get("/api/admin/dashboard");
  assert.equal(trimmed.status, 200, "shell dashboard allowed for any admin role");
  assert.ok("training" in trimmed.data, "learning kept for learning-admin");
  assert.ok(!("headcount" in trimmed.data), "people fields dropped");
  assert.ok(!("cycles" in trimmed.data), "performance fields dropped");
  assert.ok(!("promotionPool" in trimmed.data), "talent fields dropped");
});

test("LMS_BULK_CAP: over-cap bulk-update is refused, not silently truncated", async () => {
  const capped = await startServer({ env: { LMS_BULK_CAP: "2" } });
  try {
    const a2 = await loginAs(capped.base, ADMIN);
    const r = await a2.post("/api/admin/employees/bulk-update", { userIds: ["a", "b", "c"], fields: { department: "X" } });
    assert.equal(r.status, 400, "over-cap rejected");
    assert.equal(r.data.code, "over_cap");
    assert.equal(r.data.cap, 2);
    assert.equal(r.data.selected, 3);
  } finally {
    capped.stop();
  }
});

test("D6 domains sealed for a no-grant role: accounts endpoints 404, roles endpoints 403", async () => {
  // A learning-admin holds neither accounts nor roles. After D6 the two domains
  // answer differently, and both must stay shut for this role:
  //  - accounts (建号/重置) is a grantable domain the learning-admin lacks →
  //    the gate's none-branch → 404 (indistinguishable from an unknown route);
  //  - roles (角色 CRUD) is super-admin-only → the gate's roles-branch → 403.
  // This pins the whole surface, not just the POST /roles spot-check.
  const la = await makeAdminUser("RBAC-ACCT-LA", roleId["learning-admin"]);
  const victim = (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === "ADMIN");
  assert.ok(victim, "victim present");
  // accounts domain (learning-admin has none) → 404, AND nothing created.
  assert.equal((await la.client.post("/api/admin/employees", { name: "z", employeeId: "RBAC-LEAK" })).status, 404, "create account 404 (accounts=none)");
  assert.ok(!(await admin.get("/api/admin/employees")).data.some((x) => x.employeeId === "RBAC-LEAK"), "no account leaked through");
  assert.equal((await la.client.post("/api/admin/employees/bulk", { rows: [{ name: "z", employeeId: "RBAC-LEAK-2" }] })).status, 404, "bulk create 404");
  assert.equal((await la.client.post("/api/admin/employees/" + victim.id + "/reset")).status, 404, "single reset 404");
  assert.equal((await la.client.post("/api/admin/employees/bulk-reset", { userIds: [victim.id] })).status, 404, "bulk reset 404");
  // roles domain — super-admin only → 403 on every verb.
  assert.equal((await la.client.get("/api/admin/roles")).status, 403, "GET roles 403");
  assert.equal((await la.client.post("/api/admin/roles", { name: "Nope" })).status, 403, "POST roles 403");
  assert.equal((await la.client.put("/api/admin/roles/" + roleId["auditor"], { name: "x" })).status, 403, "PUT roles 403");
  assert.equal((await la.client.del("/api/admin/roles/" + roleId["auditor"])).status, 403, "DELETE roles 403");
});

test("escalation to the super-admin role specifically is refused (field guard, people=manage)", async () => {
  // HRBP holds people=manage, so PUT /employees/:id passes the domain gate and
  // the field-level guard is the only thing standing between them and super.
  const hr = await makeAdminUser("RBAC-ESC2-HR", roleId["hrbp"]);
  const r1 = await hr.client.put("/api/admin/employees/" + hr.id, { adminRoleId: roleId["super-admin"] });
  assert.equal(r1.status, 403, "self-assign super-admin role 403");
  const r2 = await hr.client.post("/api/admin/employees/bulk-update", { userIds: [hr.id], fields: { adminRoleId: roleId["super-admin"] } });
  assert.equal(r2.status, 403, "bulk self-assign super-admin role 403");
  const me = await hr.client.get("/api/me");
  assert.equal(me.data.isSuperAdmin, false, "attacker never became super");
  assert.equal(me.data.adminRoleId, roleId["hrbp"], "adminRoleId unchanged");
});

// ---------- the non-super-admin persona gaps (G1-G5) ----------
// P1 built the gate; what stayed broken were the leftover legacy `role ===
// "admin"` checks, which left the six built-in roles half-crippled: a
// learning-admin never received the notices that role exists to handle, could
// not open the course they were building, and had no member list to appear in.
// Every case below also asserts the PLAIN-EMPLOYEE side, which is the real
// regression risk: canRead(user, "learning") must be exactly as tight for
// someone holding no admin role as the old `role !== "admin"` check was.

// A published elective program and a draft program, written straight into the
// content table (the server picks them up through PRAGMA data_version, no
// restart -- see data-consistency.test.js). Fresh ids nobody is assigned to, so
// "may this admin preview it?" is never confused with "is it assigned?", and no
// seeded program changes meaning for the tests above.
const PROBE = {
  pubCourse: "rbac-g-course", pubProg: "rbac-g-prog",
  draftCourse: "rbac-d-course", draftProg: "rbac-d-prog",
};
function seedProbeContent() {
  const now = new Date().toISOString();
  const course = (id, title, title_zh) => ({
    id, title, title_zh,
    modules: [{ id: "m1", title: "Probe Module", title_zh: "探针模块", minutes: 5, sections: [] }],
  });
  const db = new DatabaseSync(srv.dbPath);
  try {
    const ins = db.prepare("INSERT INTO content (kind, id, json, updatedAt) VALUES (?, ?, ?, ?)");
    ins.run("course", PROBE.pubCourse, JSON.stringify(course(PROBE.pubCourse, "RBAC Probe Course", "RBAC 探针课程")), now);
    ins.run("course", PROBE.draftCourse, JSON.stringify(course(PROBE.draftCourse, "RBAC Draft Course", "RBAC 草稿课程")), now);
    ins.run("program", PROBE.pubProg, JSON.stringify({
      id: PROBE.pubProg, title: "RBAC Probe Program", title_zh: "RBAC 探针项目",
      status: "published", enrollType: "elective", passingScore: 80, courseIds: [PROBE.pubCourse],
    }), now);
    ins.run("program", PROBE.draftProg, JSON.stringify({
      id: PROBE.draftProg, title: "RBAC Draft Program", title_zh: "RBAC 草稿项目",
      status: "draft", passingScore: 80, courseIds: [PROBE.draftCourse],
    }), now);
  } finally {
    db.close();
  }
}

// The four personas every G-case needs, built once and shared: a learning-admin
// (learning=manage), a performance-admin (learning=none, proves the domain
// filter is a filter), the read-only auditor (audit=read only), and a plain
// employee carrying NO admin role at all.
let personas = null;
async function probePersonas() {
  if (personas) return personas;
  seedProbeContent();
  personas = {
    la: await makeAdminUser("RBAC-G-LA", roleId["learning-admin"]),
    pa: await makeAdminUser("RBAC-G-PA", roleId["performance-talent-admin"]),
    au: await makeAdminUser("RBAC-G-AUD", roleId["auditor"]),
    emp: await makeAdminUser("RBAC-G-EMP", null),
  };
  return personas;
}

// Does this client hold an in-app notification of the given type?
async function hasNotice(client, type) {
  const r = await client.get("/api/me/notifications");
  assert.equal(r.status, 200, "notifications readable: " + JSON.stringify(r.data));
  return r.data.items.some((n) => n.type === type);
}

test("G1: notifyAdmins fans out by domain — learning-admin in, auditor out, super always in", async () => {
  const p = await probePersonas();
  // An elective enrolment application is a learning-domain notifyAdmins trigger
  // (server.js /api/me/enroll-requests). Before this batch the fan-out filtered
  // on role === "admin", so the learning-admin who has to approve it never knew.
  const apply = await p.emp.client.post("/api/me/enroll-requests", { programId: PROBE.pubProg });
  assert.equal(apply.status, 200, "enrolment application accepted: " + JSON.stringify(apply.data));

  assert.equal(await hasNotice(admin, "enroll.request"), true, "super-admin receives every notification");
  assert.equal(await hasNotice(p.la.client, "enroll.request"), true, "learning-admin receives the learning notice — the whole reason the role exists");
  assert.equal(await hasNotice(p.pa.client, "enroll.request"), false, "performance-admin is outside the learning domain");
  assert.equal(await hasNotice(p.au.client, "enroll.request"), false, "the read-only auditor is not drowned in business traffic");
  assert.equal(await hasNotice(p.emp.client, "enroll.request"), false, "a plain employee is not an admin");
});

test("G1: notifyAdmins with no domain still reaches EVERY admin, auditor included", async () => {
  // The startup integrity alarm is the one console-wide diagnostic that passes
  // no domain, and that omission must degrade to the exact pre-RBAC behaviour.
  // Boot a server, plant an auditor, stop it, seed one dangling assignment, boot
  // again on the same DB: the alarm has to land on the auditor as well.
  const first = await startServer();
  const audCreds = { employeeId: "RBAC-DOM-AUD", password: "rbac-dom-aud-2026" };
  try {
    const a = await loginAs(first.base, ADMIN);
    const audMade = await a.post("/api/admin/roles", { name: "Test Auditor", grants: { audit: "read" } });
    assert.equal(audMade.status, 200, "audit-only custom role created on the second DB too");
    const audRole = audMade.data.role;
    const created = await a.post("/api/admin/employees", { name: "Domainless Auditor", employeeId: audCreds.employeeId });
    assert.equal(created.status, 200, "create the auditor account");
    const u = (await a.get("/api/admin/employees")).data.find((x) => x.employeeId === audCreds.employeeId);
    assert.equal((await a.put("/api/admin/employees/" + u.id, { adminRoleId: audRole.id })).status, 200, "assign the auditor role");
    const c = await loginAs(first.base, { employeeId: audCreds.employeeId, password: created.data.password });
    assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: audCreds.password })).status, 200, "clear mustChangePassword");
  } finally {
    first.stop();
  }
  // One dangling assignment row -> the startup alarm fires on the next boot.
  // Retried: the killed server may still be releasing its WAL lock.
  let inserted = false;
  for (let i = 0; i < 20 && !inserted; i++) {
    try {
      const db = new DatabaseSync(first.dbPath);
      try {
        db.prepare("INSERT INTO assignments (userId, programId, dueAt, assignedAt) VALUES (?, ?, NULL, ?)")
          .run("u-does-not-exist", "prog-does-not-exist", new Date().toISOString());
        inserted = true;
      } finally {
        db.close();
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(inserted, "seeded the dangling assignment");

  const second = await startServer({ dbPath: first.dbPath });
  try {
    const au = await loginAs(second.base, audCreds);
    assert.equal(await hasNotice(au, "integrity"), true, "a domain-less notifyAdmins reaches the auditor too — pre-RBAC behaviour kept");
    const sa = await loginAs(second.base, ADMIN);
    assert.equal(await hasNotice(sa, "integrity"), true, "and the super-admin");
  } finally {
    second.stop();
  }
});

test("G2: learning-domain read is the employee-side preview key; auditor and plain employee unchanged", async () => {
  const p = await probePersonas();
  const rec = (c, pid) => c.get("/api/me/programs/" + pid + "/record");
  // Nobody is assigned to either probe program, so a 200 can only come from the
  // learning-domain preview privilege.
  assert.equal((await rec(p.la.client, PROBE.pubProg)).status, 200, "learning-admin opens an unassigned published program");
  assert.equal((await rec(p.la.client, PROBE.draftProg)).status, 200, "learning-admin opens the draft they are building");
  assert.equal((await rec(p.au.client, PROBE.pubProg)).status, 404, "auditor (learning=none) gets no preview privilege");
  assert.equal((await rec(p.au.client, PROBE.draftProg)).status, 404, "auditor sees no draft either");
  // The regression half: no admin role -> exactly as walled off as before.
  assert.equal((await rec(p.emp.client, PROBE.pubProg)).status, 404, "plain employee: unassigned published program still 404");
  assert.equal((await rec(p.emp.client, PROBE.draftProg)).status, 404, "plain employee: draft still 404");

  // Same rule on the list endpoint.
  const inRecord = async (c) => {
    const r = await c.get("/api/me/learning-record");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.some((x) => x.id === PROBE.pubProg);
  };
  assert.equal(await inRecord(p.la.client), true, "learning-admin's record lists the unassigned program");
  assert.equal(await inRecord(p.au.client), false, "auditor's record does not");
  assert.equal(await inRecord(p.emp.client), false, "plain employee's record does not");

  // Catalog: the preview privilege reads as "assigned", and must not leak to the auditor.
  const catStatus = async (c) => {
    const r = await c.get("/api/catalog");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const hit = r.data.find((x) => x.id === PROBE.pubProg);
    assert.ok(hit, "the probe program is in the catalog");
    return hit.status;
  };
  assert.equal(await catStatus(p.la.client), "assigned", "learning-admin can enter the course from the catalog");
  assert.equal(await catStatus(p.au.client), "none", "auditor is not silently enrolled in everything");
});

test("G3: course attachments follow the learning domain; other owner kinds stay admin-only", async () => {
  const p = await probePersonas();
  // The file hangs off the DRAFT course, so no employee can reach it through the
  // assigned-published-program rule — a 200 proves the learning-domain branch.
  const up = await admin.upload("/api/admin/attachments?name=probe.pdf&courseId=" + PROBE.draftCourse, Buffer.from("%PDF-1.4\n% rbac probe\n"));
  assert.equal(up.status, 200, "upload: " + JSON.stringify(up.data));
  const url = "/api/attachments/" + up.data.id;
  assert.equal((await p.la.client.raw("GET", url)).status, 200, "learning-admin fetches the courseware they own");
  assert.equal((await p.au.client.raw("GET", url)).status, 404, "auditor (learning=none) does not");
  assert.equal((await p.emp.client.raw("GET", url)).status, 404, "plain employee without the assignment does not");

  // Flip the row to a Phase-B owner kind: the bar there is isAdmin(), NOT the
  // learning domain — so the auditor passes and a logged-in non-admin never does.
  const db = new DatabaseSync(srv.dbPath);
  try {
    db.prepare("UPDATE attachments SET ownerKind = 'project', ownerId = ? WHERE id = ?").run("tp-rbac-probe", up.data.id);
  } finally {
    db.close();
  }
  assert.equal((await p.au.client.raw("GET", url)).status, 200, "non-course file: any admin identity passes the isAdmin bar");
  assert.equal((await p.la.client.raw("GET", url)).status, 200, "non-course file: learning-admin is an admin too");
  assert.equal((await p.emp.client.raw("GET", url)).status, 404, "non-course file: a logged-in non-admin is still refused");
});

test("G4: /api/me/roles reports any admin identity, with isSuperAdmin as the narrow flag", async () => {
  const p = await probePersonas();
  const sup = await admin.get("/api/me/roles");
  assert.equal(sup.status, 200);
  assert.equal(sup.data.admin, true, "ADMIN reads as admin");
  assert.equal(sup.data.isSuperAdmin, true, "ADMIN is super");

  const la = await p.la.client.get("/api/me/roles");
  assert.equal(la.status, 200);
  assert.equal(la.data.admin, true, "a non-super admin role still reads as admin");
  assert.equal(la.data.isSuperAdmin, false, "but is not super");

  const emp = await p.emp.client.get("/api/me/roles");
  assert.equal(emp.status, 200);
  assert.equal(emp.data.admin, false, "plain employee unchanged by the widening");
  assert.equal(emp.data.isSuperAdmin, false);

  // Back-compat: the widening added a field, it removed none.
  for (const k of ["trainer", "classHead", "manager", "sessionCount", "classCount", "reportCount"])
    assert.ok(k in la.data, "legacy key kept: " + k);
});

test("G5: roster rows carry adminRoleId and leak no credentials", async () => {
  const p = await probePersonas();
  const r = await admin.get("/api/admin/roster");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data), "roster is a flat array — the Roles page reads it directly");
  const la = r.data.find((x) => x.employeeId === "RBAC-G-LA");
  const emp = r.data.find((x) => x.employeeId === "RBAC-G-EMP");
  assert.ok(la && emp, "both probe users are in the roster");
  // Numeric id: the Roles page matches with === against role.id, so a stringified
  // value would silently render an empty member list.
  assert.equal(la.adminRoleId, roleId["learning-admin"], "the holder's role id, as a number");
  assert.equal(emp.adminRoleId, null, "no admin role -> null");
  for (const row of r.data) {
    assert.ok("adminRoleId" in row, "the key is present on EVERY row (" + row.employeeId + ") so the UI can tell an old server apart from an unassigned role");
    for (const secret of ["passwordHash", "larkUserId", "mustChangePassword", "salt", "resetToken", "sessionToken"])
      assert.ok(!(secret in row), "roster must not leak " + secret + " (" + row.employeeId + ")");
  }
});

test("W1b: job-grades and the record-field config are readable by any domain holder, writable only by fields", async () => {
  // 员工档案 labels a job level out of job-grades and 人才盘点 labels a rating out of
  // the record-field config: both are pure REFERENCE catalogs (no person in them),
  // so a role allowed to read a person or a rating must be able to read the labels
  // for it. Before this whitelist, HRBP on its OWN roster page and talent-admin on
  // its OWN 9-box each fired a 404 on mount (browser role-acceptance run, 2026-08-27).
  const hr = await makeAdminUser("RBAC-W1B-HR", roleId["hrbp"]);    // people=manage, fields=none
  const au = await makeAdminUser("RBAC-W1B-AU", roleId["auditor"]); // audit=read, everything else none
  for (const path of ["/api/admin/job-grades", "/api/admin/config/records"]) {
    assert.equal((await hr.client.get(path)).status, 200, "people>=read is enough for GET " + path);
    assert.equal((await au.client.get(path)).status, 404, "none of people/learning/performance/talent/fields -> 404 for GET " + path);
  }
  // GET only — every WRITE stays in the fields domain, i.e. the none-domain 404.
  assert.equal((await hr.client.put("/api/admin/job-grades", { ranks: [] })).status, 404, "job-grades write still needs fields");
  assert.equal((await hr.client.post("/api/admin/config/record-types", { key: "w1b", name: "W1b" })).status, 404, "record-type write still needs fields");
});

// ---------- A1: the 后台角色 selector round-trip (Employees.jsx) ----------

// The admin-role picker added to the employee edit form PUTs exactly one field:
// body.adminRoleId (a role id, or null for 无（普通员工）). This pins the whole
// server-side chain that control depends on — grant, revoke, and the audit trail
// the 角色与授权 page and 审计 page read back.
test("A1 assignment round-trip: adminRoleId grants then revokes console access, both audited", async () => {
  // A plain employee: created with no admin role, which is the state the picker
  // opens on (「无（普通员工）」) for everyone who is not an admin yet.
  const t = await makeAdminUser("RBAC-ASSIGN-RT", null);
  const me0 = await t.client.get("/api/me");
  assert.equal(me0.data.adminRoleId, null, "starts with no admin role");
  assert.equal(me0.data.isSuperAdmin, false, "and is not a super-admin");
  assert.deepEqual(me0.data.grants, {}, "no role -> no grants at all");
  assert.equal((await t.client.get("/api/admin/dashboard")).status, 403, "no admin role -> no console (Admin only)");

  // ① Super-admin assigns 培训管理员 — the picker sends the role id and nothing else.
  const grant = await admin.put("/api/admin/employees/" + t.id, { adminRoleId: roleId["learning-admin"] });
  assert.equal(grant.status, 200, "super-admin may assign an admin role");
  assert.equal(grant.data.user.adminRoleId, roleId["learning-admin"], "the response echoes the new id (the form re-seeds from the roster after this)");
  const meGranted = await t.client.get("/api/me");
  assert.equal(meGranted.data.adminRoleId, roleId["learning-admin"], "/api/me carries the assigned role id");
  assert.ok(meGranted.data.adminRoleName, "and its display name (the drawer/TopBar label)");
  assert.equal(meGranted.data.isSuperAdmin, false, "a granted role is not super");
  assert.equal(meGranted.data.grants.learning, "manage", "grants flipped to learning=manage");
  for (const d of ["people", "performance", "talent", "fields", "brand", "audit", "accounts"])
    assert.equal(meGranted.data.grants[d], "none", "only the learning domain opened, " + d + " stays none");
  assert.equal((await t.client.get("/api/admin/dashboard")).status, 200, "console now reachable");
  assert.equal((await t.client.get("/api/admin/content")).status, 200, "and the learning domain with it");

  // ② Back to 「无（普通员工）」 — the picker sends JSON null (not undefined, which
  // would drop the key and leave the role in place).
  const revoke = await admin.put("/api/admin/employees/" + t.id, { adminRoleId: null });
  assert.equal(revoke.status, 200, "null clears the admin role");
  assert.equal(revoke.data.user.adminRoleId, null, "echoed back as null");
  const meRevoked = await t.client.get("/api/me");
  assert.equal(meRevoked.data.adminRoleId, null, "role gone");
  assert.equal(meRevoked.data.adminRoleName, null, "and its name with it");
  assert.equal(meRevoked.data.isSuperAdmin, false);
  assert.deepEqual(meRevoked.data.grants, {}, "grants back to empty");
  assert.equal((await t.client.get("/api/admin/dashboard")).status, 403, "back-office access revoked");
  assert.equal((await t.client.get("/api/admin/content")).status, 403, "learning domain revoked with it");

  // ③ A no-change PUT (picking 无 again) must not fabricate an audit row.
  assert.equal((await admin.put("/api/admin/employees/" + t.id, { adminRoleId: null })).status, 200, "re-selecting the same value is a no-op, not an error");

  // Both real changes are on the audit trail as role.assign, in order, with the
  // before/after role ids the 审计 page renders.
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT action, target, beforeJson, afterJson FROM audit_logs WHERE action = ? AND target = ? ORDER BY id").all("role.assign", "RBAC-ASSIGN-RT");
    assert.equal(rows.length, 2, "exactly two role.assign rows — one per real change, none for the no-op");
    assert.equal(JSON.parse(rows[0].beforeJson).roleId, null, "grant: from no role");
    assert.equal(JSON.parse(rows[0].afterJson).roleId, roleId["learning-admin"], "grant: to learning-admin");
    assert.equal(JSON.parse(rows[1].beforeJson).roleId, roleId["learning-admin"], "revoke: from learning-admin");
    assert.equal(JSON.parse(rows[1].afterJson).roleId, null, "revoke: back to no role");
  } finally {
    db.close();
  }
});
