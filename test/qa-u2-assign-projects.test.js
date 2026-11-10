// UI 批 U2（2026-10-09）源码 / CSS 级回归：
//   11.5（F52）指派弹窗重排 —— 课程库「指派课程」与培养项目「添加学员」共用 components/AssignPanel.jsx：
//       页签「按条件 / 粘贴工号 / 逐个选择」；部门与职级两行等宽（左标签、右选择框），职级区间并入职级下拉；
//       醒目的人数结果条（附查看名单）；底部左截止日期 / 班级、右按钮，主按钮不可用时写明原因；说明收进标题旁「?」。
//   F53 + 12.1 培养项目列表改为表格 —— 列：项目名（状态胶囊在名称右侧）、类别、期次、学员数、完成度、开始—结束、负责人、操作（固定右侧），
//       列可排序；筛选条（搜索名称 / 编号、状态默认不含已关闭、类别、开始年份、负责人、排序）全部写进地址栏，显示「共 N 个项目」；
//       390 宽每行一张紧凑卡片。
// QA_WEB_SRC 可指向另一份 web/src（证明本测试在改动前的副本上失败）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = process.env.QA_WEB_SRC || path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const exists = (...p) => fs.existsSync(path.join(WEB, ...p));
const content = read("pages", "admin", "Content.jsx");
const projects = read("pages", "admin", "Projects.jsx");
const filters = read("components", "TrainingFilters.jsx");
const CSS = read("app.css") + "\n" + read("v2.css") + "\n" + read("admin.css");   // 简化 10/11：后台专用规则拆到 admin.css

function fnBody(src, name) {
  const at = src.search(new RegExp("\\n(?:export (?:default )?)?function " + name + "\\("));
  assert.ok(at >= 0, "function " + name + " exists");
  const end = src.indexOf("\n}\n", at + 1);
  return src.slice(at, end + 2);
}
// 页面词典（const T = {…}）按源码求值，只取对象字面量
function dict(src) {
  const at = src.indexOf("const T = {");
  assert.ok(at >= 0, "dictionary present");
  let i = src.indexOf("{", at), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    // 注释里的撇号（如 shouldn't）不能当成字符串开头
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === "'" || c === '"') { i++; while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "`") { i++; let d = 0; while (i < src.length && !(src[i] === "`" && d === 0)) { if (src[i] === "\\") i++; else if (src[i] === "$" && src[i + 1] === "{") { d++; i++; } else if (src[i] === "}" && d) d--; i++; } continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) break; }
  }
  return vm.runInNewContext("(" + src.slice(start, i + 1) + ")");
}
// 选择器 + 属性在给定视口宽度下最后一条生效的值（同 qa-f46-align.test.js）
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
const at = (sel, prop, w = 1440) => cssLast(CSS, sel, prop, w);

/* ---------------- 11.5 指派弹窗 ---------------- */

