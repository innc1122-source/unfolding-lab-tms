// 2026-10-06 负责人定的培养项目五类活动：线上课程 / 线下课程（引用课程库，线上线下按课程 mode 现算）、
// 线上活动（新存储类型 online）、线下活动（offline）、结业考试（exam）；旧的 program（学习包）只读保留。
// 本文件覆盖线上活动的服务端：PUT 结构校验、学员端视图与 POST /api/me/tprojects/:id/complete、
// 讲师（我的授课）与 HR（完成登记）登记、阶段解锁、项目状态（进行中 / 收尾中才接受学员完成）、
// 与签到 / 出勤率的隔离、看板风险条目、删除保护，以及旧行为的回归。
// 负责人拍板：请假不算完成，需补课（负责人 2026-10-06；线下活动、线下课程同一口径，见 test/excused-not-done.test.js）；收尾中也接受学员完成；HR 可撤销学员本人的完成行；讲师不能给自己登记；
// 已创建的线上活动不能改完成方式（completion_locked）。
// 活动 id 全库唯一（activity_state 主键只有 activityId + userId），各项目的活动 id 刻意不重复；
// 线上 / 线下活动的这一点由 PUT 保证（id_in_use，见最后一个用例）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

const COURSE = "culture-conduct";
let srv, admin, pid, EXAM, PROGRAM;
let A, B, C;   // A、B = 本期学员（B 同时是 act-tr 的讲师）；C = 班主任（不是学员）

function cohorts() {
  return [{
    id: "co-1", name: "Cohort 1", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 10,
    classes: [{ id: "cl-1", name: "Class 1", headId: C.userId }],
    phases: [
      { id: "ph-1", name: "Phase 1", gateMode: "completion", activities: [
        { id: "act-click", type: "online", title: "Live", title_zh: "直播", url: "https://example.com/live", completion: "click", startAt: "2026-01-02T09:00", durationMin: 60 },
        { id: "act-self", type: "online", title: "Survey", url: "https://example.com/s", completion: "self", dueAt: "2026-02-01" },
        { id: "act-tr", type: "online", title: "Workshop", completion: "trainer", trainerId: B.userId, required: true },
        { id: "act-off", type: "offline", title: "Kickoff", startAt: "2026-01-02T09:00" },
      ] },
      { id: "ph-2", name: "Phase 2", gateMode: "completion", activities: [
        { id: "act-opt", type: "online", title: "Later", url: "https://example.com/l", completion: "self", required: false },
      ] },
      // 按时间开放、没写开始日期 = 立即开放：课程与考试活动放这里，不影响第 1 → 2 阶段的解锁
      { id: "ph-3", name: "Phase 3", gateMode: "time", activities: [
        { id: "act-course", type: "course", refId: COURSE },
        { id: "act-exam", type: "exam", refId: EXAM },
      ] },
    ],
  }];
}
// 拿夹具改一个活动（patch 为 null = 删掉它；带 id 的新活动用 extra 追加到第 1 阶段）
function withAct(id, patch, extra) {
  const cs = cohorts();
  const ph1 = cs[0].phases[0];
  for (const ph of cs[0].phases) {
    const i = ph.activities.findIndex((a) => a.id === id);
    if (i >= 0) { if (patch === null) ph.activities.splice(i, 1); else ph.activities[i] = { ...ph.activities[i], ...patch }; }
  }
  if (extra) ph1.activities.push(extra);
  return cs;
}
async function put(cs) { return admin.put("/api/admin/tprojects/" + pid, { cohorts: cs }); }
function assertBad(r, code, label) {
  assert.equal(r.status, 400, (label || code) + ": " + JSON.stringify(r.data));
  assert.equal(r.data.code, code, label || code);
  assert.ok(r.data.error && r.data.error_zh, (label || code) + " is bilingual");
}
function storedAct(doc, id) {
  for (const c of doc.cohorts || []) for (const ph of c.phases || []) for (const a of ph.activities || []) if (a.id === id) return a;
  return null;
}
async function myView(person) {
  const r = await person.c.get("/api/me/tprojects/" + pid);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const acts = {};
  for (const ph of r.data.phases) for (const a of ph.activities) acts[a.id] = a;
  return { data: r.data, acts, phase: (id) => r.data.phases.find((p) => p.id === id) };
}
const complete = (person, activityId, via, projectId) => person.c.post(`/api/me/tprojects/${projectId || pid}/complete`, { activityId, via });
const mark = (actId, userId, status, projectId) => admin.post(`/api/admin/tprojects/${projectId || pid}/checkin/${actId}/mark`, { userId, status });
function dbAll(sql, ...args) {
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

async function makeEmployee(i) {
  const id = "OLA-" + i;
  const { data: made } = await admin.post("/api/admin/employees", { name: "Online Activity " + i, employeeId: id });
  const c = await loginAs(srv.base, { employeeId: id, password: made.password });
  await c.post("/api/auth/change-password", { currentPassword: made.password, newPassword: "online-activity-1" });
  const userId = made.id || (await admin.get("/api/admin/employees")).data.find((u) => u.employeeId === id).id;
  return { c, userId, employeeId: id };
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const content = (await admin.get("/api/admin/content")).data;
  const course = content.courses.find((c) => c.id === COURSE);
  assert.ok(course, "seeded course present");
  // 先设成线下课：用来验「课程活动的分类按课程 mode 现算」；场次放在未来，不计入出勤率
  assert.equal((await admin.put("/api/admin/content/courses/" + COURSE, { ...course, mode: "offline", location: "Room 1", sessionAt: "2099-01-02T09:00" })).status, 200);
  PROGRAM = content.programs[0].id;
  EXAM = (await admin.get("/api/admin/exams")).data[0].id;
  A = await makeEmployee("A");
  B = await makeEmployee("B");
  C = await makeEmployee("C");
  pid = (await admin.post("/api/admin/tprojects", { title: "Online activities", title_zh: "线上活动" })).data.id;
  const r = await admin.put("/api/admin/tprojects/" + pid, { cohorts: cohorts(), status: "running" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-1", userIds: [A.userId], classId: "cl-1" })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-1", userIds: [B.userId] })).status, 200);
});
after(async () => { if (srv) await srv.stopAsync(); });

