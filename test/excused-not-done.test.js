// 请假需补课（负责人 2026-10-06，F1–F5）：请假（excused）一律不算完成 —— 线下活动、线下课程（出勤记在
// course:<id>）、线上活动同一口径。
//   F1 完成只认出席 / 迟到（线上活动只认 completed）：请假不计进度、按完成解锁的下一阶段不开、线下课程不算学完
//      （我的课程、学习记录、总览完成数），挂在课程上的考试不解锁。
//   F2 出勤率不变：请假仍不进分母（与「完成」分开算）。
//   F3 看板风险：已登记请假的条目不列（线下 / 线上一样，HR 已知情）。
//   F4 补课登记：HR（单条、批量）、讲师（我的授课）、班主任可把「请假」直接改为出席 / 完成，不必先撤销；
//      批量里其他不同的登记仍 already_marked。
//   F5 学员之后自己输码签到（项目线下活动、项目里的线下课程活动、课程页签到）覆盖请假，记为本人签到。
// 夹具：线下课程 CX（无考试，被项目活动 xn-oc 引用，讲师 = TR）、线下课程 CE（有考试，直接指派给 L11）；
// 项目 1 期 1 班（班主任 HEAD），第 1 阶段 xn-off / xn-oc / xn-on（线上、讲师登记，讲师 TR）三项必修，
// 截止 2026-01-05（已逾期）；第 2 阶段按完成解锁，只有 xn-next（线上、学员自行确认）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");
// CX-078（10/11）：员工输码签到只在活动当天开放 —— 签到用例的活动时间取「今天」（马尼拉日）：00:00 测迟到、23:59 测准时
const TODAY_YMD = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const TODAY_EARLY = TODAY_YMD + "T00:00", TODAY_LATE = TODAY_YMD + "T23:59";

const CX = "xn-course", CE = "xn-course-exam";
let srv, admin, adminId, pid, examId;
let TR, HEAD;
const L = [];   // L0–L10 = 本期学员（cl-x 班）；L11 = 只被指派 CE 的员工

