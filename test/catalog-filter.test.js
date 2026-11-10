// 第四批 G5（2026-10-08）课程目录与公开课程的前端：web/src/catalog.js 纯函数（vm 直接跑）+ 培训入口表 + 几处源码约定。
//   · 搜索（课程名中英、简介中英）、类别多选（含自定义类别与 __none 未分类）、授课方式、只看未加入、默认排序；
//   · 按状态给出的操作（未加入线上 / 未加入线下 / 自主学习 / 指派 / 待补考 / 已完成）；
//   · 学习记录累计学时（服务端 totals 优先，否则按已完成 × 学时合计）；
//   · learningnav：「课程目录」入口只在 hasCatalog 时显示，/catalog 属于培训路由；
//   · 课程链接 404 public_not_enrolled → 转到 /catalog?open=<programId>；首页「可申请的选修课程」不再列公开课程。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8").replace(/\r\n/g, "\n");
const J = (v) => JSON.parse(JSON.stringify(v));

function loadEsm(src, names) {
  assert.doesNotMatch(src, /^import /m, "import-free so it runs in vm");
  const code = src.replace(/^export /gm, "") + `\n;({ ${names.join(", ")} })`;
  return vm.runInNewContext(code, { Math, Number, String, Array, Object, Set, Map, JSON });
}
const C = loadEsm(read("catalog.js"), ["catalogFiltersOf", "catalogFilterCount", "myStatusOf", "matchCatalog", "filterCatalog", "sortCatalog",
  "catalogTitle", "catalogCategories", "catalogAction", "learningHoursOf", "CATALOG_UNCAT"]);

// 类别顺序桩：与 categories.js 同一规则（标准目录在前，自定义随后，未分类最后）
const ORDER = ["合规", "通用", "数字与数据", "团建"];
const rank = (k) => (k == null || k === "__none" ? 99 : ORDER.includes(k) ? ORDER.indexOf(k) : 50);

const item = (o) => ({ programId: "pw-" + o.id, courseId: "c-" + o.id, title: o.en || o.id, title_zh: o.zh || null, summary: o.sum || "", summary_zh: o.sumZh || "",
  category: o.cat === undefined ? "通用" : o.cat, mode: o.mode || "online", hours: o.hours ?? 1, moduleCount: 3, hasExam: !!o.exam, my: o.my || { status: "none" } });
const LIST = [
  item({ id: "a", en: "Data Privacy Basics", zh: "数据隐私基础", cat: "合规", exam: true, sum: "GDPR and local law" }),
  item({ id: "b", en: "Excel Pivot Tables", zh: "Excel 进阶：数据透视", cat: "数字与数据", my: { status: "self", progress: 45 } }),
  item({ id: "c", en: "Team Workshop", zh: "团队协作工作坊", cat: "团建", mode: "offline" }),
  item({ id: "d", en: "The Art of Communication", zh: "沟通的艺术", cat: "通用", my: { status: "assigned", done: true, progress: 100 } }),
  item({ id: "e", en: "Negotiation", zh: "谈判技巧", cat: null, sumZh: "双赢谈判的方法" }),
  item({ id: "f", en: "Wine Tasting", zh: "品酒", cat: "兴趣小组" }),
];

test("catalog: URL params → filters (q, cat list with __none, mode, mine) and the active-filter count", () => {
  const f = C.catalogFiltersOf({ q: "  Excel ", cat: "合规,,__none,合规", mode: "hybrid", mine: "1" });
  assert.deepEqual(J(f), { q: "Excel", cat: ["合规", "__none"], mode: "", mine: true });
  assert.equal(C.catalogFilterCount(f), 2, "category + mine; search is not counted");
  assert.deepEqual(J(C.catalogFiltersOf({})), { q: "", cat: [], mode: "", mine: false });
  assert.equal(C.catalogFiltersOf({ mode: "offline" }).mode, "offline");
  assert.equal(C.catalogFiltersOf({ mine: "0" }).mine, false);
});

test("catalog: search matches the title and summary in both languages, case-insensitive", () => {
  const ids = (f) => C.filterCatalog(LIST, { cat: [], mode: "", mine: false, ...f }).map((x) => x.programId);
  assert.deepEqual(ids({ q: "excel" }), ["pw-b"]);
  assert.deepEqual(ids({ q: "隐私" }), ["pw-a"], "Chinese title");
  assert.deepEqual(ids({ q: "gdpr" }), ["pw-a"], "English summary");
  assert.deepEqual(ids({ q: "双赢" }), ["pw-e"], "Chinese summary");
  assert.deepEqual(ids({ q: "zzz" }), []);
  assert.equal(ids({ q: "" }).length, LIST.length);
});

