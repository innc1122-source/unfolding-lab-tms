// 第三批 1.4（2026-10-08）：培训概览的请求级快照（training-stats.createSnapshotStore）与实时 store 给出完全相同的完成口径。
// 临时库上铺一批人 × 课程（线上模块进度、线下出勤含请假、考试通过 / 未通过 / 待复核 / 作废），逐对比较
// programDone、programProgress、resultPending、programDoneAt；另验 programDoneAt 的几条规则。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-parity-"));
process.env.LMS_DB_PATH = path.join(dir, "parity.db");
process.env.LMS_ATTACH_DIR = path.join(dir, "attachments");
process.env.LMS_NO_DEMO_USERS = "1";
const store = require("../store.js");
const LC = require("../modules/learning/completion.js");
const TS = require("../modules/learning/training-stats.js");

let courses, programs, users;
const getCourse = (id) => courses.find((c) => c.id === id) || null;
const iso = (s) => new Date(s).toISOString();

before(() => {
  store.init({ hashPassword: () => "x" });
  // 一门线下课程（开课 2026-08-03 09:00）与它的包装程序 + 已发布考试；一门线下无考试
  store.putContent("course", "off1", { id: "off1", title: "Off 1", mode: "offline", sessionAt: "2026-08-03T09:00", status: "published", modules: [] });
  store.putContent("program", "pw-off1", { id: "pw-off1", title: "Off 1", courseIds: ["off1"], status: "published" });
  store.putContent("course", "off2", { id: "off2", title: "Off 2", mode: "offline", status: "published", modules: [] });
  store.putContent("program", "pw-off2", { id: "pw-off2", title: "Off 2", courseIds: ["off2"], status: "published" });
  store.createExam({ id: "exam-off1", programId: "pw-off1", title: "Off exam", status: "published", passingScore: 60, mcqCount: 1, openCount: 0, showAnswersAfterExam: true });
  courses = store.listContent("course");
  programs = store.listContent("program");
  users = [];
  for (let i = 0; i < 12; i++) {
    const id = "pu-" + i;
    store.createUser({ id, employeeId: "PAR-" + i, name: "P " + i, role: "employee", passwordHash: "x", department: "D" });
    users.push(id);
  }
  const online = courses.filter((c) => (c.mode || "online") !== "offline" && (c.modules || []).length);
  let n = 0;
  for (const [ui, uid] of users.entries()) {
    for (const p of programs) if ((ui + p.id.length) % 3 !== 0) store.setAssignment(uid, p.id, ui % 2 ? "2026-09-01" : null);
    // 线上模块：前 ui % 4 个课程学完，其余学一半
    online.forEach((c, ci) => {
      const k = ci < ui % 4 ? c.modules.length : Math.floor(c.modules.length / 2);
      c.modules.slice(0, k).forEach((m, mi) => store.setModuleComplete(uid, c.id, m.id, iso(`2026-0${(mi % 8) + 1}-1${ci % 10}T0${mi % 9}:00:00Z`)));
    });
    // 线下出勤：出席 / 迟到 / 请假 / 无
    const st = ["attended", "late", "excused", null][ui % 4];
    if (st) for (const cid of ["off1", "off2"]) store.setActivityState({ projectId: "__course__", cohortId: cid, activityId: "course:" + cid, userId: uid, status: st, by: null });
    // 答卷：每个已发布考试 0–3 份，混合通过 / 未通过 / 待复核 / 作废
    for (const e of store.listExams().filter((x) => x.status === "published")) {
      for (let a = 0; a < (ui + a) % 4; a++) {
        const aid = "pa-" + (++n);
        store.createAttempt({ id: aid, userId: uid, programId: e.programId, examId: e.id, startedAt: iso("2026-09-0" + (a + 1) + "T01:00:00Z"), questions: [] });
        const pct = [40, 85, 85, 70][(ui + a) % 4];
        store.submitAttempt(aid, { submittedAt: iso(`2026-09-0${a + 1}T0${ui % 9}:30:00Z`), answers: {}, percent: pct, passed: pct >= 60, detail: [], gradingStatus: (ui + a) % 5 === 0 ? "pending_review" : "final" });
        if ((ui * 7 + a) % 6 === 0) store.voidUserExamAttempts(uid, e.id);
      }
    }
  }
});
after(() => { try { store.close(); } catch {} });

