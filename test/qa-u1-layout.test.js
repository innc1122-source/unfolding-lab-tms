// UI 批 U1（2026-10-09）宽度与版式：11.1 宽度规则 A、11.2 正文行宽、11.4 只读说明、F50 员工档案布局、F51 ②③ 组织架构画布。
// 源码 / CSS 级检查（验收用例 U-1、U-2、U-4、U-9、U-10）。CSS 按「最后一条生效的声明」取值（app.css 在前、v2.css 在后，
// 与 main.jsx 引入顺序一致），并考虑 @media 宽度。QA_U1_WEB 可指向另一份 web/src（用于对照改前 / 改后副本）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = process.env.QA_U1_WEB || path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const has = (...p) => fs.existsSync(path.join(WEB, ...p));
const CSS = read("app.css") + "\n" + read("v2.css") + "\n" + read("admin.css");   // 简化 10/11：后台专用规则拆到 admin.css

// 同 test/qa-f46-align.test.js 的 cssLast：选择器 + 属性在给定视口宽度下最后一条生效的值
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
const at = (sel, prop, w = 1920) => cssLast(CSS, sel, prop, w);
const NOCAP = new Set([undefined, "none"]);
// 课程页 G5 规则的选择器（纯文字课程）
// 含逗号的 :has() 选择器 cssLast 会按逗号拆开，这类规则按原文找最后一条（均为顶层规则，不在 @media 内）
function lastRaw(selector, prop) {
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = src.lastIndexOf(selector + "{"), val;
  while (i >= 0 && val === undefined) {
    const body = src.slice(i + selector.length + 1, src.indexOf("}", i));
    for (const d of body.split(";")) { const k = d.indexOf(":"); if (k > 0 && d.slice(0, k).trim() === prop) val = d.slice(k + 1).trim(); }
    i = i > 0 ? src.lastIndexOf(selector + "{", i - 1) : -1;
  }
  return val;
}
const G5 = ".v2-page-course .course:not(:has(.content video,.content iframe,.content .pdfviewer,.content audio,.content .attach,.content .wm-video))";

/* ---------------- 11.1 宽度规则 A（U-1） ---------------- */

test("11.1 页面根容器不再用内联 maxWidth 单独限宽（培养项目 980 / 项目详情 920 / 组织架构 1400）", () => {
  const offenders = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(path.join(WEB, d))) {
      const rel = path.join(d, f);
      if (fs.statSync(path.join(WEB, rel)).isDirectory()) { if (f !== "culture") walk(rel); continue; }
      if (!/\.jsx$/.test(f)) continue;
      const src = read(rel);
      for (const m of src.matchAll(/className="wrap[^"]*"\s+style=\{\{[^}]*maxWidth/g)) offenders.push(rel + ": " + m[0]);
    }
  };
  walk("pages");
  assert.deepEqual(offenders, []);
});

test("11.1 考前说明、后台新建课程不再限宽（原 880 / 1320）", () => {
  assert.ok(NOCAP.has(at(".ep2-col", "max-width")), ".ep2-col max-width = " + at(".ep2-col", "max-width"));
  assert.ok(NOCAP.has(at(".co-page .co-formpage.co-form2", "max-width")), "新建课程 max-width = " + at(".co-page .co-formpage.co-form2", "max-width"));
});

test("11.1 培训中转页：入口卡按行伸缩补满（不再是首卡占两列、右侧空三分之一的三列网格）", () => {
  assert.equal(at(".v2-layout .hub-grid", "display", 1920), "flex");
  assert.equal(at(".v2-layout .hub-grid", "flex-wrap", 1920), "wrap");
  assert.match(String(at(".v2-layout .hub-card", "flex", 1920)), /^1 1 /, "hub-card 可伸展");
  assert.equal(at(".v2-layout .hub-card", "flex-basis", 390), "100%", "390 宽单列");
  assert.equal(at(".v2-layout .hub-card:first-child", "flex-basis", 390), "100%");
});

test("11.1 宽屏考前说明：考试规则与注意事项并排，其余整行", () => {
  assert.equal(at(".ep2-col", "display", 1920), "grid");
  assert.equal(at(".ep2-col>.ep2-rules", "grid-column", 1920), "1");
  assert.equal(at(".ep2-col>.ep2-notes", "grid-column", 1920), "2");
  assert.notEqual(at(".ep2-col", "display", 390), "grid", "手机单列");
});

/* ---------------- 11.2 正文行宽（U-2） ---------------- */

test("11.2 正文行宽 token：中文 45em（约 45 字）、英文 75ch", () => {
  assert.equal(at("html:lang(zh-CN)", "--read-measure"), "45em");
  assert.equal(at(":root", "--read-measure"), "75ch");
});

