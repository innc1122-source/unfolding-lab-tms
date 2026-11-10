// modules/core/org.js 部门筛选纯函数单测（第二批 3.1，2026-10-08）：deptPathOf / deptOptionsOf / deptMatcherOf。
// 口径：集团层不算祖先、直挂集团节点的人；四级及以下并入三级（只是不成选项，匹配仍走完整链）；"name:" 伪 id；
// 部门父链成环退回按名匹配；停用部门标记；范围裁剪后的路径、parentId 与「只到四级」的兜底；idByName 按原文作键；
// counts 含下级汇总；不限级数时与 server.js reviewDeptOptions 逐字段相同（下面抄了一份旧实现作对照）。
// 不起服务、不开库。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const org = require("../modules/core/org.js");

const D = (id, name, parentId = null, extra = {}) => ({ id, name, parentId, active: true, ...extra });

const TREE = [
  D("grp", "DigiGroup", null, { group: true }),       // 集团层
  D("ops", "Operations", "grp"),                       // 上级是集团层 → 一级
  D("pay", "Payments", "ops"),
  D("set", "Settlement", "pay"),
  D("rec", "Reconciliation", "set"),                   // 四级
  D("rec5", "Recon Night", "rec"),                     // 五级
  D("fin", "Finance", "grp"),
  D("ap", "AP", "fin"),
  D("old", "Old Desk", "fin", { active: false }),      // 停用的二级
  D("la", "Loop A", "lb"),
  D("lb", "Loop B", "la"),
];
const ix = org.buildOrgIndex(TREE);
const NAMES = ["Operations", "Payments", "Settlement", "Reconciliation", "Recon Night", "Finance", "AP", "Old Desk", "DigiGroup", "Legacy Team", "Loop A", "", null];

test("deptPathOf: 一级 → 本部门的完整 id 链（集团层不算祖先、四级及以下照列）；空 → []；不在部门表 / 父链成环 → name: 伪 id", () => {
  assert.deepEqual(org.deptPathOf(ix, "Recon Night"), ["ops", "pay", "set", "rec", "rec5"]);
  assert.deepEqual(org.deptPathOf(ix, " payments "), ["ops", "pay"], "去首尾空白、不分大小写");
  assert.deepEqual(org.deptPathOf(ix, "DigiGroup"), ["grp"], "直接挂在集团节点上的人：链就是集团节点");
  assert.deepEqual(org.deptPathOf(ix, ""), []);
  assert.deepEqual(org.deptPathOf(ix, null), []);
  assert.deepEqual(org.deptPathOf(ix, " Legacy Team "), ["name:legacy team"]);
  assert.deepEqual(org.deptPathOf(ix, "Loop A"), ["name:loop a"], "父链成环的部门同样用伪 id");
  const allow = (n) => n !== "Operations";
  assert.deepEqual(org.deptPathOf(ix, "Settlement", allow), ["pay", "set"], "范围外的部门从链上去掉");
});

test("deptOptionsOf: 默认只列到三级；集团层不进联动；四级及以下并入三级但 chainById 仍是完整链；伪选项 level 为 null", () => {
  const r = org.deptOptionsOf(ix, NAMES, null);
  const byId = Object.fromEntries(r.options.map((o) => [o.id, o]));
  assert.ok(!byId.rec && !byId.rec5, "四级、五级不单独成选项");
  assert.deepEqual(byId.set, { id: "set", name: "Settlement", parentId: "pay", path: "Operations › Payments › Settlement", level: 3 });
  assert.deepEqual(byId.ops, { id: "ops", name: "Operations", parentId: null, path: "Operations", level: 1 }, "一级部门的上级是集团层：parentId 为空，路径不带集团名");
  assert.deepEqual(byId.grp, { id: "grp", name: "DigiGroup", parentId: null, path: "DigiGroup", level: 1 }, "只有直挂集团节点的人时，集团节点才作为一级出现");
  assert.deepEqual(byId["name:legacy team"], { id: "name:legacy team", name: "Legacy Team", parentId: null, path: "Legacy Team", level: null });
  assert.deepEqual(byId["name:loop a"].level, null, "父链成环 → 伪选项");
  assert.deepEqual(r.chainById.rec5, ["ops", "pay", "set", "rec", "rec5"]);
  assert.equal(r.idByName["Recon Night"], "rec5");
  assert.equal(r.idByName["Loop A"], "name:loop a");
  assert.ok(!("" in r.idByName) && !("null" in r.idByName), "空部门不进 idByName（前端用 __none 匹配）");
  // 父级在前、按链逐段排序
  const paths = r.options.map((o) => o.path);
  assert.ok(paths.indexOf("Operations") < paths.indexOf("Operations › Payments"));
  assert.ok(paths.indexOf("Operations › Payments") < paths.indexOf("Operations › Payments › Settlement"));
});

