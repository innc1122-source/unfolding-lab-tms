// P3（D8）经理那半边的契约测试：汇报线子树解析 + 只读下属档案 + /api/me/team 扩到整条线。
//   子树 —— 多层、隔层、成环不死循环、无下属、系统账号(role==='admin')被排除；
//   只读档案 —— 直接下属与隔层下属都读得到完整档案（身份/入转调离/全部绩效史/培训/
//               人才标签与潜力），汇报线外与查无此人**同形 404**，普通员工读谁都是 404，
//               这条通路上没有任何写操作，且不因此获得任何 /api/admin/* 入口；
//   审计 —— 每次读档落一行 manager.view_profile（谁看了谁），目标能解析出姓名；
//   裁剪 —— 开放周期里的自评正文（selfFeedback 等）不上行到隔层经理。
// 讲师/班主任那半边早已落地（见 RBAC-DESIGN.md §8.1），不在本文件范围内。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin;
const emp = {};      // employeeId -> user id
const cli = {};      // employeeId -> logged-in client

// 建号 → 落上级等字段 → 登录 → 清掉强制改密标记（与 rbac-scope-* 同一套路）。
async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId + " " + JSON.stringify(created.data));
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  emp[empId] = u.id;
  if (patch) assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  cli[empId] = c;
  return u.id;
}

// PUT /employees/:id 与（2026-09-25 起）bulk-update 都会挡住成环，但导入/历史数据
// 里仍可能留着环，所以环只能绕过接口、直接写测试临时库来造（跨进程写库由服务端的
// 缓存失效机制感知）。
async function setManagerUnchecked(empId, managerEmpId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(srv.dbPath);
  try {
    db.prepare("UPDATE users SET managerId = ? WHERE id = ?").run(managerEmpId ? emp[managerEmpId] : null, emp[empId]);
  } finally { db.close(); }
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // 三层树：TOP → MID → {LEAF, LEAF2}，外加一个不相干的 OUT。
  await makeEmployee("ML-TOP", { department: "ML Line", position: "Director", hireDate: "2019-01-01" });
  await makeEmployee("ML-MID", { department: "ML Line", position: "Manager", hireDate: "2020-01-01", managerId: emp["ML-TOP"] });
  await makeEmployee("ML-LEAF", { department: "ML Line", position: "Analyst", hireDate: "2021-01-01", managerId: emp["ML-MID"] });
  await makeEmployee("ML-LEAF2", { department: "ML Line", position: "Analyst", hireDate: "2021-06-01", managerId: emp["ML-MID"] });
  await makeEmployee("ML-OUT", { department: "ML Elsewhere", position: "Nobody", hireDate: "2022-01-01" });
  // 环：C1 → C2 → C3 → C1。
  await makeEmployee("ML-C1", { department: "ML Loop" });
  await makeEmployee("ML-C2", { department: "ML Loop", managerId: emp["ML-C1"] });
  await makeEmployee("ML-C3", { department: "ML Loop", managerId: emp["ML-C2"] });
  await setManagerUnchecked("ML-C1", "ML-C3");
});
after(() => srv.stop());

// 第三批 9.1：员工端名单不再下发工号；测试账号的姓名即工号，按姓名比对
const idsOf = (rows) => rows.map((r) => r.name).sort();

test("the team view is the whole reporting line, with skip-levels labelled", async () => {
  const r = await cli["ML-TOP"].get("/api/me/team");
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.data.rows), ["ML-LEAF", "ML-LEAF2", "ML-MID"]);
  assert.equal(r.data.count, 3);
  assert.equal(r.data.directCount, 1, "only ML-MID reports to ML-TOP directly");
  const mid = r.data.rows.find((x) => x.name === "ML-MID");
  const leaf = r.data.rows.find((x) => x.name === "ML-LEAF");
  assert.equal(mid.relation, "direct");
  assert.equal(mid.depth, 1);
  assert.equal(leaf.relation, "indirect");
  assert.equal(leaf.depth, 2);
  assert.equal(leaf.managerName, "ML-MID", "a skip-level row names its own manager");
  // 既有字段一个都不能少 —— MyTeam.jsx 直接消费它们（**直接下属**那一行）。
  // F2 起隔层行只带身份/组织/relation 那几项，培训明细不再预算；
  // 全套字段口径见 test/team-cost.test.js。
  for (const k of ["userId", "name", "department", "active", "position",
                   "jobLevel", "empStatus", "assigned", "done", "overdue", "items"])
    assert.ok(k in mid, "/api/me/team direct row keeps " + k);
  assert.ok(!("employeeId" in mid) && !("employeeId" in leaf), "第三批 9.1：员工端名单不下发工号");
  assert.ok(Array.isArray(mid.items));
  for (const k of ["userId", "name", "department", "active", "position", "jobLevel", "empStatus"])
    assert.ok(k in leaf, "/api/me/team skip-level row keeps identity field " + k);
  // 中层只看得到自己下面那一段。
  const midView = await cli["ML-MID"].get("/api/me/team");
  assert.deepEqual(idsOf(midView.data.rows), ["ML-LEAF", "ML-LEAF2"]);
  assert.ok(midView.data.rows.every((x) => x.relation === "direct"));
});

