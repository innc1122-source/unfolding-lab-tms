// 第三批 4.1 / 4.2 / 1.2（2026-10-08）：风险优先的培训概览（GET /api/admin/overview?v=2）、下钻名单（/overview/people）、
// 全局搜索（/training/search）、一键提醒的逾期 / 提前提醒（remind-overdue metric）与课程学时（hours）。
//   - v2 载荷的各块；筛选 cat（含 __none）、enroll（nho 缺省必修）、mode、dept（含 direct:<id> 只看本部门直属）；
//   - 指标：学时字段驱动人均学时（验收 G1-3）；逾期只算已发布课程；7 天内到期；
//   - 名单总数与看板数字同源（验收 G3-5）；remindablePeople = reminded + skippedToday；due_soon 文案与每人每天一条；
//   - CSV（BOM、表头随 lang、审计 export.training-people）；搜索（太短、工号精确排第一、每组 5 条 + more）；
//   - 旧载荷（不带 v）原字段都在，trend 周 = 本地周一；课程学时 PUT 规范化（缺省保留、null 清除、越界 400）与批量改学时。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const dept = {}, emp = {};
const p2 = (x) => String(x).padStart(2, "0");
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const course = (id, o) => ({ id, title: id.toUpperCase(), title_zh: null, modules: [], mode: "offline", status: "published", enrollType: "mandatory", ...o });

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["OV Root", null], ["OV Child", "OV Root"]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200);
    dept[name] = r.data.department.id;
  }
  for (const [eid, d] of [["OV-1", "OV Child"], ["OV-2", "OV Child"], ["OV-3", "OV Root"], ["OV-4", "OV Root"]]) {
    const r = await admin.post("/api/admin/employees", { name: "Ov " + eid, employeeId: eid, department: d, programIds: [] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    emp[eid] = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === eid).id;
  }
  // 两门线下课：ovc1 必修、合规、4 学时，昨天到期；ovc2 选修、领导力、3 天后到期
  assert.equal((await admin.put("/api/admin/content/courses/ovc1", course("ovc1", { category: "Compliance", hours: 4 }))).status, 200);
  assert.equal((await admin.put("/api/admin/content/courses/ovc2", course("ovc2", { category: "领导力", enrollType: "elective" }))).status, 200);
  const ids = ["OV-1", "OV-2", "OV-3", "OV-4"].map((e) => emp[e]);
  assert.equal((await admin.post("/api/admin/assignments/bulk", { userIds: ids, programId: "pw-ovc1", dueAt: day(-1), action: "assign", silent: true })).status, 200);
  assert.equal((await admin.post("/api/admin/assignments/bulk", { userIds: [emp["OV-2"], emp["OV-3"]], programId: "pw-ovc2", dueAt: day(3), action: "assign", silent: true })).status, 200);
  assert.equal((await admin.post("/api/admin/courses/ovc1/checkin/mark", { userId: emp["OV-1"], status: "attended" })).status, 200);
});
after(() => srv.stop());

const q = (o) => "?" + new URLSearchParams(o).toString();
const ROOT = () => ({ dept: dept["OV Root"] });

