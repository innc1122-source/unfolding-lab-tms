// 12.2 关键岗位清单（设计 b12-design 第 4 节）HTTP 契约：
//   · 增删改查：talent 读只能 GET（写 403）；没有 talent 404；新部门越界 400 dept_out_of_scope；行越界 404；
//     同键（大小写、空格、连字符差异）409 position_exists；校验码；审计 keyposition.create / update / delete / import；
//   · GET：范围内的行、每行范围内在职继任者的覆盖数与在任人数、继任计划里有而清单没有的岗位；
//   · 导入：预览 → 提交（previewHash），预览后数据变了 409 preview_stale，有越界行整批拒绝（一行不写），「从继任计划带入」；
//   · 继任页 vacancies / keyRoleCount：清单里有关键岗位时改用清单，清空后回到「有直属下属即关键岗位」的推断。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin, scoped, reader, noTalent;
const dept = {}, emp = {};
const db = (fn) => { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } };
const kpCount = () => db((d) => d.prepare("SELECT count(*) n FROM key_positions").get().n);
const audits = (action) => db((d) => d.prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY id").all(action).map((r) => ({ ...r })));

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}
async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: "Name " + empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  emp[empId] = u.id;
  if (patch) assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  return created.data.password;
}
async function makeAdminUser(empId, roleId) {
  const pw = await makeEmployee(empId, { department: "KP Root", adminRoleId: roleId });
  const c = await loginAs(srv.base, { employeeId: empId, password: pw });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: pw, newPassword: empId + "-pw-2026" })).status, 200);
  return c;
}
const succ = async (positionName, empId, readiness) => assert.equal((await admin.post("/api/admin/succession", { positionName, userId: emp[empId], readiness })).status, 200);

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["KP Root", null], ["KP Child", "KP Root"], ["KP Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200);
    dept[name] = r.data.department.id;
  }
  await makeEmployee("KP-LEAD", { department: "KP Root", position: "Team Lead - Sales", jobLevel: "MB2", hireDate: "2020-01-01" });
  await makeEmployee("KP-MEM1", { department: "KP Child", position: "Sales Rep", jobLevel: "PC1", hireDate: "2021-01-01", managerId: emp["KP-LEAD"] });
  await makeEmployee("KP-MEM2", { department: "KP Child", position: "Sales Rep", jobLevel: "PC1", hireDate: "2021-01-01", managerId: emp["KP-LEAD"] });
  await makeEmployee("KP-GONE", { department: "KP Child", position: "Sales Rep", jobLevel: "PC1", hireDate: "2021-01-01" });
  await makeEmployee("KP-OLEAD", { department: "KP Other", position: "Ops Head", jobLevel: "MA2", hireDate: "2019-01-01" });
  await makeEmployee("KP-OMEM", { department: "KP Other", position: "Ops Analyst", jobLevel: "PC1", hireDate: "2021-01-01", managerId: emp["KP-OLEAD"] });
  // 继任：Team Lead - Sales 有 1 名 1 年内就绪（MEM1）、1 名 2 年（MEM2）、1 名已离职（GONE）；Ops Head 的继任人在范围外
  await succ("Team Lead – Sales", "KP-MEM1", "oneYear");
  await succ("team lead - sales", "KP-MEM2", "twoYears");
  await succ("Team Lead - Sales", "KP-GONE", "ready");
  await succ("Ops Head", "KP-OMEM", "ready");
  await succ("Data Steward", "KP-MEM1", "twoYears");
  assert.equal((await admin.put("/api/admin/employees/" + emp["KP-GONE"], { empStatus: "exited" })).status, 200);
  const scope = { departments: [{ id: dept["KP Root"], includeChildren: true }] };
  scoped = await makeAdminUser("KP-A-SCOPED", await makeRole("KP Scoped Talent", { talent: "manage", people: "read" }, scope));
  reader = await makeAdminUser("KP-A-READ", await makeRole("KP Talent Read", { talent: "read" }));
  noTalent = await makeAdminUser("KP-A-LEARN", await makeRole("KP Learning", { learning: "manage" }));
});
after(() => srv.stop());