test("catalog: category is multi-select incl. a custom category and __none; mode; 'not joined only'", () => {
  const ids = (f) => C.filterCatalog(LIST, { q: "", cat: [], mode: "", mine: false, ...f }).map((x) => x.programId);
  assert.deepEqual(ids({ cat: ["合规", "团建"] }), ["pw-a", "pw-c"]);
  assert.deepEqual(ids({ cat: ["兴趣小组"] }), ["pw-f"], "a custom category value");
  assert.deepEqual(ids({ cat: ["__none"] }), ["pw-e"], "uncategorised");
  assert.deepEqual(ids({ mode: "offline" }), ["pw-c"]);
  assert.deepEqual(ids({ mode: "online" }).length, 5);
  assert.deepEqual(ids({ mine: true }), ["pw-a", "pw-c", "pw-e", "pw-f"], "self and assigned courses are hidden");
  assert.deepEqual(ids({ mine: true, cat: ["合规"], q: "privacy" }), ["pw-a"], "filters combine");
  assert.equal(C.myStatusOf({ my: { status: "weird" } }), "none");
  assert.equal(C.myStatusOf({}), "none");
});

test("catalog: default sort = category order (uncategorised last), then title in the current language", () => {
  const zh = C.sortCatalog(LIST, "zh", rank).map((x) => x.programId);
  assert.deepEqual(zh, ["pw-a", "pw-d", "pw-b", "pw-c", "pw-f", "pw-e"]);
  const two = [item({ id: "x", en: "Beta", zh: "乙", cat: "通用" }), item({ id: "y", en: "Alpha", zh: "甲", cat: "通用" })];
  assert.deepEqual(C.sortCatalog(two, "en", rank).map((x) => x.programId), ["pw-y", "pw-x"], "English titles");
  assert.equal(C.catalogTitle({ title: "T", title_zh: null }, "zh"), "T", "falls back to the other language");
  assert.deepEqual(J(C.sortCatalog(LIST, "zh")).length, LIST.length, "no rank function → still sorts by title");
  assert.notEqual(C.sortCatalog(LIST, "zh", rank), LIST, "returns a copy");
});

test("catalog: categories for the filter come from the server, else from the list", () => {
  assert.deepEqual(J(C.catalogCategories({ categories: ["合规", null] })), ["合规", "__none"]);
  assert.deepEqual(J(C.catalogCategories({ items: LIST })), ["合规", "数字与数据", "团建", "通用", "__none", "兴趣小组"]);
  assert.deepEqual(J(C.catalogCategories(null)), []);
});

test("catalog: action by state — start / join / continue / retake / done / joined", () => {
  const on = (my, extra = {}) => C.catalogAction({ programId: "pw-1", courseId: "c-1", mode: "online", hasExam: true, my, ...extra });
  assert.deepEqual(J(on({ status: "none" })), { kind: "start", enroll: true, href: "/course/c-1" }, "none + online → Start learning, then the course");
  assert.deepEqual(J(on({ status: "none" }, { mode: "offline" })), { kind: "join", enroll: true, href: null }, "none + in-person → Join course, stay on the page");
  assert.deepEqual(J(on({ status: "self", progress: 45 })), { kind: "continue", enroll: false, progress: 45, href: "/course/c-1" });
  assert.deepEqual(J(on({ status: "assigned", progress: 100.4 })), { kind: "continue", enroll: false, progress: 100, href: "/program/pw-1" }, "finished the content, exam left → course details");
  assert.equal(on({ status: "self", progress: 100 }, { hasExam: false }).href, "/course/c-1");
  assert.deepEqual(J(on({ status: "self", learnStatus: "retake_pending", retakeExamId: "ex-9" })), { kind: "retake", enroll: false, href: "/exam-prep/pw-1/ex-9" });
  assert.equal(on({ status: "self", learnStatus: "retake_pending" }).href, "/program/pw-1", "no exam id → course details");
  assert.deepEqual(J(on({ status: "assigned", done: true, learnStatus: "retake_pending" })), { kind: "done", enroll: false, href: "/program/pw-1" }, "done wins");
  assert.deepEqual(J(on({ status: "self" }, { mode: "offline" })), { kind: "joined", enroll: false, href: "/course/c-1" });
  assert.equal(on({ status: "self", progress: -5 }).progress, 0);
  assert.equal(C.catalogAction({ programId: "pw-2", mode: "online", my: { status: "none" } }).href, "/program/pw-2", "no course id → program page");
});

