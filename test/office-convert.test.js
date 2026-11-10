// P0 1.3 / 1.4：Office 课件只转成在线只读 PDF、转不了就拒绝上传；存量原文件在后台在线补转。
// 全程用测试替身 test/fixtures/fake-soffice.js，本机不需要 LibreOffice。
//   · "engine: …"  直接驱动 modules/learning/office-convert.js（进程内 store，库在系统临时目录）：
//                  状态与版本、未安装 / 已停用、no_pdf / error / 超时、临时目录与配置目录清理、
//                  上传通道不排在批量任务后面、批量任务（条件更新、不在线删原文件、失败记录、连续超时中止、
//                  发起人上下文）、启动清理、shutdown。
//   · "http: …"    经 server.js 的真实接口（A 组接线之后才会通过）：上传转换、上传失败不留痕、
//                  存量原文件 409 + 在线补转 + 重启后清理原文件、两条新路由的权限与模块开关。
// node --test 每个文件一个进程，所以可以在 require store.js 之前设好 LMS_DB_PATH 等变量。
"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ADMIN, EMPLOYEE, FAKE_SOFFICE, startServer, loginAs, tempDir } = require("./helpers.js");

const TMP = tempDir("lms-office-convert-");
process.env.LMS_DB_PATH = path.join(TMP, "unit.db");
process.env.LMS_ATTACH_DIR = path.join(TMP, "unit-attachments");
process.env.LMS_CONFIG_PATH = path.join(TMP, "config.json");
const store = require("../store.js");
const officeConvert = require("../modules/learning/office-convert.js");
store.init({ hashPassword: (pw) => "test-hash:" + pw });
after(() => { try { store.close(); } catch { /* already closed */ } });

const SAMPLES = path.join(__dirname, "..", "scripts", "samples");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const META_KEYS = Object.values(officeConvert.META);
const resetMeta = () => { for (const k of META_KEYS) store.setMeta(k, "null"); };
const meta = (k) => { const v = store.getMeta(k); return v == null ? null : JSON.parse(v); };
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

let seq = 0;
function engine(extra = {}) {
  const dir = path.join(TMP, "e" + (++seq));
  const attachDir = path.join(dir, "attachments");
  fs.mkdirSync(attachDir, { recursive: true });
  const logs = [];
  const office = officeConvert.create({
    attachDir, probe: () => FAKE_SOFFICE, disabled: () => false, store, log: (m) => logs.push(m), ...extra,
  });
  return { office, attachDir, logs, dir };
}
function srcFile(office, name, content) {
  const workDir = office.makeWorkDir();
  const p = path.join(workDir, name);
  if (Buffer.isBuffer(content) || typeof content === "string") fs.writeFileSync(p, content);
  else fs.copyFileSync(path.join(SAMPLES, content.sample), p);
  return { workDir, src: p };
}
async function waitJob(office, ms = 20000) {
  const t0 = Date.now();
  while (office.job().running) {
    if (Date.now() - t0 > ms) throw new Error("job still running after " + ms + " ms");
    await sleep(50);
  }
  return office.job();
}
let attSeq = 0;
function legacyRow(attachDir, { content, sample, ext = ".pptx", kind = "doc", noFile = false }) {
  const id = "att-unit" + (++attSeq);
  if (!noFile) {
    if (sample) fs.copyFileSync(path.join(SAMPLES, sample), path.join(attachDir, id + ext));
    else fs.writeFileSync(path.join(attachDir, id + ext), content || "x");
  }
  store.createAttachment({ id, courseId: "culture-conduct", kind, storageKey: id + ext, originalName: "Legacy " + id + ext, mime: "application/octet-stream", size: 1, uploadedBy: "u-admin" });
  return id;
}

// ---------------------------------------------------------------- engine

test("engine: status reports ok with the version from --version; includePath:false hides the path", async () => {
  resetMeta();
  const { office } = engine();
  assert.equal(office.available(), FAKE_SOFFICE);
  assert.equal(office.state(), "ok");
  const st = await office.status();
  assert.equal(st.state, "ok");
  assert.equal(st.path, FAKE_SOFFICE);
  assert.equal(st.version, "7.6.0.0");
  assert.equal(st.versionSource, "--version");
  assert.ok(st.probedAt);
  assert.equal(st.lastConversion, null);
  const hidden = await office.status({ includePath: false });
  assert.equal(hidden.path, null);
  assert.equal(hidden.version, "7.6.0.0");
});

test("engine: version.ini next to the binary wins over --version (MsiProductVersion, then ProductMajor/Minor)", async () => {
  const dir = path.join(TMP, "lo-install", "program");
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "soffice.exe");
  fs.writeFileSync(bin, "not really soffice");
  fs.writeFileSync(path.join(dir, "version.ini"), "[Version]\r\nbuildid=abc\r\nMsiProductVersion=7.6.4.1\r\n");
  const { office } = engine({ probe: () => bin });
  const st = await office.status();
  assert.equal(st.version, "7.6.4.1");
  assert.equal(st.versionSource, "version.ini");
  const ini2 = path.join(TMP, "v2.ini");
  fs.writeFileSync(ini2, "ProductMajor=24\nProductMinor=2\n");
  assert.equal(officeConvert.parseVersionFile(ini2), "24.2");
  assert.equal(officeConvert.parseVersionFile(path.join(TMP, "nope.ini")), null);
});

