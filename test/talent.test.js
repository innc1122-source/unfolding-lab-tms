// Talent layer (People module) contracts: profile assembly, record CRUD with
// config-driven validation, lifecycle side effects (入转调离 + 晋级), field
// configuration, departments, bulk import dedupe, and the records CSV export.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient, tempDir } = require("./helpers.js");

let srv, admin, emp;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(() => srv.stop());

test("talent endpoints are admin-only", async () => {
  for (const p of ["/api/admin/employees/u-1001/profile", "/api/admin/config/records", "/api/admin/departments"]) {
    assert.equal((await emp.get(p)).status, 403, p + " must be admin-only");
  }
  assert.equal((await makeClient(srv.base).get("/api/admin/employees/u-1001/profile")).status, 401);
});

test("profile returns seeded demo trajectory, stats, config and suggestions", async () => {
  const r = await admin.get("/api/admin/employees/u-1001/profile");
  assert.equal(r.status, 200);
  assert.equal(r.data.user.jobLevel, "MB2");
  assert.equal(r.data.user.empStatus, "regular");
  assert.ok(r.data.user.talentTags.length >= 2, "talent tags seeded");
  assert.equal(r.data.stats.awards, 1);
  assert.equal(r.data.stats.promotions, 1);
  // Timeline: 7 demo records + hired anchor, newest first.
  const recordEvents = r.data.events.filter((e) => e.source === "record");
  assert.equal(recordEvents.length, 7);
  assert.ok(r.data.events.some((e) => e.type === "hired"), "hire anchor present");
  const dates = r.data.events.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), "events sorted newest first");
  // Config ships all 10 built-in types (the 9 original ones + culture-program, seeded by data migration 51 for
  // core's culture.program.completed subscription); suggestions include the seeded department.
  assert.equal(r.data.config.types.filter((t) => t.builtin).length, 10);
  const culture = r.data.config.types.find((t) => t.key === "culture-program");
  // employee-visible since data migration 53; moduleOff: culture is off in this test server (defaultOn:false), so the
  // console leaves it out of the new-record type picker while existing records keep rendering (2026-09-28).
  assert.deepEqual(culture && [culture.label, culture.label_zh, culture.builtin, culture.active, culture.employeeVisible, culture.moduleOff], ["Behavior Practice", "行为实践", true, true, true, true]);
  assert.ok(r.data.config.types.filter((t) => t.key !== "culture-program").every((t) => t.moduleOff === false), "core types are never moduleOff");
  assert.ok(r.data.suggestions.departments.includes("Customer Care"));
});

test("record create is validated by the field config", async () => {
  const bad = await admin.post("/api/admin/employees/u-1001/records", { type: "performance", date: "2026-02-31", fields: {} });
  assert.equal(bad.status, 400, "impossible calendar date rejected");
  const miss = await admin.post("/api/admin/employees/u-1001/records", { type: "promotion", date: "2026-08-01", fields: { result: "Passed" } });
  assert.equal(miss.status, 400, "missing required field rejected");
  const opt = await admin.post("/api/admin/employees/u-1001/records", { type: "violation", date: "2026-08-01", fields: { severity: "Huge" } });
  assert.equal(opt.status, 400, "value outside configured select options rejected");
});

