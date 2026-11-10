// 第三批 5.7：modules/learning/video-transcode.js —— ffmpeg 探测、抽取入库、转码队列、超时杀进程树、启动恢复、清理。
// 全程用 test/fixtures/fake-ffmpeg.js 与内存里的假 store（真实 store 的 attachment_media 由 G1 的迁移 72 提供；
// 走真实 server 的端到端用例在 test/ppt-video-http.test.js）。本机不需要 ffmpeg。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { tempDir, FAKE_FFMPEG } = require("./helpers.js");
const vt = require("../modules/learning/video-transcode.js");
const { makePptx, makeDeck } = require("./fixtures/make-pptx.js");

const TMP = tempDir("lms-video-transcode-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what);
    await sleep(50);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; } };
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

// ---------------------------------------------------------------- in-memory store (same contract as store.js, migration 72)
function fakeStore() {
  const media = new Map(), meta = new Map(), atts = new Map();
  const clone = (r) => (r == null ? null : JSON.parse(JSON.stringify(r)));
  const order = (a, b) => String(a.attachmentId).localeCompare(String(b.attachmentId)) || a.seq - b.seq;
  return {
    media, meta, atts,
    getMeta: (k) => (meta.has(k) ? meta.get(k) : null),
    setMeta: (k, v) => { meta.set(k, v); },
    getAttachment: (id) => clone(atts.get(id)),
    listAllAttachments: () => [...atts.values()].map(clone),
    createAttachmentMedia(rows) {
      for (const r of rows) {
        if (!r.id || media.has(r.id)) throw new Error("bad id");
        if ([...media.values()].some((m) => m.attachmentId === r.attachmentId && m.seq === r.seq)) throw new Error("UNIQUE constraint failed: attachment_media.attachmentId, attachment_media.seq");
      }
      for (const r of rows) { assert.ok(Array.isArray(r.slides), "slides passed as an array"); media.set(r.id, clone(r)); }
      return rows.map(clone);
    },
    listAttachmentMedia(q) {
      const o = q || {};
      return [...media.values()].filter((m) =>
        (!o.attachmentId || m.attachmentId === o.attachmentId)
        && (!o.attachmentIds || o.attachmentIds.includes(m.attachmentId))
        && (!o.statuses || o.statuses.includes(m.status))).sort(order).map(clone);
    },
    getAttachmentMedia: (id) => clone(media.get(id)),
    updateAttachmentMedia(id, patch, opts) {
      const r = media.get(id);
      if (!r || (opts && opts.expectStatus && r.status !== opts.expectStatus)) return 0;
      Object.assign(r, patch, { updatedAt: new Date().toISOString() });
      return 1;
    },
    claimAttachmentMedia(id) {
      const r = media.get(id);
      if (!r || !["pending", "failed"].includes(r.status)) return false;
      r.status = "transcoding"; r.attempts = (r.attempts || 0) + 1;
      return true;
    },
    resetTranscodingMedia() { let n = 0; for (const r of media.values()) if (r.status === "transcoding") { r.status = "pending"; n++; } return n; },
    countAttachmentMediaByStatus() { const c = { pending: 0, transcoding: 0, ready: 0, failed: 0, external: 0, skipped: 0 }; for (const r of media.values()) c[r.status]++; return c; },
    listMediaFileKeys() {
      const srcKeys = new Set(), storageKeys = new Set();
      for (const r of media.values()) { if (r.srcKey) srcKeys.add(r.srcKey); if (r.storageKey) storageKeys.add(r.storageKey); }
      return { srcKeys, storageKeys };
    },
  };
}

