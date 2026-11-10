// 第二批波次 2 复核修正（2026-10-08）：
//   · L2 开关关闭（LMS_TEST_HIDE_MANAGER_COMMENT=1，模拟负责人对问题 1 选「不给」）时，三处一起隐藏上级评语：
//     「我的绩效」、成长档案（HR 改过评语、summaryAuthor 已被去掉的归档记录也隐藏）、进行中旧流程周期的 mine[].managerText。
//   · 面谈补登记的最早日期 = 周期发起日的本地日历日（马尼拉 07:30 发起的周期，UTC 日是前一天，前一天不能登记）；
//     mine[] 带 cycleStartedAt。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

const DAY = 24 * 60 * 60 * 1000;
const H8 = 8 * 60 * 60 * 1000;
const manilaDay = (ms) => new Date(ms + H8).toISOString().slice(0, 10);   // 马尼拉没有夏令时
const FAKE_NOW = Date.now() + 3 * DAY;
const MGR_COMMENT = "SW-MGR-COMMENT 稳定完成目标";
const HR_EDIT = "SW-HR-EDITED 评语错字已更正";
const LEGACY_COMMENT = "SW-LEGACY-COMMENT 旧流程评语";
const selfBody = { outcomes: ["完成季度目标"], challenges: "", feedback: "多一些跨部门同步", goalsNext: ["下季度目标"] };

