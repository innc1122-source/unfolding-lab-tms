// 第二批 2.1 / 2.7（2026-10-08，波次 1 W1-A）：上级的团队名单与单人评估页、面谈由两侧各自登记、离职的处理。
//   · GET /api/me/reviews：team[] 保持原来的完整形状（现在的评估页还在用，审查 P0-1），另带 teamRows（轻量行 + tags）与
//     teamStats（每个周期一条，分母去掉离职者；面谈完成 = 双方都登记，「仅上级 / 仅员工」单列）；mine[] 在 v2 周期不再给
//     上级评语、关键亮点与评级时间，另带 managerGone / managerGoneBy / notCounted。
//   · GET /api/me/reviews/team/:id：只对快照上级本人、且本人仍在职时返回，其余 404。
//   · POST /api/me/reviews/:id/one-on-one：员工与上级两种身份；补登记日期不能晚于今天、不能早于周期发起日；旧流程上级一侧 400。
//   · v2 上级评级不以面谈为前提；HoD 已代评 → 409 hod_proxied；上级本人已离职 → 409 manager_inactive；
//     给已离职的下属发提醒 → 400 recipient_inactive。
// 服务端「今天」用 LMS_FAKE_NOW 推后 10 天，这样「周期发起日 ≤ 补登记日期 < 今天」有可用的日期。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

const DAY = 24 * 60 * 60 * 1000;
const FAKE_NOW = Date.now() + 10 * DAY;
// 与服务端 todayLocal() 同一算法（本机时区的日历日）
const ymd = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const TODAY = ymd(FAKE_NOW);

let srv, admin;
const people = {};   // employeeId → { id, client }
let Q, LEGACY;
const items = {};    // employeeId → Q 的条目 id
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
const auditRows = (action) => dbRead((d) => d.prepare("SELECT target, afterJson FROM audit_logs WHERE action = ? ORDER BY id").all(action)).map((r) => ({ target: r.target, after: JSON.parse(r.afterJson || "null") }));
const notes = (uid) => dbRead((d) => d.prepare("SELECT title, title_zh, link FROM notifications WHERE userId = ? ORDER BY createdAt, id").all(uid));

async function newPerson(employeeId, name, department, managerEid) {
  const r = await admin.post("/api/admin/employees", { name, employeeId, department, jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: r.data.password });
  await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: "tr-pass-123" });
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(employeeId)).id;
  if (managerEid) assert.equal((await admin.put(`/api/admin/employees/${id}`, { managerId: people[managerEid].id })).status, 200);
  people[employeeId] = { id, client: c };
}
const exit = async (eid) => assert.equal((await admin.put(`/api/admin/employees/${people[eid].id}`, { empStatus: "exited" })).status, 200);
const me = (eid) => people[eid].client.get("/api/me/reviews").then((r) => r.data);
const rowOf = (d, eid) => d.teamRows.find((r) => r.employeeId === eid);

before(async () => {
  srv = await startServer({ env: { LMS_FAKE_NOW: new Date(FAKE_NOW).toISOString() } });
  admin = await loginAs(srv.base, ADMIN);
  await newPerson("TR-HOD", "Tina Hod", "TR Dept");
  const d = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "TR Dept");
  assert.equal((await admin.put(`/api/admin/departments/${d.id}`, { ownerId: people["TR-HOD"].id })).status, 200);
  await newPerson("TR-MGR", "Max Mgr", "TR Dept", "TR-HOD");
  await newPerson("TR-MGR2", "Mona Mgr", "TR Dept", "TR-HOD");
  for (const e of ["TR-E1", "TR-E2", "TR-E3", "TR-E4"]) await newPerson(e, "Emp " + e, "TR Dept", "TR-MGR");
  await newPerson("TR-E5", "Emp TR-E5", "TR Dept", "TR-MGR2");
  const ids = ["TR-MGR", "TR-MGR2", "TR-E1", "TR-E2", "TR-E3", "TR-E4", "TR-E5"].map((k) => people[k].id);
  const c = await admin.post("/api/admin/review-cycles", { name: "TR 2026Q4", flow: "v2", kind: "quarter", dueAt: ymd(FAKE_NOW + 5 * DAY), dueRateAt: ymd(FAKE_NOW + 7 * DAY), dueCalibAt: ymd(FAKE_NOW + 9 * DAY), userIds: ids });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  Q = c.data.cycle.id;
  for (const i of (await admin.get(`/api/admin/review-cycles/${Q}`)).data.items) items[i.employeeId] = i.id;
  const l = await admin.post("/api/admin/review-cycles", { name: "TR Legacy", dueAt: ymd(FAKE_NOW + 5 * DAY), userIds: [people["TR-E1"].id] });
  assert.equal(l.status, 200, JSON.stringify(l.data));
  LEGACY = l.data.cycle.id;
});
after(async () => { if (srv) await srv.stopAsync(); });

