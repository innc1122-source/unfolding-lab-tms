// F62（负责人 2026-10-09 定）：晋升评审候选按公司晋升门槛重设内置条件。
//   · 新默认：① 有下一职级；② 过去 12 个月绩效无 C / D；③ 近 2 期任一期 ≥ B+；④ 现职级任职满 12 个月；⑤ 近 12 个月无违纪（所有严重度）；
//     去掉「必修课程全部完成」与司龄门槛；
//   · 边界：恰好 12 个月；近 2 期是 B 和 B+；12 个月内有一次 C；没有晋升记录用入职日；只有 1 期评级（不通过）；没有评级（不通过）；
//   · 工作台「晋升评审候选」人数与候选页同口径；
//   · 迁移 92：新库直接是新默认（不写审计）；旧库里从未改过的内置筛选换成新默认（审计 applied:true）；被 HR 改过的保留并写
//     meta promotionDefaultsPending（接口 defaultsPending = true，审计 applied:false），再启动不重复；「恢复默认」清掉提示。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, ROOT, startServer, loginAs, tempDir } = require("./helpers.js");
const M = require(path.join(ROOT, "modules", "talent", "filter-model.js"));

const NOW = "2026-10-09T04:00:00Z";   // 马尼拉 2026-10-09 12:00
const RATING_OPTS = ["A+", "A", "B+", "B", "C", "D"];
let srv, admin, dbPath;
const emp = {};
const db = (fn, readOnly = true) => { const d = new DatabaseSync(dbPath, { readOnly }); try { return fn(d); } finally { d.close(); } };
const boot = () => startServer({ dbPath, env: { LMS_FAKE_NOW: NOW, LMS_NO_DEMO_USERS: "1" } });
const builtinRow = () => db((d) => { const r = d.prepare("SELECT * FROM talent_filters WHERE builtinKey = 'promotion'").get(); return { ...r, definition: JSON.parse(r.definition), columns: JSON.parse(r.columns) }; });
const audits = () => db((d) => d.prepare("SELECT * FROM audit_logs WHERE action = 'promotion.defaults-update' ORDER BY id").all().map((r) => ({ ...r, after: JSON.parse(r.afterJson) })));
const meta = (k) => db((d) => { const r = d.prepare("SELECT value FROM meta WHERE key = ?").get(k); return r ? r.value : null; });

async function makeEmployee(empId, patch) {
  const created = await admin.post("/api/admin/employees", { name: "Name " + empId, employeeId: empId });
  assert.equal(created.status, 200, "create " + empId);
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  emp[empId] = u.id;
  const p = await admin.put("/api/admin/employees/" + u.id, { department: "F62 Dept", jobLevel: "PB2", position: "Analyst", empStatus: "regular", hireDate: "2019-01-01", ...(patch || {}) });
  assert.equal(p.status, 200, "patch " + empId + " " + JSON.stringify(p.data));
}
const record = async (empId, type, date, fields) => { const r = await admin.post(`/api/admin/employees/${emp[empId]}/records`, { type, date, fields }); assert.equal(r.status, 200, `${type} ${empId} ${JSON.stringify(r.data)}`); };
const rating = (empId, date, value) => record(empId, "performance", date, { rating: value, period: date.slice(0, 7) });
const promo = (empId, date) => record(empId, "promotion", date, { fromLevel: "PB1", toLevel: "PB2", result: "Passed", method: "Direct" });
const candRow = async (empId) => (await admin.get("/api/admin/promotion-candidates")).data.rows.find((r) => r.employeeId === empId);

