// config.json 的读取韧性：UTF-8 BOM 容忍 + 解析失败不再静默。
//
// 为什么值得一个独立文件：config.json 是**单一文件多租户** —— 品牌配色、邮件
// provider、AI key、Lark app secret、模块开关全在里面，而每一个读取方都把 "{}"
// 当成「没配置」。所以 readConfig() 一旦 JSON.parse 抛错，整份配置**一起消失**
// 且服务照常启动：品牌变回中性默认、邮件静默不发、AI 退回禁用、Lark 不推送 ——
// 四个症状看起来互不相干，没有一条日志指向真正的原因（一个逗号）。
//
// 而踩中它极其容易：PowerShell 5.1 的 `Set-Content -Encoding utf8`(以及若干编辑器
// 的默认保存)会写 UTF-8 BOM，readFileSync(…, "utf8") 把那三个字节解成首字符
// U+FEFF，JSON.parse 直接拒绝 —— 用户看到的是一份**内容完全正确**的文件配置不生效。
//
// 本文件钉住四件事：
//   1. 带 BOM 的 config.json 仍能正确解析（unit 与 HTTP 两个层面各钉一次）；
//   2. 解析失败会在服务端日志里留下一条明确警告（不再静默返回 {}）；
//   3. 那条警告**不含文件内容** —— V8 的 JSON 报错会引用出错处前后约 20 个字符，
//      而这个文件里存的是 API key，把 e.message 原样打出去等于把密钥写进日志。
//      测试往坏配置里埋了一个 canary 密钥，断言它不出现在 stderr 里；
//   4. 文件不存在仍然安静（零配置安装是受支持的用法，不是错误），且同一条警告
//      不会每次调用都刷屏（notify.js 按消息去重）。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ROOT, startServer, makeClient } = require("./helpers.js");

// 埋进坏配置里的假密钥：它只要出现在 stderr 里，就说明日志在泄露文件内容。
const CANARY = "re_canary_must_never_reach_a_log_9f3a";
const BOM = "﻿";

