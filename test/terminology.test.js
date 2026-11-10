// TMS 界面用语检查（批次 3 S5；IA 2.x 禁用说法与 5.6 验收，计划 R-1109、R-1119）：web/src 页面与组件的字符串字面量、server.js 发给
// 用户的通知标题与正文里，不再出现已停用的说法。只查字符串（去掉注释），代码标识符、接口路径、code 值不在范围内。
// 拍板例外：「Action 3+3 挑战」学员端产品名（2026-09-30 起，原「Action 挑战」）、「行为实践」类别名（负责人 2026-09-29）、导入关键字 leader / employee 等不在禁用表里。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// [禁用写法, 改为] —— 中文按词，英文按词边界
const BANNED = [
  [/我的学习/, "我的课程 / 培训"], [/我的项目/, "发展项目"], [/我的记录/, "成长档案"], [/培训项目/, "发展项目"],
  [/培养项目/, "发展项目（F59，负责人 2026-10-09）"], [/课程目录/, "公开课（F59）"],
  [/报名/, "申请"], [/结案/, "已关闭"], [/在编/, "在职"], [/字段设置/, "档案与职级设置"], [/答辩池/, "晋升评审候选"],
  [/冷却/, "重考等待期"], [/超管/, "超级管理员"], [/璞玉|明星 Star|风险 Risk/, "九宫格状态描述格名"], [/课程中心/, "可申请的选修课程"],
  [/建号/, "账号创建"], [/成绩档案/, "学习记录"], [/联系管理员/, "联系 HR"],
  [/\bMy Learning\b/, "My Courses / Learning"], [/\bMy Projects\b/, "Development Programs"], [/\bMy Record\b/, "Development Record"],
  [/\bCourse Catalog\b/, "Public Courses (F59)"],
  [/\b[Tt]raining [Pp]rojects?\b/, "development program"], [/\b[Dd]efense pool\b/, "promotion panel candidates"],
  [/\bback office\b/, "console"], [/\bTalent field settings\b/, "Profile & Job Level Settings"], [/\bprogramme\b/, "program"],
  [/\benrol\b/, "enroll / add"], [/\bOpen[- ]ended\b|\bOpen answer\b/, "Short answer"],
];

// 去掉 /* */ 与整行 // 注释（行尾注释若含引号不处理，按字符串照查 —— 宁严勿漏）
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l)).join("\n");
}
// 取一行里的字符串字面量（单引号、双引号、模板字符串的文字段，${…} 去掉）
function strings(line) {
  const out = [];
  for (const m of line.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*?)`/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    if (s.trim()) out.push(s);
  }
  return out;
}
function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, out); else if (/\.(jsx|js)$/.test(f)) out.push(p);
  }
  return out;
}

test("terminology: no retired term appears in a user-facing string anywhere in web/src", () => {
  const hits = [];
  for (const f of walk(path.join(ROOT, "web", "src"))) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    stripComments(fs.readFileSync(f, "utf8")).split("\n").forEach((line, i) => {
      // 正则字面量（导入表头识别等）不是界面文字
      const code = line.replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, (m) => (/[|^$]/.test(m) ? " " : m));
      for (const s of strings(code)) for (const [re, fix] of BANNED) if (re.test(s)) hits.push(`${rel}:${i + 1} 「${s.slice(0, 60)}」 → ${fix}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("terminology: server notifications (title / body in both languages) use the current names", () => {
  const hits = [];
  stripComments(fs.readFileSync(path.join(ROOT, "server.js"), "utf8")).split("\n").forEach((l, i) => {
    if (!/\b(title|title_zh|body|body_zh)\s*:/.test(l)) return;
    for (const s of strings(l)) for (const [re, fix] of BANNED) if (re.test(s)) hits.push(`server.js:${i + 1} 「${s.slice(0, 60)}」 → ${fix}`);
  });
  assert.deepEqual(hits, []);
});
