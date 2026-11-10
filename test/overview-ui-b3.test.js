// 第三批 4.1 / 4.2 培训概览前端（2026-10-08，G3）：静态 + vm 断言。
//   · overview/ovquery.js 纯函数（vm 跑）：queryOf 键顺序稳定、filtersFromParams 缺省与校验、listParamsOf、fmtDelta 方向与好坏、bucketOf 分档。
//   · 指标卡整卡是 button、不设 aria-label（读屏读卡片文字）；名单 / 员工页进出都用 { push: true }；考试成绩页读写 ?status=。
//   · 热力表：部门名是行表头（th scope=row），app.css 里 .ovx-heat th 的规则不得有省略号或 nowrap（V3）；格子按钮有 aria-label。
//   · 需要关注 / 培养项目：段落不是卡片，卡片不套卡片（UX 审查 2）。
//   · 英文复数：带数量的词条用 1 调用时不出现 "1 people / 1 courses" 一类写法（UX 审查 7）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "web", "src");
const OV = path.join(SRC, "pages", "admin", "overview");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n");
const ov = (f) => read(OV, f);

function loadModule(src, extra = {}) {
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]);
  const code = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "").replace(/^export\s+/gm, "");
  const ctx = vm.createContext({ console, encodeURIComponent, decodeURIComponent, ...extra });
  vm.runInContext(code + "\n;globalThis.__x = {" + names.join(",") + "};", ctx);
  return ctx.__x;
}
const Q = loadModule(ov("ovquery.js"));

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

test("ovquery: filtersFromParams defaults to this quarter and drops invalid values", () => {
  const f = Q.filtersFromParams({});
  assert.equal(f.period, "quarter");
  assert.equal(f.cohort, "all");
  assert.deepEqual([...f.cat], []);
  const g = Q.filtersFromParams({ period: "bogus", enroll: "x", mode: "hybrid", cohort: "z", cat: "合规,,__none,合规", programs: "pw-a,pw-b" });
  assert.equal(g.period, "quarter");
  assert.equal(g.enroll, "");
  assert.equal(g.mode, "");
  assert.equal(g.cohort, "all");
  assert.deepEqual([...g.cat], ["合规", "__none"]);
  assert.deepEqual([...g.programs], ["pw-a", "pw-b"]);
  // 自定义缺日期 → 本季度；倒置的日期对调
  assert.equal(Q.filtersFromParams({ period: "custom", from: "2026-01-01" }).period, "quarter");
  const c = Q.filtersFromParams({ period: "custom", from: "2026-06-30", to: "2026-01-01" });
  assert.equal(c.period, "custom");
  assert.equal(c.from, "2026-01-01");
  assert.equal(c.to, "2026-06-30");
  // 非自定义时 from/to 不生效
  const m = Q.filtersFromParams({ period: "month", from: "2026-01-01", to: "2026-02-01" });
  assert.equal(m.from, null);
});

test("ovquery: queryOf has a stable key order, always sends period, omits defaults", () => {
  assert.equal(Q.queryOf(Q.filtersFromParams({})), "period=quarter");
  const f = Q.filtersFromParams({ cohort: "new30", programs: "pw-a", tp: "tp1", mode: "online", enroll: "mandatory", cat: "合规,__none", dept: "d1", period: "custom", from: "2026-01-01", to: "2026-03-31" });
  assert.equal(Q.queryOf(f),
    "period=custom&from=2026-01-01&to=2026-03-31&dept=d1&cat=" + encodeURIComponent("合规,__none") + "&enroll=mandatory&mode=online&tp=tp1&programs=pw-a&cohort=new30");
  // 覆盖项按传入顺序接在后面，空值省略
  assert.equal(Q.queryOf(Q.filtersFromParams({ period: "all" }), { metric: "overdue", ldept: "d2", lcat: null, q: "" }), "period=all&metric=overdue&ldept=d2");
  assert.deepEqual({ ...Q.bodyOf(Q.filtersFromParams({ dept: "d1" }), { metric: "dueSoon", lprog: "pw-x" }) }, { period: "quarter", dept: "d1", metric: "dueSoon", lprog: "pw-x" });
});

