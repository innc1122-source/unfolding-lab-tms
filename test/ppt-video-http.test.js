// 第三批 5.7：PPT 内嵌视频端到端（真实 server.js；G1 接线 + 迁移 72 合入之后才会通过）。
// 用 test/fixtures/fake-soffice.js（.pptx 按可见幻灯片数输出 PDF 页数）与 test/fixtures/fake-ffmpeg.js，本机不需要
// LibreOffice / ffmpeg。课件由 test/fixtures/make-pptx.js 现场生成：
//   演示顺序 P1 YouTube 外链（第 1 页）、P2 内嵌 media1.wmv + 音频（第 2 页）、P3 隐藏、P4 同一个 media1.wmv + file:/// 链接（第 3 页）。
// 覆盖：上传回执 media 摘要与逐条状态；ffmpeg 停用时 pending、office-status 列出幻灯片与视频名、POST 409；
// 学员端 slideMedia（处理中 / 外链 / 不可用，跳过的与音频不下发）；同库同附件目录换成假 ffmpeg 重启 → 自动转码就绪；
// 媒体流 200 + Range 206；跨附件的 mediaId 404（安全评审 #1）；看不到课程的人 404；转码失败 → 上传人收到点名
// 课件 / 幻灯片 / 视频的通知 + 审计；存量 .pptx 在线补转时先抽视频再把原文件记进待删；课程 PUT 不会丢掉视频。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, FAKE_SOFFICE, FAKE_FFMPEG, startServer, loginAs } = require("./helpers.js");
const { makePptx } = require("./fixtures/make-pptx.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OFFICE_ENV = { LMS_DISABLE_OFFICE_CONVERT: "0", LMS_SOFFICE: FAKE_SOFFICE, LMS_OFFICE_CONVERT_TIMEOUT_MS: "8000" };
const VIDEO_ENV = { ...OFFICE_ENV, LMS_DISABLE_VIDEO_TRANSCODE: "0", LMS_FFMPEG: FAKE_FFMPEG };
const attachDirOf = (srv) => path.join(path.dirname(srv.dbPath), "attachments");
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
// 临时工作目录在响应之后才清理完：全量并行跑、机器负载高时会晚几十到几百毫秒（10/10 全量偶发「no work dirs left」）。
// 轮询最多 3 秒再断言，检查的内容不变 —— 工作目录最终必须被删掉。
const workDirsLeft = async (d, ms = 3000) => {
  const left = () => listDir(d).filter((n) => n.startsWith("w-") || n.startsWith("v-"));
  for (const until = Date.now() + ms; left().length && Date.now() < until;) await sleep(50);
  return left();
};
async function waitFor(fn, ms = 30000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what);
    await sleep(150);
  }
}
async function upload(admin, name, buf, courseId = "culture-conduct") {
  const r = await admin.upload(`/api/admin/attachments?name=${encodeURIComponent(name)}&courseId=${courseId}`, buf);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function attachToSection(admin, courseId, att) {
  const { data: content } = await admin.get("/api/admin/content");
  const c = content.courses.find((x) => x.id === courseId);
  c.modules[0].sections[0].attachments = [{ id: att.id, kind: "pdf", name: att.originalName, size: att.size }];
  const r = await admin.put("/api/admin/content/courses/" + courseId, c);
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
const slideMediaOf = async (client, courseId, attId) => {
  const course = (await client.get("/api/courses/" + courseId)).data;
  for (const m of course.modules || []) for (const s of m.sections || []) for (const a of s.attachments || []) if (a.id === attId) return a.slideMedia;
  return undefined;
};

test("http: upload with ffmpeg disabled → videos extracted and pending; admin status, learner slideMedia, 409 on transcode; restart with ffmpeg → ready and streamable", async () => {
  let srv = await startServer({ env: OFFICE_ENV });
  const dbPath = srv.dbPath;
  const attachDir = attachDirOf(srv);
  let att, videoId;
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const emp = await loginAs(srv.base, EMPLOYEE);
    att = await upload(admin, "产品培训.pptx", makePptx());
    assert.equal(att.kind, "pdf");
    const m = att.media;
    assert.ok(m, "the upload response carries a media summary");
    assert.deepEqual({ total: m.total, pending: m.pending, external: m.external, skipped: m.skipped, failed: m.failed, ready: m.ready },
      { total: 4, pending: 1, external: 1, skipped: 1, failed: 1, ready: 0 });
    assert.equal(m.mapping, "ok", "fake soffice emitted one page per visible slide");
    assert.equal(m.transcoder, "disabled");
    const video = m.items.find((x) => x.status === "pending");
    videoId = video.id;
    assert.equal(video.name, "Product demo");
    assert.deepEqual(video.slides, [{ slideNo: 2, pageNo: 2 }, { slideNo: 4, pageNo: 3 }]);
    assert.ok(fs.existsSync(path.join(attachDir, video.id + ".src.wmv")), "the raw video is kept for later transcoding");
    assert.deepEqual(await workDirsLeft(attachDir + ".convert-tmp"), [], "no work dirs left");

    const per = await admin.get("/api/admin/attachments/" + att.id + "/media");
    assert.equal(per.status, 200, JSON.stringify(per.data));
    assert.equal(per.data.summary.total, 4);
    assert.equal(per.data.mapping, "ok");
    assert.equal((await admin.get("/api/admin/attachments/att-nope/media")).status, 404);

    const st = (await admin.get("/api/admin/attachments/office-status")).data;
    assert.equal(st.transcoder.state, "disabled");
    assert.equal(st.mediaCounts.pending, 1);
    const item = st.media.find((x) => x.id === videoId);
    assert.ok(item, JSON.stringify(st.media));
    assert.equal(item.deck, "产品培训.pptx");
    assert.equal(item.name, "Product demo");
    assert.deepEqual(item.slides.map((s) => s.slideNo), [2, 4]);
    assert.ok(!st.media.some((x) => x.status === "external"), "external links are not listed as work");
    const run = await admin.post("/api/admin/attachments/media-transcode", {});
    assert.equal(run.status, 409, JSON.stringify(run.data));
    assert.equal(run.data.code, "video_transcoder_unavailable");

    await attachToSection(admin, "culture-conduct", att);
    const sm = await slideMediaOf(emp, "culture-conduct", att.id);
    assert.ok(Array.isArray(sm), "learner GET /api/courses/:id carries slideMedia");
    assert.deepEqual(sm.map((x) => [x.status, x.pages]), [["external", [1]], ["processing", [2, 3]], ["unavailable", [3]]]);
    assert.equal(sm[0].url, "https://www.youtube.com/embed/dQw4w9WgXcQ");
    assert.ok(!sm[1].src, "no stream before the video is ready");
    assert.ok(!JSON.stringify(sm).includes("Product demo") && !JSON.stringify(sm).includes("linked_file"), "names and reasons are not sent to learners");

    // 课程再保存一次（normalise 附件为 {id,kind,name,size}）：视频在自己的表里，不受影响
    await attachToSection(admin, "culture-conduct", att);
    assert.equal((await admin.get("/api/admin/attachments/" + att.id + "/media")).data.summary.total, 4);
  } finally { await srv.stopAsync(); }

  // 同库同附件目录，换成假 ffmpeg 重启：startupRecover → kick → 自动转码
  srv = await startServer({ dbPath, env: VIDEO_ENV });
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const emp = await loginAs(srv.base, EMPLOYEE);
    await waitFor(async () => {
      const r = (await admin.get("/api/admin/attachments/" + att.id + "/media")).data;
      return r.items.find((x) => x.id === videoId).status === "ready";
    }, 30000, "auto transcode after restart");
    const st = (await admin.get("/api/admin/attachments/office-status")).data;
    assert.equal(st.transcoder.state, "ok");
    assert.equal(st.transcoder.version, "6.1-test-double");
    assert.ok(fs.existsSync(path.join(attachDir, videoId + ".mp4")));

    const sm = await slideMediaOf(emp, "culture-conduct", att.id);
    const ready = sm.find((x) => x.status === "ready");
    assert.equal(ready.src, `/api/attachments/${att.id}/media/${videoId}`);
    assert.deepEqual(ready.pages, [2, 3]);
    const res = await emp.raw("GET", ready.src);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /video\/mp4/);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString("latin1", 4, 8), "ftyp");
    const part = await emp.raw("GET", ready.src, undefined, { range: "bytes=0-7" });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).length, 8);
    assert.equal((await emp.raw("GET", `/api/attachments/${att.id}/media/am-000000000000`)).status, 404);

    // 跨附件：用另一个附件的 id 配这段视频的 mediaId → 404（安全评审 #1）
    const other = await upload(admin, "other.pptx", fs.readFileSync(path.join(__dirname, "..", "scripts", "samples", "sample-slides.pptx")));
    await attachToSection(admin, "culture-conduct", other);
    assert.equal((await emp.raw("GET", `/api/attachments/${other.id}/media/${videoId}`)).status, 404);
    await attachToSection(admin, "culture-conduct", att);

    // 看不到这门课的人：与附件本身同一条规则
    const created = await admin.post("/api/admin/employees", { name: "PV Outsider", employeeId: "DP-PVO" });
    const outsider = await loginAs(srv.base, { employeeId: "DP-PVO", password: created.data.password });
    await outsider.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: "pv-outsider-pw-2026" });
    const attStatus = (await outsider.raw("GET", "/api/attachments/" + att.id)).status;
    const mediaStatus = (await outsider.raw("GET", ready.src)).status;
    assert.equal(mediaStatus, attStatus === 200 ? 200 : 404, "the media stream follows the attachment access rule");

    const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
    assert.ok(audit.includes("attachment.media.extract"));
    assert.ok(audit.includes("attachment.media.transcode"));
  } finally { await srv.stopAsync(); }

  // 再启动一次：已转码的源视频此时才删（服务运行中不删附件目录里的文件）
  srv = await startServer({ dbPath, env: VIDEO_ENV });
  try {
    assert.ok(!fs.existsSync(path.join(attachDir, videoId + ".src.wmv")), "transcoded source removed at the next start");
    assert.ok(fs.existsSync(path.join(attachDir, videoId + ".mp4")));
  } finally { await srv.stopAsync(); }
});

