// AI 治理服务（方案 2.1.3、2.3、2.7）：功能生效判定、调用记录、限流与并发、月度预算、配置指纹、保留期清理。
// server.js 在启动时 createAiService(deps) 一次；四项功能的路由（learning / talent）与治理接口（core）都经它调用。
//
// deps: { store, readConfig, modulesOn, isProduction, brandName, auditSystem(action, target, before, after), notifyAdmins(n, domain), log }
"use strict";
const crypto = require("crypto");
const provider = require("./provider.js");
const { limitsFrom, createRateLimiter, createPool } = require("./limits.js");
const READY = require("./readiness.js");
const manifest = require("./manifest.js");
const { VERSIONS: PROMPT_VERSIONS } = require("./prompts.js");
// talentFilter 的提示词与结构在 talent-filter.js（第 5 批）；prompts.js 登记之前也能取到版本号，登记之后两边一致
const VERSIONS = { ...require("./talent-filter.js").VERSIONS, ...PROMPT_VERSIONS };

const CATALOG = manifest.provides.aiFeatures;
const FEATURE_IDS = CATALOG.map((f) => f.id);
const catalogOf = (id) => CATALOG.find((f) => f.id === id) || null;
// 员工告知的当前版本（方案 2.6）：文案改版时递增，员工下次使用时重新提示
const NOTICE_VERSIONS = { assistant: 2, grading: 1 };
const RETENTION_DEFAULTS = { assistant: 180, questionGen: 180, translate: 180, talentFilter: 180, test: 180, grading: null, portrait: null };
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// +08:00 自然月（方案 2.7）
function monthKey(ms) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 7); }
function monthStartIso(key) { return new Date(key + "-01T00:00:00+08:00").toISOString(); }
function nextMonthKey(key) { const [y, m] = key.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; }
function prevMonthKey(key) { const [y, m] = key.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; }

