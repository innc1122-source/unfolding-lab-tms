// AI 服务商层（modules/ai/provider.js、schema.js）—— 方案 5.4 ai-provider.test.js。
// 全部对本机假服务商（test/fixtures/fake-ai-server.js），不连任何真实服务。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const P = require("../modules/ai/provider.js");
const S = require("../modules/ai/schema.js");
const { startFakeAi, startFakeProxy, reply, TLS_DIR } = require("./fixtures/fake-ai-server.js");

const ENV = { LMS_TEST_AI_LOCAL_ONLY: "1", LMS_AI_API_KEY: "sk-test-SECRET-123" };
const cfgFor = (fake, protocol, extra = {}) => ({
  ai: {
    provider: { id: "fake", protocol, baseUrl: fake.baseUrl + (protocol === "openai-chat" ? "/v1" : ""), retryBaseMs: 10, ...extra.provider },
    models: { default: "model-a", portrait: "model-b", ...(extra.models || {}) },
  },
});
const SCHEMA = { type: "object", additionalProperties: false, required: ["score", "note"], properties: { score: { type: "integer" }, note: { type: ["string", "null"] } } };

test("provider: anthropic-messages request shape — /v1/messages, x-api-key + anthropic-version, structured output and adaptive thinking, no sampling params", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "anthropic-messages"), ENV);
    assert.equal(r.ok, true, JSON.stringify(r));
    fake.enqueue({ json: reply("anthropic-messages", '{"score":3,"note":null}', { model: "claude-sonnet-5-20260201", inTokens: 900, outTokens: 70 }) });
    const out = await P.callModel(r, { feature: "grading", system: "SYS", messages: [{ role: "user", content: "hi" }], schema: SCHEMA, effort: "medium" });
    assert.deepEqual(out.json, { score: 3, note: null });
    assert.equal(out.modelReturned, "claude-sonnet-5-20260201");
    assert.deepEqual(out.usage, { in: 900, out: 70, estimated: false });
    const q = fake.requests[0];
    assert.equal(q.path, "/v1/messages");
    assert.equal(q.headers["x-api-key"], "sk-test-SECRET-123");
    assert.equal(q.headers["anthropic-version"], "2023-06-01");
    assert.equal(q.headers.authorization, undefined);
    assert.equal(q.json.model, "model-a");
    assert.equal(q.json.system, "SYS");
    assert.deepEqual(q.json.thinking, { type: "adaptive" });
    assert.equal(q.json.output_config.format.type, "json_schema");
    assert.equal(q.json.output_config.effort, "medium");
    assert.equal(q.json.output_config.format.schema.additionalProperties, false);
    for (const k of ["temperature", "top_p", "top_k", "metadata"]) assert.equal(k in q.json, false, k + " must not be sent");
    assert.equal(q.json.max_tokens, 16000);
  } finally { await fake.close(); }
});

test("provider: openai-chat request shape — baseUrl carries /v1, Bearer auth, system message first, json_schema strict, max_tokens field switch, custom headers and query", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "openai-chat", { provider: { headers: { "X-Client-App": "tms" }, query: { "api-version": "2026-01-01" }, maxTokensField: "max_completion_tokens" } }), ENV);
    fake.enqueue({ json: reply("openai-chat", '{"score":1,"note":"x"}') });
    const out = await P.callModel(r, { feature: "questionGen", system: "SYS", messages: [{ role: "user", content: "hi" }], schema: SCHEMA });
    assert.equal(out.json.score, 1);
    const q = fake.requests[0];
    assert.equal(q.path, "/v1/chat/completions");
    assert.equal(q.query["api-version"], "2026-01-01");
    assert.equal(q.headers.authorization, "Bearer sk-test-SECRET-123");
    assert.equal(q.headers["x-client-app"], "tms");
    assert.equal(q.json.messages[0].role, "system");
    assert.equal(q.json.response_format.type, "json_schema");
    assert.equal(q.json.response_format.json_schema.strict, true);
    assert.equal(q.json.max_completion_tokens, 16000);
    assert.equal("max_tokens" in q.json, false);
    assert.equal("user" in q.json, false, "no user attribution unless configured");
    assert.equal("temperature" in q.json, false);
  } finally { await fake.close(); }
});