before(async () => {
  dbPath = path.join(tempDir("lms-f62-"), "f62.db");
  srv = await boot();
  admin = await loginAs(srv.base, ADMIN);
  assert.equal((await admin.post("/api/admin/departments", { name: "F62 Dept" })).status, 200);
  // 恰好 12 个月（晋升 2025-10-09，今天 2026-10-09）；近 2 期 B+ / B
  await makeEmployee("F62-EXACT"); await promo("F62-EXACT", "2025-10-09"); await rating("F62-EXACT", "2026-06-30", "B+"); await rating("F62-EXACT", "2026-03-31", "B");
  // 差一天：11 个月
  await makeEmployee("F62-SHORT"); await promo("F62-SHORT", "2025-10-10"); await rating("F62-SHORT", "2026-06-30", "B+"); await rating("F62-SHORT", "2026-03-31", "B");
  // 近 2 期 B / B → 条件 ③ 不满足
  await makeEmployee("F62-BB"); await rating("F62-BB", "2026-06-30", "B"); await rating("F62-BB", "2026-03-31", "B");
  // 12 个月内有一次 C（2025-12-31）→ 条件 ② 不满足；条件 ③ 仍满足
  await makeEmployee("F62-C"); await rating("F62-C", "2026-06-30", "B+"); await rating("F62-C", "2025-12-31", "C");
  // C 在 12 个月之外（2025-09-30）→ 不计
  await makeEmployee("F62-COLD"); await rating("F62-COLD", "2026-06-30", "B+"); await rating("F62-COLD", "2025-09-30", "C");
  // 没有晋升记录：从入职日算（2025-10-09 = 恰好 12 个月；2025-10-10 = 11 个月）
  await makeEmployee("F62-NOPROMO", { hireDate: "2025-10-09" }); await rating("F62-NOPROMO", "2026-06-30", "B+"); await rating("F62-NOPROMO", "2026-03-31", "B");
  await makeEmployee("F62-NOPROMO2", { hireDate: "2025-10-10" }); await rating("F62-NOPROMO2", "2026-06-30", "B+"); await rating("F62-NOPROMO2", "2026-03-31", "B");
  // 违纪：12 个月内（2025-11-01）挡；12 个月外（2025-09-01）不挡
  await makeEmployee("F62-VIO"); await rating("F62-VIO", "2026-06-30", "A"); await rating("F62-VIO", "2026-03-31", "A"); await record("F62-VIO", "violation", "2025-11-01", { severity: "Minor" });
  await makeEmployee("F62-VIOOLD"); await rating("F62-VIOOLD", "2026-06-30", "A"); await rating("F62-VIOOLD", "2026-03-31", "A"); await record("F62-VIOOLD", "violation", "2025-09-01", { severity: "Minor" });
  // 只有 1 期评级（B+）→ 条件 ③ 要求 2 期可比，不通过；没有评级 → ②③ 都不通过（负责人 10/9 定：刚入职的人不能靠一期入选）
  await makeEmployee("F62-ONE"); await rating("F62-ONE", "2026-06-30", "B+");
  await makeEmployee("F62-NONE");
});
after(() => srv && srv.stop());

test("fresh database: the built-in filter is the F62 default; promotion-config exposes the new keys; no defaults-update audit", async () => {
  const row = builtinRow();
  assert.equal(M.isPromotionDefault(row.definition, RATING_OPTS), true);
  assert.deepEqual(row.definition.items.map((l) => l.tag), ["nextLevel", "ratingWindow", "rating", "levelTenure", "violations"]);
  assert.deepEqual(row.columns, M.PROMO_COLUMNS);
  assert.ok(db((d) => d.prepare("SELECT 1 FROM schema_migrations WHERE version = 92 AND name = 'promotion-threshold-f62'").get()), "migration 92 recorded");
  assert.ok(db((d) => d.prepare("SELECT 1 FROM schema_migrations WHERE version = 93 AND name = 'promotion-threshold-f62-missing-fail'").get()), "migration 93 recorded");
  assert.equal(audits().length, 0);
  const cfg = (await admin.get("/api/admin/promotion-config")).data.config;
  assert.deepEqual(cfg, { ...M.PROMO_DEFAULTS });
  const cand = await admin.get("/api/admin/promotion-candidates");
  assert.equal(cand.data.defaultsPending, false);
  assert.equal(cand.data.gatesSkipped.ratingWindow, false);
  const f = (await admin.get("/api/admin/talent-filters/" + cand.data.filterId)).data.filter;
  assert.equal(f.defaultsPending, false);
  assert.match(f.summary_zh, /近 12 个月内绩效各期均不低于 B/);
  assert.match(f.summary_zh, /近 2 期绩效任一期不低于 B\+/);
  assert.match(f.summary_zh, /现职级任职不少于 12 个月/);
  assert.match(f.summary, /Time in current level at least 12 months/);
  assert.equal(/必修|司龄/.test(f.summary_zh), false, "training and tenure conditions are gone");
});

