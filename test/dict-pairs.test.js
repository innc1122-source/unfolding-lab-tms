// 双语词典成对（批次 3 S5；IA 5.3、R-1117）：web/src 里每个页面与组件的 `const T` / `const NT` 词典，以及 i18n.jsx 的 DICT，
// zh 与 en 两套键名完全相同；函数型词条两种语言参数个数相同；嵌套对象（如 stHelp、domains）同样逐层核对。
// 词典按源码求值（vm），只取 `const T = {` … 对应的对象字面量，不执行页面代码。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web", "src");

function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx|js)$/.test(f)) out.push(p);
  }
  return out;
}

// 从 `anchor` 起取出平衡的 {…} 对象字面量（跳过字符串、模板与注释里的花括号）
function objectLiteral(src, at) {
  let i = src.indexOf("{", at), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === "'" || c === '"') { i++; while (src[i] !== c) { if (src[i] === "\\") i++; i++; } continue; }
    if (c === "`") { i++; let d2 = 0; while (i < src.length && !(src[i] === "`" && d2 === 0)) { if (src[i] === "\\") i++; else if (src[i] === "$" && src[i + 1] === "{") { d2++; i++; } else if (src[i] === "}" && d2) d2--; i++; } continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced object at " + at);
}

function dictionaries() {
  const out = [];
  for (const f of walk(WEB)) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    for (const m of src.matchAll(/\bconst (T|NT|T404|DICT)\s*=\s*\{/g)) {
      const lit = objectLiteral(src, m.index);
      let obj;
      try { obj = vm.runInNewContext("(" + lit + ")", { Math, Number, String, Array, Object, Intl, Date }); }
      catch (e) { throw new Error(rel + " " + m[1] + ": cannot evaluate the dictionary (" + e.message + ")"); }
      if (obj && typeof obj === "object" && obj.zh && obj.en) out.push({ file: rel, name: m[1], zh: obj.zh, en: obj.en });
    }
  }
  return out;
}

function compare(a, b, where, problems) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  const onlyZh = ka.filter((k) => !(k in b)), onlyEn = kb.filter((k) => !(k in a));
  if (onlyZh.length) problems.push(where + ": only in zh: " + onlyZh.join(", "));
  if (onlyEn.length) problems.push(where + ": only in en: " + onlyEn.join(", "));
  for (const k of ka) {
    if (!(k in b)) continue;
    const x = a[k], y = b[k];
    if (typeof x === "function" || typeof y === "function") {
      if (typeof x !== typeof y) problems.push(where + "." + k + ": function in one language only");
      else if (x.length !== y.length) problems.push(where + "." + k + ": zh takes " + x.length + " parameter(s), en " + y.length);
    } else if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) problems.push(where + "." + k + ": arrays differ in shape");
    } else if (x && typeof x === "object" && y && typeof y === "object") {
      compare(x, y, where + "." + k, problems);
    } else if (typeof x !== typeof y) problems.push(where + "." + k + ": " + typeof x + " vs " + typeof y);
  }
}

test("dict pairs: every zh / en dictionary in web/src has the same keys, the same function arity and the same nested shape", () => {
  const dicts = dictionaries();
  assert.ok(dicts.length >= 40, "found " + dicts.length + " dictionaries");
  const problems = [];
  for (const d of dicts) compare(d.zh, d.en, d.file + " " + d.name, problems);
  assert.deepEqual(problems, []);
});

test("dict pairs: the shared i18n.jsx dictionary carries the navigation names both languages use", () => {
  const d = dictionaries().find((x) => x.file === "web/src/i18n.jsx" && x.name === "DICT");
  assert.ok(d, "i18n.jsx DICT found");
  for (const k of ["navHome", "navLearningGroup", "navLearning", "navRecord", "navReview", "tabRecord", "tabReview", "trailLabel", "switchLang", "adminConsole"])
    assert.ok(typeof d.zh[k] === "string" && typeof d.en[k] === "string", k);
});