test("ovquery: listParamsOf maps the l* URL keys to the people endpoint", () => {
  const o = Q.listParamsOf({ list: "assigned", ldept: "d1", lcat: "__none", lprog: "pw-a", lenroll: "mandatory", lst: "notdone", lq: " Ana ", lp: "3", lsort: "name" });
  assert.deepEqual({ ...o }, { metric: "assigned", ldept: "d1", lcat: "__none", lprog: "pw-a", lenroll: "mandatory", status: "notdone", q: "Ana", sort: "name", page: 3 });
  assert.equal(Q.listParamsOf({ list: "overdue", lst: "done" }).status, undefined, "status tabs only for list=assigned");
  assert.equal(Q.listParamsOf({ list: "nope" }).metric, "assigned");
  assert.equal(Q.unitOf("covered"), "person");
  assert.equal(Q.unitOf("attempts"), "attempt");
  assert.equal(Q.unitOf("dueSoon"), "cell");
});

test("ovquery: fmtDelta direction, 'good' direction per metric, null delta", () => {
  assert.deepEqual({ ...Q.fmtDelta({ delta: 7 }, "rate", "coverage") }, { dir: "up", good: true, abs: "7.0" });
  assert.deepEqual({ ...Q.fmtDelta({ delta: -12 }, "count", "overduePeople") }, { dir: "down", good: true, abs: "12" }, "fewer overdue people is good");
  assert.deepEqual({ ...Q.fmtDelta({ delta: 3 }, "count", "overduePeople") }, { dir: "up", good: false, abs: "3" });
  assert.deepEqual({ ...Q.fmtDelta({ delta: -2.14 }, "rate", "requiredCompletion") }, { dir: "down", good: false, abs: "2.1" });
  assert.deepEqual({ ...Q.fmtDelta({ delta: 0 }, "hours", "hoursPerHead") }, { dir: "flat", good: null, abs: "0.0" });
  assert.deepEqual({ ...Q.fmtDelta({ delta: null }, "rate", "passRate") }, { dir: null, good: null, abs: null });
  assert.deepEqual({ ...Q.fmtDelta(undefined, "rate", "passRate") }, { dir: null, good: null, abs: null });
});

test("ovquery: bucketOf boundaries (0 <50, 1 50–69, 2 70–84, 3 85–94, 4 ≥95)", () => {
  const cases = [[0, 0], [49.9, 0], [50, 1], [69.9, 1], [70, 2], [84.9, 2], [85, 3], [94.9, 3], [95, 4], [100, 4], [null, null], [undefined, null]];
  for (const [v, b] of cases) assert.equal(Q.bucketOf(v), b, String(v));
  assert.equal(Q.searchReady("a"), false);
  assert.equal(Q.searchReady("ab"), true);
  assert.equal(Q.searchReady("合"), true, "one CJK character is enough");
  // 热力表默认按风险：逾期多 → 完成率低
  const rows = [{ deptId: "a", name: "A", completion: 90, assigned: 10 }, { deptId: "b", name: "B", completion: 40, assigned: 10 }, { deptId: "c", name: "C", completion: 95, assigned: 10 }];
  const od = { a: 0, b: 0, c: 5 };
  assert.deepEqual(Q.sortHeatRows(rows, "risk", (r) => od[r.deptId]).map((r) => r.deptId), ["c", "b", "a"]);
  assert.deepEqual(Q.sortHeatRows(rows, "name").map((r) => r.deptId), ["a", "b", "c"]);
});

