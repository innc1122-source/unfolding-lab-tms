// 第三批 5.7：modules/learning/pptx-media.js —— PPTX 内嵌视频解析、幻灯片 → PDF 页码映射、安全的 zip 读取。
// 全部用 test/fixtures/make-pptx.js 现场生成的课件，不需要 PowerPoint / LibreOffice。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tempDir } = require("./helpers.js");
const pm = require("../modules/learning/pptx-media.js");
const { makePptx, makeDeck, zip } = require("./fixtures/make-pptx.js");

const TMP = tempDir("lms-pptx-media-");
let n = 0;
const write = (buf, ext = ".pptx") => { const p = path.join(TMP, "d" + (++n) + ext); fs.writeFileSync(p, buf); return p; };
const byName = (r, name) => r.media.find((m) => m.name === name);
// 改中央目录里某个条目的字段（usize / crc），造「声明与实际不符」的包
function patchCentral(buf, name, patch) {
  const b = Buffer.from(buf);
  for (let i = b.length - 22; i >= 0; i--) {
    if (b.readUInt32LE(i) !== 0x02014b50) continue;
    const nl = b.readUInt16LE(i + 28);
    if (b.toString("latin1", i + 46, i + 46 + nl) !== name) continue;
    if (patch.usize !== undefined) b.writeUInt32LE(patch.usize, i + 24);
    if (patch.crc !== undefined) b.writeUInt32LE(patch.crc >>> 0, i + 16);
    return b;
  }
  throw new Error("entry not found: " + name);
}

