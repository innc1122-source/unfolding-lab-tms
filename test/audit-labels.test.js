// 审计日志标签（批次 3 S5；IA B-AC71、B-P72、R-811–R-815）：server.js 写入的每一个审计动作，在后台「审计日志」页
// （web/src/pages/admin/Audit.jsx 的 ACTIONS）都有中英两种标签——没有标签的动作会显示原始键名，也不进动作筛选。
// 动作名以字面量写入；按「"前缀." + decision」拼出的两处（选修课程申请、培养项目申请）按服务端允许的 approve / reject 展开。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

function serverActions() {
  const srv = require("./helpers.js").serverSource();   // server.js + modules/*/routes.js
  const acts = new Set();
  for (const m of srv.matchAll(/\baudit(?:Auth)?\(\s*["'`]([a-z][a-z0-9_.-]*[a-z0-9_-])["'`]/g)) acts.add(m[1]);
  for (const m of srv.matchAll(/\baudit\(\s*[a-zA-Z_]+\s*\?\s*["']([a-z][a-z0-9_.-]*)["']\s*:\s*["']([a-z][a-z0-9_.-]*)["']/g)) { acts.add(m[1]); acts.add(m[2]); }
  const dyn = [...srv.matchAll(/\baudit\(\s*["']([a-z][a-z0-9_.-]*\.)["']\s*\+\s*decision\b/g)].map((m) => m[1]);
  assert.deepEqual(dyn.sort(), ["enroll.", "tproject.nomination."], "the two decision-built actions");
  for (const p of dyn) { acts.add(p + "approve"); acts.add(p + "reject"); }
  // 第三批 5.7：视频转码引擎以系统身份写的审计经 hooks.audit 回到 server.js（videoMediaAudit），动作名在引擎里以字面量出现
  const vtc = read("modules", "learning", "video-transcode.js");
  const vtcActs = [...vtc.matchAll(/\bhooks\.audit\s*,\s*["']([a-z][a-z0-9_.-]*[a-z0-9_-])["']/g)].map((m) => m[1]);
  assert.ok(vtcActs.length >= 2, "video-transcode.js writes its audit actions as literals: " + vtcActs.join(", "));
  for (const a of vtcActs) acts.add(a);
  return acts;
}

function auditLabels() {
  const src = read("web", "src", "pages", "admin", "Audit.jsx");
  const block = src.slice(src.indexOf("const ACTIONS = {"), src.indexOf("\n};", src.indexOf("const ACTIONS = {")));
  const out = new Map();
  for (const m of block.matchAll(/^\s*'([^']+)': \{ zh: '([^']+)', en: '([^']+)', color: '(green|amber|red|blue|grey)' \},?\s*$/gm)) out.set(m[1], { zh: m[2], en: m[3] });
  return { src, out };
}

test("audit labels: every action server.js writes has a Chinese and an English label in Audit.jsx", () => {
  const acts = serverActions();
  assert.ok(acts.size >= 80, "found " + acts.size + " actions");
  const { out } = auditLabels();
  const missing = [...acts].filter((a) => !out.has(a)).sort();
  assert.deepEqual(missing, [], "unlabelled audit actions");
  for (const [a, l] of out) {
    assert.ok(l.zh.trim() && l.en.trim(), a);
    assert.match(l.zh, /[一-鿿]/, a + ": the Chinese label is written in Chinese");
    assert.doesNotMatch(l.en, /[一-鿿]/, a + ": the English label has no Chinese");
  }
});

test("audit labels: the action filter is built from the same table, so every labelled action can be filtered", () => {
  const { src } = auditLabels();
  assert.match(src, /optionList=\{Object\.keys\(ACTIONS\)\.map\(\(k\) => \(\{\s*label: lang === 'zh' \? ACTIONS\[k\]\.zh : ACTIONS\[k\]\.en, value: k,/);
});

test("audit labels: wording follows the terminology decisions (development program, cohort, department ranking, log meeting)", () => {
  const { out } = auditLabels();
  const want = {
    "program.create": ["创建课程（内部结构）", "Create course (internal structure)"],
    "tproject.create": ["创建发展项目", "Create development program"], // F59
    "review.cycle.create": ["发起评估周期", "Launch review cycle"],
    "review.nudge": ["提醒提交自评", "Self-review reminder sent"],
    "culture.programs.create": ["行为实践：创建期次", "Behavior Practice: create cohort"],
    "culture.jobs.leaderboard": ["行为实践：重算部门排名", "Behavior Practice: recalculate department ranking"],
    "culture.meetings.submit": ["行为实践：登记例会", "Behavior Practice: log meeting"],
    "enroll.approve": ["通过课程申请", "Approve course application"],
  };
  for (const [a, [zh, en]] of Object.entries(want)) assert.deepEqual(out.get(a), { zh, en }, a);
});