test("KPI cards are whole-card buttons without an aria-label override; the delta glyph is hidden from screen readers", () => {
  const src = ov("KpiCards.jsx");
  assert.match(src, /<button type="button" key=\{c\.key\} className=\{'ovx-kpi ovx-kpi-' \+ c\.key\} onClick=\{\(\) => onOpen\(c\.metric, c\.o\)\}/);
  assert.doesNotMatch(src, /aria-label=/);
  assert.match(src, /<span aria-hidden>\{d\.dir === 'up' \? '▲ ' : '▼ '\}<\/span>/);
  assert.match(src, /key: 'requiredCompletion'[^\n]*metric: 'assigned', o: \{ lenroll: 'mandatory', lst: 'notdone' \}/);
});

test("list and person pages are pushed onto history; the Results page reads ?status=", () => {
  const src = read(SRC, "pages", "admin", "Overview.jsx");
  assert.match(src, /const openList = \(metric, o\) => patchUrl\(\{[\s\S]{0,140}list: metric, \.\.\.\(o \|\| \{\}\),\s*\}, \{ push: true \}\);/);
  assert.match(src, /const openPerson = \(userId\) => patchUrl\(\{ person: String\(userId\) \}, \{ push: true \}\);/);
  assert.match(src, /const closePerson = \(\) => patchUrl\(\{ person: null \}, \{ push: true \}\);/);
  assert.match(src, /api\.get\('\/api\/admin\/overview\?' \+ key\)/);
  assert.match(src, /const key = onDash \? 'v=2'/, "the dashboard asks for the v=2 payload");
  const list = ov("PeopleListPage.jsx");
  assert.match(list, /const back = \(\) => patchUrl\(Object\.fromEntries\(LIST_KEYS\.map\(\(k\) => \[k, null\]\)\), \{ push: true \}\);/);
  assert.match(list, /api\.get\('\/api\/admin\/overview\/people\?' \+ qs\)/);
  const res = read(SRC, "pages", "admin", "Results.jsx");
  assert.match(res, /const STATUS_KEYS = \['pass', 'fail', 'flagged', 'pending', 'appealing'\];/);
  assert.match(res, /const fStatus = STATUS_KEYS\.includes\(urlp\.status\) \? urlp\.status : '';/);
  assert.match(res, /const setFStatus = \(v\) => patchUrl\(\{ status: v \|\| null \}\);/);
  assert.doesNotMatch(res, /\[fStatus, setFStatus\] = useState/, "fStatus is no longer component state");
});

