// modules/core/org.js 纯函数单测：部门三层口径（levelOf / level1Of / level2Of / level3Of、四级并入三级、
// 「本部」）与 HoD 推算（deriveHods）的全部分支 —— 负责人在职 / 负责人停用·离职·不存在 /
// 单顶端 / 多顶端（候选人排序）/ 无在职人员 / 子树内汇报线成环 / 单顶端但子树里另有环（loop_with_top）/
// 部门名不在部门表 / 部门父链成环 / 停用一级部门下的在职人员（inactive_level1）/ 部门名只差大小写
// （精确写法优先、duplicateNames），以及 4,000 人规模的 O(n) 耗时。
// 不起服务、不开库；HTTP 契约（接口、CSV、RBAC、部门范围）在 test/org-hod-api.test.js。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const org = require("../modules/core/org.js");

const D = (id, name, parentId = null, extra = {}) => ({ id, name, parentId, active: true, ...extra });
const U = (id, name, department, managerId = null, extra = {}) => ({ id, name, employeeId: id.toUpperCase(), department, managerId, role: "employee", active: 1, empStatus: "regular", ...extra });
const item = (res, name) => res.items.find((x) => x.deptName === name);
const ids = (list) => list.map((p) => p.id);

// ---------- 部门层级 ----------

const TREE = [
  D("ops", "Operations"),
  D("pay", "Payments", "ops"),
  D("set", "Settlement", "pay"),
  D("rec", "Reconciliation", "set"), // 四级
  D("fin", "Finance"),
  D("dang", "Dangling", "d-deleted"), // parentId 指向已删部门 → 视为一级
  D("la", "Loop A", "lb"),
  D("lb", "Loop B", "la"),
  D("lc", "Under Loop", "la"), // 挂在环下，同样无法定级
  D("self", "Self Parent", "self"),
];

test("levels: 一级 / 二级 / 三级，四级及更深并入所属三级；直接在一级部门 = 二级本部（level2 为 null、isDirect），直接在二级部门 = 三级本部（level3 为 null、isDirect2）", () => {
  const ix = org.buildOrgIndex(TREE);
  assert.deepEqual(ix.levelsOf("Operations"), { deptId: "ops", level: 1, level1: "Operations", level1Id: "ops", level2: null, level2Id: null, isDirect: true, level3: null, level3Id: null, isDirect2: false });
  assert.deepEqual(ix.levelsOf("Payments"), { deptId: "pay", level: 2, level1: "Operations", level1Id: "ops", level2: "Payments", level2Id: "pay", isDirect: false, level3: null, level3Id: null, isDirect2: true });
  assert.deepEqual(ix.levelsOf("Settlement"), { deptId: "set", level: 3, level1: "Operations", level1Id: "ops", level2: "Payments", level2Id: "pay", isDirect: false, level3: "Settlement", level3Id: "set", isDirect2: false });
  assert.equal(ix.levelOf("Settlement"), 3);
  assert.equal(ix.level2Of("Settlement"), "Payments", "三级的二级祖先");
  assert.equal(ix.level3Of("Settlement"), "Settlement");
  assert.equal(ix.levelOf("Reconciliation"), 4);
  assert.equal(ix.level2Of("Reconciliation"), "Payments", "四级的二级祖先");
  assert.equal(ix.level3Of("Reconciliation"), "Settlement", "四级并入三级");
  assert.equal(ix.levelsOf("Reconciliation").level3Id, "set");
  assert.equal(ix.level3Of("Payments"), null, "二级部门本身没有三级 —— 展示为「本部」");
  assert.equal(ix.level3Of("Operations"), null, "直接在一级部门：三级不适用");
  assert.equal(ix.level1Of("Reconciliation"), "Operations");
  assert.equal(ix.level2Of("Operations"), null, "一级部门本身没有二级 —— 展示为「本部」");
  assert.equal(ix.isDirect("Operations"), true);
  assert.equal(ix.isDirect("Payments"), false);
  assert.deepEqual(org.DIRECT_LABEL, { zh: "本部", en: "Direct" });
});

