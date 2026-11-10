// AI 治理的 HTTP 行为（方案 2.1.3、2.3、2.6、2.7、5.1；5.4 ai-governance-http.test.js）。AI 一律指向本机假服务商。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient, tempDir, completeAllModules } = require("./helpers.js");
const { startFakeAi, reply } = require("./fixtures/fake-ai-server.js");

let fake, srv, admin, emp, cfgFile, dbPath;
const base = () => ({
  modules: { ai: true },
  ai: {
    provider: { id: "fake-gw", protocol: "openai-chat", baseUrl: fake.baseUrl + "/v1", retryBaseMs: 5, headers: { "X-Tenant": "TENANT-SECRET-HDR" }, query: { "api-version": "QUERY-SECRET-VAL" } },
    models: { default: "fake-default", portrait: "fake-portrait" },
  },
});
function writeCfg(mutate) { const c = base(); if (mutate) mutate(c); fs.writeFileSync(cfgFile, JSON.stringify(c)); }
function db(fn) { const d = new DatabaseSync(dbPath); try { return fn(d); } finally { d.close(); } }
const ask = (c, content, courseId = "culture-conduct") => c.post("/api/ai/assistant", { courseId, messages: [{ role: "user", content }] });

before(async () => {
  fake = await startFakeAi();
  const dir = tempDir("ai-gov-");
  cfgFile = path.join(dir, "config.json");
  dbPath = path.join(dir, "test.db");
  writeCfg();
  srv = await startServer({ dbPath, env: { LMS_CONFIG_PATH: cfgFile, LMS_DISABLE_AI: "", LMS_AI_API_KEY: "KEY-SECRET-123" } });
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(async () => { if (srv) await srv.stopAsync(); await fake.close(); });

test("module off (the default): every AI call route answers the same bare 404 as any switched-off module route; the read-only governance routes still answer", async () => {
  const off = await startServer();
  try {
    const a = await loginAs(off.base, ADMIN);
    const e = await loginAs(off.base, EMPLOYEE);
    // 与其它关闭的模块同一个应答（server.js 模块关门：{ error: "Not found" }，不带路径）
    const gated = { error: "Not found" };
    for (const [c, p, b] of [[e, "/api/ai/assistant", { courseId: "culture-conduct", messages: [{ role: "user", content: "x" }] }], [a, "/api/admin/ai/generate", { material: "x".repeat(200) }], [a, "/api/admin/employees/u-1001/ai-portrait", {}], [a, "/api/admin/ai-governance/test", {}]]) {
      const r = await c.post(p, b);
      assert.equal(r.status, 404, p);
      assert.deepEqual(r.data, gated, p + " looks exactly like a switched-off module route");
    }
    assert.equal((await a.get("/api/admin/ai-governance/status")).status, 200);
    assert.equal((await a.get("/api/admin/ai-governance/calls")).status, 200);
    const me = (await e.get("/api/me")).data;
    assert.equal(me.modules.ai, false);
    assert.equal(me.ai.assistant, "off_module");
    assert.equal(me.aiEnabled, false);
  } finally { await off.stopAsync(); }
});

test("/api/me: employees get assistant / grading / demo / notice; admin accounts also questionGen, portrait and history", async () => {
  const me = (await emp.get("/api/me")).data;
  assert.equal(me.ai.assistant, "on");
  assert.equal(me.ai.grading, "on");
  assert.equal(me.ai.demo, false);
  assert.deepEqual(me.ai.notice.assistant, { version: 2, acked: false });
  assert.equal("questionGen" in me.ai, false);
  assert.equal(me.aiEnabled, true);
  const am = (await admin.get("/api/me")).data;
  assert.equal(am.ai.questionGen, "on");
  assert.equal(am.ai.portrait, "off_feature", "portrait is off by default until legal signs off");
  assert.equal(typeof am.ai.history, "boolean");
});

test("notice acknowledgement is recorded server-side; a later version asks again", async () => {
  assert.equal((await emp.post("/api/me/ai-notice-ack", { notice: "assistant", version: 9 })).status, 400);
  assert.equal((await emp.post("/api/me/ai-notice-ack", { notice: "assistant", version: 2 })).status, 200);
  assert.equal((await emp.get("/api/me")).data.ai.notice.assistant.acked, true);
  assert.equal(db((d) => d.prepare("SELECT COUNT(*) AS n FROM ai_notice_acks WHERE notice = 'assistant' AND version = 2").get().n), 1);
});

test("a call is recorded without any raw text: no question, no answer, no key; configHash and model are kept", async () => {
  const MARK = "PRIVATE-QUESTION-MARK-4242";
  fake.enqueue({ json: reply("openai-chat", "ANSWER-MARK-9090 see section 2", { model: "fake-default-v7" }) });
  const r = await ask(emp, MARK + " how do I escalate?");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.reply, /ANSWER-MARK-9090/);
  const rows = db((d) => d.prepare("SELECT * FROM ai_calls WHERE feature = 'assistant' ORDER BY id DESC LIMIT 1").all());
  const dump = JSON.stringify(rows);
  for (const s of [MARK, "ANSWER-MARK-9090", "KEY-SECRET-123"]) assert.ok(!dump.includes(s), s);
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].modelReturned, "fake-default-v7");
  assert.equal(rows[0].actorKind, "employee");
  assert.ok(rows[0].configHash && rows[0].inTokens > 0);
});

