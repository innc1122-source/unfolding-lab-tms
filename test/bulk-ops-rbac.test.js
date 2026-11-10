// 批量操作 B1–B4（2026-10-06）的权限与数据范围契约测试。
//   · 四个以员工为主体的端点（两条申请审批、期次与成员、签到 / 完成登记）：选中项里只要有 1 项的主体在操作者范围外，
//     整批 404 out_of_scope + 越界条数，范围内那几项也一行不写、不写审计、不发通知；范围预检排在逐条状态检查之前；
//     不存在的 id 不计数（逐条报 not_found）；申请人已被删除时，范围生效即算越界（与单条的 404 同口径）。
//   · 空范围角色与超管：跨部门的一批照常处理。题库（内容对象）不受范围约束。
//   · 培训只读角色 403、没有培训权限的角色 404；培训模块关闭时五个端点都是 404。
// 第二批（2026-10-07）：B5 课程库批量操作（内容对象，范围受限的角色也能用）与 B7 考试成绩批量重置（按答卷的员工过范围，
// 任一项越界整批拒绝）并入上面的培训端点表；B6 评估按阶段提醒属绩效域，单独一组：绩效只读 403、没有绩效权限 404、
// 绩效模块关闭 404（不能塞进培训端点表 —— 培训只读角色对它是 404，关培训模块它也不关）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin;
const dept = {}, emp = {}, client = {};
let scoped, plain, readonly, perfOnly, perfRead;
let elective, tpApply, tpRoll, qIds = [];
let courseIds = [];             // B5：草稿课程
const attemptId = {};           // B7：userId → 一条未通过的考试答卷
const ROLL_CO = "bks-co", ROLL_ACT = "bks-off";

function dbRead(fn) { const d = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return fn(d); } finally { d.close(); } }
const one = (sql, ...a) => dbRead((d) => d.prepare(sql).get(...a));
function dbWrite(sql, ...a) {
  const d = new DatabaseSync(srv.dbPath);
  try { d.exec("PRAGMA busy_timeout = 5000"); return d.prepare(sql).run(...a); } finally { d.close(); }
}
const snapshot = () => dbRead((d) => ({
  audit: d.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
  notifications: d.prepare("SELECT COUNT(*) AS n FROM notifications").get().n,
  approvals: d.prepare("SELECT group_concat(id || ':' || status, '|') AS s FROM (SELECT id, status FROM approvals ORDER BY id)").get().s,
  assignments: d.prepare("SELECT COUNT(*) AS n FROM assignments").get().n,
  members: d.prepare("SELECT group_concat(userId || ':' || ifnull(classId, '-') || ':' || state, '|') AS s FROM (SELECT * FROM project_members ORDER BY projectId, userId)").get().s,
  states: d.prepare("SELECT COUNT(*) AS n FROM activity_state").get().n,
  points: d.prepare("SELECT group_concat(id || ':' || ifnull(points, '-') || ':' || courseId, '|') AS s FROM (SELECT * FROM questions ORDER BY id)").get().s,
  content: d.prepare("SELECT group_concat(kind || ':' || id || ':' || json, '|') AS s FROM (SELECT * FROM content ORDER BY kind, id)").get().s,
  voided: d.prepare("SELECT COUNT(*) AS n FROM attempts WHERE COALESCE(voided, 0) = 1").get().n,
}));

