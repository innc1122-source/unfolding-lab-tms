// 12.2 工作台（设计 b12-design 第 1–3、6.4、6.6 节）HTTP 契约：
//   · 四个接口 todo / risk / structure / people 的每个数字都等于对应名单的 total（卡片数 = 名单人数，6.6 第 3 条）；
//   · 两道闸：模块开关 + 能力域（无权的块整块不下发、名单 404），再数据范围（受限范围的每个数字 ≤ 全范围，名单里没有范围外的人、部门、岗位）；
//   · 上期值：首次启动上期为空；季度末快照（A2）在下一季度成为上期（继任覆盖、流失风险、管理幅度）；保留与试用期按上季度窗口算；
//   · 合规率与培训概览 period=quarter 的 requiredCompletion 同口径；
//   · 404：未知 metric、无权 metric、不在表里的部门；模块关闭：对应块消失、不出 500。
// 时钟用 LMS_FAKE_NOW 推进三次：A = 2026-08-20（Q3 首次启动）、A2 = 2026-09-25（Q3 期末快照）、B = 2026-11-15（Q4）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");

const HIPO = "hipo", KEY = "key", FLIGHT = "flight";   // controlled-tags 接口收的是 key
const REASON = "工作台 HTTP 测试：按夹具方案打标";
const T_A = "2026-08-20T04:00:00Z", T_A2 = "2026-09-25T04:00:00Z", T_B = "2026-11-15T04:00:00Z";

