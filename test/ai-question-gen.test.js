// AI 出题（方案 4.2；5.4 ai-question-gen.test.js）与字段外发范围（2.2.1 第 5 条；5.4 ai-datashare.test.js）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");
const { startFakeAi, reply } = require("./fixtures/fake-ai-server.js");

let fake, srv, admin;
before(async () => {
  fake = await startFakeAi();
  const dir = tempDir("ai-qgen-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ modules: { ai: true }, ai: { provider: { id: "fake", protocol: "openai-chat", baseUrl: fake.baseUrl + "/v1", retryBaseMs: 5 }, models: { default: "fake-q" } } }));
  srv = await startServer({ env: { LMS_CONFIG_PATH: path.join(dir, "config.json"), LMS_DISABLE_AI: "", LMS_AI_API_KEY: "k" } });
  admin = await loginAs(srv.base, ADMIN);
});
after(async () => { await srv.stopAsync(); await fake.close(); });

const MATERIAL = "Escalate every payment dispute to the finance desk within one business day. ".repeat(4) + "Contact Maria Lopez at maria.lopez@corp.example or 0917 555 1234 for urgent cases.";
const q = (type, extra = {}) => ({
  type, question: `Q ${type}?`, question_zh: `题 ${type}？`, options: [], answers: [], explanation: "e", explanation_zh: "解", rubric: "", rubric_zh: "", maxPoints: 0, sourceQuote: "Escalate every payment dispute", difficulty: "easy", ...extra,
});
const opts = (n, correct) => Array.from({ length: n }, (_, i) => ({ text: "o" + i, text_zh: "项" + i, correct: correct.includes(i) }));
const good = () => [
  q("single", { options: opts(4, [0]) }),
  q("multi", { options: opts(4, [0, 2]) }),
  q("truefalse", { options: [{ text: "True", text_zh: "正确", correct: true }, { text: "False", text_zh: "错误", correct: false }] }),
  q("fill", { question: "Escalate within ____ business day.", answers: ["one"] }),
  q("open", { rubric: "Mentions escalation and timing", rubric_zh: "提到上报与时限", maxPoints: 10 }),
];

test("five question types are counted and validated locally; a wrong count triggers one repair call", async () => {
  const wrong = good().slice(0, 4); // 少一道简答题
  fake.enqueue({ json: reply("openai-chat", JSON.stringify({ questions: wrong })) }, { json: reply("openai-chat", JSON.stringify({ questions: good() })) });
  const before = fake.requests.length;
  const r = await admin.post("/api/admin/ai/generate", { source: "paste", material: MATERIAL, counts: { single: 1, multi: 1, truefalse: 1, fill: 1, open: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fake.requests.length - before, 2);
  assert.deepEqual(r.data.questions.map((x) => x.type), ["single", "multi", "truefalse", "fill", "open"]);
  assert.ok(r.data.callId);
  assert.ok(r.data.questions.every((x) => x.sourceQuote && x.difficulty));
  const sent = fake.requests[before].body;
  assert.ok(!sent.includes("maria.lopez@corp.example") && !sent.includes("0917 555 1234"), "material is de-identified");
  assert.match(sent, /Create exactly these questions: 1 single, 1 multi, 1 truefalse, 1 fill, 1 open/);
});

test("only open questions asked → no stray single-choice question; legacy mcqCount / openCount still accepted", async () => {
  fake.enqueue({ json: reply("openai-chat", JSON.stringify({ questions: [good()[4]] })) });
  const r = await admin.post("/api/admin/ai/generate", { material: MATERIAL, counts: { open: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.questions.map((x) => x.type), ["open"]);
  fake.enqueue({ json: reply("openai-chat", JSON.stringify({ questions: [good()[0], good()[4]] })) });
  const legacy = await admin.post("/api/admin/ai/generate", { material: MATERIAL, mcqCount: 1, openCount: 1 });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
});

test("generate from course content: the server reads the course text itself", async () => {
  const courses = (await admin.get("/api/admin/content")).data;
  const course = (Array.isArray(courses) ? courses : courses.courses || []).find((c) => c.id === "culture-conduct") || { id: "culture-conduct" };
  fake.enqueue({ json: reply("openai-chat", JSON.stringify({ questions: [good()[0]] })) });
  const r = await admin.post("/api/admin/ai/generate", { source: "course", courseId: course.id, counts: { single: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(fake.requests[fake.requests.length - 1].body, /## Module: /);
  assert.equal((await admin.post("/api/admin/ai/generate", { source: "course", courseId: "no-such-course", counts: { single: 1 } })).data.code, "unknown_course");
});

test("adopting an AI draft records its origin (checked callId) and audits question.ai.adopt; another account's callId is refused", async () => {
  fake.enqueue({ json: reply("openai-chat", JSON.stringify({ questions: [good()[0]] }), { model: "fake-q-2026" }) });
  const g = await admin.post("/api/admin/ai/generate", { material: MATERIAL, counts: { single: 1 } });
  const d = g.data.questions[0];
  const body = { courseId: "culture-conduct", type: "mcq", question: d.question, question_zh: d.question_zh, options: d.options.map((o) => ({ text: o.text, text_zh: o.text_zh, ok: o.correct })), aiCallId: g.data.callId };
  const add = await admin.post("/api/admin/questions", body);
  assert.equal(add.status, 200, JSON.stringify(add.data));
  const saved = (await admin.get("/api/admin/questions")).data.find((x) => x.id === add.data.id);
  assert.equal(saved.origin.kind, "ai");
  assert.equal(saved.origin.callId, g.data.callId);
  assert.equal(saved.origin.modelReturned, "fake-q-2026");
  const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
  assert.ok(audit.includes("question.ai.adopt"));
  assert.equal((await admin.post("/api/admin/questions", { ...body, aiCallId: 999999 })).data.code, "bad_ai_call");
  // 与题库重复的题标出 similarTo
  fake.enqueue({ json: reply("openai-chat", JSON.stringify({ questions: [{ ...good()[0], question: d.question }] })) });
  const again = await admin.post("/api/admin/ai/generate", { material: MATERIAL, counts: { single: 1 } });
  assert.equal(again.data.questions[0].similarTo, add.data.id);
});

test("aiShare: new fields default to omit; only a super admin widens; tightening is open to fields managers; every change is audited; 3+3 fields never carry it", async () => {
  const types = (await admin.get("/api/admin/config/records")).data;
  const viol = types.fields.find((f) => f.typeKey === "violation" && f.key === "description");
  assert.equal(viol.aiShare, "omit");
  assert.equal(types.fields.find((f) => f.typeKey === "violation" && f.key === "severity").aiShare, "send");
  assert.equal(types.fields.find((f) => f.typeKey === "transfer" && f.key === "toDept").aiShare, "mask");
  assert.ok(types.fields.filter((f) => f.typeKey === "culture-program").every((f) => !("aiShare" in f)));
  const created = await admin.post("/api/admin/config/record-fields", { typeKey: "violation", label: "Witness", input: "text" });
  assert.equal(created.data.field.aiShare, "omit");
  // fields=manage 的非超管
  const role = await admin.post("/api/admin/roles", { name: "Fields Mgr", name_zh: "字段管理", grants: { fields: "manage" } });
  const { data: c } = await admin.post("/api/admin/employees", { name: "Fields Mgr", employeeId: "DP-FLD" });
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "DP-FLD");
  await admin.put("/api/admin/employees/" + u.id, { adminRoleId: role.data.role.id });
  const fm = await loginAs(srv.base, { employeeId: "DP-FLD", password: c.password });
  await fm.post("/api/auth/change-password", { currentPassword: c.password, newPassword: "fields-pass-1" });
  const widen = await fm.put(`/api/admin/config/record-fields/${viol.id}`, { aiShare: "mask" });
  assert.equal(widen.status, 403);
  assert.equal(widen.data.code, "ai_share_super_admin");
  const sev = types.fields.find((f) => f.typeKey === "violation" && f.key === "severity");
  const tighten = await fm.put(`/api/admin/config/record-fields/${sev.id}`, { aiShare: "omit" });
  assert.equal(tighten.status, 200);
  assert.equal(tighten.data.field.aiShare, "omit");
  const su = await admin.put(`/api/admin/config/record-fields/${viol.id}`, { aiShare: "mask" });
  assert.equal(su.status, 200);
  assert.equal(su.data.field.aiShare, "mask");
  const cult = types.fields.find((f) => f.typeKey === "culture-program");
  assert.equal((await admin.put(`/api/admin/config/record-fields/${cult.id}`, { aiShare: "send" })).data.code, "ai_share_not_applicable");
  const audit = (await admin.get("/api/admin/audit")).data;
  const rows = (audit.rows || audit.items || audit).filter((x) => x.action === "ai.datashare.change");
  assert.ok(rows.length >= 2);
  // 治理页的数据流向：与上线基线不同的字段被标出
  const flow = (await admin.get("/api/admin/ai-governance/status")).data.dataflow;
  assert.equal(flow.find((f) => f.id === viol.id).differs, true);
  assert.equal(flow.find((f) => f.id === sev.id).differs, true);
});
