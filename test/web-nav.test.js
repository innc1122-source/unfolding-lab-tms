// 员工端信息架构（批次 3 S5 第一段；IA 方案 1.2–1.4）：顶栏「培训▾」下拉、手机底栏四项、「培训」中转页 /learn 与页头模块路径。
// 读前端源码（构建前的 JSX）；培训入口表 learningnav.js 按源码求值，核对真实的显示条件与路由判定。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// learningnav.js 去掉 import 与 export 后求值（react 与 api 用桩），取出纯函数与入口表
function learningNav() {
  const src = read("web", "src", "learningnav.js").replace(/^import .*$/gm, "").replace(/^export /gm, "");
  return new Function("useEffect", "useState", "api", "fetchMyProjects", src + "\nreturn { LEARNING_ITEMS, isLearningPath, visibleLearningItems };")(() => {}, (v) => [v, () => {}], {}, () => Promise.resolve({}));
}

test("web nav: the Learning menu lists My Courses, Public Courses, Development Programs, My Sessions, My Classes, Team Learning in that order, each behind its condition", () => {
  const N = learningNav();
  assert.deepEqual(N.LEARNING_ITEMS.map((x) => [x.id, x.to, x.zh, x.en]), [
    ["courses", "/learning", "我的课程", "My Courses"], // F59（负责人 2026-10-09）
    ["catalog", "/catalog", "公开课", "Public Courses"], // F59；第四批 7：有公开课程时才显示（hasCatalog）
    ["programs", "/projects", "发展项目", "Development Programs"],
    ["sessions", "/sessions", "我的授课", "My Sessions"],
    ["classes", "/classes", "我的班级", "My Classes"],
    ["team", "/team", "团队学习", "Team Learning"],
  ]);
  const ids = (st) => N.visibleLearningItems(st).map((x) => x.id);
  assert.deepEqual(ids({ learningOn: false, hasProjects: true, roles: { trainer: true, classHead: true, manager: true } }), [], "learning off → no Learning menu at all");
  assert.deepEqual(ids({ learningOn: true, hasProjects: false, roles: {} }), ["courses"], "Courses is always there while learning is on");
  assert.deepEqual(ids({ learningOn: true, hasProjects: true, roles: { manager: true } }), ["courses", "programs", "team"]);
  assert.deepEqual(ids({ learningOn: true, hasProjects: true, roles: { trainer: true, classHead: true, manager: true } }), ["courses", "programs", "sessions", "classes", "team"], "people holding several roles see every entry");
  assert.deepEqual(ids({ learningOn: true, hasProjects: false, hasCatalog: true, roles: {} }), ["courses", "catalog"], "the catalog shows once it has a public course");
  assert.deepEqual(ids({ learningOn: false, hasCatalog: true, roles: {} }), [], "learning off → no catalog either");
  for (const x of N.LEARNING_ITEMS) assert.ok(x.hubZh && x.hubEn, x.id + ": the hub page has a description in both languages");
});

test("web nav: learning routes light up the Learning menu and tab; a report's profile (/team/:id) is not a learning route", () => {
  const N = learningNav();
  for (const p of ["/learn", "/learning", "/catalog", "/projects", "/projects/p1", "/sessions", "/classes", "/team", "/team/", "/course/c1", "/program/p1", "/exam-prep/p1/e1", "/exam/e1", "/result/a1"])
    assert.equal(N.isLearningPath(p), true, p);
  for (const p of ["/", "/record", "/review", "/team/u1", "/change-password", "/admin", "/learner", "/courses", "/examples"])
    assert.equal(N.isLearningPath(p), false, p);
});

