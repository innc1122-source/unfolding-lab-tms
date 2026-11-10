// P0 1.5（负责人 2026-10-07，docs/REQ-20261007-consolidated.md 一）：评估周期按部门筛选时包含下级部门。
//   发起 / 预览：departmentId（部门 id 或 "name:<部门名>" 伪选项）优先于 department（部门名，继续兼容），选上级部门 = 含全部下级
//   （org.js chainOf / descendantIdsOf，全深度、集团层不算祖先）；响应带 noLevel 与 deptOptions。
//   详情：items[].deptPath（一级 → 本部门的 id 链）与顶层 deptOptions，前端按 deptPath.includes(id) 筛选。
// 部门树：RF Finance > RF AP > RF AP Payables > RF Deep（第四级）。用临时服务器（test/helpers.js），不碰 lms.db。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const dept = {};   // 部门名 → id
const emp = {};    // 工号 → user id
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["RF Finance", null], ["RF AP", "RF Finance"], ["RF AP Payables", "RF AP"], ["RF Deep", "RF AP Payables"], ["RF Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    dept[name] = r.data.department.id;
  }
  // RF-1 是 Finance 唯一的顶端（其余人都向他汇报）→ v2 推算出的 HoD；RF-4 的部门写成小写变体；RF-NL 没有职级；
  // RF-L 的部门名随后从部门表删掉（模拟历史数据 / 同步留下的旧部门名）→ "name:" 伪选项
  const rows = [
    ["RF-1", "RF Finance", "PB3", null], ["RF-2", "RF AP", "PB2", "RF-1"], ["RF-3", "RF AP Payables", "PB2", "RF-1"],
    ["RF-4", "rf ap", "PB2", "RF-1"], ["RF-5", "RF Deep", "PB2", "RF-1"], ["RF-NL", "RF AP Payables", "", "RF-1"],
    ["RF-9", "RF Other", "PB2", null], ["RF-L", "RF Legacy", "PB2", null],
  ];
  const r = await admin.post("/api/admin/employees/bulk", {
    rows: rows.map(([employeeId, department, jobLevel, managerEmployeeId]) => ({ employeeId, name: "N " + employeeId, department, jobLevel, ...(managerEmployeeId ? { managerEmployeeId } : {}) })),
    programIds: [],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const u of (await admin.get("/api/admin/employees")).data) emp[u.employeeId] = u.id;
  // 接口删不掉有人的部门：停服后直接改测试库（只动这次的临时库），再用同一个库重启
  await srv.stopAsync();
  const db = new DatabaseSync(srv.dbPath);
  db.prepare("DELETE FROM departments WHERE name = ?").run("RF Legacy");
  db.close();
  srv = await startServer({ dbPath: srv.dbPath });
  admin = await loginAs(srv.base, ADMIN);
  assert.ok(!(await admin.get("/api/admin/departments")).data.some((d) => d.name === "RF Legacy"), "RF Legacy 不在部门表");
});
after(() => srv.stop());

const dry = (body) => admin.post("/api/admin/review-cycles", { dryRun: true, ...body });

test("preview by name or by id includes every sub-department (4 levels deep), legacy flow", async () => {
  for (const sel of [{ department: "RF Finance" }, { department: "rf finance" }, { departmentId: dept["RF Finance"] }]) {
    const r = await dry(sel);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.participants, 5, JSON.stringify(sel) + " → RF-1..RF-5（修复前只有 RF-1）");
    assert.equal(r.data.skippedNoLevel, 1);
    assert.equal(r.data.noLevel, 1);
    assert.equal(r.data.excludedHods, 0, "旧流程不排除 HoD");
  }
  const ap = await dry({ departmentId: dept["RF AP"] });
  assert.equal(ap.data.participants, 4, "RF AP 及以下：RF-2、RF-3、RF-4（小写变体）、RF-5");
  const deep = await dry({ departmentId: dept["RF Deep"] });
  assert.equal(deep.data.participants, 1);
  assert.equal(deep.data.noLevel, 0);
});