test("provider: gemini puts the key in x-goog-api-key (never in the URL) and converts the schema (no additionalProperties, nullable)", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "gemini"), ENV);
    fake.enqueue({ json: reply("gemini", '{"score":2,"note":null}', { model: "gemini-2.9-flash-001" }) });
    const out = await P.callModel(r, { feature: "assistant", system: "SYS", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "a" }, { role: "user", content: "b" }], schema: SCHEMA });
    assert.equal(out.modelReturned, "gemini-2.9-flash-001");
    assert.deepEqual(out.usage, { in: 120, out: 35, estimated: false }, "candidates + thoughts tokens");
    const q = fake.requests[0];
    assert.equal(q.path, "/v1beta/models/model-a:generateContent");
    assert.deepEqual(q.query, {}, "no ?key= in the URL");
    assert.equal(q.headers["x-goog-api-key"], "sk-test-SECRET-123");
    assert.equal(q.json.contents[1].role, "model");
    const rs = q.json.generationConfig.responseSchema;
    assert.equal("additionalProperties" in rs, false);
    assert.deepEqual(rs.properties.note, { type: "string", nullable: true });
    assert.equal(out.text.includes("…"), false, "thought parts are not part of the answer");
  } finally { await fake.close(); }
});

test("provider: provider.path overrides the joined path; describe() shows host + path but never key, header values or query values", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "openai-chat", { provider: { path: "/ai/llm/chat", headers: { "X-Tenant": "tenant-SECRET" }, query: { token: "q-SECRET" } } }), ENV);
    fake.enqueue({ json: reply("openai-chat", "hello") });
    await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] });
    assert.equal(fake.requests[0].path, "/v1/ai/llm/chat");
    const d = P.describe(r);
    assert.equal(d.url, fake.baseUrl + "/v1/ai/llm/chat");
    const s = JSON.stringify(d);
    for (const secret of ["sk-test-SECRET-123", "tenant-SECRET", "q-SECRET"]) assert.equal(s.includes(secret), false, secret);
    assert.deepEqual(d.headerNames, ["X-Tenant"]);
    assert.deepEqual(d.queryNames, ["token"]);
    assert.ok(d.warnings.includes("query_param_looks_secret:token"));
    assert.equal(d.keySource, "env:LMS_AI_API_KEY");
  } finally { await fake.close(); }
});

test("provider: retries 529/429 honouring Retry-After, then succeeds; 400/401/404 are not retried and map to their codes", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "anthropic-messages"), ENV);
    fake.enqueue({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "busy" } }, headers: { "retry-after": "0" } },
      { status: 429, json: { error: { type: "rate_limit_error" } } },
      { json: reply("anthropic-messages", "done") });
    const calls = [];
    const out = await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }, { onCall: (c) => calls.push(c) });
    assert.equal(out.text, "done");
    assert.equal(out.attempts, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].attempts, 3);
    for (const [status, code] of [[400, "ai_bad_request"], [401, "ai_auth_failed"], [403, "ai_auth_failed"], [404, "ai_model_not_found"], [422, "ai_bad_request"]]) {
      const before = fake.requests.length;
      fake.enqueue({ status, json: { error: { type: "x" } } }, { json: reply("anthropic-messages", "should not be reached") });
      await assert.rejects(P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }), (e) => e.code === code && e.attempts === 1);
      assert.equal(fake.requests.length - before, 1, status + " is not retried");
      fake.requests.length; // queue still holds the unreached reply
      await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] });
    }
  } finally { await fake.close(); }
});

