// 第二批 2.3 / 2.4（2026-10-08，波次 2 W2-A）：人才盘点九宫格的服务端字段与来源周期，潜力评定日期，绩效与人才管理员的员工档案只读。
//   · GET /api/admin/talent-review：?cycle= 选绩效来源（缺省 / latest = 每人最近一条；否则须是已关闭的周期，不存在或未关闭 → 404
//     cycle_not_found），评级读该周期归档进档案的记录；rows 补 managerId / managerName / managerEmployeeId（上级在范围内才给）/
//     hireDate / empStatus / jobGrade / jobTrack / directReports / potentialAt；响应补 source / sourceCycles。
//   · users.potentialAt（迁移 67）：potential 真的变了才写（清空写 null），PUT 与 bulk-update 都经过 store.updateUser；
//     employee.update 审计的 before / after 带 potential；后台档案带 potentialAt。
//   · 迁移 68：已有库里 performance-talent-admin 的 people 由 none 改为 read（已是 manage 的不降级，幂等）。
//   · notifyAdmins 的 write 标记：Lark 同步与首次登录建号的通知只发给 people 有管理权限的人；人才记录 CSV 的导出权限只在一处判定。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin, legacyId, openId;
const people = {};
const dept = {};
const selfBody = { outcomes: ["done"], challenges: "", feedback: "more syncs", goalsNext: ["next"] };

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
async function mkPerson(employeeId, department, extra) {
  const r = await admin.post("/api/admin/employees", { name: "N " + employeeId, employeeId, ...(department ? { department } : {}), jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(employeeId)).id;
  if (extra) assert.equal((await admin.put(`/api/admin/employees/${id}`, extra)).status, 200, JSON.stringify(extra));
  people[employeeId] = { id, password: r.data.password };
  return id;
}
async function client(employeeId) {
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: people[employeeId].password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: people[employeeId].password, newPassword: employeeId + "-pw-2026" })).status, 200);
  return c;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  await mkPerson("TR-M", "TR Sales", { jobLevel: "MB3" });
  dept["TR Sales"] = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "TR Sales").id;
  await mkPerson("TR-OM", "TR Other");
  await mkPerson("TR-E1", "TR Sales", { managerId: people["TR-OM"].id, hireDate: "2023-02-01", empStatus: "probation" });
  await mkPerson("TR-E2", "TR Sales", { managerId: people["TR-M"].id });
  await mkPerson("TR-E3", "TR Sales", { managerId: people["TR-M"].id });
  await mkPerson("TR-E4", "TR Sales", { managerId: people["TR-M"].id, empStatus: "exited" });
  // 旧流程周期：E1 评 A、E2 评 C → 关闭归档；之后 E1 另有一条更新的手工绩效记录（「最近一条」取它）
  const c = await admin.post("/api/admin/review-cycles", { name: "TR 2026H1", userIds: [people["TR-E1"].id, people["TR-E2"].id] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  legacyId = c.data.cycle.id;
  const items = Object.fromEntries((await admin.get(`/api/admin/review-cycles/${legacyId}`)).data.items.map((i) => [i.employeeId, i.id]));
  const e1 = await client("TR-E1"), e2 = await client("TR-E2"), om = await client("TR-OM"), m = await client("TR-M");
  assert.equal((await e1.post(`/api/me/reviews/${items["TR-E1"]}/self`, selfBody)).status, 200);
  assert.equal((await e2.post(`/api/me/reviews/${items["TR-E2"]}/self`, selfBody)).status, 200);
  assert.equal((await om.post(`/api/me/reviews/${items["TR-E1"]}/manager`, { rating: "A", oneOnOneDone: true })).status, 200);
  assert.equal((await m.post(`/api/me/reviews/${items["TR-E2"]}/manager`, { rating: "C", oneOnOneDone: true })).status, 200);
  const closed = await admin.post(`/api/admin/review-cycles/${legacyId}/close`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal((await admin.post(`/api/admin/employees/${people["TR-E1"].id}/records`, { type: "performance", date: "2099-01-01", title: "later", fields: { period: "2099 manual", rating: "D", summary: "" } })).status, 200);
  openId = (await admin.post("/api/admin/review-cycles", { name: "TR open", userIds: [people["TR-E3"].id] })).data.cycle.id;
});
after(async () => { if (srv) await srv.stopAsync(); });

test("2.4 rows: manager, hire date, status, job grade / track, direct reports and potentialAt; source and the closed cycles to pick from", async () => {
  const r = await admin.get("/api/admin/talent-review");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.source, "latest");
  assert.deepEqual(r.data.sourceCycles.map((c) => c.id), [legacyId], "only closed cycles");
  assert.deepEqual(Object.keys(r.data.sourceCycles[0]).sort(), ["closedAt", "flow", "id", "kind", "name"]);
  const row = (eid) => r.data.rows.find((x) => x.employeeId === eid);
  const e1 = row("TR-E1");
  for (const k of ["managerId", "managerName", "managerEmployeeId", "hireDate", "empStatus", "jobGrade", "jobTrack", "directReports", "potentialAt"]) assert.ok(k in e1, k);
  assert.deepEqual([e1.managerId, e1.managerName, e1.managerEmployeeId], [people["TR-OM"].id, "N TR-OM", "TR-OM"]);
  assert.deepEqual([e1.hireDate, e1.empStatus, e1.jobGrade, e1.jobTrack], ["2023-02-01", "probation", "B", "P"]);
  assert.equal(e1.rating, "D", "latest = the most recent performance record per person");
  assert.equal(row("TR-M").directReports, 2, "active direct reports only (TR-E4 has left)");
  assert.deepEqual([row("TR-M").jobGrade, row("TR-M").jobTrack], ["B", "M"]);
  assert.equal(row("TR-E2").directReports, 0);
  assert.equal((await admin.get("/api/admin/talent-review?cycle=latest")).data.source, "latest");
});

