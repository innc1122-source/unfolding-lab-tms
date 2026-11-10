// 通知邮件中英双语（批次 3 S5；IA B-S11、D-18 ①，计划 R-1011）：主题「中文 / English」，正文先中文、后英文；站内通知仍按界面
// 语言显示（title / title_zh 分列）。经真实服务端触发：发起评估周期时给参与者发「请提交自评」通知（IA B-F07），邮件写进
// LMS_EMAIL_SINK（测试缝，不发真邮件）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADMIN, startServer, loginAs, tempDir } = require("./helpers.js");

let srv, admin, sink;
test.before(async () => {
  const dir = tempDir("lms-notify2-");
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ email: { provider: "resend", apiKey: "re_test_fake_key", from: "TMS <noreply@example.com>" } }));
  sink = path.join(dir, "mail.jsonl");
  srv = await startServer({ env: { LMS_CONFIG_PATH: cfg, LMS_EMAIL_SINK: sink } });
  admin = await loginAs(srv.base, ADMIN);
});
test.after(() => srv && srv.stop());

async function waitMail(to) {
  for (let i = 0; i < 50; i++) {
    const lines = fs.existsSync(sink) ? fs.readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const hit = lines.filter((m) => m.to === to);
    if (hit.length) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no mail for " + to);
}

test("notify bilingual: the mail subject reads Chinese / English and the body carries both languages, Chinese first; the in-app notice keeps the two languages apart", async () => {
  const c = await admin.post("/api/admin/employees", { name: "Mail Person", employeeId: "NB-0001", email: "nb0001@example.com", jobLevel: "P3" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "NB-0001");
  const r = await admin.post("/api/admin/review-cycles", { name: "2026-H2", dueAt: "2026-12-15", userIds: [u.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [mail] = await waitMail("nb0001@example.com");
  assert.equal(mail.subject, "请在 2026-12-15 前提交「2026-H2」自评 / Please submit your self-review for 2026-H2 by 2026-12-15");
  const zhAt = mail.html.indexOf("评估周期「2026-H2」已发起"), enAt = mail.html.indexOf("The review cycle 2026-H2 has started");
  assert.ok(zhAt >= 0 && enAt > zhAt, "Chinese block first, English block second: " + mail.html);
  // 站内通知：两种语言分列，界面按语言取一种
  const emp = await loginAs(srv.base, { employeeId: "NB-0001", password: c.data.password });
  // 临时密码账号先改密（否则除改密外的接口都被拦下）
  assert.equal((await emp.post("/api/auth/change-password", { currentPassword: c.data.password, newPassword: "Mail-pass-2026" })).status, 200);
  const n =(await emp.get("/api/me/notifications")).data;
  const list = Array.isArray(n) ? n : (n.items || n.notifications || []);
  const rv = list.find((x) => x.type === "review");
  assert.ok(rv, "the review notice is in the bell");
  assert.equal(rv.title_zh, "请在 2026-12-15 前提交「2026-H2」自评");
  assert.equal(rv.title, "Please submit your self-review for 2026-H2 by 2026-12-15");
});

test("notify bilingual: the helper writes one block when both languages are the same text", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "notify.js"), "utf8");
  assert.match(src, /const subject = zhT === enT \? zhT : `\$\{zhT\} \/ \$\{enT\}`;/);
  assert.match(src, /const \{ subject, html \} = bilingualMail\(n\);/);
});

test("notify bilingual: an appeal submit notice (第二批 2.8) has distinct English and Chinese title and body, and the mail carries both", async () => {
  const mk = async (employeeId, name, extra) => {
    const c = await admin.post("/api/admin/employees", { name, employeeId, email: employeeId.toLowerCase() + "@example.com", jobLevel: "P3", ...(extra || {}) });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === employeeId);
    const cl = await loginAs(srv.base, { employeeId, password: c.data.password });
    assert.equal((await cl.post("/api/auth/change-password", { currentPassword: c.data.password, newPassword: employeeId + "-pass-2026" })).status, 200);
    return { u, cl };
  };
  const m = await mk("NB-MGR", "Mail Manager");
  const e = await mk("NB-APL", "Mail Appellant");
  assert.equal((await admin.put("/api/admin/employees/" + e.u.id, { managerId: m.u.id })).status, 200);
  const r = await admin.post("/api/admin/review-cycles", { name: "2026-Q3 NB", dueAt: "2026-12-15", userIds: [e.u.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const item = (await admin.get("/api/admin/review-cycles/" + r.data.cycle.id)).data.items[0].id;
  assert.equal((await e.cl.post("/api/me/reviews/" + item + "/self", { outcomes: ["done"], challenges: "", feedback: "more syncs", goalsNext: ["next"] })).status, 200);
  assert.equal((await m.cl.post("/api/me/reviews/" + item + "/manager", { rating: "B", text: "ok", oneOnOneDone: true })).status, 200);
  assert.equal((await admin.post("/api/admin/review-cycles/" + r.data.cycle.id + "/close", {})).status, 200);
  const sub = await e.cl.post("/api/me/reviews/" + item + "/appeal", { reason: "I disagree with the final rating; please review the extra project work I delivered this quarter." });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  const list = (await e.cl.get("/api/me/notifications")).data.items;
  const n = list.find((x) => x.type === "review_appeal");
  assert.ok(n, "the appeal confirmation is in the bell");
  assert.ok(n.title && n.title_zh && n.body && n.body_zh, JSON.stringify(n));
  assert.notEqual(n.title, n.title_zh);
  assert.notEqual(n.body, n.body_zh);
  assert.match(n.title_zh, /[一-鿿]/);
  assert.doesNotMatch(n.title, /[一-鿿]/, "the English title has no Chinese");
  const mails = await waitMail("nb-apl@example.com");
  const mail = mails.find((x) => x.subject.includes(n.title_zh));
  assert.ok(mail, "mail subject carries the Chinese title: " + JSON.stringify(mails.map((x) => x.subject)));
  assert.equal(mail.subject, n.title_zh + " / " + n.title);
});
