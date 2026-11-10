// F2：GET /api/me/team 的成本契约。
//
// 背景：D8 把团队视图从「直接下属」扩到「整条汇报线」之后，服务端对线上每个人都
// 跑一遍 PROGRAMS 循环算培训明细。925 人库上实测一条 924 人的线：单请求 750KB /
// ~630ms，8 个并发把单线程实例堵 5s（期间一个 /api/me 排队 5s）。这是任何树顶经理
// 的正常开页，不是攻击。
//
// 现在的口径（server.js「COST (F2)」那段注释是事实源）：
//   · depth === 1（直接下属）—— 字段一字不少，顺序也不变。团队页的主职就是看直接
//     下属的培训状态，MyTeam.jsx 把这些字段全用上了，所以这里钉的是**精确键集**：
//     多一个少一个都算回归。
//   · depth > 1（隔层）—— 只给身份 + 组织 + 汇报关系。隔层行的用途是「看得到人 +
//     点进档案」，培训明细改成按需取（GET /api/me/reports/:userId，一次一个人）。
//   · D8 的可见性一点没窄：整条线的人还在 rows 里、还带 relation/depth/managerName、
//     档案还打得开。省的只有报文和 CPU。
// 下面每条测试都对着上面某一句。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const emp = {};      // employeeId -> user id
const cli = {};      // employeeId -> logged-in client

// 直接下属那一行的**精确**键集（P3/D8 之后的现状）。加字段要先想清楚 MyTeam.jsx
// 与这条断言，别悄悄改。
// 第三批 9.1：员工端名单不再下发工号（测试账号的姓名即工号，下面按姓名比对）
const DIRECT_KEYS = ["userId", "name", "department", "active", "position",
  "jobLevel", "empStatus", "assigned", "done", "overdue", "items",
  "relation", "depth", "managerId", "managerName",
  "selfDone"];   // 第四批 7（2026-10-08）：自主学习课程的完成数（assigned / done / overdue 只计指派）
// 隔层那一行的精确键集 = 直接下属那套里去掉「贵」字段（第四批起含 selfDone）。
const INDIRECT_KEYS = DIRECT_KEYS.filter((k) => !["assigned", "done", "overdue", "items", "selfDone"].includes(k));

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

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // TC-TOP → TC-MID → TC-D1..TC-D6 → TC-DEEP（四层，隔层有 7 个人）。
  await makeEmployee("TC-TOP", { department: "TC", position: "Director", hireDate: "2019-01-01" });
  await makeEmployee("TC-MID", { department: "TC", position: "Manager", hireDate: "2020-01-01", managerId: emp["TC-TOP"] });
  for (let i = 1; i <= 6; i++)
    await makeEmployee("TC-D" + i, { department: "TC", position: "Analyst", hireDate: "2021-01-01", managerId: emp["TC-MID"] });
  await makeEmployee("TC-DEEP", { department: "TC", position: "Intern", hireDate: "2022-01-01", managerId: emp["TC-D1"] });
  // 线上每个人都有一门逾期的指派 —— 这样「直接下属带明细、隔层不带」才是真差异，
  // 而不是「大家都是空的所以看不出来」。
  const all = ["TC-MID", "TC-D1", "TC-D2", "TC-D3", "TC-D4", "TC-D5", "TC-D6", "TC-DEEP"];
  const r = await admin.post("/api/admin/assignments/bulk",
    { userIds: all.map((k) => emp[k]), programId: "nho", dueAt: "2020-01-31", action: "assign" });
  assert.equal(r.status, 200, "bulk assign nho " + JSON.stringify(r.data));
});
after(() => srv.stop());

test("直接下属那一行:字段一字不少(精确键集,防回归)", async () => {
  const r = await cli["TC-MID"].get("/api/me/team");     // MID 的下属全是直接下属
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 7, "6 个直接 + TC-DEEP(隔层)");
  assert.equal(r.data.directCount, 6);
  const d1 = r.data.rows.find((x) => x.name === "TC-D1");
  assert.deepEqual(Object.keys(d1).sort(), [...DIRECT_KEYS].sort(), "直接下属的键集与 F2 之前完全一致");
  // 值也要是真的算过的，不是占位。
  assert.equal(d1.relation, "direct");
  assert.equal(d1.depth, 1);
  assert.equal(d1.assigned, 1);
  assert.equal(d1.overdue, 1, "dueAt=2020-01-31 早就过了");
  assert.equal(d1.done, 0);
  assert.equal(d1.items.length, 1);
  assert.equal(d1.items[0].id, "nho");
  for (const k of ["title", "title_zh", "progress", "dueAt", "passed", "overdue", "bestPercent"])
    assert.ok(k in d1.items[0], "items[] 保留 " + k);
});

