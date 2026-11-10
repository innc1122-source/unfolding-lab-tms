// RBAC P2 数据范围（scope）—— **整系统保密性**的对抗复核（阶段 B/C 收尾验收）。
//
// 为什么已经有三个域测试了还要这一个：people / learning / perf-talent 三份契约测试
// 各自用一个**单域**角色（people:manage、learning:manage、performance+talent:manage）。
// 但设计稿的 W1 白名单让一条端点可以被**多个域**同时消费（roster 是最典型的一条：
// people/learning/performance/talent 任一 ≥只读 都能读它）。单域角色测不到的那种泄露，
// 恰恰发生在「一个角色同时持有多个域，于是走到了另一条 grants 分支」上。所以这里造
// **一个把 8 个域全开到 manage 的角色**（= 一个真实客户的「全能 HRBP，但只管一个
// 部门」），拿它把全部受约束的读端点扫一遍，逐字节断言范围外员工的**工号一次都不出现**。
//
// 这份测试锁的是一句话的承诺：**范围受限的角色拿不到范围外员工的工号**。
// 它是一条会随时间腐坏的横切性质 —— 任何人给任何 handler 新加一个带 employeeId 的
// 字段（一个 suggestions 名录、一条 risks[]、一列 CSV），只要忘了过滤，这里就会红。
//
// 已知且**刻意保留**的唯一例外，见下面第二个用例：范围内员工自己的**直属上级链姓名**。
// 清点文档 §8 的方案 B 明文接受它（组织图不连通就没有价值，而直属上级本来就是员工
// 自己也知道的信息）。这里把这个例外**钉死成一个上界**：可以出现的只有「姓名」，
// 绝不能连工号一起出现，也绝不能扩散到非祖先的范围外员工身上。
//
// 域测试在 test/rbac-scope-{people,learning,perf-talent}.test.js；
// 范围解析器本身在 test/rbac-scope.test.js；BOM 配置在 test/config-bom.test.js。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const dept = {};   // name -> id
const emp = {};    // employeeId -> user id
const pw = {};     // employeeId -> 初始密码（绩效申诉用例要用员工本人登录）
let scopedAll, plainAll;
let cycleMixed, programId;

// 范围外的两个人：**姓名与工号刻意不同字**，这样「泄露的是姓名」与「泄露的是工号」
// 可以分开断言 —— 如果 name 就等于 employeeId，上面那条唯一例外就无法与真泄露区分。
const OUT_ID = "SW-OUT", OUT_NAME = "Outsider Zeta";
const OUT2_ID = "SW-OUT2", OUT2_NAME = "Outsider Theta";

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name + " " + JSON.stringify(r.data));
  return r.data.role.id;
}

// 建号 → 超管指派角色 → 登录 → 清掉强制改密标记（与另外三份 scope 测试同一套路）。
async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.ok(u, "find " + empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, { adminRoleId })).status, 200);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  return c;
}

async function makeEmployee(empId, name, patch) {
  const created = await admin.post("/api/admin/employees", { name, employeeId: empId });
  assert.equal(created.status, 200, "create employee " + empId);
  pw[empId] = created.data.password;
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.ok(u, "find employee " + empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, patch)).status, 200, "patch " + empId);
  emp[empId] = u.id;
  return u.id;
}

// 受约束的读端点清单（RBAC-SCOPE-INVENTORY.md 的 61 条里所有**不需要额外夹具**的读）。
// 全部用 raw 文本比对：CSV 不是 JSON，而「有没有泄露」这个问题只关心字节。
function readUrls() {
  return [
    "/api/admin/roster",
    "/api/admin/employees",
    "/api/admin/departments",
    "/api/admin/org-chart",
    "/api/admin/org-diagnostics",
    "/api/admin/export/records.csv",
    "/api/admin/export/completion.csv",
    "/api/admin/export/attempts.csv",
    "/api/admin/attempts",
    "/api/admin/nominations",
    "/api/admin/enroll-requests",
    "/api/admin/overview",
    "/api/admin/pending-counts",
    "/api/admin/dashboard",
    "/api/admin/review-cycles",
    "/api/admin/review-cycles/" + cycleMixed,
    "/api/admin/promotion-candidates",
    "/api/admin/succession",
    "/api/admin/talent-review",
    "/api/admin/employees/" + emp["SW-IN"] + "/profile",
    "/api/admin/employees/" + emp["SW-IN"] + "/detail",
    "/api/admin/employees/" + emp["SW-IN"] + "/secondary-lines",
    "/api/admin/programs/" + programId + "/assignees",
    // 第二批 2.8 绩效申诉台：列表、角标、统计按分工或角色范围过滤（RBAC-SCOPE-INVENTORY）
    "/api/admin/review-appeals",
    "/api/admin/review-appeals/summary",
    "/api/admin/review-appeals/stats",
  ];
}

