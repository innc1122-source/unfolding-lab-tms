// 人才记录标签与评级刻度说明（批次 3 S5；IA 5.4、4.8，B-S01–B-S03、B-C18、D-14、D-27，计划 R-372、R-1115、G-09、G-10）：
//   结构迁移 56 record-option-descriptions：record_fields 增加 options_desc / options_desc_zh（只加列，不写内容）；
//   数据迁移 57 terminology-record-labels-2：只改仍为旧默认值的标签，HR 改过的不动；绩效得分仍为种子原样时停用。
// 另核对：字段配置接口带说明且按位置对齐，没带说明的保存保留原值；员工端与后台评估接口带刻度说明与 resultVisibleToEmployee；
// 员工本人的评估不下发面谈要点（D-17）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");

const dbFile = path.join(tempDir("lms-labels57-"), "a.db");
let srv, admin;
const q = (sql, ...a) => { const db = new DatabaseSync(dbFile, { readOnly: true }); try { return db.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { db.close(); } };
const w = (sql, ...a) => { const db = new DatabaseSync(dbFile); try { db.prepare(sql).run(...a); } finally { db.close(); } };

test.before(async () => { srv = await startServer({ dbPath: dbFile }); admin = await loginAs(srv.base, ADMIN); });
test.after(async () => { if (srv) await srv.stopAsync(); });

test("labels 57: a new database ends with the new record type and field labels, and the untouched performance score is switched off", () => {
  assert.deepEqual(q("SELECT version, name FROM schema_migrations WHERE version IN (56, 57) ORDER BY version"),
    [{ version: 56, name: "record-option-descriptions" }, { version: 57, name: "terminology-record-labels-2" }]);
  const t = Object.fromEntries(q("SELECT key, label, label_zh FROM record_types").map((r) => [r.key, [r.label, r.label_zh]]));
  assert.deepEqual(t.performance, ["Performance Record", "绩效记录"]);
  assert.deepEqual(t.promotion, ["Promotion", "晋升"]);
  assert.deepEqual(t.violation, ["Disciplinary Record", "违纪记录"]);
  const f = Object.fromEntries(q("SELECT typeKey || '.' || key AS k, label, label_zh, active FROM record_fields").map((r) => [r.k, [r.label, r.label_zh, r.active]]));
  assert.deepEqual(f["performance.period"], ["Review Cycle", "评估周期", 1]);
  assert.deepEqual(f["performance.rating"], ["Performance Rating", "绩效评级", 1]);
  assert.deepEqual(f["performance.score"], ["Performance Score", "绩效得分", 0], "not written by the review flow: off by default");
  assert.deepEqual(f["performance.summary"], ["Comments", "评语", 1]);
  assert.deepEqual(f["culture-program.programName"].slice(0, 2), ["Cohort", "期次名称"]);
  assert.deepEqual(f["culture-program.weeksRequired"].slice(0, 2), ["Required weeks", "必修周数"]);
  assert.deepEqual(f["culture-program.cardsGiven"].slice(0, 2), ["Cards given", "发出认可卡"]);
  const cols = q("PRAGMA table_info(record_fields)").map((c) => c.name);
  assert.ok(cols.includes("options_desc") && cols.includes("options_desc_zh"));
  // Unfolding Lab 版（2026-10-12）：迁移 61 不再写入 DigiPlus 制度的评级说明 —— 新库里没有任何字段预置说明
  assert.deepEqual(q("SELECT typeKey, key FROM record_fields WHERE options_desc IS NOT NULL OR options_desc_zh IS NOT NULL"), [], "no field ships preset option descriptions");
});

test("labels 57: on an older database only labels still at the old defaults change; a label HR edited, and a score field HR kept, stay as they are", async () => {
  await srv.stopAsync();
  // 回到迁移前：旧默认值，外加两处 HR 改过的名称
  w("UPDATE record_types SET label = 'Performance', label_zh = '绩效' WHERE key = 'performance'");
  w("UPDATE record_types SET label = 'Violation', label_zh = '违规行为（HR 自定）' WHERE key = 'violation'");
  w("UPDATE record_fields SET label = 'Period', label_zh = '期间' WHERE typeKey = 'performance' AND key = 'period'");
  w("UPDATE record_fields SET label = 'Score', label_zh = '分数', active = 1 WHERE typeKey = 'performance' AND key = 'score'");
  w("UPDATE record_fields SET label = 'Summary', label_zh = '上级评语（HR 自定）' WHERE typeKey = 'performance' AND key = 'summary'");
  w("DELETE FROM schema_migrations WHERE version = 57");
  srv = await startServer({ dbPath: dbFile });
  admin = await loginAs(srv.base, ADMIN);
  const t = Object.fromEntries(q("SELECT key, label, label_zh FROM record_types").map((r) => [r.key, [r.label, r.label_zh]]));
  assert.deepEqual(t.performance, ["Performance Record", "绩效记录"]);
  assert.deepEqual(t.violation, ["Violation", "违规行为（HR 自定）"], "HR-edited type name untouched");
  const f = Object.fromEntries(q("SELECT key, label, label_zh, active FROM record_fields WHERE typeKey = 'performance'").map((r) => [r.key, [r.label, r.label_zh, r.active]]));
  assert.deepEqual(f.period, ["Review Cycle", "评估周期", 1]);
  assert.deepEqual(f.score, ["Performance Score", "绩效得分", 0]);
  assert.deepEqual(f.summary, ["Summary", "上级评语（HR 自定）", 1], "HR-edited field name untouched");
  // 再启动一次：不重复执行
  assert.deepEqual(q("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 57"), [{ n: 1 }]);
});

test("rating descriptions: the field config carries them aligned to the options; a save without them keeps them; the review endpoints hand them out", async () => {
  const cfg = (await admin.get("/api/admin/config/records")).data;
  const rating = cfg.fields.find((x) => x.typeKey === "performance" && x.key === "rating");
  assert.deepEqual(rating.options, ["A+", "A", "B+", "B", "C", "D"]);
  assert.ok(!rating.options_desc || rating.options_desc.every((d) => !d), "Unfolding Lab: no preset rating descriptions");
  const put = await admin.put("/api/admin/config/record-fields/" + rating.id, {
    options_desc_zh: ["远超预期", "超出预期", "达到并部分超出预期", "达到预期", "部分达到预期", "未达预期", "多出来的一项"],
    options_desc: ["Far exceeds", "Exceeds"],
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.field.options_desc_zh, ["远超预期", "超出预期", "达到并部分超出预期", "达到预期", "部分达到预期", "未达预期"], "trimmed to the option count");
  assert.deepEqual(put.data.field.options_desc, ["Far exceeds", "Exceeds", "", "", "", ""], "padded to the option count");
  const put2 = await admin.put("/api/admin/config/record-fields/" + rating.id, { label_zh: "绩效评级" });
  assert.deepEqual(put2.data.field.options_desc_zh.slice(0, 2), ["远超预期", "超出预期"], "a save without descriptions keeps them");
  const mine = (await admin.get("/api/me/reviews")).data;
  assert.deepEqual(mine.ratingOptions_desc_zh.slice(0, 2), ["远超预期", "超出预期"]);
  assert.equal(mine.resultVisibleToEmployee, true, "the performance record type is employee-visible by default");
  // 关掉「绩效记录」的员工可见 → 接口随之为 false
  const perf = cfg.types.find((x) => x.key === "performance");
  await admin.post("/api/admin/config/record-types", { ...perf, employeeVisible: false });
  assert.equal((await admin.get("/api/me/reviews")).data.resultVisibleToEmployee, false);
  await admin.post("/api/admin/config/record-types", { ...perf, employeeVisible: true });
});

test("review data: an employee's own review never carries the manager's conversation notes; HR's cycle detail does", async () => {
  const c = await admin.post("/api/admin/employees", { name: "Notes Mgr", employeeId: "RL-MGR1", jobLevel: "M1" });
  const e = await admin.post("/api/admin/employees", { name: "Notes Emp", employeeId: "RL-EMP1", jobLevel: "P2" });
  const roster = (await admin.get("/api/admin/roster")).data;
  const mgr = roster.find((x) => x.employeeId === "RL-MGR1"), emp = roster.find((x) => x.employeeId === "RL-EMP1");
  await admin.put("/api/admin/employees/" + emp.id, { managerId: mgr.id });
  const cyc = await admin.post("/api/admin/review-cycles", { name: "Notes cycle", userIds: [emp.id] });
  const ms = await loginAs(srv.base, { employeeId: "RL-MGR1", password: c.data.password });
  await ms.post("/api/auth/change-password", { currentPassword: c.data.password, newPassword: "Mgr-pass-2026" });
  const es = await loginAs(srv.base, { employeeId: "RL-EMP1", password: e.data.password });
  await es.post("/api/auth/change-password", { currentPassword: e.data.password, newPassword: "Emp-pass-2026" });
  const item = (await ms.get("/api/me/reviews")).data.teamRows[0];
  assert.equal((await ms.post(`/api/me/reviews/${item.id}/manager`, { rating: "B", oneOnOneDone: true, oneOnOneNotes: "面谈要点：下季度聚焦客户回访", text: "达到预期" })).status, 200);
  // 面谈要点在上级的单人评估页（GET team/:id）读回；第二批波次 3 删掉了 /api/me/reviews 的完整 team[]
  assert.equal((await ms.get(`/api/me/reviews/team/${item.id}`)).data.item.oneOnOneNotes, "面谈要点：下季度聚焦客户回访", "the manager reads it back");
  const own = (await es.get("/api/me/reviews")).data.mine[0];
  assert.ok(own && !("oneOnOneNotes" in own), "not in the employee's own payload");
  const detail = (await admin.get("/api/admin/review-cycles/" + cyc.data.cycle.id)).data;
  assert.equal(detail.items[0].oneOnOneNotes, "面谈要点：下季度聚焦客户回访", "HR detail carries it");
  // 错误带 code（IA B-S07、B-S08）
  const closed = await admin.post(`/api/admin/review-cycles/${cyc.data.cycle.id}/close`, {});
  assert.equal(closed.status, 200);
  const again = await admin.post(`/api/admin/review-cycles/${cyc.data.cycle.id}/close`, {});
  assert.equal(again.data.code, "cycle_closed");
  const late = await ms.post(`/api/me/reviews/${item.id}/manager`, { rating: "A", oneOnOneDone: true });
  assert.equal(late.data.code, "cycle_closed");
  // 关闭时只写上级评语（D-16）
  const prof = (await admin.get(`/api/admin/employees/${emp.id}/profile`)).data;
  const rec = prof.events.find((x) => x.source === "record" && x.type === "performance" && x.title === "Notes cycle");
  assert.equal(rec.detail.summary, "达到预期");
});
