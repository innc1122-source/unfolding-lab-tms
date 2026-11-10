// 2026-10-09 上线验收 P2 修复的回归：docs/HANDOFF-DEV-UAT-20261009.md 第二节（含复测新增 CX-053）。
//   CX-003 成绩详情带补考状态（retake / examId / learnStatus），结果页按状态给「去补考」与文案；
//   CX-026 退训给学员通知；CX-028 期次成员行带 cohortLog；
//   CX-033 / 034 / 035 外链视频：白名单校验（缺省 + config videoEmbedHosts）、直链识别 videoKind = file、非法地址 400 不再静默丢弃；
//   CX-053 3+3 programs.list 带 nextStartMin（上一期保持度测评后第 8 天）；
//   其余（CX-004/005/006/008/009/010/012/016/017/018/027/029）为前端改动，这里做源码静态核对。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules, tempDir } = require("./helpers.js");
const VURL = require("../modules/learning/video-url.js");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let srv, admin, emp, empId;

before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  empId = (await admin.get("/api/admin/roster")).data.find((u) => u.employeeId === EMPLOYEE.employeeId).id;
});
after(async () => { if (srv) await srv.stopAsync(); });

// ---------- CX-003 ----------
test("CX-003: a submitted attempt carries the retake state so the result page can offer 'Retake exam'", async () => {
  await completeAllModules(emp, "nho");
  const start = await emp.post("/api/exam/start", { examId: "exam-nho" });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const submit = await emp.post(`/api/exam/${start.data.attemptId}/submit`, { answers: {} });
  assert.equal(submit.status, 200);
  assert.equal(submit.data.passed, false, "an empty answer sheet fails");
  const a = (await emp.get(`/api/me/attempts/${start.data.attemptId}`)).data;
  assert.equal(a.examId, "exam-nho");
  assert.ok(a.programId, "programId present for the exam-prep link");
  assert.ok(a.retake && a.retake.examId === "exam-nho", "retake points at the failed exam: " + JSON.stringify(a.retake));
  assert.ok(["ready", "waiting", "usedUp", "pending"].includes(a.retake.state));
  assert.ok(["retake_pending", "failed", "result_pending"].includes(a.learnStatus), a.learnStatus);
  const src = read("web/src/pages/Result.jsx");
  assert.ok(src.includes("s.goRetake") && src.includes("/exam-prep/${data.programId}/${data.retake.examId}"), "result page has the retake button");
  assert.ok(src.includes("failReady") && src.includes("failWaiting") && src.includes("failUsedUp"), "three fail notes by state");
});

