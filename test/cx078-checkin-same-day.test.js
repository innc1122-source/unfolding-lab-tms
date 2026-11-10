// 上线前测试 CX-078（负责人 2026-10-11「只在当天」）：员工输码签到只在活动当天（马尼拉日）开放。
// 发展项目的线下活动与线下课程两个入口都按活动日期判；不在当天回 409 checkin_not_today（带活动日期）；
// 讲师 / HR 登记出勤不受影响（补签照旧）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

const ymd = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);   // 马尼拉日
const TODAY = ymd(Date.now()), TOMORROW = ymd(Date.now() + 86400e3);
const COURSE = "culture-conduct";
let srv, admin, pid, learner;

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const created = await admin.post("/api/admin/tprojects", { title: "Same-day check-in", title_zh: "当天签到" });
  pid = created.data.id;
  const cohorts = [{
    id: "sd-co", name: "Cohort", startAt: "2026-01-01", endAt: "2099-12-31", capacity: 10, classes: [],
    phases: [{ id: "sd-ph", name: "Phase", activities: [
      { id: "sd-today", type: "offline", title: "Today", startAt: TODAY + "T23:59" },
      { id: "sd-tomorrow", type: "offline", title: "Tomorrow", startAt: TOMORROW + "T09:00" },
    ] }],
  }];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts, status: "running" })).status, 200);
  const { data: made } = await admin.post("/api/admin/employees", { name: "Same Day", employeeId: "SD-1" });
  const c = await loginAs(srv.base, { employeeId: "SD-1", password: made.password });
  await c.post("/api/auth/change-password", { currentPassword: made.password, newPassword: "same-day-1a" });
  const userId = made.id || (await admin.get("/api/admin/employees")).data.find((u) => u.employeeId === "SD-1").id;
  learner = { c, userId };
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "sd-co", userIds: [userId] })).status, 200);
});
after(async () => { if (srv) await srv.stopAsync(); });

const codeOf = async (act) => (await admin.get(`/api/admin/tprojects/${pid}/checkin/${act}`)).data.code;
async function selfCheckin(act) {
  let r;
  for (let i = 0; i < 2; i++) {   // 码按整分钟换：跨分钟时重取一次
    r = await learner.c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: act, code: await codeOf(act) });
    if (r.status !== 400) break;
  }
  return r;
}

test("CX-078: a learner can check in with the code on the day of the activity", async () => {
  const r = await selfCheckin("sd-today");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "attended");
});

test("CX-078: the day before, the right code is refused with checkin_not_today and the session date; nothing is written", async () => {
  const r = await selfCheckin("sd-tomorrow");
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, "checkin_not_today");
  assert.equal(r.data.sessionDay, TOMORROW);
  assert.match(r.data.error_zh, /签到只在活动当天开放/);
  const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/sd-tomorrow`)).data;
  const row = (roll.roster || roll.rows || roll.members || []).find((x) => x.userId === learner.userId || x.id === learner.userId);
  assert.ok(!row || !row.status || row.status === "none" || row.status === null, "no attendance recorded: " + JSON.stringify(row));
});

test("CX-078: staff can still record attendance for an activity on another day (make-up records are unaffected)", async () => {
  const r = await admin.post(`/api/admin/tprojects/${pid}/checkin/sd-tomorrow/mark`, { userId: learner.userId, status: "attended" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test("CX-078: the in-person course page uses the same rule (session on another day → checkin_not_today)", async () => {
  const content = await admin.get("/api/admin/content");
  const course = content.data.courses.find((c) => c.id === COURSE);
  assert.equal((await admin.put("/api/admin/content/courses/" + COURSE, { ...course, mode: "offline", location: "Room 1", sessionAt: TOMORROW + "T09:00" })).status, 200);
  const code = (await admin.get(`/api/admin/courses/${COURSE}/checkin`)).data.code;
  const r = await admin.post(`/api/courses/${COURSE}/checkin`, { code });
  // 管理员本人也能访问该课程；不在当天就拒绝（不论码对不对，日期先判）
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(r.data.code, "checkin_not_today");
});
