// 到期提醒按统一完成口径判定（2026-10-07，需求 (2)）：定时任务 scripts/notify-due.js、一键提醒
// POST /api/admin/training/remind-overdue、培训概览的逾期名单（remindable）三处用同一个 programDone 与同一份提醒资格
// （modules/learning/completion.js）。
//   · 线下课程无考试：出席 / 迟到 = 完成，不提醒；请假、缺勤、没有登记 = 逾期。
//   · 线下课程有考试：考试通过且出席才算完成；通过后被改为缺勤或请假 → 逾期。
//   · 线上课程：无考试学完即完成；有考试须通过；关掉「需要结业考试」后学完即完成。
//   · 不提醒：已离职（账号仍可用）、纯服务账号（也是员工的管理员照常提醒）、课程已下线、课程无法完成
//     （线上 0 个模块且无考试）、成绩待定（待 HR 复核）；培训模块关闭时脚本整体不运行。
//   · 一键提醒带看板筛选条件时，提醒的正好是看板逾期名单里可提醒的人。
// 夹具都经 HTTP 搭在一次性临时库上；脚本另起子进程跑，配置（邮件 + 落盘 sink）写在临时目录。
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
let srv, admin, dir, cfg, sink, seq = 0;
let mainRun = null;           // 第一次（正式）运行的结果
const P = {};                 // tag → { id, employeeId, email, c? }
const C = {};                 // key → { cid, pid, examId, moduleIds }
let deptF = null;             // 「ND Filter」部门 id

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
const one = (sql, ...a) => dbRead((d) => d.prepare(sql).get(...a));
const all = (sql, ...a) => dbRead((d) => d.prepare(sql).all(...a));
function dbWrite(sql, ...a) {
  const d = new DatabaseSync(srv.dbPath);
  try { d.exec("PRAGMA busy_timeout = 5000"); return d.prepare(sql).run(...a); } finally { d.close(); }
}
const dueRows = () => one("SELECT COUNT(*) AS n FROM notifications WHERE type IN ('due_soon', 'overdue')").n;
const remindedOf = (p, type) => all("SELECT link FROM notifications WHERE userId = ? AND type = ?", p.id, type).map((r) => r.link);
const dayPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function runScript(extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "notify-due.js")], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, LMS_DB_PATH: srv.dbPath, LMS_ATTACH_DIR: path.join(dir, "attachments"), LMS_CONFIG_PATH: cfg, LMS_DISABLE_AI: "1", LMS_EMAIL_SINK: sink, LMS_MODULES_OFF: "", ...extraEnv },
  });
  const m = /due soon: (\d+), overdue: (\d+)/.exec(r.stdout || "");
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", dueSoon: m ? Number(m[1]) : null, overdue: m ? Number(m[2]) : null };
}
function mails() {
  return fs.existsSync(sink) ? fs.readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function mkPerson(tag, { login = false, department } = {}) {
  const employeeId = `ND${tag}-${String(++seq).padStart(3, "0")}`;
  const email = employeeId.toLowerCase() + "@example.com";
  const made = await admin.post("/api/admin/employees", { name: "Due " + employeeId, employeeId, email, programIds: [], ...(department ? { department } : {}) });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const p = { id: one("SELECT id FROM users WHERE employeeId = ?", employeeId).id, employeeId, email };
  if (login) {
    p.c = await loginAs(srv.base, { employeeId, password: made.data.password });
    assert.equal((await p.c.post("/api/auth/change-password", { currentPassword: made.data.password, newPassword: employeeId + "-pw-2026" })).status, 200);
  }
  P[tag] = p;
  return p;
}
async function mkCourse(key, { mode = "online", modules = 1, exam = false } = {}) {
  const cid = "nd-" + key;
  const body = { id: cid, title: "Due " + key, title_zh: "提醒 " + key, status: "published", mode, modules: [] };
  if (mode === "offline") Object.assign(body, { location: "Room 3", sessionAt: "2026-01-02T09:00" });
  else for (let i = 1; i <= modules; i++) body.modules.push({ id: `${cid}-m${i}`, title: "Module " + i, minutes: 5, sections: [] });
  const put = await admin.put("/api/admin/content/courses/" + cid, body);
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const out = { cid, pid: "pw-" + cid, moduleIds: body.modules.map((m) => m.id), examId: null };
  if (exam) {
    const q = await admin.post("/api/admin/questions", { courseId: cid, type: "mcq", question: `Due exam ${key}?`, options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] });
    assert.equal(q.status, 200, JSON.stringify(q.data));
    const ex = await admin.post("/api/admin/exams", { programId: out.pid, title: "Exam " + key, courseIds: [cid], passingScore: 50, mcqCount: 1, openCount: 0, status: "published" });
    assert.equal(ex.status, 200, JSON.stringify(ex.data));
    out.examId = ex.data.id;
  }
  C[key] = out;
  return out;
}
async function assign(p, course, dueAt) {
  const r = await admin.post("/api/admin/assignments", { userId: p.id, items: [{ programId: course.pid, assigned: true, dueAt }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function completeAll(p, course) {
  for (const mid of course.moduleIds) assert.equal((await p.c.post(`/api/courses/${course.cid}/modules/${mid}/complete`)).status, 200);
}
async function takeExam(p, course, right) {
  const st = await p.c.post("/api/exam/start", { examId: course.examId });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const answers = {};
  for (const q of st.data.questions) answers[q.id] = q.options.findIndex((o) => o.text === (right ? "right" : "wrong"));
  const sub = await p.c.post(`/api/exam/${st.data.attemptId}/submit`, { answers });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  return st.data.attemptId;
}
const mark = async (course, p, status) => assert.equal((await admin.post(`/api/admin/courses/${course.cid}/checkin/mark`, { userId: p.id, status })).status, 200);

before(async () => {
  dir = tempDir("lms-notify-due-");
  cfg = path.join(dir, "script-config.json");
  fs.writeFileSync(cfg, JSON.stringify({ email: { provider: "resend", apiKey: "x", from: "t@x" } }));
  sink = path.join(dir, "mail.jsonl");
  srv = await startServer();          // 服务端自己没有邮件配置；邮件只看脚本那一份 config
  admin = await loginAs(srv.base, ADMIN);

  // ① 线下课程、无考试
  const off = await mkCourse("off", { mode: "offline" });
  for (const t of ["A1", "A2", "A3", "A4", "A5"]) await assign(await mkPerson(t), off, PAST);
  await mark(off, P.A1, "attended");
  await mark(off, P.A2, "late");
  await mark(off, P.A3, "excused");
  await mark(off, P.A4, "absent");
  // ③ 线下课程、有已发布考试：出席 → 通过；B2 之后改缺勤、B3 改请假
  const offx = await mkCourse("offx", { mode: "offline", exam: true });
  for (const t of ["B1", "B2", "B3"]) {
    const p = await mkPerson(t, { login: true });
    await assign(p, offx, PAST);
    await mark(offx, p, "attended");
    await takeExam(p, offx, true);
  }
  await mark(offx, P.B2, "absent");
  await mark(offx, P.B3, "excused");
  // ④ 线上无考试：D1 学完、D2 没学；D3 的课先有考试、关掉「需要结业考试」后学完
  const on = await mkCourse("on");
  await assign(await mkPerson("D1", { login: true }), on, PAST);
  await assign(await mkPerson("D2"), on, PAST);
  await completeAll(P.D1, on);
  const tog = await mkCourse("tog", { exam: true });
  await assign(await mkPerson("D3", { login: true }), tog, PAST);
  assert.equal((await admin.post(`/api/admin/programs/${tog.pid}/exam-required`, { required: false })).status, 200);
  await completeAll(P.D3, tog);
  // ⑤ 线上有考试：E1 学完但考试没过；E2 通过；H1 交卷后结论待定（待 HR 复核）
  const onx = await mkCourse("onx", { exam: true });
  for (const t of ["E1", "E2", "H1"]) { const p = await mkPerson(t, { login: true }); await assign(p, onx, PAST); await completeAll(p, onx); }
  await takeExam(P.E1, onx, false);
  await takeExam(P.E2, onx, true);
  const h1Attempt = await takeExam(P.H1, onx, false);
  dbWrite("UPDATE attempts SET gradingStatus = 'pending_review' WHERE id = ?", h1Attempt);
  // ⑥ 即将截止（今天 + 2 天）：F1 未完成、F2 已学完
  const soon = await mkCourse("soon");
  await assign(await mkPerson("F1"), soon, dayPlus(2));
  await assign(await mkPerson("F2", { login: true }), soon, dayPlus(2));
  await completeAll(P.F2, soon);
  // ⑦ 已离职（账号仍可用）；课程下线；无法完成的课程（线上 0 个模块、无考试）
  await assign(await mkPerson("G1"), off, PAST);
  assert.equal((await admin.put("/api/admin/employees/" + P.G1.id, { empStatus: "exited" })).status, 200);
  assert.equal(one("SELECT active FROM users WHERE id = ?", P.G1.id).active, 1, "the account itself is still active");
  const arch = await mkCourse("arch");
  await assign(await mkPerson("G2"), arch, PAST);
  const archDoc = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === arch.cid);
  assert.equal((await admin.put("/api/admin/content/courses/" + arch.cid, { ...archDoc, status: "archived" })).status, 200);
  const empty = await mkCourse("empty", { modules: 0 });
  await assign(await mkPerson("H2"), empty, PAST);
  // 后台账号：J1 也是员工（有部门）→ 照常提醒；J2 是纯服务账号（无部门、职位、入职日）→ 不提醒
  const dj = await admin.post("/api/admin/departments", { name: "ND Admins" });
  assert.equal(dj.status, 200, JSON.stringify(dj.data));
  await mkPerson("J1", { department: "ND Admins" });
  await mkPerson("J2");
  for (const t of ["J1", "J2"]) {
    assert.equal((await admin.put("/api/admin/employees/" + P[t].id, { role: "admin" })).status, 200);
    await assign(P[t], on, PAST);
  }
  // ⑫ 看板筛选：K1、K2 在「ND Filter」部门，K3 在别的部门；都逾期同一门课
  const df = await admin.post("/api/admin/departments", { name: "ND Filter" });
  assert.equal(df.status, 200, JSON.stringify(df.data));
  deptF = df.data.department.id;
  const dept = await mkCourse("dept");
  await assign(await mkPerson("K1", { department: "ND Filter" }), dept, PAST);
  await assign(await mkPerson("K2", { department: "ND Filter" }), dept, PAST);
  await assign(await mkPerson("K3", { department: "ND Admins" }), dept, PAST);
});
after(async () => { if (srv) await srv.stopAsync(); });

test("B8: with the learning module switched off the job sends nothing and says so (config or LMS_MODULES_OFF)", () => {
  const before = dueRows();
  const offCfg = path.join(dir, "learning-off.json");
  fs.writeFileSync(offCfg, JSON.stringify({ modules: { learning: false } }));
  const a = runScript({ LMS_CONFIG_PATH: offCfg });
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /learning module is off/);
  const b = runScript({ LMS_MODULES_OFF: "performance,learning" });
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /learning module is off/);
  assert.equal(dueRows(), before, "no reminder written");
  assert.equal(mails().length, 0, "no mail");
});

test("the job reminds exactly the people who are not done (programDone), and its counts match the rows it wrote", () => {
  const before = dueRows();
  mainRun = runScript();
  assert.equal(mainRun.code, 0, mainRun.err);
  assert.ok(mainRun.dueSoon != null && mainRun.overdue != null, mainRun.out);
  assert.equal(dueRows() - before, mainRun.dueSoon + mainRun.overdue, "printed counts = rows created");
  const od = (t) => remindedOf(P[t], "overdue");
  // ① 线下无考试：出席、迟到 = 完成
  assert.deepEqual(od("A1"), [], "attended is done");
  assert.deepEqual(od("A2"), [], "late is done");
  // ② 请假、缺勤、没有登记 = 逾期
  for (const t of ["A3", "A4", "A5"]) assert.deepEqual(od(t), ["#/program/" + C.off.pid], t);
  // ③ 有考试的线下课程：通过且出席才算完成
  assert.deepEqual(od("B1"), [], "passed and attended");
  assert.deepEqual(od("B2"), ["#/program/" + C.offx.pid], "passed, then marked absent");
  assert.deepEqual(od("B3"), ["#/program/" + C.offx.pid], "passed, then marked excused");
  // ④ 线上无考试
  assert.deepEqual(od("D1"), [], "100% with no exam is done");
  assert.deepEqual(od("D2"), ["#/program/" + C.on.pid]);
  assert.deepEqual(od("D3"), [], "exam switched off, then 100%");
  // ⑤ 线上有考试
  assert.deepEqual(od("E1"), ["#/program/" + C.onx.pid], "100% but the exam is not passed");
  assert.deepEqual(od("E2"), [], "passed");
  // ⑥ 即将截止
  assert.deepEqual(remindedOf(P.F1, "due_soon"), ["#/program/" + C.soon.pid]);
  assert.deepEqual(remindedOf(P.F2, "due_soon"), [], "already done — nothing due");
  // ⑦ 不提醒的人与课
  assert.deepEqual(od("G1"), [], "exited (account still active)");
  assert.deepEqual(od("G2"), [], "the course was retired");
  assert.deepEqual(od("H1"), [], "result pending HR review");
  assert.deepEqual(od("H2"), [], "an online course with no modules and no exam cannot be completed");
  assert.deepEqual(od("J1"), ["#/program/" + C.on.pid], "an admin who is also an employee is reminded");
  assert.deepEqual(od("J2"), [], "a pure service account is not");
});

test("email: only the reminded fixture people get a mail (the script's own config, mail captured by the sink)", () => {
  assert.ok(mainRun, "main run happened");
  const to = new Set(mails().map((m) => m.to));
  for (const t of ["A3", "A4", "A5", "B2", "B3", "D2", "E1", "F1", "J1"]) assert.ok(to.has(P[t].email), t + " gets a mail");
  for (const t of ["A1", "A2", "B1", "D1", "D3", "E2", "F2", "G1", "G2", "H1", "H2", "J2"]) assert.ok(!to.has(P[t].email), t + " gets no mail");
});

test("idempotent: a second run the same day creates nothing", () => {
  assert.ok(mainRun, "main run happened");
  const before = dueRows();
  const again = runScript();
  assert.equal(again.code, 0, again.err);
  assert.equal(again.dueSoon, 0);
  assert.equal(again.overdue, 0);
  assert.equal(dueRows(), before);
});

test("parity: the job, remind-overdue {programId} and the overview's remindable overdue rows name the same people", async () => {
  assert.ok(mainRun, "main run happened");
  const ov = (await admin.get("/api/admin/overview")).data;
  for (const key of ["off", "offx", "on", "onx", "empty"]) {
    const pid = C[key].pid;
    const byJob = all("SELECT u.employeeId AS e FROM notifications n JOIN users u ON u.id = n.userId WHERE n.type = 'overdue' AND n.link = ?", "#/program/" + pid).map((r) => r.e).sort();
    const rem = await admin.post("/api/admin/training/remind-overdue", { programId: pid });
    assert.equal(rem.status, 200, JSON.stringify(rem.data));
    const byButton = rem.data.sample.map((x) => x.employeeId).sort();
    assert.equal(rem.data.reminded, byButton.length, "fixtures stay under the 10-row sample");
    const row = ov.perProgram.find((p) => p.id === pid);
    const byBoard = row.overdueList.filter((o) => o.remindable !== false).map((o) => o.employeeId).sort();
    assert.deepEqual(byButton, byJob, key + ": remind-overdue = the job");
    assert.deepEqual(byBoard, byJob, key + ": overview remindable rows = the job");
  }
  // 看板仍把不提醒的人算进逾期（计数口径不变），只是 remindable:false
  const offRow = ov.perProgram.find((p) => p.id === C.off.pid);
  assert.equal(offRow.overdueList.find((o) => o.employeeId === P.G1.employeeId).remindable, false, "exited: listed, not remindable");
  const onxRow = ov.perProgram.find((p) => p.id === C.onx.pid);
  assert.equal(onxRow.overdueList.find((o) => o.employeeId === P.H1.employeeId).remindable, false, "result pending: listed, not remindable");
  const emptyRow = ov.perProgram.find((p) => p.id === C.empty.pid);
  assert.equal(emptyRow.overdueList.find((o) => o.employeeId === P.H2.employeeId).remindable, false, "cannot be completed: listed, not remindable");
  const onRow = ov.perProgram.find((p) => p.id === C.on.pid);
  assert.ok(onRow.overdueList.some((o) => o.employeeId === P.J1.employeeId), "the admin who is an employee is on the board");
  assert.ok(!onRow.overdueList.some((o) => o.employeeId === P.J2.employeeId), "the pure service account is not");
  // F4：下线的课程 —— 一键提醒不发
  const arch = await admin.post("/api/admin/training/remind-overdue", { programId: C.arch.pid });
  assert.equal(arch.data.reminded, 0, "retired course: nobody reminded");
});

test("overview button: with a department filter it reminds exactly the remindable people on that filtered list; unfiltered = the whole board", async () => {
  const board = (await admin.get("/api/admin/overview?dept=" + encodeURIComponent(deptF))).data;
  const people = new Set();
  for (const p of board.perProgram) for (const o of p.overdueList) if (o.remindable !== false) people.add(o.employeeId);
  assert.deepEqual([...people].sort(), [P.K1.employeeId, P.K2.employeeId].sort(), "the filtered board lists K1 and K2 only");
  const audit0 = one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'training.remind-overdue'").n;
  const r = await admin.post("/api/admin/training/remind-overdue", { dept: deptF });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reminded, people.size);
  assert.deepEqual(r.data.sample.map((x) => x.employeeId).sort(), [...people].sort());
  assert.equal(remindedOf(P.K3, "training").length, 0, "K3 (other department) is not reminded");
  const row = one("SELECT afterJson FROM audit_logs WHERE action = 'training.remind-overdue' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(row.afterJson).filtered, true, "the audit row says a filter was applied");
  assert.equal(one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'training.remind-overdue'").n, audit0 + 1);
  // programs 也可以传数组；与看板的 programs= 同一口径
  // CX-114：K1、K2 今天已就这门课收到过逾期提醒，不重复发送（计入 skippedToday），只发 K3
  const byProg = await admin.post("/api/admin/training/remind-overdue", { programs: [C.dept.pid] });
  assert.deepEqual(byProg.data.sample.map((x) => x.employeeId).sort(), [P.K3.employeeId]);
  assert.equal(byProg.data.reminded + byProg.data.skippedToday, 3);
  // 不筛选：与看板全量的可提醒人数一致
  const whole = (await admin.get("/api/admin/overview")).data;
  const everyone = new Set();
  for (const p of whole.perProgram) for (const o of p.overdueList) if (o.remindable !== false) everyone.add(o.userId);
  const all0 = await admin.post("/api/admin/training/remind-overdue", {});
  assert.equal(all0.data.reminded + all0.data.skippedToday, everyone.size, "unfiltered: one reminder per remindable person on the whole board (already reminded today → skippedToday)");
});

test("the employee learning record page data: done / hasExam / overdue per course, empStatus and position on the user", async () => {
  const d = (await admin.get(`/api/admin/employees/${P.B2.id}/detail`)).data;
  const row = d.programs.find((p) => p.id === C.offx.pid);
  assert.deepEqual([row.done, row.hasExam, row.overdue], [false, true, true], "passed but absent: not done, overdue");
  const ok = (await admin.get(`/api/admin/employees/${P.B1.id}/detail`)).data.programs.find((p) => p.id === C.offx.pid);
  assert.deepEqual([ok.done, ok.overdue], [true, false]);
  const g2 = (await admin.get(`/api/admin/employees/${P.G2.id}/detail`)).data;
  assert.equal(g2.programs.find((p) => p.id === C.arch.pid).overdue, false, "a retired course is not flagged overdue");
  const g1 = (await admin.get(`/api/admin/employees/${P.G1.id}/detail`)).data;
  assert.equal(g1.user.empStatus, "exited");
  assert.ok("position" in g1.user);
  // 员工端：/api/programs 的 done 与学习记录都不再显示「已通过」
  const mine = (await P.B2.c.get("/api/programs")).data.find((x) => x.id === C.offx.pid);
  assert.equal(mine.done, false);
  const rec = (await P.B2.c.get("/api/me/learning-record")).data.find((x) => x.id === C.offx.pid);
  assert.equal(rec.status, "overdue", "passed the exam but absent: not 「已通过」");
});

test("completion.csv: PASSED / Passed YES only when programDone; a voided pass is not a completion", async () => {
  const rows = async () => (await (await admin.raw("GET", "/api/admin/export/completion.csv?programs=" + encodeURIComponent(C.offx.pid))).text()).replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => l.split(",").map((x) => x.replace(/^"|"$/g, "")));
  let csv = await rows();
  const head = csv[0];
  const col = (r, name) => r[head.indexOf(name)];
  const rowOf = (p) => csv.find((r) => r[0] === p.employeeId);
  assert.equal(col(rowOf(P.B1), "Status"), "PASSED");
  assert.equal(col(rowOf(P.B1), "Passed"), "YES");
  assert.ok(col(rowOf(P.B1), "Passed at"));
  assert.equal(col(rowOf(P.B2), "Status"), "OVERDUE", "passed the exam but absent");
  assert.equal(col(rowOf(P.B2), "Passed"), "NO");
  assert.equal(col(rowOf(P.B2), "Passed at"), "");
  // 单条重置会作废通过的那次：之后 CSV 不再写 PASSED
  const reset = await admin.post(`/api/admin/exams/${C.offx.examId}/reset-attempts`, { userId: P.B1.id });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  csv = await rows();
  assert.equal(col(rowOf(P.B1), "Status"), "OVERDUE", "the pass was voided");
  assert.equal(col(rowOf(P.B1), "Passed"), "NO");
  assert.equal(col(rowOf(P.B1), "Passed at"), "");
});

test("completion.js unit: account rules, completable courses and resultPending", () => {
  assert.equal(LC.isServiceAccount({ role: "admin" }), true);
  assert.equal(LC.isServiceAccount({ role: "admin", department: "HR" }), false);
  assert.equal(LC.isServiceAccount({ role: "admin", hireDate: "2024-01-01" }), false);
  assert.equal(LC.isServiceAccount({ role: "employee" }), false);
  assert.equal(LC.isRemindableUser({ role: "admin", position: "HRBP", active: 1 }), true, "admin who is an employee");
  assert.equal(LC.isRemindableUser({ role: "employee", active: 1, empStatus: "exited" }), false);
  assert.equal(LC.isRemindableUser({ role: "employee", active: 0 }), false);
  assert.equal(LC.isPublishedProgram({ id: "x" }), true, "no status = published (legacy)");
  assert.equal(LC.isPublishedProgram({ id: "x", status: "archived" }), false);
  const courses = { on: { id: "on", mode: "online", modules: [] }, off: { id: "off", mode: "offline", modules: [] }, full: { id: "full", modules: [{ id: "m" }] } };
  const exams = { p1: [{ id: "e1", status: "published" }, { id: "e2", status: "archived" }] };
  const pending = new Set(["u1|e1", "u1|e2"]);
  const fake = {
    listProgramExams: (pid) => exams[pid] || [],
    pendingExamAttempt: (uid, eid) => (pending.has(uid + "|" + eid) ? { id: "a" } : null),
    getCourseProgress: () => ({}), getUserActivityStates: () => ({}), bestAttempt: () => null,
  };
  const k = LC.createCompletion({ store: fake, getCourse: (id) => courses[id] || null });
  assert.equal(k.programCompletable({ id: "p0", courseIds: ["on"] }), false, "online, no modules, no exam");
  assert.equal(k.programCompletable({ id: "p0", courseIds: [] }), false, "an empty legacy package");
  assert.equal(k.programCompletable({ id: "p0" }), false, "no courseIds at all");
  assert.equal(k.programCompletable({ id: "p0", courseIds: ["off"] }), true, "in-person: attendance completes it");
  assert.equal(k.programCompletable({ id: "p0", courseIds: ["full"] }), true);
  assert.equal(k.programCompletable({ id: "p1", courseIds: ["on"] }), true, "a published exam completes it");
  assert.equal(k.resultPending("u1", { id: "p1" }), true, "pending on a published exam");
  assert.equal(k.resultPending("u2", { id: "p1" }), false);
  pending.delete("u1|e1");
  assert.equal(k.resultPending("u1", { id: "p1" }), false, "a pending attempt on an archived exam does not count");
  assert.equal(k.reminderEligible({ id: "u1", role: "employee", active: 1 }, { id: "p1", courseIds: ["on"] }), true);
  assert.equal(k.reminderEligible({ id: "u1", role: "employee", active: 1 }, { id: "p1", courseIds: ["on"], status: "draft" }), false);
});

test("static guards: the job and the server share completion.js; ATTENDED_STATES is defined once; the handover package ships it", () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const job = strip(read("scripts", "notify-due.js"));
  assert.ok(!/bestAttempt\(/.test(job), "the job no longer judges by the best attempt");
  assert.ok(!/\.passed\b/.test(job), "the job no longer reads .passed");
  assert.match(job, /completion\.js/);
  assert.match(job, /programDone\(/);
  const server = read("server.js");
  assert.match(server, /require\("\.\/modules\/learning\/completion\.js"\)/);
  assert.ok(!/ATTENDED_STATES = \[/.test(server), "server.js takes ATTENDED_STATES from completion.js");
  assert.ok(!/ATTENDED_STATES = \[/.test(job));
  assert.match(read("modules", "learning", "completion.js"), /const ATTENDED_STATES = \["attended", "late"\];/);
  const pack = read("scripts", "package-handover.js");
  const must = pack.slice(pack.indexOf("MUST"));
  assert.match(must, /"modules\/learning\/completion\.js"/);
});

test("one population: completion.csv, the course assignees list and the in-person check-in roster keep the admin who is an employee and drop the pure service account (same as the overview)", async () => {
  // completion.csv 按课程筛选：在职行的人 = 看板该课程的指派人数；J1 在、J2 不在
  const csv = (await (await admin.raw("GET", "/api/admin/export/completion.csv?programs=" + encodeURIComponent(C.on.pid))).text())
    .replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => l.split(",").map((x) => x.replace(/^"|"$/g, "")));
  const head = csv[0];
  const ids = csv.slice(1).filter((r) => r[head.indexOf("Active")] === "YES").map((r) => r[0]);
  assert.ok(ids.includes(P.J1.employeeId), "admin who is an employee is exported");
  assert.ok(!ids.includes(P.J2.employeeId), "pure service account is not");
  const ov = (await admin.get("/api/admin/overview?programs=" + encodeURIComponent(C.on.pid))).data;
  assert.equal(ids.length, ov.perProgram.find((p) => p.id === C.on.pid).assigned, "CSV rows = the board's assigned count for the same filter");
  // 课程指派名单
  const asg = (await admin.get(`/api/admin/programs/${C.on.pid}/assignees`)).data.list.map((x) => x.employeeId);
  assert.ok(asg.includes(P.J1.employeeId) && !asg.includes(P.J2.employeeId));
  // 线下课程签到名单：J1 在名单上、能登记出勤，登记后看板算完成
  const offj = await mkCourse("offj", { mode: "offline" });
  for (const t of ["J1", "J2"]) await assign(P[t], offj, PAST);
  const roll = (await admin.get(`/api/admin/courses/${offj.cid}/checkin`)).data.list.map((x) => x.employeeId);
  assert.ok(roll.includes(P.J1.employeeId), "admin who is an employee is on the check-in roster");
  assert.ok(!roll.includes(P.J2.employeeId), "pure service account is not");
  await mark(offj, P.J1, "attended");
  const row = (await admin.get("/api/admin/overview?programs=" + encodeURIComponent(offj.pid))).data.perProgram.find((p) => p.id === offj.pid);
  assert.deepEqual([row.assigned, row.done, row.overdue], [1, 1, 0], "J1 attended → done on the board");
});