async function bodyOf(client, url) {
  const res = await client.raw("GET", url);
  return await res.text();
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["SW Root", null], ["SW Child", "SW Root"], ["SW Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  // SW-OUT 是 SW-IN 的**直属上级**：这正是「祖先链姓名」那条已知例外的探针。
  await makeEmployee(OUT_ID, OUT_NAME, { department: "SW Other", jobLevel: "PB2", position: "Outside Lead", hireDate: "2020-01-01" });
  await makeEmployee(OUT2_ID, OUT2_NAME, { department: "SW Other", jobLevel: "PB2", position: "Outside Member", hireDate: "2020-01-01", managerId: emp[OUT_ID] });
  await makeEmployee("SW-IN", "Insider Alpha", { department: "SW Root", jobLevel: "PB2", position: "Inside Lead", hireDate: "2020-01-01", managerId: emp[OUT_ID] });
  await makeEmployee("SW-KID", "Insider Beta", { department: "SW Child", jobLevel: "PB2", position: "Inside Member", hireDate: "2020-01-01", managerId: emp["SW-IN"] });
  // 一条范围外的绩效档案 + 一条范围外的继任记录：让 records.csv / succession /
  // talent-search 三条端点在超管眼里**确实**有范围外的行可泄露（否则用例是空转的）。
  assert.equal((await admin.post(`/api/admin/employees/${emp[OUT_ID]}/records`, {
    type: "performance", date: "2026-01-15", title: "SW Perf Out",
    fields: { rating: "D", period: "2026-H1", summary: "systemwide probe" },
  })).status, 200);
  assert.equal((await admin.post("/api/admin/succession", { positionName: "SW Future Lead", userId: emp[OUT2_ID], readiness: "ready" })).status, 200);
  // 一个混合周期（范围内 2 人 + 范围外 1 人）：给 review-cycles/:id 与关账对账两用。
  const c = await admin.post("/api/admin/review-cycles", { name: "SW Mixed Cycle", userIds: [emp["SW-IN"], emp["SW-KID"], emp[OUT_ID]] });
  assert.equal(c.status, 200, "open mixed cycle " + JSON.stringify(c.data));
  assert.equal(c.data.participants, 3);
  cycleMixed = c.data.cycle.id;
  // 一个项目 + 给三个人都派上，assignees 名单才有范围外的行。
  programId = (await admin.get("/api/admin/programs")).data[0].id;
  for (const e of ["SW-IN", "SW-KID", OUT_ID]) {
    assert.equal((await admin.post("/api/admin/assignments", { userId: emp[e], items: [{ programId, assigned: true }] })).status, 200, "assign " + e);
  }
  // 一个把可授予的数据域全开到 manage 的角色（roles 会被 sanitizeGrants 强制成 none，
  // 那是 D6 起的既定行为；accounts 此处未列，同样落 none，均不影响本读端点范围测试）
  // —— 这就是本文件存在的理由。
  const allDomains = { people: "manage", learning: "manage", performance: "manage", talent: "manage", fields: "manage", brand: "manage", audit: "manage", shell: "manage" };
  const scope = { departments: [{ id: dept["SW Root"], includeChildren: true }] };
  scopedAll = await makeAdminUser("SW-A-SCOPED", await makeRole("Scoped AllDomains", allDomains, scope));
  plainAll = await makeAdminUser("SW-A-PLAIN", await makeRole("Plain AllDomains", allDomains));
});
after(() => srv.stop());

test("八域全开的范围角色：把受约束的读端点全扫一遍，范围外工号一次都不出现", async () => {
  const urls = readUrls();
  let sawOutAsAdmin = 0;
  for (const url of urls) {
    const scopedBody = await bodyOf(scopedAll, url);
    const adminBody = await bodyOf(admin, url);
    if (adminBody.includes(OUT_ID) || adminBody.includes(OUT2_ID)) sawOutAsAdmin++;
    assert.ok(!scopedBody.includes(OUT_ID), `范围外工号 ${OUT_ID} 出现在 ${url}`);
    assert.ok(!scopedBody.includes(OUT2_ID), `范围外工号 ${OUT2_ID} 出现在 ${url}`);
  }
  // 反向断言：这些端点里**确实**有范围外的数据可泄露 —— 否则上面全是空转。
  assert.ok(sawOutAsAdmin >= 8, `超管只在 ${sawOutAsAdmin} 条端点上看到范围外的人，夹具太弱，用例会空转`);
  // POST 形状的读（W3 白名单里的纯查询）走同一条口径。
  const ts = await scopedAll.post("/api/admin/talent-search", { type: "performance", fields: {} });
  assert.equal(ts.status, 200);
  assert.ok(!JSON.stringify(ts.data).includes(OUT_ID), "talent-search 泄露了范围外工号");
});