function createAiService(deps) {
  const { store, readConfig, modulesOn } = deps;
  const log = deps.log || console;
  const limiter = createRateLimiter();
  let cachedLimits = limitsFrom({});
  const interactivePool = createPool(() => cachedLimits.concurrency);
  const gradingPool = createPool(() => cachedLimits.gradingConcurrency);
  let budgetCache = { at: 0, month: null, used: 0 };
  let historyCache = { at: 0, v: false };

  const aiCfg = (cfg) => obj((cfg || readConfig()).ai);
  function resolveNow(cfg) { return provider.resolveProviderConfig(cfg || readConfig(), process.env); }

  // ---------- 功能开关（config.ai.features；未写时取目录默认值） ----------
  function featureEnabled(id, cfg) {
    const f = obj(aiCfg(cfg).features);
    if (typeof f[id] === "boolean") return f[id];
    const c = catalogOf(id);
    return c ? c.defaultOn !== false : true;
  }
  function budgetLimits(cfg) {
    const b = obj(aiCfg(cfg).budget);
    const monthly = Number(b.monthlyTokens);
    const alertAt = Number(b.alertAtPercent);
    const price = obj(b.pricePerMTok);
    return {
      monthlyTokens: Number.isFinite(monthly) && monthly > 0 ? monthly : 50000000,
      alertAtPercent: Number.isFinite(alertAt) && alertAt > 0 && alertAt < 100 ? alertAt : 80,
      pricePerMTok: { input: Number(price.input) || 0, output: Number(price.output) || 0 },
    };
  }
  function budgetState(cfg) {
    const now = Date.now();
    const month = monthKey(now);
    if (budgetCache.month !== month || now - budgetCache.at > 60000) {
      budgetCache = { at: now, month, used: store.aiTokensBetween(monthStartIso(month), monthStartIso(nextMonthKey(month))) };
    }
    const lim = budgetLimits(cfg);
    return { month, used: budgetCache.used, limit: lim.monthlyTokens, alertAtPercent: lim.alertAtPercent, percent: Math.floor((budgetCache.used / lim.monthlyTokens) * 1000) / 10 };
  }

  // featureState(id) → { state, reason? }，从上到下命中第一条（方案 2.1.3 表）
  function featureState(id, o = {}) {
    const cfg = o.cfg || readConfig();
    const mods = o.mods || modulesOn();
    if (!mods.ai) return { state: "off_module" };
    const c = catalogOf(id);
    if (c && c.owner && mods[c.owner] === false) return { state: "off_owner" };
    if (id !== "test" && !featureEnabled(id, cfg)) return { state: "off_feature" };
    if (!READY.includes(id) && process.env.LMS_TEST_AI_LOCAL_ONLY !== "1") return { state: "off_feature", reason: "not_ready" };
    if (process.env.LMS_DISABLE_AI === "1") return { state: "not_configured", reason: "disabled" };
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return { state: "not_configured", reason: "tls_verification_disabled" };
    if (aiCfg(cfg).demo === true) return { state: "demo" };
    const r = resolveNow(cfg);
    if (!r.ok) return { state: "not_configured", reason: r.reason };
    const b = budgetState(cfg);
    if (id !== "test" && b.used >= b.limit) return { state: "budget_exhausted" };
    return { state: "on" };
  }
  // 状态 → 响应（调用接口在 handler 内用）：关闭一律裸 404（与不存在相同）
  function stateResponse(st) {
    if (st.state === "off_module" || st.state === "off_owner") return { status: 404, body: { error: "Not found" } };
    if (st.state === "off_feature") return { status: 403, body: { error: "This AI feature is not enabled.", error_zh: "该 AI 功能未开启。", code: "ai_feature_off" } };
    if (st.state === "not_configured") return { status: 503, body: { error: "The AI service is not connected yet.", error_zh: "AI 服务尚未接入。", code: "ai_not_configured", reason: st.reason || null } };
    if (st.state === "budget_exhausted") return { status: 429, body: { error: "This month's AI usage limit has been reached.", error_zh: "本月 AI 用量已达上限。", code: "ai_budget_exhausted" } };
    return null;
  }

  // ---------- /api/me 的 ai 字段 ----------
  function historyExists() {
    const now = Date.now();
    if (now - historyCache.at > 60000) historyCache = { at: now, v: store.aiCallsExist() };
    return historyCache.v;
  }
  function meAi(user, o = {}) {
    const cfg = readConfig();
    const mods = modulesOn();
    const st = (id) => featureState(id, { cfg, mods }).state;
    const out = {
      assistant: st("assistant"), grading: st("grading"), demo: !!(mods.ai && aiCfg(cfg).demo === true),
      notice: {
        assistant: { version: NOTICE_VERSIONS.assistant, acked: store.aiNoticeAcked(user.id, "assistant", NOTICE_VERSIONS.assistant) },
        grading: { version: NOTICE_VERSIONS.grading },
      },
    };
    if (o.isAdmin) { out.questionGen = st("questionGen"); out.portrait = st("portrait"); out.translate = st("translate"); out.talentFilter = st("talentFilter"); }
    if (o.canAudit) out.history = historyExists();
    return out;
  }

  // ---------- 配置指纹与 ai.config.change（方案 2.3.5）：不含密钥、请求头与查询参数的值 ----------
  function configSummary(cfg) {
    cfg = cfg || readConfig();
    const mods = modulesOn();
    const r = resolveNow(cfg);
    const d = provider.describe(r);
    const a = aiCfg(cfg);
    const features = {};
    for (const id of FEATURE_IDS) features[id] = featureEnabled(id, cfg);
    return {
      module: !!mods.ai, demo: a.demo === true, features,
      providerId: d.providerId || null, protocol: d.protocol || null, url: d.url || null, legacy: !!d.legacy,
      models: d.models || null, headerNames: d.headerNames || [], queryNames: d.queryNames || [],
      proxyHost: d.proxyHost || null, clientCert: !!d.clientCert, userAttribution: d.userAttribution || null,
      capabilities: d.capabilities || null, limits: limitsFrom(cfg), budget: budgetLimits(cfg), retention: retentionDays(cfg),
    };
  }
  function hashOf(summary) {
    return crypto.createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16);
  }
  function checkConfigChange() {
    const summary = configSummary();
    const h = hashOf(summary);
    const prev = store.getMeta("aiConfigHash");
    if (prev !== h) {
      let before = null;
      try { before = JSON.parse(store.getMeta("aiConfigSummary") || "null"); } catch { before = null; }
      store.setMeta("aiConfigHash", h);
      store.setMeta("aiConfigSummary", JSON.stringify(summary));
      // 第一次（库里还没有指纹）只登记基线、不写审计：新库启动不该出现一条「配置变更」；此后每一次变化都写，带前后对照
      if (prev) deps.auditSystem("ai.config.change", null, before, summary);
    }
    cachedLimits = summary.limits;
    return h;
  }

  // ---------- 调用记录 ----------
  function retentionDays(cfg) {
    const r = obj(obj(aiCfg(cfg).audit).retentionDays);
    const out = {};
    for (const k of Object.keys(RETENTION_DEFAULTS)) {
      const v = r[k];
      if (v === null && (k === "grading" || k === "portrait")) out[k] = null;
      else if (Number.isFinite(Number(v)) && v !== null) out[k] = Math.min(1095, Math.max(90, Math.round(Number(v))));
      else out[k] = RETENTION_DEFAULTS[k];
    }
    return out;
  }
  function pseudonym(userId) {
    const month = monthKey(Date.now());
    let keys = {};
    try { keys = JSON.parse(store.getMeta("aiPseudonymKey") || "{}"); } catch { keys = {}; }
    if (!keys[month]) { keys = { [month]: crypto.randomBytes(32).toString("hex") }; store.setMeta("aiPseudonymKey", JSON.stringify(keys)); }
    return crypto.createHmac("sha256", keys[month]).update(month + ":" + userId).digest("hex").slice(0, 16);
  }
  // 本地记一行（演示、被拦截）：token 记 0
  function recordLocal(feature, o) {
    const cfgHash = store.getMeta("aiConfigHash") || null;
    const id = store.addAiCall({
      requestId: o.requestId || null, actorId: o.actorId || null, actorKind: o.actorKind || "admin", feature,
      subjectUserId: o.subjectUserId || null, refId: o.refId || null, providerId: null, protocol: o.status === "demo" ? "demo" : null,
      configHash: cfgHash, promptVersion: VERSIONS[feature] || null, status: o.status, errorCode: o.errorCode || null,
      attempts: 0, latencyMs: 0, inChars: o.inChars || 0, outChars: o.outChars || 0, inTokens: 0, outTokens: 0, tokensEstimated: 0,
      redactions: o.redactions || null,
    });
    historyCache = { at: Date.now(), v: true };
    return id;
  }
  // 真实调用：经并发池、provider.callModel；每次逻辑请求（首次与补救）各记一行。返回 { …结果, callId, provenance }。
  async function call(feature, o) {
    const cfg = readConfig();
    const configHash = checkConfigChange();
    const r = resolveNow(cfg);
    if (!r.ok) throw new provider.AiError("ai_not_configured", { reason: r.reason });
    const ft = provider.FEATURE_TIMEOUTS[feature] || provider.FEATURE_TIMEOUTS.test;
    const effort = obj(aiCfg(cfg).effort)[feature] || { assistant: "low", questionGen: "medium", grading: "medium", portrait: "high", translate: "low", talentFilter: "low", test: "low" }[feature];
    let lastId = null;
    const ctx = {
      requestId: o.requestId || null,
      debugUntil: debugUntil(cfg),
      debugRedact: o.debugRedact || ((t) => t),
      log: (line) => {
        const parts = ["[ai]", line.event, "feature=" + line.feature];
        for (const k of ["requestId", "status", "contentType", "upstreamType", "code", "redirectHost", "attempts", "latencyMs"]) if (line[k] != null) parts.push(k + "=" + line[k]);
        if (line.debug) parts.push("debug=" + JSON.stringify(line.debug));
        (line.event === "ok" ? log.log : log.warn).call(log, parts.join(" "));
      },
      onCall: (rec) => {
        lastId = store.addAiCall({
          requestId: o.requestId || null, actorId: o.actorId || null, actorKind: o.actorKind || "admin", feature,
          subjectUserId: o.subjectUserId || null, refId: o.refId || null, providerId: rec.providerId, protocol: rec.protocol,
          endpointHost: rec.endpointHost, configHash, modelRequested: rec.modelRequested, modelReturned: rec.modelReturned || null,
          promptVersion: VERSIONS[feature] || null, status: rec.status, errorCode: rec.errorCode || null, httpStatus: rec.httpStatus || null,
          attempts: rec.attempts || 0, latencyMs: rec.latencyMs || 0, inChars: rec.inChars || 0, outChars: rec.outChars || 0,
          inTokens: rec.inTokens || 0, outTokens: rec.outTokens || 0, tokensEstimated: rec.tokensEstimated ? 1 : 0,
          redactions: o.redactions || null,
        });
        budgetCache.used += (rec.inTokens || 0) + (rec.outTokens || 0);
        historyCache = { at: Date.now(), v: true };
      },
    };
    const attribution = r.provider.userAttribution === "pseudonym" && o.actorId ? pseudonym(o.actorId) : null;
    const pool = feature === "grading" ? gradingPool : interactivePool;
    const deadline = feature === "grading" ? null : Date.now() + ft.total;
    const run = () => provider.callModel(r, {
      feature, system: o.system, messages: o.messages, schema: o.schema, schemaName: o.schemaName, semantic: o.semantic,
      maxTokens: o.maxTokens, effort, attribution, model: o.model,
    }, ctx);
    try {
      const out = await pool.run(run, deadline, () => new provider.AiError("ai_timeout", { reason: "queue" }));
      afterUsage(cfg);
      return {
        ...out, callId: lastId,
        provenance: { providerId: r.provider.id, protocol: r.provider.protocol, model: o.model || r.models[feature] || r.models.default, modelReturned: out.modelReturned || null, promptVersion: VERSIONS[feature] || null, generatedAt: new Date().toISOString(), callId: lastId },
      };
    } catch (e) {
      afterUsage(cfg);
      if (e && e.code === "ai_timeout" && e.reason === "queue") recordLocal(feature, { ...o, status: "blocked", errorCode: "ai_timeout" });
      throw e;
    }
  }
  function debugUntil(cfg) {
    const s = aiCfg(cfg).debugLogUntil;
    const t = s ? Date.parse(s) : NaN;
    if (!Number.isFinite(t)) return 0;
    return Math.min(t, Date.now() + 24 * 3600 * 1000);
  }
  // 月度预算预警：两个阈值各自每月通知一次（meta aiBudgetAlerts = { month, alerted80, alerted100 }）
  function afterUsage(cfg) {
    const b = budgetState(cfg);
    let st = {};
    try { st = JSON.parse(store.getMeta("aiBudgetAlerts") || "{}"); } catch { st = {}; }
    if (st.month !== b.month) st = { month: b.month, alerted80: false, alerted100: false };
    const fire = (threshold) => {
      const pct = Math.round(b.percent);
      deps.auditSystem("ai.budget.alert", b.month, null, { usedTokens: b.used, limit: b.limit, percent: pct, threshold });
      deps.notifyAdmins({
        type: "ai.budget",
        title: threshold === 100 ? `AI usage has reached this month's limit (${pct}%). The study assistant, question drafting and portraits are paused; short answers go to HR scoring.` : `AI usage has reached ${pct}% of this month's limit.`,
        title_zh: threshold === 100 ? `本月 AI 用量已达上限（${pct}%）：学习助手、AI 出题与画像暂停，简答题转 HR 评分。` : `本月 AI 用量已达上限的 ${pct}%。`,
        body: "See System settings › AI Governance for usage by feature.", body_zh: "按功能的用量见「系统设置 › AI 治理」。",
        link: "#/admin/ai-governance",
      }, "audit");
    };
    let changed = false;
    if (b.percent >= b.alertAtPercent && !st.alerted80) { st.alerted80 = true; changed = true; fire(b.alertAtPercent); }
    if (b.percent >= 100 && !st.alerted100) { st.alerted100 = true; changed = true; fire(100); }
    if (changed || !store.getMeta("aiBudgetAlerts")) store.setMeta("aiBudgetAlerts", JSON.stringify(st));
  }

  // ---------- 限流 ----------
  function rateHit(feature, userId) {
    return limiter.hit(feature, userId, limitsFrom(readConfig()));
  }

  // ---------- 用量（治理页） ----------
  function usage() {
    const cfg = readConfig();
    const b = budgetState(cfg);
    const lim = budgetLimits(cfg);
    const cur = b.month, prev = prevMonthKey(cur);
    const rows = (key) => store.aiUsageBetween(monthStartIso(key), monthStartIso(nextMonthKey(key))).map((x) => ({
      feature: x.feature, calls: Number(x.calls) || 0, errors: Number(x.errors) || 0, demo: Number(x.demo) || 0,
      inTokens: Number(x.inTokens) || 0, outTokens: Number(x.outTokens) || 0,
      failureRate: x.calls ? Math.round(((Number(x.errors) || 0) / Number(x.calls)) * 1000) / 10 : 0,
    }));
    const cost = (list) => {
      if (!lim.pricePerMTok.input && !lim.pricePerMTok.output) return null;
      const i = list.reduce((n, x) => n + x.inTokens, 0), o = list.reduce((n, x) => n + x.outTokens, 0);
      return Math.round(((i / 1e6) * lim.pricePerMTok.input + (o / 1e6) * lim.pricePerMTok.output) * 100) / 100;
    };
    const thisMonth = rows(cur), lastMonth = rows(prev);
    return {
      month: cur, prevMonth: prev, byFeature: thisMonth, prevByFeature: lastMonth,
      budget: { used: b.used, limit: b.limit, percent: b.percent, alertAtPercent: b.alertAtPercent },
      cost: cost(thisMonth), prevCost: cost(lastMonth), priced: !!(lim.pricePerMTok.input || lim.pricePerMTok.output),
    };
  }

  // ---------- 状态（治理页）：不返回任何密钥片段、请求头与查询参数的值 ----------
  function status() {
    const cfg = readConfig();
    const mods = modulesOn();
    const hash = checkConfigChange();
    const r = resolveNow(cfg);
    const d = provider.describe(r);
    const features = CATALOG.map((c) => ({ id: c.id, name: c.name, owner: c.owner, humanReview: c.humanReview, enabled: featureEnabled(c.id, cfg), state: featureState(c.id, { cfg, mods }).state, ready: READY.includes(c.id) }));
    return {
      module: !!mods.ai, demo: aiCfg(cfg).demo === true, production: !!(deps.isProduction && deps.isProduction()),
      disabledByEnv: process.env.LMS_DISABLE_AI === "1",
      tlsVerificationDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0",
      provider: d, features, configHash: hash, limits: limitsFrom(cfg), budget: budgetLimits(cfg), retention: retentionDays(cfg),
      debugLogUntil: debugUntil(cfg) ? new Date(debugUntil(cfg)).toISOString() : null,
    };
  }

  // ---------- 保留期清理（每日一次） ----------
  function retentionSweep() {
    const days = retentionDays(readConfig());
    let n = 0;
    for (const f of ["assistant", "questionGen", "translate", "talentFilter", "test"]) n += store.pruneAiCalls(f, new Date(Date.now() - days[f] * 86400000).toISOString());
    for (const f of ["grading", "portrait"]) if (days[f] != null) n += store.pruneAiCalls(f, new Date(Date.now() - days[f] * 86400000).toISOString());
    n += store.pruneOrphanAiCalls();
    return n;
  }

  // ---------- 启动日志（方案 10.5 第 3 步） ----------
  function startupLog() {
    const cfg = readConfig();
    const mods = modulesOn();
    const r = resolveNow(cfg);
    const legacyKey = !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || cfg.anthropicApiKey || cfg.geminiApiKey || obj(aiCfg(cfg).provider).protocol);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      log.warn("AI: TLS verification disabled (NODE_TLS_REJECT_UNAUTHORIZED=0) — every AI call is refused. Remove the variable. / 检测到证书校验被关闭，已拒绝一切 AI 调用，请删除该环境变量。");
    if (!mods.ai) {
      if (legacyKey) log.warn("AI: module off, but an AI key / provider is configured — add \"ai\": true to the modules block of config.json to turn it on. / 检测到 AI 密钥但 AI 模块未开启。");
      else log.log("AI: module off");
      return { moduleOn: false, keyWithoutModule: legacyKey };
    }
    if (aiCfg(cfg).demo === true) {
      log.warn("AI: DEMO MODE (ai.demo: true) — no AI service is called; demo estimates never count toward exam results.");
      if (deps.isProduction && deps.isProduction()) log.warn("AI: WARNING — demo mode is on in a PRODUCTION deployment. / 警告：生产环境开启了演示模式。");
      return { moduleOn: true, demo: true };
    }
    if (process.env.LMS_DISABLE_AI === "1") { log.log("AI: not configured (LMS_DISABLE_AI=1)"); return { moduleOn: true, configured: false }; }
    if (!r.ok) { log.warn("AI: not configured (" + r.reason + ")"); return { moduleOn: true, configured: false }; }
    const d = provider.describe(r);
    const on = FEATURE_IDS.filter((id) => featureState(id, { cfg, mods }).state === "on");
    const models = Object.entries(d.models).filter(([k]) => k === "default" || (d.models[k] !== d.models.default && k !== "test" && k !== "assistant")).map(([k, v]) => `${k}=${v}`).join(", ");
    log.log(`AI: ENABLED · provider=${d.providerId} · protocol=${d.protocol} · url=${d.url} · models: ${models} · features: ${on.join(", ") || "(none)"}`);
    if (d.legacy) log.log("AI: using the legacy fields (anthropicApiKey / geminiApiKey / aiModel) — consider moving to ai.provider (HANDOVER-IT §10).");
    for (const w of d.warnings) {
      if (w === "legacy_fields_ignored") log.log("AI: ai.provider is set — the legacy anthropicApiKey / geminiApiKey / aiModel fields and ANTHROPIC_API_KEY / GEMINI_API_KEY are ignored.");
      else if (w.startsWith("query_param_looks_secret:")) log.warn(`AI: query parameter "${w.split(":")[1]}" looks like a secret — use ai.provider.auth or headers instead.`);
    }
    return { moduleOn: true, configured: true };
  }

  return {
    CATALOG, FEATURE_IDS, NOTICE_VERSIONS, VERSIONS,
    featureState, stateResponse, featureEnabled, meAi, status, usage, call, recordLocal, rateHit,
    checkConfigChange, configSummary, retentionSweep, startupLog, budgetState, pseudonym, retentionDays,
    gradingPool, limits: () => limitsFrom(readConfig()),
  };
}

module.exports = { createAiService, CATALOG, NOTICE_VERSIONS, monthKey, monthStartIso };
