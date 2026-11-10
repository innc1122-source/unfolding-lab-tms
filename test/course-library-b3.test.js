// 第三批 G4（2026-10-08）源码断言：课程库只用列表（10.3）、筛选写进地址栏（4.3）、类别与学时字段（5.5 / 1.2）、
// 大纲小图标（5.5）、表单两栏（8.5）、按职级指派与加学员（8.6）、「A · B」空值不留点（10.5）、课件转换页的视频转码（5.7）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8").replace(/\r\n/g, "\n");
const content = read("pages", "admin", "Content.jsx");
const projects = read("pages", "admin", "Projects.jsx");
const questions = read("pages", "admin", "Questions.jsx");
const office = read("pages", "admin", "OfficeConvertSheet.jsx");

// 第四批 G6（2026-10-09）QA 缺陷回归用：app.css 在给定视口宽度下，某个选择器（整段选择器文本相同）某个属性最后一次声明的值。
// 只认 @media 里的 min/max-width（px）；print 与 @container 视为不生效；后写的覆盖先写的。
function cssLast(css, selector, prop, width) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack = [];
  let buf = "", val;
  const applies = () => stack.every((m) => {
    if (m.startsWith("@container") || /\bprint\b/.test(m)) return false;
    if (!m.startsWith("@media")) return true;
    for (const [, k, n] of m.matchAll(/(max|min)-width\s*:\s*(\d+)px/g)) if (k === "max" ? width > +n : width < +n) return false;
    return true;
  });
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const sel = buf.trim();
      buf = "";
      if (sel.startsWith("@")) { stack.push(sel); continue; }
      const end = src.indexOf("}", i);
      const body = src.slice(i + 1, end);
      i = end;
      if (!applies() || !sel.split(",").map((x) => x.trim().replace(/\s+/g, " ")).includes(selector)) continue;
      for (const d of body.split(";")) { const at = d.indexOf(":"); if (at > 0 && d.slice(0, at).trim() === prop) val = d.slice(at + 1).trim(); }
    } else if (c === "}") { stack.pop(); buf = ""; }
    else if (c === ";" && buf.trim().startsWith("@")) buf = "";
    else buf += c;
  }
  return val;
}

function fnBody(src, name) {
  const at = src.search(new RegExp("\\nfunction " + name + "\\("));
  assert.ok(at >= 0, "function " + name + " exists");
  const end = src.indexOf("\n}\n", at + 1);
  return src.slice(at, end + 2);
}
function dict(src) {
  const at = src.indexOf("const T = {");
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') { const q = c; i++; while (src[i] !== q) { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "`") { i++; let d = 0; while (i < src.length && !(src[i] === "`" && d === 0)) { if (src[i] === "\\") i++; else if (src[i] === "$" && src[i + 1] === "{") { d++; i++; } else if (src[i] === "}" && d) d--; i++; } continue; }
    if (c === "{") depth++; else if (c === "}" && --depth === 0) break;
  }
  return vm.runInNewContext("(" + src.slice(src.indexOf("{", at), i + 1) + ")");
}