test("PUT validation: retired / unknown / missing types, type and completion locks, link, duration, title, dates", async () => {
  assertBad(await put(withAct("x", null, { id: "act-newprog", type: "program", refId: PROGRAM })), "type_retired", "new program activity");
  assertBad(await put(withAct("x", null, { id: "act-webinar", type: "webinar", title: "W" })), "type_retired", "unknown type");
  assertBad(await put(withAct("x", null, { id: "act-notype", title: "No type" })), "bad_activity", "missing type");
  assertBad(await put(withAct("x", null, { id: "act-numtype", type: 3, title: "Numeric type" })), "bad_activity", "non-string type");
  assertBad(await put(withAct("x", null, { type: "online", title: "No id", completion: "self" })), "bad_activity", "missing id");
  const locked = await put(withAct("act-off", { type: "online", completion: "self" }));
  assertBad(locked, "type_locked");
  assert.match(locked.data.error, /Kickoff/, "the message names the activity");
  // D10：已创建的线上活动不能改完成方式
  assertBad(await put(withAct("act-tr", { completion: "self" })), "completion_locked", "trainer → self");
  assertBad(await put(withAct("act-click", { completion: "trainer" })), "completion_locked", "click → trainer");
  const online = (patch) => withAct("x", null, { id: "act-new", type: "online", title: "New", completion: "self", ...patch });
  assertBad(await put(online({ url: "javascript:alert(1)" })), "bad_url", "javascript: link");
  assertBad(await put(online({ url: "data:text/html,<b>x</b>" })), "bad_url", "data: link");
  assertBad(await put(online({ url: "https://example.com/" + "x".repeat(2000) })), "bad_url", "over 2000 chars");
  assertBad(await put(online({ completion: "click", url: "" })), "url_required", "click without link");
  assertBad(await put(online({ completion: "x" })), "bad_completion");
  assertBad(await put(online({ durationMin: 0 })), "bad_duration", "duration 0");
  assertBad(await put(online({ durationMin: 2000 })), "bad_duration", "duration 2000");
  assertBad(await put(online({ durationMin: 1.5 })), "bad_duration", "duration 1.5");
  assertBad(await put(online({ title: "  ", title_zh: "" })), "title_required");
  assertBad(await put(online({ startAt: "2026-01-02 09:00" })), "bad_datetime");
  assertBad(await put(online({ dueAt: "02/01/2026" })), "bad_dates");
  // 失败的 PUT 一个字都没存
  let doc = (await admin.get("/api/admin/tprojects/" + pid)).data;
  assert.equal(storedAct(doc, "act-new"), null);
  assert.equal(storedAct(doc, "act-off").type, "offline");
  assert.equal(storedAct(doc, "act-tr").completion, "trainer");

  // 规整：线上活动带的 refId / location 被删掉，非讲师登记方式的 trainerId 清空，时长字符串存成数字，
  // 已有线上活动没传完成方式时沿用原来的
  const ok = await put(withAct("act-self", { refId: PROGRAM, location: "Room 9", trainerId: B.userId }, null)
    .map((c) => ({ ...c, phases: c.phases.map((ph) => ({ ...ph, activities: ph.activities.map((a) => {
      if (a.id === "act-click") return { ...a, durationMin: "60" };
      if (a.id === "act-tr") { const { completion, ...rest } = a; return rest; }
      return a;
    }) })) })));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  doc = (await admin.get("/api/admin/tprojects/" + pid)).data;
  const self = storedAct(doc, "act-self");
  assert.ok(!("refId" in self) && !("location" in self), "refId / location stripped from an online activity");
  assert.equal(self.trainerId, null, "trainerId nulled on a self-mode activity");
  assert.equal(storedAct(doc, "act-click").durationMin, 60, "duration stored as a Number");
  assert.equal(storedAct(doc, "act-tr").completion, "trainer", "a missing completion keeps the stored one");
  assert.equal(storedAct(doc, "act-tr").trainerId, B.userId);
  // 课程 / 考试 / 线下活动的旧形状照常通过（没有 title、没有 required）
  assert.equal(storedAct(doc, "act-course").refId, COURSE);
  // 恢复夹具
  assert.equal((await put(cohorts())).status, 200);
});

