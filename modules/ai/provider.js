// AI 服务商层（方案第 3 节）：配置解析、三种协议的请求与响应适配、超时与重试、代理与客户端证书、错误码。
//
// 设计要点（逐条对应方案，改动前先读 NEXT-WORK/specs/03-ai-governance-spec.md 第 3 节）：
//   · 一套 HTTP 栈：直连与走代理都用 node:https（测试对回环地址用 node:http），不用全局 fetch。
//     node:https 默认不跟随重定向 —— 收到 30x 一律报 ai_upstream_error（原因 redirect），
//     认证头不会被带到另一台主机，也不会被降级到 http:// 明文发出（P-7.8）。
//   · 响应体上限 4 MB；先读文本再按 JSON 解析，网关的 HTML 错误页报 ai_upstream_error（P-7.3）。
//   · 超时按功能：单次超时取「功能单次超时」与 provider.timeoutMs 的较小值；出题与画像这两项长生成
//     在客户端超时后不重试（被中止的生成在上游照样计费），直接报 ai_timeout（3.3）。
//   · 只重试临时性错误：网络错误与 408/409/429/500/502/503/504/529；退避 1 秒 × 2ⁿ ±20%，遵守
//     Retry-After（最长 20 秒，且不超过总时限）。400/401/403/404/413/422 与 30x 不重试。
//   · 日志只记元数据（requestId、功能、HTTP 状态、content-type、上游错误类型或错误码、耗时），不记上游
//     message 和响应体；ai.debugLogUntil 生效期间例外（先脱敏、截断到 200 字）（2.3.3）。
//   · 前端与数据库只看到错误码，看不到上游原文（P-7.6、P-7.10）。
//   · 证书校验恒开（rejectUnauthorized: true，不传自定义 ca）。检测到 NODE_TLS_REJECT_UNAUTHORIZED=0
//     时拒绝一切调用（not_configured，原因 tls_verification_disabled）。
//   · 测试安全网：LMS_TEST_AI_LOCAL_ONLY=1 时只允许回环地址（目标与代理都算），从机制上保证测试连不到真实服务。
//   · 结构化输出：先结构校验（公共子集）、再语义校验，失败时发一次「按 schema 修正」的补救调用；
//     补救调用也经 onCall 记一次调用记录。占位符还原不在这一层做（在功能层、校验全部通过之后）。
"use strict";
const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const { toProtocol, validate, parseJsonText } = require("./schema.js");

const PROTOCOLS = ["anthropic-messages", "openai-chat", "gemini"];
const DEFAULT_BASE = { "anthropic-messages": "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com" };
const DEFAULT_AUTH = { "anthropic-messages": "x-api-key", "openai-chat": "bearer", gemini: "x-goog-api-key" };
const AUTH_MODES = new Set(["bearer", "x-api-key", "api-key", "x-goog-api-key", "none"]);
const DEFAULT_MODEL = { "anthropic-messages": "claude-sonnet-5", gemini: "gemini-flash-latest" };
const STRUCTURED = new Set(["json_schema", "json_object", "none"]);
const FEATURES = ["assistant", "questionGen", "grading", "portrait", "translate", "talentFilter", "test"];
// 方案 3.3 的超时表。total = 含排队与重试的总时限；retryOnTimeout = 客户端超时后是否重试。
const FEATURE_TIMEOUTS = {
  assistant: { attempt: 40000, total: 45000, retryOnTimeout: true },
  grading: { attempt: 25000, total: 60000, retryOnTimeout: true, maxRetries: 1 },
  questionGen: { attempt: 110000, total: 120000, retryOnTimeout: false },
  portrait: { attempt: 140000, total: 150000, retryOnTimeout: false },
  translate: { attempt: 110000, total: 120000, retryOnTimeout: false },
  talentFilter: { attempt: 110000, total: 120000, retryOnTimeout: false }, // 与 translate 相同（第 5 批 §8.1）
  test: { attempt: 60000, total: 90000, retryOnTimeout: false },
};
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const RETRY_NET = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "ECONNABORTED", "UND_ERR_SOCKET"]);
const MAX_BODY = 4 * 1024 * 1024;
const RETRY_AFTER_MAX_MS = 20000;
// 各功能的输出上限（3.2）：结构化输出的三项 16,000（思考也计入 max_tokens），学习助手 4,000，连接测试 1,000。
const MAX_TOKENS = { assistant: 4000, questionGen: 16000, grading: 16000, portrait: 16000, translate: 16000, talentFilter: 8000, test: 1000 };