test("someone with no reports gets an empty line, not everyone", async () => {
  const r = await cli["ML-OUT"].get("/api/me/team");
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 0);
  assert.equal(r.data.rows.length, 0);
});

test("system accounts are never part of anyone's reporting line", async () => {
  const adminUser = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === ADMIN.employeeId);
  assert.ok(adminUser, "seeded admin present");
  const r0 = await admin.post("/api/admin/employees/bulk-update", { userIds: [adminUser.id], fields: { managerId: emp["ML-TOP"] } });
  assert.equal(r0.status, 200);
  try {
    const r = await cli["ML-TOP"].get("/api/me/team");
    assert.ok(!r.data.rows.some((x) => x.userId === adminUser.id), "role==='admin' excluded");
    assert.equal(r.data.count, 3, "line size unchanged");
    assert.equal((await cli["ML-TOP"].get("/api/me/reports/" + adminUser.id)).status, 404);
  } finally {
    await admin.post("/api/admin/employees/bulk-update", { userIds: [adminUser.id], fields: { managerId: "" } });
  }
});

test("a reporting loop is walked once, not forever", async () => {
  // 走到这里就说明没死循环（node --test 的超时会先杀掉挂住的请求）。
  const r = await cli["ML-C1"].get("/api/me/team");
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r.data.rows), ["ML-C2", "ML-C3"]);
  assert.ok(!r.data.rows.some((x) => x.name === "ML-C1"), "the root never reports to itself");
  assert.equal(r.data.rows.find((x) => x.name === "ML-C3").depth, 2);
  // 环确实存在（C1 → C3 这条边已被服务端读到）：C3 的汇报线里有 C1、C2。
  assert.deepEqual(idsOf((await cli["ML-C3"].get("/api/me/team")).data.rows), ["ML-C1", "ML-C2"]);
  // 单人校验走同一套解析：环里的人互相可见，但谁都读不到自己。
  assert.equal((await cli["ML-C1"].get("/api/me/reports/" + emp["ML-C3"])).status, 200);
  assert.equal((await cli["ML-C1"].get("/api/me/reports/" + emp["ML-C1"])).status, 404);
});

test("a manager reads a direct report's full profile", async () => {
  const r = await cli["ML-MID"].get("/api/me/reports/" + emp["ML-LEAF"]);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, "ML-LEAF");
  assert.ok(!("employeeId" in r.data.user), "第三批 9.1：下属档案不下发工号");
  assert.equal(r.data.user.relation, "direct");
  assert.equal(r.data.user.depth, 1);
  assert.deepEqual(r.data.chain, [], "nobody sits between a direct report and me");
  assert.equal(r.data.user.hireDate, "2021-01-01");
  assert.equal(r.data.user.position, "Analyst");
  assert.equal(r.data.user.managerName, "ML-MID");
  assert.ok(Array.isArray(r.data.events) && r.data.events.length, "timeline has at least the hire anchor");
  assert.ok(Array.isArray(r.data.assignments));
  assert.ok(Array.isArray(r.data.performance));
  assert.ok(r.data.stats && typeof r.data.stats.trainingsPassed === "number");
  // 后台版里那些**不该**给经理的东西，一个都不能漏出来。
  for (const k of ["config", "suggestions", "secondaryReports"])
    assert.ok(!(k in r.data), "manager profile must not ship " + k);
  for (const k of ["extras", "lastLoginAt", "createdAt", "role", "adminRoleId"])
    assert.ok(!(k in r.data.user), "manager profile must not ship user." + k);
});

test("a skip-level report's profile reads too, with the chain that explains it", async () => {
  const r = await cli["ML-TOP"].get("/api/me/reports/" + emp["ML-LEAF"]);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.relation, "indirect");
  assert.equal(r.data.user.depth, 2);
  assert.deepEqual(r.data.chain.map((x) => x.name), ["ML-MID"]);
  assert.ok(r.data.chain.every((x) => !("employeeId" in x)), "第三批 9.1：汇报链不下发工号");
});

