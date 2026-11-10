// F46（2026-10-09）行内对齐与标签统一 + F47 小胶囊放在所属文字右侧。源码 / CSS 级检查。
//   F46 负责人：「优先行居中对齐，不影响美观的前提下最好大小宽度也一致」——含按钮的行里，标签 / 状态与按钮垂直居中，
//       同一行的标签同高同样式，按钮所在区域不单独着色。
//   F47 负责人：「所有的小胶囊都放在文字右边，不要上下」——标签在所属文字右侧同一行、垂直居中，放不下时文字自身换行，胶囊不单独掉到下一行。
// CSS 断言按「最后一条生效的声明」取值（app.css 在前、v2.css 在后，与 main.jsx 的引入顺序一致），并考虑 @media 宽度。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const CSS = read("app.css") + "\n" + read("v2.css") + "\n" + read("admin.css");   // 简化 10/11：后台专用规则拆到 admin.css

// 选择器 + 属性在给定视口宽度下最后一条生效的值（同 test/course-library-b3.test.js 的 cssLast，支持 min/max-width 组合）
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
const areas = (v) => String(v || "").replace(/\s+/g, " ").trim();
// 统一标签：同一高度、无上下内边距、同字号、同圆角
function uniformTag(sel) {
  assert.equal(at(sel, "height"), "24px", sel + " height");
  assert.equal(at(sel, "padding"), "0 9px", sel + " padding");
  assert.equal(at(sel, "font-size"), "11.5px", sel + " font-size");
  assert.equal(at(sel, "line-height"), "1", sel + " line-height");
  assert.equal(at(sel, "border-radius"), "6px", sel + " border-radius");
}

/* ---------------- F46 ---------------- */

test("F46-1 课程目录：入职 / 线上 标签纵跨三行，与右侧按钮同一中线（桌面）；手机布局不变", () => {
  assert.equal(areas(at(".cg-main", "grid-template-areas", 1440)), "'title tags' 'alt tags' 'meta tags'");
  assert.equal(areas(at(".cg-main", "grid-template-areas", 800)), "'title tags' 'alt tags' 'meta tags'");
  assert.equal(areas(at(".cg-main", "grid-template-areas", 390)), "'title' 'alt' 'tags' 'meta'");
  assert.equal(at(".cg-main", "align-items"), "center");
  assert.equal(at(".cg-row", "align-items"), "center");
});

test("F46-1 课程目录：「已完成」与 入职 / 线上 同高同样式，图标缩到 12px", () => {
  uniformTag(".cg-row .pill");
  assert.equal(at(".cg-row .pill svg.ic", "width"), "12px");
  assert.equal(at(".cg-row .pill svg.ic", "height"), "12px");
});

test("F46-1 课程目录：操作区不单独着色，悬停时整行同一底色", () => {
  assert.equal(at(".cg-act", "background"), "transparent");
  assert.equal(at(".cg-main:hover", "background"), "transparent");
  assert.equal(at(".cg-row:hover", "background"), "var(--surface)");
});

test("F46-2 考试结果：「未通过」与「简答题待评分」在同一 flex 行，居中、同高", () => {
  const src = read("pages", "Result.jsx");
  const m = src.match(/<div className="res-tags">([\s\S]*?)<\/div>/);
  assert.ok(m, "res-tags wrapper exists");
  assert.match(m[1], /res-failpill/);
  assert.match(m[1], /s\.manualPending/);
  assert.doesNotMatch(src, /marginLeft: 6 \}\}>\{s\.manualPending\}/, "no inline margin on the second pill");
  assert.equal(at(".res-tags", "display"), "flex");
  assert.equal(at(".res-tags", "align-items"), "center");
  assert.equal(at(".v2-result-rail .res-tags", "justify-content"), "center");
  uniformTag(".res-tags .pill");
  assert.equal(at(".res-tags .pill svg.ic", "height"), "12px");
});

