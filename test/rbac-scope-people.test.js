// RBAC P2 数据范围（scope）—— people 域 20 条端点的契约测试（阶段 A 余下部分）。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db），造一棵三层部门树 +
// 三个员工（范围内根 / 范围内子部门 / 范围外），三个角色（带范围的 people 角色、
// 带范围的 learning 角色、**空范围**的 people 角色）逐条验：
//   读 —— 范围外整条不返回（不是隐藏字段）；
//   写 —— 范围外回 404 且与「不存在」逐字同形（rbacGate none 档口径）；
//   批量 —— 部分越界 → 整批拒绝 + 回报越界条数，且一行都没写进去；
//   聚合 —— dashboard / org-diagnostics 按范围重算（不是过滤后不改分母）；
//   回归红线 —— **空范围角色与超管的行为一字不变**。
// 范围解析器本身（fail closed / 缓存 / 子树展开）在 test/rbac-scope.test.js。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const dept = {};   // name -> id
const emp = {};    // employeeId -> user id
let scopedPeople, scopedLearning, plainPeople;

// 造一个持某角色的后台账号并登录（与 rbac.test.js 的 makeAdminUser 同一套路：
// 建号 → 超管指派角色 → 登录 → 清掉强制改密标记）。
async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  const r = await admin.put("/api/admin/employees/" + u.id, { adminRoleId });
  assert.equal(r.status, 200, "assign role to " + empId);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  const cp = await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" });
  assert.equal(cp.status, 200, "clear mustChangePassword for " + empId);
  return c;
}

async function makeEmployee(empId, department) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find employee " + empId);
  const put = await admin.put("/api/admin/employees/" + u.id, { department, jobLevel: "P5" });
  assert.equal(put.status, 200, "set department of " + empId);
  emp[empId] = u.id;
  return u.id;
}

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // 部门树：SCP Root → SCP Child（两层，含下级要真的展开），SCP Other 在范围外。
  for (const [name, parent] of [["SCP Root", null], ["SCP Child", "SCP Root"], ["SCP Other", null]]) {
    const body = parent ? { name, parentId: dept[parent] } : { name };
    const r = await admin.post("/api/admin/departments", body);
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  await makeEmployee("SCP-IN", "SCP Root");
  await makeEmployee("SCP-KID", "SCP Child");
  await makeEmployee("SCP-OUT", "SCP Other");
  // 范围 = SCP Root 子树（含下级）。people=manage + learning=manage 才够摸到
  // GET /api/admin/employees（域 = learning，裁定①）。
  const scope = { departments: [{ id: dept["SCP Root"], includeChildren: true }] };
  scopedPeople = await makeAdminUser("SCP-A-PEOPLE", await makeRole("Scoped People", { people: "manage", learning: "manage" }, scope));
  // W1 白名单：learning 单域也能读 roster —— 范围过滤必须同样作用于它（清点文档 §9③）。
  scopedLearning = await makeAdminUser("SCP-A-LEARN", await makeRole("Scoped Learning", { learning: "manage" }, scope));
  // 回归基线：一模一样的授权，**空范围**（现有全部角色都是这个形状）。
  plainPeople = await makeAdminUser("SCP-A-PLAIN", await makeRole("Plain People", { people: "manage", learning: "manage" }));
});
after(() => srv.stop());

// ---------- 读：过滤 ----------
test("roster：范围内可见、范围外整条不返回；W1 的 learning 角色同样被过滤", async () => {
  for (const [who, c] of [["people", scopedPeople], ["learning", scopedLearning]]) {
    const r = await c.get("/api/admin/roster");
    assert.equal(r.status, 200, who + " 可读 roster");
    const ids = r.data.map((x) => x.employeeId);
    assert.ok(ids.includes("SCP-IN"), who + " 看得到范围内本部门");
    assert.ok(ids.includes("SCP-KID"), who + " 看得到范围内子部门（含下级）");
    assert.ok(!ids.includes("SCP-OUT"), who + " 看不到范围外");
    assert.ok(!ids.includes("ADMIN"), who + " 看不到无部门的系统账号");
    assert.equal(r.data.length, 2, who + " roster 只剩范围内 2 人");
  }
});

