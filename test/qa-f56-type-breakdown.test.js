// F56（负责人 10/9 拍板）考前说明：同一题型分值不同时显示每题分值分布 ——「判断 2 题，共 3 分（1 分 × 1、2 分 × 1）」；
// 分值相同时照旧「单选 8 题 × 1 分」。服务端 typeSummary 行另带可选字段 breakdown: [{ points, count }]（只在固定题目、
// 分值不一致时带；旧字段 type / count / points 不变，旧前端照常工作）。
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ADMIN, EMPLOYEE, startServer, loginAs, completeAllModules } = require("./helpers.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "web", "src", "pages", "ExamPrep.jsx"), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));
const H = vm.runInNewContext(SRC.slice(SRC.indexOf("export const totalOf"), SRC.indexOf("export default function ExamPrep")).replace(/^export /gm, "") + "\n;({ typeLinesOf })", { Math, Number, String, Array, Object });
const T = vm.runInNewContext("(" + SRC.slice(SRC.indexOf("const T = {") + 10, SRC.indexOf("\n};", SRC.indexOf("const T = {")) + 2) + ")");

test("ExamPrep 文案：分值不同列出分布，分值相同照旧（中英文）", () => {
  const br = [{ points: 1, count: 1 }, { points: 2, count: 1 }];
  assert.equal(T.zh.typeLine(T.zh.typeName.tf, 2, null, br), "判断 2 题，共 3 分（1 分 × 1、2 分 × 1）");
  assert.equal(T.en.typeLine(T.en.typeName.tf, 2, null, br), "True / false: 2 questions, 3 pts total (1 pt × 1, 2 pts × 1)");
  assert.equal(T.zh.typeLine(T.zh.typeName.mcq, 8, 1), "单选 8 题 × 1 分", "equal points keep the old form");
  assert.equal(T.en.typeLine(T.en.typeName.mcq, 8, 1), "Single choice: 8 questions × 1 pt");
  assert.equal(T.zh.typeLine(T.zh.typeName.tf, 2, null), "判断 2 题", "no breakdown (old server) → unchanged");
  // 案例：各组分值不同
  const cb = [{ points: 4, count: 1 }, { points: 5, count: 1 }];
  assert.equal(T.zh.caseLine(2, 8, null, cb), "情境案例 2 组（共 8 小题）· 共 9 分（4 分 × 1、5 分 × 1）");
  assert.equal(T.en.caseLine(2, 8, null, cb), "Scenario cases: 2 groups (8 sub-questions) · 9 points (4 pts × 1, 5 pts × 1)");
  assert.equal(T.zh.caseLine(2, 8, 4), "情境案例 2 组（共 8 小题）· 8 分", "uniform case groups unchanged");
});

test("typeLinesOf 把 breakdown 带到行上；没有 breakdown 的行与旧输出完全相同", () => {
  const lines = plain(H.typeLinesOf({ typeSummary: [
    { type: "mcq", count: 8, points: 1 },
    { type: "tf", count: 2, points: null, breakdown: [{ points: 1, count: 1 }, { points: 2, count: 1 }] },
  ] }));
  assert.deepEqual(lines, [
    { type: "mcq", count: 8, points: 1 },
    { type: "tf", count: 2, points: null, breakdown: [{ points: 1, count: 1 }, { points: 2, count: 1 }] },
  ]);
  assert.match(SRC, /s\.typeLine\(\(s\.typeName\[l\.type\] \|\| l\.type\), l\.count, l\.points, l\.breakdown\)/, "the page passes the breakdown to the copy");
  assert.match(SRC, /s\.caseLine\(l\.count, l\.items, l\.points, l\.breakdown\)/);
});

let srv, admin, emp, courseId;
before(async () => {
  srv = await startServer();
  admin = await loginAs(srv.base, ADMIN);
  emp = await loginAs(srv.base, EMPLOYEE);
  await completeAllModules(emp, "nho");
  courseId = (await admin.get("/api/admin/content")).data.programs.find((p) => p.id === "nho").courseIds[0];
});
after(() => srv.stop());

test("/api/programs/:id typeSummary：固定题目、同题型分值不同 → breakdown；分值相同 → 不带，旧字段不变", async () => {
  const ids = [];
  for (const [k, pts] of [["a", 1], ["b", 2], ["c", 3], ["d", 3]]) {
    const r = await admin.post("/api/admin/questions", { courseId, type: "mcq", question: "F56 " + k, points: pts, options: [{ text: "R", ok: true }, { text: "W", ok: false }], explanation: "" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids.push(r.data.id || r.data.question.id);
  }
  const mk = async (title, qids) => {
    const r = await admin.post("/api/admin/exams", { programId: "nho", title, status: "published", courseIds: [courseId], passingScore: 60, mcqCount: 1, openCount: 0, mode: "fixed", questionIds: qids });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.id;
  };
  const mixed = await mk("F56 mixed", [ids[1], ids[0], ids[2]]);   // 2 + 1 + 3
  const same = await mk("F56 same", [ids[2], ids[3]]);             // 3 + 3
  const exams = (await emp.get("/api/programs/nho")).data.exams;
  const em = exams.find((e) => e.id === mixed), es = exams.find((e) => e.id === same);
  assert.deepEqual(plain(em.typeSummary), [{ type: "mcq", count: 3, points: null, breakdown: [{ points: 1, count: 1 }, { points: 2, count: 1 }, { points: 3, count: 1 }] }]);
  assert.equal(em.totalPoints, 6);
  assert.deepEqual(plain(es.typeSummary), [{ type: "mcq", count: 2, points: 3 }], "equal points: no breakdown field");
  // 页面文案
  const line = H.typeLinesOf(em)[0];
  assert.equal(T.zh.typeLine(T.zh.typeName[line.type], line.count, line.points, line.breakdown), "单选 3 题，共 6 分（1 分 × 1、2 分 × 1、3 分 × 1）");
  const ls = H.typeLinesOf(es)[0];
  assert.equal(T.zh.typeLine(T.zh.typeName[ls.type], ls.count, ls.points, ls.breakdown), "单选 2 题 × 3 分");
});
