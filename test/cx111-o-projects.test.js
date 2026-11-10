// 上线前全覆盖 O 组（发展项目、签到，10/11）：
//   CX-111 单条「改为出席」：学员本人输码的「迟到」改为出席后仍是本人签到（by = 学员本人），不可撤销（409 self_checkin）；
//   CX-113 单条驳回申请不填理由 → 400 note_required；
//   CX-115 没有学员与记录的期次可删除，有学员的期次 409 cohort_in_use；
//   CX-116 管理员账号不能申请、也不能经审批入班（admin_not_learner）；
//   CX-117 草稿项目加学员不发「你已加入」，发布时补发；
//   CX-119 已处理的申请再审批带 error_zh；CX-120 项目活动截止日同步到学员指派；
//   CX-122 同一员工重复申请只通知管理员一次。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

const ymd = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);   // 马尼拉日
const TODAY = ymd(Date.now());
let srv, admin, pid;
const L = {};
const dbw = (fn) => { const d = new DatabaseSync(srv.dbPath); try { return fn(d); } finally { d.close(); } };

async function learner(eid) {
  const { data: made } = await admin.post("/api/admin/employees", { name: "Learner " + eid, employeeId: eid });
  const c = await loginAs(srv.base, { employeeId: eid, password: made.password });
  await c.post("/api/auth/change-password", { currentPassword: made.password, newPassword: eid + "-pass-1a" });
  const id = (await admin.get("/api/admin/roster")).data.find((u) => u.employeeId === eid).id;
  L[eid] = { c, id };
}
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  pid = (await admin.post("/api/admin/tprojects", { title: "O group", title_zh: "O 组" })).data.id;
  const cohorts = [
    { id: "o-co1", name: "Cohort 1", startAt: "2026-01-01", endAt: "2099-12-31", capacity: 20, open: true, classes: [],
      phases: [{ id: "o-ph", name: "Phase", activities: [{ id: "o-today", type: "offline", title: "Today", startAt: TODAY + "T23:59" }] }] },
    { id: "o-co2", name: "Cohort 2 (typo)", startAt: "2026-01-01", endAt: "2099-12-31", capacity: 20, classes: [], phases: [] },
  ];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts, status: "running" })).status, 200);
  for (const e of ["O-1", "O-2", "O-3"]) await learner(e);
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "o-co1", userIds: [L["O-1"].id] })).status, 200);
});
after(async () => { if (srv) await srv.stopAsync(); });

test("CX-111: upgrading a learner's own late check-in to attended keeps it a self check-in (cannot be undone)", async () => {
  const code = (await admin.get(`/api/admin/tprojects/${pid}/checkin/o-today`)).data.code;
  const ck = await L["O-1"].c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "o-today", code });
  assert.equal(ck.status, 200, JSON.stringify(ck.data));
  dbw((d) => d.prepare("UPDATE activity_state SET status = 'late' WHERE activityId = ? AND userId = ?").run("o-today", L["O-1"].id));
  const up = await admin.post(`/api/admin/tprojects/${pid}/checkin/o-today/mark`, { userId: L["O-1"].id, status: "attended" });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const row = dbw((d) => d.prepare("SELECT status, by FROM activity_state WHERE activityId = ? AND userId = ?").get("o-today", L["O-1"].id));
  assert.equal(row.status, "attended");
  assert.equal(row.by, L["O-1"].id, "still the learner's own check-in");
  const clr = await admin.post(`/api/admin/tprojects/${pid}/checkin/o-today/mark`, { userId: L["O-1"].id, status: "clear" });
  assert.equal(clr.status, 409);
  assert.equal(clr.data.code, "self_checkin");
});

test("CX-122 / CX-113 / CX-119: a repeat application notifies admins once; single reject needs a reason; deciding twice says so in Chinese", async () => {
  const a1 = await L["O-2"].c.post(`/api/me/tprojects/${pid}/apply`, { note: "please" });
  assert.equal(a1.status, 200, JSON.stringify(a1.data));
  const a2 = await L["O-2"].c.post(`/api/me/tprojects/${pid}/apply`, { note: "again" });
  assert.equal(a2.status, 200);
  assert.equal(a2.data.existing, true);
  const n = dbw((d) => d.prepare("SELECT count(*) n FROM notifications WHERE type = 'tproject.apply' AND title LIKE ?").get("%Learner O-2%").n);
  const admins = dbw((d) => d.prepare("SELECT count(DISTINCT userId) n FROM notifications WHERE type = 'tproject.apply' AND title LIKE ?").get("%Learner O-2%").n);
  assert.equal(n, admins, "one notification per admin, not one per application attempt");
  const nm = dbw((d) => d.prepare("SELECT id FROM approvals WHERE kind = 'nomination' AND targetUserId = ? AND status = 'pending'").get(L["O-2"].id)).id;
  const bare = await admin.post(`/api/admin/nominations/${nm}/decide`, { decision: "reject", note: "  " });
  assert.equal(bare.status, 400);
  assert.equal(bare.data.code, "note_required");
  const ok = await admin.post(`/api/admin/nominations/${nm}/decide`, { decision: "reject", note: "Next cohort" });
  assert.equal(ok.status, 200);
  const again = await admin.post(`/api/admin/nominations/${nm}/decide`, { decision: "approve" });
  assert.equal(again.status, 400);
  assert.equal(again.data.code, "already_decided");
  assert.ok(again.data.error_zh);
});

