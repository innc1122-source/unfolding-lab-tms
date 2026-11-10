// 2026-10-09 上线验收（Codex + Claude）P0 / P1 修复的回归：docs/HANDOFF-DEV-UAT-20261009.md 第一节。
//   CX-025 已结束期次不再出码、学员输码 409 cohort_ended（写入前拒绝，已有请假记录原样保留；未结束期次仍按 F5 由本人签到覆盖请假）；
//   CX-036 课程 / 模块英文留空不再复制中文（接口存空串，显示层 i18n loc 回退）；中英都空才 400；
//   CX-032 课程包导出（JSON：课程 + 附件清单）与导入（新 id、草稿、改名、坏文件 400 bad_package 不写库）；
//   CX-048 迁移 94 停用 DEMO-ADMIN（已有库：登录 401 disabled + 系统审计；幂等；新库播种不受影响）；
//   CX-051 / CX-052 3+3 员工端不显示工号（选人接口不回传、我的进度页头不拼工号）。
// 真服务 + 一次性库（helpers.startServer），永不碰 lms.db。修复前全部用例失败（见 HANDOVER 1.55 的修复前运行记录）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, DEMO_ADMIN, startServer, loginAs, makeClient, tempDir } = require("./helpers.js");
// CX-078（10/11）：员工输码签到只在活动当天开放 —— 签到用例的活动时间取「今天」（马尼拉日）：00:00 测迟到、23:59 测准时
const TODAY_YMD = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const TODAY_EARLY = TODAY_YMD + "T00:00", TODAY_LATE = TODAY_YMD + "T23:59";

const ROOT = path.join(__dirname, "..");
const COURSE = "culture-conduct";
let srv, admin, pid;
const people = [];   // [0] = 已结束期次的学员，[1] = 未结束期次的学员

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000));
const daysAhead = (n) => ymd(new Date(Date.now() + n * 86400000));

async function makeLearner(id, name) {
  const { data: made } = await admin.post("/api/admin/employees", { name, employeeId: id });
  const c = await loginAs(srv.base, { employeeId: id, password: made.password });
  await c.post("/api/auth/change-password", { currentPassword: made.password, newPassword: "uat-learner-2026" });
  const userId = made.id || (await admin.get("/api/admin/roster")).data.find((u) => u.employeeId === id).id;
  return { c, userId };
}

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const content = await admin.get("/api/admin/content");
  const course = content.data.courses.find((c) => c.id === COURSE);
  assert.ok(course, "seeded course present");
  assert.equal((await admin.put("/api/admin/content/courses/" + COURSE, { ...course, mode: "offline", location: "Room 1", sessionAt: TODAY_EARLY, status: "published" })).status, 200);
  const created = await admin.post("/api/admin/tprojects", { title: "UAT check-in", title_zh: "验收签到" });
  pid = created.data.id;
  const cohorts = [
    { id: "co-ended", name: "第一期", startAt: daysAgo(60), endAt: daysAgo(1), capacity: 10, classes: [],
      phases: [{ id: "ph-e", name: "Phase", activities: [{ id: "act-e", type: "offline", title: "Kickoff", startAt: daysAgo(30) + "T09:00" }] }] },
    { id: "co-open", name: "第二期", startAt: daysAgo(10), endAt: daysAhead(60), capacity: 10, classes: [],
      phases: [{ id: "ph-o", name: "Phase", activities: [
        { id: "act-o", type: "offline", title: "Kickoff 2", startAt: TODAY_EARLY },
        { id: "act-oc", type: "course", refId: COURSE, title: "In-person course" },
      ] }] },
  ];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts, status: "running" })).status, 200);
  people.push(await makeLearner("UAT-CK-0", "UAT Ended Cohort"));
  people.push(await makeLearner("UAT-CK-1", "UAT Open Cohort"));
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-ended", userIds: [people[0].userId] })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-open", userIds: [people[1].userId] })).status, 200);
});
after(async () => { if (srv) await srv.stopAsync(); });