let srv, admin, dbPath;
const dept = {}, emp = {}, cli = {};
const db = (fn, readOnly = true) => { const d = new DatabaseSync(dbPath, { readOnly }); try { return fn(d); } finally { d.close(); } };
const boot = (now, extra) => startServer({ dbPath, env: { LMS_FAKE_NOW: now, LMS_NO_DEMO_USERS: "1", ...(extra || {}) } });

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name + " " + JSON.stringify(r.data));
  return r.data.role.id;
}
async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: "Name " + empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  emp[empId] = u.id;
  if (patch) { const p = await admin.put("/api/admin/employees/" + u.id, patch); assert.equal(p.status, 200, "patch " + empId + " " + JSON.stringify(p.data)); }
  return created.data.password;
}
async function loginEmp(empId, pw) {
  const c = await loginAs(srv.base, { employeeId: empId, password: pw });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: pw, newPassword: empId + "-pw-2026" })).status, 200);
  return c;
}
async function relogin(empId) { return loginAs(srv.base, { employeeId: empId, password: empId + "-pw-2026" }); }
const tagIt = (empId, tag, action) => admin.post(`/api/admin/employees/${emp[empId]}/controlled-tags`, { tag, action, reason: REASON });
const record = async (empId, type, date, fields) => { const r = await admin.post(`/api/admin/employees/${emp[empId]}/records`, { type, date, fields }); assert.equal(r.status, 200, type + " " + empId + " " + JSON.stringify(r.data)); return r.data.record; };
const succ = async (positionName, empId, readiness) => assert.equal((await admin.post("/api/admin/succession", { positionName, userId: emp[empId], readiness })).status, 200);
const kp = async (name, deptName) => { const r = await admin.post("/api/admin/key-positions", { name, deptId: dept[deptName] }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.position; };

const wb = async (c, what) => { const r = await c.get("/api/admin/workbench/" + what); assert.equal(r.status, 200, what + " " + JSON.stringify(r.data).slice(0, 300)); return r.data; };
const people = async (c, qs) => { const r = await c.get("/api/admin/workbench/people?" + qs); assert.equal(r.status, 200, qs + " " + JSON.stringify(r.data).slice(0, 300)); return r.data; };
const total = async (c, qs) => (await people(c, qs)).total;
const metricOf = (risk, key) => risk.metrics.find((m) => m.key === key);
const names = (rows) => rows.map((r) => r.name).sort();

// 卡片数 = 名单人数（6.6 第 3 条）：对一个客户端把四个接口的每个数字与 people 名单对一遍
async function assertCountsEqualLists(c, label) {
  const todo = await wb(c, "todo"), risk = await wb(c, "risk"), st = await wb(c, "structure");
  for (const it of todo.items) {
    const p = await people(c, "metric=" + it.key);
    assert.equal(it.count, p.total, `${label} todo ${it.key}`);
    if (it.overdueCount !== undefined) assert.equal(it.overdueCount, p.rows.filter((r) => r.overdue).length, `${label} todo ${it.key} overdueCount`);
  }
  for (const m of risk.metrics) {
    if (m.key === "succession") {
      assert.equal(m.den, await total(c, "metric=succession"), label + " succession den = positions listed");
      assert.equal(m.extra.noSuccessor, await total(c, "metric=succession&cell=noSuccessor"), label + " succession noSuccessor");
      if (m.prev !== null) assert.equal((await people(c, "metric=succession&period=prev")).rows.length > 0, true, label + " succession prev list");
    } else if (m.key === "retention") {
      assert.equal(m.value, await total(c, "metric=retention"), label + " retention");
      assert.equal(m.extra.voluntary, await total(c, "metric=retention&cell=voluntary"), label + " retention voluntary");
      assert.equal(m.prev, await total(c, "metric=retention&period=prev"), label + " retention prev");
      assert.equal(m.extra.flight.value, await total(c, "metric=flight"), label + " flight");
      if (m.extra.flight.prev !== null) assert.equal(m.extra.flight.prev, await total(c, "metric=flight&period=prev"), label + " flight prev");
    } else if (m.key === "compliance") {
      assert.equal(m.extra.notDonePeople, await total(c, "metric=compliance"), label + " compliance notDonePeople");
    } else if (m.key === "reviewOnTime") {
      assert.equal(m.extra.lateCount, await total(c, "metric=reviewOnTime"), label + " reviewOnTime late");
      const byStage = await Promise.all(["self", "rate", "calib"].map((s) => total(c, "metric=reviewOnTime&stage=" + s)));
      assert.equal(byStage.reduce((a, b) => a + b, 0), m.extra.lateCount, label + " reviewOnTime stages sum");
    } else if (m.key === "probation") {
      assert.equal(m.den, await total(c, "metric=probation"), label + " probation den");
      assert.equal(m.num, (await people(c, "metric=probation")).rows.filter((r) => r.result === "onTime" || r.result === "extended").length, label + " probation num");
    } else if (m.key === "span") {
      assert.equal(m.value, await total(c, "metric=span"), label + " span");
      assert.equal(m.extra.zero, await total(c, "metric=span&cell=zero"), label + " span zero");
      assert.equal(m.extra.over, await total(c, "metric=span&cell=over"), label + " span over");
      if (m.prev !== null) assert.equal(m.prev, await total(c, "metric=span&period=prev"), label + " span prev");
    }
  }
  if (st.nineBox) {
    for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) assert.equal(st.nineBox.cells[p][q], await total(c, `metric=nineBox&cell=${p}-${q}`), `${label} nineBox ${p}-${q}`);
    assert.equal(st.nineBox.unrated, await total(c, "metric=nineBox&cell=unrated"), label + " nineBox unrated");
    assert.equal(st.pipeline.candidates, await total(c, "metric=pipeline.candidates"), label + " pipeline candidates");
    assert.equal(st.pipeline.promoted, await total(c, "metric=pipeline.promoted"), label + " pipeline promoted");
  }
  if (st.deptHealth) {
    for (const row of st.deptHealth.rows) {
      for (const col of st.deptHealth.columns) {
        const p = await people(c, `metric=dept.${col}&dept=${encodeURIComponent(row.deptId)}`);
        if (col === "headcount") assert.equal(row.headcount, p.total, `${label} dept ${row.deptName} headcount`);
        else if (col === "probation" || col === "hipo") assert.equal(row.cells[col].num, p.total, `${label} dept ${row.deptName} ${col}`);
        else if (col === "compliance") {
          assert.equal(row.cells[col].den - row.cells[col].num, p.rows.reduce((a, r) => a + r.missingCount, 0), `${label} dept ${row.deptName} compliance missing`);
        } else if (col === "reviewOnTime") assert.equal(row.cells[col].den - row.cells[col].num, p.total, `${label} dept ${row.deptName} reviewOnTime late`);
      }
    }
  }
  return { todo, risk, st };
}

