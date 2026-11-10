// P0 第一组（1.1 / 1.2 / 1.5，2026-10-07）评估周期前端：读源码断言 + 把部门确认的判断函数取出来实跑。
// 写法照 review-reminders.test.js 读 ReviewCycles.jsx 的做法，不起服务器、不碰数据库。
// 覆盖：HR 校准只认 hrCalibratable、v2 校准带理由、确认按钮按 confirmIssues / scopePartial / HoD 待确认 / 本人是 HoD
// 置灰并列出原因、无 HoD 组「撤销确认」与「已撤销确认」、「已调整」只在季度周期、部门筛选走 deptPath / deptOptions、
// 发起对话框发 departmentId 并保留最近一次成功的部门选项、员工端面谈取消被锁时的 self_locked 文案。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const RVC = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "ReviewCycles.jsx"), "utf8");
const REVIEW = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "Review.jsx"), "utf8");

// 从 at 起取出平衡的 {…}（跳过字符串、模板与注释里的花括号）
function balanced(src, at) {
  let i = src.indexOf("{", at), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === "'" || c === '"') { i++; while (src[i] !== c) { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "`") { i++; let d2 = 0; while (i < src.length && !(src[i] === "`" && d2 === 0)) { if (src[i] === "\\") i++; else if (src[i] === "$" && src[i + 1] === "{") { d2++; i++; } else if (src[i] === "}" && d2) d2--; i++; } continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced at " + at);
}
function snippet(re) {
  const m = RVC.match(re);
  assert.ok(m, "ReviewCycles.jsx has " + re);
  return m.index;
}

// 词典（zh / en）与部门确认的两个纯函数：按源码求值，不执行页面代码
// CX-229：deptConfirmState 按员工与组织写权限选文案；测试里用 me.peopleRo 模拟只读（缺省视为有写权限）
const ctx = vm.createContext({ canWriteDomain: (u, d) => !(u && u.peopleRo && d === "people") });
for (const re of [/const deptNames = /, /const memberDiff = /]) {
  const at = snippet(re);
  vm.runInContext(RVC.slice(at, RVC.indexOf("\n", at)), ctx);
}
vm.runInContext("var T = (" + balanced(RVC, snippet(/\bconst T\s*=\s*\{/)) + ");", ctx);
const issueAt = snippet(/const deptIssueText = /);
vm.runInContext("var deptIssueText = (s, x) => " + balanced(RVC, RVC.indexOf("=>", issueAt)) + ";", ctx);
const stateAt = snippet(/function deptConfirmState\(r, me, s\)/);
vm.runInContext("var deptConfirmState = function (r, me, s) " + balanced(RVC, stateAt) + ";", ctx);
const T = vm.runInContext("T", ctx);
// 结果在 vm 的另一个 realm 里造出来，数组原型不同；转成本 realm 的普通对象再比
const state = (r, me, lang = "en") => JSON.parse(JSON.stringify(vm.runInContext("deptConfirmState", ctx)(r, me, T[lang])));

const NEW_KEYS = [
  "colCalib", "calibHintV2", "calibHintLegacy", "adjusted", "xHod", "calibTitle", "calibReason", "calibReasonOpt", "calibReasonPh",
  "calibPick", "calibClear", "eHodReadonly", "eReasonCalib", "eConfirmBlocked", "eAlreadyConfirmed", "eHodUnresolved", "eSelfConfirm",
  "eDeptNotFound", "eDeptsChanged", "issueRatingMissing", "issueOverQuota", "issueMembershipChanged", "issueMembersChangedConfirmed", "issueScopePartial",
  "mustReturn", "fixInSheet", "reopen", "reopenTitle", "reopenReason", "reopenedOk", "stReopened", "stHodPending", "hodPendingShort", "inclSub",
  // 审查修复轮：一级部门已停用、评级在提交 / 确认后被改
  "eDeptInactive", "stDeptInactive", "deptInactiveShort", "issueRatingsChanged", "issueRatingsChangedConfirmed",
];

test("new strings exist in both languages; the old single calibHint is gone", () => {
  for (const k of NEW_KEYS) {
    assert.ok(T.zh[k] !== undefined, "zh." + k);
    assert.ok(T.en[k] !== undefined, "en." + k);
    assert.equal(typeof T.zh[k], typeof T.en[k], k + " has the same shape in zh and en");
  }
  assert.equal(T.zh.calibHint, undefined);
  assert.equal(T.en.calibHint, undefined);
  assert.equal(T.zh.colCalib, "校准评级");
  assert.equal(T.en.colCalib, "Calibrated Rating");
  assert.equal(T.en.issueOverQuota([{ tier: "A+", count: 1, allowed: 0 }]), "Over quota: A+ 1/0");
  assert.equal(T.zh.issueOverQuota([{ tier: "A+", count: 1, allowed: 0 }, { tier: "A", count: 3, allowed: 2 }]), "超出配额：A+ 1/0、A 3/2");
  assert.equal(T.zh.issueRatingMissing(2), "2 人还没有评级");
  assert.match(T.en.eDeptsChanged({ depts: ["Finance", { dept1: "Ops" }] }), /Finance, Ops$/);
  // 求助写「请 IT …」或指向部门页，不写「联系管理员」
  const sample = { issueOverQuota: [{ tier: "A", count: 2, allowed: 1 }], eDeptsChanged: { depts: ["Finance"] }, calibPick: "A",
    issueMembershipChanged: { added: 1, removed: 1 }, issueMembersChangedConfirmed: null };
  assert.equal(T.en.issueMembershipChanged({}), "Members changed after the HoD submitted", "no counts → no parenthesis");
  for (const lang of ["zh", "en"]) for (const k of NEW_KEYS) {
    const v = typeof T[lang][k] === "function" ? T[lang][k](k in sample ? sample[k] : 1) : T[lang][k];
    assert.doesNotMatch(String(v), /联系管理员|contact (an |your )?admin/i, lang + "." + k);
  }
});

test("1.1: the calibration cell is editable only where the server says hrCalibratable; v2 sends a reason", () => {
  assert.match(RVC, /open && canEdit && r\.hrCalibratable/, "edit condition reads items[].hrCalibratable");
  // 第二批 2.2：评估表只给旧流程（表头说明用 calibHintLegacy）；v2 的说明放在「部门确认」下面（无 HoD 的组在部门明细里校准）
  assert.match(RVC, /title=\{s\.calibHintLegacy\}/, "legacy table header keeps its hint");
  assert.match(RVC, /<div className="tset-foot">\{s\.calibHintV2\}<\/div>/, "the v2 hint sits under the department list");
  assert.match(RVC, /\{ finalRating: v \|\| null, reason \}/, "v2 PUT carries the reason");
  assert.match(RVC, /reason === undefined \? \{ finalRating: v \|\| null \}/, "legacy PUT keeps the old body");
  assert.match(RVC, /if \(!v2\) \{ calibrate\(r\.id, nv\); return; \}/, "legacy keeps save-on-select");
  assert.match(RVC, /const calibReasonNeeded = \(r, v\) => quarterly && !!v && !!r\.managerRating && v !== r\.managerRating/, "quarter: a changed manager rating needs a reason (same rule as the HoD route)");
  assert.match(RVC, /disabled: !!calib && calibReasonNeeded\(calib\.r, calib\.value\) && !calibNote\.trim\(\)/, "save is blocked until the reason is given");
  // 「已调整」只在季度周期（年度周期没有上级评级，M10）
  assert.match(RVC, /const quarterly = d\.cycle\.kind !== 'annual'/);
  assert.match(RVC, /\{quarterly && v && r\.managerRating && v !== r\.managerRating && \(/);
  assert.match(RVC, /title=\{r\.hodText \|\| undefined\}>\{s\.adjusted\}/, "the tag shows the calibration note on hover");
  for (const code of ["hod_calibration_readonly", "reason_required", "hod_unresolved", "dept_inactive", "depts_changed"]) {
    assert.match(RVC, new RegExp(code + ": "), "errMap maps " + code);
  }
});

test("1.2: department confirm reads confirmIssues and maps the new server codes", () => {
  assert.match(RVC, /r\.confirmIssues/);
  for (const code of ["confirm_blocked", "already_confirmed", "hod_unresolved", "dept_inactive", "self_confirm", "not_submitted"]) {
    assert.match(RVC, new RegExp("\\b" + code + ": "), "act() maps " + code);
  }
  assert.match(RVC, /r\.deptInactive \? s\.stDeptInactive : s\.stHodPending/, "an inactive level-1 department says so instead of 'set the owner'");
  assert.match(RVC, /c\.hodOwned \? s\.stReturned : s\.stReopened/, "a reopened no-HoD group is not labelled 'Returned'");
  assert.match(RVC, /c\.hodOwned \? s\.returnBtn : s\.reopen/, "confirmed no-HoD group offers Reopen");
  assert.match(RVC, /retHodOwned \? s\.returnTitle : s\.reopenTitle/);
  assert.match(RVC, /hodOwned \? s\.returnedOk : s\.reopenedOk/);
});

test("1.2 / E1–E5: deptConfirmState — who may confirm, and the reasons shown beside the button", () => {
  const me = { id: "hr1" };
  const hod = { id: "h1", name: "HoD" };
  const sub = { hodSubmittedAt: "2026-10-07T01:00:00Z", hodId: "h1" };
  const en = T.en;

  // HoD 已提交、无阻断项 → 可确认，可退回
  let c = state({ hod, status: sub, confirmIssues: [] }, me);
  assert.deepEqual([c.canConfirm, c.canReturn, c.hodOwned, c.reasons], [true, true, true, []]);

  // HoD 未提交 → 不能确认；阻断项先不列（不出现「须退回」）
  c = state({ hod, status: null, confirmIssues: [{ code: "rating_missing", n: 2 }] }, me);
  assert.equal(c.canConfirm, false);
  assert.deepEqual(c.reasons, []);

  // 超额（10 人以上）与有人未评级 → 置灰，列出原因并提示退回 HoD
  c = state({ hod, status: sub, confirmIssues: [{ code: "over_quota", over: [{ tier: "A+", count: 1, allowed: 0 }] }, { code: "rating_missing", n: 1 }] }, me);
  assert.equal(c.canConfirm, false);
  assert.deepEqual(c.reasons, ["Over quota: A+ 1/0", "1 without a rating", en.mustReturn]);

  // 成员快照不一致（E3）
  c = state({ hod, status: sub, confirmIssues: [{ code: "membership_changed", added: 1, removed: 0 }] }, me);
  assert.deepEqual([c.canConfirm, c.reasons], [false, ["Members changed after the HoD submitted (1 added, 0 removed)", en.mustReturn]]);
  // 已确认后成员有变动（membershipChanged）：退回 / 撤销确认仍可用，并提示关闭周期会被拦
  c = state({ hod, status: { ...sub, hrConfirmedAt: "2026-10-07T03:00:00Z" }, confirmIssues: [], membershipChanged: { added: 0, removed: 2 } }, me, "zh");
  assert.equal(c.canReturn, true);
  assert.deepEqual(c.confirmedNotes, ["确认后部门成员有变动（新增 0 人、移出 2 人），须退回或撤销确认后重新确认，否则不能关闭周期"]);

  // 无 HoD 的组：HR 直接确认；有阻断项时提示在部门明细中调整（第二批起 v2 没有评估表）；撤销确认（hodOwned=false）
  c = state({ hod: null, status: null, confirmIssues: [] }, me);
  assert.deepEqual([c.canConfirm, c.hodOwned, c.hodPending], [true, false, false]);
  c = state({ hod: null, status: null, confirmIssues: [{ code: "rating_missing", n: 3 }] }, me);
  assert.deepEqual([c.canConfirm, c.reasons], [false, ["3 without a rating", en.fixInSheet]]);

  // 数据范围不全（scopePartial）→ 确认与退回都置灰（M10）
  c = state({ hod, status: sub, confirmIssues: null, scopePartial: true }, me);
  assert.deepEqual([c.canConfirm, c.canReturn, c.reasons], [false, false, [en.issueScopePartial]]);

  // HoD 待确认（E1）：服务端标 hodUnresolved 或给 hod_unresolved 阻断项 → 不能确认，始终提示去部门页指定负责人
  c = state({ hod: null, hodUnresolved: true, status: null, confirmIssues: [] }, me);
  assert.deepEqual([c.canConfirm, c.hodPending, c.reasons], [false, true, [en.eHodUnresolved]]);
  c = state({ hod: null, status: null, confirmIssues: [{ code: "hod_unresolved" }] }, me);
  assert.deepEqual([c.canConfirm, c.reasons], [false, [en.eHodUnresolved]]);
  // HoD 提交之后才变成「待确认」：照常确认（服务端只在未提交时返回 hod_unresolved），HoD 列仍提示待确认
  c = state({ hod: null, hodUnresolved: true, status: sub, confirmIssues: [] }, me);
  assert.deepEqual([c.canConfirm, c.hodPending, c.reasons], [true, true, []]);
  // 曾由 HoD 提交（status.hodId）、现在找不到 HoD：仍算 HoD 所有，显示「HoD 待确认」，未提交不能确认
  c = state({ hod: null, status: { hodId: "h1", returnedAt: "2026-10-07T02:00:00Z" }, confirmIssues: [] }, me);
  assert.deepEqual([c.hodOwned, c.hodPending, c.canConfirm], [true, true, false]);

  // 确认人自己就是该部门的 HoD（E2）：当前 HoD 或提交人 → 确认与退回都不行
  c = state({ hod, status: sub, confirmIssues: [] }, { id: "h1" });
  assert.deepEqual([c.canConfirm, c.canReturn, c.reasons], [false, false, [en.eSelfConfirm]]);
  c = state({ hod: { id: "h2", name: "New HoD" }, status: sub, confirmIssues: [] }, { id: "h1" });
  assert.deepEqual([c.canConfirm, c.canReturn], [false, false], "the HoD who submitted can't confirm either");

  // 审查修复轮：服务端给了 hodOwned 就以它为准 —— 退回后一级部门已没有在职成员 → 交回 HR，可以直接确认
  c = state({ hod: null, hodOwned: false, status: { hodId: "h1", returnedAt: "2026-10-07T02:00:00Z" }, confirmIssues: [] }, me);
  assert.deepEqual([c.hodOwned, c.hodPending, c.canConfirm], [false, false, true]);
  // HoD 待确认且有人未评级：部门明细里同样只读，不再提示「请在部门明细中调整」
  c = state({ hod: null, hodUnresolved: true, hodOwned: false, status: null, confirmIssues: [{ code: "hod_unresolved" }, { code: "rating_missing", n: 3 }] }, me);
  // CX-171：HoD 待确认时确认区只给这一个原因与下一步；「N 人还没有评级」仍在部门明细的徽标里，不再重复
  assert.deepEqual([c.canConfirm, c.reasons], [false, [en.eHodUnresolved]]);
  // CX-229：没有员工与组织写权限的人只看到原因，不让他「去部门页指定负责人」
  c = state({ hod: null, hodUnresolved: true, hodOwned: false, status: null, confirmIssues: [{ code: "hod_unresolved" }] }, { id: "hr2", peopleRo: true });
  assert.deepEqual(c.reasons, [en.eHodUnresolvedRo]);
  // 一级部门已停用：单独的原因（重新启用或调整人员），不让 HR 去指定负责人
  c = state({ hod: null, hodUnresolved: true, deptInactive: true, hodOwned: false, status: null, confirmIssues: [{ code: "dept_inactive" }, { code: "rating_missing", n: 1 }] }, me);
  assert.deepEqual([c.canConfirm, c.hodPending, c.reasons], [false, true, [en.eDeptInactive]]);
  // 提交后有人的评级被改（ratings_changed）；确认后被改（ratingsChanged）
  c = state({ hod, status: sub, confirmIssues: [{ code: "ratings_changed", n: 2 }] }, me);
  assert.deepEqual([c.canConfirm, c.reasons], [false, ["2 rating(s) changed after the HoD submitted", en.mustReturn]]);
  c = state({ hod, status: { ...sub, hrConfirmedAt: "2026-10-07T03:00:00Z" }, confirmIssues: [], ratingsChanged: 1 }, me, "zh");
  assert.deepEqual(c.confirmedNotes, ["确认后有 1 人的评级被改动，须退回或撤销确认后重新确认，否则不能关闭周期"]);

  // 中文原因
  c = state({ hod, status: sub, confirmIssues: [{ code: "over_quota", over: [{ tier: "A+", count: 1, allowed: 0 }] }] }, me, "zh");
  assert.deepEqual(c.reasons, ["超出配额：A+ 1/0", "须退回 HoD 调整"]);
});

test("1.2: the confirm button and the reasons are wired to deptConfirmState; confirmed rows get Return / Reopen", () => {
  assert.match(RVC, /disabled=\{!c\.canConfirm \|\| busy\}/);
  assert.match(RVC, /<DeptReasons list=\{c\.reasons\} \/>/);
  assert.match(RVC, /if \(st\.hrConfirmedAt\) \{/, "confirmed rows are no longer hidden from HR");
  assert.doesNotMatch(RVC, /if \(!open \|\| !canEdit \|\| st\.hrConfirmedAt\) return null;/);
  assert.doesNotMatch(RVC, /const canConfirm = !!st\.hodSubmittedAt \|\| !r\.hod;/, "old rule replaced");
});

test("1.5: department filters use deptPath / deptOptions ids; launch sends departmentId and keeps the last good options", () => {
  assert.match(RVC, /\(i\.deptPath \|\| \[\]\)\.includes\(id\)/);
  assert.match(RVC, /d\.deptOptions/);
  // 第二批 3.1：评估表工具栏换成全站的 DeptFilter（含下级），列头上重复的那份部门筛选删掉
  assert.match(RVC, /<DeptFilter options=\{deptOptions\} value=\{fDept \|\| null\}/);
  assert.doesNotMatch(RVC, /onFilter: \(val, r\) => inDept\(r, val\)/, "no second department filter on the column header");
  assert.doesNotMatch(RVC, /i\.department !== fDept/);
  assert.doesNotMatch(RVC, /r\.department === val/);
  assert.doesNotMatch(RVC, /department: cDept/);
  assert.match(RVC, /departmentId: cDept \|\| undefined/);
  assert.equal((RVC.match(/departmentId: cDept \|\| undefined/g) || []).length, 2, "preview and launch both send departmentId");
  // 选项取自预览响应；预览失败只清人数，不清下拉（M8）。第二批 3.1：参与范围换成 DeptFilter；它在 Semi 弹窗里，
  // 弹窗关掉动画并把内容层改成 overflow:visible，部门弹层 / 手机抽屉才不会被截掉
  assert.match(RVC, /setDeptOpts\(r\.deptOptions\)/);
  assert.match(RVC, /<DeptFilter options=\{deptOpts\} value=\{cDept \|\| null\} onChange=\{\(v\) => setCDept\(v \|\| ''\)\}/);
  assert.match(RVC, /motion=\{false\} modalRender=\{dpfModalRender\}/);
  assert.match(RVC, /overflow: 'visible'/);
  assert.doesNotMatch(RVC, /\.catch\(\(\) => \{ if \(alive\) setPreview\(null\); \}\)/, "no longer wipes everything on a failed preview");
  // 人数与未设职级人数都来自服务端预览；不再按 roster 的部门名精确计数
  assert.match(RVC, /preview\.noLevel/);
  assert.doesNotMatch(RVC, /\/api\/admin\/roster/);
  assert.match(RVC, /\{s\.inclSub\}/);
  assert.match(RVC, /dept_not_found: \(\) => s\.eDeptNotFound/);
});

test("2.2: v2 has no editable Review Sheet; department names open the read-only HR detail (DeptCalibration mode=hr)", () => {
  // 页签：v2 只有「部门确认」「看板」，缺省部门确认；旧流程只有评估表（含 HR 校准）
  assert.match(RVC, /\[\['depts', s\.vDepts\], \['board', s\.vBoard\]\]/);
  assert.doesNotMatch(RVC, /\['table', s\.vTable\]/, "the v2 Review Sheet tab is gone");
  assert.match(RVC, /v2 \? \(params\.view === 'board' \? 'board' : 'depts'\) : 'table'/, "view comes from the address bar");
  // 「请在评估表中调整」改为「请在部门明细中调整」
  assert.equal(T.zh.fixInSheet, "请在部门明细中调整");
  assert.equal(T.en.fixInSheet, "Adjust it in the department detail");
  for (const lang of ["zh", "en"]) assert.doesNotMatch(Object.values(T[lang]).filter((v) => typeof v === "string").join("|"), /请在评估表中调整|in the Review Sheet/);
  // 部门名 → &unit=（Link，push）；明细读新接口，HR 模式，确认 / 退回与列表共用一套
  assert.match(RVC, /<Link className="emp-namelink" to=\{unitHref\(r\.dept1Id\)\}/);
  assert.match(RVC, /mergeParams\(params, \{ view: 'depts', unit: dept1Id \}, BOARD_KEYS\)/, "opening a department drops the board keys");
  assert.match(RVC, /patch\(\{ unit: null \}, \{ clear: REVIEW_FILTER_KEYS \}\)/, "leaving it drops the calibration filter keys");
  assert.match(RVC, /api\.get\(`\/api\/admin\/review-cycles\/\$\{cycleId\}\/depts\/\$\{encodeURIComponent\(unit\)\}`\)/);
  assert.match(RVC, /<DeptCalibration mode="hr"/);
  assert.match(RVC, /actions=\{data\.row \? <DeptActs r=\{data\.row\}/, "confirm / return on the detail page");
  assert.match(RVC, /<DeptActs r=\{r\} s=\{s\} open=\{open\} canEdit=\{canEdit\} acts=\{acts\} \/>/, "and in the department list");
  // 「校准」只给有绩效写权限的人（服务端 editable 另外要求 hrCalibratable 且有写权限）；只读档没有提醒按钮
  assert.match(RVC, /onCalibrateRow=\{canEdit && open \? \(row\) => calib\.openCalib\(row\) : undefined\}/);
  assert.match(RVC, /remindManagers = useMemo\(\(\) => \(open && canEdit/);
  assert.match(RVC, /personHref=\{canProfile \? \(row\) => `\/admin\/people\/\$\{row\.userId\}` : undefined\}/);
  // 404（部门已调整或越出范围）→ 提示并回到部门列表；周期 404 → 回到周期列表
  // 波次 2 复核：404 的清理用 replace（失效地址不留在历史里，否则返回键退不出本页）；用户点的「返回」仍是 push
  assert.match(RVC, /if \(q\.error && q\.error\.status === 404\) \{ Toast\.warning\(s\.eUnitGone\); onGone\(\); \}/);
  assert.match(RVC, /if \(q\.error && q\.error\.status === 404\) \{ Toast\.warning\(s\.eCycleGone\); onGone\(\); \}/);
  assert.match(RVC, /const dropGoneCycle = useCallback\(\(\) => patch\(\{ cycle: null, view: null, unit: null \}, \{ clear: \[\.\.\.BOARD_KEYS, \.\.\.REVIEW_FILTER_KEYS\], push: false \}\), \[patch\]\);/);
  assert.match(RVC, /const dropGoneUnit = useCallback\(\(\) => patch\(\{ unit: null \}, \{ clear: REVIEW_FILTER_KEYS, push: false \}\), \[patch\]\);/);
  assert.match(RVC, /onGone=\{\(\) => \{ dropGoneCycle\(\); listQ\.reload\(\); \}\}/);
  assert.match(RVC, /onBack=\{closeUnit\} onGone=\{dropGoneUnit\}/);
  // v2 导出全部条目，明细另有本部门导出
  assert.match(RVC, /downloadReviewCsv\(s, d\.cycle\.name, v2 \? items : shown, !open\)/);
  assert.match(RVC, /\{s\.exportDept\}/);
});

test("O1: a confirmed department reads 'Confirmed · local time · confirmer'", () => {
  assert.equal(T.zh.stConfirmed("2026-10-08 14:05", "Ana Cruz"), "已确认 · 2026-10-08 14:05 · Ana Cruz");
  assert.equal(T.en.stConfirmed("2026-10-08 14:05", "Ana Cruz"), "Confirmed · 2026-10-08 14:05 · Ana Cruz");
  assert.equal(T.en.stConfirmed("2026-10-08 14:05", ""), "Confirmed · 2026-10-08 14:05", "no name → no trailing dot");
  assert.match(RVC, /s\.stConfirmed\(localStamp\(st\.hrConfirmedAt\), confirmerOf\(st\)\)/);
  assert.doesNotMatch(RVC, /s\.stConfirmed\(String\(st\.hrConfirmedAt\)\.slice\(0, 10\)\)/, "not the UTC date slice");
});

test("Review.jsx: the employee's 1-on-1 undo maps self_locked and is hidden once the department is locked", () => {
  const at = REVIEW.indexOf("function EmpOneOnOne");
  assert.ok(at > 0);
  const body = REVIEW.slice(at, REVIEW.indexOf("\nfunction ", at + 10));
  assert.match(body, /self_locked: \(\) => s\.eSelfLocked/);
  assert.match(body, /!item\.selfLocked && <button/);
});
