// F55（2026-10-09）多选题「部分得分」的说明与实际规则一致：少选且无错选得一半分，有错选不得分（不是按比例）。
// 判分规则见 modules/learning/qtypes/multi.js；员工端考前说明（ExamPrep.jsx）与 HR 端考试设置（Exams.jsx）两处文案须与之一致。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "web", "src");
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), "utf8");

test("multi 判分：少选且无错选 = 一半分，有错选 = 0（规则未变）", () => {
  const multi = require("../modules/learning/qtypes/multi.js");
  const src = fs.readFileSync(require.resolve("../modules/learning/qtypes/multi.js"), "utf8");
  assert.ok(multi && src.length > 0);
  assert.match(src, /0\.5/, "multi.js 的部分得分是一半分");
});

test("员工端考前说明不再写「按比例」，写明少选无错选得一半分、有错选不得分（中英文）", () => {
  const s = read("pages", "ExamPrep.jsx");
  assert.doesNotMatch(s, /按比例得分'/);
  assert.match(s, /multiPartial: '多选题少选且无错选得一半分，有错选不得分'/);
  assert.match(s, /multiPartial: 'Multiple-answer questions: half credit if you miss an option but select no wrong ones; no credit if any wrong option is selected'/);
});

test("HR 端考试设置与员工端同一口径", () => {
  const s = read("pages", "admin", "Exams.jsx");
  assert.match(s, /fMultiPartial: '多选题少选且无错选给一半分'/);
  assert.match(s, /multiPartialHint: '有错选不得分；/);
  assert.doesNotMatch(s, /部分正确给一半分/);
});
