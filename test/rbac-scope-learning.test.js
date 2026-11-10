// RBAC P2 数据范围（scope）—— learning 域 25 条端点的契约测试（阶段 B）。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db），造一棵两层部门树 +
// 三个员工（范围内根 / 范围内子部门 / 范围外），两个 learning 角色（带范围 / 空范围）
// 逐条验：
//   读 —— 范围外整条不返回（名单、答卷、导出、聚合分母）；
//   写 —— 范围外回与**同一 handler 的「不存在」逐字同形**的应答（404，assignments
//         那条是 400 —— 同形的对象是它自己的不存在分支，不是别处的 404）；
//   批量 —— 部分越界 → 整批拒绝 + 回报越界条数，且一行都没写；
//   混合主体 —— tprojects/:id 的项目文档照常可见可编，只有 members[] 被过滤；
//   内容对象 —— 课程/题库/考试定义/项目列表**不加门**（防「过滤过头 → 开箱即残」）；
//   回归红线 —— 空范围角色与超管的行为一字不变。
// people 域的 20 条在 test/rbac-scope-people.test.js；范围解析器本身在 test/rbac-scope.test.js。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs, completeAllModules } = require("./helpers.js");

let srv, admin;
const dept = {};        // name -> id
const emp = {};         // employeeId -> user id
const client = {};      // employeeId -> logged-in employee client
const attempt = {};     // employeeId -> attemptId
const appeal = {};      // employeeId -> appealId
let scopedLearn, plainLearn;
let tpId, tpApplyId, electiveId;
const COHORT = "cohort-scope", ACT = "act-scope-offline", OFFLINE_COURSE = "culture-conduct";

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}

// 建号 → 超管指派角色 → 登录 → 清掉强制改密标记（与 rbac-scope-people 同一套路）。
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

// 员工：建号 + 落部门 + 登录（learning 域的测试大量需要「员工自己产生的数据」——
// 答卷、申诉、选修申请、报名 —— 所以每个员工都要一个真会话）。
async function makeEmployee(empId, department) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  const roster = await admin.get("/api/admin/roster");
  const u = roster.data.find((x) => x.employeeId === empId);
  assert.ok(u, "find employee " + empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, { department, jobLevel: "P5" })).status, 200);
  emp[empId] = u.id;
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  client[empId] = c;
  return u.id;
}