test("heat table: department names are row headers that never truncate (V3); cells carry an accessible name", () => {
  const src = ov("HeatTable.jsx");
  assert.match(src, /<th scope="row" className="ovx-heat-dept">/);
  assert.doesNotMatch(src, /ellip|nowrap/i);
  assert.match(src, /aria-label=\{label \+ tip\}/);
  assert.match(src, /data-b=\{b === null \? undefined : b\}/);
  // app.css（G6 追加后）里 .ovx-heat th 的规则不得省略号 / 不换行
  const css = read(SRC, "app.css") + "\n" + read(SRC, "admin.css");   // 简化 10/11：后台专用规则拆到 admin.css
  for (const m of css.matchAll(/([^{}]*\.ovx-heat[^{}]*\bth\b[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(m[2], /text-overflow\s*:\s*ellipsis/, m[1].trim());
    assert.doesNotMatch(m[2], /white-space\s*:\s*nowrap/, m[1].trim());
  }
});

test("needs-attention and development-program sections are plain sections; their items are top-level cards (no card in card)", () => {
  const att = ov("AttentionPanels.jsx");
  assert.match(att, /<section className="ovx-sec ovx-attn">/);
  const cards = [...att.matchAll(/className="card\b[^"]*"/g)].map((m) => m[0]);
  assert.equal(cards.length, 4);
  for (const c of cards) assert.equal(c, 'className="card ovx-panel"');
  const prj = ov("ProjectCards.jsx");
  assert.match(prj, /<section className="ovx-sec ovx-projects">/);
  assert.match(prj, /<div className="card ovx-prj" key=\{t\.id\}>/);
  assert.equal((prj.match(/className="card ovx-prj"/g) || []).length, 1);
  // 提醒只在可提醒人数 > 0 且有写权限时出现
  assert.match(att, /!low && canWrite && \(c\.remindablePeople \|\| 0\) > 0/);
  assert.match(att, /\.filter\(\(r\) => \(r\.n \|\| 0\) > 0\)/, "zero-count pending rows are hidden");
});

test("EN plurals: count-bearing entries read correctly for 1", () => {
  const src = ov("ovtext.js");
  const at = src.indexOf("export const T = {");
  let i = src.indexOf("{", at), depth = 0, end = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') { const q = c; i++; while (src[i] !== q) { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "`") { i++; let d2 = 0; while (i < src.length && !(src[i] === "`" && d2 === 0)) { if (src[i] === "\\") i++; else if (src[i] === "$" && src[i + 1] === "{") { d2++; i++; } else if (src[i] === "}" && d2) d2--; i++; } continue; }
    if (c === "{") depth++; else if (c === "}") { depth--; if (!depth) { end = i; break; } }
  }
  const T = vm.runInNewContext("(" + src.slice(src.indexOf("{", at), end + 1) + ")", {
    Number, String, Math, fmtN: Q.fmtN, fmt1: Q.fmt1, pl: (n, one, many) => (Number(n) === 1 ? one : many),
  });
  const keys = vm.runInNewContext(src.match(/export const PLURAL_KEYS = (\[[\s\S]*?\]);/)[1]);
  assert.ok(keys.length >= 15);
  for (const k of keys) {
    const fn = T.en[k];
    assert.equal(typeof fn, "function", k);
    const out = fn(...Array(fn.length).fill(1));
    assert.doesNotMatch(out, /\b1 (people|courses|learners|records|assignments|attempts|cohorts|days|departments|employees)\b/, k + ": " + out);
    assert.equal(typeof T.zh[k](...Array(fn.length).fill(1)), "string");
  }
  // 指派一律按「人次」计（不混用门次）
  assert.doesNotMatch(src, /门次/);
  assert.equal(T.en.title, "Learning Overview", "matches the console navigation label");
  assert.equal(T.zh.helpLines.length, T.en.helpLines.length);
});

test("phone filter modal and custom period: dpfModalProps, two single-date pickers (no dateRange panel)", () => {
  const src = ov("OverviewFilters.jsx");
  assert.match(src, /<Modal \{\.\.\.dpfModalProps\(\)\} className="u-modal-visible"/);
  assert.doesNotMatch(src, /type="dateRange"/);
  assert.equal((src.match(/<DatePicker type="date"/g) || []).length, 2);
  // 搜索选中课程会清掉把它筛掉的其他课程筛选
  assert.match(read(SRC, "pages", "admin", "Overview.jsx"), /patchUrl\(\{ programs: c\.id, cat: null, enroll: null, mode: null, tp: null \}\);/);
  // 搜索框：combobox + listbox
  const s = ov("OverviewSearch.jsx");
  assert.match(s, /role="combobox"/);
  assert.match(s, /role="listbox"/);
  assert.match(s, /aria-activedescendant=/);
});

test("QA D3（第三批）：390 宽「统计区间 … · 对比 …」换行显示，不横向截断", () => {
  const css = read(SRC, "app.css") + "\n" + read(SRC, "admin.css");   // 简化 10/11：后台专用规则拆到 admin.css
  assert.match(ov("OverviewFilters.jsx"), /<span className="ovx-range-t">\{rangeLine\}<\/span>/);
  assert.equal(cssLast(css, ".ovx-range", "flex-wrap", 390), "wrap");
  assert.notEqual(cssLast(css, ".ovx-range", "white-space", 390), "nowrap");
  assert.notEqual(cssLast(css, ".ovx-range", "overflow-x", 390), "auto");
  assert.equal(cssLast(css, ".ovx-range-t", "white-space", 390), "normal");
  assert.equal(cssLast(css, ".ovx-range", "flex-wrap", 1440), "wrap", "desktop unchanged");
});
