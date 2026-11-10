// 培训概览看板（2026-10-06 需求单 #10）：GET /api/admin/overview 的筛选参数与新增字段。
//   - 不带参数：原字段（employees / perProgram / byDept / recent）仍在，另有 deptTree / matrix / trend / filters；
//   - dept=<部门 id> 含下级；programs= 只留选中课程；from/to 按指派日期；cohort=probation|new30；非法值忽略。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN, startServer, loginAs } = require("./helpers.js");

let srv, admin, base, depts;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  base = (await admin.get("/api/admin/overview")).data;
  depts = (await admin.get("/api/admin/departments")).data;
});
after(() => srv.stop());

test("unfiltered payload keeps the legacy fields and adds deptTree / matrix / trend / filters", () => {
  for (const k of ["employees", "perProgram", "byDept", "recent", "deptTree", "matrix", "trend", "filters"]) assert.ok(k in base, k);
  assert.equal(base.trend.length, 12);
  for (const w of base.trend) { assert.match(w.week, /^\d{4}-\d{2}-\d{2}$/); for (const k of ["assigned", "submitted", "passed"]) assert.equal(typeof w[k], "number"); }
  assert.deepEqual(base.filters, { dept: null, programs: [], from: null, to: null, cohort: "all" });
  // 部门树每行：自身人数 / 指派 / 完成 / 逾期 / 考试，parentId 只指向范围内存在的部门
  const ids = new Set(base.deptTree.map((d) => d.id));
  for (const d of base.deptTree) {
    for (const k of ["headcount", "assigned", "done", "overdue", "overduePeople", "attempts", "passed"]) assert.equal(typeof d[k], "number", d.id + "." + k);
    if (d.parentId) assert.ok(ids.has(d.parentId), "parent in tree");
  }
  const heads = base.deptTree.reduce((n, d) => n + d.headcount, 0);
  assert.equal(heads, base.employees, "department headcounts add up to the employee count (incl. the no-department bucket)");
  // 矩阵格的指派合计 = perProgram 的指派合计
  const mxAssigned = base.matrix.reduce((n, m) => n + m.assigned, 0);
  const ppAssigned = base.perProgram.reduce((n, p) => n + p.assigned, 0);
  assert.equal(mxAssigned, ppAssigned);
});

test("dept= narrows to that department and its descendants; an unknown id is ignored", async () => {
  const withPeople = base.deptTree.filter((d) => d.id !== "__none" && d.headcount > 0);
  assert.ok(withPeople.length > 0, "seed data has at least one department with people");
  const d = withPeople[0];
  const r = (await admin.get(`/api/admin/overview?dept=${encodeURIComponent(d.id)}`)).data;
  assert.equal(r.filters.dept, d.id);
  // 该部门 + 下级的人数
  const kids = new Map(); for (const x of base.deptTree) if (x.parentId) { if (!kids.has(x.parentId)) kids.set(x.parentId, []); kids.get(x.parentId).push(x.id); }
  const sub = new Set([d.id]); const stack = [d.id]; while (stack.length) for (const c of kids.get(stack.pop()) || []) if (!sub.has(c)) { sub.add(c); stack.push(c); }
  const expect = base.deptTree.filter((x) => sub.has(x.id)).reduce((n, x) => n + x.headcount, 0);
  assert.equal(r.employees, expect);
  assert.ok(r.employees <= base.employees);
  const bad = (await admin.get("/api/admin/overview?dept=no-such-dept")).data;
  assert.equal(bad.filters.dept, null);
  assert.equal(bad.employees, base.employees);
});

test("programs= keeps only the chosen courses; from/to filter by assignment date; cohort filters people", async () => {
  const pid = base.perProgram[0].id;
  const r = (await admin.get(`/api/admin/overview?programs=${encodeURIComponent(pid)}`)).data;
  assert.deepEqual(r.perProgram.map((p) => p.id), [pid]);
  assert.deepEqual(r.filters.programs, [pid]);
  // 时间：一个未来的区间里没有任何指派
  const future = (await admin.get("/api/admin/overview?from=2999-01-01&to=2999-12-31")).data;
  assert.equal(future.perProgram.reduce((n, p) => n + p.assigned, 0), 0);
  assert.equal(future.filters.from, "2999-01-01");
  // 非法日期忽略
  const badDate = (await admin.get("/api/admin/overview?from=yesterday")).data;
  assert.equal(badDate.filters.from, null);
  // 人员范围：试用期 ≤ 全部；非法值回 all
  const prob = (await admin.get("/api/admin/overview?cohort=probation")).data;
  assert.equal(prob.filters.cohort, "probation");
  assert.ok(prob.employees <= base.employees);
  const junk = (await admin.get("/api/admin/overview?cohort=everyone")).data;
  assert.equal(junk.filters.cohort, "all");
  assert.equal(junk.employees, base.employees);
});

test("overdue rows carry the manager's name field", () => {
  for (const p of base.perProgram) for (const o of p.overdueList) assert.ok("managerName" in o && "userId" in o);
});