test("GET /employees（培训报表，每行仍是一个人）同样过滤", async () => {
  const r = await scopedPeople.get("/api/admin/employees");
  assert.equal(r.status, 200);
  const ids = r.data.map((x) => x.employeeId).sort();
  assert.deepEqual(ids, ["SCP-IN", "SCP-KID"]);
});

test("profile：范围内 200，范围外 404 且与「不存在」逐字同形；名录也被过滤", async () => {
  const ok = await scopedPeople.get("/api/admin/employees/" + emp["SCP-IN"] + "/profile");
  assert.equal(ok.status, 200);
  const out = await scopedPeople.get("/api/admin/employees/" + emp["SCP-OUT"] + "/profile");
  const ghost = await scopedPeople.get("/api/admin/employees/u-does-not-exist/profile");
  assert.equal(out.status, 404, "范围外 → 404");
  assert.equal(out.status, ghost.status);
  assert.deepEqual(out.data, ghost.data, "越界与不存在的响应体必须一字不差");
  // 档案页里的两个「第二份全员名录」也得过滤。
  const depts = ok.data.suggestions.departments;
  assert.ok(depts.includes("SCP Root") && depts.includes("SCP Child"));
  assert.ok(!depts.includes("SCP Other"), "suggestions.departments 不含范围外部门");
  const mgrIds = ok.data.suggestions.managers.map((m) => m.employeeId);
  assert.ok(mgrIds.includes("SCP-KID"));
  assert.ok(!mgrIds.includes("SCP-OUT"), "suggestions.managers 不含范围外员工");
});

test("departments：只回范围子树；range 外部门连行都没有", async () => {
  const r = await scopedPeople.get("/api/admin/departments");
  assert.equal(r.status, 200);
  const names = r.data.map((d) => d.name).sort();
  assert.deepEqual(names, ["SCP Child", "SCP Root"]);
  // 剩下的每一行都整体在范围内，所以它自己的 headcount 天然就是范围内人数。
  assert.equal(r.data.find((d) => d.name === "SCP Root").headcount, 1);
  assert.equal(r.data.find((d) => d.name === "SCP Child").headcount, 1);
});

test("export/records.csv：不带 userId 过滤全员，带 userId 越界回 404 同形", async () => {
  for (const eid of ["SCP-IN", "SCP-OUT"]) {
    const rec = await admin.post("/api/admin/employees/" + emp[eid] + "/records", { type: "note", date: "2026-05-01", title: "scope-csv-" + eid, fields: { text: "scope test" } });
    assert.equal(rec.status, 200, "seed record for " + eid);
  }
  const csv = await (await scopedPeople.raw("GET", "/api/admin/export/records.csv")).text();
  assert.ok(csv.includes("scope-csv-SCP-IN"), "范围内的记录在导出里");
  assert.ok(!csv.includes("scope-csv-SCP-OUT"), "范围外的记录不在导出里");
  const out = await scopedPeople.get("/api/admin/export/records.csv?userId=" + emp["SCP-OUT"]);
  const ghost = await scopedPeople.get("/api/admin/export/records.csv?userId=u-nope");
  assert.equal(out.status, 404);
  assert.deepEqual(out.data, ghost.data, "越界与查无此人同形");
});

