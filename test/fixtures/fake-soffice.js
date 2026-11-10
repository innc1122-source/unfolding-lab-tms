// 测试替身：冒充 LibreOffice 的 soffice（P0 1.3 / 1.4）。本机和 CI 都不必装 LibreOffice。
// 用法：LMS_DISABLE_OFFICE_CONVERT=0 + LMS_SOFFICE=<本文件>。modules/learning/office-convert.js 看到 .js 结尾的
// 转换器就用 process.execPath 执行它（Node 22 的 execFile 跑不了 .cmd，所以替身必须是 node 脚本）。
//
//   --version                         输出 "LibreOffice 7.6.0.0 (test double)"
//   … --convert-to pdf --outdir D src 按源文件内容决定行为：
//       含 FAKE_SOFFICE_FAIL   退出码 1（转换出错）
//       含 FAKE_SOFFICE_NOPDF  退出码 0，但不产出 PDF
//       含 FAKE_SOFFICE_HANG   挂住不动；30 秒后自己退出，不留孤儿进程
//       其它                   在 D 里写出 <src 主文件名>.pdf：一个合法、不压缩的单页 PDF（Helvetica + WinAnsiEncoding）。
//                              文字取自 modules/ai/extract-text.js（docx / pptx），否则取源文件里的纯文本；
//                              只保留 ASCII，每段一个 Tj、不自动换行 —— pdfjs 读回来的是完整的句子。
//                              源文件是 .pptx 时（第三批 5.7）：按 modules/learning/pptx-media.js 数出的可见幻灯片数输出同样多页
//                              （与 LibreOffice 默认不导出隐藏页一致）；文字都在第 1 页。读不出幻灯片时仍是 1 页（与此前一致）。
//   -env:UserInstallation=<file URL>  必须是合法的 file URL（pathToFileURL 生成的）；替身会在里面建一个假配置，
//                              好让测试确认调用方事后把配置目录清掉了。
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { fileURLToPath } = require("url");

const EXTRACT = path.join(__dirname, "..", "..", "modules", "ai", "extract-text.js");
const PPTX_MEDIA = path.join(__dirname, "..", "..", "modules", "learning", "pptx-media.js");
const args = process.argv.slice(2);

function pdfLiteral(s) {
  return "(" + s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
}
function asciiLines(text) {
  return String(text)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\t/g, " ").replace(/[^\x20-\x7E]/g, "").trim())
    .filter(Boolean)
    .slice(0, 400)
    .map((l) => l.slice(0, 2000));
}
function buildPdf(lines, pageCount) {
  const pages = Math.max(1, Math.min(500, Math.floor(pageCount) || 1));
  const ops = ["BT", "/F1 11 Tf", "14 TL", "40 800 Td"];
  lines.forEach((l, i) => ops.push((i ? "T* " : "") + pdfLiteral(l) + " Tj"));
  ops.push("ET");
  const content = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" + ["3 0 R"].concat(Array.from({ length: pages - 1 }, (_, i) => (6 + i) + " 0 R")).join(" ") + "] /Count " + pages + " >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Length " + Buffer.byteLength(content, "latin1") + " >>\nstream\n" + content + "\nendstream",
  ];
  // 第 2 页起：空白页（没有 /Contents）
  for (let i = 1; i < pages; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> >>");
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += (i + 1) + " 0 obj\n" + o + "\nendobj\n";
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n";
  for (const n of offsets) out += String(n).padStart(10, "0") + " 00000 n \n";
  out += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}

function main() {
  if (args.includes("--version")) {
    process.stdout.write("LibreOffice 7.6.0.0 (test double)\n");
    return process.exit(0);
  }
  const prof = args.find((a) => a.startsWith("-env:UserInstallation="));
  if (prof) {
    try {
      const dir = fileURLToPath(prof.slice("-env:UserInstallation=".length));
      fs.mkdirSync(path.join(dir, "user"), { recursive: true });
      fs.writeFileSync(path.join(dir, "user", "registrymodifications.xcu"), "<items/>\n");
    } catch (e) {
      process.stderr.write("invalid -env:UserInstallation URL: " + e.message + "\n");
      return process.exit(3);
    }
  }
  const at = args.indexOf("--outdir");
  const outDir = at >= 0 ? args[at + 1] : process.cwd();
  const src = args[args.length - 1];
  let raw;
  try { raw = fs.readFileSync(src); } catch (e) {
    process.stderr.write("Error: source file could not be loaded: " + src + "\n");
    return process.exit(1);
  }
  const marker = raw.toString("latin1");
  if (marker.includes("FAKE_SOFFICE_FAIL")) {
    process.stderr.write("Error: source file could not be loaded\n");
    return process.exit(1);
  }
  if (marker.includes("FAKE_SOFFICE_NOPDF")) return process.exit(0);
  if (marker.includes("FAKE_SOFFICE_HANG")) {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 30000);
    return;
  }
  let text = "";
  try {
    text = execFileSync(process.execPath, [EXTRACT, src, "200000"], { encoding: "utf8", windowsHide: true, timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { text = ""; }
  if (!text.trim()) {
    const plain = raw.toString("utf8");
    if (!/[\x00-\x08\x0E-\x1F]/.test(plain.slice(0, 4000))) text = plain;
  }
  let lines = asciiLines(text);
  if (!lines.length) lines = ["Converted by the test double: " + path.basename(src)];
  const base = path.basename(src, path.extname(src));
  let pageCount = 1;
  if (/\.pptx$/i.test(src)) {
    try { const r = require(PPTX_MEDIA).inspect(src); if (r.ok && r.visibleCount > 0) pageCount = r.visibleCount; } catch { /* 1 页 */ }
  }
  fs.writeFileSync(path.join(outDir, base + ".pdf"), buildPdf(lines, pageCount));
  return process.exit(0);
}
main();
