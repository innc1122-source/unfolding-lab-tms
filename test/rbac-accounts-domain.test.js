// D6（2026-08-28）拆域验收：把原「账号与角色」域拆成 accounts（员工账号，可授予+受
// 部门范围约束）与 roles（角色与授权，恒超管、不可授予）。本文件钉住 D6 最危险的一条：
// 非超管即使 accounts=manage，也**能**建号/重置/停用（范围内），但**绝不能**授
// admin/adminRoleId、建/改/删角色、给自己加域 —— roles 域必须恒超管、不可授予。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db）。与 rbac-scope-*.test.js
// 同一套 makeEmployee/makeRole/makeAdminUser 套路。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const dept = {};        // name -> id
const emp = {};         // employeeId -> user id
const roleId = {};      // builtin role key -> id
let acctOnly;           // 非超管，accounts=manage（无 people），空范围 —— 纯账号域
let hrbpAcct;           // 非超管，people=manage + accounts=manage，空范围 —— 办入职的 HRBP
let hrbpScoped;         // 同上但范围 = ACCT Root 子树 —— 范围受限的 HRBP
// active（停用/启用）是 accounts 域字段，但**挂在 people 路由**上（PUT /employees/:id、
// bulk-update）——与既有的 potential/talentTags（talent 字段挂 people 路由）同构：要动它
// 得先过 people 路由闸门、再过 accounts=manage 的字段护栏。所以「停用」的现实角色是
// people+accounts 的 HRBP；纯 accounts 角色只做建号/重置（各有专用 accounts 路由）。

async function makeEmployee(empId, department) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find employee " + empId);
  if (department) {
    const put = await admin.put("/api/admin/employees/" + u.id, { department });
    assert.equal(put.status, 200, "set department of " + empId);
  }
  emp[empId] = u.id;
  return u.id;
}

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}

async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  const r = await admin.put("/api/admin/employees/" + u.id, { adminRoleId });
  assert.equal(r.status, 200, "assign role to " + empId);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  const cp = await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" });
  assert.equal(cp.status, 200, "clear mustChangePassword for " + empId);
  return { client: c, id: u.id };
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const roles = await admin.get("/api/admin/roles");
  assert.equal(roles.status, 200, "super-admin lists roles");
  for (const role of roles.data.roles) if (role.key) roleId[role.key] = role.id;
  // 部门树：ACCT Root → ACCT Child（含下级要真展开），ACCT Other 在范围外。
  for (const [name, parent] of [["ACCT Root", null], ["ACCT Child", "ACCT Root"], ["ACCT Other", null]]) {
    const body = parent ? { name, parentId: dept[parent] } : { name };
    const r = await admin.post("/api/admin/departments", body);
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  await makeEmployee("ACCT-IN", "ACCT Root");
  await makeEmployee("ACCT-KID", "ACCT Child");
  await makeEmployee("ACCT-OUT", "ACCT Other");
  const scope = { departments: [{ id: dept["ACCT Root"], includeChildren: true }] };
  acctOnly = await makeAdminUser("ACCT-A-ONLY", await makeRole("Accounts Only", { accounts: "manage" }));
  hrbpAcct = await makeAdminUser("ACCT-A-HRBP", await makeRole("HRBP+Accounts", { people: "manage", learning: "manage", accounts: "manage" }));
  hrbpScoped = await makeAdminUser("ACCT-A-SCOPED", await makeRole("HRBP+Accounts Scoped", { people: "manage", learning: "manage", accounts: "manage" }, scope));
});
after(() => srv.stop());

// ---------- migration ----------
test("migration 46 backfills the roles domain: super-admin manage, others none, all 9 keys present", async () => {
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    const versions = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(versions.includes(46), "migration 46 applied");
    const rows = db.prepare("SELECT key, grants FROM roles WHERE builtin = 1").all();
    const NINE = ["people", "learning", "performance", "talent", "fields", "brand", "audit", "accounts", "roles"];
    for (const r of rows) {
      const g = JSON.parse(r.grants);
      for (const d of NINE) assert.ok(d in g, r.key + " has key " + d);
      if (r.key === "super-admin") {
        assert.equal(g.roles, "manage", "super-admin roles=manage");
        assert.equal(g.accounts, "manage", "super-admin accounts=manage");
      } else {
        assert.equal(g.roles, "none", r.key + " roles=none (never grantable)");
      }
    }
  } finally {
    db.close();
  }
});

// ---------- /api/me contract ----------
test("/api/me: accounts=manage non-super sees accounts manage, roles none, not super", async () => {
  const me = await acctOnly.client.get("/api/me");
  assert.equal(me.data.isSuperAdmin, false, "not super");
  assert.equal(me.data.grants.accounts, "manage", "accounts granted");
  assert.equal(me.data.grants.roles, "none", "roles never granted");
  assert.equal(me.data.grants.people, "none", "people not granted");
});