test("a stored legacy program activity round-trips through PUT, but can't change type or be added anew", async () => {
  const lid = (await admin.post("/api/admin/tprojects", { title: "Legacy package" })).data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + lid, {
    cohorts: [{ id: "co-lg", name: "LG", classes: [], phases: [{ id: "ph-lg", name: "P", activities: [{ id: "lg-off", type: "offline", title: "Kick" }] }] }],
  })).status, 200);
  // PUT 已不能新建 program 活动，只能直接写库造一份旧文档（服务端靠 data_version 发现外部写入）
  const db = new DatabaseSync(srv.dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.prepare("SELECT json FROM content WHERE kind = 'tproject' AND id = ?").get(lid);
    const raw = JSON.parse(row.json);
    raw.cohorts[0].phases[0].activities.push({ id: "lg-prog", type: "program", refId: PROGRAM, required: true });
    db.prepare("UPDATE content SET json = ? WHERE kind = 'tproject' AND id = ?").run(JSON.stringify(raw), lid);
  } finally { db.close(); }
  const doc = (await admin.get("/api/admin/tprojects/" + lid)).data;
  assert.equal(storedAct(doc, "lg-prog").type, "program", "the server picked up the direct write");
  assert.ok(doc.actStats["lg-prog"], "the legacy activity is still counted");
  const rt = await admin.put("/api/admin/tprojects/" + lid, { cohorts: doc.cohorts });
  assert.equal(rt.status, 200, "round-trip: " + JSON.stringify(rt.data));
  assert.equal(storedAct((await admin.get("/api/admin/tprojects/" + lid)).data, "lg-prog").type, "program");
  const changed = JSON.parse(JSON.stringify(doc.cohorts));
  changed[0].phases[0].activities.find((a) => a.id === "lg-prog").type = "course";
  assertBad(await admin.put("/api/admin/tprojects/" + lid, { cohorts: changed }), "type_locked", "legacy program → course");
  const added = JSON.parse(JSON.stringify(doc.cohorts));
  added[0].phases[0].activities.push({ id: "lg-prog2", type: "program", refId: PROGRAM });
  assertBad(await admin.put("/api/admin/tprojects/" + lid, { cohorts: added }), "type_retired", "a second program activity");
});

