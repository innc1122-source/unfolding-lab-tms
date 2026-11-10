// HoD 名单接口的 HTTP 契约：GET /api/admin/departments/hods 与 hods.csv。
// 起真服务（helpers.startServer，一次性库，永不碰 lms.db / 根目录 config.json），造一组覆盖
// 全部来源的一级部门（负责人 / 自动推算 / 需确认（多顶端、成环）/ 无在职人员 / 负责人已离职），
// 逐条验：载荷形状与分类、CSV（BOM、中英双语表头、公式注入防护、审计）、RBAC 能力域闸门
// （people 读；无 people 的角色 404、员工 403、未登录 401）、部门范围（只看到整棵子树都在
// 范围内的一级部门，越界不泄露存在性；负责人在范围外时不带出他的部门与职位；scoped 标记）、
// 改上级 / 设负责人之后立即生效（不缓存旧结果）、设负责人的审计可追溯、认领孤儿部门不能成环、
// 部门名大小写一致（写入存规范写法；大小写变体在改名 / 删除校验 / 在编人数里都算得进；非 ASCII 不重复建部门）。
// 另外把 server.js 里的 hodOf / deptLevelsOf 按源码原文截出来，注入桩 store 直接验。
// 纯函数的全部分支在 test/org-hod.test.js。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin;
const dept = {}; // name -> id
const emp = {};  // employeeId -> user id
let scoped, peopleRead, learningOnly, employee;

async function makeAdminUser(empId, adminRoleId) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  assert.equal((await admin.put("/api/admin/employees/" + u.id, { adminRoleId })).status, 200, "assign role to " + empId);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  return c;
}
async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name);
  return r.data.role.id;
}
async function makeDept(name, parent) {
  const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
  assert.equal(r.status, 200, "create department " + name);
  dept[name] = r.data.department.id;
}
function withDb(fn) {
  const db = new DatabaseSync(srv.dbPath);
  try { fn(db); } finally { db.close(); }
}
const stripTime = (d) => { const { generatedAt, ...rest } = d; return rest; };
const byName = (data, name) => data.items.find((x) => x.deptName === name);
// 最小 CSV 解析（引号、转义引号、逗号），足够验本接口的输出。
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  // 一级部门（带下级的注明）：
  //   HOD Ops（→ Pay → Settle，三层）  自动推算：唯一顶端在本部
  //   HOD Fin                            负责人（在职）
  //   HOD Mkt（→ Brand）                 需确认：本部一人 + 二级一人，都没有上级
  //   HOD Legacy                         负责人已离职 → 继续推算
  //   HOD Loop                           需确认：两人互为上级（直写库，API 拦环）
  //   HOD Empty                          无在职人员（唯一一人已停用）
  //   HOD Off                            停用的一级部门：不列
  //   HOD Out                            范围外（给范围受限角色验不泄露）
  //   @HOD At                            公式注入：部门名以 @ 开头、HoD 姓名以 = 开头
  for (const [name, parent] of [
    ["HOD Ops"], ["HOD Ops Pay", "HOD Ops"], ["HOD Ops Pay Settle", "HOD Ops Pay"],
    ["HOD Fin"], ["HOD Mkt"], ["HOD Mkt Brand", "HOD Mkt"], ["HOD Legacy"], ["HOD Loop"],
    ["HOD Empty"], ["HOD Off"], ["HOD Out"], ["@HOD At"],
  ]) await makeDept(name, parent);
  const people = [
    ["HOD-OPS-1", "Olivia Ops", "HOD Ops"], ["HOD-OPS-2", "Oscar Pay", "HOD Ops Pay"], ["HOD-OPS-3", "Otto Settle", "HOD Ops Pay Settle"],
    ["HOD-FIN-1", "Fiona Top", "HOD Fin"], ["HOD-FIN-2", "Felix Owner", "HOD Fin"],
    ["HOD-MKT-Z", "Zara Direct", "HOD Mkt"], ["HOD-MKT-A", "Adam Brand", "HOD Mkt Brand"],
    ["HOD-LEG-O", "Lena Former", "HOD Legacy"], ["HOD-LEG-1", "Liam Lead", "HOD Legacy"],
    ["HOD-LOOP-A", "Lara Loop", "HOD Loop"], ["HOD-LOOP-B", "Luca Loop", "HOD Loop"],
    ["HOD-EMPTY-X", "Ex Empty", "HOD Empty"], ["HOD-OFF-1", "Owen Off", "HOD Off"],
    ["HOD-OUT-1", "Omar Out", "HOD Out"], ["HOD-GHOST", "Gina Ghost", "HOD Out"],
    ["HOD-EVIL-1", "=Eve Formula", "@HOD At"],
  ];
  for (const [employeeId, name, department] of people) {
    const r = await admin.post("/api/admin/employees", { name, employeeId, department });
    assert.equal(r.status, 200, "create " + employeeId);
  }
  for (const u of (await admin.get("/api/admin/roster")).data) emp[u.employeeId] = u.id;
  const setMgr = async (who, mgr) => assert.equal((await admin.put("/api/admin/employees/" + emp[who], { managerId: emp[mgr] })).status, 200, `${who} → ${mgr}`);
  await setMgr("HOD-OPS-2", "HOD-OPS-1");
  await setMgr("HOD-OPS-3", "HOD-OPS-2");
  await setMgr("HOD-FIN-2", "HOD-FIN-1");
  await setMgr("HOD-LEG-1", "HOD-LEG-O");
  const setDept = async (name, fields) => assert.equal((await admin.put("/api/admin/departments/" + dept[name], fields)).status, 200, "update " + name);
  await setDept("HOD Fin", { ownerId: emp["HOD-FIN-2"] });
  await setDept("HOD Legacy", { ownerId: emp["HOD-LEG-O"] });
  await setDept("HOD Off", { active: false });
  for (const who of ["HOD-LEG-O", "HOD-EMPTY-X"]) assert.equal((await admin.put("/api/admin/employees/" + emp[who], { active: false })).status, 200, "deactivate " + who);
  // API 会拦下成环的上级与「不在部门表里的部门名」，这两种坏数据只可能来自直写库 / 旧数据。
  withDb((db) => {
    db.prepare("UPDATE users SET managerId = ? WHERE id = ?").run(emp["HOD-LOOP-B"], emp["HOD-LOOP-A"]);
    db.prepare("UPDATE users SET managerId = ? WHERE id = ?").run(emp["HOD-LOOP-A"], emp["HOD-LOOP-B"]);
    db.prepare("UPDATE users SET department = ? WHERE id = ?").run("HOD Ghost Dept", emp["HOD-GHOST"]);
  });
  // 范围：Ops 含下级（整棵子树在范围内）、Fin 不含下级（它没有下级 → 整棵在范围内）、
  // Mkt 不含下级（Brand 在范围外 → 只有部分子树在范围内 → 整行不返回）。
  const scope = { departments: [{ id: dept["HOD Ops"], includeChildren: true }, { id: dept["HOD Fin"], includeChildren: false }, { id: dept["HOD Mkt"], includeChildren: false }] };
  scoped = await makeAdminUser("HOD-A-SCOPED", await makeRole("HoD Scoped People", { people: "read" }, scope));
  peopleRead = await makeAdminUser("HOD-A-PEOPLE", await makeRole("HoD People Read", { people: "read" }));
  learningOnly = await makeAdminUser("HOD-A-LEARN", await makeRole("HoD Learning Only", { learning: "manage" }));
  employee = await loginAs(srv.base, EMPLOYEE);
});
after(() => srv.stop());

