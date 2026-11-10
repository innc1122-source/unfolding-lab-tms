// 组织层级与 HoD 推算 —— 纯函数（不 require store、不读库、不读 config、不起服务）。
//
// 输入是两张表的行（store.listDepartments(true) 与 store.listUsers() 的形状），输出是
// 可直接 JSON 化的结果。server.js 的 hodOf / deptLevelsOf / GET /api/admin/departments/hods
// 都从这里取数；后续 culture（3+3 行为实践）适配层也只经 server.js 的那两个封装读它。
//
// ===== 已定规则（2026-09 与 HR 对齐）=====
//   · 部门用三层（2026-09-28 起）：一级部门（departments.parentId 为空）、二级部门、三级部门。
//     四级及更深并入所属三级祖先（level3Of 返回其三级祖先）。人直接挂在一级部门时二级维度
//     记为「本部」、三级维度不适用（level2Of / level3Of 返回 null，levelsOf 的 isDirect = true）；
//     直接挂在二级部门时三级维度记为「本部」（level3Of 返回 null，isDirect2 = true）；展示用 DIRECT_LABEL。
//     HoD 推算只看一级部门（deriveHods / hodOf 只用 level1Id 与 isDirect）。
//   · HoD = 员工所属一级部门的负责人。deriveHods() 对每个在用（active）的一级部门给出
//     负责人：部门页填了 ownerId 且此人在职 → 用它（source "owner"）；否则按汇报线推算
//     （"derived" / "ambiguous" / "none"），ownerId 填了但此人已离职/不存在时两者都标出。
//
// ===== 口径 =====
//   在职      users.active 不为 0/false，且 empStatus !== "exited"（与 review-cycles 建周期、
//             到期提醒等处同一口径：离职记录会同时写 exited + active=0，但只写了其一的旧
//             数据也按离职算）。
//   系统账号  role === "admin"（种子 ADMIN 等），不参与推算，也不计入未归属人员。
//   部门匹配  users.department 是部门**名**；先按去首尾空白后的原文精确匹配，找不到再按
//             不区分大小写匹配（JS toLowerCase，含非 ASCII 字母；与 store.getDepartmentByName /
//             范围解析同一口径）。部门表里只差大小写的两条部门（只可能来自直写库或历史数据：
//             getDepartmentByName 现在按同一口径查重）各自认领与自己原文相同的人，其余大小写
//             变体归排在前面（sort, name）的一条；这类重名由 duplicateNames 列出，供 HR 合并。
//   父级      parentId 为空、或指向不存在的部门 → 视为一级（与 Departments.jsx 把悬空
//             parentId 画成根行一致）。parentId 成环（只可能来自直写库：PUT 与
//             ensureDepartment 都拦了）→ 环上及挂在环下的部门无法定级，其成员计入
//             unassignedPeople（reason "cycle"）。
//
// ===== 推算（ownerId 未填或已失效时）=====
//   成员 = 在职、非系统账号、所属部门落在该一级部门子树内的人。
//   顶端 = 上级为空，或上级不是本一级部门的成员（上级离职/停用/不存在/在别的一级部门/
//          是系统账号）的成员。这比「上级不在职或不在同一子树」多兜住一种情况：上级是
//          子树内的系统账号 —— 否则那种数据会被误报成「成环」。
//   恰好 1 个顶端、且其余成员沿上级链都能走到它 → "derived"；多于 1 个 → "ambiguous"（reason
//   "multiple_tops"，candidates = 全部顶端，直接挂在一级部门的人排前，再按姓名）；成员为 0 →
//   "none"；成员非 0 但顶端为 0 → 子树内汇报线成环（每个成员的上级都是成员，有限图必有环）→
//   "ambiguous"，reason "loop"，candidates = 环上的人（让 HR 知道去改谁的上级）。
//   恰好 1 个顶端、但子树里另有一个环（环上的人走不到这个顶端）→ "ambiguous"，reason
//   "loop_with_top"，candidates = 顶端 + 环上的人：典型情形是真正的负责人与某个下属互为上级、
//   只剩一个向外汇报的普通员工成了唯一顶端 —— 不能把 HoD 判给他。
//   停用的一级部门不成行；挂在它下面的在职人员不会悄悄消失，计入 unassignedPeople
//   （reason "inactive_level1"，level1 = 该一级部门名），HR 在名单里能看到要把谁调走。
//
// ===== 复杂度 =====
//   部门定级：每个部门沿父链最多被走一次（记忆化），O(D)。
//   成员归组、顶端判定：每人 O(1) 的 Map 查找，O(n)。环检测：每个成员最多进栈一次，O(n)。
//   候选人排序只对顶端做（通常个位数）。4,000 人 × 300 部门在毫秒级（test/org-hod.test.js 量过）。
"use strict";