test("teamRows / teamStats replace the old full team[]; tags and the 1-on-1 states are computed once on the server", async () => {
  await people["TR-E1"].client.post(`/api/me/reviews/${items["TR-E1"]}/self`, selfBody);
  assert.equal((await people["TR-E1"].client.post(`/api/me/reviews/${items["TR-E1"]}/one-on-one`, { done: true })).status, 200);
  assert.equal((await people["TR-MGR"].client.post(`/api/me/reviews/${items["TR-E2"]}/one-on-one`, { done: true, notes: "聊了下季度目标" })).status, 200);
  const d = await me("TR-MGR");
  // 波次 3（W3-S）：旧的完整 team[] 已删（前端只读 teamRows / teamStats），完整内容在单人评估页 GET team/:id
  assert.ok(!("team" in d), "the old full team[] is gone");
  assert.equal(d.commentVisibleToEmployee, true, "L2 default: the manager form can say the comment is shown to the employee");
  const full = (await people["TR-MGR"].client.get(`/api/me/reviews/team/${items["TR-E1"]}`)).data;
  assert.ok(Array.isArray(full.item.goalsNext) && "managerText" in full.item && "selfOutcomes" in full.item, JSON.stringify(Object.keys(full.item)));
  assert.equal(full.commentVisibleToEmployee, true, "team/:id carries the same switch");
  assert.match(full.item.cycleStartedAt, /^\d{4}-\d{2}-\d{2}$/, "the date picker's lower bound");
  assert.deepEqual(d.teamRows.map((r) => r.employeeId).sort(), ["TR-E1", "TR-E1", "TR-E2", "TR-E3", "TR-E4"], "managerId = me only (the legacy cycle row for E1 is listed too)");
  const r1 = d.teamRows.find((r) => r.employeeId === "TR-E1" && r.cycleId === Q);
  assert.deepEqual(Object.keys(r1).sort(), ["cycle", "cycleId", "department", "dueAt", "dueRateAt", "employeeId", "employeeOneOnOneAt", "flow", "highlightsMissing",
    "hodProxied", "id", "jobLevel", "kind", "locked", "managerAt", "managerRating", "name", "notCounted", "oneOnOneAt", "oneState", "overdue", "position",
    "selfAt", "selfOverdue", "tags", "userId"]);
  assert.equal(r1.oneState, "emp");
  assert.deepEqual(r1.tags, ["one", "rate"]);
  assert.equal(rowOf(d, "TR-E2").oneState, "mgr");
  // 波次 2 复核：rate 与 todo.rate、D1 评级门槛同一口径 —— 自评没交且未逾期的人不算「待评级」（只算「待自评」）
  assert.deepEqual(rowOf(d, "TR-E2").tags, ["self", "one"]);
  const st = d.teamStats.find((s) => s.cycleId === Q);
  assert.deepEqual(
    [st.counted, st.excluded, st.selfDone, st.oneOnOneDone, st.oneMgrOnly, st.oneEmpOnly, st.rated, st.todo.rate, st.todo.oneOnOne],
    [4, 0, 1, 0, 1, 1, 0, 1, 3],
    JSON.stringify(st),
  );
  assert.deepEqual(st.byStatus, { all: 4, self: 3, one: 4, rate: 1, rated: 0, locked: 0, left: 0 });
  assert.equal(st.byStatus.rate, st.todo.rate, "the 待评级 chip and the home to-do count agree");
});

test("a leaver is listed as left / not counted and drops out of every denominator; reminding them → 400 recipient_inactive", async () => {
  await exit("TR-E3");
  const d = await me("TR-MGR");
  const r3 = rowOf(d, "TR-E3");
  assert.equal(r3.notCounted, "departed");
  assert.deepEqual(r3.tags, ["left"]);
  const st = d.teamStats.find((s) => s.cycleId === Q);
  assert.deepEqual([st.counted, st.excluded, st.byStatus.left, st.byStatus.all], [3, 1, 1, 4]);
  const nudge = await people["TR-MGR"].client.post(`/api/me/reviews/${items["TR-E3"]}/nudge`);
  assert.equal(nudge.status, 400);
  assert.equal(nudge.data.code, "recipient_inactive");
  assert.match(nudge.data.error, /has left.*已离职/);
});

