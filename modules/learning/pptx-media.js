"use strict";
// PPTX 内嵌视频解析与「幻灯片 → PDF 页码」映射（第三批 5.7，2026-10-08）。零依赖。
// PPTX parsing for embedded slide media (batch 3, item 5.7). Zero dependencies.
//
// 谁用它 / callers:
//   · modules/learning/video-transcode.js 的 ingestDeck() —— 以子进程方式运行本文件（--ingest），
//     解析与抽取都不在服务主线程里做（安全评审 #2：大 XML / 解压炸弹不能卡住考试计时等请求）；
//   · test/fixtures/fake-soffice.js —— 按可见幻灯片数输出 PDF 页数；
//   · 单元测试 test/pptx-media.test.js。
//
// 导出 / exports:
//   inspect(file, opts)                    同步。→ { ok, error, slideCount, visibleCount, slides:[{slideNo,pageNo,hidden}], media:[…] }
//                                          不抛错：不是 zip / 加密 / ZIP64 / 超限 → ok:false + error（pptx_unreadable | zip64_unsupported）
//   extractEntry(file, entry, dest, opts)  异步，流式解压 + 字节上限 + CRC 校验；先写 dest.part 再改名。失败 reject（err.reason）
//   countPdfPages(file)                    同步，流式数 /Type /Page（64 字节重叠）；读不了返回 0
//   ingestLocal(src, outDir, pdfPath, opts) 异步：inspect + 抽取所有 pending 视频到 outDir/m<seq>.bin + 页数核对
//   SOURCE_EXT, LIMITS
//
// 规则（设计稿 §13.2 + 安全评审）：
//   · zip：读文件尾 ≤65,557 字节找 EOCD；拒绝 ZIP64；≤20,000 条目；中央目录 ≤32 MB；文件名 bit 11 → UTF-8，否则 latin1；
//     只认 stored / deflate；XML 部件每个 ≤20 MB、整份 ≤64 MB（解压后）；幻灯片 ≤2,000 张。
//   · 演示顺序 = ppt/presentation.xml 的 <p:sldIdLst> 顺序（slideK.xml 的 K 不是位置）。
//   · 隐藏页（<p:sld show="0">）pageNo = null；其余 pageNo = 1 + 之前可见页数（LibreOffice 默认不导出隐藏页）。
//   · 同一个媒体文件（或同一个外链）只出一行，slides[] 列出所有出现的幻灯片。
//   · 上限：每份 ≤50 行（其余 skipped/too_many_media）；单个 ≤500 MB、整份 ≤1.5 GB（too_large）。
//   · 源扩展名白名单 SOURCE_EXT；扩展名取白名单里的常量，不取 zip 里的原文（安全评审 #3）。
//   · 形状名 / 外链去掉控制字符与双向控制符、限长（安全评审 #16）。
//   · XML 用线性扫描（indexOf），不对整个部件跑 [\s\S]*? 正则。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Transform, pipeline } = require("stream");

const MB = 1024 * 1024;
const SOURCE_EXT = Object.freeze(["mp4", "m4v", "mov", "wmv", "asf", "avi", "mpg", "mpeg", "mkv", "webm", "flv", "3gp", "ts", "mts", "m2ts"]);
const LIMITS = Object.freeze({
  tailBytes: 65557,
  maxEntries: 20000,
  maxCentralDir: 32 * MB,
  maxXmlPart: 20 * MB,
  maxXmlTotal: 64 * MB,
  maxSlides: 2000,
  maxMediaRows: 50,
  maxMediaBytes: 500 * MB,
  maxDeckBytes: 1536 * MB,
  maxNameChars: 120,
  maxUrlChars: 2048,
  maxExtChars: 10,
});

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function zerr(reason, message) {
  const e = new Error(message || reason);
  e.reason = reason;
  return e;
}
const reasonOf = (e) => (e && e.reason) || "pptx_unreadable";

// ---------------------------------------------------------------- zip reader (fd based)
function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (n <= 0) throw zerr("pptx_unreadable", "unexpected end of file");
    got += n;
  }
  return buf;
}