test("10.3 / 4.3 library: list only (Semi Table in .co-ctable), no card view; filters q/st/cat/enroll/mode/kind (+ batch 4 pub) in the URL via useUrlState", () => {
  assert.match(content, /import \{ useUrlState \} from '\.\.\/\.\.\/urlstate\.js';/);
  assert.match(content, /const \[urlp, patchUrl\] = useUrlState\(\);/);
  assert.match(content, /const FILTER_KEYS = \['q', 'st', 'cat', 'enroll', 'mode', 'kind', 'pub'\];/); // 第四批 7：pub 公开课程
  assert.doesNotMatch(content, /setSearchParams/, "no wholesale query rewrite is left");
  assert.match(content, /const \[searchParams\] = useSearchParams\(\);/);
  assert.match(content, /searchParams\.get\('office'\) === '1'/);
  assert.match(content, /<div className="co-ctable">/);
  assert.doesNotMatch(content, /co-clist|layout=card|layout === 'card'/, "no card view (owner 10/8: list only)");
  assert.match(content, /rowSelection=\{canWrite \? sel\.rowSelection : undefined\}/);
  assert.match(content, /<div ref=\{sel\.wrapRef\}>/);
  assert.match(content, /resetOn: \[fStatus, fKind, query, urlp\.cat \|\| '', fEnroll, fMode, fPub\]/);
  assert.match(content, /goPage = \(set, opts\) => patchUrl\(\{ \.\.\.PAGE_RESET, \.\.\.\(set \|\| \{\}\) \}, \{ push: true/, "page switches keep the filters");
  assert.match(content, /<CategorySelect value=\{fCat\}/);
  assert.match(content, /<EnrollSelect value=\{fEnroll\}/);
  assert.match(content, /<ModeSelect value=\{fMode\}/);
  assert.match(content, /fCat\.includes\(cat \|\| UNCATEGORIZED\)/, "?cat=__none finds uncategorised courses");
  assert.match(content, /visible\.forEach\(\(c\) => sel\.rowSelection\.onSelect\(c, true\)\)/, "select all current filter results (across pages)");
  for (const k of ["colCourse", "colCat", "colType", "colHours", "colProjects", "colContent", "colBank", "colActions"]) assert.match(content, new RegExp("s\\." + k + "\\b"), k);
});

test("5.5 / 1.2 course form: category from categories.js (normalised), hours carried in normalizeCourse, serializeCourse and submitForm; CATEGORY_OPTS gone", () => {
  assert.doesNotMatch(content, /CATEGORY_OPTS/);
  assert.match(content, /const categoryOpts = useMemo\(\(\) => categoryOptions\(lang, catInUse\), \[lang, catInUse\]\);/);
  assert.match(content, /category: normalizeCategoryInput\(values\.category\),\n\s*hours: clampHours\(values\.hours\),/);
  assert.match(fnBody(content, "normalizeCourse"), /hours: c\.hours != null/);
  assert.match(fnBody(content, "serializeCourse"), /hours: clampHours\(course\.hours\),/);
  assert.match(content, /field="hours" label=\{s\.fHours\} min=\{0\} max=\{999\} step=\{0\.5\} precision=\{1\}/);
  // 8.5：两栏表单，新建页与编辑器「课程信息」共用同一组字段
  assert.equal((content.match(/\{renderCourseFields\(formApi, values\)\}/g) || []).length, 2);
  assert.match(content, /className="card co-ed-card co-formpage co-form2"/);
  assert.match(content, /<div className="co-form2-grid">/);
});

test("5.5 outline: marks under the section name as icons with role=img + aria-label; no Tag in the row", () => {
  assert.match(content, /<span className="co-sec-text">\n\s*<span className="co-sec-name"[^\n]*\n\s*<SecMarks s=\{s\} sec=\{sec\} \/>/);
  assert.doesNotMatch(content, /prefixIcon=\{<IconLink \/>\}>\{s\.seVideoLabel\}/);
  const marks = fnBody(content, "SecMarks");
  assert.match(content, /role="img" aria-label=\{label\} title=\{label\}/);
  for (const k of ["mkVideo", "mkLink", "mkFiles", "mkDeck", "mkWarn"]) assert.match(marks, new RegExp("s\\." + k), k);
});

test("8.6 assign by job grade (course library and development program): dept × grade, no-grade count, confirm states count and already-assigned", () => {
  const asg = fnBody(content, "AssignCourseModal");
  assert.match(asg, /<JobGradeSelect value=\{grades\} onChange=\{setGrades\}/);
  assert.match(asg, /api\.get\('\/api\/admin\/job-grades'\)/);
  assert.match(asg, /splitByGrade\(byDept, grades\)/);
  assert.match(asg, /depts\.length \? \[\] : grades\.length \? eligible : \[\]/, "dept chosen but no tree → nobody");
  assert.match(asg, /s\.asgConfirmSkip\(candidates\.skip\)/);
  assert.match(asg, /s\.asgConfirmNoGrade\(candidates\.noGrade\)/);
  assert.match(asg, /criteria: \{ depts, grades \}/);
  const add = fnBody(projects, "AddMembersModal");
  assert.match(add, /<JobGradeSelect value=\{grades\} onChange=\{setGrades\}/);
  assert.match(add, /s\.confirmSkip\(alreadyIn\)/);
  assert.match(add, /s\.confirmNoGrade\(noGradeN\)/);
});

test("10.5 「A · B」: no trailing separator when B is empty (question-bank course options and the same pattern on G4 pages)", () => {
  assert.match(questions, /\[t, p && p !== t \? p : null\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.doesNotMatch(questions, /`\$\{loc\(c, 'title'\)\} · \$\{progLabelOf\(c\.id\)\}`/);
  assert.doesNotMatch(content, /· \$\{loc\(course, 'title'\) \|\| ''\}/);
  assert.doesNotMatch(projects, /<\/Text>\} · <\/>\}/,"activity meta line builds the list first, then joins");
});

test("5.7 office page: ffmpeg states under vst (LibreOffice st unchanged), media table, retry / convert all for writers only, error codes mapped", () => {
  const T = dict(office);
  assert.deepEqual(Object.keys(T.zh.st).sort(), ["disabled", "missing", "ok"]);
  assert.deepEqual(Object.keys(T.zh.vst).sort(), ["disabled", "missing", "no_encoder", "ok"]);
  assert.equal(T.zh.title, "课件转换与视频转码");
  assert.equal(T.en.title, "File & video conversion");
  assert.match(T.zh.instV1, /^请 IT /);
  for (const code of ["video_transcoder_unavailable", "video_transcode_running", "unknown_media", "nothing_to_transcode"]) assert.match(office, new RegExp(code + ": \\(\\) => s\\."), code);
  assert.match(office, /api\.post\('\/api\/admin\/attachments\/media-transcode', ids \? \{ ids \} : \{\}\)/);
  assert.match(office, /<code>winget install --id Gyan\.FFmpeg -e --scope machine<\/code>/);
  assert.match(office, /\.\.\.\(canWrite \? \[\{\n\s*title: s\.mAct/);
  assert.match(office, /canWrite && r\.detail \?/, "ffmpeg stderr only for writers");
  assert.match(content, /data-video=\{videoDot\}/);
  assert.match(content, /<DeckMedia key=\{sectionDraft\.attachments\[0\]\.id\}/);
  assert.match(content, /media: res\.media \|\| null/);
});

test("QA D2（第三批）：课程库列表在 1440 宽（中英文）放得下，操作列固定在右侧", () => {
  const at = content.indexOf("  const columns = [\n");
  const block = content.slice(at, content.indexOf("\n  ];\n", at));
  const widths = [...block.matchAll(/^ {6}title: s\.col\w+, dataIndex: '\w+', width: (\d+)/gm)].map((m) => +m[1]);
  assert.equal(widths.length, 8, "eight columns");
  assert.match(read("components", "BulkActions.jsx"), /export const BULK_SEL_EXTRA = 60;/);
  // 1440 视口：滚动条约 15 + 侧栏 224 + 左右内边距 48 + 边框 2 → 内容区约 1150px
  const total = widths.reduce((a, b) => a + b, 0) + 60;
  assert.ok(total <= 1150, "column widths + selection = " + total + "px");
  assert.match(block, /title: s\.colActions, dataIndex: 'op', width: \d+, fixed: 'right', className: 'co-opcol',/);
  assert.match(content, /\{\.\.\.resizableTable\(columns\.map/, "scroll.x still follows the real column sum");
});

test("QA D4（第三批）：课件转换页导语随内容区宽度，安装步骤保留阅读宽度；390 宽视频状态筛选按钮换行", () => {
  const css = read("app.css") + "\n" + read("admin.css");   // 简化 10/11：后台专用规则拆到 admin.css
  for (const sel of [".oc-lead", ".oc-note"]) assert.equal(cssLast(css, sel, "max-width", 1440), "none", sel);
  assert.match(cssLast(css, ".oc-install ol", "max-width", 1440) || "", /^var\(--form-measure/, ".oc-install ol");
  assert.equal(cssLast(css, ".oc-chips", "flex-wrap", 390), "wrap");
  assert.notEqual(cssLast(css, ".oc-chips", "overflow-x", 390), "auto");
  assert.match(office, /<p className="oc-lead">\{s\.lead\}<\/p>/);
  assert.match(office, /<div className="oc-chips" role="group"/);
});