test("engine: missing converter (probe → null) re-probes at most every 60 s; disabled never probes", async () => {
  let t = 1_000_000, calls = [];
  const { office } = engine({ probe: (force) => { calls.push(!!force); return null; }, now: () => t });
  assert.equal(office.available(), null);
  assert.equal(office.state(), "missing");
  assert.deepEqual(calls, [false]);
  t += 30_000;
  office.available();
  assert.equal(calls.length, 1, "no re-probe within 60 s");
  t += 31_000;
  office.available();
  assert.deepEqual(calls, [false, true], "forced re-probe after 60 s");
  const st = await office.status();
  assert.equal(st.state, "missing");
  assert.equal(st.path, null);
  assert.equal(st.version, null);
  const { workDir, src } = srcFile(office, "a.pptx", "hello");
  await assert.rejects(office.convertFile(src, { workDir }), (e) => e.reason === "unavailable");
  assert.throws(() => office.startJob(null, {}), (e) => e.code === "unavailable");

  let probes = 0;
  const off = engine({ probe: () => { probes++; return FAKE_SOFFICE; }, disabled: () => true }).office;
  assert.equal(off.available(), null);
  assert.equal(off.state(), "disabled");
  const ds = await off.status({ refresh: true });
  assert.equal(ds.state, "disabled");
  assert.equal(ds.path, null);
  assert.equal(probes, 0, "a disabled converter is never probed");
});

test("engine: ?refresh re-probes at most every 10 s", async () => {
  let t = 5_000_000, forced = 0;
  const { office } = engine({ probe: (force) => { if (force) forced++; return FAKE_SOFFICE; }, now: () => t });
  await office.status({ refresh: true });
  await office.status({ refresh: true });
  assert.equal(forced, 1, "second refresh within 10 s is ignored");
  t += 10_001;
  await office.status({ refresh: true });
  assert.equal(forced, 2);
});

test("engine: converts a .pptx to a PDF pdfjs can read; the LibreOffice profile dir is removed; lastConversion is recorded", async () => {
  resetMeta();
  const { office, attachDir } = engine();
  const { workDir, src } = srcFile(office, "att-x1.pptx", { sample: "sample-slides.pptx" });
  const r = await office.convertFile(src, { workDir, priority: "upload" });
  assert.equal(path.dirname(r.pdfPath), workDir);
  assert.equal(path.basename(r.pdfPath), "att-x1.pdf");
  assert.ok(office.hasPdfMagic(r.pdfPath));
  assert.ok(r.size > 100);
  assert.deepEqual(listDir(path.join(office.tmpRoot, "profiles")), [], "per-conversion profile dir removed");
  const last = (await office.status()).lastConversion;
  assert.equal(last.ok, true);
  assert.equal(last.source, "upload");
  assert.equal(meta(officeConvert.META.last).ok, true, "persisted in meta");
  // convertUpload = convert + move into the attachment dir
  const u = srcFile(office, "att-x2.docx", { sample: "sample-handbook.docx" });
  const up = await office.convertUpload(u.src, { workDir: u.workDir, storageKey: "att-x2.pdf" });
  assert.equal(up.storageKey, "att-x2.pdf");
  assert.ok(fs.existsSync(path.join(attachDir, "att-x2.pdf")));
  assert.equal(up.size, fs.statSync(path.join(attachDir, "att-x2.pdf")).size);
  assert.equal(await office.discardStored("att-x2.pdf"), true);
  assert.ok(!fs.existsSync(path.join(attachDir, "att-x2.pdf")));
  // work dirs: removed only inside tmpRoot, idempotent
  assert.equal(office.rmWorkDir(workDir), true);
  assert.equal(office.rmWorkDir(workDir), true);
  assert.ok(!fs.existsSync(workDir));
  assert.equal(office.rmWorkDir(attachDir), false, "refuses a directory outside the temp root");
  assert.ok(fs.existsSync(attachDir));
  await assert.rejects(office.storePdf(r.pdfPath, "../escape.pdf"));
});

test("engine: error, no_pdf and timeout reasons; the hung converter is killed (not left for its own 30 s exit)", async () => {
  resetMeta();
  const { office } = engine({ timeoutMs: 1000 });
  const fail = srcFile(office, "f.pptx", "FAKE_SOFFICE_FAIL");
  await assert.rejects(office.convertFile(fail.src, { workDir: fail.workDir }), (e) => e.reason === "error");
  const nopdf = srcFile(office, "n.docx", "FAKE_SOFFICE_NOPDF");
  await assert.rejects(office.convertFile(nopdf.src, { workDir: nopdf.workDir }), (e) => e.reason === "no_pdf");
  const notPdf = srcFile(office, "g.xlsx", "x");
  fs.writeFileSync(path.join(notPdf.workDir, "g.pdf"), "not a pdf");
  assert.equal(office.hasPdfMagic(path.join(notPdf.workDir, "g.pdf")), false);
  const hang = srcFile(office, "h.pptx", "FAKE_SOFFICE_HANG");
  const t0 = Date.now();
  await assert.rejects(office.convertFile(hang.src, { workDir: hang.workDir }), (e) => e.reason === "timeout");
  assert.ok(Date.now() - t0 < 8000, "settled by the kill, not by the 10 s fallback (" + (Date.now() - t0) + " ms)");
  const last = (await office.status()).lastConversion;
  assert.equal(last.ok, false);
  assert.equal(last.reason, "timeout");
  assert.deepEqual(listDir(path.join(office.tmpRoot, "profiles")), [], "profile dirs removed after failures too");
});

