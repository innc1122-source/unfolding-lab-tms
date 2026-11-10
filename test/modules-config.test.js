// 后台「功能模块」开关页的接口（负责人 9/28 决定，取代 AI 治理方案 8.3「开关只在配置文件」）：
// GET/PUT /api/admin/modules-config —— 只限超级管理员；写回 config.json（原子写、其它键原样保留）；每次修改记审计；
// 不接受密钥类字段；LMS_MODULES_OFF 强制关闭的模块只读显示。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, EMPLOYEE, startServer, loginAs, tempDir } = require("./helpers.js");

let srv, admin, cfgFile;
const ORIGINAL = { brand: { name: "Acme Test" }, lark: { appId: "cli_x", appSecret: "LARK-SECRET-KEEP" }, ai: { provider: { id: "gw", protocol: "openai-chat", baseUrl: "https://ai.example/v1", apiKey: "AI-KEY-KEEP" }, models: { default: "m" } }, culture: { raterKey: "RATER-KEY-KEEP-0123456789" } };
before(async () => {
  const dir = tempDir("modcfg-");
  cfgFile = path.join(dir, "config.json");
  fs.writeFileSync(cfgFile, "﻿" + JSON.stringify(ORIGINAL, null, 2));
  srv = await startServer({ env: { LMS_CONFIG_PATH: cfgFile, LMS_MODULES_OFF: "performance" } });
  admin = await loginAs(srv.base, ADMIN);
});
after(async () => { await srv.stopAsync(); });

test("modules-config: super admin reads the four modules and the AI features; everyone else gets 403", async () => {
  const r = await admin.get("/api/admin/modules-config");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.modules.map((m) => m.id), ["learning", "performance", "talent", "ai"]);
  const byId = Object.fromEntries(r.data.modules.map((m) => [m.id, m]));
  assert.equal(byId.performance.forcedOff, true, "LMS_MODULES_OFF shows as forced off");
  assert.equal(byId.performance.on, false);
  assert.equal(byId.ai.defaultOn, false);
  assert.deepEqual(r.data.ai.features.map((f) => [f.id, f.enabled]), [["assistant", true], ["questionGen", true], ["grading", true], ["portrait", false], ["translate", true], ["talentFilter", true]]);  // translate：AI 翻译（2026-10-06）；talentFilter：人才筛选条件生成（第 5 批，默认开启）
  assert.ok(!JSON.stringify(r.data).includes("AI-KEY-KEEP") && !JSON.stringify(r.data).includes("RATER-KEY"), "no secrets in the payload");
  const emp = await loginAs(srv.base, EMPLOYEE);
  assert.equal((await emp.get("/api/admin/modules-config")).status, 403);
  const role = await admin.post("/api/admin/roles", { name: "Auditor Mods", name_zh: "审计", grants: { audit: "manage", fields: "manage", brand: "manage" } });
  const { data: c } = await admin.post("/api/admin/employees", { name: "Mods Aud", employeeId: "DP-MODS" });
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "DP-MODS");
  await admin.put("/api/admin/employees/" + u.id, { adminRoleId: role.data.role.id });
  const a2 = await loginAs(srv.base, { employeeId: "DP-MODS", password: c.password });
  await a2.post("/api/auth/change-password", { currentPassword: c.password, newPassword: "mods-pass-12" });
  assert.equal((await a2.get("/api/admin/modules-config")).status, 403);
  assert.equal((await a2.put("/api/admin/modules-config", { modules: { ai: true } })).status, 403);
});

test("modules-config PUT: writes only the modules block and ai.features, keeps every other key (secrets included), audits, and takes effect on the next request", async () => {
  const r = await admin.put("/api/admin/modules-config", { modules: { ai: true, talent: false }, aiFeatures: { portrait: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  assert.deepEqual(cfg.modules, { ai: true, talent: false });
  assert.deepEqual(cfg.ai.features, { portrait: true });
  assert.equal(cfg.lark.appSecret, "LARK-SECRET-KEEP");
  assert.equal(cfg.ai.provider.apiKey, "AI-KEY-KEEP");
  assert.equal(cfg.culture.raterKey, "RATER-KEY-KEEP-0123456789");
  assert.equal(cfg.brand.name, "Acme Test");
  const me = (await admin.get("/api/me")).data;
  assert.equal(me.modules.ai, true);
  assert.equal(me.modules.talent, false);
  assert.equal((await admin.get("/api/admin/talent-review")).status, 404, "talent routes close at once");
  const audit = (await admin.get("/api/admin/audit")).data;
  const rows = (audit.rows || audit.items || audit).filter((x) => x.action === "module.config.change");
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes("AI-KEY-KEEP"));
  // 未知模块、非布尔值、未知 AI 功能：400，文件不动
  const before = fs.readFileSync(cfgFile, "utf8");
  assert.equal((await admin.put("/api/admin/modules-config", { modules: { core: false } })).data.code, "unknown_module");
  assert.equal((await admin.put("/api/admin/modules-config", { modules: { ai: "yes" } })).data.code, "bad_value");
  assert.equal((await admin.put("/api/admin/modules-config", { aiFeatures: { apiKey: true } })).data.code, "unknown_feature");
  assert.equal(fs.readFileSync(cfgFile, "utf8"), before);
  // 恢复
  await admin.put("/api/admin/modules-config", { modules: { talent: true } });
});
