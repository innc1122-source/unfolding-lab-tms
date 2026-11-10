// F58（负责人 10/9 定）考试设置「考前须知（选填）」——源码与界面检查。验收用例 58-1（表单）、58-2（显示位置与语言回退）、
//   58-3（AI 初评告知不变、不可编辑）、58-4（未填只显示系统须知）、58-5（审计字段标签）、58-6（纯文本渲染，不解析 HTML）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8");
const PREP = read("pages", "ExamPrep.jsx");
const EXAMS = read("pages", "admin", "Exams.jsx");
const AUDIT = read("pages", "admin", "Audit.jsx");

// ExamPrep.jsx 的 preNoticeOf（纯函数）单独取出来跑
function loadPreNoticeOf() {
  const start = PREP.indexOf("export const preNoticeOf");
  assert.ok(start >= 0, "ExamPrep.jsx exports preNoticeOf");
  const end = PREP.indexOf("\n};", start);
  const code = PREP.slice(start, end + 3).replace(/^export /, "") + "\n;preNoticeOf";
  return vm.runInNewContext(code, {});
}
// 某个 T 语言块（zh / en）的源码
const langBlock = (src, lang) => {
  const a = src.indexOf(`\n  ${lang}: {`);
  const b = src.indexOf(lang === "zh" ? "\n  en: {" : "\n};", a);
  return src.slice(a, b);
};

test("58-2：按界面语言取须知，该语言为空时回退到另一种语言；都空（或只有空白）为 null", () => {
  const f = loadPreNoticeOf();
  const both = { preNotice: "EN text", preNotice_zh: "中文须知" };
  assert.equal(f(both, "zh"), "中文须知");
  assert.equal(f(both, "en"), "EN text");
  assert.equal(f({ preNotice: "EN only", preNotice_zh: null }, "zh"), "EN only", "zh viewer, zh empty → English");
  assert.equal(f({ preNotice: "", preNotice_zh: "只有中文" }, "en"), "只有中文", "en viewer, en empty → Chinese");
  assert.equal(f({ preNotice: "  ", preNotice_zh: "\n" }, "zh"), null);
  assert.equal(f({}, "en"), null, "old server without the fields");
  assert.equal(f({ preNotice: "a\nb" }, "en"), "a\nb", "line breaks kept");
});

test("58-2 / 58-3 / 58-4 / 58-6：须知排在系统固定须知（含 AI 初评告知）之后，文本节点 + pre-line，不用 dangerouslySetInnerHTML", () => {
  const notes = PREP.slice(PREP.indexOf('<section className="card ep2-notes">'), PREP.indexOf("</section>", PREP.indexOf('<section className="card ep2-notes">')));
  const iTip = notes.indexOf("<li>{s.tip}</li>");
  const iAi = notes.indexOf('<li className="ep-ai"><b>{s.aiHead}</b>{s.aiNotice}</li>');
  const iCustom = notes.indexOf("{preNotice && <li className=\"ep-custom\" style={{ whiteSpace: 'pre-line' }}>{preNotice}</li>}");
  assert.ok(iTip >= 0 && iAi > iTip, "system notes unchanged: fixed tip, then the AI disclosure");
  assert.ok(iCustom > iAi, "HR notice renders after the system notes, as a text child with white-space: pre-line");
  // AI 初评告知的显示条件不受须知影响（不可被 HR 删改）
  assert.match(notes, /\{aiGrading && \(exam\.openCount \|\| 0\) > 0 && <li className="ep-ai">/);
  assert.match(PREP, /const preNotice = preNoticeOf\(exam, lang\);/);
  assert.doesNotMatch(PREP, /dangerouslySetInnerHTML/, "never parsed as HTML");
  // AI 告知文案仍写死在页面里（中英文各一份），不从考试设置读
  for (const lang of ["zh", "en"]) assert.match(langBlock(PREP, lang), /aiNotice: '/);
});

test("58-1：考试设置有「考前须知（选填）」中英文两栏（TextArea，1000 字计数与校验），读写 preNotice / preNotice_zh", () => {
  assert.match(EXAMS, /<div className="exm-sec-h">\{s\.secNotice\}<\/div>/);
  assert.match(EXAMS, /\[\['noticeZh', s\.fNoticeZh, s\.fNoticeZhPh\], \['noticeEn', s\.fNoticeEn, s\.fNoticeEnPh\]\]\.map/);
  const area = EXAMS.slice(EXAMS.indexOf("<Form.TextArea", EXAMS.indexOf("s.secNotice}")), EXAMS.indexOf("/>", EXAMS.indexOf("<Form.TextArea", EXAMS.indexOf("s.secNotice}"))));
  assert.match(area, /maxCount=\{1000\}/);
  assert.match(area, /Array\.from\(String\(val \|\| ''\)\.trim\(\)\)\.length <= 1000, message: s\.errNoticeLen/);
  // 回显、未保存比较、提交
  assert.match(EXAMS, /noticeZh: d\.preNotice_zh \|\| '',\s*noticeEn: d\.preNotice \|\| '',/);
  assert.match(EXAMS, /notice: \[String\(v\.noticeZh \|\| ''\)\.trim\(\), String\(v\.noticeEn \|\| ''\)\.trim\(\)\],/);
  assert.match(EXAMS, /preNotice: String\(v\.noticeEn \|\| ''\)\.trim\(\) \|\| null,\s*preNotice_zh: String\(v\.noticeZh \|\| ''\)\.trim\(\) \|\| null,/);
  // 中英文文案键一致、都有内容
  for (const k of ["secNotice", "noticeHint", "fNoticeZh", "fNoticeEn", "fNoticeZhPh", "fNoticeEnPh", "errNoticeLen"]) {
    assert.match(langBlock(EXAMS, "zh"), new RegExp(`\\b${k}: '[^']+'`), "zh " + k);
    assert.match(langBlock(EXAMS, "en"), new RegExp(`\\b${k}: '[^']+'`), "en " + k);
  }
  assert.match(langBlock(EXAMS, "zh"), /secNotice: '考前须知（选填）'/);
  assert.match(langBlock(EXAMS, "en"), /secNotice: 'Pre-exam notice \(optional\)'/);
});

test("58-5：审计页有两栏的字段标签（中英文）", () => {
  assert.match(AUDIT, /\n  preNotice: \{ zh: '考前须知（英文）', en: 'Pre-exam notice \(EN\)' \},/);
  assert.match(AUDIT, /\n  preNotice_zh: \{ zh: '考前须知（中文）', en: 'Pre-exam notice \(ZH\)' \},/);
});