test("engine: an upload is not queued behind a running batch conversion (separate lane)", async () => {
  resetMeta();
  const { office, attachDir } = engine({ timeoutMs: 4000 });
  const hangId = legacyRow(attachDir, { content: "FAKE_SOFFICE_HANG" });
  office.startJob([hangId], {});
  await sleep(300);
  assert.equal(office.job().running, true);
  const { workDir, src } = srcFile(office, "up.pptx", { sample: "sample-slides.pptx" });
  const t0 = Date.now();
  await office.convertFile(src, { workDir, priority: "upload" });
  assert.ok(Date.now() - t0 < 3000, "upload finished while the batch item was still hanging");
  assert.equal(office.job().running, true);
  const j = await waitJob(office);
  assert.equal(j.failed, 1);
});

test("engine: batch job — conditional update, originals kept as orphans until startup cleanup, failures recorded, hooks + actor context", async () => {
  resetMeta();
  const ctxCalls = [];
  const { office, attachDir } = engine({ runInContext: (ctx, fn) => { ctxCalls.push(ctx); return fn(); } });
  const good = legacyRow(attachDir, { sample: "sample-slides.pptx" });
  fs.writeFileSync(path.join(attachDir, good + ".pptx.txt"), "cached text of the original");
  const bad = legacyRow(attachDir, { content: "FAKE_SOFFICE_FAIL", ext: ".docx" });
  const gone = legacyRow(attachDir, { noFile: true, ext: ".xlsx" });
  const pdfRow = legacyRow(attachDir, { content: "%PDF-1.4\n", ext: ".pdf", kind: "pdf" });
  assert.equal(office.isOfficeAttachment(store.getAttachment(pdfRow)), false);
  assert.equal(office.isOfficeAttachment({ kind: "pdf", storageKey: "x.PPTX" }), true, "an Office extension counts even if kind says otherwise");

  const pend = office.pendingAttachments().filter((p) => [good, bad, gone].includes(p.id));
  assert.equal(pend.length, 3);
  assert.equal(pend.find((p) => p.id === gone).fileMissing, true);
  assert.equal(pend.find((p) => p.id === good).ext, ".pptx");

  const converted = [], failed = [];
  const snap = office.startJob([good, bad, gone], {
    by: { id: "u-admin", name: "Admin" }, requestId: "req-1",
    onConverted: (att, info) => converted.push({ id: att.id, ...info }),
    onFailed: (att, reason) => failed.push({ id: att.id, reason }),
  });
  assert.equal(snap.running, true);
  assert.equal(snap.total, 3);
  assert.deepEqual(snap.by, { id: "u-admin", name: "Admin" });
  assert.deepEqual(ctxCalls, [{ actorId: "u-admin", requestId: "req-1" }], "the job runs as the person who started it");
  assert.throws(() => office.startJob([bad], {}), (e) => e.code === "running");

  const j = await waitJob(office);
  assert.equal(j.running, false);
  assert.equal(j.done, 3);
  assert.equal(j.converted, 1);
  assert.equal(j.failed, 1);
  assert.equal(j.missing, 1);
  assert.ok(j.finishedAt);
  assert.deepEqual(meta(officeConvert.META.lastJob).converted, 1, "job snapshot persisted");

  const row = store.getAttachment(good);
  assert.equal(row.kind, "pdf");
  assert.equal(row.storageKey, good + ".pdf");
  assert.equal(row.mime, "application/pdf");
  assert.equal(row.size, fs.statSync(path.join(attachDir, good + ".pdf")).size);
  assert.deepEqual(converted, [{ id: good, fromKey: good + ".pptx", storageKey: good + ".pdf", size: row.size }]);
  assert.deepEqual(failed, [{ id: bad, reason: "error" }]);
  // H5：在线补转不删原文件，记进 orphans，等启动清理
  assert.ok(fs.existsSync(path.join(attachDir, good + ".pptx")), "original kept while the server runs");
  assert.ok(fs.existsSync(path.join(attachDir, good + ".pptx.txt")));
  assert.deepEqual(meta(officeConvert.META.orphans), [good + ".pptx", good + ".pptx.txt"]);
  assert.equal(meta(officeConvert.META.errors)[bad].reason, "error");
  const pend2 = office.pendingAttachments().filter((p) => [good, bad, gone].includes(p.id));
  assert.deepEqual(pend2.map((p) => p.id).sort(), [bad, gone].sort());
  assert.equal(pend2.find((p) => p.id === bad).lastError.reason, "error");
  assert.ok(!listDir(office.tmpRoot).some((n) => n.startsWith("w-")), "work dirs removed");

  // 条件更新：附件行已不再指向原文件 → false
  assert.equal(store.convertAttachmentToPdf(good, good + ".pptx", { storageKey: "x.pdf", size: 1 }), false);
  assert.equal(store.getAttachment(good).storageKey, good + ".pdf");

  // 启动清理：删掉孤儿原文件（没有附件行再指向它们）
  const r = office.startupCleanup();
  assert.equal(r.orphansRemoved, 2);
  assert.ok(!fs.existsSync(path.join(attachDir, good + ".pptx")));
  assert.ok(!fs.existsSync(path.join(attachDir, good + ".pptx.txt")));
  assert.ok(fs.existsSync(path.join(attachDir, good + ".pdf")));
  assert.deepEqual(meta(officeConvert.META.orphans), []);
});

