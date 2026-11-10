// Lark 首次登录自动建号的「操作人」：浏览器里残留着别人的会话 cookie 时，employee.hired 事件与
// auth.lark.jit 审计仍记为系统（actorId null），不借用那个会话。
//
// 为什么会残留：Lark 把浏览器 302 回 /api/auth/lark/callback 是顶层 GET，SameSite=Lax 的 sid cookie
// 照样带上。handleApi 入口按 cookie 解析出的 user 是**那个人**（测 Lark 登录的 HR 管理员、共用电脑上
// 没退出的上一个人），回调分支以前不重置上下文，于是新账号的 employee.hired 记成了他建的。
//
// 真服务 + 一次性库（helpers.startServer）+ 临时 config（lark.appId/appSecret），永不碰 lms.db /
// 根目录 config.json。测试环境没有外网：子进程用 NODE_OPTIONS=--require 预加载一个只拦
// open.larksuite.com 的 fetch 桩（测试侧文件，写在系统临时目录；服务端代码没有为此加任何测试缝）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { startServer, ADMIN, tempDir } = require("./helpers.js");

let srv, dir;
const LARK_USER = { name: "Lara Lark", union_id: "on_test_jit_actor", open_id: "ou_test_jit_actor", user_id: "LKJIT-001", email: "" };

before(async () => {
  dir = tempDir("lark-jit-");
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ lark: { appId: "cli_test_only", appSecret: "test-only-secret", redirectUri: "http://127.0.0.1/api/auth/lark/callback" } }));
  const stub = path.join(dir, "lark-fetch-stub.js");
  fs.writeFileSync(stub, [
    '"use strict";',
    "const realFetch = globalThis.fetch;",
    `const USER = ${JSON.stringify(LARK_USER)};`,
    "globalThis.fetch = async (url, init) => {",
    "  const u = String(url);",
    '  if (!u.startsWith("https://open.larksuite.com/")) return realFetch(url, init);',
    '  const body = u.includes("/auth/v3/app_access_token/") ? { code: 0, app_access_token: "t-app" }',
    '    : u.includes("/authen/v1/oidc/access_token") ? { code: 0, data: { access_token: "t-user" } }',
    "    : { code: 0, data: USER };",
    '  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });',
    "};",
    "",
  ].join("\n"));
  // NODE_OPTIONS 里双引号内的反斜杠会被当成转义符：路径一律写成正斜杠（Windows 同样认）。
  srv = await startServer({ env: { LMS_CONFIG_PATH: cfgPath, NODE_OPTIONS: `--require "${stub.replace(/\\/g, "/")}"` } });
});
after(() => { if (srv) srv.stop(); });

const rows = (sql, ...args) => { const db = new DatabaseSync(srv.dbPath, { readOnly: true }); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
const sidOf = (res) => { for (const c of res.headers.getSetCookie()) { const m = c.match(/^sid=([^;]*)/); if (m) return m[1]; } return null; };

test("Lark first sign-in with someone else's session cookie still in the browser: employee.hired and auth.lark.jit are recorded as the system (actorId null)", async () => {
  // 同一浏览器里先登着超管。
  const login = await fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN) });
  assert.equal(login.status, 200);
  const adminSid = sidOf(login);
  assert.ok(adminSid);
  const cookie = { cookie: "sid=" + adminSid };
  // 点「用 Lark 登录」：拿到 state。
  const start = await fetch(srv.base + "/api/auth/lark/start", { headers: cookie, redirect: "manual" });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  assert.ok(state);
  // Lark 把浏览器带回回调，cookie 里仍是超管的 sid。
  const cb = await fetch(`${srv.base}/api/auth/lark/callback?code=test-code&state=${encodeURIComponent(state)}`, { headers: cookie, redirect: "manual" });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/", "signed in (not bounced to the login page with an error)");
  assert.ok(sidOf(cb) && sidOf(cb) !== adminSid, "a fresh session for the new account");

  const [u] = rows("SELECT id, employeeId, larkUserId FROM users WHERE employeeId = ?", LARK_USER.user_id);
  assert.ok(u, "the account was auto-created");
  assert.equal(u.larkUserId, LARK_USER.union_id);
  const hired = rows("SELECT actorId, type, data FROM event_outbox WHERE subjectUserId = ?", u.id);
  assert.deepEqual(hired.map((e) => e.type), ["employee.hired"]);
  assert.equal(hired[0].actorId, null, "not the super-admin whose cookie rode along");
  const jit = rows("SELECT actorId, actorName FROM audit_logs WHERE action = 'auth.lark.jit' AND target = ?", u.employeeId);
  assert.equal(jit.length, 1);
  assert.deepEqual([jit[0].actorId, jit[0].actorName], [null, null], "the audit row is the system's too");
  // 登录本身照常记在新账号名下（auditAuth 的 actor 是登录的人）。
  const signin = rows("SELECT actorId FROM audit_logs WHERE action = 'auth.login' AND target = ? ORDER BY id DESC LIMIT 1", u.employeeId);
  assert.equal(signin[0].actorId, u.id);
});
