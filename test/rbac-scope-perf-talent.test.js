// RBAC P2 数据范围（scope）—— performance 6 条 + talent 8 条的契约测试（阶段 C）。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db），造一棵两层部门树 +
// 范围内/范围内子部门/范围外三组人，两个 performance+talent 角色（带范围 / 空范围），
// 逐条验：
//   读 —— 名单整条不返回（周期名单、九宫格、晋升池、继任计划、记录检索），
//         聚合按范围**重算**（周期进度分母、distribution、九宫格分桶、keyRoleCount、
//         talent-search 的 total 与 facets）；
//   写 —— 单人主体越界回与**同一 handler 的「不存在」逐字同形**的应答
//         （review-items / succession PUT+DELETE / ai-portrait 是 404；
//          succession POST 是它自己的 400 —— 同形的对象是本 handler 的分支，不是别处的 404）；
//   批量 —— 开周期圈人 / 增补参与者部分越界 → 整批拒绝 + 回报越界条数，且一行都没写；
//   **整周期** —— close 关账只要含一个范围外参与者就整体拒绝：周期保持 open，
//                 范围内的人也一条档案都不写（部分关账不可逆，见 handler 上的推理）；
//   内容对象 —— promotion-config 不加门（防「过滤过头 → 开箱即残」）；
//   回归红线 —— 空范围角色与超管的行为一字不变。
// people 域 20 条在 test/rbac-scope-people.test.js，learning 域 25 条在
// test/rbac-scope-learning.test.js，范围解析器本身在 test/rbac-scope.test.js。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");
const fs = require("fs");
const path = require("path");

let srv, admin;
const dept = {};   // name -> id
const emp = {};    // employeeId -> user id
// scopedPTP / plainPTP：同样的范围与授权，另加员工档案（people）读 —— AI 画像要求同时具备 people 读（AI 治理方案 2.5）
let scopedPT, plainPT, scopedPTP, plainPTP, talentOnly;
let ptScope;       // 范围定义（before 里建角色用；工作台的两层测试要再建一个同范围角色）
let succIn, succOut;      // 继任记录 id（范围内 / 范围外）

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}

// 建号 → 超管指派角色 → 登录 → 清掉强制改密标记（与 rbac-scope-people/learning 同一套路）。
async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, { adminRoleId })).status, 200);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  return c;
}

// 员工：建号 + 落部门/职级/岗位/上级。jobLevel 为 "" 的那两个人是**故意**的 ——
// promotion-candidates 的 unmapped[] 只收「职级落不进职级表」的人，没有他们就测不到
// 清单点名的「两个数组都要过滤」。
async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find employee " + empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  emp[empId] = u.id;
  return u.id;
}

// 一条绩效档案（talent-search 的 results/facets/total 与晋升池的 rating 闸门都读它）。
async function addPerfRecord(empId, rating) {
  const r = await admin.post(`/api/admin/employees/${emp[empId]}/records`, {
    type: "performance", date: "2026-01-15", title: "Scope Perf " + empId,
    fields: { rating, period: "2026-H1", summary: "scope test" },
  });
  assert.equal(r.status, 200, "perf record for " + empId + " " + JSON.stringify(r.data));
}

// 开一个只含指定员工的周期，回周期 id（每个用例自带周期，免得互相踩）。
async function openCycle(name, empIds) {
  const r = await admin.post("/api/admin/review-cycles", { name, userIds: empIds.map((e) => emp[e]) });
  assert.equal(r.status, 200, "open cycle " + name);
  assert.equal(r.data.participants, empIds.length, "participants of " + name);
  return r.data.cycle.id;
}

// 给周期里的每个人打上经理评级，让 close 有东西可落档。
async function rateEveryone(cycleId, rating) {
  const d = await admin.get("/api/admin/review-cycles/" + cycleId);
  assert.equal(d.status, 200);
  for (const it of d.data.items) {
    assert.equal((await admin.put("/api/admin/review-items/" + it.id, { finalRating: rating })).status, 200, "rate " + it.name);
  }
  return d.data.items;
}

