// 批量操作 B1–B4（2026-10-06，docs/SPEC-bulk-ops-20261006.md）服务端功能测试。
//   B1 申请审批：POST /api/admin/enroll-requests/bulk-decide、/api/admin/nominations/bulk-decide
//   B2 期次与成员：POST /api/admin/tprojects/:id/members/bulk-update
//   B3 签到 / 完成登记名单：POST /api/admin/tprojects/:id/checkin/:act/bulk-mark
//   B4 题库：POST /api/admin/questions/bulk-update
// 第二批（2026-10-07）：B5 课程库 POST /api/admin/content/bulk-update、B7 考试成绩 POST /api/admin/attempts/bulk-reset
//   （B6 评估按阶段提醒在 test/review-reminders.test.js）
// 验收口径：勾选 3 条批量执行 = 逐条做 3 次（库里的行、站内通知、邮件、审计逐项一致）；逐条报告结果，成功的照常生效；
// 已是目标设置的条目算成功（unchanged）；抛异常整批回滚；超上限整批拒绝。数据范围与权限在 test/bulk-ops-rbac.test.js。
// 测试服一律是一次性临时库 + 临时 config（邮件写进 LMS_EMAIL_SINK，不发真邮件）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs, tempDir } = require("./helpers.js");
// CX-078（10/11）：员工输码签到只在活动当天开放 —— 签到用例的活动时间取「今天」（马尼拉日）：00:00 测迟到、23:59 测准时
const TODAY_YMD = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const TODAY_EARLY = TODAY_YMD + "T00:00", TODAY_LATE = TODAY_YMD + "T23:59";
// 迟到 = 活动开始 15 分钟后签到（按真实时钟）。马尼拉时间 00:00–00:20 之间，当天找不到「已开始超过 15 分钟」的时间点，
// 依赖「本人签到为迟到」的用例在这段时间跳过（只能当天签到，见 CX-078）
const MANILA_MIN = Math.floor(((Date.now() + 8 * 3600e3) % 86400e3) / 60000);
const NO_LATE_WINDOW = MANILA_MIN < 20 ? "马尼拉时间 00:20 前当天没有「已开始超过 15 分钟」的时间点，迟到用例跳过" : false;

let srv, admin, sink;
let seq = 0;