// ---------- 载荷 ----------

test("hods：每个在用一级部门一行，来源分类正确；停用的一级部门不列；summary 与 items 对得上", async () => {
  const r = await admin.get("/api/admin/departments/hods");
  assert.equal(r.status, 200);
  const d = r.data;
  assert.ok(!Number.isNaN(Date.parse(d.generatedAt)), "generatedAt 是时间戳");
  assert.deepEqual(Object.keys(d.summary).sort(), ["ambiguous", "derived", "none", "owner", "ownerInactive", "total", "unassignedPeople"]);
  assert.equal(d.summary.total, d.items.length);
  for (const k of ["owner", "derived", "ambiguous", "none"]) assert.equal(d.summary[k], d.items.filter((x) => x.source === k).length, k);
  assert.equal(d.summary.ownerInactive, d.items.filter((x) => x.ownerInactive).length);
  assert.equal(d.summary.unassignedPeople, d.unassignedPeople.length);
  for (const it of d.items) assert.deepEqual(Object.keys(it).sort(), ["candidates", "deptId", "deptName", "hod", "memberCount", "owner", "ownerInactive", "reason", "source"]);

  const ops = byName(d, "HOD Ops");
  assert.equal(ops.deptId, dept["HOD Ops"]);
  assert.equal(ops.source, "derived");
  assert.equal(ops.reason, "single_top");
  assert.equal(ops.hod.employeeId, "HOD-OPS-1");
  assert.equal(ops.hod.direct, true);
  assert.equal(ops.memberCount, 3, "三级部门的人计入一级部门");
  assert.equal(byName(d, "HOD Ops Pay"), undefined, "二级部门不单独成行");

  const fin = byName(d, "HOD Fin");
  assert.equal(fin.source, "owner");
  assert.equal(fin.hod.employeeId, "HOD-FIN-2", "部门页负责人覆盖推算结果（推算会是 HOD-FIN-1）");
  assert.equal(fin.owner.status, "active");

  const mkt = byName(d, "HOD Mkt");
  assert.equal(mkt.source, "ambiguous");
  assert.equal(mkt.reason, "multiple_tops");
  assert.equal(mkt.hod, null);
  assert.deepEqual(mkt.candidates.map((c) => [c.employeeId, c.direct]), [["HOD-MKT-Z", true], ["HOD-MKT-A", false]], "本部的人排前");

  const leg = byName(d, "HOD Legacy");
  assert.equal(leg.ownerInactive, true);
  assert.deepEqual(leg.owner, { id: emp["HOD-LEG-O"], name: "Lena Former", employeeId: "HOD-LEG-O", status: "inactive" });
  assert.equal(leg.source, "derived", "负责人离职后照常推算");
  assert.equal(leg.hod.employeeId, "HOD-LEG-1");

  const loop = byName(d, "HOD Loop");
  assert.equal(loop.source, "ambiguous");
  assert.equal(loop.reason, "loop");
  assert.deepEqual(loop.candidates.map((c) => c.employeeId).sort(), ["HOD-LOOP-A", "HOD-LOOP-B"]);

  const empty = byName(d, "HOD Empty");
  assert.equal(empty.source, "none");
  assert.equal(empty.memberCount, 0, "已停用的人不算成员");

  assert.equal(byName(d, "HOD Off"), undefined, "停用的一级部门不列");
  // ……但它下面的在职人员不会悄悄消失：计入未归属，reason inactive_level1，带上一级部门名。
  const off = d.unassignedPeople.find((p) => p.employeeId === "HOD-OFF-1");
  assert.deepEqual(off, { id: emp["HOD-OFF-1"], name: "Owen Off", employeeId: "HOD-OFF-1", department: "HOD Off", reason: "inactive_level1", level1: "HOD Off" });
  assert.equal(byName(d, "HOD Out").hod.employeeId, "HOD-OUT-1");
  const ghost = d.unassignedPeople.find((p) => p.employeeId === "HOD-GHOST");
  assert.deepEqual(ghost, { id: emp["HOD-GHOST"], name: "Gina Ghost", employeeId: "HOD-GHOST", department: "HOD Ghost Dept", reason: "unknown", level1: null });
  assert.ok(!d.unassignedPeople.some((p) => p.employeeId === "ADMIN"), "系统账号不计入未归属");
  assert.equal(d.scoped, false, "超管看到的是未经范围裁剪的名单");
  assert.deepEqual(d.duplicateNames, []);
});

