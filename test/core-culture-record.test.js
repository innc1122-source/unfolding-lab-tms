// core 订阅 culture.program.completed → 正式人才记录（modules/culture/CONTRACT.md 6.1；PHASE2-KERNEL.md 1.6、4.10）：
//   · 数据迁移 51 种入人才记录类型 culture-program「行为实践 / Behavior Practice」及其字段；数据迁移 54 把两个选择字段的英文改为
//     可读的产品用语（track：Leader / Team member；participantStatus：Full program / Left early；数据迁移 55 再改为 Team Member、Full participation），hooks.js 写入时把事件的内部键换成它们；
//   · modules/core/hooks.js 逐条 O(1)：按 programId + userId 确定性生成主键、INSERT OR IGNORE —— 同一对只写一次，
//     重复送达不改写；日期取 data.endDate；data 不合规时按处理失败记（发件箱 lastError），不写半条记录；
//   · 规模：冻结一个 4,000 人的项目 = 一个事务里 4,000 行发件箱，提交后一轮分发给 core，1 秒量级。
// 进程内驱动真实 store 与 kernel/events.js 的总线（server.js 的接线由 test/module-host-http.test.js 端到端验证）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "core-culture-rec-"));
process.env.LMS_DB_PATH = path.join(TMP, "rec.db");
process.env.LMS_ATTACH_DIR = path.join(TMP, "attachments");
process.env.LMS_CONFIG_PATH = path.join(TMP, "config.json");
const store = require("../store.js");
const events = require("../kernel/events.js");
const registry = require("../kernel/registry.js");
const CORE_HOOKS = require("../modules/core/hooks.js");
const { DatabaseSync } = require("node:sqlite");