test("provider: per-feature timeouts — the assistant retries after a client timeout, question drafting and the portrait do not (upstream still bills an aborted generation)", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "openai-chat", { provider: { timeoutMs: 300, maxRetries: 2 } }), ENV);
    fake.enqueue({ hang: true }, { json: reply("openai-chat", "second try") });
    const out = await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] });
    assert.equal(out.text, "second try");
    for (const feature of ["questionGen", "portrait"]) {
      const before = fake.requests.length;
      fake.enqueue({ hang: true }, { json: reply("openai-chat", "never") });
      await assert.rejects(P.callModel(r, { feature, system: "S", messages: [{ role: "user", content: "x" }] }), (e) => e.code === "ai_timeout" && e.attempts === 1);
      assert.equal(fake.requests.length - before, 1, feature + " is not retried after a timeout");
      await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "drain" }] });
    }
  } finally { await fake.close(); }
});

test("provider: a non-JSON body (gateway HTML page) → ai_upstream_error non_json; truncation and refusal map per protocol", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "anthropic-messages"), ENV);
    fake.enqueue({ status: 200, text: "<html>proxy login</html>", contentType: "text/html" });
    await assert.rejects(P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }), (e) => e.code === "ai_upstream_error" && e.reason === "non_json");
    const cases = [
      ["anthropic-messages", { stop: "max_tokens" }, "ai_output_truncated"],
      ["anthropic-messages", { stop: "refusal" }, "ai_refused"],
      ["openai-chat", { stop: "length" }, "ai_output_truncated"],
      ["openai-chat", { stop: "content_filter" }, "ai_refused"],
      ["openai-chat", { refusal: "no" }, "ai_refused"],
      ["gemini", { stop: "MAX_TOKENS" }, "ai_output_truncated"],
      ["gemini", { stop: "SAFETY" }, "ai_refused"],
      ["gemini", { blockReason: "OTHER" }, "ai_refused"],
    ];
    for (const [protocol, extra, code] of cases) {
      const rr = P.resolveProviderConfig(cfgFor(fake, protocol), ENV);
      fake.enqueue({ json: reply(protocol, "partial", extra) });
      await assert.rejects(P.callModel(rr, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }), (e) => e.code === code, protocol + " " + JSON.stringify(extra));
    }
  } finally { await fake.close(); }
});

test("provider: output that fails the schema gets ONE repair call carrying the raw output; still invalid → ai_output_invalid; both calls are recorded", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "anthropic-messages"), ENV);
    fake.enqueue({ json: reply("anthropic-messages", '{"score":"high","note":null} [员工]') }, { json: reply("anthropic-messages", '```json\n{"score":4,"note":"ok"}\n```') });
    const calls = [];
    const out = await P.callModel(r, { feature: "grading", system: "S", messages: [{ role: "user", content: "x" }], schema: SCHEMA }, { onCall: (c) => calls.push(c) });
    assert.deepEqual(out.json, { score: 4, note: "ok" });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => [c.status, c.repair]), [["error", false], ["ok", true]]);
    const repairMsgs = fake.requests[1].json.messages;
    assert.match(repairMsgs[repairMsgs.length - 2].content, /\[员工\]/, "the repair call sends the raw (placeholder) output back");
    // semantic check failure also triggers the repair path
    fake.enqueue({ json: reply("anthropic-messages", '{"score":99,"note":null}') }, { json: reply("anthropic-messages", '{"score":98,"note":null}') });
    await assert.rejects(P.callModel(r, { feature: "grading", system: "S", messages: [{ role: "user", content: "x" }], schema: SCHEMA, semantic: (j) => (j.score > 10 ? "score out of range" : null) }), (e) => e.code === "ai_output_invalid");
  } finally { await fake.close(); }
});

test("provider: a 307 to another port is NOT followed — the other port receives nothing", async () => {
  const fake = await startFakeAi();
  const other = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "openai-chat"), ENV);
    fake.enqueue({ status: 307, text: "", headers: { location: other.baseUrl + "/v1/chat/completions" } });
    await assert.rejects(P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }),
      (e) => e.code === "ai_upstream_error" && e.reason === "redirect" && e.redirectHost === new URL(other.baseUrl).host);
    assert.equal(other.requests.length, 0);
  } finally { await fake.close(); await other.close(); }
});

