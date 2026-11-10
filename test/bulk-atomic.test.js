// 批量写原子性收尾：employees/bulk-update 与 assignments/bulk 包进单个事务，
// talent_records 查重索引（migration 48），batch_failed 不再回传原始异常文本。
//
// 覆盖：
//   1. 故障注入（LMS_TEST_FAIL_BULK_AT=3）：bulk-update（改部门 / 停用）与 assignments/bulk
//      （指派 / 取消）在第 3 个人抛异常 → 500 batch_failed + line，响应里没有 detail / 异常
//      文本；users、assignments、audit_logs、notifications、sessions 逐项不变，持有会话的人
//      照常在线。少于 3 人的批次照常成功、逐个跳过口径不变。
//   2. 写库之前的整批拒绝不受事务影响：over_cap、范围越界（404 out_of_scope）、把人推出
//      范围（400 dept_out_of_scope）都在进事务之前返回，故障注入不会被触发。
//   3. stderr：出错时记一行 [batch-tx] batch_failed <接口> row <N>: <异常>，单行、有长度
//      上限，不含请求体内容。
//   4. 正常模式：bulk-update 停用 → 该人会话被吊销，提交后写一条汇总的
//      auth.sessions_revoked；assignments/bulk 提交后才发通知，已停用 / 查无此人照旧跳过。
//   5. migration 48：talentRecordExists 的查重 SQL 走 idx_talent_dedupe（EXPLAIN QUERY PLAN）。
//
// 测试服一律指向临时库（LMS_DB_PATH，由 helpers 注入）和临时 config（LMS_CONFIG_PATH），
// 绝不读写仓库根的 lms.db / config.json。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer: startRaw, loginAs, tempDir } = require("./helpers.js");

function startServer(opts = {}) {
  const cfg = path.join(tempDir("lms-bulkatomic-cfg-"), "config.json");
  return startRaw({ ...opts, env: { LMS_CONFIG_PATH: cfg, ...(opts.env || {}) } });
}
const HAN = /[一-鿿]/;
function assertBilingual(msg) {
  assert.ok(HAN.test(msg) && /[A-Za-z]/.test(msg), `文案应为中英双语: ${msg}`);
}
function dbq(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
// 回滚断言用的整库快照：用户逐行逐列、指派逐行，其余按条数。
function snapshot(dbPath) {
  return dbq(dbPath, (db) => ({
    users: db.prepare("SELECT * FROM users ORDER BY id").all(),
    assignments: db.prepare("SELECT * FROM assignments ORDER BY userId, programId").all(),
    audit: db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
    notifications: db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n,
    sessions: db.prepare("SELECT token, userId FROM sessions ORDER BY token").all(),
    departments: db.prepare("SELECT COUNT(*) AS n FROM departments").get().n,
  }));
}
function stderrLines(srv) {
  const lines = [];
  let buf = "";
  srv.child.stderr.on("data", (d) => {
    buf += d;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    lines.push(...parts);
  });
  return lines;
}
const waitFor = async (pred) => { for (let k = 0; k < 50 && !pred(); k++) await new Promise((r) => setTimeout(r, 20)); };

async function makeEmployee(admin, empId, department) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId + ": " + JSON.stringify(created.data));
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  if (department) {
    const put = await admin.put("/api/admin/employees/" + u.id, { department });
    assert.equal(put.status, 200, "set department of " + empId);
  }
  return { id: u.id, password: created.data.password };
}
async function makeAdminUser(srv, admin, empId, adminRoleId) {
  const u = await makeEmployee(admin, empId, null);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, { adminRoleId })).status, 200);
  const c = await loginAs(srv.base, { employeeId: empId, password: u.password });
  const cp = await c.post("/api/auth/change-password", { currentPassword: u.password, newPassword: empId + "-pw-2026" });
  assert.equal(cp.status, 200);
  return c;
}

