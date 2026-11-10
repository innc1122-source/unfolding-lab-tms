// 12.2 工作台前端（b12-design §7、§8 组 3；2026-10-09）。
//   web/src/workbench.js 纯函数：四种 grants 的视角与三层顺序、隐藏块、模块开关、差值文字中英与语义方向、待办排序、
//   健康度单元格状态（落后 / 样本少）、3+3 部门合并（按 id，对不上按名称）、名单地址（只放行站内后台路径）。
//   pages/admin/workbench/* 源码：只调新接口、不调 /api/admin/dashboard、无部门人数条形图、名单是整页（负责人规则：不用抽屉）、
//   无 emoji、F47 胶囊写法。
// WB_WEB 可指向另一份 web/src（对照改前 / 改后副本）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const WEB = process.env.WB_WEB || path.join(__dirname, "..", "web", "src");
const WB_DIR = path.join(WEB, "pages", "admin", "workbench");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const lib = () => import(pathToFileURL(path.join(WEB, "workbench.js")).href);
const wbFiles = () => fs.readdirSync(WB_DIR).filter((f) => /\.jsx?$/.test(f));

// 内置角色的 /api/me 形状（store.js SEED_ROLES）；grants 缺的域按 none
const ALL = ["people", "learning", "performance", "talent", "culture", "fields", "brand", "audit", "accounts"];
const grants = (o) => Object.fromEntries(ALL.map((d) => [d, o[d] || "none"]));
const SUPER = { isSuperAdmin: true, grants: grants({}), modules: { culture: true } };
const ADMIN = { isSuperAdmin: false, grants: grants(Object.fromEntries(ALL.map((d) => [d, "manage"]))), modules: { culture: true } };
const PERF_TALENT = { isSuperAdmin: false, grants: grants({ performance: "manage", talent: "manage", people: "read" }), modules: { culture: true } };
const LEARNING = { isSuperAdmin: false, grants: grants({ learning: "manage" }), modules: { culture: true } };
const AUDITOR = { isSuperAdmin: false, grants: grants({ audit: "read" }), modules: {} };

/* ---------------- 视角与可见块 ---------------- */

test("workbenchLayout：超级管理员与管理员 = 管理员视角，三层顺序 需要处理 → 组织风险 → 人才结构，块全可见", async () => {
  const { workbenchLayout } = await lib();
  for (const u of [SUPER, ADMIN]) {
    const l = workbenchLayout(u);
    assert.equal(l.view, "admin");
    assert.deepEqual(l.order, ["todo", "risk", "structure"]);
    for (const k of ["succession", "retention", "compliance", "reviewOnTime", "probation", "span", "nineBox", "perfQuota", "pipeline", "deptHealth", "culture", "todo"]) assert.equal(l.blocks[k], true, k);
  }
  // 老服务（/api/me 无 grants）= 超级管理员
  assert.equal(workbenchLayout({ role: "admin" }).view, "admin");
});

test("workbenchLayout：绩效与人才管理员 = 人才结构在组织风险之前，培训类块隐藏", async () => {
  const { workbenchLayout, todoVisible } = await lib();
  const l = workbenchLayout(PERF_TALENT);
  assert.equal(l.view, "talent");
  assert.deepEqual(l.order, ["todo", "structure", "risk"]);
  assert.equal(l.blocks.compliance, false, "必修合规不显示");
  assert.equal(l.blocks.succession, true);
  assert.equal(l.blocks.reviewOnTime, true);
  assert.equal(l.blocks.deptHealth, true, "people 可读 → 部门健康度表");
  assert.equal(l.blocks.probation, true);
  assert.equal(l.blocks.culture, false, "culture 不可读");
  assert.equal(todoVisible({ key: "trainingOverdue", domain: "learning" }, l), false, "培训待办隐藏");
  assert.equal(todoVisible({ key: "reviewSelfOverdue", domain: "performance" }, l), true);
});

