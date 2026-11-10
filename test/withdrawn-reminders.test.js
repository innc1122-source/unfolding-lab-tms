// 退训后不再提醒（负责人 2026-10-07）：学员从培养项目退训（project_members.state = 'withdrawn'）后，
// 由该项目派出的课程指派不再收「即将截止 / 已逾期」提醒。三条提醒路径同一判定（modules/learning/completion.js
// withdrawnOnly，并入 reminderEligible）：定时任务 scripts/notify-due.js、POST /api/admin/training/remind-overdue、
// 培训概览逾期名单的 remindable。指派与看板计数不动（仍算逾期，只是不可提醒）。
//   · 照常提醒：加入项目前 HR 已派的课（assignedAt 早于加入时间 5 分钟以上）、还在另一个引用同一门课的项目里在训、
//     退训项目没有引用的课、从未退训的学员；重新加入项目后自动恢复提醒。
//   · 期次引用的课程推导与派课同一份（server.js tpProgramIds 委托 completion.js cohortProgramIds）：课程活动 → 包装程序，
//     结业考试活动 → 考试所属程序。
// 夹具都经 HTTP 搭在一次性临时库上；定时脚本另起子进程跑。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { ROOT, ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");
const LC = require("../modules/learning/completion.js");

const PAST = "2026-01-05";
let srv, admin, dir, cfg, seq = 0;
const P = {};   // tag → { id, employeeId }
const C = {};   // key → { cid, pid, examId }
let TP1, TP2;   // 两个培养项目，期次都引用课程 w

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
const one = (sql, ...a) => dbRead((d) => d.prepare(sql).get(...a));
const all = (sql, ...a) => dbRead((d) => d.prepare(sql).all(...a));
function dbWrite(sql, ...a) {
  const d = new DatabaseSync(srv.dbPath);
  try { d.exec("PRAGMA busy_timeout = 5000"); return d.prepare(sql).run(...a); } finally { d.close(); }
}
const linksOf = (p, type) => all("SELECT link FROM notifications WHERE userId = ? AND type = ?", p.id, type).map((r) => r.link).sort();
const link = (key) => "#/program/" + C[key].pid;

function runScript() {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "notify-due.js")], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, LMS_DB_PATH: srv.dbPath, LMS_ATTACH_DIR: path.join(dir, "attachments"), LMS_CONFIG_PATH: cfg, LMS_DISABLE_AI: "1", LMS_MODULES_OFF: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout || "", /due soon: \d+, overdue: \d+/);
}