// QA 2026-10-06 O5：未知课程 id 与未知部门 id 一样忽略（不再让结果全为 0）
test("programs= with an unknown id is ignored, like an unknown dept id", async () => {
  const r = (await admin.get("/api/admin/overview?programs=no-such-course")).data;
  assert.equal(r.perProgram.length, base.perProgram.length);
  assert.deepEqual(r.filters.programs, []);
});

// QA 2026-10-06 O2：完成情况 CSV 跟随看板筛选（dept 含下级、programs、from/to、cohort）；不带参数 = 全部
test("completion.csv follows the overview filters", async () => {
  const csvRows = async (q) => {
    const res = await admin.raw("GET", "/api/admin/export/completion.csv" + q);
    assert.equal(res.status, 200);
    return (await res.text()).trim().split(/\r?\n/).length - 1;
  };
  const all = await csvRows("");
  const prog = base.perProgram.find((p) => (p.done || 0) + (p.inprog || 0) + (p.overdue || 0) + (p.notstarted || 0) > 0);
  const one = await csvRows("?programs=" + encodeURIComponent(prog.id));
  assert.ok(one > 0 && one <= all, `one course: ${one} of ${all}`);
  const empty = base.perProgram.find((p) => (p.done || 0) + (p.inprog || 0) + (p.overdue || 0) + (p.notstarted || 0) === 0);
  if (empty) assert.equal(await csvRows("?programs=" + encodeURIComponent(empty.id)), 0, "a course nobody is assigned to exports no rows");
  const future = await csvRows("?from=2999-01-01");
  assert.equal(future, 0, "no assignment in the future window");
  assert.equal(await csvRows("?programs=no-such-course"), all, "unknown course id ignored");
});

// 第二批 3.1（2026-10-08，波次 2 W2-A）：培训概览与 completion.csv 的 dept= 改走全站部门筛选口径（deptFilterFor）。
// 集团层（Lark L0–L2，meta larksync.groupDepts）不算祖先：集团之下的第一层是一级部门，部门树里它的 parentId 为空，
// 矩阵按它归列；选集团节点只圈直接挂在集团节点上的人（修掉 K2）。"__none" = 没有部门的人。
test("group layer: not an ancestor in the department tree, the matrix or the dept= filter (overview and completion.csv)", async () => {
  const { DatabaseSync } = require("node:sqlite");
  const mk = async (name, parentId) => {
    const r = await admin.post("/api/admin/departments", { name, ...(parentId ? { parentId } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.department.id;
  };
  const grp = await mk("OF Group"), region = await mk("OF Region", grp), fin = await mk("OF Finance", region), ap = await mk("OF Finance AP", fin);
  const db = new DatabaseSync(srv.dbPath);
  try { db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('larksync.groupDepts', ?)").run(JSON.stringify([grp, region])); } finally { db.close(); }
  for (const [eid, d] of [["OF-CEO", "OF Group"], ["OF-F1", "OF Finance"], ["OF-F2", "OF Finance AP"], ["OF-N1", null]]) {
    const r = await admin.post("/api/admin/employees", { name: "N " + eid, employeeId: eid, ...(d ? { department: d } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const all = (await admin.get("/api/admin/overview")).data;
  const row = (id) => all.deptTree.find((d) => d.id === id);
  assert.equal(row(fin).parentId, null, "the first layer under the group layer is a root (level 1)");
  assert.equal(row(ap).parentId, fin);
  assert.equal(row(grp).parentId, null);
  assert.equal(row(region).parentId, null, "group nodes don't chain to each other either");
  // 矩阵：Finance 子树的人归到 OF Finance 列，不会塌进集团节点
  const finCells = all.matrix.filter((m) => m.deptId === fin);
  assert.ok(finCells.length > 0, "OF Finance has its own matrix column: " + JSON.stringify(all.matrix.map((m) => m.deptId)));
  assert.ok(finCells.reduce((n, m) => n + m.assigned, 0) >= 2, "both OF-F1 and OF-F2 are counted under OF Finance");
  const onGroup = (await admin.get(`/api/admin/overview?dept=${encodeURIComponent(grp)}`)).data;
  assert.equal(onGroup.filters.dept, grp);
  assert.equal(onGroup.employees, 1, "selecting a group node only takes the people sitting on it directly");
  const onFin = (await admin.get(`/api/admin/overview?dept=${encodeURIComponent(fin)}`)).data;
  assert.equal(onFin.employees, 2, "OF Finance includes its sub-department");
  const none = (await admin.get("/api/admin/overview?dept=__none")).data;
  assert.equal(none.filters.dept, "__none");
  assert.ok(none.employees >= 1 && none.employees < all.employees, "OF-N1 has no department; people with one are not included");
  const csvIds = async (q) => {
    const res = await admin.raw("GET", "/api/admin/export/completion.csv" + q);
    assert.equal(res.status, 200);
    return new Set((await res.text()).trim().split(/\r?\n/).slice(1).map((l) => l.split(",")[0].replace(/^\uFEFF?"?|"$/g, "")));
  };
  assert.deepEqual([...await csvIds("?dept=" + encodeURIComponent(grp))], ["OF-CEO"]);
  assert.deepEqual([...await csvIds("?dept=" + encodeURIComponent(fin))].sort(), ["OF-F1", "OF-F2"]);
});
