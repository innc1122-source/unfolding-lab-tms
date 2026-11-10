// F48（负责人 2026-10-09 定）：界面不用 emoji。需要图标时用系统线性图标（svg.ic，见 web/src/components/LineIcons.jsx），
// 否则用文字。本测试静态扫描 web/src 下全部 .js / .jsx（去掉注释后）里的 Extended_Pictographic 字符：凡是会进界面的
// （JSX 文本、字符串、字典文案）一律不许出现。代码注释里的不算。
// 白名单只放「不是 emoji 的排版符号」——它们在 Unicode 里碰巧也带 Extended_Pictographic 属性。✓ ✗ › × · – 等本来就不是
// Extended_Pictographic，不需要进白名单。⚠ 按负责人规则算 emoji，不进白名单。
// 另外两处演示数据（store.js 的 seedTalentDemo、scripts/seed-demo-complete.js 的标签表）也不许带 emoji：
// 已存进库里的旧标签由数据迁移 85 清洗（见 test/talent-tags-emoji-85.test.js）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB_SRC = path.join(ROOT, "web", "src");

// 非 emoji 的排版符号（带 Extended_Pictographic 属性，但属于版权/商标/双向箭头这类文字符号）。
const ALLOW = new Set(["©" /* © */, "®" /* ® */, "™" /* ™ */, "↔" /* ↔ */, "↕" /* ↕ */]);
const PICTO = /[\p{Extended_Pictographic}\u{FE0F}]/gu;

// 去掉 // 与 /* */ 注释（保留换行，行号不变）。字符串、模板字符串（含 ${} 嵌套）、正则字面量原样保留。
// 单 / 双引号字符串与正则遇到换行即判定「不是字符串 / 正则」，退回一个字符继续（JSX 文本里的撇号、`</div>`、`/>`）。
function stripComments(src) {
  const out = src.split("");
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "; };
  const n = src.length;
  let i = 0;
  let prev = ""; // 上一个有意义的字符（判断 / 是除号还是正则）
  const tpl = []; // 模板字符串里 ${ 的花括号深度栈
  const regexAfter = /[(,=:[!&|?{};+\-*%<>~^]/;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { let j = i; while (j < n && src[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); const e = j < 0 ? n : j + 2; blank(i, e); i = e; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      if (j < n && src[j] === c) { i = j + 1; prev = c; continue; }
      i++; continue; // 不是字符串（JSX 文本里的撇号）
    }
    if (c === "`" || (c === "}" && tpl.length && tpl[tpl.length - 1] === 0)) {
      if (c === "}") tpl.pop();
      let j = i + 1;
      while (j < n && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
      if (j < n && src[j] === "$") { tpl.push(0); i = j + 2; prev = "{"; continue; }
      i = j + 1; prev = "`"; continue;
    }
    if (c === "{" && tpl.length) tpl[tpl.length - 1]++;
    if (c === "}" && tpl.length) tpl[tpl.length - 1]--;
    if (c === "/" && d !== ">" && prev !== "<" && (prev === "" || regexAfter.test(prev) || /\b(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; else if (src[j] === "/" && !cls) break;
        j++;
      }
      if (j < n && src[j] === "/") { i = j + 1; prev = "/"; continue; }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function findEmoji(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const bad = [...line.matchAll(PICTO)].map((m) => m[0]).filter((ch) => !ALLOW.has(ch));
    if (bad.length) hits.push({ line: i + 1, chars: [...new Set(bad)].join(""), text: line.trim().slice(0, 120) });
  });
  return hits;
}

test("the comment stripper keeps strings, JSX text and regexes, and only blanks comments", () => {
  const src = [
    "const a = '⚠ x'; // 🔒 comment",
    "/* 📅 block */ const r = /['\"]/g; const b = \"🔗\";",
    "const t = `a ${f({ k: '⬆' })} b`; // ℹ",
    "const el = <p>Don't ⚠ {x}</p>; {/* 🌟 */}",
    "const q = 4 / 2; const s = '✓';",
  ].join("\n");
  const kept = stripComments(src);
  assert.equal(kept.split("\n").length, 5, "line count unchanged");
  assert.deepEqual(findEmoji(kept).map((h) => [h.line, h.chars]), [[1, "⚠"], [2, "🔗"], [3, "⬆"], [4, "⚠"]]);
});

test("F48: no emoji / pictographic characters reach the UI from web/src (comments excluded)", () => {
  const files = sourceFiles(WEB_SRC);
  assert.ok(files.length > 50, "scanned " + files.length + " files");
  const hits = [];
  for (const f of files) {
    for (const h of findEmoji(stripComments(fs.readFileSync(f, "utf8")))) hits.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${h.line} [${h.chars}] ${h.text}`);
  }
  assert.deepEqual(hits, [], "emoji in UI code — use a line icon from components/LineIcons.jsx or plain text");
});

