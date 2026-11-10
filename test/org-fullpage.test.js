// 员工与组织模块的抽屉改整页（2026-10-07，需求 (3)，负责人「短操作弹窗、长编辑整页」）—— 静态护栏。
//   · 档案「编辑资料」→ #/admin/people/:id?edit=1；名册「新增 / 编辑 / 查看学习记录」→ #/admin/employees?new=1 / ?edit=<id> / ?learn=<id>；
//     部门「HoD 名单」→ #/admin/departments?view=hod。地址栏是唯一事实源，三个文件都不再用 SideSheet。
//   · 两个编辑整页有未保存守卫（返回 / 取消弹确认，挂 beforeunload）；名册与部门表回到列表时保留页码（useDataVersion + clampPage）。
//   · 名册编辑页的 editingId 必须由地址栏参数推出（否则 ?edit=<id> 时工号框可编辑、校验报「工号已存在」，或走了新建接口）。
//   · 名册整页根元素不用 emp-wrap（v2.css 在宽屏把 .v2-page-employees .emp-wrap 排成网格区域）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN_DIR = path.join(__dirname, "..", "web", "src", "pages", "admin");
const src = (f) => fs.readFileSync(path.join(ADMIN_DIR, f), "utf8");

test("no SideSheet left in People, Employees and Departments", () => {
  for (const f of ["People.jsx", "Employees.jsx", "Departments.jsx"]) assert.ok(!src(f).includes("SideSheet"), f + " still uses SideSheet");
});

test("the address bar drives the full pages: ?edit=1 / ?edit= ?new= ?learn= / ?view=hod", () => {
  assert.ok(src("People.jsx").includes("searchParams.get('edit') === '1'"), "People: ?edit=1");
  const emp = src("Employees.jsx");
  for (const k of ["learn", "edit", "new"]) assert.ok(emp.includes(`get('${k}')`), "Employees: ?" + k + "=");
  assert.ok(src("Departments.jsx").includes("get('view') === 'hod'"), "Departments: ?view=hod");
});

test("both edit pages guard unsaved changes (confirm on back / cancel, beforeunload)", () => {
  for (const f of ["People.jsx", "Employees.jsx"]) {
    const s = src(f);
    assert.ok(s.includes("Modal.confirm({ title: s.discardTitle"), f + ": discard confirm");
    assert.ok(s.includes("beforeunload"), f + ": beforeunload");
  }
});

test("roster and department table keep their page when coming back (useDataVersion + clampPage)", () => {
  for (const f of ["Employees.jsx", "Departments.jsx"]) {
    const s = src(f);
    assert.ok(s.includes("useDataVersion("), f + ": useDataVersion");
    assert.ok(s.includes("clampPage("), f + ": clampPage");
  }
});

test("Employees: editingId comes from the address bar, not a stale useState; the page root is not emp-wrap", () => {
  const s = src("Employees.jsx");
  assert.ok(!s.includes("useState(null); // null => creating"), "the old editingId state is gone");
  assert.match(s, /const editingId = editParam\b/, "editingId is derived from ?edit=");
  assert.ok(s.includes('className="wrap emp-page'), "full-page root uses emp-page");
  assert.ok(!/className="wrap emp-wrap emp-(edit|learn)-page/.test(s), "full-page root must not use emp-wrap");
});