before(async () => {
  // 画像走演示内容：ai 模块与 portrait 功能显式开启、ai.demo:true，并清空 helpers 默认的 LMS_DISABLE_AI（它优先于演示）
  const cfgDir = tempDir("pt-cfg-");
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ modules: { ai: true }, ai: { demo: true, features: { portrait: true } } }));
  srv = await startServer({ env: { LMS_CONFIG_PATH: path.join(cfgDir, "config.json"), LMS_DISABLE_AI: "" } });
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["PT Root", null], ["PT Child", "PT Root"], ["PT Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  // position 各不相同是必须的：succession 的 keyRoles 以 position||jobLevel||name 为键，
  // 两个人同职级会被折成一个关键岗，vacancies 的过滤就测不出来了。
  await makeEmployee("PT-IN", { department: "PT Root", jobLevel: "PB2", position: "Scope Lead In", hireDate: "2020-01-01" });
  await makeEmployee("PT-KID", { department: "PT Child", jobLevel: "PB2", position: "Scope Member In", hireDate: "2020-01-01", managerId: emp["PT-IN"] });
  await makeEmployee("PT-OUT", { department: "PT Other", jobLevel: "PB2", position: "Scope Lead Out", hireDate: "2020-01-01" });
  await makeEmployee("PT-OUT2", { department: "PT Other", jobLevel: "PB2", position: "Scope Member Out", hireDate: "2020-01-01", managerId: emp["PT-OUT"] });
  await makeEmployee("PT-NOLVL-IN", { department: "PT Root", jobLevel: "", hireDate: "2020-01-01" });
  await makeEmployee("PT-NOLVL-OUT", { department: "PT Other", jobLevel: "", hireDate: "2020-01-01" });
  await addPerfRecord("PT-IN", "A");
  await addPerfRecord("PT-OUT", "D");   // 范围外**独有**的取值 —— facets 泄露的探针
  // 继任计划：范围内一条、范围外一条；positionName 与上面的 position 刻意不同名，
  // 这样两个关键岗（PT-IN / PT-OUT）都还算「无人接班」，vacancies 才有东西可过滤。
  const s1 = await admin.post("/api/admin/succession", { positionName: "Future Lead A", userId: emp["PT-KID"], readiness: "ready" });
  assert.equal(s1.status, 200); succIn = s1.data.entry.id;
  const s2 = await admin.post("/api/admin/succession", { positionName: "Future Lead B", userId: emp["PT-OUT2"], readiness: "ready" });
  assert.equal(s2.status, 200); succOut = s2.data.entry.id;
  // 范围 = PT Root 子树（含下级）。两个域一起给：这一批 14 条横跨 performance 与 talent。
  ptScope = { departments: [{ id: dept["PT Root"], includeChildren: true }] };
  scopedPT = await makeAdminUser("PT-A-SCOPED", await makeRole("Scoped PerfTalent C", { performance: "manage", talent: "manage" }, ptScope));
  plainPT = await makeAdminUser("PT-A-PLAIN", await makeRole("Plain PerfTalent C", { performance: "manage", talent: "manage" }));
  scopedPTP = await makeAdminUser("PT-A-SCOPED-P", await makeRole("Scoped PerfTalent People C", { performance: "manage", talent: "manage", people: "read" }, ptScope));
  plainPTP = await makeAdminUser("PT-A-PLAIN-P", await makeRole("Plain PerfTalent People C", { performance: "manage", talent: "manage", people: "read" }));
  talentOnly = await makeAdminUser("PT-A-TALENT", await makeRole("Talent Only C", { talent: "manage" }));
});
after(() => srv.stop());

// ---------- performance：开周期（圈人的三个分支） ----------
test("POST /review-cycles：显式 userIds 部分越界 → 整批拒绝，且不留空壳周期", async () => {
  const before = (await admin.get("/api/admin/review-cycles")).data.length;
  const r = await scopedPT.post("/api/admin/review-cycles", { name: "Rejected Cycle", userIds: [emp["PT-IN"], emp["PT-OUT"]] });
  assert.equal(r.status, 404);
  assert.equal(r.data.code, "out_of_scope");
  assert.equal(r.data.outOfScope, 1);
  // 建周期原本是这条 handler 的第一句 —— 拒绝必须发生在它之前，否则列表里会多一行
  // 谁也删不掉的空壳。
  const after2 = await admin.get("/api/admin/review-cycles");
  assert.equal(after2.data.length, before, "no shell cycle created");
  assert.ok(!after2.data.some((c) => c.name === "Rejected Cycle"), "rejected cycle absent");
});

