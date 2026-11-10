// 2026-10-05 用户反馈修复：培养项目出勤率、简答题「重新 AI 初评」、AI 出题读取课程附件文字。
// AI 指向本机假服务商（test/fixtures/fake-ai-server.js），不连任何真实服务。
// Office 课件转换走测试替身 test/fixtures/fake-soffice.js（P0 1.3：转不了就拒绝上传，所以 Word / PPT 样例必须先转成 PDF）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, FAKE_SOFFICE, startServer, loginAs, completeAllModules, tempDir } = require("./helpers.js");
const { startFakeAi, reply } = require("./fixtures/fake-ai-server.js");

let fake, srv, admin, dbPath, attachDir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  fake = await startFakeAi();
  const dir = tempDir("feedback-1005-");
  const cfgFile = path.join(dir, "config.json");
  dbPath = path.join(dir, "test.db");
  attachDir = path.join(dir, "attachments");
  fs.writeFileSync(cfgFile, JSON.stringify({
    modules: { ai: true },
    ai: { provider: { id: "fake", protocol: "openai-chat", baseUrl: fake.baseUrl + "/v1", retryBaseMs: 5, maxRetries: 1 }, models: { default: "fake-grader" } },
  }));
  srv = await startServer({ dbPath, env: { LMS_CONFIG_PATH: cfgFile, LMS_DISABLE_AI: "", LMS_AI_API_KEY: "test-key", LMS_ATTACH_DIR: attachDir, LMS_DISABLE_OFFICE_CONVERT: "0", LMS_SOFFICE: FAKE_SOFFICE } });
  admin = await loginAs(srv.base, ADMIN);
});
after(async () => { if (srv) await srv.stopAsync(); await fake.close(); });

let seq = 0;
async function newEmployee(tag) {
  const id = "DP-FB" + (++seq) + tag;
  const { data: created } = await admin.post("/api/admin/employees", { name: "Feedback Test " + id, employeeId: id });
  const c = await loginAs(srv.base, { employeeId: id, password: created.password });
  await c.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "feedback-pass-1" });
  return { c, id, userId: created.id || (await admin.get("/api/admin/employees")).data.find((u) => u.employeeId === id).id };
}