before(async () => {
  dbPath = path.join(tempDir("lms-wb-"), "wb.db");
  srv = await boot(T_A);
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["WB Root", null], ["WB Child", "WB Root"], ["WB Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200);
    dept[name] = r.data.department.id;
  }
  const reg = (d, extra) => ({ department: d, empStatus: "regular", hireDate: "2021-03-01", position: "Analyst", jobLevel: "PB2", ...(extra || {}) });
  await makeEmployee("R-MGR", reg("WB Root", { jobLevel: "MB2", position: "Root Lead", hireDate: "2019-01-01" }));
  await makeEmployee("R-ZERO", reg("WB Root", { jobLevel: "MB3", position: "Root Advisor", hireDate: "2019-06-01" }));
  await makeEmployee("R-E1", reg("WB Root", { managerId: emp["R-MGR"] }));
  await makeEmployee("R-E2", { department: "WB Child", empStatus: "probation", hireDate: "2026-05-20", position: "Analyst", jobLevel: "PB1", managerId: emp["R-MGR"] });
  await makeEmployee("R-E3", { department: "WB Child", empStatus: "probation", hireDate: "2026-04-01", position: "Analyst", jobLevel: "PB1", managerId: emp["R-MGR"] });
  await makeEmployee("R-E4", { department: "WB Child", empStatus: "probation", hireDate: "2026-03-01", position: "Analyst", jobLevel: "PB1", managerId: emp["R-MGR"] });
  await makeEmployee("R-E5", { department: "WB Child", empStatus: "probation", hireDate: "2026-06-01", position: "Analyst", jobLevel: "PB1" });
  await makeEmployee("O-MGR", reg("WB Other", { jobLevel: "MB2", position: "Other Head", hireDate: "2018-01-01" }));
  await makeEmployee("O-ZERO", reg("WB Other", { jobLevel: "MB3", position: "Other Advisor", hireDate: "2018-06-01" }));
  for (const id of ["O-E1", "O-E2", "O-E3"]) await makeEmployee(id, reg("WB Other", { managerId: emp["O-MGR"] }));
  // 受控标签：高潜 R-E1、关键人才 O-E2、流失风险 O-E1
  for (const [id, tag] of [["R-E1", HIPO], ["O-E2", KEY], ["O-E1", FLIGHT]]) { const r = await tagIt(id, tag, "add"); assert.equal(r.status, 200, JSON.stringify(r.data)); }
  // 关键岗位与继任：WB Lead（R-E1 一年内）、WB Other Head（O-E3 就绪）、WB Spare（无继任）
  await kp("WB Lead", "WB Root"); await kp("WB Other Head", "WB Other"); await kp("WB Spare", "WB Root");
  await succ("WB Lead", "R-E1", "oneYear");
  await succ("WB Other Head", "O-E3", "ready");
  // Q3 季度周期，自评截止 2026-08-10（今天 08-20 已过）
  const all = Object.keys(emp).map((k) => emp[k]);
  const c3 = await admin.post("/api/admin/review-cycles", { name: "WB Q3", dueAt: "2026-08-10", userIds: all });
  assert.equal(c3.status, 200, JSON.stringify(c3.data));
  // 角色：内置培训管理员、绩效与人才管理员；受限自定义角色（四域只读、范围 WB Root 含下级）
  const roles = (await admin.get("/api/admin/roles")).data.roles;
  const byKey = (k) => { const r = roles.find((x) => x.key === k); assert.ok(r, "builtin role " + k); return r.id; };
  const scoped = await makeRole("WB Scoped Reader", { people: "read", learning: "read", performance: "read", talent: "read" }, { departments: [{ id: dept["WB Root"], includeChildren: true }] });
  const pw = {};
  pw["A-LEARN"] = await makeEmployee("A-LEARN", { department: "WB Root", adminRoleId: byKey("learning-admin"), empStatus: "regular", hireDate: "2020-01-01", jobLevel: "PB3", position: "Admin L" });
  pw["A-PERF"] = await makeEmployee("A-PERF", { department: "WB Root", adminRoleId: byKey("performance-talent-admin"), empStatus: "regular", hireDate: "2020-01-01", jobLevel: "PB3", position: "Admin P" });
  pw["A-SCOPED"] = await makeEmployee("A-SCOPED", { department: "WB Root", adminRoleId: scoped, empStatus: "regular", hireDate: "2020-01-01", jobLevel: "PB3", position: "Admin S" });
  for (const k of Object.keys(pw)) cli[k] = await loginEmp(k, pw[k]);
});
after(() => srv && srv.stop());