test("levels: 名称匹配去首尾空白、不区分大小写；空 / 不在部门表 → null", () => {
  const ix = org.buildOrgIndex(TREE);
  assert.equal(ix.level1Of("  settlement "), "Operations");
  assert.equal(ix.level2Of("SETTLEMENT"), "Payments");
  for (const v of ["", "   ", null, undefined, "Nowhere"]) {
    assert.equal(ix.levelsOf(v), null, `levelsOf(${JSON.stringify(v)})`);
    assert.equal(ix.levelOf(v), null);
    assert.equal(ix.level1Of(v), null);
    assert.equal(ix.level2Of(v), null);
    assert.equal(ix.level3Of(v), null);
    assert.equal(ix.isDirect(v), false);
  }
});

test("levels: 悬空 parentId 视为一级；父链成环（含自指、挂在环下）无法定级 → null", () => {
  const ix = org.buildOrgIndex(TREE);
  assert.equal(ix.levelOf("Dangling"), 1);
  assert.equal(ix.level1Of("Dangling"), "Dangling");
  for (const n of ["Loop A", "Loop B", "Under Loop", "Self Parent"]) assert.equal(ix.levelsOf(n), null, n);
  assert.deepEqual(ix.cyclic().map((d) => d.id).sort(), ["la", "lb", "lc", "self"]);
  assert.deepEqual(ix.roots().map((d) => d.id), ["ops", "fin", "dang"]);
  assert.deepEqual(ix.subtreeOf("ops").map((d) => d.id), ["ops", "pay", "set", "rec"]);
  assert.deepEqual(ix.subtreeOf("pay"), [], "不是一级部门 → 空");
  // 输入顺序无关：子部门排在父部门之前也能定级（记忆化沿父链一次走完）。
  const rev = org.buildOrgIndex(TREE.slice().reverse());
  assert.equal(rev.level2Of("Reconciliation"), "Payments");
  assert.equal(rev.levelsOf("Loop B"), null);
});

// ---------- HoD 推算 ----------

test("owner：部门页负责人在职 → source owner（不再推算，candidates 为空）", () => {
  const deps = [D("fin", "Finance", null, { ownerId: "u2" }), D("ap", "AP", "fin")];
  const users = [U("u1", "Top", "Finance"), U("u2", "Owner", "AP", "u1")];
  const r = org.deriveHods(deps, users);
  const it = item(r, "Finance");
  assert.equal(it.source, "owner");
  assert.equal(it.reason, "owner");
  assert.equal(it.hod.id, "u2");
  assert.equal(it.hod.direct, false, "负责人在二级部门");
  assert.deepEqual(it.candidates, []);
  assert.equal(it.ownerInactive, false);
  assert.deepEqual(it.owner, { id: "u2", name: "Owner", employeeId: "U2", status: "active" });
  assert.equal(it.memberCount, 2);
  // 负责人可以不在本部门（部门页可以指定任何人）。
  const r2 = org.deriveHods([D("fin", "Finance", null, { ownerId: "x" }), D("hr", "HR")], [U("x", "Outsider", "HR"), U("u1", "Top", "Finance")]);
  assert.equal(item(r2, "Finance").hod.id, "x");
  assert.equal(item(r2, "Finance").hod.direct, false);
});