test("workbenchLayout：培训管理员 = 只有 需要处理 → 组织风险，人才结构层与绩效 / 人才指标隐藏", async () => {
  const { workbenchLayout, todoVisible } = await lib();
  const l = workbenchLayout(LEARNING);
  assert.equal(l.view, "learning");
  assert.deepEqual(l.order, ["todo", "risk"]);
  assert.equal(l.blocks.compliance, true);
  for (const k of ["succession", "retention", "reviewOnTime", "nineBox", "perfQuota", "pipeline", "deptHealth", "probation", "span"]) assert.equal(l.blocks[k], false, k);
  assert.equal(todoVisible({ key: "reviewSelfOverdue", domain: "performance" }, l), false);
  assert.equal(todoVisible({ key: "trainingOverdue", domain: "learning" }, l), true);
});

test("workbenchLayout：没有任何业务域可读的角色三层都不显示（页面给空态）；自定义角色按块逐个判", async () => {
  const { workbenchLayout } = await lib();
  const a = workbenchLayout(AUDITOR);
  assert.equal(a.view, "custom");
  assert.deepEqual(a.order, []);
  const custom = workbenchLayout({ isSuperAdmin: false, grants: grants({ people: "read", culture: "read" }), modules: { culture: true } });
  assert.equal(custom.view, "custom");
  assert.deepEqual(custom.order, ["todo", "risk", "structure"]);
  assert.equal(custom.blocks.span, true);
  assert.equal(custom.blocks.succession, false);
  assert.equal(custom.blocks.culture, true);
});

test("workbenchLayout：模块开关与能力域两道闸；culture 模块缺省关闭，只认显式 true", async () => {
  const { workbenchLayout } = await lib();
  const off = workbenchLayout({ ...SUPER, modules: { talent: false, culture: true } });
  assert.equal(off.blocks.succession, false);
  assert.equal(off.blocks.nineBox, false);
  assert.equal(off.blocks.compliance, true);
  assert.equal(workbenchLayout({ ...SUPER, modules: {} }).blocks.culture, false, "culture 缺省关闭");
  const onlyTalent = workbenchLayout({ ...SUPER, modules: { performance: false, learning: false, culture: false } });
  assert.equal(onlyTalent.blocks.reviewOnTime, false);
  assert.equal(onlyTalent.blocks.compliance, false);
  assert.deepEqual(onlyTalent.order, ["todo", "risk", "structure"]);
});

/* ---------------- 差值文字 ---------------- */

test("deltaText：比率给百分点、计数给人数；语义方向按 better；上期无数据不显示 0", async () => {
  const { deltaText } = await lib();
  const up = { key: "succession", unit: "pct", value: 62.5, prev: 58.8, delta: 3.7, better: "up" };
  assert.deepEqual(deltaText(up, "zh"), { text: "较上季度 +3.7 个百分点", tone: "better", dir: "up" });
  assert.deepEqual(deltaText(up, "en"), { text: "+3.7 pp vs last quarter", tone: "better", dir: "up" });
  const span = { key: "span", unit: "count", value: 9, prev: 7, better: "down" };
  assert.deepEqual(deltaText(span, "zh"), { text: "较上季度 +2 人", tone: "worse", dir: "up" });
  assert.equal(deltaText({ ...span, value: 5 }, "en").text, "−2 vs last quarter");
  assert.equal(deltaText({ ...span, value: 5 }, "en").tone, "better");
  assert.deepEqual(deltaText({ ...span, prev: 9 }, "zh"), { text: "与上季度持平", tone: "flat", dir: "flat" });
  assert.deepEqual(deltaText({ ...span, prev: null }, "zh"), { text: "上期暂无数据", tone: "none", dir: null });
  assert.equal(deltaText({ ...span, prev: null, snapshotSince: "2026-10" }, "zh").text, "上期暂无数据（自 2026-10 起留存）");
  assert.equal(deltaText({ ...span, prev: null }, "en").text, "No prior-period data");
  // 评估按时率按评估周期比较
  assert.equal(deltaText({ key: "reviewOnTime", unit: "pct", value: 80, prev: 85, better: "up" }, "zh").text, "较上一周期 −5.0 个百分点");
  assert.equal(deltaText({ key: "reviewOnTime", unit: "pct", value: 80, prev: 85, better: "up" }, "en").tone, "worse");
});