let seq = 0;
function engine(extra = {}) {
  const dir = path.join(TMP, "e" + (++seq));
  const attachDir = path.join(dir, "attachments");
  fs.mkdirSync(attachDir, { recursive: true });
  const store = extra.store || fakeStore();
  const logs = [], audits = [], notices = [];
  const ffLog = path.join(dir, "ffmpeg.log");
  process.env.FAKE_FFMPEG_LOG = ffLog;
  const vtc = vt.create({
    attachDir, store, log: (m) => logs.push(m),
    probe: () => FAKE_FFMPEG, disabled: () => false,
    hooks: {
      audit: (action, targetId, before, after, by) => audits.push({ action, targetId, after, by }),
      notifyFailures: (x) => notices.push(x),
    },
    statfs: () => ({ bavail: 1e9, bsize: 4096 }),
    ...extra,
  });
  const ffCalls = () => (fs.existsSync(ffLog) ? fs.readFileSync(ffLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { vtc, store, attachDir, dir, logs, audits, notices, ffCalls };
}
let attSeq = 0;
function deckFile(dir, buf) {
  const id = "att-v" + (++attSeq);
  const p = path.join(dir, id + ".pptx");
  fs.writeFileSync(p, buf);
  return { id, src: p };
}
function addAttachment(store, id, name) {
  store.atts.set(id, { id, courseId: "c1", kind: "pdf", storageKey: id + ".pdf", originalName: name || "Product training.pptx", uploadedBy: "u-hr", createdAt: new Date().toISOString() });
  return store.getAttachment(id);
}
// 单视频课件：内容由 bytes 决定（用来放 FAKE_FFMPEG_* 标记）
function oneVideoDeck(bytes, ext = "wmv", name = "Clip") {
  return makeDeck({ order: [1, 2], slides: { 1: { items: [] }, 2: { items: [{ kind: "video", embed: "v." + ext, name }] } }, media: { ["v." + ext]: Buffer.from(bytes) } });
}
async function ingestOne(e, bytes, ext, name) {
  const { id, src } = deckFile(e.dir, oneVideoDeck(bytes, ext, name));
  const att = addAttachment(e.store, id, "Deck " + id + ".pptx");
  const r = await e.vtc.ingestDeck({ attachment: att, srcPath: src });
  return { att, r, row: r.items.find((x) => x.kind === "video") };
}
const idle = (vtc) => () => !vtc.job().running;

// ---------------------------------------------------------------- probe
test("findFfmpeg: LMS_FFMPEG, then PATH (absolute entries only), then env-derived Windows paths, then posix paths", () => {
  const W = { ProgramFiles: "C:\\PF", ProgramData: "C:\\PD", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
  const find = (env, have, platform = "win32") => vt.findFfmpeg({ env, platform, exists: (p) => have.includes(p) });
  const all = ["C:\\tools\\ff.exe", "C:\\bin\\ffmpeg.exe", "C:\\PF\\ffmpeg\\bin\\ffmpeg.exe", "C:\\PF\\WinGet\\Links\\ffmpeg.exe", "C:\\PD\\chocolatey\\bin\\ffmpeg.exe", "C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe"];
  assert.equal(find({ ...W, LMS_FFMPEG: "C:\\tools\\ff.exe", PATH: "C:\\bin" }, all), "C:\\tools\\ff.exe");
  assert.equal(find({ ...W, LMS_FFMPEG: "C:\\tools\\ff.cmd", PATH: "C:\\bin" }, [...all, "C:\\tools\\ff.cmd"]), "C:\\bin\\ffmpeg.exe", "a .cmd needs a shell and is never used on Windows");
  assert.equal(find({ ...W, Path: 'relative\\dir;"C:\\bin"' }, all), "C:\\bin\\ffmpeg.exe", "Path is matched case-insensitively; quotes stripped");
  assert.equal(find({ ...W, PATH: ".;relative" }, [...all.slice(2), ".\\ffmpeg.exe", "relative\\ffmpeg.exe"]), "C:\\PF\\ffmpeg\\bin\\ffmpeg.exe", "relative PATH entries are ignored");
  assert.equal(find(W, all.slice(3)), "C:\\PF\\WinGet\\Links\\ffmpeg.exe");
  assert.equal(find(W, all.slice(4)), "C:\\PD\\chocolatey\\bin\\ffmpeg.exe");
  assert.equal(find(W, all.slice(5)), "C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe");
  assert.equal(find({}, ["/usr/bin/ffmpeg", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"]), null, "no hard-coded drive letters on Windows");
  assert.equal(find({ PATH: "/opt/x:/usr/local/sbin" }, ["/opt/x/ffmpeg", "/usr/bin/ffmpeg"], "linux"), "/opt/x/ffmpeg");
  assert.equal(find({}, ["/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"], "linux"), "/usr/local/bin/ffmpeg");
  assert.equal(find({}, ["/opt/homebrew/bin/ffmpeg"], "darwin"), "/opt/homebrew/bin/ffmpeg");
  assert.equal(find({ LMS_FFMPEG: FAKE_FFMPEG }, [FAKE_FFMPEG]), FAKE_FFMPEG, "the .js test double is allowed");
});

test("states: ok (version + encoder), missing, disabled (never probes), no_encoder; includePath:false hides the path; refresh is throttled", async () => {
  const e = engine();
  await e.vtc.ready();
  assert.equal(e.vtc.state(), "ok");
  const s = await e.vtc.status();
  assert.deepEqual({ state: s.state, path: s.path, version: s.version, encoder: s.encoder }, { state: "ok", path: FAKE_FFMPEG, version: "6.1-test-double", encoder: "libx264" });
  assert.ok(s.probedAt);
  assert.equal((await e.vtc.status({ includePath: false })).path, null);

  let probes = 0;
  const m = engine({ probe: () => { probes++; return null; } });
  assert.equal((await m.vtc.status()).state, "missing");
  await m.vtc.status({ refresh: true });
  await m.vtc.status({ refresh: true });
  assert.equal(probes, 2, "first probe + one refresh; the second refresh within 10 s is ignored");

  let dprobes = 0;
  const d = engine({ disabled: () => true, probe: () => { dprobes++; return FAKE_FFMPEG; } });
  const ds = await d.vtc.status({ refresh: true });
  assert.deepEqual([ds.state, ds.path, ds.probedAt], ["disabled", null, null]);
  assert.equal(dprobes, 0);
  const envOff = vt.create({ attachDir: path.join(TMP, "envoff"), env: { LMS_DISABLE_VIDEO_TRANSCODE: "1" } });
  assert.equal(envOff.state(), "disabled", "LMS_DISABLE_VIDEO_TRANSCODE=1");

  process.env.FAKE_FFMPEG_MODE = "no_encoder";
  try {
    const n = engine();
    const ns = await n.vtc.status();
    assert.deepEqual([ns.state, ns.encoder, ns.version], ["no_encoder", null, "6.1-test-double"]);
    assert.equal(n.vtc.available(), null);
  } finally { delete process.env.FAKE_FFMPEG_MODE; }
});

test("timeout and concurrency options are clamped (env: 1 min–3 h, default 30 min; concurrency 1–2)", () => {
  const mk = (env, extra) => vt.create({ attachDir: path.join(TMP, "clamp"), env, disabled: () => true, ...(extra || {}) });
  assert.equal(mk({}).timeoutMs, 1800000);
  assert.equal(mk({ LMS_VIDEO_TRANSCODE_TIMEOUT_MS: "5" }).timeoutMs, 60000);
  assert.equal(mk({ LMS_VIDEO_TRANSCODE_TIMEOUT_MS: "99999999" }).timeoutMs, 10800000);
  assert.equal(mk({ LMS_VIDEO_TRANSCODE_CONCURRENCY: "9" }).concurrency, 2);
  assert.equal(mk({}).concurrency, 1);
});

// ---------------------------------------------------------------- ingest
test("ingestDeck: rows in one insert, sources named by media id, nothing else lands in the attachment dir, idempotent", async () => {
  const e = engine({ autoStart: false });
  const { id, src } = deckFile(e.dir, makePptx({ hiddenVideo: true }));
  const att = addAttachment(e.store, id);
  const pdf = path.join(e.attachDir, id + ".pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n<< /Type /Page >>\n<< /Type /Page >>\n<< /Type /Page >>\n");
  const r = await e.vtc.ingestDeck({ attachment: att, srcPath: src, pdfPath: pdf });
  assert.deepEqual({ total: r.total, pending: r.pending, external: r.external, skipped: r.skipped, failed: r.failed, ready: r.ready },
    { total: 5, pending: 1, external: 1, skipped: 2, failed: 1, ready: 0 });
  assert.deepEqual([r.mapping, r.pdfPages, r.visibleSlides], ["ok", 3, 3]);
  assert.equal(r.transcoder, "ok");
  const rows = e.store.listAttachmentMedia({ attachmentId: id });
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.match(row.id, /^am-[0-9a-f]{12}$/);
    assert.equal(row.attachmentId, id);
    assert.ok(row.createdAt && row.updatedAt);
    assert.equal(row.attempts, 0);
  }
  const demo = rows.find((x) => x.status === "pending");
  assert.equal(demo.srcKey, demo.id + ".src.wmv");
  assert.equal(demo.srcExt, "wmv");
  assert.deepEqual(demo.slides, [{ slideNo: 2, pageNo: 2 }, { slideNo: 4, pageNo: 3 }]);
  assert.equal(demo.name, "Product demo");
  assert.ok(fs.readFileSync(path.join(e.attachDir, demo.srcKey)).toString().startsWith("FAKE_WMV"));
  assert.deepEqual(listDir(e.attachDir), [id + ".pdf", demo.srcKey].sort(), "only the PDF and one source file");
  assert.equal(rows.find((x) => x.source === "external").url, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.deepEqual(listDir(e.vtc.tmpRoot).filter((x) => x.startsWith("v-")), [], "work dir removed");
  assert.deepEqual(e.vtc.mappingOf(id), { mapping: "ok", pdfPages: 3, visibleSlides: 3 });

  const again = await e.vtc.ingestDeck({ attachment: att, srcPath: src, pdfPath: pdf });
  assert.equal(again.reused, true);
  assert.equal(again.total, 5);
  assert.equal(again.mapping, "ok");
  assert.equal(e.store.media.size, 5, "a second ingest adds nothing");
  assert.equal(e.vtc.job().running, false, "autoStart:false never transcodes");
});

test("ingestDeck: an unreadable deck returns an error and stores nothing; a mismatched PDF page count is reported", async () => {
  const e = engine({ autoStart: false });
  const bad = deckFile(e.dir, Buffer.from("not a zip"));
  const r = await e.vtc.ingestDeck({ attachment: addAttachment(e.store, bad.id), srcPath: bad.src });
  assert.equal(r.error, "pptx_unreadable");
  assert.equal(r.total, 0);
  assert.equal(e.store.media.size, 0);
  const z = deckFile(e.dir, makePptx({ zip64: true }));
  assert.equal((await e.vtc.ingestDeck({ attachment: addAttachment(e.store, z.id), srcPath: z.src })).error, "zip64_unsupported");
  const ok = deckFile(e.dir, makePptx());
  const pdf = path.join(e.dir, "one.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n<< /Type /Page >>\n");
  const m = await e.vtc.ingestDeck({ attachment: addAttachment(e.store, ok.id), srcPath: ok.src, pdfPath: pdf });
  assert.deepEqual([m.mapping, m.pdfPages, m.visibleSlides], ["mismatch", 1, 3]);
  assert.deepEqual(listDir(e.attachDir).filter((x) => !x.endsWith(".pdf")).length, 1);
});

test("ingestDeck: low disk space or the retained-source cap skip videos instead of storing them", async () => {
  const disk = engine({ autoStart: false, statfs: () => ({ bavail: 0, bsize: 4096 }) });
  const a = await ingestOne(disk, "FAKE_WMV");
  assert.deepEqual([a.row.status, a.row.reason, a.row.srcKey], ["skipped", "disk_full", null]);
  assert.deepEqual(listDir(disk.attachDir), []);
  const cap = engine({ autoStart: false, srcMaxBytes: 10 });
  const b = await ingestOne(cap, "FAKE_WMV more than ten bytes");
  assert.deepEqual([b.row.status, b.row.reason], ["skipped", "storage_limit"]);
});

// ---------------------------------------------------------------- transcoding
test("auto transcode after ingest: full transcode for wmv, ftyp-checked MP4 <id>.mp4, source orphaned (deleted only at startup), audit, safety flags", async () => {
  const e = engine();
  const { row } = await ingestOne(e, "FAKE_WMV payload");
  await waitFor(() => e.store.getAttachmentMedia(row.id).status === "ready", 20000, "ready");
  await waitFor(idle(e.vtc));
  const done = e.store.getAttachmentMedia(row.id);
  assert.equal(done.storageKey, row.id + ".mp4");
  assert.equal(done.srcKey, null, "the ready row no longer references its source");
  assert.equal(done.durationSec, 5);
  assert.equal(done.attempts, 1);
  const mp4 = fs.readFileSync(path.join(e.attachDir, done.storageKey));
  assert.equal(mp4.toString("latin1", 4, 8), "ftyp");
  assert.equal(done.size, mp4.length);
  assert.ok(mp4.toString().includes("fake-mp4-transcode"));
  assert.ok(fs.existsSync(path.join(e.attachDir, row.srcKey)), "source kept while the server runs (backup rule)");
  assert.deepEqual(JSON.parse(e.store.getMeta(vt.META.orphans)), [row.srcKey]);
  const j = e.vtc.job();
  assert.deepEqual([j.auto, j.total, j.done, j.ready, j.failed, j.by, j.aborted], [true, 1, 1, 1, 0, null, null]);
  const last = JSON.parse(e.store.getMeta(vt.META.last));
  assert.deepEqual([last.ok, last.mediaId], [true, row.id]);
  assert.equal(e.audits.length, 1);
  assert.equal(e.audits[0].action, "attachment.media.transcode");
  assert.equal(e.audits[0].targetId, row.id);
  assert.equal(e.audits[0].after.mode, "transcode");
  assert.equal(e.audits[0].by, null, "system actor for automatic jobs");
  // ffmpeg 参数：探测用 info 级别；转码带白名单、像素 / 时长 / 体积上限；输入输出都是 file: 绝对路径
  const calls = e.ffCalls().filter((c) => c.mode === "probe" || c.mode === "transcode");
  const probe = calls.find((c) => c.mode === "probe").args;
  assert.equal(probe[probe.indexOf("-loglevel") + 1], "info");
  const tr = calls.find((c) => c.mode === "transcode").args;
  for (const [flag, val] of [["-loglevel", "error"], ["-protocol_whitelist", "file"], ["-format_whitelist", vt.FORMAT_WHITELIST], ["-max_pixels", "8294400"], ["-t", "14400"], ["-fs", "2147483648"], ["-c:v", "libx264"], ["-c:a", "aac"], ["-threads", "2"]]) {
    assert.equal(tr[tr.indexOf(flag) + 1], val, flag);
  }
  assert.ok(tr.includes("-nostdin") && tr.includes("-timelimit"));
  assert.equal(tr[tr.indexOf("-i") + 1], "file:" + path.join(e.attachDir, row.srcKey));
  assert.match(tr[tr.length - 1], /^file:.+out\.mp4$/);
  assert.ok(tr.indexOf("-max_pixels") < tr.indexOf("-i"), "decoder limit goes before -i");

  const r = e.vtc.startupRecover();
  assert.equal(r.orphansRemoved, 1);
  assert.ok(!fs.existsSync(path.join(e.attachDir, row.srcKey)));
  assert.ok(fs.existsSync(path.join(e.attachDir, done.storageKey)));
  e.vtc.shutdown();
});

test("h264 + aac in mp4 is copy-remuxed; a failed copy falls back to a full transcode once", async () => {
  const e = engine();
  const a = await ingestOne(e, "FAKE_FFMPEG_H264", "mp4");
  await waitFor(() => e.store.getAttachmentMedia(a.row.id).status === "ready");
  await waitFor(idle(e.vtc));
  assert.equal(e.audits.at(-1).after.mode, "copy");
  assert.ok(fs.readFileSync(path.join(e.attachDir, a.row.id + ".mp4")).toString().includes("fake-mp4-copy"));
  const b = await ingestOne(e, "FAKE_FFMPEG_H264 FAKE_FFMPEG_COPYFAIL", "mov");
  await waitFor(() => e.store.getAttachmentMedia(b.row.id).status === "ready");
  await waitFor(idle(e.vtc));
  assert.equal(e.audits.at(-1).after.mode, "transcode");
  assert.deepEqual(e.ffCalls().filter((c) => c.mode === "copy" || c.mode === "transcode").map((c) => c.mode).slice(-3), ["copy", "copy", "transcode"]);
  e.vtc.shutdown();
});

test("failures: FAIL → error with a redacted stderr tail, NOMP4 / BADMP4 → no_mp4, LONG → too_long, missing source → source_missing; one notification per deck", async () => {
  const e = engine({ autoStart: false });
  const deck = makeDeck({
    order: [1, 2, 3],
    slides: {
      1: { items: [{ kind: "video", embed: "a.wmv", name: "Broken" }] },
      2: { items: [{ kind: "video", embed: "b.wmv", name: "Empty" }, { kind: "video", embed: "c.wmv", name: "Garbage" }] },
      3: { items: [{ kind: "video", embed: "d.wmv", name: "Marathon" }, { kind: "video", embed: "e.wmv", name: "Gone" }] },
    },
    media: { "a.wmv": Buffer.from("FAKE_FFMPEG_FAIL"), "b.wmv": Buffer.from("FAKE_FFMPEG_NOMP4"), "c.wmv": Buffer.from("FAKE_FFMPEG_BADMP4"), "d.wmv": Buffer.from("FAKE_FFMPEG_LONG"), "e.wmv": Buffer.from("fine") },
  });
  const { id, src } = deckFile(e.dir, deck);
  const att = addAttachment(e.store, id, "合规培训.pptx");
  await e.vtc.ingestDeck({ attachment: att, srcPath: src });
  const rows = e.store.listAttachmentMedia({ attachmentId: id });
  const gone = rows.find((r) => r.name === "Gone");
  fs.unlinkSync(path.join(e.attachDir, gone.srcKey));
  await e.vtc.ready();
  const snap = e.vtc.startJob(null, { by: { id: "u-hr", name: "HR" } });
  assert.deepEqual([snap.running, snap.total, snap.auto, snap.by.id], [true, 5, false, "u-hr"]);
  await waitFor(idle(e.vtc));
  const by = (n) => e.store.listAttachmentMedia({ attachmentId: id }).find((r) => r.name === n);
  assert.deepEqual([by("Broken").status, by("Broken").reason], ["failed", "error"]);
  assert.match(by("Broken").detail, /Invalid data found when processing input/);
  assert.ok(!by("Broken").detail.includes(e.attachDir) && !by("Broken").detail.toLowerCase().includes(e.attachDir.toLowerCase()), "server paths are redacted");
  assert.ok(by("Broken").detail.includes("<attachments>"));
  assert.ok(by("Broken").detail.length <= 1000);
  assert.equal(by("Broken").srcKey !== null, true, "a failed row keeps its source for a retry");
  assert.equal(by("Empty").reason, "no_mp4");
  assert.equal(by("Garbage").reason, "no_mp4");
  assert.equal(by("Marathon").reason, "too_long");
  assert.equal(by("Gone").reason, "source_missing");
  const j = e.vtc.job();
  assert.deepEqual([j.done, j.ready, j.failed, j.aborted], [5, 0, 5, null]);
  assert.equal(e.audits.filter((a) => a.action === "attachment.media.transcode.fail").length, 5);
  assert.equal(e.audits[0].after.deck, "合规培训.pptx");
  assert.equal(e.audits[0].by.id, "u-hr");
  assert.equal(e.notices.length, 1, "one notification per deck per job");
  const nt = e.notices[0];
  assert.equal(nt.attachment.id, id);
  assert.equal(nt.items.length, 5);
  assert.equal(nt.message.zh.title, "课件视频转码失败");
  const lines = nt.message.zh.body.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "「合规培训.pptx」第 1 页「Broken」：视频文件已损坏或格式无法识别");
  assert.equal(lines[3], "等 2 段");
  assert.match(nt.message.en.body, /^"合规培训\.pptx" slide 1 "Broken": The video file is damaged/);
  assert.match(nt.message.en.body, /and 2 more$/);
  // 手动重试：失败的行可以再排队
  assert.equal(e.vtc.isRetryable(by("Broken")), true);
  const again = e.vtc.startJob([by("Broken").id], { by: { id: "u-hr" } });
  assert.equal(again.total, 1);
  await waitFor(idle(e.vtc));
  assert.equal(by("Broken").attempts, 2);
});

test("HANG → timeout and the whole process tree is killed; three timeouts in a row abort the job", async () => {
  const e = engine({ autoStart: false, timeoutMs: 1500 });
  const items = [], media = {};
  for (let i = 1; i <= 4; i++) { items.push({ kind: "video", embed: "h" + i + ".wmv", name: "Hang " + i }); media["h" + i + ".wmv"] = Buffer.from("FAKE_FFMPEG_HANG " + i); }
  const { id, src } = deckFile(e.dir, makeDeck({ order: [1], slides: { 1: { items } }, media }));
  await e.vtc.ingestDeck({ attachment: addAttachment(e.store, id), srcPath: src });
  await e.vtc.ready();
  const t0 = Date.now();
  e.vtc.startJob(null, {});
  await waitFor(() => !!e.ffCalls().find((c) => c.hang), 10000, "first hang");
  const running = JSON.parse(e.store.getMeta(vt.META.running));
  assert.equal(running.length, 1, "the running ffmpeg is recorded for crash recovery");
  await waitFor(idle(e.vtc), 30000, "job end");
  assert.ok(Date.now() - t0 < 20000, "three 1.5 s timeouts, not three 30 s self-exits");
  const j = e.vtc.job();
  assert.deepEqual([j.aborted, j.failed, j.done], ["timeouts", 3, 3]);
  const rows = e.store.listAttachmentMedia({ attachmentId: id });
  assert.deepEqual(rows.map((r) => r.status), ["failed", "failed", "failed", "pending"], "the fourth was never tried");
  assert.equal(rows[0].reason, "timeout");
  assert.deepEqual(JSON.parse(e.store.getMeta(vt.META.running)), [], "cleared on settle");
  const hangs = e.ffCalls().filter((c) => c.hang);
  assert.equal(hangs.length, 3);
  await waitFor(() => hangs.every((h) => !alive(h.pid) && !alive(h.childPid)), 8000, "process trees gone");
  assert.equal(vt.reasonText("timeout", "zh", { m: 30 }), "转码超时（超过 30 分钟）");
});

test("shutdown kills a running transcode at once", async () => {
  const e = engine({ autoStart: false, timeoutMs: 60000 });
  await ingestOne(e, "FAKE_FFMPEG_HANG");
  await e.vtc.ready();
  e.vtc.startJob(null, {});
  await waitFor(() => !!e.ffCalls().find((c) => c.hang), 10000, "hang");
  const h = e.ffCalls().find((c) => c.hang);
  const t0 = Date.now();
  e.vtc.shutdown();
  await waitFor(idle(e.vtc), 15000, "job end");
  assert.ok(Date.now() - t0 < 12000);
  await waitFor(() => !alive(h.pid) && !alive(h.childPid), 8000, "tree gone");
});

test("startupRecover: transcoding rows go back to pending, an interrupted job is marked, old v-* dirs go, only unreferenced orphans are deleted", () => {
  const store = fakeStore();
  const e = engine({ store, autoStart: false });
  store.media.set("am-000000000001", { id: "am-000000000001", attachmentId: "att-x", seq: 1, kind: "video", source: "embedded", name: "a", slides: [], srcKey: "am-000000000001.src.wmv", status: "transcoding", attempts: 1 });
  store.media.set("am-000000000002", { id: "am-000000000002", attachmentId: "att-x", seq: 2, kind: "video", source: "embedded", name: "b", slides: [], srcKey: null, storageKey: "am-000000000002.mp4", status: "ready", attempts: 1 });
  for (const k of ["am-000000000001.src.wmv", "am-000000000002.mp4", "am-000000000003.src.avi"]) fs.writeFileSync(path.join(e.attachDir, k), "x");
  store.setMeta(vt.META.orphans, JSON.stringify(["am-000000000001.src.wmv", "am-000000000002.mp4", "am-000000000003.src.avi", "../escape.txt"]));
  store.setMeta(vt.META.lastJob, JSON.stringify({ running: true, startedAt: "2026-10-08T01:00:00.000Z", total: 3, done: 1, currentIds: ["am-000000000001"] }));
  assert.equal(e.vtc.job().interrupted, true);
  const old = e.vtc.makeWorkDir();
  const fresh = e.vtc.makeWorkDir();
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  const r = e.vtc.startupRecover();
  assert.equal(r.reset, 1);
  assert.equal(store.getAttachmentMedia("am-000000000001").status, "pending");
  assert.equal(r.interrupted, true);
  assert.equal(JSON.parse(store.getMeta(vt.META.lastJob)).running, false);
  assert.equal(r.orphansRemoved, 1, "only the unreferenced source is deleted");
  assert.deepEqual(listDir(e.attachDir), ["am-000000000001.src.wmv", "am-000000000002.mp4"]);
  assert.deepEqual(JSON.parse(store.getMeta(vt.META.orphans)), []);
  assert.equal(r.tmpRemoved, 1);
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh));
  e.vtc.shutdown();
});

test("startupRecover kills an ffmpeg left behind by a hard stop only when pid and image name match", async () => {
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", windowsHide: true });
  try {
    await sleep(200);
    const record = JSON.stringify([{ pid: sleeper.pid, mediaId: "am-x", image: path.basename(process.execPath).toLowerCase(), startedAt: "x" }]);
    const guard = engine({ autoStart: false });
    guard.store.setMeta(vt.META.running, record);
    assert.equal(guard.vtc.startupRecover().killed, 0, "a pid whose image is not ffmpeg is never killed (pid reuse)");
    assert.ok(alive(sleeper.pid));
    assert.deepEqual(JSON.parse(guard.store.getMeta(vt.META.running)), []);
    const e = engine({ autoStart: false, staleImages: [path.basename(process.execPath).toLowerCase()] });
    e.store.setMeta(vt.META.running, record);
    assert.equal(e.vtc.startupRecover().killed, 1);
    await waitFor(() => !alive(sleeper.pid), 8000, "stale process killed");
    const wrong = engine({ autoStart: false, staleImages: ["node.exe", "node"] });
    wrong.store.setMeta(vt.META.running, JSON.stringify([{ pid: process.pid, image: "node.exe" }]));
    assert.equal(wrong.vtc.startupRecover().killed, 0, "never kills itself");
  } finally { try { sleeper.kill(); } catch { /* gone */ } }
});

test("the 60 s re-probe: when ffmpeg appears, pending videos start automatically (checkAvailability and the timer)", async () => {
  let have = false;
  const e = engine({ probe: () => (have ? FAKE_FFMPEG : null), reprobeMs: 100 });
  const { row } = await ingestOne(e, "FAKE_WMV");
  await e.vtc.ready();
  assert.equal(e.vtc.state(), "missing");
  assert.equal(e.store.getAttachmentMedia(row.id).status, "pending");
  assert.throws(() => e.vtc.startJob(null, {}), (x) => x.code === "unavailable");
  have = true;
  assert.equal(await e.vtc.checkAvailability(), "ok");
  await waitFor(() => e.store.getAttachmentMedia(row.id).status === "ready", 20000, "auto ready");
  await waitFor(idle(e.vtc));

  let have2 = false;
  const t = engine({ probe: () => (have2 ? FAKE_FFMPEG : null), reprobeMs: 100 });
  const b = await ingestOne(t, "FAKE_WMV");
  t.vtc.startupRecover();
  await t.vtc.ready();
  await sleep(300);
  assert.equal(t.store.getAttachmentMedia(b.row.id).status, "pending");
  have2 = true;
  await waitFor(() => t.store.getAttachmentMedia(b.row.id).status === "ready", 20000, "timer flip");
  await waitFor(idle(t.vtc));
  t.vtc.shutdown();
});

test("startJob errors: unavailable, running (+ job), unknown_media (unknown or not retryable), nothing_to_transcode", async () => {
  const off = engine({ autoStart: false, probe: () => null });
  await off.vtc.ready();
  assert.throws(() => off.vtc.startJob(null, {}), (x) => x.code === "unavailable");
  const e = engine({ autoStart: false, timeoutMs: 60000 });
  await e.vtc.ready();
  assert.throws(() => e.vtc.startJob(null, {}), (x) => x.code === "nothing_to_transcode");
  assert.throws(() => e.vtc.startJob([], {}), (x) => x.code === "nothing_to_transcode", "[] means all");
  const { id, src } = deckFile(e.dir, makePptx());
  await e.vtc.ingestDeck({ attachment: addAttachment(e.store, id), srcPath: src });
  const rows = e.store.listAttachmentMedia({ attachmentId: id });
  const ext = rows.find((r) => r.source === "external");
  const linked = rows.find((r) => r.source === "linked_file");
  assert.throws(() => e.vtc.startJob(["am-nope", ext.id, linked.id], {}), (x) => x.code === "unknown_media" && x.ids.length === 3);
  await ingestOne(e, "FAKE_FFMPEG_HANG");
  e.vtc.startJob(null, {});
  assert.throws(() => e.vtc.startJob(null, {}), (x) => x.code === "running" && x.job && x.job.running === true);
  e.vtc.shutdown();
  await waitFor(idle(e.vtc), 15000);
});

test("kick never throws and does nothing without autoStart, while disabled or when nothing is pending", async () => {
  const e = engine({ autoStart: false });
  await ingestOne(e, "FAKE_WMV");
  assert.equal(e.vtc.kick(), false);
  const d = engine({ disabled: () => true });
  assert.equal(d.vtc.kick(), false);
  const broken = engine({ store: { ...fakeStore(), listAttachmentMedia: () => { throw new Error("db closed"); } } });
  assert.doesNotThrow(() => broken.vtc.kick());
  await sleep(300);
  assert.equal(broken.vtc.job().running, false);
});

test("daily source cleanup runs once per day at the configured hour (outside the 03:00 backup)", () => {
  let clock = new Date(2026, 9, 8, 11, 30).getTime();
  const e = engine({ autoStart: false, sweepHour: 12, now: () => clock });
  fs.writeFileSync(path.join(e.attachDir, "am-00000000000a.src.wmv"), "x");
  e.store.setMeta(vt.META.orphans, JSON.stringify(["am-00000000000a.src.wmv"]));
  assert.equal(e.vtc.sweepIfDue(), false, "not yet noon");
  clock = new Date(2026, 9, 8, 12, 5).getTime();
  assert.equal(e.vtc.sweepIfDue(), true);
  assert.deepEqual(listDir(e.attachDir), []);
  assert.equal(e.vtc.sweepIfDue(), false, "once per day");
  clock = new Date(2026, 9, 9, 12, 1).getTime();
  assert.equal(e.vtc.sweepIfDue(), true);
});

test("texts: every reason has zh + en; slide labels use PowerPoint numbers, hidden-only reads 隐藏页 / hidden slide", () => {
  for (const [k, v] of Object.entries(vt.REASONS)) assert.ok(v.zh && v.en, k);
  for (const k of ["unavailable", "no_encoder", "timeout", "error", "no_mp4", "source_missing", "too_large", "too_long", "unsupported_format", "unsupported_compression", "pptx_unreadable", "zip64_unsupported", "linked_file", "hidden_slide", "audio_not_supported", "too_many_media", "disk_full", "storage_limit", "cancelled"]) assert.ok(vt.REASONS[k], k);
  const item = { name: "demo.wmv", reason: "unsupported_format", srcExt: "swf", slides: [{ slideNo: 4, pageNo: 3 }, { slideNo: 9, pageNo: 8 }] };
  assert.equal(vt.lineFor("产品培训.pptx", item, "zh"), "「产品培训.pptx」第 4、9 页「demo.wmv」：不支持的视频格式（.swf）");
  assert.equal(vt.lineFor("Product.pptx", item, "en"), "\"Product.pptx\" slides 4, 9 \"demo.wmv\": Unsupported video format (.swf)");
  assert.equal(vt.lineFor("D", { name: "x", reason: "hidden_slide", slides: [{ slideNo: 3, pageNo: null }] }, "zh"), "「D」隐藏页「x」：视频在隐藏的幻灯片上，学员看不到，已跳过");
  assert.match(vt.lineFor("D", { name: "x", reason: "hidden_slide", slides: [{ slideNo: 3, pageNo: null }] }, "en"), /^"D" hidden slide "x"/);
  assert.deepEqual(vt.summarize([{ status: "ready" }, { status: "pending" }, { status: "pending" }, { status: "external" }]), { total: 4, ready: 1, pending: 2, transcoding: 0, failed: 0, external: 1, skipped: 0 });
  assert.deepEqual(vt.parseProbe("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'file:x':\n  Duration: 01:02:03.50, start\n  Stream #0:0[0x1](und): Video: h264 (High)\n  Stream #0:1(und): Audio: aac (LC)\n"),
    { durationSec: 3723.5, container: "mov,mp4,m4a,3gp,3g2,mj2", video: "h264", audio: "aac" });
  assert.equal(vt.canCopy({ container: "asf", video: "h264", audio: "aac" }), false);
  assert.equal(vt.canCopy({ container: "mov,mp4,m4a,3gp,3g2,mj2", video: "h264", audio: null }), true);
  assert.equal(vt.canCopy({ container: "mov,mp4,m4a,3gp,3g2,mj2", video: "h264", audio: "mp3" }), false);
});