test("F46-3 首页资料条：「查看成长档案」与头像、职级胶囊同一行（宽屏），中屏布局不变", () => {
  assert.equal(areas(at(".v2-profile-strip", "grid-template-areas", 1440)), "'identity action' 'facts facts'");
  assert.equal(areas(at(".v2-profile-strip", "grid-template-areas", 1100)), "'identity identity' 'facts action'");
  assert.equal(at(".v2-profile-strip>.me-open", "align-self"), "center");
  assert.equal(at(".me-top", "align-items"), "center");
  assert.equal(at(".me-sub:empty", "display"), "none");
  uniformTag(".me-name .pill");
});

test("F46 我的课程：「线下 / 自主学习」移到状态格，与状态胶囊、按钮同一中线；整行悬停同色", () => {
  const src = read("pages", "MyLearning.jsx");
  const meta = src.match(/<span className="ml-row-meta">([\s\S]*?)<\/span>/)[1];
  assert.doesNotMatch(meta, /pill/, "meta line carries no pills");
  const st = src.match(/<span className="ml-row-status">([\s\S]*?)\{statusPill\(p, st\)\}/);
  assert.ok(st, "status cell holds the tags before the status pill");
  assert.match(st[1], /className="pill muted">\{s\.offlineTag\}/);
  assert.match(st[1], /className="pill pri ml-self">\{s\.selfTag\}/);
  assert.equal(at(".ml-row-status", "align-items"), "center");
  uniformTag(".ml-row .pill");
  assert.equal(at(".ml-list>li:hover", "background"), "var(--surface)");
  assert.equal(at(".ml-row:hover", "background"), "transparent");
});

test("F46 学习记录 › 考试明细行：结果格居中；「最佳 / 已调整 / 人工阅卷」与结果胶囊同高同样式", () => {
  assert.equal(at(".rec-h-res", "display"), "flex");
  assert.equal(at(".rec-h-res", "align-items"), "center");
  assert.equal(at(".rec-h-act", "align-items"), "center");
  uniformTag(".rec-hrow2 .pill");
  uniformTag(".rec-hrow2 .rec-tag");
  assert.equal(at(".rec-hrow2 .rec-tag", "margin-left"), "0");
});

test("F46 我的团队 / 下属档案：行头（胶囊与「明细」按钮）垂直居中，不再顶端对齐", () => {
  assert.equal(at(".v2-layout .tm-head", "align-items", 1440), "center");
  assert.equal(at(".v2-layout .tm-head", "align-items", 390), "center");
  uniformTag(".tm-head .pill");
  // 共用标签规则不得改写 display（.tm-msum / .tm-dsum 的桌面 / 手机显隐靠它）
  assert.equal(at(".tm-head .pill", "display"), undefined);
});