test("POST /review-cycles：department 越界 → 400 dept_out_of_scope；范围内部门放行", async () => {
  const bad = await scopedPT.post("/api/admin/review-cycles", { name: "Dept Cycle Bad", department: "PT Other" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "dept_out_of_scope");
  const ok = await scopedPT.post("/api/admin/review-cycles", { name: "Dept Cycle Good", department: "PT Child" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.participants, 1, "only PT-KID");
});

test("POST /review-cycles：默认「全员」收窄成「范围内全员」", async () => {
  const r = await scopedPT.post("/api/admin/review-cycles", { name: "Scoped All Cycle" });
  assert.equal(r.status, 200);
  // 范围内有职级的在职员工只有 PT-IN 与 PT-KID；PT-NOLVL-IN 走 skippedNoLevel。
  assert.equal(r.data.participants, 2);
  assert.equal(r.data.skippedNoLevel, 1);
  const items = (await admin.get("/api/admin/review-cycles/" + r.data.cycle.id)).data.items.map((i) => i.employeeId).sort();
  assert.deepEqual(items, ["PT-IN", "PT-KID"]);
});

// ---------- P0 1.5：按部门圈人包含下级部门；部门选项与部门链按范围裁剪 ----------
test("P0 1.5 POST /review-cycles：选 PT Root（按名或按 id）包含下级 PT Child；noLevel 不受 includeNoLevel 影响", async () => {
  for (const sel of [{ department: "PT Root" }, { departmentId: dept["PT Root"] }]) {
    const r = await scopedPT.post("/api/admin/review-cycles", { dryRun: true, ...sel });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.participants, 2, "PT-IN + PT-KID（修复前只有 PT-IN）");
    assert.equal(r.data.skippedNoLevel, 1);
    assert.equal(r.data.noLevel, 1);
    const withNoLevel = await scopedPT.post("/api/admin/review-cycles", { dryRun: true, includeNoLevel: true, ...sel });
    assert.equal(withNoLevel.data.participants, 3);
    assert.equal(withNoLevel.data.noLevel, 1, "勾选「包含无职级」不改变 noLevel");
    // 部门选项：范围内全部在职员工的部门链（不受所选部门影响），PT Other 不在里面
    assert.deepEqual(r.data.deptOptions.map((o) => [o.id, o.parentId, o.path, o.level]),
      [[dept["PT Root"], null, "PT Root", 1], [dept["PT Child"], dept["PT Root"], "PT Root › PT Child", 2]]);
  }
  const bad = await scopedPT.post("/api/admin/review-cycles", { dryRun: true, departmentId: dept["PT Other"] });
  assert.equal(bad.data.code, "dept_out_of_scope");
});

test("P0 1.5：角色范围不含下级时，选 PT Root 被收窄成 1 人（不报错）", async () => {
  const noKids = await makeAdminUser("PT-A-NOKIDS", await makeRole("Root Only PerfTalent", { performance: "manage", talent: "manage" }, { departments: [{ id: dept["PT Root"], includeChildren: false }] }));
  const r = await noKids.post("/api/admin/review-cycles", { dryRun: true, departmentId: dept["PT Root"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.participants, 1, "PT-KID 在范围外，被收窄掉");
  assert.deepEqual(r.data.deptOptions.map((o) => o.id), [dept["PT Root"]]);
});

test("P0 1.5 GET /review-cycles/:id：范围只有 PT Child 的角色，deptOptions / deptPath 里没有 PT Root 与 PT Other", async () => {
  const childOnly = await makeAdminUser("PT-A-CHILD", await makeRole("Child Only PerfTalent", { performance: "manage", talent: "manage" }, { departments: [{ id: dept["PT Child"], includeChildren: true }] }));
  const cid = await openCycle("Dept Path Cycle", ["PT-IN", "PT-KID", "PT-OUT"]);
  const d = (await childOnly.get("/api/admin/review-cycles/" + cid)).data;
  assert.deepEqual(d.items.map((i) => i.employeeId), ["PT-KID"]);
  assert.deepEqual(d.items[0].deptPath, [dept["PT Child"]]);
  assert.deepEqual(d.deptOptions, [{ id: dept["PT Child"], name: "PT Child", parentId: null, path: "PT Child", level: 2 }]);
  // 全公司范围看同一个周期：完整的链与选项
  const all = (await admin.get("/api/admin/review-cycles/" + cid)).data;
  assert.deepEqual(all.items.find((i) => i.employeeId === "PT-KID").deptPath, [dept["PT Root"], dept["PT Child"]]);
  assert.deepEqual(all.deptOptions.map((o) => o.path), ["PT Other", "PT Root", "PT Root › PT Child"]);
  assert.equal(all.items.find((i) => i.employeeId === "PT-IN").hrCalibratable, true, "旧流程进行中");
});

// ---------- performance：读（过滤 + 重算） ----------
test("GET /review-cycles + /review-cycles/:id：items 过滤，total 与 distribution 重算", async () => {
  const cid = await openCycle("Mixed Cycle", ["PT-IN", "PT-OUT"]);
  await rateEveryone(cid, "B");
  const scopedList = (await scopedPT.get("/api/admin/review-cycles")).data.find((c) => c.id === cid);
  const superList = (await admin.get("/api/admin/review-cycles")).data.find((c) => c.id === cid);
  assert.equal(superList.total, 2, "super sees both");
  assert.equal(scopedList.total, 1, "分母跟着范围走，不是「算完再过滤」");
  assert.equal(scopedList.finalDone, 1);
  const one = await scopedPT.get("/api/admin/review-cycles/" + cid);
  assert.equal(one.status, 200, "周期容器本身仍可见：藏掉整个周期 = 授权了却用不了");
  assert.deepEqual(one.data.items.map((i) => i.employeeId), ["PT-IN"]);
  assert.deepEqual(one.data.distribution, { B: 1 }, "distribution 由过滤后的 items 导出");
  assert.deepEqual((await admin.get("/api/admin/review-cycles/" + cid)).data.distribution, { B: 2 });
});

// ---------- performance：增补参与者 / 校准 ----------
test("POST /review-cycles/:id/participants：部分越界 → 整批拒绝，一行都不加", async () => {
  const cid = await openCycle("Participants Cycle", ["PT-IN"]);
  const r = await scopedPT.post(`/api/admin/review-cycles/${cid}/participants`, { userIds: [emp["PT-KID"], emp["PT-OUT"]] });
  assert.equal(r.status, 404);
  assert.equal(r.data.code, "out_of_scope");
  assert.equal(r.data.outOfScope, 1);
  const items = (await admin.get("/api/admin/review-cycles/" + cid)).data.items;
  assert.equal(items.length, 1, "PT-KID 也没被加进去（整批，不是跳过）");
  // 全部在范围内时照常写入。
  assert.equal((await scopedPT.post(`/api/admin/review-cycles/${cid}/participants`, { userIds: [emp["PT-KID"]] })).data.added, 1);
});

test("PUT /review-items/:id：越界与「不存在」逐字同形（裸 404）", async () => {
  const cid = await openCycle("Calibrate Cycle", ["PT-IN", "PT-OUT"]);
  const items = (await admin.get("/api/admin/review-cycles/" + cid)).data.items;
  const outItem = items.find((i) => i.employeeId === "PT-OUT");
  const inItem = items.find((i) => i.employeeId === "PT-IN");
  const denied = await scopedPT.put("/api/admin/review-items/" + outItem.id, { finalRating: "A" });
  const missing = await scopedPT.put("/api/admin/review-items/no-such-item", { finalRating: "A" });
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.data, missing.data, "同形：不暴露这条 review item 确实存在");
  assert.equal((await scopedPT.put("/api/admin/review-items/" + inItem.id, { finalRating: "A" })).status, 200);
  // 越界那条的评级一个字没动。
  assert.equal((await admin.get("/api/admin/review-cycles/" + cid)).data.items.find((i) => i.employeeId === "PT-OUT").finalRating, null);
});

// ---------- performance：关账（本批次最危险的一条） ----------
test("POST /review-cycles/:id/close：含范围外参与者 → 整周期拒绝，周期保持 open，一条档案不写", async () => {
  const cid = await openCycle("Close Mixed Cycle", ["PT-IN", "PT-OUT"]);
  await rateEveryone(cid, "A");
  // 「落了几条绩效档案」用超管的 talent-search 数（它按 type 全量扫 talent_records）。
  const perfCount = async () => (await admin.post("/api/admin/talent-search", { type: "performance", fields: {} }))
    .data.results.reduce((n, x) => n + x.matchCount, 0);
  const before = await perfCount();
  const r = await scopedPT.post(`/api/admin/review-cycles/${cid}/close`);
  assert.equal(r.status, 404);
  assert.equal(r.data.code, "out_of_scope");
  assert.equal(r.data.outOfScope, 1);
  // 关账不可逆：拒绝必须是「什么都没发生」，不是「范围内的关了、范围外的留着」。
  const cyc = (await admin.get("/api/admin/review-cycles")).data.find((c) => c.id === cid);
  assert.equal(cyc.status, "open", "周期没被关掉");
  assert.equal(await perfCount(), before, "范围内的人也一条档案都没落 —— 部分关账被禁止");
  assert.equal((await admin.get("/api/admin/review-cycles/" + cid)).data.items.every((i) => !i.recordId), true);
  // 超管仍能把同一个周期正常关掉（范围不改变超管的行为）。
  const su = await admin.post(`/api/admin/review-cycles/${cid}/close`);
  assert.equal(su.status, 200);
  assert.equal(su.data.written, 2);
});

test("POST /review-cycles/:id/close：全员在范围内 → 照常关账", async () => {
  const cid = await openCycle("Close Clean Cycle", ["PT-IN", "PT-KID"]);
  await rateEveryone(cid, "B+");
  const r = await scopedPT.post(`/api/admin/review-cycles/${cid}/close`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.written, 2);
  assert.equal((await admin.get("/api/admin/review-cycles")).data.find((c) => c.id === cid).status, "closed");
});

// ---------- talent：晋升池（两个数组） ----------
test("GET /promotion-candidates：rows[] 与 unmapped[] 两个数组都过滤", async () => {
  const scoped = await scopedPT.get("/api/admin/promotion-candidates");
  assert.equal(scoped.status, 200);
  const rowIds = scoped.data.rows.map((r) => r.employeeId);
  const unIds = scoped.data.unmapped.map((r) => r.employeeId);
  assert.ok(rowIds.includes("PT-IN") && rowIds.includes("PT-KID"));
  assert.ok(!rowIds.includes("PT-OUT") && !rowIds.includes("PT-OUT2"), "rows 过滤");
  assert.ok(unIds.includes("PT-NOLVL-IN"), "范围内的无职级员工仍在 unmapped");
  assert.ok(!unIds.includes("PT-NOLVL-OUT"), "unmapped 也过滤（清单点名最容易漏的一个）");
  // 空范围与超管一字不变。
  for (const c of [admin, plainPT]) {
    const all = await c.get("/api/admin/promotion-candidates");
    assert.ok(all.data.rows.some((r) => r.employeeId === "PT-OUT"));
    assert.ok(all.data.unmapped.some((r) => r.employeeId === "PT-NOLVL-OUT"));
  }
  // 晋升配置是内容对象：不加门（读写都不受范围约束）。
  assert.equal((await scopedPT.get("/api/admin/promotion-config")).status, 200);
  assert.equal((await scopedPT.put("/api/admin/promotion-config", { minTenureMonths: 6 })).status, 200);
});

// ---------- talent：继任计划 ----------
// ⚠ vacancies / keyRoleCount 这两个字段**过不了线**：handler 把它们挂成数组的额外属性
// （payload.vacancies = ...），而 JSON.stringify 对数组只序列化下标项，非下标属性一律
// 丢弃 —— 所以它们从来没到过客户端（web/ 里也确实没有任何一处读它们）。这是本批次之前
// 就存在的问题，不在「加范围过滤」的范围内，故此处只测能过线的 rows[]；服务端两者已按
// 范围过滤/重算（见 handler 注释），等响应形状被修正后可直接补断言。
test("GET /succession：继任人行按范围过滤", async () => {
  const scoped = await scopedPT.get("/api/admin/succession");
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.data.map((r) => r.employeeId), ["PT-KID"]);
  const su = await admin.get("/api/admin/succession");
  assert.ok(su.data.some((r) => r.employeeId === "PT-OUT2"));
  assert.ok(su.data.length > scoped.data.length);
});

test("succession 写三条：越界与各自 handler 的「不存在」同形", async () => {
  // POST 的「查无此人」出口是 400，所以越界也回 400 —— 同形的对象是本 handler 的分支。
  const denied = await scopedPT.post("/api/admin/succession", { positionName: "Sneak", userId: emp["PT-OUT"], readiness: "ready" });
  const missing = await scopedPT.post("/api/admin/succession", { positionName: "Sneak", userId: "no-such-user", readiness: "ready" });
  assert.equal(denied.status, 400);
  assert.deepEqual(denied.data, missing.data);
  assert.equal((await admin.get("/api/admin/succession")).data.some((r) => r.positionName === "Sneak"), false);
  // PUT / DELETE 按 cur.userId → 裸 404，与「这条继任记录不存在」同形。
  const pDenied = await scopedPT.put("/api/admin/succession/" + succOut, { readiness: "twoYears" });
  const pMissing = await scopedPT.put("/api/admin/succession/no-such-entry", { readiness: "twoYears" });
  assert.equal(pDenied.status, 404);
  assert.deepEqual(pDenied.data, pMissing.data);
  const dDenied = await scopedPT.del("/api/admin/succession/" + succOut);
  assert.equal(dDenied.status, 404);
  assert.deepEqual(dDenied.data, pMissing.data);
  assert.equal((await admin.get("/api/admin/succession")).data.some((r) => r.id === succOut), true, "范围外那条一个字没动");
  // 范围内的照常可改。
  assert.equal((await scopedPT.put("/api/admin/succession/" + succIn, { readiness: "oneYear" })).status, 200);
});

// ---------- talent：九宫格 / 记录检索 / AI 画像 ----------
test("GET /talent-review：九宫格行过滤，分桶数字跟着重算", async () => {
  const scoped = await scopedPT.get("/api/admin/talent-review");
  assert.equal(scoped.status, 200);
  const ids = scoped.data.rows.map((r) => r.employeeId);
  assert.ok(ids.includes("PT-IN") && ids.includes("PT-KID") && ids.includes("PT-NOLVL-IN"));
  assert.ok(!ids.includes("PT-OUT") && !ids.includes("PT-OUT2") && !ids.includes("PT-NOLVL-OUT"));
  // 分桶完全由 rows 导出（前端按 perfBucket×potBucket 数格子），所以「格子里的数字」
  // 就是过滤后的计数 —— 逐桶比一遍：范围角色的每个格子都 ≤ 超管，且总数严格更小。
  const buckets = (rows) => {
    const m = {};
    for (const r of rows) { const k = r.perfBucket + "/" + r.potBucket; m[k] = (m[k] || 0) + 1; }
    return m;
  };
  const su = await admin.get("/api/admin/talent-review");
  const sb = buckets(scoped.data.rows), ab = buckets(su.data.rows);
  for (const k of Object.keys(sb)) assert.ok(sb[k] <= (ab[k] || 0), "bucket " + k + " 没有凭空变大");
  assert.ok(su.data.rows.length > scoped.data.rows.length, "分桶总数按范围重算，不是「过滤后不改分母」");
  // 范围外的每一行都不在，包括他们的部门名（部门本身也是情报）。
  assert.equal(scoped.data.rows.filter((r) => r.department === "PT Other").length, 0);
  assert.ok(su.data.rows.some((r) => r.employeeId === "PT-OUT"));
});

test("POST /talent-search：results 过滤，total 与 facets 一并重算", async () => {
  const scoped = await scopedPT.post("/api/admin/talent-search", { type: "performance", fields: {} });
  assert.equal(scoped.status, 200);
  const ids = scoped.data.results.map((r) => r.employeeId);
  assert.ok(ids.includes("PT-IN"));
  assert.ok(!ids.includes("PT-OUT"), "results 过滤");
  assert.equal(scoped.data.total, scoped.data.results.length, "total = 过滤后的行数");
  // facets 是取值分布，本身就是情报：范围外独有的 "D" 不该出现在范围角色的筛选下拉里。
  assert.ok(!scoped.data.facets.rating.includes("D"), "facets 也按范围重算");
  const su = await admin.post("/api/admin/talent-search", { type: "performance", fields: {} });
  assert.ok(su.data.facets.rating.includes("D"));
  assert.ok(su.data.total > scoped.data.total);
  // 直接拿范围外的取值去搜，也搜不出人来（不是靠前端不给选）。
  const probe = await scopedPT.post("/api/admin/talent-search", { type: "performance", fields: { rating: "D" } });
  assert.equal(probe.data.total, 0);
});

test("POST /employees/:id/ai-portrait：越界与「不存在」同形，且卡在 demo 分支之前", async () => {
  const denied = await scopedPTP.post(`/api/admin/employees/${emp["PT-OUT"]}/ai-portrait`);
  const missing = await scopedPTP.post("/api/admin/employees/no-such-user/ai-portrait");
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.data, missing.data, "200 的 demo 画像本身就会确认这个 id 有人");
  const ok = await scopedPTP.post(`/api/admin/employees/${emp["PT-IN"]}/ai-portrait`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.demo, true);
  assert.equal(ok.data.draft.status, "draft", "画像一律先存为草稿");
  // 负责人 2026-09-30：只有 talent、没有员工档案读权限（内置「人才管理员」的形状）也可以使用画像；不存在的 id 仍是 404
  const none = await talentOnly.post("/api/admin/employees/no-such-user/ai-portrait");
  assert.equal(none.status, 404);
  assert.notEqual((await scopedPT.post(`/api/admin/employees/${emp["PT-IN"]}/ai-portrait`)).data.code, "people_read_required");
});