test("隔层那一行:只带身份/组织/汇报关系,不带培训明细", async () => {
  const r = await cli["TC-TOP"].get("/api/me/team");
  assert.equal(r.status, 200);
  const deep = r.data.rows.find((x) => x.name === "TC-DEEP");
  assert.ok(deep, "隔层的人还在列表里");
  assert.deepEqual(Object.keys(deep).sort(), [...INDIRECT_KEYS].sort());
  for (const k of ["assigned", "done", "overdue", "items"])
    assert.ok(!(k in deep), "隔层行不带 " + k);
  // 身份/组织/汇报关系是实打实的值，不是 null 占位 —— 前端拿它渲染整行。
  assert.equal(deep.name, "TC-DEEP");
  assert.equal(deep.department, "TC");
  assert.equal(deep.position, "Intern");
  assert.equal(deep.active, true);
  assert.equal(deep.relation, "indirect");
  assert.equal(deep.depth, 3);
  assert.equal(deep.managerId, emp["TC-D1"]);
  assert.equal(deep.managerName, "TC-D1", "隔层行仍报出自己的上级姓名(不再逐行查库)");
  // 直接下属那一行在同一份响应里仍是全的。
  const mid = r.data.rows.find((x) => x.name === "TC-MID");
  assert.deepEqual(Object.keys(mid).sort(), [...DIRECT_KEYS].sort());
  assert.equal(mid.assigned, 1);
});

test("整条线的可见性没被削弱:人都在,档案都打得开,明细按需可取", async () => {
  const r = await cli["TC-TOP"].get("/api/me/team");
  const ids = r.data.rows.map((x) => x.name).sort();
  assert.deepEqual(ids, ["TC-D1", "TC-D2", "TC-D3", "TC-D4", "TC-D5", "TC-D6", "TC-DEEP", "TC-MID"]);
  assert.equal(r.data.count, 8);
  assert.equal(r.data.directCount, 1, "TOP 只有 MID 一个直接下属");
  // 每个隔层行都能点进档案（D3/D8 的读档通路，一次一个人）。
  for (const row of r.data.rows.filter((x) => x.relation === "indirect")) {
    const p = await cli["TC-TOP"].get("/api/me/reports/" + row.userId);
    assert.equal(p.status, 200, "隔层档案仍打得开:" + row.name);
    assert.equal(p.data.user.name, row.name);
  }
  // 团队页省掉的培训明细，在档案页按需拿得到 —— 数据没丢，只是不预算。
  const deep = await cli["TC-TOP"].get("/api/me/reports/" + emp["TC-DEEP"]);
  assert.ok(Array.isArray(deep.data.assignments), "档案页仍给培训指派");
  assert.ok(deep.data.assignments.some((a) => a.programId === "nho" || a.id === "nho"),
    "TC-DEEP 的 nho 指派在档案页看得到:" + JSON.stringify(deep.data.assignments).slice(0, 200));
});

test("报文成本:隔层行远小于直接下属行,且 items 只按直接下属计数", async () => {
  const r = await cli["TC-TOP"].get("/api/me/team");
  const size = (o) => JSON.stringify(o).length;
  const mid = r.data.rows.find((x) => x.name === "TC-MID");     // direct, 有明细
  const deep = r.data.rows.find((x) => x.name === "TC-DEEP");   // indirect
  // 测试内容集只有一门课(content.js 的 nho)，所以这里省下的是「1 门明细」；
  // 生产上每多一门课,直接下属行就多一份 items[]，而隔层行永远是这个大小。
  assert.ok(size(deep) < size(mid) * 0.7,
    "隔层行应明显小于直接下属行:" + size(deep) + " vs " + size(mid));
  // 整份响应里 items 出现的次数 === directCount：隔层一份都没算。
  const itemsCount = r.data.rows.filter((x) => Array.isArray(x.items)).length;
  assert.equal(itemsCount, r.data.directCount, "只有直接下属带 items");
  assert.equal(itemsCount, 1);
  // 线长了、深了，报文只按「身份行」增长。TOP 的线比 MID 的线多一个人，
  // 但多出来的那一行是隔层行，涨幅必须小于一个带明细的直接下属行。
  const midView = await cli["TC-MID"].get("/api/me/team");
  const perIndirect = size(deep);
  const perDirect = size(mid);
  assert.ok(perIndirect < perDirect, "隔层行单价低于直接下属行");
  assert.ok(midView.data.rows.filter((x) => Array.isArray(x.items)).length === midView.data.directCount);
});

test("没有下属的人拿到空线;直接下属的行不因 F2 变成占位", async () => {
  // TC-DEEP 自己没有下属。
  const none = await cli["TC-DEEP"].get("/api/me/team");
  assert.equal(none.status, 200);
  assert.equal(none.data.count, 0);
  assert.deepEqual(none.data.rows, []);
  // TC-D1 有一个直接下属(TC-DEEP)，它必须是**全字段**的那一行 ——
  // 「隔层减字段」是按 depth 判的，不是按人判的。
  const d1 = await cli["TC-D1"].get("/api/me/team");
  assert.equal(d1.data.count, 1);
  assert.equal(d1.data.directCount, 1);
  const row = d1.data.rows[0];
  assert.equal(row.name, "TC-DEEP");
  assert.deepEqual(Object.keys(row).sort(), [...DIRECT_KEYS].sort(),
    "同一个人在上一层是隔层行、在自己上级那里是直接下属行 —— 后者字段全");
  assert.equal(row.relation, "direct");
  assert.equal(row.assigned, 1);
  assert.equal(row.managerName, "TC-D1", "直接下属的 managerName 就是调用者自己");
});
