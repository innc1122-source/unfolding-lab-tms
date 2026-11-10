// CX-227（10/12）：行尾「// 注释」写在代码中间会把同一行后面的代码一起注释掉 —— 曾两次吞掉文案字典的键、一次吞掉通知的 title_zh。
// 这里扫描服务端与前端源码：任何行尾注释里出现 title_zh / body_zh / error_zh / *_zh 键，或「key: 字符串,」「key: (参数) =>」
// 这类明显是代码的内容，判为被吞掉的代码。类型说明（如 kind: "a" | "b"）不算。
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function files() {
  const out = ["server.js", "store.js"];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|dist|culture)$/.test(e.name)) walk(p); }
      else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
    }
  };
  walk("modules"); walk("kernel"); walk(path.join("web", "src"));
  return out;
}

const ZH_KEY = /\b\w+_zh\s*:/;
const CODE_LIKE = /(?:^|[,{ ])[A-Za-z_]\w*: (?:`[^`]*`|'[^']*'|"[^"]*")\s*,|(?:^|[,{ ])[A-Za-z_]\w*: \([^)]*\)\s*=>/;

test("CX-227: the scanner itself catches the two known shapes", () => {
  const hit = (ln) => { const m = /^(\s*\S.*?)\s\/\/\s(.*)$/.exec(ln); return !!m && (ZH_KEY.test(m[2]) || CODE_LIKE.test(m[2])); };
  assert.ok(hit("  title: `HR has started`,   // CX-219：不点名 HRBP title_zh: `你的评级`,"));
  assert.ok(hit("    lRemind: (n) => '发送提醒…',   // CX-210：不写人数 lExport: '导出 CSV',"));
  assert.ok(!hit("  const x = 1; // { id, kind: \"item\" | \"group\", pre: code | null }"));
});

test("CX-227: no trailing // comment swallows code (bilingual keys, dictionary entries)", () => {
  const bad = [];
  for (const f of files()) {
    fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/).forEach((ln, i) => {
      const m = /^(\s*\S.*?)\s\/\/\s(.*)$/.exec(ln);
      if (!m) return;
      const code = m[1].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "");
      if (/['"`]/.test(code) || /https?:$/.test(m[1])) return;   // 「//」落在字符串里
      if (ZH_KEY.test(m[2]) || CODE_LIKE.test(m[2])) bad.push(`${f}:${i + 1}  ${m[2].slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, []);
});