// ---------- 库与邮件 ----------
function dbRead(fn, dbPath) {
  const d = new DatabaseSync(dbPath || srv.dbPath, { readOnly: true });
  try { return fn(d); } finally { d.close(); }
}
const all = (sql, ...a) => dbRead((d) => d.prepare(sql).all(...a));
const one = (sql, ...a) => dbRead((d) => d.prepare(sql).get(...a));
function dbWrite(sql, ...a) {
  const d = new DatabaseSync(srv.dbPath);
  try { d.exec("PRAGMA busy_timeout = 5000"); return d.prepare(sql).run(...a); } finally { d.close(); }
}
const auditCount = () => one("SELECT COUNT(*) AS n FROM audit_logs").n;
const notifCount = () => one("SELECT COUNT(*) AS n FROM notifications").n;
function mails() {
  return fs.existsSync(sink) ? fs.readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
async function waitMails(to, match, n) {
  for (let i = 0; i < 60; i++) {
    const hit = mails().filter((m) => m.to === to && match(m));
    if (hit.length >= n) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return mails().filter((m) => m.to === to && match(m));
}

// ---------- 人与数据 ----------
async function mkEmp(tag, { login = false, programIds } = {}) {
  const employeeId = `BK${tag}-${String(++seq).padStart(3, "0")}`;
  const email = employeeId.toLowerCase() + "@example.com";
  const made = await admin.post("/api/admin/employees", { name: "Bulk " + employeeId, employeeId, email, ...(programIds ? { programIds } : {}) });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const p = { id: one("SELECT id FROM users WHERE employeeId = ?", employeeId).id, employeeId, email };
  if (login) {
    p.c = await loginAs(srv.base, { employeeId, password: made.data.password });
    assert.equal((await p.c.post("/api/auth/change-password", { currentPassword: made.data.password, newPassword: employeeId + "-pw-2026" })).status, 200);
  }
  return p;
}
async function mkEmps(n, tag, opts) { const out = []; for (let i = 0; i < n; i++) out.push(await mkEmp(tag, opts)); return out; }
// 把与某个人相关的 id / 工号 / 邮箱换成占位符：逐条与批量作用在不同的人身上，比的是「同一种写法」。
function canon(value, people) {
  let s = JSON.stringify(value);
  for (const p of people) s = s.split(p.email).join("<EMAIL>").split(p.employeeId).join("<EID>").split(p.id).join("<UID>");
  return JSON.parse(s);
}
async function mkElective(title) {
  const r = await admin.post("/api/admin/programs", { title, title_zh: title + "（选修）", status: "published", enrollType: "elective" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
async function enrollIds(programId) {
  const r = await admin.get("/api/admin/enroll-requests");
  assert.equal(r.status, 200);
  const out = {};
  for (const x of r.data) if (x.programId === programId) out[x.userId] = x.id;
  return out;
}
async function nominationIds(projectId) {
  const r = await admin.get("/api/admin/nominations");
  assert.equal(r.status, 200);
  const out = {};
  for (const x of r.data) if (x.projectId === projectId) out[x.userId] = x.id;
  return out;
}
async function mkProject(title, cohorts, status = "running") {
  const r = await admin.post("/api/admin/tprojects", { title, title_zh: title + "（培养）" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const put = await admin.put("/api/admin/tprojects/" + r.data.id, { status, cohorts });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  return r.data.id;
}
async function addMembers(pid, cohortId, people, classId) {
  const r = await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId, userIds: people.map((p) => p.id), ...(classId ? { classId } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.count, people.length);
}
const bulkDecide = (kind, ids, decision, extra) => admin.post(`/api/admin/${kind}/bulk-decide`, { ids, decision, ...(extra || {}) });
const bulkMembers = (pid, userIds, action, extra) => admin.post(`/api/admin/tprojects/${pid}/members/bulk-update`, { userIds, action, ...(extra || {}) });
const bulkMark = (pid, act, userIds, status) => admin.post(`/api/admin/tprojects/${pid}/checkin/${act}/bulk-mark`, { userIds, status });
const singleMark = (pid, act, userId, status) => admin.post(`/api/admin/tprojects/${pid}/checkin/${act}/mark`, { userId, status });
const bulkQ = (body) => admin.post("/api/admin/questions/bulk-update", body);
function summary(d) { return { ok: d.ok, total: d.total, done: d.done, skipped: d.skipped, unchanged: d.unchanged }; }
function assertBadReq(r, code) {
  assert.equal(r.status, 400, code + ": " + JSON.stringify(r.data));
  assert.equal(r.data.code, code);
  assert.ok(r.data.error && r.data.error_zh && /[一-鿿]/.test(r.data.error_zh), code + " carries error + error_zh");
}
async function rosterCode(pid, act) {
  const r = await admin.get(`/api/admin/tprojects/${pid}/checkin/${act}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(typeof r.data.code, "string", "the roll-call shows a code while the program is running");
  return r.data.code;
}
async function selfCheckin(person, pid, act) {
  // 码按整分钟换，服务端也收上一分钟的码；跨分钟时重取一次
  for (let i = 0; i < 2; i++) {
    const r = await person.c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: act, code: await rosterCode(pid, act) });
    if (r.status === 200) return r.data.status;
  }
  throw new Error("self check-in failed");
}
const stateRow = (activityId, userId) => { const r = one("SELECT projectId, cohortId, activityId, status, by, note FROM activity_state WHERE activityId = ? AND userId = ?", activityId, userId); return r ? { ...r } : null; };

before(async () => {
  const dir = tempDir("lms-bulkops-");
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ email: { provider: "resend", apiKey: "re_test_fake_key", from: "TMS <noreply@example.com>" } }));
  sink = path.join(dir, "mail.jsonl");
  srv = await startServer({ env: { LMS_CONFIG_PATH: cfg, LMS_EMAIL_SINK: sink } });
  admin = await loginAs(srv.base, ADMIN);
});
after(async () => { if (srv) await srv.stopAsync(); });

// =====================================================================
// B1 申请审批
// =====================================================================
let pool;   // 6 位登录过的员工（不带默认课程）：前 3 位走单条、后 3 位走批量，历史始终相同
async function enrollSnap(p, programId, title) {
  return canon({
    approval: all("SELECT kind, status, decidedBy, decideNote, subjectJson, note FROM approvals WHERE kind = 'enroll' AND targetUserId = ? AND subjectJson LIKE ?", p.id, `%"${programId}"%`),
    assignment: all("SELECT programId, dueAt FROM assignments WHERE userId = ? AND programId = ?", p.id, programId),
    notifications: all("SELECT type, title, title_zh, body, body_zh, link FROM notifications WHERE userId = ? AND type LIKE 'enroll.%' AND title LIKE ? ORDER BY createdAt", p.id, `%${title}%`),
    audit: all("SELECT actorId, actorName, action, target, beforeJson, afterJson FROM audit_logs WHERE action IN ('enroll.approve', 'enroll.reject') AND target = ? AND afterJson LIKE ? ORDER BY id", p.employeeId, `%"${programId}"%`),
    mail: (await waitMails(p.email, (m) => m.subject.includes(title), 1)).map((m) => ({ subject: m.subject, html: m.html })),
  }, [p]);
}

test("B1 选修课程申请 · 批量通过 3 条 = 单条通过 3 次：指派与截止日、决定、站内通知、邮件、审计逐项一致", async () => {
  pool = await mkEmps(6, "P", { login: true, programIds: [] });
  const title = "Bulk Elective Approve";
  const prog = await mkElective(title);
  for (const p of pool) assert.equal((await p.c.post("/api/me/enroll-requests", { programId: prog, note: "please" })).status, 200);
  const id = await enrollIds(prog);
  const single = pool.slice(0, 3), bulk = pool.slice(3);
  for (const p of single) assert.equal((await admin.post(`/api/admin/enroll-requests/${id[p.id]}/decide`, { decision: "approve" })).status, 200);
  const r = await bulkDecide("enroll-requests", bulk.map((p) => id[p.id]), "approve", { note: "" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  assert.deepEqual(r.data.results, bulk.map((p) => ({ id: id[p.id], ok: true })), "results follow the request order");
  for (let i = 0; i < 3; i++) {
    const s = await enrollSnap(single[i], prog, title), b = await enrollSnap(bulk[i], prog, title);
    assert.equal(s.assignment.length, 1, "approved = assigned");
    assert.equal(s.notifications.length, 1);
    assert.equal(s.audit.length, 1);
    assert.equal(s.mail.length, 1, "one email per approval");
    assert.deepEqual(b, s, "person " + i + ": bulk equals single");
  }
});

test("B1 选修课程申请 · 批量驳回 = 单条驳回：理由原样保存（不去首尾空格），通知正文「原因：…」一致", async () => {
  const title = "Bulk Elective Reject";
  const prog = await mkElective(title);
  for (const p of pool) assert.equal((await p.c.post("/api/me/enroll-requests", { programId: prog })).status, 200);
  const id = await enrollIds(prog);
  const note = "  Seats are full this quarter  ";
  for (const p of pool.slice(0, 3)) assert.equal((await admin.post(`/api/admin/enroll-requests/${id[p.id]}/decide`, { decision: "reject", note })).status, 200);
  const r = await bulkDecide("enroll-requests", pool.slice(3).map((p) => id[p.id]), "reject", { note });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, 3);
  for (let i = 0; i < 3; i++) {
    const s = await enrollSnap(pool[i], prog, title), b = await enrollSnap(pool[3 + i], prog, title);
    assert.equal(s.approval[0].decideNote, note);
    assert.equal(s.assignment.length, 0, "rejected = not assigned");
    assert.equal(s.notifications[0].body_zh, "原因：" + note);
    assert.deepEqual(b, s, "person " + i + ": bulk equals single");
  }
});

test("B1 驳回理由必填：空白理由 400 note_required，什么都没写；批量里混着已处理的申请 → 报「已处理，跳过」，其余照常生效", async () => {
  const people = await mkEmps(3, "D", { login: true, programIds: [] });
  const prog = await mkElective("Bulk Elective Mixed");
  for (const p of people) assert.equal((await p.c.post("/api/me/enroll-requests", { programId: prog })).status, 200);
  const id = await enrollIds(prog);
  const ids = people.map((p) => id[p.id]);
  const a0 = auditCount(), n0 = notifCount();
  for (const note of [undefined, "", "   "]) assertBadReq(await bulkDecide("enroll-requests", ids, "reject", note === undefined ? {} : { note }), "note_required");
  assertBadReq(await bulkDecide("enroll-requests", ids, "maybe"), "bad_decision");
  assertBadReq(await bulkDecide("enroll-requests", [], "approve"), "no_items");
  assertBadReq(await bulkDecide("enroll-requests", ids[0], "approve"), "no_items");   // 不是数组
  assert.equal(auditCount(), a0, "nothing audited");
  assert.equal(notifCount(), n0, "nobody notified");
  assert.ok(all("SELECT status FROM approvals WHERE id IN (?, ?, ?)", ...ids).every((x) => x.status === "pending"), "all still pending");
  // 单条先处理第 1 条，再批量处理全部 3 条（第 2 条重复出现、带空格）：去重后 3 项，1 项跳过
  assert.equal((await admin.post(`/api/admin/enroll-requests/${ids[0]}/decide`, { decision: "approve" })).status, 200);
  const r = await bulkDecide("enroll-requests", [ids[0], ids[1], ` ${ids[1]} `, ids[1], ids[2]], "approve");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 2, skipped: 1, unchanged: 0 });
  assert.deepEqual(r.data.results[0], { id: ids[0], ok: false, code: "already_decided", error: "Already decided — skipped.", error_zh: "已处理，跳过。" });
  assert.equal(all("SELECT id FROM audit_logs WHERE action = 'enroll.approve' AND target = ?", people[0].employeeId).length, 1, "no second audit for the decided one");
  assert.equal(all("SELECT id FROM notifications WHERE userId = ? AND type = 'enroll.approved'", people[0].id).length, 1, "no second notification");
  // 不存在 / 别的种类的审批 → not_found，不影响其余
  const ghost = await bulkDecide("enroll-requests", ["er-nope"], "approve");
  assert.equal(ghost.status, 200);
  assert.equal(ghost.data.results[0].code, "not_found");
});

async function nominationSnap(p, pid, title) {
  return canon({
    approval: all("SELECT kind, status, decidedBy, decideNote, subjectJson, note FROM approvals WHERE kind = 'nomination' AND targetUserId = ? AND subjectJson LIKE ?", p.id, `%"${pid}"%`),
    member: all("SELECT projectId, cohortId, role, classId, groupId, state FROM project_members WHERE projectId = ? AND userId = ?", pid, p.id),
    assignments: all("SELECT programId, dueAt FROM assignments WHERE userId = ? ORDER BY programId", p.id),
    notifications: all("SELECT type, title, title_zh, body, body_zh, link FROM notifications WHERE userId = ? AND type LIKE 'tproject.%' AND title LIKE ? ORDER BY createdAt", p.id, `%“${title}”%`),
    audit: all("SELECT actorId, actorName, action, target, beforeJson, afterJson FROM audit_logs WHERE action LIKE 'tproject.nomination.%' AND target = ? AND afterJson LIKE ? ORDER BY id", pid, `%"${p.employeeId}"%`),
  }, [p]);
}

test("B1 培养项目申请 · 批量通过 3 条 = 单条通过 3 次：入期次、派课、通知、邮件、审计一致；批量驳回 = 单条驳回", async () => {
  const pid = await mkProject("Bulk Nomination", [{
    id: "nm-co", name: "Open Cohort", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, open: true, classes: [],
    phases: [{ id: "nm-ph", name: "P1", gateMode: "time", activities: [{ id: "nm-course", type: "course", refId: "data-privacy" }] }],
  }], "planning");
  for (const p of pool) assert.equal((await p.c.post(`/api/me/tprojects/${pid}/apply`, { note: "keen" })).status, 200);
  const id = await nominationIds(pid);
  for (const p of pool.slice(0, 3)) assert.equal((await admin.post(`/api/admin/nominations/${id[p.id]}/decide`, { decision: "approve" })).status, 200);
  const r = await bulkDecide("nominations", pool.slice(3).map((p) => id[p.id]), "approve", { note: "" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  for (let i = 0; i < 3; i++) {
    const s = await nominationSnap(pool[i], pid, "Bulk Nomination"), b = await nominationSnap(pool[3 + i], pid, "Bulk Nomination");
    assert.equal(s.member.length, 1, "approved = joined the cohort");
    assert.ok(s.assignments.some((x) => x.programId === "nho"), "the cohort's course assigned");
    assert.equal(s.notifications.length, 1);
    assert.equal(s.audit.length, 1);
    assert.deepEqual(b, s, "person " + i + ": bulk equals single");
    const sm = await waitMails(pool[i].email, (m) => m.subject.includes("“Bulk Nomination”"), 1);
    const bm = await waitMails(pool[3 + i].email, (m) => m.subject.includes("“Bulk Nomination”"), 1);
    assert.equal(sm.length, 1);
    assert.deepEqual(canon(bm.map((m) => [m.subject, m.html]), [pool[3 + i]]), canon(sm.map((m) => [m.subject, m.html]), [pool[i]]), "same email");
  }
  // 驳回：另一个项目，1 条单条 vs 1 条批量
  const pid2 = await mkProject("Bulk Nomination Reject", [{ id: "nr-co", name: "Open", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, open: true, classes: [], phases: [] }], "planning");
  for (const p of [pool[0], pool[3]]) assert.equal((await p.c.post(`/api/me/tprojects/${pid2}/apply`, {})).status, 200);
  const id2 = await nominationIds(pid2);
  assert.equal((await admin.post(`/api/admin/nominations/${id2[pool[0].id]}/decide`, { decision: "reject", note: "Next intake" })).status, 200);
  const rj = await bulkDecide("nominations", [id2[pool[3].id]], "reject", { note: "Next intake" });
  assert.equal(rj.data.done, 1);
  const s = await nominationSnap(pool[0], pid2, "Bulk Nomination Reject"), b = await nominationSnap(pool[3], pid2, "Bulk Nomination Reject");
  assert.equal(s.member.length, 0);
  assert.equal(s.notifications[0].body, "Reason: Next intake");
  assert.deepEqual(b, s, "reject: bulk equals single");
  assertBadReq(await bulkDecide("nominations", [id2[pool[0].id]], "reject", { note: " " }), "note_required");
});

test("B1 培养项目申请 · 期次容量逐条判定：满员的报 over_capacity（带容量与人数），带 force 再提交即仍然通过", async () => {
  const people = await mkEmps(3, "C", { login: true, programIds: [] });
  const pid = await mkProject("Bulk Capacity", [{ id: "cap-co", name: "Small Cohort", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 1, open: true, classes: [], phases: [] }], "planning");
  for (const p of people.slice(0, 2)) assert.equal((await p.c.post(`/api/me/tprojects/${pid}/apply`, {})).status, 200);
  const id = await nominationIds(pid);
  const ids = people.slice(0, 2).map((p) => id[p.id]);
  const r = await bulkDecide("nominations", ids, "approve");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 2, done: 1, skipped: 1, unchanged: 0 });
  assert.deepEqual(r.data.results[0], { id: ids[0], ok: true });
  const over = r.data.results[1];
  assert.equal(over.code, "over_capacity");
  assert.deepEqual([over.capacity, over.current, over.cohort], [1, 1, "Small Cohort"]);
  assert.equal(over.error_zh, "期次「Small Cohort」已满（1/1）。");
  assert.equal(one("SELECT status FROM approvals WHERE id = ?", ids[1]).status, "pending", "the full one stays pending");
  const forced = await bulkDecide("nominations", [over.id], "approve", { force: true });
  assert.equal(forced.status, 200);
  assert.deepEqual(forced.data.results, [{ id: ids[1], ok: true }]);
  assert.equal((await admin.get("/api/admin/tprojects/" + pid)).data.members.filter((m) => m.state === "active").length, 2);
  // 主体 JSON 损坏的旧申请：逐条 not_found，不让整批失败
  dbWrite("INSERT INTO approvals (id, kind, subjectJson, requesterId, targetUserId, note, status, requestedAt) VALUES (?, 'nomination', ?, ?, ?, NULL, 'pending', ?)",
    "nm-broken01", "{not json", people[2].id, people[2].id, new Date().toISOString());
  try {
    const bad = await bulkDecide("nominations", ["nm-broken01"], "reject", { note: "x" });
    assert.equal(bad.status, 200, JSON.stringify(bad.data));
    assert.equal(bad.data.results[0].code, "not_found");
  } finally {
    dbWrite("DELETE FROM approvals WHERE id = ?", "nm-broken01");   // GET /nominations 不容忍坏行，别留给后面的用例
  }
});

// =====================================================================
// B2 期次与成员
// =====================================================================
let mv;   // { pid, otherCohort, learners, heads, viewer }
async function memberSnap(p, pid) {
  return canon({
    member: all("SELECT projectId, cohortId, role, classId, groupId, state FROM project_members WHERE projectId = ? AND userId = ?", pid, p.id),
    assignments: all("SELECT programId, dueAt FROM assignments WHERE userId = ? ORDER BY programId", p.id),
    audit: all("SELECT actorId, actorName, action, target, beforeJson, afterJson FROM audit_logs WHERE action LIKE 'tproject.members.%' AND afterJson LIKE ? ORDER BY id", `%"employeeId":"${p.employeeId}"%`),
  }, [p]);
}

test("B2 批量调整与退训 = 单条 3 次：成员行、派课、审计一致（退训保留记录）", async () => {
  const heads = await mkEmps(2, "H", { login: true, programIds: [] });
  const viewer = await mkEmp("V", { login: true, programIds: [] });
  const learners = await mkEmps(13, "M", { programIds: [] });
  const pid = await mkProject("Bulk Move", [
    { id: "mv-a", name: "Cohort A", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50,
      classes: [{ id: "mv-a1", name: "Class A1", headId: heads[0].id }, { id: "mv-a2", name: "Class A2", headId: heads[1].id }],
      phases: [{ id: "mv-ph-a", name: "P1", gateMode: "time", activities: [{ id: "mv-off", type: "offline", title: "Kickoff", startAt: TODAY_LATE }] }] },
    { id: "mv-b", name: "Cohort B", startAt: "2026-01-01", endAt: "2026-11-30", capacity: 50, classes: [{ id: "mv-b1", name: "Class B1", headId: null }],
      phases: [{ id: "mv-ph-b", name: "P1", gateMode: "time", activities: [{ id: "mv-course", type: "course", refId: "data-privacy" }] }] },
  ]);
  await addMembers(pid, "mv-a", [...learners, viewer], "mv-a1");
  mv = { pid, heads, viewer, learners };
  // 调班：3 条单条 vs 3 条批量（同一期次内 A1 → A2）
  for (const p of learners.slice(0, 3)) assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members/update`, { userId: p.id, action: "move", cohortId: "mv-a", classId: "mv-a2" })).status, 200);
  const r = await bulkMembers(pid, learners.slice(3, 6).map((p) => p.id), "move", { cohortId: "mv-a", classId: "mv-a2" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  for (let i = 0; i < 3; i++) {
    const s = await memberSnap(learners[i], pid), b = await memberSnap(learners[3 + i], pid);
    assert.equal(s.member[0].classId, "mv-a2");
    assert.equal(s.audit.length, 1);
    assert.deepEqual(JSON.parse(s.audit[0].afterJson), { employeeId: "<EID>", cohortId: "mv-a", classId: "mv-a2" });
    assert.deepEqual(b, s, "move person " + i);
  }
  // 退训：3 条单条 vs 3 条批量；行保留、state = withdrawn
  for (const p of learners.slice(6, 9)) assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members/update`, { userId: p.id, action: "withdraw" })).status, 200);
  const w = await bulkMembers(pid, learners.slice(9, 12).map((p) => p.id), "withdraw");
  assert.equal(w.data.done, 3);
  for (let i = 0; i < 3; i++) {
    const s = await memberSnap(learners[6 + i], pid), b = await memberSnap(learners[9 + i], pid);
    assert.equal(s.member[0].state, "withdrawn", "the row is kept");
    assert.deepEqual(b, s, "withdraw person " + i);
  }
  // 对已退训的人再退训 = 已是目标设置（成功、未改动、不写审计）；调整已退训的人 = 跳过
  const a0 = auditCount();
  const again = await bulkMembers(pid, [learners[9].id], "withdraw");
  assert.deepEqual(summary(again.data), { ok: true, total: 1, done: 1, skipped: 0, unchanged: 1 });
  assert.deepEqual(again.data.results, [{ id: learners[9].id, ok: true, unchanged: true }]);
  const mvW = await bulkMembers(pid, [learners[9].id], "move", { cohortId: "mv-a", classId: "mv-a1" });
  assert.equal(mvW.data.results[0].code, "withdrawn");
  assert.equal(auditCount(), a0, "no-ops and skips write no audit");
});

test("B2 把 2 人从 A1 调到 A2：签到名单、看板、班主任视图、学员端项目页都按新班级显示；再调到期次 B：人数移动、派 B 的课", async () => {
  const { pid, heads, viewer, learners } = mv;
  const two = [viewer, learners[12]];
  const r = await bulkMembers(pid, two.map((p) => p.id), "move", { cohortId: "mv-a", classId: "mv-a2" });
  assert.equal(r.data.done, 2);
  const doc = (await admin.get("/api/admin/tprojects/" + pid)).data;
  for (const p of two) assert.equal(doc.members.find((m) => m.userId === p.id).classId, "mv-a2");
  const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/mv-off`)).data;
  for (const p of two) assert.equal(roll.list.find((x) => x.userId === p.id).class, "Class A2", "roll-call shows the new class");
  assert.equal((await viewer.c.get("/api/me/tprojects/" + pid)).data.class, "Class A2", "learner page shows the new class");
  const a2 = (await heads[1].c.get(`/api/me/classes/${pid}/mv-a/mv-a2`)).data.learners.map((x) => x.userId);
  const a1 = (await heads[0].c.get(`/api/me/classes/${pid}/mv-a/mv-a1`)).data.learners.map((x) => x.userId);
  for (const p of two) { assert.ok(a2.includes(p.id), "new class head sees them"); assert.ok(!a1.includes(p.id), "old class head no longer does"); }
  // 调到期次 B（不分班）
  const dashA = (await admin.get(`/api/admin/tprojects/${pid}/dashboard?cohort=mv-a`)).data.members;
  const dashB = (await admin.get(`/api/admin/tprojects/${pid}/dashboard?cohort=mv-b`)).data.members;
  assert.ok(!all("SELECT programId FROM assignments WHERE userId = ?", viewer.id).some((x) => x.programId === "nho"), "nothing assigned before");
  const toB = await bulkMembers(pid, two.map((p) => p.id), "move", { cohortId: "mv-b", classId: null });
  assert.equal(toB.data.done, 2);
  assert.equal((await admin.get(`/api/admin/tprojects/${pid}/dashboard?cohort=mv-a`)).data.members, dashA - 2);
  assert.equal((await admin.get(`/api/admin/tprojects/${pid}/dashboard?cohort=mv-b`)).data.members, dashB + 2);
  for (const p of two) {
    const asg = all("SELECT programId, dueAt FROM assignments WHERE userId = ?", p.id).find((x) => x.programId === "nho");
    assert.ok(asg, "cohort B's course assigned");
    assert.equal(asg.dueAt, "2026-11-30", "due = cohort end");
  }
  assert.equal((await viewer.c.get("/api/me/tprojects/" + pid)).data.class, null);
  // 已是目标设置：成功、未改动；不在项目里的人：not_member；不存在：not_found
  const stranger = await mkEmp("X", { programIds: [] });
  const r2 = await bulkMembers(pid, [viewer.id, stranger.id, "u-nope"], "move", { cohortId: "mv-b" });
  assert.deepEqual(summary(r2.data), { ok: true, total: 3, done: 1, skipped: 2, unchanged: 1 });
  assert.deepEqual(r2.data.results.map((x) => x.code || (x.unchanged ? "unchanged" : "ok")), ["unchanged", "not_member", "not_found"]);
});

test("B2 校验：期次必须属于本项目、班级必须属于该期次、操作必须是调整或退训；都在写库之前", async () => {
  const { pid, learners } = mv;
  const other = await mkProject("Bulk Other", [{ id: "ot-co", name: "Other", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 5, classes: [{ id: "ot-c1", name: "OC1" }], phases: [] }]);
  assert.ok(other);
  const ids = [learners[0].id];
  assertBadReq(await bulkMembers(pid, ids, "move", { cohortId: "ot-co" }), "bad_cohort");
  assertBadReq(await bulkMembers(pid, ids, "move", {}), "bad_cohort");
  assertBadReq(await bulkMembers(pid, ids, "move", { cohortId: "mv-a", classId: "mv-b1" }), "bad_class");
  assertBadReq(await bulkMembers(pid, ids, "promote"), "bad_action");
  assertBadReq(await bulkMembers(pid, [], "withdraw"), "no_items");
  const nf = await bulkMembers("tp-nope", ids, "withdraw");
  assert.equal(nf.status, 404);
  assert.equal(nf.data.code, "not_found");
});

// =====================================================================
// B3 签到 / 完成登记名单
// =====================================================================
let ck;   // { pid, learners, selfA, selfLate, prog, selfCourse, online }
async function rosterSnap(p, act, ckId) {
  return canon({
    state: stateRow(ckId || act, p.id),
    audit: all("SELECT actorId, actorName, action, target, beforeJson, afterJson FROM audit_logs WHERE (action LIKE 'tproject.checkin.%' OR action LIKE 'tproject.activity.%') AND afterJson LIKE ? AND afterJson LIKE ? ORDER BY id", `%"employeeId":"${p.employeeId}"%`, `%"activityId":"${act}"%`),
  }, [p]);
}

test("B3 签到名单 · 批量补签 / 批量撤销 = 单条 3 次（行与审计一致）", async () => {
  const content = await admin.get("/api/admin/content");
  const course = content.data.courses.find((c) => c.id === "compliance");
  assert.equal((await admin.put("/api/admin/content/courses/compliance", { ...course, mode: "offline", location: "Room 2", sessionAt: TODAY_LATE })).status, 200);
  const logins = await mkEmps(5, "K", { login: true });   // 默认课程（含 nho），线下课签到与课程进度要用
  const learners = await mkEmps(14, "L");
  const pid = await mkProject("Bulk Roll", [{
    id: "ck-co", name: "Roll Cohort", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, classes: [],
    phases: [{ id: "ck-ph", name: "P1", gateMode: "time", activities: [
      { id: "ck-fut", type: "offline", title: "Future session", startAt: TODAY_LATE },
      { id: "ck-past", type: "offline", title: "Past session", startAt: TODAY_EARLY },
      { id: "ck-course", type: "course", refId: "compliance" },
      { id: "ck-online", type: "online", title: "Survey", url: "https://example.com/s", completion: "self" },
    ] }],
  }]);
  await addMembers(pid, "ck-co", [...logins, ...learners]);
  ck = { pid, learners, selfA: logins[0], selfLate: logins[1], prog: logins[2], selfCourse: logins[3], online: logins[4] };
  for (const p of learners.slice(0, 3)) assert.equal((await singleMark(pid, "ck-fut", p.id, "attended")).status, 200);
  const r = await bulkMark(pid, "ck-fut", learners.slice(3, 6).map((p) => p.id), "attended");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  for (let i = 0; i < 3; i++) {
    const s = await rosterSnap(learners[i], "ck-fut"), b = await rosterSnap(learners[3 + i], "ck-fut");
    assert.deepEqual(s.state, { projectId: pid, cohortId: "ck-co", activityId: "ck-fut", status: "attended", by: one("SELECT id FROM users WHERE employeeId = 'ADMIN'").id, note: null });
    assert.deepEqual(b, s, "mark person " + i);
  }
  for (const p of learners.slice(0, 3)) assert.equal((await singleMark(pid, "ck-fut", p.id, "clear")).status, 200);
  const c = await bulkMark(pid, "ck-fut", learners.slice(3, 6).map((p) => p.id), "clear");
  assert.equal(c.data.done, 3);
  for (let i = 0; i < 3; i++) {
    const s = await rosterSnap(learners[i], "ck-fut"), b = await rosterSnap(learners[3 + i], "ck-fut");
    assert.equal(s.state, null, "undone");
    assert.equal(s.audit.length, 2, "mark + unmark");
    assert.deepEqual(b, s, "clear person " + i);
  }
});

test("B3 验收：选中含 1 个「学员自己签到」行的 3 人批量撤销 → 2 成功、1 跳过（本人签到不可撤销）；只登记空白行", async () => {
  const { pid, learners, selfA } = ck;
  const [l2, l3, l4, l5, l6] = learners.slice(6, 11);
  assert.equal(await selfCheckin(selfA, pid, "ck-fut"), "attended");
  assert.equal((await singleMark(pid, "ck-fut", l2.id, "attended")).status, 200);
  assert.equal((await singleMark(pid, "ck-fut", l3.id, "excused")).status, 200);
  const a0 = auditCount();
  const r = await bulkMark(pid, "ck-fut", [selfA.id, l2.id, l3.id], "clear");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 2, skipped: 1, unchanged: 0 });
  assert.equal(r.data.results[0].code, "self_checkin");
  assert.equal(r.data.results[0].error_zh, "本人签到不可撤销。");
  const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/ck-fut`)).data;
  assert.equal(roll.list.find((x) => x.userId === selfA.id).self, true, "the self check-in is intact");
  assert.equal(roll.list.find((x) => x.userId === l2.id).status, null);
  assert.equal(roll.list.find((x) => x.userId === l3.id).status, null);
  const un = all("SELECT beforeJson FROM audit_logs WHERE action = 'tproject.checkin.unmark' AND id > ? ORDER BY id", 0).slice(-2).map((x) => JSON.parse(x.beforeJson));
  assert.deepEqual(un.map((x) => x.status).sort(), ["attended", "excused"]);
  assert.equal(auditCount(), a0 + 2, "two unmark audits, none for the skipped row");
  // 补签：本人已签到（同一状态）= 未改动；空白行补签；缺勤 / 已补签的行不覆盖
  assert.equal((await singleMark(pid, "ck-fut", l5.id, "absent")).status, 200);
  const m = await bulkMark(pid, "ck-fut", [selfA.id, l4.id, l5.id], "attended");
  assert.deepEqual(summary(m.data), { ok: true, total: 3, done: 2, skipped: 1, unchanged: 1 });
  assert.deepEqual(m.data.results[0], { id: selfA.id, ok: true, unchanged: true });
  assert.deepEqual(m.data.results[1], { id: l4.id, ok: true });
  assert.equal(m.data.results[2].code, "already_marked");
  assert.equal(m.data.results[2].status, "absent");
  assert.equal(stateRow("ck-fut", selfA.id).by, selfA.id, "self row untouched");
  const ex = await bulkMark(pid, "ck-fut", [l4.id], "excused");
  assert.equal(ex.data.results[0].code, "already_marked");
  assert.equal(stateRow("ck-fut", l4.id).status, "attended", "never overwritten");
  // 没有登记可撤销 = 已是目标状态：同单条（200 {ok:true}）算成功、未改动，不写库不写审计；不在名单里的人；状态校验
  const a1 = auditCount();
  const nc = await bulkMark(pid, "ck-fut", [l6.id], "clear");
  assert.deepEqual(summary(nc.data), { ok: true, total: 1, done: 1, skipped: 0, unchanged: 1 });
  assert.deepEqual(nc.data.results, [{ id: l6.id, ok: true, unchanged: true }]);
  assert.equal(stateRow("ck-fut", l6.id), null);
  assert.equal(auditCount(), a1, "a no-op undo writes no audit");
  assert.deepEqual((await singleMark(pid, "ck-fut", l6.id, "clear")).data, { ok: true }, "single undo on the same row: silent 200");
  assert.equal(auditCount(), a1);
  const stranger = await mkEmp("Y");
  assert.equal((await bulkMark(pid, "ck-fut", [stranger.id], "attended")).data.results[0].code, "not_in_roster");
  for (const st of ["late", "absent", "completed", ""]) assertBadReq(await bulkMark(pid, "ck-fut", [l6.id], st), "bad_status");
  const nf = await bulkMark(pid, "ck-nope", [l6.id], "attended");
  assert.equal(nf.status, 404);
  assert.equal(nf.data.code, "not_found");
});

test("B3 批量补签把「迟到」改为出席；学员本人签到的迟到行仍记为本人签到（by 不变、仍不可撤销）", { skip: NO_LATE_WINDOW }, async () => {
  const { pid, learners, selfLate } = ck;
  const staffLate = learners[11];
  assert.equal(await selfCheckin(selfLate, pid, "ck-past"), "late");
  assert.equal((await singleMark(pid, "ck-past", staffLate.id, "late")).status, 200);
  const r = await bulkMark(pid, "ck-past", [selfLate.id, staffLate.id], "attended");
  assert.deepEqual(summary(r.data), { ok: true, total: 2, done: 2, skipped: 0, unchanged: 0 });
  const adminId = one("SELECT id FROM users WHERE employeeId = 'ADMIN'").id;
  assert.equal(stateRow("ck-past", selfLate.id).status, "attended");
  assert.equal(stateRow("ck-past", selfLate.id).by, selfLate.id, "self check-in keeps its proof");
  assert.equal(stateRow("ck-past", staffLate.id).by, adminId, "staff row: by = operator (same as single 改为出席)");
  const marks = all("SELECT afterJson FROM audit_logs WHERE action = 'tproject.checkin.mark' AND afterJson LIKE ?", '%"activityId":"ck-past"%').map((x) => JSON.parse(x.afterJson));
  assert.ok(marks.some((x) => x.employeeId === selfLate.employeeId && x.status === "attended"));
  const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/ck-past`)).data;
  assert.equal(roll.list.find((x) => x.userId === selfLate.id).self, true);
  assert.equal((await bulkMark(pid, "ck-past", [selfLate.id], "clear")).data.results[0].code, "self_checkin");
});