test("已知且刻意保留的唯一例外：直属上级链**只有姓名**，且不扩散、不带工号", async () => {
  // 清点文档 §8 的方案 B：范围内员工的上级在范围外时，组织图给一个只有姓名/部门的
  // 骨架节点（outOfScope: true）。同一个事实还会以 profile.user.managerName 与
  // review 名单的 items[].manager 出现 —— 三处是**同一个人**：范围内员工自己的上级。
  const chart = (await scopedAll.get("/api/admin/org-chart")).data;
  const skeleton = chart.nodes.filter((n) => n.outOfScope);
  assert.ok(skeleton.length >= 1, "祖先骨架节点应当存在（否则组织图不连通）");
  for (const n of skeleton) {
    assert.equal(n.employeeId, null, "骨架节点绝不能带工号");
    assert.equal(n.jobLevel, null, "骨架节点只保留连通性所需字段");
  }
  // CX-013（2026-10-10 验收，负责人要求全部解决）：骨架节点连姓名也不下发，按 id 认；姓名只留在档案页的直属上级栏（见下）
  assert.ok(skeleton.some((n) => n.id === emp[OUT_ID]), "上级链上的人应当作为骨架节点出现");
  for (const n of skeleton) assert.equal(n.name, null, "骨架节点不带姓名（CX-013）");
  assert.ok(!JSON.stringify(chart).includes(OUT_NAME), "组织图里不出现范围外上级的姓名（CX-013）");
  // 而**非祖先**的范围外员工（SW-OUT2 是 SW-OUT 的下属，不在任何范围内员工的上级链上）
  // 一个字都不能出现 —— 这条把例外钉成上界，防止它日后悄悄扩成「整个范围外部门」。
  for (const url of readUrls()) {
    const body = await bodyOf(scopedAll, url);
    assert.ok(!body.includes(OUT2_NAME), `非祖先的范围外姓名 ${OUT2_NAME} 出现在 ${url}`);
  }
  // 例外只覆盖姓名：任何一条端点都不得把上级的姓名与工号一起给出。
  const prof = (await scopedAll.get("/api/admin/employees/" + emp["SW-IN"] + "/profile")).data;
  assert.equal(prof.user.managerName, OUT_NAME, "直属上级姓名照常可见（否则档案页的上级栏是空的）");
  assert.ok(!JSON.stringify(prof).includes(OUT_ID), "档案页不得同时给出上级的工号");
});

test("关账对账：整周期拒绝，且库里一条 talent_records 都没写", async () => {
  // 关账是全部 112 条里唯一「部分执行 = 不可逆数据缺失」的端点，所以对账要看**库**，
  // 不能只看回包。records.csv 是这条流水账在 HTTP 上唯一的出口。
  const rated = (await admin.get("/api/admin/review-cycles/" + cycleMixed)).data.items;
  for (const it of rated) {
    assert.equal((await admin.put("/api/admin/review-items/" + it.id, { finalRating: "A" })).status, 200);
  }
  const ledger = async () => (await (await admin.raw("GET", "/api/admin/export/records.csv")).text()).split(/\r?\n/).filter((l) => l.trim()).length;
  const before = await ledger();
  const rej = await scopedAll.post(`/api/admin/review-cycles/${cycleMixed}/close`, {});
  assert.equal(rej.status, 404, "含范围外参与者的周期必须整体拒绝");
  assert.equal(rej.data.code, "out_of_scope");
  assert.equal(rej.data.outOfScope, 1, "回报越界人数，HR 才知道要改几行");
  assert.equal(await ledger(), before, "被拒的关账写了档案 —— 这是不可逆的部分关账");
  const still = (await admin.get("/api/admin/review-cycles")).data.find((c) => c.id === cycleMixed);
  assert.equal(still.status, "open", "被拒之后周期必须保持 open（关了就打不开）");
  // 反面：同权限但空范围的角色关得掉，而且**确实**写了三条 —— 证明上面的 0 是范围
  // 拦住的，不是「这条周期本来就没东西可写」。
  const ok = await plainAll.post(`/api/admin/review-cycles/${cycleMixed}/close`, {});
  assert.equal(ok.status, 200, "空范围角色不该被误伤");
  assert.equal(ok.data.written, 3);
  assert.equal(await ledger(), before + 3, "成功关账应当落三条档案");
});

