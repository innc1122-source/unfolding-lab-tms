// QA §19（2026-10-09）第五批缺陷 D5–D8 与课程目录筛选样式的源码回归：不起浏览器、不打包，读源码与 CSS 断言。
// D5 晋升评审候选表 1440 宽放得下、操作列固定在右侧；D6 人才筛选结果表默认列放得下、姓名列固定在左侧、宽列集合仍可横向滚动；
// D7 组卷页题型标签不被压缩；D8 部门筛选触发器文字全站不换行；课程目录「全部授课方式」原生下拉与类别按钮同一外观。
// 环境变量 QA_D5D8_SRC 可指向另一份 web/src（用于在修复前的副本上证明这些用例会失败）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = process.env.QA_D5D8_SRC || path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8").replace(/\r\n/g, "\n");

// 与 course-library-b3.test.js 同一个辅助：某视口宽度下，某个选择器（整段选择器文本相同）某个属性最后一次声明的值。
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
// 选择器的全部声明文本（不分视口），用于「只用变量、不写死颜色」检查
function ruleBodies(css, selector) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").map((x) => x.trim().replace(/\s+/g, " ")).includes(selector)) out.push(m[2]);
  }
  return out;
}
function fnBody(src, name) {
  const at = src.search(new RegExp("\\nfunction " + name + "\\("));
  assert.ok(at >= 0, "function " + name + " exists");
  return src.slice(at, src.indexOf("\n}\n", at + 1) + 2);
}
// 从 start 起取一个括号配平的表达式，到顶层的 `,` 或 `}` 为止
function exprAt(src, start) {
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
    else if (c === "," && depth === 0) break;
  }
  return src.slice(start, i).trim();
}

// 1440 视口下表格可用宽度（QA 实测，见 docs/QA-20261006.md §19）
const PROMO_BOX = 914;   // 人才盘点 › 晋升评审候选卡片内
const FILTER_BOX = 1116; // 人才筛选结果卡片内
const SEL_COL = 60;      // Semi 勾选列（DEFAULT_WIDTH_COLUMN_SELECTION），即 BULK_SEL_EXTRA