test("project dashboard attendance counts learners who never checked in; excused learners leave the denominator; future sessions don't count", async () => {
  const created = await admin.post("/api/admin/tprojects", { title: "Attendance Probe", title_zh: "出勤率探针" });
  const pid = created.data.id;
  const cohorts = [{
    id: "co-att", name: "Cohort", startAt: "2026-01-01", endAt: "2026-12-31", capacity: 10, classes: [],
    phases: [{ id: "ph-1", name: "Phase 1", activities: [
      { id: "act-past", type: "offline", title: "Kickoff", startAt: "2026-01-02T09:00" },
      { id: "act-future", type: "offline", title: "Later", startAt: "2099-01-02T09:00" },
    ] }],
  }];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts })).status, 200);
  const people = [];
  for (let i = 0; i < 4; i++) people.push(await newEmployee("ATT"));
  const added = await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-att", userIds: people.map((p) => p.userId) });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  // 1 人签到、1 人请假、2 人没来。旧算法只数有记录的行：签到 1 / (签到 1 + 请假 1) = 50%，没来的人不进分母。
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/checkin/act-past/mark`, { userId: people[0].userId, status: "attended" })).status, 200);
  assert.equal((await admin.post(`/api/admin/tprojects/${pid}/checkin/act-past/mark`, { userId: people[1].userId, status: "excused" })).status, 200);
  const d = (await admin.get(`/api/admin/tprojects/${pid}/dashboard?cohort=co-att`)).data;
  assert.equal(d.members, 4);
  assert.equal(d.attendance, 33, "1 present / (4 learners − 1 excused) on the one session that has started");
});

test("dashboard attendance is null before any session has started", async () => {
  const created = await admin.post("/api/admin/tprojects", { title: "Attendance Future", title_zh: "未开始" });
  const pid = created.data.id;
  const cohorts = [{ id: "co-f", name: "Cohort", startAt: "2099-01-01", endAt: "2099-12-31", capacity: 10, classes: [],
    phases: [{ id: "ph-1", name: "P", activities: [{ id: "act-f1", type: "offline", title: "Later", startAt: "2099-01-02T09:00" }] }] }];
  assert.equal((await admin.put("/api/admin/tprojects/" + pid, { cohorts })).status, 200);
  const p = await newEmployee("ATF");
  await admin.post(`/api/admin/tprojects/${pid}/members`, { cohortId: "co-f", userIds: [p.userId] });
  const d = (await admin.get(`/api/admin/tprojects/${pid}/dashboard?cohort=co-f`)).data;
  assert.equal(d.attendance, null);
});

// ---------- 重新 AI 初评 ----------
const grade = (score) => ({ json: reply("openai-chat", JSON.stringify({ criteria: [{ point: "listens", level: "full", evidence: "I listen" }], score, feedback: "[学员] covered the key steps.", confidence: "high", flags: [] }), { model: "fake-grader-2026" }) });
function answersFor(questions, k, answer) {
  const out = {};
  let n = 0;
  for (const q of questions) {
    if (q.type === "open") { out[q.id] = answer; continue; }
    const right = n++ < k;
    if (q.type === "mcq") { const i = q.options.findIndex((o) => o.ok); out[q.id] = right ? i : (i + 1) % q.options.length; }
    else if (q.type === "multi") out[q.id] = right ? q.options.map((o, i) => (o.ok ? i : -1)).filter((i) => i >= 0) : [q.options.findIndex((o) => !o.ok)];
    else if (q.type === "fill") out[q.id] = right ? q.answers[0] : "zzz-wrong";
  }
  return out;
}
async function waitSettled(c, attemptId, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const r = await c.get(`/api/me/attempts/${attemptId}`);
    if (r.data.gradingStatus !== "grading") return r.data;
    if (Date.now() - t0 > ms) throw new Error("still grading after " + ms + "ms");
    await sleep(100);
  }
}
const ANSWER = "I would listen to the player, apologise, check the account history and escalate to my supervisor within 24 hours.";

test("retry AI pre-score: an answer the AI missed at submit (upstream error) is scored on retry; it settles like a normal AI pass and is audited", async () => {
  const e = await newEmployee("AIR");
  await completeAllModules(e.c, "nho");
  const st = await e.c.post("/api/exam/start", { programId: "nho" });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let questions;
  try { questions = JSON.parse(db.prepare("SELECT questions FROM attempts WHERE id = ?").get(st.data.attemptId).questions); } finally { db.close(); }
  fake.enqueue({ status: 500, echo: true }, { status: 500, echo: true });
  // 7/8 客观题答对：简答题分数决定是否通过 → AI 失败后进入「待复核」
  await e.c.post(`/api/exam/${st.data.attemptId}/submit`, { answers: answersFor(questions, 7, ANSWER) });
  const first = await waitSettled(e.c, st.data.attemptId);
  assert.equal(first.gradingStatus, "pending_review");

  fake.enqueue(grade(4));
  const r = await admin.post(`/api/admin/attempts/${st.data.attemptId}/ai-retry`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.questions, 1);
  const again = await admin.post(`/api/admin/attempts/${st.data.attemptId}/ai-retry`, {});
  assert.ok([400, 409].includes(again.status), "a second retry while grading / after scoring is refused");
  const done = await waitSettled(e.c, st.data.attemptId);
  // 决定性的题：AI 分只作建议分，仍由 HR 确认（与交卷时 AI 正常评分的规则一致）
  assert.equal(done.gradingStatus, "pending_review");
  const row = (await admin.get("/api/admin/attempts")).data.find((x) => x.id === st.data.attemptId);
  const open = row.detail.find((d) => d.type === "open");
  assert.equal(open.ai.suggestedScore, 4);
  assert.ok(!open.ai.errorCode, "the earlier error is replaced by the AI result");
  const third = await admin.post(`/api/admin/attempts/${st.data.attemptId}/ai-retry`, {});
  assert.equal(third.status, 400, "nothing left to retry once the AI has scored it");
  assert.equal(third.data.code, "nothing_to_retry");
  const audit = (await admin.get("/api/admin/audit")).data;
  assert.ok(JSON.stringify(audit).includes("attempt.ai.retry"));
});

test("retry AI pre-score is refused for a final attempt and for an unknown one", async () => {
  assert.equal((await admin.post("/api/admin/attempts/at-nope/ai-retry", {})).status, 404);
  const e = await newEmployee("AIF");
  await completeAllModules(e.c, "nho");
  const st = await e.c.post("/api/exam/start", { programId: "nho" });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let questions;
  try { questions = JSON.parse(db.prepare("SELECT questions FROM attempts WHERE id = ?").get(st.data.attemptId).questions); } finally { db.close(); }
  fake.enqueue(grade(8));
  await e.c.post(`/api/exam/${st.data.attemptId}/submit`, { answers: answersFor(questions, 8, ANSWER) });
  await waitSettled(e.c, st.data.attemptId);
  const r = await admin.post(`/api/admin/attempts/${st.data.attemptId}/ai-retry`, {});
  assert.equal(r.status, 400);
});

// ---------- AI 出题读取课程附件 ----------
test("AI question generation from a course reads its PDF / Word / PPT attachments when the sections have no text", async () => {
  const cid = "fb-attach";
  const body = (atts) => ({
    id: cid, title: "Attachment-only course", title_zh: "只有附件的课程", status: "published", mode: "online",
    modules: [{ id: cid + "-m1", title: "Module 1", minutes: 10, sections: [{ id: "s1", heading: "1.1", html: "", attachments: atts }] }],
  });
  assert.equal((await admin.put("/api/admin/content/courses/" + cid, body([]))).status, 200);
  // 没有正文、也没有附件：提示改用粘贴材料，并带 source: "course"
  const empty = await admin.post("/api/admin/ai/generate", { source: "course", courseId: cid, counts: { single: 2 } });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.code, "material_too_short");
  assert.equal(empty.data.source, "course");

  const samples = path.join(__dirname, "..", "scripts", "samples");
  const ids = [];
  for (const f of ["sample-policy.pdf", "sample-handbook.docx", "sample-slides.pptx"]) {
    const up = await admin.upload(`/api/admin/attachments?name=${f}&courseId=${cid}`, fs.readFileSync(path.join(samples, f)));
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.kind, "pdf", f + " is stored as a view-only PDF");
    ids.push({ id: up.data.id });
  }
  assert.equal((await admin.put("/api/admin/content/courses/" + cid, body(ids))).status, 200);
  const before = fake.requests.length;
  await admin.post("/api/admin/ai/generate", { source: "course", courseId: cid, counts: { single: 2 } });
  assert.ok(fake.requests.length > before, "the material was long enough to reach the AI");
  const sent = JSON.stringify(fake.requests[before].json);
  assert.match(sent, /Five-Minute Learning Loop/, "PDF text is in the material");
  assert.match(sent, /Complete assigned training before the due date/, "Word text is in the material");
  assert.match(sent, /Know your customer/, "PPT text is in the material");
  // 解析结果缓存在附件旁边，第二次不再起子进程
  assert.ok(fs.readdirSync(attachDir).some((f) => f.endsWith(".pdf.txt")));
});