// ---------- 工作台：阶段 A 留下的两个字段 ----------
test("GET /dashboard：cycles[] 与 succession 按范围重算，与各自的列表页同口径", async () => {
  const cid = await openCycle("Dash Cycle", ["PT-IN", "PT-OUT"]);
  const scoped = (await scopedPT.get("/api/admin/dashboard")).data;
  const su = (await admin.get("/api/admin/dashboard")).data;
  const sc = scoped.cycles.find((c) => c.id === cid);
  const sc2 = su.cycles.find((c) => c.id === cid);
  assert.equal(sc.total, 1, "首页进度分母与 /review-cycles 一致");
  assert.equal(sc2.total, 2);
  assert.equal(scoped.succession, (await scopedPT.get("/api/admin/succession")).data.length, "角标与列表页对得上");
  assert.ok(su.succession > scoped.succession);
  // 两层顺序的另一半（P1 的 W4 在范围之前）：一个**只有 people**、且带同一份范围的
  // 角色，连 cycles / succession 这两个**键**都不该有 —— 字段在不在由 grants 决定，
  // 与范围是几个部门无关。顺序颠倒的症状是「空数组 / 0」而不是「键不存在」，前端
  // 会把它当成「有权限但没数据」照常渲染卡片。
  const peopleOnly = await makeAdminUser("PT-A-PEOPLE", await makeRole("People Only C", { people: "read" }, ptScope));
  const po = (await peopleOnly.get("/api/admin/dashboard")).data;
  assert.equal("cycles" in po, false, "performance 未授权 → 字段不存在（不是空数组）");
  assert.equal("succession" in po, false, "talent 未授权 → 字段不存在（不是 0）");
  assert.equal(po.headcount, 3, "它自己的 people 字段仍按范围重算（两层都生效）");
});