function dbOne(sql, ...a) {
  const d = new DatabaseSync(srv.dbPath, { readOnly: true });
  try { const r = d.prepare(sql).get(...a); return r ? { ...r } : null; } finally { d.close(); }
}
const row = (activityId, userId) => dbOne("SELECT status, by FROM activity_state WHERE activityId = ? AND userId = ?", activityId, userId);
async function mkPerson(tag) {
  const employeeId = "XND-" + tag;
  const { data: made } = await admin.post("/api/admin/employees", { name: "Excused " + tag, employeeId });
  const c = await loginAs(srv.base, { employeeId, password: made.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: made.password, newPassword: "excused-not-done-1" })).status, 200);
  const userId = made.id || (await admin.get("/api/admin/employees")).data.find((u) => u.employeeId === employeeId).id;
  return { c, userId, employeeId };
}
const mark = (act, userId, status) => admin.post(`/api/admin/tprojects/${pid}/checkin/${act}/mark`, { userId, status });
const bulk = (act, userIds, status) => admin.post(`/api/admin/tprojects/${pid}/checkin/${act}/bulk-mark`, { userIds, status });
const courseMark = (cid, userId, status) => admin.post(`/api/admin/courses/${cid}/checkin/mark`, { userId, status });
async function view(p) {
  const r = await p.c.get("/api/me/tprojects/" + pid);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const acts = {};
  for (const ph of r.data.phases) for (const a of ph.activities) acts[a.id] = a;
  return { data: r.data, acts, phase: (id) => r.data.phases.find((x) => x.id === id) };
}
async function program(p, id) {
  const r = await p.c.get("/api/programs/" + id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
const rollRow = async (act, userId) => (await admin.get(`/api/admin/tprojects/${pid}/checkin/${act}`)).data.list.find((x) => x.userId === userId);
// 码按整分钟换，服务端也收上一分钟的码；跨分钟时重取一次
async function projectCheckin(p, act) {
  let r;
  for (let i = 0; i < 2; i++) {
    const code = (await admin.get(`/api/admin/tprojects/${pid}/checkin/${act}`)).data.code;
    r = await p.c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: act, code });
    if (r.status === 200) return r.data.status;
  }
  throw new Error("project check-in failed: " + JSON.stringify(r.data));
}
async function coursePageCheckin(p, cid) {
  let r;
  for (let i = 0; i < 2; i++) {
    const code = (await admin.get(`/api/admin/courses/${cid}/checkin`)).data.code;
    r = await p.c.post(`/api/courses/${cid}/checkin`, { code });
    if (r.status === 200) return r.data.status;
  }
  throw new Error("course check-in failed: " + JSON.stringify(r.data));
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  TR = await mkPerson("TR");
  HEAD = await mkPerson("HEAD");
  for (let i = 0; i < 12; i++) L.push(await mkPerson("L" + i));
  adminId = dbOne("SELECT id FROM users WHERE employeeId = 'ADMIN'").id;
  for (const [cid, extra] of [[CX, { trainerId: TR.userId }], [CE, {}]]) {
    const r = await admin.put("/api/admin/content/courses/" + cid, {
      id: cid, title: "In-person " + cid, title_zh: "线下课程 " + cid, status: "published", mode: "offline",
      location: "Room 7", sessionAt: TODAY_EARLY, modules: [], ...extra,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  // CE 挂一场已发布考试（只关联 CE）：出勤才解锁
  const q = await admin.post("/api/admin/questions", { courseId: CE, type: "mcq", question: "Excused exam question?", options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const ex = await admin.post("/api/admin/exams", { programId: "pw-" + CE, title: "Exam " + CE, courseIds: [CE], passingScore: 50, mcqCount: 1, openCount: 0, status: "published" });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  examId = ex.data.id;
  assert.equal((await admin.post("/api/admin/assignments", { userId: L[11].userId, items: [{ programId: "pw-" + CE, assigned: true, dueAt: null }] })).status, 200);

  pid = (await admin.post("/api/admin/tprojects", { title: "Excused make-up", title_zh: "请假补课" })).data.id;
  const put = await admin.put("/api/admin/tprojects/" + pid, {
    status: "running",
    cohorts: [{
      id: "co-x", name: "Cohort X", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 20,
      classes: [{ id: "cl-x", name: "Class X", headId: HEAD.userId }],
      phases: [
        { id: "ph-1", name: "Phase 1", gateMode: "completion", activities: [
          { id: "xn-off", type: "offline", title: "Kickoff", startAt: TODAY_EARLY, dueAt: "2026-01-05", trainerId: TR.userId },
          { id: "xn-oc", type: "course", refId: CX, dueAt: "2026-01-05" },
          { id: "xn-on", type: "online", title: "Workshop", completion: "trainer", trainerId: TR.userId, dueAt: "2026-01-05" },
        ] },
        { id: "ph-2", name: "Phase 2", gateMode: "completion", activities: [
          { id: "xn-next", type: "online", title: "Survey", url: "https://example.com/next", completion: "self" },
        ] },
      ],
    }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const add = await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-x", classId: "cl-x", userIds: L.slice(0, 11).map((p) => p.userId) });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal((await L[0].c.get("/api/courses/" + CX)).status, 200, "the project assigns the in-person course");
});
after(async () => { if (srv) await srv.stopAsync(); });

test("F1–F3: excused offline activity, in-person course and online activity are not done; gating, progress, course completion, overview and risks follow; the attendance rate still leaves excused out", async () => {
  const [L0, L1] = L;
  // L0 三项都请假；L1 三项都到（对照）；其余空白
  for (const act of ["xn-off", "xn-oc", "xn-on"]) assert.equal((await mark(act, L0.userId, "excused")).status, 200, act);
  for (const [act, st] of [["xn-off", "attended"], ["xn-oc", "attended"], ["xn-on", "completed"]]) assert.equal((await mark(act, L1.userId, st)).status, 200, act);

  let v = await view(L0);
  for (const id of ["xn-off", "xn-oc", "xn-on"]) {
    assert.equal(v.acts[id].done, false, id + ": excused is not done (owner 2026-10-06)");
    assert.equal(v.acts[id].state, "excused", id + ": the learner page can still say 已请假");
  }
  assert.equal(v.acts["xn-oc"].progressPercent, 0, "the in-person course activity shows 0%");
  assert.equal(v.phase("ph-1").complete, false);
  assert.equal(v.phase("ph-2").unlocked, false, "a required excused item keeps the completion-gated next phase locked");
  assert.equal(v.data.progress, 0, "excused moves no progress");
  const locked = await L0.c.post(`/api/me/tprojects/${pid}/complete`, { activityId: "xn-next", via: "self" });
  assert.equal(locked.status, 409);
  assert.equal(locked.data.code, "phase_locked");
  const v1 = await view(L1);
  assert.equal(v1.phase("ph-2").unlocked, true, "attended / completed opens the next phase");
  assert.equal(v1.data.progress, 75);

  const doc = (await admin.get("/api/admin/tprojects/" + pid)).data;
  for (const id of ["xn-off", "xn-oc", "xn-on"]) assert.equal(doc.actStats[id].done, 1, id + ": only L1 counts");
  assert.equal(doc.members.find((m) => m.userId === L0.userId).progress, 0);
  assert.equal((await L0.c.get("/api/me/tprojects")).data.mine.find((p) => p.id === pid).progress, 0);

  // 线下课程：请假不算学完（课程进度、我的课程、学习记录、总览完成数）
  const p0 = await program(L0, "pw-" + CX);
  assert.equal(p0.progress, 0);
  assert.equal(p0.done, false);
  assert.equal(p0.courses[0].progress, 0);
  const myL0 = (await L0.c.get("/api/programs")).data;
  const myL1 = (await L1.c.get("/api/programs")).data;
  assert.equal(myL0.find((x) => x.id === "pw-" + CX).done, false);
  assert.equal(myL1.find((x) => x.id === "pw-" + CX).done, true, "attended is a finished course");
  // 「课程」页卡片显示「已请假 · 需补课」靠这个字段（负责人 2026-10-06）：单门线下课程带出勤记录，其余为 null
  assert.equal(myL0.find((x) => x.id === "pw-" + CX).attendance, "excused");
  assert.equal(myL1.find((x) => x.id === "pw-" + CX).attendance, "attended");
  for (const x of myL0.filter((x) => x.mode !== "offline")) assert.equal(x.attendance, null, x.id);
  const blank = (await L[2].c.get("/api/programs")).data.find((x) => x.id === "pw-" + CX);
  assert.equal(blank.attendance, null, "no attendance record yet");
  assert.notEqual((await L0.c.get("/api/me/learning-record")).data.find((x) => x.id === "pw-" + CX).status, "passed");
  assert.equal((await L1.c.get("/api/me/learning-record")).data.find((x) => x.id === "pw-" + CX).status, "passed");
  const ov = (await admin.get("/api/admin/overview?programs=pw-" + CX)).data.perProgram.find((x) => x.id === "pw-" + CX);
  assert.equal(ov.assigned, 11);
  assert.equal(ov.done, 1, "the overview counts L1 only, not the excused L0");

  // F2：出勤率 = 两场（xn-off、xn-oc）里出席 + 迟到 / 非请假人数 = 2 / (2 × 10) = 10%（请假算进分母会是 9%）
  const dash = (await admin.get(`/api/admin/tprojects/${pid}/dashboard`)).data;
  assert.equal(dash.attendance, 10);
  // F3：L0 的三项都已逾期、都请假 → 不列；空白的人照常列
  assert.ok(!dash.risks.some((r) => r.employeeId === L0.employeeId), JSON.stringify(dash.risks.filter((r) => r.employeeId === L0.employeeId)));
  for (const id of ["xn-off", "xn-oc", "xn-on"]) assert.ok(dash.risks.some((r) => r.activityId === id), id + ": blank overdue learners are still risks");
  assert.ok(!dash.risks.some((r) => r.employeeId === L1.employeeId), "done items are not risks");
});

test("F1: an excused in-person course does not unlock its exam; attendance does", async () => {
  const L11 = L[11];
  assert.equal((await courseMark(CE, L11.userId, "excused")).status, 200);
  let p = await program(L11, "pw-" + CE);
  assert.equal(p.progress, 0);
  assert.equal(p.examUnlocked, false);
  assert.equal(p.exams.find((e) => e.id === examId).unlocked, false);
  const start = await L11.c.post("/api/exam/start", { examId });
  assert.equal(start.status, 400, JSON.stringify(start.data));
  assert.equal(start.data.code, "incomplete");
  // HR 单条补课：请假 → 出席，直接改写（F4）
  assert.equal((await courseMark(CE, L11.userId, "attended")).status, 200);
  p = await program(L11, "pw-" + CE);
  assert.equal(p.progress, 100);
  assert.equal(p.exams.find((e) => e.id === examId).unlocked, true);
  assert.equal(p.done, false, "with an exam, the course is done once the exam is passed");
  // 考试通过 → 完成；之后被改为请假 → 不再算完成（线下课程请假不算学完）；补课出席 → 恢复完成
  const st = await L11.c.post("/api/exam/start", { examId });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const answers = {};
  for (const q of st.data.questions) answers[q.id] = q.options.findIndex((o) => o.text === "right");
  const sub = await L11.c.post(`/api/exam/${st.data.attemptId}/submit`, { answers });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  assert.equal((await program(L11, "pw-" + CE)).done, true, "exam passed + attended = done");
  assert.equal((await courseMark(CE, L11.userId, "excused")).status, 200);
  assert.equal((await program(L11, "pw-" + CE)).done, false, "a passed exam does not make an excused in-person course done");
  assert.equal((await courseMark(CE, L11.userId, "attended")).status, 200);
  assert.equal((await program(L11, "pw-" + CE)).done, true, "make-up attendance restores completion");
});

test("F4 HR single: excused → attended (offline activity, in-person course activity, course roll-call) and excused → completed (online) without undoing first", async () => {
  const L2 = L[2], L10 = L[10];
  for (const act of ["xn-off", "xn-oc", "xn-on"]) assert.equal((await mark(act, L2.userId, "excused")).status, 200);
  for (const [act, st] of [["xn-off", "attended"], ["xn-oc", "attended"], ["xn-on", "completed"]]) {
    const r = await mark(act, L2.userId, st);
    assert.equal(r.status, 200, act + ": " + JSON.stringify(r.data));
  }
  assert.deepEqual(row("xn-off", L2.userId), { status: "attended", by: adminId });
  assert.deepEqual(row("course:" + CX, L2.userId), { status: "attended", by: adminId });
  assert.deepEqual(row("xn-on", L2.userId), { status: "completed", by: adminId });
  const v = await view(L2);
  for (const id of ["xn-off", "xn-oc", "xn-on"]) assert.equal(v.acts[id].done, true, id);
  assert.equal(v.phase("ph-2").unlocked, true);
  // 课程签到名单（内容管理）：同样直接改写
  assert.equal((await courseMark(CX, L10.userId, "excused")).status, 200);
  assert.equal((await view(L10)).acts["xn-oc"].done, false);
  assert.equal((await courseMark(CX, L10.userId, "attended")).status, 200);
  assert.equal((await view(L10)).acts["xn-oc"].done, true);
  assert.equal((await program(L10, "pw-" + CX)).progress, 100);
});

test("F4 HR bulk: excused → attended / completed is applied (not already_marked) and stays undoable; other different records are still skipped", async () => {
  const [L3, L4, L5] = [L[3], L[4], L[5]];
  for (const act of ["xn-off", "xn-oc", "xn-on"]) assert.equal((await mark(act, L3.userId, "excused")).status, 200);
  assert.equal((await mark("xn-off", L4.userId, "absent")).status, 200);
  assert.equal((await mark("xn-off", L5.userId, "attended")).status, 200);
  // 签到名单：请假 → 出席；缺勤仍 already_marked；已出席 = 未改动
  const r = await bulk("xn-off", [L3.userId, L4.userId, L5.userId], "attended");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.results[0], { id: L3.userId, ok: true });
  assert.equal(r.data.results[1].code, "already_marked");
  assert.equal(r.data.results[1].status, "absent");
  assert.deepEqual(r.data.results[2], { id: L5.userId, ok: true, unchanged: true });
  assert.deepEqual(row("xn-off", L3.userId), { status: "attended", by: adminId }, "make-up row: by = operator");
  assert.equal(row("xn-off", L4.userId).status, "absent", "absent is never overwritten by bulk");
  assert.equal((await view(L3)).acts["xn-off"].done, true);
  // 补课行由操作人登记，单条撤销可撤
  assert.equal((await mark("xn-off", L3.userId, "clear")).status, 200);
  assert.equal(row("xn-off", L3.userId), null);
  // 请假 → 请假 = 未改动；出席上再批量请假仍 already_marked（规则只放开请假 → 出席 / 完成）
  assert.equal((await mark("xn-off", L3.userId, "excused")).status, 200);
  assert.deepEqual((await bulk("xn-off", [L3.userId], "excused")).data.results[0], { id: L3.userId, ok: true, unchanged: true });
  assert.equal((await bulk("xn-off", [L5.userId], "excused")).data.results[0].code, "already_marked");
  // 引用线下课程的活动：批量补课 = 课程学完
  assert.equal((await program(L3, "pw-" + CX)).progress, 0);
  const oc = await bulk("xn-oc", [L3.userId], "attended");
  assert.deepEqual(oc.data.results[0], { id: L3.userId, ok: true });
  assert.deepEqual(row("course:" + CX, L3.userId), { status: "attended", by: adminId });
  assert.equal((await program(L3, "pw-" + CX)).progress, 100);
  assert.equal((await view(L3)).acts["xn-oc"].done, true);
  // 完成登记名单（线上活动）：请假 → 完成；attended 按 completed
  const on = await bulk("xn-on", [L3.userId], "completed");
  assert.deepEqual(on.data.results[0], { id: L3.userId, ok: true });
  assert.deepEqual(row("xn-on", L3.userId), { status: "completed", by: adminId });
  assert.equal((await mark("xn-on", L4.userId, "excused")).status, 200);
  const on2 = await bulk("xn-on", [L4.userId], "attended");
  assert.deepEqual(on2.data.results[0], { id: L4.userId, ok: true });
  assert.equal(row("xn-on", L4.userId).status, "completed");
  assert.equal((await view(L4)).acts["xn-on"].done, true);
  // 完成上再批量请假仍 already_marked
  assert.equal((await bulk("xn-on", [L3.userId], "excused")).data.results[0].code, "already_marked");
});

test("F4 trainer (我的授课) and class head (班主任): excused → attended / completed directly", async () => {
  const [L6, L7] = [L[6], L[7]];
  for (const act of ["xn-off", "xn-oc", "xn-on"]) assert.equal((await mark(act, L6.userId, "excused")).status, 200);
  const keys = (await TR.c.get("/api/me/sessions")).data.sessions.map((s) => s.key);
  const kOff = `a.${pid}.co-x.xn-off`, kOn = `a.${pid}.co-x.xn-on`, kCourse = "c." + CX;
  for (const k of [kOff, kOn, kCourse]) assert.ok(keys.includes(k), k + " is one of the trainer's sessions: " + JSON.stringify(keys));
  const tMark = (key, userId, status) => TR.c.post(`/api/me/sessions/${encodeURIComponent(key)}/checkin/mark`, { userId, status });
  assert.equal((await tMark(kOff, L6.userId, "attended")).status, 200);
  assert.equal((await tMark(kOn, L6.userId, "completed")).status, 200);
  assert.equal((await tMark(kCourse, L6.userId, "attended")).status, 200);
  assert.deepEqual(row("xn-off", L6.userId), { status: "attended", by: TR.userId });
  assert.deepEqual(row("xn-on", L6.userId), { status: "completed", by: TR.userId });
  assert.deepEqual(row("course:" + CX, L6.userId), { status: "attended", by: TR.userId });
  let v = await view(L6);
  for (const id of ["xn-off", "xn-oc", "xn-on"]) assert.equal(v.acts[id].done, true, "trainer make-up: " + id);
  // 班主任：本班学员的线下活动与线下课程活动
  for (const act of ["xn-off", "xn-oc"]) assert.equal((await mark(act, L7.userId, "excused")).status, 200);
  const hMark = (act, userId, status) => HEAD.c.post(`/api/me/classes/${pid}/checkin/${act}/mark`, { userId, status });
  assert.equal((await hMark("xn-off", L7.userId, "attended")).status, 200);
  assert.equal((await hMark("xn-oc", L7.userId, "attended")).status, 200);
  assert.deepEqual(row("xn-off", L7.userId), { status: "attended", by: HEAD.userId });
  assert.deepEqual(row("course:" + CX, L7.userId), { status: "attended", by: HEAD.userId });
  v = await view(L7);
  assert.equal(v.acts["xn-off"].done, true);
  assert.equal(v.acts["xn-oc"].done, true);
  assert.equal((await program(L7, "pw-" + CX)).progress, 100);
});

test("F5: a learner's own code check-in overrides excused — project offline activity, project in-person course activity, course page", async () => {
  const [L8, L9] = [L[8], L[9]];
  for (const act of ["xn-off", "xn-oc"]) assert.equal((await mark(act, L8.userId, "excused")).status, 200);
  for (const act of ["xn-off", "xn-oc"]) {
    const st = await projectCheckin(L8, act);
    assert.ok(["attended", "late"].includes(st), act + ": " + st);
    const rr = await rollRow(act, L8.userId);
    assert.equal(rr.status, st);
    assert.equal(rr.self, true, act + ": recorded as a self check-in");
  }
  assert.deepEqual(row("course:" + CX, L8.userId).by, L8.userId);
  let v = await view(L8);
  assert.equal(v.acts["xn-off"].done, true);
  assert.equal(v.acts["xn-oc"].done, true);
  // 课程页签到
  assert.equal((await courseMark(CX, L9.userId, "excused")).status, 200);
  assert.equal((await L9.c.get("/api/courses/" + CX)).data.attendance, "excused");
  assert.equal((await view(L9)).acts["xn-oc"].done, false);
  const st = await coursePageCheckin(L9, CX);
  assert.ok(["attended", "late"].includes(st), st);
  assert.deepEqual(row("course:" + CX, L9.userId), { status: st, by: L9.userId });
  assert.equal((await L9.c.get("/api/courses/" + CX)).data.attendance, st);
  assert.equal((await rollRow("xn-oc", L9.userId)).self, true);
  v = await view(L9);
  assert.equal(v.acts["xn-oc"].done, true);
  assert.equal((await program(L9, "pw-" + CX)).progress, 100);
});
