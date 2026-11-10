// 课程附件取文字（AI 出题「从所选课程内容生成」用）。由 server.js 以子进程调用：
//   node extract-text.js <文件路径> <最多字数>
// 文字写到 stdout（UTF-8）；读不出文字（扫描件、视频、不支持的格式）时输出为空，退出码仍为 0。
// 放在子进程里跑：PDF 解析是同步吃 CPU 的，大文件在主进程里会卡住整个服务；子进程还能被超时直接杀掉。
//   .pdf  —— 复用前端预览用的 public/vendor/pdfjs（3.11.174，Node 下走 fake worker），不新增依赖。
//   .docx —— word/document.xml 的 <w:t>，按 <w:p> 分段。
//   .pptx —— ppt/slides/slideN.xml 的 <a:t>，按页、按 <a:p> 分段。
// Office 文件上传时若服务器装了 LibreOffice 已转成 PDF，这里拿到的就是 .pdf。
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const file = process.argv[2];
const MAX = Math.max(1000, Math.min(200000, Number(process.argv[3]) || 60000));
const PDFJS_DIR = path.join(__dirname, "..", "..", "public", "vendor", "pdfjs");

// 最小 zip 读取：从中央目录找条目，只支持 stored(0) / deflate(8) —— Office 文件够用。
function readZipEntries(buf, want) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return new Map();
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!want(name)) continue;
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    try { out.set(name, method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : Buffer.alloc(0)); } catch { /* 坏条目跳过 */ }
  }
  return out;
}
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function paragraphs(xml, pTag, tTag) {
  const out = [];
  for (const p of xml.split(new RegExp("</" + pTag + ">"))) {
    const re = new RegExp("<" + tTag + "(?:\\s[^>]*)?>([^<]*)</" + tTag + ">", "g");
    let m, line = "";
    while ((m = re.exec(p))) line += unxml(m[1]);
    if (line.trim()) out.push(line.trim());
  }
  return out.join("\n");
}
function docxText(buf) {
  const e = readZipEntries(buf, (n) => n === "word/document.xml");
  return e.has("word/document.xml") ? paragraphs(e.get("word/document.xml").toString("utf8"), "w:p", "w:t") : "";
}
function pptxText(buf) {
  const e = readZipEntries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const num = (n) => Number(n.match(/(\d+)\.xml$/)[1]);
  return [...e.keys()].sort((a, b) => num(a) - num(b)).map((n) => paragraphs(e.get(n).toString("utf8"), "a:p", "a:t")).filter(Boolean).join("\n\n");
}
async function pdfText(buf) {
  const pdfjs = require(path.join(PDFJS_DIR, "pdf.min.js"));
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(PDFJS_DIR, "pdf.worker.min.js");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages && out.length < MAX; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out += tc.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : "")).join("") + "\n\n";
  }
  await doc.destroy();
  return out;
}

(async () => {
  const ext = path.extname(file || "").toLowerCase();
  const buf = fs.readFileSync(file);
  let text = "";
  if (ext === ".pdf") text = await pdfText(buf);
  else if (ext === ".docx") text = docxText(buf);
  else if (ext === ".pptx") text = pptxText(buf);
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX);
  process.stdout.write(text);
})().catch((e) => {
  process.stderr.write(String((e && e.message) || e));
  process.exit(2);
});