class AiError extends Error {
  constructor(code, opts = {}) {
    super(code);
    this.code = code;
    this.reason = opts.reason || null;
    this.httpStatus = opts.httpStatus || null;
    this.attempts = opts.attempts || 0;
    this.latencyMs = opts.latencyMs || 0;
    this.upstreamType = opts.upstreamType || null;
    this.redirectHost = opts.redirectHost || null;
  }
}

function isLoopbackHost(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
function parseUrl(s) {
  try { return new URL(String(s)); } catch { return null; }
}
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// ---------- 配置解析 ----------
// resolveProviderConfig(cfg, env) → { ok, reason?, legacy, provider, models, capabilities, warnings }
// ok=false 的 reason：no_provider | bad_protocol | bad_base_url | insecure_base_url | no_key | no_model |
//                     tls_verification_disabled | local_only | bad_proxy
// 返回值里的 provider.key 是密钥本身：只在本进程内存里用，**不得**进入日志、响应或审计；
// 对外展示一律用 describe()。
function resolveProviderConfig(cfg, env) {
  cfg = obj(cfg); env = env || process.env;
  const ai = obj(cfg.ai);
  const warnings = [];
  let src, legacy = false, key = "", keySource = null;
  const legacyAnthropic = env.ANTHROPIC_API_KEY || cfg.anthropicApiKey;
  const legacyGemini = env.GEMINI_API_KEY || cfg.geminiApiKey;
  if (ai.provider && typeof ai.provider === "object" && !Array.isArray(ai.provider)) {
    src = { ...ai.provider };
    if (legacyAnthropic || legacyGemini || cfg.aiModel) warnings.push("legacy_fields_ignored");
    const envName = typeof src.apiKeyEnv === "string" && src.apiKeyEnv.trim() ? src.apiKeyEnv.trim() : "LMS_AI_API_KEY";
    if (env[envName]) { key = String(env[envName]); keySource = "env:" + envName; }
    else if (typeof src.apiKey === "string" && src.apiKey) { key = src.apiKey; keySource = "config:ai.provider.apiKey"; }
  } else if (legacyAnthropic) {
    legacy = true;
    src = { id: "anthropic", protocol: "anthropic-messages" };
    key = String(legacyAnthropic);
    keySource = env.ANTHROPIC_API_KEY ? "env:ANTHROPIC_API_KEY" : "config:anthropicApiKey";
  } else if (legacyGemini) {
    legacy = true;
    src = { id: "gemini", protocol: "gemini" };
    key = String(legacyGemini);
    keySource = env.GEMINI_API_KEY ? "env:GEMINI_API_KEY" : "config:geminiApiKey";
  } else {
    return { ok: false, reason: "no_provider", legacy: false, warnings };
  }
  const protocol = String(src.protocol || "");
  if (!PROTOCOLS.includes(protocol)) return { ok: false, reason: "bad_protocol", legacy, warnings };
  const baseUrl = String(src.baseUrl || DEFAULT_BASE[protocol] || "").replace(/\/+$/, "");
  const u = parseUrl(baseUrl);
  if (!u || !/^https?:$/.test(u.protocol)) return { ok: false, reason: "bad_base_url", legacy, warnings };
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) return { ok: false, reason: "insecure_base_url", legacy, warnings };
  const auth = AUTH_MODES.has(src.auth) ? src.auth : DEFAULT_AUTH[protocol];
  if (auth !== "none" && !key) return { ok: false, reason: "no_key", legacy, warnings, keySource };
  // 模型：ai.models.default / ai.models.<功能>；旧配置取 aiModel。openai-chat 没有官方默认，必须填写。
  const mcfg = obj(ai.models);
  const models = {};
  const fallback = (legacy ? cfg.aiModel : mcfg.default) || DEFAULT_MODEL[protocol] || "";
  models.default = fallback;
  for (const f of FEATURES) models[f] = (!legacy && typeof mcfg[f] === "string" && mcfg[f]) || fallback;
  if (!models.assistant) return { ok: false, reason: "no_model", legacy, warnings };
  // 能力：按协议给默认值，网关不支持的参数在 capabilities 里关掉（3.2）。
  const c = obj(src.capabilities);
  const isAnthropic = protocol === "anthropic-messages";
  const capabilities = {
    structuredOutput: STRUCTURED.has(c.structuredOutput) ? c.structuredOutput : "json_schema",
    thinking: typeof c.thinking === "boolean" ? c.thinking : isAnthropic,
    effort: typeof c.effort === "boolean" ? c.effort : isAnthropic,
    sampling: typeof c.sampling === "boolean" ? c.sampling : false,
    usage: typeof c.usage === "boolean" ? c.usage : true,
  };
  let proxy = null;
  if (src.proxy) {
    const pu = parseUrl(src.proxy);
    if (!pu || pu.protocol !== "http:") return { ok: false, reason: "bad_proxy", legacy, warnings };
    proxy = { host: pu.hostname, port: Number(pu.port) || 80, auth: pu.username ? decodeURIComponent(pu.username) + ":" + decodeURIComponent(pu.password || "") : null };
  }
  if (env.LMS_TEST_AI_LOCAL_ONLY === "1" && (!isLoopbackHost(u.hostname) || (proxy && !isLoopbackHost(proxy.host))))
    return { ok: false, reason: "local_only", legacy, warnings };
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return { ok: false, reason: "tls_verification_disabled", legacy, warnings };
  const headers = {};
  for (const [k, v] of Object.entries(obj(src.headers))) if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k) && v != null) headers[k] = String(v);
  const query = {};
  for (const [k, v] of Object.entries(obj(src.query))) if (v != null) query[k] = String(v);
  for (const k of Object.keys(query)) if (/key|token|secret|code/i.test(k)) warnings.push("query_param_looks_secret:" + k);
  const t = obj(src.tls);
  const tlsOpts = {};
  if (t.pfxFile) tlsOpts.pfxFile = String(t.pfxFile);
  if (t.certFile) tlsOpts.certFile = String(t.certFile);
  if (t.keyFile) tlsOpts.keyFile = String(t.keyFile);
  if (t.passphraseEnv) tlsOpts.passphraseEnv = String(t.passphraseEnv);
  const timeoutMs = Number.isFinite(Number(src.timeoutMs)) && Number(src.timeoutMs) > 0 ? Math.min(600000, Number(src.timeoutMs)) : 150000;
  const maxRetries = Number.isInteger(Number(src.maxRetries)) && Number(src.maxRetries) >= 0 ? Math.min(5, Number(src.maxRetries)) : 2;
  const provider = {
    id: String(src.id || protocol).slice(0, 60),
    protocol, baseUrl, path: typeof src.path === "string" && src.path ? (src.path.startsWith("/") ? src.path : "/" + src.path) : "",
    auth, key, keySource, headers, query, timeoutMs, maxRetries, proxy, tls: tlsOpts,
    userAttribution: src.userAttribution === "pseudonym" ? "pseudonym" : "none",
    maxTokensField: src.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
    // 测试专用：缩短退避基数（只在 LMS_TEST_AI_LOCAL_ONLY=1 时读取，生产配置写了也不生效）
    retryBaseMs: env.LMS_TEST_AI_LOCAL_ONLY === "1" && Number(src.retryBaseMs) >= 0 ? Number(src.retryBaseMs) : 1000,
  };
  return { ok: true, legacy, provider, models, capabilities, warnings };
}