test("deptOptionsOf: 停用部门带 inactive:true，在用的不带这个键", () => {
  const r = org.deptOptionsOf(ix, ["Old Desk", "AP"], null);
  assert.deepEqual(r.options.find((o) => o.id === "old"), { id: "old", name: "Old Desk", parentId: "fin", path: "Finance › Old Desk", level: 2, inactive: true });
  assert.ok(!("inactive" in r.options.find((o) => o.id === "ap")));
});

test("deptOptionsOf: 范围裁剪 —— 根落在二级时 parentId 为空、路径从二级起；范围只到四级时，最浅的范围内部门兜底成选项", () => {
  const allow = (n) => !["Operations", "DigiGroup"].includes(n);
  const r = org.deptOptionsOf(ix, ["Settlement", "Reconciliation", "Payments"], allow);
  assert.deepEqual(r.options.map((o) => [o.id, o.parentId, o.path, o.level]), [
    ["pay", null, "Payments", 2],
    ["set", "pay", "Payments › Settlement", 3],
  ]);
  assert.deepEqual(r.chainById.rec, ["pay", "set", "rec"]);
  assert.ok(!JSON.stringify(r).includes("Operations"), "范围外的部门名不出现在结果里");
  // 范围只有四级部门 Reconciliation 及其下级
  const deep = (n) => ["Reconciliation", "Recon Night"].includes(n);
  const r2 = org.deptOptionsOf(ix, ["Reconciliation", "Recon Night"], deep);
  assert.deepEqual(r2.options.map((o) => [o.id, o.parentId, o.path, o.level]), [["rec", null, "Reconciliation", 4]]);
  assert.deepEqual(r2.chainById.rec5, ["rec", "rec5"]);
  // 整条链都在范围外 → 不成选项，也不进 idByName / chainById
  const r3 = org.deptOptionsOf(ix, ["AP"], (n) => n === "Payments");
  assert.deepEqual(r3, { options: [], idByName: {}, chainById: {} });
});

test("deptOptionsOf: idByName 按名单里的原文作键（空白、大小写各成一键，指向同一个部门）", () => {
  const r = org.deptOptionsOf(ix, [" Finance ", "finance", "FINANCE", "Finance"], null);
  assert.deepEqual(r.idByName, { " Finance ": "fin", finance: "fin", FINANCE: "fin", Finance: "fin" });
  assert.equal(r.options.length, 1);
  // 只差大小写的两条部门：各自认领与自己原文相同的人（buildOrgIndex 的精确写法优先）
  const ix2 = org.buildOrgIndex([D("a", "Sales"), D("b", "SALES")]);
  const r2 = org.deptOptionsOf(ix2, ["Sales", "SALES", "sales"], null);
  assert.deepEqual(r2.idByName, { Sales: "a", SALES: "b", sales: "a" });
});

test("deptOptionsOf: counts（部门原文 → 人数）按「含下级」汇总到每个选项；Map 与普通对象都可以", () => {
  const counts = new Map([["Recon Night", 2], ["Settlement", 3], ["Payments", 1], ["Legacy Team", 4]]);
  const r = org.deptOptionsOf(ix, ["Recon Night", "Recon Night", "Settlement", "Payments", "Legacy Team"], null, { counts });
  const c = Object.fromEntries(r.options.map((o) => [o.id, o.count]));
  assert.deepEqual(c, { ops: 6, pay: 6, set: 5, "name:legacy team": 4 }, "同一原文在名单里重复出现只计一次");
  const r2 = org.deptOptionsOf(ix, ["AP"], null, { counts: { AP: 5 } });
  assert.deepEqual(r2.options.map((o) => [o.id, o.count]), [["fin", 5], ["ap", 5]]);
});

test("deptMatcherOf: 真实 id 含全部下级（集团层不算祖先）；name: 伪 id 与 __none；成环退回按名；找不到 → null", () => {
  const ops = org.deptMatcherOf(ix, "ops");
  assert.equal(ops("Recon Night"), true, "五级也在一级的子树里");
  assert.equal(ops("Finance"), false);
  const set = org.deptMatcherOf(ix, "set");
  assert.deepEqual(["Settlement", "Reconciliation", "Recon Night", "Payments"].map(set), [true, true, true, false]);
  const grp = org.deptMatcherOf(ix, "grp");
  assert.deepEqual(["DigiGroup", "Operations", "Finance"].map(grp), [true, false, false], "选集团节点只圈直挂它的人");
  const legacy = org.deptMatcherOf(ix, "name:Legacy TEAM");
  assert.deepEqual([" legacy team ", "Legacy", ""].map(legacy), [true, false, false]);
  const none = org.deptMatcherOf(ix, "__none");
  assert.deepEqual(["", "  ", null, undefined, "AP"].map(none), [true, true, true, true, false]);
  const loop = org.deptMatcherOf(ix, "la");
  assert.deepEqual(["Loop A", "loop a", "Loop B"].map(loop), [true, true, false], "父链成环：descendantIdsOf 为空，退回按部门名");
  assert.equal(org.deptMatcherOf(ix, "nope"), null);
  assert.equal(org.deptMatcherOf(ix, ""), null);
  assert.equal(org.deptMatcherOf(ix, "name:  "), null);
  assert.equal(org.deptMatcherOf(ix, null), null);
});