test("ownerInactive：负责人停用 / 离职 / 不存在 → 标出并继续推算，两者都能看出", () => {
  const deps = [D("a", "Alpha", null, { ownerId: "gone" }), D("b", "Beta", null, { ownerId: "exited" }), D("c", "Gamma", null, { ownerId: "nobody" })];
  const users = [
    U("gone", "Gone Owner", "Alpha", null, { active: 0 }),
    U("a1", "Alpha Lead", "Alpha", "gone"), // 上级已停用 → 顶端
    U("exited", "Exited Owner", "Beta", null, { empStatus: "exited" }), // 账号没停但已离职
    U("b1", "Beta Lead", "Beta", "exited"),
    U("b2", "Beta Two", "Beta"),
  ];
  const r = org.deriveHods(deps, users);
  const a = item(r, "Alpha");
  assert.equal(a.ownerInactive, true);
  assert.equal(a.owner.status, "inactive");
  assert.equal(a.source, "derived");
  assert.equal(a.hod.id, "a1");
  const b = item(r, "Beta");
  assert.equal(b.ownerInactive, true);
  assert.equal(b.owner.status, "inactive", "empStatus exited 也算不在职");
  assert.equal(b.source, "ambiguous");
  assert.deepEqual(ids(b.candidates), ["b1", "b2"]);
  const c = item(r, "Gamma");
  assert.equal(c.ownerInactive, true);
  assert.deepEqual(c.owner, { id: "nobody", name: null, employeeId: null, status: "missing" });
  assert.equal(c.source, "none");
  assert.equal(c.reason, "no_members");
  assert.equal(r.summary.ownerInactive, 3);
});

test("derived：恰好一个顶端；上级为空 / 离职 / 不存在 / 在别的一级部门 / 是系统账号，都算顶端", () => {
  const deps = [D("ops", "Ops"), D("pay", "Pay", "ops"), D("set", "Settle", "pay"), D("hr", "HR")];
  const base = [U("h", "Head", "Ops"), U("m", "Mid", "Pay", "h"), U("l", "Leaf", "Settle", "m")];
  const r = org.deriveHods(deps, base);
  const it = item(r, "Ops");
  assert.equal(it.source, "derived");
  assert.equal(it.reason, "single_top");
  assert.equal(it.hod.id, "h");
  assert.equal(it.hod.direct, true);
  assert.equal(it.memberCount, 3, "三级部门的人也计入所属一级部门");
  // 各种「上级不算本部门成员」的情形：换掉 Head 的上级，Head 仍是唯一顶端。
  const cases = {
    "manager missing": [U("h", "Head", "Ops", "ghost")],
    "manager inactive": [U("h", "Head", "Ops", "x"), U("x", "Old Boss", "Ops", null, { active: 0 })],
    "manager other L1": [U("h", "Head", "Ops", "x"), U("x", "CEO", "HR")],
    "manager is system account": [U("h", "Head", "Ops", "x"), U("x", "Admin", "Ops", null, { role: "admin" })],
  };
  for (const [label, head] of Object.entries(cases)) {
    const users = [...head, U("m", "Mid", "Pay", "h"), U("l", "Leaf", "Settle", "m")];
    const got = item(org.deriveHods(deps, users), "Ops");
    assert.equal(got.source, "derived", label);
    assert.equal(got.hod.id, "h", label);
  }
});

test("ambiguous：多个顶端 → candidates 列全部顶端，直接挂在一级部门的人排前，再按姓名", () => {
  const deps = [D("mkt", "Marketing"), D("br", "Brand", "mkt"), D("ev", "Events", "br")];
  const users = [
    U("z", "zed", "Brand"),
    U("a", "Amy", "Events"),
    U("y", "Yan", "Marketing"),
    U("b", "bob", "Marketing"),
    U("k", "Kid", "Brand", "z"), // 不是顶端
    U("n10", "Ann 10", "Brand"),
    U("n9", "Ann 9", "Brand"), // numeric 排序：Ann 9 在 Ann 10 之前
  ];
  const it = item(org.deriveHods(deps, users), "Marketing");
  assert.equal(it.source, "ambiguous");
  assert.equal(it.reason, "multiple_tops");
  assert.equal(it.hod, null);
  assert.deepEqual(ids(it.candidates), ["b", "y", "a", "n9", "n10", "z"]);
  assert.deepEqual(it.candidates.map((c) => c.direct), [true, true, false, false, false, false]);
  assert.equal(it.memberCount, 7);
});