test("learning record hours: server totals first; otherwise completed rows × hours, self-directed split", () => {
  const rows = [
    { id: "p1", status: "passed", hours: 1.5, source: "self" },
    { id: "p2", status: "passed", hours: 2 },
    { id: "p3", status: "inprog", hours: 4, source: "self" },
    { id: "p4", done: true, hours: 0.25 },
  ];
  assert.deepEqual(J(C.learningHoursOf(rows)), { items: rows, total: 3.8, self: 1.5, assigned: 2.3, known: true });
  const srv = C.learningHoursOf({ items: rows, totals: { hoursDone: 10, hoursSelf: 2.5 } });
  assert.equal(srv.total, 10);
  assert.equal(srv.self, 2.5);
  assert.equal(srv.assigned, 7.5);
  assert.equal(srv.items.length, 4);
  const flat = C.learningHoursOf({ items: [], hoursDone: 3, hoursSelf: 0 });
  assert.deepEqual([flat.total, flat.self, flat.known], [3, 0, true]);
  const old = C.learningHoursOf([{ id: "p1", status: "passed" }]);
  assert.equal(old.known, false, "an old server sends no hours → the line is hidden");
  assert.equal(C.learningHoursOf(null).items.length, 0);
});

test("learningnav: Public Courses sits after My Courses and shows only with hasCatalog; /catalog is a learning route", () => {
  const src = read("learningnav.js").replace(/^import .*$/gm, "").replace(/^export /gm, "");
  const N = new Function("useEffect", "useState", "api", "fetchMyProjects", src + "\nreturn { LEARNING_ITEMS, isLearningPath, visibleLearningItems };")(() => {}, (v) => [v, () => {}], {}, () => Promise.resolve({}));
  const cat = N.LEARNING_ITEMS[1];
  assert.deepEqual([cat.id, cat.to, cat.need, cat.zh, cat.en], ["catalog", "/catalog", "catalog", "公开课", "Public Courses"]); // F59
  assert.equal(cat.hubZh, "全员可自主学习的公开课程，无需申请");
  assert.equal(cat.hubEn, "Open courses anyone can take, no application needed");
  const ids = (st) => N.visibleLearningItems(st).map((x) => x.id);
  assert.deepEqual(ids({ learningOn: true, hasCatalog: false, roles: {} }), ["courses"], "hidden while the catalog is empty");
  assert.deepEqual(ids({ learningOn: true, hasCatalog: true, hasProjects: true, roles: {} }), ["courses", "catalog", "programs"]);
  assert.equal(N.isLearningPath("/catalog"), true);
  assert.equal(N.isLearningPath("/catalog/"), true);
  assert.equal(N.isLearningPath("/catalogue"), false);
  assert.match(read("learningnav.js"), /api\.get\('\/api\/catalog\/courses\?count=1'\)/);
  assert.match(read("App.jsx"), /<Route path="\/catalog" element=\{<Catalog \/>\} \/>/);
  const gate = read("App.jsx").slice(read("App.jsx").indexOf("{on('learning') && ("));
  assert.ok(gate.indexOf('path="/catalog"') > 0 && gate.indexOf('path="/catalog"') < gate.indexOf("</>"), "inside the learning switch");
});