test("侧栏角标与列表页严格相等（角标 12 / 列表 3 条这种对不上不能再出现）", async () => {
  const badge = (await scopedAll.get("/api/admin/pending-counts")).data;
  const noms = (await scopedAll.get("/api/admin/nominations")).data;
  const reqs = (await scopedAll.get("/api/admin/enroll-requests")).data;
  assert.equal(badge.nominations, noms.length, "提名角标与提名列表条数必须同源");
  assert.equal(badge.enroll, reqs.length, "选修申请角标与列表条数必须同源");
  // 超管侧同样相等（防止「两边都错成 0」这种假通过）。
  const badgeA = (await admin.get("/api/admin/pending-counts")).data;
  assert.equal(badgeA.nominations, (await admin.get("/api/admin/nominations")).data.length);
  assert.equal(badgeA.enroll, (await admin.get("/api/admin/enroll-requests")).data.length);
});

test("回归红线：八域全开的**空范围**角色，与超管逐字节一致", async () => {
  // 向后兼容红线 —— 现有全部角色的 scope 都是空的。空范围必须走原样的全公司代码路径，
  // 一个字节都不能变。这里比的是 raw 文本而不是解析后的对象：字段顺序变了也算变。
  for (const url of readUrls()) {
    const a = await bodyOf(admin, url);
    const p = await bodyOf(plainAll, url);
    assert.equal(p, a, "空范围角色与超管在 " + url + " 上出现了差异");
  }
  // 而带范围的同权角色**必须**看得更少 —— 否则上面一整份测试都在空转。
  const rosterA = (await admin.get("/api/admin/roster")).data.length;
  const rosterS = (await scopedAll.get("/api/admin/roster")).data.length;
  assert.ok(rosterS < rosterA, `范围角色应当看到更少的人（${rosterS} vs ${rosterA}）`);
});

test("第二批 2.8 绩效申诉台：范围外员工的申诉不进范围角色的列表 / 角标 / 统计；空范围角色与超管逐字节一致", async () => {
  // 混合周期已在上面的用例里由空范围角色关闭（结果对员工可见 → 申诉期限开始），SW-OUT 对自己的评级提出申诉
  const out = await loginAs(srv.base, { employeeId: OUT_ID, password: pw[OUT_ID] });
  assert.equal((await out.post("/api/auth/change-password", { currentPassword: pw[OUT_ID], newPassword: OUT_ID + "-pw-2026" })).status, 200);
  const hist = (await out.get("/api/me/reviews/history")).data;
  const item = hist.items.find((i) => i.cycleId === cycleMixed);
  assert.ok(item && item.appeal && item.appeal.state === "open", JSON.stringify(hist));
  const sub = await out.post("/api/me/reviews/" + item.id + "/appeal", { reason: "对本期评级有异议，请 HR 复核我在本季度承担的额外工作与目标完成情况。我负责了两个跨部门项目并按期交付，评级未能反映这些贡献。" });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const urls = ["/api/admin/review-appeals", "/api/admin/review-appeals/summary", "/api/admin/review-appeals/stats"];
  // 空范围的全域角色（兜底处理人）看得到这条申诉 —— 否则用例空转
  assert.ok((await bodyOf(plainAll, urls[0])).includes(OUT_ID), "fallback handler sees the appeal");
  // 超管在「关账对账」用例里用 PUT /review-items 改过这些人的评级（旧流程 HR 校准）→ 利益回避（制度审查 #6），列表里没有这一行；
  // 所以这里不比超管与空范围角色的逐字节一致（权限矩阵里的逐字节一致见 review-appeal-rbac.test.js）
  assert.ok(!(await bodyOf(admin, urls[0])).includes(OUT_ID), "the HR calibrator is conflicted");
  for (const url of urls) {
    const scoped = await bodyOf(scopedAll, url);
    assert.ok(!scoped.includes(OUT_ID), "范围外工号出现在 " + url);
  }
  assert.equal((await scopedAll.get("/api/admin/review-appeals")).data.items.length, 0);
});