test("provider: a 400 that echoes the request (LiteLLM / Azure style) leaves no input text or key in the log lines or call records", async () => {
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "openai-chat"), ENV);
    fake.enqueue({ status: 400, echo: true });
    const lines = [], calls = [];
    const MARK = "PRIVATE-ANSWER-TEXT-7731";
    await assert.rejects(P.callModel(r, { feature: "grading", system: "S", messages: [{ role: "user", content: MARK }] }, { requestId: "r-1", log: (l) => lines.push(l), onCall: (c) => calls.push(c) }), (e) => e.code === "ai_bad_request");
    const dump = JSON.stringify(lines) + JSON.stringify(calls);
    assert.equal(dump.includes(MARK), false);
    assert.equal(dump.includes("sk-test-SECRET-123"), false);
    assert.equal(lines[0].upstreamType, "invalid_request_error");
    // debugLogUntil on: the upstream message is logged — redacted and capped at 200 chars
    fake.enqueue({ status: 400, echo: true });
    const dl = [];
    await assert.rejects(P.callModel(r, { feature: "grading", system: "S", messages: [{ role: "user", content: MARK }] }, { log: (l) => dl.push(l), debugUntil: Date.now() + 60000, debugRedact: (t) => t.replace(/PRIVATE-[A-Z-]+\d+/g, "[x]") }));
    assert.ok(dl[0].debug && dl[0].debug.length <= 200 && !dl[0].debug.includes(MARK));
  } finally { await fake.close(); }
});

test("provider: no identity in protocol fields — attribution only when given (a 16-hex pseudonym), as user / metadata.user_id", async () => {
  const fake = await startFakeAi();
  try {
    for (const protocol of ["openai-chat", "anthropic-messages"]) {
      const r = P.resolveProviderConfig(cfgFor(fake, protocol), ENV);
      fake.enqueue({ json: reply(protocol, "a") }, { json: reply(protocol, "b") });
      await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] });
      await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }], attribution: "0123456789abcdef" });
      const [a, b] = fake.requests.slice(-2).map((q) => q.json);
      if (protocol === "openai-chat") { assert.equal("user" in a, false); assert.equal(b.user, "0123456789abcdef"); }
      else { assert.equal("metadata" in a, false); assert.deepEqual(b.metadata, { user_id: "0123456789abcdef" }); }
    }
  } finally { await fake.close(); }
});

test("provider: certificate checks — an untrusted self-signed gateway fails with a TLS error (no custom CA, no opt-out)", async () => {
  const fake = await startFakeAi({ https: true });
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "anthropic-messages"), ENV);
    await assert.rejects(P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }), (e) => e.code === "ai_upstream_error" && e.reason === "tls");
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

// NODE_EXTRA_CA_CERTS is read once at process start, so the "trusted CA" cases run in a child process.
function runChild(script, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("exit", () => resolve({ out: out.trim(), err }));
  });
}
test("provider: with the CA trusted (NODE_EXTRA_CA_CERTS) the gateway works directly and through a CONNECT proxy; a certificate for another host name still fails", async () => {
  const good = await startFakeAi({ https: true });
  const wrong = await startFakeAi({ https: true, cert: "wrong" });
  const proxy = await startFakeProxy();
  try {
    const script = `
      const P = require(${JSON.stringify(path.join(__dirname, "..", "modules", "ai", "provider.js"))});
      const cfg = JSON.parse(process.env.T_CFG);
      const r = P.resolveProviderConfig(cfg, process.env);
      P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] })
        .then((o) => console.log(JSON.stringify({ ok: true, text: o.text })), (e) => console.log(JSON.stringify({ ok: false, code: e.code, reason: e.reason })));`;
    const base = { LMS_TEST_AI_LOCAL_ONLY: "1", LMS_AI_API_KEY: "k", NODE_EXTRA_CA_CERTS: path.join(TLS_DIR, "ca.pem") };
    const direct = await runChild(script, { ...base, T_CFG: JSON.stringify(cfgFor(good, "anthropic-messages")) });
    assert.deepEqual(JSON.parse(direct.out), { ok: true, text: "ok" }, direct.err);
    const viaProxy = await runChild(script, { ...base, T_CFG: JSON.stringify(cfgFor(good, "anthropic-messages", { provider: { proxy: proxy.url } })) });
    assert.deepEqual(JSON.parse(viaProxy.out), { ok: true, text: "ok" }, viaProxy.err);
    assert.equal(proxy.connects.length, 1);
    assert.equal(proxy.connects[0].target, "localhost:" + good.port);
    const mismatch = await runChild(script, { ...base, T_CFG: JSON.stringify(cfgFor(wrong, "anthropic-messages")) });
    assert.deepEqual(JSON.parse(mismatch.out), { ok: false, code: "ai_upstream_error", reason: "tls" }, mismatch.err);
    assert.equal(wrong.requests.length, 0);
  } finally { await good.close(); await wrong.close(); await proxy.close(); }
});