test("hods：改上级、设负责人之后立即反映（每次按当下的库推算，不缓存旧结果）", async () => {
  // Adam 挂到 Zara 下 → Mkt 只剩一个顶端 → 自动推算。
  assert.equal((await admin.put("/api/admin/employees/" + emp["HOD-MKT-A"], { managerId: emp["HOD-MKT-Z"] })).status, 200);
  let mkt = byName((await admin.get("/api/admin/departments/hods")).data, "HOD Mkt");
  assert.equal(mkt.source, "derived");
  assert.equal(mkt.hod.employeeId, "HOD-MKT-Z");
  // 在部门列表设负责人 → 覆盖推算结果。
  assert.equal((await admin.put("/api/admin/departments/" + dept["HOD Mkt"], { ownerId: emp["HOD-MKT-A"] })).status, 200);
  mkt = byName((await admin.get("/api/admin/departments/hods")).data, "HOD Mkt");
  assert.equal(mkt.source, "owner");
  assert.equal(mkt.hod.employeeId, "HOD-MKT-A");
  // 还原（后面的 CSV 测试按「需确认」验）。
  assert.equal((await admin.put("/api/admin/departments/" + dept["HOD Mkt"], { ownerId: "" })).status, 200);
  assert.equal((await admin.put("/api/admin/employees/" + emp["HOD-MKT-A"], { managerId: "" })).status, 200);
  mkt = byName((await admin.get("/api/admin/departments/hods")).data, "HOD Mkt");
  assert.equal(mkt.source, "ambiguous");
});

// ---------- CSV ----------

test("hods.csv：带 BOM 的 UTF-8、中英双语表头、每个一级部门一行，内容与 JSON 一致，并落审计", async () => {
  const res = await admin.raw("GET", "/api/admin/departments/hods.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="hod-list-\d{4}-\d{2}-\d{2}\.csv"$/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM（Excel 打开中文不乱码）");
  const rows = parseCsv(buf.toString("utf8").slice(1));
  assert.deepEqual(rows[0], ["一级部门 Level-1 department", "HoD 姓名 HoD name", "工号 Employee ID", "来源 Source", "候选人 Candidates", "成员数 Members"]);
  const json = (await admin.get("/api/admin/departments/hods")).data;
  assert.equal(rows.length - 1, json.items.length, "每个一级部门一行");
  const row = (name) => rows.find((r) => r[0] === name);
  assert.deepEqual(row("HOD Ops"), ["HOD Ops", "Olivia Ops", "HOD-OPS-1", "自动推算 Derived", "", "3"]);
  assert.deepEqual(row("HOD Fin"), ["HOD Fin", "Felix Owner", "HOD-FIN-2", "负责人 Owner", "", "2"]);
  assert.deepEqual(row("HOD Mkt"), ["HOD Mkt", "", "", "需确认 Needs review", "Zara Direct (HOD-MKT-Z); Adam Brand (HOD-MKT-A)", "2"]);
  assert.deepEqual(row("HOD Legacy"), ["HOD Legacy", "Liam Lead", "HOD-LEG-1", "自动推算 Derived; 负责人已离职 Owner inactive: Lena Former (HOD-LEG-O)", "", "1"]);
  assert.match(row("HOD Loop")[3], /^需确认 Needs review（汇报线成环 reporting loop）$/);
  assert.deepEqual(row("HOD Empty"), ["HOD Empty", "", "", "无在职人员 No active members", "", "0"]);
  assert.equal(row("HOD Off"), undefined);
  const audit = (await admin.get("/api/admin/audit?action=export")).data.rows.filter((a) => a.action === "export.hods-csv");
  assert.ok(audit.length >= 1, "导出落审计");
});

test("hods.csv：以 = + - @ 开头的单元格前置 '（CSV 公式注入防护）", async () => {
  const text = (await (await admin.raw("GET", "/api/admin/departments/hods.csv")).text()).replace(/^﻿/, "");
  const row = parseCsv(text).find((r) => r[0].includes("@HOD At"));
  assert.ok(row, "注入样本行存在");
  assert.equal(row[0], "'@HOD At");
  assert.equal(row[1], "'=Eve Formula");
  // JSON 载荷保持原样（防护只在 CSV 这个出口做）。
  const json = (await admin.get("/api/admin/departments/hods")).data;
  assert.equal(byName(json, "@HOD At").hod.name, "=Eve Formula");
});

// ---------- RBAC ----------

