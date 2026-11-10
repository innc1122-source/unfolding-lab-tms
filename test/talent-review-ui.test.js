// 第二批波次 3 W3-A（2026-10-08）：人才盘点九宫格筛选（2.4）、档案评级修改界面（2.6）、潜力评定日期、组织架构 / 部门页的部门筛选（3.1）。
// 不起浏览器、不打包：九宫格筛选的纯函数（司龄分段、潜力评定过期、逐行匹配）直接跑；
// 其余做源码断言（地址栏键、全站唯一部门口径、继任录入仍用未筛选的 rows、2.6 的理由 / 错误码 / 删除按钮 / 已改动标记）。
// F60（10/9）：九宫格筛选判定移到服务端 modules/talent/review-scope.js（整页人群范围，各页签共用），纯函数用例改为直接跑该模块，
// 用例本身不变；F61 删除「管理职责」，逐行匹配里 role 的用例改为「role 不再参与判定」。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ADMIN = path.join(__dirname, "..", "web", "src", "pages", "admin");
const src = (f) => fs.readFileSync(path.join(ADMIN, f), "utf8").replace(/\r\n/g, "\n");
const TR = src("TalentReview.jsx");
const PEOPLE = src("People.jsx");
const ORG = src("OrgChart.jsx");
const DEPTS = src("Departments.jsx");

// 页面词典按源码求值（与 dict-pairs 同法）
function dictOf(s) {
  const i = s.indexOf("const T = {");
  const end = s.indexOf("\n};", i);
  return vm.runInNewContext("(" + s.slice(i + "const T = ".length, end + 2) + ")", {});
}

// 九宫格筛选纯函数：F60 起只在服务端一处（modules/talent/review-scope.js），TalentReview.jsx 不再保留副本
const RS = require("../modules/talent/review-scope.js");
function pure() {
  assert.ok(!TR.includes("function trRowMatch(") && !TR.includes("function tenureBucket("), "the page no longer keeps its own copy of the scope rules");
  return { tenureBucket: RS.tenureBucket, monthsBefore: RS.monthsBefore, potState: RS.potState, trRowMatch: RS.rowMatch };
}

test("九宫格筛选纯函数：司龄满 N 周年才算 N 年，入职日期缺失为 none，未来入职按不满 1 年", () => {
  const { tenureBucket } = pure();
  const today = "2026-10-08";
  assert.equal(tenureBucket("", today), "none");
  assert.equal(tenureBucket(null, today), "none");
  assert.equal(tenureBucket("not-a-date", today), "none");
  assert.equal(tenureBucket("2027-01-01", today), "lt1");
  assert.equal(tenureBucket("2025-10-09", today), "lt1", "差一天满 1 年");
  assert.equal(tenureBucket("2025-10-08", today), "1to3", "满 1 周年");
  assert.equal(tenureBucket("2023-10-09", today), "1to3");
  assert.equal(tenureBucket("2023-10-08", today), "3to5");
  assert.equal(tenureBucket("2021-10-09", today), "3to5");
  assert.equal(tenureBucket("2021-10-08", today), "5p");
  assert.equal(tenureBucket("2001-01-01", today), "5p");
});

test("九宫格筛选纯函数：潜力评定满 12 个月算过期，没有日期归入「已过期或日期不详」，月末对齐", () => {
  const { potState, monthsBefore } = pure();
  assert.equal(monthsBefore("2026-10-08", 12), "2025-10-08");
  assert.equal(monthsBefore("2026-03-31", 1), "2026-02-28");
  assert.equal(monthsBefore("2028-03-31", 1), "2028-02-29");
  assert.equal(monthsBefore("2026-01-15", 13), "2024-12-15");
  const today = "2026-10-08";
  assert.equal(potState("", null, today, 12), "none");
  assert.equal(potState(null, "2026-10-01", today, 12), "none", "没有潜力评级 = 未评定，不看日期");
  assert.equal(potState("High", null, today, 12), "stale", "迁移 67 之前评定的没有日期");
  assert.equal(potState("High", "", today, 12), "stale");
  assert.equal(potState("High", "2025-10-09", today, 12), "fresh");
  assert.equal(potState("High", "2025-10-08", today, 12), "stale", "满 12 个月");
  assert.equal(potState("Low", "2026-10-08", today, 12), "fresh");
});