test("none：成员为 0（含只有离职者与系统账号的部门）；停用的一级部门不成行，其下的在职人员计入未归属（inactive_level1）", () => {
  const deps = [D("e", "Empty"), D("q", "Quiet"), D("off", "Closed", null, { active: false }), D("offk", "Closed Kid", "off")];
  const users = [U("x", "Left", "Quiet", null, { active: 0 }), U("s", "System", "Quiet", null, { role: "admin" }), U("c", "In Closed", "Closed Kid"), U("d", "Direct Closed", "Closed"),
    U("cx", "Closed Leaver", "Closed Kid", null, { empStatus: "exited" })];
  const r = org.deriveHods(deps, users);
  assert.equal(item(r, "Empty").source, "none");
  assert.equal(item(r, "Empty").reason, "no_members");
  assert.equal(item(r, "Quiet").source, "none");
  assert.equal(item(r, "Quiet").memberCount, 0);
  assert.equal(item(r, "Closed"), undefined, "停用的一级部门不列");
  // 停用一级部门是删除校验引导的正规做法（有在编员工只能停用）：其下的在职人员不能从名单上悄悄消失。
  assert.deepEqual(r.unassignedPeople, [
    { id: "d", name: "Direct Closed", employeeId: "D", department: "Closed", reason: "inactive_level1", level1: "Closed" },
    { id: "c", name: "In Closed", employeeId: "C", department: "Closed Kid", reason: "inactive_level1", level1: "Closed" },
  ], "直接挂在停用一级部门、挂在其下级部门的在职人员都列出；离职者不列");
  assert.equal(r.summary.unassignedPeople, 2, "summary 的覆盖面把他们算进未归属");
  assert.equal(org.createOrgResolver(deps, users).hodOf("Closed Kid"), null, "他们没有 HoD（hodOf 仍为 null）");
  // 停用的二级部门照样计入所属（在用的）一级部门：停用部门不会清掉员工身上的部门名。
  const r2 = org.deriveHods([D("ops", "Ops"), D("old", "Old Team", "ops", { active: false })], [U("h", "Head", "Old Team")]);
  assert.equal(item(r2, "Ops").hod.id, "h");
});

test("loop：成员非 0 但顶端为 0（子树内汇报线成环）→ ambiguous / reason loop，candidates = 环上的人", () => {
  const deps = [D("l", "Loopy"), D("l2", "Loopy Sub", "l")];
  const users = [
    U("a", "Ada", "Loopy", "b"),
    U("b", "Ben", "Loopy Sub", "c"),
    U("c", "Cai", "Loopy Sub", "a"),
    U("t", "Tail", "Loopy Sub", "a"), // 挂在环下，但不在环上
  ];
  const it = item(org.deriveHods(deps, users), "Loopy");
  assert.equal(it.source, "ambiguous");
  assert.equal(it.reason, "loop");
  assert.equal(it.hod, null);
  assert.deepEqual(ids(it.candidates), ["a", "b", "c"], "本部（Ada）排前，再按姓名；Tail 不在环上");
  assert.equal(it.memberCount, 4);
  // 自己是自己的上级：单人成环。
  const self = item(org.deriveHods([D("s", "Solo")], [U("s1", "Solo Lead", "Solo", "s1")]), "Solo");
  assert.equal(self.reason, "loop");
  assert.deepEqual(ids(self.candidates), ["s1"]);
});

