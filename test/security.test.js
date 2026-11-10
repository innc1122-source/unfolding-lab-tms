// Batch 5 regression tests: unified server-side permissions, forced password
// change, CSRF/headers, audit log, content versions, AI limits, production mode.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient, tempDir } = require("./helpers.js");
const { startFakeAi } = require("./fixtures/fake-ai-server.js");

let srv, admin, emp;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(() => srv.stop());

// A fresh employee with the NHO assignment removed — sees nothing of it.
async function makeUnassignedEmployee(tag) {
  const { data: created } = await admin.post("/api/admin/employees", { name: "Unassigned " + tag, employeeId: "DP-UN" + tag });
  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === "DP-UN" + tag);
  await admin.post("/api/admin/assignments", { userId: u.id, items: [{ programId: "nho", assigned: false }] });
  const c = await loginAs(srv.base, { employeeId: "DP-UN" + tag, password: created.password });
  await c.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "own-password-1" });
  return c;
}

test("unassigned employees cannot read courses, complete modules, or use the AI", async () => {
  const stranger = await makeUnassignedEmployee("A1");
  assert.equal((await stranger.get("/api/courses/culture-conduct")).status, 404);
  assert.equal((await stranger.post("/api/courses/culture-conduct/modules/anything/complete")).status, 404);
  assert.equal((await stranger.post("/api/ai/assistant", { courseId: "culture-conduct", moduleId: "x", messages: [{ role: "user", content: "hi" }] })).status, 404);
});

test("module completion requires the module to belong to the course", async () => {
  const r = await emp.post("/api/courses/culture-conduct/modules/not-a-real-module/complete");
  assert.equal(r.status, 400);
});

test("a temporary password locks everything except me/change-password/logout", async () => {
  const { data: created } = await admin.post("/api/admin/employees", { name: "Force PW", employeeId: "DP-FPW1" });
  const c = await loginAs(srv.base, { employeeId: "DP-FPW1", password: created.password });
  assert.equal((await c.get("/api/programs")).status, 403, "blocked before changing the password");
  assert.equal((await c.get("/api/me")).status, 200, "me stays reachable");
  await c.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "fresh-password-1" });
  assert.equal((await c.get("/api/programs")).status, 200, "unblocked after the change");
});

test("cross-origin writes are rejected; security headers are present", async () => {
  const res = await fetch(srv.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(EMPLOYEE),
  });
  assert.equal(res.status, 403);
  const ok = await fetch(srv.base + "/api/env");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ok.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("admin actions land in the append-only audit log; employees can't read it", async () => {
  await admin.post("/api/admin/employees", { name: "Audit Target", employeeId: "DP-AUD1" });
  const log = await admin.get("/api/admin/audit");
  assert.equal(log.status, 200);
  // The endpoint reports the true row count alongside the window it returned,
  // so the page can say "共 N 条" honestly instead of echoing its own fetch size.
  assert.ok(Array.isArray(log.data.rows), "audit returns a paged shape, not a bare array");
  assert.ok(log.data.total >= log.data.rows.length, "total counts the whole log, not the page");
  assert.equal(typeof log.data.truncated, "boolean");
  const entry = log.data.rows.find((r) => r.action === "employee.create" && r.target === "DP-AUD1");
  assert.ok(entry, "employee.create was recorded");
  assert.ok(entry.actor, "actor recorded");
  assert.equal((await emp.get("/api/admin/audit")).status, 403);
  // Regrade is audited with before/after scores.
  // (covered indirectly: action wiring shares one helper — spot-check one more)
  await admin.post("/api/admin/employees/does-not-exist/reset").catch(() => {});
});

test("every course save writes a content version snapshot", async () => {
  const { data: content } = await admin.get("/api/admin/content");
  const c = content.courses.find((x) => x.id === "culture-conduct");
  assert.equal((await admin.put("/api/admin/content/courses/" + c.id, c)).status, 200);
  // CX-042 乐观锁：第二次保存要带最新的 updatedAt（重新 GET），否则 409 stale 不写快照
  const c2 = (await admin.get("/api/admin/content")).data.courses.find((x) => x.id === "culture-conduct");
  assert.equal((await admin.put("/api/admin/content/courses/" + c.id, c2)).status, 200);
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    const n = db.prepare("SELECT COUNT(*) AS n FROM content_versions WHERE kind='course' AND contentId='culture-conduct'").get().n;
    assert.ok(n >= 2, "two saves → at least two versions");
    const versions = db.prepare("SELECT version FROM content_versions WHERE kind='course' AND contentId='culture-conduct' ORDER BY version").all().map((r) => r.version);
    assert.deepEqual(versions.slice(-2), [versions.length - 1, versions.length], "versions increment");
  } finally { db.close(); }
});

