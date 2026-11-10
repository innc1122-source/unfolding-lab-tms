// 批量导入异步哈希窗口期的竞态回归（第一轮对抗复核补充）。
//
// employees/bulk 先在事务外用线程池算哈希（可能持续几十秒），再进同步事务写库。这段
// 窗口期里别的请求照常执行，所以：
//   1. 调用者的会话在窗口期被吊销 → 进事务前重新核对，401 session_changed（双语），
//      一个账号都不建、不写导入审计；
//   2. 窗口期里有人单个建了同工号的人 → 事务内重新查重，那一行逐行 skipped，
//      其余照建，单个建的那个账号不受影响（密码仍可登录）；
//   3. 故障注入开关 LMS_TEST_FAIL_BULK_AT 只在库位于系统临时目录时生效：把子进程的
//      临时目录指到别处（库不在其中）→ 开关无效，第 3 行照常写入。
//
// 全部跑在临时库（LMS_DB_PATH）与临时 config（LMS_CONFIG_PATH）上，不碰仓库根的
// lms.db / config.json。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer: startRaw, loginAs, makeClient, tempDir } = require("./helpers.js");

function startServer(opts = {}) {
  const cfg = path.join(tempDir("lms-bulkrace-cfg-"), "config.json");
  return startRaw({ ...opts, env: { LMS_CONFIG_PATH: cfg, ...(opts.env || {}) } });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dbq(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const rowsOf = (prefix, n) => Array.from({ length: n }, (_, i) => ({ employeeId: `${prefix}-${String(i).padStart(4, "0")}`, name: `${prefix} ${i}` }));

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

test("窗口期会话被吊销 → 401 session_changed 双语，一行不写、无导入审计", async () => {
  const a1 = await loginAs(srv.base, ADMIN);
  const bulkP = a1.post("/api/admin/employees/bulk", { rows: rowsOf("RV", 150), programIds: [] });
  await sleep(300);                                   // 此时仍在线程池里算哈希
  const out = await a1.post("/api/auth/logout", {});
  assert.equal(out.status, 200);
  const r = await bulkP;
  assert.equal(r.status, 401, JSON.stringify(r.data).slice(0, 300));
  assert.equal(r.data.code, "session_changed");
  assert.ok(/[一-鿿]/.test(r.data.error) && /[A-Za-z]/.test(r.data.error), "双语: " + r.data.error);
  const n = dbq(srv.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE employeeId LIKE 'RV-%'").get().n);
  assert.equal(n, 0);
  const aud = dbq(srv.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'employee.bulk-import'").get().n);
  assert.equal(aud, 0);
});

test("窗口期有人单个建了同工号 → 该行 skipped，其余照建，单建账号不受影响", async () => {
  const bulkAdmin = await loginAs(srv.base, ADMIN);
  const other = await loginAs(srv.base, ADMIN);
  const rows = rowsOf("SC", 150);
  const bulkP = bulkAdmin.post("/api/admin/employees/bulk", { rows, programIds: [] });
  await sleep(300);
  const single = await other.post("/api/admin/employees", { name: "Single Racer", employeeId: "SC-0042" });
  assert.equal(single.status, 200, JSON.stringify(single.data));
  const r = await bulkP;
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const byEmp = new Map(r.data.results.map((x) => [x.employeeId, x]));
  assert.equal(byEmp.get("SC-0042").status, "skipped");
  assert.equal(byEmp.get("SC-0042").reason, "already exists");
  assert.equal(r.data.results.filter((x) => x.status === "created").length, 149);
  const n = dbq(srv.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE employeeId LIKE 'SC-%'").get().n);
  assert.equal(n, 150);
  const login = await makeClient(srv.base).login({ employeeId: "SC-0042", password: single.data.password });
  assert.equal(login.status, 200, "单个建号返回的密码应仍然有效");
});

test("故障注入开关：库不在系统临时目录之内时无效", async (t) => {
  const fake = tempDir("lms-bulkrace-faketmp-");
  // 子进程的 os.tmpdir() 指向 fake；库仍由 helpers 建在真正的临时目录下（不在 fake 里）。
  const b = await startServer({ env: { LMS_TEST_FAIL_BULK_AT: "3", TEMP: fake, TMP: fake, TMPDIR: fake } });
  t.after(() => b.stop());
  const adm = await loginAs(b.base, ADMIN);
  const r = await adm.post("/api/admin/employees/bulk", { rows: rowsOf("GT", 4), programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  assert.deepEqual(r.data.results.map((x) => x.status), ["created", "created", "created", "created"]);
});