// ---------- CX-025 ----------
test("CX-025: a cohort past its end date gets no code (project in progress) and a learner's code is refused with cohort_ended", async () => {
  const roll = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-e`)).data;
  assert.equal(roll.projectStatus, "running");
  assert.equal(roll.code, null, "no code for an ended cohort");
  assert.equal(roll.checkinOpen, false);
  assert.equal(roll.cohortEnded, true);
  assert.equal(roll.list.length, 1, "the list is still there");
  const r = await people[0].c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "act-e", code: "000000" });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "cohort_ended");
  assert.match(r.data.error_zh, /期次已结束/);
  // 工作人员补签 / 请假照常
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/checkin/act-e/mark`, { userId: people[0].userId, status: "excused" })).status, 200);
  // 未结束的期次照常出码
  const open = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-o`)).data;
  assert.match(String(open.code), /^\d{6}$/);
  assert.equal(open.checkinOpen, true);
  assert.equal(open.cohortEnded, false);
});

test("CX-025: a leave record in an ended cohort survives the learner's attempt (refused before any write); in an open cohort the learner's own check-in still overrides leave (F5, 2026-10-06)", async () => {
  // 已结束期次：上一条已为 people[0] 登记请假；学员再输码 → 409 cohort_ended，记录原样
  const r = await people[0].c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "act-e", code: "000000" });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "cohort_ended");
  const row = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-e`)).data.list.find((x) => x.userId === people[0].userId);
  assert.equal(row.status, "excused", "the leave record is unchanged");
  // 未结束期次：请假后本人到场输码 → 覆盖为出席 / 迟到（负责人 2026-10-06 规则，excused-not-done.test.js F5）
  const { c, userId } = people[1];
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/checkin/act-o/mark`, { userId, status: "excused" })).status, 200);
  let ok;
  for (let i = 0; i < 2; i++) {   // 跨整分钟换码时重取一次
    const code = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-o`)).data.code;
    ok = await c.post(`/api/me/tprojects/${pid}/checkin`, { activityId: "act-o", code });
    if (ok.status === 200) break;
  }
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const row2 = (await admin.get(`/api/admin/tprojects/${pid}/checkin/act-o`)).data.list.find((x) => x.userId === userId);
  assert.ok(["attended", "late"].includes(row2.status), "own check-in overrides leave in an open cohort: " + row2.status);
});

// ---------- CX-036 ----------
test("CX-036: an empty English title is stored empty (not a copy of the Chinese one); both empty is a 400; the editor source no longer copies", async () => {
  const id = "course-uat-zh-only";
  const doc = { id, title: "", title_zh: "只有中文的课程", modules: [
    { id: "m-1", title: "", title_zh: "第一模块", minutes: 10, sections: [{ heading: "", heading_zh: "第一节", html: "", html_zh: "<p>正文</p>", attachments: [] }] },
  ] };
  const put = await admin.put("/api/admin/content/courses/" + id, doc);
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const saved = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === id);
  assert.equal(saved.title, "", "English title stays empty");
  assert.equal(saved.title_zh, "只有中文的课程");
  assert.equal(saved.modules[0].title, "", "module English title stays empty");
  assert.equal(saved.modules[0].sections[0].heading, "");
  assert.equal(saved.modules[0].sections[0].html, "");
  // 改中文：英文仍为空（显示层回退到新的中文，不会留旧副本）
  assert.equal((await admin.put("/api/admin/content/courses/" + id, { ...saved, title_zh: "第二版" })).status, 200);
  const again = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === id);
  assert.equal(again.title, "");
  assert.equal(again.title_zh, "第二版");
  // 中英都空 → 400
  const bad = await admin.put("/api/admin/content/courses/" + id, { ...saved, title: "", title_zh: "" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "title_required");
  const badM = await admin.put("/api/admin/content/courses/" + id, { ...saved, modules: [{ ...saved.modules[0], title: "", title_zh: "" }] });
  assert.equal(badM.status, 400);
  assert.equal(badM.data.code, "module_title_required");
  // 源码：编辑器不再复制；i18n loc 英文缺失时回退中文
  const src = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "Content.jsx"), "utf8");
  for (const bad of ["course.title || course.title_zh", "m.title || m.title_zh || ''", "sec.title || sec.title_zh || ''", "sec.body || sec.body_zh || ''", "(values.title || '').trim() || (values.title_zh", "(vals.title || '').trim() || (vals.title_zh"])
    assert.ok(!src.includes(bad), "Content.jsx still copies zh into en: " + bad);
  const i18n = fs.readFileSync(path.join(ROOT, "web", "src", "i18n.jsx"), "utf8");
  assert.match(i18n, /return has\(en\) \? en : \(has\(zh\) \? zh : en\)/, "loc falls back to zh when en is empty");
});