const DIRECT_LABEL = Object.freeze({ zh: "本部", en: "Direct" });
const SOURCES = Object.freeze(["owner", "derived", "ambiguous", "none"]);

const norm = (s) => (s === null || s === undefined ? "" : String(s).trim().toLowerCase());
const blank = (v) => v === null || v === undefined || String(v).trim() === "";

function isInService(u) {
  return !!u && u.active !== 0 && u.active !== false && u.active !== "0" && u.empStatus !== "exited";
}
function isSystemAccount(u) {
  return !!u && u.role === "admin";
}

// 固定排序规则（不随运行环境的默认语言变化）：姓名 → 工号 → id。
const COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });
function byName(a, b) {
  return COLLATOR.compare(String(a.name || ""), String(b.name || ""))
    || COLLATOR.compare(String(a.employeeId || ""), String(b.employeeId || ""))
    || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
}

// ---------- 部门层级 ----------
// buildOrgIndex(departments) → 索引对象。departments 行需要 { id, name, parentId, active? }。
// 名称匹配先精确（去首尾空白后的原文）、再不区分大小写；同一写法重复时取先出现的一条
// （store.listDepartments 按 sort, name 排序，与 getDepartmentByName 的取法一致）。
function buildOrgIndex(departments) {
  const byId = new Map();
  const byName = new Map();
  const byExact = new Map();
  const byKey = new Map();   // norm(name) → 全部同名（只差大小写/空白）的部门，按输入顺序
  for (const d of departments || []) {
    if (!d || blank(d.id)) continue;
    const rec = {
      id: String(d.id),
      name: d.name === null || d.name === undefined ? "" : String(d.name),
      parentId: blank(d.parentId) ? null : String(d.parentId),
      active: d.active !== false && d.active !== 0,
      ownerId: blank(d.ownerId) ? null : String(d.ownerId),
      sort: d.sort,
      // 集团层（2026-10-01，modules/core/larksync.js）：部门树完整保留 Lark 的 L0–L2，但这几层不算一级部门 ——
      // 上级是集团层的部门即为一级部门；集团层本身只对直接挂在它上面的人算一级（见 deriveHods）。
      group: d.group === true,
    };
    if (byId.has(rec.id)) continue;
    byId.set(rec.id, rec);
    const k = norm(rec.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, rec);
    const exact = rec.name.trim();
    if (!byExact.has(exact)) byExact.set(exact, rec);
    const same = byKey.get(k);
    if (same) same.push(rec); else byKey.set(k, [rec]);
  }

  // id → { level, l1Id, l2Id }；false = 父链成环、无法定级。
  const info = new Map();
  for (const startId of byId.keys()) {
    if (info.has(startId)) continue;
    const path = [];
    const onPath = new Set();
    let cur = startId;
    let base;            // undefined = path 的最后一个就是根；对象 = 已定级的祖先；false = 环
    for (;;) {
      path.push(cur);
      onPath.add(cur);
      const p = byId.get(cur).parentId;
      if (!p || !byId.has(p) || byId.get(p).group) { base = undefined; break; }   // 顶到根（空或悬空 parentId，或上级是集团层）
      if (info.has(p)) { base = info.get(p); break; }        // 接上已定级的祖先（可能是 false）
      if (onPath.has(p)) { base = false; break; }            // 本次路径上成环
      cur = p;
    }
    if (base === false) { for (const id of path) info.set(id, false); continue; }
    let parent = base;
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i];
      // 定级时一并记三级祖先：parent 为一级 → 本部门是二级（无三级）；parent 为二级 → 本部门是三级；
      // parent 为三级及更深 → 沿用 parent 的三级。
      const inf = parent === undefined
        ? { level: 1, l1Id: id, l2Id: null, l3Id: null }
        : { level: parent.level + 1, l1Id: parent.l1Id,
            l2Id: parent.level === 1 ? id : parent.l2Id,
            l3Id: parent.level === 1 ? null : parent.level === 2 ? id : parent.l3Id };
      info.set(id, inf);
      parent = inf;
    }
  }

  // 一级部门 id → 子树内全部部门（含自己），按输入顺序。
  const subtree = new Map();
  for (const [id, inf] of info) {
    if (!inf) continue;
    const list = subtree.get(inf.l1Id);
    if (list) list.push(byId.get(id)); else subtree.set(inf.l1Id, [byId.get(id)]);
  }

  const deptOf = (deptName) => {
    const k = norm(deptName);
    if (!k) return null;
    return byExact.get(String(deptName).trim()) || byName.get(k) || null;
  };
  // levelsOf(deptName) → null（空/不在部门表/父链成环）或
  //   { deptId, level, level1, level1Id, level2, level2Id, isDirect, level3, level3Id, isDirect2 }
  // level2 / level2Id：三级及更深返回其二级祖先；人直接在一级部门时为 null（isDirect = true，
  // 展示为 DIRECT_LABEL「本部」）。
  // level3 / level3Id：四级及更深返回其三级祖先；人直接在一级或二级部门时为 null
  // （直接在二级：isDirect2 = true，三级展示为「本部」；直接在一级：三级不适用）。
  const levelsOf = (deptName) => {
    const d = deptOf(deptName);
    if (!d) return null;
    const inf = info.get(d.id);
    if (!inf) return null;
    const l1 = byId.get(inf.l1Id);
    const l2 = inf.l2Id ? byId.get(inf.l2Id) : null;
    const l3 = inf.l3Id ? byId.get(inf.l3Id) : null;
    return {
      deptId: d.id,
      level: inf.level,
      level1: l1.name,
      level1Id: l1.id,
      level2: l2 ? l2.name : null,
      level2Id: l2 ? l2.id : null,
      isDirect: inf.level === 1,
      level3: l3 ? l3.name : null,
      level3Id: l3 ? l3.id : null,
      isDirect2: inf.level === 2,
    };
  };
  // chainOf(deptName) → [{ id, name }]，从一级部门排到本部门，全深度（不像 levelsOf 在三级截断）；
  // 集团层不算祖先（与 levelsOf / HoD 同一口径）。空 / 不在部门表 / 父链成环 → null。
  // 不变式：chainOf(x)[0].id === levelsOf(x).level1Id，链长 === levelsOf(x).level。
  // 评估周期按部门圈人与筛选（P0 1.5）用它把「选上级部门」解释为「含全部下级部门」。
  const chainOf = (deptName) => {
    const d = deptOf(deptName);
    if (!d || !info.get(d.id)) return null;
    const out = [];
    let cur = d;
    for (;;) {
      out.push({ id: cur.id, name: cur.name });
      const ci = info.get(cur.id);
      if (!ci || ci.level === 1) break;
      cur = byId.get(cur.parentId);
      if (!cur) break;
    }
    return out.reverse();
  };
  // descendantIdsOf(id) → Set（含自己）= 所有 chainOf 里含这个 id 的部门，所以与 chainOf 互为反向。
  // 第一次调用时一次性建表（每个部门沿父链走一次，O(D × 深度)）。未知 / 父链成环 → 空 Set。
  let descMap = null;
  const descendantIdsOf = (id) => {
    if (!descMap) {
      descMap = new Map();
      for (const [did, inf] of info) {
        if (!inf) continue;
        let cur = byId.get(did);
        for (;;) {
          let s = descMap.get(cur.id);
          if (!s) descMap.set(cur.id, (s = new Set()));
          s.add(did);
          const ci = info.get(cur.id);
          if (!ci || ci.level === 1) break;
          cur = byId.get(cur.parentId);
          if (!cur) break;
        }
      }
    }
    return new Set(descMap.get(String(id)) || []);
  };

  return {
    byId,
    deptOf,
    levelsOf,
    chainOf,
    descendantIdsOf,
    // 部门在树里的层级（1 = 一级）；空/未知/成环 → null。
    levelOf: (deptName) => { const l = levelsOf(deptName); return l ? l.level : null; },
    // 所属一级部门名；空/未知/成环 → null。
    level1Of: (deptName) => { const l = levelsOf(deptName); return l ? l.level1 : null; },
    // 所属二级部门名（三级及更深 → 其二级祖先）；直接在一级部门（本部）或未知 → null。
    level2Of: (deptName) => { const l = levelsOf(deptName); return l ? l.level2 : null; },
    // 所属三级部门名（四级及更深 → 其三级祖先）；直接在一级或二级部门、或未知 → null。
    level3Of: (deptName) => { const l = levelsOf(deptName); return l ? l.level3 : null; },
    // 该部门名是否就是一级部门本身（人挂在这里 = 「本部」）。未知 → false。
    isDirect: (deptName) => { const l = levelsOf(deptName); return !!l && l.isDirect; },
    // 一级部门 id → 子树内全部部门行（含自己）；不是一级部门 → []。
    subtreeOf: (l1Id) => (subtree.get(String(l1Id)) || []).slice(),
    // 全部一级部门（含停用的），按输入顺序。
    roots: () => [...byId.values()].filter((d) => { const inf = info.get(d.id); return inf && inf.level === 1; }),
    // 父链成环、无法定级的部门（排障用）。
    cyclic: () => [...byId.values()].filter((d) => info.get(d.id) === false),
    // 名称只差大小写/首尾空白的部门组（每组两条及以上），按输入顺序：[{ name, departments:[{ id, name, active }] }]。
    duplicates: () => [...byKey.values()].filter((g) => g.length > 1)
      .map((g) => ({ name: g[0].name, departments: g.map((d) => ({ id: d.id, name: d.name, active: d.active })) })),
  };
}