// 第三批 5.7：批量补转的 afterConvert 钩子（server.js 用它从 .pptx 原文件抽内嵌视频）
test("engine: afterConvert is awaited after the row becomes a PDF and before the original is queued for deletion; a throwing hook does not fail the conversion", async () => {
  resetMeta();
  const calls = [];
  let throwFor = null;
  const { office, attachDir, logs } = engine({
    afterConvert: async (att, srcPath, pdfPath) => {
      calls.push({
        id: att.id, kind: att.kind, storageKey: att.storageKey,
        srcExists: fs.existsSync(srcPath), srcIsOriginal: path.basename(srcPath) === att.id + ".pptx",
        pdfExists: fs.existsSync(pdfPath), pdfInAttachDir: path.dirname(pdfPath) === attachDir,
        orphansBefore: meta(officeConvert.META.orphans) || [],
      });
      await sleep(30);
      if (att.id === throwFor) throw new Error("boom");
    },
  });
  const good = legacyRow(attachDir, { sample: "sample-slides.pptx" });
  const thrower = legacyRow(attachDir, { sample: "sample-slides.pptx" });
  const failing = legacyRow(attachDir, { content: "FAKE_SOFFICE_FAIL" });
  throwFor = thrower;
  office.startJob([good, thrower, failing], {});
  const j = await waitJob(office);
  assert.equal(j.converted, 2);
  assert.equal(j.failed, 1);
  assert.deepEqual(calls.map((c) => c.id), [good, thrower], "never called for a failed conversion");
  for (const c of calls) {
    assert.equal(c.kind, "pdf", "the hook sees the converted row");
    assert.equal(c.storageKey, c.id + ".pdf");
    assert.equal(c.srcExists && c.srcIsOriginal, true, "the original is still there");
    assert.equal(c.pdfExists && c.pdfInAttachDir, true);
    assert.ok(!c.orphansBefore.includes(c.id + ".pptx"), "runs before the original is queued for deletion");
  }
  assert.equal(store.getAttachment(thrower).kind, "pdf", "a throwing hook does not undo the conversion");
  assert.ok(logs.some((l) => /afterConvert failed for .*boom/.test(l)));
  assert.deepEqual(meta(officeConvert.META.orphans), [good + ".pptx", good + ".pptx.txt", thrower + ".pptx", thrower + ".pptx.txt"]);
});

test("engine: an orphan that is referenced again is never deleted", () => {
  resetMeta();
  const { office, attachDir } = engine();
  const id = legacyRow(attachDir, { content: "still in use" });
  store.setMeta(officeConvert.META.orphans, JSON.stringify([id + ".pptx", "../outside.txt"]));
  const r = office.cleanOrphans();
  assert.equal(r.removed, 0);
  assert.ok(fs.existsSync(path.join(attachDir, id + ".pptx")));
  assert.deepEqual(meta(officeConvert.META.orphans), []);
});

test("engine: startJob refuses unknown ids, non-Office ids and an empty list", () => {
  resetMeta();
  const { office, attachDir } = engine();
  const pdfRow = legacyRow(attachDir, { content: "%PDF-1.4\n", ext: ".pdf", kind: "pdf" });
  assert.throws(() => office.startJob(["att-nope", pdfRow], {}), (e) => e.code === "unknown_attachment" && e.ids.length === 2);
  assert.throws(() => office.startJob([], {}), (e) => e.code === "nothing_to_convert");
  assert.equal(office.job().running, false);
});

test("engine: three timeouts in a row abort the batch", async () => {
  resetMeta();
  const { office, attachDir } = engine({ timeoutMs: 1000 });
  const ids = [1, 2, 3, 4].map(() => legacyRow(attachDir, { content: "FAKE_SOFFICE_HANG" }));
  office.startJob(ids, {});
  const j = await waitJob(office, 30000);
  assert.equal(j.aborted, "timeouts");
  assert.equal(j.failed, 3);
  assert.equal(j.done, 3);
  assert.equal(meta(officeConvert.META.errors)[ids[0]].reason, "timeout");
  assert.equal(store.getAttachment(ids[3]).kind, "doc", "the fourth was never tried");
});