test("RBAC：people 读即可（JSON 与 CSV）；无 people 的后台角色 404（与本域其它端点同形）；员工 403；未登录 401", async () => {
  for (const p of ["/api/admin/departments/hods", "/api/admin/departments/hods.csv"]) {
    const ok = await peopleRead.raw("GET", p);
    assert.equal(ok.status, 200, "people=read → " + p);
    await ok.arrayBuffer();
    const none = await learningOnly.raw("GET", p);
    const sibling = await learningOnly.raw("GET", "/api/admin/departments");
    assert.equal(none.status, 404, "people=none → " + p);
    assert.equal(await none.text(), await sibling.text(), "与 GET /api/admin/departments 的 404 逐字同形");
    const emp403 = await employee.raw("GET", p);
    const empSibling = await employee.raw("GET", "/api/admin/departments");
    assert.equal(emp403.status, 403, "员工 → " + p);
    assert.equal(await emp403.text(), await empSibling.text());
    const anon = await makeClient(srv.base).raw("GET", p);
    assert.equal(anon.status, 401, "未登录 → " + p);
    await anon.arrayBuffer();
  }
  // 只读档不能借这条路径写（people=read 的写一律 403）。
  assert.equal((await peopleRead.put("/api/admin/departments/hods", { ownerId: "" })).status, 403);
});

// ---------- 部门范围 ----------

test("范围：只看到整棵子树都在范围内的一级部门；部分在范围内（Mkt 不含下级）整行不返回；summary 按可见行重算", async () => {
  const r = await scoped.get("/api/admin/departments/hods");
  assert.equal(r.status, 200);
  assert.equal(r.data.scoped, true, "前端据此说明名单按数据范围裁过");
  assert.deepEqual(r.data.duplicateNames, [], "重名组只给不受范围限制的角色");
  assert.deepEqual(r.data.items.map((x) => x.deptName).sort(), ["HOD Fin", "HOD Ops"]);
  assert.deepEqual(r.data.summary, { total: 2, owner: 1, derived: 1, ambiguous: 0, none: 0, ownerInactive: 0, unassignedPeople: 0 });
  assert.deepEqual(r.data.unassignedPeople, [], "未归属人员不在任何范围内");
  // 越界的一级部门、其成员、未归属的人，在载荷里一个字都不出现。
  const body = JSON.stringify(r.data);
  for (const s of ["HOD Mkt", "Zara", "Adam", "HOD Out", "Omar", "Gina Ghost", "HOD Ghost Dept", "HOD Legacy", "Lena", "HOD Loop", dept["HOD Out"], dept["HOD Mkt"]])
    assert.ok(!body.includes(s), `范围外的 ${s} 不得出现在载荷里`);
  // 可见行与超管看到的同一行完全相同（推算不随观看者变化；这里的负责人与 HoD 都在范围内，
  // 负责人在范围外时只抹掉他的部门与职位，见下一项）。
  const all = (await admin.get("/api/admin/departments/hods")).data;
  for (const it of r.data.items) assert.deepEqual(it, byName(all, it.deptName));
  // CSV 同一口径。
  const rows = parseCsv((await (await scoped.raw("GET", "/api/admin/departments/hods.csv")).text()).replace(/^﻿/, ""));
  assert.deepEqual(rows.slice(1).map((x) => x[0]).sort(), ["HOD Fin", "HOD Ops"]);
});

test("范围：范围外新增一级部门与人员，范围受限角色看到的载荷逐字不变（不泄露存在性）", async () => {
  const before1 = stripTime((await scoped.get("/api/admin/departments/hods")).data);
  await makeDept("HOD Out Two");
  assert.equal((await admin.post("/api/admin/employees", { name: "Nina New", employeeId: "HOD-OUT-2", department: "HOD Out Two" })).status, 200);
  assert.equal((await admin.post("/api/admin/employees", { name: "Nobody Dept", employeeId: "HOD-OUT-3" })).status, 200);
  const after1 = stripTime((await scoped.get("/api/admin/departments/hods")).data);
  assert.deepEqual(after1, before1);
  // 超管那边确实多了一行、多了一个未归属的人（证明上面不是因为没写进去）。
  const all = (await admin.get("/api/admin/departments/hods")).data;
  assert.equal(byName(all, "HOD Out Two").hod.employeeId, "HOD-OUT-2");
  assert.ok(all.unassignedPeople.some((p) => p.employeeId === "HOD-OUT-3" && p.reason === "blank"));
});