test("feature switched off → 403 ai_feature_off; LMS_DISABLE_AI or no provider → 503 and never demo content", async () => {
  writeCfg((c) => { c.ai.features = { assistant: false }; });
  try {
    const r = await ask(emp, "hi");
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "ai_feature_off");
  } finally { writeCfg(); }
  const dir = tempDir("ai-gov-off-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ modules: { ai: true }, ai: { demo: true } }));
  const s2 = await startServer({ env: { LMS_CONFIG_PATH: path.join(dir, "config.json") } }); // helpers keep LMS_DISABLE_AI=1
  try {
    const e2 = await loginAs(s2.base, EMPLOYEE);
    const r = await ask(e2, "hi");
    assert.equal(r.status, 503);
    assert.equal(r.data.code, "ai_not_configured");
    assert.equal(r.data.reason, "disabled");
    assert.equal((await e2.get("/api/me")).data.ai.assistant, "not_configured", "LMS_DISABLE_AI wins over ai.demo");
  } finally { await s2.stopAsync(); }
});

test("demo mode: demo replies are labelled and do not count toward the rate limit", async () => {
  writeCfg((c) => { c.ai.demo = true; c.ai.limits = { assistant: { perUser10Min: 2 } }; });
  try {
    const before = fake.requests.length;
    for (let i = 0; i < 4; i++) {
      const r = await ask(emp, "q" + i);
      assert.equal(r.status, 200);
      assert.equal(r.data.demo, true);
    }
    assert.equal(fake.requests.length, before, "demo calls nothing");
  } finally { writeCfg(); }
});

test("the study assistant refuses during an exam that covers the course (409), and works again once the attempt is abandoned", async () => {
  const { data: created } = await admin.post("/api/admin/employees", { name: "Exam Taker", employeeId: "DP-EXAMAI" });
  const c = await loginAs(srv.base, { employeeId: "DP-EXAMAI", password: created.password });
  await c.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "exam-taker-1" });
  await completeAllModules(c, "nho");
  const st = await c.post("/api/exam/start", { programId: "nho" });
  assert.equal(st.status, 200);
  const course = (await c.get("/api/programs/nho")).data.courses[0].id;
  const r = await ask(c, "what is the answer?", course);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "ai_exam_in_progress");
  db((d) => d.prepare("UPDATE attempts SET startedAt = ?, lastSavedAt = NULL WHERE id = ?").run(new Date(Date.now() - 6 * 3600000).toISOString(), st.data.attemptId));
  fake.enqueue({ json: reply("openai-chat", "ok") });
  assert.equal((await ask(c, "back to studying", course)).status, 200);
});