async function mkPerson(tag) {
  const employeeId = `WD${tag}-${String(++seq).padStart(3, "0")}`;
  const made = await admin.post("/api/admin/employees", { name: "Withdrawn " + employeeId, employeeId, email: employeeId.toLowerCase() + "@example.com", programIds: [] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  P[tag] = { id: one("SELECT id FROM users WHERE employeeId = ?", employeeId).id, employeeId };
  return P[tag];
}
async function mkCourse(key, { exam = false } = {}) {
  const cid = "wd-" + key;
  const body = { id: cid, title: "WD " + key, title_zh: "退训 " + key, status: "published", mode: "online", modules: [{ id: cid + "-m1", title: "Module 1", minutes: 5, sections: [] }] };
  const put = await admin.put("/api/admin/content/courses/" + cid, body);
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const out = { cid, pid: "pw-" + cid, examId: null };
  if (exam) {
    const q = await admin.post("/api/admin/questions", { courseId: cid, type: "mcq", question: `WD exam ${key}?`, options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] });
    assert.equal(q.status, 200, JSON.stringify(q.data));
    const ex = await admin.post("/api/admin/exams", { programId: out.pid, title: "Exam " + key, courseIds: [cid], passingScore: 50, mcqCount: 1, openCount: 0, status: "published" });
    assert.equal(ex.status, 200, JSON.stringify(ex.data));
    out.examId = ex.data.id;
  }
  C[key] = out;
  return out;
}
async function mkProject(title, activities) {
  const made = await admin.post("/api/admin/tprojects", { title });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const cohorts = [{ id: made.data.id + "-c1", name: "Cohort 1", startAt: "2026-01-01", endAt: PAST, capacity: 0, classes: [], phases: [{ id: made.data.id + "-ph1", name: "Phase 1", activities }] }];
  const put = await admin.put("/api/admin/tprojects/" + made.data.id, { cohorts, status: "running" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  return { id: made.data.id, cohortId: cohorts[0].id };
}
async function join(tp, ...people) {
  const r = await admin.post(`/api/admin/tprojects/${tp.id}/members`, { cohortId: tp.cohortId, userIds: people.map((p) => p.id), silent: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.count, people.length);
}
async function withdraw(tp, p) {
  const r = await admin.post(`/api/admin/tprojects/${tp.id}/members/update`, { userId: p.id, action: "withdraw" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function assign(p, course, dueAt) {
  const r = await admin.post("/api/admin/assignments", { userId: p.id, items: [{ programId: course.pid, assigned: true, dueAt }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
const asgOf = (p, key) => one("SELECT dueAt, assignedAt FROM assignments WHERE userId = ? AND programId = ?", p.id, C[key].pid);
const remindable = (ov, key, p) => {
  const row = ov.perProgram.find((x) => x.id === C[key].pid).overdueList.find((o) => o.employeeId === p.employeeId);
  return row ? row.remindable : undefined;
};

before(async () => {
  dir = tempDir("lms-withdrawn-reminders-");
  cfg = path.join(dir, "script-config.json");
  fs.writeFileSync(cfg, JSON.stringify({}));
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);

  const w = await mkCourse("w");                 // 两个项目都引用的线上课程
  const wx = await mkCourse("wx", { exam: true }); // TP1 用结业考试活动引用（考试所属程序）
  await mkCourse("x");                            // 不在任何项目里的课
  TP1 = await mkProject("WD project one", [
    { id: "wd-a1", type: "course", refId: w.cid, required: true },
    { id: "wd-a2", type: "exam", refId: wx.examId, required: true },
  ]);
  TP2 = await mkProject("WD project two", [{ id: "wd-b1", type: "course", refId: w.cid, required: true }]);

  // W1：只因 TP1 有 w、wx 两门课 → 退训；加入后 HR 另派 x
  // W2：加入 TP1 之前 HR 已派 w（assignedAt 早于加入时间）→ 退训
  // W3：TP1 退训，但还在 TP2 在训（TP2 也引用 w）
  // W4：TP1 退训，之后重新加入
  // W5：TP1 在训，从未退训；W6：不在任何项目，HR 派 w
  for (const t of ["W1", "W2", "W3", "W4", "W5", "W6"]) await mkPerson(t);
  await assign(P.W2, w, PAST);
  dbWrite("UPDATE assignments SET assignedAt = ? WHERE userId = ? AND programId = ?", "2025-12-01T00:00:00.000Z", P.W2.id, w.pid);
  await join(TP1, P.W1, P.W2, P.W3, P.W4, P.W5);
  await join(TP2, P.W3);
  await assign(P.W1, C.x, PAST);
  await assign(P.W6, w, PAST);
  for (const t of ["W1", "W2", "W3", "W4"]) await withdraw(TP1, P[t]);
  assert.equal(one("SELECT state FROM project_members WHERE projectId = ? AND userId = ?", TP1.id, P.W1.id).state, "withdrawn");
});
after(async () => { if (srv) await srv.stopAsync(); });

test("fixtures: the project assigned w and wx (course activity → wrapper program, exam activity → the exam's program); withdrawal leaves the assignments in place", () => {
  for (const t of ["W1", "W3", "W4", "W5"]) {
    assert.ok(asgOf(P[t], "w"), t + " has w from the project");
    assert.ok(asgOf(P[t], "wx"), t + " has wx from the project's exam activity");
    assert.equal(asgOf(P[t], "w").dueAt, PAST, "due = cohort end");
  }
  assert.equal(asgOf(P.W2, "w").assignedAt, "2025-12-01T00:00:00.000Z", "HR's earlier assignment keeps its assignedAt when the project assigns it again");
  assert.ok(asgOf(P.W1, "w") && asgOf(P.W1, "wx"), "withdrawing does not remove assignments");
});

test("cron (notify-due.js): withdrawn-only assignments are skipped; HR-before-joining, still active elsewhere, other courses and never-withdrawn learners are reminded", () => {
  runScript();
  assert.deepEqual(linksOf(P.W1, "overdue"), [link("x")], "W1: w and wx came only from the project they left; x (HR, not in the project) still reminded");
  assert.deepEqual(linksOf(P.W2, "overdue"), [link("w")], "W2: HR assigned w before joining → still reminded; wx came only from the project → not");
  assert.deepEqual(linksOf(P.W3, "overdue"), [link("w")], "W3: still active in TP2, which also references w; wx only came from TP1");
  assert.deepEqual(linksOf(P.W4, "overdue"), [], "W4: withdrawn");
  assert.deepEqual(linksOf(P.W5, "overdue"), [link("w"), link("wx")].sort(), "W5: never withdrawn");
  assert.deepEqual(linksOf(P.W6, "overdue"), [link("w")], "W6: plain HR assignment");
});

test("remind-overdue and the overview: withdrawn-only rows stay on the overdue list (counts unchanged) but are not remindable, and the button skips them", async () => {
  const ov = (await admin.get("/api/admin/overview")).data;
  const row = ov.perProgram.find((x) => x.id === C.w.pid);
  assert.equal(row.overdue, 6, "all six still count as overdue on w");
  assert.equal(remindable(ov, "w", P.W1), false);
  assert.equal(remindable(ov, "w", P.W4), false);
  for (const t of ["W2", "W3", "W5", "W6"]) assert.equal(remindable(ov, "w", P[t]), true, t);
  assert.equal(remindable(ov, "wx", P.W1), false);
  assert.equal(remindable(ov, "wx", P.W3), false, "TP2 does not reference wx");
  assert.equal(remindable(ov, "wx", P.W5), true);
  assert.equal(remindable(ov, "x", P.W1), true, "a course the project never referenced");

  const rem = await admin.post("/api/admin/training/remind-overdue", { programId: C.w.pid });
  assert.equal(rem.status, 200, JSON.stringify(rem.data));
  assert.deepEqual(rem.data.sample.map((s) => s.employeeId).sort(), ["W2", "W3", "W5", "W6"].map((t) => P[t].employeeId).sort());
  const byBoard = row.overdueList.filter((o) => o.remindable !== false).map((o) => o.employeeId).sort();
  assert.deepEqual(rem.data.sample.map((s) => s.employeeId).sort(), byBoard, "button = the board's remindable rows");
  const remx = await admin.post("/api/admin/training/remind-overdue", { programId: C.wx.pid });
  assert.deepEqual(remx.data.sample.map((s) => s.employeeId), [P.W5.employeeId]);
  // 不筛选：W1 照样因为 x 被提醒（一人一条），W4 一条都没有
  const whole = await admin.post("/api/admin/training/remind-overdue", {});
  assert.equal(whole.status, 200, JSON.stringify(whole.data));
  assert.deepEqual(linksOf(P.W1, "training"), [link("x")], "W1 is reminded about x only");
  assert.deepEqual(linksOf(P.W4, "training"), [], "W4 is not reminded at all");
});

test("re-adding the withdrawn learner to the project restores reminders on all three paths", async () => {
  await join(TP1, P.W4);
  assert.equal(one("SELECT state FROM project_members WHERE projectId = ? AND userId = ?", TP1.id, P.W4.id).state, "active");
  const ov = (await admin.get("/api/admin/overview")).data;
  assert.equal(remindable(ov, "w", P.W4), true);
  assert.equal(remindable(ov, "wx", P.W4), true);
  const rem = await admin.post("/api/admin/training/remind-overdue", { programId: C.w.pid });
  assert.ok(rem.data.sample.some((s) => s.employeeId === P.W4.employeeId), "remind-overdue includes W4 again");
  runScript();
  assert.deepEqual(linksOf(P.W4, "overdue"), [link("w"), link("wx")].sort(), "the cron reminds W4 again");
  assert.deepEqual(linksOf(P.W1, "overdue"), [link("x")], "W1 is still withdrawn — unchanged");
});

test("completion.js unit: cohortProgramIds and the withdrawnOnly rule (5-minute grace, active elsewhere, no project resolver)", () => {
  const courses = { c1: { id: "c1" }, c2: { id: "c2", programId: "legacy" }, full: { id: "full", modules: [{ id: "m" }] } };
  const getCourse = (id) => courses[id] || null;
  const programsOfCourse = LC.programsOfCourseFrom([{ id: "pw-c1", courseIds: ["c1"] }, { id: "pack", courseIds: ["c1", "zz"] }]);
  const exams = { e1: { id: "e1", programId: "pe" } };
  const cohort = { id: "k1", phases: [{ activities: [
    { type: "course", refId: "c1" }, { type: "course", refId: "c2" }, { type: "course", refId: "gone" },
    { type: "exam", refId: "e1" }, { type: "exam", refId: "e-gone" }, { type: "program", refId: "pl" },
    { type: "online", title: "x" }, { type: "offline" },
  ] }] };
  assert.deepEqual(LC.cohortProgramIds(cohort, { getCourse, programsOfCourse, getExam: (id) => exams[id] || null }).sort(),
    ["legacy", "pack", "pe", "pl", "pw-c1"].sort());
  assert.deepEqual(LC.cohortProgramIds({ id: "empty" }, { getCourse, programsOfCourse, getExam: () => null }), []);

  const T0 = Date.parse("2026-03-01T10:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  let members = [], assignedAt = iso(T0);
  const fake = {
    listUserMemberships: () => members, getUserAssignments: () => ({ "pw-c1": { dueAt: PAST, assignedAt } }),
    getExam: () => null, listProgramExams: () => [], pendingExamAttempt: () => null,
    getCourseProgress: () => ({}), getUserActivityStates: () => ({}), bestAttempt: () => null,
  };
  const projects = [
    { id: "tpA", cohorts: [{ id: "kA", phases: [{ activities: [{ type: "course", refId: "c1" }] }] }] },
    { id: "tpB", cohorts: [{ id: "kB", phases: [{ activities: [{ type: "course", refId: "c1" }] }] }, { id: "kB2", phases: [] }] },
  ];
  const k = LC.createCompletion({ store: fake, getCourse, listProjects: () => projects, programsOfCourse });
  const m = (projectId, cohortId, state, addedMs, role = "learner") => ({ projectId, cohortId, state, role, addedAt: iso(addedMs) });
  members = [m("tpA", "kA", "withdrawn", T0)];
  assert.equal(k.withdrawnOnly("u", "pw-c1"), true, "assigned at the moment of joining");
  assignedAt = iso(T0 - LC.WITHDRAWN_ASSIGN_GRACE_MS);
  assert.equal(k.withdrawnOnly("u", "pw-c1"), true, "exactly 5 minutes before joining still counts as the project's");
  assignedAt = iso(T0 - LC.WITHDRAWN_ASSIGN_GRACE_MS - 1000);
  assert.equal(k.withdrawnOnly("u", "pw-c1"), false, "assigned earlier than that = HR's own assignment");
  assignedAt = iso(T0);
  assert.equal(k.withdrawnOnly("u", "other"), false, "a program the cohort does not reference");
  members = [m("tpA", "kA", "withdrawn", T0), m("tpB", "kB", "active", T0)];
  assert.equal(k.withdrawnOnly("u", "pw-c1"), false, "active in another project that references it");
  members = [m("tpA", "kA", "withdrawn", T0), m("tpB", "kB2", "active", T0)];
  assert.equal(k.withdrawnOnly("u", "pw-c1"), true, "active elsewhere, but that cohort does not reference it");
  members = [m("tpA", "kA", "withdrawn", T0), m("tpB", "kB", "active", T0, "mentor")];
  assert.equal(k.withdrawnOnly("u", "pw-c1"), true, "a non-learner role does not keep reminders on");
  members = [m("tpA", "kA", "withdrawn", T0, "mentor")];
  assert.equal(k.withdrawnOnly("u", "pw-c1"), false, "only learner memberships count");
  members = [m("tpGone", "kA", "withdrawn", T0)];
  assert.equal(k.withdrawnOnly("u", "pw-c1"), false, "a project that no longer exists references nothing");
  members = [m("tpA", "kA", "withdrawn", T0)];
  assignedAt = null;
  assert.equal(k.withdrawnOnly("u", "pw-c1"), false, "no assignedAt: cannot show the project made it → keep reminding");
  assignedAt = iso(T0);
  const user = { id: "u", role: "employee", active: 1 };
  assert.equal(k.reminderEligible(user, { id: "pw-c1", courseIds: ["full"] }), false, "reminderEligible includes withdrawnOnly");
  members = [m("tpA", "kA", "active", T0)];
  assert.equal(k.reminderEligible(user, { id: "pw-c1", courseIds: ["full"] }), true, "re-activated → eligible again");
  // 不传项目解析（旧调用方 / 假 store）：不做退训判定
  const bare = LC.createCompletion({ store: fake, getCourse });
  assert.equal(bare.withdrawnOnly("u", "pw-c1"), false);
});

// 期次轨迹（store.js 迁移 66 cohortLog，2026-10-07 复核）：调期改写 cohortId、重新加入保留最初的 addedAt，
// 只看当前期次与 addedAt 会把结果弄反。项目 TP3 两个期次：A 引用课程 a，B 引用课程 b。
//   M1：加入 A → 调到 B → 退训：a、b 都是项目派的 → 都不提醒
//   M2：1 月加入 A；3 月 HR 另派 b；之后调到 B（b 保留 3 月的派课时间）→ 退训：a 不提醒，b 照常提醒
//   M3：1 月加入 A → 退训；3 月 HR 另派 b；重新加入到 B → 再退训：a 不提醒（第一段项目派的），b 照常提醒
//   M4：加入 A → 退训；之后 HR 删掉 a 重派（派课时间晚于离开）→ 照常提醒
//   M5：加入 A → 调到 B，仍在训 → a、b 都照常提醒
test("cohort history: a move or a re-join before withdrawing — every cohort the learner was in counts, each only for its own stint", async () => {
  const a = await mkCourse("a"), b = await mkCourse("b");
  const made = await admin.post("/api/admin/tprojects", { title: "WD project three" });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.id, kA = id + "-ca", kB = id + "-cb";
  const cohort = (cid, key, refId) => ({ id: cid, name: "Cohort " + key, startAt: "2026-01-01", endAt: PAST, capacity: 0, classes: [], phases: [{ id: cid + "-ph", name: "Phase", activities: [{ id: cid + "-act", type: "course", refId, required: true }] }] });
  const put = await admin.put("/api/admin/tprojects/" + id, { cohorts: [cohort(kA, "A", a.cid), cohort(kB, "B", b.cid)], status: "running" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const A = { id, cohortId: kA }, B = { id, cohortId: kB };
  const move = async (p, cohortId) => {
    const r = await admin.post(`/api/admin/tprojects/${id}/members/update`, { userId: p.id, action: "move", cohortId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  const logOf = (p) => JSON.parse(one("SELECT cohortLog FROM project_members WHERE projectId = ? AND userId = ?", id, p.id).cohortLog);
  const setLog = (p, log) => dbWrite("UPDATE project_members SET cohortLog = ? WHERE projectId = ? AND userId = ?", JSON.stringify(log), id, p.id);
  const setAssignedAt = (p, key, at) => dbWrite("UPDATE assignments SET assignedAt = ? WHERE userId = ? AND programId = ?", at, p.id, C[key].pid);
  const JAN = "2026-01-10T00:00:00.000Z", JAN1 = "2026-01-10T00:00:01.000Z", FEB = "2026-02-01T00:00:00.000Z", MAR = "2026-03-01T00:00:00.000Z";
  for (const t of ["M1", "M2", "M3", "M4", "M5"]) await mkPerson(t);

  await join(A, P.M1);
  await move(P.M1, kB);
  await withdraw(A, P.M1);
  const l1 = logOf(P.M1);
  assert.deepEqual(l1.map((e) => e.cohortId), [kA, kB], "the move is on the cohort history");
  assert.ok(l1[0].leftAt && l1[0].leftAt === l1[1].enteredAt, "leaving A = entering B");
  assert.ok(l1[1].leftAt, "withdrawing closes the B stint");

  await join(A, P.M2);
  setLog(P.M2, [{ cohortId: kA, enteredAt: JAN, leftAt: null }]);
  setAssignedAt(P.M2, "a", JAN1);
  await assign(P.M2, b, PAST);
  setAssignedAt(P.M2, "b", MAR);
  await move(P.M2, kB);
  assert.equal(asgOf(P.M2, "b").assignedAt, MAR, "moving into B keeps HR's earlier assignment of b");
  await withdraw(A, P.M2);

  await join(A, P.M3);
  setLog(P.M3, [{ cohortId: kA, enteredAt: JAN, leftAt: null }]);
  setAssignedAt(P.M3, "a", JAN1);
  await withdraw(A, P.M3);
  await assign(P.M3, b, PAST);
  setAssignedAt(P.M3, "b", MAR);
  await join(B, P.M3);
  assert.equal(one("SELECT state FROM project_members WHERE projectId = ? AND userId = ?", id, P.M3.id).state, "active");
  assert.equal(asgOf(P.M3, "b").assignedAt, MAR, "re-joining into B keeps HR's earlier assignment of b");
  await withdraw(A, P.M3);
  assert.deepEqual(logOf(P.M3).map((e) => e.cohortId), [kA, kB], "the re-join is a new stint");
  assert.ok(logOf(P.M3).every((e) => e.leftAt), "both stints closed");

  await join(A, P.M4);
  await withdraw(A, P.M4);
  setLog(P.M4, [{ cohortId: kA, enteredAt: JAN, leftAt: FEB }]);
  setAssignedAt(P.M4, "a", JAN1);
  let ov = (await admin.get("/api/admin/overview")).data;
  assert.equal(remindable(ov, "a", P.M4), false, "assigned while in A, A has ended → not remindable");
  const rm = await admin.post("/api/admin/assignments", { userId: P.M4.id, items: [{ programId: a.pid, assigned: false }] });
  assert.equal(rm.status, 200, JSON.stringify(rm.data));
  await assign(P.M4, a, PAST);
  assert.ok(Date.parse(asgOf(P.M4, "a").assignedAt) > Date.parse(FEB));

  await join(A, P.M5);
  await move(P.M5, kB);
  assert.ok(asgOf(P.M5, "a") && asgOf(P.M5, "b"), "M5 has a (cohort A) and b (cohort B)");

  runScript();
  assert.deepEqual(linksOf(P.M1, "overdue"), [], "M1: a (cohort A, before the move) and b (cohort B) both came from the project");
  assert.deepEqual(linksOf(P.M2, "overdue"), [link("b")], "M2: b was HR's own (before moving into B) → reminded; a came from the project → not");
  assert.deepEqual(linksOf(P.M3, "overdue"), [link("b")], "M3: b was HR's own (between the two stints) → reminded; a came from the first stint → not");
  assert.deepEqual(linksOf(P.M4, "overdue"), [link("a")], "M4: HR re-assigned a after the learner left → reminded");
  assert.deepEqual(linksOf(P.M5, "overdue"), [link("a"), link("b")].sort(), "M5: moved but never withdrawn → both reminded");

  ov = (await admin.get("/api/admin/overview")).data;
  assert.equal(remindable(ov, "a", P.M1), false);
  assert.equal(remindable(ov, "b", P.M1), false);
  assert.equal(remindable(ov, "a", P.M2), false);
  assert.equal(remindable(ov, "b", P.M2), true);
  assert.equal(remindable(ov, "a", P.M3), false);
  assert.equal(remindable(ov, "b", P.M3), true);
  assert.equal(remindable(ov, "a", P.M4), true);
  assert.equal(remindable(ov, "a", P.M5), true);
  assert.equal(remindable(ov, "b", P.M5), true);
  const ra = await admin.post("/api/admin/training/remind-overdue", { programId: a.pid });
  assert.deepEqual(ra.data.sample.map((s) => s.employeeId).sort(), [P.M4.employeeId, P.M5.employeeId].sort());
  const rb = await admin.post("/api/admin/training/remind-overdue", { programId: b.pid });
  assert.deepEqual(rb.data.sample.map((s) => s.employeeId).sort(), [P.M2.employeeId, P.M3.employeeId, P.M5.employeeId].sort());
});

test("completion.js unit: cohort stints (moves, re-joins, end of stint) and the per-cohort cache", () => {
  let getCourseCalls = 0, asgCalls = 0;
  const getCourse = (id) => { getCourseCalls++; return { id }; };
  const programsOfCourse = LC.programsOfCourseFrom([{ id: "pa", courseIds: ["ca"] }, { id: "pb", courseIds: ["cb"] }]);
  const act = (refId) => ({ phases: [{ activities: [{ type: "course", refId }] }] });
  let projects = [{ id: "tp", cohorts: [{ id: "kA", ...act("ca") }, { id: "kB", ...act("cb") }] }];
  const iso = (d) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + d * 86400000).toISOString();
  let members = [], assigned = {};
  const fake = {
    listUserMemberships: () => members,
    getUserAssignments: () => { asgCalls++; return assigned; },
    getExam: () => null, listProgramExams: () => [], pendingExamAttempt: () => null,
    getCourseProgress: () => ({}), getUserActivityStates: () => ({}), bestAttempt: () => null,
  };
  const k = LC.createCompletion({ store: fake, getCourse, listProjects: () => projects, programsOfCourse });
  const row = (state, cohortId, cohorts) => ({ projectId: "tp", role: "learner", state, cohortId, addedAt: iso(0), cohorts });
  // A 第 0–10 天，B 第 10–20 天（第 20 天退训）
  members = [row("withdrawn", "kB", [{ cohortId: "kA", enteredAt: iso(0), leftAt: iso(10) }, { cohortId: "kB", enteredAt: iso(10), leftAt: iso(20) }])];
  assigned = { pa: { assignedAt: iso(0) }, pb: { assignedAt: iso(10) } };
  assert.equal(k.withdrawnOnly("u", "pa"), true, "a cohort before the move still counts");
  assert.equal(k.withdrawnOnly("u", "pb"), true);
  assigned = { pa: { assignedAt: iso(15) }, pb: { assignedAt: iso(5) } };
  assert.equal(k.withdrawnOnly("u", "pa"), false, "assigned after leaving A = not the project's");
  assert.equal(k.withdrawnOnly("u", "pb"), false, "assigned before entering B = HR's own");
  assert.equal(k.withdrawnOnly("u", "pb", { assignedAt: iso(12) }), true, "the caller's assignment row is used as given");
  assert.equal(k.withdrawnOnly("u", "pb", null), false, "no assignment row → keep reminding");
  assigned = { pa: { assignedAt: iso(30) } };
  assert.equal(k.withdrawnOnly("u", "pa"), false, "re-assigned after withdrawing");
  // 解析不了的结束时间按未结束；没有轨迹的旧行按「当前期次、addedAt 起」
  members = [row("withdrawn", "kA", [{ cohortId: "kA", enteredAt: iso(0), leftAt: "bad" }])];
  assert.equal(k.withdrawnOnly("u", "pa"), true);
  members = [row("withdrawn", "kA", undefined)];
  assert.equal(k.withdrawnOnly("u", "pa"), true, "legacy row without a history");
  // 缓存：同一批项目对象，期次引用只推导一次；传了指派行就不查库
  const before = getCourseCalls;
  asgCalls = 0;
  for (let i = 0; i < 50; i++) k.withdrawnOnly("u", "pa", { assignedAt: iso(1) });
  assert.equal(getCourseCalls, before, "cohort references are cached per cohort object");
  assert.equal(asgCalls, 0, "no assignment lookup when the caller passes the row");
  projects = [{ id: "tp", cohorts: [{ id: "kA", ...act("cb") }] }]; // 整批换掉（服务端 refreshContent 换 TPROJECTS）
  assert.equal(k.withdrawnOnly("u", "pa", { assignedAt: iso(1) }), false, "new project objects → recomputed (A now references b)");
  assert.equal(k.withdrawnOnly("u", "pb", { assignedAt: iso(1) }), true);
});

test("static guards: tpProgramIds delegates to completion.js; the server and the job both pass the project resolver", () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
  const server = require("./helpers.js").serverSource();   // server.js + modules/*/routes.js
  assert.match(server, /function tpProgramIds\(cohort\) \{\r?\n\s*return LC\.cohortProgramIds\(/);
  assert.match(server, /listProjects: \(\) => TPROJECTS, programsOfCourse:/);
  const job = read("scripts", "notify-due.js");
  assert.match(job, /store\.listContent\("tproject"\)/);
  assert.match(job, /listProjects: \(\) => projects, programsOfCourse: programsOfCourseFrom\(/);
  assert.match(read("store.js"), /function listUserMemberships\(userId\)/);
  // 调用方手上的指派行直接传进去（逐行判定不再查库）；定时任务先按截止日筛再判定
  assert.match(server, /COMPLETION\.reminderEligible\(u, p, a\)/);
  assert.match(server, /COMPLETION\.reminderEligible\(u, p, asg\[p\.id\]\)/);
  assert.match(job, /if \(d == null \|\| d > 3\) continue;[\s\S]*?programDone\(u\.id, p\)[\s\S]*?reminderEligible\(u, p, asg\[pid\]\)/);
});