async function makeRole(name, grants, scope) {
  const r = await admin.post("/api/admin/roles", { name, name_zh: name, grants, ...(scope ? { scope } : {}) });
  assert.equal(r.status, 200, "create role " + name + ": " + JSON.stringify(r.data));
  return r.data.role.id;
}
async function makeUser(empId, { department, adminRoleId } = {}) {
  const created = await admin.post("/api/admin/employees", { name: empId, employeeId: empId, programIds: [] });
  assert.equal(created.status, 200, "create " + empId);
  const id = one("SELECT id FROM users WHERE employeeId = ?", empId).id;
  assert.equal((await admin.put("/api/admin/employees/" + id, { ...(department ? { department, jobLevel: "P5" } : {}), ...(adminRoleId ? { adminRoleId } : {}) })).status, 200);
  const c = await loginAs(srv.base, { employeeId: empId, password: created.data.password });
  assert.equal((await c.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: empId + "-pw-2026" })).status, 200);
  return { id, c };
}
async function idsByUser(path, key, value) {
  const r = await admin.get(path);
  assert.equal(r.status, 200);
  const out = {};
  for (const x of r.data) if (x[key] === value) out[x.userId] = x.id;
  return out;
}
// 五个端点，按「选中的主体」拼请求体
const ENDPOINTS = {
  enroll: (c, ids, extra) => c.post("/api/admin/enroll-requests/bulk-decide", { ids, decision: "approve", ...(extra || {}) }),
  nominations: (c, ids, extra) => c.post("/api/admin/nominations/bulk-decide", { ids, decision: "approve", ...(extra || {}) }),
  members: (c, ids) => c.post(`/api/admin/tprojects/${tpRoll}/members/bulk-update`, { userIds: ids, action: "move", cohortId: ROLL_CO, classId: "bks-c2" }),
  checkin: (c, ids) => c.post(`/api/admin/tprojects/${tpRoll}/checkin/${ROLL_ACT}/bulk-mark`, { userIds: ids, status: "attended" }),
  questions: (c, ids) => c.post("/api/admin/questions/bulk-update", { ids, op: "points", points: 3 }),
  content: (c, ids) => c.post("/api/admin/content/bulk-update", { ids, op: "category", category: "Scope cat" }),   // B5（2026-10-07）
  attempts: (c, ids) => c.post("/api/admin/attempts/bulk-reset", { ids }),                                         // B7（2026-10-07）
};
let enrollId, nomId;
function idsFor(kind, people) {
  if (kind === "enroll") return people.map((p) => enrollId[emp[p]]);
  if (kind === "nominations") return people.map((p) => nomId[emp[p]]);
  if (kind === "attempts") return people.map((p) => attemptId[emp[p]]);
  return people.map((p) => emp[p]);
}
// 内容对象（题库、课程库）用自己的 id，其余按「BKS-IN2 这个人」取
const idsOf = (kind) => (kind === "questions" ? qIds : kind === "content" ? courseIds : idsFor(kind, ["BKS-IN2"]));
// B6（绩效域）
const reviewRemind = (c, ids) => c.post("/api/admin/review-reminders", { stage: "self", by: "cycle", ids });

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  for (const [name, parent] of [["BKS Root", null], ["BKS Child", "BKS Root"], ["BKS Other", null]]) {
    const r = await admin.post("/api/admin/departments", parent ? { name, parentId: dept[parent] } : { name });
    assert.equal(r.status, 200, "create department " + name);
    dept[name] = r.data.department.id;
  }
  for (const [e, d] of [["BKS-IN", "BKS Root"], ["BKS-KID", "BKS Child"], ["BKS-OUT", "BKS Other"], ["BKS-DEL", "BKS Root"], ["BKS-IN2", "BKS Root"]]) {
    const u = await makeUser(e, { department: d });
    emp[e] = u.id; client[e] = u.c;
  }
  elective = (await admin.post("/api/admin/programs", { title: "Scope Bulk Elective", status: "published", enrollType: "elective" })).data.id;
  for (const e of ["BKS-IN", "BKS-KID", "BKS-OUT", "BKS-DEL", "BKS-IN2"])
    assert.equal((await client[e].post("/api/me/enroll-requests", { programId: elective })).status, 200, "enroll request " + e);
  enrollId = await idsByUser("/api/admin/enroll-requests", "programId", elective);
  tpApply = (await admin.post("/api/admin/tprojects", { title: "Scope Bulk Apply" })).data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + tpApply, { status: "planning", cohorts: [{ id: "bks-apply", name: "Apply", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, open: true, classes: [], phases: [] }] })).status, 200);
  for (const e of ["BKS-IN", "BKS-KID", "BKS-OUT"]) assert.equal((await client[e].post(`/api/me/tprojects/${tpApply}/apply`, {})).status, 200, "apply " + e);
  nomId = await idsByUser("/api/admin/nominations", "projectId", tpApply);
  tpRoll = (await admin.post("/api/admin/tprojects", { title: "Scope Bulk Roll" })).data.id;
  assert.equal((await admin.put("/api/admin/tprojects/" + tpRoll, { status: "running", cohorts: [{
    id: ROLL_CO, name: "Roll", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 50, classes: [{ id: "bks-c1", name: "C1" }, { id: "bks-c2", name: "C2" }],
    phases: [{ id: "bks-ph", name: "P1", gateMode: "time", activities: [{ id: ROLL_ACT, type: "offline", title: "Session", startAt: "2099-01-02T09:00" }] }],
  }] })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${tpRoll}/members`, { cohortId: ROLL_CO, classId: "bks-c1", userIds: ["BKS-IN", "BKS-KID", "BKS-OUT", "BKS-IN2"].map((e) => emp[e]) })).data.count, 4);
  for (let i = 0; i < 2; i++) {
    const r = await admin.post("/api/admin/questions", { courseId: "culture-conduct", type: "mcq", question: "Scope Q" + i, options: [{ text: "a", ok: true }, { text: "b", ok: false }] });
    qIds.push(r.data.id);
  }
  // 第二批：B5 两门草稿课程；B7 一场考试，BKS-IN / KID / OUT / IN2 各交一份未通过的答卷
  for (let i = 0; i < 2; i++) {
    const cid = "bks-course-" + i;
    assert.equal((await admin.put("/api/admin/content/courses/" + cid, { id: cid, title: "Scope course " + i, status: "draft", mode: "online", modules: [{ id: cid + "-m1", title: "M1", minutes: 5, sections: [] }] })).status, 200);
    courseIds.push(cid);
  }
  const xc = "bks-exam-course";
  assert.equal((await admin.put("/api/admin/content/courses/" + xc, { id: xc, title: "Scope exam course", status: "published", mode: "online", modules: [{ id: xc + "-m1", title: "M1", minutes: 5, sections: [] }] })).status, 200);
  assert.equal((await admin.post("/api/admin/questions", { courseId: xc, type: "mcq", question: "Scope exam?", options: [{ text: "right", ok: true }, { text: "wrong", ok: false }] })).status, 200);
  const ex = await admin.post("/api/admin/exams", { programId: "pw-" + xc, title: "Scope exam", courseIds: [xc], passingScore: 50, mcqCount: 1, openCount: 0, status: "published" });
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  for (const e of ["BKS-IN", "BKS-KID", "BKS-OUT", "BKS-IN2"]) {
    assert.equal((await admin.post("/api/admin/assignments", { userId: emp[e], items: [{ programId: "pw-" + xc, assigned: true, dueAt: null }] })).status, 200);
    assert.equal((await client[e].post(`/api/courses/${xc}/modules/${xc}-m1/complete`)).status, 200);
    const st = await client[e].post("/api/exam/start", { examId: ex.data.id });
    assert.equal(st.status, 200, JSON.stringify(st.data));
    const answers = {};
    for (const q of st.data.questions) answers[q.id] = q.options.findIndex((o) => o.text === "wrong");
    assert.equal((await client[e].post(`/api/exam/${st.data.attemptId}/submit`, { answers })).status, 200);
    attemptId[emp[e]] = st.data.attemptId;
  }
  const scope = { departments: [{ id: dept["BKS Root"], includeChildren: true }] };
  scoped = (await makeUser("BKS-A-SCOPED", { adminRoleId: await makeRole("Bulk Scoped Learning", { learning: "manage" }, scope) })).c;
  plain = (await makeUser("BKS-A-PLAIN", { adminRoleId: await makeRole("Bulk Plain Learning", { learning: "manage" }) })).c;
  readonly = (await makeUser("BKS-A-READ", { adminRoleId: await makeRole("Bulk Read Learning", { learning: "read" }) })).c;
  perfOnly = (await makeUser("BKS-A-PERF", { adminRoleId: await makeRole("Bulk Perf Only", { performance: "manage" }) })).c;
  perfRead = (await makeUser("BKS-A-PERFR", { adminRoleId: await makeRole("Bulk Perf Read", { performance: "read" }) })).c;
});
after(async () => { if (srv) await srv.stopAsync(); });

test("以员工为主体的批量端点（含 B7 考试成绩重置）：选中项里有 1 人在范围外 → 整批 404 out_of_scope + 越界条数，范围内那项也没写、无审计、无通知", async () => {
  for (const kind of ["enroll", "nominations", "members", "checkin", "attempts"]) {
    const s0 = snapshot();
    const r = await ENDPOINTS[kind](scoped, idsFor(kind, ["BKS-KID", "BKS-OUT"]));
    assert.equal(r.status, 404, kind + ": " + JSON.stringify(r.data));
    assert.equal(r.data.code, "out_of_scope", kind);
    assert.equal(r.data.outOfScope, 1, kind + " reports how many");
    assert.ok(r.data.error && /[一-鿿]/.test(r.data.error_zh), kind + " error + error_zh");
    assert.deepEqual(snapshot(), s0, kind + ": nothing written");
  }
});

test("范围预检排在逐条状态检查之前；不存在的 id 不计数（逐条 not_found），范围内的一批照常生效", async () => {
  // 范围外的那条先被超管处理掉：它仍然算越界，整批拒绝
  assert.equal((await admin.post(`/api/admin/enroll-requests/${enrollId[emp["BKS-OUT"]]}/decide`, { decision: "reject" })).status, 200);
  const s0 = snapshot();
  const r = await ENDPOINTS.enroll(scoped, idsFor("enroll", ["BKS-IN", "BKS-OUT"]));
  assert.equal(r.status, 404);
  assert.equal(r.data.outOfScope, 1);
  assert.deepEqual(snapshot(), s0);
  const ok = await ENDPOINTS.enroll(scoped, ["er-ghost", ...idsFor("enroll", ["BKS-IN"])]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.results.map((x) => x.code || "ok"), ["not_found", "ok"]);
  assert.equal(one("SELECT status FROM approvals WHERE id = ?", enrollId[emp["BKS-IN"]]).status, "approved");
  const mem = await ENDPOINTS.members(scoped, ["u-ghost", emp["BKS-KID"]]);
  assert.equal(mem.status, 200);
  assert.deepEqual(mem.data.results.map((x) => x.code || "ok"), ["not_found", "ok"]);
});

test("申请人已被删除：范围生效时算越界，整批拒绝（与单条的 404 同口径）；空范围角色照常处理", async () => {
  const delId = enrollId[emp["BKS-DEL"]];
  dbWrite("UPDATE approvals SET targetUserId = ? WHERE id = ?", "u-deleted-applicant", delId);   // 申请行还在，申请人已不存在
  const s0 = snapshot();
  const r = await ENDPOINTS.enroll(scoped, [delId, enrollId[emp["BKS-IN2"]]]);
  assert.equal(r.status, 404, JSON.stringify(r.data));
  assert.equal(r.data.outOfScope, 1, "the dangling applicant counts as out of scope");
  assert.deepEqual(snapshot(), s0);
  const single = await scoped.post(`/api/admin/enroll-requests/${delId}/decide`, { decision: "reject" });
  assert.equal(single.status, 404, "the single decide says the same");
  const p = await plain.post("/api/admin/enroll-requests/bulk-decide", { ids: [delId], decision: "reject", note: "Applicant left" });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.done, 1);
});

test("空范围角色与超管：跨部门的一批照常处理；题库是内容对象，范围受限的角色也能批量修改", async () => {
  const p = await ENDPOINTS.nominations(plain, idsFor("nominations", ["BKS-IN", "BKS-OUT"]));
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.done, 2);
  const s = await ENDPOINTS.checkin(admin, idsFor("checkin", ["BKS-IN", "BKS-OUT"]));
  assert.equal(s.status, 200);
  assert.equal(s.data.done, 2);
  const m = await ENDPOINTS.members(plain, idsFor("members", ["BKS-IN", "BKS-OUT"]));
  assert.equal(m.status, 200);
  assert.equal(m.data.done, 2);
  const q = await ENDPOINTS.questions(scoped, qIds);
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.equal(q.data.done, 2);
  assert.equal(one("SELECT points FROM questions WHERE id = ?", qIds[0]).points, 3);
  // B5 课程库：内容对象，范围受限的角色也能批量改分类
  const cc = await ENDPOINTS.content(scoped, courseIds);
  assert.equal(cc.status, 200, JSON.stringify(cc.data));
  assert.equal(cc.data.done, 2);
  assert.equal(JSON.parse(one("SELECT json FROM content WHERE kind = 'course' AND id = ?", courseIds[0]).json).category, "Scope cat");
  // B7：范围内的答卷照常重置；空范围角色跨部门照常
  const at = await ENDPOINTS.attempts(scoped, idsFor("attempts", ["BKS-IN"]));
  assert.equal(at.status, 200, JSON.stringify(at.data));
  assert.deepEqual([at.data.done, at.data.voided], [1, 1]);
  const ap = await ENDPOINTS.attempts(plain, idsFor("attempts", ["BKS-OUT", "BKS-KID"]));
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.deepEqual([ap.data.done, ap.data.voided], [2, 2]);
});

test("B6 评估按阶段提醒（绩效域）：绩效只读 403、没有绩效权限 404（培训角色也是）、绩效模块关闭 404、关培训模块不影响它", async () => {
  const s0 = snapshot();
  const ok = await reviewRemind(perfOnly, ["rc-ghost"]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.results.map((x) => x.code), ["not_found"]);
  const ro = await reviewRemind(perfRead, ["rc-ghost"]);
  assert.equal(ro.status, 403, "performance read-only: " + JSON.stringify(ro.data));
  for (const [name, c] of [["learning read-only", readonly], ["learning manage", plain], ["scoped learning", scoped]]) {
    const r = await reviewRemind(c, ["rc-ghost"]);
    assert.equal(r.status, 404, name + ": " + JSON.stringify(r.data));
  }
  assert.equal((await admin.put("/api/admin/modules-config", { modules: { performance: false } })).status, 200);
  try {
    const off = await reviewRemind(admin, ["rc-ghost"]);
    assert.equal(off.status, 404, JSON.stringify(off.data));
    assert.deepEqual(off.data, { error: "Not found" });
  } finally {
    assert.equal((await admin.put("/api/admin/modules-config", { modules: { performance: true } })).status, 200);
  }
  assert.equal((await admin.put("/api/admin/modules-config", { modules: { learning: false } })).status, 200);
  try {
    const on = await reviewRemind(admin, ["rc-ghost"]);
    assert.equal(on.status, 200, "learning off does not close a performance route: " + JSON.stringify(on.data));
  } finally {
    assert.equal((await admin.put("/api/admin/modules-config", { modules: { learning: true } })).status, 200);
  }
  assert.equal((await reviewRemind(admin, ["rc-ghost"])).status, 200, "the route answers again");
  // 模块开关本身写审计（modules.update），其余什么都没写；也没有任何评估提醒的审计
  const { audit: a1, ...rest1 } = snapshot();
  const { audit: a0, ...rest0 } = s0;
  assert.deepEqual(rest1, rest0, "nothing written");
  assert.equal(one("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('review.nudge', 'review.remind')").n, 0);
  assert.ok(a1 >= a0);
});

test("培训只读角色 403、没有培训权限的角色 404：七个培训端点（含 B5、B7）一个都写不进", async () => {
  const s0 = snapshot();
  for (const [kind, call] of Object.entries(ENDPOINTS)) {
    const ids = idsOf(kind);
    const ro = await call(readonly, ids);
    assert.equal(ro.status, 403, kind + " read-only: " + JSON.stringify(ro.data));
    const pf = await call(perfOnly, ids);
    assert.equal(pf.status, 404, kind + " no learning access: " + JSON.stringify(pf.data));
  }
  assert.deepEqual(snapshot(), s0, "nothing written");
});

test("培训模块关闭：七个培训端点（含 B5、B7）都 404（与未知路由同形）；重新打开后恢复", async () => {
  assert.equal((await admin.put("/api/admin/modules-config", { modules: { learning: false } })).status, 200);
  try {
    for (const [kind, call] of Object.entries(ENDPOINTS)) {
      const r = await call(admin, idsOf(kind));
      assert.equal(r.status, 404, kind + ": " + JSON.stringify(r.data));
      assert.deepEqual(r.data, { error: "Not found" }, kind);
    }
  } finally {
    assert.equal((await admin.put("/api/admin/modules-config", { modules: { learning: true } })).status, 200);
  }
  const back = await admin.post("/api/admin/questions/bulk-update", { ids: [], op: "points", points: 3 });
  assert.equal(back.status, 400, "the route answers again");
  assert.equal(back.data.code, "no_items");
});