test("CX-116: an admin account can neither apply nor be approved into a cohort", async () => {
  const ap = await admin.post(`/api/me/tprojects/${pid}/apply`, {});
  assert.equal(ap.status, 400, JSON.stringify(ap.data));
  assert.equal(ap.data.code, "admin_not_learner");
  // 历史遗留的管理员申请（修复前已提交）：审批通过也被拦下
  const adminId = (await admin.get("/api/me")).data.id || (await admin.get("/api/me")).data.user.id;
  dbw((d) => d.prepare("INSERT INTO approvals (id, kind, subjectJson, requesterId, targetUserId, note, status, requestedAt) VALUES (?, 'nomination', ?, ?, ?, NULL, 'pending', ?)")
    .run("nm-adm-1", JSON.stringify({ projectId: pid, cohortId: "o-co1" }), adminId, adminId, new Date().toISOString()));
  const r = await admin.post("/api/admin/nominations/nm-adm-1/decide", { decision: "approve" });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.code, "admin_not_learner");
  const isMember = dbw((d) => d.prepare("SELECT count(*) n FROM project_members WHERE projectId = ? AND userId = ?").get(pid, adminId).n);
  assert.equal(isMember, 0);
});

test("CX-115: an empty cohort can be deleted; a cohort with learners cannot (409 cohort_in_use)", async () => {
  const doc = (await admin.get("/api/admin/tprojects/" + pid)).data;
  const busy = await admin.put("/api/admin/tprojects/" + pid, { cohorts: doc.cohorts.filter((c) => c.id !== "o-co1") });
  assert.equal(busy.status, 409);
  assert.equal(busy.data.code, "cohort_in_use");
  const ok = await admin.put("/api/admin/tprojects/" + pid, { cohorts: doc.cohorts.filter((c) => c.id !== "o-co2") });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual((await admin.get("/api/admin/tprojects/" + pid)).data.cohorts.map((c) => c.id), ["o-co1"]);
});

test("CX-117: learners added while the program is a draft are notified when it is published, not before", async () => {
  const dp = (await admin.post("/api/admin/tprojects", { title: "Draft program", title_zh: "草稿项目" })).data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + dp, { cohorts: [{ id: "d-co", name: "D1", startAt: "2026-01-01", endAt: "2099-12-31", classes: [], phases: [] }] })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${dp}/members`, { cohortId: "d-co", userIds: [L["O-3"].id] })).status, 200);
  const joined = () => dbw((d) => d.prepare("SELECT count(*) n FROM notifications WHERE userId = ? AND type = 'tproject.joined' AND link = ?").get(L["O-3"].id, "#/projects/" + dp).n);
  assert.equal(joined(), 0, "no notification while draft");
  assert.equal((await admin.put("/api/admin/tprojects/" + dp, { status: "planning" })).status, 200);
  assert.equal(joined(), 1, "notified on publish");
  assert.equal((await admin.put("/api/admin/tprojects/" + dp, { status: "running" })).status, 200);
  assert.equal(joined(), 1, "not again on later status changes");
  // CX-187：改回草稿再发布，每人仍只有一条
  assert.equal((await admin.put("/api/admin/tprojects/" + dp, { status: "draft" })).status, 200);
  assert.equal((await admin.put("/api/admin/tprojects/" + dp, { status: "running" })).status, 200);
  assert.equal(joined(), 1, "re-publishing does not notify again");
});

test("CX-120: activity due date is authoritative and an edit syncs the existing learner assignment", async () => {
  const content = (await admin.get("/api/admin/content")).data;
  const course = content.courses.find((c) => content.programs.some((p) => (p.courseIds || []).includes(c.id) && (p.status || "published") === "published"));
  assert.ok(course, "fixture has a course in a published program");
  const xp = (await admin.post("/api/admin/tprojects", { title: "CX-120", title_zh: "CX-120" })).data.id;
  const cohort = (dueAt) => ({
    id: "cx120-co", name: "Deadline sync", startAt: "2026-01-01", endAt: "2099-12-31", capacity: 20, open: true, classes: [],
    phases: [{ id: "cx120-ph", name: "Phase", activities: [{ id: "cx120-act", type: "course", refId: course.id, title: course.title, dueAt }] }],
  });
  assert.equal((await admin.put("/api/admin/tprojects/" + xp, { cohorts: [cohort("2030-05-10")], status: "running" })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${xp}/members`, { cohortId: "cx120-co", userIds: [L["O-3"].id] })).status, 200);
  const dates = () => dbw((d) => d.prepare("SELECT programId, dueAt FROM assignments WHERE userId = ? ORDER BY programId").all(L["O-3"].id));
  const first = dates().filter((x) => x.dueAt === "2030-05-10");
  assert.ok(first.length > 0, "activity due date, not cohort end, reaches the assignment");
  assert.equal((await admin.put("/api/admin/tprojects/" + xp, { cohorts: [cohort("2030-06-20")], status: "running" })).status, 200);
  const after = dates();
  for (const row of first) assert.equal(after.find((x) => x.programId === row.programId).dueAt, "2030-06-20", "existing learner is resynced");
});

test("CX-189: checking in to an activity that does not exist answers 404 with Chinese text", async () => {
  const r = await L["O-1"].c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "no-such-act", code: "000000" });
  assert.equal(r.status, 404, JSON.stringify(r.data));
  assert.equal(r.data.error_zh, "未找到该活动。");
});