// 解析后的完整地址（主机 + 路径，不含查询串）：启动日志、ai-check、治理页都显示它。
function endpointPath(p, model) {
  if (p.path) return p.path.replace("{model}", encodeURIComponent(model || ""));
  if (p.protocol === "anthropic-messages") return "/v1/messages";
  if (p.protocol === "openai-chat") return "/chat/completions";
  return `/v1beta/models/${encodeURIComponent(model || "")}:generateContent`;
}
function displayUrl(p, model) {
  return p.baseUrl + endpointPath(p, model);
}
function requestUrl(p, model) {
  const u = new URL(displayUrl(p, model));
  for (const [k, v] of Object.entries(p.query)) u.searchParams.set(k, v);
  return u;
}
// 对外可展示的配置摘要：不含密钥、请求头与查询参数的值（只给名称）。
function describe(resolved) {
  if (!resolved || !resolved.ok) return { configured: false, reason: resolved ? resolved.reason : "no_provider", legacy: !!(resolved && resolved.legacy) };
  const p = resolved.provider;
  const u = parseUrl(p.baseUrl);
  return {
    configured: true, legacy: resolved.legacy, providerId: p.id, protocol: p.protocol,
    url: displayUrl(p, resolved.models.default || resolved.models.assistant),
    host: u ? u.host : null, auth: p.auth, keyConfigured: !!p.key, keySource: p.keySource,
    headerNames: Object.keys(p.headers), queryNames: Object.keys(p.query),
    proxyHost: p.proxy ? p.proxy.host + ":" + p.proxy.port : null,
    clientCert: !!(p.tls.pfxFile || p.tls.certFile),
    userAttribution: p.userAttribution, timeoutMs: p.timeoutMs, maxRetries: p.maxRetries,
    models: resolved.models, capabilities: resolved.capabilities, warnings: resolved.warnings,
  };
}