test("lifecycle side effects sync employee master data (and only when passed)", async () => {
  const c = await admin.post("/api/admin/employees", { name: "Life Cycle", employeeId: "DP-LC01", department: "QA", jobLevel: "S-2" });
  assert.equal(c.status, 200);
  const uid = (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === "DP-LC01").id;
  assert.equal((await admin.get("/api/admin/employees")).data.find((x) => x.id === uid).empStatus, "probation", "new hire defaults to probation");

  // Failed promotion with sync ticked must NOT change the level.
  await admin.post(`/api/admin/employees/${uid}/records`, { type: "promotion", date: "2026-01-10", fields: { fromLevel: "S-2", toLevel: "S-1", result: "Failed", syncLevel: true } });
  let u = (await admin.get(`/api/admin/employees/${uid}/profile`)).data.user;
  assert.equal(u.jobLevel, "S-2");
  // Passed promotion with sync ticked updates it.
  const p2 = await admin.post(`/api/admin/employees/${uid}/records`, { type: "promotion", date: "2026-02-10", fields: { fromLevel: "S-2", toLevel: "S-1", result: "Passed", syncLevel: true } });
  assert.equal(p2.data.record.detail.synced, true);
  u = (await admin.get(`/api/admin/employees/${uid}/profile`)).data.user;
  assert.equal(u.jobLevel, "S-1");
  // Regularization syncs employment status.
  await admin.post(`/api/admin/employees/${uid}/records`, { type: "regularization", date: "2026-03-01", fields: { result: "On time", syncStatus: true } });
  u = (await admin.get(`/api/admin/employees/${uid}/profile`)).data.user;
  assert.equal(u.empStatus, "regular");
  // Transfer syncs department/position and auto-registers the department.
  await admin.post(`/api/admin/employees/${uid}/records`, { type: "transfer", date: "2026-04-01", fields: { fromDept: "QA", toDept: "Risk Management", toPosition: "Risk Analyst", syncDept: true } });
  u = (await admin.get(`/api/admin/employees/${uid}/profile`)).data.user;
  assert.equal(u.department, "Risk Management");
  assert.equal(u.position, "Risk Analyst");
  assert.ok((await admin.get("/api/admin/departments")).data.some((d) => d.name === "Risk Management"), "transfer auto-registered the department");
  // Exit deactivates the account and marks the status.
  await admin.post(`/api/admin/employees/${uid}/records`, { type: "exit", date: "2026-05-01", fields: { exitType: "Voluntary", syncStatus: true } });
  const row = (await admin.get("/api/admin/employees")).data.find((x) => x.id === uid);
  assert.equal(row.empStatus, "exited");
  assert.equal(row.active, false);
  // Profile stays readable for exited employees (the archive is the point).
  assert.equal((await admin.get(`/api/admin/employees/${uid}/profile`)).status, 200);
});

test("bulk import resolves Chinese type names and dedupes on re-import", async () => {
  const rows = { rows: [
    { employeeId: "DP-1001", type: "培训", date: "2023-11-20", title: "客服卓越训练营", fields: { programName: "客服卓越训练营", result: "优秀", score: "95", rank: "1/30" } },
    { employeeId: "DP-1001", type: "荣誉", date: "2023-11-20", title: "最佳进步", fields: { awardName: "最佳进步" } },
    { employeeId: "DP-9999", type: "培训", date: "2023-01-01", title: "x", fields: {} },
    { employeeId: "DP-1001", type: "培训", date: "2023-13-99", title: "bad", fields: {} },
  ]};
  const r1 = await admin.post("/api/admin/records/bulk", rows);
  const by1 = r1.data.results.map((x) => x.status);
  assert.deepEqual(by1, ["created", "created", "skipped", "skipped"]);
  assert.match(r1.data.results[2].reason, /no such employee/);
  assert.match(r1.data.results[3].reason, /invalid date/);
  const r2 = await admin.post("/api/admin/records/bulk", rows);
  assert.ok(r2.data.results.slice(0, 2).every((x) => x.status === "skipped" && /duplicate/.test(x.reason)), "re-import is a no-op");
  // Clean up the two imported records so other assertions stay stable.
  const prof = await admin.get("/api/admin/employees/u-1001/profile");
  for (const e of prof.data.events.filter((x) => x.source === "record" && !String(x.id).startsWith("tr-demo")))
    assert.equal((await admin.del(`/api/admin/records/${e.id}`)).status, 200);
});