test("boundaries: exactly 12 months in level; B and B+; one C inside 12 months; no promotion record → hire date; one rating; no rating; violations", async () => {
  const ex = await candRow("F62-EXACT");
  assert.equal(ex.eligible, true, JSON.stringify(ex.checks));
  assert.deepEqual([ex.checks.levelTenure.ok, ex.checks.levelTenure.months, ex.checks.ratingWindow.ok, ex.checks.rating.ok, ex.checks.violations.ok], [true, 12, true, true, true]);
  assert.equal(ex.checks.tenure.ok, true, "tenure gate is off by default (no leaf → ok)");
  const sh = await candRow("F62-SHORT");
  assert.deepEqual([sh.eligible, sh.checks.levelTenure.ok, sh.checks.levelTenure.months], [false, false, 11]);
  const bb = await candRow("F62-BB");
  assert.deepEqual([bb.eligible, bb.checks.rating.ok, bb.checks.ratingWindow.ok], [false, false, true], "B and B → no period ≥ B+, but nothing below B");
  const c = await candRow("F62-C");
  assert.deepEqual([c.eligible, c.checks.ratingWindow.ok, c.checks.rating.ok], [false, false, true], "a C inside 12 months fails the window; the latest B+ still satisfies the 2-period rule");
  assert.equal((await candRow("F62-COLD")).eligible, true, "a C older than 12 months does not count");
  const np = await candRow("F62-NOPROMO");
  assert.deepEqual([np.eligible, np.checks.levelTenure.months], [true, 12], "no promotion record → months since hire date");
  const np2 = await candRow("F62-NOPROMO2");
  assert.deepEqual([np2.eligible, np2.checks.levelTenure.months], [false, 11]);
  assert.deepEqual([(await candRow("F62-VIO")).eligible, (await candRow("F62-VIO")).checks.violations.ok], [false, false]);
  assert.equal((await candRow("F62-VIOOLD")).eligible, true);
  const one = await candRow("F62-ONE");
  assert.deepEqual([one.eligible, one.checks.rating.ok, one.checks.ratingWindow.ok], [false, false, true], "one rating only: the 2-period rule needs 2 periods on file");
  const none = await candRow("F62-NONE");
  assert.deepEqual([none.eligible, none.checks.rating.ok, none.checks.ratingWindow.ok], [false, false, false], "no rating at all: both rating rules fail");
  // 工作台「晋升评审候选」与首页 promotionPool 同口径
  const eligible = (await admin.get("/api/admin/promotion-candidates")).data.rows.filter((r) => r.eligible).length;
  assert.equal(eligible, 4, "EXACT, COLD, NOPROMO, VIOOLD");
  assert.equal((await admin.get("/api/admin/workbench/structure")).data.pipeline.candidates, eligible);
  assert.equal((await admin.get("/api/admin/workbench/people?metric=pipeline.candidates")).data.total, eligible);
  assert.equal((await admin.get("/api/admin/dashboard")).data.promotionPool, eligible);
});