test("engine: a job left running by a previous process shows as interrupted; startup cleanup rewrites it", () => {
  resetMeta();
  store.setMeta(officeConvert.META.lastJob, JSON.stringify({ running: true, startedAt: "2026-10-07T01:00:00.000Z", total: 5, done: 2, currentId: "att-x" }));
  const { office } = engine();
  const j = office.job();
  assert.equal(j.running, false);
  assert.equal(j.interrupted, true);
  assert.equal(j.currentId, null);
  assert.equal(j.done, 2);
  const r = office.startupCleanup();
  assert.equal(r.interrupted, true);
  assert.equal(meta(officeConvert.META.lastJob).running, false);
  assert.equal(meta(officeConvert.META.lastJob).interrupted, true);
});

test("engine: startup cleanup removes temp entries older than an hour and keeps fresh ones", () => {
  const { office } = engine();
  const oldWork = office.makeWorkDir();
  fs.writeFileSync(path.join(oldWork, "half.pdf"), "x");
  const profiles = path.join(office.tmpRoot, "profiles");
  const oldProfile = path.join(profiles, "p-old");
  fs.mkdirSync(path.join(oldProfile, "user"), { recursive: true });
  const fresh = office.makeWorkDir();
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(oldWork, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(oldProfile, twoHoursAgo, twoHoursAgo);
  const r = office.startupCleanup();
  assert.equal(r.tmpRemoved, 2);
  assert.ok(!fs.existsSync(oldWork));
  assert.ok(!fs.existsSync(oldProfile));
  assert.ok(fs.existsSync(fresh), "a work dir in use is left alone");
  assert.ok(fs.existsSync(profiles));
});

test("engine: shutdown kills a running conversion at once", async () => {
  const { office } = engine({ timeoutMs: 60000 });
  const { workDir, src } = srcFile(office, "s.pptx", "FAKE_SOFFICE_HANG");
  const t0 = Date.now();
  const p = office.convertFile(src, { workDir });
  await sleep(500);
  office.shutdown();
  await assert.rejects(p, (e) => e.reason === "error" || e.reason === "timeout");
  assert.ok(Date.now() - t0 < 8000, "settled right after shutdown");
});

// 审查（P0 修复轮）：客户端已断开的上传不占着上传通道 —— 排队中不启动、转换中立即杀掉，都不放进附件目录、不记 lastConversion
test("engine: an upload whose client went away is cancelled — not started while queued, killed while converting, never placed", async () => {
  resetMeta();
  const { office, attachDir } = engine({ timeoutMs: 60000 });
  const a = srcFile(office, "a.pptx", { sample: "sample-slides.pptx" });
  const gone1 = new AbortController();
  gone1.abort();
  await assert.rejects(office.convertUpload(a.src, { workDir: a.workDir, storageKey: "att-c1.pdf", signal: gone1.signal }), (e) => e.reason === "cancelled");
  const h = srcFile(office, "h.pptx", "FAKE_SOFFICE_HANG");
  const gone2 = new AbortController();
  const t0 = Date.now();
  const p = office.convertUpload(h.src, { workDir: h.workDir, storageKey: "att-c2.pdf", signal: gone2.signal });
  await sleep(500);
  gone2.abort();
  await assert.rejects(p, (e) => e.reason === "cancelled");
  assert.ok(Date.now() - t0 < 8000, "the hung converter was killed when the client left (" + (Date.now() - t0) + " ms)");
  assert.deepEqual(listDir(attachDir), [], "nothing placed in the attachment dir");
  assert.equal((await office.status()).lastConversion, null, "a cancelled upload is not recorded as a conversion");
  assert.deepEqual(listDir(path.join(office.tmpRoot, "profiles")), [], "profile dir removed after a cancel");
  // 通道已经让出来：下一个上传照常转换
  const ok = srcFile(office, "ok.pptx", { sample: "sample-slides.pptx" });
  const up = await office.convertUpload(ok.src, { workDir: ok.workDir, storageKey: "att-c3.pdf" });
  assert.equal(up.storageKey, "att-c3.pdf");
  assert.deepEqual(listDir(attachDir), ["att-c3.pdf"]);
  for (const w of [a, h, ok]) office.rmWorkDir(w.workDir);
});

test("engine: hasPdfMagic is strict at byte 0 by default; { within: 1024 } finds the header after a BOM / CRLF like pdf.js", () => {
  const plain = Buffer.from("%PDF-1.7\n1 0 obj\n");
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a]), plain]);
  const late = Buffer.concat([Buffer.alloc(1100, 0x20), plain]);
  assert.equal(officeConvert.hasPdfMagic(plain), true);
  assert.equal(officeConvert.hasPdfMagic(bom), false, "converter output must start with %PDF-");
  assert.equal(officeConvert.hasPdfMagic(bom, { within: 1024 }), true);
  assert.equal(officeConvert.hasPdfMagic(late, { within: 1024 }), false, "only the first 1024 bytes count");
  assert.equal(officeConvert.hasPdfMagic(Buffer.from("\r\n%PDF-"), { within: 1024 }), false, "a bare header is not a PDF");
  const f = path.join(TMP, "bom.pdf");
  fs.writeFileSync(f, bom);
  assert.equal(officeConvert.hasPdfMagic(f), false);
  assert.equal(officeConvert.hasPdfMagic(f, { within: 1024 }), true);
});