test("provider: proxy refusing CONNECT fails at once; a proxy that drops the tunnel ends within the time limit without a reconnect storm", async () => {
  const fake = await startFakeAi();
  const refuse = await startFakeProxy({ mode: "refuse" });
  const drop = await startFakeProxy({ mode: "drop" });
  try {
    const r1 = P.resolveProviderConfig(cfgFor(fake, "openai-chat", { provider: { proxy: refuse.url } }), ENV);
    await assert.rejects(P.callModel(r1, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }), (e) => e.reason === "proxy_refused");
    assert.equal(refuse.connects.length, 1);
    const r2 = P.resolveProviderConfig(cfgFor(fake, "openai-chat", { provider: { proxy: drop.url, timeoutMs: 2000, maxRetries: 2 } }), ENV);
    const t0 = Date.now();
    await assert.rejects(P.callModel(r2, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] }), (e) => e.code === "ai_upstream_error" || e.code === "ai_timeout");
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(drop.connects.length <= 3, "bounded by maxRetries: " + drop.connects.length);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); await refuse.close(); await drop.close(); }
});

test("provider: configuration guards — TLS verification disabled, local-only safety net, http only on loopback, missing key/model, legacy fields", () => {
  const withProvider = (p) => ({ ai: { provider: { id: "x", protocol: "openai-chat", baseUrl: "https://ai.internal.example/v1", ...p }, models: { default: "m" } } });
  assert.equal(P.resolveProviderConfig(withProvider({}), { LMS_AI_API_KEY: "k", NODE_TLS_REJECT_UNAUTHORIZED: "0" }).reason, "tls_verification_disabled");
  assert.equal(P.resolveProviderConfig(withProvider({}), { LMS_AI_API_KEY: "k", LMS_TEST_AI_LOCAL_ONLY: "1" }).reason, "local_only");
  assert.equal(P.resolveProviderConfig(withProvider({ baseUrl: "http://ai.internal.example/v1" }), { LMS_AI_API_KEY: "k" }).reason, "insecure_base_url");
  assert.equal(P.resolveProviderConfig(withProvider({ proxy: "http://127.0.0.1:1" }), { LMS_AI_API_KEY: "k", LMS_TEST_AI_LOCAL_ONLY: "1" }).reason, "local_only");
  assert.equal(P.resolveProviderConfig(withProvider({}), {}).reason, "no_key");
  assert.equal(P.resolveProviderConfig(withProvider({ auth: "none" }), {}).ok, true, "auth none needs no key");
  assert.equal(P.resolveProviderConfig({ ai: { provider: { protocol: "openai-chat", baseUrl: "https://x.example/v1" } } }, { LMS_AI_API_KEY: "k" }).reason, "no_model");
  assert.equal(P.resolveProviderConfig({}, {}).reason, "no_provider");
  // apiKeyEnv non-empty wins; empty env falls back to provider.apiKey
  const both = withProvider({ apiKey: "from-file" });
  assert.equal(P.resolveProviderConfig(both, { LMS_AI_API_KEY: "from-env" }).provider.key, "from-env");
  assert.equal(P.resolveProviderConfig(both, { LMS_AI_API_KEY: "" }).provider.key, "from-file");
  // legacy: anthropicApiKey → implicit Anthropic config with claude-sonnet-5 (the old claude-opus-4-8 default is gone)
  const leg = P.resolveProviderConfig({ anthropicApiKey: "sk-ant-x" }, {});
  assert.equal(leg.ok, true);
  assert.equal(leg.legacy, true);
  assert.equal(leg.provider.protocol, "anthropic-messages");
  assert.equal(leg.provider.baseUrl, "https://api.anthropic.com");
  assert.equal(leg.models.assistant, "claude-sonnet-5");
  assert.equal(P.resolveProviderConfig({ anthropicApiKey: "sk-ant-x", aiModel: "claude-opus-5-5" }, {}).models.portrait, "claude-opus-5-5");
  const gem = P.resolveProviderConfig({ geminiApiKey: "AIza" }, {});
  assert.equal(gem.provider.protocol, "gemini");
  assert.equal(gem.models.default, "gemini-flash-latest");
  // ai.provider present → legacy fields ignored, with a warning
  const mixed = P.resolveProviderConfig({ anthropicApiKey: "sk-ant-x", ...withProvider({}) }, { LMS_AI_API_KEY: "k" });
  assert.equal(mixed.provider.protocol, "openai-chat");
  assert.ok(mixed.warnings.includes("legacy_fields_ignored"));
});