test("v2 payload: blocks, filters echo, KPIs (hours field drives hours per head), heat rows, categories, due soon", async () => {
  const r = await admin.get("/api/admin/overview" + q({ v: 2, period: "quarter", ...ROOT() }));
  assert.equal(r.status, 200);
  const d = r.data;
  for (const k of ["v", "asOf", "filters", "employees", "programsMeta", "perProgram", "kpis", "attention", "categories", "heat", "projects", "trend"]) assert.ok(k in d, k);
  assert.equal(d.filters.period, "quarter");
  assert.ok(d.filters.from && d.filters.prevFrom);
  assert.equal(d.employees, 4);
  assert.deepEqual([d.kpis.coverage.num, d.kpis.coverage.den, d.kpis.coverage.value], [1, 4, 25]);
  assert.equal(d.kpis.hoursPerHead.value, 1, "4 h completed / 4 people");
  assert.equal(d.kpis.overduePeople.value, 3);
  const meta = d.programsMeta.find((p) => p.id === "pw-ovc1");
  assert.deepEqual([meta.courseId, meta.category, meta.mode, meta.hours, meta.enrollType], ["ovc1", "合规", "offline", 4, "mandatory"], "category normalised from 'Compliance'");
  const pp = d.perProgram.find((p) => p.id === "pw-ovc1");
  assert.deepEqual([pp.assigned, pp.done, pp.overdue, pp.remindablePeople, pp.hoursDone], [4, 1, 3, 3, 4]);
  assert.deepEqual([d.attention.dueSoon.people, d.attention.dueSoon.rows], [2, 2]);
  assert.equal(d.attention.dueSoon.items[0].programId, "pw-ovc2");
  assert.ok(d.attention.courses.some((c) => c.programId === "pw-ovc1" && c.reason === "overdue"));
  for (const k of ["enroll", "nominations", "review", "reviewOverdue", "manual", "appeals"]) assert.equal(typeof d.attention.pending[k], "number", k);
  // 热力表：OV Root 的直接下级 OV Child + 「本部门直属」行
  const rows = d.heat.rows.map((x) => [x.name, x.direct, x.filterKey]);
  assert.deepEqual(rows.sort(), [["OV Child", false, dept["OV Child"]], ["OV Root", true, "direct:" + dept["OV Root"]]].sort());
  assert.ok(d.heat.cols.includes("合规") && d.heat.cols.includes("领导力"));
  assert.ok(d.categories.findIndex((c) => c.key === "合规") < d.categories.findIndex((c) => c.key === "领导力"), "catalogue order");
  assert.equal(d.trend.length, 12);
  assert.equal(new Date(d.trend[11].week + "T00:00:00").getDay(), 1, "local Monday");
});

test("course filters: cat (incl. __none), enroll (nho defaults to required), mode; unknown values ignored", async () => {
  const meta = async (o) => (await admin.get("/api/admin/overview" + q({ v: 2, ...o }))).data.programsMeta.map((p) => p.id);
  assert.deepEqual(await meta({ cat: "领导力" }), ["pw-ovc2"]);
  assert.deepEqual((await meta({ cat: "Leadership,合规" })).sort(), ["pw-ovc1", "pw-ovc2"], "en labels map to keys");
  assert.ok((await meta({ cat: "__none" })).includes("nho"));
  assert.ok(!(await meta({ cat: "__none" })).includes("pw-ovc1"));
  const req = await meta({ enroll: "mandatory" });
  assert.ok(req.includes("nho") && req.includes("pw-ovc1") && !req.includes("pw-ovc2"));
  const off = await meta({ mode: "offline" });
  assert.ok(off.includes("pw-ovc1") && !off.includes("nho"));
  const junk = (await admin.get("/api/admin/overview" + q({ v: 2, enroll: "x", mode: "y", tp: "nope" }))).data;
  assert.deepEqual([junk.filters.enroll, junk.filters.mode, junk.filters.tp], [null, null, null]);
});

test("name lists: totals equal the dashboard numbers; direct:<id> keeps only people sitting in that department", async () => {
  const base = { period: "quarter", ...ROOT() };
  const d = (await admin.get("/api/admin/overview" + q({ v: 2, ...base }))).data;
  const list = async (o) => (await admin.get("/api/admin/overview/people" + q({ ...base, ...o }))).data;
  const ov = await list({ metric: "overdue" });
  assert.equal(ov.total, d.kpis.overduePeople.rows);
  assert.equal(ov.people, d.kpis.overduePeople.value);
  assert.equal(ov.remindablePeople, 3);
  assert.ok(ov.rows.every((r) => r.status === "overdue" && r.daysOverdue >= 1));
  const cov = await list({ metric: "covered" });
  assert.equal(cov.total, d.kpis.coverage.num);
  assert.equal(cov.rows[0].employeeId, "OV-1");
  assert.equal(cov.rows[0].hours, 4);
  assert.equal((await list({ metric: "uncovered" })).total, 3);
  const asg = await list({ metric: "assigned" });
  assert.equal(asg.total, d.perProgram.reduce((n, p) => n + p.assigned, 0));
  assert.equal((await list({ metric: "assigned", status: "done" })).total, 1);
  assert.equal((await list({ metric: "dueSoon" })).total, d.attention.dueSoon.rows);
  assert.equal((await list({ metric: "attempts" })).total, d.kpis.passRate.den ?? 0);
  const direct = await list({ metric: "assigned", ldept: "direct:" + dept["OV Root"] });
  assert.deepEqual([...new Set(direct.rows.map((r) => r.employeeId))].sort(), ["OV-3", "OV-4"]);
  const byQ = await list({ metric: "assigned", q: "ov-2" });
  assert.ok(byQ.rows.length && byQ.rows.every((r) => r.employeeId === "OV-2"));
  const paged = await list({ metric: "assigned", size: 10, page: 99 });
  assert.equal(paged.page, 1, "page clamps to the last page");
  assert.equal((await admin.get("/api/admin/overview/people?metric=nope")).status, 400);
});

