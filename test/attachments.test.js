// Batch 4 regression tests: protected attachments (upload, authorised access)
// and server-side HTML sanitization of course content.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, startServer, loginAs, makeClient } = require("./helpers.js");

let srv, admin, emp;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
});
after(() => srv.stop());

const FAKE_PDF = Buffer.from("%PDF-1.4\n% fake test pdf\n");

test("admin uploads an attachment; assigned employee can fetch it, others cannot", async () => {
  const up = await admin.upload("/api/admin/attachments?name=policy.pdf&courseId=culture-conduct", FAKE_PDF);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.kind, "pdf");
  assert.equal(up.data.originalName, "policy.pdf");
  const url = "/api/attachments/" + up.data.id;

  // Assigned employee: 200 with the right content type and bytes; PDFs are
  // served inline (view-only), never as a download.
  const ok = await emp.raw("GET", url);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /application\/pdf/);
  assert.match(ok.headers.get("content-disposition") || "", /inline/);
  assert.doesNotMatch(ok.headers.get("content-disposition") || "", /attachment/);
  const bytes = Buffer.from(await ok.arrayBuffer());
  assert.equal(bytes.toString(), FAKE_PDF.toString());

  // Anonymous: 401 — the file is NOT reachable without a session.
  const anon = makeClient(srv.base);
  assert.equal((await anon.get(url)).status, 401);

  // Employee without the assignment: 404.
  const { data: created } = await admin.post("/api/admin/employees", { name: "No Access", employeeId: "DP-NOAX" });
  const list = await admin.get("/api/admin/employees");
  const u = list.data.find((x) => x.employeeId === "DP-NOAX");
  await admin.post("/api/admin/assignments", { userId: u.id, items: [{ programId: "nho", assigned: false }] });
  const stranger = await loginAs(srv.base, { employeeId: "DP-NOAX", password: created.password });
  // Clear the forced-password-change gate first (Batch 5), then check access.
  await stranger.post("/api/auth/change-password", { currentPassword: created.password, newPassword: "stranger-pass-1" });
  assert.equal((await stranger.get(url)).status, 404);

  // Office files are never offered as downloads (P0 1.3): they are converted to a
  // view-only PDF on upload, and with no converter the upload is refused before
  // anything is written. The test harness sets LMS_DISABLE_OFFICE_CONVERT=1, which
  // now means "converter not installed", so this path is deterministic whether or
  // not LibreOffice is installed on the host. (Conversion itself is covered by
  // test/office-convert.test.js with the fake soffice, and by the converter-guarded
  // real-LibreOffice test below.)
  const attachDir = path.join(path.dirname(srv.dbPath), "attachments");
  const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
  const filesBefore = listDir(attachDir);
  const doc = await admin.upload("/api/admin/attachments?name=slides.pptx&courseId=culture-conduct", Buffer.from("fake ppt"));
  assert.equal(doc.status, 422, JSON.stringify(doc.data));
  assert.equal(doc.data.code, "office_converter_unavailable");
  assert.match(doc.data.error || "", /LibreOffice/);
  assert.match((doc.data.error || "") + (doc.data.error_zh || ""), /\p{Script=Han}/u, "the message is bilingual");
  assert.deepEqual(listDir(attachDir), filesBefore, "nothing was written to the attachment dir");
  const leftovers = listDir(attachDir + ".convert-tmp").filter((n) => n !== "profiles");
  assert.deepEqual(leftovers, [], "no work dir left behind");
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE originalName = ?").get("slides.pptx").n, 0, "no attachment row");
  } finally { db.close(); }
});

