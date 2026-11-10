// 批量导入的性能与原子性回归测试（4,000 人一次导入的上线前提）。
//
// 覆盖：
//   1. 并发不阻塞：employees/bulk 导入 200 行（200 次 scrypt）期间，GET /api/env 仍在
//      1 秒内返回 —— 哈希走线程池（hashPasswordsAsync），不占事件循环。
//   2. 哈希兼容：批量建号、批量重置后的账号能用新密码登录；存储格式与 hashPassword 相同。
//   3. 查重：批内重复邮箱（大小写不同）/ 库内已有邮箱 / 批内重复工号都逐行 skipped；
//      两个并发的同名单导入不会建出重复账号（查重在事务里对最新库重做）。
//   4. 索引：migration 47 建了 lower(employeeId) 表达式索引，按工号查人的 SQL 用上了它。
//   5. 请求体：非批量路径 > 2,000,000 字符 → 413 body_too_large（双语），不是 500；
//      批量路径（后台账号）放宽到 LMS_BULK_BODY_MAX；匿名打批量路径仍是 2,000,000；
//      大请求体里跨 chunk 的中文不被解码成乱码。
//   6. 原子性：LMS_TEST_FAIL_BULK_AT=3 让五个批量接口在第 3 行抛异常 → 整批回滚、
//      500 batch_failed + line，库里一行不留，无审计、无通知、无会话吊销。
//
// 测试服一律指向临时库（LMS_DB_PATH，由 helpers 注入）和临时 config（LMS_CONFIG_PATH），
// 绝不读写仓库根的 lms.db / config.json。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer: startRaw, loginAs, makeClient, tempDir } = require("./helpers.js");

function startServer(opts = {}) {
  const cfg = path.join(tempDir("lms-bulkperf-cfg-"), "config.json");
  return startRaw({ ...opts, env: { LMS_CONFIG_PATH: cfg, ...(opts.env || {}) } });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HAN = /[一-鿿]/;
function assertBilingual(msg) {
  assert.ok(HAN.test(msg) && /[A-Za-z]/.test(msg), `文案应为中英双语: ${msg}`);
}
// 只读打开测试库做计数（WAL 下与运行中的服务并存没问题）。
function dbq(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function counts(dbPath) {
  return dbq(dbPath, (db) => {
    const n = (sql) => db.prepare(sql).get().n;
    return {
      users: n("SELECT COUNT(*) AS n FROM users"),
      assignments: n("SELECT COUNT(*) AS n FROM assignments"),
      audit: n("SELECT COUNT(*) AS n FROM audit_logs"),
      notifications: n("SELECT COUNT(*) AS n FROM notifications"),
      sessions: n("SELECT COUNT(*) AS n FROM sessions"),
      departments: n("SELECT COUNT(*) AS n FROM departments"),
      records: n("SELECT COUNT(*) AS n FROM talent_records"),
      secondary: n("SELECT COUNT(*) AS n FROM secondary_lines"),
      questions: n("SELECT COUNT(*) AS n FROM questions"),
      hashes: db.prepare("SELECT group_concat(passwordHash, '|') AS h FROM users").get().h,
    };
  });
}
async function rosterByEmpId(admin) {
  const r = await admin.get("/api/admin/roster");
  assert.equal(r.status, 200);
  return new Map(r.data.map((u) => [u.employeeId, u]));
}
// ======================= 服务 A：正常模式 =======================
let srv, admin;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
});
after(() => srv.stop());