test("promotion-config PUT accepts the new keys and only overrides what it is given", async () => {
  const f0 = (await admin.get("/api/admin/promotion-candidates")).data.filterId;
  assert.equal((await admin.put("/api/admin/promotion-config", { windowMinRating: "Z" })).status, 400);
  assert.equal((await admin.put("/api/admin/promotion-config", { minLevelTenureMonths: 6, windowMonths: 24, minRatingPeriods: 3 })).status, 200);
  const cfg = (await admin.get("/api/admin/promotion-config")).data.config;
  assert.deepEqual([cfg.minLevelTenureMonths, cfg.windowMonths, cfg.minRatingPeriods, cfg.minRating, cfg.windowMinRating], [6, 24, 3, "B+", "B"]);
  assert.equal((await candRow("F62-SHORT")).checks.rating.ok, false, "3 periods required, only 2 on file");
  assert.equal((await admin.put("/api/admin/promotion-config", { minRatingPeriods: 2 })).status, 200);
  assert.equal((await candRow("F62-SHORT")).eligible, true, "11 months ≥ 6");
  assert.equal((await candRow("F62-COLD")).eligible, false, "the C of 2025-09-30 is inside a 24-month window");
  // 关掉时间窗与现职级门槛 → 叶子去掉；恢复默认 → 回到 F62 默认
  assert.equal((await admin.put("/api/admin/promotion-config", { windowMonths: 0, minLevelTenureMonths: 0 })).status, 200);
  const def = (await admin.get("/api/admin/talent-filters/" + f0)).data.filter;
  assert.deepEqual(def.definition.items.map((l) => l.tag), ["nextLevel", "rating", "violations"]);
  const reset = await admin.put("/api/admin/talent-filters/" + f0, { reset: true, version: def.version });
  assert.equal(reset.status, 200);
  assert.equal(M.isPromotionDefault(reset.data.filter.definition, RATING_OPTS), true);
});

test("migration 92 on an old database: untouched legacy default → replaced; HR-modified → kept with the 'defaults updated' hint; idempotent; reset clears the hint", async () => {
  await srv.stopAsync();
  const legacy = M.promotionFilterRow(M.LEGACY_PROMO_DEFAULTS, RATING_OPTS);
  const rewind = (definition, updatedBy) => db((d) => {
    d.prepare("UPDATE talent_filters SET definition = ?, columns = ?, version = 1, updatedBy = ? WHERE builtinKey = 'promotion'").run(JSON.stringify(definition), JSON.stringify(legacy.columns), updatedBy);
    d.exec("DELETE FROM schema_migrations WHERE version IN (92, 93); DELETE FROM meta WHERE key = 'promotionDefaultsPending'; DELETE FROM audit_logs WHERE action = 'promotion.defaults-update';");
  }, false);
  // ① 从未改过（updatedBy 为空、定义 = 旧默认）→ 换成新默认，列也换，version + 1，审计 applied:true
  rewind(legacy.definition, null);
  srv = await boot();
  let row = builtinRow();
  assert.equal(M.isPromotionDefault(row.definition, RATING_OPTS), true, "replaced with the F62 default");
  assert.deepEqual(row.columns, M.PROMO_COLUMNS);
  assert.equal(row.version, 2);
  assert.equal(audits().length, 1);
  assert.deepEqual([audits()[0].after.applied, audits()[0].after.migration, audits()[0].actorId], [true, 92, null]);
  assert.equal(meta("promotionDefaultsPending"), "");
  assert.deepEqual(JSON.parse(meta("promotionConfig")), { ...M.PROMO_DEFAULTS });
  await srv.stopAsync();
  // ② 被 HR 改过（司龄改为 6 个月，updatedBy 有值）→ 原样保留，写 pending，审计 applied:false
  const modified = JSON.parse(JSON.stringify(legacy.definition));
  modified.items.find((l) => l.tag === "tenure").value = 6;
  rewind(modified, "u-admin");
  srv = await boot();
  row = builtinRow();
  assert.deepEqual(row.definition, modified, "kept as is");
  assert.equal(row.version, 1);
  assert.equal(meta("promotionDefaultsPending"), "92");
  assert.equal(audits().length, 1);
  assert.deepEqual([audits()[0].after.applied, audits()[0].after.reason], [false, "modified_by_hr"]);
  admin = await loginAs(srv.base, ADMIN);
  const cand = await admin.get("/api/admin/promotion-candidates");
  assert.equal(cand.data.defaultsPending, true);
  assert.equal((await admin.get("/api/admin/talent-filters/" + cand.data.filterId)).data.filter.defaultsPending, true);
  assert.equal((await admin.get("/api/admin/talent-filters")).data.filters.find((f) => f.builtinKey === "promotion").defaultsPending, true);
  await srv.stopAsync();
  // ③ 再执行一次（删掉迁移记录）：pending 已写 → 不再写审计
  db((d) => d.exec("DELETE FROM schema_migrations WHERE version = 92;"), false);
  srv = await boot();
  assert.equal(audits().length, 1, "idempotent");
  assert.equal(meta("promotionDefaultsPending"), "92");
  admin = await loginAs(srv.base, ADMIN);
  // ④ 恢复默认 → 新默认，提示清掉
  const f = (await admin.get("/api/admin/talent-filters/" + cand.data.filterId)).data.filter;
  const reset = await admin.put("/api/admin/talent-filters/" + f.id, { reset: true, version: f.version });
  assert.equal(reset.status, 200);
  assert.equal(M.isPromotionDefault(reset.data.filter.definition, RATING_OPTS), true);
  assert.equal(reset.data.filter.defaultsPending, false);
  assert.equal(meta("promotionDefaultsPending"), "");
  assert.equal((await admin.get("/api/admin/promotion-candidates")).data.defaultsPending, false);
});

