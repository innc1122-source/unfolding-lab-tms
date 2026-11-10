// 第三批 5.6 / 5.7（2026-10-08）：课件与视频不许在地址栏 / 新标签直接打开（Sec-Fetch-Dest 为 document / iframe / frame /
// embed / object → 与「不存在」同形的 404），阅读器（empty）、video 元素（video）与不带该头的请求照常 200 / 206，响应不缓存
// （private, no-store）。课件内视频播放流：媒体行必须属于这份附件且已就绪（不能拿别的附件 id 拉视频），学员课程详情带 slideMedia。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ROOT, ADMIN, EMPLOYEE, startServer, loginAs } = require("./helpers.js");

const STAMP = Date.now().toString(36);
const VIDEO_DIR = path.join(ROOT, "public", "videos");
const VIDEO = "guard-" + STAMP + ".mp4";
const BYTES = Buffer.alloc(4096, 7);
let srv, admin, emp, pdfId, otherId, madeDir;

before(async () => {
  madeDir = !fs.existsSync(VIDEO_DIR);
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  fs.writeFileSync(path.join(VIDEO_DIR, VIDEO), BYTES);
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 32), Buffer.from("\n%%EOF\n")]);
  const up = await admin.upload("/api/admin/attachments?name=guard.pdf&courseId=culture-conduct", pdf);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  pdfId = up.data.id;
  const up2 = await admin.upload("/api/admin/attachments?name=other.pdf&courseId=culture-conduct", pdf);
  otherId = up2.data.id;
  const { data: content } = await admin.get("/api/admin/content");
  const cc = content.courses.find((c) => c.id === "culture-conduct");
  cc.modules[0].sections[0].attachments = [{ id: pdfId }, { id: otherId }];
  cc.modules[0].sections[0].video = "/videos/" + VIDEO;
  assert.equal((await admin.put("/api/admin/content/courses/culture-conduct", cc)).status, 200);
  // 一段已转码好的课件内视频（直接写库 + 附件目录里的产物）
  const attachDir = path.join(path.dirname(srv.dbPath), "attachments");
  fs.writeFileSync(path.join(attachDir, "am-guard00000001.mp4"), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(3000, 1)]));
  const db = new DatabaseSync(srv.dbPath);
  try {
    const now = new Date().toISOString();
    const ins = db.prepare("INSERT INTO attachment_media (id, attachmentId, seq, kind, source, name, slides, storageKey, status, attempts, createdAt, updatedAt) VALUES (?, ?, ?, 'video', 'embedded', ?, ?, ?, ?, 0, ?, ?)");
    ins.run("am-guard00000001", pdfId, 1, "demo.wmv", JSON.stringify([{ slideNo: 2, pageNo: 2 }]), "am-guard00000001.mp4", "ready", now, now);
    ins.run("am-guard00000002", pdfId, 2, "intro.avi", JSON.stringify([{ slideNo: 5, pageNo: 4 }]), null, "pending", now, now);
    ins.run("am-guard00000003", pdfId, 3, "hidden.mp4", JSON.stringify([{ slideNo: 6, pageNo: null }]), null, "skipped", now, now);
  } finally { db.close(); }
});
after(() => {
  if (srv) srv.stop();
  try { fs.unlinkSync(path.join(VIDEO_DIR, VIDEO)); } catch {}
  if (madeDir) { try { fs.rmdirSync(VIDEO_DIR); } catch {} }
});

const get = (c, p, dest, extra) => c.raw("GET", p, undefined, { ...(dest ? { "sec-fetch-dest": dest } : {}), ...(extra || {}) });

