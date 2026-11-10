// 上线前全覆盖 M 组（员工组织、设置、审计，10/11）：
//   CX-127 部门列表人数只计在职（已离职不计）；删除校验仍按全部档案，报错写明含已离职、中英文分开（CX-131）；
//   CX-129 员工批量导入逐行原因 / 提示带中文（reason_zh / warning_zh）；
//   CX-131 新增重名部门、职级表报错中英文分开；
//   CX-135 晋升记录缺原职级时标题写「— → PD1」；
//   CX-137 记录类型、同类型字段不能重名；CX-139 人才记录 CSV 导出写审计。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const one = (sql, ...a) => { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const idOf = async (eid) => (await admin.get("/api/admin/roster")).data.find((u) => u.employeeId === eid).id;
before(async () => { srv = await startServer(); admin = await loginAs(srv.base, ADMIN); });
after(async () => { if (srv) await srv.stopAsync(); });

test("CX-127 / CX-131: department headcount counts people in service only; deleting is still refused while former employees remain, with a separate Chinese message", async () => {
  const d = await admin.post("/api/admin/departments", { name: "CXM Dept" });
  assert.equal(d.status, 200);
  for (const e of ["CXM-1", "CXM-2"]) {
    assert.equal((await admin.post("/api/admin/employees", { name: "Name " + e, employeeId: e })).status, 200);
    assert.equal((await admin.put("/api/admin/employees/" + (await idOf(e)), { department: "CXM Dept" })).status, 200);
  }
  assert.equal((await admin.put("/api/admin/employees/" + (await idOf("CXM-2")), { empStatus: "exited" })).status, 200);
  const row = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "CXM Dept");
  assert.equal(row.headcount, 1, "the former employee is not counted");
  const del = await admin.del("/api/admin/departments/" + row.id);
  assert.equal(del.status, 400);
  assert.equal(del.data.code, "occupied");
  assert.match(del.data.error_zh, /含已离职员工/);
  assert.ok(!/[一-鿿]/.test(del.data.error), "English message has no Chinese appended");
  const dup = await admin.post("/api/admin/departments", { name: "CXM Dept" });
  assert.equal(dup.status, 400);
  assert.equal(dup.data.code, "dept_exists");
  assert.equal(dup.data.error_zh, "部门已存在。");
});

test("CX-129: bulk import reasons and warnings come with Chinese text", async () => {
  const r = await admin.post("/api/admin/employees/bulk", { rows: [
    { employeeId: "CXM-1", name: "Dup" },
    { employeeId: "CXM-NEW", name: "New One", managerEmployeeId: "T-99999" },
    { employeeId: "CXM-BAD", name: "Bad Mail", email: "not-an-email" },
    { employeeId: "CXM-NONAME", name: "" },
  ], programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const by = Object.fromEntries(r.data.results.map((x) => [x.employeeId, x]));
  assert.equal(by["CXM-1"].reason_zh, "工号已存在");
  assert.equal(by["CXM-BAD"].reason_zh, "邮箱格式无效");
  assert.equal(by["CXM-NONAME"].reason_zh, "缺少姓名或工号");
  assert.equal(by["CXM-NEW"].status, "created");
  assert.equal(by["CXM-NEW"].warning_zh, "直属上级「T-99999」不存在，已留空");
});

test("CX-135: a promotion record without the previous level is titled with a dash, not a question mark", async () => {
  const uid = await idOf("CXM-1");
  const r = await admin.post("/api/admin/employees/" + uid + "/records", { type: "promotion", date: "2026-10-01", fields: { toLevel: "PD1", result: "Passed" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = one("SELECT title FROM talent_records WHERE userId = ? AND type = 'promotion' ORDER BY rowid DESC LIMIT 1", uid).title;
  assert.equal(t, "— → PD1");
});

test("CX-137: record types and fields within a type cannot share a name", async () => {
  const t1 = await admin.post("/api/admin/config/record-types", { label: "CXM Type", label_zh: "测试类型" });
  assert.equal(t1.status, 200, JSON.stringify(t1.data));
  const t2 = await admin.post("/api/admin/config/record-types", { label: "cxm type" });
  assert.equal(t2.status, 400);
  assert.equal(t2.data.code, "type_name_taken");
  const t3 = await admin.post("/api/admin/config/record-types", { label: "Another", label_zh: "测试类型" });
  assert.equal(t3.data.code, "type_name_taken");
  const key = (t1.data.type || t1.data).key;
  assert.ok(key, JSON.stringify(t1.data));
  const resave = await admin.post("/api/admin/config/record-types", { key, label: "CXM Type", label_zh: "测试类型", color: "#123456" });
  assert.equal(resave.status, 200, "saving the type itself is not a clash");
  const f1 = await admin.post("/api/admin/config/record-fields", { typeKey: key, label: "Witness", input: "text" });
  assert.equal(f1.status, 200, JSON.stringify(f1.data));
  const f2 = await admin.post("/api/admin/config/record-fields", { typeKey: key, label: "witness", input: "text" });
  assert.equal(f2.status, 400);
  assert.equal(f2.data.code, "field_name_taken");
});

test("CX-139: exporting talent records as CSV is audited", async () => {
  const before = one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'export.records-csv'").n;
  const r = await admin.raw("GET", "/api/admin/export/records.csv");
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'export.records-csv'").n, before + 1);
});