test("catalog page and learner pages: source conventions (no Semi on the employee side, redirect, electives, self-directed tags)", () => {
  const page = read("pages", "Catalog.jsx");
  assert.doesNotMatch(page, /semi-ui|TrainingFilters/, "the employee bundle stays Semi-free");
  assert.match(page, /<ModuleTrail items=\{learnTrail\(lang, 'catalog'\)\} \/>/);
  assert.match(page, /api\.post\(`\/api\/catalog\/courses\/\$\{encodeURIComponent\(it\.programId\)\}\/enroll`\)/);
  assert.match(page, /title: '公开课'/); // F59
  assert.match(page, /title: 'Public Courses'/);
  // 简化 10/11：弹窗外壳改用公共的 Overlay（role="dialog" + aria-modal 在那里）
  assert.match(page, /<Overlay className="cg-mask" boxClassName="cg-dialog" labelledBy="cg-dlg-t"/);
  assert.match(read("components", "Overlay.jsx"), /role="dialog" aria-modal="true"/);
  assert.doesNotMatch(page, /employeeId/, "9.1: no people on the catalog");
  for (const f of ["Course.jsx", "ProgramDetail.jsx"]) {
    const src = read("pages", f);
    assert.match(src, /error\.data\.code === 'public_not_enrolled'/, f);
    assert.match(src, /<Navigate to=\{`\/catalog\?open=\$\{encodeURIComponent\(error\.data\.programId/, f);
  }
  const home = read("pages", "Home.jsx");
  assert.match(home, /p\.enrollType === 'elective' && p\.public !== true/, "public courses are not offered for application");
  assert.match(home, /nav\('\/catalog'\)/);
  const ml = read("pages", "MyLearning.jsx");
  assert.match(ml, /selfTag: '自主学习'/);
  assert.match(ml, /closedNote: '该课程已不再公开，你仍可学完'/);
  assert.match(ml, /api\.del\(`\/api\/catalog\/courses\/\$\{encodeURIComponent\(p\.id\)\}\/enroll`\)/);
  const row = ml.slice(ml.indexOf('<ul className="ml-list">'));
  assert.equal((row.match(/<button\b/g) || []).length, 1, "the ⋯ menu sits beside the row button, never inside it");
  assert.match(read("pages", "Record.jsx"), /learningHoursOf\(data\)/);
  assert.match(read("pages", "MyTeam.jsx"), /it\.source === 'self'/);
});

test("overview source filter (7 「区分指派与自主学习」): src in the URL, omitted when 'all', counted as a filter", () => {
  const src = read("pages", "admin", "overview", "ovquery.js");
  const names = [...src.matchAll(/^export\s+(?:function|const)\s+(\w+)/gm)].map((m) => m[1]);
  const code = src.replace(/^export\s+/gm, "");
  const Q = vm.runInNewContext(code + "\n;({" + names.join(",") + "})", { encodeURIComponent, decodeURIComponent });
  assert.equal(Q.FILTER_KEYS[Q.FILTER_KEYS.length - 1], "src");
  assert.equal(Q.filtersFromParams({}).src, "all");
  assert.equal(Q.filtersFromParams({ src: "bogus" }).src, "all");
  assert.equal(Q.queryOf(Q.filtersFromParams({ src: "all" })), "period=quarter", "default stays out of the query");
  assert.equal(Q.queryOf(Q.filtersFromParams({ src: "self", cohort: "new30" })), "period=quarter&cohort=new30&src=self");
  assert.equal(Q.activeFilterCount(Q.filtersFromParams({ src: "assigned" })), 1);
  assert.deepEqual({ ...Q.bodyOf(Q.filtersFromParams({ src: "self" }), { metric: "overdue" }) }, { period: "quarter", src: "self", metric: "overdue" });
  const filt = read("pages", "admin", "overview", "OverviewFilters.jsx");
  assert.match(filt, /<SourceSelect value=\{filters\.src === 'all' \? '' : filters\.src\} onChange=\{\(v\) => patch\(\{ src: v \|\| null \}\)\}/);
  const kpi = read("pages", "admin", "overview", "KpiCards.jsx");
  assert.match(kpi, /Number\(sp\.self\.num\) > 0/, "the split line only appears with self-directed learning");
  assert.match(read("pages", "admin", "overview", "CategoryTable.jsx"), /const hasSelf = rows\.some\(\(c\) => Number\(c\.selfAssigned\) > 0\);/);
  assert.match(read("pages", "admin", "overview", "PeopleListPage.jsx"), /title: s\.colSource, dataIndex: 'source'/);
});

test("course library: public checkbox, list tag, pub filter and bulk make public / not public (op 'public' + value), close confirm", () => {
  const c = read("pages", "admin", "Content.jsx");
  assert.match(c, /<Form\.Checkbox field="public" noLabel/);
  assert.match(c, /\{ op: 'public', ids: bulkSnap\.ids, value: op === 'publicOn' \}/);
  assert.match(c, /if \(fPub && publicOf\(c\) !== \(fPub === '1'\)\) return false;/);
  assert.match(c, /<PublicSelect value=\{fPub\} onChange=\{\(v\) => setFilter\('pub', v\)\} \/>/);
  assert.match(c, /if \(formSheet\.data\.public === true && next\.public === false\) \{ confirmPublicClose\(next, save\); return; \}/);
  assert.match(c, /api\.get\(`\/api\/admin\/courses\/\$\{encodeURIComponent\(c\.id\)\}\/public-impact`\)/);
  assert.match(c, /\.\.\.\(typeof course\.public === 'boolean' \? \{ public: course\.public \} : \{\}\),/, "an unknown flag is never sent, so older data is kept");
  // impactOf: field aliases and list lengths
  const at = c.indexOf("const impactOf = ");
  const fn = c.slice(at, c.indexOf("\n};", at) + 3).replace("const impactOf = ", "(") .replace(/;\s*$/, ")");
  const impactOf = vm.runInNewContext(fn, { Array, Number, Math });
  assert.deepEqual(J(impactOf({ started: 8, notStarted: 4, done: 23 })), { started: 8, notStarted: 4, total: 12, done: 23 });
  assert.deepEqual(J(impactOf({ kept: ["u1", "u2"], removed: ["u3"], completed: 5 })), { started: 2, notStarted: 1, total: 3, done: 5 });
  assert.equal(impactOf(null), null);
});