test("learner view: category, link, duration and completion; course category follows the course mode; locked phases withhold the link", async () => {
  let v = await myView(A);
  const click = v.acts["act-click"];
  assert.equal(click.category, "online_activity");
  assert.equal(click.url, "https://example.com/live");
  assert.equal(click.durationMin, 60);
  assert.equal(click.completion, "click");
  assert.ok(!click.refId, "no refId");
  assert.equal(click.progressPercent, undefined, "no progressPercent for an online activity");
  assert.equal(v.acts["act-tr"].completion, "trainer");
  assert.equal(v.acts["act-off"].category, "offline_activity");
  assert.equal(v.acts["act-exam"].category, "exam");
  assert.equal(v.acts["act-course"].category, "offline_course");
  assert.equal(v.phase("ph-2").unlocked, false);
  assert.equal(v.acts["act-opt"].url, null, "a locked phase does not hand out the link");
  const list = (await A.c.get("/api/me/tprojects")).data.mine.find((p) => p.id === pid);
  assert.equal(list.nextActivity.category, "online_activity", "nextActivity carries the activity category");
  // 课程改成线上 → 同一活动现算为线上课程（负责人接受分类随课程 mode 变）
  const course = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === COURSE);
  assert.equal((await admin.put("/api/admin/content/courses/" + COURSE, { ...course, mode: "online" })).status, 200);
  v = await myView(A);
  assert.equal(v.acts["act-course"].category, "online_course");
});

test("click mode: opening the link completes it, idempotently; the other way is refused", async () => {
  const r = await complete(A, "act-click", "click");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "completed");
  const again = await complete(A, "act-click", "click");
  assert.equal(again.status, 200);
  assert.equal(again.data.status, "completed");
  assert.equal((await admin.get("/api/admin/tprojects/" + pid)).data.actStats["act-click"].done, 1);
  const wrong = await complete(A, "act-click", "self");
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.code, "mode_mismatch");
  assert.ok(wrong.data.error_zh);
  const off = await complete(A, "act-off", "self");
  assert.equal(off.status, 404, "an offline activity is not completed this way");
  assert.equal(off.data.code, "not_found");
  assert.ok(off.data.error_zh);
  assert.equal((await complete(A, "act-nope", "click")).status, 404);
  const row = dbAll("SELECT * FROM activity_state WHERE activityId = 'act-click' AND userId = ?", A.userId)[0];
  assert.equal(row.projectId, pid);
  assert.equal(row.by, A.userId);
  assert.equal(row.note, "click");
});

test("self mode: done only after the learner confirms; non-members and draft projects get 404", async () => {
  assert.equal((await myView(A)).acts["act-self"].done, false);
  const r = await complete(A, "act-self", "self");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await myView(A)).acts["act-self"].done, true);
  const outsider = await complete(C, "act-self", "self");
  assert.equal(outsider.status, 404);
  assert.equal(outsider.data.code, "not_found");
  assert.ok(outsider.data.error_zh);
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { status: "draft" })).status, 200);
  try {
    const draft = await complete(A, "act-self", "self");
    assert.equal(draft.status, 404);
    assert.equal(draft.data.code, "not_found");
  } finally {
    assert.equal((await admin.put("/api/admin/tprojects/" + pid, { status: "running" })).status, 200);
  }
});