function openZip(file, lim) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (e) { throw zerr("pptx_unreadable", "cannot open: " + ((e && e.code) || e)); }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw zerr("pptx_unreadable", "not a zip file");
    const tailLen = Math.min(size, lim.tailBytes);
    const tailPos = size - tailLen;
    const tail = readAt(fd, tailPos, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      if (i + 22 + tail.readUInt16LE(i + 20) <= tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw zerr("pptx_unreadable", "no end-of-central-directory record (not a zip, or password-protected)");
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) throw zerr("zip64_unsupported", "ZIP64 archive");
    const disk = tail.readUInt16LE(eocd + 4), cdDisk = tail.readUInt16LE(eocd + 6);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw zerr("zip64_unsupported", "ZIP64 archive");
    if (disk !== 0 || cdDisk !== 0) throw zerr("pptx_unreadable", "multi-disk archive");
    if (count > lim.maxEntries) throw zerr("pptx_unreadable", "too many entries (" + count + ")");
    if (cdSize > lim.maxCentralDir) throw zerr("pptx_unreadable", "central directory too large");
    if (cdOff + cdSize > size) throw zerr("pptx_unreadable", "central directory out of range");
    const cd = readAt(fd, cdOff, cdSize);
    const entries = new Map();
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw zerr("pptx_unreadable", "corrupt central directory");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      if (p + 46 + nl > cd.length) throw zerr("pptx_unreadable", "corrupt central directory");
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw zerr("zip64_unsupported", "ZIP64 entry");
      const name = cd.subarray(p + 46, p + 46 + nl).toString(flags & 0x800 ? "utf8" : "latin1");
      if (!entries.has(name)) entries.set(name, { name, flags, method, crc, csize, usize, offset });
      p += 46 + nl + xl + cl;
    }
    return { fd, size, entries, close() { try { fs.closeSync(fd); } catch { /* ignore */ } } };
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    throw e;
  }
}

// 数据区起点按本地头重新算（本地头的 extra 长度可能与中央目录不同）；大小一律用中央目录（bit 3 数据描述符时本地头是 0）
function dataStart(fd, size, entry) {
  if (entry.offset + 30 > size) throw zerr("pptx_unreadable", "local header out of range");
  const h = readAt(fd, entry.offset, 30);
  if (h.readUInt32LE(0) !== SIG_LOCAL) throw zerr("pptx_unreadable", "bad local header");
  const start = entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  if (start + entry.csize > size) throw zerr("pptx_unreadable", "entry data out of range");
  return start;
}

function readPart(zip, name, budget, lim) {
  const e = zip.entries.get(name);
  if (!e) return null;
  if (e.flags & 1) throw zerr("pptx_unreadable", "encrypted entry " + name);
  if (e.method !== 0 && e.method !== 8) throw zerr("pptx_unreadable", "unsupported compression in " + name);
  if (e.usize > lim.maxXmlPart || e.csize > lim.maxXmlPart) throw zerr("pptx_unreadable", "XML part too large: " + name);
  budget.xml += e.usize;
  if (budget.xml > lim.maxXmlTotal) throw zerr("pptx_unreadable", "XML parts exceed the per-deck budget");
  const raw = readAt(zip.fd, dataStart(zip.fd, zip.size, e), e.csize);
  let buf;
  if (e.method === 0) buf = raw;
  else {
    try { buf = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize + 1) }); }
    catch { throw zerr("pptx_unreadable", "cannot inflate " + name); }
  }
  if (buf.length !== e.usize) throw zerr("pptx_unreadable", "size mismatch in " + name);
  if ((zlib.crc32(buf) >>> 0) !== e.crc) throw zerr("pptx_unreadable", "CRC mismatch in " + name);
  return buf.toString("utf8");
}