test("loop_with_top：只有一个顶端、但子树里另有汇报环 → 需确认（不能把 HoD 判给那个唯一向外汇报的人）", () => {
  // 真正的负责人 H 的上级被误设成下属 X（H↔X 互为上级），其余人挂在 H 或 X 下；只有普通员工 J
  // 向部门外的 CEO 汇报 —— J 是唯一顶端。以前判为 derived / single_top，J 会拿到 HoD 身份
  // （按已定规则可看整个一级部门的「周五真事」），名单上也不提示 HR。
  const deps = [D("ops", "Ops"), D("opa", "Ops-A", "ops"), D("ex", "Exec")];
  const users = [
    U("H", "Hana Head", "Ops", "X"), U("X", "Xavier", "Ops-A", "H"),
    U("m1", "Mia", "Ops-A", "H"), U("m2", "Max", "Ops-A", "X"),
    U("J", "Junior", "Ops-A", "C"), U("C", "Cee Oh", "Exec"),
  ];
  const r = org.deriveHods(deps, users);
  const it = item(r, "Ops");
  assert.equal(it.source, "ambiguous");
  assert.equal(it.reason, "loop_with_top");
  assert.equal(it.hod, null);
  assert.deepEqual(ids(it.candidates), ["H", "J", "X"], "顶端 + 环上的人；本部（Hana）排前，再按姓名；挂在环下的 Mia / Max 不列");
  assert.equal(it.memberCount, 5);
  assert.equal(org.createOrgResolver(deps, users).hodOf("Ops-A"), null, "需确认 → hodOf 为 null");
  assert.equal(item(r, "Exec").source, "derived", "别的部门不受影响");
  // 修好环（H 不再有上级）→ 两个顶端（H 与 J）→ multiple_tops；把 J 也挂到 H 下 → derived / H。
  const fixed = users.map((u) => (u.id === "H" ? { ...u, managerId: null } : u));
  assert.equal(item(org.deriveHods(deps, fixed), "Ops").reason, "multiple_tops");
  const clean = fixed.map((u) => (u.id === "J" ? { ...u, managerId: "H" } : u));
  const ok = item(org.deriveHods(deps, clean), "Ops");
  assert.equal(ok.source, "derived");
  assert.equal(ok.hod.id, "H");
});

test("部门名只差大小写：精确写法优先，其余变体归排在前面的一条；重名组由 duplicateNames 列出（含非 ASCII 字母）", () => {
  // store.getDepartmentByName 以前用 SQLite lower()，只折叠 ASCII：「PARAÑAQUE OFFICE」查不到
  // 「Parañaque Office」，于是新建出一条只差大小写的一级部门。这类存量数据下，org.js 让每个人
  // 落在与自己原文相同的那条部门上，而不是一律归到先出现的那条。
  const deps = [D("tech", "Technology"), D("pq", "Parañaque Office", "tech"), D("PQ", "PARAÑAQUE OFFICE"), D("s1", "Sales"), D("s2", "SALES")];
  const ix = org.buildOrgIndex(deps);
  assert.equal(ix.levelsOf("PARAÑAQUE OFFICE").deptId, "PQ", "精确写法 → 那条一级部门");
  assert.equal(ix.levelsOf("Parañaque Office").level1, "Technology", "精确写法 → Technology 下的二级部门");
  assert.equal(ix.levelsOf("parañaque office").deptId, "pq", "其余大小写变体（含 ñ/Ñ）→ 排在前面的一条");
  assert.equal(ix.levelsOf(" SALES ").deptId, "s2", "精确匹配先去首尾空白");
  assert.equal(ix.levelsOf("sales").deptId, "s1");
  assert.deepEqual(ix.duplicates(), [
    { name: "Parañaque Office", departments: [{ id: "pq", name: "Parañaque Office", active: true }, { id: "PQ", name: "PARAÑAQUE OFFICE", active: true }] },
    { name: "Sales", departments: [{ id: "s1", name: "Sales", active: true }, { id: "s2", name: "SALES", active: true }] },
  ]);
  const users = [U("a", "Ana", "Parañaque Office"), U("b", "Ben", "PARAÑAQUE OFFICE"), U("c", "Cai", "parañaque office")];
  const r = org.deriveHods(deps, users);
  assert.deepEqual(ids(item(r, "Technology").candidates), ["a", "c"], "Ana（原文相同）与 Cai（小写变体）落在 Technology 下");
  assert.equal(item(r, "PARAÑAQUE OFFICE").hod.id, "b");
  assert.equal(r.duplicateNames.length, 2, "deriveHods 把重名组带出来，供 HR 合并");
  assert.deepEqual(org.deriveHods([D("x", "X")], []).duplicateNames, []);
});

