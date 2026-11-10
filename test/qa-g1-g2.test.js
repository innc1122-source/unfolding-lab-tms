// G1 / G2（2026-10-09，QA 第 24 节）
//   G1 培养项目表格「开始—结束」列：开始在上、结束在下，各自不断开（原来一行，结束日期折成「2026-10-」+「05」）。
//   G2 部门筛选触发器「全部部门」：扫描所有 .dpf-trigger / .dpf-trigger-t 规则 —— 文字一行、放不下用省略号，
//      任何规则都不得把 white-space 改回可换行；触发器在常规宽度下最小宽度不低于 150px（指派条件行的整行触发器除外）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEB = process.env.QA_G_WEB || path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const CSS = read("app.css") + "\n" + read("v2.css") + "\n" + read("admin.css");   // 简化 10/11：后台专用规则拆到 admin.css

// 与 qa-f46-align 的 cssLast 相同：给定视口宽度下某选择器某属性最后一条生效的值
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
// 所有选择器里含 needle 的规则（不论媒体查询），返回 [{ sel, body }]
function rulesWith(css, needle) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) if (m[1].includes(needle) && !m[1].trim().startsWith("@")) out.push({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  return out;
}

test("G1 起止日期两行显示，各自不换行", () => {
  const src = read("pages", "admin", "Projects.jsx");
  assert.match(src, /<span className="tp-dates tnum"><span>\{pjDay\(p\.startAt\) \|\| '—'\}<\/span><span>\{pjDay\(p\.endAt\) \|\| '—'\}<\/span><\/span>/);
  assert.equal(cssLast(CSS, ".tp-dates", "flex-direction", 1440), "column");
  assert.equal(cssLast(CSS, ".tp-dates>span", "white-space", 1440), "nowrap");
});

test("G2 所有 .dpf-trigger-t 规则都不得允许换行；全局为不换行 + 省略号", () => {
  for (const r of rulesWith(CSS, "dpf-trigger-t")) {
    const ws = (r.body.match(/white-space\s*:\s*([^;]+)/) || [])[1];
    if (ws) assert.equal(ws.trim(), "nowrap", r.sel + " 把 white-space 改成了 " + ws);
    assert.doesNotMatch(r.body, /word-break\s*:\s*break-all/, r.sel);
  }
  for (const w of [1440, 1920, 1100]) {
    assert.equal(cssLast(CSS, ".dpf-trigger .dpf-trigger-t", "white-space", w), "nowrap");
    assert.equal(cssLast(CSS, ".dpf-trigger .dpf-trigger-t", "text-overflow", w), "ellipsis");
    assert.equal(cssLast(CSS, ".dpf-trigger", "white-space", w), "nowrap");
  }
});

test("G2 触发器在常规宽度下不被父级 flex 压窄：.dpf 不收缩，小号触发器最小 168px", () => {
  assert.equal(cssLast(CSS, ".dpf", "flex", 1440), "none");
  assert.equal(cssLast(CSS, ".dpf-sm .dpf-trigger", "min-width", 1440), "168px");
  // 任何把触发器最小宽度压到 150px 以下的规则，只允许出现在指派条件行（整行宽度的触发器）
  for (const r of rulesWith(CSS, "dpf-trigger")) {
    const mw = (r.body.match(/min-width\s*:\s*([^;]+)/) || [])[1];
    if (!mw || !/\.dpf-trigger(?![-\w])/.test(r.sel)) continue;
    const px = /^(\d+)px$/.test(mw.trim()) ? +mw.trim().slice(0, -2) : (mw.trim() === "0" ? 0 : null);
    if (px !== null && px < 150) assert.match(r.sel, /\.asg-crit-ctl/, r.sel + " min-width " + mw);
  }
});