// ---------- positive: a pure accounts role CAN provision via the dedicated accounts routes ----------
test("accounts=manage can create / reset / bulk-reset (dedicated accounts routes, no people needed)", async () => {
  const created = await acctOnly.client.post("/api/admin/employees", { name: "z", employeeId: "ACCT-NEW", department: "ACCT Other" });
  assert.equal(created.status, 200, "create account allowed");
  assert.ok(created.data.password, "temp password issued");
  assert.ok((await admin.get("/api/admin/roster")).data.some((x) => x.employeeId === "ACCT-NEW"), "new account exists");
  assert.equal((await acctOnly.client.post("/api/admin/employees/" + emp["ACCT-IN"] + "/reset")).status, 200, "single reset allowed");
  const br = await acctOnly.client.post("/api/admin/employees/bulk-reset", { userIds: [emp["ACCT-KID"]] });
  assert.equal(br.status, 200, "bulk-reset allowed");
  assert.equal(br.data.count, 1, "one password issued");
});

// ---------- positive: active (accounts field on a people route) works for people+accounts (HRBP onboarding) ----------
test("HRBP+accounts can deactivate via PUT active and bulk-update active", async () => {
  const created = await acctOnly.client.post("/api/admin/employees", { name: "z", employeeId: "ACCT-DEA", department: "ACCT Other" });
  assert.equal(created.status, 200);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "ACCT-DEA");
  assert.equal((await hrbpAcct.client.put("/api/admin/employees/" + u.id, { active: false })).status, 200, "deactivate via PUT active allowed");
  assert.equal((await hrbpAcct.client.post("/api/admin/employees/bulk-update", { userIds: [emp["ACCT-OUT"]], fields: { active: false } })).status, 200, "deactivate via bulk-update active allowed");
  await admin.put("/api/admin/employees/" + emp["ACCT-OUT"], { active: true }); // restore
  // A people-only role (no accounts) is still blocked on active — the field guard,
  // not the route, is what stops it (pins that accounts=manage is the real gate).
  const hrbpNoAcct = await makeAdminUser("ACCT-A-NOACCT", roleId["hrbp"]);
  assert.equal((await hrbpNoAcct.client.put("/api/admin/employees/" + emp["ACCT-OUT"], { active: false })).status, 403, "people-only can't change active (needs accounts=manage)");
});

// ---------- the dangerous line: accounts=manage must NEVER be a privilege-escalation face ----------
test("accounts=manage cannot escalate: role / adminRoleId / roles CRUD are all shut", async () => {
  const target = emp["ACCT-IN"];
  // role / adminRoleId on PUT employees → super-admin only → 403. hrbpAcct holds
  // people=manage so it CLEARS the route gate and hits the field guard (a pure
  // accounts role would 404 at the people route — also a rejection, but this
  // pins the field-level 403 specifically).
  assert.equal((await hrbpAcct.client.put("/api/admin/employees/" + target, { role: "admin" })).status, 403, "PUT role=admin 403");
  assert.equal((await hrbpAcct.client.put("/api/admin/employees/" + target, { adminRoleId: roleId["super-admin"] })).status, 403, "PUT adminRoleId=super 403");
  assert.equal((await hrbpAcct.client.put("/api/admin/employees/" + hrbpAcct.id, { adminRoleId: roleId["super-admin"] })).status, 403, "self-assign super 403");
  assert.equal((await hrbpAcct.client.post("/api/admin/employees/bulk-update", { userIds: [target], fields: { role: "admin" } })).status, 403, "bulk role=admin 403");
  assert.equal((await hrbpAcct.client.post("/api/admin/employees/bulk-update", { userIds: [target], fields: { adminRoleId: roleId["super-admin"] } })).status, 403, "bulk adminRoleId 403");
  // roles domain CRUD → super-admin only → shut on every verb, for BOTH a pure
  // accounts role and a people+accounts role (this is the real escalation face).
  for (const who of [acctOnly, hrbpAcct]) {
    assert.equal((await who.client.get("/api/admin/roles")).status, 403, "GET roles 403");
    assert.equal((await who.client.post("/api/admin/roles", { name: "Mine", grants: { people: "manage" } })).status, 403, "POST roles 403 (can't build a role / add self a domain)");
    assert.equal((await who.client.put("/api/admin/roles/" + roleId["hrbp"], { name: "x" })).status, 403, "PUT roles 403");
    assert.equal((await who.client.del("/api/admin/roles/" + roleId["hrbp"])).status, 403, "DELETE roles 403");
  }
  // none of the above changed the attacker
  const me = await hrbpAcct.client.get("/api/me");
  assert.equal(me.data.isSuperAdmin, false, "still not super");
  assert.equal(me.data.grants.roles, "none", "roles stays none");
  assert.equal(me.data.grants.accounts, "manage", "still just an accounts manager, not escalated");
});