test("九宫格筛选纯函数：逐行匹配（部门走传入的口径函数，职级段 g: / nogrid；直属上级含「无」、岗位序列、员工状态、潜力；F61 管理职责不再参与）", () => {
  const { trRowMatch } = pure();
  const ctx = {
    deptOk: (d) => d === "Ops",
    levelOk: (row, band) => (band === "nogrid" ? !!row.jobLevel && !row.jobGrade : band === "g:" + row.jobGrade),
    today: "2026-10-08", day: (x) => (x ? String(x).slice(0, 10) : ""), months: 12,
  };
  const base = { department: "Ops", jobLevel: "PB1", jobGrade: "B", jobTrack: "P", directReports: 0, managerId: "m1", hireDate: "2020-01-01", empStatus: "regular", potential: "High", potentialAt: "2026-05-01T02:00:00.000Z" };
  assert.equal(trRowMatch(base, {}, ctx), true, "没有筛选全部命中");
  assert.equal(trRowMatch(base, { dept: "x" }, ctx), true);
  assert.equal(trRowMatch({ ...base, department: "Fin" }, { dept: "x" }, ctx), false);
  assert.equal(trRowMatch(base, { band: "g:B" }, ctx), true);
  assert.equal(trRowMatch(base, { band: "nogrid" }, ctx), false);
  assert.equal(trRowMatch(base, { track: "P" }, ctx), true);
  assert.equal(trRowMatch(base, { track: "M" }, ctx), false);
  assert.equal(trRowMatch({ ...base, jobTrack: "m" }, { track: "M" }, ctx), true, "通道不分大小写");
  // F61：role（管理职责）已删除，不再是范围键，传了也不参与判定
  assert.equal(trRowMatch(base, { role: "mgr" }, ctx), true);
  assert.equal(trRowMatch({ ...base, directReports: 3 }, { role: "ic" }, ctx), true);
  assert.ok(!RS.SCOPE_KEYS.includes("role"));
  assert.equal(trRowMatch(base, { mgr: "m1" }, ctx), true);
  assert.equal(trRowMatch(base, { mgr: "m2" }, ctx), false);
  assert.equal(trRowMatch(base, { mgr: "__none" }, ctx), false);
  assert.equal(trRowMatch({ ...base, managerId: null }, { mgr: "__none" }, ctx), true);
  assert.equal(trRowMatch(base, { tenure: "5p" }, ctx), true);
  assert.equal(trRowMatch(base, { tenure: "lt1" }, ctx), false);
  assert.equal(trRowMatch(base, { estatus: "regular" }, ctx), true);
  assert.equal(trRowMatch({ ...base, empStatus: null }, { estatus: "none" }, ctx), true);
  assert.equal(trRowMatch(base, { pot: "fresh" }, ctx), true);
  assert.equal(trRowMatch({ ...base, potentialAt: null }, { pot: "stale" }, ctx), true);
  assert.equal(trRowMatch({ ...base, potential: null }, { pot: "none" }, ctx), true);
  assert.equal(trRowMatch(base, { dept: "x", band: "g:B", track: "P", mgr: "m1", tenure: "5p", estatus: "regular", pot: "fresh" }, ctx), true, "全部条件同时满足");
});