test("snapshot completion equals live completion for every (user, program) pair", () => {
  const live = LC.createCompletion({ store, getCourse });
  const snap = TS.createSnapshotStore(store);
  const fast = LC.createCompletion({ store: snap, getCourse, memoExams: true });
  let pairs = 0, done = 0;
  for (const uid of users) for (const p of programs) {
    pairs++;
    const a = { done: live.programDone(uid, p), prog: live.programProgress(uid, p), pend: live.resultPending(uid, p), at: live.programDoneAt(uid, p), best: store.bestAttempt(uid, p.id) };
    const b = { done: fast.programDone(uid, p), prog: fast.programProgress(uid, p), pend: fast.resultPending(uid, p), at: fast.programDoneAt(uid, p), best: snap.bestAttempt(uid, p.id) };
    if (a.done) done++;
    assert.deepEqual([b.done, b.prog, b.pend, b.at], [a.done, a.prog, a.pend, a.at], `${uid} × ${p.id}`);
    assert.deepEqual(b.best ? [b.best.id, b.best.percent] : null, a.best ? [a.best.id, a.best.percent] : null, `best attempt ${uid} × ${p.id}`);
    assert.deepEqual(snap.getUserAssignments(uid)[p.id] || null, store.getUserAssignments(uid)[p.id] || null);
  }
  assert.ok(pairs > 30 && done > 0 && done < pairs, `meaningful mix: ${done} of ${pairs} done`);
});

test("programDoneAt rules: exam = earliest settled pass, max with attendance (session date when earlier); examless = latest module / attendance; null when not done", () => {
  const live = LC.createCompletion({ store, getCourse });
  const off1 = programs.find((p) => p.id === "pw-off1"), off2 = programs.find((p) => p.id === "pw-off2");
  store.createUser({ id: "pr-x", employeeId: "PAR-X", name: "X", role: "employee", passwordHash: "x", department: "D" });
  assert.equal(live.programDoneAt("pr-x", off1), null, "not done → null");
  // 出席记录写在场次之后（事后补录）→ 用开课时间
  store.setActivityState({ projectId: "__course__", cohortId: "off1", activityId: "course:off1", userId: "pr-x", status: "attended", by: null });
  store.createAttempt({ id: "px-1", userId: "pr-x", programId: "pw-off1", examId: "exam-off1", startedAt: iso("2026-07-01T00:00:00Z"), questions: [] });
  store.submitAttempt("px-1", { submittedAt: iso("2026-07-01T02:00:00Z"), answers: {}, percent: 90, passed: true, detail: [], gradingStatus: "final" });
  store.createAttempt({ id: "px-2", userId: "pr-x", programId: "pw-off1", examId: "exam-off1", startedAt: iso("2026-07-05T00:00:00Z"), questions: [] });
  store.submitAttempt("px-2", { submittedAt: iso("2026-07-05T02:00:00Z"), answers: {}, percent: 95, passed: true, detail: [], gradingStatus: "final" });
  assert.equal(live.programDoneAt("pr-x", off1), new Date("2026-08-03T09:00").toISOString(), "session (2026-08-03 local) is later than the first pass (07-01) and earlier than the roll-call write");
  // 没有开课时间的线下课程：出席行的时间
  store.setActivityState({ projectId: "__course__", cohortId: "off2", activityId: "course:off2", userId: "pr-x", status: "late", by: null });
  const at2 = store.getUserActivityStates("pr-x", "__course__")["course:off2"].at;
  assert.equal(live.programDoneAt("pr-x", off2), new Date(at2).toISOString());
  // 线上无考试课程：最后一个模块的完成时间
  const c = courses.find((x) => (x.mode || "online") !== "offline" && (x.modules || []).length >= 2 && !programs.some((p) => (p.courseIds || []).includes(x.id) && store.listProgramExams(p.id).some((e) => e.status === "published")));
  if (c) {
    const p = programs.find((x) => (x.courseIds || []).length === 1 && x.courseIds[0] === c.id);
    c.modules.forEach((m, i) => store.setModuleComplete("pr-x", c.id, m.id, iso(`2026-06-0${i + 1}T03:00:00Z`)));
    assert.equal(live.programDoneAt("pr-x", p), iso(`2026-06-0${c.modules.length}T03:00:00Z`));
  }
});