test("范围：负责人在范围外时只给姓名与工号 —— 不带出他所在的范围外部门与职位；负责人状态对范围受限的角色只分在职 / 不在职", async () => {
  // HOD Fin 在范围内；把它的负责人设成范围外部门（HOD Out）的 Omar，并给 Omar 一个职位。
  assert.equal((await admin.put("/api/admin/employees/" + emp["HOD-OUT-1"], { position: "Covert Investigations Lead" })).status, 200);
  assert.equal((await admin.put("/api/admin/departments/" + dept["HOD Fin"], { ownerId: emp["HOD-OUT-1"] })).status, 200);
  try {
    const sc = (await scoped.get("/api/admin/departments/hods")).data;
    const fin = byName(sc, "HOD Fin");
    assert.equal(fin.source, "owner");
    assert.deepEqual([fin.hod.name, fin.hod.employeeId], ["Omar Out", "HOD-OUT-1"], "姓名与工号照给（与 GET /departments 的 ownerName / ownerEmployeeId 同一取舍）");
    assert.equal(fin.hod.department, null, "范围外的部门名不给");
    assert.equal(fin.hod.position, null, "范围外的人的职位不给");
    const body = JSON.stringify(sc);
    for (const s of ["HOD Out", "Covert Investigations Lead", dept["HOD Out"]]) assert.ok(!body.includes(s), `范围外的 ${s} 不得出现在载荷里`);
    // 不受范围限制的角色照常看到全部字段。
    const all = byName((await admin.get("/api/admin/departments/hods")).data, "HOD Fin");
    assert.deepEqual([all.hod.department, all.hod.position], ["HOD Out", "Covert Investigations Lead"]);
    // 负责人账号已不存在（只可能来自直写库：PUT 会拒绝未知 id）：超管看到 missing，范围受限的角色只看到 inactive。
    withDb((db) => db.prepare("UPDATE departments SET ownerId = 'u-gone-owner' WHERE id = ?").run(dept["HOD Fin"]));
    assert.equal(byName((await admin.get("/api/admin/departments/hods")).data, "HOD Fin").owner.status, "missing");
    const sc2 = byName((await scoped.get("/api/admin/departments/hods")).data, "HOD Fin");
    assert.equal(sc2.owner.status, "inactive");
    assert.equal(sc2.ownerInactive, true);
  } finally {
    assert.equal((await admin.put("/api/admin/departments/" + dept["HOD Fin"], { ownerId: emp["HOD-FIN-2"] })).status, 200);
  }
});

test("范围：范围内没有完整一级部门的角色拿到空名单，scoped 为真（前端据此说明原因，而不是显示「暂无一级部门」）", async () => {
  const onlyL2 = await makeAdminUser("HOD-A-L2", await makeRole("HoD Level-2 Only", { people: "read" }, { departments: [{ id: dept["HOD Ops Pay"], includeChildren: true }] }));
  const r = await onlyL2.get("/api/admin/departments/hods");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items, []);
  assert.equal(r.data.scoped, true);
  assert.equal(r.data.summary.total, 0);
});

test("审计：设负责人 / 换人 / 清空，department.update 的 before 与 after 同形，带负责人 id 与姓名", async () => {
  const lastAudit = (target) => {
    let row;
    withDb((db) => { row = db.prepare("SELECT * FROM audit_logs WHERE action = 'department.update' AND target = ? ORDER BY id DESC LIMIT 1").get(target); });
    return { before: JSON.parse(row.beforeJson), after: JSON.parse(row.afterJson) };
  };
  const put = async (ownerId) => assert.equal((await admin.put("/api/admin/departments/" + dept["HOD Empty"], { ownerId })).status, 200);
  await put(emp["HOD-OUT-1"]);
  let a = lastAudit("HOD Empty");
  assert.deepEqual(Object.keys(a.before).sort(), Object.keys(a.after).sort(), "两侧同一组键：审计页只显示真正变了的字段");
  assert.deepEqual([a.before.ownerId, a.before.ownerName], [null, null]);
  assert.deepEqual([a.after.ownerId, a.after.ownerName], [emp["HOD-OUT-1"], "Omar Out"], "设成了谁看得出来");
  for (const k of ["id", "name", "parentId", "active", "sort"]) assert.deepEqual(a.after[k], a.before[k], `${k} 没变，不产生变更行`);
  await put(emp["HOD-FIN-1"]);
  a = lastAudit("HOD Empty");
  assert.deepEqual([a.before.ownerName, a.after.ownerName], ["Omar Out", "Fiona Top"], "换人：从谁变成谁");
  await put("");
  a = lastAudit("HOD Empty");
  assert.deepEqual([a.before.ownerId, a.after.ownerId], [emp["HOD-FIN-1"], null], "清空");
});