test("scoped audit reader: sees only in-scope employees' calls, and neither question drafting nor connection tests — list and CSV alike", async () => {
  const d1 = await admin.post("/api/admin/departments", { name: "AIGov In" });
  const d2 = await admin.post("/api/admin/departments", { name: "AIGov Out" });
  const mk = async (id, dept) => {
    const { data: c } = await admin.post("/api/admin/employees", { name: id, employeeId: id });
    const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === id);
    await admin.put("/api/admin/employees/" + u.id, { department: dept });
    const cl = await loginAs(srv.base, { employeeId: id, password: c.password });
    await cl.post("/api/auth/change-password", { currentPassword: c.password, newPassword: id + "-pass-9" });
    return { cl, u };
  };
  const inE = await mk("DP-AIG-IN", "AIGov In");
  const outE = await mk("DP-AIG-OUT", "AIGov Out");
  fake.enqueue({ json: reply("openai-chat", "a") }, { json: reply("openai-chat", "b") });
  assert.equal((await ask(inE.cl, "in question")).status, 200);
  assert.equal((await ask(outE.cl, "out question")).status, 200);
  fake.enqueue({ json: reply("openai-chat", JSON.stringify({ questions: [{ type: "single", question: "Q?", question_zh: "题？", options: [{ text: "a", text_zh: "甲", correct: true }, { text: "b", text_zh: "乙", correct: false }, { text: "c", text_zh: "丙", correct: false }, { text: "d", text_zh: "丁", correct: false }], answers: [], explanation: "", explanation_zh: "", rubric: "", rubric_zh: "", maxPoints: 0, sourceQuote: "s", difficulty: "easy" }] })) });
  assert.equal((await admin.post("/api/admin/ai/generate", { material: "Training material sentence. ".repeat(10), counts: { single: 1 } })).status, 200);
  const role = await admin.post("/api/admin/roles", { name: "Scoped Auditor", name_zh: "范围审计", grants: { audit: "read" }, scope: { departments: [{ id: d1.data.department.id, includeChildren: true }] } });
  const { data: ac } = await admin.post("/api/admin/employees", { name: "Scoped Aud", employeeId: "DP-AIG-AUD" });
  const au = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "DP-AIG-AUD");
  await admin.put("/api/admin/employees/" + au.id, { adminRoleId: role.data.role.id });
  const aud = await loginAs(srv.base, { employeeId: "DP-AIG-AUD", password: ac.password });
  await aud.post("/api/auth/change-password", { currentPassword: ac.password, newPassword: "auditor-pass-9" });
  const list = (await aud.get("/api/admin/ai-governance/calls?pageSize=200")).data.rows;
  const who = list.map((r) => (r.actor && r.actor.employeeId) || null);
  assert.ok(who.includes("DP-AIG-IN"));
  assert.ok(!who.includes("DP-AIG-OUT"));
  assert.ok(!list.some((r) => r.feature === "questionGen" || r.feature === "test"));
  const csv = await aud.raw("GET", "/api/admin/ai-governance/calls.csv");
  const text = await csv.text();
  assert.ok(text.includes("DP-AIG-IN") && !text.includes("DP-AIG-OUT") && !text.includes("questionGen"));
  const full = (await admin.get("/api/admin/ai-governance/calls?pageSize=200")).data.rows;
  assert.ok(full.some((r) => r.feature === "questionGen"), "the super admin sees everything");
  // 连接测试只限超级管理员
  assert.equal((await aud.post("/api/admin/ai-governance/test", {})).status, 403);
});

