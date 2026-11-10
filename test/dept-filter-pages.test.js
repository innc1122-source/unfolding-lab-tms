// 第二批 3.1 培训侧部门筛选（2026-10-08，波次 3 W3-B）：培训概览、考试成绩、申请审批、培养项目、课程库都用全站统一的
// DeptFilter（components/DeptFilter.jsx）+ useDeptTree（GET /api/admin/dept-tree），不再各自拼部门下拉。
//   · 源码断言：五个页面都用 DeptFilter；培训概览不再请求 /api/admin/departments、不再有三级 Select；地址栏合并写回
//     （考试成绩只增删 attempt、培养项目读 ?project=&tab=）；按部门加学员 / 指派课程改为多选含下级并带人数确认；
//     放 DeptFilter 的 Semi Modal 都用 dpfModalProps()（motion:false + 内容层 overflow:visible）。
//   · 行为：用真服务的部门树跑 deptfilter.js 的 deptMatcher —— 「按部门」选上级会带上下级部门的人（原来按部门原文精确匹配），
//     且与培训概览 dept= 的服务端口径（deptFilterFor）人数一致。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

const SRC = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8").replace(/\r\n/g, "\n");
const page = (f) => read("pages", "admin", f);
const PAGES = ["Overview.jsx", "Results.jsx", "Requests.jsx", "Projects.jsx", "Content.jsx"];
// 第三批 4.1（2026-10-08）：培训概览拆成容器 Overview.jsx + overview/ 目录；DeptFilter 渲染在 overview/OverviewFilters.jsx
const OV_DIR = path.join(SRC, "pages", "admin", "overview");
const ovFiles = () => fs.readdirSync(OV_DIR).filter((f) => /\.jsx?$/.test(f));
const ovRead = (f) => fs.readFileSync(path.join(OV_DIR, f), "utf8").replace(/\r\n/g, "\n");

// 顶层 function Name(...) { ... } 的函数体：从声明到第一个顶格的「}」（页面里顶层函数的收尾括号都顶格写；
// 不按花括号配平 —— 正则字面量与 JSX 文本里的引号会让配平出错）
function fnBody(src, name) {
  const at = src.search(new RegExp("\\nfunction " + name + "\\("));
  assert.ok(at >= 0, "function " + name + " exists");
  const end = src.indexOf("\n}\n", at + 1);
  assert.ok(end > at, "function " + name + " has a top-level closing brace");
  return src.slice(at, end + 2);
}
const topFunctions = (src) => [...src.matchAll(/\nfunction (\w+)\(/g)].map((m) => m[1]);

// deptfilter.js 的纯函数用 vm 跑（与 deptcal-ui.test.js 同一加载方式）
function loadDeptFilter() {
  let src = read("deptfilter.js");
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]);
  src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "").replace(/^export\s+/gm, "");
  const ctx = vm.createContext({ console, useEffect() {}, useState() {}, api: {} });
  vm.runInContext(src + "\n;globalThis.__x = {" + names.join(",") + "};", ctx);
  return ctx.__x;
}

test("every training-side page uses the shared DeptFilter and the dept-tree cache", () => {
  for (const f of PAGES) {
    if (f === "Overview.jsx") {
      // 容器读部门树、写地址栏；筛选条组件渲染 DeptFilter
      const ov = page(f), bar = ovRead("OverviewFilters.jsx");
      assert.match(ov, /import \{[^}]*\buseDeptTree\b[^}]*\} from '\.\.\/\.\.\/deptfilter\.js';/, "Overview reads the tree through useDeptTree");
      assert.match(bar, /import DeptFilter(, \{[^}]*\})? from '\.\.\/\.\.\/\.\.\/components\/DeptFilter\.jsx';/, "OverviewFilters imports DeptFilter");
      assert.match(bar, /<DeptFilter\b/);
      for (const x of [ov, ...ovFiles().map(ovRead)]) assert.doesNotMatch(x, /\/api\/admin\/departments\b/);
      continue;
    }
    const src = page(f);
    assert.match(src, /import DeptFilter(, \{[^}]*\})? from '\.\.\/\.\.\/components\/DeptFilter\.jsx';/, f + " imports DeptFilter");
    assert.match(src, /import \{[^}]*\buseDeptTree\b[^}]*\} from '\.\.\/\.\.\/deptfilter\.js';/, f + " reads the tree through useDeptTree");
    assert.match(src, /<DeptFilter\b/, f + " renders DeptFilter");
    assert.doesNotMatch(src, /\/api\/admin\/departments\b/, f + " no longer builds its own department list from /api/admin/departments");
  }
});