// ---------- narrowness: a pure accounts=manage is not a backdoor into other data domains ----------
test("accounts=manage is confined to the accounts surface (people/learning stay 404)", async () => {
  assert.equal((await acctOnly.client.get("/api/admin/departments")).status, 404, "people read 404 (accounts != people)");
  assert.equal((await acctOnly.client.get("/api/admin/content")).status, 404, "learning read 404");
});

// ---------- scope: a scoped HRBP+accounts is confined to its departments ----------
test("scoped accounts=manage: create/reset/deactivate confined to scope", async () => {
  // create in scope → 200
  assert.equal((await hrbpScoped.client.post("/api/admin/employees", { name: "z", employeeId: "ACCT-SNEW", department: "ACCT Child" })).status, 200, "create in-scope dept allowed");
  // create out of scope → 400 dept_out_of_scope
  const oos = await hrbpScoped.client.post("/api/admin/employees", { name: "z", employeeId: "ACCT-SBAD", department: "ACCT Other" });
  assert.equal(oos.status, 400, "create out-of-scope dept rejected");
  assert.equal(oos.data.code, "dept_out_of_scope");
  assert.ok(!(await admin.get("/api/admin/roster")).data.some((x) => x.employeeId === "ACCT-SBAD"), "no out-of-scope account created");
  // create with no department → also rejected (no-dept is invisible under an active scope)
  const nodep = await hrbpScoped.client.post("/api/admin/employees", { name: "z", employeeId: "ACCT-SNODE" });
  assert.equal(nodep.status, 400, "create with no department rejected under scope");
  assert.equal(nodep.data.code, "dept_out_of_scope");
  // reset in scope → 200; out of scope → 404 (indistinguishable from not-found)
  assert.equal((await hrbpScoped.client.post("/api/admin/employees/" + emp["ACCT-IN"] + "/reset")).status, 200, "reset in-scope allowed");
  assert.equal((await hrbpScoped.client.post("/api/admin/employees/" + emp["ACCT-OUT"] + "/reset")).status, 404, "reset out-of-scope 404");
  // deactivate out of scope → 404 (scope check precedes the field guard); in scope → 200
  assert.equal((await hrbpScoped.client.put("/api/admin/employees/" + emp["ACCT-OUT"], { active: false })).status, 404, "deactivate out-of-scope 404");
  assert.equal((await hrbpScoped.client.put("/api/admin/employees/" + emp["ACCT-KID"], { active: false })).status, 200, "deactivate in-scope allowed");
  await admin.put("/api/admin/employees/" + emp["ACCT-KID"], { active: true }); // restore
});

test("scoped accounts=manage: batch endpoints reject the whole batch on any out-of-scope row", async () => {
  // bulk-reset partial out of scope → 404 out_of_scope, reports the count
  const br = await hrbpScoped.client.post("/api/admin/employees/bulk-reset", { userIds: [emp["ACCT-IN"], emp["ACCT-OUT"]] });
  assert.equal(br.status, 404, "bulk-reset partial out-of-scope rejected");
  assert.equal(br.data.code, "out_of_scope");
  assert.equal(br.data.outOfScope, 1, "reports one out-of-scope row");
  // bulk create partial out of scope → 404 out_of_scope, and nothing created
  const bc = await hrbpScoped.client.post("/api/admin/employees/bulk", { rows: [
    { name: "a", employeeId: "ACCT-BC1", department: "ACCT Child" },
    { name: "b", employeeId: "ACCT-BC2", department: "ACCT Other" },
  ] });
  assert.equal(bc.status, 404, "bulk create partial out-of-scope rejected");
  assert.equal(bc.data.code, "out_of_scope");
  const roster = (await admin.get("/api/admin/roster")).data;
  assert.ok(!roster.some((x) => x.employeeId === "ACCT-BC1"), "in-scope row not created (whole-batch reject)");
  assert.ok(!roster.some((x) => x.employeeId === "ACCT-BC2"), "out-of-scope row not created");
});

