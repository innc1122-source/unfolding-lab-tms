// UI 批 U3（2026-10-09）：11.3 / F45 考试最后一题交卷 + F54 后台「系统设置」菜单顺序、图标与悬停底色。源码 / CSS 级检查。
//   11.3 / F45 负责人：「最后一题没有办法点，要在最下面交卷……应该是上一题旁边用交卷」——最后一题（含案例的最后一道小题）时
//       「下一题」那一格换成「交卷」主按钮，与「上一题」同一行，打开同一个交卷确认框（含未答题数提示）；答题卡旁的交卷保留。
//   F54 负责人：「这里的排序调整下，按照使用逻辑」——系统设置按「权限与分工 → 数据口径 → 平台设置 → 审计」排序，
//       每项各自一个线性图标；未选中的「HRBP 分工」不再显示像被选中的整块底色（根因：未选中项的 :hover 铺整块填充，与选中态同形）。
// CSS 断言按 app.css 在前、v2.css 在后（与 main.jsx 的引入顺序一致）取层叠结果，并考虑 @media 宽度。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const CSS = read("app.css") + "\n" + read("v2.css") + "\n" + read("admin.css");   // 简化 10/11：后台专用规则拆到 admin.css

/* ---------- 迷你层叠：只认「类 / 标签 + :hover + :not(.类)」的后代选择器，足够判断侧栏条目 ---------- */
// 返回 [{ sel, body, order }]，只收在给定宽度下生效的规则
function rulesAt(css, width) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack = [];
  const out = [];
  let buf = "", order = 0;
  const applies = () => stack.every((m) => {
    if (m.startsWith("@container") || /\bprint\b/.test(m)) return false;
    if (!m.startsWith("@media")) return true;
    if (/\(hover:\s*none\)/.test(m)) return false; // 桌面鼠标视口
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
      if (!applies()) continue;
      for (const one of sel.split(",")) out.push({ sel: one.trim().replace(/\s+/g, " "), body, order: order++ });
    } else if (c === "}") { stack.pop(); buf = ""; }
    else if (c === ";" && buf.trim().startsWith("@")) buf = "";
    else buf += c;
  }
  return out;
}
// 一个复合选择器：可选标签、若干 .类、:hover、:not(.类)；别的伪类 / 属性 / 组合符一律当作不匹配
function parseCompound(s) {
  const m = { tag: null, cls: [], not: [], hover: false, ok: true, spec: [0, 0, 0] };
  const re = /^([a-z][a-z0-9]*)|\.([\w-]+)|:not\(\.([\w-]+)\)|:(hover)|(.)/gi;
  let t;
  while ((t = re.exec(s))) {
    if (t[1]) { m.tag = t[1].toLowerCase(); m.spec[2]++; }
    else if (t[2]) { m.cls.push(t[2]); m.spec[1]++; }
    else if (t[3]) { m.not.push(t[3]); m.spec[1]++; }
    else if (t[4]) { m.hover = true; m.spec[1]++; }
    else { m.ok = false; break; }
  }
  return m;
}
const matchEl = (cp, el) => cp.ok && (!cp.tag || cp.tag === el.tag) && cp.cls.every((c) => el.cls.includes(c))
  && cp.not.every((c) => !el.cls.includes(c)) && (!cp.hover || el.hover);