// ---------- 回归红线：空范围 = 全公司，超管不受约束 ----------
test("空范围角色与超管：这 14 条的行为一字不变", async () => {
  for (const c of [admin, plainPT]) {
    const tr = await c.get("/api/admin/talent-review");
    const trIds = tr.data.rows.map((r) => r.employeeId);
    assert.ok(trIds.includes("PT-OUT") && trIds.includes("PT-IN"), "九宫格仍是全公司");
    const sx = await c.get("/api/admin/succession");
    assert.ok(sx.data.some((r) => r.employeeId === "PT-OUT2"));
    const cyc = await c.post("/api/admin/review-cycles", { name: "Plain Cycle " + Math.random(), userIds: [emp["PT-IN"], emp["PT-OUT"]] });
    assert.equal(cyc.status, 200, "空范围可以跨部门圈人");
    assert.equal(cyc.data.participants, 2);
    const closeRes = await c.post(`/api/admin/review-cycles/${cyc.data.cycle.id}/close`);
    assert.equal(closeRes.status, 200, "空范围可以关账");
    // 画像另要求 people 读：空范围角色用加了 people 读的同形角色（plainPTP）
    assert.equal((await (c === plainPT ? plainPTP : c).post(`/api/admin/employees/${emp["PT-OUT"]}/ai-portrait`)).status, 200);
    assert.equal((await c.get("/api/admin/promotion-candidates")).data.rows.some((r) => r.employeeId === "PT-OUT"), true);
  }
});