test("succession vacancies: inferred while the list is empty", async () => {
  const r = await admin.get("/api/admin/succession?vacancies=1");
  assert.equal(r.status, 200);
  assert.ok(r.data.keyRoleCount >= 2, "managers with direct reports are inferred key roles");
  assert.equal(r.data.vacancies.some((v) => v.keyPositionId), false, "inferred rows carry no keyPositionId");
});

test("create: validation codes, duplicate key (case / spaces / dashes) → 409, audit; matchedSuccession", async () => {
  const bad = async (body, code, status = 400) => { const r = await admin.post("/api/admin/key-positions", body); assert.equal(r.status, status, JSON.stringify(r.data)); assert.equal(r.data.code, code); };
  await bad({ name: "", deptId: dept["KP Root"] }, "name_required");
  await bad({ name: "x".repeat(81), deptId: dept["KP Root"] }, "name_too_long");
  await bad({ name: "Team Lead - Sales" }, "dept_required");
  await bad({ name: "Team Lead - Sales", deptId: "d-nope" }, "dept_unknown");
  await bad({ name: "Team Lead - Sales", deptId: dept["KP Root"], note: "n".repeat(301) }, "note_too_long");
  const c = await admin.post("/api/admin/key-positions", { name: "Team Lead - Sales", deptId: dept["KP Root"], note: "Revenue critical" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.matchedSuccession, 3, "three succession rows share the key (written with different dashes and case)");
  for (const dup of ["team lead - sales", "Team  Lead – Sales", "TEAM LEAD-SALES"]) {
    const r = await admin.post("/api/admin/key-positions", { name: dup, deptId: dept["KP Child"] });
    assert.equal(r.status, 409, dup);
    assert.equal(r.data.code, "position_exists");
    assert.equal(r.data.id, c.data.position.id);
  }
  assert.equal((await admin.post("/api/admin/key-positions", { name: "Ops Head", deptId: dept["KP Other"] })).status, 200);
  assert.equal((await admin.post("/api/admin/key-positions", { name: "Archive Clerk", deptId: dept["KP Root"], isKey: false })).status, 200);
  assert.equal(audits("keyposition.create").length, 3);
  assert.deepEqual(JSON.parse(audits("keyposition.create")[0].afterJson), { name: "Team Lead - Sales", dept: "KP Root", isKey: true, note: "Revenue critical" });
});

test("GET: coverage counts only in-service, in-scope successors; unmatched succession positions; scope filters rows", async () => {
  const r = await admin.get("/api/admin/key-positions");
  assert.equal(r.status, 200);
  const tl = r.data.rows.find((x) => x.name === "Team Lead - Sales");
  assert.deepEqual(tl.coverage, { ready: 0, oneYear: 1, twoYears: 1, total: 2 }, "the exited successor is not counted");
  assert.equal(tl.best, "oneYear");
  assert.equal(tl.holders, 1);
  assert.equal(tl.isKey, true);
  assert.equal(r.data.rows.find((x) => x.name === "Archive Clerk").isKey, false);
  assert.deepEqual(r.data.unmatchedSuccessionPositions.map((x) => x.name), ["Data Steward"]);
  const s = await scoped.get("/api/admin/key-positions");
  assert.deepEqual(s.data.rows.map((x) => x.name).sort(), ["Archive Clerk", "Team Lead - Sales"], "out-of-scope position not listed");
  assert.equal(JSON.stringify(s.data).includes("KP-OMEM"), false, "no out-of-scope successor anywhere");
  const rd = await reader.get("/api/admin/key-positions");
  assert.equal(rd.status, 200);
  assert.equal(rd.data.canWrite, false);
  assert.equal((await noTalent.get("/api/admin/key-positions")).status, 404, "no talent → 404");
});

test("permissions and scope on writes: read-only 403; out-of-scope row 404; out-of-scope department 400", async () => {
  const rows = (await admin.get("/api/admin/key-positions")).data.rows;
  const tl = rows.find((x) => x.name === "Team Lead - Sales"), oh = rows.find((x) => x.name === "Ops Head");
  assert.equal((await reader.post("/api/admin/key-positions", { name: "X Role", deptId: dept["KP Root"] })).status, 403);
  assert.equal((await reader.put("/api/admin/key-positions/" + tl.id, { note: "x" })).status, 403);
  assert.equal((await reader.del("/api/admin/key-positions/" + tl.id)).status, 403);
  assert.equal((await reader.post("/api/admin/key-positions/import/preview", { rows: [{ line: 2, name: "A", dept: "KP Root" }] })).status, 403);
  const out = await scoped.post("/api/admin/key-positions", { name: "Other Role", deptId: dept["KP Other"] });
  assert.equal(out.status, 400);
  assert.equal(out.data.code, "dept_out_of_scope");
  assert.equal((await scoped.put("/api/admin/key-positions/" + oh.id, { note: "mine now" })).status, 404, "out-of-scope row looks missing");
  assert.equal((await scoped.del("/api/admin/key-positions/" + oh.id)).status, 404);
  const mv = await scoped.put("/api/admin/key-positions/" + tl.id, { deptId: dept["KP Other"] });
  assert.equal(mv.data.code, "dept_out_of_scope");
  const up = await scoped.put("/api/admin/key-positions/" + tl.id, { deptId: dept["KP Child"], note: "Moved to the team" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.position.deptName, "KP Child");
  const ren = await scoped.put("/api/admin/key-positions/" + tl.id, { name: "archive clerk" });
  assert.equal(ren.status, 409, "renaming onto another row's key is refused");
  assert.equal(audits("keyposition.update").length, 1);
  assert.deepEqual(JSON.parse(audits("keyposition.update")[0].beforeJson).dept, "KP Root");
  assert.equal(kpCount(), 3);
});

test("succession vacancies switch to the list while it holds key positions, and back when it is cleared", async () => {
  const r = await admin.get("/api/admin/succession?vacancies=1");
  assert.equal(r.data.keyRoleCount, 2, "denominator = key positions (isKey) on the list; the non-key row is excluded");
  assert.deepEqual(r.data.vacancies, [], "Team Lead has successors; Ops Head has an in-service successor too");
  const s = await scoped.get("/api/admin/succession?vacancies=1");
  assert.equal(s.data.keyRoleCount, 1, "scoped viewer: only in-scope key positions");
  // Ops Head 的继任人离职 → 该岗位成为空缺
  assert.equal((await admin.put("/api/admin/employees/" + emp["KP-OMEM"], { empStatus: "exited" })).status, 200);
  const r2 = await admin.get("/api/admin/succession?vacancies=1");
  assert.deepEqual(r2.data.vacancies.map((v) => [v.positionName, v.holder, !!v.keyPositionId]), [["Ops Head", "Name KP-OLEAD", true]]);
  assert.equal((await admin.put("/api/admin/employees/" + emp["KP-OMEM"], { empStatus: "regular" })).status, 200);
});

test("import: preview → commit with hash; stale preview 409; any out-of-scope row rejects the whole batch; audit", async () => {
  const rows = [
    { line: 2, name: "Head of Payments", dept: "KP Root", isKey: "Y", note: "" },
    { line: 3, name: "TEAM LEAD - SALES", dept: "KP Root / KP Child", isKey: "", note: "Still critical" },
    { line: 4, name: "Archive Clerk", dept: "KP Root", isKey: "否", note: "" },
    { line: 5, name: "head of payments", dept: "KP Root", isKey: "", note: "" },
    { line: 6, name: "Nowhere Role", dept: "No Such Dept", isKey: "", note: "" },
    { line: 7, name: "Weird", dept: "KP Root", isKey: "maybe", note: "" },
  ];
  const p = await admin.post("/api/admin/key-positions/import/preview", { rows });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const act = Object.fromEntries(p.data.rows.map((r) => [r.line, r.action]));
  assert.deepEqual(act, { 2: "create", 3: "update", 4: "unchanged", 5: "error", 6: "error", 7: "error" });
  const codes = (line) => p.data.rows.find((r) => r.line === line).codes.map((c) => c.code);
  assert.ok(codes(5).includes("dup_in_file"));
  assert.ok(codes(6).includes("dept_unknown"));
  assert.ok(codes(7).includes("is_key_invalid"));
  assert.ok(codes(3).includes("name_merged"), "same key with a different spelling keeps the list's spelling");
  // 预览之后数据变了 → 409
  assert.equal((await admin.post("/api/admin/key-positions", { name: "Head of Payments", deptId: dept["KP Root"] })).status, 200);
  const stale = await admin.post("/api/admin/key-positions/import", { rows, previewHash: p.data.previewHash });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "preview_stale");
  const del = (await admin.get("/api/admin/key-positions")).data.rows.find((r) => r.name === "Head of Payments");
  assert.equal((await admin.del("/api/admin/key-positions/" + del.id)).status, 200);
  assert.equal(audits("keyposition.delete").length, 1);
  const p2 = await admin.post("/api/admin/key-positions/import/preview", { rows });
  assert.equal(p2.data.previewHash, p.data.previewHash, "same data → same hash");
  const ok = await admin.post("/api/admin/key-positions/import", { rows, previewHash: p2.data.previewHash });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data, { created: 1, updated: 1, unchanged: 1, skipped: 3 });
  const list = (await admin.get("/api/admin/key-positions")).data.rows;
  assert.equal(list.find((r) => r.name === "Team Lead - Sales").note, "Still critical");
  assert.equal(list.find((r) => r.name === "Team Lead - Sales").deptName, "KP Child");
  assert.equal(audits("keyposition.import").length, 1);
  // 范围受限：文件里有一行在范围外 → 整批拒绝
  const before = kpCount();
  const mixed = [{ line: 2, name: "Scoped New", dept: "KP Root", isKey: "", note: "" }, { line: 3, name: "Other New", dept: "KP Other", isKey: "", note: "" }];
  const sp = await scoped.post("/api/admin/key-positions/import/preview", { rows: mixed });
  assert.equal(sp.data.outOfScope, 1);
  const rej = await scoped.post("/api/admin/key-positions/import", { rows: mixed, previewHash: sp.data.previewHash });
  assert.equal(rej.status, 404);
  assert.equal(rej.data.code, "out_of_scope");
  assert.equal(rej.data.outOfScope, 1);
  assert.equal(kpCount(), before, "nothing written");
  // 改写范围外的已有行也算越界
  const touch = [{ line: 2, name: "Ops Head", dept: "KP Root", isKey: "", note: "" }];
  const tp = await scoped.post("/api/admin/key-positions/import/preview", { rows: touch });
  assert.ok(tp.data.rows[0].codes.some((c) => c.code === "position_out_of_scope"));
  assert.equal(tp.data.outOfScope, 1);
});