test("http: a video ffmpeg cannot read → failed; the uploader is notified naming deck, slide and video; failure audited; retry is allowed", async () => {
  const srv = await startServer({ env: VIDEO_ENV });
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const att = await upload(admin, "Broken deck.pptx", makePptx({ media1: Buffer.from("FAKE_FFMPEG_FAIL payload") }));
    const id = att.media.items.find((x) => x.name === "Product demo").id;
    await waitFor(async () => (await admin.get("/api/admin/attachments/" + att.id + "/media")).data.items.find((x) => x.id === id).status === "failed", 30000, "failed");
    const item = (await admin.get("/api/admin/attachments/" + att.id + "/media")).data.items.find((x) => x.id === id);
    assert.equal(item.reason, "error");
    assert.match(item.detail || "", /Invalid data/);
    const notes = (await admin.get("/api/me/notifications")).data.items;
    const n = notes.find((x) => /课件视频转码失败/.test(x.title_zh || "") || /could not be converted/.test(x.title || ""));
    assert.ok(n, JSON.stringify(notes.map((x) => x.title)));
    assert.match(n.body_zh || n.body, /Broken deck\.pptx/);
    assert.match(n.body_zh || "", /第 2、4 页「Product demo」/);
    assert.match(n.body || "", /slides 2, 4 "Product demo"/);
    const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
    assert.ok(audit.includes("attachment.media.transcode.fail"));
    const retry = await admin.post("/api/admin/attachments/media-transcode", { ids: [id] });
    assert.equal(retry.status, 202, JSON.stringify(retry.data));
    const bad = await admin.post("/api/admin/attachments/media-transcode", { ids: ["am-nope"] });
    assert.ok([400, 409].includes(bad.status), JSON.stringify(bad.data));
  } finally { await srv.stopAsync(); }
});