test("migration 93: a database already on the F62 interim default (missing: ignore) gets the corrected default; an HR-modified interim stays", async () => {
  await srv.stopAsync();
  const interim = M.promotionConfigToFilter(M.PROMO_DEFAULTS, RATING_OPTS);
  for (const l of interim.items) if (l.params && l.params.withinMonths !== undefined) l.params.missing = "ignore";
  assert.equal(M.isInterimPromotionDefault(interim, RATING_OPTS), true);
  const rewind = (definition, updatedBy) => db((d) => {
    d.prepare("UPDATE talent_filters SET definition = ?, version = 2, updatedBy = ? WHERE builtinKey = 'promotion'").run(JSON.stringify(definition), updatedBy);
    d.exec("DELETE FROM schema_migrations WHERE version = 93; DELETE FROM audit_logs WHERE action = 'promotion.defaults-update';");
  }, false);
  // ① 首版默认、未被人改过 → 换成修正后的默认
  rewind(interim, null);
  srv = await boot();
  let row = builtinRow();
  assert.equal(M.isPromotionDefault(row.definition, RATING_OPTS), true, "corrected: missing = fail on both rating leaves");
  assert.equal(row.version, 3);
  assert.deepEqual(audits().map((a) => [a.after.migration, a.after.applied]), [[93, true]]);
  assert.equal(JSON.parse(meta("promotionConfig")).minRatingPeriods, 2);
  admin = await loginAs(srv.base, ADMIN);
  assert.equal((await candRow("F62-ONE")).eligible, false, "one rating no longer qualifies");
  await srv.stopAsync();
  // ② 首版默认但被 HR 改过（司龄 6 个月加回）→ 不动
  const modified = JSON.parse(JSON.stringify(interim));
  modified.items.push({ id: "cte", field: "tenureMonths", op: "gte", value: 6, tag: "tenure" });
  rewind(modified, "u-admin");
  srv = await boot();
  row = builtinRow();
  assert.deepEqual(row.definition, modified, "kept as is");
  assert.equal(audits().length, 0);
  await srv.stopAsync();
  // ③ 再执行一次（已是修正后默认）→ 不改、不写审计
  db((d) => { d.prepare("UPDATE talent_filters SET definition = ?, version = 3, updatedBy = NULL WHERE builtinKey = 'promotion'").run(JSON.stringify(M.promotionConfigToFilter(M.PROMO_DEFAULTS, RATING_OPTS))); d.exec("DELETE FROM schema_migrations WHERE version = 93;"); }, false);
  srv = await boot();
  assert.equal(builtinRow().version, 3);
  assert.equal(audits().length, 0, "idempotent");
  admin = await loginAs(srv.base, ADMIN);
});