test("认领孤儿部门：挂到自己的子部门下 → 400 dept_cycle（与 PUT 同一规则），什么都不改，这个一级部门仍在 HoD 名单里", async () => {
  await makeDept("CYC Root");
  await makeDept("CYC Child", "CYC Root");
  assert.equal((await admin.post("/api/admin/employees", { name: "Cy Member", employeeId: "CYC-1", department: "CYC Child" })).status, 200);
  const outbox = () => { let n; withDb((db) => { n = db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE subjectDeptId = ?").get(dept["CYC Root"]).n; }); return n; };
  const before1 = outbox();
  for (const body of [{ name: "CYC Root", parentId: dept["CYC Child"] }, { name: "cyc root", parentName: "CYC Child" }]) {
    const r = await admin.post("/api/admin/departments", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.code, "dept_cycle");
    assert.match(r.data.error, /subtree/);
    assert.match(r.data.error, /子部门/);
  }
  const put = await admin.put("/api/admin/departments/" + dept["CYC Root"], { parentId: dept["CYC Child"] });
  assert.equal(put.status, 400);
  assert.equal(put.data.code, "dept_cycle", "PUT 改上级的同一种拒绝带同一个 code");
  const root = (await admin.get("/api/admin/departments")).data.find((d) => d.id === dept["CYC Root"]);
  assert.equal(root.parentId, null, "没有写");
  assert.equal(outbox(), before1, "没有 department.moved 事件");
  const row = byName((await admin.get("/api/admin/departments/hods")).data, "CYC Root");
  assert.equal(row.memberCount, 1, "一级部门与成员都还在名单里");
  // 正常认领（挂到别的部门下）照常可用。
  await makeDept("CYC Orphan");
  const ok = await admin.post("/api/admin/departments", { name: "CYC Orphan", parentId: dept["CYC Root"] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.adopted, true);
});

test("部门名大小写：写入存部门表的写法；存量的大小写变体在改名时跟着走、删除前的人数校验数得到、在编人数与 HoD 成员数算得进", async () => {
  await makeDept("CV Sales");
  assert.equal((await admin.post("/api/admin/employees", { name: "Cv One", employeeId: "CV-001", department: "cv sales" })).status, 200);
  assert.equal((await admin.post("/api/admin/employees", { name: "Cv Two", employeeId: "CV-002" })).status, 200);
  assert.equal((await admin.post("/api/admin/employees", { name: "Cv Three", employeeId: "CV-003", department: "CV Sales" })).status, 200);
  for (const u of (await admin.get("/api/admin/roster")).data) emp[u.employeeId] = u.id;
  assert.equal((await admin.put("/api/admin/employees/" + emp["CV-002"], { department: "CV SALES" })).status, 200);
  const deptOfUser = (id) => { let v; withDb((db) => { v = db.prepare("SELECT department FROM users WHERE id = ?").get(id).department; }); return v; };
  assert.equal(deptOfUser(emp["CV-001"]), "CV Sales", "POST employees 存规范写法");
  assert.equal(deptOfUser(emp["CV-002"]), "CV Sales", "PUT employees 存规范写法");
  // 存量的大小写变体（旧数据 / 直写库）：
  withDb((db) => db.prepare("UPDATE users SET department = 'cv sales' WHERE id = ?").run(emp["CV-003"]));
  const deptsNow = async () => (await admin.get("/api/admin/departments")).data;
  assert.equal((await deptsNow()).find((d) => d.id === dept["CV Sales"]).headcount, 3, "在编人数把大小写变体算进来");
  assert.equal(byName((await admin.get("/api/admin/departments/hods")).data, "CV Sales").memberCount, 3);
  // 删除前的人数校验：两条删除路径都数到 3 人、都拒绝。
  const del = await admin.del("/api/admin/departments/" + dept["CV Sales"]);
  assert.equal(del.status, 400);
  assert.match(del.data.error, /^3 employee/);
  // DELETE 与旧版 POST 同一应答（2026-09-28）：code 沿用旧版的 "occupied"，带 headcount，error 中英双语（英文在前）
  assert.equal(del.data.code, "occupied");
  assert.equal(del.data.headcount, 3);
  // CX-131：中英文分开；CX-127：写明含已离职员工
  assert.equal(del.data.error, "3 employee record(s), including former employees, are in this department — deactivate it instead.");
  assert.equal(del.data.error_zh, "该部门还有 3 名员工档案（含已离职员工），不能删除，只能停用。");
  const legacyDel = await admin.post("/api/admin/departments", { action: "delete", name: "CV Sales" });
  assert.equal(legacyDel.status, 400);
  assert.equal(legacyDel.data.code, "occupied");
  assert.equal(legacyDel.data.headcount, 3);
  assert.deepEqual(legacyDel.data, del.data, "两条删除路径的 400 应答逐字相同");
  // 改名：大小写变体的成员跟着走，不被留在旧名上变成未归属。
  let mark1; withDb((db) => { mark1 = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM event_outbox").get().n; });
  assert.equal((await admin.put("/api/admin/departments/" + dept["CV Sales"], { name: "CV Revenue" })).status, 200);
  dept["CV Revenue"] = dept["CV Sales"];
  for (const k of ["CV-001", "CV-002", "CV-003"]) assert.equal(deptOfUser(emp[k]), "CV Revenue", k);
  let renamed; withDb((db) => { renamed = db.prepare("SELECT data FROM event_outbox WHERE rowid > ? AND type = 'department.renamed'").all(mark1); });
  assert.equal(renamed.length, 1);
  assert.equal(JSON.parse(renamed[0].data).members, 3);
  const hods = (await admin.get("/api/admin/departments/hods")).data;
  assert.equal(byName(hods, "CV Revenue").memberCount, 3);
  assert.ok(!hods.unassignedPeople.some((p) => p.employeeId.startsWith("CV-")), "没有人因为大小写掉出部门树");
  // 调动记录的副作用同样存规范写法。
  const rec = await admin.post(`/api/admin/employees/${emp["CV-002"]}/records`, { type: "transfer", date: "2026-09-20", fields: { fromDept: "CV Revenue", toDept: "HOD OPS", syncDept: true } });
  assert.equal(rec.status, 200);
  assert.equal(deptOfUser(emp["CV-002"]), "HOD Ops");
});

test("部门名大小写（非 ASCII）：「CV PARAÑAQUE OFFICE」认得出已有的「CV Parañaque Office」，不再新建一条只差大小写的一级部门", async () => {
  await makeDept("CV Parañaque Office", "CV Revenue");
  const before1 = (await admin.get("/api/admin/departments")).data.length;
  assert.equal((await admin.put("/api/admin/employees/" + emp["CV-001"], { department: "CV PARAÑAQUE OFFICE" })).status, 200);
  const after1 = (await admin.get("/api/admin/departments")).data;
  assert.equal(after1.length, before1, "没有新建部门（以前 SQLite lower() 不折叠 Ñ/ñ，会新建一个一级部门）");
  let stored; withDb((db) => { stored = db.prepare("SELECT department FROM users WHERE id = ?").get(emp["CV-001"]).department; });
  assert.equal(stored, "CV Parañaque Office");
  const hods = (await admin.get("/api/admin/departments/hods")).data;
  assert.equal(byName(hods, "CV PARAÑAQUE OFFICE"), undefined, "HoD 名单里没有假的一级部门");
  assert.equal(byName(hods, "CV Revenue").memberCount, 2, "这个人（与 CV-003）仍算在 CV Revenue 下（CV-002 上一项已调去 HOD Ops）");
  // 部门页新建同名（只差大小写）的部门同样被拦下。
  const dup = await admin.post("/api/admin/departments", { name: "cv parañaque office" });
  assert.equal(dup.status, 400);
});

// ---------- 前端（静态核对：构建产物之外，这几处没有界面测试） ----------

test("前端：审计页认得 export.hods-csv 与负责人字段；负责人选择框与推算同一「在职」口径；空名单按 scoped 说明原因；新增文案中英成对", () => {
  const audit = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "Audit.jsx"), "utf8");
  assert.match(audit, /'export\.hods-csv': \{ zh: '[^']+', en: '[^']+'/, "导出 HoD 名单有动作名（否则审计页显示原始键名、筛选下拉里选不到）");
  for (const k of ["ownerId", "ownerName"]) assert.match(audit, new RegExp(`\\n\\s*${k}: \\{ zh: '[^']+', en: '[^']+' \\}`), `FIELDS.${k}`);
  const src = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "Departments.jsx"), "utf8");
  assert.match(src, /\(roster \|\| \[\]\)\.filter\(\(u\) => u\.active !== false && u\.empStatus !== 'exited' && u\.role !== 'admin'\)/,
    "负责人候选排除 empStatus 为 exited 的人（与 org.js isInService 一致）");
  assert.match(src, /data\.scoped \? s\.hodEmptyScoped : s\.hodEmpty/);
  assert.match(src, /it\.reason === 'loop' \|\| it\.reason === 'loop_with_top'/);
  const i = src.indexOf("const T = {");
  // eslint-disable-next-line no-new-func
  const T = new Function(src.slice(i, src.indexOf("\n};", i) + 3) + "; return T;")();
  const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, p + k + ".") : [p + k]));
  assert.deepEqual(flat(T.zh).sort(), flat(T.en).sort(), "T.zh 与 T.en 键一一对应");
  for (const k of ["hodEmptyScoped", "hodScopedNote", "hodWhyUnknown", "hodWhyCycle", "hodWhyInactive", "hodDup"]) {
    assert.ok(k in T.zh && k in T.en, k);
    assert.equal(typeof T.zh[k], typeof T.en[k], k);
  }
});