test("trainer mode, learner side: the learner can't complete it", async () => {
  for (const via of ["trainer", "self", "click"]) {
    const r = await complete(A, "act-tr", via);
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "trainer_only");
    assert.ok(r.data.error_zh);
  }
});

test("trainer mode, trainer side: My Sessions lists it with a completion roster; the trainer marks others but not themself", async () => {
  const key = `a.${pid}.co-1.act-tr`;
  const sessions = (await B.c.get("/api/me/sessions")).data.sessions;
  const s = sessions.find((x) => x.key === key);
  assert.ok(s, "the trainer-mode online activity is a session");
  assert.equal(s.category, "online_activity");
  assert.equal(s.completion, "trainer");
  assert.equal(s.mode, "online");
  assert.deepEqual(sessions.map((x) => x.key), [key], "click / self activities and non-roster activities are not sessions");
  assert.equal((await B.c.get("/api/me/roles")).data.trainer, true);
  const roll = await B.c.get(`/api/me/sessions/${encodeURIComponent(key)}/checkin`);
  assert.equal(roll.status, 200, JSON.stringify(roll.data));
  assert.equal(roll.data.rollKind, "completion");
  assert.equal(roll.data.code, null);
  assert.equal(roll.data.checkinOpen, false);
  assert.deepEqual(roll.data.stats, { completed: 0, excused: 0, missing: 2, attended: 0, late: 0 });
  const bad = await B.c.post(`/api/me/sessions/${encodeURIComponent(key)}/checkin/mark`, { userId: A.userId, status: "absent" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "bad_status");
  assert.ok(bad.data.error_zh);
  // D11：讲师本人也是本期学员，不能给自己登记
  const mine = await B.c.post(`/api/me/sessions/${encodeURIComponent(key)}/checkin/mark`, { userId: B.userId, status: "completed" });
  assert.equal(mine.status, 403);
  assert.equal(mine.data.code, "self_mark");
  assert.ok(mine.data.error_zh);
  const ok = await B.c.post(`/api/me/sessions/${encodeURIComponent(key)}/checkin/mark`, { userId: A.userId, status: "completed" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await myView(A)).acts["act-tr"].done, true);
  assert.equal((await myView(B)).acts["act-tr"].done, false);
  assert.ok(JSON.stringify((await admin.get("/api/admin/audit")).data).includes("trainer.activity.mark"));
  // 讲师会话路由对非讲师登记方式的线上活动仍是 404
  assert.equal((await B.c.get(`/api/me/sessions/${encodeURIComponent(`a.${pid}.co-1.act-click`)}/checkin`)).status, 404);
});

test("trainer mode, admin side: completion roster, mark and undo — including a learner's own click row", async () => {
  const roll = await admin.get(`/api/admin/tprojects/${pid}/checkin/act-tr`);
  assert.equal(roll.status, 200, JSON.stringify(roll.data));
  assert.equal(roll.data.rollKind, "completion");
  assert.equal(roll.data.completion, "trainer");
  assert.equal(roll.data.code, null);
  assert.equal(roll.data.checkinOpen, false);
  assert.equal(roll.data.projectStatus, "running");
  assert.deepEqual(roll.data.stats, { completed: 1, excused: 0, missing: 1, attended: 0, late: 0 });
  assert.equal(roll.data.list.find((x) => x.userId === A.userId).self, false, "marked by the trainer");
  const bad = await mark("act-tr", A.userId, "absent");
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "bad_status");
  assert.ok(bad.data.error_zh);
  // 撤销讲师登记的行
  assert.equal((await mark("act-tr", A.userId, "clear")).status, 200);
  assert.equal((await admin.get(`/api/admin/tprojects/${pid}/checkin/act-tr`)).data.list.find((x) => x.userId === A.userId).status, null);
  // 「补签」发的 attended 记为 completed；请假不算完成（负责人 2026-10-06）
  assert.equal((await mark("act-tr", B.userId, "attended")).status, 200);
  assert.equal((await admin.get(`/api/admin/tprojects/${pid}/checkin/act-tr`)).data.list.find((x) => x.userId === B.userId).status, "completed");
  assert.equal((await mark("act-tr", B.userId, "excused")).status, 200);
  assert.equal((await myView(B)).acts["act-tr"].done, false, "excused does not count as done for an online activity");
  assert.equal((await myView(B)).acts["act-tr"].state, "excused", "the learner page still shows 已请假");
  assert.equal((await mark("act-tr", B.userId, "clear")).status, 200);
  assert.equal((await myView(B)).acts["act-tr"].done, false);
  // D3：学员自己打开链接的行，HR 可以撤销（线下的自助签到仍不可撤）
  const clickRoll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-click`)).data;
  assert.equal(clickRoll.rollKind, "completion");
  assert.equal(clickRoll.list.find((x) => x.userId === A.userId).self, true);
  assert.equal((await mark("act-click", A.userId, "clear")).status, 200);
  assert.equal((await myView(A)).acts["act-click"].done, false);
  assert.equal((await complete(A, "act-click", "click")).status, 200, "the learner can open the link again");
  const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
  assert.ok(audit.includes("tproject.activity.mark"), "mark audited");
  assert.ok(audit.includes("tproject.activity.unmark"), "undo audited");
});

test("gating: a required online activity holds the next phase until done; optional ones don't; progress counts them", async () => {
  assert.equal((await mark("act-off", A.userId, "attended")).status, 200);
  let v = await myView(A);
  for (const id of ["act-click", "act-self", "act-off"]) assert.equal(v.acts[id].done, true, id);
  assert.equal(v.acts["act-tr"].done, false);
  assert.equal(v.phase("ph-2").unlocked, false);
  const locked = await complete(A, "act-opt", "self");
  assert.equal(locked.status, 409);
  assert.equal(locked.data.code, "phase_locked");
  assert.ok(locked.data.error_zh);
  assert.equal((await mark("act-tr", A.userId, "completed")).status, 200);
  v = await myView(A);
  assert.equal(v.phase("ph-1").complete, true);
  assert.equal(v.phase("ph-2").unlocked, true);
  assert.equal(v.acts["act-opt"].url, "https://example.com/l", "the link appears once the phase opens");
  assert.equal(v.phase("ph-2").complete, true, "an optional activity does not hold its phase");
  // 必修 6 个（act-click / act-self / act-tr / act-off / act-course / act-exam），已完成 4 个
  assert.equal(v.data.progress, 67);
  assert.equal((await complete(A, "act-opt", "self")).status, 200);
  assert.equal((await myView(A)).data.progress, 67, "optional activities don't move progress");
  const doc = (await admin.get("/api/admin/tprojects/" + pid)).data;
  const pA = doc.members.find((m) => m.userId === A.userId).progress;
  const pB = doc.members.find((m) => m.userId === B.userId).progress;
  assert.equal(pA, 67);
  assert.equal((await A.c.get("/api/me/tprojects")).data.mine.find((p) => p.id === pid).progress, 67);
  const dash = (await admin.get(`/api/admin/tprojects/${pid}/dashboard`)).data;
  assert.equal(dash.progressAvg, Math.round((pA + pB) / 2));
  assert.equal(doc.actStats["act-tr"].done, 1);
  assert.equal(doc.actStats["act-opt"].done, 1);
});

test("status gate: learners complete while running or closing, not while planning; staff marks work in any status", async () => {
  assert.equal((await mark("act-opt", A.userId, "clear")).status, 200);
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { status: "planning" })).status, 200);
  try {
    const r = await complete(A, "act-opt", "self");
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "not_running");
    assert.ok(r.data.error_zh);
    assert.equal((await mark("act-tr", B.userId, "excused")).status, 200, "staff marks still accepted");
    assert.equal((await mark("act-tr", B.userId, "clear")).status, 200);
    assert.equal((await admin.put("/api/admin/tprojects/" + pid, { status: "closing" })).status, 200);
    const closing = await complete(A, "act-opt", "self");
    assert.equal(closing.status, 200, "wrapping up still accepts completion: " + JSON.stringify(closing.data));
  } finally {
    assert.equal((await admin.put("/api/admin/tprojects/" + pid, { status: "running" })).status, 200);
  }
});

test("online activities stay out of check-in: no learner code check-in, no class-head roll, not in the attendance rate", async () => {
  const dash = (await admin.get(`/api/admin/tprojects/${pid}/dashboard`)).data;
  // 只有 act-off 计出勤：A 已签到、B 未签到 → 1/2
  assert.equal(dash.attendance, 50);
  const ck = await A.c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "act-click", code: "000000" });
  assert.equal(ck.status, 404);
  assert.equal((await C.c.get(`/api/me/classes/${pid}/checkin/act-off`)).status, 200, "the class head rolls the offline activity");
  assert.equal((await C.c.get(`/api/me/classes/${pid}/checkin/act-click`)).status, 404, "but not an online activity");
  assert.equal((await C.c.post(`/api/me/classes/${pid}/checkin/act-click/mark`, { userId: A.userId, status: "attended" })).status, 404);
  const off = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-off`)).data;
  assert.equal(off.rollKind, "checkin");
  assert.equal(typeof off.code, "string");
});