test("B3 引用线下课程的活动：批量补签 = 课程完成（进度 100），批量撤销 = 回到未完成；课程页本人签到的行跳过", async () => {
  const { pid, prog, selfCourse } = ck;
  const progressOf = async (p) => (await p.c.get("/api/programs/nho")).data.courses.find((c) => c.id === "compliance").progress;
  assert.equal(await progressOf(prog), 0);
  const r = await bulkMark(pid, "ck-course", [prog.id], "attended");
  assert.equal(r.data.done, 1);
  assert.deepEqual(stateRow("course:compliance", prog.id), { projectId: "__course__", cohortId: "compliance", activityId: "course:compliance", status: "attended", by: one("SELECT id FROM users WHERE employeeId = 'ADMIN'").id, note: null });
  assert.equal(await progressOf(prog), 100, "attendance is course completion");
  const audit = all("SELECT target, afterJson FROM audit_logs WHERE action = 'tproject.checkin.mark' AND afterJson LIKE ?", `%"employeeId":"${prog.employeeId}"%`).map((x) => ({ target: x.target, after: JSON.parse(x.afterJson) }));
  assert.deepEqual(audit, [{ target: pid, after: { employeeId: prog.employeeId, activityId: "ck-course", status: "attended" } }], "audit names the activity, not the course row");
  // 学员在课程页自己输码签到
  let ok = false;
  for (let i = 0; i < 2 && !ok; i++) {
    const code = (await admin.get("/api/admin/courses/compliance/checkin")).data.code;
    ok = (await selfCourse.c.post("/api/courses/compliance/checkin", { code })).status === 200;
  }
  assert.ok(ok, "course self check-in");
  const c = await bulkMark(pid, "ck-course", [selfCourse.id, prog.id], "clear");
  assert.deepEqual(summary(c.data), { ok: true, total: 2, done: 1, skipped: 1, unchanged: 0 });
  assert.equal(c.data.results[0].code, "self_checkin");
  assert.equal(await progressOf(prog), 0, "undo un-completes the course");
  assert.equal(await progressOf(selfCourse), 100, "the self check-in still counts");
});