test("unassignedPeople：部门为空 / 部门名不在部门表 / 部门父链成环；离职者与系统账号不计", () => {
  const users = [
    U("n1", "No Dept", ""),
    U("n2", "Null Dept", null),
    U("g", "Ghost", "Ghost Team"),
    U("c", "Cyclic", "Loop A"),
    U("left", "Left Ghost", "Ghost Team", null, { active: 0 }),
    U("sys", "System", null, null, { role: "admin" }),
    U("ok", "Fine", "Operations"),
  ];
  const r = org.deriveHods(TREE, users);
  assert.deepEqual(r.unassignedPeople.map((p) => [p.id, p.reason]), [["c", "cycle"], ["g", "unknown"], ["n1", "blank"], ["n2", "blank"]]);
  assert.deepEqual(r.unassignedPeople[1], { id: "g", name: "Ghost", employeeId: "G", department: "Ghost Team", reason: "unknown", level1: null });
  assert.equal(r.summary.unassignedPeople, 4);
  assert.equal(item(r, "Operations").hod.id, "ok");
});

test("summary 与 summarize：按 source 计数，过滤之后用同一个函数重算", () => {
  const deps = [D("a", "A", null, { ownerId: "o" }), D("b", "B"), D("c", "C"), D("d", "D", null, { ownerId: "gone" })];
  const users = [U("o", "Owner", "A"), U("b1", "B1", "B"), U("c1", "C1", "C"), U("c2", "C2", "C"), U("gone", "Gone", "D", null, { active: 0 }), U("x", "X", "Nope")];
  const r = org.deriveHods(deps, users);
  assert.deepEqual(r.summary, { total: 4, owner: 1, derived: 1, ambiguous: 1, none: 1, ownerInactive: 1, unassignedPeople: 1 });
  assert.deepEqual(org.summarize(r.items.filter((x) => x.deptName !== "C"), []), { total: 3, owner: 1, derived: 1, ambiguous: 0, none: 1, ownerInactive: 1, unassignedPeople: 0 });
  assert.deepEqual(org.SOURCES, ["owner", "derived", "ambiguous", "none"]);
});

test("createOrgResolver.hodOf：三级部门的人拿到一级部门的 HoD；需确认 / 无人 / 未知部门 / 停用一级 → null", () => {
  const deps = [D("ops", "Ops"), D("pay", "Pay", "ops"), D("set", "Settle", "pay"), D("mkt", "Mkt"), D("e", "Empty"), D("off", "Closed", null, { active: false }), D("fin", "Fin", null, { ownerId: "fo" })];
  const users = [U("h", "Head", "Ops"), U("l", "Leaf", "Settle", "h"), U("m1", "M1", "Mkt"), U("m2", "M2", "Mkt"), U("c", "C", "Closed"), U("fo", "Fin Owner", "Fin")];
  const snap = org.createOrgResolver(deps, users);
  const hod = snap.hodOf("settle");
  assert.equal(hod.id, "h");
  assert.equal(hod.source, "derived");
  assert.equal(hod.level1, "Ops");
  assert.equal(hod.level1Id, "ops");
  assert.equal(snap.hodOf("Fin").source, "owner");
  for (const n of ["Mkt", "Empty", "Closed", "Nowhere", "", null]) assert.equal(snap.hodOf(n), null, `hodOf(${JSON.stringify(n)})`);
  assert.equal(snap.levelsOf("Settle").level2, "Pay");
  assert.equal(snap.hods.summary.total, 4, "停用的一级部门不计");
});

// ---------- P0 1.5：部门链与下级部门（评估周期按部门圈人 / 筛选包含下级）----------