// ======================= 服务 A：故障注入 =======================
let fsrv, fadmin, flog;
const E = {};          // employeeId -> { id, password }
const sess = {};       // employeeId -> 已登录客户端
let scoped;            // 范围 = ATX In 的 people+learning 角色
before(async () => {
  fsrv = await startServer({ env: { LMS_TEST_FAIL_BULK_AT: "3", LMS_BULK_CAP: "5" } });
  flog = stderrLines(fsrv);
  fadmin = await loginAs(fsrv.base, ADMIN);
  const deptId = {};
  for (const name of ["ATX In", "ATX Out"]) {
    const r = await fadmin.post("/api/admin/departments", { name });
    assert.equal(r.status, 200, "create department " + name);
    deptId[name] = r.data.department.id;
  }
  for (const id of ["ATX-1", "ATX-2", "ATX-3", "ATX-4"]) E[id] = await makeEmployee(fadmin, id, "ATX In");
  E["ATX-OUT"] = await makeEmployee(fadmin, "ATX-OUT", "ATX Out");
  for (const id of ["ATX-1", "ATX-2", "ATX-3", "ATX-4"]) sess[id] = await loginAs(fsrv.base, { employeeId: id, password: E[id].password });
  const role = await fadmin.post("/api/admin/roles", {
    name: "ATX Scoped", name_zh: "ATX 范围", grants: { people: "manage", learning: "manage", accounts: "manage" },
    scope: { departments: [{ id: deptId["ATX In"], includeChildren: false }] },
  });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  scoped = await makeAdminUser(fsrv, fadmin, "ATX-SCOPED", role.data.role.id);
});
after(() => fsrv.stop());