// ---------- token 估算（服务商没回 usage 时）：CJK 字符按 1 字 1 token，其余按 4 字符 1 token（2.7） ----------
function estimateTokens(text) {
  const s = String(text || "");
  const cjk = (s.match(/[　-鿿가-힯豈-﫿＀-￯]/g) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

// ---------- 请求体 ----------
function schemaHint(schema) {
  return "\n\nReturn ONLY a JSON object that matches this JSON Schema (no prose, no code fences):\n" + JSON.stringify(schema);
}
function buildRequest(resolved, o) {
  const p = resolved.provider, caps = resolved.capabilities;
  const model = o.model;
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (p.auth === "bearer") headers.authorization = "Bearer " + p.key;
  else if (p.auth === "x-api-key") headers["x-api-key"] = p.key;
  else if (p.auth === "api-key") headers["api-key"] = p.key;
  else if (p.auth === "x-goog-api-key") headers["x-goog-api-key"] = p.key;
  for (const [k, v] of Object.entries(p.headers)) headers[k] = v;
  let system = o.system || "";
  const wantSchema = !!o.schema;
  if (wantSchema && caps.structuredOutput !== "json_schema") system += schemaHint(o.schema);
  let body;
  if (p.protocol === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    body = { model, max_tokens: o.maxTokens, system, messages: o.messages.map((m) => ({ role: m.role, content: m.content })) };
    const oc = {};
    if (wantSchema && caps.structuredOutput === "json_schema") oc.format = { type: "json_schema", schema: toProtocol(o.schema, p.protocol) };
    if (caps.effort && o.effort) oc.effort = o.effort;
    if (Object.keys(oc).length) body.output_config = oc;
    if (caps.thinking) body.thinking = { type: "adaptive" };
    if (o.attribution) body.metadata = { user_id: o.attribution };
  } else if (p.protocol === "openai-chat") {
    body = { model, messages: [{ role: "system", content: system }, ...o.messages.map((m) => ({ role: m.role, content: m.content }))] };
    body[p.maxTokensField] = o.maxTokens;
    if (wantSchema && caps.structuredOutput === "json_schema")
      body.response_format = { type: "json_schema", json_schema: { name: o.schemaName || "output", schema: toProtocol(o.schema, p.protocol), strict: true } };
    else if (wantSchema && caps.structuredOutput === "json_object") body.response_format = { type: "json_object" };
    if (caps.effort && o.effort) body.reasoning_effort = o.effort;
    if (o.attribution) body.user = o.attribution;
  } else {
    const gc = { maxOutputTokens: o.maxTokens };
    if (wantSchema && caps.structuredOutput !== "none") gc.responseMimeType = "application/json";
    if (wantSchema && caps.structuredOutput === "json_schema") gc.responseSchema = toProtocol(o.schema, p.protocol);
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: o.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: gc,
    };
  }
  const inChars = system.length + o.messages.reduce((n, m) => n + String(m.content || "").length, 0);
  return { url: requestUrl(p, model), headers, body: JSON.stringify(body), inChars, inText: system + "\n" + o.messages.map((m) => m.content).join("\n") };
}

// ---------- 响应 ----------
function parseResponse(protocol, data) {
  let text = "", stop = null, usage = null, modelReturned = null, refused = false, truncated = false;
  if (protocol === "anthropic-messages") {
    text = (Array.isArray(data.content) ? data.content : []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
    stop = data.stop_reason || null;
    truncated = stop === "max_tokens";
    refused = stop === "refusal";
    if (data.usage) usage = { in: Number(data.usage.input_tokens) || 0, out: Number(data.usage.output_tokens) || 0 };
    modelReturned = typeof data.model === "string" ? data.model : null;
  } else if (protocol === "openai-chat") {
    const ch = Array.isArray(data.choices) ? data.choices[0] : null;
    const msg = ch && ch.message ? ch.message : {};
    text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((x) => (x && (x.text || "")) || "").join("") : "";
    stop = ch ? ch.finish_reason || null : null;
    truncated = stop === "length";
    refused = stop === "content_filter" || (typeof msg.refusal === "string" && msg.refusal.length > 0);
    if (data.usage) usage = { in: Number(data.usage.prompt_tokens) || 0, out: Number(data.usage.completion_tokens) || 0 };
    modelReturned = typeof data.model === "string" ? data.model : null;
  } else {
    const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    text = parts.filter((x) => x && !x.thought).map((x) => x.text || "").join("");
    stop = cand ? cand.finishReason || null : null;
    truncated = stop === "MAX_TOKENS";
    refused = !!(data.promptFeedback && data.promptFeedback.blockReason) || ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(stop);
    const um = data.usageMetadata;
    if (um) usage = { in: Number(um.promptTokenCount) || 0, out: (Number(um.candidatesTokenCount) || 0) + (Number(um.thoughtsTokenCount) || 0) };
    modelReturned = typeof data.modelVersion === "string" ? data.modelVersion : null;
  }
  return { text, stop, usage, modelReturned, refused, truncated };
}
// 上游错误的类型或错误码（不含 message）：anthropic {error:{type}}、openai {error:{type,code}}、gemini {error:{status,code}}。
function upstreamErrorType(data) {
  const e = data && typeof data === "object" ? data.error : null;
  if (!e || typeof e !== "object") return null;
  const parts = [e.type, e.code, e.status].filter((x) => typeof x === "string" || typeof x === "number").map(String);
  return parts.length ? parts.join("/").slice(0, 80) : null;
}
function upstreamMessage(data) {
  const e = data && typeof data === "object" ? data.error : null;
  return e && typeof e.message === "string" ? e.message : "";
}

// ---------- HTTP（一套栈） ----------
function tlsMaterial(t) {
  const out = {};
  if (t.pfxFile) out.pfx = fs.readFileSync(t.pfxFile);
  if (t.certFile) out.cert = fs.readFileSync(t.certFile);
  if (t.keyFile) out.key = fs.readFileSync(t.keyFile);
  if (t.passphraseEnv && process.env[t.passphraseEnv]) out.passphrase = process.env[t.passphraseEnv];
  return out;
}
// 经 HTTP CONNECT 隧道连到目标（方案 3.3 的五条要求）：CONNECT 不是 200 立即失败；隧道上做 TLS 握手，
// servername 取目标主机名、默认主机名校验、rejectUnauthorized 恒为 true、不传自定义 ca；超时与直连一致；
// 代理账号只进 Proxy-Authorization，不写日志。
function connectTunnel(proxy, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${target.hostname}:${target.port}` };
    if (proxy.auth) headers["proxy-authorization"] = "Basic " + Buffer.from(proxy.auth).toString("base64");
    const req = http.request({ host: proxy.host, port: proxy.port, method: "CONNECT", path: `${target.hostname}:${target.port}`, headers, agent: false });
    const timer = setTimeout(() => { req.destroy(Object.assign(new Error("proxy connect timeout"), { code: "AI_TIMEOUT" })); }, timeoutMs);
    req.once("connect", (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) { socket.destroy(); return reject(Object.assign(new Error("proxy refused CONNECT"), { code: "AI_PROXY_REFUSED", proxyStatus: res.statusCode })); }
      resolve(socket);
    });
    req.once("error", (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}
function httpPost(resolved, url, headers, bodyText, timeoutMs) {
  const p = resolved.provider;
  const secure = url.protocol === "https:";
  const port = Number(url.port) || (secure ? 443 : 80);
  const target = { hostname: url.hostname.replace(/^\[|\]$/g, ""), port };
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      const e = Object.assign(new Error("timeout"), { code: "AI_TIMEOUT" });
      if (req) req.destroy(e);
      done(reject, e);
    }, timeoutMs);
    const onResponse = (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { res.destroy(); done(reject, Object.assign(new Error("response too large"), { code: "AI_TOO_LARGE" })); return; }
        chunks.push(c);
      });
      res.on("end", () => done(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => done(reject, e));
    };
    const opts = {
      method: "POST", path: url.pathname + url.search,
      headers: { ...headers, host: url.host, "content-length": Buffer.byteLength(bodyText) },
      agent: false,
    };
    const start = (socket) => {
      if (settled) { if (socket) socket.destroy(); return; }
      if (socket) {
        // 隧道：在代理给的套接字上做 TLS（https 目标），再在其上发 HTTP/1.1。
        let conn = socket;
        if (secure) {
          conn = tls.connect({ socket, servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true, ...tlsMaterial(p.tls) });
          conn.once("error", (e) => done(reject, e));
        }
        // 不能带 agent:false：那样 Node 会新建一个 Agent 自己去连（默认 localhost:80），createConnection 被忽略。
        const { agent, ...viaTunnel } = opts;
        req = http.request({ ...viaTunnel, createConnection: () => conn }, onResponse);
      } else if (secure) {
        req = https.request({ ...opts, hostname: target.hostname, port, servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true, ...tlsMaterial(p.tls) }, onResponse);
      } else {
        req = http.request({ ...opts, hostname: target.hostname, port }, onResponse);
      }
      req.once("error", (e) => done(reject, e));
      req.end(bodyText);
    };
    if (p.proxy) connectTunnel(p.proxy, target, timeoutMs).then(start, (e) => done(reject, e));
    else {
      try { start(null); } catch (e) { done(reject, e); }
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryAfterMs(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}
function statusToCode(status) {
  if (status === 401 || status === 403) return "ai_auth_failed";
  if (status === 404) return "ai_model_not_found";
  if (status === 400 || status === 422) return "ai_bad_request";
  if (status === 413) return "ai_input_too_large";
  return "ai_upstream_error";
}

// 一次逻辑请求（含重试）。成功返回 { text, usage, modelReturned, stopReason, attempts, latencyMs, httpStatus }；
// 失败抛 AiError。日志只记元数据。
async function sendOnce(resolved, o, req, ctx) {
  const p = resolved.provider;
  const ft = FEATURE_TIMEOUTS[o.feature] || FEATURE_TIMEOUTS.test;
  const maxRetries = Math.min(p.maxRetries, ft.maxRetries != null ? ft.maxRetries : p.maxRetries);
  const t0 = Date.now();
  const deadline = t0 + Math.min(ft.total, p.timeoutMs + (ft.total - ft.attempt));
  let attempts = 0, lastErr = null;
  const log = ctx.log || (() => {});
  const debugOn = ctx.debugUntil && ctx.debugUntil > Date.now();
  while (attempts <= maxRetries) {
    const remain = deadline - Date.now();
    const perAttempt = Math.min(ft.attempt, p.timeoutMs, remain);
    if (perAttempt <= 0) break;
    attempts++;
    let res;
    try {
      res = await httpPost(resolved, req.url, req.headers, req.body, perAttempt);
    } catch (e) {
      const isTimeout = e && e.code === "AI_TIMEOUT";
      if (e && e.code === "AI_TOO_LARGE") {
        lastErr = new AiError("ai_upstream_error", { reason: "too_large", attempts });
        break;
      }
      if (e && e.code === "AI_PROXY_REFUSED") {
        lastErr = new AiError("ai_upstream_error", { reason: "proxy_refused", httpStatus: e.proxyStatus, attempts });
        log({ requestId: ctx.requestId, feature: o.feature, event: "proxy_refused", status: e.proxyStatus, latencyMs: Date.now() - t0 });
        break;
      }
      const tlsFail = e && (/CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|HOSTNAME|altnames/i.test(String(e.code || "") + " " + String(e.message || "")));
      log({ requestId: ctx.requestId, feature: o.feature, event: isTimeout ? "timeout" : tlsFail ? "tls_error" : "network_error", code: e && e.code ? String(e.code).slice(0, 40) : null, latencyMs: Date.now() - t0 });
      if (tlsFail) { lastErr = new AiError("ai_upstream_error", { reason: "tls", attempts }); break; }
      lastErr = isTimeout ? new AiError("ai_timeout", { attempts }) : new AiError("ai_upstream_error", { reason: "network", attempts });
      const retryable = isTimeout ? ft.retryOnTimeout : RETRY_NET.has(e && e.code);
      if (!retryable || attempts > maxRetries) break;
      await sleep(Math.min(backoff(p.retryBaseMs, attempts), Math.max(0, deadline - Date.now())));
      continue;
    }
    const ctype = String(res.headers["content-type"] || "").split(";")[0].slice(0, 60);
    if (res.status >= 300 && res.status < 400) {
      const loc = parseUrl(res.headers.location ? new URL(res.headers.location, req.url).href : "");
      log({ requestId: ctx.requestId, feature: o.feature, event: "redirect", status: res.status, redirectHost: loc ? loc.host : null, latencyMs: Date.now() - t0 });
      throw new AiError("ai_upstream_error", { reason: "redirect", httpStatus: res.status, attempts, latencyMs: Date.now() - t0, redirectHost: loc ? loc.host : null });
    }
    let data;
    try { data = JSON.parse(res.text); } catch { data = undefined; }
    if (res.status >= 200 && res.status < 300) {
      if (data === undefined || typeof data !== "object" || data === null) {
        log({ requestId: ctx.requestId, feature: o.feature, event: "non_json", status: res.status, contentType: ctype, latencyMs: Date.now() - t0 });
        throw new AiError("ai_upstream_error", { reason: "non_json", httpStatus: res.status, attempts, latencyMs: Date.now() - t0 });
      }
      log({ requestId: ctx.requestId, feature: o.feature, event: "ok", status: res.status, latencyMs: Date.now() - t0, attempts });
      return { data, attempts, latencyMs: Date.now() - t0, httpStatus: res.status };
    }
    const upType = upstreamErrorType(data);
    const line = { requestId: ctx.requestId, feature: o.feature, event: "upstream_error", status: res.status, contentType: ctype, upstreamType: upType, latencyMs: Date.now() - t0 };
    if (debugOn) line.debug = ctx.debugRedact ? ctx.debugRedact(String(upstreamMessage(data) || res.text || "")).slice(0, 200) : "";
    log(line);
    const code = data === undefined && res.status < 500 && res.status !== 429 ? "ai_upstream_error" : statusToCode(res.status);
    lastErr = new AiError(code, { reason: data === undefined ? "non_json" : "http_" + res.status, httpStatus: res.status, attempts, upstreamType: upType });
    if (!RETRY_STATUS.has(res.status) || attempts > maxRetries) break;
    let wait = backoff(p.retryBaseMs, attempts);
    const ra = retryAfterMs(res.headers["retry-after"]);
    if (ra != null) wait = Math.min(RETRY_AFTER_MAX_MS, Math.max(wait, ra));
    if (Date.now() + wait >= deadline) break;
    await sleep(wait);
  }
  if (!lastErr) lastErr = new AiError("ai_timeout", { attempts });
  lastErr.attempts = attempts;
  lastErr.latencyMs = Date.now() - t0;
  throw lastErr;
}
function backoff(base, attempt) {
  const ms = base * Math.pow(2, attempt - 1);
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

// callModel(resolved, opts, ctx) —— 统一的内部接口（3.2）。
// opts: { feature, system, messages:[{role,content}], schema?, schemaName?, semantic?(json)→问题|null, maxTokens?, effort?, model?, attribution? }
// ctx:  { requestId, log(line), onCall(record), debugUntil(ms), debugRedact(text) }
// 返回 { text, json?, usage:{in,out,estimated}, modelReturned, stopReason, attempts, latencyMs, calls }
// 每次逻辑请求（首次与补救）都调用 ctx.onCall(record) 一次，record 不含任何原文。
async function callModel(resolved, opts, ctx = {}) {
  if (!resolved || !resolved.ok) throw new AiError("ai_not_configured", { reason: resolved ? resolved.reason : "no_provider" });
  const feature = opts.feature;
  const model = opts.model || resolved.models[feature] || resolved.models.default || resolved.models.assistant;
  const base = {
    feature, model, system: opts.system || "", messages: opts.messages || [], schema: opts.schema || null,
    schemaName: opts.schemaName || feature, maxTokens: opts.maxTokens || MAX_TOKENS[feature] || 4000,
    effort: opts.effort || null, attribution: opts.attribution || null,
  };
  const p = resolved.provider;
  const host = parseUrl(p.baseUrl) ? parseUrl(p.baseUrl).host : null;
  const record = (extra) => {
    if (typeof ctx.onCall === "function") {
      try { ctx.onCall({ feature, providerId: p.id, protocol: p.protocol, endpointHost: host, modelRequested: model, ...extra }); } catch { /* 记录失败不影响调用 */ }
    }
  };
  const one = async (o, repair) => {
    const req = buildRequest(resolved, o);
    try {
      const r = await sendOnce(resolved, o, req, ctx);
      const parsed = parseResponse(p.protocol, r.data);
      const usage = parsed.usage && resolved.capabilities.usage ? { in: parsed.usage.in, out: parsed.usage.out, estimated: false }
        : { in: estimateTokens(req.inText), out: estimateTokens(parsed.text), estimated: true };
      const common = { httpStatus: r.httpStatus, attempts: r.attempts, latencyMs: r.latencyMs, inChars: req.inChars, outChars: parsed.text.length, inTokens: usage.in, outTokens: usage.out, tokensEstimated: usage.estimated ? 1 : 0, modelReturned: parsed.modelReturned, repair };
      if (parsed.refused) { record({ status: "error", errorCode: "ai_refused", ...common }); throw new AiError("ai_refused", { httpStatus: r.httpStatus, attempts: r.attempts, latencyMs: r.latencyMs }); }
      if (parsed.truncated) { record({ status: "error", errorCode: "ai_output_truncated", ...common }); throw new AiError("ai_output_truncated", { httpStatus: r.httpStatus, attempts: r.attempts, latencyMs: r.latencyMs }); }
      return { parsed, usage, common, r };
    } catch (e) {
      if (e instanceof AiError && (e.code === "ai_refused" || e.code === "ai_output_truncated")) throw e;
      const err = e instanceof AiError ? e : new AiError("ai_upstream_error", { reason: "internal" });
      record({ status: "error", errorCode: err.code, httpStatus: err.httpStatus, attempts: err.attempts, latencyMs: err.latencyMs, inChars: req.inChars, outChars: 0, inTokens: 0, outTokens: 0, tokensEstimated: 1, modelReturned: null, repair, reason: err.reason });
      throw err;
    }
  };
  const first = await one(base, false);
  if (!base.schema) {
    record({ status: "ok", errorCode: null, ...first.common });
    return { text: first.parsed.text, usage: first.usage, modelReturned: first.parsed.modelReturned, stopReason: first.parsed.stop, attempts: first.r.attempts, latencyMs: first.r.latencyMs };
  }
  const check = (text) => {
    const json = parseJsonText(text);
    if (json === undefined) return { problem: "output is not valid JSON" };
    const s = validate(base.schema, json);
    if (s) return { problem: s };
    const sem = typeof opts.semantic === "function" ? opts.semantic(json) : null;
    if (sem) return { problem: String(sem) };
    return { json };
  };
  const c1 = check(first.parsed.text);
  if (c1.json !== undefined) {
    record({ status: "ok", errorCode: null, ...first.common });
    return { text: first.parsed.text, json: c1.json, usage: first.usage, modelReturned: first.parsed.modelReturned, stopReason: first.parsed.stop, attempts: first.r.attempts, latencyMs: first.r.latencyMs };
  }
  record({ status: "error", errorCode: "ai_output_invalid", ...first.common });
  // 补救调用：发回的是模型的原始输出（含占位符，未还原），外加问题描述。
  const fix = { ...base, messages: [...base.messages, { role: "assistant", content: first.parsed.text.slice(0, 60000) }, { role: "user", content: `Your previous reply did not match the required JSON Schema (${c1.problem}). Reply again with ONLY the corrected JSON object.` }] };
  const second = await one(fix, true);
  const c2 = check(second.parsed.text);
  if (c2.json === undefined) {
    record({ status: "error", errorCode: "ai_output_invalid", ...second.common });
    throw new AiError("ai_output_invalid", { httpStatus: second.r.httpStatus, attempts: second.r.attempts, latencyMs: second.r.latencyMs });
  }
  record({ status: "ok", errorCode: null, ...second.common });
  const usage = { in: first.usage.in + second.usage.in, out: first.usage.out + second.usage.out, estimated: first.usage.estimated || second.usage.estimated };
  return { text: second.parsed.text, json: c2.json, usage, modelReturned: second.parsed.modelReturned, stopReason: second.parsed.stop, attempts: first.r.attempts + second.r.attempts, latencyMs: first.r.latencyMs + second.r.latencyMs };
}

module.exports = {
  PROTOCOLS, FEATURES, FEATURE_TIMEOUTS, MAX_TOKENS, AiError,
  resolveProviderConfig, describe, displayUrl, endpointPath, callModel, estimateTokens, isLoopbackHost,
  // 供测试核对
  _buildRequest: buildRequest, _parseResponse: parseResponse,
};
