// 第二批 W2-C（2026-10-08）后台评估页：周期列表筛选（2.3-B）、看板筛选 / 「部门 × 评级」下钻 / 按直属上级看分布（2.3-C）、
// 地址栏参数（2.3-D）、部门确认「已确认 · 时间 · 确认人」（O1）、工作台周期直达。
// 不起服务器、不碰数据库：deptcal.js 去掉 import / export 后用 vm 跑；ReviewCycles.jsx 里的模块级纯函数按源码取出来实跑；
// 页面接线做源码断言。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "web", "src");
const RVC = fs.readFileSync(path.join(SRC, "pages", "admin", "ReviewCycles.jsx"), "utf8").replace(/\r\n/g, "\n");
// 12.2 工作台改版（2026-10-09）：周期行搬到了组织风险层「评估按时完成率」卡（workbench/RiskLayer.jsx 的 CycleRow），代码不变
const DASH = fs.readFileSync(path.join(SRC, "pages", "admin", "workbench", "RiskLayer.jsx"), "utf8").replace(/\r\n/g, "\n");
// 跨 realm 的对象不能直接 deepStrictEqual（原型不同）：先 JSON 往返
const J = (x) => JSON.parse(JSON.stringify(x));

// deptcal.js：与 test/deptcal-ui.test.js 同一种加载方式
function loadDeptcal() {
  let src = fs.readFileSync(path.join(SRC, "deptcal.js"), "utf8");
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]);
  src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "").replace(/^export\s+/gm, "");
  const ctx = vm.createContext({ console });
  vm.runInContext(src + "\n;globalThis.__x = {" + names.join(",") + "};", ctx, { filename: "deptcal.js" });
  // deptcal.stageOf 用 instanceof Map 认部门表：测试里的 Map 要用它那个 realm 的
  ctx.__x.__Map = vm.runInContext("Map", ctx);
  return ctx.__x;
}
const dc = loadDeptcal();

// ReviewCycles.jsx 的看板 / 列表纯函数：取「周期列表筛选」到「评级的显示名」之间的源码，再加 localStamp / confirmerOf
function slice(from, to) {
  const a = RVC.indexOf(from), b = RVC.indexOf(to, a);
  assert.ok(a > 0 && b > a, "ReviewCycles.jsx has " + from);
  return RVC.slice(a, b);
}
const ctx = vm.createContext({ dc, console });
vm.runInContext(slice("const RVC_KINDS = ", "// 评级的显示名") + "\n" + slice("const localStamp = ", "\n/* ---- CSV export ----"), ctx, { filename: "ReviewCycles.jsx" });
const fn = (name) => vm.runInContext(name, ctx);
const call = (name, ...args) => J(fn(name)(...args));

// ---------- 2.3-B：周期列表筛选 ----------
test("2.3-B: list filter by kind / status / year (local year of createdAt); unknown values are ignored", () => {
  const list = [
    { id: "q1", flow: "v2", kind: "quarter", status: "open", createdAt: "2026-03-01T02:00:00.000Z" },
    { id: "a1", flow: "v2", kind: "annual", status: "closed", createdAt: "2025-12-01T02:00:00.000Z" },
    { id: "l1", flow: null, kind: null, status: "closed", createdAt: "2025-06-01T02:00:00.000Z" },
  ];
  const ids = (q) => call("rvcFilterCycles", list, q).map((c) => c.id);
  assert.deepEqual(ids({}), ["q1", "a1", "l1"]);
  assert.deepEqual(ids({ kind: "quarter" }), ["q1"]);
  assert.deepEqual(ids({ kind: "annual" }), ["a1"]);
  assert.deepEqual(ids({ kind: "legacy" }), ["l1"]);
  assert.deepEqual(ids({ status: "closed" }), ["a1", "l1"]);
  assert.deepEqual(ids({ year: "2025" }), ["a1", "l1"]);
  assert.deepEqual(ids({ kind: "legacy", status: "open" }), []);
  assert.deepEqual(ids({ kind: "bogus", status: "x", year: "20x5" }), ["q1", "a1", "l1"], "unknown values = not set");
  assert.deepEqual(call("rvcYears", list), ["2026", "2025"], "years: distinct, newest first");
  // 年份按本地日历：本地 1 月 1 日早上的周期（UTC 仍是上一年）算新的一年
  const local = new Date(2027, 0, 1, 0, 30).toISOString();
  assert.equal(fn("rvcYearOf")({ createdAt: local }), "2027");
});