test("team/:id: only the snapshot manager gets the full item; anyone else → 404", async () => {
  const ok = await people["TR-MGR"].client.get(`/api/me/reviews/team/${items["TR-E1"]}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const it = ok.data.item;
  assert.equal(it.name, "Emp TR-E1");
  assert.ok(Array.isArray(it.goalsNext) && it.selfFeedback === selfBody.feedback, "the self-review text is there for the manager");
  assert.deepEqual([it.oneState, it.notCounted, it.locked, it.hodProxied], ["emp", null, false, false]);
  // 波次 2 复核：周期发起日（本地日）给日期选择器作下限；mine[] 同样带
  const created = (await admin.get(`/api/admin/review-cycles/${Q}`)).data.cycle.createdAt;
  assert.equal(it.cycleStartedAt, ymd(Date.parse(created)));
  assert.equal((await me("TR-E1")).mine.find((x) => x.id === items["TR-E1"]).cycleStartedAt, ymd(Date.parse(created)));
  assert.ok(Array.isArray(ok.data.ratingOptions) && ok.data.ratingOptions.length && Array.isArray(ok.data.highlightRatings));
  for (const [who, id] of [["TR-MGR2", items["TR-E1"]], ["TR-HOD", items["TR-E1"]], ["TR-E1", items["TR-E1"]], ["TR-MGR", items["TR-E5"]]]) {
    const r = await people[who].client.get(`/api/me/reviews/team/${id}`);
    assert.equal(r.status, 404, who);
    assert.equal(r.data.code, "not_found");
  }
});

test("1-on-1: both sides log their own side; back-dating is limited to [cycle start, today]; the legacy flow keeps the manager side with the rating", async () => {
  const m = people["TR-MGR"].client;
  const url = `/api/me/reviews/${items["TR-E1"]}/one-on-one`;
  // 补登记：两天前（在周期发起日与今天之间）
  const back = ymd(FAKE_NOW - 2 * DAY);
  const r = await m.post(url, { done: true, date: back, notes: "季度回顾" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.side, "manager");
  assert.equal(r.data.at, `${back}T12:00:00.000Z`);
  const a = auditRows("review.one-on-one").pop();
  assert.equal(a.target, items["TR-E1"]);
  assert.deepEqual(a.after, { side: "manager", done: true, date: back, backfill: true });
  for (const bad of [ymd(FAKE_NOW + DAY), ymd(Date.now() - 3 * DAY), "2026-13-40", "yesterday"]) {
    const x = await m.post(url, { done: true, date: bad });
    assert.equal(x.status, 400, bad);
    assert.equal(x.data.code, "date_invalid", bad);
    assert.match(x.data.error, /can't be in the future.*不能晚于今天/);
  }
  const det = (await admin.get(`/api/admin/review-cycles/${Q}`)).data.items.find((i) => i.employeeId === "TR-E1");
  assert.equal(det.oneOnOneAt, `${back}T12:00:00.000Z`);
  assert.equal(det.oneOnOneNotes, "季度回顾");
  assert.equal(det.oneState, "both");
  // 不相干的人 → 404；旧流程周期的上级一侧 → 400 flow_unsupported
  assert.equal((await people["TR-E2"].client.post(url, { done: true })).status, 404);
  const legacyItem = (await admin.get(`/api/admin/review-cycles/${LEGACY}`)).data.items[0].id;
  const lg = await m.post(`/api/me/reviews/${legacyItem}/one-on-one`, { done: true });
  assert.equal(lg.status, 400);
  assert.equal(lg.data.code, "flow_unsupported");
  // 员工一侧撤销后再登记今天
  assert.equal((await people["TR-E1"].client.post(url, { done: false })).status, 200);
  const again = await people["TR-E1"].client.post(url, { done: true, date: TODAY });
  assert.equal(again.status, 200);
  assert.equal(again.data.side, "employee");
  assert.equal(auditRows("review.one-on-one").pop().after.backfill, false);
});

test("v2 rating needs no 1-on-1 and no self-review on the server; mine[] hides the manager's comments, highlights and rating time", async () => {
  const m = people["TR-MGR"].client;
  const r = await m.post(`/api/me/reviews/${items["TR-E4"]}/manager`, { rating: "C", highlights: "交付多次延期", text: "需要改进排期" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const det = (await admin.get(`/api/admin/review-cycles/${Q}`)).data.items.find((i) => i.employeeId === "TR-E4");
  assert.equal(det.managerRating, "C");
  assert.equal(det.oneOnOneAt, null, "the rating doesn't log the 1-on-1");
  const mine = (await me("TR-E4")).mine.find((i) => i.cycle === "TR 2026Q4");
  assert.equal(mine.managerDone, true);
  for (const k of ["managerRating", "managerText", "highlights", "managerAt"]) assert.ok(!(k in mine), k);
  assert.deepEqual([mine.managerGone, mine.managerGoneBy, mine.notCounted], [false, null, null]);
  assert.ok(!JSON.stringify(mine).includes("交付多次延期"));
  const row = rowOf(await me("TR-MGR"), "TR-E4");
  assert.deepEqual(row.tags, ["self", "one", "rated"]);
  assert.equal(row.highlightsMissing, false);
});

test("2.7 manager left: they can't rate, nudge or log the 1-on-1 (409 manager_inactive), their roster is empty, and the employee learns the HoD will rate", async () => {
  await exit("TR-MGR2");
  const m2 = people["TR-MGR2"].client;
  for (const [url, body] of [[`/api/me/reviews/${items["TR-E5"]}/manager`, { rating: "B" }], [`/api/me/reviews/${items["TR-E5"]}/nudge`, {}], [`/api/me/reviews/${items["TR-E5"]}/one-on-one`, { done: true }]]) {
    const r = await m2.post(url, body);
    assert.equal(r.status, 409, url + " " + JSON.stringify(r.data));
    assert.equal(r.data.code, "manager_inactive");
  }
  const d = await me("TR-MGR2");
  assert.deepEqual([d.teamRows.length, d.teamStats.length], [0, 0]);
  assert.equal((await m2.get(`/api/me/reviews/team/${items["TR-E5"]}`)).status, 404);
  const mine = (await me("TR-E5")).mine.find((i) => i.cycle === "TR 2026Q4");
  assert.deepEqual([mine.managerGone, mine.managerGoneBy], [true, "hod"]);
  // 员工一侧照常登记面谈（自评之前也可以）
  assert.equal((await people["TR-E5"].client.post(`/api/me/reviews/${items["TR-E5"]}/one-on-one`, { done: true })).status, 200);
});

test("2.2 HoD proxy: after the rating deadline the HoD rates for an active manager (who is told); the manager is then blocked (409 hod_proxied) until the HoD clears it", async () => {
  const hod = people["TR-HOD"].client, m = people["TR-MGR"].client;
  // 截止日未过：不能代评
  const early = await hod.put(`/api/me/reviews/hod/items/${items["TR-E2"]}`, { rating: "B", reason: "上级迟迟未评" });
  assert.equal(early.status, 409, JSON.stringify(early.data));
  assert.equal(early.data.code, "manager_not_overdue");
  assert.equal((await admin.put(`/api/admin/review-cycles/${Q}/due`, { dueRateAt: ymd(FAKE_NOW - DAY) })).status, 200);
  const noReason = await hod.put(`/api/me/reviews/hod/items/${items["TR-E2"]}`, { rating: "B" });
  assert.equal(noReason.data.code, "proxy_reason_required");
  const ok = await hod.put(`/api/me/reviews/hod/items/${items["TR-E2"]}`, { rating: "B", reason: "上级迟迟未评" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(notes(people["TR-MGR"].id).some((n) => /rated Emp TR-E2 on your behalf/.test(n.title) && n.link === "/review?view=team"));
  const blocked = await m.post(`/api/me/reviews/${items["TR-E2"]}/manager`, { rating: "B+" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, "hod_proxied");
  const row = rowOf(await me("TR-MGR"), "TR-E2");
  assert.equal(row.hodProxied, true);
  assert.ok(row.tags.includes("rated") && !row.tags.includes("rate"));
  assert.equal(row.managerRating, null, "the proxied rating value is not shown to the manager");
  assert.equal((await hod.put(`/api/me/reviews/hod/items/${items["TR-E2"]}`, { rating: null })).status, 200);
  assert.equal((await m.post(`/api/me/reviews/${items["TR-E2"]}/manager`, { rating: "B+" })).status, 200);
});