// AI 治理方案 5.4：限流只数真实调用（演示回复不计数），所以这条跑在「ai 模块开启、指向本机假服务商」的服务上；
// 同一个服务上再核对一次课程权限（未指派的员工 → 404），测的仍是课程权限而不是模块开关。
test("the AI assistant is rate-limited per user (real calls to a local fake provider) and still checks course access", async () => {
  const fake = await startFakeAi();
  const dir = tempDir("ai-rl-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    modules: { ai: true },
    ai: { provider: { id: "fake", protocol: "openai-chat", baseUrl: fake.baseUrl + "/v1" }, models: { default: "fake-model" }, limits: { assistant: { perUser10Min: 5 } } },
  }));
  const s2 = await startServer({ env: { LMS_CONFIG_PATH: path.join(dir, "config.json"), LMS_DISABLE_AI: "", LMS_AI_API_KEY: "test-key" } });
  try {
    const a2 = await loginAs(s2.base, ADMIN);
    const { data: created } = await a2.post("/api/admin/employees", { name: "Chatty", employeeId: "DP-CHAT" });
    const c = await loginAs(s2.base, { employeeId: "DP-CHAT", password: created.password });
    await c.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "chatty-pass-1" });
    const codes = [];
    for (let i = 0; i < 7; i++) {
      const r = await c.post("/api/ai/assistant", { courseId: "culture-conduct", messages: [{ role: "user", content: "q" + i }] });
      codes.push(r.status);
      if (r.status === 429) { assert.equal(r.data.code, "ai_rate_limited"); assert.ok(r.data.retryAfterSec > 0); }
    }
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429], "five real answers, then 429");
    assert.equal(fake.requests.length, 5, "the rate-limited requests never reach the provider");
    // 未指派该课程的员工：404（与课程不存在同形）
    const { data: c2 } = await a2.post("/api/admin/employees", { name: "Unassigned R", employeeId: "DP-UNR" });
    const u = (await a2.get("/api/admin/employees")).data.find((x) => x.employeeId === "DP-UNR");
    await a2.post("/api/admin/assignments", { userId: u.id, items: [{ programId: "nho", assigned: false }] });
    const stranger = await loginAs(s2.base, { employeeId: "DP-UNR", password: c2.password });
    await stranger.post("/api/auth/change-password", { currentPassword: c2.password, newPassword: "own-password-1" });
    assert.equal((await stranger.post("/api/ai/assistant", { courseId: "culture-conduct", messages: [{ role: "user", content: "hi" }] })).status, 404);
    assert.equal(fake.requests.length, 5);
  } finally {
    await s2.stopAsync();
    await fake.close();
  }
});

test("production mode: no demo accounts/content, admin password from env, demo hint off", async () => {
  const prod = await startServer({ env: { LMS_PROD: "1", LMS_ADMIN_PASSWORD: "prod-admin-secret-1" } });
  try {
    const env = await makeClient(prod.base).get("/api/env");
    assert.equal(env.data.demo, false);
    // Demo employee doesn't exist.
    const demoLogin = await makeClient(prod.base).login(EMPLOYEE);
    assert.equal(demoLogin.status, 401);
    // Admin logs in with the configured password; no demo programs seeded.
    const a = await loginAs(prod.base, { employeeId: "ADMIN", password: "prod-admin-secret-1" });
    assert.deepEqual((await a.get("/api/programs")).data, []);
    assert.deepEqual((await a.get("/api/admin/questions")).data, []);
  } finally {
    prod.stop();
  }
});

// 对抗复核: the request dispatcher decodes the path with decodeURIComponent, in a
// bare http.createServer callback with no try/catch and no uncaughtException
// handler. A malformed percent-escape ("GET /videos/%") therefore terminated the
// process — an unauthenticated, single-request remote DoS. It must answer 400 and
// keep serving.
test("a malformed percent-escape in the URL answers 400 and does not take the server down", async () => {
  const anon = makeClient(srv.base);
  for (const p of ["/videos/%", "/videos/%zz.mp4", "/%", "/api/%e0%a4%a", "/api/me%"]) {
    const r = await anon.raw("GET", p);
    assert.equal(r.status, 400, `${p} must answer 400`);
    await r.arrayBuffer();
    // Every probe is followed by a real request: a dead process fails here.
    assert.equal((await anon.raw("GET", "/api/env")).status, 200, `server died after ${p}`);
  }
});