test("outside the reporting line is indistinguishable from not existing", async () => {
  const outside = await cli["ML-TOP"].get("/api/me/reports/" + emp["ML-OUT"]);
  const nobody = await cli["ML-TOP"].get("/api/me/reports/u-no-such-person");
  const self = await cli["ML-TOP"].get("/api/me/reports/" + emp["ML-TOP"]);
  assert.equal(outside.status, 404);
  assert.equal(nobody.status, 404);
  assert.equal(self.status, 404, "your own profile is /api/me/growth, not this route");
  assert.deepEqual(outside.data, nobody.data, "same body, byte for byte");
  assert.deepEqual(self.data, nobody.data);
  // 没有下属的人在这条通路上读不到任何人（含自己的上级、自己的同事）。
  for (const who of ["ML-TOP", "ML-LEAF", "ML-OUT"])
    assert.equal((await cli["ML-OUT"].get("/api/me/reports/" + emp[who])).status, 404, "ML-OUT reading " + who);
  // 反向也不行：下属读不到上级。
  assert.equal((await cli["ML-LEAF"].get("/api/me/reports/" + emp["ML-MID"])).status, 404);
});

test("the manager profile path is read-only, and opens no back-office door", async () => {
  const id = emp["ML-LEAF"];
  for (const [m, call] of [["POST", cli["ML-TOP"].post], ["PUT", cli["ML-TOP"].put], ["DELETE", cli["ML-TOP"].del]]) {
    const r = await call("/api/me/reports/" + id, { name: "hacked", potential: "High" });
    assert.equal(r.status, 404, m + " on the manager path must not exist");
  }
  const after = await cli["ML-TOP"].get("/api/me/reports/" + id);
  assert.equal(after.data.user.name, "ML-LEAF", "nothing was written");
  // 经理身份是数据派生的，与 9 域 RBAC 正交：后台一个门都不开。
  assert.equal((await cli["ML-TOP"].get("/api/me")).data.adminRoleId, null);
  assert.equal((await cli["ML-TOP"].get("/api/admin/roster")).status, 403);
  assert.equal((await cli["ML-TOP"].get("/api/admin/employees/" + id + "/profile")).status, 403);
  assert.equal((await cli["ML-TOP"].get("/api/admin/audit")).status, 403);
  assert.equal((await cli["ML-TOP"].put("/api/admin/employees/" + id, { potential: "High" })).status, 403);
});

test("every profile read lands one audit row naming who read whom", async () => {
  await cli["ML-TOP"].get("/api/me/reports/" + emp["ML-LEAF2"]);
  const rows = (await admin.get("/api/admin/audit")).data.rows.filter((r) => r.action === "manager.view_profile");
  const hit = rows.find((r) => r.target === "ML-LEAF2");
  assert.ok(hit, "manager.view_profile written with the viewed employee id as target");
  assert.equal(hit.actor, "ML-TOP", "the reader is the actor");
  assert.ok(hit.targetLabel && hit.targetLabel.includes("ML-LEAF2"), "target resolves to a name, not a bare id");
  assert.equal(hit.after.relation, "indirect");
  assert.equal(hit.after.depth, 2);
});

test("the profile carries the whole performance history but not the self-review prose", async () => {
  // 一条已归档的绩效档案（关账写的就是这种 type=performance 记录）。
  const rec = await admin.post("/api/admin/employees/" + emp["ML-LEAF"] + "/records", {
    type: "performance", date: "2026-01-15", title: "ML 2025-H2",
    fields: { rating: "A", period: "2025-H2", summary: "steady delivery" },
  });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  // 外加一个仍然开着的周期，里面有下属写给**直属上级**的自评正文。
  const SECRET = "ML-SELF-REVIEW-PRIVATE-TEXT";
  const cyc = await admin.post("/api/admin/review-cycles", { name: "ML Cycle", userIds: [emp["ML-LEAF"]] });
  assert.equal(cyc.status, 200);
  const mine = (await cli["ML-LEAF"].get("/api/me/reviews")).data.mine.find((i) => i.cycle === "ML Cycle");
  assert.ok(mine, "the report sees their own open cycle");
  assert.equal((await cli["ML-LEAF"].post("/api/me/reviews/" + mine.id + "/self", { feedback: SECRET, goalsNext: ["ship it"] })).status, 200);

  const r = await cli["ML-TOP"].get("/api/me/reports/" + emp["ML-LEAF"]);
  assert.equal(r.status, 200);
  const archived = r.data.performance.find((p) => p.source === "archived");
  assert.ok(archived, "archived performance record is part of the history");
  assert.equal(archived.rating, "A");
  assert.equal(archived.summary, "steady delivery");
  const open = r.data.performance.find((p) => p.source === "open" && p.cycle === "ML Cycle");
  assert.ok(open, "an in-flight cycle shows up too");
  assert.equal(open.pending, true, "nobody has rated it yet");
  assert.equal(open.rating, null);
  // 隔层经理拿不到自评正文（selfFeedback 明确是「给上级的反馈」）。
  assert.ok(!JSON.stringify(r.data).includes(SECRET), "self-review prose never rides up the line");
  // 绩效档案同时仍在时间线里（D3：完整档案）。
  assert.ok(r.data.events.some((e) => e.kind === "record" && e.type === "performance"), "performance record on the timeline");
});

