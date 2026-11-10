// 第二批 2.8（2026-10-08）绩效申诉：HRBP 答复时限 10 个工作日与提醒（设计 §5.3、§5.4，§10.1 review-appeal-sla）。
//   · slaDueOn：周一 12-07 提交 → 12-22（12-08 假期）；
//   · 每日任务在马尼拉 08:00 之后的第一次运行（含启动时）执行，同一天只跑一次（meta reviewAppealDay），周末与菲律宾假期不提醒；
//   · 到期前 2 个工作日提醒处理人一次；逾期首日提醒处理人并升级给范围内、无利益冲突的绩效管理员（处理人除外）；
//     之后每满 5 个工作日再提醒处理人，不再升级；状态永远不因逾期改变；模块关闭时不提醒，重新打开后只补一次。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const W = require("./fixtures/appeal-world.js");

let w, Q, apB;
const at = (s) => new Date(s + "+08:00").toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REMIND = /due soon|overdue|Overdue appeal/i;
const reminders = (eid) => w.notifs(eid, "review_appeal").filter((n) => REMIND.test(n.title) && n.link && n.link.includes(apB));
const events = (kind) => w.dbRead((d) => d.prepare("SELECT * FROM review_appeal_events WHERE appealId = ? AND kind = ? ORDER BY id").all(apB, kind));
const meta = () => { const r = w.dbRead((d) => d.prepare("SELECT value FROM meta WHERE key = 'reviewAppealDay'").get()); return r ? r.value : null; };
async function dayAt(s, env) { await w.restart(at(s), env); await sleep(800); }
const counts = () => ({ HB: reminders("HB").length, SA: reminders("SA").length, AD: reminders("AD").length, PT: reminders("PT").length, PS: reminders("PS").length, MB: reminders("M-B").length, EB: w.notifs("E-B", "review_appeal").filter((n) => REMIND.test(n.title)).length });

before(async () => {
  w = await W.bootWorld(at("2026-11-27T10:00:00"));
  await W.buildAppealWorld(w);
  // M-B（E-B 的上级）同时持有绩效管理角色：利益冲突，不能收到升级提醒
  await w.patch("M-B", { adminRoleId: await w.role("PM", { performance: "manage" }) });
  await w.cover("Dept B", ["HB"]);
  Q = await w.runV2Cycle("2026Q4 SLA", { "E-A": "B", "E-B": "B" });
  await dayAt("2026-12-07T10:00:00");
  apB = await w.submitOk("E-B", Q.items["E-B"]);
  assert.equal((await (await w.as("HB")).post(`/api/admin/review-appeals/${apB}/start`, {})).status, 200);
});
after(async () => { if (w) await w.stop(); });

test("#1 slaDueOn for Monday 12-07 is 12-22 (Dec 8 is a holiday); the desk shows working days left", async () => {
  assert.equal(w.appealRow(Q.items["E-B"]).slaDueOn, "2026-12-22");
  assert.equal(w.appealRow(Q.items["E-B"]).windowDeadline, "2026-12-07");
  const row = (await (await w.as("HB")).get("/api/admin/review-appeals")).data.items.find((x) => x.id === apB);
  assert.equal(row.slaDueOn, "2026-12-22");
  assert.equal(row.overdue, false);
  assert.equal(row.workdaysLeft, 10);
});

test("#3 at 07:00 Manila nothing runs and the day marker is not set", async () => {
  await dayAt("2026-12-18T07:00:00");
  assert.notEqual(meta(), "2026-12-18");
  assert.equal(counts().HB, 0);
  assert.equal(w.appealRow(Q.items["E-B"]).remindSoonAt, null);
});