test("前端：HoD 名单表格的「HoD 姓名」列标题不被表头的全局大写转换改成「HOD」；全局表头样式不变、其它列照旧", () => {
  const src = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "Departments.jsx"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "web", "src", "app.css"), "utf8");
  // 全局规则仍在（本次只针对这一列，不改全局样式）
  assert.match(css, /\.semi-table-thead > \.semi-table-row > \.semi-table-row-head\{[^}]*text-transform:uppercase/, "表头的全局大写规则保持不变");
  // 这一列的标题包一层 text-transform:none（text-transform 可继承，子元素上的 none 覆盖表头的 uppercase）
  assert.match(src, /\{ title: <span style=\{\{ textTransform: 'none' \}\}>\{s\.colHod\}<\/span>, dataIndex: 'hod'/, "HoD 列标题关闭大写转换");
  // 其它列仍是纯文本标题（沿用全局大写）
  for (const k of ["colL1", "colEmpId", "colSource", "colCand", "colMembers"]) assert.match(src, new RegExp(`\\{ title: s\\.${k}, dataIndex: `), k);
  // 两种语言的列名都含大小写混排的「HoD」
  const i = src.indexOf("const T = {");
  // eslint-disable-next-line no-new-func
  const T = new Function(src.slice(i, src.indexOf("\n};", i) + 3) + "; return T;")();
  assert.equal(T.zh.colHod, "HoD 姓名");
  assert.equal(T.en.colHod, "HoD");
  // 构建产物里同样带上这条内联样式（改了 web/src 就要重新构建）
  const dist = path.join(ROOT, "public", "dist", "assets");
  const built = fs.readdirSync(dist).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(dist, f), "utf8"));
  assert.ok(built.some((b) => /textTransform:"none"/.test(b) && b.includes("HoD 姓名")), "public/dist 含 HoD 列的 textTransform:none");
});

// ---------- server.js 的 hodOf / deptLevelsOf（按源码原文截取，注入桩 store） ----------

const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8").replace(/\r\n/g, "\n");
function serverFunction(name) {
  const lines = SERVER_SRC.split("\n");
  const s = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(s >= 0, `server.js: function ${name} not found`);
  const e = lines.findIndex((l, i) => i > s && l === "}");
  return lines.slice(s, e + 1).join("\n");
}
function serverOrgHelpers(depts, users) {
  const calls = { listDepartments: 0, listUsers: 0 };
  const store = {
    listDepartments: (inc) => { calls.listDepartments++; assert.equal(inc, true, "含停用部门（停用部门不清员工的部门名）"); return depts; },
    listUsers: () => { calls.listUsers++; return users; },
  };
  const src = ["orgSnapshot", "hodOf", "deptLevelsOf"].map(serverFunction).join("\n");
  // eslint-disable-next-line no-new-func
  const api = new Function("orgLib", "store", `${src}\nreturn { orgSnapshot, hodOf, deptLevelsOf };`)(require("../modules/core/org.js"), store);
  return { ...api, calls };
}

