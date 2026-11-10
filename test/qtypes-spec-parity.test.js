// 第四批 6.1（2026-10-08，G3）：题型目录前后端一致。
//   · web/src/qtypes/spec.js（vm 跑）与 modules/learning/qtypes/spec.js：键、顺序、中英文名、分组、QTI、阶段、默认分值、计分方式、
//     选项顺序、可否作案例小题、ENABLED（阶段开关，逐项相同）；
//   · 前端 model.js 的 LIMITS 与服务端 LIMITS 同一组数字（保存前的行内校验与服务端 validate 同口径）；
//   · 考前说明页 ExamPrep.jsx 的 typeName（中文短名 / 英文全称）与目录一致；AI 题型映射只落到已开放的题型。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web", "src");
const plain = (v) => JSON.parse(JSON.stringify(v));

// 纯 ESM 文件依次在同一个 vm 上下文里跑：去掉 import / export，把导出名挂出来
function loadEsm(rels) {
  const names = [];
  let code = "";
  for (const rel of rels) {
    let src = fs.readFileSync(path.join(WEB, rel), "utf8");
    names.push(...[...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]));
    src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "").replace(/^export\s+/gm, "");
    code += src + "\n";
  }
  const ctx = vm.createContext({ Math, Number, String, Array, Object, Set, Map, JSON });
  vm.runInContext(code + "\n;globalThis.__x = {" + names.join(",") + "};", ctx);
  return ctx.__x;
}
const W = loadEsm(["qtypes/spec.js"]);
const SERVER = path.join(ROOT, "modules", "learning", "qtypes", "spec.js");

test("web spec: catalogue order, labels and helpers", () => {
  assert.deepEqual(plain(W.TYPE_ORDER), ["mcq", "multi", "tf", "fill", "cloze", "ordering", "matching", "classify", "open", "case"]);
  assert.equal(W.typeLabel("mcq", "zh"), "单选题");
  assert.equal(W.typeLabel("mcq", "en"), "Single choice");
  assert.equal(W.typeLabel("multi", "en", true), "Multiple");
  assert.equal(W.typeLabel("case", "zh"), "情境案例题组");
  assert.equal(W.typeLabel("open", "en"), "Short answer", "terminology: 简答题 / Short answer");
  assert.equal(W.typeLabel("future_type", "zh"), "future_type", "an unknown type shows its key");
  assert.deepEqual(plain(W.typePointsKeys()), plain(W.TYPE_ORDER.filter((k) => k !== "case")));
  assert.deepEqual(plain(W.caseItemTypes()), ["mcq", "multi", "tf", "fill", "cloze", "ordering", "matching", "classify"], "objective types only (D3)");
  assert.equal(W.groupOf("case"), "case");
  assert.equal(W.groupOf("open"), "open");
  assert.equal(W.groupOf("ordering"), "objective");
  for (const k of W.ENABLED) assert.ok(W.TYPES[k], k + " is in the catalogue");
  // AI 题型名 → 题库题型：4c 起 truefalse 存为 tf；全部落在已开放的题型上
  assert.equal(W.AI_TYPE_MAP.truefalse, "tf");
  assert.equal(W.AI_TYPE_MAP.single, "mcq");
  for (const [ai, k] of Object.entries(W.AI_TYPE_MAP)) assert.ok(W.ENABLED.includes(k), `AI type ${ai} → ${k} is enabled`);
});

test("spec parity: web/src/qtypes/spec.js equals modules/learning/qtypes/spec.js", (t) => {
  if (!fs.existsSync(SERVER)) { t.diagnostic("modules/learning/qtypes/spec.js not there yet (G2) — server parity skipped"); return; }
  const S = require(SERVER);
  assert.deepEqual(plain(W.TYPE_ORDER), S.TYPE_ORDER, "same keys in the same order");
  for (const k of S.TYPE_ORDER) assert.deepEqual(plain(W.TYPES[k]), S.TYPES[k], `${k}: labels, group, qti, phase, defaultPoints, partial, optionOrder, caseItem`);
  assert.deepEqual(Object.keys(W.TYPES).sort(), Object.keys(S.TYPES).sort(), "no extra types on either side");
  assert.deepEqual(plain(W.ENABLED), S.ENABLED, "ENABLED (phase gate) identical, item by item");
  // 注册表入口的派生列表也一致
  const idx = path.join(ROOT, "modules", "learning", "qtypes", "index.js");
  if (fs.existsSync(idx)) {
    const R = require(idx);
    if (typeof R.typePointsKeys === "function") assert.deepEqual(plain(W.typePointsKeys().filter((k) => W.ENABLED.includes(k))), R.typePointsKeys());
    if (typeof R.enabled === "function") assert.deepEqual(plain(W.enabledTypes()), R.enabled());
  }
});

test("limits parity: web model.js LIMITS equal the server LIMITS", (t) => {
  if (!fs.existsSync(SERVER)) { t.diagnostic("server spec missing — skipped"); return; }
  const S = require(SERVER).LIMITS;
  const M = loadEsm(["qtypes/spec.js", "qtypes/model.js"]).LIMITS;
  assert.equal(M.textMax, S.text);
  assert.equal(M.passageMax, S.passage);
  assert.equal(M.acceptedLen, S.blankAnswer);
  assert.equal(M.clozeAnswerLen, S.responseText);
  assert.deepEqual([M.orderingMin, M.orderingMax], [S.ordering.min, S.ordering.max]);
  assert.deepEqual([M.pairsMin, M.pairsMax, M.distractorsMax], [S.matching.min, S.matching.max, S.matching.distractorsMax]);
  assert.deepEqual([M.categoriesMin, M.categoriesMax, M.classItemsMin, M.classItemsMax], [S.classify.catMin, S.classify.catMax, S.classify.itemMin, S.classify.itemMax]);
  assert.deepEqual([M.blanksMin, M.blanksMax, M.acceptedMax], [S.cloze.min, S.cloze.max, S.cloze.answersMax]);
  assert.deepEqual([M.subsMin, M.subsMax], [S.case.min, S.case.max]);
});

test("ExamPrep type names follow the catalogue (zh short name, en full name) for all ten types", () => {
  const src = fs.readFileSync(path.join(WEB, "pages", "ExamPrep.jsx"), "utf8");
  const at = src.indexOf("const T = {");
  const T = vm.runInNewContext("(" + src.slice(at + 10, src.indexOf("\n};", at) + 2) + ")");
  for (const k of W.TYPE_ORDER) {
    assert.equal(T.zh.typeName[k], W.typeLabel(k, "zh", true), "zh " + k);
    assert.equal(T.en.typeName[k], W.typeLabel(k, "en"), "en " + k);
  }
  // 情境案例一行：「情境案例 2 组（共 8 小题）· 8 分」
  assert.equal(T.zh.caseLine(2, 8, 4), "情境案例 2 组（共 8 小题）· 8 分");
  assert.equal(T.en.caseLine(2, 8, 4), "Scenario cases: 2 groups (8 sub-questions) · 8 points");
  assert.equal(T.zh.caseLine(1, null, null), "情境案例 1 组");
  assert.equal(T.zh.caseLine(2, null, 4), "情境案例 2 组 · 8 分", "random draw: sub-question total unknown");
  assert.equal(T.en.caseLine(1, 3, null), "Scenario cases: 1 group (3 sub-questions)");
});
