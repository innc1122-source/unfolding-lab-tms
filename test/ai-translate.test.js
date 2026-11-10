// AI 翻译（2026-10-06）：培训内容中英互译，走 AI 治理框架（功能 translate，归属 learning）。AI 一律指向本机假服务商。
//   · 模块关闭时与其它 AI 路由同样裸 404；功能单独关闭时 403 ai_feature_off；
//   · 只返回草稿，不写库；HTML 项的标签必须原样保留（不符时补救一次）；人名脱敏后发送、部门与上级名还原；
//   · 每次调用记一行 ai_calls（feature = translate）；演示模式不调用服务商。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs, tempDir } = require("./helpers.js");
const { startFakeAi, reply } = require("./fixtures/fake-ai-server.js");

let fake, srv, admin, emp, cfgFile, dbPath;
const base = () => ({
  modules: { ai: true },
  ai: { provider: { id: "fake-gw", protocol: "openai-chat", baseUrl: fake.baseUrl + "/v1", retryBaseMs: 5 }, models: { default: "fake-default" } },
});
function writeCfg(mutate) { const c = base(); if (mutate) mutate(c); fs.writeFileSync(cfgFile, JSON.stringify(c)); }
function db(fn) { const d = new DatabaseSync(dbPath); try { return fn(d); } finally { d.close(); } }

before(async () => {
  fake = await startFakeAi();
  const dir = tempDir("ai-tr-");
  cfgFile = path.join(dir, "config.json");
  dbPath = path.join(dir, "test.db");
  writeCfg();
  srv = await startServer({ dbPath, env: { LMS_CONFIG_PATH: cfgFile, LMS_DISABLE_AI: "", LMS_AI_API_KEY: "KEY-SECRET-123" } });
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(async () => { if (srv) await srv.stopAsync(); await fake.close(); });

test("translate: admins see ai.translate; employees do not; module-off answers the bare 404", async () => {
  assert.equal((await admin.get("/api/me")).data.ai.translate, "on");
  assert.equal("translate" in (await emp.get("/api/me")).data.ai, false);
  const off = await startServer();
  try {
    const a = await loginAs(off.base, ADMIN);
    const r = await a.post("/api/admin/ai/translate", { to: "en", items: [{ key: "t", text: "你好" }] });
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: "Not found" });
  } finally { await off.stopAsync(); }
});

test("translate: validates the request before calling the provider", async () => {
  const n = fake.requests.length;
  assert.equal((await admin.post("/api/admin/ai/translate", { to: "fr", items: [{ key: "a", text: "x" }] })).data.code, "bad_target");
  assert.equal((await admin.post("/api/admin/ai/translate", { to: "en", items: [{ key: "a", text: "  " }] })).data.code, "nothing_to_translate");
  const many = Array.from({ length: 81 }, (_, i) => ({ key: "k" + i, text: "文" }));
  assert.equal((await admin.post("/api/admin/ai/translate", { to: "en", items: many })).data.code, "too_many_items");
  assert.equal((await admin.post("/api/admin/ai/translate", { to: "en", items: [{ key: "a", text: "x".repeat(60001) }] })).status, 413);
  assert.equal((await emp.post("/api/admin/ai/translate", { to: "en", items: [{ key: "a", text: "x" }] })).status, 403, "admin route");
  assert.equal(fake.requests.length, n, "no provider call for invalid requests");
});

test("translate: returns drafts in order, keeps HTML tags (one repair call when they change), records an ai_calls row", async () => {
  // 第一次回复把 <b> 弄丢了 → 本地语义校验不过 → 补救一次
  const bad = { items: [{ key: "title", text: "Code of conduct" }, { key: "body", text: "<p>Do not bet on our own products.</p>" }] };
  const good = { items: [{ key: "title", text: "Code of conduct" }, { key: "body", text: "<p>Do <b>not</b> bet on our own products.</p>" }] };
  fake.enqueue({ json: reply("openai-chat", JSON.stringify(bad)) }, { json: reply("openai-chat", JSON.stringify(good)) });
  const before = fake.requests.length;
  const r = await admin.post("/api/admin/ai/translate", {
    to: "en", refId: "culture-conduct",
    items: [{ key: "title", text: "行为准则" }, { key: "body", text: "<p>员工<b>不得</b>在自家产品下注。</p>", format: "html" }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.items, good.items);
  assert.equal(fake.requests.length - before, 2, "one repair call after the tag check failed");
  // 发给服务商的是翻译系统提示词 + 数据区块
  const sent = fake.requests[fake.requests.length - 1].json;
  assert.match(JSON.stringify(sent.messages), /CONTENT_TO_TRANSLATE/);
  assert.match(JSON.stringify(sent.messages), /keep every HTML tag/i);
  const rows = db((d) => d.prepare("SELECT feature, status, refId FROM ai_calls WHERE feature = 'translate'").all());
  assert.ok(rows.some((x) => x.status === "ok" && x.refId === "culture-conduct"));
  // 不写库：课程内容没有变
  const c = (await admin.get("/api/admin/content")).data.courses.find((x) => x.id === "culture-conduct");
  assert.notEqual(c.title, "Code of conduct");
});

test("translate: switched off per feature → 403; demo mode → marked placeholders, no provider call", async () => {
  writeCfg((c) => { c.ai.features = { translate: false }; });
  const off = await admin.post("/api/admin/ai/translate", { to: "en", items: [{ key: "a", text: "你好" }] });
  assert.equal(off.status, 403);
  assert.equal(off.data.code, "ai_feature_off");
  writeCfg((c) => { c.ai.demo = true; });
  const n = fake.requests.length;
  const r = await admin.post("/api/admin/ai/translate", { to: "zh", items: [{ key: "a", text: "Hello" }, { key: "b", text: "<p>Body</p>", format: "html" }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.demo, true);
  assert.equal(r.data.items[0].text, "【演示译文】Hello");
  assert.match(r.data.items[1].text, /^<p><em>【演示译文】<\/em><\/p><p>Body<\/p>$/);
  assert.equal(fake.requests.length, n);
  writeCfg();
});