test("QA D5：晋升评审候选表在 1440 宽（约 914px）放得下（4 条条件，中英文同宽），操作列固定在右侧", () => {
  const tr = read("pages", "admin", "TalentReview.jsx");
  const fn = fnBody(tr, "PromoPipeline");
  const num = (expr) => {
    if (/^\d+$/.test(expr)) return +expr;
    const m = tr.match(new RegExp("^const " + expr + " = (\\d+);", "m"));
    assert.ok(m, "width constant " + expr + " is a number");
    return +m[1];
  };
  const widthOf = (re, what) => {
    const m = fn.match(re);
    assert.ok(m, what + " column found");
    return num(m[1]);
  };
  const name = widthOf(/\{ title: s\.colName, dataIndex: 'name', width: (\w+)/, "name");
  const cur = widthOf(/\{ title: s\.pCur, dataIndex: 'jobLevel', width: (\w+)/, "current → next");
  const cond = widthOf(/dataIndex: 'c_' \+ \(it\.id \|\| i\), width: (\w+)/, "condition");
  const result = widthOf(/\{ title: s\.pResult, dataIndex: 'eligible', width: (\w+)/, "result");
  const act = widthOf(/title: s\.colAct, dataIndex: '__act', width: (\w+)/, "actions");
  // F62：条件列数 = 新默认条件数减去「有下一职级」（它由「当前 → 下一级」列表达）= 4
  const M = require(path.join(__dirname, "..", "modules", "talent", "filter-model.js"));
  const nCond = M.promotionConfigToFilter({}, ["A+", "A", "B+", "B", "C", "D"]).items.filter((l) => l.tag !== "nextLevel").length;
  assert.equal(nCond, 4, "F62 default: 5 conditions, 4 of them shown as columns");
  const total = name + cur + nCond * cond + result + act;
  assert.ok(total <= PROMO_BOX, `name ${name} + current ${cur} + ${nCond} × condition ${cond} + result ${result} + actions ${act} = ${total}px > ${PROMO_BOX}px`);
  assert.ok(cond <= 110, "dynamic ✓/✗ condition columns use a narrow fixed width, got " + cond);
  // 筛选读不到时退回的旧四列（F62：评级、现职级任职、司龄、违纪）也放得下
  const legacy = [...fn.matchAll(/\{ title: s\.p(?:Rating|LevelTenure|Tenure|Train|Vio), dataIndex: 'checks\d?', width: (\d+)/g)].map((m) => +m[1]);
  assert.equal(legacy.length, 4, "legacy fallback columns");
  assert.ok(name + cur + legacy.reduce((a, b) => a + b, 0) + result + act <= PROMO_BOX, "legacy fallback fits too");
  // 操作列固定在右侧（条件更多时横向滚动，「移出候选」仍可见）
  assert.match(fn, /title: s\.colAct, dataIndex: '__act', width: \w+, fixed: 'right', className: 'trev-pc-opcol',/);
  assert.match(fn, /\{\.\.\.resizableTable\(\[/, "scroll.x still follows the real column sum");
  // 120px 操作列里英文长按钮换行，不撑出列宽；结果标签换行显示全文
  const css = read("app.css");
  assert.equal(cssLast(css, ".trev-pc-opcol .semi-button", "white-space", 1440), "normal");
  assert.equal(cssLast(css, ".trev-pc-res .semi-tag-content", "white-space", 1440), "normal");
  assert.match(fn, /dataIndex: 'eligible', width: \w+, className: 'trev-pc-res'/);
});

test("QA D6：人才筛选结果表默认列在 1440 宽（约 1116px）放得下；姓名列与勾选列固定在左侧、条件命中固定在右侧；宽列集合横向滚动", () => {
  const tf = read("pages", "admin", "TalentFilter.jsx");
  const colW = tf.match(/^const COL_W = (\{[^\n]*\});/m);
  assert.ok(colW, "COL_W map");
  const COL_W = vm.runInNewContext("(" + colW[1] + ")");
  const fbM = tf.match(/width: COL_W\[cid\] \|\| (\w+)/);
  assert.ok(fbM, "fallback width");
  const fallback = /^\d+$/.test(fbM[1]) ? +fbM[1] : +tf.match(new RegExp("^const " + fbM[1] + " = (\\d+);", "m"))[1];
  const hitsAt = tf.indexOf("dataIndex: '__hits', width: ");
  assert.ok(hitsAt > 0, "hits column");
  const hitsExpr = exprAt(tf, hitsAt + "dataIndex: '__hits', width: ".length);
  const helper = (tf.match(/^const hitsWidth = [^\n]*;$/m) || [""])[0];
  const hitsW = (n) => vm.runInNewContext(helper + "\n(" + hitsExpr + ")", { st: { def: { items: new Array(n).fill({}) } } });
  const lib = read("pages", "admin", "talentFilter.js");
  const DEFAULT = vm.runInNewContext(lib.match(/^export const DEFAULT_COLUMNS = (\[[^\]]*\]);/m)[1]);
  const widthOf = (cols) => cols.reduce((a, c) => a + (COL_W[c] || fallback), 0);
  for (const n of [1, 3, 5]) {
    const total = widthOf(DEFAULT) + SEL_COL + hitsW(n);
    assert.ok(total <= FILTER_BOX, `default columns (${DEFAULT.join(", ")}) + selection + hits(${n}) = ${total}px > ${FILTER_BOX}px`);
  }
  assert.ok(hitsW(5) <= 200, "hits column stays compact (5 conditions = " + hitsW(5) + "px)");
  // 姓名列（第一列时）固定在左侧；勾选列随之固定；条件命中固定在右侧
  assert.match(tf, /\.\.\.\(cid === 'name' && ci === 0 \? \{ fixed: 'left' \} : null\)/);
  assert.match(tf, /rowSelection=\{canWrite \? \{\n\s+fixed: 'left',/);
  assert.match(tf, /dataIndex: '__hits', width: [^\n]*fixed: 'right'/);
  // 横向滚动仍在：scroll.x = 实际列宽合计 + 勾选列（resizableTable），之后没有手写 scroll 覆盖
  const tableAt = tf.indexOf("<Table rowKey=\"id\" size=\"small\" dataSource={rows}");
  const tableSrc = tf.slice(tableAt, tf.indexOf("/>", tf.indexOf("resizableTable(tableCols", tableAt)) + 2);
  assert.match(tableSrc, /\{\.\.\.resizableTable\(tableCols, \{ extra: canWrite \? BULK_SEL_EXTRA : 0 \}\)\} \/>$/);
  assert.doesNotMatch(tableSrc, /\bscroll=/);
  assert.match(read("components", "BulkActions.jsx"), new RegExp("export const BULK_SEL_EXTRA = " + SEL_COL + ";"));
  // 晋升评审候选 10 列：超出可视宽度，横向滚动（scroll.x 与列宽合计一致）
  const PROMO = ["name", "employeeId", "department", "jobLevel", "nextLevel", "latestRating", "tenure", "trainingMandatory", "violationCount", "potential"];
  for (const c of PROMO) assert.ok(COL_W[c] || fallback, c);
  assert.ok(COL_W.violationCount, "violationCount has its own compact width");
});

test("QA D7：组卷页题干折两行时题型标签不收缩、不换行", () => {
  const css = read("app.css");
  assert.equal(cssLast(css, ".exc-row-main > .semi-tag", "flex-shrink", 1440), "0");
  assert.equal(cssLast(css, ".exc-row-main > .semi-tag", "white-space", 1440), "nowrap");
  assert.equal(cssLast(css, ".exc-row-main > .semi-tag .semi-tag-content", "text-overflow", 1440), "clip");
  const comp = read("pages", "admin", "exam", "Composer.jsx");
  // 标签是 .exc-row-main 的直接子元素（题库栏与试卷栏）
  assert.equal((comp.match(/<div className="exc-row-main">/g) || []).length, 2);
  assert.match(comp, /<div className="exc-row-main">[\s\S]*?<TypeTag type=\{q\.type\} lang=\{lang\} short size="small" \/>\n\s+<span className="exc-stem"/);
});

test("QA D8：部门筛选触发器（DeptFilter）文字全站不换行、超长省略，小号触发器最小宽度能完整显示「全部部门」", () => {
  const v2 = read("v2.css");
  for (const w of [1440, 390]) {
    assert.equal(cssLast(v2, ".dpf-trigger-t", "white-space", w), "nowrap", "global (not .dcal-filters only) at " + w);
    assert.equal(cssLast(v2, ".dpf-trigger-t", "overflow", w), "hidden");
    assert.equal(cssLast(v2, ".dpf-trigger-t", "text-overflow", w), "ellipsis");
    assert.equal(cssLast(v2, ".dpf-trigger-t", "min-width", w), "0");
  }
  const mw = cssLast(v2, ".dpf-sm .dpf-trigger", "min-width", 1440) || "";
  assert.ok(parseInt(mw, 10) >= 168, ".dpf-sm .dpf-trigger min-width = " + mw);
  const df = read("components", "DeptFilter.jsx");
  assert.match(df, /<button ref=\{triggerRef\} type="button" className=\{'dpf-trigger'/);
  assert.match(df, /<span className="dpf-trigger-t">/);
});

test("课程目录：「全部授课方式」原生下拉与「全部类别」按钮同一套样式（高度、边框、圆角、内边距、字体、箭头），只用变量，员工端不引入 Semi", () => {
  const css = read("app.css");
  const at = (p) => cssLast(css, ".cg-select", p, 1440);
  assert.equal(at("appearance"), "none");
  assert.equal(at("-webkit-appearance"), "none");
  assert.equal(at("height"), "36px");
  assert.equal(at("border"), "1px solid var(--line)");
  assert.equal(at("border-radius"), "var(--radius)");
  assert.equal(at("padding"), "0 30px 0 12px");
  assert.equal(at("font"), "inherit");
  assert.match(at("background-image") || "", /var\(--ink-3\)/, "chevron drawn with a token colour");
  for (const body of ruleBodies(css, ".cg-select").concat(ruleBodies(css, ".cg-cat-btn.on"))) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|url\(/i, "tokens only: " + body);
  }
  const cat = read("pages", "Catalog.jsx");
  assert.match(cat, /<select className="cg-select" value=\{f\.mode\}/);
  assert.match(cat, /className=\{'cg-select cg-cat-btn'/, "category button shares .cg-select");
  assert.doesNotMatch(cat, /@douyinfe\/semi-ui/);
});