test("http: batch re-conversion of a legacy .pptx original extracts its videos before the original is queued for deletion", async () => {
  const first = await startServer({ env: OFFICE_ENV });
  const dbPath = first.dbPath;
  const attachDir = attachDirOf(first);
  await first.stopAsync();
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, "att-legacyv.pptx"), makePptx());
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("INSERT INTO attachments (id, courseId, kind, storageKey, originalName, mime, size, uploadedBy, createdAt, ownerKind, ownerId) VALUES ('att-legacyv', 'culture-conduct', 'doc', 'att-legacyv.pptx', 'Legacy video deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 1, 'u-admin', '2026-09-01T00:00:00.000Z', 'course', 'culture-conduct')").run();
  } finally { db.close(); }
  const srv = await startServer({ dbPath, env: OFFICE_ENV });
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const go = await admin.post("/api/admin/attachments/office-convert", { ids: ["att-legacyv"] });
    assert.equal(go.status, 202, JSON.stringify(go.data));
    await waitFor(async () => !(await admin.get("/api/admin/attachments/office-status")).data.job.running, 30000, "conversion job");
    const per = (await admin.get("/api/admin/attachments/att-legacyv/media")).data;
    assert.equal(per.summary.total, 4);
    assert.equal(per.summary.pending, 1);
    const v = per.items.find((x) => x.status === "pending");
    assert.ok(fs.existsSync(path.join(attachDir, v.id + ".src.wmv")));
    assert.ok(fs.existsSync(path.join(attachDir, "att-legacyv.pptx")), "the original stays until the next start");
  } finally { await srv.stopAsync(); }
});