test("#2 at 08:30 on 12-18 one due-soon reminder to the handler; a second start the same day sends nothing more", async () => {
  await dayAt("2026-12-18T08:30:00");
  assert.equal(meta(), "2026-12-18");
  assert.equal(counts().HB, 1);
  const n = reminders("HB")[0];
  assert.match(n.title, /due soon/i);
  assert.match(n.body, /2026-12-22/);
  assert.match(n.body, /\b2\b/, "2 working days left");
  assert.ok(w.appealRow(Q.items["E-B"]).remindSoonAt);
  assert.equal(events("remind_soon").length, 1);
  assert.equal(events("remind_soon")[0].actorId, null);
  await dayAt("2026-12-18T09:30:00");
  assert.equal(counts().HB, 1, "no duplicate on restart");
  assert.equal(counts().SA + counts().PT + counts().AD, 0, "no escalation before the due date");
});

test("#4 Saturday 12-19 → nothing", async () => {
  await dayAt("2026-12-19T09:00:00");
  assert.equal(counts().HB, 1);
});

test("#5 12-23: overdue reminder to the handler plus one escalation to in-scope performance managers (SA, AD, PT) — not to PS (out of scope), the conflicted manager, or the employee", async () => {
  await dayAt("2026-12-23T09:00:00");
  const c = counts();
  assert.equal(c.HB, 2, "due-soon + first overdue");
  assert.deepEqual([c.SA, c.AD, c.PT], [1, 1, 1], JSON.stringify(c));
  assert.equal(c.PS, 0, "PS scope A, appellant in B");
  assert.equal(c.MB, 0, "conflicted (direct manager)");
  assert.equal(c.EB, 0, "the employee gets no SLA reminder");
  const od = reminders("HB").pop();
  assert.match(od.title, /overdue/i);
  assert.match(od.body, /2026-12-22/);
  assert.match(reminders("SA")[0].body, /Hank HrbpB/, "escalation names the handler");
  assert.equal(w.appealRow(Q.items["E-B"]).remindOverdueOn, "2026-12-23");
  assert.ok(w.appealRow(Q.items["E-B"]).escalatedAt);
  assert.equal(events("remind_overdue").length, 1);
  assert.equal(events("escalate").length, 1);
  const row = (await (await w.as("HB")).get("/api/admin/review-appeals")).data.items.find((x) => x.id === apB);
  assert.equal(row.overdue, true);
  assert.equal(row.overdueWorkdays, 1);
  assert.equal(row.status, "in_review");
});

test("#6 12-24 and 12-25 (holidays) → nothing; 2027-01-05 (4 working days later) → nothing", async () => {
  for (const d of ["2026-12-24T09:00:00", "2026-12-25T09:00:00", "2027-01-05T09:00:00"]) {
    await dayAt(d);
    assert.equal(counts().HB, 2, d);
  }
});

test("#7 2027-01-06 → the second overdue reminder, with no new escalation", async () => {
  await dayAt("2027-01-06T09:00:00");
  const c = counts();
  assert.equal(c.HB, 3);
  assert.deepEqual([c.SA, c.AD, c.PT], [1, 1, 1], "escalation only once");
  assert.equal(w.appealRow(Q.items["E-B"]).remindOverdueOn, "2027-01-06");
  assert.equal(events("remind_overdue").length, 2);
  assert.equal(events("escalate").length, 1);
});

test("#8 never auto-closed; performance off → no reminders; back on → exactly one catch-up reminder", async () => {
  w.writeConfig({ modules: { performance: false } });
  try {
    await dayAt("2027-01-13T09:00:00");
    assert.equal(counts().HB, 3, "module off");
  } finally { w.writeConfig(null); }
  await dayAt("2027-01-14T09:00:00");
  assert.equal(counts().HB, 4, "one catch-up reminder, not a burst");
  await dayAt("2027-01-14T15:00:00");
  assert.equal(counts().HB, 4);
  const row = w.appealRow(Q.items["E-B"]);
  assert.equal(row.status, "in_review", "overdue never changes state");
  assert.equal(row.decidedAt, null);
  assert.equal(w.audits("review.appeal.maintain").length + w.audits("review.appeal.adjust").length, 0, "reminders are not decisions");
});
