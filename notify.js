// notify.js — in-app notifications + the pluggable email hook, shared between
// server.js and the scheduled jobs (scripts/notify-due.js). Extracted from
// server.js so a cron job sends email through the exact same path as the live
// server: before this split, notify-due.js wrote store.createNotification()
// directly, so a configured email provider still never sent a single mail.
// CommonJS, zero dependencies (global fetch), same directory as server.js.
//
// Email delivery is OFF until config.json has an "email" block, e.g.:
//   { "email": { "provider": "resend", "apiKey": "re_…",
//                "from": "Unfolding Lab <noreply@unfolding-lab.example>" } }  (见 config.json.example)
// With it, every notification is also emailed to the user's address; without a
// config, notifications are in-app only.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store.js");

// LMS_CONFIG_PATH points at an alternate config.json (tests inject throwaway
// configs this way; multi-tenant deployments can share one install). Unset =
// the original behavior: config.json next to server.js — this file lives in
// the same directory, so __dirname resolves to the same place.
function configPath() {
  return process.env.LMS_CONFIG_PATH || path.join(__dirname, "config.json");
}
// One whole config.json feeds品牌配色 / 邮件 / AI key / Lark / modules 开关，and every
// one of those readers treats "{}" as "not configured" — so a config that fails to
// PARSE used to make all of them vanish at once, silently. Two fixes here:
//
//  1) BOM tolerance. `Set-Content -Encoding utf8` (PowerShell 5.1) and several
//     editors write a UTF-8 BOM; readFileSync(…, "utf8") decodes those three bytes
//     into a leading U+FEFF that JSON.parse rejects outright. The user's file is
//     perfectly good JSON — only the byte-order mark is in the way — so strip it.
//     Only the leading one: a U+FEFF anywhere else is genuinely malformed.
//  2) No more silent {}. A parse failure now logs one warning naming the file.
//
// ⚠ The warning must NEVER include the parser's own message or the file text.
// V8 quotes ~20 characters of source around the error, e.g.
//   Unexpected token 'r', ...""apiKey": re_superse"... is not valid JSON
// and this file holds the Resend API key, the AI key and the Lark app secret —
// that snippet in a log is a leaked credential. Only the byte offset is echoed
// (a number can't carry a secret) and it's what the user needs to find the typo.
//
// Throttled by message so a broken config warns once, not once per notification;
// a successful read re-arms it, so the next break is reported again.
let lastConfigWarn = null;
function warnConfig(msg) {
  if (lastConfigWarn === msg) return;
  lastConfigWarn = msg;
  console.warn("[config] " + msg);
}
function readConfig() {
  const p = configPath();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    // No file at all = the supported zero-config install, not an error: stay quiet.
    // Anything else (permissions, a directory in its place) is worth saying out loud.
    if (e && e.code !== "ENOENT") warnConfig("cannot read " + p + " (" + (e.code || "unknown error") + "); running with no config");
    return {};
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // UTF-8 BOM
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const at = /position (\d+)/.exec(String((e && e.message) || ""));
    warnConfig("failed to parse " + p + (at ? " at byte offset " + at[1] : "") +
      " — brand/email/AI/Lark settings are ALL being ignored until it is valid JSON (tip: check for a trailing comma; a UTF-8 BOM is tolerated)");
    return {};
  }
  // "null" / "[]" / '"x"' parse fine but are not a config object; every caller does
  // readConfig().something, and readConfig() returning null would throw at the dot.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnConfig(p + " is valid JSON but not an object — ignoring it");
    return {};
  }
  lastConfigWarn = null;
  return parsed;
}
// Is email delivery actually WORKING-configured? Callers that promise the user
// "check your mailbox" have to ask this first — the self-service password reset
// (/api/auth/forgot) only offers itself when this is true, because an endpoint
// that always answers "we've sent a link" with no mailer behind it is a promise
// nobody keeps. Stricter than sendEmail()'s own guard on purpose: a provider with
// an empty apiKey or no from-address is a half-filled config, not a mailer, and
// this flag decides whether a whole UI entry point appears. sendEmail() stays
// lenient (provider alone is enough) so the pre-existing notification hook keeps
// its exact old behaviour.
function emailConfigured() {
  const cfg = readConfig().email;
  return !!(cfg && cfg.provider && cfg.apiKey && cfg.from);
}

async function sendEmail(to, subject, html) {
  const cfg = readConfig().email;
  if (!cfg || !cfg.provider || !to) return { skipped: true };
  // LMS_EMAIL_SINK is a TEST seam (same family as LMS_DISABLE_AI / LMS_FAKE_NOW):
  // when set, the message is appended to that file as one JSON line instead of
  // being handed to the provider, so a test can assert on what WOULD have gone
  // out — no API key, no network call, no mail to a real person. Placed AFTER the
  // config guard so "no email block = no mail at all" still holds. Never set in
  // production: the sink file is plaintext mail, including password-reset links.
  const sink = process.env.LMS_EMAIL_SINK;
  if (sink) {
    try { fs.appendFileSync(sink, JSON.stringify({ at: new Date().toISOString(), to, subject, html }) + "\n"); } catch { /* a test seam must never break the caller */ }
    return { ok: true, sink: true };
  }
  try {
    if (cfg.provider === "resend") {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: "Bearer " + cfg.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ from: cfg.from, to, subject, html }),
      });
      return { ok: r.ok, status: r.status };
    }
    // Other providers (sendgrid / mailgun / smtp-bridge …) plug in here later.
    return { skipped: true, reason: "unknown provider: " + cfg.provider };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}
const escHtml = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// Create an in-app notification, then fire the (optional) email hook.
// (Same id shape server.js used: "n-" + 10 hex chars.)
function notify(userId, n) {
  if (!userId || !n || !n.title) return;
  try {
    store.createNotification({
      id: "n-" + crypto.randomBytes(5).toString("hex"), userId, type: n.type || "info",
      title: n.title, title_zh: n.title_zh, body: n.body, body_zh: n.body_zh, link: n.link,
    });
  } catch { /* never let a notification failure break the main action */ }
  const u = store.getUserById(userId);
  if (u && u.email) {
    const { subject, html } = bilingualMail(n);
    sendEmail(u.email, subject, html).catch(() => {});
  }
}
// 邮件中英双语、中文在前（IA B-S11、D-18 ①）：服务端不保存用户语言，马尼拉的员工也会收到这封邮件。
// 主题「中文 / English」，两种一样时只写一次；正文先整段中文，再整段英文。站内通知仍按界面语言显示（不经这里）。
function bilingualMail(n) {
  const zhT = n.title_zh || n.title, enT = n.title || n.title_zh;
  const zhB = n.body_zh || n.body || "", enB = n.body || n.body_zh || "";
  const subject = zhT === enT ? zhT : `${zhT} / ${enT}`;
  const block = (t, b) => `<p><strong>${escHtml(t)}</strong></p>` + (b ? `<p>${escHtml(b)}</p>` : "");
  const html = (zhT === enT && zhB === enB)
    ? block(zhT, zhB)
    : block(zhT, zhB) + '<hr style="border:none;border-top:1px solid #e5e6eb;margin:16px 0">' + block(enT, enB);
  return { subject, html };
}

module.exports = { notify, sendEmail, escHtml, readConfig, configPath, emailConfigured, bilingualMail };
