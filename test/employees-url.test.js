// 第二批波次 3 W3-A（2026-10-08）：员工名册的地址栏（3.1）。
//   · 部门筛选写进地址栏 dept=<部门 id>，含下级，全站唯一口径（/api/admin/dept-tree + deptMatcher），不再按部门原文精确比较；
//   · 进出整页（?edit= / ?new=1 / ?learn=）只增删页面键 PAGE_KEYS，不整串清空 —— 原来 setSearchParams({}) 会把部门筛选一并清掉；
//   · 名册有写操作后部门树缓存失效。
// urlstate.js 的 mergeParams 用 vm 直接跑（去掉 import / export，同 deptcal-ui），Employees.jsx 做源码断言。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "web", "src");
const EMP = fs.readFileSync(path.join(SRC, "pages", "admin", "Employees.jsx"), "utf8").replace(/\r\n/g, "\n");

function loadUrlstate() {
  let src = fs.readFileSync(path.join(SRC, "urlstate.js"), "utf8");
  const names = [...src.matchAll(/^export\s+(?:function|const|let)\s+(\w+)/gm)].map((m) => m[1]);
  src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, "").replace(/^export\s+/gm, "");
  const ctx = vm.createContext({ URLSearchParams, useCallback() {}, useMemo() {}, useSearchParams() {} });
  vm.runInContext(src + "\n;globalThis.__x = {" + names.join(",") + "};", ctx);
  return ctx.__x;
}

test("mergeParams + PAGE_KEYS：进出整页保留部门筛选，只换页面键", () => {
  const us = loadUrlstate();
  const go = (prev, set) => us.mergeParams(prev, set, us.PAGE_KEYS).toString();
  assert.deepEqual([...us.PAGE_KEYS], ["edit", "new", "learn", "attempt"]);
  assert.equal(go("dept=12", { new: "1" }), "dept=12&new=1", "新增员工：dept 留着");
  assert.equal(go("dept=12&learn=7", { edit: "9" }), "dept=12&edit=9", "从学习记录切到编辑：learn 清掉");
  assert.equal(go("dept=12&edit=9", {}), "dept=12", "返回名单：只删页面键");
  assert.equal(go("dept=__none&new=1", {}), "dept=__none");
  assert.equal(us.shouldPush("dept=12", "dept=12&edit=9"), false, "页面键不在层级键里：push 与否由调用方明确指定");
});

test("Employees：不再整串清空地址栏，进出整页都经 goPage（clear: PAGE_KEYS）", () => {
  assert.ok(!/setSearchParams\(/.test(EMP.replace(/\/\/.*$/gm, "")), "代码里不再调用 setSearchParams(…)");
  assert.match(EMP, /const goPage = \(set, push = true\) => patchUrl\(set \|\| \{\}, \{ clear: PAGE_KEYS, push \}\);/);
  for (const [k, v] of [["new", "'1'"], ["edit", "String(r.id)"], ["learn", "String(r.id)"]])
    assert.ok(EMP.includes(`goPage({ ${k}: ${v} })`), "打开整页 ?" + k + "=");
  assert.ok(EMP.includes("if (hasPageParam && !pageKind) goPage({}, false);"), "无权限的页面参数：replace 去掉");
  assert.equal((EMP.match(/if \(seq === loadSeq\.current\) goPage\(\{\}, false\);/g) || []).length, 2, "保存成功后 replace 回名单（编辑、新增）");
  assert.ok(EMP.includes("const leave = () => guard(() => goPage({}));"));
  assert.ok(EMP.includes("const back = () => goPage({});"));
  // org-fullpage 依赖的读取方式不变
  for (const k of ["learn", "edit", "new"]) assert.ok(EMP.includes(`get('${k}')`), "?" + k + "=");
});

test("Employees：部门筛选 = DeptFilter + 地址栏 dept=<id> + deptMatcher（含下级）；写操作后部门树失效", () => {
  assert.match(EMP, /const fDept = searchParams\.get\('dept'\) \|\| '';/);
  assert.match(EMP, /const setFDept = \(v\) => patchUrl\(\{ dept: v \|\| null \}\);/, "筛选只改 dept，replace（不是层级键）");
  assert.match(EMP, /const deptOk = useMemo\(\(\) => deptMatcher\(deptTree, fDept \|\| null\), \[deptTree, fDept\]\);/);
  assert.match(EMP, /if \(fDept && !deptOk\(r\.department\)\) return false;/);
  assert.ok(!EMP.includes("r.department !== fDept"), "不再按部门原文精确比较");
  assert.match(EMP, /<DeptFilter\n\s+options=\{deptTree \? deptTree\.options : \[\]\}/);
  assert.match(EMP, /showNone=\{!!\(deptTree && deptTree\.hasNone\)\}/);
  assert.match(EMP, /onInvalid=\{\(\) => \{ Toast\.info\(deptFilterInvalidText\(lang\)\); setFDept\(null\); \}\}/);
  assert.match(EMP, /const reloadRoster = \(\) => \{ empQ\.reload\(\); invalidateDeptTree\(\); \};/);
  assert.ok((EMP.match(/reloadRoster\(\);/g) || []).length >= 5, "编辑、新增、批量改、启停、导入之后都失效");
  // 编辑表单与批量改部门的下拉仍是部门原文（写进主数据的值），不受筛选改造影响
  assert.ok((EMP.match(/optionList=\{departments\.map\(\(d\) => \(\{ label: d, value: d \}\)\)\}/g) || []).length >= 2);
});