// ---------- CX-032 ----------
test("CX-032: export is a JSON package with the course and its attachment list; import creates a draft copy (new id, optional rename); bad packages are refused", async () => {
  const content = (await admin.get("/api/admin/content")).data;
  const src = content.courses.find((c) => c.id === COURSE);
  const before = content.courses.length;
  const exp = await admin.get(`/api/admin/content/courses/${COURSE}/export`);
  assert.equal(exp.status, 200, JSON.stringify(exp.data));
  const pkg = exp.data;
  assert.equal(pkg.format, "tms-course");
  assert.equal(pkg.version, 1);
  assert.equal(pkg.course.title, src.title);
  assert.equal(pkg.course.title_zh, src.title_zh || null);
  assert.equal(pkg.course.mode, "offline");
  assert.equal(pkg.course.modules.length, src.modules.length);
  assert.deepEqual(pkg.course.modules.map((m) => m.sections.length), src.modules.map((m) => m.sections.length));
  assert.ok(Array.isArray(pkg.attachments));
  for (const k of ["id", "status", "public", "trainerId"]) assert.ok(!(k in pkg.course), "package carries no " + k);
  assert.equal((await admin.get("/api/admin/content/courses/no-such-course/export")).status, 404);
  // 导入（原名）
  const imp = await admin.post("/api/admin/content/courses/import", { package: pkg });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.ok(imp.data.id && imp.data.id !== COURSE, "a new course id");
  assert.equal(imp.data.modules, src.modules.length);
  const srcDropped = pkg.course.modules.flatMap((m) => m.sections).reduce((n, s) => n + s.attachments.length + (s.video ? 1 : 0), 0);
  assert.equal(imp.data.attachmentsDropped, srcDropped, "attachments / in-course videos listed in the package are dropped on import");
  const after1 = (await admin.get("/api/admin/content")).data.courses;
  assert.equal(after1.length, before + 1);
  const copy = after1.find((c) => c.id === imp.data.id);
  assert.equal(copy.status, "draft");
  assert.equal(copy.title, src.title);
  assert.equal(copy.title_zh, src.title_zh || null);
  assert.equal(copy.mode, "offline");
  assert.equal(copy.location, src.location);
  assert.equal(copy.trainerId, null);
  assert.equal(copy.public, false);
  assert.deepEqual(copy.modules.map((m) => [m.title, m.title_zh, m.sections.map((s) => [s.heading, s.heading_zh, s.html])]),
    src.modules.map((m) => [m.title, m.title_zh, m.sections.map((s) => [s.heading, s.heading_zh, s.html])]), "modules / sections / bilingual text identical");
  assert.ok(copy.modules.every((m) => !src.modules.some((x) => x.id === m.id)), "module ids are new");
  assert.ok(after1.some((p) => p.id === COURSE), "the original is untouched");
  // 导入（改名）
  const imp2 = await admin.post("/api/admin/content/courses/import", { package: pkg, title: "Imported copy", title_zh: "导入副本" });
  assert.equal(imp2.status, 200, JSON.stringify(imp2.data));
  const copy2 = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === imp2.data.id);
  assert.equal(copy2.title, "Imported copy");
  assert.equal(copy2.title_zh, "导入副本");
  // 附件清单：带附件的包导入后附件被去掉并计数
  const withAtt = JSON.parse(JSON.stringify(pkg));
  const sec0 = withAtt.course.modules[0].sections[0];
  const added = 1 + (sec0.video ? 0 : 1);
  sec0.attachments = [...sec0.attachments, { name: "deck.pdf", kind: "pdf", size: 1234 }];
  sec0.video = true;
  const imp3 = await admin.post("/api/admin/content/courses/import", { package: withAtt, title_zh: "带附件清单" });
  assert.equal(imp3.status, 200, JSON.stringify(imp3.data));
  assert.equal(imp3.data.attachmentsDropped, srcDropped + added);
  const copy3 = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === imp3.data.id);
  assert.deepEqual(copy3.modules[0].sections[0].attachments, []);
  // 坏文件：不是对象 / 格式不对 / 缺模块 / 没有标题 → 400 bad_package，不写库
  const n0 = (await admin.get("/api/admin/content")).data.courses.length;
  for (const body of [
    { package: "not json object" },
    { package: { hello: 1 } },
    { package: { format: "tms-course", version: 2, course: pkg.course } },
    { package: { format: "tms-course", version: 1, course: { title: "x" } } },
    { package: { format: "tms-course", version: 1, course: { title: "", title_zh: "", modules: [] } } },
    { package: { format: "tms-course", version: 1, course: { title: "x", modules: [{ title: "m" }] } } },
    {},
  ]) {
    const r = await admin.post("/api/admin/content/courses/import", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.data.code, "bad_package");
    assert.ok(r.data.error_zh, "Chinese message");
  }
  assert.equal((await admin.get("/api/admin/content")).data.courses.length, n0, "nothing written for bad packages");
  // 审计：导出一条、导入走 course.create
  const audits = (await admin.get("/api/admin/audit?limit=200")).data;
  const rows = Array.isArray(audits) ? audits : audits.rows || audits.items || [];
  assert.ok(rows.some((a) => a.action === "course.export" && a.target === COURSE), "course.export audited");
  assert.ok(rows.some((a) => a.action === "course.create" && a.target === imp.data.id), "import audited as course.create");
});