// ---------- 写：单人主体 → 404 ----------
test("PUT /employees/:id：范围外 404 同形；调出范围/清空部门 400 dept_out_of_scope", async () => {
  const okr = await scopedPeople.put("/api/admin/employees/" + emp["SCP-IN"], { position: "Analyst" });
  assert.equal(okr.status, 200, "范围内可写");
  const out = await scopedPeople.put("/api/admin/employees/" + emp["SCP-OUT"], { position: "Hacked" });
  const ghost = await scopedPeople.put("/api/admin/employees/u-nope", { position: "Hacked" });
  assert.equal(out.status, 404);
  assert.deepEqual(out.data, ghost.data, "越界写与不存在同形");
  assert.equal((await admin.get("/api/admin/employees/" + emp["SCP-OUT"] + "/profile")).data.user.position, "", "范围外的人没被改到");
  // 新部门也要在范围内 —— 否则能把自己范围内的人「推出」范围。
  const push = await scopedPeople.put("/api/admin/employees/" + emp["SCP-IN"], { department: "SCP Other" });
  assert.equal(push.status, 400);
  assert.equal(push.data.code, "dept_out_of_scope");
  const clear = await scopedPeople.put("/api/admin/employees/" + emp["SCP-IN"], { department: "" });
  assert.equal(clear.status, 400, "清空部门 = 推出范围，同样拒绝");
  assert.equal((await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "SCP-IN").department, "SCP Root");
  // 范围内部门之间调动是允许的。
  const move = await scopedPeople.put("/api/admin/employees/" + emp["SCP-IN"], { department: "SCP Child" });
  assert.equal(move.status, 200, "范围内调动可以");
  await admin.put("/api/admin/employees/" + emp["SCP-IN"], { department: "SCP Root" });
});

test("records 单人三条（POST/PUT/DELETE）：范围外 404 且与「记录不存在」同形", async () => {
  const mk = async (eid) => {
    const r = await admin.post("/api/admin/employees/" + emp[eid] + "/records", { type: "note", date: "2026-06-01", title: "rec-" + eid, fields: { text: "scope test" } });
    assert.equal(r.status, 200);
    return r.data.record.id;
  };
  const inRec = await mk("SCP-IN");
  const outRec = await mk("SCP-OUT");
  // POST（有副作用的那条：applyRecordSideEffects 会改主数据）
  const post = await scopedPeople.post("/api/admin/employees/" + emp["SCP-OUT"] + "/records", { type: "note", date: "2026-06-02", title: "nope", fields: { text: "scope test" } });
  const postGhost = await scopedPeople.post("/api/admin/employees/u-nope/records", { type: "note", date: "2026-06-02", title: "nope", fields: { text: "scope test" } });
  assert.equal(post.status, 404);
  assert.deepEqual(post.data, postGhost.data);
  // PUT / DELETE 按 rec.userId 判
  for (const method of ["put", "del"]) {
    const out = await scopedPeople[method]("/api/admin/records/" + outRec, { type: "note", date: "2026-06-03", fields: { text: "scope test" } });
    const ghost = await scopedPeople[method]("/api/admin/records/tr-nope", { type: "note", date: "2026-06-03", fields: { text: "scope test" } });
    assert.equal(out.status, 404, method + " 越界 404");
    assert.deepEqual(out.data, ghost.data, method + " 与记录不存在同形");
  }
  // 范围内同样的调用要成功（证明卡的是范围而不是端点本身）
  assert.equal((await scopedPeople.put("/api/admin/records/" + inRec, { type: "note", date: "2026-06-04", title: "rec-in-edited", fields: { text: "scope test" } })).status, 200);
  assert.equal((await scopedPeople.del("/api/admin/records/" + inRec)).status, 200);
  // 越界的那条记录还在
  assert.ok((await admin.get("/api/admin/employees/" + emp["SCP-OUT"] + "/profile")).data.events.some((e) => e.title === "rec-SCP-OUT"));
});

test("secondary-lines：按主体校验，允许指向范围外上级；DELETE 按行归属人", async () => {
  const list = await scopedPeople.get("/api/admin/employees/" + emp["SCP-OUT"] + "/secondary-lines");
  const listGhost = await scopedPeople.get("/api/admin/employees/u-nope/secondary-lines");
  assert.equal(list.status, 404);
  assert.deepEqual(list.data, listGhost.data);
  assert.equal((await scopedPeople.post("/api/admin/employees/" + emp["SCP-OUT"] + "/secondary-lines", { kind: "concurrent", position: "X" })).status, 404, "范围外主体不能加线");
  // 主体在范围内、上级在范围外 —— 允许（跨部门虚线是这个功能的全部用途）
  const cross = await scopedPeople.post("/api/admin/employees/" + emp["SCP-IN"] + "/secondary-lines", { kind: "dotted", managerId: emp["SCP-OUT"] });
  assert.equal(cross.status, 200, "允许指向范围外上级");
  // DELETE 按 row.userId：范围外的人的线删不掉，且与「行不存在」同形
  const outLine = await admin.post("/api/admin/employees/" + emp["SCP-OUT"] + "/secondary-lines", { kind: "concurrent", position: "Out Post" });
  assert.equal(outLine.status, 200);
  const del = await scopedPeople.del("/api/admin/secondary-lines/" + outLine.data.line.id);
  const delGhost = await scopedPeople.del("/api/admin/secondary-lines/sl-nope");
  assert.equal(del.status, 404);
  assert.deepEqual(del.data, delGhost.data);
  assert.equal((await scopedPeople.del("/api/admin/secondary-lines/" + cross.data.line.id)).status, 200, "自己范围内的线可以删");
});