// ---------- HoD 推算 ----------
function personOut(u, direct) {
  return {
    id: u.id,
    name: u.name || "",
    employeeId: u.employeeId || "",
    department: u.department || null,
    position: u.position || null,
    direct: !!direct,
  };
}

// 环上的人：成员子图里每人恰有一条出边（上级，且上级也是成员）或没有出边（顶端）。
// 三色 DFS 的迭代版：沿上级链走，碰到本轮路径上的点 = 找到环，从该点起到路径末尾都在环上。
function loopMembers(members, managerOf) {
  const state = new Map(); // id → 1 本轮路径上 / 2 已处理
  const onLoop = new Set();
  for (const m of members) {
    if (state.has(m.id)) continue;
    const path = [];
    let cur = m.id;
    while (cur && !state.has(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = managerOf(cur);
    }
    if (cur && state.get(cur) === 1) {
      const at = path.indexOf(cur);
      for (let i = at; i < path.length; i++) onLoop.add(path[i]);
    }
    for (const id of path) state.set(id, 2);
  }
  return onLoop;
}

// deriveHods(departments, users, { index }) →
//   { items:[…], unassignedPeople:[…], duplicateNames:[…], summary:{…} }
// items：每个在用（active）的一级部门一条，按 departments 输入顺序（store 已按 sort, name 排）：
//   { deptId, deptName, source, hod, candidates, memberCount, reason, ownerInactive, owner }
//     source        "owner" | "derived" | "ambiguous" | "none"
//     hod           personOut | null（ambiguous / none 为 null）
//     candidates    ambiguous 时的全部顶端（或环上的人；loop_with_top 为顶端 + 环上的人）；其余为 []
//     memberCount   推算口径的成员数（在职、非系统账号、落在子树内）
//     reason        "owner" | "single_top" | "multiple_tops" | "loop" | "loop_with_top" | "no_members"
//     ownerInactive ownerId 已填但此人离职/停用/不存在（此时 source/reason 是推算结果）
//     owner         ownerId 已填时 { id, name, employeeId, status: "active"|"inactive"|"missing" }，否则 null
// unassignedPeople：在职、非系统账号，但没有落进任何在用一级部门的人：
//   { id, name, employeeId, department, reason, level1 }
//     reason  "blank"（部门为空）| "unknown"（部门名不在部门表）| "cycle"（部门父链成环）|
//             "inactive_level1"（所属一级部门已停用）
//     level1  reason 为 inactive_level1 时是那个一级部门的名称，其余为 null
// duplicateNames：只差大小写/首尾空白的部门组（buildOrgIndex().duplicates()）。
function deriveHods(departments, users, opts = {}) {
  const index = opts.index || buildOrgIndex(departments);
  const list = Array.isArray(users) ? users : [];
  const userById = new Map();
  for (const u of list) if (u && !blank(u.id)) userById.set(u.id, u);

  // 成员归组：userId → 一级部门 id；一级部门 id → [{ u, direct }]
  const memberL1 = new Map();
  const groups = new Map();
  const unassignedPeople = [];
  for (const u of list) {
    if (!u || blank(u.id) || !isInService(u) || isSystemAccount(u)) continue;
    const reasonOut = (reason, level1 = null) => unassignedPeople.push({ id: u.id, name: u.name || "", employeeId: u.employeeId || "", department: u.department || null, reason, level1 });
    if (blank(u.department)) { reasonOut("blank"); continue; }
    const d = index.deptOf(u.department);
    if (!d) { reasonOut("unknown"); continue; }
    const lv = index.levelsOf(u.department);
    if (!lv) { reasonOut("cycle"); continue; }
    if (!index.byId.get(lv.level1Id).active) { reasonOut("inactive_level1", lv.level1); continue; }
    memberL1.set(u.id, lv.level1Id);
    const g = groups.get(lv.level1Id);
    const entry = { u, direct: lv.isDirect };
    if (g) g.push(entry); else groups.set(lv.level1Id, [entry]);
  }
  unassignedPeople.sort(byName);

  const items = [];
  for (const root of index.roots()) {
    if (!root.active) continue;
    if (root.group && !groups.has(root.id)) continue;   // 集团层没有直接挂人时不成行
    const members = groups.get(root.id) || [];
    const item = {
      deptId: root.id,
      deptName: root.name,
      source: "none",
      hod: null,
      candidates: [],
      memberCount: members.length,
      reason: "no_members",
      ownerInactive: false,
      owner: null,
    };
    if (root.ownerId) {
      const o = userById.get(root.ownerId) || null;
      const status = !o ? "missing" : isInService(o) ? "active" : "inactive";
      item.owner = { id: root.ownerId, name: o ? o.name || "" : null, employeeId: o ? o.employeeId || "" : null, status };
      if (status === "active") {
        const ol = index.levelsOf(o.department);
        item.source = "owner";
        item.reason = "owner";
        item.hod = personOut(o, !!ol && ol.level1Id === root.id && ol.isDirect);
        items.push(item);
        continue;
      }
      item.ownerInactive = true;
    }
    if (!members.length) { items.push(item); continue; }
    const tops = members.filter(({ u }) => blank(u.managerId) || memberL1.get(u.managerId) !== root.id);
    const rank = (a, b) => (a.direct === b.direct ? byName(a.u, b.u) : a.direct ? -1 : 1);
    // 成员子图里的上级边（上级也是本一级部门的成员才算）；环检测与「都能走到唯一顶端」共用。
    const managerOf = (id) => { const u = userById.get(id); const mid = u && u.managerId; return mid && memberL1.get(mid) === root.id ? mid : null; };
    if (tops.length === 1) {
      // 只有一个顶端时，其余成员沿上级链要么走到它、要么陷进环（每人至多一条出边，走不到
      // 顶端就一定在环上或挂在环下）。有环 → 这个唯一顶端不代表整个部门，交给 HR 确认。
      const onLoop = loopMembers(members.map((m) => m.u), managerOf);
      if (!onLoop.size) {
        item.source = "derived";
        item.reason = "single_top";
        item.hod = personOut(tops[0].u, tops[0].direct);
      } else {
        item.source = "ambiguous";
        item.reason = "loop_with_top";
        item.candidates = members.filter((m) => m === tops[0] || onLoop.has(m.u.id)).sort(rank).map((t) => personOut(t.u, t.direct));
      }
    } else if (tops.length > 1) {
      item.source = "ambiguous";
      item.reason = "multiple_tops";
      item.candidates = tops.slice().sort(rank).map((t) => personOut(t.u, t.direct));
    } else {
      // 每个成员的上级都是本部门成员 → 必有环。candidates 列出环上的人。
      const onLoop = loopMembers(members.map((m) => m.u), managerOf);
      item.source = "ambiguous";
      item.reason = "loop";
      item.candidates = members.filter((m) => onLoop.has(m.u.id)).sort(rank).map((t) => personOut(t.u, t.direct));
    }
    items.push(item);
  }
  return { items, unassignedPeople, duplicateNames: index.duplicates(), summary: summarize(items, unassignedPeople) };
}

// summary 只由 items / unassignedPeople 导出 —— 范围过滤之后重算用同一个函数，
// 分母与表格行永远对得上。
function summarize(items, unassignedPeople) {
  const s = { total: items.length, owner: 0, derived: 0, ambiguous: 0, none: 0, ownerInactive: 0, unassignedPeople: (unassignedPeople || []).length };
  for (const it of items) {
    if (SOURCES.includes(it.source)) s[it.source]++;
    if (it.ownerInactive) s.ownerInactive++;
  }
  return s;
}

// createOrgResolver(departments, users) → 一次快照上的查询器（批量调用时只建一次）。
//   hodOf(deptName) → 所属一级部门的 HoD（{ ...personOut, source, level1, level1Id }）或 null
//                     （未知部门 / 一级部门已停用 / 需确认（含 loop_with_top）/ 无在职人员）。
//   levelsOf(deptName) → 同 buildOrgIndex().levelsOf
// HoD 推算延迟到第一次 hodOf 才做：只问层级的调用方不必付成员归组的代价。
function createOrgResolver(departments, users) {
  const index = buildOrgIndex(departments);
  let hods = null;
  let byL1 = null;
  const result = () => {
    if (!hods) {
      hods = deriveHods(null, users, { index });
      byL1 = new Map(hods.items.map((it) => [it.deptId, it]));
    }
    return hods;
  };
  return {
    index,
    levelsOf: index.levelsOf,
    get hods() { return result(); },
    hodOf(deptName) {
      const lv = index.levelsOf(deptName);
      if (!lv) return null;
      result();
      const it = byL1.get(lv.level1Id);
      if (!it || !it.hod) return null;
      return { ...it.hod, source: it.source, level1: it.deptName, level1Id: it.deptId };
    },
    // 一级部门 id → deriveHods 的那一行（{ source, ownerInactive, … }）或 null（一级部门已停用 / 不存在 /
    // 集团层且没有直接挂人）。评估周期据此区分「无 HoD」与「HoD 待确认」（P0 1.1）。
    hodItemOf(level1Id) {
      result();
      return byL1.get(String(level1Id)) || null;
    },
  };
}

// ---------- 部门筛选（第二批 3.1，2026-10-08）：全站部门筛选的唯一口径 ----------
// 以下三个纯函数只读 buildOrgIndex() 的结果，不改上面任何函数。server.js 的 deptFilterFor / reviewDeptPath /
// reviewDeptOptions、GET /api/admin/dept-tree、评估周期圈人都委托到这里，前端 web/src/deptfilter.js 只消费结果。
//   · 集团层不算祖先：chainOf 已按 buildOrgIndex 的定级规则从一级部门（levelsOf 的 level1）起算；直接挂在
//     集团节点上的人，链就是 [集团节点]（与 HoD、评估周期、3+3 同一口径）。
//   · 四级及以下只是不单独成选项（并入所属三级，maxLevel 默认 3）；匹配仍走完整链，选三级 = 含其下全部部门。
//   · 部门名不在部门表、或部门父链成环 → 伪 id "name:<去首尾空白后小写>"，选它 = 按部门名不分大小写匹配。
//   · 范围裁剪：allow(部门名) 为假的部门从链上去掉（不把范围外的部门名带出去，与 GET /departments 同一口径）。
//     裁剪后链上没有一个落在 maxLevel 以内的部门时（范围只到四级部门），链上最浅的那个部门照样成选项，
//     不让范围内的人「选不到自己的部门」。
const DEPT_NONE = "__none";            // 「无部门」选项的值（前端 DeptFilter 的 showNone）
const pseudoDeptId = (deptName) => "name:" + String(deptName).trim().toLowerCase();

// deptPathOf(ix, deptName, allow) → 一级 → 本部门的 id 链（全深度，范围外的部门去掉）。
//   部门为空 → []；不在部门表或父链成环 → ["name:<小写名>"]。与 server.js reviewDeptPath 逐字同一口径。
function deptPathOf(ix, deptName, allow) {
  const dep = deptName === null || deptName === undefined ? "" : String(deptName).trim();
  if (!dep) return [];
  const chain = ix.chainOf(dep);
  if (!chain) return [pseudoDeptId(dep)];
  return chain.filter((d) => !allow || allow(d.name)).map((d) => d.id);
}

// deptOptionsOf(ix, deptNames, allow, { maxLevel = 3, counts }) → { options, idByName, chainById }
//   deptNames  名单里实际出现的部门原文（可重复、可为空，空的跳过）。
//   allow      (部门名) => bool；null = 不裁剪。
//   maxLevel   选项只列到第几级（按部门在全树里的级数）；0 / null / Infinity = 不限（评估周期详情沿用的旧口径）。
//   counts     可选：Map 或普通对象，部门原文 → 人数（调用方只数在职的人）。给了才在选项上带 count，
//              count = 链上含这个选项的所有部门原文人数之和（「含下级」）。
//   options    [{ id, name, parentId, path, level, inactive?, count? }]：parentId = 裁剪后链上最近的、本身也是选项的
//              祖先；path = 裁剪后的链拼成「Finance › AP」（到本选项为止）；level = 全树级数（伪选项为 null）；
//              inactive 只在部门已停用时出现（true）。排序与 reviewDeptOptions 相同：按链逐段 localeCompare，父级在前。
//              不限 maxLevel、不给 counts 且部门都在用时，结果与 server.js reviewDeptOptions 逐字段相同（测试有对照）。
//   idByName   部门原文（未去空白，名单里怎么写就怎么作键）→ 本部门 id 或 "name:" 伪 id；裁剪后链为空的不列。
//   chainById  上面这些 id → 裁剪后的完整 id 链（含四级及以下）。前端：选中 X ⇔ chainById[idByName[原文]] 含 X。
function deptOptionsOf(ix, deptNames, allow, opts = {}) {
  const lim = opts.maxLevel === undefined ? 3 : opts.maxLevel;
  const maxLevel = !lim || !Number.isFinite(Number(lim)) ? Infinity : Number(lim);
  const countOf = (name) => {
    const c = opts.counts;
    if (!c) return 0;
    const v = typeof c.get === "function" ? c.get(name) : c[name];
    return Number(v) > 0 ? Number(v) : 0;
  };
  const withCount = !!opts.counts;
  const out = new Map();          // id → option（含排序键 _k）
  const idByName = {};
  const chainById = {};
  const seenRaw = new Set();
  const addCount = (id, n) => { if (withCount && n) { const o = out.get(id); if (o) o.count += n; } };
  for (const raw of deptNames || []) {
    if (raw === null || raw === undefined) continue;
    const rawKey = String(raw);
    const dep = rawKey.trim();
    if (!dep) continue;
    const firstSight = !seenRaw.has(rawKey);
    seenRaw.add(rawKey);
    const n = firstSight ? countOf(rawKey) : 0;
    const chain = ix.chainOf(dep);
    if (!chain) {
      const id = pseudoDeptId(dep);
      if (!out.has(id)) out.set(id, { id, name: dep, parentId: null, path: dep, level: null, ...(withCount ? { count: 0 } : {}), _k: [dep] });
      idByName[rawKey] = id;
      chainById[id] = [id];
      addCount(id, n);
      continue;
    }
    // 裁剪后的链（保留全树级数 level = 在 chainOf 里的位置 + 1）
    const kept = [];
    chain.forEach((d, k) => { if (!allow || allow(d.name)) kept.push({ id: d.id, name: d.name, level: k + 1 }); });
    if (!kept.length) continue;
    const own = chain[chain.length - 1].id;
    idByName[rawKey] = own;
    chainById[own] = kept.map((d) => d.id);
    // 成选项的节点：级数在 maxLevel 以内的；一个都没有时取链上最浅的那个（范围只到更深的部门）
    let optNodes = kept.filter((d) => d.level <= maxLevel);
    if (!optNodes.length) optNodes = [kept[0]];
    let parent = null;
    const names = [];
    for (const d of kept) {
      names.push(d.name);
      if (!optNodes.includes(d)) continue;
      if (!out.has(d.id)) {
        const rec = ix.byId && ix.byId.get(d.id);
        out.set(d.id, {
          id: d.id, name: d.name, parentId: parent, path: names.join(" › "), level: d.level,
          ...(rec && rec.active === false ? { inactive: true } : {}),
          ...(withCount ? { count: 0 } : {}),
          _k: names.slice(),
        });
      }
      addCount(d.id, n);
      parent = d.id;
    }
  }
  const cmp = (a, b) => {
    for (let i = 0; i < Math.min(a._k.length, b._k.length); i++) { const c = a._k[i].localeCompare(b._k[i]); if (c) return c; }
    return a._k.length - b._k.length;
  };
  const options = [...out.values()].sort(cmp).map(({ _k, ...o }) => o);
  return { options, idByName, chainById };
}

// deptMatcherOf(ix, selId) → (deptName) => bool；找不到这个部门 → null（调用方决定是 400 还是忽略）。
//   "__none" → 部门为空的人；"name:<名>" → 按部门名不分大小写匹配；真实 id → 该部门及全部下级（descendantIdsOf，
//   集团层不算祖先）；该部门父链成环（descendantIdsOf 为空）→ 退回按部门名匹配（不然连直属成员都圈不到）。
//   与 server.js 发起评估周期按 departmentId 圈人（POST /api/admin/review-cycles）同一口径。
function deptMatcherOf(ix, selId) {
  if (selId === null || selId === undefined) return null;
  const raw = String(selId).trim();
  if (!raw) return null;
  if (raw === DEPT_NONE) return (deptName) => blank(deptName);
  if (raw.startsWith("name:")) {
    const want = norm(raw.slice(5));
    if (!want) return null;
    return (deptName) => norm(deptName) === want;
  }
  const sel = ix.byId && ix.byId.get(raw);
  if (!sel) return null;
  const ids = ix.descendantIdsOf(sel.id);
  const selName = norm(sel.name);
  if (!ids.size) return (deptName) => norm(deptName) === selName;
  return (deptName) => {
    const h = ix.deptOf(deptName);
    return h ? ids.has(h.id) : norm(deptName) === selName;
  };
}

module.exports = {
  DIRECT_LABEL,
  SOURCES,
  DEPT_NONE,
  isInService,
  isSystemAccount,
  buildOrgIndex,
  deriveHods,
  summarize,
  createOrgResolver,
  deptPathOf,
  deptOptionsOf,
  deptMatcherOf,
};