// ---------- 2.3-C：阶段、职级、看板筛选 ----------
const DEPTS = [
  { dept1Id: "d1", dept1: "Ops", hod: { id: "h1", name: "H1" }, status: null, allowed: { "A+": 0, A: 1, "B+": 1 }, counts: {} },
  { dept1Id: "d2", dept1: "Fin", hod: { id: "h2", name: "H2" }, status: { hodSubmittedAt: "2026-10-01T01:00:00Z" }, allowed: { "A+": 0, A: 0, "B+": 1 } },
  { dept1Id: "d3", dept1: "IT", hod: null, hodOwned: false, status: { hrConfirmedAt: "2026-10-02T01:00:00Z" }, allowed: null },
];
const OPTS = [
  { id: "d1", name: "Ops", parentId: null, path: "Ops", level: 1 },
  { id: "o2a", name: "Ops North", parentId: "d1", path: "Ops › Ops North", level: 2 },
  { id: "o3a", name: "Desk A", parentId: "o2a", path: "Ops › Ops North › Desk A", level: 3 },
  { id: "o4a", name: "Pod 1", parentId: "o3a", path: "Ops › Ops North › Desk A › Pod 1", level: 4 },
  { id: "o2b", name: "Ops South", parentId: "d1", path: "Ops › Ops South", level: 2 },
  { id: "d2", name: "Fin", parentId: null, path: "Fin", level: 1 },
  { id: "d3", name: "IT", parentId: null, path: "IT", level: 1 },
];
const it = (id, extra = {}) => ({
  id, userId: "u" + id, name: "N" + id, employeeId: "E" + id, dept1Id: "d1", deptPath: ["d1"], department: "Ops",
  managerId: "m1", manager: "Mgr One", managerStatus: "active", jobLevel: "P3", jobGrade: 3,
  selfAt: "2026-10-01T01:00:00Z", oneOnOneAt: null, employeeOneOnOneAt: null, managerRating: null, finalRating: null,
  hodProxy: null, notCounted: null, ...extra,
});

test("2.3-C: stageOf (deptcal) per item; annual items are never 'awaiting self-review'", () => {
  const m = new dc.__Map(DEPTS.map((x) => [x.dept1Id, x]));
  assert.equal(dc.stageOf(it("1", { selfAt: null }), m, "quarter"), "self");
  assert.equal(dc.stageOf(it("1"), m, "quarter"), "one");
  assert.equal(dc.stageOf(it("1", { oneOnOneAt: "a", employeeOneOnOneAt: "b" }), m, "quarter"), "rate");
  assert.equal(dc.stageOf(it("1", { managerRating: "B" }), m, "quarter"), "hod");
  assert.equal(dc.stageOf(it("1", { dept1Id: "d2" }), m, "quarter"), "hr");
  assert.equal(dc.stageOf(it("1", { dept1Id: "d3", finalRating: "A" }), m, "quarter"), "confirmed");
  assert.equal(dc.stageOf(it("1", { dept1Id: "d3" }), m, "quarter"), "norating");
  // 年度：没有自评这一步，rvcStageOf 不让它落在 self
  assert.equal(fn("rvcStageOf")(it("1", { selfAt: null }), m, "annual"), "hod");
  assert.equal(fn("rvcStageOf")(it("1", { selfAt: null, dept1Id: "d2" }), m, "annual"), "hr");
  assert.deepEqual(J(fn("rvcStagesOf")("annual")), ["hod", "hr", "confirmed", "norating"]);
  assert.deepEqual(J(fn("rvcStagesOf")("quarter")), ["self", "one", "rate", "hod", "hr", "confirmed", "norating"]);
});