// ---------- CX-048 ----------
test("CX-048: migration 94 deactivates an existing DEMO-ADMIN (401 disabled, one system audit, idempotent); a fresh database still seeds it for local use", async () => {
  const dir = tempDir();
  const dbPath = path.join(dir, "cx048.db");
  let s = null;
  try {
  // 1）新库：迁移 94 在播种之前执行 → 演示超管仍被播种、可登录（本地开发 / 测试口径不变）
  s = await startServer({ dbPath });
  let c = makeClient(s.base);
  let r = await c.login(DEMO_ADMIN);
  assert.equal(r.status, 200, "fresh db: DEMO-ADMIN seeded and usable");
  await s.stopAsync();
  s = null;
  // 2）模拟已有库（迁移 94 尚未执行、账号启用）：删掉 94 的记录再启动
  let db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM schema_migrations WHERE version = 94").run();
  db.prepare("DELETE FROM audit_logs WHERE action = 'account.deactivate'").run();
  db.close();
  s = await startServer({ dbPath });
  c = makeClient(s.base);
  r = await c.login(DEMO_ADMIN);
  assert.equal(r.status, 401);
  assert.equal(r.data.code, "disabled");
  const adminC = await loginAs(s.base, ADMIN);
  const demo = (await adminC.get("/api/admin/roster")).data.find((u) => u.employeeId === "DEMO-ADMIN");
  assert.ok(demo, "the account still exists (deactivated, not deleted)");
  assert.ok(demo.active === 0 || demo.active === false, "deactivated: " + JSON.stringify(demo.active));
  db = new DatabaseSync(dbPath, { readOnly: true });
  const audits = db.prepare("SELECT afterJson FROM audit_logs WHERE action = 'account.deactivate'").all().map((x) => JSON.parse(x.afterJson));
  db.close();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].migration, 94);
  await s.stopAsync();
  s = null;
  // 3）再启动：幂等（不再写审计、仍停用）
  s = await startServer({ dbPath });
  assert.equal((await makeClient(s.base).login(DEMO_ADMIN)).status, 401);
  db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action = 'account.deactivate'").get().n, 1);
  db.close();
  await s.stopAsync();
  s = null;
  } finally { if (s) await s.stopAsync(); }
});