const ids = (...emp) => emp.map((x) => E[x].id);
function assertFailed(r, label) {
  assert.equal(r.status, 500, `${label}: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.code, "batch_failed", label);
  assert.equal(r.data.line, 3, label);
  assertBilingual(r.data.error);
  assert.ok(!("detail" in r.data), label + " 响应不应带 detail");
  assert.ok(!/injected|LMS_TEST_FAIL_BULK_AT|SQLITE|constraint/i.test(JSON.stringify(r.data)), label + " 响应不应含原始异常文本");
}
async function assertSessionsAlive() {
  for (const id of ["ATX-1", "ATX-2", "ATX-3", "ATX-4"]) assert.equal((await sess[id].get("/api/me")).status, 200, id + " 会话应仍有效");
}

test("bulk-update 第 3 人抛异常：改部门 / 停用都整批回滚，用户、审计、会话全部不变", async () => {
  for (const fields of [{ department: "ATX Moved" }, { active: false }, { managerId: E["ATX-OUT"].id, potential: "High" }]) {
    const before0 = snapshot(fsrv.dbPath);
    flog.length = 0;
    const r = await fadmin.post("/api/admin/employees/bulk-update", { userIds: ids("ATX-1", "ATX-2", "ATX-3", "ATX-4"), fields });
    assertFailed(r, "bulk-update " + JSON.stringify(fields));
    assert.deepEqual(snapshot(fsrv.dbPath), before0, "bulk-update 回滚后库应逐项相同: " + JSON.stringify(fields));
    await assertSessionsAlive();
    // stderr：一行 [batch-tx] batch_failed，带接口名、行号与原始异常，不含请求体内容。
    await waitFor(() => flog.some((l) => l.includes("batch_failed")));
    const line = flog.find((l) => l.includes("batch_failed"));
    assert.ok(line, "应有 batch_failed 日志: " + JSON.stringify(flog));
    assert.match(line, /^\[batch-tx\] batch_failed employees\/bulk-update row 3: Error: injected failure at row 3/);
    assert.ok(line.length <= 800, "日志行应截断: " + line.length);
    assert.ok(!line.includes("ATX Moved") && !line.includes(E["ATX-OUT"].id), "日志不应含请求体内容: " + line);
  }
  // 少于 3 人：照常成功，逐个跳过口径不变（查无此人不计数）。
  const ok = await fadmin.post("/api/admin/employees/bulk-update", { userIds: [E["ATX-1"].id, "u-no-such-person"], fields: { potential: "Medium" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.count, 1);
});

test("assignments/bulk 第 3 人抛异常：指派 / 取消都整批回滚，指派、通知、审计全部不变", async () => {
  for (const action of ["assign", "unassign"]) {
    const before0 = snapshot(fsrv.dbPath);
    flog.length = 0;
    const r = await fadmin.post("/api/admin/assignments/bulk", { userIds: ids("ATX-1", "ATX-2", "ATX-3", "ATX-4"), programId: "nho", dueAt: "2031-01-31", action });
    assertFailed(r, "assignments/bulk " + action);
    assert.deepEqual(snapshot(fsrv.dbPath), before0, "assignments/bulk 回滚后库应逐项相同: " + action);
    await waitFor(() => flog.some((l) => l.includes("batch_failed")));
    assert.ok(flog.some((l) => /^\[batch-tx\] batch_failed assignments\/bulk row 3: /.test(l)), JSON.stringify(flog));
  }
  // 少于 3 人：照常成功。
  const ok = await fadmin.post("/api/admin/assignments/bulk", { userIds: ids("ATX-1", "ATX-2"), programId: "nho", action: "assign" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.count, 2);
  await assertSessionsAlive();
});

test("写库之前的整批拒绝不进事务：over_cap、范围越界、把人推出范围", async () => {
  const before0 = snapshot(fsrv.dbPath);
  // over_cap（LMS_BULK_CAP=5）：6 人 → 400，不会走到第 3 人的故障点。
  const over = await fadmin.post("/api/admin/employees/bulk-update", { userIds: [...ids("ATX-1", "ATX-2", "ATX-3", "ATX-4", "ATX-OUT"), "u-x"], fields: { potential: "Low" } });
  assert.equal(over.status, 400);
  assert.equal(over.data.code, "over_cap");
  // 范围越界：第 4 人在范围外 → 整批 404 out_of_scope（不是 batch_failed）。
  const oos = await scoped.post("/api/admin/employees/bulk-update", { userIds: ids("ATX-1", "ATX-2", "ATX-3", "ATX-OUT"), fields: { department: "ATX In" } });
  assert.equal(oos.status, 404, JSON.stringify(oos.data));
  assert.equal(oos.data.code, "out_of_scope");
  assert.equal(oos.data.outOfScope, 1);
  const oosA = await scoped.post("/api/admin/assignments/bulk", { userIds: ids("ATX-1", "ATX-2", "ATX-3", "ATX-OUT"), programId: "nho", action: "assign" });
  assert.equal(oosA.status, 404, JSON.stringify(oosA.data));
  assert.equal(oosA.data.code, "out_of_scope");
  // 把人推出范围：目标部门在范围外 → 400 dept_out_of_scope。
  const push = await scoped.post("/api/admin/employees/bulk-update", { userIds: ids("ATX-1", "ATX-2", "ATX-3"), fields: { department: "ATX Out" } });
  assert.equal(push.status, 400, JSON.stringify(push.data));
  assert.equal(push.data.code, "dept_out_of_scope");
  // 范围内的批次照常进事务（于是在第 3 人撞上故障注入 → 整批回滚）。
  const inScope = await scoped.post("/api/admin/employees/bulk-update", { userIds: ids("ATX-1", "ATX-2", "ATX-3"), fields: { active: false } });
  assertFailed(inScope, "scoped bulk-update");
  assert.deepEqual(snapshot(fsrv.dbPath), before0, "以上全部拒绝 / 回滚之后库应逐项相同");
  await assertSessionsAlive();
});

// ======================= 服务 B：正常模式 =======================
test("正常模式：bulk-update 停用吊销会话并写汇总审计；assignments/bulk 提交后发通知、跳过口径不变", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = await loginAs(srv.base, ADMIN);
  const P = {};
  for (const id of ["ATN-1", "ATN-2", "ATN-3"]) P[id] = await makeEmployee(admin, id, "ATN Dept");
  const c1 = await loginAs(srv.base, { employeeId: "ATN-1", password: P["ATN-1"].password });
  const c3 = await loginAs(srv.base, { employeeId: "ATN-3", password: P["ATN-3"].password });

  const off = await admin.post("/api/admin/employees/bulk-update", { userIds: [P["ATN-1"].id, P["ATN-2"].id, "u-missing"], fields: { active: false } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.count, 2);
  assert.equal((await c1.get("/api/me")).status, 401, "被停用的人会话应被吊销");
  assert.equal((await c3.get("/api/me")).status, 200, "不在批次里的人不受影响");
  const rows = dbq(srv.dbPath, (db) => ({
    sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE userId = ?").get(P["ATN-1"].id).n,
    revoked: db.prepare("SELECT afterJson AS after FROM audit_logs WHERE action = 'auth.sessions_revoked' ORDER BY id DESC LIMIT 1").get(),
    upd: db.prepare("SELECT afterJson AS after FROM audit_logs WHERE action = 'employee.bulk-update' ORDER BY id DESC LIMIT 1").get(),
  }));
  assert.equal(rows.sessions, 0);
  assert.ok(rows.revoked, "应有 auth.sessions_revoked 汇总审计");
  assert.deepEqual(JSON.parse(rows.revoked.after), { reason: "bulk_deactivated", count: 2 });
  assert.equal(JSON.parse(rows.upd.after).count, 2);

  // assignments/bulk：ATN-1/2 已停用 → skippedInactive；ATN-3 指派并收到一条通知；查无此人跳过。
  // 新员工可能已被默认指派 nho：先取消，保证下面是「新指派」、会发通知。
  const un = await admin.post("/api/admin/assignments/bulk", { userIds: [P["ATN-3"].id], programId: "nho", action: "unassign" });
  assert.equal(un.status, 200, JSON.stringify(un.data));
  const n0 = dbq(srv.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE userId = ?").get(P["ATN-3"].id).n);
  const a = await admin.post("/api/admin/assignments/bulk", { userIds: [P["ATN-1"].id, P["ATN-2"].id, P["ATN-3"].id, P["ATN-3"].id, "u-missing"], programId: "nho", action: "assign" });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.count, 2, "ATN-3 出现两次，按原口径计 2");
  assert.equal(a.data.skippedInactive, 2);
  const after0 = dbq(srv.dbPath, (db) => ({
    notes: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE userId = ? AND type = 'assigned'").get(P["ATN-3"].id).n,
    all: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE userId = ?").get(P["ATN-3"].id).n,
    asg: db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE userId = ? AND programId = 'nho'").get(P["ATN-3"].id).n,
  }));
  assert.equal(after0.asg, 1);
  assert.equal(after0.all - n0, 1, "同一人重复出现只通知一次");
  assert.equal(after0.notes >= 1, true);
});

test("migration 48：talentRecordExists 的查重 SQL 走 idx_talent_dedupe", () => {
  dbq(fsrv.dbPath, (db) => {
    const versions = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(versions.includes(48), "migration 48 applied");
    const cols = db.prepare("PRAGMA index_info(idx_talent_dedupe)").all().map((r) => r.name);
    assert.deepEqual(cols, ["userId", "type", "date", "title"]);
    // 与 store.talentRecordExists 逐字相同的 SQL。
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM talent_records WHERE userId = ? AND type = ? AND date = ? AND title = ?")
      .all("u-1", "honor", "2026-07-01", "t").map((r) => r.detail).join(" | ");
    assert.match(plan, /USING (COVERING )?INDEX idx_talent_dedupe \(userId=\? AND type=\? AND date=\? AND title=\?\)/, "实际计划: " + plan);
  });
});
