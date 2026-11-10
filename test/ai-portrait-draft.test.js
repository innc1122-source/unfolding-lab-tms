// AI 人才画像：最小化输入、草稿 → 确认 / 丢弃、权限与判定顺序（AI 治理方案 2.2.3 D、2.5、4.4；5.4 ai-portrait-draft.test.js）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");
const { startFakeAi, reply } = require("./fixtures/fake-ai-server.js");

let fake, srv, admin, cfgFile, dbPath;
const ids = {};
const MARKS = {
  violation: "VIOLATION-DESC-MARK-111", summary: "SELF-FEEDBACK-MARK-222", review: "PROBATION-REVIEW-MARK-333", note: "HR-NOTE-MARK-444",
  exit: "EXIT-REASON-MARK-555", culture: "CULTURE-PROGRAM-MARK-666", tag: "HIPO-TAG-MARK-777", email: "portrait.person@example.com",
};
function writeCfg(mods = { ai: true }) {
  fs.writeFileSync(cfgFile, JSON.stringify({ modules: mods, ai: { provider: { id: "fake", protocol: "openai-chat", baseUrl: fake.baseUrl + "/v1", retryBaseMs: 5 }, models: { default: "fake-m", portrait: "fake-portrait" }, features: { portrait: true } } }));
}
async function boot() {
  srv = await startServer({ dbPath, env: { LMS_CONFIG_PATH: cfgFile, LMS_DISABLE_AI: "", LMS_AI_API_KEY: "k" } });
  admin = await loginAs(srv.base, ADMIN);
}
function db(fn) { const d = new DatabaseSync(dbPath); try { return fn(d); } finally { d.close(); } }
async function makeEmployee(empId, extra) {
  const r = await admin.post("/api/admin/employees", { name: empId + " Person", employeeId: empId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId).id;
  if (extra) { const p = await admin.put("/api/admin/employees/" + id, extra); assert.equal(p.status, 200, JSON.stringify(p.data)); }
  return id;
}
async function adminUser(empId, grants, scope) {
  const role = await admin.post("/api/admin/roles", { name: empId + " role", name_zh: empId, grants, ...(scope ? { scope } : {}) });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const { data: c } = await admin.post("/api/admin/employees", { name: empId, employeeId: empId });
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === empId);
  await admin.put("/api/admin/employees/" + u.id, { adminRoleId: role.data.role.id });
  const cl = await loginAs(srv.base, { employeeId: empId, password: c.password });
  await cl.post("/api/auth/change-password", { currentPassword: c.password, newPassword: "portrait-pass-1" });
  return cl;
}
const portraitJson = (extra = {}) => JSON.stringify({
  summary: { text: "[员工] performs steadily in [部门A] under [上级].", text_zh: "[员工]在[部门A]表现稳定。", evidence: ["E1", "E2"] },
  strengths: [{ text: "Consistent ratings", text_zh: "评级稳定", evidence: ["E2"] }],
  risks: [{ text: "Unsupported claim", text_zh: "无依据的判断", evidence: ["E99"] }],
  development: [{ text: "Cross-team project", text_zh: "跨团队项目", evidence: ["E1"] }],
  readiness: { level: "one_year", text: "Ready in about a year", text_zh: "约一年后可晋升", evidence: ["E2"] },
  evidenceLevel: "sufficient", ...extra,
});

before(async () => {
  fake = await startFakeAi();
  const dir = tempDir("ai-portrait-");
  cfgFile = path.join(dir, "config.json");
  dbPath = path.join(dir, "test.db");
  writeCfg();
  await boot();
  const d = await admin.post("/api/admin/departments", { name: "Portrait Dept Q" });
  assert.equal(d.status, 200);
  ids.deptQ = d.data.department.id;
  await admin.post("/api/admin/departments", { name: "Portrait Other Q" });
  ids.mgr = await makeEmployee("PQ-MGR", { department: "Portrait Dept Q" });
  db((x) => x.prepare("UPDATE users SET name = 'Manager Mara Q' WHERE id = ?").run(ids.mgr));
  ids.emp = await makeEmployee("PQ-EMP", { department: "Portrait Dept Q", managerId: ids.mgr, jobLevel: "PB2", position: "Support Lead", hireDate: "2023-01-10" });
  ids.out = await makeEmployee("PQ-OUT", { department: "Portrait Other Q" });
  const rec = async (type, date, fields) => { const r = await admin.post(`/api/admin/employees/${ids.emp}/records`, { type, date, fields }); assert.equal(r.status, 200, type + " " + JSON.stringify(r.data)); };
  await rec("performance", "2025-01-15", { period: "2024-H2", rating: "A", summary: MARKS.summary });
  await rec("violation", "2025-03-01", { severity: "Minor", description: MARKS.violation, action: "Verbal" });
  await rec("regularization", "2023-07-10", { result: "On time", review: MARKS.review });
  await rec("note", "2025-04-01", { text: MARKS.note });
  await rec("exit", "2025-05-01", { exitType: "Voluntary", reason: MARKS.exit });
  db((x) => {
    x.prepare("UPDATE users SET potential = 'High', talentTags = ?, email = ? WHERE id = ?").run(JSON.stringify([MARKS.tag]), MARKS.email, ids.emp);
    x.prepare("INSERT INTO talent_records (id, userId, type, date, title, detail, programId, createdBy, createdAt) VALUES ('tr-cult', ?, 'culture-program', '2025-02-01', ?, ?, NULL, 'u-admin', ?)")
      .run(ids.emp, MARKS.culture, JSON.stringify({ programName: MARKS.culture }), new Date().toISOString());
    // 即使有人把行为实践字段强行改成 send，也不外发（硬编码排除）
    x.prepare("UPDATE record_fields SET aiShare = 'send' WHERE typeKey = 'culture-program'").run();
  });
});
after(async () => { if (srv) await srv.stopAsync(); await fake.close(); });

