// P0 1.3 / 1.4 课件转换的前端（读构建前的源码断言，不起服务）：
//   1.3 学员端 Course.jsx 对 Office 原文件只显示「待转换」卡片，没有任何下载入口；后台上传按错误码给出本地化提示，
//       上传 Office 时显示「转换中…」，转换组件不可用时选择框去掉 Office 扩展名。
//   1.4 后台课程库页头有转换组件状态按钮，OfficeConvertSheet 显示状态、安装说明、待转换清单与在线补转。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, "web", "src", ...p), "utf8");

// 与 dict-pairs.test.js 同一做法：取出 `const T = {…}` 的对象字面量求值（跳过字符串、模板与注释里的花括号）
function objectLiteral(src, at) {
  let i = src.indexOf("{", at), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === "'" || c === '"') { i++; while (src[i] !== c) { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "`") { i++; let d2 = 0; while (i < src.length && !(src[i] === "`" && d2 === 0)) { if (src[i] === "\\") i++; else if (src[i] === "$" && src[i + 1] === "{") { d2++; i++; } else if (src[i] === "}" && d2) d2--; i++; } continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced object at " + at);
}
const dict = (src) => vm.runInNewContext("(" + objectLiteral(src, src.search(/\bconst T\s*=\s*\{/)) + ")", {});
// 函数体（从声明到下一个顶层 function / 文件尾），用来把断言限定在某个组件里
const fnBody = (src, name) => {
  const at = src.indexOf("function " + name + "(");
  assert.ok(at >= 0, name + " exists");
  const next = src.indexOf("\nfunction ", at + 10);
  return src.slice(at, next < 0 ? src.length : next);
};

test("1.3 learner page: an Office original renders as a link-free 'pending conversion' card, never a download", () => {
  const src = read("pages", "Course.jsx");
  assert.doesNotMatch(src, /<a\b[^>]*\bdownload\b/, "no <a download> anywhere on the learner course page");
  assert.doesNotMatch(src, /\{s\.download\}/, "the Download label is gone");
  const from = src.indexOf('<div className="attach is-pending"');
  assert.ok(from > 0, "pending card present");
  const card = src.slice(from, src.indexOf(");", from));
  assert.match(card, /<div className="fs">\{s\.pendingConv\}<\/div>/);
  assert.match(card, /<span className="pill muted">\{s\.pendingTag\}<\/span>/);
  assert.doesNotMatch(card, /href=|<a\b/, "the pending card carries no link");
  // PDF / audio / video keep their inline players
  // 第三批 5.6 / 5.7：调用处加 media（课件内视频）与 watermark（查看人水印）
  assert.match(src, /<PdfViewer url=\{href\} note=\{s\.viewOnly\} media=\{a\.slideMedia\} watermark \/>/);
  const T = dict(src);
  for (const lang of ["zh", "en"]) {
    assert.equal("download" in T[lang], false, lang + ": download key removed");
    assert.equal("protectedView" in T[lang], false, lang + ": the old 'protected view' label is unused and removed");
    assert.ok(T[lang].pendingConv && T[lang].pendingTag, lang + ": pending-conversion copy present");
  }
  assert.equal(T.zh.pendingConv, "课件正在等待转换为在线查看格式，暂时无法打开。");
  assert.equal(T.en.pendingTag, "Pending conversion");
});

test("1.3 console upload: error codes map to page copy, HTTP-status fallback, 'converting…' while an Office file uploads, Office extensions dropped when the converter is unavailable", () => {
  const src = read("pages", "admin", "Content.jsx");
  const up = fnBody(src, "SectionUpload");
  assert.match(up, /const \{ lang \} = useI18n\(\);/, "SectionUpload reads the active language itself");
  assert.match(up, /office_converter_unavailable: \(\) => s\.eOfficeOff/);
  assert.match(up, /office_convert_failed: \(\) => s\.eConvFail/);
  assert.match(up, /pdf_invalid: \(\) => s\.ePdfInvalid/, "a renamed non-PDF gets the page's own sentence, not the server's bilingual one");
  assert.match(up, /if \(status === 413\) return s\.eTooLarge;/);
  assert.match(up, /if \(status === 422\) return s\.eConvFail;/);
  assert.match(up, /accept=\{officeOk \? `\$\{ACCEPT_BASE\},\$\{ACCEPT_OFFICE\}` : ACCEPT_BASE\}/);
  assert.match(src, /const ACCEPT_BASE = '\.mp3,\.m4a,\.wav,\.ogg,\.pdf';/);
  assert.match(up, /if \(office\) setConverting\(true\);/);
  assert.match(up, /\{converting && \(\s*<div className="co-oc-converting" role="status"><Spin size="small" \/><span>\{s\.converting\}<\/span><\/div>/);
  assert.doesNotMatch(src, /uploadHintText/, "the hard-coded bilingual toast is replaced by page copy");
  assert.doesNotMatch(src, /受保护下载|protected download/, "the attachment hint no longer promises a download");
  // 页面级状态：页头按钮 + 附件区横幅 + 传给上传组件
  assert.match(src, /const oc = useAsync\(\(\) => api\.get\('\/api\/admin\/attachments\/office-status'\), \[\]\);/);
  assert.match(src, /\{canWrite && !officeOk && <Banner type="warning"[^>]*description=\{s\.seOfficeOff\}/);
  assert.match(src, /officeOk=\{officeOk\}/);
  assert.match(src, /<div className="co-head-acts">[\s\S]*?className=\{'co-oc-btn ' \+ \(ocState === 'ok' \? 'is-ok' : 'is-off'\)\}[\s\S]*?\{s\.newCourse2\}/);
  assert.match(src, /<OfficeConvertSheet\s+canWrite=\{canWrite\}\s+initial=\{oc\.data\}\s+onChanged=\{oc\.reload\}/);
  const T = dict(src);
  for (const k of ["seOfficeOff", "eOfficeOff", "eConvFail", "ePdfInvalid", "eTooLarge", "converting", "uploadedHint", "ocBtnOk", "ocBtnOff", "ocBtnDisabled"])
    for (const lang of ["zh", "en"]) assert.ok(T[lang][k], `${lang}.${k}`);
  assert.equal(T.zh.ocBtnOk(0), "课件转换：可用");
  assert.equal(T.zh.ocBtnOff(3), "课件转换：未安装 · 3 个待转换");
  assert.equal(T.en.ocBtnOff(0), "File converter: not installed");
  assert.match(T.zh.converting, /^转换中…/);
  assert.match(T.zh.seAttachHint, /不提供下载/);
  assert.match(T.en.seAttachHint, /never downloadable/);
});

test("1.4 OfficeConvertSheet: same keys in both languages, every server code mapped, 403/404/429 fall back by HTTP status, commands in <code>, write controls behind canWrite", () => {
  const src = read("pages", "admin", "OfficeConvertSheet.jsx");
  const T = dict(src);
  const shape = (o) => Object.keys(o).sort().map((k) => (o[k] && typeof o[k] === "object" ? k + ":" + shape(o[k]) : k + (typeof o[k] === "function" ? "/" + o[k].length : ""))).join(",");
  assert.equal(shape(T.zh), shape(T.en), "zh and en dictionaries have the same keys, nesting and function arity");
  assert.deepEqual(Object.keys(T.zh.st).sort(), ["disabled", "missing", "ok"]);
  for (const code of ["office_converter_unavailable", "office_convert_running", "nothing_to_convert", "unknown_attachment"])
    assert.match(src, new RegExp(code + ": \\(\\) => s\\."), code + " mapped");
  assert.match(src, /if \(status === 403\) return s\.eForbidden;/);
  assert.match(src, /if \(status === 404\) return s\.eNotFound;/);
  assert.match(src, /if \(status === 429\) return s\.eThrottled;/);
  assert.match(src, /api\.get\('\/api\/admin\/attachments\/office-status' \+ \(refresh \? '\?refresh=1' : ''\)\)/);
  assert.match(src, /api\.post\('\/api\/admin\/attachments\/office-convert', ids \? \{ ids \} : \{\}\)/);
  assert.match(src, /const POLL_MS = 2000;/);
  assert.match(src, /<code>winget install TheDocumentFoundation\.LibreOffice<\/code>/);
  assert.match(src, /<code>LMS_SOFFICE<\/code>/);
  assert.match(src, /<code>LMS_DISABLE_OFFICE_CONVERT=1<\/code>/);
  assert.match(src, /\.\.\.\(canWrite \? \[\{/, "the per-row Convert column only exists for writers");
  assert.match(src, /\{canWrite && \(\s*<div className="oc-all">/, "Convert all only for writers");
  // 整页而不是抽屉（负责人原则「短操作弹窗、长编辑整页」；课程库 ?office=1）
  assert.match(src, /className="co-page oc-page"/);
  assert.doesNotMatch(src, /<SideSheet/);
  const content = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "Content.jsx"), "utf8");
  assert.match(content, /searchParams\.get\('office'\) === '1'/);
  for (const lang of ["zh", "en"]) {
    const text = JSON.stringify(T[lang]);
    assert.doesNotMatch(text, /联系管理员|超管|contact (an|the) admin/i, lang + ": ask IT, not 'contact the admin'");
  }
  assert.match(T.zh.inst1, /^请 IT /);
  assert.equal(T.zh.jobDone(2, 1, 0), "已转换 2 个，失败 1 个，原文件缺失 0 个");
  // 引擎中止任务写的是 job.aborted（"timeouts" | "unavailable" | "shutdown" | "error"），不是 job.reason（审查：两边字段名对不上）
  assert.doesNotMatch(src, /job\.reason/);
  assert.match(src, /job\.aborted === 'timeouts' && !running && <Banner[^>]*description=\{s\.jobAborted\}/);
  assert.match(src, /job\.aborted && job\.aborted !== 'timeouts' && !job\.interrupted && !running && <Banner[^>]*description=\{s\.jobStopped\}/);
  assert.match(src, /const untried = job\.aborted \? Math\.max\(0, \(job\.total \|\| 0\) - \(job\.done \|\| 0\)\) : 0;/);
  assert.match(src, /if \(job\.failed \|\| job\.missing \|\| job\.aborted\) Toast\.warning/, "a stopped run never shows the success toast");
  assert.equal(T.en.jobUntried(7), "7 not processed");
});

test("app.css: the conversion styles are appended at the end and use tokens only", () => {
  // 简化 10/11：后台专用规则拆到 admin.css（段落标题随规则带过去）—— 这一段 = app.css 里剩下的部分 + admin.css 里同名段落
  const HEAD = "/* ===== P0 1.3 / 1.4 课件转换";
  const css = read("app.css"), adm = read("admin.css");
  const at = css.indexOf(HEAD), atA = adm.indexOf(HEAD);
  assert.ok(at > 0 || atA > 0, "block present");
  const nextHead = (s, i) => { const j = s.indexOf("/* =====", i + 10); return j > 0 ? j : s.length; };
  const block = (at > 0 ? css.slice(at) : "") + "\n" + (atA > 0 ? adm.slice(atA, nextHead(adm, atA)) : "");
  for (const sel of [".attach.is-pending{", ".co-oc-btn.is-ok .dot{", ".co-oc-btn.is-off .dot{", ".co-head-acts{", ".co-oc-converting{", ".oc-kv{", ".oc-install code{"])
    assert.ok(block.includes(sel), sel);
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-f]{3,8}\b/i, "no hard-coded colours");
});