test("并发不阻塞：employees/bulk 导入 200 行期间 /api/env 在 1 秒内返回", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    employeeId: "PF-" + String(i).padStart(4, "0"), name: "Perf " + i, department: "Perf Dept",
  }));
  let done = false;
  const t0 = Date.now();
  const bulkP = admin.post("/api/admin/employees/bulk", { rows, programIds: [] }).then((r) => { done = true; return r; });
  await sleep(80);
  let maxMs = 0, whilePending = 0;
  while (!done) {
    const s = Date.now();
    const r = await fetch(srv.base + "/api/env");
    assert.equal(r.status, 200);
    await r.json();
    const ms = Date.now() - s;
    if (!done) whilePending++;
    maxMs = Math.max(maxMs, ms);
    await sleep(40);
  }
  const bulk = await bulkP;
  const total = Date.now() - t0;
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data).slice(0, 300));
  assert.equal(bulk.data.results.filter((x) => x.status === "created").length, 200);
  assert.ok(whilePending >= 2, `导入期间应至少有 2 次探测完成（实际 ${whilePending}，导入总耗时 ${total}ms）`);
  assert.ok(maxMs < 1000, `导入期间 /api/env 最大响应 ${maxMs}ms，应 < 1000ms`);
  // 抽一个新账号用初始密码登录：异步哈希与 checkPassword 兼容。
  const one = bulk.data.results[137];
  const r = await makeClient(srv.base).login({ employeeId: one.employeeId, password: one.password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("哈希兼容：批量建号 → 登录；批量重置 → 新密码可登录、旧密码失效、旧会话被踢", async () => {
  const bulk = await admin.post("/api/admin/employees/bulk", {
    rows: [{ employeeId: "HC-001", name: "Hash One" }, { employeeId: "HC-002", name: "Hash Two" }], programIds: [],
  });
  assert.equal(bulk.status, 200);
  const [a, b] = bulk.data.results;
  assert.equal(a.status, "created");
  // 存储格式：16 字节盐 hex + ":" + 32 字节哈希 hex（与 hashPassword 逐字同构）。
  const stored = dbq(srv.dbPath, (db) => db.prepare("SELECT passwordHash FROM users WHERE employeeId = 'HC-001'").get().passwordHash);
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  const ca = await loginAs(srv.base, { employeeId: "HC-001", password: a.password });
  await loginAs(srv.base, { employeeId: "HC-002", password: b.password });
  assert.equal((await ca.get("/api/me")).status, 200);

  const roster = await rosterByEmpId(admin);
  const ids = [roster.get("HC-001").id, roster.get("HC-002").id];
  const reset = await admin.post("/api/admin/employees/bulk-reset", { userIds: ids });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.count, 2);
  const byEmp = new Map(reset.data.issued.map((x) => [x.employeeId, x]));
  assert.equal((await ca.get("/api/me")).status, 401, "重置后旧会话应被吊销");
  assert.equal((await makeClient(srv.base).login({ employeeId: "HC-001", password: a.password })).status, 401, "旧密码应失效");
  for (const emp of ["HC-001", "HC-002"]) {
    const r = await makeClient(srv.base).login({ employeeId: emp, password: byEmp.get(emp).password });
    assert.equal(r.status, 200, emp + " 新密码应可登录");
  }
});

test("查重：批内重复邮箱（大小写不同）、库内已有邮箱、批内/库内重复工号都逐行 skipped", async () => {
  const first = await admin.post("/api/admin/employees/bulk", {
    rows: [{ employeeId: "EM-001", name: "Mail Owner", email: "owner@dup.test" }], programIds: [],
  });
  assert.equal(first.data.results[0].status, "created");
  const r = await admin.post("/api/admin/employees/bulk", {
    rows: [
      { employeeId: "EM-010", name: "Batch A", email: "Same@Batch.test" },
      { employeeId: "EM-011", name: "Batch B", email: " same@batch.TEST " },   // 批内重复（规范化后相同）
      { employeeId: "EM-012", name: "Db Dup", email: "OWNER@dup.test" },       // 库内已有
      { employeeId: "em-010", name: "Id Dup" },                                // 批内工号重复（大小写不同）
      { employeeId: "EM-001", name: "Id Db Dup" },                             // 库内工号重复
      { employeeId: "EM-013", name: "Fine", email: "fine@batch.test" },
    ],
    programIds: [],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const st = r.data.results.map((x) => [x.employeeId, x.status, x.reason || ""]);
  assert.deepEqual(st.map((x) => x[1]), ["created", "skipped", "skipped", "skipped", "skipped", "created"]);
  assert.equal(st[1][2], "email already used by EM-010");
  assert.equal(st[2][2], "email already used by EM-001");
  assert.equal(st[3][2], "already exists");
  assert.equal(st[4][2], "already exists");
});

test("并发的两次同名单导入：查重在事务内重做，不会建出重复账号", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ employeeId: "CC-" + String(i).padStart(3, "0"), name: "Conc " + i, email: `conc${i}@race.test` }));
  const [x, y] = await Promise.all([
    admin.post("/api/admin/employees/bulk", { rows, programIds: [] }),
    admin.post("/api/admin/employees/bulk", { rows, programIds: [] }),
  ]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  const created = [...x.data.results, ...y.data.results].filter((r) => r.status === "created").length;
  assert.equal(created, 30, "两批合计恰好建 30 人");
  const n = dbq(srv.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE employeeId LIKE 'CC-%'").get().n);
  assert.equal(n, 30);
});

test("索引：migration 47 已应用，按 lower(employeeId) 查人走表达式索引", () => {
  dbq(srv.dbPath, (db) => {
    const versions = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
    assert.ok(versions.includes(47), "migration 47 applied");
    for (const sql of [
      "SELECT * FROM users WHERE lower(employeeId) = lower(?)",   // store.getUserByEmployeeId
      "SELECT 1 FROM users WHERE lower(employeeId) = lower(?)",   // store.employeeIdExists
    ]) {
      const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all("PF-0001").map((r) => r.detail).join(" | ");
      assert.match(plan, /idx_users_lower_empid/, `${sql} 应使用表达式索引，实际计划: ${plan}`);
    }
  });
});

test("请求体：非批量路径超 2,000,000 → 413 body_too_large 双语；匿名打批量路径同样 413", async () => {
  const big = JSON.stringify({ employeeId: "X", password: "y", pad: "a".repeat(2_100_000) });
  const r1 = await fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: big });
  assert.equal(r1.status, 413);
  const d1 = await r1.json();
  assert.equal(d1.code, "body_too_large");
  assertBilingual(d1.error);
  // 匿名请求不享受批量路径的放宽上限。
  const r2 = await fetch(srv.base + "/api/admin/employees/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: big });
  assert.equal(r2.status, 413);
  assert.equal((await r2.json()).code, "body_too_large");
  // 服务还活着，普通请求照常。
  assert.equal((await fetch(srv.base + "/api/env")).status, 200);
});

