// 第三批 9.1（2026-10-08）：员工端（含经理、HoD、讲师、班主任、征询人）接口不下发他人工号；只显示姓名、职位、职级、汇报关系。
// 保留但不显示：/api/me/reviews 的 teamRows[].employeeId（前端按工号查找）、部门校准 rows[].employeeId（查找 / 排序）；
// /api/me 本人工号保留。经理团队、下属档案、汇报链见 test/manager-line.test.js 与 test/team-cost.test.js。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ROOT, EMPLOYEE, startServer, loginAs } = require("./helpers.js");

let srv, emp;
before(async () => { srv = await startServer(); emp = await loginAs(srv.base, EMPLOYEE); });
after(() => srv.stop());

test("/api/me/growth no longer carries the employee ID; /api/me keeps the viewer's own", async () => {
  const g = await emp.get("/api/me/growth");
  assert.equal(g.status, 200);
  assert.ok(g.data.me && !("employeeId" in g.data.me));
  assert.equal((await emp.get("/api/me")).data.employeeId, EMPLOYEE.employeeId);
});

test("static: the employee-side builders do not ship other people's employee IDs", () => {
  const src = require("./helpers.js").serverSource();   // server.js + modules/*/routes.js
  const fn = (name) => { const i = src.indexOf("function " + name + "("); return src.slice(i, src.indexOf("\n}", i)); };
  assert.ok(!/employeeId/.test(fn("reportingChain")), "reporting chain");
  const block = (start, len) => { const i = src.indexOf(start); assert.ok(i > 0, start); return src.slice(i, i + len); };
  assert.ok(!/employeeId: u\.employeeId/.test(block('if (pathname === "/api/me/team" && req.method === "GET")', 4000)), "/api/me/team rows");
  assert.ok(!/employeeId: u \? u\.employeeId/.test(block("const clsOne = pathname.match(", 3000)), "class roster");
  assert.match(block("const sesCk = pathname.match(", 800), /attendees\.map\(\(\{ employeeId, \.\.\.a \}\)/, "trainer session roster strips it");
  assert.ok(!/employeeId/.test(block('if (pathname === "/api/me/reviews/appeal-consults" && req.method === "GET")', 900)), "appeal consult list");
  assert.ok(!/employeeId: u \? u\.employeeId/.test(block("const meConsultMatch = pathname.match(", 1200)), "appeal consult page");
  assert.ok(!/employeeId: u \? u\.employeeId/.test(block("const teamItemMatch = pathname.match(", 1500)), "team review item");
});