test("11.2 课程正文按自身字号限 45 字、靠左；课程目录移到正文右侧（桌面）", () => {
  assert.equal(lastRaw(G5 + " .content .prose", "max-width"), "var(--read-measure)");
  assert.equal(at(".v2-page-course .course .content .prose", "max-width"), "var(--read-measure)");
  assert.equal(lastRaw(G5 + " .content>*", "max-width"), "none", "不再按 14px 的容器字号限 42em");
  assert.equal(lastRaw(G5 + " .content>*", "margin-left"), "0");
  assert.equal(at(".v2-layout .course", "grid-template-columns", 1920), "minmax(0,1fr) 260px");
  assert.equal(at(".v2-layout .course>.rail", "order", 1920), "2");
  assert.equal(at(".v2-layout .course", "grid-template-columns", 1100), "minmax(0,1fr) 200px");
  assert.equal(at(".v2-layout .course", "grid-template-columns", 390), "1fr", "手机布局不变（目录在上方横排）");
});

test("11.2 页面说明跟随内容区宽度并按标点 / 单词自然换行，课程正文仍保留阅读宽度", () => {
  for (const sel of [".tset-lead", ".emp-lead", ".ml-lead", ".pg-desc", ".ep2-notes ol", ".tset-foot"]) {
    assert.equal(at(sel, "max-width"), "none", sel + " 不应提前限宽");
    assert.equal(at(sel, "line-break"), "strict", sel + " 中文标点换行");
    assert.equal(at(sel, "word-break"), "normal", sel + " 英文按单词换行");
    assert.equal(at(sel, "text-wrap"), "pretty", sel + " 避免孤字孤词");
  }
  assert.equal(at(".v2-page-course .course .content .prose", "max-width"), "var(--read-measure)");
});

/* ---------------- 11.4 只读说明（U-4、U-10 ①） ---------------- */

test("11.4 只读胶囊组件：中英成对，悬停给一句说明", () => {
  assert.ok(has("components", "ReadOnlyPill.jsx"), "components/ReadOnlyPill.jsx");
  const src = read("components", "ReadOnlyPill.jsx");
  assert.match(src, /<Tooltip content=\{tip\}/);
  assert.match(src, /label: '只读'/);
  assert.match(src, /label: 'Read-only'/);
});

test("11.4 员工档案 / 部门 / 组织架构 / 考试列表：删除权限说明段落，标题右侧放「只读」胶囊", () => {
  const emp = read("pages", "admin", "Employees.jsx");
  for (const k of ["hintAcct", "hintReadOnly", "hintPot", "hintLearn"]) assert.ok(!emp.includes(k), "Employees 仍有 " + k);
  assert.match(emp, /<h1 className="emp-title">\{s\.title\}<\/h1>\s*\{peopleReadOnly && <ReadOnlyPill tip=\{s\.roTip\} \/>\}/);

  const dep = read("pages", "admin", "Departments.jsx");
  assert.ok(!/\{s\.readOnly\}/.test(dep), "Departments 仍有只读说明段落");
  assert.match(dep, /<h1 className="tset-title">\{s\.title\}<\/h1>\{readOnly && <ReadOnlyPill tip=\{s\.roTip\} \/>\}/);

  const org = read("pages", "admin", "OrgChart.jsx");
  assert.ok(!org.includes("mgrReadOnly"), "OrgChart 仍有只读说明");
  assert.ok(!/<div className="tset-lead">\{s\.lead\}<\/div>/.test(org), "OrgChart 顶部三行说明仍在页面上");
  assert.match(org, /<Tooltip content=\{<div className="u-help-tip">\{s\.lead\}<\/div>\}/, "说明收进「?」");
  assert.match(org, /\{peopleReadOnly && <ReadOnlyPill tip=\{s\.roTip\} \/>\}/);

  const exm = read("pages", "admin", "Exams.jsx");
  assert.ok(!/<div className="exm-lead">\{s\.roWrite\}<\/div>/.test(exm), "考试列表仍有只读说明段落");
  assert.match(exm, /\{!canWrite && <ReadOnlyPill tip=\{s\.roWrite\} \/>\}/);
});

test("11.4 / F47 标题行：标题与胶囊同一行、垂直居中，不换到下一行", () => {
  assert.equal(at(".u-title-line", "display"), "flex");
  assert.equal(at(".u-title-line", "align-items"), "center");
  assert.equal(at(".u-title-line", "flex-wrap"), "nowrap");
  assert.equal(at(".u-title-line>.ro-pill", "flex"), "none");
});

/* ---------------- F50 员工档案（U-9） ---------------- */

test("F50 员工档案 1920 宽：统计为顶部横排卡片，不再是 158px 左栏网格；手机布局不变", () => {
  assert.equal(at(".v2-page-employees .emp-wrap", "display", 1920), "block");
  assert.equal(at(".v2-page-employees .emp-statstrip", "flex-direction", 1920), "row");
  assert.equal(at(".v2-page-employees .emp-statstrip", "position", 1920), "static");
  assert.equal(at(".v2-page-employees .emp-stat", "background", 1920), "var(--card)");
  assert.equal(at(".v2-page-employees .emp-wrap", "display", 1440), "block", "1600 以下原本就是叠放");
  assert.equal(at(".v2-page-employees .emp-wrap", "display", 390), "block", "390 宽叠放不变");
});