test("TalentReview：筛选全部走地址栏（8 个键，F61 删除 role），来源周期带 ?cycle=，部门用全站唯一口径，继任录入仍用未筛选的 rows", () => {
  assert.match(TR, /const TR_KEYS = \['src', 'dept', 'band', 'track', 'mgr', 'tenure', 'estatus', 'pot'\];/);
  assert.equal(RS.POT_STALE_MONTHS, 12, "M5：12 个月算过期，写成常量（F60 起在服务端 review-scope.js）");
  assert.match(TR, /useUrlState\(\)/);
  assert.match(TR, /api\.get\(TF\.withQuery\('\/api\/admin\/talent-review', src \? `cycle=\$\{encodeURIComponent\(src\)\}` : '', scopeQs\)\)/, "F60：九宫格请求带来源周期与页面范围参数");
  assert.match(TR, /err\.status === 404\) return \{ gone: true \}/, "周期不存在 / 未关闭（404 cycle_not_found）不整页报错，改回缺省来源");
  assert.match(TR, /sourceCycles\.map\(\(c\) => \(\{ value: c\.id, label: c\.name \}\)\)/, "来源下拉列 sourceCycles");
  assert.match(TR, /<DeptFilter options=\{tree \? tree\.options : \[\]\}/);
  assert.match(TR, /useDeptTree\(\)/);
  assert.match(TR, /const shown = useMemo\(\(\) => rows\.filter\(\(r\) => r\.inScope !== false\), \[rows\]\);/, "F60：九宫格的部门（含下级）等判定由服务端给出 inScope");
  assert.ok(!/r\.department (===|!==) (dept|unratedDept)/.test(TR), "不再按部门原文精确比较（不含下级）");
  assert.ok(!TR.includes("unratedDept"), "L208–212 的死代码已删");
  assert.match(TR, /<SuccessionCard [^>]*employees=\{rows\}/, "继任计划用未筛选的 rows");
  assert.match(TR, /const rated = shown\.filter/);
  assert.match(TR, /const unrated = shown\.filter/);
  assert.ok(RS.bandMatch({ jobLevel: "PB1", jobGrade: "B" }, "g:B") && RS.bandMatch({ jobLevel: "V4", jobGrade: null }, "nogrid") && RS.bandMatch({ jobLevel: null }, "none"), "职级段与后台看板同一个 lv 口径（g:<职等> / nogrid / none）");
  // 名单弹窗：DeptFilter 放进 Semi Modal 用共用 helper（关动画、内容层不裁切）
  assert.match(TR, /<Modal \{\.\.\.dpfModalProps\(\)\} visible title=\{title\}/);
  assert.ok(!/<Select[^>]*placeholder=\{s\.(deptAll|unratedDeptAll)\}/.test(TR), "旧的部门 Select 已换掉");
  // culture-switch 测试依赖的那一行不动
  assert.match(TR, /cfg\.types\.filter\(\(t\) => t\.active && !t\.moduleOff\)/);
});

test("TalentReview：词条中英成对且与设计第 4 节一致", () => {
  const T = dictOf(TR);
  const want = {
    fSrc: ["绩效来源", "Rating source"], srcLatest: ["最近一次（每人）", "Most recent (per person)"], fBand: ["职级段", "Job grade"],
    fTrack: ["岗位序列", "Track"], trackM: ["管理通道", "Management"], trackP: ["专业通道", "Professional"],
    fTenure: ["司龄", "Tenure"],
    fEstatus: ["员工状态", "Employment status"], potFresh: ["12 个月内评定", "Assessed within 12 months"],
    potStale: ["已过期或日期不详", "Out of date or date unknown"], potNone: ["未评定", "Not assessed"],
    noGrid: ["未纳入职级体系", "Not in job grade structure"], noLevel: ["未设职级", "No job level"],
  };
  for (const [k, [zh, en]] of Object.entries(want)) {
    assert.equal(T.zh[k], zh, "zh " + k);
    assert.equal(T.en[k], en, "en " + k);
  }
  assert.deepEqual(Object.keys(T.zh).sort(), Object.keys(T.en).sort());
  assert.ok(!/最近一次绩效评级（按/.test(T.zh.lead), "lead 改写：说明来源可选");
  assert.match(T.zh.lead, /已关闭的评估周期/);
});