// ---------- 写：批量 → 整批拒绝 ----------
test("bulk-update：部分越界 → 整批拒绝 + 回报条数，范围内那条也没被改", async () => {
  // bulk-update 的可写字段是 department/managerId/active/potential，所以这里用
  // department 当探针（也顺带盯住「部分执行会把人调到另一个部门」这个不可逆后果）。
  const mixed = await scopedPeople.post("/api/admin/employees/bulk-update", { userIds: [emp["SCP-IN"], emp["SCP-OUT"]], fields: { department: "SCP Child" } });
  assert.equal(mixed.status, 404);
  assert.equal(mixed.data.code, "out_of_scope");
  assert.equal(mixed.data.outOfScope, 1, "回报越界条数");
  const roster = await admin.get("/api/admin/roster");
  assert.equal(roster.data.find((x) => x.employeeId === "SCP-IN").department, "SCP Root", "整批拒绝 = 一行都没写");
  // 全在范围内 → 照常 200
  const ok = await scopedPeople.post("/api/admin/employees/bulk-update", { userIds: [emp["SCP-IN"], emp["SCP-KID"]], fields: { department: "SCP Child" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.count, 2);
  await admin.put("/api/admin/employees/" + emp["SCP-IN"], { department: "SCP Root" });
  // 目标部门越界（把人推出范围）→ 400，与单条 PUT 同口径
  const push = await scopedPeople.post("/api/admin/employees/bulk-update", { userIds: [emp["SCP-IN"]], fields: { department: "SCP Other" } });
  assert.equal(push.status, 400);
  assert.equal(push.data.code, "dept_out_of_scope");
});

test("records/bulk 与 secondary-lines/bulk：部分越界整批拒绝，且一行都没导入", async () => {
  const recs = await scopedPeople.post("/api/admin/records/bulk", {
    rows: [
      { employeeId: "SCP-IN", type: "note", date: "2026-07-01", title: "bulk-in" },
      { employeeId: "SCP-OUT", type: "note", date: "2026-07-01", title: "bulk-out" },
    ],
  });
  assert.equal(recs.status, 404);
  assert.equal(recs.data.outOfScope, 1);
  const prof = await admin.get("/api/admin/employees/" + emp["SCP-IN"] + "/profile");
  assert.ok(!prof.data.events.some((e) => e.title === "bulk-in"), "整批拒绝 = 范围内那行也没写");
  // 查无此工号仍按原样逐行 skipped + 200（口径不变）
  const ghosts = await scopedPeople.post("/api/admin/records/bulk", { rows: [{ employeeId: "SCP-NOPE", type: "note", date: "2026-07-01", title: "x" }] });
  assert.equal(ghosts.status, 200);
  assert.equal(ghosts.data.results[0].status, "skipped");
  const lines = await scopedPeople.post("/api/admin/secondary-lines/bulk", {
    rows: [
      { employeeId: "SCP-IN", kind: "concurrent", position: "P1" },
      { employeeId: "SCP-OUT", kind: "concurrent", position: "P2" },
    ],
  });
  assert.equal(lines.status, 404);
  assert.equal(lines.data.outOfScope, 1);
  assert.equal((await scopedPeople.get("/api/admin/employees/" + emp["SCP-IN"] + "/secondary-lines")).data.length, 0, "一行都没导入");
});

// ---------- 部门写 ----------
test("departments 写：范围外改名/删除/改父级全部拒绝，建部门必须挂在范围内父级下", async () => {
  const rename = await scopedPeople.post("/api/admin/departments", { action: "rename", name: "SCP Other", newName: "Hijacked" });
  assert.equal(rename.status, 400);
  assert.equal(rename.data.code, "dept_out_of_scope");
  const delAct = await scopedPeople.post("/api/admin/departments", { action: "delete", name: "SCP Other" });
  assert.equal(delAct.status, 400, "范围外部门不能删（删除会把该部门全体员工的部门置 NULL）");
  // 按 id 的两条回 404（部门 id 不该被枚举）
  const put = await scopedPeople.put("/api/admin/departments/" + dept["SCP Other"], { name: "Hijacked" });
  const putGhost = await scopedPeople.put("/api/admin/departments/d-nope", { name: "Hijacked" });
  assert.equal(put.status, 404);
  assert.deepEqual(put.data, putGhost.data, "越界与部门不存在同形");
  const del = await scopedPeople.del("/api/admin/departments/" + dept["SCP Other"]);
  assert.equal(del.status, 404);
  assert.equal((await admin.get("/api/admin/departments")).data.find((d) => d.id === dept["SCP Other"]).name, "SCP Other", "范围外部门没被动");
  // 建部门：没有父级（= 建根部门）拒绝；挂在范围内父级下允许
  const root = await scopedPeople.post("/api/admin/departments", { name: "SCP Rogue Root" });
  assert.equal(root.status, 400);
  assert.equal(root.data.code, "dept_out_of_scope");
  const child = await scopedPeople.post("/api/admin/departments", { name: "SCP New Child", parentId: dept["SCP Root"] });
  assert.equal(child.status, 200, "挂在范围内父级下可以建");
  assert.ok((await scopedPeople.get("/api/admin/departments")).data.some((d) => d.name === "SCP New Child"), "新建的子部门立刻可见（含下级）");
  // 改父级：新父级也要在范围内
  const reparent = await scopedPeople.put("/api/admin/departments/" + child.data.department.id, { parentId: dept["SCP Other"] });
  assert.equal(reparent.status, 400);
  assert.equal(reparent.data.code, "dept_out_of_scope");
  // 范围内改名可以，且改完范围自动跟随（范围按 id 配）
  const ok = await scopedPeople.put("/api/admin/departments/" + child.data.department.id, { name: "SCP Renamed Child" });
  assert.equal(ok.status, 200);
  assert.ok((await scopedPeople.get("/api/admin/departments")).data.some((d) => d.name === "SCP Renamed Child"));
  await admin.del("/api/admin/departments/" + child.data.department.id);
});

// ---------- 组织架构树（设计选择②：方案 B）----------
test("org-chart：范围内 + 祖先链骨架节点（outOfScope 标记，其余字段 null）", async () => {
  // 让范围内的人挂在范围外的上级下面 —— 这正是会打断树的形状。
  assert.equal((await admin.put("/api/admin/employees/" + emp["SCP-IN"], { managerId: emp["SCP-OUT"] })).status, 200);
  const r = await scopedPeople.get("/api/admin/org-chart");
  assert.equal(r.status, 200);
  const byEmp = new Map(r.data.nodes.map((n) => [n.name, n]));
  assert.ok(byEmp.has("SCP-IN") && byEmp.has("SCP-KID"), "范围内的人都在");
  // CX-013（2026-10-10）：骨架节点不下发姓名（按 id 找）；部门仍保留（见下一条断言）
  const skel = r.data.nodes.find((n) => n.id === emp["SCP-OUT"]);
  assert.equal(skel && skel.name, null, "骨架节点不带姓名");
  assert.ok(skel, "范围外的上级作为骨架节点保留（树必须连通）");
  assert.equal(skel.outOfScope, true, "骨架节点必须带显式标记，否则前端会去调 profile 吃 404");
  assert.equal(skel.employeeId, null, "骨架节点只留连通性所需的最小信息");
  assert.equal(skel.jobLevel, null);
  assert.equal(skel.department, "SCP Other", "部门保留 —— 这是「我们挂在谁下面」的答案");
  assert.equal(byEmp.get("SCP-IN").outOfScope, undefined, "范围内节点不带这个标记");
  // 骨架节点自己的矩阵关系不属于这个视图
  const outLine = await admin.post("/api/admin/employees/" + emp["SCP-OUT"] + "/secondary-lines", { kind: "dotted", managerId: emp["SCP-KID"] });
  assert.equal(outLine.status, 200);
  const r2 = await scopedPeople.get("/api/admin/org-chart");
  assert.ok(!r2.data.secondary.some((e) => e.userId === emp["SCP-OUT"]), "主体是骨架节点的虚线不画");
  await admin.del("/api/admin/secondary-lines/" + outLine.data.line.id);
  await admin.put("/api/admin/employees/" + emp["SCP-IN"], { managerId: "" });
});

// ---------- 聚合：重算 ----------
test("org-diagnostics：在过滤后的子图上重算；spans/matrix 不含范围外经理", async () => {
  assert.equal((await admin.put("/api/admin/employees/" + emp["SCP-KID"], { managerId: emp["SCP-IN"] })).status, 200);
  assert.equal((await admin.put("/api/admin/employees/" + emp["SCP-OUT"], { managerId: emp["SCP-IN"] })).status, 200);
  const r = await scopedPeople.get("/api/admin/org-diagnostics");
  assert.equal(r.status, 200);
  assert.equal(r.data.kpis.headcount, 2, "分母是范围内人数，不是全公司");
  const mgr = r.data.spans.find((s) => s.name === "SCP-IN");
  assert.ok(mgr, "范围内经理在跨度统计里");
  assert.equal(mgr.directs, 1, "直属数只数范围内的下属（范围外那个不计入）");
  assert.ok(!r.data.spans.some((s) => s.department === "SCP Other"), "范围外经理整条剔除（spans 带姓名）");
  assert.ok(!r.data.depts.some(([d]) => d === "SCP Other"), "部门分布不含范围外部门");
  const sup = await admin.get("/api/admin/org-diagnostics");
  assert.ok(sup.data.kpis.headcount > r.data.kpis.headcount, "超管看到的还是全公司");
  await admin.put("/api/admin/employees/" + emp["SCP-OUT"], { managerId: "" });
});

test("dashboard：人员域字段按范围重算，且与 W4 字段裁剪是两层", async () => {
  const r = await scopedPeople.get("/api/admin/dashboard");
  assert.equal(r.status, 200);
  assert.equal(r.data.headcount, 2, "headcount 重算");
  assert.equal(r.data.deptTotal, 2, "deptTotal 只数范围内部门");
  assert.ok(!r.data.byDept.some(([d]) => d === "SCP Other"), "byDept 不含范围外部门");
  assert.ok(!r.data.recentHires.some((h) => h.department === "SCP Other"), "recentHires 按范围过滤");
  const sup = await admin.get("/api/admin/dashboard");
  assert.ok(sup.data.headcount > 2, "超管仍是全公司分母");
  // 两层顺序：people=none 的角色连 headcount 这个**键**都不该有（范围是几个部门无关）
  const learn = await scopedLearning.get("/api/admin/dashboard");
  assert.equal("headcount" in learn.data, false, "先按 grants 决定字段在不在");
});

// ---------- 回归红线 ----------
test("回归：空范围角色与超管的行为一字不变", async () => {
  const plainRoster = await plainPeople.get("/api/admin/roster");
  const superRoster = await admin.get("/api/admin/roster");
  assert.deepEqual(plainRoster.data, superRoster.data, "空范围 roster 与超管逐字节一致（= 全公司）");
  for (const eid of ["SCP-IN", "SCP-KID", "SCP-OUT"]) assert.ok(plainRoster.data.some((x) => x.employeeId === eid), "空范围看得到 " + eid);
  const plainDepts = await plainPeople.get("/api/admin/departments");
  const superDepts = await admin.get("/api/admin/departments");
  assert.deepEqual(plainDepts.data.map((d) => d.id).sort(), superDepts.data.map((d) => d.id).sort(), "部门列表与超管一致");
  const plainChart = await plainPeople.get("/api/admin/org-chart");
  const superChart = await admin.get("/api/admin/org-chart");
  assert.deepEqual(plainChart.data, superChart.data, "org-chart 与超管逐字节一致（无骨架节点）");
  assert.ok(!plainChart.data.nodes.some((n) => "outOfScope" in n), "空范围不产生骨架节点");
  const plainDash = await plainPeople.get("/api/admin/dashboard");
  const superDash = await admin.get("/api/admin/dashboard");
  assert.equal(plainDash.data.headcount, superDash.data.headcount);
  assert.equal(plainDash.data.deptTotal, superDash.data.deptTotal);
  assert.deepEqual((await plainPeople.get("/api/admin/org-diagnostics")).data.kpis, (await admin.get("/api/admin/org-diagnostics")).data.kpis);
  // 空范围角色照旧能写到任何人、任何部门（越界的概念不存在）
  assert.equal((await plainPeople.put("/api/admin/employees/" + emp["SCP-OUT"], { position: "Plain OK" })).status, 200);
  // 跨范围的批量（一个在「SCP Root」、一个在「SCP Other」）对空范围角色是合法的一批
  assert.equal((await plainPeople.post("/api/admin/employees/bulk-update", { userIds: [emp["SCP-IN"], emp["SCP-OUT"]], fields: { department: "SCP Other" } })).data.count, 2);
  await admin.put("/api/admin/employees/" + emp["SCP-IN"], { department: "SCP Root" });
  assert.equal((await plainPeople.post("/api/admin/departments", { name: "SCP Plain Root" })).status, 200, "空范围能建根部门");
  assert.equal((await plainPeople.post("/api/admin/departments", { action: "rename", name: "SCP Plain Root", newName: "SCP Plain Renamed" })).status, 200, "空范围能改任意部门");
});

test("坏 scope 在端点上 fail closed：名册空表而不是全公司", async () => {
  // departments 不是数组 = 自相矛盾的形状（store.js parseScope 的 b 类）→ 零可见。
  const bad = await makeAdminUser("SCP-A-BAD", await makeRole("Bad Scope", { people: "manage" }, { departments: "SCP Root" }));
  const r = await bad.get("/api/admin/roster");
  assert.equal(r.status, 200, "端点仍然可达（域闸门是另一维度）");
  assert.deepEqual(r.data, [], "零可见：响亮地空，绝不退化成全公司");
  assert.equal((await bad.get("/api/admin/dashboard")).data.headcount, 0);
  assert.deepEqual((await bad.get("/api/admin/departments")).data, []);
  assert.equal((await bad.put("/api/admin/employees/" + emp["SCP-IN"], { position: "X" })).status, 404);
});

/* ---------- 对抗复核补丁：两条曾经漏掉的「把范围内的人推出范围」的写路径 ----------
   两条都不是「读到了不该读的」，而是**写**出来的不可逆越权：范围受限角色把自己范围内
   的人挪到范围外，挪完他自己再也看不到那个人，除了审计日志里一行 count 没有任何痕迹。
   users.department 一共只有三条写路径（PUT /employees/:id、bulk-update、transfer 记录的
   同步副作用），三条必须逐字同口径 —— 分叉的那一条就是漏洞本身。 */
test("bulk-update：清空部门与调出范围同口径拒绝（曾经 null 被漏过范围校验）", async () => {
  const rosterBefore = (await admin.get("/api/admin/roster")).data;
  const dIn = rosterBefore.find((x) => x.employeeId === "SCP-IN").department;
  const dKid = rosterBefore.find((x) => x.employeeId === "SCP-KID").department;
  const clear = await scopedPeople.post("/api/admin/employees/bulk-update",
    { userIds: [emp["SCP-IN"], emp["SCP-KID"]], fields: { department: "" } });
  assert.equal(clear.status, 400, "清空部门 = 把人推出范围（没有部门的人在范围生效时不可见）");
  assert.equal(clear.data.code, "dept_out_of_scope");
  const rosterAfter = (await admin.get("/api/admin/roster")).data;
  assert.equal(rosterAfter.find((x) => x.employeeId === "SCP-IN").department, dIn, "一行都没写");
  assert.equal(rosterAfter.find((x) => x.employeeId === "SCP-KID").department, dKid);
  // 空范围角色不受影响（对它「越界」这个概念不存在）：照旧能清空任何人的部门。
  const plain = await plainPeople.post("/api/admin/employees/bulk-update",
    { userIds: [emp["SCP-OUT"]], fields: { department: "" } });
  assert.equal(plain.status, 200, "空范围行为一字不变");
  assert.equal(plain.data.count, 1);
  await admin.put("/api/admin/employees/" + emp["SCP-OUT"], { department: "SCP Other" });
});

test("records 的调动副作用受范围约束：transfer + syncDept 不能把人搬出范围", async () => {
  const deptOf = async (eid) => (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === eid).department;
  const tr = (toDept, sync) => ({
    type: "transfer", date: "2026-07-01", title: "scope transfer",
    fields: { fromDept: "SCP Root", toDept, ...(sync ? { syncDept: true } : {}) },
  });
  // ① 搬到范围外的既有部门 —— 与 PUT /employees/:id 的 department 同口径 400。
  const out = await scopedPeople.post("/api/admin/employees/" + emp["SCP-IN"] + "/records", tr("SCP Other", true));
  assert.equal(out.status, 400);
  assert.equal(out.data.code, "dept_out_of_scope");
  assert.equal(await deptOf("SCP-IN"), "SCP Root", "校验在副作用之前，主数据没动");
  // ② 搬到一个**凭空造出来**的部门：toDept 走 ensureDepartment，等于顺手绕过
  //    「范围受限角色不能建根部门」那条守卫，所以同样拒绝，且部门不能被造出来。
  const invented = "SCP Invented By Transfer";
  const inv = await scopedPeople.post("/api/admin/employees/" + emp["SCP-IN"] + "/records", tr(invented, true));
  assert.equal(inv.status, 400);
  assert.equal(inv.data.code, "dept_out_of_scope");
  assert.ok(!(await admin.get("/api/admin/departments")).data.some((d) => d.name === invented), "部门也没被造出来");
  // ③ PUT 一条既有记录同样会触发副作用（同一张表，两个入口）。
  const seed = await admin.post("/api/admin/employees/" + emp["SCP-IN"] + "/records", { type: "note", date: "2026-07-02", title: "put base", fields: { text: "x" } });
  assert.equal(seed.status, 200);
  const put = await scopedPeople.put("/api/admin/records/" + seed.data.record.id, tr("SCP Other", true));
  assert.equal(put.status, 400);
  assert.equal(put.data.code, "dept_out_of_scope");
  assert.equal(await deptOf("SCP-IN"), "SCP Root");
  // ④ 不带 syncDept 的历史记录照旧可写（它不改主数据）—— 守卫不能把功能废掉。
  assert.equal((await scopedPeople.post("/api/admin/employees/" + emp["SCP-IN"] + "/records", tr("SCP Other", false))).status, 200, "纯历史记录不受影响");
  assert.equal(await deptOf("SCP-IN"), "SCP Root");
  // ⑤ 范围内调动照旧生效（卡的是范围，不是这条功能）。
  assert.equal((await scopedPeople.post("/api/admin/employees/" + emp["SCP-IN"] + "/records", tr("SCP Child", true))).status, 200);
  assert.equal(await deptOf("SCP-IN"), "SCP Child");
  await admin.put("/api/admin/employees/" + emp["SCP-IN"], { department: "SCP Root" });
  // ⑥ 空范围角色照旧能把任何人搬到任何部门。
  const plain = await plainPeople.post("/api/admin/employees/" + emp["SCP-OUT"] + "/records",
    { type: "transfer", date: "2026-07-03", title: "plain transfer", fields: { toDept: "SCP Root", syncDept: true } });
  assert.equal(plain.status, 200, "空范围行为一字不变");
  assert.equal(await deptOf("SCP-OUT"), "SCP Root");
  await admin.put("/api/admin/employees/" + emp["SCP-OUT"], { department: "SCP Other" });
});