test("server.js hodOf / deptLevelsOf：一级 / 二级 / 三级 / 本部，四级并入三级；HoD 只看一级；批量调用共用一个快照", () => {
  const depts = [
    { id: "d1", name: "Ops", parentId: null, active: true, ownerId: null },
    { id: "d2", name: "Pay", parentId: "d1", active: true, ownerId: null },
    { id: "d3", name: "Settle", parentId: "d2", active: true, ownerId: null },
    { id: "d4", name: "Mkt", parentId: null, active: true, ownerId: null },
    { id: "d5", name: "Recon", parentId: "d3", active: true, ownerId: null },
  ];
  const users = [
    { id: "u1", name: "Head", employeeId: "E1", department: "Ops", managerId: null, role: "employee", active: 1 },
    { id: "u2", name: "Leaf", employeeId: "E2", department: "Settle", managerId: "u1", role: "employee", active: 1 },
    { id: "u3", name: "M1", employeeId: "E3", department: "Mkt", managerId: null, role: "employee", active: 1 },
    { id: "u4", name: "M2", employeeId: "E4", department: "Mkt", managerId: null, role: "employee", active: 1 },
  ];
  const h = serverOrgHelpers(depts, users);
  assert.deepEqual(h.deptLevelsOf(users[1]), { level1: "Ops", level2: "Pay", level3: "Settle", isDirect: false, isDirect2: false, level1Id: "d1", level2Id: "d2", level3Id: "d3" });
  assert.deepEqual(h.deptLevelsOf(users[0]), { level1: "Ops", level2: null, level3: null, isDirect: true, isDirect2: false, level1Id: "d1", level2Id: null, level3Id: null });
  assert.deepEqual(h.deptLevelsOf({ department: "Pay" }), { level1: "Ops", level2: "Pay", level3: null, isDirect: false, isDirect2: true, level1Id: "d1", level2Id: "d2", level3Id: null });
  assert.deepEqual(h.deptLevelsOf({ department: "Recon" }), { level1: "Ops", level2: "Pay", level3: "Settle", isDirect: false, isDirect2: false, level1Id: "d1", level2Id: "d2", level3Id: "d3" }, "四级并入三级");
  const blank = { level1: null, level2: null, level3: null, isDirect: false, isDirect2: false, level1Id: null, level2Id: null, level3Id: null };
  assert.deepEqual(h.deptLevelsOf({ department: "Nowhere" }), blank);
  assert.deepEqual(h.deptLevelsOf(null), blank);
  assert.equal(h.calls.listUsers, 0, "只问层级不读 users");
  const hod = h.hodOf("Settle");
  assert.equal(hod.id, "u1");
  assert.equal(hod.source, "derived");
  assert.equal(hod.level1, "Ops");
  assert.equal(h.hodOf("Mkt"), null, "需确认 → null（没有唯一答案）");
  assert.equal(h.hodOf(""), null);
  // 批量：一个快照问很多次，只读一次库。
  const before1 = { ...h.calls };
  const snap = h.orgSnapshot();
  for (let i = 0; i < 50; i++) { h.hodOf("Pay", snap); h.deptLevelsOf(users[1], snap); }
  assert.deepEqual(h.calls, { listDepartments: before1.listDepartments + 1, listUsers: before1.listUsers + 1 });
});
// ---------- 终审补充：停用一级部门的名字不越过范围 ----------

test("范围：所属一级部门已停用的人计入未归属；那个一级部门不在范围内时不报它的名字（level1 置空），在范围内照给", async () => {
  await makeDept("HOD Shut");
  await makeDept("HOD Shut Unit", "HOD Shut");
  assert.equal((await admin.post("/api/admin/employees", { name: "Sam Shut", employeeId: "HOD-SHUT-1", department: "HOD Shut Unit" })).status, 200);
  assert.equal((await admin.put("/api/admin/departments/" + dept["HOD Shut"], { active: false })).status, 200);
  const pick = (d) => d.unassignedPeople.find((p) => p.employeeId === "HOD-SHUT-1");
  // 不受范围限制：照常带停用的一级部门名。
  const all = pick((await admin.get("/api/admin/departments/hods")).data);
  assert.deepEqual([all.reason, all.department, all.level1], ["inactive_level1", "HOD Shut Unit", "HOD Shut"]);
  // 范围只含二级部门：人可见（他的部门在范围内），停用的一级部门不在范围内 → 名字不给。
  const unitOnly = await makeAdminUser("HOD-A-SHUT-UNIT", await makeRole("HoD Shut Unit Only", { people: "read" }, { departments: [{ id: dept["HOD Shut Unit"], includeChildren: true }] }));
  const u = (await unitOnly.get("/api/admin/departments/hods")).data;
  assert.equal(u.scoped, true);
  assert.deepEqual(u.items, []);
  assert.equal(u.summary.unassignedPeople, 1);
  const p = pick(u);
  assert.deepEqual([p.reason, p.department, p.level1], ["inactive_level1", "HOD Shut Unit", null]);
  assert.ok(!JSON.stringify(u).includes('"HOD Shut"'), "范围外的一级部门名不得出现在载荷里");
  // 范围含这个一级部门（及其下级）：名字照给。
  const whole = await makeAdminUser("HOD-A-SHUT-ALL", await makeRole("HoD Shut Whole", { people: "read" }, { departments: [{ id: dept["HOD Shut"], includeChildren: true }] }));
  assert.equal(pick((await whole.get("/api/admin/departments/hods")).data).level1, "HOD Shut");
});
