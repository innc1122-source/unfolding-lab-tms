// 第四批 7 / 9.2（2026-10-08）：公开课程与自主学习的规则（modules/learning/public-courses.js）与 store 层的来源字段（迁移 74）。
//   目录收录（公开、已发布、只列 1:1 包装程序、线下按开课日、已加入的人始终可见）；加入 / 退出判定表；9.2 关闭时的移出名单（A/B/C）
//   与 B/C 的访问判定；public 键缺省保持原值；来源合并规则；以及临时库上 setAssignment 把自主学习改为指派、selfEnroll 不动已有行、
//   removeSelfEnrollment 只删自主学习行、快照与实时 store 同样带 source；迁移 73 的考试选项三列默认值与读写。
"use strict";
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-pubcourse-"));
process.env.LMS_DB_PATH = path.join(dir, "pub.db");
process.env.LMS_ATTACH_DIR = path.join(dir, "attachments");
process.env.LMS_NO_DEMO_USERS = "1";
const PC = require("../modules/learning/public-courses.js");
const store = require("../store.js");
const TS = require("../modules/learning/training-stats.js");

before(() => { store.init({ hashPassword: () => "x" }); });

const course = (o = {}) => ({ id: "c1", title: "C1", status: "published", public: true, mode: "online", ...o });
const wrapper = (o = {}) => ({ id: "pw-c1", courseIds: ["c1"], status: "published", ...o });

test("policy constant is the owner's decision A (keep until finished)", () => {
  assert.equal(PC.PUBLIC_CLOSE_POLICY, "A");
});

test("catalogEligible: public + published wrapper only; offline listed until the session day unless already joined", () => {
  const today = "2026-10-08";
  assert.equal(PC.catalogEligible(wrapper(), course(), { today }), true);
  assert.equal(PC.catalogEligible(wrapper(), course({ public: false }), { today }), false, "not public");
  assert.equal(PC.catalogEligible(wrapper(), course({ public: "true" }), { today }), false, "only boolean true counts");
  assert.equal(PC.catalogEligible(wrapper(), course({ status: "draft" }), { today }), false, "unpublished course");
  assert.equal(PC.catalogEligible(wrapper({ status: "archived" }), course(), { today }), false, "archived wrapper");
  assert.equal(PC.catalogEligible({ id: "pkg", courseIds: ["c1", "c2"], status: "published" }, course(), { today }), false, "legacy multi-course package never listed");
  assert.equal(PC.catalogEligible(wrapper(), null, { today }), false, "course missing");
  assert.equal(PC.catalogEligible(wrapper(), course(), { today, isWrapper: false }), false);
  // 线下：未填开课时间 / 开课日在今天或以后 → 列出；已过 → 不列，除非本人已有这门课
  assert.equal(PC.catalogEligible(wrapper(), course({ mode: "offline" }), { today }), true);
  assert.equal(PC.catalogEligible(wrapper(), course({ mode: "offline", sessionAt: "2026-10-08T14:00" }), { today }), true, "session today");
  assert.equal(PC.catalogEligible(wrapper(), course({ mode: "offline", sessionAt: "2026-10-20T09:00" }), { today }), true);
  assert.equal(PC.catalogEligible(wrapper(), course({ mode: "offline", sessionAt: "2026-10-07T09:00" }), { today }), false, "session passed");
  assert.equal(PC.catalogEligible(wrapper(), course({ mode: "offline", sessionAt: "2026-10-07T09:00" }), { today, hasCourse: true }), true, "already joined stays visible");
  assert.equal(PC.sessionPassed(course({ mode: "offline", sessionAt: "2026-10-07T09:00" }), today), true);
  assert.equal(PC.sessionPassed(course({ mode: "online", sessionAt: "2026-10-07T09:00" }), today), false);
});