test("engine: a batch item whose row changed meanwhile keeps the new PDF as an orphan (no online delete) until startup cleanup", async () => {
  resetMeta();
  const { office, attachDir } = engine();
  const id = legacyRow(attachDir, { sample: "sample-slides.pptx" });
  office.startJob([id], {});
  await sleep(100);   // 转换（两次进程启动）至少要 ~300 ms：此时附件行被别处改了
  store.updateAttachment(id, { storageKey: id + "-new.pptx" });
  const j = await waitJob(office);
  assert.equal(j.failed, 1);
  assert.equal(meta(officeConvert.META.errors)[id].reason, "changed");
  assert.ok(fs.existsSync(path.join(attachDir, id + ".pdf")), "the stray PDF is not deleted while the server runs");
  assert.ok(meta(officeConvert.META.orphans).includes(id + ".pdf"));
  office.startupCleanup();
  assert.ok(!fs.existsSync(path.join(attachDir, id + ".pdf")), "removed at the next start");
});

// ---------------------------------------------------------------- http
// 超时给足 8 秒：成功的转换也要起两次 node 进程（fake-soffice + 抽文字），全量并行跑时 1.5 秒会偶发超时（审查）。
// 卡住的用例因此各多等几秒；超时与杀进程本身由上面的引擎单测（1 秒）覆盖。
const FAKE_ENV = { LMS_DISABLE_OFFICE_CONVERT: "0", LMS_SOFFICE: FAKE_SOFFICE, LMS_OFFICE_CONVERT_TIMEOUT_MS: "8000" };
const attachDirOf = (srv) => path.join(path.dirname(srv.dbPath), "attachments");
const countRows = (srv, sql, ...a) => {
  const db = new DatabaseSync(srv.dbPath, { readOnly: true });
  try { return db.prepare(sql).get(...a).n; } finally { db.close(); }
};
async function waitHttpJob(admin, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const r = await admin.get("/api/admin/attachments/office-status");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (!r.data.job.running) return r.data;
    if (Date.now() - t0 > ms) throw new Error("conversion job still running after " + ms + " ms");
    await sleep(100);
  }
}

test("http: with the converter disabled (test default) status says disabled and a conversion run is refused", async () => {
  const srv = await startServer();
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const st = await admin.get("/api/admin/attachments/office-status");
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.equal(st.data.converter.state, "disabled");
    assert.equal(st.data.job.running, false);
    assert.ok(Array.isArray(st.data.pending));
    const run = await admin.post("/api/admin/attachments/office-convert", {});
    assert.equal(run.status, 409, JSON.stringify(run.data));
    assert.equal(run.data.code, "office_converter_unavailable");
  } finally { await srv.stopAsync(); }
});

test("http: uploads convert through the fake converter; failures and timeouts are refused without a record or a file", async () => {
  const srv = await startServer({ env: FAKE_ENV });
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const emp = await loginAs(srv.base, EMPLOYEE);
    const attachDir = attachDirOf(srv);
    const filesBefore = listDir(attachDir); // 启动时种入的演示 PDF
    const up = await admin.upload("/api/admin/attachments?name=deck.pptx&courseId=culture-conduct", fs.readFileSync(path.join(SAMPLES, "sample-slides.pptx")));
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.kind, "pdf");
    assert.equal(up.data.converted, true);
    assert.equal(up.data.originalName, "deck.pptx");
    const res = await emp.raw("GET", "/api/attachments/" + up.data.id);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/pdf/);
    assert.match(res.headers.get("content-disposition") || "", /inline/);
    assert.doesNotMatch(res.headers.get("content-disposition") || "", /attachment/);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(listDir(attachDir), [...filesBefore, up.data.id + ".pdf"].sort(), "only the PDF lands in the attachment dir");
    assert.ok(!listDir(attachDir + ".convert-tmp").some((n) => n.startsWith("w-")), "no work dir left behind");

    for (const [name, body, reason] of [
      ["broken.pptx", "FAKE_SOFFICE_FAIL", "error"],
      ["empty.docx", "FAKE_SOFFICE_NOPDF", "no_pdf"],
      ["stuck.xlsx", "FAKE_SOFFICE_HANG", "timeout"],
    ]) {
      const r = await admin.upload(`/api/admin/attachments?name=${name}&courseId=culture-conduct`, Buffer.from(body));
      assert.equal(r.status, 422, name + " " + JSON.stringify(r.data));
      assert.equal(r.data.code, "office_convert_failed");
      assert.equal(r.data.reason, reason, name);
      assert.equal(countRows(srv, "SELECT COUNT(*) AS n FROM attachments WHERE originalName = ?", name), 0, "no row for " + name);
    }
    assert.deepEqual(listDir(attachDir), [...filesBefore, up.data.id + ".pdf"].sort(), "failed uploads leave no file");
    assert.ok(!listDir(attachDir + ".convert-tmp").some((n) => n.startsWith("w-")));

    const st = (await admin.get("/api/admin/attachments/office-status")).data;
    assert.equal(st.converter.state, "ok");
    assert.equal(st.converter.version, "7.6.0.0");
    assert.equal(st.converter.lastConversion.ok, false);
    assert.equal(st.converter.lastConversion.reason, "timeout");
    assert.equal(st.converter.lastConversion.source, "upload");
    assert.equal(st.counts.pending, 0);
    const none = await admin.post("/api/admin/attachments/office-convert", {});
    assert.equal(none.status, 400, JSON.stringify(none.data));
    assert.equal(none.data.code, "nothing_to_convert");

    // 权限：员工被拒；培训只读角色能看状态、不能发起转换
    assert.equal((await emp.get("/api/admin/attachments/office-status")).status, 403);
    const role = await admin.post("/api/admin/roles", { name: "Learning Viewer OC", name_zh: "培训只读 OC", grants: { learning: "read" } });
    assert.equal(role.status, 200, JSON.stringify(role.data));
    const created = await admin.post("/api/admin/employees", { name: "OC Viewer", employeeId: "DP-OCV" });
    const u = (await admin.get("/api/admin/roster")).data.find((x) => x.employeeId === "DP-OCV");
    assert.equal((await admin.put("/api/admin/employees/" + u.id, { adminRoleId: role.data.role.id })).status, 200);
    const viewer = await loginAs(srv.base, { employeeId: "DP-OCV", password: created.data.password });
    await viewer.post("/api/auth/change-password", { currentPassword: created.data.password, newPassword: "oc-viewer-pw-2026" });
    const vs = await viewer.get("/api/admin/attachments/office-status");
    assert.equal(vs.status, 200, JSON.stringify(vs.data));
    assert.equal(vs.data.converter.state, "ok");
    assert.equal((await viewer.post("/api/admin/attachments/office-convert", {})).status, 403);
  } finally { await srv.stopAsync(); }
});

