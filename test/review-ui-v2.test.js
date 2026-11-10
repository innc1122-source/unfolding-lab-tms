// 第二批 2.1 员工端评估页（W2-B，2026-10-08）：读前端源码断言 + 把页面里标明的纯函数段取出来用 vm 实跑。
// 不起服务器、不打包、不碰数据库。覆盖：视图走地址栏（?view=）与默认视图；切页签清参数、先问离开守卫；不引用 Semi；
// 团队评估读 teamRows / teamStats 与 GET team/:id（不再读旧的 team[]）；单人页换人不串数据（审查 P1-7）；
// 员工登记面谈带日期、显示本地日期、撤销条件；直属上级离职的说明按 hod / hr 分；leadV2 不再承诺关键亮点（K4）；
// HoD 页用 /hod?v=2 + DeptCalibration（ready / managerEntryHref / 一次保存）；L2 核对评语提示；首页待办读 teamStats；
// 下属档案进行中周期只显示状态（D8）；app.css 追加段不写死颜色、吸顶按顶栏偏移。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "web", "src");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const REVIEW = read("pages", "Review.jsx");
const TEAM = read("pages", "ReviewTeam.jsx");
const HOME = read("pages", "Home.jsx");
const RP = read("pages", "ReportProfile.jsx");
const DCAL = read("components", "DeptCalibration.jsx");

// 页面里「// ---- 纯函数 … ----」到「// ---- 纯函数到此 ----」之间的代码：去掉 export 后在 vm 里求值
function pureBlock(src, names) {
  const a = src.indexOf("// ---- 纯函数");
  const b = src.indexOf("// ---- 纯函数到此 ----");
  assert.ok(a >= 0 && b > a, "pure-function block markers present");
  const code = src.slice(a, b).replace(/^export /gm, "");
  return vm.runInNewContext(code + "\n;({ " + names.join(", ") + " })", { Date, Number, String, Array, Object, Set, Math });
}
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
// 顶层函数的源码：从签名到下一个顶层 function / const / export / 注释行（够断言用，不解析）
const fnBody = (src, sig) => {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, sig);
  const re = /\r?\n(?:function |const |export |\/\/ )/g;
  re.lastIndex = at + sig.length;
  const hit = re.exec(src);
  return src.slice(at, hit ? hit.index : src.length);
};