test("dashboard risks: overdue required online activities, by due date or else start date, with names and category", async () => {
  const risks = (await admin.get(`/api/admin/tprojects/${pid}/dashboard`)).data.risks;
  const mineB = risks.filter((r) => r.employeeId === B.employeeId);
  const click = mineB.find((r) => r.activityId === "act-click");
  assert.ok(click, JSON.stringify(risks));
  assert.equal(click.item, "Live");
  assert.equal(click.item_zh, "直播");
  assert.equal(click.category, "online_activity");
  assert.equal(click.dueAt, "2026-01-02", "no due date → the start date");
  const self = mineB.find((r) => r.activityId === "act-self");
  assert.ok(self);
  assert.equal(self.item, "Survey");
  assert.equal(self.dueAt, "2026-02-01");
  assert.ok(!mineB.some((r) => r.activityId === "act-tr"), "no due date and no start date → never overdue");
  assert.ok(!risks.some((r) => r.employeeId === A.employeeId && r.activityId === "act-click"), "done activities are not risks");
  assert.ok(!risks.some((r) => r.activityId === "act-opt"), "optional activities are not risks");
  for (const r of risks) assert.ok(!["course", "exam", "online", "offline"].includes(r.item), "no raw type keyword leaks");
});

test("excused is not done for an online activity (owner 2026-10-06): no progress, not a risk, and the learner can still complete it", async () => {
  assert.equal((await myView(B)).acts["act-self"].done, false);
  assert.equal((await mark("act-self", B.userId, "excused")).status, 200);
  let v = (await myView(B)).acts["act-self"];
  assert.equal(v.done, false, "excused stays not done");
  assert.equal(v.state, "excused");
  const risks = (await admin.get(`/api/admin/tprojects/${pid}/dashboard`)).data.risks;
  assert.ok(!risks.some((r) => r.employeeId === B.employeeId && r.activityId === "act-self"), "an excused learner is not listed as a risk");
  const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-self`)).data;
  assert.equal(roll.list.find((x) => x.userId === B.userId).status, "excused");
  // 学员之后自己完成：覆盖请假
  const r = await complete(B, "act-self", "self");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "completed");
  v = (await myView(B)).acts["act-self"];
  assert.equal(v.done, true);
  assert.equal((await mark("act-self", B.userId, "clear")).status, 200);
});

test("delete guard: an online completion row is history", async () => {
  const did = (await admin.post("/api/admin/tprojects", { title: "Delete guard" })).data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + did, {
    status: "running",
    cohorts: [{ id: "co-dg", name: "DG", classes: [], phases: [{ id: "ph-dg", name: "P", activities: [
      { id: "dg-online", type: "online", title: "Recording", url: "https://example.com/rec", completion: "click" },
    ] }] }],
  })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${did}/members`, { cohortId: "co-dg", userIds: [A.userId] })).status, 200);
  assert.equal((await complete(A, "dg-online", "click", did)).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${did}/members/update`, { userId: A.userId, action: "withdraw" })).status, 200);
  const del = await admin.del("/api/admin/tprojects/" + did);
  assert.equal(del.status, 400, JSON.stringify(del.data));
  assert.equal(del.data.code, "has_history");
  assert.equal(del.data.learners, 0);
  assert.equal(del.data.attendance, 1);
  assert.ok(del.data.error_zh);
});

test("regression: online courses and exams still have no roster, and marking them no longer writes a stray row", async () => {
  for (const act of ["act-course", "act-exam"]) {
    const g = await admin.get(`/api/admin/tprojects/${pid}/checkin/${act}`);
    assert.equal(g.status, 404, act);
    assert.ok(g.data.error_zh);
    const m = await mark(act, A.userId, "attended");
    assert.equal(m.status, 404, act);
    assert.equal(dbAll("SELECT COUNT(*) AS n FROM activity_state WHERE activityId = ?", act)[0].n, 0, act + ": nothing written");
  }
  // 考试活动的完成仍然只看考试是否通过
  const v = await myView(A);
  assert.equal(v.acts["act-exam"].done, false);
  assert.equal(v.acts["act-exam"].examPassed, false);
  assert.equal((await admin.get("/api/admin/tprojects/" + pid)).data.actStats["act-exam"].done, 0);
});

test("activity ids: a new online or in-person activity can't take an id another program uses, a duplicate, or one that still holds records", async () => {
  const oid = (await admin.post("/api/admin/tprojects", { title: "Id reuse" })).data.id;
  const one = (acts) => admin.put("/api/admin/tprojects/" + oid, { cohorts: [{ id: "co-id", name: "ID", classes: [], phases: [{ id: "ph-id", name: "P", activities: acts }] }] });
  // 跨项目复用：pid 的 act-click 已有学员的完成行；继承别人的完成、或被 tpSetCompletion 搬走都不允许
  const reuse = await one([{ id: "act-click", type: "online", title: "Copy", url: "https://example.com/c", completion: "click" }]);
  assertBad(reuse, "id_in_use", "online id used by another program");
  assert.match(reuse.data.error, /Copy/, "the message names the activity");
  assertBad(await one([{ id: "act-tr", type: "offline", title: "Copy" }]), "id_in_use", "in-person id used by another program");
  assertBad(await one([
    { id: "id-dup", type: "online", title: "One", completion: "self" },
    { id: "id-dup", type: "online", title: "Two", completion: "self" },
  ]), "id_in_use", "the same new id twice in one save");
  // 课程 / 考试活动不读活动行，同 id 不拦
  assert.equal((await one([{ id: "act-course", type: "course", refId: COURSE }])).status, 200);
  // 删掉再以同 id 加回（两次保存绕过 type_locked / completion_locked）：留有记录的 id 不能再用
  const rec = { id: "id-rec", type: "online", title: "Recording", url: "https://example.com/r", completion: "self" };
  assert.equal((await one([rec])).status, 200, "a fresh id is fine");
  assert.equal((await admin.post(`/api/admin/tprojects/${oid}/members`, { cohortId: "co-id", userIds: [A.userId] })).status, 200);
  assert.equal((await mark("id-rec", A.userId, "completed", oid)).status, 200);
  assert.equal((await one([])).status, 200, "removing it is allowed");
  assertBad(await one([{ ...rec, type: "offline" }]), "id_in_use", "re-added as an in-person activity");
  assertBad(await one([{ ...rec, completion: "click" }]), "id_in_use", "re-added with another completion method");
  const rows = dbAll("SELECT projectId, status FROM activity_state WHERE activityId = 'id-rec'");
  assert.deepEqual(rows.map((r) => [r.projectId, r.status]), [[oid, "completed"]], "the record is untouched");
  // 原项目照常保存（已有活动不受影响）
  assert.equal((await put(cohorts())).status, 200);
});