test("F46 学习项目详情：课程步骤的状态胶囊在按钮左侧，不在标题下的元信息行", () => {
  const src = read("pages", "ProgramDetail.jsx");
  const meta = src.match(/<div className="pg-meta">\n\s*<span className="tnum">\{c\.moduleCount/);
  assert.ok(meta, "course meta line starts with the module count");
  assert.match(src, /<span className="pg-stepst">\{statePill\(state\)\}<\/span>\n\s*<span className=\{'btn sm' \+ \(state === 'current'/);
  uniformTag(".pg-step .pill");
});

/* ---------------- F47 ---------------- */

test("F47 人才筛选页头：「内置 / 共享 / 私有」在标题右侧同一行", () => {
  const src = read("pages", "admin", "TalentFilter.jsx");
  assert.match(src, /<div className="co-page-tline">\n\s*<h1 className="co-page-title" title=\{title\}>\{title\}<\/h1>\n\s*\{tag \|\| null\}\n\s*<\/div>/);
  assert.match(src, /, actions, \(\n\s*<Tag size="small" color=\{isBuiltin \? 'violet'/);
  assert.doesNotMatch(src, /<span className="tf-sub">\n\s*<Tag/, "kind tag is no longer in the sub line");
  assert.equal(at(".co-page-tline", "display"), "flex");
  assert.equal(at(".co-page-tline", "align-items"), "center");
  assert.equal(at(".co-page-tline", "flex-wrap"), "nowrap");
  assert.equal(at(".co-page-tline>.co-page-title", "min-width"), "0");
  assert.equal(at(".co-page-tline>.semi-tag", "flex"), "none");
});

test("F47 员工档案卡：姓名与「PD2 / 正式」同一行（姓名不再占满整行）", () => {
  for (const w of [1440, 390]) {
    assert.equal(at(".v2-person-rail .ppl-id-name h1", "width", w), "auto", "h1 width @" + w);
    assert.equal(at(".v2-person-rail .ppl-id-name", "flex-wrap", w), "nowrap", "row nowrap @" + w);
  }
  assert.equal(at(".v2-person-rail .ppl-id-name", "align-items"), "center");
  assert.equal(at(".v2-person-rail .ppl-id-name h1", "min-width"), "0");
  assert.equal(at(".v2-person-rail .ppl-id-name>.semi-tag", "flex"), "none");
});

test("F47 首页资料条：姓名后的职级 / 状态胶囊不单独换到下一行", () => {
  assert.equal(at(".me-name", "flex-wrap"), "nowrap");
  assert.equal(at(".me-name", "flex-wrap", 390), "nowrap");
});

test("F47 名单与列表：周期名、人员姓名、考试名与其标签同一行", () => {
  assert.equal(at(".rvc-name", "flex-direction"), "row");
  assert.equal(at(".rvc-name", "align-items"), "center");
  assert.equal(at(".rvc-name", "flex-wrap"), "nowrap");
  assert.equal(at(".tf-namecell", "flex-wrap"), "nowrap");
  assert.equal(at(".tf-namecell>.semi-tag", "flex"), "none");
  assert.equal(at(".exm-mc-l1", "flex-wrap", 390), "nowrap");
  assert.equal(at(".exm-mc-l1>.pill", "flex", 390), "none");
});

test("F47 标题与胶囊：章节「未保存」、申诉页头评级 / 状态、课程编辑页头项目标签都在标题右侧", () => {
  // 章节标题的下边距移到行上，标题与「未保存」同一中线
  assert.equal(at(".co-ed-hrow .co-ed-h", "margin-bottom"), "0");
  assert.equal(at(".co-ed-hrow", "flex-wrap"), "nowrap");
  // 申诉页头：标题 + 胶囊第一行，周期第二行
  assert.equal(at(".rv-ap-head", "display"), "grid");
  assert.equal(at(".rv-ap-head>.pill", "grid-row"), "1");
  assert.equal(at(".rv-ap-head .rv-ap-cycle", "grid-row"), "2");
  // 课程编辑页头：课程名 + 项目标签第一行，形态说明第二行
  assert.equal(at(".co-editor .co-page-titles", "display"), "grid");
  assert.equal(at(".co-editor .co-page-titles>.co-ptags", "grid-row"), "1");
  assert.equal(at(".co-editor .co-page-titles>.co-ptags", "grid-column"), "2");
  assert.equal(at(".co-editor .co-page-titles>.co-page-sub", "grid-row"), "2");
});

test("F46 / F47 新增样式块：只追加、只用变量（无 hex / rgb）", () => {
  for (const f of ["app.css", "v2.css"]) {
    const t = read(f);
    const i = t.indexOf("/* ===== F46 行内对齐与标签统一（2026-10-09）===== */");
    assert.ok(i > 0, f + " has the F46 block");
    // Unfolding Lab 版（2026-10-12）：v2.css 末尾另有品牌调色板块（定义色值本身，必须写 hex），不属于 F46 块
    const end = t.indexOf("/* ===== Unfolding Lab 品牌");
    const block = end > i ? t.slice(i, end) : t.slice(i);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, f + " block uses tokens only");
  }
});