test("2.4 ?cycle=: a closed cycle reads the ratings archived from it; unknown or still-open cycles are 404 cycle_not_found", async () => {
  const r = (await admin.get(`/api/admin/talent-review?cycle=${legacyId}`)).data;
  assert.equal(r.source, legacyId);
  const row = (eid) => r.rows.find((x) => x.employeeId === eid);
  assert.deepEqual([row("TR-E1").rating, row("TR-E2").rating, row("TR-E3").rating], ["A", "C", null]);
  assert.equal(row("TR-E1").perfBucket, 2);
  for (const bad of [openId, "no-such-cycle"]) {
    const x = await admin.get(`/api/admin/talent-review?cycle=${encodeURIComponent(bad)}`);
    assert.equal(x.status, 404, bad);
    assert.equal(x.data.code, "cycle_not_found");
    assert.match(x.data.error, /isn't closed yet.*尚未关闭/);
  }
});

test("2.4 scope: a manager outside the viewer's data scope keeps the name but never the employee ID", async () => {
  const role = await admin.post("/api/admin/roles", { name: "TR scoped talent", name_zh: "TR 范围人才", grants: { talent: "read" }, scope: { departments: [{ id: dept["TR Sales"], includeChildren: true }] } });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  await mkPerson("TR-SC", null, { adminRoleId: role.data.role.id });
  const sc = await client("TR-SC");
  const r = (await sc.get("/api/admin/talent-review")).data;
  const e1 = r.rows.find((x) => x.employeeId === "TR-E1"), e2 = r.rows.find((x) => x.employeeId === "TR-E2");
  assert.deepEqual([e1.managerName, e1.managerEmployeeId], ["N TR-OM", null], "TR-OM sits in TR Other, outside the scope");
  assert.equal(e2.managerEmployeeId, "TR-M");
  assert.ok(!JSON.stringify(r).includes("\"TR-OM\""), "the out-of-scope manager's employee ID never appears");
});

test("2.4 potentialAt: written only when the potential really changes (PUT and bulk-update), cleared with it; the audit carries potential", async () => {
  const id = people["TR-E2"].id;
  const at = async () => (await admin.get(`/api/admin/employees/${id}/profile`)).data.user.potentialAt;
  assert.equal(await at(), null, "never assessed");
  assert.equal((await admin.put(`/api/admin/employees/${id}`, { potential: "High" })).status, 200);
  const first = await at();
  assert.match(first, /^\d{4}-\d{2}-\d{2}T/);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal((await admin.put(`/api/admin/employees/${id}`, { potential: "High", position: "Rep" })).status, 200);
  assert.equal(await at(), first, "re-sending the same value keeps the date");
  const audit = dbRead((d) => d.prepare("SELECT beforeJson, afterJson FROM audit_logs WHERE action = 'employee.update' AND target = 'TR-E2' ORDER BY id").all());
  const firstChange = audit.find((a) => JSON.parse(a.afterJson).potential === "High");
  assert.ok(firstChange, "employee.update carries potential");
  assert.equal(JSON.parse(firstChange.beforeJson).potential, null);
  assert.equal((await admin.put(`/api/admin/employees/${id}`, { potential: "" })).status, 200);
  assert.equal(await at(), null, "cleared with the potential");
  const bulk = await admin.post("/api/admin/employees/bulk-update", { userIds: [id], fields: { potential: "Medium" } });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.match(await at(), /^\d{4}-\d{2}-\d{2}T/, "bulk-update goes through the same store function");
  const tr = (await admin.get("/api/admin/talent-review")).data.rows.find((x) => x.employeeId === "TR-E2");
  assert.deepEqual([tr.potential, typeof tr.potentialAt], ["Medium", "string"]);
});

test("2.3: people-domain Lark notices are sent to people managers only; the records.csv permission lives in one helper", () => {
  const src = require("./helpers.js").serverSource();   // server.js + modules/*/routes.js
  assert.match(src, /function notifyAdmins\(n, domain, opts\) \{[\s\S]{0,400}?write \? canWrite\(u, domain\) : canRead\(u, domain\)/);
  assert.equal((src.match(/\}, "people", \{ write: true \}\);/g) || []).length, 2, "lark.sync and lark.jit pass write:true");
  assert.match(src, /link: `#\/admin\/people\/\$\{u\.id\}\?edit=1`/, "the Lark first sign-in notice opens the person's edit page");
  // 2.5 其余通知直达：成绩申诉 → 那份答卷；培养项目申请 → 该项目的「待审申请」页签
  assert.match(src, /link: `\/admin\/results\?attempt=\$\{encodeURIComponent\(attempt\.id\)\}`/);
  assert.match(src, /link: `#\/admin\/projects\?project=\$\{encodeURIComponent\(doc\.id\)\}&tab=nom`/);
  assert.equal((src.match(/function canExportTalentRecords\(/g) || []).length, 1);
  assert.match(src, /\/api\/admin\/export\/records\.csv"\) \{\s+\/\/[^\n]*\n\s+if \(!canExportTalentRecords\(user\)\)/);
});

test("migration 68: an existing database upgrades performance-talent-admin people none → read, never downgrades manage, and is idempotent", async () => {
  const s1 = await startServer();
  const grantsOf = (dbPath) => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return JSON.parse(d.prepare("SELECT grants FROM roles WHERE key = 'performance-talent-admin'").get().grants); } finally { d.close(); } };
  const rewind = (dbPath, people) => {
    const d = new DatabaseSync(dbPath);
    try {
      const g = JSON.parse(d.prepare("SELECT grants FROM roles WHERE key = 'performance-talent-admin'").get().grants);
      g.people = people;
      d.prepare("UPDATE roles SET grants = ? WHERE key = 'performance-talent-admin'").run(JSON.stringify(g));
      d.prepare("DELETE FROM schema_migrations WHERE version = 68").run();
    } finally { d.close(); }
  };
  try {
    assert.equal(grantsOf(s1.dbPath).people, "read", "a fresh database is seeded with people read");
    await s1.stopAsync();
    rewind(s1.dbPath, "none");
    const s2 = await startServer({ dbPath: s1.dbPath });
    await s2.stopAsync();
    const g = grantsOf(s1.dbPath);
    assert.deepEqual([g.people, g.performance, g.talent, g.learning], ["read", "manage", "manage", "none"]);
    assert.deepEqual(Object.keys(g).sort(), ["accounts", "audit", "brand", "fields", "learning", "people", "performance", "roles", "talent"], "written back with every domain listed");
    rewind(s1.dbPath, "manage");
    const s3 = await startServer({ dbPath: s1.dbPath });
    await s3.stopAsync();
    assert.equal(grantsOf(s1.dbPath).people, "manage", "a role an admin already widened is not downgraded");
  } finally {
    try { await s1.stopAsync(); } catch {}
  }
});
