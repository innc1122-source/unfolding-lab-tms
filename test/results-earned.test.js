// 回归测试（第四批，设计 §2.1 / §12 第 8 条）：后台「成绩」答卷复核页每题显示的「得 n 分」（Results.jsx objPoints）
// 原来写死「答对 1 分、部分正确 0.5 分」，忽略了每题分值 points —— 2 分的题答对也显示「得 1 分」，与服务端
// scoreTotals 计的分不一致。改为与学员成绩页同一个 model.earnedOf：有分值按分值（多选部分正确 = 一半），
// 新题型按 分值 × credit，旧答卷（没有 points）仍是旧口径。本测试在修复前失败（返回 1 而不是 3）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "web", "src", "pages", "admin", "Results.jsx"), "utf8");

async function objPointsFn() {
  const m = src.match(/const objPoints = ([^;]+);/);
  assert.ok(m, "Results.jsx still defines objPoints");
  const { earnedOf } = await import(pathToFileURL(path.join(ROOT, "web", "src", "qtypes", "model.js")).href);
  // eslint-disable-next-line no-new-func
  return new Function("earnedOf", `return (${m[1]});`)(earnedOf);
}

test("Results objPoints honours per-question points (was a flat 1 / 0.5)", async () => {
  const objPoints = await objPointsFn();
  assert.equal(objPoints({ type: "mcq", isRight: true, partial: false, points: 3 }), 3);
  assert.equal(objPoints({ type: "mcq", isRight: false, partial: false, points: 3 }), 0);
  assert.equal(objPoints({ type: "multi", isRight: false, partial: true, points: 2 }), 1, "partial multi = half of its points");
  assert.equal(objPoints({ type: "fill", isRight: true, points: 5 }), 5);
});

test("Results objPoints: legacy attempts without points keep the old rule; new types use points × credit", async () => {
  const objPoints = await objPointsFn();
  assert.equal(objPoints({ type: "mcq", isRight: true }), 1);
  assert.equal(objPoints({ type: "multi", isRight: false, partial: true }), 0.5);
  assert.equal(objPoints({ type: "ordering", credit: 2 / 3, isRight: false, partial: true, points: 3 }), 2);
  assert.equal(objPoints({ type: "matching", credit: 0.5, isRight: false, partial: true }), 0.5);
  assert.equal(objPoints({ type: "case", items: [{ type: "mcq", credit: 1, isRight: true, points: 2 }, { type: "tf", credit: 0, isRight: false, points: 1 }] }), 2);
});

test("Results renders the points line through objPoints and no longer keeps its own type-label dictionary", () => {
  assert.match(src, /s\.earned\(objPoints\(d\)\)/);
  assert.doesNotMatch(src, /typeSingle|typeMulti|typeFill|typeOpen/, "labels come from qtypes typeLabel");
});