test("enrollDecision: none → enroll; self / assigned → already; not listed → not_public; passed session / inactive refused", () => {
  const today = "2026-10-08";
  assert.deepEqual(PC.enrollDecision({ listed: true, asg: null, course: course(), today }), { action: "enroll" });
  assert.deepEqual(PC.enrollDecision({ listed: true, asg: { source: "self" }, course: course(), today }), { action: "already", status: "self" });
  assert.deepEqual(PC.enrollDecision({ listed: true, asg: { source: null }, course: course(), today }), { action: "already", status: "assigned" });
  assert.deepEqual(PC.enrollDecision({ listed: false, asg: null, course: course({ public: false }), today }), { action: "reject", code: "not_public" });
  assert.deepEqual(PC.enrollDecision({ listed: false, asg: { source: "self" }, course: course({ public: false }), today }), { action: "reject", code: "not_public" }, "closed course: nobody can newly join, and the uniform answer is not_public");
  assert.deepEqual(PC.enrollDecision({ listed: true, asg: null, course: course({ mode: "offline", sessionAt: "2026-10-01T09:00" }), today }), { action: "reject", code: "session_passed" });
  assert.deepEqual(PC.enrollDecision({ listed: true, asg: null, course: course(), today, active: false }), { action: "reject", code: "inactive" });
  assert.equal(PC.myStatusOf(null), "none");
  assert.equal(PC.myStatusOf({ source: "self" }), "self");
  assert.equal(PC.myStatusOf({ dueAt: null }), "assigned");
});

test("leaveDecision: only self-directed and not done", () => {
  assert.deepEqual(PC.leaveDecision({ asg: { source: "self" }, done: false }), { ok: true });
  assert.deepEqual(PC.leaveDecision({ asg: { source: "self" }, done: true }), { ok: false, code: "already_done" });
  assert.deepEqual(PC.leaveDecision({ asg: { source: null }, done: false }), { ok: false, code: "not_self" });
  assert.deepEqual(PC.leaveDecision({ asg: null, done: false }), { ok: false, code: "not_self" });
});

test("planPublicClose (A/B/C): never-started self rows are removed; started and done are kept", () => {
  const rows = [
    { userId: "u-new", started: false, done: false },
    { userId: "u-mid", started: true, done: false },
    { userId: "u-done", started: true, done: true },
    { userId: "u-done-noprog", started: false, done: true },
  ];
  for (const pol of ["A", "B", "C"]) {
    assert.deepEqual(PC.planPublicClose(rows, pol), { remove: ["u-new"], keep: ["u-mid", "u-done", "u-done-noprog"] }, pol);
  }
  assert.deepEqual(PC.planPublicClose([], "A"), { remove: [], keep: [] });
});

test("selfAccessBlocked: A never blocks; B blocks unfinished self rows on a closed course; C after 30 days", () => {
  const closed = { public: false, publicClosedAt: "2026-10-01T00:00:00.000Z" };
  const self = { source: "self" };
  const at = (d) => Date.parse(d);
  assert.equal(PC.selfAccessBlocked({ asg: self, course: closed, done: false, policy: "A" }), false);
  assert.equal(PC.selfAccessBlocked({ asg: self, course: closed, done: false, policy: "B" }), true);
  assert.equal(PC.selfAccessBlocked({ asg: self, course: closed, done: true, policy: "B" }), false, "finished people keep their record");
  assert.equal(PC.selfAccessBlocked({ asg: { source: null }, course: closed, done: false, policy: "B" }), false, "assigned learners unaffected");
  assert.equal(PC.selfAccessBlocked({ asg: self, course: { public: true }, done: false, policy: "B" }), false, "re-opened → access back");
  assert.equal(PC.selfAccessBlocked({ asg: self, course: closed, done: false, policy: "C", nowMs: at("2026-10-20T00:00:00Z") }), false);
  assert.equal(PC.selfAccessBlocked({ asg: self, course: closed, done: false, policy: "C", nowMs: at("2026-11-05T00:00:00Z") }), true);
});

test("applyPublicFlag: absent key keeps the previous value; changes stamp publicSince / publicClosedAt", () => {
  const now = "2026-10-08T01:00:00.000Z";
  assert.deepEqual(PC.applyPublicFlag({ public: true, publicSince: "x" }, undefined, now), { public: true, publicSince: "x", publicClosedAt: null, changed: null });
  assert.deepEqual(PC.applyPublicFlag({}, true, now), { public: true, publicSince: now, publicClosedAt: null, changed: "open" });
  assert.deepEqual(PC.applyPublicFlag({ public: true, publicSince: "s" }, false, now), { public: false, publicSince: "s", publicClosedAt: now, changed: "close" });
  assert.deepEqual(PC.applyPublicFlag({ public: true, publicSince: "s" }, true, now).changed, null);
  assert.equal(PC.applyPublicFlag({}, "yes", now).public, false, "only boolean true");
  assert.equal(PC.clipSummary("a".repeat(300)).length, 240);
  assert.equal(PC.clipSummary("  "), null);
});

