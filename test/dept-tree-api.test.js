// 第二批 3.1（2026-10-08，波次 2 W2-A）：GET /api/admin/dept-tree —— 全站部门筛选（前端 DeptFilter / useDeptTree）的唯一数据源，
// 与培训概览、completion.csv、评估周期同一口径（server.js deptFilterFor → modules/core/org.js）。
//   · 形状 { options, idByName, chainById, hasNone }；集团层（Lark L0–L2）不算祖先，一级部门 = 集团层之下的第一层；
//     直接挂在集团节点上的人，集团节点自己成一个一级选项；四级及更深不单独成选项，但 chainById 里有完整链（选三级 = 含其下全部）。
//   · 部门来源 = 范围内全部人员（含离职）；count = 含下级的在职人数；不返回负责人。
//   · 读权限 = 后台闸门里先于 rbacGate 的手写规则 W1c：people / learning / performance / talent 任一可读（修掉 K1：培训管理员、绩效与人才管理员
//     的部门下拉为空）；只有审计、字段等其他域的角色 404。范围受限的角色只看到范围内的部门与人数。
//   · 考试成绩行带 department（考试成绩页按部门筛选）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin;
const dept = {};   // name → id
const people = {};

function dbWrite(fn) { const d = new DatabaseSync(srv.dbPath); try { return fn(d); } finally { d.close(); } }
function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
async function mkDept(name, parent) {
  const r = await admin.post("/api/admin/departments", { name, ...(parent ? { parentId: dept[parent] } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  dept[name] = r.data.department.id;
}
async function mkPerson(employeeId, department, extra) {
  const r = await admin.post("/api/admin/employees", { name: "N " + employeeId, employeeId, ...(department ? { department } : {}), jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(employeeId)).id;
  if (extra) assert.equal((await admin.put(`/api/admin/employees/${id}`, extra)).status, 200);
  people[employeeId] = { id, password: r.data.password };
  return id;
}
async function asRole(employeeId, grants, scope) {
  const role = await admin.post("/api/admin/roles", { name: "DT " + employeeId, name_zh: "DT " + employeeId, grants, ...(scope ? { scope } : {}) });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  return asRoleId(employeeId, role.data.role.id);
}
async function asRoleId(employeeId, roleId) {
  await mkPerson(employeeId, null, { adminRoleId: roleId });
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: people[employeeId].password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: people[employeeId].password, newPassword: employeeId + "-pw-2026" })).status, 200);
  return c;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // 集团层 DT Group → DT Region（两层都是 Lark 集团层）→ 一级部门 DT Finance / DT Ops
  await mkDept("DT Group");
  await mkDept("DT Region", "DT Group");
  await mkDept("DT Finance", "DT Region");
  await mkDept("DT Finance AP", "DT Finance");
  await mkDept("DT AP Team", "DT Finance AP");
  await mkDept("DT AP Deep", "DT AP Team");
  await mkDept("DT Ops", "DT Region");
  await mkDept("DT Ops Floor", "DT Ops");
  dbWrite((d) => d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('larksync.groupDepts', ?)").run(JSON.stringify([dept["DT Group"], dept["DT Region"]])));
  await mkPerson("DT-CEO", "DT Group");
  await mkPerson("DT-F1", "DT Finance");
  await mkPerson("DT-F2", "DT Finance AP");
  await mkPerson("DT-F3", "DT AP Team");
  await mkPerson("DT-F4", "DT AP Deep");
  await mkPerson("DT-F5", "DT Finance AP", { empStatus: "exited" });
  await mkPerson("DT-O1", "DT Ops Floor");
  await mkPerson("DT-N1", null);
});
after(async () => { if (srv) await srv.stopAsync(); });

const opt = (tree, name) => tree.options.find((o) => o.name === name);