store.init({ hashPassword: (pw) => "test-hash:" + pw });
test.after(() => { try { store.setEventSink(null); store.close(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const rows = (sql, ...a) => { const db = new DatabaseSync(process.env.LMS_DB_PATH, { readOnly: true }); try { return db.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { db.close(); } };

// 与 server.js 同样的接线：注册表的订阅表（core 订阅 culture.program.completed），core 拿到带幂等写入的服务。
const REG = registry.load();
const logs = [];
const bus = events.createBus({
  subscriptions: REG.events.subscriptions,
  services: () => ({}),
  moduleServices: (id) => (id === "core" ? Object.freeze({ addTalentRecordOnce: (rec) => store.addTalentRecordOnce(rec) }) : undefined),
  record: (results) => store.recordEventDispatch(results),
  log: (line) => logs.push(line),
});
store.setEventSink((committed) => bus.publish(committed), { needsDispatch: (type) => bus.hasSubscribers(type) });

const DATA = (programId, endDate, extra = {}) => ({
  programId, programName: "3+3 Action Challenge", startDate: "2026-10-26", endDate, track: "employee", participantStatus: "active",
  dept1Id: "d-1", dept1: "Operations", weeksRequired: 6, weeksMet: 6, totalPoints: 480, tasksSubmitted: 6, tasksWitnessed: 5, cardsGiven: 4, cardsReceived: 3, ...extra,
});
// 模拟 culture 的冻结处理：一个事务里为每名参与者发一条事件（事件在提交后一轮分发）。
function freeze(userIds, data, actorId = null) {
  const t0 = process.hrtime.bigint();
  events.runWithContext({ actorId, requestId: "job-culture.program.daily" }, () => store.transaction(() => {
    for (const userId of userIds) store.publishEvent("culture.program.completed", { userId }, data);
  }));
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test("core record: data migration 51 seeded the built-in culture-program type (Behavior Practice / 行为实践) and its fields; data migration 53 made it visible to the employee 54 gave its option lists readable English, 55 set Team Member / Full participation (2026-09-28) and 60 renamed Team Member to Follower (2026-09-30)", () => {
  assert.deepEqual(rows("SELECT version, name FROM schema_migrations WHERE version IN (51, 53, 54, 55, 60) ORDER BY version"),
    [{ version: 51, name: "culture-program-record-type" }, { version: 53, name: "culture-program-employee-visible" }, { version: 54, name: "culture-program-record-options" }, { version: 55, name: "terminology-record-labels" }, { version: 60, name: "culture-track-follower" }]);
  const t = store.getRecordType("culture-program");
  assert.deepEqual([t.label, t.label_zh, t.builtin, t.active, t.employeeVisible], ["Behavior Practice", "行为实践", true, true, true]);
  const fields = store.listRecordFields("culture-program", true);
  assert.deepEqual(fields.map((f) => f.key), ["programName", "startDate", "track", "participantStatus", "dept1", "weeksMet", "weeksRequired", "totalPoints",
    "tasksSubmitted", "tasksWitnessed", "cardsGiven", "cardsReceived"]);
  assert.equal(new Set(fields.map((f) => f.id)).size, fields.length);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  // options 同时是存储值与英文显示名：英文界面读到的是这里的字，不再是内部键 leader / employee（与档案「行为实践」页签的 Follower track 同一叫法）
  assert.deepEqual([byKey.track.input, byKey.track.options, byKey.track.options_zh], ["select", ["Leader", "Follower"], ["领导者", "追随者"]]);
  assert.deepEqual([byKey.participantStatus.input, byKey.participantStatus.options, byKey.participantStatus.options_zh], ["select", ["Full participation", "Left early"], ["全程参与", "中途离开"]]);
  assert.equal(byKey.programName.required, true);
  assert.equal(byKey.totalPoints.input, "number");
  // 字段名与档案「行为实践」页签、学员端同一叫法（「周五真事」是内部叫法，不出现在界面上）
  assert.deepEqual([byKey.tasksSubmitted.label, byKey.tasksSubmitted.label_zh, byKey.tasksWitnessed.label, byKey.tasksWitnessed.label_zh],
    ["Practice records submitted", "行为实践记录提交数", "Practice records witnessed", "行为实践记录被见证数"]);
  assert.ok(!fields.some((f) => /周五真事|Stories/.test(f.label_zh + " " + f.label)));
  // 之后 HR 新建字段的编号不会与种子撞车
  const next = Number(store.getMeta("nextRF"));
  assert.ok(fields.every((f) => Number(f.id.slice(3)) < next), `nextRF ${next}`);
});

test("core record: store.addTalentRecordOnce writes once per id and refuses incomplete records", () => {
  const rec = { id: "tr-once-1", userId: "u-1001", type: "culture-program", date: "2026-12-06", title: "T", detail: { a: 1 }, createdBy: "system" };
  assert.equal(store.addTalentRecordOnce(rec), true);
  assert.equal(store.addTalentRecordOnce({ ...rec, date: "2027-01-01", title: "changed" }), false);
  assert.deepEqual(rows("SELECT date, title, detail FROM talent_records WHERE id = 'tr-once-1'"), [{ date: "2026-12-06", title: "T", detail: '{"a":1}' }]);
  for (const k of ["id", "userId", "type", "date", "createdBy"]) assert.throws(() => store.addTalentRecordOnce({ ...rec, id: "tr-once-2", [k]: "" }), new RegExp(k + " must be a non-empty string"));
});

test("core record: freezing a 4,000-person program writes one record per person in one dispatch round (1-second scale), dated data.endDate; redelivery writes nothing and rewrites nothing", (t) => {
  const users = Array.from({ length: 4000 }, (_, i) => "u-scale-" + i);
  const ms = freeze(users, DATA("p-2026-q4", "2026-12-06"));
  t.diagnostic(`4,000 events: commit + dispatch + outbox write-back ${ms.toFixed(0)}ms`);
  // 单独运行约 0.8 秒（2026-09-26 实测）；全量测试多进程并行时磁盘繁忙，放宽到与 kernel-events-services 同一条线。
  assert.ok(ms < 10000, `freeze took ${ms.toFixed(0)}ms (expected on the order of a second)`);
  const n = rows("SELECT COUNT(*) AS n, MIN(date) AS a, MAX(date) AS b, COUNT(DISTINCT id) AS ids FROM talent_records WHERE type = 'culture-program' AND userId LIKE 'u-scale-%'")[0];
  assert.deepEqual(n, { n: 4000, a: "2026-12-06", b: "2026-12-06", ids: 4000 });
  const one = rows("SELECT id, title, detail, createdBy, programId FROM talent_records WHERE userId = 'u-scale-7' AND type = 'culture-program'")[0];
  assert.match(one.id, /^tr-cp-[0-9a-f]{24}$/);
  assert.equal(one.title, "3+3 Action Challenge");
  assert.equal(one.createdBy, "system", "frozen by the nightly job: no acting user");
  assert.equal(one.programId, null, "talent_records.programId links LMS programs; the culture program id lives in detail");
  // 每个字段都抄进 detail；两个选择字段存字段选项里的值（事件的 employee / active → Follower / Full participation）
  assert.deepEqual(JSON.parse(one.detail), { ...DATA("p-2026-q4", "2026-12-06"), track: "Follower", participantStatus: "Full participation" }, "every field of the event data is kept in detail");
  const ob = rows("SELECT COUNT(*) AS n, SUM(attempts) AS att, SUM(dispatchedAt IS NULL) AS pending FROM event_outbox WHERE type = 'culture.program.completed'")[0];
  assert.deepEqual(ob, { n: 4000, att: 4000, pending: 0 });
  // 同一批事件再送达一次（例如补发）：不多写、不改写
  const again = freeze(users, DATA("p-2026-q4", "2027-01-15", { totalPoints: 999 }));
  t.diagnostic(`redelivery of 4,000 events ${again.toFixed(0)}ms`);
  const m = rows("SELECT COUNT(*) AS n, MAX(date) AS b FROM talent_records WHERE type = 'culture-program' AND userId LIKE 'u-scale-%'")[0];
  assert.deepEqual(m, { n: 4000, b: "2026-12-06" });
  assert.equal(JSON.parse(rows("SELECT detail FROM talent_records WHERE userId = 'u-scale-7' AND type = 'culture-program'")[0].detail).totalPoints, 480);
});

test("core record: another program is another record; the acting HR user (programs.close) becomes createdBy; only whitelisted data keys are kept", () => {
  // S3（G-08、G-23、G-29）：culture 事件 data 另带 weeksEnrolled、tasksLate、tasksVague、excludeReason，core 的人才记录字段不增加
  freeze(["u-scale-1"], DATA("p-2027-q1", "2027-03-10", { unexpected: "dropped", weeksMet: "six", weeksEnrolled: 3, tasksLate: 1, tasksVague: 1, excludeReason: "long_absence" }), "u-admin");
  const recs = rows("SELECT date, createdBy, detail FROM talent_records WHERE userId = 'u-scale-1' AND type = 'culture-program' ORDER BY date");
  assert.equal(recs.length, 2);
  assert.equal(recs[1].date, "2027-03-10");
  assert.equal(recs[1].createdBy, "u-admin");
  const d = JSON.parse(recs[1].detail);
  assert.equal("unexpected" in d, false);
  for (const k of ["weeksEnrolled", "tasksLate", "tasksVague", "excludeReason"]) assert.equal(k in d, false, k + " stays in the event data only");
  assert.equal("weeksMet" in d, false, "a non-number count is left out rather than stored as text");
});

test("core record: track and participantStatus are stored as the field's option values (leader → Leader, employee → Follower, active → Full participation, left → Left early), so the English timeline never shows the internal key; a value outside the map is kept as sent", () => {
  const fields = Object.fromEntries(store.listRecordFields("culture-program", true).map((f) => [f.key, f]));
  const cases = [
    ["u-map-1", { track: "leader", participantStatus: "left" }, { track: "Leader", participantStatus: "Left early" }],
    ["u-map-2", { track: "employee", participantStatus: "active" }, { track: "Follower", participantStatus: "Full participation" }],
    ["u-map-3", { track: " leader ", participantStatus: "paused" }, { track: "Leader", participantStatus: "paused" }],
  ];
  for (const [userId, extra] of cases) freeze([userId], DATA("p-map-1", "2026-12-06", extra));
  for (const [userId, sent, want] of cases) {
    const d = JSON.parse(rows("SELECT detail FROM talent_records WHERE userId = ? AND type = 'culture-program'", userId)[0].detail);
    assert.deepEqual([d.track, d.participantStatus], [want.track, want.participantStatus], userId + " " + JSON.stringify(sent));
  }
  // 与迁移 55 之后的清单逐项对齐：事件的内部键 → 同一位置的存储值，中文名就是那一位置的 options_zh（领导者 / 追随者、全程参与 / 中途离开）
  const pairs = [["track", "leader", "领导者"], ["track", "employee", "追随者"], ["participantStatus", "active", "全程参与"], ["participantStatus", "left", "中途离开"]];
  for (const [key, internal, zh] of pairs) {
    const userId = "u-map-" + key + "-" + internal;
    freeze([userId], DATA("p-map-2", "2026-12-06", { [key]: internal }));
    const v = JSON.parse(rows("SELECT detail FROM talent_records WHERE userId = ? AND type = 'culture-program'", userId)[0].detail)[key];
    const i = fields[key].options.indexOf(v);
    assert.ok(i >= 0, `${key} ${internal} → ${v} is one of the configured options ${JSON.stringify(fields[key].options)}`);
    assert.equal(fields[key].options_zh[i], zh, `${key} ${internal}`);
  }
});

test("core record: data the handler cannot trust (no user, no programId, an impossible endDate) is a recorded handler failure and writes nothing", () => {
  const before = rows("SELECT COUNT(*) AS n FROM talent_records WHERE type = 'culture-program'")[0].n;
  logs.length = 0;
  events.runWithContext({ actorId: null, requestId: "t" }, () => store.transaction(() => {
    store.publishEvent("culture.program.completed", {}, DATA("p-bad-1", "2026-12-06"));
    store.publishEvent("culture.program.completed", { userId: "u-bad" }, DATA("", "2026-12-06"));
    store.publishEvent("culture.program.completed", { userId: "u-bad" }, DATA("p-bad-2", "2026-02-30"));
    store.publishEvent("culture.program.completed", { userId: "u-bad" }, DATA("p-bad-3", "12/09/2026"));
  }));
  assert.equal(rows("SELECT COUNT(*) AS n FROM talent_records WHERE type = 'culture-program'")[0].n, before);
  const failed = rows("SELECT lastError FROM event_outbox WHERE type = 'culture.program.completed' AND dispatchedAt IS NULL ORDER BY occurredAt, id");
  assert.equal(failed.length, 4);
  assert.match(failed[0].lastError, /subject\.userId is missing/);
  assert.match(failed[1].lastError, /data\.programId is missing/);
  assert.match(failed[2].lastError, /data\.endDate must be a YYYY-MM-DD date/);
  assert.match(failed[3].lastError, /data\.endDate must be a YYYY-MM-DD date/);
  assert.equal(logs.length, 4, "one [events] line per failed handler call");
  assert.ok(logs.every((l) => /^\[events\] handler failed: culture\.program\.completed ev-[0-9a-f-]+ \(module core, Error\)$/.test(l)), logs.join("\n"));
  assert.deepEqual(Object.keys(CORE_HOOKS), ["culture.program.completed"]);
});