test("course attachment: document-like destinations get 404; the reader (empty) and header-less requests get 200, never cached", async () => {
  for (const dest of ["document", "iframe", "frame", "embed", "object"]) {
    const r = await get(emp, "/api/attachments/" + pdfId, dest);
    assert.equal(r.status, 404, dest);
    assert.deepEqual(await r.json(), { error: "Attachment not found" }, "same shape as a missing attachment");
  }
  for (const dest of ["empty", null]) {
    const r = await get(emp, "/api/attachments/" + pdfId, dest);
    assert.equal(r.status, 200, String(dest));
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    await r.arrayBuffer();
  }
  const ranged = await get(emp, "/api/attachments/" + pdfId, "empty", { range: "bytes=0-9" });
  assert.equal(ranged.status, 206);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString("latin1", 0, 5), "%PDF-");
});

test("/videos/*: the video element plays, opening the URL directly is 404", async () => {
  assert.equal((await get(emp, "/videos/" + VIDEO, "document")).status, 404);
  const ok = await get(emp, "/videos/" + VIDEO, "video");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  await ok.arrayBuffer();
  assert.equal((await get(emp, "/videos/" + VIDEO, "video", { range: "bytes=0-99" })).status, 206);
});

test("slide video stream: bound to its attachment, ready only, Range, direct open 404; learners get slideMedia without names or reasons", async () => {
  const url = `/api/attachments/${pdfId}/media/am-guard00000001`;
  const ok = await get(emp, url, "video");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "video/mp4");
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  await ok.arrayBuffer();
  assert.equal((await get(emp, url, "video", { range: "bytes=0-11" })).status, 206);
  assert.equal((await get(emp, url, "document")).status, 404);
  assert.equal((await get(emp, `/api/attachments/${otherId}/media/am-guard00000001`, "video")).status, 404, "another attachment's id cannot pull this video");
  assert.equal((await get(emp, `/api/attachments/${pdfId}/media/am-guard00000002`, "video")).status, 404, "not ready");
  const anon = await fetch(srv.base + url);
  assert.equal(anon.status, (await fetch(srv.base + "/api/attachments/" + pdfId)).status, "anonymous: same answer as the attachment itself (login required)");
  const course = (await emp.get("/api/courses/culture-conduct")).data;
  const att = course.modules[0].sections[0].attachments.find((a) => a.id === pdfId);
  assert.deepEqual(att.slideMedia, [
    { id: "am-guard00000001", kind: "video", status: "ready", pages: [2], src: url },
    { id: "am-guard00000002", kind: "video", status: "processing", pages: [4] },
  ], "skipped / hidden rows are not sent; no file names or reasons");
  const other = course.modules[0].sections[0].attachments.find((a) => a.id === otherId);
  assert.equal(other.slideMedia, undefined);
});

test("admin media views: per-attachment list, office-status block, content counts; retry refuses without ffmpeg", async () => {
  const m = await admin.get(`/api/admin/attachments/${pdfId}/media`);
  assert.equal(m.status, 200);
  assert.deepEqual([m.data.summary.total, m.data.summary.ready, m.data.summary.pending, m.data.summary.skipped], [3, 1, 1, 1]);
  assert.equal(m.data.deck, "guard.pdf");
  assert.ok(m.data.items.every((i) => "retryable" in i && Array.isArray(i.refs)));
  assert.equal((await admin.get("/api/admin/attachments/no-such/media")).status, 404);
  const os = (await admin.get("/api/admin/attachments/office-status")).data;
  assert.equal(os.transcoder.state, "disabled");
  assert.ok(os.media.some((i) => i.id === "am-guard00000002") && !os.media.some((i) => i.id === "am-guard00000001"), "non-ready rows only");
  assert.equal(os.mediaCounts.ready, 1);
  const content = (await admin.get("/api/admin/content")).data.courses.find((c) => c.id === "culture-conduct");
  assert.equal(content.modules[0].sections[0].attachments.find((a) => a.id === pdfId).media.total, 3);
  const retry = await admin.post("/api/admin/attachments/media-transcode", {});
  assert.equal(retry.status, 409);
  assert.equal(retry.data.code, "video_transcoder_unavailable");
});