test("preview v2: the derived HoD is excluded, so participants + excludedHods = the subtree; noLevel counts after the HoD exclusion", async () => {
  const r = await dry({ flow: "v2", departmentId: dept["RF Finance"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.excludedHods, 1);
  assert.deepEqual(r.data.excludedHodNames, ["N RF-1"]);
  assert.equal(r.data.participants + r.data.excludedHods, 5);
  assert.equal(r.data.noLevel, 1);
  const inc = await dry({ flow: "v2", departmentId: dept["RF Finance"], includeNoLevel: true });
  assert.equal(inc.data.participants, r.data.participants + r.data.noLevel, "勾选「包含无职级」增加的人数 = noLevel");
});

test("unknown departmentId → 400 dept_not_found; 'name:' pseudo ids and legacy names match by name", async () => {
  for (const departmentId of ["nope", "name:", "name:   "]) {
    const r = await dry({ departmentId });
    assert.equal(r.status, 400, departmentId);
    assert.equal(r.data.code, "dept_not_found");
    assert.match(r.data.error, /Department not found\. 未找到该部门。/);
  }
  assert.equal((await dry({ departmentId: "name:rf legacy" })).data.participants, 1);
  assert.equal((await dry({ department: "RF Legacy" })).data.participants, 1);
  // 部门选项：全部在职员工的部门链 + 伪选项，按链逐段排序（父级在子级前）
  const opts = (await dry({})).data.deptOptions.filter((o) => /^RF|^name:rf/i.test(o.name));
  assert.deepEqual(opts.map((o) => [o.path, o.level]), [
    ["RF Finance", 1], ["RF Finance › RF AP", 2], ["RF Finance › RF AP › RF AP Payables", 3],
    ["RF Finance › RF AP › RF AP Payables › RF Deep", 4], ["RF Legacy", null], ["RF Other", 1],
  ]);
  const byPath = Object.fromEntries(opts.map((o) => [o.path, o]));
  assert.equal(byPath["RF Finance › RF AP"].parentId, dept["RF Finance"]);
  assert.equal(byPath["RF Finance › RF AP › RF AP Payables › RF Deep"].parentId, dept["RF AP Payables"]);
  assert.deepEqual(byPath["RF Legacy"], { id: "name:rf legacy", name: "RF Legacy", parentId: null, path: "RF Legacy", level: null });
});

test("launch (legacy) by departmentId: the cycle holds the whole subtree; the response carries noLevel and deptOptions", async () => {
  const r = await admin.post("/api/admin/review-cycles", { name: "RF legacy", departmentId: dept["RF Finance"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.participants, 5);
  assert.equal(r.data.noLevel, 1);
  assert.ok(Array.isArray(r.data.deptOptions) && r.data.deptOptions.length >= 6);
  const d = (await admin.get(`/api/admin/review-cycles/${r.data.cycle.id}`)).data;
  assert.deepEqual(d.items.map((i) => i.employeeId).sort(), ["RF-1", "RF-2", "RF-3", "RF-4", "RF-5"]);
  const path = (e) => d.items.find((i) => i.employeeId === e).deptPath;
  assert.deepEqual(path("RF-5"), [dept["RF Finance"], dept["RF AP"], dept["RF AP Payables"], dept["RF Deep"]], "第四级的链长度为 4");
  assert.deepEqual(path("RF-4"), [dept["RF Finance"], dept["RF AP"]], "小写变体归到 RF AP");
  assert.deepEqual(path("RF-1"), [dept["RF Finance"]]);
  assert.ok(d.items.every((i) => i.hrCalibratable === true));
  assert.deepEqual(d.deptOptions.map((o) => o.path), ["RF Finance", "RF Finance › RF AP", "RF Finance › RF AP › RF AP Payables", "RF Finance › RF AP › RF AP Payables › RF Deep"]);
  // 前端的筛选口径：deptPath.includes(选中的 id)
  const under = (id) => d.items.filter((i) => i.deptPath.includes(id)).map((i) => i.employeeId).sort();
  assert.deepEqual(under(dept["RF AP"]), ["RF-2", "RF-3", "RF-4", "RF-5"]);
  assert.deepEqual(under(dept["RF AP Payables"]), ["RF-3", "RF-5"]);
});

test("v2 detail: deptPath for a department outside the table is the 'name:' pseudo id, and deptOptions offers it", async () => {
  const r = await admin.post("/api/admin/review-cycles", { name: "RF v2", flow: "v2", userIds: ["RF-2", "RF-5", "RF-L"].map((e) => emp[e]) });   // RF-9 是 RF Other 唯一的人 = HoD，v2 不收
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = (await admin.get(`/api/admin/review-cycles/${r.data.cycle.id}`)).data;
  const it = (e) => d.items.find((i) => i.employeeId === e);
  assert.deepEqual(it("RF-L").deptPath, ["name:rf legacy"]);
  assert.equal(it("RF-L").dept1Id, "__none");
  assert.deepEqual(it("RF-2").deptPath, [dept["RF Finance"], dept["RF AP"]]);
  assert.deepEqual(d.deptOptions.map((o) => o.id), [dept["RF Finance"], dept["RF AP"], dept["RF AP Payables"], dept["RF Deep"], "name:rf legacy"]);
  assert.deepEqual(d.items.filter((i) => i.deptPath.includes("name:rf legacy")).map((i) => i.employeeId), ["RF-L"]);
});