test("请求体：后台账号的批量路径可超 2,000,000（默认上限 20MB），跨 chunk 中文不乱码", async () => {
  // ~3MB：一行有效数据 + 大量无效行（工号格式非法 → 逐行 skipped，不算哈希），
  // 名字是中文，逐行回显 —— 64KB chunk 边界切开多字节字符时，老的 raw += chunk 会出 U+FFFD。
  // 行数压在默认 LMS_BULK_CAP（10000）之内，靠长中文名把请求体撑到 2MB 以上。
  const name = "测试员工甲乙丙丁戊己庚辛壬癸".repeat(12);
  const rows = [{ employeeId: "BIG-001", name: "大请求体" }];
  for (let i = 0; i < 9990; i++) rows.push({ employeeId: "!", name: name + i, department: "填充部门名称" + (i % 7), note: "备注".repeat(30) });
  const body = JSON.stringify({ rows, programIds: [] });
  assert.ok(body.length > 2_000_000, "请求体应超过老上限: " + body.length);
  const r = await admin.post("/api/admin/employees/bulk", { rows, programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  assert.equal(r.data.results[0].status, "created");
  assert.equal(r.data.results[0].name, "大请求体");
  const bad = r.data.results.slice(1).filter((x, i) => x.name !== name + i);
  assert.equal(bad.length, 0, "中文名被解坏: " + JSON.stringify(bad.slice(0, 3)));
});

// ======================= 服务 B：故障注入 + 小的批量上限 =======================
test("原子性：五个批量接口第 3 行抛异常 → 整批回滚、batch_failed + 行号、无任何副作用", async (t) => {
  const b = await startServer({ env: { LMS_TEST_FAIL_BULK_AT: "3", LMS_BULK_BODY_MAX: "1000000" } });
  t.after(() => b.stop());
  const adm = await loginAs(b.base, ADMIN);

  // 准备：两行一批建 6 个人（行数 < 3，不触发注入）。
  const pw = {};
  for (let k = 0; k < 3; k++) {
    const rows = [1, 2].map((j) => { const n = k * 2 + j; return { employeeId: "FB-0" + n, name: "Fault " + n, email: `fb${n}@fault.test`, department: "Fault Dept" }; });
    const r = await adm.post("/api/admin/employees/bulk", { rows, programIds: [] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (const x of r.data.results) { assert.equal(x.status, "created"); pw[x.employeeId] = x.password; }
  }
  // 逐行校验问题照旧 skipped、不回滚（2 行，不触发注入）。
  const mixed = await adm.post("/api/admin/employees/bulk", { rows: [{ employeeId: "FB-OK1", name: "Ok" }, { employeeId: "FB-BAD", name: "Bad", hireDate: "2026-13-45" }], programIds: [] });
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.data.results.map((x) => x.status), ["created", "skipped"]);

  const assertFailed = (r, label) => {
    assert.equal(r.status, 500, `${label}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, "batch_failed", label);
    assert.equal(r.data.line, 3, label);
    assertBilingual(r.data.error);
    assert.ok(!Array.isArray(r.data.results), label + " 不得夹带部分 results");
    // 原始异常文本只进服务端 stderr（[batch-tx] batch_failed …），不回给调用方。
    assert.ok(!("detail" in r.data), label + " 响应不应带 detail");
    assert.ok(!/injected|LMS_TEST_FAIL_BULK_AT/.test(JSON.stringify(r.data)), label + " 响应不应含原始异常文本");
  };

  // employees/bulk
  let before0 = counts(b.dbPath);
  const e = await adm.post("/api/admin/employees/bulk", {
    rows: [1, 2, 3, 4, 5].map((n) => ({ employeeId: "RB-00" + n, name: "Rollback " + n, department: "Rollback Dept " + n, email: `rb${n}@fault.test` })),
  });
  assertFailed(e, "employees/bulk");
  assert.deepEqual(counts(b.dbPath), before0, "employees/bulk 回滚后库应与之前逐项相同");
  const deps = dbq(b.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM departments WHERE name LIKE 'Rollback Dept%'").get().n);
  assert.equal(deps, 0, "事务里 ensureDepartment 建的部门也应回滚");

  // employees/bulk-reset：先让 FB-01..03 登录，持有会话。
  const sess = [];
  for (const emp of ["FB-01", "FB-02", "FB-03"]) sess.push(await loginAs(b.base, { employeeId: emp, password: pw[emp] }));
  const roster = await rosterByEmpId(adm);
  before0 = counts(b.dbPath);
  const rs = await adm.post("/api/admin/employees/bulk-reset", { userIds: ["FB-01", "FB-02", "FB-03", "FB-04"].map((x) => roster.get(x).id) });
  assertFailed(rs, "employees/bulk-reset");
  assert.deepEqual(counts(b.dbPath), before0, "bulk-reset 回滚后：密码哈希、会话、审计都不变");
  for (const c of sess) assert.equal((await c.get("/api/me")).status, 200, "回滚时不应吊销任何会话");
  assert.equal((await makeClient(b.base).login({ employeeId: "FB-04", password: pw["FB-04"] })).status, 200, "旧密码仍有效");

  // records/bulk
  before0 = counts(b.dbPath);
  const rec = await adm.post("/api/admin/records/bulk", {
    rows: ["FB-01", "FB-02", "FB-03", "FB-04"].map((employeeId, i) => ({ employeeId, type: "荣誉", date: "2026-07-01", title: "rb-" + i, fields: { awardName: "rb-" + i } })),
  });
  assertFailed(rec, "records/bulk");
  assert.deepEqual(counts(b.dbPath), before0, "records/bulk 回滚");

  // secondary-lines/bulk
  before0 = counts(b.dbPath);
  const nextSL0 = dbq(b.dbPath, (db) => (db.prepare("SELECT value FROM meta WHERE key = 'nextSL'").get() || {}).value || null);
  const sec = await adm.post("/api/admin/secondary-lines/bulk", {
    rows: ["FB-01", "FB-02", "FB-03", "FB-04"].map((employeeId) => ({ employeeId, kind: "dotted", managerEmployeeId: "FB-05", department: "Sec Rollback Dept" })),
  });
  assertFailed(sec, "secondary-lines/bulk");
  assert.deepEqual(counts(b.dbPath), before0, "secondary-lines/bulk 回滚");
  assert.equal(dbq(b.dbPath, (db) => (db.prepare("SELECT value FROM meta WHERE key = 'nextSL'").get() || {}).value || null), nextSL0, "id 计数器也回滚");

  // questions/bulk
  const courseId = dbq(b.dbPath, (db) => db.prepare("SELECT id FROM content WHERE kind = 'course' LIMIT 1").get().id);
  before0 = counts(b.dbPath);
  const q = await adm.post("/api/admin/questions/bulk", {
    courseId, items: [1, 2, 3, 4].map((n) => ({ type: "open", question: "Rollback question " + n, rubric: "r" })),
  });
  assertFailed(q, "questions/bulk");
  assert.deepEqual(counts(b.dbPath), before0, "questions/bulk 回滚");

  // 回滚之后服务照常可写（事务状态已清理干净）。
  const ok = await adm.post("/api/admin/employees/bulk", { rows: [{ employeeId: "FB-AFTER", name: "After" }], programIds: [] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.results[0].status, "created");

  // 批量路径的上限可调：LMS_BULK_BODY_MAX=1000000 → 1.2MB 的批量请求 413。
  const big = { rows: [{ employeeId: "BIG-X", name: "x".repeat(1_200_000) }], programIds: [] };
  const r413 = await adm.post("/api/admin/employees/bulk", big);
  assert.equal(r413.status, 413);
  assert.equal(r413.data.code, "body_too_large");
  assertBilingual(r413.data.error);
});