test("B3 完成登记名单（线上活动）：批量撤销可撤学员自己完成的行；批量标记完成（attended 按 completed）；已完成的再标 = 未改动", async () => {
  const { pid, online, learners } = ck;
  const done = await online.c.post(`/api/me/tprojects/${pid}/complete`, { activityId: "ck-online", via: "self" });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const r = await bulkMark(pid, "ck-online", [online.id], "clear");
  assert.deepEqual(summary(r.data), { ok: true, total: 1, done: 1, skipped: 0, unchanged: 0 });
  assert.equal(stateRow("ck-online", online.id), null);
  const un = all("SELECT target, beforeJson, afterJson FROM audit_logs WHERE action = 'tproject.activity.unmark' AND afterJson LIKE ?", `%"employeeId":"${online.employeeId}"%`);
  assert.equal(un.length, 1);
  assert.deepEqual(JSON.parse(un[0].beforeJson), { status: "completed", by: online.id });
  const l = learners[12];
  const m = await bulkMark(pid, "ck-online", [online.id, l.id], "attended");
  assert.equal(m.data.done, 2);
  assert.equal(stateRow("ck-online", l.id).status, "completed");
  const marks = all("SELECT afterJson FROM audit_logs WHERE action = 'tproject.activity.mark' AND afterJson LIKE ?", `%"employeeId":"${l.employeeId}"%`).map((x) => JSON.parse(x.afterJson));
  assert.deepEqual(marks, [{ employeeId: l.employeeId, activityId: "ck-online", status: "completed" }]);
  // 与单条一致：单条标记完成的一行，比对批量标记的一行
  const s = learners[13];
  assert.equal((await singleMark(pid, "ck-online", s.id, "completed")).status, 200);
  assert.deepEqual(await rosterSnap(l, "ck-online"), await rosterSnap(s, "ck-online"), "bulk completion row equals single");
  const again = await bulkMark(pid, "ck-online", [l.id], "completed");
  assert.deepEqual(again.data.results, [{ id: l.id, ok: true, unchanged: true }]);
  assert.equal((await bulkMark(pid, "ck-online", [l.id], "excused")).data.results[0].code, "already_marked");
  assertBadReq(await bulkMark(pid, "ck-online", [l.id], "late"), "bad_status");
});