// Locate a LibreOffice/soffice binary the same way server.js does, so the
// conversion test below runs only where a converter is genuinely installed and
// is otherwise skipped — never a false failure on hosts without LibreOffice.
const SOFFICE = (() => {
  // 与 server.js 的 findSoffice() **逐字一致**（那边是权威实现）。不一致会造出一个
  // 什么都没坏的红测试：WOW64 下（32 位进程 / 64 位 Windows）ProgramFiles 与
  // ProgramFiles(x86) 都指向 (x86)，若这里多留一条无条件的 C:\Program Files 字面值，
  // 就会在 server.js 找不到 soffice 的环境里判定「有转换器」，于是测试不跳过、然后失败。
  // 字面值只在两个环境变量都缺失时兜底，而且必须是两条（含 (x86)）。
  const progDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const winDirs = progDirs.length ? progDirs : ["C:\\Program Files", "C:\\Program Files (x86)"];
  return [
    process.env.LMS_SOFFICE, // explicit configuration outranks any guess
    ...winDirs.map((d) => path.join(d, "LibreOffice", "program", "soffice.exe")),
    "/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice",
    "/opt/homebrew/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
})();

test("Office uploads convert to a view-only PDF when a converter is available", {
  skip: SOFFICE ? false : "LibreOffice/soffice not found on this host (on Windows, set LMS_SOFFICE to soffice.exe)",
}, async () => {
  // A fresh server with conversion ENABLED (the shared harness disables it).
  const csrv = await startServer({ env: { LMS_DISABLE_OFFICE_CONVERT: "0" } });
  try {
    const cadmin = await loginAs(csrv.base, ADMIN);
    // Plain text in a .doc is a genuinely convertible Office document — unlike the
    // "fake ppt" bytes above, LibreOffice turns this into a real PDF.
    const up = await cadmin.upload(
      "/api/admin/attachments?name=notes.doc&courseId=culture-conduct",
      Buffer.from("Unfolding Lab learning notes — converted to a view-only PDF."),
    );
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.kind, "pdf", "office file was converted to a PDF");
    assert.equal(up.data.converted, true);

    // Served inline (view-only), never as a download, and the bytes are a real PDF.
    const res = await cadmin.raw("GET", "/api/attachments/" + up.data.id);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/pdf/);
    assert.match(res.headers.get("content-disposition") || "", /inline/);
    assert.doesNotMatch(res.headers.get("content-disposition") || "", /attachment/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-", "served bytes are a real PDF");
  } finally {
    csrv.stop();
  }
});

test("uploads are validated: admin-only, known course, supported type", async () => {
  assert.equal((await emp.upload("/api/admin/attachments?name=x.pdf&courseId=culture-conduct", FAKE_PDF)).status, 403);
  assert.equal((await admin.upload("/api/admin/attachments?name=x.pdf&courseId=nope", FAKE_PDF)).status, 400);
  assert.equal((await admin.upload("/api/admin/attachments?name=x.exe&courseId=culture-conduct", FAKE_PDF)).status, 400);
});

test("section attachments must belong to the course; foreign ids are dropped on save", async () => {
  const mine = await admin.upload("/api/admin/attachments?name=a.pdf&courseId=culture-conduct", FAKE_PDF);
  const foreign = await admin.upload("/api/admin/attachments?name=b.pdf&courseId=data-privacy", FAKE_PDF);
  const { data: content } = await admin.get("/api/admin/content");
  const c = content.courses.find((x) => x.id === "culture-conduct");
  c.modules[0].sections[0].attachments = [
    { id: mine.data.id, kind: "pdf", name: "a.pdf", size: 1 },
    { id: foreign.data.id, kind: "pdf", name: "b.pdf", size: 1 },
    { id: "att-nonexistent", kind: "pdf", name: "ghost.pdf", size: 1 },
  ];
  assert.equal((await admin.put("/api/admin/content/courses/" + c.id, c)).status, 200);
  const { data: course } = await emp.get("/api/courses/culture-conduct");
  const atts = course.modules[0].sections[0].attachments;
  assert.equal(atts.length, 1, "only the attachment belonging to this course survives");
  assert.equal(atts[0].id, mine.data.id);
});

test("course HTML is sanitized server-side on save", async () => {
  const { data: content } = await admin.get("/api/admin/content");
  const c = content.courses.find((x) => x.id === "compliance");
  c.modules[0].sections[0].html =
    `<p onclick="steal()">Hello <b>world</b></p><script>alert(1)</script>` +
    `<a href="javascript:alert(1)">bad link</a><a href="https://example.com">good link</a>` +
    `<iframe src="https://evil.example"></iframe><img src="x" onerror="alert(1)">`;
  // CX-035（2026-10-09 验收）：非 http(s) 的视频地址不再静默丢弃，而是 400 bad_video_url、整次保存不写；清掉后照常保存
  c.modules[0].sections[0].videoEmbed = "javascript:alert(1)";
  const refused = await admin.put("/api/admin/content/courses/" + c.id, c);
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, "bad_video_url");
  c.modules[0].sections[0].videoEmbed = null;
  assert.equal((await admin.put("/api/admin/content/courses/" + c.id, c)).status, 200);

  const { data: course } = await emp.get("/api/courses/compliance");
  const html = course.modules[0].sections[0].html;
  assert.doesNotMatch(html, /<script/i, "script stripped");
  assert.doesNotMatch(html, /onclick|onerror/i, "event handlers stripped");
  assert.doesNotMatch(html, /javascript:/i, "javascript: URLs stripped");
  assert.doesNotMatch(html, /<iframe/i, "iframes stripped");
  assert.match(html, /Hello <b>world<\/b>/, "safe formatting kept");
  assert.match(html, /href="https:\/\/example\.com"/, "safe links kept");
  assert.equal(course.modules[0].sections[0].videoEmbed, null, "non-http embed dropped");
});