test("2.3-C: matchLevel — g:<grade>, r:<level>, none, nogrid (same format as the calibration filter)", () => {
  assert.equal(dc.matchLevel({ jobLevel: "P3", jobGrade: 3 }, "g:3"), true);
  assert.equal(dc.matchLevel({ jobLevel: "P3", jobGrade: 3 }, "g:4"), false);
  assert.equal(dc.matchLevel({ jobLevel: "p3" }, "r:P3"), true, "level match ignores case");
  assert.equal(dc.matchLevel({ jobLevel: "" }, "none"), true);
  assert.equal(dc.matchLevel({ jobLevel: "X9", jobGrade: null }, "nogrid"), true);
  assert.equal(dc.matchLevel({ jobLevel: "P3", jobGrade: 3 }, "nogrid"), false);
  assert.equal(dc.matchLevel({ jobLevel: "P3" }, ""), true);
});

test("2.3-C: board filter — department includes sub-departments, manager '__none', job level, stage", () => {
  const m = new dc.__Map(DEPTS.map((x) => [x.dept1Id, x]));
  const items = [
    it("1", { deptPath: ["d1", "o2a", "o3a", "o4a"] }),
    it("2", { deptPath: ["d1", "o2b"], managerId: null, manager: null }),
    it("3", { dept1Id: "d2", deptPath: ["d2"], jobLevel: "", jobGrade: null }),
  ];
  const ids = (q) => call("rvcBoardFilter", items, q, m, "quarter").map((i) => i.id);
  assert.deepEqual(ids({ dept: "d1" }), ["1", "2"]);
  assert.deepEqual(ids({ dept: "o2a" }), ["1"], "a level-4 person is inside the level-2 filter");
  assert.deepEqual(ids({ mgr: "__none" }), ["2"]);
  assert.deepEqual(ids({ mgr: "m1" }), ["1", "3"]);
  assert.deepEqual(ids({ lv: "none" }), ["3"]);
  assert.deepEqual(ids({ stage: "hr" }), ["3"]);
  assert.deepEqual(ids({ stage: "one", dept: "d1" }), ["1", "2"]);
  // 看板的部门选项只到三级；范围裁剪后父级不在选项里的更深部门保留为根
  assert.deepEqual(call("rvcBoardDeptOptions", OPTS).map((o) => o.id), ["d1", "o2a", "o3a", "o2b", "d2", "d3"]);
  assert.deepEqual(call("rvcBoardDeptOptions", [{ id: "x4", name: "Pod", parentId: "gone", level: 4 }, { id: "x5", name: "Sub", parentId: "x4", level: 5 }]).map((o) => o.id), ["x4"]);
});

test("2.3-C: department × rating rows — level-1 rows with quota only when unfiltered; a selected department lists its children by parentId", () => {
  const d = { depts: DEPTS, deptOptions: OPTS };
  const items = [
    it("1", { deptPath: ["d1", "o2a", "o3a"], managerRating: "A" }),
    it("2", { deptPath: ["d1", "o2a"], managerRating: "A", finalRating: "B+" }),
    it("3", { deptPath: ["d1", "o2b"], managerRating: "C" }),
    it("4", { deptPath: ["d1"], managerRating: "B" }),
    it("5", { deptPath: ["d1"], managerRating: "A", notCounted: "departed" }),
    it("6", { dept1Id: "d2", deptPath: ["d2"], managerRating: "A" }),
  ];
  let rows = call("rvcMatrixRows", items, {}, d, false);
  assert.deepEqual(rows.map((r) => [r.label, r.items.length]), [["Ops", 4], ["Fin", 1], ["IT", 0]], "every level-1 department, departed not counted");
  assert.deepEqual(rows[0].counts, { A: 1, "B+": 1, "C/D": 1, B: 1 });
  assert.deepEqual(rows[0].allowed, DEPTS[0].allowed);
  assert.deepEqual(J(fn("rvcOverTiers")(fn("rvcMatrixRows")(items, {}, d, false)[1])), ["A"], "Fin: 1 A over 0 places");
  // 有直属上级 / 职级 / 阶段筛选：不显示名额，只列筛到人的部门
  rows = call("rvcMatrixRows", items, { mgr: "m1", stage: "hod" }, d, false);
  assert.ok(rows.every((r) => r.allowed === null));
  assert.equal(fn("rvcQuotaMode")({ mgr: "m1" }, DEPTS), false);
  assert.equal(fn("rvcQuotaMode")({ dept: "d1" }, DEPTS), true, "a level-1 department alone keeps the quota");
  assert.equal(fn("rvcQuotaMode")({ dept: "o2a" }, DEPTS), false);
  // 选了一级部门：合计一行（带名额）+ 下一级部门（按 parentId）+ 本部门直属
  const sel = items.filter((i) => i.deptPath.includes("d1"));
  rows = call("rvcMatrixRows", sel, { dept: "d1" }, d, false);
  assert.deepEqual(rows.map((r) => [r.key, r.items.length, !!r.sub]), [["all:d1", 4, false], ["o2a", 2, true], ["o2b", 1, true], ["direct:d1", 1, true]]);
  assert.deepEqual(rows[0].allowed, DEPTS[0].allowed);
  assert.equal(rows[1].allowed, null);
  // 选了二级部门：没有名额；三级子部门按 parentId 找（四级并入三级，不单独成行）
  rows = call("rvcMatrixRows", sel.filter((i) => i.deptPath.includes("o2a")), { dept: "o2a" }, d, false);
  assert.deepEqual(rows.map((r) => [r.key, r.items.length]), [["all:o2a", 2], ["o3a", 1], ["direct:o2a", 1]]);
  assert.equal(rows[0].allowed, null);
  // 范围裁剪后 deptPath 不含一级部门：仍按 id 找下一级，不按下标
  rows = call("rvcMatrixRows", [it("9", { deptPath: ["o2a", "o3a"] })], { dept: "o2a" }, d, false);
  assert.deepEqual(rows.map((r) => r.key), ["all:o2a", "o3a"]);
});