// =====================================================================
// B4 题库
// =====================================================================
async function mkQuestion(courseId, extra) {
  const r = await admin.post("/api/admin/questions", { courseId, type: "mcq", question: "Bulk equivalence stem", question_zh: "批量等价题干",
    options: [{ text: "Right", text_zh: "对", ok: true }, { text: "Wrong", text_zh: "错", ok: false }], explanation: "Because.", ...(extra || {}) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
const qRow = (id) => one("SELECT courseId, moduleId, type, question, question_zh, options, explanation, explanation_zh, rubric, rubric_zh, maxPoints, origin, points FROM questions WHERE id = ?", id);
const qAudit = (id) => all("SELECT actorId, actorName, action, target, beforeJson, afterJson FROM audit_logs WHERE action = 'question.update' AND target = ? ORDER BY id", id)
  .map((x) => ({ ...x, target: "<Q>" }));

test("B4 批量改分值 = 单题修改 3 次（题目行与审计一致，id 不变）；越界分值 400；null 恢复考试默认分值", async () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await mkQuestion("culture-conduct"));
  const bank = (await admin.get("/api/admin/questions")).data;
  for (const id of ids.slice(0, 3)) {
    const q = bank.find((x) => x.id === id);
    assert.equal((await admin.put("/api/admin/questions/" + id, { ...q, points: 2 })).status, 200);
  }
  const r = await bulkQ({ ids: ids.slice(3), op: "points", points: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  assert.deepEqual(r.data.warnings, []);
  for (let i = 0; i < 3; i++) {
    assert.equal(qRow(ids[i]).points, 2);
    assert.deepEqual(qRow(ids[3 + i]), qRow(ids[i]), "question row " + i);
    assert.deepEqual(qAudit(ids[3 + i]), qAudit(ids[i]), "audit " + i);
    assert.equal(qAudit(ids[i]).length, 1);
  }
  const again = await bulkQ({ ids: ids.slice(3), op: "points", points: 2 });
  assert.deepEqual(summary(again.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 3 });
  assert.equal(qAudit(ids[3]).length, 1, "unchanged writes no audit");
  for (const points of [0, 101, 2.5, "abc", "", true, undefined]) assertBadReq(await bulkQ({ ids: ids.slice(3), op: "points", points }), "bad_points");
  assertBadReq(await bulkQ({ ids: ids.slice(3), op: "rename" }), "bad_op");
  const back = await bulkQ({ ids: [ids[3]], op: "points", points: null });
  assert.equal(back.data.done, 1);
  assert.equal(qRow(ids[3]).points, null, "null = use the exam default");
  assert.equal((await bulkQ({ ids: [ids[4]], op: "points", points: "7" })).data.done, 1, "a numeric string is accepted");
  assert.equal(qRow(ids[4]).points, 7);
});

test("第四批：批量改分值跳过情境案例题组（case_points，题组分值 = 小题合计），同批其余题照常改", async () => {
  const sub = (type, extra) => ({ type, question: "Sub?", ...extra });
  const cs = await admin.post("/api/admin/questions", { courseId: "culture-conduct", type: "case", question: "Bulk case", passage: "Scenario text.",
    items: [sub("mcq", { options: [{ text: "a", ok: true }, { text: "b" }] }), sub("tf", { answer: true })] });
  assert.equal(cs.status, 200, JSON.stringify(cs.data));
  const plain = await mkQuestion("culture-conduct", { question: "Bulk case neighbour" });
  const r = await bulkQ({ ids: [cs.data.id, plain], op: "points", points: 4 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 2, done: 1, skipped: 1, unchanged: 0 });
  const skip = r.data.results.find((x) => x.id === cs.data.id);
  assert.equal(skip.code, "case_points");
  assert.ok(skip.error && /[一-鿿]/.test(skip.error_zh), "reason line in both languages");
  assert.equal(qRow(cs.data.id).points, null, "the case row is not written");
  assert.equal(qRow(plain).points, 4);
  assert.equal(all("SELECT id FROM audit_logs WHERE action = 'question.update' AND target = ?", cs.data.id).length, 0, "no audit for the skipped case");
});

test("B4 验收：批量把 5 题改为 2 分后，固定题目考试的卷面总分随之更新；题目 id 与其余字段不变；简答题的满分不动", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await mkQuestion("culture-conduct", { question: "Fixed paper " + i }));
  const ex = await admin.post("/api/admin/exams", { programId: "nho", title: "Bulk Fixed Points", status: "published", courseIds: ["culture-conduct"], passingScore: 60,
    mcqCount: 1, openCount: 0, mode: "fixed", questionIds: ids, typePoints: { mcq: 1, multi: 1, fill: 1, open: 10 } });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  const emp = await loginAs(srv.base, EMPLOYEE);
  const range = async () => (await emp.get("/api/programs/nho")).data.exams.find((e) => e.id === ex.data.id).pointsRange;
  assert.deepEqual(await range(), { min: 5, max: 5 });
  const before = (await admin.get("/api/admin/questions")).data;
  const r = await bulkQ({ ids, op: "points", points: 2 });
  assert.equal(r.data.done, 5);
  assert.deepEqual(await range(), { min: 10, max: 10 }, "the fixed paper's total follows");
  const afterBank = (await admin.get("/api/admin/questions")).data;
  assert.equal(afterBank.length, before.length, "no question added or removed");
  for (const id of ids) {
    const b = before.find((q) => q.id === id), a = afterBank.find((q) => q.id === id);
    assert.ok(a, "id unchanged");
    assert.deepEqual({ ...a, points: null }, { ...b, points: null }, "every other field unchanged");
    assert.equal(a.points, 2);
    assert.deepEqual(qAudit(id).map((x) => JSON.parse(x.afterJson)), [{ courseId: "culture-conduct", type: "mcq" }]);
  }
  assert.deepEqual((await admin.get("/api/admin/exams/" + ex.data.id)).data.questionIds, ids, "the exam still references the same ids");
  // 简答题：只改 points，满分（maxPoints）与评分标准原样
  const open = await admin.post("/api/admin/questions", { courseId: "culture-conduct", type: "open", question: "Explain", rubric: "Two points", maxPoints: 20 });
  const ro = await bulkQ({ ids: [open.data.id], op: "points", points: 7 });
  assert.equal(ro.data.done, 1);
  assert.deepEqual([qRow(open.data.id).points, qRow(open.data.id).maxPoints, qRow(open.data.id).rubric], [7, 20, "Two points"]);
});

test("B4 批量改课程与模块：换课程不选模块 → 模块清空；选模块 → 统一设为该模块；同课程不选模块 → 未改动；校验课程与模块", async () => {
  const cat = (await admin.get("/api/admin/catalog")).data;
  const cc = cat.courses.find((c) => c.id === "culture-conduct"), dp = cat.courses.find((c) => c.id === "data-privacy");
  assert.ok(cc.modules.length >= 2 && dp.modules.length >= 1, "catalog lists each course's modules");
  assert.deepEqual(Object.keys(cc.modules[0]).sort(), ["id", "title", "title_zh"]);
  const qa = await mkQuestion("culture-conduct", { moduleId: cc.modules[0].id });
  const qb = await mkQuestion("culture-conduct", { moduleId: cc.modules[0].id });
  const qc = await mkQuestion("culture-conduct", { moduleId: cc.modules[0].id });
  const r1 = await bulkQ({ ids: [qa], op: "course", courseId: "data-privacy" });
  assert.deepEqual(r1.data.results, [{ id: qa, ok: true }]);
  assert.deepEqual([qRow(qa).courseId, qRow(qa).moduleId], ["data-privacy", null]);
  const r2 = await bulkQ({ ids: [qb], op: "course", courseId: "data-privacy", moduleId: dp.modules[0].id });
  assert.equal(r2.data.done, 1);
  assert.deepEqual([qRow(qb).courseId, qRow(qb).moduleId], ["data-privacy", dp.modules[0].id]);
  const r3 = await bulkQ({ ids: [qc], op: "course", courseId: "culture-conduct" });
  assert.deepEqual(r3.data.results, [{ id: qc, ok: true, unchanged: true }], "same course, no module = keep each question's own");
  assert.equal(qRow(qc).moduleId, cc.modules[0].id);
  const r4 = await bulkQ({ ids: [qc], op: "course", courseId: "culture-conduct", moduleId: cc.modules[1].id });
  assert.equal(r4.data.done, 1);
  assert.equal(qRow(qc).moduleId, cc.modules[1].id);
  assert.deepEqual(qAudit(qa).map((x) => JSON.parse(x.afterJson)), [{ courseId: "data-privacy", type: "mcq" }]);
  assertBadReq(await bulkQ({ ids: [qa], op: "course", courseId: "data-privacy", moduleId: cc.modules[0].id }), "bad_module");
  assertBadReq(await bulkQ({ ids: [qa], op: "course", courseId: "nope" }), "bad_course");
  assertBadReq(await bulkQ({ ids: [qa], op: "course" }), "bad_course");
  assert.equal((await bulkQ({ ids: ["q-nope"], op: "course", courseId: "data-privacy" })).data.results[0].code, "not_found");
  for (const id of [qa, qb, qc]) assert.ok(qRow(id), "ids unchanged");
});

test("B4 批量改课程 = 单题修改 3 次（换课程、不带模块 → 模块清空；题目行与审计一致）", async () => {
  const cc = (await admin.get("/api/admin/catalog")).data.courses.find((c) => c.id === "culture-conduct");
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await mkQuestion("culture-conduct", { moduleId: cc.modules[0].id }));
  const bank = (await admin.get("/api/admin/questions")).data;
  for (const id of ids.slice(0, 3)) {
    const { moduleId, ...q } = bank.find((x) => x.id === id);
    assert.equal(moduleId, cc.modules[0].id);
    assert.equal((await admin.put("/api/admin/questions/" + id, { ...q, courseId: "data-privacy" })).status, 200);
  }
  const r = await bulkQ({ ids: ids.slice(3), op: "course", courseId: "data-privacy" });
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  assert.deepEqual(r.data.warnings, []);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual([qRow(ids[i]).courseId, qRow(ids[i]).moduleId], ["data-privacy", null]);
    assert.deepEqual(qRow(ids[3 + i]), qRow(ids[i]), "question row " + i);
    assert.deepEqual(qAudit(ids[3 + i]), qAudit(ids[i]), "audit " + i);
  }
});

