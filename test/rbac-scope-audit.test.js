// RBAC P2 数据范围（scope）—— D7：审计日志 GET /api/admin/audit 按范围过滤。
// 判据：一行审计的**目标解析出的员工**在范围内 → 保留；目标解析不出员工（配置/
// 品牌/角色/部门等无员工主体的操作）→ 对范围受限角色隐藏；超管与空范围角色看全量。
// countAudit/total 必须与过滤后一致（否则「共 N 条」又变谎话）。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const dept = {};   // name -> id
const emp = {};    // employeeId -> user id

// 造一个持某角色的后台账号并登录（与 rbac-scope-people.test.js 同一套路）。
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
  return c;
}

async function makeEmployee(empId, department) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find employee " + empId);
  const put = await admin.put("/api/admin/employees/" + u.id, { department, jobLevel: "P5" });
  assert.equal(put.status, 200, "set department of " + empId);
  emp[empId] = u.id;
  return u.id;
}

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}

let scopedAuditor, plainAuditor;

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // 部门树：AUD Root → AUD Child（含下级），AUD Other 在范围外（都产 department.* 行）。
  for (const [name, parent] of [["AUD Root", null], ["AUD Child", "AUD Root"], ["AUD Other", null]]) {
    const body = parent ? { name, parentId: dept[parent] } : { name };
    const r = await admin.post("/api/admin/departments", body);
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  // 每个 makeEmployee 产 employee.create + employee.update（target = employeeId）。
  await makeEmployee("AUD-IN", "AUD Root");    // 范围内
  await makeEmployee("AUD-KID", "AUD Child");  // 范围内（子部门，含下级）
  await makeEmployee("AUD-OUT", "AUD Other");  // 范围外
  const scope = { departments: [{ id: dept["AUD Root"], includeChildren: true }] };
  // 纯审计角色：audit=manage 才够读 GET /api/admin/audit；范围 = AUD Root 子树。
  scopedAuditor = await makeAdminUser("AUD-A-SCOPED", await makeRole("Scoped Auditor", { audit: "manage" }, scope));
  // 回归基线：一模一样的授权，**空范围**（现有全部角色都是这个形状）→ 必须看全量。
  plainAuditor = await makeAdminUser("AUD-A-PLAIN", await makeRole("Plain Auditor", { audit: "manage" }));
});
after(() => srv.stop());

test("范围受限审计员：只见范围内员工的审计行，范围外与无主体的配置行全隐藏", async () => {
  const r = await scopedAuditor.get("/api/admin/audit");
  assert.equal(r.status, 200, "scoped auditor 可读 audit");
  const rows = r.data.rows;
  const targets = new Set(rows.map((x) => x.target));
  // 范围内员工（AUD-IN / AUD-KID）的 employee.* 行看得到。
  assert.ok(targets.has("AUD-IN"), "看得到范围内本部门的审计行");
  assert.ok(targets.has("AUD-KID"), "看得到范围内子部门（含下级）的审计行");
  // 范围外员工（AUD-OUT）一行都看不到。
  assert.ok(!targets.has("AUD-OUT"), "看不到范围外员工的审计行");
  // 无员工主体的行（部门/角色/自己无部门的账号）全隐藏。
  for (const x of rows) {
    const kind = String(x.action || "").split(".")[0];
    assert.ok(!["department", "role", "config", "brand"].includes(kind),
      "范围受限审计员不应看到无员工主体的配置类行：" + x.action);
    // 越界员工与系统账号（无部门）不应出现。
    assert.ok(!["AUD-OUT", "AUD-A-SCOPED", "AUD-A-PLAIN", "ADMIN"].includes(x.target),
      "不应出现范围外/无部门主体：" + x.target);
  }
  // 每一行都必须解析为一个范围内的员工主体（employee.* / auth.* 等）。
  assert.ok(rows.length > 0, "至少有范围内员工的若干审计行");
});

test("total 与过滤后一致：total === 可见行数，未截断", async () => {
  const r = await scopedAuditor.get("/api/admin/audit");
  assert.equal(r.status, 200);
  assert.equal(r.data.total, r.data.rows.length, "total 必须等于过滤后返回的行数");
  assert.equal(r.data.truncated, false, "行数远小于窗口，不应截断");
});

test("超管看全量：包含范围外员工与配置类行，total === 库内真实总数", async () => {
  const r = await admin.get("/api/admin/audit");
  assert.equal(r.status, 200);
  const targets = new Set(r.data.rows.map((x) => x.target));
  assert.ok(targets.has("AUD-OUT"), "超管看得到范围外员工的行");
  const kinds = new Set(r.data.rows.map((x) => String(x.action || "").split(".")[0]));
  assert.ok(kinds.has("department"), "超管看得到无员工主体的部门配置行");
  assert.ok(kinds.has("role"), "超管看得到无员工主体的角色配置行");
  // 未截断时 total 就是库内真实总数（countAudit）；这里数据量远小于窗口。
  assert.equal(r.data.truncated, false);
  assert.equal(r.data.total, r.data.rows.length, "超管 total = 全部行");
});

test("空范围角色与超管一字不变：total 相等，且都看得到范围外与配置行", async () => {
  const a = await admin.get("/api/admin/audit");
  const p = await plainAuditor.get("/api/admin/audit");
  assert.equal(p.status, 200, "空范围审计员可读 audit");
  assert.equal(p.data.total, a.data.total, "空范围角色 total 必须与超管全量一致");
  const pt = new Set(p.data.rows.map((x) => x.target));
  assert.ok(pt.has("AUD-OUT"), "空范围角色看得到范围外员工（回归红线：不过滤）");
  const pk = new Set(p.data.rows.map((x) => String(x.action || "").split(".")[0]));
  assert.ok(pk.has("department") && pk.has("role"), "空范围角色看得到配置类行");
});

test("过滤严格小于全量：受限审计员看到的行数 < 超管", async () => {
  const a = await admin.get("/api/admin/audit");
  const s = await scopedAuditor.get("/api/admin/audit");
  assert.ok(s.data.total < a.data.total, "受限审计员的可见总数必须严格少于超管全量");
});