test("the request carries no name, ID, email, potential, tags, free-text comments, culture / note / exit content; departments and the manager go out as placeholders and come back restored", async () => {
  fake.enqueue({ json: reply("openai-chat", portraitJson()) });
  const r = await admin.post(`/api/admin/employees/${ids.emp}/ai-portrait`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const body = fake.requests[fake.requests.length - 1].body;
  for (const s of [...Object.values(MARKS), "PQ-EMP", "PQ-EMP Person", "Manager Mara Q", "Portrait Dept Q", "tab-switch", "High"]) assert.ok(!body.includes(s), "request must not contain " + s);
  assert.match(body, /Tenure: \d+ months/);
  assert.match(body, /\[部门A\]/);
  const draft = r.data.draft;
  assert.equal(draft.status, "draft");
  assert.equal(draft.unsupportedCount, 1);
  assert.equal(draft.content.risks[0].unsupported, true);
  assert.match(draft.content.summary.text, /Portrait Dept Q/, "department placeholder restored for HR");
  assert.match(draft.content.summary.text, /Manager Mara Q/);
  assert.match(draft.content.summary.text, /^the employee/);
  assert.equal(draft.provenance.model, "fake-portrait");
  assert.ok(draft.content.summary.evidence.every((e) => /^E\d+$/.test(e.ref) && /^\d{4}-\d{2}$/.test(e.date)));
  ids.draft1 = draft.id;
});

test("confirm: blocked while an unsupported judgement remains; deleting it confirms, supersedes nothing, audits the edited fields", async () => {
  const bad = await admin.post(`/api/admin/talent-portraits/${ids.draft1}/confirm`, {});
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "portrait_unsupported");
  const g = (await admin.get(`/api/admin/talent-portraits?userId=${ids.emp}`)).data;
  const content = g.drafts[0].content;
  const ok = await admin.post(`/api/admin/talent-portraits/${ids.draft1}/confirm`, { content: { ...content, risks: [] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.portrait.status, "confirmed");
  const g2 = (await admin.get(`/api/admin/talent-portraits?userId=${ids.emp}`)).data;
  assert.equal(g2.current.id, ids.draft1);
  assert.equal(g2.drafts.length, 0);
  const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
  assert.ok(audit.includes("talent.portrait.confirm") && audit.includes("risks"));
});

test("discard empties the text and keeps only provenance; a second confirmed version supersedes the first", async () => {
  fake.enqueue({ json: reply("openai-chat", portraitJson()) });
  const d2 = (await admin.post(`/api/admin/employees/${ids.emp}/ai-portrait`)).data.draft;
  const dis = await admin.post(`/api/admin/talent-portraits/${d2.id}/discard`, { reason: "not useful" });
  assert.equal(dis.status, 200);
  assert.equal(dis.data.portrait.content, null);
  assert.equal(dis.data.portrait.discardReason, "not useful");
  assert.equal((await admin.post(`/api/admin/talent-portraits/${d2.id}/confirm`, {})).status, 409, "already handled");
  fake.enqueue({ json: reply("openai-chat", portraitJson({ risks: [] })) });
  const d3 = (await admin.post(`/api/admin/employees/${ids.emp}/ai-portrait`)).data.draft;
  assert.equal((await admin.post(`/api/admin/talent-portraits/${d3.id}/confirm`, {})).status, 200);
  const g = (await admin.get(`/api/admin/talent-portraits?userId=${ids.emp}`)).data;
  assert.equal(g.current.id, d3.id);
  assert.ok(g.history.some((h) => h.id === ids.draft1 && h.status === "superseded" && h.content), "superseded keeps its text");
  assert.ok(g.history.some((h) => h.id === d2.id && h.status === "discarded" && h.content === null));
});

test("objection is recorded on a confirmed portrait; the audit entry carries no objection text", async () => {
  const g = (await admin.get(`/api/admin/talent-portraits?userId=${ids.emp}`)).data;
  const r = await admin.post(`/api/admin/talent-portraits/${g.current.id}/objection`, { summary: "OBJECTION-TEXT-MARK disputes the readiness line", outcome: "Reviewed with the employee; kept." });
  assert.equal(r.status, 200);
  assert.equal(r.data.portrait.objections.length, 1);
  const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
  assert.ok(audit.includes("talent.portrait.objection"));
  assert.ok(!audit.includes("OBJECTION-TEXT-MARK"));
});

test("permissions: talent access alone is enough (no separate people read, owner 2026-09-30); self → 403 ai_self_subject; out of scope and missing ids answer the same 404 before any status check", async () => {
  const talentOnly = await adminUser("PQ-A-TALENT", { talent: "manage" });
  const miss = await talentOnly.post("/api/admin/employees/no-such-user/ai-portrait");
  assert.equal(miss.status, 404);
  assert.notEqual((await talentOnly.get(`/api/admin/talent-portraits?userId=${ids.emp}`)).data.code, "people_read_required");
  const self = await admin.post("/api/admin/employees/u-admin/ai-portrait");
  assert.equal(self.status, 403);
  assert.equal(self.data.code, "ai_self_subject");
  const scoped = await adminUser("PQ-A-SCOPED", { talent: "manage", people: "read" }, { departments: [{ id: ids.deptQ, includeChildren: true }] });
  // 范围外员工的画像（先由超管生成一份草稿）与不存在的 id：confirm / discard / objection 都是同一个裸 404
  fake.enqueue({ json: reply("openai-chat", portraitJson({ risks: [] })) });
  const outDraft = (await admin.post(`/api/admin/employees/${ids.out}/ai-portrait`)).data.draft;
  for (const act of ["confirm", "discard", "objection"]) {
    const a = await scoped.post(`/api/admin/talent-portraits/${outDraft.id}/${act}`, { summary: "x y" });
    const b = await scoped.post(`/api/admin/talent-portraits/pt-nope/${act}`, { summary: "x y" });
    assert.equal(a.status, 404, act);
    assert.deepEqual(a.data, b.data, act);
  }
  assert.equal((await scoped.post(`/api/admin/employees/${ids.out}/ai-portrait`)).status, 404);
});

test("an output that fails the schema gets one repair call — the repair request still holds placeholders, never the restored manager or department", async () => {
  const broken = JSON.parse(portraitJson());
  delete broken.readiness;
  fake.enqueue({ json: reply("openai-chat", JSON.stringify(broken)) }, { json: reply("openai-chat", portraitJson({ risks: [] })) });
  const before = fake.requests.length;
  const r = await admin.post(`/api/admin/employees/${ids.emp}/ai-portrait`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fake.requests.length - before, 2);
  const repairBody = fake.requests[fake.requests.length - 1].body;
  assert.ok(!repairBody.includes("Manager Mara Q") && !repairBody.includes("Portrait Dept Q"));
  assert.match(repairBody, /\[部门A\]/);
});

test("ai module off: confirmed portraits stay readable, drafts disappear, generate / confirm answer 404", async () => {
  writeCfg({ ai: false });
  try {
    const g = await admin.get(`/api/admin/talent-portraits?userId=${ids.emp}`);
    assert.equal(g.status, 200);
    assert.ok(g.data.current && g.data.current.content);
    assert.deepEqual(g.data.drafts, []);
    assert.equal((await admin.post(`/api/admin/employees/${ids.emp}/ai-portrait`)).status, 404);
    const anyDraft = db((x) => x.prepare("SELECT id FROM talent_portraits WHERE status = 'draft' LIMIT 1").get());
    if (anyDraft) assert.equal((await admin.post(`/api/admin/talent-portraits/${anyDraft.id}/confirm`, {})).status, 404);
  } finally { writeCfg(); }
});

test("daily maintenance: a draft untouched for 30 days expires (text cleared, audited)", async () => {
  fake.enqueue({ json: reply("openai-chat", portraitJson({ risks: [] })) });
  const d = (await admin.post(`/api/admin/employees/${ids.emp}/ai-portrait`)).data.draft;
  await srv.stopAsync();
  db((x) => {
    x.prepare("UPDATE talent_portraits SET generatedAt = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86400000).toISOString(), d.id);
    x.prepare("DELETE FROM meta WHERE key = 'aiMaintenanceDay'").run();
  });
  await boot();
  const row = db((x) => x.prepare("SELECT status, content, discardReason FROM talent_portraits WHERE id = ?").get(d.id));
  assert.deepEqual({ ...row }, { status: "discarded", content: null, discardReason: "expired" });
});