// 审查（P0 修复轮）：.pdf 也先写进工作目录，校验通过才挪进附件目录 —— 不是 PDF 的不会在附件目录里「出现又被删掉」
// （夜间备份正在复制附件目录时会让整份备份作废）；文件头与 pdf.js 同口径，前面多个 BOM / 换行的 PDF 照收。
test("http: .pdf uploads are staged — a renamed non-PDF is refused (pdf_invalid) without touching the attachment dir; a PDF with a leading BOM is accepted", async () => {
  const srv = await startServer();
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const attachDir = attachDirOf(srv);
    const filesBefore = listDir(attachDir);
    const bad = await admin.upload("/api/admin/attachments?name=renamed.pdf&courseId=culture-conduct", fs.readFileSync(path.join(SAMPLES, "sample-handbook.docx")));
    assert.equal(bad.status, 422, JSON.stringify(bad.data));
    assert.equal(bad.data.code, "pdf_invalid");
    assert.equal(countRows(srv, "SELECT COUNT(*) AS n FROM attachments WHERE originalName = ?", "renamed.pdf"), 0);
    assert.deepEqual(listDir(attachDir), filesBefore, "nothing written into the attachment dir");
    assert.ok(!listDir(attachDir + ".convert-tmp").some((n) => n.startsWith("w-")), "work dir removed");
    const bomPdf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a]), Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")]);
    const ok = await admin.upload("/api/admin/attachments?name=exported.pdf&courseId=culture-conduct", bomPdf);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.kind, "pdf");
    assert.equal(ok.data.size, bomPdf.length);
    assert.deepEqual(listDir(attachDir), [...filesBefore, ok.data.id + ".pdf"].sort());
    assert.ok(!listDir(attachDir + ".convert-tmp").some((n) => n.startsWith("w-")));
  } finally { await srv.stopAsync(); }
});