test("Overview: one DeptFilter in the address bar replaces the three cascading Selects (fixes K1 and the interim group-layer gap)", () => {
  const src = page("Overview.jsx");
  assert.doesNotMatch(src, /fDeptL[123]|pickL[123]|setL[123]|optsOf\(/, "the l1/l2/l3 cascade is gone");
  assert.match(src, /const \[urlp, patchUrl\] = useUrlState\(\);/);
  assert.match(src, /const dept = urlp\.dept \|\| null;/, "dept comes from ?dept=");
  assert.match(src, /const setDept = \(v\) => patchUrl\(\{ dept: v \|\| null \}\);/, "writes merge into the URL, other params kept");
  assert.match(ovRead("OverviewFilters.jsx"), /<DeptFilter options=\{deptOpts\} value=\{dept\} onChange=\{setDept\}[\s\S]{0,200}onInvalid=\{onDeptInvalid\}/);
  assert.match(src, /deptOpts=\{deptOpts\} dept=\{dept\} setDept=\{setDept\} tree=\{tree\}\s+onDeptInvalid=\{onDeptInvalid\}/, "the container hands the URL-bound dept to the filter bar");
  assert.match(src, /const resetFilters = \(\) => \{ setDept\(null\); patchUrl\(Object\.fromEntries\(FILTER_KEYS\.map\(\(k\) => \[k, null\]\)\)\); \};/, "reset clears the dept and every other filter key in the URL");
  // 第三批 4.1：其余筛选也全部在地址栏，组件状态里不再有筛选
  assert.match(ovRead("ovquery.js"), /export const FILTER_KEYS = \['period', 'from', 'to', 'dept', 'cat', 'enroll', 'mode', 'tp', 'programs', 'cohort', 'src'\];/); // 第四批 7：末尾加来源 src
  assert.doesNotMatch(src, /setPeriod\(|setProgs\(|setCohort\(/, "no filter kept in component state any more");
  // 点部门表 / 矩阵列头：落到部门筛选里有的那一级（四级及以下、没人的部门往上找祖先）
  assert.match(fnBodyArrow(src, "focusDept"), /deptOptIds\.has\(String\(cur\.id\)\)/);
  assert.match(ovRead("ProjectCards.jsx"), /nav\('\/admin\/projects\?project=' \+ encodeURIComponent\(t\.id\) \+ '&tab=dash'\)/, "running-program cards deep-link to the program dashboard");
});
// const name = (...) => { ... } 的函数体
function fnBodyArrow(src, name) {
  const at = src.indexOf("const " + name + " = (");
  assert.ok(at >= 0, name + " exists");
  let i = src.indexOf("{", src.indexOf("=>", at)), depth = 0;
  const start = i;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (!depth) return src.slice(start, i + 1); } }
  throw new Error("unbalanced " + name);
}

test("Results: department filter on the rows' department; opening / closing an attempt only touches ?attempt=", () => {
  const src = page("Results.jsx");
  assert.doesNotMatch(src, /useSearchParams|setSearchParams\(/, "no whole-query overwrite left (setSearchParams({}) used to drop the filters)");
  assert.match(src, /patchUrl\(\{ attempt: String\(id\) \}, \{ push: true \}\)/);
  assert.match(src, /patchUrl\(\{ attempt: null \}, \{ push: true \}\)/);
  assert.match(src, /const deptOk = useMemo\(\(\) => deptMatcher\(tree, fDept\), \[tree, fDept\]\);/);
  // CX-150：部门与考试筛选一起圈定范围（部门仍按答卷的 department）
  assert.match(src, /rows\.filter\(\(r\) => \(!fDept \|\| deptOk\(r\.department\)\)/, "filters by attempt.department");
  assert.match(src, /resetOn: \[query, fStatus, fExam, fDept\]/, "changing the department clears the bulk selection");
  assert.match(src, /exportCsvTip\(rows\.length\)/, "the export tooltip still counts every attempt (the file ignores filters)");
});

test("Requests: one DeptFilter above both tables; counts, bulk selection and the bulk dialog use the filtered rows", () => {
  const src = page("Requests.jsx");
  assert.equal((src.match(/<DeptFilter\b/g) || []).length, 1, "a single shared filter");
  assert.match(src, /const enrollRows = useMemo\([\s\S]{0,160}all\.filter\(\(r\) => deptOk\(r\.department\)\)/);
  assert.match(src, /const nomRows = useMemo\([\s\S]{0,160}all\.filter\(\(r\) => deptOk\(r\.department\)\)/);
  assert.match(src, /useBulkSelection\(\{ rows: enrollRows,/);
  assert.match(src, /useBulkSelection\(\{ rows: nomRows,/);
  assert.match(src, /const rows = kind === 'nom' \? nomRows : enrollRows;/, "the bulk confirm lists only what is on screen");
  assert.match(src, /patchUrl\(\{ dept: v \|\| null \}\)/);
});

test("Projects: ?project=&tab= drive the detail (notification deep link to tab=nom); members and rosters filter by department", () => {
  const src = page("Projects.jsx");
  assert.match(src, /const TAB_KEYS = \['dash', 'struct', 'cohort', 'nom', 'set'\];/);
  assert.match(src, /const sel = urlp\.project \|\| null;/);
  assert.match(src, /const tab = TAB_KEYS\.includes\(urlp\.tab\) \? urlp\.tab : 'dash';/);
  assert.match(src, /const tabs = \[\s*\['dash', s\.tabDash\]/, "the board is the first visible tab");
  assert.match(src, /patchUrl\(\{ project: id \|\| null, tab: null, dept: null \}, \{ push: true \}\)/, "open / back push, and clear the detail-only keys");
  assert.match(src, /<Detail key=\{sel\} id=\{sel\}/, "a different project remounts the detail");
  assert.match(fnBody(src, "Detail"), /q\.error\.status === 404/, "a removed program goes back to the list");
  // 期次成员：部门列 + 统一筛选
  const members = fnBody(src, "CohortMembers");
  assert.match(members, /dataIndex: 'department'/);
  assert.match(members, /!deptKey \|\| deptOk\(m\.department\)/);
  assert.match(members, /resetOn: \[needle, deptKey\]/);
  // 签到 / 完成登记名单：弹窗内部状态
  for (const fn of ["CheckinModal", "CompletionModal"]) {
    const b = fnBody(src, fn);
    assert.match(b, /const rd = useRosterDept\(roster, all\);/, fn);
    assert.match(b, /<RosterDeptBar /, fn);
    assert.match(b, /useBulkSelection\(\{ rows, rowKey: 'userId', ready: !!q\.data, resetOn: \[rd\.dept\] \}\)/, fn);
  }
  // 按部门加学员：多选、含下级、人数确认（P3）
  const add = fnBody(src, "AddMembersModal");
  assert.match(add, /<DeptFilter multiple /);
  assert.doesNotMatch(add, /depts\.includes\(r\.department\)/, "no exact-name match any more");
  assert.match(add, /depts\.length && tree \? eligible\.filter\(\(r\) => deptOk\(r\.department\)\)/, "no tree → nobody (never the whole roster)");
  assert.match(add, /content: s\.byDeptConfirm\(resolved\.length\)/);
  assert.match(add, /onOk=\{\(\) => \(mode === 'dept' \? confirmDept\(\) : submit\(false\)\)\}/, "the click event is no longer passed as `force`");
});

test("Content: assign by department = multi-select incl. sub-departments with a head-count confirm; roll-call and assigned list filter by department", () => {
  const src = page("Content.jsx");
  const asg = fnBody(src, "AssignCourseModal");
  assert.match(asg, /<DeptFilter multiple /);
  assert.doesNotMatch(asg, /depts\.includes\(r\.department\)/);
  assert.match(asg, /depts\.length && tree \? eligible\.filter\(\(r\) => deptOk\(r\.department\)\)/);
  assert.match(asg, /content: s\.asgConfirm\(candidates\.fresh\.length\)/);
  assert.match(asg, /dataSource=\{assignedShown\}/);
  const ck = fnBody(src, "CourseCheckinModal");
  assert.match(ck, /<DeptFilter /);
  assert.match(ck, /dataSource=\{rows\}/);
});

test("every Semi Modal that hosts a DeptFilter uses the shared dpfModalProps() helper", () => {
  let checked = 0;
  for (const f of PAGES) {
    const src = page(f);
    for (const name of topFunctions(src)) {
      const b = fnBody(src, name);
      if (!/<Modal\b/.test(b) || !/<DeptFilter\b|<RosterDeptBar\b/.test(b)) continue;
      for (const m of b.matchAll(/<Modal\b[^>]*/g)) {
        assert.match(m[0], /\{\.\.\.dpfModalProps\(\)\}/, `${f} ${name}: ${m[0].slice(0, 80)}`);
        assert.match(m[0], /className="u-modal-visible"/, `${f} ${name}`);
        checked++;
      }
    }
  }
  // 培训概览 overview/ 目录：放 DeptFilter 的文件里每个 Modal 都要 dpfModalProps（手机「筛选」弹窗）
  let ov = 0;
  for (const f of ovFiles()) {
    const src = ovRead(f);
    if (!/<DeptFilter\b/.test(src)) continue;
    for (const m of src.matchAll(/<Modal\b[^>]*/g)) {
      assert.match(m[0], /\{\.\.\.dpfModalProps\(\)\}/, "overview/" + f);
      assert.match(m[0], /className="u-modal-visible"/, "overview/" + f);
      ov++;
    }
  }
  assert.ok(ov >= 1, "the phone filter modal of the training overview: " + ov);
  assert.ok(checked >= 5, "AddMembersModal, CheckinModal, CompletionModal, AssignCourseModal, CourseCheckinModal: " + checked);
});

// ---------- 行为：真服务的部门树 + deptMatcher ----------
let srv, admin;
const ids = {};
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  const mk = async (name, parent) => {
    const r = await admin.post("/api/admin/departments", { name, ...(parent ? { parentId: ids[parent] } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids[name] = r.data.department.id;
  };
  await mk("DFP Ops");
  await mk("DFP Ops North", "DFP Ops");
  await mk("DFP Ops North Shift", "DFP Ops North");
  await mk("DFP Sales");
  for (const [eid, d] of [["DFP-1", "DFP Ops"], ["DFP-2", "DFP Ops North"], ["DFP-3", "DFP Ops North Shift"], ["DFP-4", "dfp ops north "], ["DFP-5", "DFP Sales"]]) {
    const r = await admin.post("/api/admin/employees", { name: "N " + eid, employeeId: eid, department: d, programIds: [] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
});
after(async () => { if (srv) await srv.stopAsync(); });

test("'by department' picks the sub-departments too, and matches the server's overview dept= count", async () => {
  const df = loadDeptFilter();
  const tree = (await admin.get("/api/admin/dept-tree")).data;
  const roster = (await admin.get("/api/admin/roster")).data;
  const ours = roster.filter((r) => /^DFP-/.test(r.employeeId));
  const pick = (sel) => ours.filter((r) => df.deptMatcher(tree, sel)(r.department)).map((r) => r.employeeId).sort();
  // 旧写法：按部门原文精确匹配 —— 只有直挂在 Ops 上的 1 人
  assert.deepEqual(ours.filter((r) => ["DFP Ops"].includes(r.department)).map((r) => r.employeeId), ["DFP-1"]);
  // 新写法：选 Ops = Ops + North + North Shift（三级）+ 原文大小写 / 空白不同的同一部门
  assert.deepEqual(pick([ids["DFP Ops"]]), ["DFP-1", "DFP-2", "DFP-3", "DFP-4"]);
  assert.deepEqual(pick([ids["DFP Ops North"]]), ["DFP-2", "DFP-3", "DFP-4"]);
  assert.deepEqual(pick([ids["DFP Ops North Shift"], ids["DFP Sales"]]), ["DFP-3", "DFP-5"], "multi-select = any of them");
  assert.deepEqual(pick([]), ["DFP-1", "DFP-2", "DFP-3", "DFP-4", "DFP-5"], "no selection = everyone (pages guard the 'by department' mode separately)");
  // 前端整表过滤与培训概览服务端 dept= 同一口径：同一个部门，人数一致
  const people = roster.filter((u) => u.active && !(u.role === "admin" && !u.department && !u.position && !u.hireDate));
  for (const name of ["DFP Ops", "DFP Ops North", "DFP Sales"]) {
    const ov = (await admin.get("/api/admin/overview?dept=" + encodeURIComponent(ids[name]))).data;
    assert.equal(ov.filters.dept, ids[name]);
    const n = people.filter((u) => df.deptMatcher(tree, ids[name])(u.department)).length;
    assert.equal(ov.employees, n, name + ": overview " + ov.employees + " vs DeptFilter " + n);
  }
  // 考试成绩页按行的 department 过滤：接口每行都带这个键
  const att = (await admin.get("/api/admin/attempts")).data;
  for (const a of att) assert.ok("department" in a, "attempt rows carry department");
});