// ---------- CX-026 / CX-028 ----------
test("CX-026 / CX-028: withdrawing a learner notifies them and the member row shows the cohort history", async () => {
  const created = await admin.post("/api/admin/tprojects", { title: "UAT withdraw", title_zh: "验收退训" });
  const pid = created.data.id;
  const cohorts = [{ id: "co-w", name: "第一期", startAt: "2026-09-01", endAt: "2026-12-31", capacity: 10, classes: [], phases: [] }];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts, status: "running" })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-w", userIds: [empId] })).status, 200);
  let row = (await admin.get("/api/admin/tprojects/" + pid)).data.members.find((m) => m.userId === empId);
  assert.ok(Array.isArray(row.cohortLog) && row.cohortLog.length === 1 && row.cohortLog[0].cohortId === "co-w" && row.cohortLog[0].enteredAt && !row.cohortLog[0].leftAt, JSON.stringify(row.cohortLog));
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/members/update`, { userId: empId, action: "withdraw" })).status, 200);
  row = (await admin.get("/api/admin/tprojects/" + pid)).data.members.find((m) => m.userId === empId);
  assert.equal(row.state, "withdrawn");
  assert.ok(row.cohortLog[0].leftAt, "the segment is closed on withdrawal: " + JSON.stringify(row.cohortLog));
  const notes = (await emp.get("/api/me/notifications")).data;
  const list = Array.isArray(notes) ? notes : notes.items || notes.rows || [];
  const n = list.find((x) => x.type === "tproject.withdrawn");
  assert.ok(n, "withdrawal notification delivered: " + JSON.stringify(list.map((x) => x.type)));
  assert.match(n.title_zh || "", /退训/);
  assert.match(n.title || "", /withdrawn/i);
  const pj = read("web/src/pages/admin/Projects.jsx");
  assert.ok(pj.includes("r.cohortLog") && pj.includes("s.trajNow"), "member table renders the cohort history");
});

// ---------- CX-033 / 034 / 035 ----------
test("CX-033/034/035: video link classification (unit)", () => {
  const c = VURL.classifyVideoUrl;
  assert.deepEqual(c("https://www.youtube.com/watch?v=dQw4w9WgXcQ").url, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(c("https://youtu.be/dQw4w9WgXcQ").kind, "embed");
  assert.equal(c("https://www.youtube.com/shorts/dQw4w9WgXcQ").kind, "embed");
  assert.equal(c("https://player.vimeo.com/video/12345").kind, "embed");
  assert.equal(c("https://www.bilibili.com/video/BV1xx411c7mD").kind, "embed");
  assert.equal(c("https://www.w3schools.com/html/mov_bbb.mp4").kind, "file");
  assert.equal(c("https://cdn.example.net/live/stream.m3u8?token=1").kind, "file");
  assert.equal(c("https://example.com/some-page").kind, null);
  assert.equal(c("https://example.com/some-page").reason, "host_not_allowed");
  assert.equal(c("javascript:alert(1)").reason, "not_http");
  assert.equal(c("ftp://x/y.mp4").reason, "not_http");
  assert.equal(c("https://video.digiplus.test/p/1", ["video.digiplus.test"]).kind, "embed");
  assert.equal(c("https://sub.video.digiplus.test/p/1", ["https://video.digiplus.test/"]).kind, "embed", "config hosts may carry a scheme / slash");
  assert.equal(c("https://evil.com/?video.digiplus.test", ["video.digiplus.test"]).kind, null);
});

test("CX-033/034/035: saving a course refuses non-allowed or non-http video links (400 bad_video_url, nothing saved), keeps allowed embeds and marks direct files", async () => {
  const content = (await admin.get("/api/admin/content")).data;
  const src = content.courses.find((c) => c.id === "culture-conduct");
  delete src.updatedAt;   // 连续多次 PUT 同一份文档：不带 updatedAt 走旧客户端路径（乐观锁见 qa-uat-p3）
  const withVideo = (url) => ({ ...src, modules: src.modules.map((m, i) => (i ? m : { ...m, sections: m.sections.map((s, j) => (j ? s : { ...s, videoEmbed: url })) })) });
  const before = JSON.stringify(src.modules[0].sections[0]);
  for (const [url, re] of [["https://example.com/some-page", /example\.com/], ["javascript:alert(1)", /http\(s\)/]]) {
    const r = await admin.put("/api/admin/content/courses/culture-conduct", withVideo(url));
    assert.equal(r.status, 400, url);
    assert.equal(r.data.code, "bad_video_url");
    assert.match(r.data.error_zh, /小节/);
    assert.match(r.data.error + r.data.error_zh, re);
  }
  const unchanged = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === "culture-conduct");
  assert.equal(JSON.stringify(unchanged.modules[0].sections[0]), before, "a refused save changes nothing");
  // YouTube 页面 → 统一成 embed 地址；mp4 直链 → videoKind file
  let r = await admin.put("/api/admin/content/courses/culture-conduct", withVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let sec = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === "culture-conduct").modules[0].sections[0];
  assert.equal(sec.videoEmbed, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(sec.videoKind, "embed");
  r = await admin.put("/api/admin/content/courses/culture-conduct", withVideo("https://www.w3schools.com/html/mov_bbb.mp4"));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  sec = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === "culture-conduct").modules[0].sections[0];
  assert.equal(sec.videoKind, "file");
  // 学员端拿到 videoKind，页面按它选播放器
  const learner = (await emp.get("/api/courses/culture-conduct")).data;
  if (learner && learner.modules) assert.equal(learner.modules[0].sections[0].videoKind, "file");
  // 清空
  r = await admin.put("/api/admin/content/courses/culture-conduct", withVideo(""));
  assert.equal(r.status, 200);
  sec = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === "culture-conduct").modules[0].sections[0];
  assert.equal(sec.videoEmbed, null);
  assert.equal(sec.videoKind, null);
  const course = read("web/src/pages/Course.jsx");
  assert.ok(course.includes("sec.videoKind === 'file'") && course.includes("<WatermarkedVideo src={sec.videoEmbed}"), "direct files use the watermarked player");
  const ed = read("web/src/pages/admin/Content.jsx");
  assert.ok(ed.includes("s.badVideoUrl") && ed.includes("err.data.error_zh"), "editor blocks non-http links and shows the server's Chinese message");
});

test("CX-033: config.json videoEmbedHosts extends the allow-list", async () => {
  const dir = tempDir();
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ videoEmbedHosts: ["video.digiplus.test"] }));
  const s = await startServer({ dbPath: path.join(dir, "cfg.db"), env: { LMS_CONFIG_PATH: cfg } });
  try {
    const a = await loginAs(s.base, ADMIN);
    const src = (await a.get("/api/admin/content")).data.courses.find((c) => c.id === "culture-conduct");
    delete src.updatedAt;
    const doc = { ...src, modules: src.modules.map((m, i) => (i ? m : { ...m, sections: m.sections.map((x, j) => (j ? x : { ...x, videoEmbed: "https://video.digiplus.test/play/42" })) })) };
    const r = await a.put("/api/admin/content/courses/culture-conduct", doc);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const sec = (await a.get("/api/admin/content")).data.courses.find((c) => c.id === "culture-conduct").modules[0].sections[0];
    assert.equal(sec.videoKind, "embed");
  } finally { await s.stopAsync(); }
});


// ---------- 前端静态核对（P2 其余条目） ----------
test("P2 front-end changes are in place (static)", () => {
  const pd = read("web/src/pages/ProgramDetail.jsx");
  assert.ok(pd.includes("Number(ex.itemCount)"), "CX-009: exam question count uses itemCount");
  assert.ok(pd.includes("s.retraining") && pd.includes("exams.some((e) => !e.unlocked)"), "CX-010: header shows re-study instead of passed after a reset");
  const rs = read("web/src/pages/admin/Results.jsx");
  assert.ok(rs.includes("const flatDetail = detail.flatMap"), "CX-005: admin counts by sub-question");
  assert.ok(rs.includes("s.scoreConv("), "CX-004: admin card shows the converted score");
  assert.ok(read("web/src/qtypes/Open.jsx").includes("s.scoreConv("), "CX-004: learner open-question row shows the converted score");
  const fill = read("web/src/qtypes/FillEditor.jsx");   // 简化 10/11：编辑器从 Fill.jsx 拆到 FillEditor.jsx
  assert.ok(fill.includes("setSelectionRange(after[focusLg]") && fill.includes("boxes.current[lg] = el"), "CX-006: caret returns after the inserted blank");
  const ex = read("web/src/pages/admin/Exams.jsx");
  assert.ok(ex.includes("s.reqTitleAny") && !ex.includes("rules={[{ required: true, message: s.reqTitleZh }]}"), "CX-008: Chinese-or-English title");
  assert.ok(ex.includes("Toast.error(s.fixErrors)") && ex.includes("semi-form-field-error-message"), "CX-008: global error toast + scroll");
  assert.ok(ex.includes("影响范围") && ex.includes("Scope:"), "CX-010: auto-retrain hint names the scope");
  const pj = read("web/src/pages/admin/Projects.jsx");
  assert.ok(pj.includes("s.addSkippedOther") && pj.includes("inThis.has(r.id)"), "CX-027: this cohort vs other cohorts");
  assert.ok(read("web/src/pages/admin/TalentFilter.jsx").includes("s.sharedReadOnly("), "CX-016: shared filter read-only banner");
  assert.ok(read("web/src/pages/admin/TalentReview.jsx").includes("withPositions=1&vacancies=1") && read("web/src/pages/admin/TalentReview.jsx").includes("s.succVacancy("), "CX-018: vacancies on the succession tab");
  const css = read("web/src/v2.css") + "\n" + read("web/src/admin.css");   // 简化 10/11：后台专用规则拆到 admin.css
  for (const k of ["CX-012", "CX-017", "CX-029"]) assert.ok(css.includes("/* " + k), k + " styles appended");
  assert.ok(css.includes(".v2-page-projects .ptabs{overflow-x:auto") && css.includes(".trev-drill-modal .semi-table-tbody>tr{display:block"), "CX-029 / CX-017 rules");
  assert.ok(read("kernel/module-host.js").includes("position: u.position || null"), "CX-051 follow-up: identity rows carry the position");
  // CX-007：案例材料与作答部件是同级元素，key 必须不同（重复 key 让 React 漏删旧节点 → 材料堆叠）
  const runner = read("web/src/pages/ExamRunner.jsx");
  assert.ok(runner.includes("<CasePassage key={'case:' + slot.key}") && runner.includes("<Runner key={slot.key}"), "CX-007: CasePassage and Runner no longer share a key");
});