test("provider: token estimate — CJK one per character, other text four characters per token; missing usage is estimated and flagged", async () => {
  assert.equal(P.estimateTokens("你好世界"), 4);
  assert.equal(P.estimateTokens("abcdefgh"), 2);
  const fake = await startFakeAi();
  try {
    const r = P.resolveProviderConfig(cfgFor(fake, "openai-chat"), ENV);
    fake.enqueue({ json: reply("openai-chat", "你好", { noUsage: true }) });
    const out = await P.callModel(r, { feature: "assistant", system: "S", messages: [{ role: "user", content: "x" }] });
    assert.equal(out.usage.estimated, true);
    assert.equal(out.usage.out, 2);
  } finally { await fake.close(); }
});

test("schema: the shared subset — lint catches non-subset keywords and optional properties; validate and fenced-JSON parsing", () => {
  assert.deepEqual(S.lintSchema(SCHEMA), []);
  assert.ok(S.lintSchema({ type: "object", properties: { a: { type: "string", minLength: 1 } }, required: [] }).length >= 2);
  assert.equal(S.validate(SCHEMA, { score: 1, note: null }), null);
  assert.match(S.validate(SCHEMA, { score: 1.5, note: null }), /score/);
  assert.match(S.validate(SCHEMA, { score: 1 }), /note: missing/);
  assert.match(S.validate(SCHEMA, { score: 1, note: "a", extra: 1 }), /unexpected/);
  assert.deepEqual(S.parseJsonText("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.equal(S.parseJsonText("not json"), undefined);
});

test("scripts/ai-check.js: tests each distinct model once (structured output included), exits 0, never prints the key or header values", async () => {
  const fake = await startFakeAi();
  const fsx = require("fs");
  const os = require("os");
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), "ai-check-"));
  try {
    const cfgFile = path.join(dir, "config.json");
    fsx.writeFileSync(cfgFile, JSON.stringify({ modules: { ai: true }, ai: { provider: { id: "gw", protocol: "openai-chat", baseUrl: fake.baseUrl + "/v1", headers: { "X-Tenant": "HDR-SECRET-9" } }, models: { default: "m-a", portrait: "m-b", grading: "m-a" } } }));
    const ok = (m) => ({ json: reply("openai-chat", JSON.stringify({ ok: true, echo: "ping" }), { model: m }) });
    fake.enqueue(ok("m-a-1"), ok("m-b-1"));
    const run = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "ai-check.js"), "--config", cfgFile], { env: { ...process.env, LMS_TEST_AI_LOCAL_ONLY: "1", LMS_AI_API_KEY: "KEY-SECRET-5" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { out += d; });
      c.on("exit", (code) => resolve({ code, out }));
    });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /all 2 model\(s\) OK/);
    assert.match(run.out, /structured output: yes/);
    assert.ok(!run.out.includes("KEY-SECRET-5") && !run.out.includes("HDR-SECRET-9"));
    assert.equal(fake.requests.length, 2);
  } finally { await fake.close(); fsx.rmSync(dir, { recursive: true, force: true }); }
});