test("2.6 on the board: a closed cycle counts the rating on file (recordRating); open cycles use the effective rating", () => {
  const r = fn("rvcRatingOf");
  assert.equal(r({ managerRating: "B", finalRating: "A", recordRating: "C" }, true), "C");
  assert.equal(r({ managerRating: "B", finalRating: "A", recordRating: null }, true), null, "record removed → no rating");
  assert.equal(r({ managerRating: "B", finalRating: "A" }, true), "A", "no recordRating field → effective rating");
  assert.equal(r({ managerRating: "B", finalRating: "A", recordRating: "C" }, false), "A");
  const d = { depts: [DEPTS[0]], deptOptions: OPTS };
  const rows = call("rvcMatrixRows", [it("1", { managerRating: "A", recordRating: "D", amendedFrom: "A" })], {}, d, true);
  assert.deepEqual(rows[0].counts, { "C/D": 1 });
  // 下钻名单里改过的人标「已改动（原评级 X）」，只在已关闭周期、且服务端给了 amendedFrom 时
  // 波次 3（W3-S）：左边距由内联样式换成 W3-C 的通用类 .u-tag-gap
  assert.match(RVC, /\{closed && r\.amendedFrom && <Tag size="small" color="amber" type="light" className="u-tag-gap">\{s\.amended\(ratingLabel\(r\.amendedFrom\)\)\}<\/Tag>\}/);
});