test("phase A (Q3, first launch): counts equal lists; prev is null for succession, flight and span; todo shape", async () => {
  const { todo, risk } = await assertCountsEqualLists(admin, "A full");
  const s = metricOf(risk, "succession"), r = metricOf(risk, "retention"), sp = metricOf(risk, "span");
  assert.equal(s.prev, null); assert.equal(r.extra.flight.prev, null); assert.equal(sp.prev, null);
  assert.equal(s.snapshotSince, "2026-08", "snapshot taken at startup today");
  assert.deepEqual([s.num, s.den, s.value], [2, 3, 66.7]);
  assert.equal(r.extra.flight.value, 1);
  assert.equal(risk.period.key, "2026-Q3"); assert.equal(risk.period.prevKey, "2026-Q2"); assert.equal(risk.period.asOf, "2026-08-20");
  const selfOverdue = todo.items.find((i) => i.key === "reviewSelfOverdue");
  assert.equal(selfOverdue.count, 12, "every participant of WB Q3 (12 employees; the admins were created later) is overdue on self-review");
  assert.equal(selfOverdue.severity, "overdue");
  assert.equal(todo.items[0].severity, "overdue", "overdue items sort first");
  const pd = todo.items.find((i) => i.key === "probationDue");
  assert.deepEqual([pd.count, pd.overdueCount, pd.dueOn], [1, 0, "2026-08-31"], "R-E4 (hired 03-01) is due within 30 days");
  const ro = metricOf(risk, "reviewOnTime");
  assert.deepEqual([ro.num, ro.den, ro.value, ro.prev], [0, 12, 0, null]);
  await assertCountsEqualLists(cli["A-SCOPED"], "A scoped");
  const sc = metricOf(await wb(cli["A-SCOPED"], "risk"), "succession");
  assert.deepEqual([sc.num, sc.den, sc.value], [1, 2, 50], "scoped: WB Lead covered, WB Spare not; WB Other Head out of scope");
});

