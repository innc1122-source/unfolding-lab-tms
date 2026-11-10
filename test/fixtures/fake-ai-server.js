// 测试用的本地假 AI 服务商（方案 5.4）：同时实现三种协议的端点，记录收到的请求，按队列编排响应。
//
//   const fake = await startFakeAi({ https: false });   // https:true 时用 test/fixtures/ai-tls 的证书
//   fake.baseUrl            → "http://127.0.0.1:<port>"
//   fake.requests           → [{ method, path, headers, body, json }]（请求头与请求体原样记录，用来断言最小化与认证方式）
//   fake.enqueue(spec)      → 下一次请求的响应；队列空时按协议回一个「ok」文本。spec 字段：
//        status            HTTP 状态（默认 200）
//        json              响应体对象（与 text 二选一）
//        text              原样响应体（如 HTML 错误页）
//        contentType       默认 application/json
//        headers           额外响应头（如 { "retry-after": "1" }、{ location: "…" }）
//        delayMs           延迟后再响应
//        hang              永不响应（超时用例）
//        destroy           直接断开连接
//        echo              回显请求体（模拟 LiteLLM / Azure 的 400 在 message 里带请求片段）
//   fake.reply(protocol, text, extra)   按协议构造一份成功响应（extra 可覆盖 stop、usage、model）
//   fake.close()
//
//   const proxy = await startFakeProxy({ mode })   mode: "forward"（默认）| "refuse"（回 407）| "drop"（接受后立即断开）
//   proxy.url → "http://127.0.0.1:<port>"；proxy.connects → 收到的 CONNECT 目标列表
"use strict";
const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");

const TLS_DIR = path.join(__dirname, "ai-tls");

function reply(protocol, text, extra = {}) {
  if (protocol === "anthropic-messages")
    return {
      id: "msg_fake", type: "message", role: "assistant", model: extra.model || "claude-sonnet-5-20260101",
      content: [{ type: "thinking", thinking: "…" }, { type: "text", text }],
      stop_reason: extra.stop || "end_turn",
      ...(extra.noUsage ? {} : { usage: { input_tokens: extra.inTokens || 120, output_tokens: extra.outTokens || 30 } }),
    };
  if (protocol === "openai-chat")
    return {
      id: "chatcmpl-fake", object: "chat.completion", model: extra.model || "gpt-fake-1",
      choices: [{ index: 0, message: { role: "assistant", content: text, ...(extra.refusal ? { refusal: extra.refusal } : {}) }, finish_reason: extra.stop || "stop" }],
      ...(extra.noUsage ? {} : { usage: { prompt_tokens: extra.inTokens || 120, completion_tokens: extra.outTokens || 30 } }),
    };
  return {
    candidates: [{ content: { role: "model", parts: [{ text: "…", thought: true }, { text }] }, finishReason: extra.stop || "STOP" }],
    modelVersion: extra.model || "gemini-fake-001",
    ...(extra.blockReason ? { promptFeedback: { blockReason: extra.blockReason } } : {}),
    ...(extra.noUsage ? {} : { usageMetadata: { promptTokenCount: extra.inTokens || 120, candidatesTokenCount: extra.outTokens || 30, thoughtsTokenCount: 5 } }),
  };
}
function protocolOf(p) {
  if (/\/v1\/messages$/.test(p)) return "anthropic-messages";
  if (/:generateContent$/.test(p)) return "gemini";
  return "openai-chat";
}

async function startFakeAi(opts = {}) {
  const queue = [];
  const requests = [];
  const sockets = new Set();
  const handler = (req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(raw); } catch { /* keep null */ }
      const url = new URL(req.url, "http://x");
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw, json });
      const spec = queue.length ? queue.shift() : {};
      const go = () => {
        if (spec.destroy) { req.socket.destroy(); return; }
        if (spec.hang) return;
        const headers = { "content-type": spec.contentType || "application/json", ...(spec.headers || {}) };
        let body;
        if (spec.echo) body = JSON.stringify({ error: { type: "invalid_request_error", message: "Bad request: " + raw.slice(0, 400) } });
        else if (spec.text !== undefined) body = spec.text;
        else if (spec.json !== undefined) body = JSON.stringify(spec.json);
        else body = JSON.stringify(reply(protocolOf(url.pathname), "ok"));
        res.writeHead(spec.status || 200, headers);
        res.end(body);
      };
      if (spec.delayMs) setTimeout(go, spec.delayMs); else go();
    });
  };
  const server = opts.https
    ? https.createServer({ cert: fs.readFileSync(path.join(TLS_DIR, (opts.cert || "localhost") + ".pem")), key: fs.readFileSync(path.join(TLS_DIR, (opts.cert || "localhost") + ".key")) }, handler)
    : http.createServer(handler);
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  // https 模式按主机名 localhost 连接（证书的 SAN）：监听同一个名字，避免 localhost 先解析到 ::1 而服务只在 127.0.0.1 上。
  const host = opts.https ? "localhost" : "127.0.0.1";
  await new Promise((r) => server.listen(0, host, r));
  const port = server.address().port;
  return {
    port,
    baseUrl: `${opts.https ? "https" : "http"}://${host}:${port}`,
    requests,
    enqueue: (...specs) => { queue.push(...specs); },
    pending: () => queue.length,
    reply,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

async function startFakeProxy(opts = {}) {
  const mode = opts.mode || "forward";
  const connects = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("connect", (req, clientSocket, head) => {
    connects.push({ target: req.url, auth: req.headers["proxy-authorization"] || null });
    if (mode === "refuse") { clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
    if (mode === "drop") { clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); clientSocket.destroy(); return; }
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port, url: `http://127.0.0.1:${port}`, connects,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

module.exports = { startFakeAi, startFakeProxy, reply, TLS_DIR };