test("standard deck: presentation order ≠ file order, hidden slide → pageNo null, dedupe across slides, external / linked / audio", () => {
  const r = pm.inspect(write(makePptx({ hiddenVideo: true })));
  assert.equal(r.ok, true);
  assert.equal(r.slideCount, 4);
  assert.equal(r.visibleCount, 3);
  assert.deepEqual(r.slides, [
    { slideNo: 1, pageNo: 1, hidden: false },
    { slideNo: 2, pageNo: 2, hidden: false },
    { slideNo: 3, pageNo: null, hidden: true },
    { slideNo: 4, pageNo: 3, hidden: false },
  ]);
  assert.deepEqual(r.media.map((m) => [m.seq, m.kind, m.source, m.status, m.reason]), [
    [1, "video", "external", "external", null],
    [2, "video", "embedded", "pending", null],
    [3, "audio", "embedded", "skipped", "audio_not_supported"],
    [4, "video", "embedded", "skipped", "hidden_slide"],
    [5, "video", "linked_file", "failed", "linked_file"],
  ]);
  const yt = byName(r, "Welcome clip");
  assert.equal(yt.url, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.deepEqual(yt.slides, [{ slideNo: 1, pageNo: 1 }]);
  const demo = byName(r, "Product demo");
  assert.equal(demo.entry, "ppt/media/media1.wmv", "target resolved relative to ppt/slides/");
  assert.equal(demo.srcExt, "wmv");
  assert.deepEqual(demo.slides, [{ slideNo: 2, pageNo: 2 }, { slideNo: 4, pageNo: 3 }], "one row for media1 on two slides; first shape name wins");
  assert.equal(r.media.filter((m) => m.entry === "ppt/media/media1.wmv").length, 1);
  assert.deepEqual(byName(r, "Hidden only").slides, [{ slideNo: 3, pageNo: null }]);
  assert.equal(byName(r, "Local clip").url, null, "file:/// targets are never exposed as URLs");
});

test("the existing one-slide sample (no media) is read: 1 visible slide, no media", () => {
  const r = pm.inspect(path.join(__dirname, "..", "scripts", "samples", "sample-slides.pptx"));
  assert.equal(r.ok, true);
  assert.equal(r.visibleCount, 1);
  assert.deepEqual(r.media, []);
});

test("deflate entries + data-descriptor sizes (bit 3) come from the central directory; extraction is byte-exact", async () => {
  const media1 = Buffer.concat([Buffer.from("FAKE_WMV "), Buffer.alloc(300000, 0x61), Buffer.from(" end")]);
  for (const opts of [{ deflate: true }, { dataDescriptor: true }, { deflate: true, dataDescriptor: true }]) {
    const f = write(makePptx({ media1, ...opts }));
    const r = pm.inspect(f);
    assert.equal(r.ok, true, JSON.stringify(opts));
    const demo = byName(r, "Product demo");
    assert.equal(demo.status, "pending");
    assert.equal(demo.srcSize, media1.length);
    const dest = path.join(TMP, "x" + (++n) + ".bin");
    const x = await pm.extractEntry(f, demo.zipEntry, dest);
    assert.equal(x.size, media1.length);
    assert.ok(fs.readFileSync(dest).equals(media1));
    assert.ok(!fs.existsSync(dest + ".part"));
  }
});

test("ingestLocal extracts every pending video to outDir/m<seq>.bin and checks the PDF page count", async () => {
  const f = write(makePptx({ deflate: true }));
  const out = tempDir("lms-pptx-out-");
  const pdf = path.join(TMP, "three.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n1 0 obj << /Type /Pages /Count 3 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>\n4 0 obj <</Type /Page/Parent 1 0 R>>\n");
  const r = await pm.ingestLocal(f, out, pdf, {});
  assert.equal(r.pdfPages, 3);
  assert.equal(r.mapping, "ok");
  const demo = byName(r, "Product demo");
  assert.equal(demo.file, path.join(out, "m2.bin"));
  assert.ok(fs.readFileSync(demo.file).toString().startsWith("FAKE_WMV"));
  assert.equal(demo.zipEntry, undefined, "zip internals are not passed back");
  assert.deepEqual(fs.readdirSync(out), ["m2.bin"], "only pending videos are extracted");
  fs.writeFileSync(pdf, "%PDF-1.4\n<< /Type /Page >>\n");
  assert.equal((await pm.ingestLocal(f, tempDir("lms-pptx-out-"), pdf, {})).mapping, "mismatch");
  fs.writeFileSync(pdf, "%PDF-1.4\nobject streams only\n");
  assert.equal((await pm.ingestLocal(f, tempDir("lms-pptx-out-"), pdf, {})).mapping, "unverified");
});

test("UTF-8 file names (flag bit 11) are decoded", () => {
  const deck = makeDeck({
    order: [1], utf8Names: true,
    slides: { 1: { items: [{ kind: "video", embed: "介绍视频.mp4", name: "介绍" }] } },
    media: { "介绍视频.mp4": Buffer.from("FAKE_MP4") },
  });
  const r = pm.inspect(write(deck));
  assert.equal(r.media[0].entry, "ppt/media/介绍视频.mp4");
  assert.equal(r.media[0].status, "pending");
  assert.equal(r.media[0].srcExt, "mp4");
});

test("both embed relationship shapes: p14:media r:embed and a:videoFile r:link to an internal file", () => {
  const deck = makeDeck({
    order: [1, 2],
    slides: {
      1: { items: [{ kind: "video", embed: "a.mp4", name: "Modern" }] },
      2: { items: [{ kind: "video", embed: "b.avi", name: "Legacy", via: "link" }] },
    },
    media: { "a.mp4": Buffer.from("A"), "b.avi": Buffer.from("B") },
  });
  const r = pm.inspect(write(deck));
  assert.deepEqual(r.media.map((m) => [m.name, m.source, m.entry, m.status]), [
    ["Modern", "embedded", "ppt/media/a.mp4", "pending"],
    ["Legacy", "embedded", "ppt/media/b.avi", "pending"],
  ]);
});

test("ZIP64 is refused; a non-zip, a truncated zip and a password-protected (OLE) file are pptx_unreadable", () => {
  assert.equal(pm.inspect(write(makePptx({ zip64: true }))).error, "zip64_unsupported");
  const locatorDeck = (() => {
    const b = makePptx();
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    return Buffer.concat([b.subarray(0, b.length - 22), loc, b.subarray(b.length - 22)]);
  })();
  assert.equal(pm.inspect(write(locatorDeck)).error, "zip64_unsupported");
  for (const bad of [
    Buffer.from("just some text, definitely not a zip"),
    makePptx().subarray(0, 200),
    Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096)]),
    Buffer.alloc(0),
  ]) {
    const r = pm.inspect(write(bad));
    assert.equal(r.ok, false);
    assert.equal(r.error, "pptx_unreadable");
    assert.deepEqual(r.media, []);
  }
  assert.equal(pm.inspect(path.join(TMP, "does-not-exist.pptx")).error, "pptx_unreadable");
});

test("caps: entries, central-directory XML part size, per-deck XML budget and slide count make the deck unreadable", () => {
  const f = write(makePptx());
  assert.equal(pm.inspect(f, { limits: { maxEntries: 5 } }).error, "pptx_unreadable");
  assert.equal(pm.inspect(f, { limits: { maxXmlPart: 100 } }).error, "pptx_unreadable");
  const r = pm.inspect(f);
  assert.equal(r.ok, true);
  assert.equal(pm.inspect(f, { limits: { maxXmlTotal: 3000 } }).error, "pptx_unreadable");
  assert.equal(pm.inspect(f, { limits: { maxSlides: 3 } }).error, "pptx_unreadable");
  assert.equal(pm.inspect(f, { limits: { maxSlides: 4 } }).ok, true);
});