test("B4 固定题目考试保护（H2）：新课程不在考试关联课程里的题逐条跳过并列出考试；关联课程内的移动之后，重存考试不丢题；随机抽题考试题量不足时给出提醒", async () => {
  const h = [];
  for (let i = 0; i < 3; i++) h.push(await mkQuestion("culture-conduct", { question: "Fixed guard " + i }));
  const fx = await admin.post("/api/admin/exams", { programId: "nho", title: "Bulk Guard Exam", title_zh: "批量保护考试", status: "published",
    courseIds: ["culture-conduct", "data-privacy"], passingScore: 60, mcqCount: 1, openCount: 0, mode: "fixed", questionIds: h });
  assert.equal(fx.status, 200, JSON.stringify(fx.data));
  const r = await bulkQ({ ids: [h[0], h[1]], op: "course", courseId: "compliance" });
  assert.deepEqual(summary(r.data), { ok: true, total: 2, done: 0, skipped: 2, unchanged: 0 });
  assert.equal(r.data.results[0].code, "in_fixed_exam");
  assert.deepEqual(r.data.results[0].exams, [{ id: fx.data.id, title: "Bulk Guard Exam", title_zh: "批量保护考试" }]);
  assert.equal(r.data.results[0].error_zh, "被固定题目考试《批量保护考试》使用，新课程不在该考试的关联课程中。");
  assert.equal(qRow(h[0]).courseId, "culture-conduct", "not moved");
  const ok = await bulkQ({ ids: [h[1]], op: "course", courseId: "data-privacy" });
  assert.deepEqual(ok.data.results, [{ id: h[1], ok: true }], "the exam links the new course → allowed");
  // 重存考试（只改标题）：题目一道不少
  const exam = (await admin.get("/api/admin/exams/" + fx.data.id)).data;
  const put = await admin.put("/api/admin/exams/" + fx.data.id, { ...exam, title: "Bulk Guard Exam (edited)" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual((await admin.get("/api/admin/exams/" + fx.data.id)).data.questionIds, h, "re-saving keeps every question");
  // 随机抽题考试：池子刚好够，移走一道 → warnings（不拦）
  const w1 = await mkQuestion("compliance", { question: "Pool question" });
  const pool = (await admin.get("/api/admin/questions")).data.filter((q) => q.courseId === "compliance" && ["mcq", "multi", "fill"].includes(q.type)).length;
  const rnd = await admin.post("/api/admin/exams", { programId: "nho", title: "Bulk Random Exam", title_zh: "批量随机考试", status: "published",
    courseIds: ["compliance"], passingScore: 60, mcqCount: pool, openCount: 0 });
  assert.equal(rnd.status, 200, JSON.stringify(rnd.data));
  const mvR = await bulkQ({ ids: [w1], op: "course", courseId: "culture-conduct" });
  assert.equal(mvR.data.done, 1, "not blocked");
  assert.deepEqual(mvR.data.warnings, [{ examId: rnd.data.id, title: "Bulk Random Exam", title_zh: "批量随机考试", kind: "objective", pool: pool - 1, need: pool }]);
});

// =====================================================================
// 单条接口改为共用函数后的回归（应答逐字不变）
// =====================================================================
test("单条回归：选修驳回不填理由仍 200；提名满员 409 应答不变；本人签到撤销 409 应答不变；调整到未知期次仍保留原期次", async () => {
  const people = await mkEmps(3, "R", { login: true, programIds: [] });
  const prog = await mkElective("Bulk Regression Elective");
  assert.equal((await people[0].c.post("/api/me/enroll-requests", { programId: prog })).status, 200);
  const eid = (await enrollIds(prog))[people[0].id];
  const rj = await admin.post(`/api/admin/enroll-requests/${eid}/decide`, { decision: "reject" });
  assert.deepEqual([rj.status, rj.data], [200, { ok: true, status: "rejected" }]);
  assert.equal(one("SELECT decideNote FROM approvals WHERE id = ?", eid).decideNote, null);
  const pid = await mkProject("Bulk Regression Cap", [{ id: "rg-co", name: "Full", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 1, open: true, classes: [], phases: [] }], "planning");
  for (const p of people.slice(1)) assert.equal((await p.c.post(`/api/me/tprojects/${pid}/apply`, {})).status, 200);
  const nid = await nominationIds(pid);
  assert.equal((await admin.post(`/api/admin/nominations/${nid[people[1].id]}/decide`, { decision: "approve" })).status, 200);
  const full = await admin.post(`/api/admin/nominations/${nid[people[2].id]}/decide`, { decision: "approve" });
  assert.equal(full.status, 409);
  assert.deepEqual(full.data, { error: 'Cohort "Full" is full (1/1). Increase the capacity or move this person to another cohort.', code: "over_capacity", capacity: 1, current: 1 });
  const { pid: ckPid, selfA } = ck;
  const self = await singleMark(ckPid, "ck-fut", selfA.id, "clear");
  assert.equal(self.status, 409);
  assert.deepEqual(self.data, { error: "This learner checked in with the code themselves; a self check-in can't be undone.", error_zh: "该学员是自己输码签到的，不能撤销。", code: "self_checkin" });
  const { pid: mvPid, learners } = mv;
  const keep = learners[0];
  const mvr = await admin.post(`/api/admin/tprojects/${mvPid}/members/update`, { userId: keep.id, action: "move", cohortId: "no-such-cohort", classId: null });
  assert.deepEqual([mvr.status, mvr.data], [200, { ok: true }]);
  assert.equal(one("SELECT cohortId FROM project_members WHERE projectId = ? AND userId = ?", mvPid, keep.id).cohortId, "mv-a", "unknown cohort ignored (COALESCE)");
  const last = all("SELECT afterJson FROM audit_logs WHERE action = 'tproject.members.move' AND afterJson LIKE ? ORDER BY id", `%"employeeId":"${keep.employeeId}"%`).pop();
  assert.deepEqual(JSON.parse(last.afterJson), { employeeId: keep.employeeId, cohortId: "no-such-cohort", classId: null }, "audit keeps the raw request values");
  const bad = await admin.post(`/api/admin/tprojects/${mvPid}/members/update`, { userId: keep.id, action: "promote" });
  assert.deepEqual([bad.status, bad.data], [400, { error: "Unknown action" }]);
});

test("一次 1000 项：批量改分值与改课程都在一个请求里完成，逐条审计 1000 行，耗时可接受", async () => {
  const ids = [];
  for (let b = 0; b < 5; b++) {
    const imp = await admin.post("/api/admin/questions/bulk", { courseId: "culture-conduct", items: Array.from({ length: 200 }, (_, i) => ({
      type: "mcq", question: `Perf ${b}-${i}`, options: [{ text: "a", ok: true }, { text: "b", ok: false }] })) });
    assert.equal(imp.status, 200);
    ids.push(...imp.data.results.map((x) => x.id));
  }
  assert.equal(ids.length, 1000);
  const a0 = auditCount();
  let t0 = Date.now();
  const r = await bulkQ({ ids, op: "points", points: 4 });
  const msPoints = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.equal(r.data.done, 1000);
  assert.equal(auditCount(), a0 + 1000, "one audit row per item");
  t0 = Date.now();
  const c = await bulkQ({ ids, op: "course", courseId: "data-privacy" });
  const msCourse = Date.now() - t0;
  assert.equal(c.data.done, 1000);
  assert.equal(one("SELECT COUNT(*) AS n FROM questions WHERE courseId = 'data-privacy' AND points = 4 AND question LIKE 'Perf %'").n, 1000);
  assert.ok(msPoints < 15000 && msCourse < 15000, `1000 items took ${msPoints}ms / ${msCourse}ms`);
});

// =====================================================================
// 第二批（2026-10-07）B5 课程库：批量发布 / 下线 / 改分类
// =====================================================================
const contentDoc = (kind, id) => { const r = one("SELECT json FROM content WHERE kind = ? AND id = ?", kind, id); return r ? JSON.parse(r.json) : null; };
async function mkCourseDoc(tag, extra = {}) {
  const cid = `bk5-${tag}-${String(++seq).padStart(3, "0")}`;
  const r = await admin.put("/api/admin/content/courses/" + cid, {
    id: cid, title: "Bulk course " + cid, title_zh: "批量课程 " + cid, status: "draft", mode: "online", category: "Old cat",
    modules: [{ id: cid + "-m1", title: "M1", minutes: 5, sections: [] }], ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return cid;
}
const bulkContent = (body) => admin.post("/api/admin/content/bulk-update", body);
function courseSnap(cid) {
  const c = contentDoc("course", cid), w = contentDoc("program", "pw-" + cid);
  return canon({
    course: { status: c.status, category: c.category, title: c.title },
    wrapper: w && { status: w.status, category: w.category, title: w.title, courseIds: w.courseIds, enrollType: w.enrollType, defaultDueDays: w.defaultDueDays },
    versions: one("SELECT COUNT(*) AS n FROM content_versions WHERE kind = 'course' AND contentId = ?", cid).n,
    audit: all("SELECT actorId, action, afterJson FROM audit_logs WHERE action IN ('course.create', 'course.update') AND target = ? ORDER BY id", cid),
  }, [{ id: cid, employeeId: cid, email: "<no-mail>" }]);
}

test("B5 课程库 · 批量发布 3 门 = 单条发布 3 次：课程与包装程序的状态、版本快照、审计 course.update 一致，不发通知；已发布 = 未改动", async () => {
  const single = [await mkCourseDoc("s"), await mkCourseDoc("s"), await mkCourseDoc("s")];
  const bulk = [await mkCourseDoc("b"), await mkCourseDoc("b"), await mkCourseDoc("b")];
  const content = (await admin.get("/api/admin/content")).data;
  for (const cid of single) {
    const c = content.courses.find((x) => x.id === cid);
    assert.equal((await admin.put("/api/admin/content/courses/" + cid, { ...c, status: "published" })).status, 200);
  }
  const n0 = notifCount();
  const r = await bulkContent({ op: "publish", ids: bulk });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  assert.equal(notifCount(), n0, "no notification, same as the single PUT");
  for (let i = 0; i < 3; i++) assert.deepEqual(courseSnap(bulk[i]), courseSnap(single[i]), "course #" + i);
  assert.equal(courseSnap(bulk[0]).wrapper.status, "published");
  const lib = (await admin.get("/api/admin/content")).data;
  assert.equal(lib.programs.find((p) => p.id === "pw-" + bulk[0]).status, "published", "the server cache was refreshed");
  const again = await bulkContent({ op: "publish", ids: [bulk[0], single[0], "bk5-ghost"] });
  assert.deepEqual(again.data.results.map((x) => x.code || (x.unchanged ? "unchanged" : "ok")), ["unchanged", "unchanged", "not_found"]);
  assert.equal(courseSnap(bulk[0]).versions, 2, "unchanged writes no version");
});

test("B5 批量发布：线上课程 0 个模块又没有考试的不发布（empty_course）；线下课程与有模块的照常发布", async () => {
  const empty = await mkCourseDoc("e", { modules: [] });
  const offline = await mkCourseDoc("o", { modules: [], mode: "offline", location: "Room 9" });
  const normal = await mkCourseDoc("n");
  const r = await bulkContent({ op: "publish", ids: [empty, offline, normal] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.results.map((x) => x.code || "ok"), ["empty_course", "ok", "ok"]);
  const skip = r.data.results[0];
  assert.ok(skip.error && /[一-鿿]/.test(skip.error_zh), "bilingual reason");
  assert.equal(contentDoc("course", empty).status, "draft");
  assert.equal(contentDoc("course", offline).status, "published");
});

test("B5 批量下线：课程与包装程序都为已下线；之后逾期一键提醒不再提醒这门课", async () => {
  const cid = await mkCourseDoc("a", { status: "published" });
  const p = await mkEmp("A5", { programIds: [] });
  assert.equal((await admin.post("/api/admin/assignments", { userId: p.id, items: [{ programId: "pw-" + cid, assigned: true, dueAt: "2026-01-05" }] })).status, 200);
  assert.equal((await admin.post("/api/admin/training/remind-overdue", { programId: "pw-" + cid })).data.reminded, 1);
  const r = await bulkContent({ op: "archive", ids: [cid] });
  assert.deepEqual(summary(r.data), { ok: true, total: 1, done: 1, skipped: 0, unchanged: 0 });
  assert.deepEqual([contentDoc("course", cid).status, contentDoc("program", "pw-" + cid).status], ["archived", "archived"]);
  assert.equal((await admin.post("/api/admin/training/remind-overdue", { programId: "pw-" + cid })).data.reminded, 0, "a retired course is not chased");
});

test("B5 批量改分类：包装程序同步；空值清空；超过 60 个字、非文字 400 bad_category；未知操作 400 bad_op", async () => {
  const ids = [await mkCourseDoc("c"), await mkCourseDoc("c")];
  const r = await bulkContent({ op: "category", ids, category: "  Leadership  " });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const cid of ids) assert.deepEqual([contentDoc("course", cid).category, contentDoc("program", "pw-" + cid).category], ["领导力", "领导力"], "第三批 1.1：英文类别名按目录规范化为中文键");
  const same = await bulkContent({ op: "category", ids, category: "Leadership" });
  assert.equal(same.data.unchanged, 2);
  const clear = await bulkContent({ op: "category", ids: [ids[0]], category: "" });
  assert.equal(clear.data.done, 1);
  assert.deepEqual([contentDoc("course", ids[0]).category, contentDoc("program", "pw-" + ids[0]).category], [null, null]);
  assertBadReq(await bulkContent({ op: "category", ids, category: "x".repeat(61) }), "bad_category");
  assertBadReq(await bulkContent({ op: "category", ids, category: 5 }), "bad_category");
  assertBadReq(await bulkContent({ op: "delete", ids }), "bad_op");
  assertBadReq(await bulkContent({ op: "publish", ids: [] }), "no_items");
  assert.equal(contentDoc("course", ids[1]).category, "领导力", "rejected requests change nothing");
});

test("B5 发布被培养项目引用的课：在训学员补指派（与单条发布一样），syncedMembers > 0", async () => {
  const cid = await mkCourseDoc("p");
  const learners = await mkEmps(2, "L5", { programIds: [] });
  const pid = await mkProject("Bulk Publish Sync", [{ id: "b5-co", name: "B5", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 10, classes: [],
    phases: [{ id: "b5-ph", name: "P", activities: [{ id: "b5-act", type: "course", refId: cid }] }] }]);
  await addMembers(pid, "b5-co", learners);
  const before = all("SELECT userId FROM assignments WHERE programId = ?", "pw-" + cid);
  assert.equal(before.length, 0, "a draft course is not assigned");
  const r = await bulkContent({ op: "publish", ids: [cid] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.syncedMembers >= 2, JSON.stringify(r.data));
  const after = all("SELECT userId, dueAt FROM assignments WHERE programId = ? ORDER BY userId", "pw-" + cid);
  assert.deepEqual(after.map((x) => x.userId).sort(), learners.map((p) => p.id).sort());
  assert.ok(after.every((x) => String(x.dueAt).startsWith("2026-12-31")), "due = the cohort end, as for the single publish");
});

// =====================================================================
// 第二批（2026-10-07）B7 考试成绩：批量重置作答次数
// =====================================================================
async function mkExamCourse(tag) {
  const cid = `bk7-${tag}-${String(++seq).padStart(3, "0")}`;
  const put = await admin.put("/api/admin/content/courses/" + cid, { id: cid, title: "Reset " + cid, title_zh: "重置 " + cid, status: "published", mode: "online", modules: [{ id: cid + "-m1", title: "M1", minutes: 5, sections: [] }] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const q = await admin.post("/api/admin/questions", { courseId: cid, type: "mcq", question: "Reset " + cid + "?", options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const ex = await admin.post("/api/admin/exams", { programId: "pw-" + cid, title: "Reset exam " + cid, courseIds: [cid], passingScore: 50, mcqCount: 1, openCount: 0, status: "published" });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  return { cid, pid: "pw-" + cid, examId: ex.data.id, title: "Reset exam " + cid };
}
async function sitExam(p, course, right) {
  if (!p.started) p.started = new Set();
  if (!p.started.has(course.cid)) {
    assert.equal((await p.c.post(`/api/courses/${course.cid}/modules/${course.cid}-m1/complete`)).status, 200);
    p.started.add(course.cid);
  }
  const st = await p.c.post("/api/exam/start", { examId: course.examId });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const answers = {};
  for (const q of st.data.questions) answers[q.id] = q.options.findIndex((o) => o.text === (right ? "right" : "wrong"));
  assert.equal((await p.c.post(`/api/exam/${st.data.attemptId}/submit`, { answers })).status, 200);
  return st.data.attemptId;
}
async function resetSnap(p, course) {
  return canon({
    attempts: all("SELECT voided, passed FROM attempts WHERE userId = ? AND examId = ? ORDER BY submittedAt", p.id, course.examId),
    notifications: all("SELECT type, title, title_zh, body, body_zh, link FROM notifications WHERE userId = ? AND type = 'exam.reset'", p.id),
    audit: all("SELECT actorId, actorName, action, target, beforeJson, afterJson FROM audit_logs WHERE action = 'exam.reset-attempts' AND afterJson LIKE ? ORDER BY id", `%"${p.employeeId}"%`),
    mail: (await waitMails(p.email, (m) => m.subject.includes(course.title), 1)).map((m) => ({ subject: m.subject, html: m.html })),
  }, [p]);
}

test("B7 考试成绩 · 批量重置 3 条 = 单条重置 3 次：作废次数、审计、通知、邮件一致", async () => {
  const course = await mkExamCourse("r");
  const people = await mkEmps(6, "R7", { login: true, programIds: [course.pid] });
  const attempts = [];
  for (const p of people) attempts.push(await sitExam(p, course, false));
  for (const p of people.slice(0, 3)) {
    const r = await admin.post(`/api/admin/exams/${course.examId}/reset-attempts`, { userId: p.id });
    assert.deepEqual([r.status, r.data], [200, { ok: true, voided: 1 }]);
  }
  const r = await admin.post("/api/admin/attempts/bulk-reset", { ids: attempts.slice(3) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(summary(r.data), { ok: true, total: 3, done: 3, skipped: 0, unchanged: 0 });
  assert.equal(r.data.voided, 3);
  for (let i = 0; i < 3; i++) assert.deepEqual(await resetSnap(people[3 + i], course), await resetSnap(people[i], course), "person #" + i);
  assert.equal((await resetSnap(people[3], course)).attempts[0].voided, 1);
});

test("B7 同一员工 × 考试的两条答卷只处理一次（第二条未改动）；已通过 already_passed；结论待定 result_pending；不是考试答卷 no_exam；未知答卷 not_found", async () => {
  const course = await mkExamCourse("d");
  const [twice, passer, pending, legacy] = await mkEmps(4, "D7", { login: true, programIds: [course.pid] });
  const t1 = await sitExam(twice, course, false), t2 = await sitExam(twice, course, false);
  await sitExam(passer, course, false);
  const pass = await sitExam(passer, course, true);
  const pend = await sitExam(pending, course, false);
  dbWrite("UPDATE attempts SET gradingStatus = 'pending_review' WHERE id = ?", pend);
  const leg = await sitExam(legacy, course, false);
  dbWrite("UPDATE attempts SET examId = NULL WHERE id = ?", leg);
  const a0 = auditCount();
  const r = await admin.post("/api/admin/attempts/bulk-reset", { ids: [t1, t2, pass, pend, leg, "at-ghost"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.results.map((x) => x.code || (x.unchanged ? "unchanged" : "ok")), ["ok", "unchanged", "already_passed", "result_pending", "no_exam", "not_found"]);
  assert.equal(r.data.results[0].voided, 2, "both attempts of the pair voided by the first row");
  assert.equal(r.data.voided, 2);
  assert.equal(auditCount(), a0 + 1, "one audit row, for the one pair actually reset");
  assert.equal(one("SELECT COUNT(*) AS n FROM attempts WHERE userId = ? AND voided = 1", passer.id).n, 0, "the pass is kept");
  // 已经全部作废的一对：作废 0 次 = 未改动，不写审计
  const again = await admin.post("/api/admin/attempts/bulk-reset", { ids: [t1] });
  assert.deepEqual([again.data.unchanged, again.data.voided], [1, 0]);
  assert.equal(auditCount(), a0 + 1);
});

test("第二批：服务端 BULK_REASONS 的每个码在前端 BulkActions.jsx 的 T.zh.why 与 T.en.why 里都有文案", () => {
  const ROOTDIR = path.join(__dirname, "..");
  const srvText = fs.readFileSync(path.join(ROOTDIR, "server.js"), "utf8").replace(/\r\n/g, "\n");
  const start = srvText.indexOf("const BULK_REASONS = {");
  const block = srvText.slice(start, srvText.indexOf("\n};", start));
  const keys = [...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.includes("empty_course") && keys.includes("manager_pending") && keys.includes("already_passed"), keys.join(","));
  const web = fs.readFileSync(path.join(ROOTDIR, "web", "src", "components", "BulkActions.jsx"), "utf8").replace(/\r\n/g, "\n");
  const whyBlocks = [];
  let at = 0;
  for (;;) { const i = web.indexOf("    why: {", at); if (i < 0) break; whyBlocks.push(web.slice(i, web.indexOf("\n    },", i))); at = i + 1; }
  assert.equal(whyBlocks.length, 2, "T.zh.why and T.en.why");
  for (const [n, b] of whyBlocks.entries()) {
    const have = new Set([...b.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]));
    const missing = keys.filter((k) => !have.has(k));
    assert.deepEqual(missing, [], (n ? "en" : "zh") + " why is missing server codes");
  }
});

// =====================================================================
// 原子性与上限：另起一台测试服（第 2 项抛异常；LMS_BULK_CAP=3；题库导入上限另设 2，证明 B4 用的是 LMS_BULK_CAP）
// 测试缝对整台服务生效，所以这台服的数据只经单条接口造。
// =====================================================================
test("原子性与上限：七个端点（B1–B5、B7）在第 2 项抛异常 → 整批回滚 batch_failed（不回传异常原文），无审计、无通知；超上限整批拒绝；B4 用 LMS_BULK_CAP", async () => {
  const fsrv = await startServer({ env: { LMS_TEST_FAIL_BULK_AT: "2", LMS_BULK_CAP: "3", LMS_QUESTIONS_BULK_CAP: "2" } });
  try {
    const fa = await loginAs(fsrv.base, ADMIN);
    const fone = (sql, ...a) => dbRead((d) => d.prepare(sql).get(...a), fsrv.dbPath);
    const people = [];
    for (let i = 0; i < 3; i++) {
      const employeeId = "FLT-00" + i;
      const made = await fa.post("/api/admin/employees", { name: "Fault " + i, employeeId, programIds: [] });
      assert.equal(made.status, 200, JSON.stringify(made.data));
      const c = await loginAs(fsrv.base, { employeeId, password: made.data.password });
      assert.equal((await c.post("/api/auth/change-password", { currentPassword: made.data.password, newPassword: employeeId + "-pw-2026" })).status, 200);
      people.push({ id: fone("SELECT id FROM users WHERE employeeId = ?", employeeId).id, c });
    }
    const prog = (await fa.post("/api/admin/programs", { title: "Fault Elective", status: "published", enrollType: "elective" })).data.id;
    for (const p of people) assert.equal((await p.c.post("/api/me/enroll-requests", { programId: prog })).status, 200);
    const erIds = (await fa.get("/api/admin/enroll-requests")).data.map((x) => x.id);
    const tp = (await fa.post("/api/admin/tprojects", { title: "Fault Project" })).data.id;
    assert.equal((await fa.put("/api/admin/tprojects/" + tp, { status: "running", cohorts: [
      { id: "f-co", name: "F", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, open: true, classes: [{ id: "f-c2", name: "F2" }],
        phases: [{ id: "f-ph", name: "P", gateMode: "time", activities: [{ id: "f-off", type: "offline", title: "S", startAt: TODAY_LATE }] }] }] })).status, 200);
    const tpN = (await fa.post("/api/admin/tprojects", { title: "Fault Apply" })).data.id;
    assert.equal((await fa.put("/api/admin/tprojects/" + tpN, { status: "planning", cohorts: [{ id: "fn-co", name: "FN", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, open: true, classes: [], phases: [] }] })).status, 200);
    for (const p of people) assert.equal((await p.c.post(`/api/me/tprojects/${tpN}/apply`, {})).status, 200);
    const nmIds = (await fa.get("/api/admin/nominations")).data.map((x) => x.id);
    assert.equal((await fa.post(`/api/admin/tprojects/${tp}/members`, { cohortId: "f-co", userIds: people.map((p) => p.id) })).data.count, 3);
    const qIds = [];
    for (let i = 0; i < 3; i++) qIds.push((await fa.post("/api/admin/questions", { courseId: "culture-conduct", type: "mcq", question: "F" + i, options: [{ text: "a", ok: true }, { text: "b", ok: false }] })).data.id);
    const uids = people.map((p) => p.id);
    // 第二批（2026-10-07）：B5 三门草稿课程；B7 一场考试、三人各一条未通过的答卷
    const cIds = [];
    for (let i = 0; i < 3; i++) {
      const cid = "flt-course-" + i;
      assert.equal((await fa.put("/api/admin/content/courses/" + cid, { id: cid, title: "Fault course " + i, status: "draft", mode: "online", modules: [{ id: cid + "-m1", title: "M1", minutes: 5, sections: [] }] })).status, 200);
      cIds.push(cid);
    }
    const xc = "flt-exam-course";
    assert.equal((await fa.put("/api/admin/content/courses/" + xc, { id: xc, title: "Fault exam course", status: "published", mode: "online", modules: [{ id: xc + "-m1", title: "M1", minutes: 5, sections: [] }] })).status, 200);
    assert.equal((await fa.post("/api/admin/questions", { courseId: xc, type: "mcq", question: "Fault exam?", options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] })).status, 200);
    const fx = await fa.post("/api/admin/exams", { programId: "pw-" + xc, title: "Fault exam", courseIds: [xc], passingScore: 50, mcqCount: 1, openCount: 0, status: "published" });
    assert.equal(fx.status, 200, JSON.stringify(fx.data));
    const aIds = [];
    for (const p of people) {
      assert.equal((await fa.post("/api/admin/assignments", { userId: p.id, items: [{ programId: "pw-" + xc, assigned: true, dueAt: null }] })).status, 200);
      assert.equal((await p.c.post(`/api/courses/${xc}/modules/${xc}-m1/complete`)).status, 200);
      const st = await p.c.post("/api/exam/start", { examId: fx.data.id });
      assert.equal(st.status, 200, JSON.stringify(st.data));
      const answers = {};
      for (const q of st.data.questions) answers[q.id] = q.options.findIndex((o) => o.text === "wrong");
      assert.equal((await p.c.post(`/api/exam/${st.data.attemptId}/submit`, { answers })).status, 200);
      aIds.push(st.data.attemptId);
    }
    const calls = [
      ["enroll-requests/bulk-decide", (ids) => fa.post("/api/admin/enroll-requests/bulk-decide", { ids, decision: "approve" }), erIds],
      ["nominations/bulk-decide", (ids) => fa.post("/api/admin/nominations/bulk-decide", { ids, decision: "approve" }), nmIds],
      ["members/bulk-update", (ids) => fa.post(`/api/admin/tprojects/${tp}/members/bulk-update`, { userIds: ids, action: "move", cohortId: "f-co", classId: "f-c2" }), uids],
      ["checkin/bulk-mark", (ids) => fa.post(`/api/admin/tprojects/${tp}/checkin/f-off/bulk-mark`, { userIds: ids, status: "attended" }), uids],
      ["questions/bulk-update", (ids) => fa.post("/api/admin/questions/bulk-update", { ids, op: "points", points: 9 }), qIds],
      ["content/bulk-update", (ids) => fa.post("/api/admin/content/bulk-update", { ids, op: "publish" }), cIds],
      ["attempts/bulk-reset", (ids) => fa.post("/api/admin/attempts/bulk-reset", { ids }), aIds],
    ];
    const counts = () => dbRead((d) => ({
      audit: d.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
      notifications: d.prepare("SELECT COUNT(*) AS n FROM notifications").get().n,
      pending: d.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get().n,
      assignments: d.prepare("SELECT COUNT(*) AS n FROM assignments").get().n,
      members: d.prepare("SELECT group_concat(userId || ':' || cohortId || ':' || ifnull(classId, '-') || ':' || state, '|') AS s FROM project_members").get().s,
      states: d.prepare("SELECT COUNT(*) AS n FROM activity_state").get().n,
      points: d.prepare("SELECT group_concat(ifnull(points, '-'), '|') AS s FROM questions").get().s,
      content: d.prepare("SELECT group_concat(kind || ':' || id || ':' || json, '|') AS s FROM (SELECT * FROM content ORDER BY kind, id)").get().s,
      versions: d.prepare("SELECT COUNT(*) AS n FROM content_versions").get().n,
      voided: d.prepare("SELECT COUNT(*) AS n FROM attempts WHERE COALESCE(voided, 0) = 1").get().n,
    }), fsrv.dbPath);
    const c0 = counts();
    assert.equal(c0.pending, 6);
    for (const [name, call, ids] of calls) {
      assert.equal(ids.length, 3, name);
      const over = await call([...ids, "extra-id"]);
      assert.equal(over.status, 400, name + " over cap: " + JSON.stringify(over.data));
      assert.deepEqual([over.data.code, over.data.selected, over.data.cap], ["over_cap", 4, 3], name);
      assert.ok(over.data.error && over.data.error_zh, name);
      const r = await call(ids);
      assert.equal(r.status, 500, name + ": " + JSON.stringify(r.data));
      assert.equal(r.data.code, "batch_failed", name);
      assert.equal(r.data.line, 2, name);
      assert.ok(r.data.error && r.data.error_zh, name + " bilingual");
      assert.ok(!/injected|LMS_TEST_FAIL_BULK_AT/.test(JSON.stringify(r.data)), name + ": no raw exception text");
      assert.deepEqual(counts(), c0, name + ": nothing written, no audit, no notification");
    }
    assert.match((await calls[0][1](erIds)).data.error, /selected item #2/);
    assert.match((await calls[2][1](uids)).data.error_zh, /第 2 个选中人员/);
    // 题库导入仍按自己的旋钮（2）：3 题被拒；B4 的 3 项没有被这个旋钮拦下（上面走到了第 2 项）
    const imp = await fa.post("/api/admin/questions/bulk", { courseId: "culture-conduct", items: [1, 2, 3].map((i) => ({ type: "mcq", question: "I" + i, options: [{ text: "a", ok: true }, { text: "b", ok: false }] })) });
    assert.deepEqual([imp.status, imp.data.code, imp.data.cap], [400, "over_cap", 2]);
  } finally {
    await fsrv.stopAsync();
  }
});