function matches(sel, chain) {
  if (/[>+~[]/.test(sel)) return null;
  const parts = sel.split(" ").map(parseCompound);
  if (parts.some((p) => !p.ok)) return null;
  let j = chain.length - 1;
  if (!matchEl(parts[parts.length - 1], chain[j])) return null;
  for (let k = parts.length - 2; k >= 0; k--) {
    j--;
    while (j >= 0 && !matchEl(parts[k], chain[j])) j--;
    if (j < 0) return null;
  }
  return parts.reduce((a, p) => [a[0] + p.spec[0], a[1] + p.spec[1], a[2] + p.spec[2]], [0, 0, 0]);
}
// 层叠后某属性的值（不处理 !important；侧栏这几条都没有）
function computed(chain, prop, width = 1440) {
  let best = null;
  for (const r of rulesAt(CSS, width)) {
    const spec = matches(r.sel, chain);
    if (!spec) continue;
    for (const d of r.body.split(";")) {
      const at = d.indexOf(":");
      if (at <= 0 || d.slice(0, at).trim() !== prop) continue;
      const v = d.slice(at + 1).trim();
      const cand = { spec, order: r.order, v };
      const cmp = (a, b) => a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order;
      if (!best || cmp(cand, best) >= 0) best = cand;
    }
  }
  return best ? best.v : undefined;
}
// 后台侧栏「系统设置」组里的一个条目（AdminLayout.jsx 的 DOM 结构；Layout v2 的 body 类由 v2BodyClasses 写）
const sideItem = ({ on = false, hover = false } = {}) => [
  { tag: "body", cls: ["v2-layout", "v2-admin", "v2-page-roles"] },
  { tag: "div", cls: ["adm-shell"] },
  { tag: "aside", cls: ["adm-side"] },
  { tag: "div", cls: ["adm-nav-group"] },
  { tag: "div", cls: ["adm-nav-sub"] },
  { tag: "a", cls: ["adm-nav-item"].concat(on ? ["on"] : []), hover },
];
const isFill = (v) => v != null && !/^(transparent|none|0|initial|unset)$/i.test(v) && !/^#[0-9a-f]{6}00$/i.test(v);

/* ---------------- 11.3 / F45 ---------------- */

test("11.3 / F45 最后一题：「下一题」那一格换成「交卷」主按钮，打开同一个确认框；第三颗交卷不重复", () => {
  const src = read("pages", "ExamRunner.jsx");
  const start = src.indexOf("<div className={'exam-nav'");
  assert.ok(start > 0, "exam-nav row carries a last-question state class");
  const nav = src.slice(start, src.indexOf("</main>", start));
  assert.match(nav, /className=\{'exam-nav' \+ \(last \? ' is-last' : ''\)\}/);
  // 第二格：最后一题 = 交卷主按钮（不是 ghost），否则 = 下一题；下一题不再「置灰不可点」
  assert.match(nav, /\{last \? \(\s*<button className="btn exam-nav-last" onClick=\{\(\) => setConfirming\(true\)\} disabled=\{submitting\}>\s*\{s\.submit\}/);
  assert.match(nav, /\) : \(\s*<button className="btn" onClick=\{\(\) => go\(idx \+ 1\)\}>\s*\{s\.next\}/);
  assert.doesNotMatch(nav, /disabled=\{last\}/, "the Next slot is never a dead, greyed-out button");
  // 手机底部条的第三颗交卷只在非最后一题出现
  assert.match(nav, /\{!last && \(\s*<button\s+className="exam-nav-sub btn ghost"\s+onClick=\{\(\) => setConfirming\(true\)\}/);
  // 答题卡旁的交卷保留
  assert.match(src, /<button className="btn exam-submit" onClick=\{\(\) => setConfirming\(true\)\} disabled=\{submitting\}>/);
  // 同一个确认框，照旧提示未答题数
  assert.match(src, /\{confirming && \(/);
  assert.match(src, /\{unansweredCount > 0 \? s\.confirmSome\(unansweredCount\) : s\.confirmAll\}/);
  assert.match(src, /confirmSome: \(n\) => `还有 \$\{n\} 题未作答，确认交卷？`/);
});

test("11.3 / F45 案例小题：「最后一题」按答题格算，案例的最后一道小题就是最后一格", async () => {
  const src = read("pages", "ExamRunner.jsx");
  assert.match(src, /const slots = useMemo\(\(\) => slotsOf\(questions\), \[questions\]\);/);
  assert.match(src, /const last = idx === slots\.length - 1;/);
  const { slotsOf } = await import(pathToFileURL(path.join(WEB, "qtypes", "model.js")).href);
  const slots = slotsOf([{ id: "q1", type: "mcq" }, { id: "c1", type: "case", items: [{ sid: "a" }, { sid: "b" }] }]);
  assert.equal(slots.length, 3);
  const lastSlot = slots[slots.length - 1];
  assert.equal(lastSlot.sub && lastSlot.sub.sid, "b", "the last case sub-question is the last slot");
  assert.equal(lastSlot.label, "2.2");
});

test("11.3 / F45 手机底部条：最后一题只剩两颗按钮时两等分，不留空格；其余题仍是三等分", () => {
  const rules = (w) => rulesAt(CSS, w);
  const last = (w, sel, prop) => {
    let v;
    for (const r of rules(w)) if (r.sel === sel) for (const d of r.body.split(";")) { const at = d.indexOf(":"); if (at > 0 && d.slice(0, at).trim() === prop) v = d.slice(at + 1).trim(); }
    return v;
  };
  // CX-069（10/11）：列允许缩到 0（minmax），英文按钮不再把底部条撑出屏幕；等分不变
  assert.equal(last(390, ".exam-nav.is-last", "grid-template-columns"), "repeat(2,minmax(0,1fr))");
  assert.equal(last(390, ".exam-nav", "grid-template-columns"), "repeat(3,minmax(0,1fr))");
  assert.equal(last(1440, ".exam-nav.is-last", "grid-template-columns"), undefined, "desktop row stays a flex row");
});

/* ---------------- F54 ---------------- */

test("F54 系统设置顺序：角色与授权 → HRBP 分工 → 档案与职级设置 → 功能模块 → 品牌设置 → 审计日志", async () => {
  const rbac = await import(pathToFileURL(path.join(WEB, "rbac.js")).href);
  assert.deepEqual(rbac.navPages("system").map((p) => p.path), [
    "/admin/roles", "/admin/hrbp-coverage", "/admin/talent-settings", "/admin/modules", "/admin/brand-settings", "/admin/audit",
  ]);
});

test("F54 系统设置图标：每项各自一个线性图标，不再共用分组标题的齿轮，也不落到通用的文件图标", () => {
  const src = read("v2.jsx");
  const pathsSrc = src.slice(src.indexOf("const PATHS = {") + "const PATHS = ".length, src.indexOf("};", src.indexOf("const PATHS = {")) + 1);
  const PATHS = new Function("return " + pathsSrc)();
  const fnStart = src.indexOf("export function adminNavIcon(path) {");
  const fnSrc = src.slice(fnStart + "export ".length, src.indexOf("\n}\n", fnStart) + 2);
  const adminNavIcon = new Function(fnSrc + "\nreturn adminNavIcon;")();
  const items = ["/admin/roles", "/admin/hrbp-coverage", "/admin/talent-settings", "/admin/modules", "/admin/brand-settings", "/admin/audit"];
  const kinds = items.map(adminNavIcon);
  assert.equal(new Set(kinds).size, items.length, "one icon per item: " + kinds.join(", "));
  for (const [i, k] of kinds.entries()) {
    assert.notEqual(k, "settings", items[i] + " must not reuse the group gear");
    assert.notEqual(k, "file", items[i] + " must not fall back to the generic file icon");
    assert.ok(PATHS[k], items[i] + " → " + k + " has a path");
  }
  // 与其余导航图标同一画法：NavIcon 统一 24 网格、1.6 描边、圆头圆角
  assert.match(src, /<svg className=\{className\} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">/);
  // 分组标题仍是齿轮
  assert.match(read("components", "AdminLayout.jsx"), /system: 'settings'/);
});

test("F54 未选中的侧栏项悬停时不铺整块底色（不再像同时被选中）；选中项仍是品牌色整块", () => {
  for (const w of [1440, 390]) {
    const hovered = computed(sideItem({ hover: true }), "background", w);
    assert.ok(!isFill(hovered), `hovered, not selected @${w}: background must not fill, got ${hovered}`);
    assert.ok(!isFill(computed(sideItem(), "background", w)), `idle, not selected @${w}`);
    const sel = computed(sideItem({ on: true }), "background", w);
    assert.equal(sel, "var(--brand)", `selected @${w} keeps the brand fill`);
    assert.equal(computed(sideItem({ on: true, hover: true }), "background", w), "var(--brand)", `selected + hover @${w}`);
  }
  // 悬停仍有反馈：文字提亮
  assert.equal(computed(sideItem({ hover: true }), "color"), "#fff");
});