test("metricKind：服务端指标键的几种写法归到六类", async () => {
  const { metricKind } = await lib();
  assert.equal(metricKind("succession"), "succession");
  assert.equal(metricKind("successionCoverage"), "succession");
  assert.equal(metricKind("hipoRetention"), "retention");
  assert.equal(metricKind("requiredCompliance"), "compliance");
  assert.equal(metricKind("reviewOnTime"), "reviewOnTime");
  assert.equal(metricKind("probationPass"), "probation");
  assert.equal(metricKind("spanOfControl"), "span");
  assert.equal(metricKind("bogus"), null);
});

/* ---------------- 待办排序 ---------------- */

test("severityOrder：已逾期 → 即将到期 → 一般；同级按截止日（无截止日在后），再按数量", async () => {
  const { severityOrder } = await lib();
  const got = severityOrder([
    { key: "a", severity: "normal", count: 9 },
    { key: "b", severity: "soon", dueOn: "2026-10-20", count: 1 },
    { key: "c", severity: "overdue", dueOn: "2026-10-05", count: 1 },
    { key: "d", severity: "soon", dueOn: "2026-10-12", count: 1 },
    { key: "e", severity: "normal", count: 30 },
    { key: "f", severity: "soon", count: 50 },
  ]).map((x) => x.key);
  assert.deepEqual(got, ["c", "d", "b", "f", "e", "a"]);
});

/* ---------------- 部门健康度 ---------------- */

test("healthCellState：低于合计 10 个百分点及以上为落后；在职少于 5 人为样本少；只展示的列不标落后", async () => {
  const { healthCellState } = await lib();
  const total = { value: 80 };
  assert.equal(healthCellState({ value: 70, headcount: 20 }, total), "lag", "恰好 10 个百分点");
  assert.equal(healthCellState({ value: 70.1, headcount: 20 }, total), "ok");
  assert.equal(healthCellState({ value: 10, headcount: 4 }, total), "small");
  assert.equal(healthCellState({ value: null, headcount: 20 }, total), "empty");
  assert.equal(healthCellState({ value: 10, headcount: 20 }, total, { mark: false }), "ok");
  assert.equal(healthCellState({ value: 60, headcount: 20 }, total, { lagPp: 25 }), "ok", "阈值可配置");
});

test("部门健康度：缺省按落后项数降序再按人数；单元格读数字或 { value } 两种形状", async () => {
  const { sortHealthRows, lagCount, cellOf } = await lib();
  const cols = ["headcount", "probation", "compliance", "reviewOnTime"];
  const total = { cells: { headcount: 100, compliance: { value: 80 }, reviewOnTime: { value: 90 } } };
  const rows = [
    { deptId: "a", deptName: "A", cells: { headcount: 40, probation: { value: 1 }, compliance: { value: 85 }, reviewOnTime: { value: 95 } } },
    { deptId: "b", deptName: "B", cells: { headcount: 10, probation: { value: 50 }, compliance: { value: 60 }, reviewOnTime: { value: 70 } } },
    { deptId: "c", deptName: "C", cells: { headcount: 30, compliance: { value: 65 }, reviewOnTime: { value: 92 } } },
    { deptId: "d", deptName: "D", cells: { headcount: 3, compliance: { value: 0 }, reviewOnTime: { value: 0 } } },
  ];
  assert.equal(lagCount(rows[1], cols, total), 2);
  assert.equal(lagCount(rows[0], cols, total), 0, "试用期占比只展示不标落后");
  assert.equal(lagCount(rows[3], cols, total), 0, "样本少不标落后");
  assert.deepEqual(sortHealthRows(rows, cols, total).map((r) => r.deptId), ["b", "c", "a", "d"]);
  assert.deepEqual(sortHealthRows(rows, cols, total, null, "compliance", "asc").map((r) => r.deptId), ["d", "b", "c", "a"]);
  assert.deepEqual(cellOf({ headcount: 7 }, "headcount"), { value: 7 });
  assert.deepEqual(cellOf({ cells: { x: { value: 5, num: 1, den: 20 } } }, "x"), { value: 5, num: 1, den: 20 });
});