test("roles: each built-in role sees only its blocks (a block it cannot see has no key at all)", async () => {
  const keysOf = (o) => Object.keys(o).sort();
  const learn = await wb(cli["A-LEARN"], "risk"), perf = await wb(cli["A-PERF"], "risk"), full = await wb(admin, "risk");
  assert.deepEqual(learn.metrics.map((m) => m.key), ["compliance"]);
  assert.deepEqual(perf.metrics.map((m) => m.key).sort(), ["probation", "retention", "reviewOnTime", "span", "succession"]);
  assert.deepEqual(full.metrics.map((m) => m.key).sort(), ["compliance", "probation", "retention", "reviewOnTime", "span", "succession"]);
  const ls = await wb(cli["A-LEARN"], "structure"), ps = await wb(cli["A-PERF"], "structure"), fs_ = await wb(admin, "structure");
  assert.deepEqual(keysOf(ls), []);
  assert.deepEqual(keysOf(ps), ["deptHealth", "nineBox", "perfQuota", "pipeline"]);
  assert.deepEqual(ps.deptHealth.columns, ["headcount", "probation", "reviewOnTime", "hipo"], "no learning read → no compliance column");
  assert.deepEqual(keysOf(fs_), ["deptHealth", "nineBox", "perfQuota", "pipeline"]);
  assert.deepEqual(fs_.deptHealth.columns, ["headcount", "probation", "compliance", "reviewOnTime", "hipo"]);
  const lt = (await wb(cli["A-LEARN"], "todo")).items.map((i) => i.key).sort();
  assert.deepEqual(lt, ["approvals", "grading", "trainingDueSoon", "trainingOverdue"]);
  const pt = (await wb(cli["A-PERF"], "todo")).items.map((i) => i.key).sort();
  assert.deepEqual(pt, ["appealsDue", "deptNoHrbp", "noJobLevel", "noManager", "probationDue", "reviewHrConfirm", "reviewRateOverdue", "reviewSelfOverdue"]);
  const st = await wb(cli["A-SCOPED"], "structure");
  assert.deepEqual(keysOf(st), ["deptHealth", "nineBox", "perfQuota", "pipeline"]);
});

test("404: unknown metric, metric without permission, department not on the table; no block → no list", async () => {
  assert.equal((await admin.get("/api/admin/workbench/people?metric=nope")).status, 404);
  assert.equal((await admin.get("/api/admin/workbench/people")).status, 404);
  assert.equal((await cli["A-LEARN"].get("/api/admin/workbench/people?metric=succession")).status, 404, "learning admin has no talent");
  assert.equal((await cli["A-LEARN"].get("/api/admin/workbench/people?metric=probationDue")).status, 404, "learning admin has no people");
  assert.equal((await cli["A-PERF"].get("/api/admin/workbench/people?metric=compliance")).status, 404, "no learning");
  assert.equal((await cli["A-PERF"].get("/api/admin/workbench/people?metric=dept.compliance&dept=" + dept["WB Root"])).status, 404);
  assert.equal((await admin.get("/api/admin/workbench/people?metric=dept.headcount&dept=d-nope")).status, 404);
  assert.equal((await admin.get("/api/admin/workbench/people?metric=dept.headcount&dept=" + dept["WB Child"])).status, 404, "WB Child is not a row (rolled into WB Root)");
  assert.equal((await admin.get("/api/admin/workbench/people?metric=nineBox&cycle=rc-nope")).status, 404);
  assert.equal((await admin.get("/api/admin/workbench/people?metric=dept.headcount&dept=" + dept["WB Root"])).status, 200);
});

test("scope: every scoped number ≤ the full number; no WB Other people, departments or positions in scoped lists", async () => {
  const sc = cli["A-SCOPED"];
  const full = await wb(admin, "risk"), part = await wb(sc, "risk");
  for (const m of part.metrics) {
    const f = metricOf(full, m.key);
    if (m.num !== null && f.num !== null) assert.ok(m.num <= f.num, m.key + " num");
    if (m.den !== null && f.den !== null) assert.ok(m.den <= f.den, m.key + " den");
  }
  const ft = await wb(admin, "todo"), pt = await wb(sc, "todo");
  for (const it of pt.items) assert.ok(it.count <= ft.items.find((x) => x.key === it.key).count, "todo " + it.key);
  const leak = (s) => /WB Other|O-MGR|O-ZERO|O-E[123]|WB Other Head/.test(s);
  for (const qs of ["metric=succession", "metric=flight", "metric=span", "metric=reviewSelfOverdue", "metric=noManager", "metric=probationDue", "metric=nineBox&cell=unrated",
    "metric=dept.headcount&dept=" + dept["WB Root"]]) {
    const p = await people(sc, qs);
    assert.equal(leak(JSON.stringify(p)), false, "scoped list leaks: " + qs);
  }
  const st = await wb(sc, "structure");
  assert.deepEqual(st.deptHealth.rows.map((r) => r.deptName), ["WB Root"]);
  assert.equal((await sc.get("/api/admin/workbench/people?metric=dept.headcount&dept=" + dept["WB Other"])).status, 404, "out-of-scope department row → 404");
});