test("People 2.6：改评级必填理由并作为 ratingReason 提交；三个新码有本地文案；周期归档的记录不显示删除；已改动标记只读 e.amend", () => {
  assert.match(PEOPLE, /const ratingChanged = !!editing && editing\.type === 'performance' && typeKey === 'performance' && ratingOf\(vals\) !== ratingOf\(editing\.detail\);/);
  assert.match(PEOPLE, /if \(ratingChanged\) body\.ratingReason = ratingReason\.trim\(\);/);
  assert.match(PEOPLE, /if \(ratingChanged && !ratingReason\.trim\(\)\) missing\.__ratingReason = s\.recRequired;/, "前端先挡住空理由");
  assert.match(PEOPLE, /maxLength=\{1000\}/, "与服务端 1–1000 字一致");
  for (const code of ["rating_reason_required", "record_type_locked", "record_from_review_cycle", "period_has_cycle_record"])
    assert.match(PEOPLE, new RegExp(code + ": \\(\\) => s\\.e_" + code), "errText 映射 " + code);
  assert.match(PEOPLE, /\{!e\.reviewLinked && \(\s*<Popconfirm title=\{s\.delRecord\}/, "reviewLinked 的记录不显示「删除」");
  assert.match(PEOPLE, /if \(e\.amend && e\.amend\.from\) \{/);
  assert.match(PEOPLE, /s\.amended\(fromLabel\)/);
  assert.match(PEOPLE, /s\.amendBy\(who \|\| '—', localDay\(e\.amend\.at\), e\.amend\.reason \|\| '—'\)/);
  // 潜力评定日期
  assert.match(PEOPLE, /u\.potentialAt \? s\.potentialAt\(localDay\(u\.potentialAt\)\) : s\.potentialNoDate/);
  // 档案页的 ?edit=1 仍由地址栏驱动（org-fullpage）
  assert.ok(PEOPLE.includes("searchParams.get('edit') === '1'"));
  const T = dictOf(PEOPLE);
  assert.equal(T.zh.ratingReason, "修改理由（必填，写入审计，员工不可见）");
  assert.equal(T.en.ratingReason, "Reason for the change (required; recorded in the audit log, not shown to the employee)");
  assert.equal(T.zh.amended("B+"), "已改动（原评级 B+）");
  assert.equal(T.en.amended("B+"), "Changed (was B+)");
  assert.equal(T.zh.amendBy("Ann", "2026-10-08", "复核"), "Ann 于 2026-10-08 修改：复核");
  assert.equal(T.en.amendBy("Ann", "2026-10-08", "review"), "Changed by Ann on 2026-10-08: review");
  assert.equal(T.zh.e_record_type_locked, "该记录由评估周期归档，不能更改类型。");
  assert.equal(T.zh.e_record_from_review_cycle, "该记录由评估周期归档，不能删除；如需更正评级，请编辑并写明理由。");
  assert.equal(T.zh.potentialAt("2026-05-01"), "评定于 2026-05-01");
  assert.equal(T.zh.potentialNoDate, "评定日期不详");
  assert.equal(T.en.potentialAt("2026-05-01"), "Assessed 2026-05-01");
  assert.equal(T.en.potentialNoDate, "Assessment date unknown");
});

test("OrgChart 3.1：DeptFilter + 地址栏 dept=<id>；人员视图按 deptMatcher（含下级、带出上级链）；部门视图按 id 取子树", () => {
  assert.match(ORG, /<DeptFilter options=\{deptTree \? deptTree\.options : \[\]\} value=\{dept \|\| null\}/);
  assert.match(ORG, /const dept = urlParams\.dept \|\| '';/);
  assert.match(ORG, /deptMatcher\(deptTree, dept \|\| null\)/);
  assert.ok(!ORG.includes("n.department === dept"), "人员视图不再按部门原文精确比较");
  assert.ok(!ORG.includes("d.name === dept"), "部门视图不再按部门名取子树");
  assert.match(ORG, /deps\.find\(\(d\) => String\(d\.id\) === String\(dept\)\)/);
  assert.match(ORG, /const v = deptOk\(n\.department\) \|\| \(kids\.get\(n\.id\) \|\| \[\]\)\.some\(inScope\);/, "保留往上带出上级链");
  assert.match(ORG, /const filterIdOf = \(id\) =>/, "定位到深层部门时切到所属的可选层级");
});

test("Departments 3.1：部门写操作后让部门树缓存失效", () => {
  assert.match(DEPTS, /import \{ invalidateDeptTree \} from '\.\.\/\.\.\/deptfilter\.js';/);
  assert.match(DEPTS, /q\.reload\(\); invalidateDeptTree\(\); \};/, "单条增删改（含停用、改名、改上级）");
  assert.match(DEPTS, /setBulk\(null\);\n\s*q\.reload\(\);\n\s*invalidateDeptTree\(\);/, "批量新建");
});

// F60 / F61（负责人 10/9）：顶部筛选 = 整页人群范围；删除「管理职责 / Role type」
test("F60/F61 TalentReview + TalentFilter: no Role type filter (Track stays), no 「不受影响」 note, every tab sends the page scope, the Talent Filters tab and page say 已叠加页面顶部筛选", () => {
  const T = dictOf(TR);
  const TFP = src("TalentFilter.jsx");
  const TFD = dictOf(TFP);
  // F61
  for (const k of ["fRole", "roleMgr", "roleIc"]) { assert.equal(T.zh[k], undefined, k); assert.equal(T.en[k], undefined, k); }
  assert.ok(!/sel\('role'/.test(TR) && !TR.includes("ROLE_KEYS"), "the Role type select is gone");
  assert.match(TR, /sel\('track', s\.fTrack,/, "Track stays");
  assert.deepEqual([T.zh.fTrack, T.en.fTrack], ["岗位序列", "Track"]);
  assert.match(TR, /if \(params\.role\) bad\.role = null;/, "an old ?role= deep link is cleared");
  // F60：「不受影响」那句删除
  assert.ok(!TR.includes("晋升评审候选与继任计划不受影响") && !TR.includes("succession plans are not affected"));
  assert.equal(T.zh.filterNote, undefined);
  // 各页签带同一组范围参数（服务端判定）
  assert.match(TR, /api\.get\(TF\.withQuery\('\/api\/admin\/promotion-candidates', scopeQs\)\), \[scopeQs\]\)/);
  assert.match(TR, /api\.get\(TF\.withQuery\('\/api\/admin\/succession', 'withPositions=1&vacancies=1', scopeQs\)\), \[scopeQs\]\)/);   // vacancies=1：CX-018
  assert.match(TR, /api\.post\('\/api\/admin\/talent-filters\/export', \{ filterId, lang, scope: scopeBody \}\)/, "promotion export follows the scope");
  assert.match(TR, /userIds: \[act\.row\.id\], note: reason\.trim\(\) \|\| undefined, scope: scopeBody,/, "row actions follow the scope");
  assert.match(TR, /s\.succInScope\(rows\.length\)/, "each key position shows 范围内继任者 N");
  assert.deepEqual([T.zh.succInScope(2), T.en.succInScope(2)], ["范围内继任者 2", "Successors in scope: 2"]);
  assert.match(TR, /for \(const p of posList \|\| \[\]\) g\.set\(p\.positionName, \[\]\);/, "key-position rows stay");
  assert.match(TR, /\{scopeQs && <div className="u-hint" style=\{\{ marginBottom: 10 \}\}>\{s\.scopeApplied\}<\/div>\}/);
  assert.equal(T.zh.scopeApplied, "已叠加页面顶部筛选");
  assert.match(TR, /navigate\(TF\.withQuery\(`\/admin\/talent-review\/filter\/\$\{encodeURIComponent\(id\)\}\$\{extra\}`, scopeQs\)\)/, "opening a filter carries the scope");
  // 人才筛选整页：结果 = 范围 ∩ 条件；查询、选择全部、导出、批量都带 scope；提示与「不叠加」
  assert.match(TFP, /scope: scoped \? scope : undefined,/);
  assert.match(TFP, /\{ positionName: pos\.trim\(\), userIds: ids, readiness: ready, note: note\.trim\(\), sourceFilterId, scope \}/);
  assert.match(TFP, /\{ action: 'include', userIds: ids, note: note\.trim\(\) \|\| undefined, scope \}/);
  assert.match(TFP, /\{scoped && \(\s*<div className="u-hint tf-scope-hint">/);
  assert.deepEqual([TFD.zh.scopeOn, TFD.zh.why.out_of_view, TFD.zh.e.field_retired], ["已叠加页面顶部筛选", "不在人才盘点页面顶部筛选的范围内", "该条件已停用，请改用岗位序列"]);
  assert.match(TFP, /TF\.isRetiredField\(leaf\.field\) \? s\.e\.field_retired : s\.e\.field_removed/, "a retired condition says 请改用岗位序列");
  assert.deepEqual(Object.keys(TFD.zh).sort(), Object.keys(TFD.en).sort());
});