let dir, probe, dbPath;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-cfg-bom-"));
  // 一个探针脚本：加载真正的 notify.js 并调用 readConfig()（可重复 N 次，用来验证
  // 警告去重），把结果打到 stdout、让警告自然落到 stderr。
  // ⚠ 铁律：notify.js → store.js 会打开数据库，所以 LMS_DB_PATH 必须指向临时文件，
  // 绝不能让探针碰到仓库根的 lms.db。
  probe = path.join(dir, "probe.js");
  fs.writeFileSync(probe, [
    'const notify = require(process.argv[2]);',
    'let out = {};',
    'for (let i = 0; i < Number(process.argv[3] || 1); i++) out = notify.readConfig();',
    'process.stdout.write(JSON.stringify(out));',
    '',
  ].join("\n"));
  dbPath = path.join(dir, "probe.db");
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// 写一份配置（raw 文本，按字节写入，好让 BOM 真的进文件）并读回 readConfig() 的结果。
function readConfigWith(raw, opts = {}) {
  const cfgFile = path.join(dir, "cfg-" + Math.random().toString(16).slice(2) + ".json");
  if (raw !== null) fs.writeFileSync(cfgFile, raw, "utf8");
  const r = spawnSync(process.execPath, [probe, path.join(ROOT, "notify.js"), String(opts.times || 1)], {
    env: { ...process.env, LMS_DB_PATH: dbPath, LMS_CONFIG_PATH: cfgFile, LMS_DISABLE_AI: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, "探针不该崩溃（readConfig 任何输入都必须返回一个对象）:\n" + r.stderr);
  return { cfg: JSON.parse(r.stdout || "{}"), stderr: r.stderr, cfgFile };
}

const GOOD = {
  brand: { name: "BOM Corp", tagline: "BOM survived" },
  email: { provider: "resend", apiKey: CANARY, from: "a@b.c" },
  modules: { learning: false },
  anthropicApiKey: CANARY,
};

test("带 BOM 的 config.json 仍能正确解析：与不带 BOM 逐字段等价，且不产生警告", () => {
  const withBom = readConfigWith(BOM + JSON.stringify(GOOD, null, 2));
  const plain = readConfigWith(JSON.stringify(GOOD, null, 2));
  assert.deepEqual(withBom.cfg, GOOD, "BOM 只是字节序标记，不该改变解析结果");
  assert.deepEqual(withBom.cfg, plain.cfg, "带不带 BOM 必须完全等价");
  // 逐块点名：这四块正是「一起消失」的那四样东西。
  assert.equal(withBom.cfg.brand.name, "BOM Corp", "品牌配色/文案还在");
  assert.equal(withBom.cfg.email.apiKey, CANARY, "邮件配置还在");
  assert.equal(withBom.cfg.anthropicApiKey, CANARY, "AI key 还在");
  assert.equal(withBom.cfg.modules.learning, false, "模块开关还在");
  assert.ok(!withBom.stderr.includes("[config]"), "解析成功不该有任何警告:\n" + withBom.stderr);
});

test("BOM 走通整条服务端链路：/api/env 的 brand 与 modules 都来自那份带 BOM 的文件", async () => {
  const cfgFile = path.join(dir, "cfg-live.json");
  fs.writeFileSync(cfgFile, BOM + JSON.stringify({ brand: { name: "BOM Corp", tagline: "BOM survived" }, modules: { learning: false } }, null, 2), "utf8");
  const srv = await startServer({ env: { LMS_CONFIG_PATH: cfgFile } });
  try {
    const env = await makeClient(srv.base).get("/api/env");
    assert.equal(env.status, 200);
    assert.equal(env.data.brand.name, "BOM Corp", "带 BOM 的品牌块必须生效（这正是用户手改文件后『配了没反应』的现场）");
    assert.equal(env.data.brand.tagline, "BOM survived");
    // 模块开关同源同一份文件：BOM 也不能让它退回默认全开。
    const cat = await makeClient(srv.base).get("/api/catalog");
    assert.equal(cat.status, 404, "modules.learning:false 必须生效");
  } finally { srv.stop(); }
});

test("解析失败不再静默：stderr 有一条点名文件的警告，且**不含**文件内容（密钥不进日志）", () => {
  // 故意在 canary 密钥**紧后面**破坏语法：V8 的报错会引用出错点前后约 20 个字符，
  // 所以这是最容易把密钥带进日志的构造。
  const broken = '{\n  "email": { "apiKey": "' + CANARY + '" oops }\n}';
  const r = readConfigWith(broken);
  assert.deepEqual(r.cfg, {}, "坏配置仍然安全降级为空配置（服务不能因为一个逗号起不来）");
  assert.ok(r.stderr.includes("[config]"), "必须有一条警告 —— 静默是这个 bug 的核心:\n" + r.stderr);
  assert.ok(r.stderr.includes("failed to parse"), "警告要说清是解析失败");
  assert.ok(r.stderr.includes(r.cfgFile), "警告要点名是哪个文件（多租户下有多份 config）");
  assert.ok(/byte offset \d+/.test(r.stderr), "给出偏移量，用户才找得到那个逗号");
  assert.doesNotMatch(r.stderr, /canary/i, "警告绝不能引用文件内容 —— 这里面是 API key:\n" + r.stderr);
  assert.ok(!r.stderr.includes(CANARY), "canary 密钥泄露进日志");
});

test("文件不存在保持安静（零配置安装是受支持的用法，不是错误）", () => {
  const r = readConfigWith(null);
  assert.deepEqual(r.cfg, {});
  assert.ok(!r.stderr.includes("[config]"), "缺文件不该报警，否则零配置部署每次请求刷一条:\n" + r.stderr);
});

test("同一条警告只刷一次（按消息去重），且 JSON 合法但不是对象也报警而不是崩溃", () => {
  const many = readConfigWith('{ "brand": }', { times: 3 });
  assert.equal((many.stderr.match(/\[config\]/g) || []).length, 1, "三次读取只该有一条警告:\n" + many.stderr);
  // "null" 是合法 JSON，但 readConfig().brand 会在点号上抛 TypeError —— 旧实现在这里
  // 是直接崩，不是静默；两种都不行。
  const nul = readConfigWith("null");
  assert.deepEqual(nul.cfg, {});
  assert.ok(nul.stderr.includes("not an object"), "要说清「是合法 JSON 但不是对象」:\n" + nul.stderr);
});