test("shape: group layers are never ancestors, level 4 merges into level 3 but keeps its full chain, counts are active people incl. sub-departments", async () => {
  const r = await admin.get("/api/admin/dept-tree");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = r.data;
  assert.deepEqual(Object.keys(t).sort(), ["chainById", "hasNone", "idByName", "options"]);
  const fin = opt(t, "DT Finance"), ap = opt(t, "DT Finance AP"), team = opt(t, "DT AP Team"), ops = opt(t, "DT Ops");
  assert.deepEqual([fin.level, fin.parentId, fin.path], [1, null, "DT Finance"], "first layer under the group layer is level 1");
  assert.deepEqual([ap.level, ap.parentId, ap.path], [2, fin.id, "DT Finance › DT Finance AP"]);
  assert.deepEqual([team.level, team.parentId, team.path], [3, ap.id, "DT Finance › DT Finance AP › DT AP Team"]);
  assert.equal(opt(t, "DT AP Deep"), undefined, "level 4 is not its own option");
  assert.deepEqual(t.chainById[t.idByName["DT AP Deep"]], [fin.id, ap.id, team.id, dept["DT AP Deep"]], "…but matching still walks the full chain");
  assert.equal(ops.level, 1);
  assert.equal(opt(t, "DT Region"), undefined, "a group node nobody sits on directly is not an option");
  const grp = opt(t, "DT Group");
  assert.deepEqual([grp.level, grp.parentId, grp.count], [1, null, 1], "people sitting directly on a group node: the node is its own level-1 option");
  // count：在职、含下级（DT-F5 已离职不计；但其部门照样出现）
  assert.equal(fin.count, 4);
  assert.equal(ap.count, 3);
  assert.equal(team.count, 2);
  assert.equal(opt(t, "DT Ops Floor").count, 1);
  assert.equal(t.hasNone, true, "DT-N1 has no department (pure service accounts don't count)");
  for (const o of t.options) assert.ok(!("owner" in o) && !("ownerId" in o) && !("hod" in o), "no head-of-department data");
});

test("RBAC W1c: any of people / learning / performance / talent can read it (K1); other roles get 404; a scoped role sees only its own branch", async () => {
  const roles = (await admin.get("/api/admin/roles")).data.roles;
  const la = await asRoleId("DT-LA", roles.find((x) => x.key === "learning-admin").id);
  const pt = await asRoleId("DT-PT", roles.find((x) => x.key === "performance-talent-admin").id);
  for (const [who, c] of [["learning-admin", la], ["performance-talent-admin", pt]]) {
    const r = await c.get("/api/admin/dept-tree");
    assert.equal(r.status, 200, who + " " + JSON.stringify(r.data));
    assert.ok(opt(r.data, "DT Finance"), who + " gets the company-wide tree");
  }
  // K1：培训管理员按 dept-tree 给出的 id 筛选培训概览，筛得出来
  const ov = await la.get(`/api/admin/overview?dept=${encodeURIComponent(dept["DT Finance"])}`);
  assert.equal(ov.status, 200);
  assert.equal(ov.data.filters.dept, dept["DT Finance"]);
  for (const g of [{ audit: "read" }, { fields: "manage" }, { brand: "manage" }]) {
    const c = await asRole("DT-X" + Object.keys(g)[0].toUpperCase(), g);
    assert.equal((await c.get("/api/admin/dept-tree")).status, 404, JSON.stringify(g));
  }
  assert.equal((await admin.post("/api/admin/dept-tree", {})).status, 404, "GET only");
  const scoped = await asRole("DT-SC", { learning: "read" }, { departments: [{ id: dept["DT Finance AP"], includeChildren: true }] });
  const s = (await scoped.get("/api/admin/dept-tree")).data;
  assert.deepEqual(s.options.map((o) => o.name).sort(), ["DT AP Team", "DT Finance AP"]);
  assert.deepEqual([opt(s, "DT Finance AP").parentId, opt(s, "DT Finance AP").count], [null, 3]);
  assert.ok(!JSON.stringify(s).includes("DT Finance\"") && !JSON.stringify(s).includes("DT Ops"), "no out-of-scope department name: " + JSON.stringify(s));
  assert.deepEqual(s.chainById[s.idByName["DT AP Deep"]], [dept["DT Finance AP"], dept["DT AP Team"], dept["DT AP Deep"]], "chains trimmed to the scope");
  assert.equal(s.hasNone, false);
  // 范围外的部门 id 在培训概览里当作没筛选
  const out = (await scoped.get(`/api/admin/overview?dept=${encodeURIComponent(dept["DT Ops"])}`)).data;
  assert.equal(out.filters.dept, null);
});

test("attempt rows carry the department (Results page filter)", async () => {
  // 新库没有答卷：直接写一份已提交的答卷（DT-F2 在 DT Finance AP）
  const pid = dbRead((d) => d.prepare("SELECT id FROM content WHERE kind = 'program' LIMIT 1").get()).id;
  dbWrite((d) => d.prepare("INSERT INTO attempts (id, userId, programId, startedAt, submittedAt, questions, answers, percent, passed, detail) VALUES (?, ?, ?, ?, ?, '[]', '{}', 90, 1, '[]')")
    .run("at-dt-1", people["DT-F2"].id, pid, new Date(Date.now() - 60000).toISOString(), new Date().toISOString()));
  const r = await admin.get("/api/admin/attempts");
  assert.equal(r.status, 200);
  const row = r.data.find((x) => x.id === "at-dt-1");
  assert.ok(row, "the probe attempt is listed");
  assert.equal(row.department, "DT Finance AP");
});