test("status never shows the key, header values or query values; the connection test tries each distinct model", async () => {
  const st = (await admin.get("/api/admin/ai-governance/status")).data;
  const dump = JSON.stringify(st);
  for (const s of ["KEY-SECRET-123", "TENANT-SECRET-HDR", "QUERY-SECRET-VAL"]) assert.ok(!dump.includes(s), s);
  assert.deepEqual(st.provider.headerNames, ["X-Tenant"]);
  assert.equal(st.provider.keySource, "env:LMS_AI_API_KEY");
  assert.ok(Array.isArray(st.dataflow) && st.dataflow.some((f) => f.typeKey === "violation" && f.key === "description" && f.aiShare === "omit"));
  assert.ok(!st.dataflow.some((f) => f.typeKey === "culture-program"), "3+3 fields are never listed");
  const ok = (m) => ({ json: reply("openai-chat", JSON.stringify({ ok: true, echo: "ping" }), { model: m }) });
  fake.enqueue(ok("fake-default-x"), ok("fake-portrait-x"));
  const t = await admin.post("/api/admin/ai-governance/test", {});
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.deepEqual(t.data.results.map((r) => [r.model, r.ok, r.structuredOutput]), [["fake-default", true, true], ["fake-portrait", true, true]]);
});

test("changing config.json while running writes ai.config.change on the next call — names only, never values", async () => {
  writeCfg((c) => { c.ai.provider.headers = { "X-Tenant": "TENANT-SECRET-HDR", "X-Cost-Center": "CC-SECRET-VAL" }; });
  try {
    fake.enqueue({ json: reply("openai-chat", "ok") });
    await ask(emp, "after change");
    const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
    assert.ok(audit.includes("ai.config.change"));
    assert.ok(audit.includes("X-Cost-Center"));
    assert.ok(!audit.includes("CC-SECRET-VAL") && !audit.includes("KEY-SECRET-123"));
  } finally { writeCfg(); }
});

test("monthly budget: 80% and 100% each alert once per month; at 100% interactive features answer 429", async () => {
  // 上限取「本月已用 × 2 + 1000」：此前各条测试的用量在 50% 以下，下一次调用一次性越过 80% 与 100%
  const used = db((d) => d.prepare("SELECT COALESCE(SUM(inTokens),0)+COALESCE(SUM(outTokens),0) AS n FROM ai_calls").get().n);
  const limit = used * 2 + 1000;
  writeCfg((c) => { c.ai.budget = { monthlyTokens: limit, alertAtPercent: 80 }; });
  try {
    // 把本月用量推到上限：假服务回报的 usage 足够大
    fake.enqueue({ json: reply("openai-chat", "big", { inTokens: limit - used + 100, outTokens: 10 }) });
    // 预算状态有 60 秒缓存：先让缓存过期不现实，所以只断言这次之后的第二次调用被拒
    const r1 = await ask(emp, "use it up");
    assert.equal(r1.status, 200);
    const r2 = await ask(emp, "one more");
    assert.equal(r2.status, 429);
    assert.equal(r2.data.code, "ai_budget_exhausted");
    const alerts = db((d) => d.prepare("SELECT id FROM audit_logs WHERE action = 'ai.budget.alert'").all());
    assert.equal(alerts.length, 2, "one at 80%, one at 100%");
    const r3 = await ask(emp, "still over");
    assert.equal(r3.status, 429);
    assert.equal(db((d) => d.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'ai.budget.alert'").get().n), 2, "no repeat within the month");
  } finally { writeCfg(); }
});

test("retention: assistant / questionGen / test rows older than the retention days are deleted by the daily sweep", async () => {
  db((d) => d.prepare("INSERT INTO ai_calls (createdAt, actorKind, feature, status, attempts) VALUES (?, 'employee', 'assistant', 'ok', 1)").run(new Date(Date.now() - 400 * 86400000).toISOString()));
  await srv.stopAsync();
  db((d) => d.prepare("DELETE FROM meta WHERE key = 'aiMaintenanceDay'").run());
  srv = await startServer({ dbPath, env: { LMS_CONFIG_PATH: cfgFile, LMS_DISABLE_AI: "", LMS_AI_API_KEY: "KEY-SECRET-123" } });
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  const old = db((d) => d.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE createdAt < ?").get(new Date(Date.now() - 300 * 86400000).toISOString()).n);
  assert.equal(old, 0);
  void makeClient;
});
