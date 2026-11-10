#!/usr/bin/env node
// AI 连通性检查（HANDOVER-IT §10.5 第 4 步）：不需要登录、不写数据库，对 ai.models 中每个不同的模型各调用一次
// （含结构化输出测试），打印协议、解析后的地址、请求的模型与实际返回的模型、耗时、token 用量、结构化输出是否可用。
// 全部成功时退出码 0。它会产生真实调用，按网关计费。输出不含密钥、请求头与查询参数的值。
//
//   runtime\node.exe scripts\ai-check.js                          用当前命令行的环境变量
//   runtime\node.exe scripts\ai-check.js --service DigiPlusTMS    读 nssm 服务的 AppEnvironmentExtra（只在内存中使用、不打印）
//   runtime\node.exe scripts\ai-check.js --config D:\tms\config.json   指定 config.json（缺省：LMS_CONFIG_PATH 或仓库根目录的 config.json）
//
// 命令行环境与服务环境不同（缺密钥、证书、代理变量）时，检查结果可能与服务不一致：以后台「系统设置 › AI 治理 › 连接测试」为准。
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const provider = require("../modules/ai/provider.js");
const { TEST_SCHEMA, TEST_SYSTEM } = require("../modules/ai/prompts.js");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}
function readCfg(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    if (e.code === "ENOENT") return {};
    console.error(`config.json 无法解析 / cannot parse ${file}（位置见编辑器提示，这里不回显内容以免泄露密钥）`);
    process.exit(2);
  }
}
// nssm get <服务名> AppEnvironmentExtra → { KEY: value }；值只放进内存里的 env，不打印
function serviceEnv(name) {
  let out = "";
  try { out = execFileSync("nssm", ["get", name, "AppEnvironmentExtra"], { encoding: "utf16le", stdio: ["ignore", "pipe", "ignore"] }); }
  catch {
    try { out = execFileSync("nssm", ["get", name, "AppEnvironmentExtra"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { console.error(`读不到服务 ${name} 的环境变量（需要管理员权限的命令行，且 nssm 在 PATH 中）。/ Cannot read the service environment.`); process.exit(2); }
  }
  const env = {};
  for (const line of out.replace(/\u0000/g, "").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

(async () => {
  const cfgFile = arg("--config") || process.env.LMS_CONFIG_PATH || path.join(__dirname, "..", "config.json");
  const cfg = readCfg(cfgFile);
  const svc = arg("--service");
  const env = svc ? { ...process.env, ...serviceEnv(svc) } : { ...process.env };
  const mods = cfg.modules && typeof cfg.modules === "object" ? cfg.modules : {};
  console.log(`config: ${cfgFile}${svc ? ` · service environment: ${svc}` : " · current command-line environment"}`);
  if (mods.ai !== true) console.log("注意 / note: config.json 的 modules 中没有 \"ai\": true —— AI 模块在服务中是关闭的（本检查仍会测试连通性）。");
  if (cfg.ai && cfg.ai.demo === true) console.log("注意 / note: ai.demo 为 true —— 服务处于演示模式，不会调用 AI 服务。");
  const r = provider.resolveProviderConfig(cfg, env);
  if (!r.ok) {
    console.log(`未接入 / not configured: ${r.reason}`);
    if (r.reason === "no_key") console.log(svc ? "服务环境里没有读到密钥（apiKeyEnv 指向的变量，缺省 LMS_AI_API_KEY），config.json 里也没有 ai.provider.apiKey。" : "当前命令行没有密钥变量：若密钥只设在服务环境里，请加 --service <服务名> 重跑，或以后台连接测试为准。");
    if (r.reason === "tls_verification_disabled") console.log("检测到 NODE_TLS_REJECT_UNAUTHORIZED=0：请删除该变量（见 HANDOVER-IT §10.9）。");
    process.exit(1);
  }
  const d = provider.describe(r);
  console.log(`provider: ${d.providerId} · protocol: ${d.protocol}${d.legacy ? " (legacy fields)" : ""}`);
  console.log(`url: ${d.url}`);
  console.log(`auth: ${d.auth} · key: ${d.keyConfigured ? "configured (" + d.keySource + ")" : "none"} · headers: ${d.headerNames.join(", ") || "none"} · query params: ${d.queryNames.join(", ") || "none"} · proxy: ${d.proxyHost || "none"} · client cert: ${d.clientCert ? "yes" : "no"}`);
  for (const w of d.warnings) console.log("warning: " + w);
  const models = [...new Set(Object.entries(r.models).filter(([k]) => k !== "test").map(([, v]) => v).filter(Boolean))];
  let failed = 0;
  for (const model of models) {
    const t0 = Date.now();
    try {
      const out = await provider.callModel(r, { feature: "test", model, system: TEST_SYSTEM, messages: [{ role: "user", content: "ping" }], schema: TEST_SCHEMA }, {
        log: (l) => { if (l.event !== "ok") console.log(`  [${l.event}] status=${l.status || "-"} ${l.upstreamType ? "type=" + l.upstreamType : ""} ${l.code || ""}`.trimEnd()); },
      });
      console.log(`OK   ${model} → ${out.modelReturned || "(not reported)"} · ${Date.now() - t0} ms · tokens ${out.usage.in}/${out.usage.out}${out.usage.estimated ? " (estimated)" : ""} · structured output: ${out.json && out.json.ok === true ? "yes" : "no"}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${model} · ${e.code || e.message}${e.reason ? " · " + e.reason : ""}${e.redirectHost ? " → " + e.redirectHost : ""}${e.httpStatus ? " · HTTP " + e.httpStatus : ""} · ${Date.now() - t0} ms`);
    }
  }
  console.log(failed ? `${failed} of ${models.length} model(s) failed — see HANDOVER-IT §10.9` : `all ${models.length} model(s) OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(2); });