// ---------------------------------------------------------------- tiny linear XML scanning
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (m, k) => {
    if (k[0] !== "#") return ENT[k];
    const cp = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return ""; }
  });
}
// 逐个标签回调 fn({ name, local, end, selfClose, body })；fn 返回 false 停止。整体线性：每个字符最多看一次。
function eachTag(xml, fn) {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) return;
    const c = xml.charCodeAt(lt + 1);
    if (c === 33) { // <! … comment / CDATA / doctype
      if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (xml.startsWith("<![CDATA[", lt)) { const e = xml.indexOf("]]>", lt + 9); i = e < 0 ? n : e + 3; continue; }
      const e = xml.indexOf(">", lt); i = e < 0 ? n : e + 1; continue;
    }
    if (c === 63) { const e = xml.indexOf("?>", lt); i = e < 0 ? n : e + 2; continue; }
    let j = lt + 1, q = 0;
    for (; j < n; j++) {
      const ch = xml.charCodeAt(j);
      if (q) { if (ch === q) q = 0; }
      else if (ch === 34 || ch === 39) q = ch;
      else if (ch === 62) break;
    }
    if (j >= n) return;
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    const end = body.charCodeAt(0) === 47;
    const m = /^\/?([^\s/>]+)/.exec(body);
    if (!m) continue;
    const name = m[1];
    const colon = name.indexOf(":");
    if (fn({ name, local: colon >= 0 ? name.slice(colon + 1) : name, end, selfClose: !end && body.endsWith("/"), body }) === false) return;
  }
}
function attrs(body) {
  const out = {};
  const re = /([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  return out;
}
// 带命名空间前缀的属性（r:id / r:embed / r:link）：按本地名找，必须带前缀（区分 <p:sldId id="256" r:id="rId2">）
function prefixed(a, local) {
  for (const k of Object.keys(a)) {
    const c = k.indexOf(":");
    if (c > 0 && k.slice(c + 1) === local) return a[k];
  }
  return null;
}
function parseRels(xml) {
  const rels = new Map();
  if (!xml) return rels;
  eachTag(xml, (t) => {
    if (t.end || t.local !== "Relationship") return;
    const a = attrs(t.body);
    if (a.Id && !rels.has(a.Id)) rels.set(a.Id, { type: a.Type || "", target: a.Target || "", external: /^external$/i.test(a.TargetMode || "") });
  });
  return rels;
}
function relsPathOf(part) {
  const d = path.posix.dirname(part);
  return (d === "." ? "" : d + "/") + "_rels/" + path.posix.basename(part) + ".rels";
}
// 包内相对路径解析；跳出包根的返回 null
function resolvePart(baseDir, target) {
  let t = String(target || "").replace(/\\/g, "/");
  try { t = decodeURIComponent(t); } catch { /* 保留原样 */ }
  let p = t.startsWith("/") ? t.slice(1) : (baseDir ? baseDir + "/" : "") + t;
  p = path.posix.normalize(p);
  if (!p || p === "." || p === ".." || p.startsWith("../") || p.startsWith("/")) return null;
  return p;
}

// ---------------------------------------------------------------- sanitising (security review #16)
const CTRL_RE = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;
function cleanName(s, lim) {
  return String(s == null ? "" : s).replace(CTRL_RE, "").replace(/\s+/g, " ").trim().slice(0, (lim || LIMITS).maxNameChars);
}
function cleanUrl(s, lim) {
  try {
    const u = new URL(String(s || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.username = "";
    u.password = "";
    const href = u.href;
    return href.length <= (lim || LIMITS).maxUrlChars ? href : null;
  } catch { return null; }
}
function extOf(entryName) {
  const b = path.posix.basename(String(entryName || ""));
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(dot + 1).toLowerCase() : "";
}

// ---------------------------------------------------------------- slide parsing
// 每个 <p:pic>：形状名、视频 / 音频引用（a:videoFile r:link、a:audioFile / a:wavAudioFile、p14:media r:embed|r:link）
function scanSlideMedia(xml) {
  const out = [];
  let pic = null;
  const flush = () => {
    if (!pic) return;
    const m = pic.media || {};
    if (pic.video) out.push({ kind: "video", name: pic.name, rids: [m.embed, pic.video.embed, pic.video.link, m.link] });
    else if (pic.audio) out.push({ kind: "audio", name: pic.name, rids: [m.embed, pic.audio.embed, pic.audio.link, m.link] });
    pic = null;
  };
  eachTag(xml, (t) => {
    if (t.local === "pic") {
      if (t.end) flush();
      else if (!t.selfClose) { flush(); pic = { name: null, video: null, audio: null, media: null }; }
      return;
    }
    if (!pic || t.end) return;
    const a = attrs(t.body);
    if (t.local === "cNvPr") { if (pic.name == null && a.name != null) pic.name = a.name; }
    else if (t.local === "videoFile" || t.local === "quickTimeFile") pic.video = { link: prefixed(a, "link"), embed: prefixed(a, "embed") };
    else if (t.local === "audioFile" || t.local === "wavAudioFile") pic.audio = { link: prefixed(a, "link"), embed: prefixed(a, "embed") };
    else if (t.local === "media" && t.name !== t.local) pic.media = { embed: prefixed(a, "embed"), link: prefixed(a, "link") };
  });
  flush();
  return out;
}
function rootIsHidden(xml) {
  let hidden = false;
  eachTag(xml, (t) => {
    if (t.end) return;
    if (t.local === "sld") { const s = attrs(t.body).show; hidden = s === "0" || s === "false"; return false; }
  });
  return hidden;
}
// 一个引用 → { source, entry | url | target }：优先包内文件（embedded），其次外链
function resolveRef(ref, rels, slideDir, lim) {
  let external = null;
  for (const rid of ref.rids) {
    if (!rid) continue;
    const rel = rels.get(rid);
    if (!rel) continue;
    if (!rel.external) {
      const entry = resolvePart(slideDir, rel.target);
      if (entry) return { source: "embedded", entry };
    } else if (!external) external = rel.target;
  }
  if (external == null) return null;
  if (/^https?:\/\//i.test(external.trim())) {
    const url = cleanUrl(external, lim);
    if (url) return { source: "external", url };
  }
  return { source: "linked_file", target: String(external).slice(0, lim.maxUrlChars) };
}

function inspect(file, opts) {
  const o = opts || {};
  const lim = { ...LIMITS, ...(o.limits || {}) };
  const fail = (e) => ({ ok: false, error: reasonOf(e), message: (e && e.message) || String(e), slideCount: 0, visibleCount: 0, slides: [], media: [] });
  let zip;
  try { zip = openZip(file, lim); } catch (e) { return fail(e); }
  try {
    const budget = { xml: 0 };
    const pres = readPart(zip, "ppt/presentation.xml", budget, lim);
    if (pres == null) throw zerr("pptx_unreadable", "ppt/presentation.xml missing");
    const presRels = parseRels(readPart(zip, "ppt/_rels/presentation.xml.rels", budget, lim));
    const rids = [];
    let inList = false;
    eachTag(pres, (t) => {
      if (t.local === "sldIdLst") {
        if (t.end) { inList = false; return false; }
        inList = !t.selfClose;
        return undefined;
      }
      if (inList && !t.end && t.local === "sldId") {
        const rid = prefixed(attrs(t.body), "id");
        if (rid) rids.push(rid);
      }
      return undefined;
    });
    if (rids.length > lim.maxSlides) throw zerr("pptx_unreadable", "too many slides (" + rids.length + ")");

    const slides = [];
    const rows = [];
    const byKey = new Map();
    let visible = 0;
    const seenParts = new Set();
    for (const rid of rids) {
      const rel = presRels.get(rid);
      if (!rel || rel.external) continue;
      const part = resolvePart("ppt", rel.target);
      if (!part || seenParts.has(part)) continue;
      seenParts.add(part);
      const xml = readPart(zip, part, budget, lim);
      if (xml == null) continue; // 引用了不存在的幻灯片：LibreOffice 同样不会输出这一页
      const hidden = rootIsHidden(xml);
      const slideNo = slides.length + 1;
      const pageNo = hidden ? null : ++visible;
      slides.push({ slideNo, pageNo, hidden, part });
      const refs = scanSlideMedia(xml);
      if (!refs.length) continue;
      const rels = parseRels(readPart(zip, relsPathOf(part), budget, lim));
      const slideDir = path.posix.dirname(part);
      for (const ref of refs) {
        const r = resolveRef(ref, rels, slideDir, lim);
        if (!r) continue;
        const key = r.source === "embedded" ? "e:" + r.entry : r.source === "external" ? "u:" + r.url : "l:" + r.target;
        let row = byKey.get(key);
        if (!row) {
          const fallback = r.entry ? path.posix.basename(r.entry) : r.url ? (() => { try { return new URL(r.url).hostname; } catch { return ""; } })() : "";
          row = {
            seq: 0, kind: ref.kind, source: r.source,
            name: cleanName(ref.name, lim) || cleanName(fallback, lim) || (ref.kind === "audio" ? "audio" : "video"),
            url: r.url || null, entry: r.entry || null,
            srcExt: null, srcSize: null, slides: [], status: null, reason: null, zipEntry: null,
          };
          byKey.set(key, row);
          rows.push(row);
        }
        if (!row.slides.some((s) => s.slideNo === slideNo)) row.slides.push({ slideNo, pageNo });
      }
    }

    // 状态与上限（按首次出现的演示顺序）
    let deckBytes = 0, diskUsed = 0, srcUsed = 0;
    const set = (row, status, reason) => { row.status = status; row.reason = reason || null; };
    rows.forEach((row, i) => {
      row.seq = i + 1;
      if (i >= lim.maxMediaRows) return set(row, "skipped", "too_many_media");
      if (row.kind === "audio") return set(row, "skipped", "audio_not_supported");
      if (!row.slides.some((s) => s.pageNo != null)) return set(row, "skipped", "hidden_slide");
      if (row.source === "external") return set(row, "external", null);
      if (row.source === "linked_file") return set(row, "failed", "linked_file");
      const ext = extOf(row.entry);
      const allowed = SOURCE_EXT.find((x) => x === ext);
      if (!allowed) { row.srcExt = cleanName(ext, lim).slice(0, lim.maxExtChars) || null; return set(row, "failed", "unsupported_format"); }
      row.srcExt = allowed;
      const e = zip.entries.get(row.entry);
      if (!e || (e.flags & 1)) return set(row, "failed", "pptx_unreadable");
      if (e.method !== 0 && e.method !== 8) return set(row, "failed", "unsupported_compression");
      row.srcSize = e.usize;
      row.zipEntry = { name: e.name, flags: e.flags, method: e.method, crc: e.crc, csize: e.csize, usize: e.usize, offset: e.offset };
      if (e.usize > lim.maxMediaBytes) return set(row, "failed", "too_large");
      if (deckBytes + e.usize > lim.maxDeckBytes) return set(row, "failed", "too_large");
      if (o.srcBudgetBytes != null && srcUsed + e.usize > o.srcBudgetBytes) return set(row, "skipped", "storage_limit");
      if (o.diskBudgetBytes != null && diskUsed + e.usize > o.diskBudgetBytes) return set(row, "skipped", "disk_full");
      deckBytes += e.usize; srcUsed += e.usize; diskUsed += e.usize;
      return set(row, "pending", null);
    });
    return {
      ok: true, error: null,
      slideCount: slides.length, visibleCount: visible,
      slides: slides.map(({ slideNo, pageNo, hidden }) => ({ slideNo, pageNo, hidden })),
      media: rows,
    };
  } catch (e) {
    return fail(e);
  } finally {
    zip.close();
  }
}

// ---------------------------------------------------------------- media extraction (stream, capped, CRC-checked)
async function extractEntry(file, entry, dest, opts) {
  const o = opts || {};
  const lim = { ...LIMITS, ...(o.limits || {}) };
  let e = entry;
  if (typeof entry === "string") {
    const zip = openZip(file, lim);
    try { e = zip.entries.get(entry); } finally { zip.close(); }
    if (!e) throw zerr("pptx_unreadable", "entry not found: " + entry);
  }
  if (!e || typeof e.offset !== "number") throw zerr("pptx_unreadable", "bad entry");
  if (e.flags & 1) throw zerr("pptx_unreadable", "encrypted entry");
  if (e.method !== 0 && e.method !== 8) throw zerr("unsupported_compression", "compression method " + e.method);
  const maxBytes = Math.min(o.maxBytes || lim.maxMediaBytes, lim.maxMediaBytes);
  if (e.usize > maxBytes) throw zerr("too_large", "entry larger than " + maxBytes + " bytes");
  let start, size;
  {
    const fd = fs.openSync(file, "r");
    try { size = fs.fstatSync(fd).size; start = dataStart(fd, size, e); } finally { fs.closeSync(fd); }
  }
  const tmp = dest + ".part";
  let bytes = 0, crc = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      if (bytes > e.usize || bytes > maxBytes) return cb(zerr(bytes > maxBytes ? "too_large" : "pptx_unreadable", "entry inflates beyond its declared size"));
      crc = zlib.crc32(chunk, crc);
      return cb(null, chunk);
    },
  });
  try {
    await new Promise((resolve, reject) => {
      const parts = [];
      if (e.csize > 0) parts.push(fs.createReadStream(file, { start, end: start + e.csize - 1 }));
      else {
        const { Readable } = require("stream");
        parts.push(Readable.from([]));
      }
      if (e.method === 8) parts.push(zlib.createInflateRaw());
      parts.push(counter, fs.createWriteStream(tmp, { flags: "w" }));
      pipeline(...parts, (err) => (err ? reject(err) : resolve()));
    });
    if (bytes !== e.usize) throw zerr("pptx_unreadable", "size mismatch");
    if ((crc >>> 0) !== (e.crc >>> 0)) throw zerr("pptx_unreadable", "CRC mismatch");
    fs.renameSync(tmp, dest);
    return { size: bytes, crc: crc >>> 0 };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (err && err.reason) throw err;
    throw zerr("pptx_unreadable", (err && err.message) || String(err));
  }
}

// ---------------------------------------------------------------- PDF page count
function countPdfPages(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return 0; }
  try {
    const re = /\/Type\s*\/Page(?![s\w])/g;
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = "", count = 0, pos = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      const eof = n <= 0;
      pos += Math.max(0, n);
      const s = carry + (eof ? "" : chunk.toString("latin1", 0, n));
      const limit = eof ? s.length : Math.max(0, s.length - 64);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) { if (m.index >= limit) break; count++; }
      if (eof) break;
      carry = s.slice(limit);
    }
    return count;
  } catch { return 0; } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- ingest (runs in a child process)