test("mergeCultureDepts：3+3 参与人数按一级部门 id 合并，id 对不上按名称；合不上为 null", async () => {
  const { mergeCultureDepts, cultureTotal } = await lib();
  const rows = [{ deptId: "d1", deptName: "Sales" }, { deptId: "x9", deptName: " Customer  Care " }, { deptId: "d3", deptName: "Finance" }];
  const cd = [
    { id: "d1", name: "Sales Dept", memberCount: 40, participantCount: 30 },
    { id: "d2", name: "customer care", memberCount: 8, participantCount: 2 },
  ];
  const got = mergeCultureDepts(rows, cd).map((r) => r.cells.culture);
  assert.deepEqual(got[0], { value: 75, num: 30, den: 40 });
  assert.deepEqual(got[1], { value: 25, num: 2, den: 8 }, "名称回退（空白与大小写归一）");
  assert.equal(got[2], null);
  assert.deepEqual(cultureTotal(cd), { value: 66.7, num: 32, den: 48 });
});

/* ---------------- 3+3、九宫格、配额 ---------------- */

test("cultureWeek / rankCultureDepts：当前周；只列参与人数 ≥ 5 的一级部门并按覆盖率排名", async () => {
  const { cultureWeek, rankCultureDepts } = await lib();
  const p = { startDate: "2026-09-28", weeks: 6 };
  assert.equal(cultureWeek(p, "2026-09-27"), null);
  assert.equal(cultureWeek(p, "2026-09-28"), 1);
  assert.equal(cultureWeek(p, "2026-10-09"), 2);
  assert.equal(cultureWeek(p, "2026-12-31"), 6);
  const r = rankCultureDepts([{ dept1: "A", headcount: 4, rate: 1 }, { dept1: "B", headcount: 10, rate: 0.5 }, { dept1: "C", headcount: 5, rate: 0.9 }]);
  assert.deepEqual(r.map((x) => x.dept1), ["C", "B"]);
});

test("nineBoxCount / quotaOverage：九宫格两种格子形状；配额偏离取 A+ / A / B+ 中超配最多的一档，小部门不标", async () => {
  const { nineBoxCount, quotaOverage } = await lib();
  const arr = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  assert.equal(nineBoxCount(arr, 2, 0), 7);
  assert.equal(nineBoxCount({ "2-0": 7 }, 2, 0), 7);
  assert.equal(nineBoxCount(null, 1, 1), 0);
  const bands = { "A+": { actual: 3, quota: 2 }, A: { actual: 12.5, quota: 8 }, "B+": { actual: 10, quota: 15 } };
  assert.deepEqual(quotaOverage({ bands }), { band: "A", pp: 4.5 });
  assert.equal(quotaOverage({ bands, small: true }), null);
  assert.equal(quotaOverage({ bands: { A: { actual: 8, quota: 8 } } }), null);
});

/* ---------------- 名单 ---------------- */

