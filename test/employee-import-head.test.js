// 员工批量导入第 6 列「部门负责人」（2026-10-06 负责人决定）：
//   - 真值（是 / Y / 1 / true）→ 该员工成为所在部门（departments.ownerId）的负责人；
//   - 没有部门的行带该标记 → 仍创建，但 warning 里说明忽略；
//   - 其他行不受影响；GET /api/admin/departments 的 ownerName 随之更新。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
before(async () => { srv = await startServer(); admin = await loginAs(srv.base, ADMIN); });
after(() => srv.stop());

test("employees/bulk: 部门负责人 column sets departments.ownerId", async () => {
  const dept = "Head Import Test Dept";
  const r = await admin.post("/api/admin/employees/bulk", { programIds: [], rows: [
    { employeeId: "HI-001", name: "Head One", department: dept, deptHead: true },
    { employeeId: "HI-002", name: "Member Two", department: dept },
    { employeeId: "HI-003", name: "No Dept", deptHead: "是" },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const results = r.data.results;
  assert.equal(results.filter((x) => x.status === "created").length, 3);
  assert.match(String(results.find((x) => x.employeeId === "HI-003").warning || ""), /department head flag ignored/);
  const deps = (await admin.get("/api/admin/departments")).data;
  const d = deps.find((x) => x.name === dept);
  assert.ok(d, "department auto-created by import");
  assert.equal(d.ownerName, "Head One");
  assert.equal(d.ownerEmployeeId, "HI-001");
});
