"use strict";
// HTTP 请求辅助（简化 10/11 从 server.js 抽出，函数与注释原样搬）：https 判定、Cookie 解析、客户端 IP、登录限流键。纯函数。

function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }
// CX-041（2026-10-09 验收）：经反向代理的 https 请求（x-forwarded-proto）或直接 TLS 连接也给会话 cookie 加 Secure；本地 http 开发不加。
function requestIsHttps(req) {
  const xf = String((req && req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim().toLowerCase();
  return xf === "https" || !!(req && req.socket && req.socket.encrypted);
}
// Cookie values are attacker-controlled, and decodeURIComponent throws on a
// malformed escape ("Cookie: sid=%"). Since S1 the /videos/* gate calls this
// from serveStatic — which, unlike handleApi, is not wrapped in a promise
// catch — so a throw here took the process down (对抗复核实测). A cookie we
// cannot decode is simply not a session token: keep the raw value, never throw.
function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}
function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=").map(safeDecode)).filter((p) => p[0])
  );
}
// Real client IP for login-lockout keying. X-Forwarded-For is client-spoofable,
// so we only trust it when the DIRECT peer is our own reverse proxy on loopback
// (Caddy runs on the same host). Then the RIGHTMOST XFF entry is the address our
// proxy actually observed and appended — the leftmost is attacker-controlled.
function clientIp(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || "unknown";
  const isLoopback = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
  if (isLoopback) {
    const parts = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return socketIp;
}
function loginKey(req, employeeId) {
  return String(employeeId || "").trim().toLowerCase() + "|" + clientIp(req);
}

module.exports = { normalizeEmail, requestIsHttps, safeDecode, parseCookies, clientIp, loginKey };