test("deptMatcherOf 与 deptOptionsOf 的 chainById 互为一致：选中任一选项，两种判定圈到的部门原文完全相同", () => {
  const r = org.deptOptionsOf(ix, NAMES, null);
  for (const o of r.options) {
    const m = org.deptMatcherOf(ix, o.id);
    for (const raw of NAMES.filter((n) => n && String(n).trim())) {
      const viaChain = !!(r.chainById[r.idByName[raw]] || []).includes(o.id);
      assert.equal(m(raw), viaChain, `${o.id} × ${raw}`);
    }
  }
});

// server.js reviewDeptOptions（2026-10-07 版）的原样抄录，用来证明 server 端委托后行为不变
function legacyReviewDeptOptions(users, ix0, allow) {
  const opts = new Map();
  const seenDept = new Set();
  for (const u of users) {
    const dep = u && u.department ? String(u.department).trim() : "";
    if (!dep || seenDept.has(dep)) continue;
    seenDept.add(dep);
    const chain = ix0.chainOf(dep);
    if (!chain) {
      const id = "name:" + dep.toLowerCase();
      if (!opts.has(id)) opts.set(id, { id, name: dep, parentId: null, path: dep, level: null, _k: [dep] });
      continue;
    }
    let parent = null;
    const names = [];
    chain.forEach((d, k) => {
      if (allow && !allow(d.name)) return;
      names.push(d.name);
      if (!opts.has(d.id)) opts.set(d.id, { id: d.id, name: d.name, parentId: parent, path: names.join(" › "), level: k + 1, _k: names.slice() });
      parent = d.id;
    });
  }
  const cmp = (a, b) => {
    for (let i = 0; i < Math.min(a._k.length, b._k.length); i++) { const c = a._k[i].localeCompare(b._k[i]); if (c) return c; }
    return a._k.length - b._k.length;
  };
  return [...opts.values()].sort(cmp).map(({ _k, ...o }) => o);
}

test("parity: 不限级数、不给 counts、部门都在用时，deptOptionsOf().options 与 reviewDeptOptions 逐字段相同（含范围裁剪）", () => {
  const live = TREE.filter((d) => d.active);
  const ixLive = org.buildOrgIndex(live);
  const names = NAMES.filter((n) => n !== "Old Desk");
  const users = names.map((department) => ({ department }));
  for (const allow of [null, (n) => n !== "Operations", (n) => n === "Reconciliation" || n === "Recon Night"]) {
    assert.deepEqual(org.deptOptionsOf(ixLive, names, allow, { maxLevel: Infinity }).options, legacyReviewDeptOptions(users, ixLive, allow));
    assert.deepEqual(org.deptOptionsOf(ixLive, names, allow, { maxLevel: 0 }).options, legacyReviewDeptOptions(users, ixLive, allow));
  }
  for (const n of names) assert.deepEqual(org.deptPathOf(ixLive, n), n && String(n).trim() ? (ixLive.chainOf(String(n).trim()) || []).map((d) => d.id).concat(ixLive.chainOf(String(n).trim()) ? [] : ["name:" + String(n).trim().toLowerCase()]) : []);
});

test("deptOptionsOf: 300 个部门 × 4,000 人的名单在毫秒级", () => {
  const depts = [];
  for (let a = 0; a < 10; a++) {
    depts.push(D(`l1-${a}`, `L1 ${a}`));
    for (let b = 0; b < 6; b++) {
      depts.push(D(`l2-${a}-${b}`, `L2 ${a}-${b}`, `l1-${a}`));
      for (let c = 0; c < 4; c++) depts.push(D(`l3-${a}-${b}-${c}`, `L3 ${a}-${b}-${c}`, `l2-${a}-${b}`));
    }
  }
  const big = org.buildOrgIndex(depts);
  const names = [];
  for (let i = 0; i < 4000; i++) names.push(depts[i % depts.length].name);
  const t0 = Date.now();
  const r = org.deptOptionsOf(big, names, null, { counts: new Map(names.map((n) => [n, 1])) });
  assert.equal(r.options.length, depts.length);
  assert.ok(Date.now() - t0 < 1000, "took " + (Date.now() - t0) + "ms");
});