test("mergeSource: an assignment always wins; joining from the catalog never downgrades an assignment", () => {
  assert.equal(PC.mergeSource(null, "self"), "self");
  assert.equal(PC.mergeSource("self", "assigned"), "assigned");
  assert.equal(PC.mergeSource("assigned", "self"), "assigned");
  assert.equal(PC.mergeSource("self", "self"), "self");
  assert.equal(PC.mergeSource(null, "assigned"), "assigned");
});

test("store (migration 74): selfEnroll / setAssignment / removeSelfEnrollment follow mergeSource; snapshot carries source", () => {
  const ids = ["ps-1", "ps-2"];
  for (const id of ids) store.createUser({ id, employeeId: id.toUpperCase(), name: id, role: "employee", passwordHash: "x", department: "D" });
  assert.equal(store.selfEnroll("ps-1", "pw-x"), 1);
  assert.equal(store.selfEnroll("ps-1", "pw-x"), 0, "idempotent");
  let a = store.getUserAssignments("ps-1")["pw-x"];
  assert.equal(a.source, "self");
  assert.equal(a.dueAt, null);
  const firstAssignedAt = a.assignedAt;
  // HR 指派同一门课：改为指派、带截止日、保留原 assignedAt
  store.setAssignment("ps-1", "pw-x", "2026-12-31");
  a = store.getUserAssignments("ps-1")["pw-x"];
  assert.deepEqual([a.source, a.dueAt, a.assignedAt], [null, "2026-12-31", firstAssignedAt]);
  // 已有指派时自主加入不改任何东西
  assert.equal(store.selfEnroll("ps-1", "pw-x"), 0);
  assert.equal(store.getUserAssignments("ps-1")["pw-x"].source, null);
  // 退出只删自主学习行
  assert.equal(store.removeSelfEnrollment("ps-1", "pw-x"), 0, "assigned row untouched");
  store.selfEnroll("ps-2", "pw-x");
  assert.deepEqual(store.listSelfEnrollments("pw-x").map((r) => r.userId), ["ps-2"]);
  assert.equal(store.removeSelfEnrollment("ps-2", "pw-x"), 1);
  assert.equal(store.getUserAssignments("ps-2")["pw-x"], undefined);
  store.selfEnroll("ps-2", "pw-y");
  const all = store.listAllAssignments().filter((r) => ids.includes(r.userId));
  assert.deepEqual(all.map((r) => [r.userId, r.programId, r.source]).sort(), [["ps-1", "pw-x", null], ["ps-2", "pw-y", "self"]]);
  const snap = TS.createSnapshotStore(store);
  for (const id of ids) assert.deepEqual(snap.getUserAssignments(id), store.getUserAssignments(id), "snapshot = live store, incl. source");
});

test("store (migration 73): exam options default to shuffle / proportional / 0 cases and round-trip", () => {
  store.putContent("program", "pw-ex", { id: "pw-ex", title: "Ex", courseIds: [], status: "published" });
  const base = { programId: "pw-ex", title: "E", status: "draft", passingScore: 60, mcqCount: 1, openCount: 0, showAnswersAfterExam: true };
  const d = store.createExam({ id: "ex-def", ...base });
  assert.deepEqual([d.shuffleOptions, d.partialCredit, d.caseCount], [true, true, 0]);
  const f = store.createExam({ id: "ex-fix", ...base, shuffleOptions: false, partialCredit: false, caseCount: 3 });
  assert.deepEqual([f.shuffleOptions, f.partialCredit, f.caseCount], [false, false, 3]);
  // 只改状态（{ ...e, status }）不丢选项
  const u = store.updateExam("ex-fix", { ...f, status: "archived" });
  assert.deepEqual([u.status, u.shuffleOptions, u.partialCredit, u.caseCount], ["archived", false, false, 3]);
  const u2 = store.updateExam("ex-fix", { ...base });
  assert.deepEqual([u2.shuffleOptions, u2.partialCredit, u2.caseCount], [true, true, 0], "omitted keys = defaults");
});