test("caps: one video over the per-file limit, the deck total, and more than 50 rows", () => {
  const big = Buffer.alloc(1000, 0x62);
  const deck = makeDeck({
    order: [1],
    slides: { 1: { items: [
      { kind: "video", embed: "a.mp4", name: "A" }, { kind: "video", embed: "b.mp4", name: "B" },
      { kind: "video", embed: "c.mp4", name: "C" }, { kind: "video", embed: "huge.mp4", name: "Huge" },
    ] } },
    media: { "a.mp4": big, "b.mp4": big, "c.mp4": big, "huge.mp4": Buffer.alloc(5000) },
  });
  const r = pm.inspect(write(deck), { limits: { maxMediaBytes: 4000, maxDeckBytes: 2500 } });
  assert.deepEqual(r.media.map((m) => [m.name, m.status, m.reason]), [
    ["A", "pending", null], ["B", "pending", null], ["C", "failed", "too_large"], ["Huge", "failed", "too_large"],
  ]);
  const items = [], media = {};
  for (let i = 1; i <= 51; i++) { items.push({ kind: "video", embed: "v" + i + ".mp4", name: "V" + i }); media["v" + i + ".mp4"] = Buffer.from("v" + i); }
  const many = pm.inspect(write(makeDeck({ order: [1], slides: { 1: { items } }, media })));
  assert.equal(many.media.length, 51);
  assert.equal(many.media.filter((m) => m.status === "pending").length, 50);
  assert.deepEqual([many.media[50].status, many.media[50].reason], ["skipped", "too_many_media"]);
});

test("disk and storage budgets skip videos that would not fit (disk_full / storage_limit)", () => {
  const deck = makeDeck({
    order: [1],
    slides: { 1: { items: [{ kind: "video", embed: "a.mp4", name: "A" }, { kind: "video", embed: "b.mp4", name: "B" }] } },
    media: { "a.mp4": Buffer.alloc(100), "b.mp4": Buffer.alloc(100) },
  });
  const f = write(deck);
  assert.deepEqual(pm.inspect(f, { diskBudgetBytes: 150 }).media.map((m) => [m.status, m.reason]), [["pending", null], ["skipped", "disk_full"]]);
  assert.deepEqual(pm.inspect(f, { srcBudgetBytes: 0 }).media.map((m) => [m.status, m.reason]), [["skipped", "storage_limit"], ["skipped", "storage_limit"]]);
});

test("unsupported source extensions fail with the (capped) extension; the allowlist constant is used for good ones", () => {
  const deck = makeDeck({
    order: [1],
    slides: { 1: { items: [
      { kind: "video", embed: "clip.swf", name: "Flash" },
      { kind: "video", embed: "clip.averyveryverylongext", name: "Odd" },
      { kind: "video", embed: "CLIP.MP4", name: "Upper" },
    ] } },
    media: { "clip.swf": Buffer.from("x"), "clip.averyveryverylongext": Buffer.from("y"), "CLIP.MP4": Buffer.from("z") },
  });
  const r = pm.inspect(write(deck));
  assert.deepEqual(r.media.map((m) => [m.name, m.status, m.reason, m.srcExt]), [
    ["Flash", "failed", "unsupported_format", "swf"],
    ["Odd", "failed", "unsupported_format", "averyveryv"],
    ["Upper", "pending", null, "mp4"],
  ]);
  assert.ok(pm.SOURCE_EXT.includes("wmv") && pm.SOURCE_EXT.includes("m2ts") && !pm.SOURCE_EXT.includes("swf"));
});

test("CRC mismatch and an entry that inflates beyond its declared size are refused (no file left behind)", async () => {
  const media1 = Buffer.alloc(5000, 0x41);
  const good = makePptx({ media1, deflate: true });
  const badCrc = patchCentral(good, "ppt/media/media1.wmv", { crc: 12345 });
  const f1 = write(badCrc);
  const r1 = pm.inspect(f1);
  const demo1 = byName(r1, "Product demo");
  const dest1 = path.join(TMP, "crc.bin");
  await assert.rejects(pm.extractEntry(f1, demo1.zipEntry, dest1), (e) => e.reason === "pptx_unreadable" && /CRC/.test(e.message));
  assert.ok(!fs.existsSync(dest1) && !fs.existsSync(dest1 + ".part"));
  const out = tempDir("lms-pptx-out-");
  const ing = await pm.ingestLocal(f1, out, null, {});
  assert.deepEqual([byName(ing, "Product demo").status, byName(ing, "Product demo").reason], ["failed", "pptx_unreadable"]);
  assert.deepEqual(fs.readdirSync(out), []);

  const bomb = patchCentral(good, "ppt/media/media1.wmv", { usize: 100 }); // 声明 100 字节，实际解出 5000
  const f2 = write(bomb);
  const demo2 = byName(pm.inspect(f2), "Product demo");
  assert.equal(demo2.srcSize, 100);
  await assert.rejects(pm.extractEntry(f2, demo2.zipEntry, path.join(TMP, "bomb.bin")), (e) => e.reason === "pptx_unreadable");
  // 单文件上限在解压途中就截断
  await assert.rejects(pm.extractEntry(write(good), { ...byName(pm.inspect(write(good)), "Product demo").zipEntry }, path.join(TMP, "cap.bin"), { maxBytes: 1000 }), (e) => e.reason === "too_large");
});