test("名单地址：/admin?list=… 整页；查询串与名单接口一致；「去处理」只放行站内后台路径", async () => {
  const { drillHref, drillQuery, drillFromSearch, safeAdminLink } = await lib();
  assert.equal(drillQuery("span"), "metric=span");
  assert.equal(drillQuery({ metric: "dept.compliance", dept: "d 1", cell: "" }), "metric=dept.compliance&dept=d%201");
  assert.equal(drillHref({ metric: "nineBox", cell: "2-1" }, "/admin/talent-review"), "/admin?list=nineBox&cell=2-1&to=%2Fadmin%2Ftalent-review");
  assert.equal(drillHref("span", "https://evil.example"), "/admin?list=span");
  assert.equal(drillHref(null), null);
  assert.deepEqual(drillFromSearch("?list=dept.hipo&dept=d1&period=prev"), { metric: "dept.hipo", dept: "d1", period: "prev" });
  assert.equal(drillFromSearch("?foo=1"), null);
  for (const bad of ["//evil.example/admin", "https://x/admin", "/culture/#/hr", "javascript:alert(1)", "/administrator"]) assert.equal(safeAdminLink(bad), null, bad);
  for (const ok of ["/admin", "/admin/reviews?cycle=c1", "/admin?x=1"]) assert.equal(safeAdminLink(ok), ok);
});

/* ---------------- 源码 ---------------- */

test("工作台源码：只调用新接口（todo / risk / structure / people），不调用 /api/admin/dashboard，不再有部门人数条形图", () => {
  const all = wbFiles().map((f) => read("pages", "admin", "workbench", f)).join("\n");
  const page = read("pages", "admin", "workbench", "WorkbenchPage.jsx");
  for (const ep of ["/api/admin/workbench/todo", "/api/admin/workbench/risk", "/api/admin/workbench/structure"]) assert.ok(page.includes(ep), ep);
  assert.ok(read("pages", "admin", "workbench", "PeopleList.jsx").includes("/api/admin/workbench/people?"));
  const code = all.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!code.includes("/api/admin/dashboard"), "不调用旧接口（注释除外）");
  assert.ok(!/dash-bar/.test(all), "不再渲染 dash-bar 条形图");
  assert.ok(!/dash-kpi/.test(all), "页头不再放 KPI");
  for (const f of ["TodoLayer.jsx", "RiskLayer.jsx", "StructureLayer.jsx", "DeptHealthTable.jsx", "CulturePanel.jsx", "PeopleList.jsx", "WorkbenchPage.jsx"]) assert.ok(wbFiles().includes(f), f);
});