// 一份提交过的答卷 + 一条待处理申诉（regrade / appeals / attempts / 两个导出都要它）。
async function seedAttemptAndAppeal(empId) {
  const c = client[empId];
  await completeAllModules(c, "nho");
  const start = await c.post("/api/exam/start", { programId: "nho" });
  assert.equal(start.status, 200, "exam start for " + empId);
  assert.equal((await c.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {} })).status, 200, "exam submit for " + empId);
  attempt[empId] = start.data.attemptId;
  const ap = await c.post(`/api/me/attempts/${start.data.attemptId}/appeal`, { reason: "Question 3 means the same as the answer key but was marked wrong." });
  assert.equal(ap.status, 200, "appeal for " + empId);
  appeal[empId] = ap.data.appeal.id;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["LRN Root", null], ["LRN Child", "LRN Root"], ["LRN Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  await makeEmployee("LRN-IN", "LRN Root");
  await makeEmployee("LRN-KID", "LRN Child");
  await makeEmployee("LRN-OUT", "LRN Other");
  // 三个人都指派 nho（逾期），这样 overview / remind-overdue / 导出都有料可比。
  for (const eid of ["LRN-IN", "LRN-KID", "LRN-OUT"]) {
    const r = await admin.post("/api/admin/assignments", { userId: emp[eid], items: [{ programId: "nho", assigned: true, dueAt: "2020-01-01" }] });
    assert.equal(r.status, 200, "assign nho to " + eid);
  }
  await seedAttemptAndAppeal("LRN-IN");
  await seedAttemptAndAppeal("LRN-OUT");
  // 选修程序 + 两条待审选修申请（enroll-requests / pending-counts）。
  const ep = await admin.post("/api/admin/programs", { title: "Scope Elective", title_zh: "范围选修课", status: "published", enrollType: "elective" });
  assert.equal(ep.status, 200);
  electiveId = ep.data.id;
  for (const eid of ["LRN-IN", "LRN-OUT"]) {
    assert.equal((await client[eid].post("/api/me/enroll-requests", { programId: electiveId, note: "scope test" })).status, 200, "enroll request " + eid);
  }
  // 训战营 A：两个人都在册（成员名单 / 看板 / 签到 / 加人 / 调班都用它）。
  const tp = await admin.post("/api/admin/tprojects", { title: "Scope Project", title_zh: "范围项目", category: "Leadership" });
  assert.equal(tp.status, 200);
  tpId = tp.data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + tpId, {
    status: "running",
    cohorts: [{
      id: COHORT, name: "Scope Cohort", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, open: false,
      classes: [{ id: "class-s", name: "Class S", headId: null }],
      phases: [{ id: "ph-1", name: "Phase 1", activities: [{ id: ACT, type: "offline", title: "Kickoff", startAt: "2026-01-02T09:00" }] }],
    }],
  })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${tpId}/members`, { cohortId: COHORT, userIds: [emp["LRN-IN"], emp["LRN-OUT"]] })).data.count, 2);
  // 训战营 B：开放报名，两个人各投一条提名（nominations / tprojects/:id/nominations）。
  const tp2 = await admin.post("/api/admin/tprojects", { title: "Scope Apply", title_zh: "范围报名项目" });
  assert.equal(tp2.status, 200);
  tpApplyId = tp2.data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + tpApplyId, {
    status: "planning",
    cohorts: [{ id: "cohort-apply", name: "Apply Cohort", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, open: true, classes: [], phases: [] }],
  })).status, 200);
  for (const eid of ["LRN-IN", "LRN-OUT"]) {
    assert.equal((await client[eid].post(`/api/me/tprojects/${tpApplyId}/apply`, { note: "scope" })).status, 200, "apply " + eid);
  }
  // 一门线下课（courses/:id/checkin 名单）。放在答卷之后做，免得改课影响开考。
  const content = await admin.get("/api/admin/content");
  const course = content.data.courses.find((c) => c.id === OFFLINE_COURSE);
  assert.ok(course, "seeded course present");
  assert.equal((await admin.put("/api/admin/content/courses/" + OFFLINE_COURSE, { ...course, mode: "offline", location: "Room 1", sessionAt: "2026-01-02T09:00" })).status, 200);
  // 范围 = LRN Root 子树（含下级）。learning 单域即可 —— 这一批 25 条全在 learning。
  const scope = { departments: [{ id: dept["LRN Root"], includeChildren: true }] };
  scopedLearn = await makeAdminUser("LRN-A-SCOPED", await makeRole("Scoped Learning B", { learning: "manage" }, scope));
  plainLearn = await makeAdminUser("LRN-A-PLAIN", await makeRole("Plain Learning B", { learning: "manage" }));
});
after(() => srv.stop());

// ---------- 读：名单类过滤 ----------
test("assignees / employees/:id/detail：名单过滤，单人主体越界与「不存在」同形", async () => {
  const list = await scopedLearn.get("/api/admin/programs/nho/assignees");
  assert.equal(list.status, 200);
  const ids = list.data.list.map((x) => x.employeeId);
  assert.ok(ids.includes("LRN-IN") && ids.includes("LRN-KID"), "范围内（含子部门）在名单里");
  assert.ok(!ids.includes("LRN-OUT"), "范围外整行不返回");
  assert.equal(list.data.count, list.data.list.length, "count 跟着过滤后的名单走");

  const ok = await scopedLearn.get("/api/admin/employees/" + emp["LRN-IN"] + "/detail");
  assert.equal(ok.status, 200, "范围内可读培训抽屉");
  const out = await scopedLearn.get("/api/admin/employees/" + emp["LRN-OUT"] + "/detail");
  const ghost = await scopedLearn.get("/api/admin/employees/u-does-not-exist/detail");
  assert.equal(out.status, 404, "阶段 A 留下的泄露已封（这条曾经返回范围外员工）");
  assert.deepEqual(out.data, ghost.data, "越界与不存在的响应体必须一字不差");
});

test("attempts：整卷明细按提交人过滤；序号不因看的人不同而变", async () => {
  const r = await scopedLearn.get("/api/admin/attempts");
  assert.equal(r.status, 200);
  const names = r.data.map((x) => x.employeeId);
  assert.ok(names.includes("LRN-IN"), "范围内的答卷在");
  assert.ok(!names.includes("LRN-OUT"), "范围外的答卷（含答题内容）整条不返回");
  const mine = r.data.find((x) => x.id === attempt["LRN-IN"]);
  const sup = (await admin.get("/api/admin/attempts")).data.find((x) => x.id === attempt["LRN-IN"]);
  assert.equal(mine.attemptNo, sup.attemptNo, "「第 N 次」用未过滤的全集算");
  assert.equal(mine.attemptTotal, sup.attemptTotal);
  assert.ok(mine.appeal, "申诉随答卷一起来（learning 没有单独的 appeals 列表端点）");
});

test("两个 CSV 导出都不含范围外员工", async () => {
  const completion = await (await scopedLearn.raw("GET", "/api/admin/export/completion.csv")).text();
  assert.ok(completion.includes("LRN-IN") && completion.includes("LRN-KID"), "范围内的人在完成率导出里");
  assert.ok(!completion.includes("LRN-OUT"), "completion.csv 不含范围外员工");
  const attempts = await (await scopedLearn.raw("GET", "/api/admin/export/attempts.csv")).text();
  assert.ok(attempts.includes("LRN-IN"), "范围内的答卷在");
  assert.ok(!attempts.includes("LRN-OUT"), "attempts.csv 不含范围外员工");
  // 超管仍然拿到全公司（导出是最容易「顺手过滤过头」的一处）。
  const sup = await (await admin.raw("GET", "/api/admin/export/completion.csv")).text();
  assert.ok(sup.includes("LRN-OUT"), "超管不受范围约束");
});

test("nominations / enroll-requests / pending-counts：三者口径一致（角标不再对不上）", async () => {
  const noms = await scopedLearn.get("/api/admin/nominations");
  assert.deepEqual(noms.data.map((x) => x.employeeId), ["LRN-IN"]);
  const reqs = await scopedLearn.get("/api/admin/enroll-requests");
  assert.deepEqual(reqs.data.map((x) => x.employeeId), ["LRN-IN"]);
  const counts = await scopedLearn.get("/api/admin/pending-counts");
  assert.equal(counts.data.nominations, noms.data.length, "侧栏角标 = 列表条数");
  assert.equal(counts.data.enroll, reqs.data.length);
  // 超管两边都看得到（证明数据确实存在，过滤发生在响应侧而不是数据侧）。
  const supCounts = await admin.get("/api/admin/pending-counts");
  assert.equal(supCounts.data.nominations, 2);
  assert.equal(supCounts.data.enroll, 2);
});

test("overview：基础人群与分母按范围重算，overdueList/recent 不带范围外的人", async () => {
  const r = await scopedLearn.get("/api/admin/overview");
  assert.equal(r.status, 200);
  assert.ok(!Object.keys(r.data.byDept).includes("LRN Other"), "byDept 不含范围外部门");
  assert.ok(Object.keys(r.data.byDept).includes("LRN Root"), "范围内部门还在");
  const nho = r.data.perProgram.find((p) => p.id === "nho");
  const overdue = nho.overdueList.map((x) => x.employeeId);
  assert.ok(overdue.includes("LRN-IN") && !overdue.includes("LRN-OUT"), "overdueList 按范围过滤");
  assert.ok(!r.data.recent.some((x) => x.employeeId === "LRN-OUT"), "recent 按范围过滤");
  const sup = await admin.get("/api/admin/overview");
  assert.ok(sup.data.employees > r.data.employees, "超管的分母仍是全公司");
  assert.ok(sup.data.perProgram.find((p) => p.id === "nho").attempts > nho.attempts, "passRate 的分母也跟着范围走");
});

// ---------- 混合主体 ----------
test("tprojects/:id：项目文档照常可见可编，只有 members[] 被过滤、actStats 跟着重算", async () => {
  const r = await scopedLearn.get("/api/admin/tprojects/" + tpId);
  assert.equal(r.status, 200, "混合主体端点绝不能整条藏掉");
  assert.equal(r.data.title, "Scope Project", "项目文档（内容对象）一个字都不动");
  assert.equal(r.data.cohorts[0].phases[0].activities[0].id, ACT, "阶段/活动结构完整");
  assert.deepEqual(r.data.members.map((m) => m.employeeId), ["LRN-IN"], "只有员工那一半被过滤");
  assert.equal(r.data.actStats[ACT].total, 1, "actStats 分母 = 范围内的在册学员（重算）");
  assert.equal((await admin.get("/api/admin/tprojects/" + tpId)).data.actStats[ACT].total, 2, "超管看到真实在册数");
  // 内容照旧可编（范围绝不能变成「授权了却用不了」）。
  assert.equal((await scopedLearn.put("/api/admin/tprojects/" + tpId, { title: "Scope Project", sponsor: "HR" })).status, 200);
});

test("tprojects 看板 / 签到名单 / 项目内提名：过滤 + 统计重算，签到码不受影响", async () => {
  const dash = await scopedLearn.get(`/api/admin/tprojects/${tpId}/dashboard?cohort=${COHORT}`);
  assert.equal(dash.status, 200);
  assert.equal(dash.data.members, 1, "看板分母只数范围内学员");
  assert.ok(!dash.data.risks.some((x) => x.employeeId === "LRN-OUT"), "risks[] 带姓名工号 → 按范围过滤");
  assert.equal((await admin.get(`/api/admin/tprojects/${tpId}/dashboard?cohort=${COHORT}`)).data.members, 2);

  const ck = await scopedLearn.get(`/api/admin/tprojects/${tpId}/checkin/${ACT}`);
  assert.equal(ck.status, 200);
  assert.deepEqual(ck.data.list.map((x) => x.employeeId), ["LRN-IN"]);
  assert.equal(ck.data.stats.missing, 1, "stats 由过滤后的名单派生 = 重算");
  const supCk = await admin.get(`/api/admin/tprojects/${tpId}/checkin/${ACT}`);
  assert.equal(supCk.data.stats.missing, 2);
  assert.equal(ck.data.code, supCk.data.code, "签到码是 HMAC 纯派生，刻意不受范围影响");

  const noms = await scopedLearn.get(`/api/admin/tprojects/${tpApplyId}/nominations`);
  assert.deepEqual(noms.data.map((x) => x.employeeId), ["LRN-IN"]);
});

test("courses/:id/checkin：线下课名单过滤 + stats 重算", async () => {
  const r = await scopedLearn.get(`/api/admin/courses/${OFFLINE_COURSE}/checkin`);
  assert.equal(r.status, 200);
  const ids = r.data.list.map((x) => x.employeeId);
  assert.ok(ids.includes("LRN-IN") && ids.includes("LRN-KID"));
  assert.ok(!ids.includes("LRN-OUT"), "范围外的人不在线下课名单里");
  assert.equal(r.data.stats.attended + r.data.stats.late + r.data.stats.excused + r.data.stats.missing, r.data.list.length, "stats 与名单同源");
});

// ---------- 写：单人主体 → 与「不存在」同形 ----------
test("单人写六条：范围外的应答与同一 handler 的「不存在」逐字同形", async () => {
  const exams = await admin.get("/api/admin/exams");
  const examId = exams.data[0].id;
  const cases = [
    ["reset-attempts", () => scopedLearn.post(`/api/admin/exams/${examId}/reset-attempts`, { userId: emp["LRN-OUT"] }),
      () => scopedLearn.post(`/api/admin/exams/${examId}/reset-attempts`, { userId: "u-nope" })],
    ["appeals/resolve", () => scopedLearn.post(`/api/admin/appeals/${appeal["LRN-OUT"]}/resolve`, { status: "accepted", resolution: "ok" }),
      () => scopedLearn.post("/api/admin/appeals/ap-nope/resolve", { status: "accepted", resolution: "ok" })],
    ["attempts/regrade", () => scopedLearn.post(`/api/admin/attempts/${attempt["LRN-OUT"]}/regrade`, { questionId: "q1", score: 10 }),
      () => scopedLearn.post("/api/admin/attempts/at-nope/regrade", { questionId: "q1", score: 10 })],
    ["tprojects/members/update", () => scopedLearn.post(`/api/admin/tprojects/${tpId}/members/update`, { userId: emp["LRN-OUT"], action: "withdraw" }),
      () => scopedLearn.post(`/api/admin/tprojects/${tpId}/members/update`, { userId: "u-nope", action: "withdraw" })],
    ["tprojects/checkin/mark", () => scopedLearn.post(`/api/admin/tprojects/${tpId}/checkin/${ACT}/mark`, { userId: emp["LRN-OUT"], status: "attended" }),
      () => scopedLearn.post(`/api/admin/tprojects/${tpId}/checkin/${ACT}/mark`, { userId: "u-nope", status: "attended" })],
    ["courses/checkin/mark", () => scopedLearn.post(`/api/admin/courses/${OFFLINE_COURSE}/checkin/mark`, { userId: emp["LRN-OUT"], status: "attended" }),
      () => scopedLearn.post(`/api/admin/courses/${OFFLINE_COURSE}/checkin/mark`, { userId: "u-nope", status: "attended" })],
  ];
  for (const [label, outCall, ghostCall] of cases) {
    const out = await outCall(), ghost = await ghostCall();
    assert.equal(out.status, 404, label + " 越界 → 404");
    assert.equal(out.status, ghost.status, label + " 与不存在同一状态码");
    assert.deepEqual(out.data, ghost.data, label + " 与不存在逐字同形");
  }
  // 范围外的人一行都没被写到。
  assert.equal((await admin.get(`/api/admin/tprojects/${tpId}/checkin/${ACT}`)).data.stats.missing, 2, "标出勤没写进去");
  assert.equal((await admin.get("/api/admin/attempts")).data.find((x) => x.id === attempt["LRN-OUT"]).appeal.status, "open", "申诉没被处理");
  assert.equal((await admin.get("/api/admin/tprojects/" + tpId)).data.members.length, 2, "没被退出项目");
});

test("两条审批 decide：越界与「这条审批不存在」同形，且排在 status 检查之前", async () => {
  const outNom = (await admin.get("/api/admin/nominations")).data.find((x) => x.employeeId === "LRN-OUT");
  const outReq = (await admin.get("/api/admin/enroll-requests")).data.find((x) => x.employeeId === "LRN-OUT");
  const nom = await scopedLearn.post(`/api/admin/nominations/${outNom.id}/decide`, { decision: "approve" });
  const nomGhost = await scopedLearn.post("/api/admin/nominations/nm-nope/decide", { decision: "approve" });
  assert.equal(nom.status, 404);
  assert.deepEqual(nom.data, nomGhost.data);
  const req = await scopedLearn.post(`/api/admin/enroll-requests/${outReq.id}/decide`, { decision: "approve" });
  const reqGhost = await scopedLearn.post("/api/admin/enroll-requests/er-nope/decide", { decision: "approve" });
  assert.equal(req.status, 404);
  assert.deepEqual(req.data, reqGhost.data);
  assert.equal((await admin.get("/api/admin/pending-counts")).data.nominations, 2, "两条都还挂着（没被批也没被拒）");
  assert.equal((await admin.get("/api/admin/pending-counts")).data.enroll, 2);
  // 范围内的同样调用要成功 —— 卡的是范围，不是端点。
  const inNom = (await scopedLearn.get("/api/admin/nominations")).data[0];
  assert.equal((await scopedLearn.post(`/api/admin/nominations/${inNom.id}/decide`, { decision: "reject", note: "scope test" })).status, 200);
  const inReq = (await scopedLearn.get("/api/admin/enroll-requests")).data[0];
  assert.equal((await scopedLearn.post(`/api/admin/enroll-requests/${inReq.id}/decide`, { decision: "approve" })).status, 200);
});

test("assignments 单人：越界复用它自己的「不存在」出口（400 Invalid request，不是 404）", async () => {
  const out = await scopedLearn.post("/api/admin/assignments", { userId: emp["LRN-OUT"], items: [{ programId: "nho", assigned: false }] });
  const ghost = await scopedLearn.post("/api/admin/assignments", { userId: "u-nope", items: [{ programId: "nho", assigned: false }] });
  assert.equal(out.status, 400, "同一 handler 的不存在分支是 400 —— 回 404 反而会漏出「这个 id 存在」");
  assert.deepEqual(out.data, ghost.data);
  assert.ok((await admin.get("/api/admin/employees/" + emp["LRN-OUT"] + "/detail")).data.programs.find((p) => p.id === "nho").assigned, "范围外的指派没被取消");
  assert.equal((await scopedLearn.post("/api/admin/assignments", { userId: emp["LRN-IN"], items: [{ programId: electiveId, assigned: true }] })).status, 200, "范围内照常可写");
});

// ---------- 写：批量 → 整批拒绝 ----------
test("assignments/bulk：部分越界整批拒绝 + 回报条数，范围内那条也没写", async () => {
  const mixed = await scopedLearn.post("/api/admin/assignments/bulk", { userIds: [emp["LRN-KID"], emp["LRN-OUT"]], programId: electiveId, action: "assign" });
  assert.equal(mixed.status, 404);
  assert.equal(mixed.data.code, "out_of_scope");
  assert.equal(mixed.data.outOfScope, 1, "回报越界条数");
  const kid = await admin.get("/api/admin/employees/" + emp["LRN-KID"] + "/detail");
  assert.equal(kid.data.programs.find((p) => p.id === electiveId).assigned, false, "整批拒绝 = 一行都没写");
  // 查无此工号仍按原样跳过 + 200（口径不变，只有「存在但越界」才整批拒绝）。
  const ghosts = await scopedLearn.post("/api/admin/assignments/bulk", { userIds: ["u-nope", emp["LRN-KID"]], programId: electiveId, action: "assign" });
  assert.equal(ghosts.status, 200);
  assert.equal(ghosts.data.count, 1);
});

test("tprojects/:id/members：部分越界整批拒绝，且容量按真实在册数算（不按范围内人数）", async () => {
  const mixed = await scopedLearn.post(`/api/admin/tprojects/${tpId}/members`, { cohortId: COHORT, userIds: [emp["LRN-KID"], emp["LRN-OUT"]] });
  assert.equal(mixed.status, 404);
  assert.equal(mixed.data.code, "out_of_scope");
  assert.equal(mixed.data.outOfScope, 1);
  assert.equal((await admin.get("/api/admin/tprojects/" + tpId)).data.members.length, 2, "一个人都没加进去");
  // 容量：范围内只看得到 1 人，但真实在册 2 人 —— 上限按 2 算，否则一路超容。
  assert.equal((await admin.put("/api/admin/tprojects/" + tpId, {
    title: "Scope Project",
    cohorts: [{ ...(await admin.get("/api/admin/tprojects/" + tpId)).data.cohorts[0], capacity: 2 }],
  })).status, 200);
  const full = await scopedLearn.post(`/api/admin/tprojects/${tpId}/members`, { cohortId: COHORT, userIds: [emp["LRN-KID"]] });
  assert.equal(full.status, 409, "容量用未过滤的在册数");
  assert.equal(full.data.current, 2);
});

test("remind-overdue：只发给范围内的人，范围外不发也不计数", async () => {
  const r = await scopedLearn.post("/api/admin/training/remind-overdue", { programId: "nho" });
  assert.equal(r.status, 200);
  const ids = r.data.sample.map((x) => x.employeeId);
  assert.ok(ids.includes("LRN-IN") || ids.includes("LRN-KID"), "范围内的逾期被提醒");
  assert.ok(!ids.includes("LRN-OUT"), "范围外的人不发");
  assert.ok(r.data.reminded <= 2, "reminded 只数范围内的收件人");
  const sup = await admin.post("/api/admin/training/remind-overdue", { programId: "nho" });
  // CX-114：范围内的人今天已就这门课提醒过，超管这次计入 skippedToday
  assert.ok(sup.data.reminded + sup.data.skippedToday > r.data.reminded, "超管仍然扫全公司");
});

// ---------- 内容对象：不加门（防「过滤过头」）----------
test("内容对象不受范围约束：课程库 / 题库 / 考试定义 / 项目列表与超管一字不差", async () => {
  for (const p of ["/api/admin/content", "/api/admin/catalog", "/api/admin/exams", "/api/admin/questions", "/api/admin/tprojects", "/api/admin/programs"]) {
    const mine = await scopedLearn.get(p);
    const sup = await admin.get(p);
    assert.equal(mine.status, 200, p + " 可达");
    assert.deepEqual(mine.data, sup.data, p + " 是内容对象，范围受限的角色看到的必须与超管一字不差");
  }
});

// ---------- 回归红线 ----------
test("空范围角色与超管：learning 的每条端点行为一字不变", async () => {
  // 签到名单的响应带 secondsLeft（当前签到码还剩几秒失效，按请求时刻现算）：前后两次请求跨过整秒就差 1，跨过整分钟时
  // 签到码 code 也会换。比较前去掉 secondsLeft；两边 code 不同（恰好跨过整分钟）时重取一次再比。只改比较方式，
  // 被测接口的行为不变（secondsLeft 仍须是 0–60 的整数）。
  const withoutClock = (d) => {
    if (!d || typeof d !== "object" || Array.isArray(d) || !("secondsLeft" in d)) return d;
    const { secondsLeft, ...rest } = d;
    assert.ok(Number.isInteger(secondsLeft) && secondsLeft >= 0 && secondsLeft <= 60, "secondsLeft " + secondsLeft);
    return rest;
  };
  const same = async (p) => {
    let mine, sup;
    for (let attempt = 0; attempt < 2; attempt++) {
      mine = await plainLearn.get(p); sup = await admin.get(p);
      const a = withoutClock(mine.data), b = withoutClock(sup.data);
      if (a === mine.data || b === sup.data || a.code === b.code) break;   // 不带时钟的响应，或两次请求在同一分钟内
    }
    assert.equal(mine.status, sup.status, p);
    assert.deepEqual(withoutClock(mine.data), withoutClock(sup.data), "空范围 " + p + " 与超管逐字节一致（= 全公司；签到名单除 secondsLeft 外）");
  };
  for (const p of ["/api/admin/attempts", "/api/admin/nominations", "/api/admin/enroll-requests",
    "/api/admin/pending-counts", "/api/admin/overview", "/api/admin/programs/nho/assignees",
    "/api/admin/tprojects/" + tpId, `/api/admin/tprojects/${tpId}/dashboard?cohort=${COHORT}`,
    `/api/admin/courses/${OFFLINE_COURSE}/checkin`]) await same(p);
  assert.ok((await plainLearn.get("/api/admin/programs/nho/assignees")).data.list.some((x) => x.employeeId === "LRN-OUT"), "空范围看得到范围外的人");
  const csv = await (await plainLearn.raw("GET", "/api/admin/export/completion.csv")).text();
  assert.ok(csv.includes("LRN-OUT"), "空范围导出仍是全公司");
  // 空范围角色照旧能写到任何人（「越界」这个概念对它不存在）。
  assert.equal((await plainLearn.get("/api/admin/employees/" + emp["LRN-OUT"] + "/detail")).status, 200);
  assert.equal((await plainLearn.post(`/api/admin/courses/${OFFLINE_COURSE}/checkin/mark`, { userId: emp["LRN-OUT"], status: "attended" })).status, 200);
  assert.equal((await plainLearn.post("/api/admin/assignments/bulk", { userIds: [emp["LRN-IN"], emp["LRN-OUT"]], programId: electiveId, action: "assign" })).data.count, 2, "跨部门的一批对空范围角色是合法的");
});

test("坏 scope 在 learning 端点上 fail closed：响亮地空，绝不退化成全公司", async () => {
  const bad = await makeAdminUser("LRN-A-BAD", await makeRole("Bad Scope Learning", { learning: "manage" }, { departments: "LRN Root" }));
  assert.deepEqual((await bad.get("/api/admin/attempts")).data, []);
  assert.deepEqual((await bad.get("/api/admin/nominations")).data, []);
  assert.deepEqual((await bad.get("/api/admin/enroll-requests")).data, []);
  assert.deepEqual((await bad.get("/api/admin/programs/nho/assignees")).data.list, []);
  assert.equal((await bad.get("/api/admin/overview")).data.employees, 0);
  assert.equal((await bad.get("/api/admin/pending-counts")).data.enroll, 0);
  assert.equal((await bad.get("/api/admin/employees/" + emp["LRN-IN"] + "/detail")).status, 404);
  // 但内容对象照旧可读 —— fail closed 关的是「人」，不是课。
  assert.equal((await bad.get("/api/admin/tprojects/" + tpId)).status, 200);
  assert.deepEqual((await bad.get("/api/admin/tprojects/" + tpId)).data.members, []);
});

// 第三批 4.1 / 4.2 / 8.6（2026-10-08）：新端点同样按范围出人 —— v2 看板、下钻名单（含 CSV）、全局搜索、按职级圈人的预览。
test("第三批：overview v2 / overview/people / training/search / assignments/preview 只含范围内的人", async () => {
  const v2 = (await scopedLearn.get("/api/admin/overview?v=2")).data;
  assert.equal(v2.employees, 2, "LRN-IN + LRN-KID");
  const all = (await admin.get("/api/admin/overview?v=2")).data;
  assert.ok(all.employees > v2.employees);
  for (const r of v2.heat.rows) assert.ok(!/LRN Other/.test(r.name || "") && !/LRN Other/.test(r.path || ""), "no out-of-scope department");
  const list = (await scopedLearn.get("/api/admin/overview/people?metric=assigned&programs=nho&size=200")).data;
  assert.deepEqual(list.rows.map((r) => r.employeeId).sort(), ["LRN-IN", "LRN-KID"]);
  const csv = await (await scopedLearn.raw("GET", "/api/admin/overview/people?metric=assigned&programs=nho&format=csv")).text();
  assert.ok(csv.includes("LRN-IN") && !csv.includes("LRN-OUT"), "CSV follows the scope");
  const s = (await scopedLearn.get("/api/admin/training/search?q=LRN")).data;
  assert.ok(s.people.some((p) => p.employeeId === "LRN-IN") && !s.people.some((p) => p.employeeId === "LRN-OUT"));
  assert.ok(!s.depts.some((d) => d.name === "LRN Other"), "departments are scoped");
  const ds = (await scopedLearn.get("/api/admin/training/search?q=" + encodeURIComponent("LRN Oth"))).data;
  assert.deepEqual(ds.depts, []);
  const pv = (await scopedLearn.get("/api/admin/assignments/preview?depts=" + encodeURIComponent(dept["LRN Root"]) + "&programId=nho")).data;
  assert.equal(pv.matched, 2);
  assert.equal(pv.alreadyAssigned, 2, "both already have nho");
  assert.equal((await scopedLearn.get("/api/admin/assignments/preview?depts=" + encodeURIComponent(dept["LRN Other"]))).status, 400, "out-of-scope department → bad_dept");
});
