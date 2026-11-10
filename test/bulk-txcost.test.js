// 批量导入「同步事务阶段」的成本回归测试（第二轮复核：性能与并发）。
//
// 事务是同步的，执行期间事件循环被占住。4,000 行员工导入的事务阶段原来要 0.75–1.4 秒，
// 剖析显示大半花在每行重复 db.prepare() 编译同几条 SQL（getUserById / createUser /
// getDepartmentByName）上；现在 store.js 用 stmt() 缓存预编译语句，employees/bulk 每批
// 每个部门名只登记一次，4,000 行降到约 0.15 秒。这里锁住：
//   1. records/bulk 3,000 行（无哈希）事务阶段 < 2 秒（服务端 [batch-tx] 日志，
//      LMS_BULK_TIMING=1），全部创建；同一批再导一次全部按 duplicate 逐行 skipped。
//   2. employees/bulk 同一批里大小写不同的同名部门只建一个部门节点。
//   3. 缓存的预编译语句在整批回滚之后照常可用（回滚后紧接着一批成功）。
//
// 测试服一律指向临时库与临时 config，绝不读写仓库根的 lms.db / config.json。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer: startRaw, loginAs, tempDir } = require("./helpers.js");

function startServer(opts = {}) {
  const cfg = path.join(tempDir("lms-txcost-cfg-"), "config.json");
  return startRaw({ ...opts, env: { LMS_CONFIG_PATH: cfg, LMS_BULK_TIMING: "1", ...(opts.env || {}) } });
}
function dbq(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
// 收集服务端 stderr 里的 [batch-tx] 行
function txLog(srv) {
  const lines = [];
  let buf = "";
  srv.child.stderr.on("data", (d) => {
    buf += d;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const l of parts) if (l.startsWith("[batch-tx]")) lines.push(l);
  });
  return lines;
}

let srv, admin, tx;
before(async () => {
  srv = await startServer();
  tx = txLog(srv);
  admin = await loginAs(srv.base, ADMIN);
});
after(() => srv.stop());

test("records/bulk 3,000 行：事务阶段 < 2 秒，全部创建；重导全部 duplicate", async () => {
  const people = Array.from({ length: 20 }, (_, i) => "TC-" + String(i).padStart(3, "0"));
  const mk = await admin.post("/api/admin/employees/bulk", {
    rows: people.map((employeeId, i) => ({ employeeId, name: "Tx " + i, department: "Tx Dept" })), programIds: [],
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.data));
  assert.equal(mk.data.results.filter((r) => r.status === "created").length, 20);

  const rows = Array.from({ length: 3000 }, (_, i) => ({
    employeeId: people[i % 20], type: "荣誉", date: "2026-07-01", title: "tx-" + i, fields: { awardName: "tx-" + i },
  }));
  tx.length = 0;
  const r1 = await admin.post("/api/admin/records/bulk", { rows });
  assert.equal(r1.status, 200, JSON.stringify(r1.data).slice(0, 300));
  assert.equal(r1.data.results.filter((r) => r.status === "created").length, 3000);
  // 等 stderr 送达
  for (let k = 0; k < 50 && !tx.length; k++) await new Promise((r) => setTimeout(r, 20));
  const m = (tx[0] || "").match(/^\[batch-tx\] commit 3000 rows in (\d+)ms/);
  assert.ok(m, "应有 [batch-tx] 提交日志，实际: " + JSON.stringify(tx));
  assert.ok(Number(m[1]) < 2000, `3,000 行的同步事务阶段应 < 2 秒，实际 ${m[1]}ms`);

  const r2 = await admin.post("/api/admin/records/bulk", { rows });
  assert.equal(r2.status, 200);
  assert.ok(r2.data.results.every((r) => r.status === "skipped" && /duplicate/.test(r.reason)), "重导应全部 duplicate");
  const n = dbq(srv.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM talent_records WHERE title LIKE 'tx-%'").get().n);
  assert.equal(n, 3000);
});

test("employees/bulk：同批大小写不同的同名部门只建一个部门节点", async () => {
  const before = dbq(srv.dbPath, (db) => db.prepare("SELECT COUNT(*) AS n FROM departments WHERE lower(name) = 'case dept'").get().n);
  assert.equal(before, 0);
  const r = await admin.post("/api/admin/employees/bulk", {
    rows: [
      { employeeId: "CD-001", name: "Case 1", department: "Case Dept" },
      { employeeId: "CD-002", name: "Case 2", department: "case dept" },
      { employeeId: "CD-003", name: "Case 3", department: "Case Dept" },
    ], programIds: [],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.results.filter((x) => x.status === "created").length, 3);
  const depts = dbq(srv.dbPath, (db) => db.prepare("SELECT name FROM departments WHERE lower(name) = 'case dept'").all());
  assert.deepEqual(depts.map((d) => d.name), ["Case Dept"]);
});

test("整批回滚之后，缓存的预编译语句照常可用", async () => {
  const s2 = await startServer({ env: { LMS_TEST_FAIL_BULK_AT: "3" } });
  try {
    const a2 = await loginAs(s2.base, ADMIN);
    const bad = await a2.post("/api/admin/employees/bulk", {
      rows: ["RB-001", "RB-002", "RB-003", "RB-004"].map((employeeId, i) => ({ employeeId, name: "Rb " + i, department: "Rb Dept" })),
      programIds: [],
    });
    assert.equal(bad.status, 500);
    assert.equal(bad.data.code, "batch_failed");
    assert.equal(bad.data.line, 3);
    assert.ok(!("detail" in bad.data), "batch_failed 响应不应带 detail");
    const ok = await a2.post("/api/admin/employees/bulk", {
      rows: ["RB-001", "RB-002"].map((employeeId, i) => ({ employeeId, name: "Rb " + i, department: "Rb Dept" })),
      programIds: [],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.results.map((x) => x.status), ["created", "created"]);
    const pw = ok.data.results[0].password;
    const login = await fetch(s2.base + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeId: "RB-001", password: pw }),
    });
    assert.equal(login.status, 200);
    const d = dbq(s2.dbPath, (db) => ({
      users: db.prepare("SELECT COUNT(*) AS n FROM users WHERE employeeId LIKE 'RB-%'").get().n,
      depts: db.prepare("SELECT COUNT(*) AS n FROM departments WHERE name = 'Rb Dept'").get().n,
    }));
    assert.deepEqual(d, { users: 2, depts: 1 });
  } finally {
    s2.stop();
  }
});