test("field config drives the record contract (add field, unknown keys dropped)", async () => {
  const f = await admin.post("/api/admin/config/record-fields", { typeKey: "training", label: "带教人 Mentor", input: "text", filterable: true });
  assert.equal(f.status, 200);
  const key = f.data.field.key;
  const rec = await admin.post("/api/admin/employees/u-1001/records", {
    type: "training", date: "2026-08-10", title: "Leadership 101",
    fields: { programName: "Leadership 101", [key]: "Coach Ana", hax0r: "dropped" },
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.data.record.detail[key], "Coach Ana");
  assert.equal(rec.data.record.detail.hax0r, undefined, "unknown keys never enter the JSON");
  // Custom employee fields live under the reserved typeKey "user" → users.extras.
  const uf = await admin.post("/api/admin/config/record-fields", { typeKey: "user", label: "紧急联系人 Emergency contact", input: "text" });
  assert.equal(uf.status, 200);
  const put = await admin.put("/api/admin/employees/u-1001", { extras: { [uf.data.field.key]: "Maria 0917-555-1234" } });
  assert.equal(put.status, 200);
  assert.equal((await admin.get("/api/admin/employees/u-1001/profile")).data.user.extras[uf.data.field.key], "Maria 0917-555-1234");
  // Cleanup: delete the test record + fields.
  const prof = await admin.get("/api/admin/employees/u-1001/profile");
  for (const e of prof.data.events.filter((x) => x.source === "record" && !String(x.id).startsWith("tr-demo")))
    await admin.del(`/api/admin/records/${e.id}`);
  await admin.del(`/api/admin/config/record-fields/${f.data.field.id}`);
  await admin.del(`/api/admin/config/record-fields/${uf.data.field.id}`);
});

test("custom record types can be created and used; built-ins refuse deletion", async () => {
  const t = await admin.post("/api/admin/config/record-types", { label: "项目经历 Project", icon: "🧩", color: "#0e7c66" });
  assert.equal(t.status, 200);
  const rec = await admin.post("/api/admin/employees/u-1001/records", { type: t.data.type.key, date: "2026-05-01", title: "新支付通道上线", fields: {} });
  assert.equal(rec.status, 200);
  assert.equal((await admin.del("/api/admin/config/record-types/performance")).status, 400, "built-in types can't be deleted");
  await admin.del(`/api/admin/records/${rec.data.record.id}`);
  assert.equal((await admin.del(`/api/admin/config/record-types/${t.data.type.key}`)).status, 200, "custom types can");
});

test("departments: create validates, rename cascades to users, delete guarded by headcount", async () => {
  const mk = await admin.post("/api/admin/departments", { name: "Casino Ops" });
  assert.equal(mk.status, 200);
  assert.equal((await admin.post("/api/admin/departments", { name: "casino ops" })).status, 400, "names unique case-insensitively");
  await admin.post("/api/admin/employees", { name: "Dept Tester", employeeId: "DP-DEPT1", department: "Casino Ops" });
  const dept = (await admin.get("/api/admin/departments")).data.find((d) => d.name === "Casino Ops");
  assert.equal(dept.headcount, 1);
  assert.equal((await admin.del(`/api/admin/departments/${dept.id}`)).status, 400, "occupied department can't be deleted");
  const rn = await admin.put(`/api/admin/departments/${dept.id}`, { name: "Casino Operations" });
  assert.equal(rn.status, 200);
  const u = (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === "DP-DEPT1");
  assert.equal(u.department, "Casino Operations", "rename cascades to users");
});

test("records.csv export follows the current field config", async () => {
  const res = await admin.raw("GET", "/api/admin/export/records.csv");
  assert.equal(res.status, 200);
  const text = (await res.text()).replace(/^﻿/, "");
  const header = text.split("\r\n")[0];
  assert.ok(header.startsWith("Employee ID,Name,Type 类型,Date 日期,Title 标题"), "fixed columns first");
  assert.ok(header.includes("奖项 Award") && header.includes("新职级 To"), "config-driven columns present");
  assert.ok(text.includes("优秀学员 Top learner"), "config-driven value column exported, both names");
});

test("talent review buckets by rating position in the configured options", async () => {
  const r = await admin.get("/api/admin/talent-review");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.ratingOptions, ["A+", "A", "B+", "B", "C", "D"]);
  const juan = r.data.rows.find((x) => x.employeeId === "DP-1001");
  assert.equal(juan.rating, "A");
  assert.equal(juan.perfBucket, 2, "A is in the top third of 6 options → high");
  assert.equal(juan.potBucket, 2, "potential High → top row");
  // Admins never appear on the grid.
  assert.ok(!r.data.rows.some((x) => x.employeeId === "ADMIN"));
});

test("talent search finds people by record field values (with facets)", async () => {
  const r = await admin.post("/api/admin/talent-search", { type: "荣誉", fields: { awardName: "优秀学员" } });
  assert.equal(r.status, 200);
  // 用中文显示名提交筛选：服务端把它归一化成 canonical 再比对，否则中文界面一筛就空。
  assert.ok(r.data.results.some((x) => x.employeeId === "DP-1001"), "a Chinese display name still matches the canonical stored value");
  assert.ok(r.data.facets.awardName.includes("Top learner"), "facets list canonical values");
  const none = await admin.post("/api/admin/talent-search", { type: "award", fields: { awardName: "不存在的奖" } });
  assert.equal(none.data.total, 0);
  assert.equal((await admin.post("/api/admin/talent-search", { type: "nope", fields: {} })).status, 400);
});