test("remind: overdue reminds exactly the remindable people; due soon uses the job's wording and one per person per day", async () => {
  const body = { period: "quarter", dept: dept["OV Root"], programs: "pw-ovc1" };
  const r = await admin.post("/api/admin/training/remind-overdue", body);
  assert.equal(r.status, 200);
  assert.equal(r.data.reminded + r.data.skippedToday, 3);
  // CX-188：dryRun 只预演，不发通知、不写审计，人数与实际发送同一口径
  const dry = await admin.post("/api/admin/training/remind-overdue", { ...body, dryRun: true });
  assert.deepEqual([dry.data.dryRun, dry.data.reminded, dry.data.skippedToday], [true, 0, 3]);
  // CX-195：预演前后通知数、审计数不变（布尔 true 与字符串 "true" 都是预演）；看不懂的值 400，绝不按真实发送处理
  {
    const cnt = () => { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return [d.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, d.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'training.remind%'").get().n]; } finally { d.close(); } };
    const before = cnt();
    const fresh = { period: "quarter", dept: dept["OV Root"], programs: "pw-ovc2" };   // 今天还没提醒过的一门课：真发送会产生通知
    for (const v of [true, "true", 1, "1"]) {
      const p = await admin.post("/api/admin/training/remind-overdue", { ...fresh, metric: "dueSoon", dryRun: v });
      assert.equal(p.status, 200, JSON.stringify(v));
      assert.equal(p.data.dryRun, true, "dryRun " + JSON.stringify(v));
    }
    assert.deepEqual(cnt(), before, "dry runs send nothing and write no audit row");
    const bad = await admin.post("/api/admin/training/remind-overdue", { ...fresh, dryRun: "yes" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, "bad_dry_run");
    assert.deepEqual(cnt(), before);
  }
  // CX-114：同一天再发一次「已逾期」不重复发送，全部计入 skippedToday
  const r2 = await admin.post("/api/admin/training/remind-overdue", body);
  assert.deepEqual([r2.data.reminded, r2.data.skippedToday], [0, 3], "overdue: already reminded today");
  const s1 = await admin.post("/api/admin/training/remind-overdue", { ...body, programs: undefined, metric: "dueSoon" });
  assert.deepEqual([s1.data.reminded, s1.data.skippedToday], [2, 0]);
  const s2 = await admin.post("/api/admin/training/remind-overdue", { ...body, programs: undefined, metric: "dueSoon" });
  assert.deepEqual([s2.data.reminded, s2.data.skippedToday], [0, 2], "already reminded today");
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    const n = db.prepare("SELECT title, title_zh, body_zh, link FROM notifications WHERE userId = ? AND type = 'due_soon'").all(emp["OV-2"]);
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Due soon: "OVC2"');
    assert.match(n[0].body_zh, /^还有 3 天截止（\d{4}-\d{2}-\d{2}）。$/);
    assert.equal(n[0].link, "#/program/pw-ovc2");
    const a = db.prepare("SELECT afterJson FROM audit_logs WHERE action = 'training.remind-due-soon' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(a.afterJson).skippedToday, 2);
  } finally { db.close(); }
});

test("CSV export: BOM, headers in the requested language, audited", async () => {
  const res = await admin.raw("GET", "/api/admin/overview/people" + q({ metric: "overdue", format: "csv", lang: "en", ...ROOT() }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /training-overdue-\d{8}\.csv/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM");
  assert.ok(buf.subarray(3).toString("utf8").startsWith("Name,Employee ID,Department"));
  const zh = await (await admin.raw("GET", "/api/admin/overview/people" + q({ metric: "overdue", format: "csv", ...ROOT() }))).text();
  assert.ok(zh.replace(/^﻿/, "").startsWith("姓名,工号,部门"));
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try { assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'export.training-people'").get()); } finally { db.close(); }
});

test("search: too short, CJK one character, exact employee ID first, departments and courses", async () => {
  assert.equal((await admin.get("/api/admin/training/search?q=o")).data.tooShort, true);
  assert.equal((await admin.get("/api/admin/training/search?q=" + encodeURIComponent("合"))).data.tooShort, false);
  const s = (await admin.get("/api/admin/training/search?q=OV-1")).data;
  assert.equal(s.people[0].employeeId, "OV-1");
  assert.ok(s.people.length <= 5);
  const d = (await admin.get("/api/admin/training/search?q=" + encodeURIComponent("OV Ch"))).data;
  assert.equal(d.depts[0].id, dept["OV Child"]);
  const c = (await admin.get("/api/admin/training/search?q=ovc")).data;
  assert.deepEqual(c.courses.map((x) => x.id).sort(), ["pw-ovc1", "pw-ovc2"]);
  assert.equal(c.courses.find((x) => x.id === "pw-ovc1").courseId, "ovc1");
  assert.equal((await admin.get("/api/admin/training/search?q=" + "x".repeat(80))).data.q.length, 50);
});

test("legacy payload (no v) keeps every old key; trend weeks are local Mondays with a completed series", async () => {
  const d = (await admin.get("/api/admin/overview")).data;
  for (const k of ["employees", "perProgram", "byDept", "recent", "deptTree", "matrix", "trend", "filters"]) assert.ok(k in d, k);
  assert.deepEqual(d.filters, { dept: null, programs: [], from: null, to: null, cohort: "all" });
  for (const w of d.trend) { assert.equal(new Date(w.week + "T00:00:00").getDay(), 1, w.week); assert.equal(typeof w.completed, "number"); }
  const row = d.perProgram.find((p) => p.id === "pw-ovc1");
  assert.ok(row.overdueList.length >= 3);
});

test("course hours: missing key keeps the stored value, null clears, out of range is 400; bulk op hours; detail carries hours / doneAt", async () => {
  const get = async () => (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === "ovc1");
  const cur = await get();
  assert.equal(cur.hours, 4);
  // CX-042（2026-10-09）：连续多次 PUT 同一份文档，去掉 updatedAt 走不带乐观锁的旧客户端路径（带上则第二次起 409 stale）
  const { hours, usedInProjects, updatedAt, ...noHours } = cur;
  assert.equal((await admin.put("/api/admin/content/courses/ovc1", noHours)).status, 200);
  assert.equal((await get()).hours, 4, "an editor that does not send hours keeps them");
  assert.equal((await admin.put("/api/admin/content/courses/ovc1", { ...noHours, hours: 2.26 })).status, 200);
  assert.equal((await get()).hours, 2.3, "rounded to 0.1");
  assert.equal((await admin.put("/api/admin/content/courses/ovc1", { ...noHours, hours: 1000 })).status, 400);
  assert.equal((await admin.put("/api/admin/content/courses/ovc1", { ...noHours, hours: "abc" })).status, 400);
  const b = await admin.post("/api/admin/content/bulk-update", { op: "hours", ids: ["ovc1"], hours: 6 });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal((await get()).hours, 6);
  assert.equal((await admin.post("/api/admin/content/bulk-update", { op: "hours", ids: ["ovc1"], hours: 6 })).data.results[0].unchanged, true);
  assert.equal((await admin.put("/api/admin/content/courses/ovc1", { ...noHours, hours: null })).status, 200);
  assert.equal("hours" in (await get()), false, "null clears");
  const pc = await admin.post("/api/admin/content/bulk-update", { op: "programCategory", ids: ["nho"], category: "Onboarding" });
  assert.equal(pc.status, 200, JSON.stringify(pc.data));
  assert.equal((await admin.get("/api/admin/content")).data.programs.find((p) => p.id === "nho").category, "入职");
  const det = (await admin.get(`/api/admin/employees/${emp["OV-1"]}/detail`)).data.programs.find((p) => p.id === "pw-ovc1");
  assert.deepEqual([det.category, det.mode, det.enrollType], ["合规", "offline", "mandatory"]);
  assert.ok(det.doneAt, "attended → done with a date");
});