async function ingestLocal(src, outDir, pdfPath, opts) {
  const o = opts || {};
  const r = inspect(src, o);
  r.pdfPages = pdfPath ? countPdfPages(pdfPath) : null;
  r.mapping = !pdfPath ? null : r.pdfPages === 0 ? "unverified" : r.pdfPages === r.visibleCount ? "ok" : "mismatch";
  if (!r.ok) return r;
  for (const m of r.media) {
    if (m.status === "pending") {
      const dest = path.join(outDir, "m" + m.seq + ".bin");
      try {
        const x = await extractEntry(src, m.zipEntry, dest, o);
        m.file = dest;
        m.srcSize = x.size;
      } catch (e) {
        m.status = "failed";
        m.reason = (e && e.reason) || "pptx_unreadable";
      }
    }
    delete m.zipEntry;
  }
  return r;
}

module.exports = { inspect, extractEntry, countPdfPages, ingestLocal, SOURCE_EXT, LIMITS, cleanName, cleanUrl };

// 子进程入口：node --max-old-space-size=512 pptx-media.js --ingest <src> <outDir> <pdfPath|""> <optsJSON>
if (require.main === module && process.argv[2] === "--ingest") {
  const [src, outDir, pdfPath, optsJson] = process.argv.slice(3);
  let opts = {};
  try { opts = optsJson ? JSON.parse(optsJson) : {}; } catch { opts = {}; }
  ingestLocal(src, outDir, pdfPath || null, opts)
    .then((r) => { process.stdout.write(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: reasonOf(e), message: String((e && e.message) || e), media: [], slides: [] })); process.exit(0); });
}