test("promotion pipeline: the quantified rule set drives eligibility", async () => {
  assert.equal((await admin.get("/api/admin/promotion-config")).data.config.minRating, "B+");
  const r1 = await admin.get("/api/admin/promotion-candidates");
  const juan = r1.data.rows.find((x) => x.employeeId === "DP-1001");
  assert.equal(juan.jobLevel, "MB2");
  assert.equal(juan.nextLevel, "MB1", "MB2(L10) → MB1(L11) on the M track");
  assert.equal(juan.checks.rating.ok, false, "F62: only one rating on file → the 2-period rule needs 2 periods");
  assert.equal(juan.checks.tenure.ok, true, "F62: the tenure gate is off by default (no condition → ok)");
  assert.equal(juan.checks.levelTenure.ok, true, "promoted MB3 → MB2 on 2025-07-01 → over 12 months in level");
  assert.equal(juan.checks.trainings.ok, true, "F62: the training gate is off by default (no condition → ok)");
  assert.equal(juan.eligible, false);
  // Look at the latest rating only → eligible (A ≥ B+; the demo rating is older than 12 months, so the window rule also needs relaxing).
  await admin.put("/api/admin/promotion-config", { minRatingPeriods: 1, windowMonths: 0 });
  assert.equal((await admin.get("/api/admin/promotion-candidates")).data.rows.find((x) => x.employeeId === "DP-1001").eligible, true);
  // Turn the training gate on → NHO assigned but exam not passed → blocked; off again → eligible; tighten rating to A+ → blocked again.
  await admin.put("/api/admin/promotion-config", { requireTrainings: true });
  const gated = (await admin.get("/api/admin/promotion-candidates")).data.rows.find((x) => x.employeeId === "DP-1001");
  assert.equal(gated.checks.trainings.ok, false, "NHO assigned but exam not passed");
  assert.equal(gated.eligible, false);
  await admin.put("/api/admin/promotion-config", { requireTrainings: false });
  assert.equal((await admin.get("/api/admin/promotion-candidates")).data.rows.find((x) => x.employeeId === "DP-1001").eligible, true);
  await admin.put("/api/admin/promotion-config", { minRating: "A+" });
  assert.equal((await admin.get("/api/admin/promotion-candidates")).data.rows.find((x) => x.employeeId === "DP-1001").checks.rating.ok, false);
  assert.equal((await admin.put("/api/admin/promotion-config", { minRating: "ZZZ" })).status, 400, "rating threshold must be a configured option");
  await admin.put("/api/admin/promotion-config", { minRating: "B+", requireTrainings: false, minRatingPeriods: 2, windowMonths: 12 });
});

test("succession: add / update readiness / enriched list / remove", async () => {
  const add = await admin.post("/api/admin/succession", { positionName: "Customer Care Team Lead", userId: "u-1001", readiness: "oneYear", note: "重点培养" });
  assert.equal(add.status, 200);
  assert.equal((await admin.post("/api/admin/succession", { positionName: "X", userId: "u-nope", readiness: "ready" })).status, 400);
  assert.equal((await admin.post("/api/admin/succession", { positionName: "X", userId: "u-1001", readiness: "someday" })).status, 400);
  const id = add.data.entry.id;
  assert.equal((await admin.put(`/api/admin/succession/${id}`, { readiness: "ready" })).status, 200);
  const list = await admin.get("/api/admin/succession");
  const row = list.data.find((x) => x.id === id);
  assert.equal(row.readiness, "ready");
  assert.equal(row.name, "Juan Dela Cruz");
  assert.equal((await admin.del(`/api/admin/succession/${id}`)).status, 200);
});

test("my growth: employees see only employee-visible types, never the admin config", async () => {
  const g1 = await emp.get("/api/me/growth");
  assert.equal(g1.status, 200);
  assert.equal(g1.data.me.jobLevel, "MB2");
  assert.equal(g1.data.config, undefined, "admin config never reaches employees");
  assert.equal(g1.data.me.talentTags, undefined, "internal tags stay HR-only");
  // typeLabel carries the English name and typeLabel_zh the Chinese one — they
  // used to be a single bilingual string, and an employee reading Chinese has to
  // get Chinese, so assert on both halves instead of substring-matching one.
  const recs1 = g1.data.events.filter((e) => e.kind === "record");
  assert.ok(recs1.some((e) => e.typeLabel === "Award" && e.typeLabel_zh === "荣誉"),
    "award visible by default, in both languages");
  assert.ok(!recs1.some((e) => /违纪记录|Disciplinary Record/.test(`${e.typeLabel} ${e.typeLabel_zh}`)),
    "violation hidden by default");
  assert.ok(g1.data.events.some((e) => e.kind === "hired"), "hire anchor present");
  // HR flips violation to employee-visible → it appears; flip back → gone.
  const vio = (await admin.get("/api/admin/config/records")).data.types.find((t) => t.key === "violation");
  await admin.post("/api/admin/config/record-types", { ...vio, employeeVisible: true });
  const g2 = await emp.get("/api/me/growth");
  assert.ok(g2.data.events.some((e) => e.kind === "record" && e.typeLabel_zh === "违纪记录" && e.typeLabel === "Disciplinary Record"), "toggle exposes the type (label per migration 57)");
  await admin.post("/api/admin/config/record-types", { ...vio, employeeVisible: false });
  const g3 = await emp.get("/api/me/growth");
  assert.ok(!g3.data.events.some((e) => e.kind === "record" && e.typeLabel_zh === "违纪记录"));
});