let srv, admin, unit;
const people = {};

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
function dbWrite(fn) { const d = new DatabaseSync(srv.dbPath); try { return fn(d); } finally { d.close(); } }
async function newPerson(employeeId, name, department, managerEid) {
  const r = await admin.post("/api/admin/employees", { name, employeeId, department, jobLevel: "PB2", programIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = dbRead((d) => d.prepare("SELECT id FROM users WHERE employeeId = ?").get(employeeId)).id;
  if (managerEid) assert.equal((await admin.put(`/api/admin/employees/${id}`, { managerId: people[managerEid].id })).status, 200);
  const c = makeClient(srv.base);
  await c.login({ employeeId, password: r.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: r.data.password, newPassword: employeeId + "-pw-2026" })).status, 200);
  people[employeeId] = { id, client: c };
}
const v2Cycle = async (name, eids) => {
  const r = await admin.post("/api/admin/review-cycles", {
    name, flow: "v2", kind: "quarter", dueAt: manilaDay(FAKE_NOW + 5 * DAY), dueRateAt: manilaDay(FAKE_NOW + 7 * DAY), dueCalibAt: manilaDay(FAKE_NOW + 9 * DAY),
    userIds: eids.map((e) => people[e].id),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const items = {};
  for (const i of (await admin.get(`/api/admin/review-cycles/${r.data.cycle.id}`)).data.items) items[i.employeeId] = i.id;
  return { id: r.data.cycle.id, items };
};

before(async () => {
  srv = await startServer({ env: { LMS_TEST_HIDE_MANAGER_COMMENT: "1", TZ: "Asia/Manila", LMS_FAKE_NOW: new Date(FAKE_NOW).toISOString() } });
  admin = await loginAs(srv.base, ADMIN);
  await newPerson("SW-HOD", "Sia Hod", "Switch Dept");
  unit = (await admin.get("/api/admin/departments")).data.find((x) => x.name === "Switch Dept").id;
  assert.equal((await admin.put(`/api/admin/departments/${unit}`, { ownerId: people["SW-HOD"].id })).status, 200);
  await newPerson("SW-MGR", "Sam Mgr", "Switch Dept", "SW-HOD");
  await newPerson("SW-E1", "Sue One", "Switch Dept", "SW-MGR");
});
after(async () => { if (srv) await srv.stopAsync(); });

test("L2 switched off: My performance, the growth timeline and an open legacy cycle all hide the manager's comment — also after HR edits it", async () => {
  // 周期 1：评级 → HoD 提交 → HR 确认 → 关闭归档
  const c1 = await v2Cycle("2026Q2 Switch", ["SW-E1"]);
  assert.equal((await people["SW-E1"].client.post(`/api/me/reviews/${c1.items["SW-E1"]}/self`, selfBody)).status, 200);
  assert.equal((await people["SW-MGR"].client.post(`/api/me/reviews/${c1.items["SW-E1"]}/manager`, { rating: "B+", text: MGR_COMMENT })).status, 200);
  const sub = await people["SW-HOD"].client.post("/api/me/reviews/hod/submit", { cycleId: c1.id, dept1Id: unit });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  assert.equal((await admin.post(`/api/admin/review-cycles/${c1.id}/depts/${unit}/confirm`, {})).status, 200);
  const closed = await admin.post(`/api/admin/review-cycles/${c1.id}/close`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const prof = (await admin.get(`/api/admin/employees/${people["SW-E1"].id}/profile`)).data;
  const ev = prof.events.find((e) => e.source === "record" && e.type === "performance" && e.title === "2026Q2 Switch");
  assert.ok(ev, "the cycle archived a record");
  assert.equal(ev.detail.summaryAuthor, "manager");

  const hidden = async (label) => {
    const hist = (await people["SW-E1"].client.get("/api/me/reviews/history")).data;
    const row = hist.items.find((i) => i.cycleId === c1.id);
    assert.equal(row.rating, "B+", label);
    assert.equal(row.managerText, "", label + ": My performance hides the comment");
    const growth = (await people["SW-E1"].client.get("/api/me/growth")).data;
    const g = growth.events.find((e) => e.kind === "record" && e.title === "2026Q2 Switch");
    assert.ok(g && g.lines.some((l) => l.value === "B+"), label + ": the rating line is there " + JSON.stringify(g));
    const body = JSON.stringify(growth) + JSON.stringify(hist);
    assert.ok(!body.includes("SW-MGR-COMMENT") && !body.includes("SW-HR-EDITED"), label + ": no comment text anywhere");
  };
  await hidden("as archived");

  // HR 只改评语（评级不变，不需要理由）：summaryAuthor 被去掉，但仍是这一期的评估评语 —— 两处一样隐藏
  const put = await admin.put(`/api/admin/records/${ev.id}`, { type: "performance", date: ev.date, title: ev.title, fields: { period: ev.detail.period, rating: "B+", summary: HR_EDIT } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.ok(!put.data.record.detail.summaryAuthor, "the author marker is gone after an edit to the comment");
  await hidden("after HR edits the comment");

  // 进行中的旧流程周期：上级评完以后员工本人同样看不到评语（评级照旧流程给）；上级自己的名单照常有
  const lg = await admin.post("/api/admin/review-cycles", { name: "Switch Legacy", dueAt: manilaDay(FAKE_NOW + 5 * DAY), userIds: [people["SW-E1"].id] });
  assert.equal(lg.status, 200, JSON.stringify(lg.data));
  const lgItem = (await admin.get(`/api/admin/review-cycles/${lg.data.cycle.id}`)).data.items[0].id;
  const rate = await people["SW-MGR"].client.post(`/api/me/reviews/${lgItem}/manager`, { rating: "B", text: LEGACY_COMMENT, oneOnOneDone: true });
  assert.equal(rate.status, 200, JSON.stringify(rate.data));
  const mine = (await people["SW-E1"].client.get("/api/me/reviews")).data;
  const lgMine = mine.mine.find((i) => i.id === lgItem);
  assert.equal(lgMine.managerRating, "B");
  assert.equal(lgMine.managerText, "");
  assert.ok(!JSON.stringify(mine).includes("SW-LEGACY-COMMENT"));
  // 波次 3（W3-S）：开关值同时下发给上级的评级表单（/api/me/reviews 与 team/:id 的 commentVisibleToEmployee），
  // 上级在单人评估页照常看到自己写的评语（旧的完整 team[] 已删）
  assert.equal(mine.commentVisibleToEmployee, false);
  const team = (await people["SW-MGR"].client.get("/api/me/reviews")).data;
  assert.equal(team.commentVisibleToEmployee, false);
  const tm = (await people["SW-MGR"].client.get(`/api/me/reviews/team/${lgItem}`)).data;
  assert.equal(tm.commentVisibleToEmployee, false);
  assert.equal(tm.item.managerText, LEGACY_COMMENT, "the manager still sees their own comment");
});

test("1-on-1 back-dating: the earliest date is the cycle's LOCAL start day (not the UTC slice of createdAt); mine[] carries cycleStartedAt", async () => {
  const c2 = await v2Cycle("2026Q3 Switch", ["SW-E1"]);
  // 周期发起于马尼拉 startDay 07:30 = 前一天 23:30Z
  const startDay = manilaDay(FAKE_NOW - 2 * DAY);
  const createdAt = new Date(Date.parse(`${startDay}T07:30:00+08:00`)).toISOString();
  const utcDay = createdAt.slice(0, 10);
  assert.notEqual(utcDay, startDay, "fixture: the UTC day is the day before");
  dbWrite((d) => d.prepare("UPDATE review_cycles SET createdAt = ? WHERE id = ?").run(createdAt, c2.id));
  const url = `/api/me/reviews/${c2.items["SW-E1"]}/one-on-one`;
  const before = await people["SW-E1"].client.post(url, { done: true, date: utcDay });
  assert.equal(before.status, 400, "the day before the cycle started: " + JSON.stringify(before.data));
  assert.equal(before.data.code, "date_invalid");
  const mgrBefore = await people["SW-MGR"].client.post(url, { done: true, date: utcDay });
  assert.equal(mgrBefore.status, 400);
  assert.equal(mgrBefore.data.code, "date_invalid");
  const ok = await people["SW-E1"].client.post(url, { done: true, date: startDay });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.at, `${startDay}T12:00:00.000Z`);
  const mine = (await people["SW-E1"].client.get("/api/me/reviews")).data.mine.find((i) => i.id === c2.items["SW-E1"]);
  assert.equal(mine.cycleStartedAt, startDay);
  const tm = (await people["SW-MGR"].client.get(`/api/me/reviews/team/${c2.items["SW-E1"]}`)).data.item;
  assert.equal(tm.cycleStartedAt, startDay);
});