test("http: a legacy Office original is never downloadable; HR converts it online; the original is removed at the next start", async () => {
  const first = await startServer({ env: FAKE_ENV });
  const dbPath = first.dbPath;
  const attachDir = attachDirOf(first);
  await first.stopAsync();
  // 存量原文件：直接写库 + 复制文件（上传接口已不可能产生 kind "doc"）
  fs.mkdirSync(attachDir, { recursive: true });
  fs.copyFileSync(path.join(SAMPLES, "sample-slides.pptx"), path.join(attachDir, "att-legacy1.pptx"));
  fs.writeFileSync(path.join(attachDir, "att-legacy1.pptx.txt"), "cached text");
  fs.writeFileSync(path.join(attachDir, "att-legacyh.pptx"), "FAKE_SOFFICE_HANG");
  const db = new DatabaseSync(dbPath);
  try {
    const ins = db.prepare("INSERT INTO attachments (id, courseId, kind, storageKey, originalName, mime, size, uploadedBy, createdAt, ownerKind, ownerId) VALUES (?, 'culture-conduct', 'doc', ?, ?, 'application/vnd.ms-powerpoint', ?, 'u-admin', ?, 'course', 'culture-conduct')");
    ins.run("att-legacy1", "att-legacy1.pptx", "Legacy deck.pptx", 1234, "2026-09-01T00:00:00.000Z");
    ins.run("att-legacyh", "att-legacyh.pptx", "Stuck deck.pptx", 17, "2026-09-02T00:00:00.000Z");
  } finally { db.close(); }

  let srv = await startServer({ dbPath, env: FAKE_ENV });
  try {
    const admin = await loginAs(srv.base, ADMIN);
    const emp = await loginAs(srv.base, EMPLOYEE);
    const { data: content } = await admin.get("/api/admin/content");
    const c = content.courses.find((x) => x.id === "culture-conduct");
    c.modules[0].sections[0].attachments = [{ id: "att-legacy1", kind: "doc", name: "Legacy deck.pptx", size: 1234 }];
    assert.equal((await admin.put("/api/admin/content/courses/" + c.id, c)).status, 200);

    const course = (await emp.get("/api/courses/culture-conduct")).data;
    assert.equal(course.modules[0].sections[0].attachments[0].kind, "doc");
    const dl = await emp.raw("GET", "/api/attachments/att-legacy1");
    assert.equal(dl.status, 409);
    assert.doesNotMatch(dl.headers.get("content-disposition") || "", /attachment/);
    assert.equal((await dl.json()).code, "pending_conversion");

    const st = (await admin.get("/api/admin/attachments/office-status")).data;
    const p1 = st.pending.find((p) => p.id === "att-legacy1");
    const ph = st.pending.find((p) => p.id === "att-legacyh");
    assert.ok(p1 && ph, JSON.stringify(st.pending));
    assert.equal(p1.ext, ".pptx");
    assert.equal(p1.fileMissing, false);
    assert.equal(p1.refs.length, 1);
    assert.equal(p1.refs[0].courseId, "culture-conduct");
    assert.deepEqual(ph.refs, []);
    assert.equal(st.counts.pending, 2);
    assert.equal(st.counts.unreferenced, 1);

    // 一个卡住的转换在跑时，再发起一次 → 409
    const hang = await admin.post("/api/admin/attachments/office-convert", { ids: ["att-legacyh"] });
    assert.equal(hang.status, 202, JSON.stringify(hang.data));
    assert.equal(hang.data.job.running, true);
    const busy = await admin.post("/api/admin/attachments/office-convert", {});
    assert.equal(busy.status, 409, JSON.stringify(busy.data));
    assert.equal(busy.data.code, "office_convert_running");
    const afterHang = await waitHttpJob(admin);
    assert.equal(afterHang.job.failed, 1);
    assert.equal(afterHang.pending.find((p) => p.id === "att-legacyh").lastError.reason, "timeout");

    const bad = await admin.post("/api/admin/attachments/office-convert", { ids: ["att-nope"] });
    assert.equal(bad.status, 400, JSON.stringify(bad.data));
    assert.equal(bad.data.code, "unknown_attachment");

    const go = await admin.post("/api/admin/attachments/office-convert", { ids: ["att-legacy1"] });
    assert.equal(go.status, 202, JSON.stringify(go.data));
    const done = await waitHttpJob(admin);
    assert.equal(done.job.converted, 1);
    assert.ok(done.job.by && done.job.by.id, "the job records who started it");
    assert.ok(!done.pending.some((p) => p.id === "att-legacy1"));

    const course2 = (await emp.get("/api/courses/culture-conduct")).data;
    assert.equal(course2.modules[0].sections[0].attachments[0].kind, "pdf");
    const ok = await emp.raw("GET", "/api/attachments/att-legacy1");
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") || "", /application\/pdf/);
    assert.match(ok.headers.get("content-disposition") || "", /inline/);
    const audit = JSON.stringify((await admin.get("/api/admin/audit")).data);
    assert.ok(audit.includes("attachment.convert"), "conversion audited");
    assert.ok(audit.includes("attachment.convert.fail"), "failure audited");
    // 服务运行中不删原文件（备份可能正在复制附件目录）
    assert.ok(fs.existsSync(path.join(attachDir, "att-legacy1.pptx")));
  } finally { await srv.stopAsync(); }

  srv = await startServer({ dbPath, env: FAKE_ENV });
  try {
    assert.ok(!fs.existsSync(path.join(attachDir, "att-legacy1.pptx")), "original removed at startup");
    assert.ok(!fs.existsSync(path.join(attachDir, "att-legacy1.pptx.txt")), "cached text of the original removed at startup");
    assert.ok(fs.existsSync(path.join(attachDir, "att-legacy1.pdf")));
    assert.ok(fs.existsSync(path.join(attachDir, "att-legacyh.pptx")), "an unconverted original stays");
  } finally { await srv.stopAsync(); }
});

test("http: with the learning module off both converter routes are 404", async () => {
  const srv = await startServer({ env: { ...FAKE_ENV, LMS_MODULES_OFF: "learning" } });
  try {
    const admin = await loginAs(srv.base, ADMIN);
    assert.equal((await admin.get("/api/admin/attachments/office-status")).status, 404);
    assert.equal((await admin.post("/api/admin/attachments/office-convert", {})).status, 404);
  } finally { await srv.stopAsync(); }
});