// AI 治理方案 5.4：ai 模块默认关闭，演示内容只在 ai.demo:true 时出现（不再「没配 key 就演示」）。
test("ai portrait: module off by default → 404; with ai.demo the demo draft lists real record counts and no invented facts", async () => {
  assert.equal((await admin.post("/api/admin/employees/u-1001/ai-portrait", {})).status, 404, "ai module is off by default");
  const dir = tempDir("ai-demo-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ modules: { ai: true }, ai: { demo: true, features: { portrait: true } } }));
  const s2 = await startServer({ env: { LMS_CONFIG_PATH: path.join(dir, "config.json"), LMS_DISABLE_AI: "" } });
  try {
    const a2 = await loginAs(s2.base, ADMIN);
    const r = await a2.post("/api/admin/employees/u-1001/ai-portrait", {});
    assert.equal(r.status, 200);
    assert.equal(r.data.demo, true);
    assert.equal(r.data.draft.status, "draft");
    assert.match(r.data.draft.content.summary.text_zh, /演示模式：未接入 AI 服务，不做分析与判断/);
    assert.ok(r.data.portrait.summary && r.data.portrait.readiness);
    assert.doesNotMatch(JSON.stringify(r.data), /优秀学员|轻微违规/, "no invented example facts (P-8.5)");
  } finally {
    await s2.stopAsync();
  }
});

// options 拆成「options = 存储值 + 英文名」「options_zh = 中文名」之后，最容易回归的是
// 「中文界面提交的值存进去变成什么」。下面两条把契约钉住。
test("an option submitted in Chinese is stored as its canonical value", async () => {
  const c = await admin.post("/api/admin/employees", { name: "Canon Test", employeeId: "DP-CANON1", department: "QA", jobLevel: "S-2" });
  assert.equal(c.status, 200);
  const uid = c.data.id || (await admin.get("/api/admin/employees")).data.find((x) => x.employeeId === "DP-CANON1").id;
  // select: 通过 -> Passed
  const promo = await admin.post(`/api/admin/employees/${uid}/records`, {
    type: "promotion", date: "2026-06-01", fields: { fromLevel: "S-2", toLevel: "S-1", result: "通过", method: "答辩" },
  });
  assert.equal(promo.status, 200);
  assert.equal(promo.data.record.detail.result, "Passed", "Chinese display name normalized to the canonical value");
  assert.equal(promo.data.record.detail.method, "Defense");
  // suggest: 结业 -> Completed, but free text still passes through untouched
  const tr = await admin.post(`/api/admin/employees/${uid}/records`, {
    type: "training", date: "2026-06-02", fields: { programName: "Canon camp", result: "结业" },
  });
  assert.equal(tr.status, 200);
  assert.equal(tr.data.record.detail.result, "Completed");
  const free = await admin.post(`/api/admin/employees/${uid}/records`, {
    type: "training", date: "2026-06-03", fields: { programName: "Canon camp", result: "自定义结果" },
  });
  assert.equal(free.status, 200, "a suggest field still accepts free text");
  assert.equal(free.data.record.detail.result, "自定义结果");
  // A select value in neither language is still rejected.
  const bad = await admin.post(`/api/admin/employees/${uid}/records`, {
    type: "promotion", date: "2026-06-04", fields: { fromLevel: "S-2", toLevel: "S-1", result: "maybe" },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "field_option");
});

test("every option list ships an equal-length Chinese twin", async () => {
  const cfg = await admin.get("/api/admin/config/records");
  assert.equal(cfg.status, 200);
  const withOpts = cfg.data.fields.filter((f) => (f.options || []).length);
  assert.ok(withOpts.length >= 8, "the built-in option fields are present");
  for (const f of withOpts) {
    // The client pairs by index; a shorter twin would shift every later label.
    assert.equal((f.options_zh || []).length, f.options.length, `${f.typeKey}.${f.key} options_zh length`);
    assert.ok(!f.options.some((o) => /[\u4e00-\u9fff]/.test(o) && /[A-Za-z]/.test(o)),
      `${f.typeKey}.${f.key} canonical options are not fused bilingual strings`);
  }
  const sev = withOpts.find((f) => f.typeKey === "violation" && f.key === "severity");
  assert.deepEqual(sev.options, ["Minor", "Major"]);
  assert.deepEqual(sev.options_zh, ["轻微", "重大"]);
});