test("phase A2 → B (Q4): quarter-end snapshot becomes prev; retention, flight, probation and span after exits, regularization and a new flight tag", async () => {
  // 两阶段之间直接写库：管理幅度上限 2，Q3 自评完成时间（9 人按时、2 人迟、1 人未做）
  await srv.stopAsync();
  db((d) => {
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('workbenchConfig', ?)").run(JSON.stringify({ spanMax: 2 }));
    const items = d.prepare("SELECT ri.id, u.employeeId FROM review_items ri JOIN users u ON u.id = ri.userId JOIN review_cycles c ON c.id = ri.cycleId WHERE c.name = 'WB Q3' ORDER BY u.employeeId").all();
    assert.equal(items.length, 12);
    const late = new Set(["O-E1", "O-E2"]), none = new Set(["R-E5"]);
    const up = d.prepare("UPDATE review_items SET selfAt = ? WHERE id = ?");
    for (const it of items) { if (none.has(it.employeeId)) continue; up.run(late.has(it.employeeId) ? "2026-08-15T02:00:00.000Z" : "2026-08-05T02:00:00.000Z", it.id); }
  }, false);
  srv = await boot(T_A2);
  admin = await loginAs(srv.base, ADMIN);
  const a2 = await wb(admin, "risk");
  assert.equal(metricOf(a2, "span").value, 4, "spanMax 2: R-MGR (4) and O-MGR (3) wide, R-ZERO and O-ZERO zero");
  assert.equal(metricOf(a2, "reviewOnTime").value, 75, "9 of 12 self-reviews on time");
  await srv.stopAsync();

  srv = await boot(T_B);
  admin = await loginAs(srv.base, ADMIN);
  for (const k of Object.keys(cli)) cli[k] = await relogin(k);
  await record("R-E1", "exit", "2026-10-15", { exitType: "Voluntary", lastDay: "2026-10-15", syncStatus: true });
  await record("O-E2", "exit", "2026-10-20", { exitType: "Involuntary", lastDay: "2026-10-20", syncStatus: true });
  await record("R-E5", "exit", "2026-10-20", { exitType: "Voluntary", lastDay: "2026-10-20", syncStatus: true });
  await record("R-E3", "regularization", "2026-10-10", { result: "On time", syncStatus: true });
  assert.equal((await tagIt("R-E2", FLIGHT, "add")).status, 200);
  const live = ["R-MGR", "R-ZERO", "R-E2", "R-E3", "R-E4", "O-MGR", "O-ZERO", "O-E1", "O-E3", "A-LEARN", "A-PERF", "A-SCOPED"].map((k) => emp[k]);
  const c4 = await admin.post("/api/admin/review-cycles", { name: "WB Q4", dueAt: "2026-11-01", dueRateAt: "2026-11-10", dueCalibAt: "2026-12-01", flow: "v2", userIds: live });
  assert.equal(c4.status, 200, JSON.stringify(c4.data));
  await srv.stopAsync();
  db((d) => {
    const items = d.prepare("SELECT ri.id, u.employeeId FROM review_items ri JOIN users u ON u.id = ri.userId JOIN review_cycles c ON c.id = ri.cycleId WHERE c.name = 'WB Q4' ORDER BY u.employeeId").all();
    assert.equal(items.length, 12);
    const selfOk = new Set(["R-MGR", "R-ZERO", "R-E2", "R-E3", "O-MGR", "O-E1", "A-LEARN", "A-PERF"]);   // 8 按时自评
    const rateOk = new Set(["R-E2", "R-E3", "O-E1"]);                                                   // 3 按时评级
    const s = d.prepare("UPDATE review_items SET selfAt = ? WHERE id = ?"), m = d.prepare("UPDATE review_items SET managerAt = ? WHERE id = ?");
    for (const it of items) { if (selfOk.has(it.employeeId)) s.run("2026-10-25T02:00:00.000Z", it.id); if (rateOk.has(it.employeeId)) m.run("2026-11-05T02:00:00.000Z", it.id); }
  }, false);
  srv = await boot(T_B);
  admin = await loginAs(srv.base, ADMIN);
  for (const k of Object.keys(cli)) cli[k] = await relogin(k);

  const { risk, todo } = await assertCountsEqualLists(admin, "B full");
  assert.equal(risk.period.key, "2026-Q4"); assert.equal(risk.period.prevKey, "2026-Q3");
  const s = metricOf(risk, "succession");
  assert.deepEqual([s.num, s.den, s.value, s.prev, s.delta], [1, 3, 33.3, 66.7, -33.4], "R-E1 left → WB Lead uncovered; prev from the Q3 snapshot; delta = rounded values diff");
  assert.deepEqual(names((await people(admin, "metric=succession&cell=noSuccessor")).rows), ["WB Lead", "WB Spare"]);
  const r = metricOf(risk, "retention");
  assert.deepEqual([r.value, r.extra.voluntary, r.prev], [2, 1, 0], "R-E1 (hipo, voluntary) and O-E2 (key, involuntary) left in Q4; none in Q3");
  assert.deepEqual(names((await people(admin, "metric=retention")).rows), ["Name O-E2", "Name R-E1"]);
  const exitRow = (await people(admin, "metric=retention")).rows.find((x) => x.name === "Name R-E1");
  assert.deepEqual([exitRow.exitDate, exitRow.exitType, exitRow.tags], ["2026-10-15", "Voluntary", ["hipo"]]);
  assert.deepEqual([r.extra.flight.value, r.extra.flight.prev, r.extra.flight.delta], [2, 1, 1], "flight: O-E1 + R-E2 now; O-E1 in the Q3 snapshot");
  const pb = metricOf(risk, "probation");
  assert.deepEqual([pb.num, pb.den, pb.value, pb.extra.avgMonths], [1, 2, 50, 6.3], "R-E3 regularized on time (192 days); R-E5 exited within probation");
  assert.deepEqual((await people(admin, "metric=probation")).rows.map((x) => [x.name, x.result]).sort(), [["Name R-E3", "onTime"], ["Name R-E5", "exitedInProbation"]]);
  const sp = metricOf(risk, "span");
  // 10/12 负责人拍板管理幅度「直属 ≥ 上限」即过宽（原为「> 上限」）：O-MGR 2 人在上限 2 时也算过宽
  assert.deepEqual([sp.value, sp.extra.zero, sp.extra.over, sp.prev, sp.extra.spanMax], [4, 2, 2, 4, 2], "O-MGR now has 2 directs (≥ 2); R-MGR 3 (≥ 2); two zero-direct managers");
  const ro = metricOf(risk, "reviewOnTime");
  assert.deepEqual([ro.num, ro.den, ro.value, ro.prev, ro.extra.lateCount], [11, 24, 45.8, 88.9, 13], "Q4: 8/12 self + 3/12 rate due; calib not due yet; prev = Q3 recomputed without the 3 leavers (8/9)");
  assert.deepEqual(ro.extra.stages, { self: 66.7, rate: 25, calib: null });
  assert.equal(ro.extra.cycle.name, "WB Q4"); assert.equal(ro.extra.prevCycle.name, "WB Q3");
  const pd = todo.items.find((i) => i.key === "probationDue");
  assert.deepEqual([pd.count, pd.overdueCount], [2, 1], "R-E2 due 11-19, R-E4 overdue since 08-31; R-E3 regularized and R-E5 exited drop out");
  assert.equal(todo.items.find((i) => i.key === "reviewRateOverdue").count, 9, "12 items − 3 rated");
  assert.equal(todo.items.find((i) => i.key === "reviewSelfOverdue").count, 4);
  // 合规率与培训概览同口径
  const ov = await admin.get("/api/admin/overview?v=2&period=quarter");
  assert.equal(ov.status, 200);
  const comp = metricOf(risk, "compliance");
  assert.deepEqual([comp.num, comp.den, comp.value], [ov.data.kpis.requiredCompletion.num, ov.data.kpis.requiredCompletion.den, ov.data.kpis.requiredCompletion.value]);

  // 受限范围：WB Root 含下级
  const scR = (await assertCountsEqualLists(cli["A-SCOPED"], "B scoped")).risk;
  const ss = metricOf(scR, "succession"), sr = metricOf(scR, "retention"), spp = metricOf(scR, "span"), spb = metricOf(scR, "probation");
  assert.deepEqual([ss.value, ss.prev], [0, 50]);
  assert.deepEqual([sr.value, sr.extra.voluntary, sr.extra.flight.value, sr.extra.flight.prev], [1, 1, 1, 0]);
  assert.deepEqual([spb.num, spb.den, spb.value, spb.extra.avgMonths], [1, 2, 50, 6.3]);
  assert.deepEqual([spp.value, spp.prev], [2, 2]);
  // 九宫格与梯队名单的人数 = 结构块（assertCountsEqualLists 已逐格比对）；部门健康度行只有范围内的一级部门
  const st = await wb(cli["A-SCOPED"], "structure");
  assert.deepEqual(st.deptHealth.rows.map((x) => x.deptName), ["WB Root"]);
  assert.equal(st.deptHealth.rows[0].headcount, await total(cli["A-SCOPED"], "metric=dept.headcount&dept=" + dept["WB Root"]));
});