test("M6: rating distribution by manager — manager's own ratings only; Lenient / Strict / Too few from constants", () => {
  assert.equal(dc.MGR_DIST_MIN, 5);
  assert.equal(dc.MGR_DIST_DIFF, 0.5);
  const R = ["A+", "A", "B+", "B", "C", "D"];
  const team = (mid, ratings, extra = {}) => ratings.map((x, k) => it(mid + k, { managerId: mid, manager: "M " + mid, managerRating: x, ...extra }));
  const items = [
    ...team("loose", ["A", "A", "A", "A", "A"]),
    ...team("tight", ["C", "C", "C", "C", "C"]),
    ...team("mid", ["B+", "B+", "B+", "B+", "B+"]),
    ...team("few", ["A+", "A+"]),
    it("px", { managerId: "mid", managerRating: null, finalRating: "A+", hodProxy: { by: "h1", at: "t", reason: "r" } }),
    it("gone", { managerId: "tight", managerRating: "A+", notCounted: "departed" }),
    it("hr", { managerId: null, manager: null, managerRating: null, finalRating: "B" }),
    it("adj1", { managerId: "mid", managerRating: "B+", finalRating: "A" }),
    it("adj2", { managerId: "mid", managerRating: "B+", finalRating: "B" }),
  ];
  const base = J(dc.mgrDist(items, R));
  assert.equal(base.overall.n, 5 + 5 + 7 + 2, "proxy and departed are excluded");
  const out = call("rvcMgrRows", items, R);
  const by = Object.fromEntries(out.rows.map((r) => [r.managerId, r]));
  assert.equal(by.loose.tag, "loose");
  assert.equal(by.tight.tag, "tight");
  assert.equal(by.mid.tag, null);
  assert.equal(by.few.tag, "few");
  assert.ok(!("null" in by) && out.rows.every((r) => r.managerId !== null), "people with no manager are not a row");
  assert.deepEqual([by.mid.team, by.mid.up, by.mid.down], [8, 1, 1], "team counts counted reports (incl. the proxied one); up/down skip proxies");
  // 默认按与整体均值差的绝对值倒序
  const abs = out.rows.map((r) => Math.abs(r.diff));
  assert.deepEqual(abs, abs.slice().sort((a, b) => b - a));
  assert.match(RVC, /s\.bMgrLead\(dc\.MGR_DIST_MIN, dc\.MGR_DIST_DIFF\)/, "the lead quotes the same constants");
  assert.match(RVC, /kind === 'annual' \? <div className="tset-foot">\{s\.bMgrAnnual\}<\/div>/, "hidden for annual cycles");
});