test("from the succession plan: preview rows for positions in succession but not on the list (holder department filled when unique)", async () => {
  const p = await admin.post("/api/admin/key-positions/import/preview", { fromSuccession: true });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.source, "succession");
  assert.deepEqual(p.data.rows.map((r) => r.name), ["Data Steward"]);
  assert.ok(p.data.rows[0].codes.some((c) => c.code === "dept_required"), "no holder → HR picks the department");
  const filled = p.data.input.map((r) => ({ ...r, dept: "KP Root" }));
  const p2 = await admin.post("/api/admin/key-positions/import/preview", { rows: filled, source: "succession" });
  const c = await admin.post("/api/admin/key-positions/import", { rows: filled, source: "succession", previewHash: p2.data.previewHash });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.created, 1);
  assert.equal(db((d) => d.prepare("SELECT source FROM key_positions WHERE name = 'Data Steward'").get().source), "succession");
  assert.deepEqual((await admin.get("/api/admin/key-positions")).data.unmatchedSuccessionPositions, []);
});

test("clearing the list brings the inferred vacancies back", async () => {
  const left = (await admin.get("/api/admin/key-positions")).data.rows;
  assert.equal(left.length, 5, "Team Lead, Ops Head, Archive Clerk, Head of Payments (imported), Data Steward (from succession)");
  for (const r of left) assert.equal((await admin.del("/api/admin/key-positions/" + r.id)).status, 200);
  assert.equal(kpCount(), 0);
  const r = await admin.get("/api/admin/succession?vacancies=1");
  assert.equal(r.data.vacancies.some((v) => v.keyPositionId), false);
  assert.ok(r.data.keyRoleCount >= 2);
  assert.equal(audits("keyposition.delete").length, 1 + 5, "one earlier delete + five now");
});
