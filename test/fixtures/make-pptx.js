// 测试夹具：生成带内嵌视频的最小 .pptx（第三批 5.7）。零依赖：自带一个极小的 zip 写入器（stored / deflate，zlib.crc32）。
// Test fixture: builds tiny .pptx decks with slide media, for test/pptx-media.test.js, video-transcode and ppt-video-http.
//
//   const { makePptx, makeDeck, zip } = require("./fixtures/make-pptx.js");
//   makePptx(opts)  → Buffer：设计稿 §15 的标准课件 ——
//       演示顺序 P1..P4 对应文件 slide2 / slide4 / slide1 / slide3（sldIdLst 故意打乱）；P3（slide1.xml）隐藏；
//       P1：YouTube 外链视频；P2：内嵌 ppt/media/media1.wmv + 一段音频（media2.mp3）；P4：同一个 media1.wmv + 一个 file:/// 链接视频。
//       可见页 P1→1、P2→2、P4→3；P3 → null。
//     opts.media1        media1.wmv 的内容（缺省含 "FAKE_WMV"；放进 FAKE_FFMPEG_* 标记可驱动 fake-ffmpeg）
//     opts.media1Name    内嵌视频文件名（缺省 media1.wmv）
//     opts.hiddenVideo   true → 隐藏页 P3 上再放一段只出现在隐藏页的 media3.mp4
//     opts.deflate       true → 所有条目 deflate；数组 → 只压这些条目名
//     opts.dataDescriptor true → 用 bit 3 数据描述符（本地头大小为 0）
//     opts.utf8Names     true → 文件名标 bit 11
//     opts.zip64         true → 把 EOCD 条目数写成 0xFFFF（ZIP64 标记）
//   makeDeck({ order, slides, media, … }) → Buffer：自定义课件（slides: { <fileNo>: { hidden, items:[{ kind, embed|url|link, name, via }] } }）
//       embed 默认写成 a:videoFile r:link + p14:media r:embed 两个关系；via:"link" 只写 a:videoFile r:link（旧版写法）
//   zip(files, opts) → Buffer：files = [{ name, data, deflate?, descriptor?, utf8? }]
"use strict";
const zlib = require("zlib");