// ---------- 地址栏参数（2.3-D） ----------
test("2.3-D: cycle, view, unit, board and list filters live in the address bar", () => {
  assert.match(RVC, /import \{ useUrlState, mergeParams, BOARD_KEYS, REVIEW_FILTER_KEYS \} from '\.\.\/\.\.\/urlstate\.js';/);
  assert.match(RVC, /const openId = params\.cycle \? String\(params\.cycle\) : '';/);
  assert.doesNotMatch(RVC, /setOpenId/, "no openId state any more");
  assert.match(RVC, /patch\(\{ cycle: cid, view: null, unit: null \}, \{ clear: \[\.\.\.BOARD_KEYS, \.\.\.REVIEW_FILTER_KEYS\] \}\)/, "opening a cycle keeps the list filters");
  assert.match(RVC, /patch\(\{ cycle: null, view: null, unit: null \}, \{ clear: \[\.\.\.BOARD_KEYS, \.\.\.REVIEW_FILTER_KEYS\] \}\)/);
  assert.match(RVC, /patch\(\{ view: k, unit: null \}, \{ clear: \[\.\.\.BOARD_KEYS, \.\.\.REVIEW_FILTER_KEYS\] \}\)/, "switching view clears every filter and unit");
  assert.match(RVC, /<CycleDetail key=\{openId\}/, "a different cycle remounts the detail (no stale data or filters)");
  assert.match(RVC, /query=\{pick\(BOARD_KEYS\)\} onQuery=\{patch\}/);
  assert.match(RVC, /query=\{pick\(REVIEW_FILTER_KEYS\)\} onQuery=\{patch\}/);
  for (const k of ["kind", "status", "year"]) assert.match(RVC, new RegExp("patch\\(\\{ " + k + ": v \\|\\| null \\}\\)"), "list filter " + k);
  for (const k of ["dept", "mgr", "lv", "stage"]) assert.match(RVC, new RegExp("onQuery\\(\\{ " + k + ": v \\|\\| null \\}\\)"), "board filter " + k);
  assert.match(RVC, /dataSource=\{cycles\}/, "the table shows the filtered list");
  assert.match(RVC, /useBulkSelection\(\{ rows: cycles,/, "bulk selection follows the filtered list");
  // 年度周期没有面谈 / 上级评级这几项；看板不再有 `r.department === val` 式的按部门名匹配
  assert.doesNotMatch(RVC, /r\.department === val/);
});

test("wave-2 review: clicking into the same page again (a notification) refetches; a 404 cleans the address with replace", () => {
  ctx.URLSearchParams = URLSearchParams;
  const sig = (s) => fn("rvcPageSig")(s);
  // 只看页面层级：周期 | 部门 | 视图（缺省 = 部门确认，与 view=depts 相同），筛选键不算
  assert.equal(sig("?cycle=rc-3&view=depts&unit=d1&q=ann&tier=A"), sig("?cycle=rc-3&view=depts&unit=d1"));
  assert.equal(sig("?cycle=rc-3"), sig("?cycle=rc-3&view=depts"), "the default view is the department list");
  assert.notEqual(sig("?cycle=rc-3&view=board"), sig("?cycle=rc-3"));
  assert.notEqual(sig("?cycle=rc-3&view=depts&unit=d1"), sig("?cycle=rc-3&view=depts"));
  assert.equal(sig(""), "||");
  // 签名不变的 push → 计数加一；周期详情与部门明细都把它放进取数依赖
  const hook = RVC.slice(RVC.indexOf("function useRenavTick()"), RVC.indexOf("function CycleDetail("));
  assert.match(hook, /if \(navType === 'PUSH' && prev\.current\.sig === sig\) setN\(\(x\) => x \+ 1\);/);
  assert.match(RVC, /const renav = useRenavTick\(\);\n  const q = useAsync\(\(\) => api\.get\(`\/api\/admin\/review-cycles\/\$\{id\}`\), \[id, renav\]\);/);
  assert.match(RVC, /const renav = useRenavTick\(\);\n  const q = useAsync\(\(\) => api\.get\(`\/api\/admin\/review-cycles\/\$\{cycleId\}\/depts\/\$\{encodeURIComponent\(unit\)\}`\), \[cycleId, unit, renav\]\);/);
  assert.match(RVC, /import \{ Link, useLocation, useNavigate, useNavigationType \} from 'react-router-dom';/);
});

test("2.6 in the HR department detail: an amended closed-cycle row shows the rating on file and 'changed (was X)'", () => {
  const DCAL = fs.readFileSync(path.join(SRC, "components", "DeptCalibration.jsx"), "utf8");
  assert.match(DCAL, /amended: \(x\) => `已改动（原评级 \$\{x\}）`/);
  assert.match(DCAL, /amended: \(x\) => `Changed \(was \$\{x\}\)`/);
  assert.match(DCAL, /\) : r\.amendedFrom \? \(/);
  assert.match(DCAL, /<span className="pill warn dcal-ml">\{s\.amended\(label\(r\.amendedFrom\)\)\}<\/span>/);
  // 「导出本部门」用 view.rows：服务端 hr 行带 recordRating 后，rvcRatingOf 取档案评级
  assert.equal(fn("rvcRatingOf")({ finalRating: "B+", recordRating: "B", amendedFrom: "B+" }, true), "B");
  assert.match(RVC, /downloadReviewCsv\(s, `\$\{d\.cycle\.name\}-\$\{\(view && view\.dept && view\.dept\.dept1\) \|\| unit\}`, \(view && view\.rows\) \|\| \[\], !open\)/);
});

test("V1: the phone card shows one progress variant (the class sits on a plain span, not on Semi Space)", () => {
  assert.doesNotMatch(RVC, /<Space wrap className="rvc-prog-wide">/);
  assert.equal((RVC.match(/<span className="rvc-prog-wide">/g) || []).length, 1);
  assert.match(RVC, /<span className="rvc-prog-narrow">/);
});

test("O1: localStamp is local time (not the UTC slice); confirmer name from the department status", () => {
  const ts = new Date(2026, 9, 8, 7, 5).toISOString();
  assert.equal(fn("localStamp")(ts), "2026-10-08 07:05");
  assert.equal(fn("localStamp")(""), "");
  const who = fn("confirmerOf");
  assert.equal(who({ hrName: "Ana" }), "Ana");
  assert.equal(who({ hrBy: { name: "Ben" } }), "Ben");
  assert.equal(who({ confirmedBy: { name: "Cy" } }), "Cy");
  assert.equal(who({ hrConfirmedAt: "x" }), "");
  assert.equal(who(null), "");
});

test("Dashboard: each review cycle row opens that cycle (/admin/reviews?cycle=<id>) without the card click", () => {
  assert.match(DASH, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); navigate\(`\/admin\/reviews\?cycle=\$\{encodeURIComponent\(c\.id\)\}`\); \}\}/);
  assert.match(DASH, /role="link" tabIndex=\{0\}/);
  assert.match(DASH, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
});