test("module off: the matching blocks disappear and nothing returns 500", async () => {
  await srv.stopAsync();
  const cfgDir = tempDir("lms-wb-cfg-");
  for (const mod of ["talent", "learning", "performance"]) {
    const cfg = path.join(cfgDir, mod + ".json");
    fs.writeFileSync(cfg, JSON.stringify({ modules: { [mod]: false } }));
    srv = await boot(T_B, { LMS_CONFIG_PATH: cfg });
    admin = await loginAs(srv.base, ADMIN);
    const risk = await wb(admin, "risk"), st = await wb(admin, "structure"), todo = await wb(admin, "todo");
    const keys = risk.metrics.map((m) => m.key);
    if (mod === "talent") {
      assert.equal(keys.includes("succession") || keys.includes("retention"), false);
      assert.equal("nineBox" in st || "pipeline" in st, false);
      assert.equal(st.deptHealth.columns.includes("hipo"), false);
      assert.equal((await admin.get("/api/admin/workbench/people?metric=flight")).status, 404);
    } else if (mod === "learning") {
      assert.equal(keys.includes("compliance"), false);
      assert.equal(todo.items.some((i) => i.module === "learning"), false);
      assert.equal(st.deptHealth.columns.includes("compliance"), false);
      assert.equal((await admin.get("/api/admin/workbench/people?metric=trainingOverdue")).status, 404);
    } else {
      assert.equal(keys.includes("reviewOnTime"), false);
      assert.equal("perfQuota" in st, false);
      assert.equal(todo.items.some((i) => i.module === "performance"), false);
      assert.equal(st.deptHealth.columns.includes("reviewOnTime"), false);
      assert.equal((await admin.get("/api/admin/workbench/people?metric=reviewOnTime")).status, 404);
      assert.ok(st.nineBox && !st.nineBox.compare, "nine-box stays (talent on) without the closed-cycle comparison");
    }
    await assertCountsEqualLists(admin, "off:" + mod);
    await srv.stopAsync();
  }
  srv = await boot(T_B);
  admin = await loginAs(srv.base, ADMIN);
});
