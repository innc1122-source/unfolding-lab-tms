// 上线前测试 CX-093 / CX-094（10/11）：
//   CX-093 本人自助改密后，同账号其他设备上的会话作废（当前这台保留），审计 auth.sessions_revoked { reason: "password_change" }；
//   CX-094 页面外壳（.html）响应 Cache-Control: no-store，浏览器不把它放进前进后退缓存，退出登录后「后退」看不到上一位用户的页面。
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin;
before(async () => { srv = await startServer(); admin = await loginAs(srv.base, ADMIN); });
after(async () => { if (srv) await srv.stopAsync(); });

test("CX-093: changing one's own password signs out the other sessions, keeps this one, and is audited", async () => {
  const { data: made } = await admin.post("/api/admin/employees", { name: "Two Devices", employeeId: "TD-1" });
  const a = await loginAs(srv.base, { employeeId: "TD-1", password: made.password });
  const b = await loginAs(srv.base, { employeeId: "TD-1", password: made.password });
  assert.equal((await b.get("/api/me")).status, 200, "second device signed in");
  const ch = await a.post("/api/auth/change-password", { currentPassword: made.password, newPassword: "two-devices-1a" });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  assert.equal((await a.get("/api/me")).status, 200, "the device that changed the password stays signed in");
  assert.equal((await b.get("/api/me")).status, 401, "the other device is signed out");
  const au = (await admin.get("/api/admin/audit?action=auth.sessions_revoked")).data;
  const rows = Array.isArray(au) ? au : au.rows || au.items || [];
  assert.ok(rows.some((r) => r.target === "TD-1" && /password_change/.test(JSON.stringify(r))), "audited: " + JSON.stringify(rows.slice(0, 3)));
});

test("CX-094: the app shell is served with Cache-Control: no-store (not kept in the back/forward cache)", async () => {
  for (const p of ["/", "/next/"]) {
    const r = await fetch(srv.base + p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get("cache-control"), "no-store", p);
  }
  const asset = await fetch(srv.base + "/api/env");
  assert.equal(asset.status, 200);
});