test("employee pages: no Semi import; the view lives in the address bar (?view=) and switching asks the leave guard first", () => {
  for (const [f, src] of [["Review.jsx", REVIEW], ["ReviewTeam.jsx", TEAM], ["Home.jsx", HOME], ["ReportProfile.jsx", RP]])
    assert.doesNotMatch(src, /@douyinfe\/semi/, f);
  assert.match(REVIEW, /import \{ useUrlState, REVIEW_FILTER_KEYS \} from '\.\.\/urlstate\.js';/);
  assert.match(REVIEW, /const \[params, patch\] = useUrlState\(\);/);
  assert.match(REVIEW, /if \(k === view \|\| !confirmLeave\(\)\) return;\s*patch\(\{ view: k \}, \{ clear: VIEW_CLEAR_KEYS \}\);/, "push (view changes) and clear the filter / team / unit keys");
  assert.match(REVIEW, /const VIEW_CLEAR_KEYS = \[\.\.\.new Set\(\[\.\.\.REVIEW_FILTER_KEYS, 'unit', \.\.\.TEAM_PARAM_KEYS\]\)\];/);
  assert.match(REVIEW, /if \(d && view && params\.view !== view\) patch\(\{ view \}, \{ push: false \}\);/, "the resolved default is written back with replace");
  // 旧的手机二选一切换（.rv-tabs / tabbed / pane）去掉，桌面和手机都用 .rv-views
  assert.doesNotMatch(REVIEW, /rv-tabs|rv-pane|tabbed|useState\('reviews'\)/);
  // 两个子模块（负责人 2026-10-12）：二级页签只列个人绩效的视图；一级切换只在能看组织互评时出现
  assert.match(REVIEW, /\{!personPage && subViews\.length > 1 && \(\s*<div className=\{'rv-views rv-views-' \+ subViews\.length\} role="tablist"/);
  assert.match(REVIEW, /\{hasOrg && \(\s*<div className="rv-mods" role="tablist"/);
  assert.match(REVIEW, /patch\(\{ view: m === 'org' \? lastOrg\.current \|\| 'org' : back \}, \{ clear: VIEW_CLEAR_KEYS \}\);/, "switching module clears the same keys; back to personal = last personal view or the default");
  // 我的评估常驻、只隐藏（审查 P1-9）
  assert.match(REVIEW, /<div className="rv-mine" hidden=\{view !== 'mine'\}>/);
  // hook 都在提前 return 之前（审查 P1-17）
  const body = fnBody(REVIEW, "export default function Review() {");
  const early = body.indexOf("if (q.error) return");
  assert.ok(early > 0);
  const hooks = [...body.matchAll(/\b(useState|useEffect|useMemo|useCallback|useAsync|useUrlState|useI18n)\(/g)].map((m) => m.index);
  assert.ok(hooks.length >= 6 && hooks.every((i) => i < early), "every hook call sits before the first early return");
});

test("views and default view: mine always; team / hod / history by data; default = my to-do → team to-do → open HoD group → mine", () => {
  const R = pureBlock(REVIEW, ["VIEWS", "viewsOf", "mineTodo", "teamTodo", "probeHod", "hodGroupsOpen", "defaultView"]);
  // 第二批 2.8：consult = 绩效申诉的征询页，只在 /api/me/reviews 的 appealConsults.total > 0 时出现
  // 组织绩效（10/10）：org = 组织互评，只在 /api/me/reviews 的 orgView 为真（一级部门负责人或有过互评任务）时出现
  assert.deepEqual([...R.VIEWS], ["mine", "team", "hod", "history", "consult", "org", "orgrec", "orgres"]);
  const M = pureBlock(REVIEW, ["MODULES", "moduleOf", "personalViews"]);
  assert.deepEqual([...M.MODULES], ["personal", "org"]);
  assert.equal(M.moduleOf("org"), "org");
  for (const v of ["mine", "team", "hod", "history", "consult", null]) assert.equal(M.moduleOf(v), "personal", String(v));
  assert.deepEqual([...M.personalViews(["mine", "team", "hod", "org"])], ["mine", "team", "hod"]);
  assert.deepEqual([...M.personalViews(["mine", "org", "orgrec", "orgres"])], ["mine"]);
  const O = pureBlock(REVIEW, ["orgViews", "moduleOf"]);
  assert.deepEqual([...O.orgViews(["mine", "team", "org", "orgrec", "orgres"])], ["org", "orgrec", "orgres"]);
  assert.equal(O.moduleOf("orgrec"), "org"); assert.equal(O.moduleOf("orgres"), "org");
  assert.deepEqual([...R.viewsOf({ mine: [], teamRows: [], teamStats: [], isHod: false, hasHistory: false, orgView: true })], ["mine", "org", "orgrec", "orgres"]);
  const base = { mine: [], teamRows: [], teamStats: [], isHod: false, hasHistory: false };
  assert.deepEqual([...R.viewsOf(base)], ["mine"]);
  assert.deepEqual([...R.viewsOf({ ...base, appealConsults: { open: 0, total: 1 } })], ["mine", "consult"], "a closed or answered consult still lists the view");
  assert.deepEqual([...R.viewsOf({ ...base, appealConsults: { open: 0, total: 0 } })], ["mine"]);
  assert.deepEqual([...R.viewsOf({ ...base, teamRows: [{ id: "a" }], isHod: true, hasHistory: true })], ["mine", "team", "hod", "history"]);
  assert.deepEqual([...R.viewsOf({ ...base, hasHistory: true, resultVisibleToEmployee: false })], ["mine"], "history hidden when results are not visible");
  const team = { ...base, teamRows: [{ id: "a" }], teamStats: [{ cycleId: "c", todo: { rate: 1, oneOnOne: 0 } }] };
  assert.equal(R.defaultView({ ...team, mine: [{ selfAt: null, selfLocked: false }] }), "mine");
  assert.equal(R.defaultView({ ...team, mine: [{ selfAt: null, selfLocked: true }] }), "team", "a locked self-review is not a to-do");
  assert.equal(R.defaultView(team), "team");
  const hod = { ...base, isHod: true, teamRows: [{ id: "a" }], teamStats: [{ todo: { rate: 0, oneOnOne: 0 } }] };
  assert.equal(R.probeHod(hod), true);
  assert.equal(R.defaultView(hod, undefined), null, "still probing the HoD groups");
  assert.equal(R.defaultView(hod, true), "hod");
  assert.equal(R.defaultView(hod, false), "mine", "every HoD group already submitted");
  assert.equal(R.hodGroupsOpen({ groups: [{ locked: true }, { locked: false }] }), true);
  assert.equal(R.hodGroupsOpen({ groups: [{ locked: true }] }), false);
  assert.equal(R.probeHod({ ...hod, mine: [{ selfAt: null }] }), false, "no probe when the page already knows where to go");
});

test("team view reads teamRows / teamStats and GET team/:id — never the old team[]; the HoD view uses /hod?v=2 + DeptCalibration", () => {
  assert.doesNotMatch(REVIEW, /\bd\.team\b(?!Rows|Stats)/, "Review.jsx no longer reads d.team");
  assert.doesNotMatch(TEAM, /\bdata\.team\b(?!Rows|Stats)/);
  assert.match(TEAM, /data\.teamRows/);
  assert.match(TEAM, /data\.teamStats/);
  assert.match(TEAM, /st\.byStatus/, "chip counts read byStatus");
  assert.match(TEAM, /r\.tags\.includes\(o\.status\)/, "filtering uses the server's tags");
  assert.match(TEAM, /api\.get\(`\/api\/me\/reviews\/team\/\$\{encodeURIComponent\(itemId\)\}`\), \[itemId\]\)/);
  // 换人不串数据（审查 P1-7）：只认 id 对得上的数据；表单按条目 id 重挂；重新加载时禁用提交
  assert.match(TEAM, /const data = q\.data && q\.data\.item && q\.data\.item\.id === itemId \? q\.data : null;/);
  assert.match(TEAM, /<MgrOneOnOne key=\{it\.id\}/);
  assert.match(TEAM, /<MgrRating key=\{it\.id\}/);
  assert.match(TEAM, /busyOuter=\{q\.loading\}/);
  // 离开守卫无条件调用；切人、返回前先确认
  assert.match(TEAM, /\n  useLeaveGuard\(dirty, s\.unsaved\);/);
  assert.match(TEAM, /const go = \(id\) => \{ if \(!id \|\| !confirmLeave\(\)\) return; patch\(\{ item: id \}, \{ push: false \}\); \};/);
  assert.match(TEAM, /if \(!confirmLeave\(\)\) return;\s*if \(fromRoster\.current\)/);
  // v2 评级不再要求面谈；补丁语义只发表单里的字段
  const rating = fnBody(TEAM, "function MgrRating(");
  assert.match(rating, /\(!v2 && !oneDone && !it\.oneOnOneAt\)/, "only the old flow still needs the 1-on-1 ticked before rating");
  assert.match(rating, /if \(v2\) body\.highlights = highlights;\s*else \{ body\.oneOnOneDone = oneDone;/);
  assert.match(rating, /hod_proxied: \(\) => s\.e_hod_proxied/);
  assert.match(rating, /manager_inactive: \(\) => s\.e_manager_inactive/);
  // 面谈独立一张卡：上级一侧 POST one-on-one 带日期与要点
  const one = fnBody(TEAM, "function MgrOneOnOne(");
  assert.match(one, /send\(\{ done: true, date, notes \}, s\.oneLogged\)/);
  assert.match(one, /<input type="date" className="rv-inp" value=\{date\} max=\{today\}/);
  assert.match(one, /date_invalid: \(\) => s\.e_date_invalid/);
  // HoD 页
  assert.match(REVIEW, /api\.get\('\/api\/me\/reviews\/hod\?v=2'\)/);
  assert.doesNotMatch(REVIEW, /\/api\/me\/reviews\/hod\/items\/\$\{/, "no more single-row saves from the page");
  assert.match(REVIEW, /api\.put\('\/api\/me\/reviews\/hod\/items', \{ cycleId: cur\.cycleId, dept1Id: cur\.unit, changes \}\)/);
  assert.match(REVIEW, /api\.post\('\/api\/me\/reviews\/hod\/remind', \{ cycleId: cur\.cycleId, dept1Id: cur\.unit, itemIds \}\)/);
  assert.match(REVIEW, /<DeptCalibration key=\{curKey\} mode="hod" lang=\{lang\} view=\{view\} query=\{query\} onQuery=\{onQuery\} ready=\{ready\}/);
  assert.match(REVIEW, /const ready = !q\.loading && !!sel;/, "filters are validated only once the URL's group is loaded (P1-8)");
  assert.match(REVIEW, /managerEntryHref=\{managerEntryHref\}/);
  assert.match(REVIEW, /const managerEntryHref = \(row\) => `\/review\?view=team&item=\$\{encodeURIComponent\(row\.id\)\}`;/);
  assert.match(REVIEW, /if \(gk\(g\) === curKey \|\| !confirmLeave\(\)\) return;/, "switching department group asks first");
  // 波次 2 复核：保存后回传的视图按组存 —— A 组保存、B 组保存，回到 A 组仍是 A 组保存后的视图
  assert.match(REVIEW, /const \[fresh, setFresh\] = useState\(\{\}\);/);
  assert.match(REVIEW, /if \(r && r\.view\) setFresh\(\(m\) => \(\{ \.\.\.m, \[curKey\]: r\.view \}\)\);/);
  assert.match(REVIEW, /const view = cur \? fresh\[curKey\] \|\| cur\.view : null;/);
  assert.doesNotMatch(REVIEW, /function HodPanel|function HodGroup|function HodRow|function TeamCard/, "old HoD table and team cards are gone");
});

test("team helpers: to-dos, filters, order, the three status columns, the D1 rating gate and prev / next", () => {
  const M = pureBlock(TEAM, ["TEAM_STATUS", "TEAM_PARAM_KEYS", "dayOf", "rowTodo", "teamPendingCount", "pickCycle", "filterTeamRows", "sortTeamRows", "rateState", "selfState", "rateGate", "personOrder", "neighbours"]);
  const row = (o) => ({ id: "x", cycleId: "c1", flow: "v2", name: "N", employeeId: "E", tags: [], overdue: [], ...o });
  const rows = [
    row({ id: "a", name: "Ann", selfAt: "2026-10-01T02:00:00Z", oneOnOneAt: null, tags: ["one", "rate"] }),          // 待评级 + 待面谈
    row({ id: "b", name: "Bob", selfAt: null, oneOnOneAt: "x", selfOverdue: false, tags: ["self", "one"] }),          // 等自评
    row({ id: "c", name: "Cat", selfAt: "y", oneOnOneAt: "x", managerRating: "B", tags: ["rated", "one"] }),
    row({ id: "d", name: "Dan", notCounted: "departed", tags: ["left"] }),
    row({ id: "e", name: "Eve", selfAt: null, selfOverdue: true, oneOnOneAt: "x", tags: ["self", "rate", "one"] }),   // 自评逾期 → 可评
    row({ id: "f", name: "Fay", cycleId: "c2", selfAt: "y", oneOnOneAt: "x", locked: true, tags: ["locked"] }),
  ];
  assert.deepEqual({ ...M.rowTodo(rows[0]) }, { rate: true, one: true });
  assert.deepEqual({ ...M.rowTodo(rows[1]) }, { rate: false, one: false }, "waiting for the self-review: nothing for the manager yet");
  assert.deepEqual({ ...M.rowTodo(rows[3]) }, { rate: false, one: false }, "departed people are never a to-do");
  assert.deepEqual({ ...M.rowTodo(rows[5]) }, { rate: false, one: false }, "locked people are never a to-do");
  assert.equal(M.teamPendingCount(rows), 2, "a + e, each counted once");
  assert.equal(M.pickCycle([{ cycleId: "c1" }, { cycleId: "c2" }], "c2"), "c2");
  assert.equal(M.pickCycle([{ cycleId: "c1" }], "gone"), "c1");
  // 波次 2 复核：没指定周期时落到第一个有待办的周期（默认进团队评估就是因为有待办）
  const two = [{ cycleId: "q4", todo: { rate: 0, oneOnOne: 0 } }, { cycleId: "q3", todo: { rate: 2, oneOnOne: 0 } }];
  assert.equal(M.pickCycle(two), "q3");
  assert.equal(M.pickCycle(two, "q4"), "q4", "an explicit cycle still wins");
  assert.equal(M.pickCycle([{ cycleId: "q4", todo: { rate: 0, oneOnOne: 0 } }]), "q4");
  assert.deepEqual(M.filterTeamRows(rows, { cycle: "c1", status: "rate" }).map((r) => r.id), ["a", "e"]);
  assert.deepEqual(M.filterTeamRows(rows, { cycle: "c1", status: "all", q: "  ev " }).map((r) => r.id), ["e"]);
  assert.deepEqual(M.filterTeamRows(rows, { cycle: "c1", q: "e" }).map((r) => r.id).sort(), ["a", "b", "c", "d", "e"], "employee ID matches too");
  assert.deepEqual([...M.sortTeamRows(rows.filter((r) => r.cycleId === "c1"))].map((r) => r.id), ["a", "e", "b", "c", "d"], "to rate → waiting → done → not counted");
  assert.deepEqual(rows.map(M.rateState), ["todo", "waitSelf", "rated", "left", "todo", "locked"]);
  assert.equal(M.rateState(row({ hodProxied: true })), "proxied");
  assert.equal(M.rateState(row({ selfAt: "y", overdue: ["rate"] })), "overdue");
  assert.deepEqual(rows.slice(0, 5).map(M.selfState), ["done", "pending", "done", "pending", "overdue"]);
  // D1：没交自评且未逾期 → 只给提醒；自评逾期 → 放开；离职 → 可选评级；锁定 / 代评 → 只读
  assert.equal(M.rateGate({ selfAt: null, selfOverdue: false }), "waitSelf");
  assert.equal(M.rateGate({ selfAt: null, selfOverdue: true }), "open");
  assert.equal(M.rateGate({ selfAt: null, notCounted: "departed" }), "open");
  assert.equal(M.rateGate({ selfAt: "y", locked: "dept" }), "locked");
  assert.equal(M.rateGate({ selfAt: "y", hodProxied: true }), "proxied");
  assert.equal(M.rateGate({ selfAt: "y" }), "open");
  // 上一位 / 下一位：按打开时的筛选顺序；当前人不在筛选结果里时退回同周期全部；已经不在名单里的人跳过
  const order = M.personOrder(rows, { cycle: "c1", status: "rate" }, "a");
  assert.deepEqual([...order], ["a", "e"]);
  assert.deepEqual([...M.personOrder(rows, { cycle: "c1", status: "rate" }, "c")], ["a", "e", "b", "c", "d"]);
  const nb = M.neighbours(["a", "b", "c"], "c", rows.filter((r) => r.id !== "b"));
  assert.deepEqual({ ...nb }, { index: 1, total: 2, prev: "a", next: null });
  assert.deepEqual({ ...M.neighbours(["a", "e"], "a", rows) }, { index: 0, total: 2, prev: null, next: "e" });
  // 本地日期（审查 P2：不用 slice(0,10) 的 UTC 日）
  const local = new Date(2026, 9, 8, 7, 30);
  assert.equal(M.dayOf(local.toISOString()), "2026-10-08");
  assert.equal(M.dayOf("2026-10-02"), "2026-10-02");
  assert.equal(M.dayOf(null), "");
  assert.deepEqual([...M.TEAM_PARAM_KEYS], ["cycle", "status", "q", "item"]);
});

test("employee 1-on-1: date field (today, not in the future), local date shown, undo only while not locked; manager gone → hod / hr note", () => {
  const body = fnBody(REVIEW, "function EmpOneOnOne(");
  assert.match(body, /!item\.selfLocked && <button/);
  assert.match(body, /self_locked: \(\) => s\.eSelfLocked/);
  assert.match(body, /date_invalid: \(\) => s\.e_date_invalid/);
  assert.match(body, /<input type="date" className="rv-inp" value=\{date\} max=\{today\}/);
  assert.match(body, /done \? \{ done: true, date \} : \{ done: false \}/);
  assert.match(body, /s\.empOneDone\(localDay\(item\.employeeOneOnOneAt\)\)/);
  assert.doesNotMatch(body, /slice\(0, 10\)/, "no UTC day");
  assert.doesNotMatch(body, /if \(!item\.selfAt\) return/, "v2 no longer needs the self-review first");
  assert.match(body, /if \(item\.managerGone\) return <div className="rv-emp1 muted">\{item\.managerGoneBy === 'hod' \? s\.managerGoneHod : s\.managerGoneHr\}<\/div>;/);
  assert.match(REVIEW, /managerGoneHod: '你目前没有在职的直属上级，本期评级由 HoD 完成/);
  assert.match(REVIEW, /managerGoneHr: '你目前没有在职的直属上级，本期评级由 HR 完成/);
});

test("K4 / L2 wording: the employee lead no longer promises key highlights or comments; the manager form hedges on comment visibility", () => {
  const zh = REVIEW.slice(REVIEW.indexOf("zh: {"), REVIEW.indexOf("en: {"));
  const en = REVIEW.slice(REVIEW.indexOf("en: {"), REVIEW.indexOf("\n};", REVIEW.indexOf("en: {")));
  const line = (src, key) => (src.match(new RegExp(key + ": '([^']*)'")) || [])[1] || "";
  for (const k of ["leadV2", "leadV2Hidden", "histLead"]) {
    assert.ok(line(zh, k) && line(en, k), k + " found in both languages");
    assert.doesNotMatch(line(zh, k), /关键亮点|上级评语/, "zh " + k);
    assert.doesNotMatch(line(en, k), /highlight|comment/i, "en " + k);
  }
  // 上级评语对员工是否可见由服务端一个开关决定：下发了就照说，没下发时说「按公司设置」
  assert.match(TEAM, /function visHint\(s, resultVisible, commentVisible\) \{/);
  assert.match(TEAM, /visTbd: '周期关闭后，员工本人可以看到最终评级；上级评语是否对员工显示，按公司设置。'/);
  // L2：HoD 改了上级评级时提示核对评语，不拦保存
  assert.match(DCAL, /checkComment: '请核对上级评语是否仍与调整后的评级一致'/);
  assert.match(DCAL, /checkComment: 'Check that the manager’s comment still fits the adjusted rating'/);
  assert.match(DCAL, /\{isHod && editable && r\._draft && need === 'adjust' && orig\.managerText !== '' && <div className="rv-hint dcal-gate dcal-cmt">\{s\.checkComment\}<\/div>\}/);
  assert.doesNotMatch(read("deptcal.js"), /checkComment|managerText/, "the hint never enters the save checks");
});

test("home to-do strip reads teamStats and links straight to the right tab; the report profile shows status only for open cycles", () => {
  const at = HOME.indexOf("export function reviewTodoCounts");
  assert.ok(at > 0);
  const src = HOME.slice(at, HOME.indexOf("\nfunction ReviewTodoStrip", at)).replace(/^export /gm, "");
  const counts = vm.runInNewContext(src + "\n;reviewTodoCounts", { Number, Array });
  // 波次 2 复核：「去团队评估」带上第一个有这类待办的周期（首页数字是各周期合计，名单一次只显示一个周期）
  const href = vm.runInNewContext(src + "\n;reviewTeamTodoHref", { Number, Array });
  const st2 = [{ cycleId: "q4", todo: { rate: 0, oneOnOne: 1 }, byStatus: { self: 2 } }, { cycleId: "q3", todo: { rate: 2, oneOnOne: 0 }, byStatus: { self: 0 } }];
  assert.equal(href({ teamStats: st2 }), "/review?view=team&cycle=q3&status=rate");
  assert.equal(href({ teamStats: [st2[0]] }), "/review?view=team&cycle=q4&status=one");
  assert.equal(href({ teamStats: [{ cycleId: "a b", todo: { rate: 0, oneOnOne: 0 }, byStatus: { self: 1 } }] }), "/review?view=team&cycle=a%20b&status=self");
  assert.equal(href({}), "/review?view=team");
  assert.match(HOME, /const teamTo = reviewTeamTodoHref\(d\);/);
  const c = counts({ mine: [{ selfAt: null }, { selfAt: "x" }, { selfAt: null, selfLocked: true }],
    teamStats: [{ todo: { rate: 2, oneOnOne: 1 }, byStatus: { self: 3 } }, { todo: { rate: 1, oneOnOne: 0 }, byStatus: { self: 0 } }] });
  assert.deepEqual({ ...c }, { mySelf: 1, teamRate: 3, teamOne: 1, teamNoSelf: 3 });
  assert.deepEqual({ ...counts({}) }, { mySelf: 0, teamRate: 0, teamOne: 0, teamNoSelf: 0 });
  assert.doesNotMatch(HOME, /d\.team\.filter/, "no longer counts the old team[]");
  assert.match(HOME, /nav\('\/review\?view=mine'\)/);
  assert.match(HOME, /todoGoSelf: '去提交自评', todoGoTeam: '去团队评估'/);
  assert.match(HOME, /todoGoSelf: 'Submit self-review', todoGoTeam: 'Open team reviews'/);
  // 下属档案：进行中周期不显示评级与评语，只显示状态
  // v2 进行中（flow 'v2' 或带 status = { self, one, rated }，W2-A 契约）只显示状态；旧流程进行中照原样
  const sig = "if (p.source === 'open' && (p.flow === 'v2' || (p.status && typeof p.status === 'object'))) ";
  assert.match(RP, /const selfIn = st \? !!\(st\.self === true \|\| st\.selfAt\) : null;/);
  assert.match(RP, /\['both', 'mgr', 'emp', 'none'\]\.includes\(st\.one\) \? st\.one/);
  const open = balanced(RP, RP.indexOf(sig) + sig.length);
  assert.ok(open.length > 50, "open-cycle branch found");
  assert.doesNotMatch(open, /p\.rating|loc\(p, 'rating'\)|p\.summary/);
  assert.match(open, /className="rp-open-st"/);
  assert.doesNotMatch(RP.replace(/\/\*[\s\S]*?\*\//g, ""), /<(input|select|textarea)\b/, "the report profile stays strictly read-only");
});

test("app.css: W2-B appended one block at the end — no hard-coded colours, sticky offsets follow the top bar, phone layouts at 820 / 640", () => {
  const css = read("app.css");
  assert.equal(css.includes("\r\n"), false, "app.css stays LF");
  const at = css.indexOf("/* ===== 第二批 W2-B（2026-10-08）");
  assert.ok(at > 0 && at > css.indexOf("/* ===== 第二批 W1-B"), "appended after the W1-B block");
  const block = css.slice(at).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, "colours come from variables");
  assert.match(block, /\.rvt-pbar\{position:sticky;top:80px;/);
  assert.match(block, /@media \(max-width:900px\)\{\.rvt-pbar\{top:72px\}\}/);
  assert.match(block, /@media \(max-width:820px\)\{[\s\S]*?\.rvt-headrow\{display:none\}/);
  for (const cls of ["rv-view-n", "rv-emp1-date", "rv-hodgroups", "rvt-open", "rvt-cell", "rvt-k", "rvt-bar-fill", "rp-open-st", "dcal-cmt", "home-todo-go"])
    assert.match(block, new RegExp("\\." + cls + "[{ ,.:]"), cls);
  // 页面用到的 rvt-* 类在追加段里都有定义（v2.css 不认识它们）
  const used = new Set([...TEAM.matchAll(/\brvt-[a-z0-9-]+/g)].map((m) => m[0]));
  for (const c of used) assert.match(block, new RegExp("\\." + c + "(?![a-z0-9-])"), c + " has a rule");
});