/* —— 以下三项由独立安全审计补充（2026-09-03）—— */

test("入转调离记录上行，HR 的内部备注(type=note)不上行", async () => {
  // transfer = 档案事实（D3 明确给经理）；note = HR 对这个人的内部批注
  // （出厂 employeeVisible=false），D8 把这条通路放到整条线之后，它会出现在
  // 这个人头上每一层经理面前 —— 服务端刻意不给（见 handler 里那一行 skip）。
  const SECRET = "HR-ONLY-INTERNAL-REMARK-XY7";
  const tr = await admin.post("/api/admin/employees/" + emp["ML-LEAF2"] + "/records", {
    type: "transfer", date: "2026-03-01", title: "ML transfer",
    fields: { fromDept: "ML Line", toDept: "ML Line B", reason: "rotation" },
  });
  assert.equal(tr.status, 200, JSON.stringify(tr.data));
  const nt = await admin.post("/api/admin/employees/" + emp["ML-LEAF2"] + "/records", {
    type: "note", date: "2026-03-02", title: "HR internal", fields: { text: SECRET },
  });
  assert.equal(nt.status, 200, JSON.stringify(nt.data));
  for (const who of ["ML-MID", "ML-TOP"]) {          // 直接下属与隔层，两条都得守住
    const r = await cli[who].get("/api/me/reports/" + emp["ML-LEAF2"]);
    assert.equal(r.status, 200);
    assert.ok(r.data.events.some((e) => e.kind === "record" && e.type === "transfer"),
      who + " 看得到入转调离记录");
    assert.ok(!r.data.events.some((e) => e.kind === "record" && e.type === "note"),
      who + " 拿不到 type=note 的记录");
    assert.ok(!JSON.stringify(r.data).includes(SECRET), who + " 拿不到备注正文");
  }
  // HR 在后台照旧看得见 —— 这是「少给经理」，不是「删数据」。
  const hr = await admin.get("/api/admin/employees/" + emp["ML-LEAF2"] + "/profile");
  assert.equal(hr.status, 200);
  assert.ok(JSON.stringify(hr.data).includes(SECRET), "HR 后台仍读得到备注");
});

test("未登录与伪造会话打不开这条通路", async () => {
  const anon = makeClient(srv.base);
  assert.equal((await anon.get("/api/me/reports/" + emp["ML-LEAF"])).status, 401);
  assert.equal((await anon.get("/api/me/team")).status, 401);
  const res = await anon.raw("GET", "/api/me/reports/" + emp["ML-LEAF"], undefined,
    { cookie: "sid=forged-" + "a".repeat(32) });
  assert.equal(res.status, 401, "伪造 sid 不给档案");
});

test("停用/离职的下属仍留在汇报线里，并被标成 inactive", async () => {
  // 与 directReports() 同口径：人走了，这条线仍是这个经理要交代的。
  assert.equal((await admin.put("/api/admin/employees/" + emp["ML-LEAF2"], { active: false })).status, 200);
  try {
    const p = await cli["ML-TOP"].get("/api/me/reports/" + emp["ML-LEAF2"]);
    assert.equal(p.status, 200);
    assert.equal(p.data.user.active, false);
    const t = await cli["ML-TOP"].get("/api/me/team");
    const row = t.data.rows.find((x) => x.name === "ML-LEAF2");
    assert.ok(row, "停用的人仍在整条线里");
    assert.equal(row.active, false);
  } finally {
    await admin.put("/api/admin/employees/" + emp["ML-LEAF2"], { active: true });
  }
});

