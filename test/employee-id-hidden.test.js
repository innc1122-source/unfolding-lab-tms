// 第三批 9.1 员工端不显示工号 + 8.5「我的评估」行宽（B3-G7，2026-10-08）：只读前端源码断言，不起服务器、不碰数据库。
// 员工端（含经理 / HoD 看到的团队评估、部门校准、下属档案、班级与签到名单、征询页、账号菜单）只显示姓名、职位、职级、
// 汇报关系；搜索仍可按工号。后台 HR 部门明细（DeptCalibration mode="hr"）照旧显示工号。
// 例外：课件水印上的本人姓名 + 工号（5.6，可追溯），不在本测试范围。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web", "src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8");

// JSX 里把某个对象的 employeeId 直接渲染出来：{r.employeeId}、{user && user.employeeId}、`${u.employeeId}`
const RENDERED = /\{\s*(?:[\w.]+\s*&&\s*)?[\w.]+\.employeeId\s*\}|\$\{[^}]*\.employeeId[^}]*\}/;

const EMPLOYEE_PAGES = [
  "pages/MyTeam.jsx", "pages/MyClasses.jsx", "pages/MySessions.jsx", "pages/ReportProfile.jsx",
  "pages/ReviewTeam.jsx", "pages/ReviewAppeal.jsx", "pages/Review.jsx", "components/TopBar.jsx",
];

test("9.1: employee-side pages never render an employee ID", () => {
  for (const f of EMPLOYEE_PAGES) {
    const src = read(f);
    assert.doesNotMatch(src, RENDERED, `${f} renders an employeeId`);
    // 数组拼接的元信息行（[r.employeeId, r.position].join(' · ')）也算显示
    assert.doesNotMatch(src, /\[[^\]\n]*\.employeeId[^\]\n]*\]\s*\.filter\(Boolean\)/, `${f} joins an employeeId into a meta line`);
  }
});

test("9.1: DeptCalibration shows the employee ID only in HR mode (admin department detail)", () => {
  const src = read("components/DeptCalibration.jsx");
  const hits = src.split(/\r?\n/).filter((l) => /\.employeeId\s*\}/.test(l));
  assert.ok(hits.length >= 1, "the HR detail still shows the employee ID");
  for (const l of hits) assert.match(l, /!isHod\s*&&/, "every rendered employeeId is gated to mode=hr: " + l.trim());
});

test("9.1: search still matches employee IDs (team review list, department calibration)", () => {
  assert.match(read("pages/ReviewTeam.jsx"), /String\(r\.employeeId \|\| ''\)\.toLowerCase\(\)\.includes\(needle\)/);
  assert.match(read("deptcal.js"), /lower\(row\.employeeId\)\.includes\(kw\)/);
});

test("9.1: team review row shows position and job grade instead", () => {
  assert.match(read("pages/ReviewTeam.jsx"), /const meta = \[r\.position \|\| r\.department, r\.jobLevel\]\.filter\(Boolean\)\.join\(' · '\);/);
});

test("8.5: the self-review on My review splits into two columns (review / next goals) and is width-capped", () => {
  const src = read("pages/Review.jsx");
  const grid = src.indexOf('className="rv-self-grid"');
  assert.ok(grid > 0, "self-review grid present");
  const cols = src.slice(grid).match(/className="rv-self-col"/g) || [];
  assert.ok(cols.length >= 2, "two columns");
  const p1 = src.indexOf("{s.p1}", grid), p2 = src.indexOf("{s.p2}", grid);
  const col2 = src.indexOf('className="rv-self-col"', src.indexOf('className="rv-self-col"', grid) + 1);
  assert.ok(p1 > grid && p1 < col2 && p2 > col2, "part 1 left, part 2 right");
});