test("chainOf：一级 → 本部门，全深度（四级不截断）；集团层不算祖先；空 / 未知 / 父链成环 → null", () => {
  const ix = org.buildOrgIndex(TREE);
  assert.deepEqual(ix.chainOf("Reconciliation").map((d) => d.id), ["ops", "pay", "set", "rec"], "四级不在三级截断");
  assert.deepEqual(ix.chainOf("Reconciliation").map((d) => d.name), ["Operations", "Payments", "Settlement", "Reconciliation"]);
  assert.deepEqual(ix.chainOf("Finance"), [{ id: "fin", name: "Finance" }]);
  assert.deepEqual(ix.chainOf("  settlement ").map((d) => d.id), ["ops", "pay", "set"], "名称匹配去首尾空白、不区分大小写");
  assert.deepEqual(ix.chainOf("Dangling").map((d) => d.id), ["dang"], "悬空 parentId = 一级");
  for (const v of ["Loop A", "Loop B", "Under Loop", "Self Parent", "Nowhere", "", "   ", null, undefined]) assert.equal(ix.chainOf(v), null, `chainOf(${JSON.stringify(v)})`);
  // 不变式：链首 = levelsOf 的一级部门，链长 = 层级
  for (const d of TREE) {
    const lv = ix.levelsOf(d.name);
    if (!lv) continue;
    const ch = ix.chainOf(d.name);
    assert.equal(ch[0].id, lv.level1Id, d.name);
    assert.equal(ch.length, lv.level, d.name);
    assert.equal(ch[ch.length - 1].id, d.id, d.name);
  }
  // 集团层（Lark L0–L2）不算祖先：挂在集团层下的部门自己就是一级
  const g = org.buildOrgIndex([D("grp", "Group", null, { group: true }), D("o2", "Ops2", "grp"), D("o2a", "Ops2 A", "o2")]);
  assert.deepEqual(g.chainOf("Ops2").map((d) => d.id), ["o2"]);
  assert.deepEqual(g.chainOf("Ops2 A").map((d) => d.id), ["o2", "o2a"]);
  assert.equal(g.chainOf("Ops2 A")[0].id, g.levelsOf("Ops2 A").level1Id);
});

test("descendantIdsOf：含自己与全部下级（= 所有 chainOf 含这个 id 的部门）；成环 / 未知 → 空 Set；集团层只含自己", () => {
  const ix = org.buildOrgIndex(TREE);
  assert.deepEqual([...ix.descendantIdsOf("pay")].sort(), ["pay", "rec", "set"]);
  assert.deepEqual([...ix.descendantIdsOf("ops")].sort(), ["ops", "pay", "rec", "set"]);
  assert.deepEqual([...ix.descendantIdsOf("rec")], ["rec"]);
  assert.deepEqual([...ix.descendantIdsOf("fin")], ["fin"]);
  for (const id of ["la", "lb", "lc", "self", "nope", ""]) assert.equal(ix.descendantIdsOf(id).size, 0, id);
  // 与 chainOf 互为反向
  for (const a of TREE) for (const b of TREE) {
    const ch = ix.chainOf(b.name);
    assert.equal(ix.descendantIdsOf(a.id).has(b.id), !!ch && ch.some((d) => d.id === a.id), `${a.id} ⊇ ${b.id}`);
  }
  // 返回的是副本：调用方改它不影响下一次
  ix.descendantIdsOf("pay").add("x");
  assert.equal(ix.descendantIdsOf("pay").has("x"), false);
  const g = org.buildOrgIndex([D("grp", "Group", null, { group: true }), D("o2", "Ops2", "grp")]);
  assert.deepEqual([...g.descendantIdsOf("grp")], ["grp"], "集团层不是祖先，只含自己");
});

test("createOrgResolver.hodItemOf：一级部门的推算行（区分「无 HoD」与「HoD 待确认」）；停用 / 未知 → null", () => {
  const deps = [D("ops", "Ops"), D("mkt", "Mkt"), D("off", "Closed", null, { active: false }), D("fin", "Fin", null, { ownerId: "gone" }), D("e", "Empty")];
  const users = [U("h", "Head", "Ops"), U("m1", "M1", "Mkt"), U("m2", "M2", "Mkt"), U("c", "C", "Closed"), U("f1", "F1", "Fin"), U("f2", "F2", "Fin"),
    U("gone", "Gone", "Fin", null, { active: 0, empStatus: "exited" })];
  const snap = org.createOrgResolver(deps, users);
  assert.equal(snap.hodItemOf("ops").source, "derived");
  assert.equal(snap.hodItemOf("mkt").source, "ambiguous");
  assert.equal(snap.hodItemOf("fin").ownerInactive, true);
  assert.equal(snap.hodItemOf("fin").hod, null, "负责人离职、推算多个顶端 → 没有 HoD");
  assert.equal(snap.hodItemOf("e").source, "none");
  assert.equal(snap.hodItemOf("off"), null, "停用的一级部门不成行");
  assert.equal(snap.hodItemOf("nope"), null);
});