test("11.5 shared AssignPanel: tabs in the order 按条件 / 粘贴工号 / 逐个选择, two labelled criteria rows, result bar, footer with reason, help icon", () => {
  assert.ok(exists("components", "AssignPanel.jsx"), "components/AssignPanel.jsx exists");
  const src = read("components", "AssignPanel.jsx");
  assert.match(src, /const MODES = \[\['dept', 'byCond'\], \['paste', 'byPaste'\], \['pick', 'byPick'\]\];/);
  const T = dict(src);
  assert.deepEqual([T.zh.byCond, T.zh.byPaste, T.zh.byPick], ["按条件", "粘贴工号", "逐个选择"]);
  assert.deepEqual([T.zh.deptLab, T.zh.deptSub, T.zh.gradeLab, T.zh.gradeSub], ["部门", "含下级，可多选", "职级", "可多选"]);
  assert.equal(T.zh.why.cond, "请先选择部门或职级");
  for (const k of ["export function AssignModes", "export function AssignCriteria", "export function AssignResult", "export function AssignFooter", "export function AssignHelp", "export function assignBlockReason"])
    assert.ok(src.includes(k), k);
  // 底部：左参数、右 取消 + 主按钮；有原因时主按钮不可用并在旁边写原因
  assert.match(fnBody(src, "AssignFooter"), /<div className="asg-foot-l">\{left\}<\/div>/);
  assert.match(fnBody(src, "AssignFooter"), /\{reason && <span className="asg-why"/);
  assert.match(fnBody(src, "AssignFooter"), /disabled=\{!!reason\}/);
  assert.match(fnBody(src, "AssignResult"), /s\.showList/);
  // 原因判定（纯函数）
  const fnSrc = src.slice(src.indexOf("export function assignBlockReason")).replace(/^export /, "");
  const why = vm.runInNewContext("(" + fnSrc.replace(/^function assignBlockReason/, "function") + ")");
  assert.equal(why({ mode: "dept", criteria: false, input: 0, matched: 0, fresh: 0 }), "cond");
  assert.equal(why({ mode: "dept", criteria: true, waitTree: true, input: 0, matched: 0, fresh: 0 }), "tree");
  assert.equal(why({ mode: "dept", criteria: true, input: 0, matched: 4, fresh: 0 }), "none");
  assert.equal(why({ mode: "dept", criteria: true, input: 0, matched: 0, fresh: 0 }), "nomatch");
  assert.equal(why({ mode: "paste", input: 0, matched: 0, fresh: 0 }), "paste");
  assert.equal(why({ mode: "pick", input: 0, matched: 0, fresh: 0 }), "pick");
  assert.equal(why({ mode: "pick", input: 2, matched: 2, fresh: 2 }), null);
});

test("11.5 both assign modals use the shared layout (course library and development program stay consistent)", () => {
  const asg = fnBody(content, "AssignCourseModal");
  const add = fnBody(projects, "AddMembersModal");
  for (const [name, b] of [["AssignCourseModal", asg], ["AddMembersModal", add]]) {
    assert.match(b, /<AssignModes mode=\{mode\} onChange=\{setMode\} \/>/, name + " tabs");
    assert.match(b, /<AssignCriteria\s+dept=\{\(\s*<DeptFilter multiple /, name + " department row");
    assert.match(b, /grade=\{<JobGradeSelect value=\{grades\} onChange=\{setGrades\}/, name + " grade row");
    assert.match(b, /<AssignResult main=\{\{ label: s\.\w+, n: /, name + " result bar");
    assert.match(b, /<AssignFooter\b[\s\S]*?reason=\{reason\}/, name + " footer with the disabled reason");
    assert.match(b, /<AssignHelp text=\{s\.\w+\} \/>/, name + " help in the title");
    assert.match(b, /const reason = assignBlockReason\(\{/, name);
    // 旧排版不再出现：单独的职级块、两行说明、内联的「将新指派」统计
    assert.doesNotMatch(b, /co-asg-grade|co-asg-modes|const seg = /, name + " old layout gone");
    assert.doesNotMatch(b, /<div className="u-hint">\{s\.\w*GradeHint\}<\/div>/, name + " hint text moved into the ?");
  }
  assert.match(asg, /left=\{<label className="asg-due"><span className="asg-due-lab">\{s\.asgDue\}<\/span><DatePicker /, "due date on the footer's left");
  assert.match(asg, /onOk=\{askAssign\}/);
  assert.doesNotMatch(asg, /s\.asgStat\(/);
  assert.match(add, /onOk=\{\(\) => \(mode === 'dept' \? confirmDept\(\) : submit\(false\)\)\}/);
  assert.match(add, /<label className="asg-due"><span className="asg-due-lab">\{s\.pickClass\}<\/span>/, "class picker on the footer's left");
  // 验收 U-5：四项数字与名单一致 —— 符合 = 将新增 + 跳过；未设职级按条件范围内全部在职员工计（含已在本期 / 已指派过的人），两处同一口径
  assert.match(asg, /const matched = candidates\.fresh\.length \+ candidates\.skip;/);
  assert.match(add, /const matched = mode === 'dept' \? resolved\.length \+ alreadyIn \+ alreadyOther :/);   // CX-027：已在本期 / 其他期次分开计
  assert.match(add, /const noGradeN = byDeptGrade && grades\.length \? byDeptGrade\.noGrade\.length \+ \(inSplit \? inSplit\.noGrade\.length : 0\) : 0;/);
  assert.match(read("components", "AssignPanel.jsx"), /const shown = \(items \|\| \[\]\)\.filter\(Boolean\);/, "zero figures stay visible");
  for (const src of [content, projects]) {
    const T = dict(src);
    for (const lang of ["zh", "en"]) for (const k of src === content ? ["asgWill", "asgSkipped", "asgHelp"] : ["addWill", "addSkipped", "addHelp", "addDo"]) assert.ok(T[lang][k], lang + "." + k);
  }
});

test("11.5 grade range merged into the grade dropdown (no separate 职级段 row)", () => {
  const b = filters.slice(filters.indexOf("export function JobGradeSelect"));
  assert.match(b, /outerBottomSlot=\{opts\.length \? range : null\}/);
  assert.match(b, /<div className="tf-grade-slot">/);
  assert.doesNotMatch(b, /className="tf-grade-range"/);
  assert.match(b, /<select className="tf-grade-end"/, "native selects do not portal out of the dropdown");
});

test("11.5 CSS: criteria rows equal width (label | control), stacked at 390; footer split left / right; prominent result number", () => {
  assert.equal(at(".asg-crit", "display"), "grid");
  assert.equal(at(".asg-crit", "grid-template-columns"), "max-content minmax(0,1fr)");
  assert.equal(at(".asg-crit", "grid-template-columns", 390), "minmax(0,1fr)");
  assert.equal(at(".asg-crit-ctl .dpf-trigger", "width"), "100%");
  assert.equal(at(".asg-crit-ctl .dpf-trigger", "max-width"), "none");
  assert.equal(at(".asg-foot", "justify-content"), "space-between");
  assert.equal(at(".asg-result-n", "font-size"), "26px");
  assert.equal(at(".tf-grade-slot", "display"), "flex");
});

/* ---------------- F53 + 12.1 培养项目列表 ---------------- */

test("F53/12.1 program list is a sortable table with the agreed columns; actions fixed right", () => {
  const list = fnBody(projects, "ProjectList");
  const cols = [...list.matchAll(/title: s\.(\w+), dataIndex: '(\w+)'/g)].map((m) => m[2]);
  assert.deepEqual(cols, ["name", "cat", "cohorts", "members", "progress", "start", "owner", "op"]);
  for (const k of ["name", "cat", "cohorts", "members", "progress", "start", "owner"])
    assert.match(list, new RegExp("dataIndex: '" + k + "', width: \\d+,[^\\n]*sorter: true, sortOrder: sortOf\\('" + k + "'\\)"), k + " sortable");
  assert.match(list, /dataIndex: 'op', width: \d+, fixed: 'right'/);
  assert.match(list, /<div className="tp-namecell">\s*<button type="button" className="co-row-link tp-name"[^\n]*\n\s*\{stTag\(p\)\}/, "status pill right of the name");
  assert.match(list, /<div className="co-ctable tp-ctable">/, "same table container as the course library");
  assert.match(list, /<div className="tp-mcard">/, "compact card for 390");
  assert.match(list, /<Progress percent=\{p\.progress\}/);
  assert.doesNotMatch(fnBody(projects, "Projects"), /className="tp-card"/, "the card grid is gone");
});

test("F53 filters: search name / code, status without 已关闭 by default, category, start year, owner, sort — all in the URL; shows 共 N 个项目", () => {
  const list = fnBody(projects, "ProjectList");
  assert.match(list, /const \[urlp, patchUrl\] = useUrlState\(\);/);
  for (const k of ["q", "st", "cat", "year", "owner"]) assert.match(list, new RegExp("urlp\\." + k + "\\b"), k);
  assert.match(list, /const sortKey = PJ_SORTS\.includes\(urlp\.sort\) \? urlp\.sort : '';/);
  assert.match(list, /const sortDir = urlp\.dir === 'asc' \? 'asc' : 'desc';/);
  assert.match(list, /if \(fSt === '' && p\.status === 'closed'\) return false;/, "closed programs hidden by default");
  assert.match(list, /\[p\.title, p\.title_zh, p\.code\]\.some/, "search covers the name and the code");
  assert.match(list, /if \(fYear && pjYear\(p\) !== fYear\) return false;/);
  assert.match(list, /if \(fOwner && p\.ownerId !== fOwner\) return false;/);
  assert.match(list, /patchUrl\(\{ \[k\]: v \|\| null \}, \{ push: false \}\)/, "filters replace, never push");
  assert.match(list, /<span className="u-count tp-count">\{s\.lstTotal\(visible\.length\)\}<\/span>/);
  assert.match(list, /'start\.desc'[\s\S]*'progress\.desc'[\s\S]*'members\.desc'/, "sort by start date, completion, learners");
  const T = dict(projects);
  assert.equal(T.zh.lstTotal(18), "共 18 个项目");
  assert.equal(T.zh.lstStOpen, "未关闭");
  assert.deepEqual(["stDraft", "stPlanning", "stRunning", "stClosing", "stClosed"].map((k) => T.zh[k]), ["草稿", "筹备中", "进行中", "收尾中", "已关闭"]);
  // 打开项目仍只改页面键，筛选保留
  assert.match(projects, /patchUrl\(\{ project: id \|\| null, tab: null, dept: null \}, \{ push: true \}\)/);
});

test("12.1 CSS: pill stays right of the name; compact card only at phone width", () => {
  assert.equal(at(".tp-namecell", "flex-wrap"), "nowrap");
  assert.equal(at(".tp-namecell", "align-items"), "center");
  assert.equal(at(".tp-namecell>.tp-st", "flex"), "none");
  assert.equal(at(".tp-mcard", "display"), "none");
  assert.equal(at(".adm-main .tp-ctable .tp-mcard", "display", 390), "flex");
  assert.equal(at(".adm-main .tp-ctable .tp-namecell-wrap", "display", 390), "none");
  assert.equal(at(".adm-main .tp-ctable .semi-table-tbody>tr.semi-table-row>td[data-label]:not(.tp-namecol):not(.tp-opcol)", "display", 390), "none");
  assert.equal(at(".adm-main .tp-ctable .tp-mcard", "display", 1440), undefined);
});