test("web nav: the top bar is Home · Learning▾ · Development Record · Performance Reviews · Action 3+3 Challenge; the menu is keyboard operable", () => {
  const top = read("web", "src", "components", "TopBar.jsx");
  const order = ["t('navHome')", "<LearningMenu", "t('navRecord')", "t('navReview')", "s.culLearner"].map((k) => top.indexOf(k));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "fixed order");
  assert.match(top, /\{learning\.items\.length > 0 && <LearningMenu items=\{learning\.items\} lang=\{lang\} label=\{t\('navLearningGroup'\)\} \/>\}/);
  assert.match(top, /aria-haspopup="menu" aria-expanded=\{open\}/);
  assert.match(top, /role="menuitem"/);
  assert.match(top, /if \(e\.key !== 'ArrowDown' && e\.key !== 'ArrowUp'\) return;/);
  assert.match(top, /if \(e\.key === 'Escape'\)/);
  assert.match(top, /const current = isLearningPath\(pathname\);/);
  assert.doesNotMatch(top, /我的项目|My Projects|我的团队|My Team'/, "old flat entries are gone");
  // 第二批 3.3：后台入口从头像菜单移到顶栏右侧「进入后台」按钮（与后台的「返回员工端」对称），判据 hasConsoleAccess(user)
  assert.match(top, /\{hasConsoleAccess\(user\) && \(\s*<Link className="adm-exit v2-view-switch" to="\/admin" title=\{s\.enterConsole\} aria-label=\{s\.enterConsole\}><UtilIcon kind="swap" \/><span className="v2-control-label">\{s\.enterConsole\}<\/span><\/Link>/);
  assert.doesNotMatch(top, /nav\('\/admin'\)/, "the avatar menu no longer carries a console entry");
  const i18n = read("web", "src", "i18n.jsx");
  for (const re of [/navLearningGroup: '培训', navLearning: '我的课程', navRecord: '成长档案', navReview: '绩效评估'/, /navLearningGroup: 'Learning', navLearning: 'My Courses', navRecord: 'Development Record', navReview: 'Performance Reviews'/,
    /adminConsole: '人才管理后台'/, /adminConsole: 'Talent Console'/, /tabRecord: '成长档案', tabReview: '绩效', trailLabel: '当前位置'/, /tabRecord: 'Records', tabReview: 'Performance', trailLabel: 'You are here'/])
    assert.match(i18n, re);
});

test("web nav: 'Go to Console' (batch 2, 3.3) mirrors the console's 'Back to Employee View' and shares one access rule with the /admin gate", async () => {
  const { pathToFileURL } = require("url");
  const rbac = await import(pathToFileURL(path.join(ROOT, "web", "src", "rbac.js")).href);
  assert.equal(rbac.hasConsoleAccess(null), false);
  assert.equal(rbac.hasConsoleAccess({ role: "employee" }), false, "old /api/me without adminRoleId: role decides");
  assert.equal(rbac.hasConsoleAccess({ role: "employee", adminRoleId: null }), false);
  assert.equal(rbac.hasConsoleAccess({ role: "admin" }), true, "super admin");
  assert.equal(rbac.hasConsoleAccess({ role: "employee", adminRoleId: 3 }), true, "a custom console role");
  assert.equal(rbac.hasConsoleAccess({ role: "employee", adminRoleId: 0 }), true, "id 0 is still a role (!= null, not truthiness)");
  const top = read("web", "src", "components", "TopBar.jsx");
  const right = top.slice(top.indexOf('<div className="top-right">'), top.indexOf('<div className="usermenu"'));
  assert.ok(right.indexOf('to="/admin"') > 0 && right.indexOf('to="/admin"') < right.indexOf("lang-toggle"), "the button sits first in .top-right, before the language switch — same slot as the console's exit link");
  assert.match(top, /enterConsole: '进入后台'/);
  assert.match(top, /enterConsole: 'Go to Console'/);
  const adm = read("web", "src", "components", "AdminLayout.jsx");
  assert.match(adm, /<Link className="adm-exit v2-view-switch" to="\/" title=\{s\.exit\} aria-label=\{s\.exit\}><UtilIcon kind="swap" \/><span className="v2-control-label">\{s\.exit\}<\/span><\/Link>/, "the console side it mirrors");
  const app = read("web", "src", "App.jsx");
  assert.match(app, /if \(user && isAdminPath\(pathname\) && !hasConsoleAccess\(user\)\) return <Navigate to="\/" replace \/>;/);
  for (const [f, src] of [["App.jsx", app], ["TopBar.jsx", top]])
    assert.doesNotMatch(src, /user\.role === 'admin' \|\| user\.adminRoleId != null/, f + ": no private copy of the rule left");
  // 审查 P1-6：头像菜单的程序化跳转（改密、退出）先问全局离开守卫；「进入后台」是链接，由守卫的捕获阶段拦截负责
  assert.match(top, /import \{ confirmLeave \} from '\.\/useLeaveGuard\.js';/);
  assert.match(top, /onClick=\{\(\) => \{ if \(!confirmLeave\(\)\) return; setOpen\(false\); nav\('\/change-password'\); \}\}/);
  assert.match(top, /onClick=\{\(\) => \{ if \(confirmLeave\(\)\) logout\(\); \}\}/);
});

test("web nav: the phone tab bar has four tabs (Home · Learning · Records · Performance) with full-name aria-labels, three when learning or performance is off", () => {
  const bar = read("web", "src", "components", "MobileTabBar.jsx");
  const tabs = [...bar.matchAll(/<NavLink to="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["/", "/learn", "/record", "/review"]);
  assert.match(bar, /\{on\('learning'\) && \(\s*<NavLink to="\/learn"/);
  assert.match(bar, /\{on\('performance'\) && \(\s*<NavLink to="\/review"/);
  assert.match(bar, /aria-label=\{t\('navRecord'\)\}>[\s\S]*?<span>\{t\('tabRecord'\)\}<\/span>/, "short label shown, full name read");
  assert.match(bar, /aria-label=\{t\('navReview'\)\}>[\s\S]*?<span>\{t\('tabReview'\)\}<\/span>/);
  assert.match(bar, /className=\{\(\) => cls\(\{ isActive: learnOn \}\)\}/, "every learning route selects the Learning tab");
  assert.doesNotMatch(bar, /to="\/sessions"|to="\/classes"|to="\/team"|to="\/projects"|culture/, "no role tabs, no projects tab, no Action 3+3 Challenge tab");
});

test("web nav: /learn is the Learning hub, inside the learning switch; it renders the same entry table", () => {
  const app = read("web", "src", "App.jsx");
  const gate = app.slice(app.indexOf("{on('learning') && ("), app.indexOf("</>", app.indexOf("{on('learning') && (")));
  assert.match(gate, /<Route path="\/learn" element=\{<LearningHub \/>\} \/>/);
  const hub = read("web", "src", "pages", "LearningHub.jsx");
  assert.match(hub, /const \{ items \} = useLearningNav\(user\);/);
  assert.match(hub, /title: '培训', lead: '课程、发展项目，以及讲师、班主任和经理的培训工作入口'/);
  assert.match(hub, /title: 'Learning', lead: 'Courses, development programs, and tools for trainers, class coordinators and managers'/);
  assert.match(hub, /<ModuleTrail items=\{\[\{ label: s\.title \}\]\} \/>/);
});

test("web nav: every learning page and the Development Record render ModuleTrail with the table's segments; the exam runner's trail is not clickable", () => {
  const trail = read("web", "src", "components", "ModuleTrail.jsx");
  assert.match(trail, /<nav className="crumb" aria-label=\{t\('trailLabel'\)\}>/);
  assert.match(trail, /<span className="sep" aria-hidden="true">›<\/span>/);
  assert.match(trail, /aria-current=\{last \? 'page' : undefined\}/, "the last segment is the current page and never a link");
  assert.match(trail, /const hub = \{ label: lang === 'zh' \? '培训' : 'Learning', to: '\/learn' \};/, "the first segment links to the hub");
  const page = (f) => read("web", "src", "pages", f);
  const expect = {
    "MyLearning.jsx": /<ModuleTrail items=\{learnTrail\(lang, 'courses'\)\} \/>/,
    "MyProjects.jsx": /<ModuleTrail items=\{learnTrail\(lang, 'programs'\)\} \/>/,
    "MySessions.jsx": /<ModuleTrail items=\{learnTrail\(lang, 'sessions'\)\} \/>/,
    "MyClasses.jsx": /<ModuleTrail items=\{learnTrail\(lang, 'classes'\)\} \/>/,
    "MyTeam.jsx": /<ModuleTrail items=\{learnTrail\(lang, 'team'\)\} \/>/,
    "ProgramDetail.jsx": /<ModuleTrail items=\{\[\.\.\.trailHead\(lang, loc\), \{ label: loc\(p, 'title'\) \}\]\} \/>/,
    "Course.jsx": /<ModuleTrail items=\{\[\.\.\.trailHead\(lang, loc\), \{ label: loc\(data, 'title'\), to: withFrom\(`\/program\/\$\{data\.programId\}`, trailSrc\) \}, \{ label: current \? loc\(current, 'title'\) : '' \}\]\} \/>/,
    "ExamPrep.jsx": /<ModuleTrail items=\{\[\.\.\.trailHead\(lang, loc\), \{ label: loc\(program, 'title'\), to: withFrom\(`\/program\/\$\{programId\}`, trailSrc\) \}, \{ label: examTitle \}\]\} \/>/,
    "Result.jsx": /<ModuleTrail items=\{\[\.\.\.trailHead\(lang, loc\), \{ label: loc\(data, 'programTitle'\) \|\| title, to: data\.programId \? withFrom\(`\/program\/\$\{data\.programId\}`, trailSrc\) : undefined \}, \{ label: s\.examResult \}\]\} \/>/,
    "ProjectHome.jsx": /<ModuleTrail items=\{\[\.\.\.learnTrail\(lang, 'programs'\), \{ label: loc\(data, 'title'\) \}\]\} \/>/,
    "Record.jsx": /<ModuleTrail items=\{\[\{ label: s\.title \}\]\} \/>/,
    // 两个子模块（2026-10-12）：能看组织互评的人多一段「个人绩效 / 组织绩效」，其余人仍只有「绩效评估」
    "Review.jsx": /<ModuleTrail items=\{hasOrg \? \[\{ label: s\.title, to: '\/review' \}, \{ label: modName\[mod\] \}\] : \[\{ label: s\.title \}\]\} \/>/,
  };
  for (const [f, re] of Object.entries(expect)) {
    const src = page(f);
    assert.match(src, re, f);
    assert.doesNotMatch(src, /<div className="crumb">/, f + ": no hand-written breadcrumb left");
  }
  const runner = page("ExamRunner.jsx");
  assert.match(runner, /<ModuleTrail items=\{\[\.\.\.trailHead\(lang, loc\), \{ label: s\.finalExam \}\]\} locked \/>/);
  const examHead = runner.slice(runner.indexOf('<div className="crumb exam-crumb">'), runner.indexOf("</div>", runner.indexOf('<div className="crumb exam-crumb">')));
  assert.doesNotMatch(examHead, /<a |<Link|onClick/, "nothing in the exam header navigates away");
  // 下属档案：按来源；两个模块都关时只显示姓名
  const rp = page("ReportProfile.jsx");
  assert.match(rp, /const fromReview = reviewOn && \(\(navState && navState\.from === 'review'\) \|\| !teamOn\);/);
  assert.match(rp, /: teamOn \? learnTrail\(lang, 'team'\) : \[\];/);
  // 第二批 2.1：「下属评估」改名「团队评估」；第二段回到 /review?view=team，从单人评估页进来时按 state.back 回到原单人页（含 &item=）
  assert.match(rp, /trailReview: '绩效评估', trailTeamReviews: '团队评估'/);
  assert.match(rp, /trailReview: 'Performance Reviews', trailTeamReviews: 'Team Reviews'/);
  assert.doesNotMatch(rp, /下属评估/);
  assert.match(rp, /navState\.back\.startsWith\('\/review\?'\) \? navState\.back : '\/review\?view=team'/);
  assert.match(rp, /\{ label: s\.trailTeamReviews, to: reviewBack \}/);
  const team = page("ReviewTeam.jsx");
  assert.match(team, /state=\{\{ from: 'review', back: selfHref \}\}/, "the person page hands its own address to the profile");
  assert.match(team, /<ModuleTrail items=\{\[\{ label: s\.trailRoot, to: '\/review' \}, \{ label: s\.trailTeam, onClick: onBack \}, \{ label: name \|\| '…' \}\]\} \/>/, "Performance Reviews › Team reviews › name");
  assert.match(team, /trailRoot: '绩效评估', trailTeam: '团队评估'/);
});

test("web nav: a course opened from a development program keeps the program in its trail (D-29) — the source rides in ?from=project:<id> across every page of the chain", () => {
  const src = read("web", "src", "trailsource.js").replace(/^import .*$/gm, "").replace(/^export /gm, "");
  const T = new Function("useEffect", "useState", "useLocation", "fetchMyProjects", "learnTrail", src + "\nreturn { readTrailSource, withFrom };")(() => {}, (v) => [v, () => {}], () => ({}), () => Promise.resolve({}), () => []);
  assert.deepEqual(T.readTrailSource("?from=project%3Atp-12"), { kind: "project", id: "tp-12" });
  assert.equal(T.readTrailSource("?from=project:../x"), null, "only a plain id");
  assert.equal(T.readTrailSource(""), null);
  assert.equal(T.withFrom("/course/c1", { kind: "project", id: "tp-12" }), "/course/c1?from=project%3Atp-12");
  assert.equal(T.withFrom("/course/c1", null), "/course/c1", "no source, path unchanged");
  const page = (f) => read("web", "src", "pages", f);
  assert.match(page("ProjectHome.jsx"), /nav\(withFrom\(`\/course\/\$\{a\.courseId\}`, \{ kind: 'project', id \}\)\)/);
  for (const [f, re] of [["ProgramDetail.jsx", /nav\(withFrom\(`\/course\/\$\{c\.id\}`, trailSrc\)\)/], ["Course.jsx", /nav\(withFrom\(`\/exam-prep\/\$\{data\.programId\}\/\$\{e\.id\}`, trailSrc\)\)/],
    ["ExamPrep.jsx", /nav\(withFrom\(`\/exam\/\$\{examId\}`, trailSrc\)\)/], ["ExamRunner.jsx", /nav\(withFrom\(`\/result\/\$\{data\.attemptId\}`, trailSrc\), \{ state: result \}\)/]])
    assert.match(page(f), re, f + " carries the source to the next page");
  for (const f of ["ProgramDetail.jsx", "Course.jsx", "ExamPrep.jsx", "ExamRunner.jsx", "Result.jsx"]) assert.doesNotMatch(page(f), /learnTrail\(lang, 'courses'\)/, f + " uses the source-aware head");
});

test("web nav: the console sidebar under the IA 5.6 module combinations — only performance, only talent, only culture, learning off — never shows a group without its module", async () => {
  const { pathToFileURL } = require("url");
  const rbac = await import(pathToFileURL(path.join(ROOT, "web", "src", "rbac.js")).href);
  const superAdmin = { role: "admin", isSuperAdmin: true };
  const groupsFor = (modules) => {
    const user = { ...superAdmin, modules };
    return rbac.ADMIN_NAV_GROUPS.filter((g) => rbac.navPages(g).some((p) => rbac.canSeeAdminPath(user, p.path)) || rbac.adminExternalLinks(user, g).length > 0);
  };
  const ALL_OFF = { learning: false, performance: false, talent: false, culture: false };
  assert.deepEqual(groupsFor({ ...ALL_OFF, performance: true }), ["shell", "people", "performance", "system"]);
  assert.deepEqual(rbac.navPages("performance").slice(0, 2).map((p) => p.path), ["/admin/perf-dashboard", "/admin/reviews"], "performance dashboard is the first item in its sidebar group");
  // 2026-10-06：人才盘点并入「绩效与人才」组（rbac.js group 'performance'），只开 talent 时也显示这一组
  assert.deepEqual(groupsFor({ ...ALL_OFF, talent: true }), ["shell", "people", "performance", "system"]);
  assert.deepEqual(groupsFor({ ...ALL_OFF, culture: true }), ["shell", "people", "culture", "system"], "a Behavior Practice group holding only the Action 3+3 Challenge link");
  assert.deepEqual(groupsFor({ learning: false, performance: true, talent: true, culture: true }), ["shell", "people", "performance", "culture", "system"], "learning off: no Learning group");
  assert.deepEqual(groupsFor({ learning: true, performance: true, talent: true, culture: true }), ["shell", "people", "performance", "culture", "learning", "system"]);
  // 员工端：learning 关闭时底栏三项（首页 · 成长档案 · 绩效）、没有「培训▾」；/learn 在 learning 开关内（见上一项）
  const top = read("web", "src", "components", "TopBar.jsx");
  assert.match(top, /\{learning\.items\.length > 0 && <LearningMenu/, "the Learning menu needs at least one visible item, i.e. learning on");
  const N = learningNav();
  assert.deepEqual(N.visibleLearningItems({ learningOn: false, hasProjects: true, roles: { trainer: true } }), []);
});

test("web nav: page titles match the navigation names", () => {
  const page = (f) => read("web", "src", "pages", f);
  for (const [f, zh, en] of [["MyLearning.jsx", "我的课程", "My Courses"], ["MyProjects.jsx", "发展项目", "Development Programs"], ["MyTeam.jsx", "团队学习", "Team Learning"], ["Record.jsx", "成长档案", "Development Record"]]) {
    const src = page(f);
    assert.match(src, new RegExp("title: '" + zh + "'"), f);
    assert.match(src, new RegExp("title: '" + en + "'"), f);
  }
  assert.match(page("MyLearning.jsx"), /lead: '指派给你和你自主加入的课程'/); // 第四批 7：自主学习的课程也在这一页
});