// ---------- 规模：O(n) ----------

// 真实形状的合成组织：D 个部门（一级 / 二级 / 三级），n 人，每个部门一棵经理树。
function synth(n, deptCount = 300) {
  const deps = [];
  const l1 = Math.max(1, Math.floor(deptCount / 10));
  for (let i = 0; i < l1; i++) deps.push(D("l1-" + i, "L1 " + i));
  for (let i = l1; i < deptCount; i++) {
    const lvl3 = i % 3 === 0 && i > l1 * 2;
    deps.push(D("d-" + i, "Dept " + i, lvl3 ? "d-" + (i - l1) : "l1-" + (i % l1)));
  }
  const pos = new Map(deps.map((d, i) => [d.id, i]));
  const users = [];
  const lastIn = new Map();
  for (let i = 0; i < n; i++) {
    const d = deps[i % deps.length];
    const prev = lastIn.get(d.id);
    // 每个部门：第一个人（u-<部门序号>）挂到上级部门的第一个人，其余挂在本部门前一个人下
    // （深链，最坏情形）；一级部门的第一个人没有上级 → 每个一级部门恰好一个顶端。
    const mgr = prev || (d.parentId ? "u-" + pos.get(d.parentId) : null);
    users.push(U("u-" + i, "Person " + i, d.name, mgr));
    lastIn.set(d.id, "u-" + i);
  }
  return { deps, users };
}
const bestOf = (k, fn) => { let best = Infinity; for (let i = 0; i < k; i++) { const t = process.hrtime.bigint(); fn(); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); } return best; };

test("规模：4,000 人 × 300 部门在毫秒级，且耗时随人数线性增长（O(n)，不是 O(n²)）", () => {
  const s4 = synth(4000);
  const r = org.deriveHods(s4.deps, s4.users);
  assert.equal(r.items.length, 30);
  assert.equal(r.items.reduce((a, x) => a + x.memberCount, 0), 4000, "每个人都归到了某个一级部门");
  assert.ok(r.items.every((x) => x.source === "derived"), "合成组织每个一级部门恰好一个顶端");
  const t4 = bestOf(3, () => org.deriveHods(s4.deps, s4.users));
  assert.ok(t4 < 250, `4,000 人推算用了 ${t4.toFixed(1)}ms`);
  // 线性判据：人数 ×8，耗时比远小于 64（平方）—— 取三次最好成绩压掉抖动，阈值留足余量。
  const s32 = synth(32000);
  const t32 = bestOf(3, () => org.deriveHods(s32.deps, s32.users));
  const ratio = t32 / Math.max(t4, 0.5);
  assert.ok(ratio < 24, `32,000 / 4,000 人耗时比 ${ratio.toFixed(1)}（${t32.toFixed(1)}ms / ${t4.toFixed(1)}ms）`);
  // 最坏情形之一：一个一级部门、4,000 人首尾相接成一个大环（环检测也必须线性）。
  const ring = Array.from({ length: 4000 }, (_, i) => U("r" + i, "R " + i, "Ring", "r" + ((i + 1) % 4000)));
  const tr = bestOf(3, () => org.deriveHods([D("ring", "Ring")], ring));
  const rr = org.deriveHods([D("ring", "Ring")], ring);
  assert.equal(item(rr, "Ring").reason, "loop");
  assert.equal(item(rr, "Ring").candidates.length, 4000);
  assert.ok(tr < 250, `4,000 人大环用了 ${tr.toFixed(1)}ms`);
});