test("F50 批量操作条只在选中行时渲染（未选中不占位）", () => {
  const emp = read("pages", "admin", "Employees.jsx");
  assert.match(emp, /\{selectedKeys\.length > 0 && \(\s*<Banner\s+type="info"\s+className="emp-bulkbar emp-bulkbar-dark"/);
});

/* ---------------- F51 ②③ 组织架构（U-10） ---------------- */

function loadFit(src) {
  const start = src.indexOf("const FIT_MAX");
  assert.ok(start >= 0, "OrgChart.jsx 没有 fitChart（打开即适应画布、上限 100%）");
  const fnAt = src.indexOf("function fitChart(", start);
  let i = src.indexOf("{", fnAt), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  const code = src.slice(start, i + 1) + "\nthis.fitChart = fitChart;";
  const ctx = { Math, Number, Infinity, Error };
  vm.runInNewContext(code, ctx);
  return ctx.fitChart;
}
function fakeChart(nodes, w, h) {
  function Transform(k, x, y) { this.k = k; this.x = x; this.y = y; }
  const out = { t: null, fallback: false };
  const tr = { duration() { return tr; }, call(_f, t) { out.t = t; return tr; }, attr() { return tr; } };
  const svgEl = { __zoom: new Transform(1, 0, 0) };
  const st = {
    root: { descendants: () => nodes }, layout: "top",
    layoutBindings: { top: { nodeLeftX: (d) => -d.width / 2, nodeRightX: (d) => d.width / 2, nodeTopY: () => 0, nodeBottomY: (d) => d.height } },
    svg: { node: () => svgEl, attr() { return this; }, transition: () => tr },
    zoomBehavior: { transform() {} }, centerG: { transition: () => tr }, duration: 0,
    container: { getBoundingClientRect: () => ({ width: w }) }, svgWidth: w, svgHeight: h,
  };
  return { chart: { getChartState: () => st, fit() { out.fallback = true; } }, out };
}
const row = (n, y = 0) => Array.from({ length: n }, (_, i) => ({ x: i * 256, y, width: 232, height: 96 }));

test("F51 ② 组织架构画布撑满内容区：不再内联限宽 1400", () => {
  const org = read("pages", "admin", "OrgChart.jsx");
  assert.ok(!/maxWidth:\s*1400/.test(org), "OrgChart 仍限宽 1400");
});

test("F51 ③ 打开即适应画布，节点少时不放大超过 100%（原 fit 最多放大 8 倍，部门卡被放大到 2~3 倍）", () => {
  const org = read("pages", "admin", "OrgChart.jsx");
  const fitChart = loadFit(org);
  // 公司卡 + 4 个部门：库自带 fit 会放大到 >1
  const small = [{ x: 384, y: 0, width: 232, height: 96 }, ...row(4, 150)];
  const a = fakeChart(small, 1536, 680);
  fitChart(a.chart, false);
  assert.ok(a.out.t && !a.out.fallback, "按自算边界缩放");
  assert.equal(a.out.t.k, 1, "上限 100%");
  // 宽树：缩小到放得下，左右节点都在画布内（不被裁）
  const wide = row(30, 150);
  const b = fakeChart(wide, 1536, 680);
  fitChart(b.chart, false);
  const { k, x } = b.out.t;
  assert.ok(k < 1 && k > 0, "宽树缩小");
  const left = x + k * (wide[0].x - 116), right = x + k * (wide[29].x + 116);
  assert.ok(left >= 0 && right <= 1536, `节点在画布内：${left.toFixed(1)}..${right.toFixed(1)}`);
  // 首次绘制后与「适应画布」按钮都走 fitChart，不再直接调库的 fit
  assert.match(org, /else fitChart\(chart\);/);
  assert.match(org, /onClick=\{\(\) => cc\(\(c\) => fitChart\(c\)\)\}>\{s\.fit\}/);
  assert.ok(!/c\.fit\(\{ animate: true \}\)/.test(org), "按钮仍直接调用库的 fit");
});

test("11.4 课程库：只读档不再单列权限说明段落，标题右侧放「只读」胶囊", () => {
  const co = read("pages", "admin", "Content.jsx");
  assert.ok(!/<div className="co-lead">\{s\.roWrite\}<\/div>/.test(co), "课程库仍有只读说明段落");
  assert.match(co, /<h1 className="co-title">\{s\.title\}<\/h1>\n\s*\{!canWrite && <ReadOnlyPill tip=\{s\.roWrite\} \/>\}/);
});