// ---------- the last-active-super-admin invariant survives D6 (active is now grantable) ----------
// Regression for a D6 gap: making `active` an accounts-domain field let a non-super
// accounts-manager reach the deactivate path, but the "keep >=1 active super-admin"
// guard lived only in the adminRoleId branch. A people+accounts HRBP could drive
// active super-admins to ZERO (PUT active:false and bulk-update), locking everyone out.
// D6 account-integrity: a non-super accounts-manager must NOT be able to
// deactivate ANY admin account (super or delegated) — regardless of how many
// supers remain. This mirrors the "only a super-admin can reset an admin account"
// guard. It is stricter than (and fires before) the last-active-super guard.
// Regression for a hole the domain-split shipped: with 2 supers present, a
// people+accounts HRBP could deactivate a super (the last-super guard only stops
// the tally hitting zero, not the act of disabling a higher-privileged admin).
test("accounts=manage cannot deactivate an admin account, even when other supers remain (PUT + bulk)", async () => {
  const roster = await admin.get("/api/admin/roster");
  const adminU = roster.data.find((x) => x.employeeId === "ADMIN");
  const demoU = roster.data.find((x) => x.employeeId === "DEMO-ADMIN");
  assert.ok(adminU && demoU, "both seeded super-admins present");
  // Both supers active -> deactivating one would pass the last-super tally, so a
  // 403 here proves the admin-account guard (not the tally guard) is doing the work.
  const p = await hrbpAcct.client.put("/api/admin/employees/" + demoU.id, { active: false });
  assert.equal(p.status, 403, "non-super PUT deactivate a super -> 403");
  assert.match(p.data.error || "", /deactivate an admin account|停用管理员账号/);
  const b = await hrbpAcct.client.post("/api/admin/employees/bulk-update", { userIds: [demoU.id], fields: { active: false } });
  assert.equal(b.status, 403, "non-super bulk deactivate a super -> 403");
  assert.match(b.data.error || "", /deactivate an admin account|停用管理员账号/);
  // Both supers still active — nothing changed.
  const after = await admin.get("/api/admin/roster");
  assert.equal(after.data.find((x) => x.employeeId === "ADMIN").active, true, "ADMIN still active");
  assert.equal(after.data.find((x) => x.employeeId === "DEMO-ADMIN").active, true, "DEMO-ADMIN still active");
});

// Not over-fixed: a SUPER actor may still deactivate another super while one
// remains — the rule is "only a super may touch an admin account", not "supers
// are untouchable". (The last-active-super tally guard is now defense-in-depth:
// self-deactivation is blocked separately and non-supers are stopped by the
// admin-account guard, so no legitimate path reaches zero.)
test("a super-admin can still deactivate another super while one remains", async () => {
  const roster = await admin.get("/api/admin/roster");
  const demoU = roster.data.find((x) => x.employeeId === "DEMO-ADMIN");
  assert.equal((await admin.put("/api/admin/employees/" + demoU.id, { active: false })).status, 200, "super deactivates another super while one remains -> 200");
  assert.equal((await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "DEMO-ADMIN").active, false, "DEMO-ADMIN now inactive");
  await admin.put("/api/admin/employees/" + demoU.id, { active: true }); // restore the second super
});

// ---------- password reset must not be a takeover face (D6) ----------
// Regression for a D6 gap: reset RETURNS the plaintext temp password, so letting a
// non-super accounts-manager reset an ADMIN account = taking that admin over. Only a
// super-admin may reset another admin; employee resets stay open (positive test above).
test("accounts=manage cannot reset an admin account's password (single 403, bulk skipped)", async () => {
  const roster = await admin.get("/api/admin/roster");
  const adminU = roster.data.find((x) => x.employeeId === "ADMIN");           // super-admin
  const otherAdmin = roster.data.find((x) => x.employeeId === "ACCT-A-HRBP"); // back-office admin (adminRoleId set)
  assert.ok(adminU && otherAdmin && otherAdmin.adminRoleId != null, "admin targets present");
  // single reset of a super-admin and of another back-office admin -> 403, no password
  for (const t of [adminU, otherAdmin]) {
    const r = await acctOnly.client.post("/api/admin/employees/" + t.id + "/reset");
    assert.equal(r.status, 403, "reset admin " + t.employeeId + " -> 403");
    assert.ok(!r.data.password, "no temp password handed back for " + t.employeeId);
  }
  // bulk-reset that includes an admin: the admin is skipped (reason admin), employee reset
  const bulk = await acctOnly.client.post("/api/admin/employees/bulk-reset", { userIds: [adminU.id, emp["ACCT-IN"]] });
  assert.equal(bulk.status, 200, "bulk-reset with an admin target still 200");
  assert.ok(!bulk.data.issued.some((x) => x.userId === adminU.id), "admin got no password in bulk");
  assert.ok(bulk.data.skipped.some((x) => x.reason === "admin"), "admin skipped with reason=admin");
  assert.ok(bulk.data.issued.some((x) => x.userId === emp["ACCT-IN"]), "regular employee still reset in the same batch");
  // super-admin is unaffected: it can still reset an admin
  const sa = await admin.post("/api/admin/employees/" + otherAdmin.id + "/reset");
  assert.equal(sa.status, 200, "super-admin can still reset an admin account");
  assert.ok(sa.data.password, "super-admin reset returns a password");
});