test("a corrupt XML part (bad CRC) makes the deck unreadable", () => {
  const files = [
    { name: "ppt/presentation.xml", data: "<p:presentation/>" },
  ];
  const b = patchCentral(zip(files), "ppt/presentation.xml", { crc: 1 });
  assert.equal(pm.inspect(write(b)).error, "pptx_unreadable");
  assert.equal(pm.inspect(write(zip([{ name: "x.txt", data: "no presentation" }]))).error, "pptx_unreadable");
  const bombXml = zip([{ name: "ppt/presentation.xml", data: Buffer.alloc(200000, 0x20), deflate: true }]);
  assert.equal(pm.inspect(write(patchCentral(bombXml, "ppt/presentation.xml", { usize: 10 }))).error, "pptx_unreadable", "inflate capped at the declared size");
});

test("names and URLs from the deck are sanitised: control / bidi characters stripped, 120-char cap, userinfo dropped, only http(s)", () => {
  const evil = "Intro‮\u0007 clip " + "x".repeat(300);
  const deck = makeDeck({
    order: [1],
    slides: { 1: { items: [
      { kind: "video", embed: "a.mp4", name: evil },
      { kind: "video", url: "https://user:secret@videos.example.com/watch?v=1", name: "Ext" },
      { kind: "video", url: "javascript:alert(1)", name: "Js" },
      { kind: "video", url: "\\\\fileserver\\share\\v.mp4", name: "Unc" },
    ] } },
    media: { "a.mp4": Buffer.from("x") },
  });
  const r = pm.inspect(write(deck));
  const a = r.media[0];
  assert.ok(!/[‮\u0007]/.test(a.name));
  assert.equal(a.name.length, 120);
  assert.ok(a.name.startsWith("Intro clip"));
  assert.equal(byName(r, "Ext").url, "https://videos.example.com/watch?v=1");
  assert.deepEqual([byName(r, "Js").source, byName(r, "Js").status, byName(r, "Js").url], ["linked_file", "failed", null]);
  assert.equal(byName(r, "Unc").source, "linked_file");
  assert.equal(pm.cleanUrl("ftp://x/y"), null);
});

test("countPdfPages: /Type /Page and /Type/Page count, /Pages does not, a match across the 1 MB chunk boundary counts once", () => {
  const f = path.join(TMP, "pages.pdf");
  const pad = Buffer.alloc(1024 * 1024 - 6, 0x20);
  fs.writeFileSync(f, Buffer.concat([
    Buffer.from("%PDF-1.4\n<< /Type /Pages /Count 4 >>\n<< /Type /Page >>\n"),
    pad, Buffer.from("<< /Type /Page /Parent 2 0 R >>\n<</Type/Page>>\n<< /Type /PageLabel >>\n<< /Type\n/Page >>\n"),
  ]));
  assert.equal(pm.countPdfPages(f), 4);
  assert.equal(pm.countPdfPages(path.join(TMP, "nope.pdf")), 0);
});

test("the --ingest child entry prints JSON (used by video-transcode in a separate process)", () => {
  const { execFileSync } = require("child_process");
  const f = write(makePptx());
  const out = tempDir("lms-pptx-out-");
  const txt = execFileSync(process.execPath, [path.join(__dirname, "..", "modules", "learning", "pptx-media.js"), "--ingest", f, out, "", JSON.stringify({ limits: { maxMediaRows: 2 } })], { encoding: "utf8" });
  const r = JSON.parse(txt);
  assert.equal(r.ok, true);
  assert.equal(r.mapping, null);
  assert.deepEqual(r.media.map((m) => m.status), ["external", "pending", "skipped", "skipped"]);
  assert.equal(r.media[2].reason, "too_many_media");
  assert.ok(fs.existsSync(path.join(out, "m2.bin")));
  const bad = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "..", "modules", "learning", "pptx-media.js"), "--ingest", write(Buffer.from("nope")), out, "", "{}"], { encoding: "utf8" }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "pptx_unreadable");
});
