// 2026-10-06 负责人：「线下活动和线下课程一样，都需要签到码」。
// 培养项目里引用线下课程的课程活动，与线下活动一样可在项目里生成签到码、看本期名单、补签与撤销；
// 签到码与出勤记录沿用该课程自己的（course:<id>），所以课程页的码与项目里的码是同一个，
// 学员在任一边签到都记在课程出勤上，并计入项目活动的完成。
// 同日负责人又定：培养项目「进行中」才允许签到 —— 其他状态不出签到码、学员输码被拒，名单与补签照常。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");
// CX-078（10/11）：员工输码签到只在活动当天开放 —— 签到用例的活动时间取「今天」（马尼拉日）：00:00 测迟到、23:59 测准时
const TODAY_YMD = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const TODAY_EARLY = TODAY_YMD + "T00:00", TODAY_LATE = TODAY_YMD + "T23:59";

const COURSE = "culture-conduct";
let srv, admin, pid;
const people = [];

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const content = await admin.get("/api/admin/content");
  const course = content.data.courses.find((c) => c.id === COURSE);
  assert.ok(course, "seeded course present");
  assert.equal((await admin.put("/api/admin/content/courses/" + COURSE, { ...course, mode: "offline", location: "Room 1", sessionAt: TODAY_EARLY })).status, 200);
  const created = await admin.post("/api/admin/tprojects", { title: "Offline course check-in", title_zh: "线下课程签到" });
  pid = created.data.id;
  const cohorts = [{
    id: "co-oc", name: "Cohort", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 10, classes: [],
    phases: [{ id: "ph-1", name: "Phase 1", activities: [
      { id: "act-oc", type: "course", refId: COURSE, title: "In-person course" },
      { id: "act-off", type: "offline", title: "Kickoff", startAt: TODAY_EARLY },
    ] }],
  }];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts, status: "running" })).status, 200);
  for (let i = 0; i < 2; i++) {
    const id = "OCK-" + i;
    const { data: made } = await admin.post("/api/admin/employees", { name: "Offline Course " + i, employeeId: id });
    const c = await loginAs(srv.base, { employeeId: id, password: made.password });
    await c.post("/api/auth/change-password", { currentPassword: made.password, newPassword: "offline-course-1" });
    const userId = made.id || (await admin.get("/api/admin/employees")).data.find((u) => u.employeeId === id).id;
    people.push({ c, userId });
  }
  const added = await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-oc", userIds: people.map((p) => p.userId) });
  assert.equal(added.status, 200, JSON.stringify(added.data));
});
after(async () => { if (srv) await srv.stopAsync(); });

test("catalog tells the project page which courses are in-person", async () => {
  const cat = (await admin.get("/api/admin/catalog")).data;
  assert.equal(cat.courses.find((c) => c.id === COURSE).mode, "offline");
});

test("a course activity that references an in-person course has a project roll-call whose code is the course's own code", async () => {
  // 两次请求可能跨过整分钟换码：取不一致时重取一次
  let p, c;
  for (let i = 0; i < 2; i++) {
    p = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-oc`));
    c = (await admin.get(`/api/admin/courses/${COURSE}/checkin`));
    if (p.data.code === c.data.code) break;
  }
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.code, c.data.code, "one code for the course page and the project");
  assert.deepEqual(p.data.list.map((x) => x.userId).sort(), people.map((x) => x.userId).sort(), "roster = this cohort's learners");
  assert.equal(p.data.stats.missing, 2);
});

test("a learner checking in from the project is recorded on the course attendance and completes the activity", async () => {
  const code = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-oc`)).data.code;
  const r = await people[0].c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "act-oc", code });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const course = (await admin.get(`/api/admin/courses/${COURSE}/checkin`)).data;
  const row = course.list.find((x) => x.userId === people[0].userId);
  if (row) assert.ok(["attended", "late"].includes(row.status), "course roll-call shows the project check-in");
  const doc = (await admin.get(`/api/admin/tprojects/${pid}`)).data;
  assert.equal(doc.actStats["act-oc"].done, 1, "attendance on an in-person course is completion");
  const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-oc`)).data;
  assert.ok(["attended", "late"].includes(roll.list.find((x) => x.userId === people[0].userId).status));
  assert.equal(roll.list.find((x) => x.userId === people[0].userId).self, true, "self check-in is marked as such");
});

test("staff make-up check-in and undo from the project write to the course attendance", async () => {
  const uid = people[1].userId;
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/checkin/act-oc/mark`, { userId: uid, status: "attended" })).status, 200);
  let roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-oc`)).data;
  assert.equal(roll.list.find((x) => x.userId === uid).status, "attended");
  assert.equal((await admin.get(`/api/admin/tprojects/${pid}`)).data.actStats["act-oc"].done, 2);
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/checkin/act-oc/mark`, { userId: uid, status: "clear" })).status, 200);
  roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-oc`)).data;
  assert.equal(roll.list.find((x) => x.userId === uid).status, null, "undo removes the course attendance row");
  // 学员自己输码签到的那一行不能被撤销（与线下活动同一规则）
  const self = await admin.post(`/api/admin/tprojects/${pid}/checkin/act-oc/mark`, { userId: people[0].userId, status: "clear" });
  assert.equal(self.status, 409);
});

test("check-in is only open while the program is in progress: no code and no self check-in otherwise; staff make-ups still work", async () => {
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { status: "planning" })).status, 200);
  try {
    for (const act of ["act-oc", "act-off"]) {
      const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/${act}`)).data;
      assert.equal(roll.code, null, act + ": no code while planning");
      assert.equal(roll.checkinOpen, false);
      assert.equal(roll.projectStatus, "planning");
      assert.equal(roll.list.length, 2, "the list is still there");
    }
    const r = await people[1].c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "act-off", code: "000000" });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "not_running");
    assert.equal((await admin.post(`/api/admin/tprojects/${pid}/checkin/act-off/mark`, { userId: people[1].userId, status: "excused" })).status, 200, "make-up / leave still recorded");
  } finally {
    assert.equal((await admin.put("/api/admin/tprojects/" + pid, { status: "running" })).status, 200);
  }
  assert.equal(typeof (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-off`)).data.code, "string", "code is back once running");
});

test("plain offline activities keep their own code; online course activities still have no roll-call", async () => {
  const off = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-off`)).data;
  const oc = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-oc`)).data;
  assert.notEqual(off.code, oc.code, "different sessions, different codes");
  const content = await admin.get("/api/admin/content");
  const course = content.data.courses.find((c) => c.id === COURSE);
  assert.equal((await admin.put("/api/admin/content/courses/" + COURSE, { ...course, mode: "online" })).status, 200);
  assert.equal((await admin.get(`/api/admin/tprojects/${pid}/checkin/act-oc`)).status, 404);
});