function zip(files, opts) {
  const o = opts || {};
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const deflate = !!f.deflate;
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const descriptor = !!f.descriptor;
    const utf8 = !!f.utf8;
    const name = Buffer.from(f.name, utf8 ? "utf8" : "latin1");
    const flags = (descriptor ? 0x8 : 0) | (utf8 ? 0x800 : 0);
    const method = deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(descriptor ? 0 : crc, 14);
    lh.writeUInt32LE(descriptor ? 0 : body.length, 18);
    lh.writeUInt32LE(descriptor ? 0 : data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const parts = [lh, name, body];
    if (descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(data.length, 12);
      parts.push(dd);
    }
    const local = Buffer.concat(parts);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const n = o.zip64 ? 0xffff : files.length;
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_VIDEO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video";
const REL_AUDIO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio";
const REL_MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function relsXml(rels) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("")
    + "</Relationships>";
}

// 一张幻灯片：每个 item 一个 <p:pic>
function slideXml(no, slide) {
  const rels = [];
  let rid = 1;
  const pics = (slide.items || []).map((it, i) => {
    const name = it.name || (it.kind === "audio" ? "Audio " : "Video ") + (i + 1);
    let mediaEl = "", nvPr = "";
    if (it.embed && it.via === "link") {
      // 旧版写法：只有 a:videoFile r:link 指向包内文件（没有 p14:media）
      const a = "rId" + (rid++);
      rels.push({ id: a, type: it.kind === "audio" ? REL_AUDIO : REL_VIDEO, target: "../media/" + it.embed });
      mediaEl = it.kind === "audio" ? `<a:audioFile r:link="${a}"/>` : `<a:videoFile r:link="${a}"/>`;
      nvPr = `<p:nvPr>${mediaEl}</p:nvPr>`;
    } else if (it.embed) {
      const a = "rId" + (rid++), b = "rId" + (rid++);
      rels.push({ id: a, type: it.kind === "audio" ? REL_AUDIO : REL_VIDEO, target: "../media/" + it.embed });
      rels.push({ id: b, type: REL_MEDIA, target: "../media/" + it.embed });
      mediaEl = it.kind === "audio" ? `<a:audioFile r:link="${a}"/>` : `<a:videoFile r:link="${a}"/>`;
      nvPr = `<p:nvPr>${mediaEl}<p:extLst><p:ext uri="{DAA4B4D9-6D3E-4ED6-9D4D-3B7A2C2C1F01}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${b}"/></p:ext></p:extLst></p:nvPr>`;
    } else {
      const a = "rId" + (rid++);
      rels.push({ id: a, type: it.kind === "audio" ? REL_AUDIO : REL_VIDEO, target: it.url || it.link, external: true });
      mediaEl = it.kind === "audio" ? `<a:audioFile r:link="${a}"/>` : `<a:videoFile r:link="${a}"/>`;
      nvPr = `<p:nvPr>${mediaEl}</p:nvPr>`;
    }
    return `<p:pic><p:nvPicPr><p:cNvPr id="${10 + i}" name="${esc(name)}"/><p:cNvPicPr/>${nvPr}</p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;
  }).join("");
  const text = `<p:sp><p:txBody><a:p><a:r><a:t>${esc(slide.text || "Slide file " + no)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}${slide.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${text}${pics}</p:spTree></p:cSld></p:sld>`;
  return { xml, rels: relsXml(rels) };
}

// order：演示顺序里的文件号（slide<K>.xml）；slides：按文件号给内容；media：{ 文件名: Buffer }
function deckFiles(opts) {
  const o = opts || {};
  const order = o.order || Object.keys(o.slides || {}).map(Number).sort((a, b) => a - b);
  const files = [];
  files.push({ name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' });
  const presRels = order.map((k, i) => ({ id: "rId" + (i + 2), type: REL_SLIDE, target: "slides/slide" + k + ".xml" }));
  presRels.unshift({ id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster", target: "slideMasters/slideMaster1.xml" });
  const sldIds = order.map((k, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  files.push({ name: "ppt/presentation.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>` });
  files.push({ name: "ppt/_rels/presentation.xml.rels", data: relsXml(presRels) });
  for (const k of Object.keys(o.slides || {}).map(Number).sort((a, b) => a - b)) {
    const s = slideXml(k, o.slides[k]);
    files.push({ name: "ppt/slides/slide" + k + ".xml", data: s.xml });
    files.push({ name: "ppt/slides/_rels/slide" + k + ".xml.rels", data: s.rels });
  }
  for (const [name, data] of Object.entries(o.media || {})) files.push({ name: "ppt/media/" + name, data });
  const deflate = o.deflate;
  return files.map((f) => ({
    ...f,
    deflate: deflate === true || (Array.isArray(deflate) && deflate.includes(f.name)),
    descriptor: !!o.dataDescriptor,
    utf8: !!o.utf8Names,
  }));
}
function makeDeck(opts) {
  return zip(deckFiles(opts), { zip64: !!(opts && opts.zip64) });
}

function makePptx(opts) {
  const o = opts || {};
  const m1 = o.media1Name || "media1.wmv";
  const media = { [m1]: o.media1 !== undefined ? o.media1 : Buffer.from("FAKE_WMV media1 payload " + "x".repeat(64)), "media2.mp3": Buffer.from("FAKE_MP3 audio") };
  const slides = {
    2: { text: "P1 intro", items: [{ kind: "video", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", name: "Welcome clip" }] },
    4: { text: "P2 product", items: [{ kind: "video", embed: m1, name: "Product demo" }, { kind: "audio", embed: "media2.mp3", name: "Narration" }] },
    1: { text: "P3 hidden", hidden: true, items: [] },
    3: { text: "P4 recap", items: [{ kind: "video", embed: m1, name: "Product demo again" }, { kind: "video", link: "file:///C:/Users/trainer/Videos/local-clip.mp4", name: "Local clip" }] },
  };
  if (o.hiddenVideo) {
    slides[1].items.push({ kind: "video", embed: "media3.mp4", name: "Hidden only" });
    media["media3.mp4"] = Buffer.from("FAKE_MP4 hidden");
  }
  return makeDeck({ order: [2, 4, 1, 3], slides, media, deflate: o.deflate, dataDescriptor: o.dataDescriptor, utf8Names: o.utf8Names, zip64: o.zip64 });
}

module.exports = { zip, makeDeck, deckFiles, makePptx };