test("名单是整页（负责人规则：不用抽屉）：工作台不引入 SideSheet / Drawer，?list= 时整页渲染名单", () => {
  const all = wbFiles().map((f) => read("pages", "admin", "workbench", f)).join("\n");
  assert.ok(!/SideSheet|Drawer/.test(all.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "no drawer component");
  const page = read("pages", "admin", "workbench", "WorkbenchPage.jsx");
  assert.match(page, /const drill = drillFromSearch\(sp\);\n\s*if \(drill\) return <div className="wrap dash-wrap wb-wrap"><PeopleList drill=\{drill\} to=\{sp\.get\('to'\)\} \/><\/div>;/);
  const list = read("pages", "admin", "workbench", "PeopleList.jsx");
  assert.match(list, /onClick=\{\(\) => navigate\('\/admin'\)\}><IcBack \/>\{s\.back\}/, "返回工作台");
  assert.match(list, /\{phone \? \(\n\s*<ul className="wb-lcards">/, "< 768 改卡片");
});

test("F47 / F48：层标题与卡片标题的胶囊在文字右侧同一行；工作台源码（含注释）无 emoji", () => {
  const shared = read("pages", "admin", "workbench", "shared.jsx");
  assert.match(shared, /<h2 className="wb-layer-title" id=\{bodyId \+ '-h'\}>\{icon\}<span className="wb-layer-name">\{title\}<\/span>\n\s*\{count !== undefined && count !== null && <span className="pill pri wb-count tnum">/);
  const PICTO = /[\p{Extended_Pictographic}\u{FE0F}]/u;
  const ALLOW = new Set(["©", "®", "™", "↔", "↕"]);
  for (const f of [...wbFiles().map((x) => path.join("pages", "admin", "workbench", x)), "workbench.js"]) {
    const bad = [...read(f)].filter((ch) => PICTO.test(ch) && !ALLOW.has(ch));
    assert.deepEqual(bad, [], f);
  }
});

test("3+3 块只读 3+3 现有接口（不改 modules/culture），接口失败只留后台链接", () => {
  const src = read("pages", "admin", "workbench", "CulturePanel.jsx");
  for (const ep of ["/api/v1/culture/programs", "/api/v1/culture/meetings?", "/api/v1/culture/cards?", "/api/v1/culture/depts?"]) assert.ok(src.includes(ep), ep);
  assert.match(src, /if \(c\.error\) return <div className="wb-card wb-culture">\{head\}<div className="wb-card-foot">\{open\}<\/div><\/div>;/);
});


/* ---------------- 切换之后（Dashboard.jsx 改为三层工作台、W3.css 已追加进 v2.css） ---------------- */

const CSS = () => read("app.css") + "\n" + read("v2.css") + "\n" + read("admin.css");   // 简化 10/11：后台专用规则拆到 admin.css
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

test("Dashboard.jsx 改为三层工作台：渲染 WorkbenchPage，不再调用 /api/admin/dashboard、不再有 hero KPI 与部门人数条形图", () => {
  const dash = read("pages", "admin", "Dashboard.jsx");
  const code = dash.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /import WorkbenchPage from '\.\/workbench\/WorkbenchPage\.jsx';/);
  assert.match(code, /return <WorkbenchPage \/>;/);
  assert.ok(!code.includes("/api/admin/dashboard"), "不调用旧接口");
  assert.ok(!/dash-bar|dash-kpi|recentHires|byDept/.test(code), "旧卡片整体移除");
});

test("工作台版式：宽度规则 A 撑满；组织风险卡 ≥1200 三列、768–1199 两列、<768 一列；390 宽待办按钮换到下一行；胶囊统一（F46）", () => {
  const css = CSS();
  const at = (sel, prop, w) => cssLast(css, sel, prop, w);
  assert.equal(at(".v2-page-dashboard .dash-wrap", "max-width", 1920), "none");
  assert.equal(at(".wb-risk-grid", "grid-template-columns", 1440), "repeat(3,minmax(0,1fr))");
  assert.equal(at(".wb-risk-grid", "grid-template-columns", 1000), "repeat(2,minmax(0,1fr))");
  assert.equal(at(".wb-risk-grid", "grid-template-columns", 390), "minmax(0,1fr)");
  assert.equal(at(".wb-structure-grid.n3", "grid-template-columns", 1440), "repeat(3,minmax(0,1fr))");
  assert.equal(at(".wb-structure-grid", "grid-template-columns", 1000), "minmax(0,1fr)");
  assert.equal(String(at(".wb-todo-row", "grid-template-areas", 390)).replace(/\s+/g, " "), "'main side' 'act act'");
  assert.equal(String(at(".wb-todo-row", "grid-template-areas", 1440)).replace(/\s+/g, " "), "'main side act'");
  assert.equal(at(".wb-todo-row", "align-items", 1440), "center");
  assert.equal(at(".wb-todo-act", "background", 1440), "transparent", "按钮区不另设底色");
  for (const [p, v] of [["height", "24px"], ["padding", "0 9px"], ["font-size", "11.5px"], ["line-height", "1"], ["border-radius", "6px"]]) assert.equal(at(".wb-wrap .pill", p, 1440), v, p);
  const i = css.indexOf("/* ===== F58–F61 W3（2026-10-09）===== */");
  assert.ok(i > 0, "W3 fragment appended");
  assert.doesNotMatch(css.slice(i, css.indexOf("/* =====", i + 10) > 0 ? css.indexOf("/* =====", i + 10) : undefined), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "tokens only");
});
