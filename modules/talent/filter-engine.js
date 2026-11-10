"use strict";
// 人才筛选 · 评估引擎（第 5 批 8.1，2026-10-08；设计 scratchpad/b5-design.md 第 2.3、3、5.2、6 节）
// 纯函数，不读库：server.js（A 组）把 store 的数据包成 loaders 传进来，范围、权限、审计、应答都在 server.js。
// 依赖只有同目录的 filter-model.js。
//
// ───────────────────────────── 导出 API ─────────────────────────────
//   basePopulation(users, { inScope, includeExited }) → 基础人群（全流程唯一一处范围过滤）
//       role !== "admin"；默认只含在职（active !== 0 且 empStatus !== "exited"）；includeExited:true 时连已离职一起；
//       inScope = scopePredicate(user)（null = 全公司）。
//
//   createFacts(population, loaders, ctx) → facts（每类事实第一次用到时才加载，每次请求每类只加载一次）
//       loaders（都可省略；省略 = 没有这类数据）：
//         records(type)  → 该类型的 talent_records [{ id, userId, type, date, detail }]（store.listTalentRecordsByType；
//                          每种类型最多调一次；分组时只保留基础人群里的人；按 date 从新到旧，同日保持传入顺序）
//         periodKinds()  → Map | { recordId: "quarter"|"half"|"annual" }（已关闭周期的 review_items.recordId → cycle.kind；
//                          只有 perfRecent 的 periodKind 不为 any 时才调用）
//         training()     → { assignments(userId) → [{ programId, mandatory, self, done }], programDone(userId, programId) → bool }
//                          （请求级快照：TS.createSnapshotStore + LC.createCompletion，写法同 server.js 培训概览；
//                           mandatory = 课程 enrollType 为必修；self = 自主学习 source:"self"）
//         succession()   → [{ id, userId, positionName, readiness }]（store.listSuccession）
//         users()        → 全部用户（算直属下属人数、上级姓名；省略时用基础人群）
//       facts.records(type) / recordsOf(type, userId) / periodKinds() / training() / succession() / allUsers() /
//       userById(id) / directReports() / extras(u) / tags(u) / ladder(ranks)
//
//   compile(filter, catalog, ctx, facts) → { test(u) → bool, explain(u) → { headId: true|false|null }, heads, skipped, warnings, usage }
//       filter 须先经 validateFilter / normalizeFilter（叶子都有 id）。
//       ctx = {
//         today:     "YYYY-MM-DD"（本地日；server.js 传 todayLocal()）
//         deptParse: (id) → (deptName) => bool | null      deptFilterFor(user).parse；null = 值不可用（不是「不筛选」）
//         inScope:   (user) => bool | null                 scopePredicate(user)；用于上级是否可选、上级工号是否下发
//         deptLabel?:(user) => string                      部门列显示（如部门路径）；省略 = users.department
//       }
//       heads = 每条顶层条件一项 [{ id, kind:"leaf"|"group", field?, op?, tag?, logic?, leafIds? }]（组的 id 为 g1、g2…）
//       skipped = [{ id, reason:"module_off"|"field_removed"|"field_retired" }]；warnings = [{ id, code, count? }]（module_off / field_removed / field_retired / value_unavailable）
//       语义：被忽略的叶子从所在组去掉；组里全被忽略 = 该组满足；值全部不可用 = 该叶子不匹配任何人。
//
//   run(opts) → { total, matchedTotal, page, pageSize, rows, columns, columnMeta, skipped, warnings, unmapped?, explainHeads?, ids? }
//       opts = { population, filter, catalog, ctx, loaders | facts, members?, columns?, sort?, page?, pageSize?, all?,
//                explain?, idsOnly?, includeUnmatched?, computeUnmapped? }
//         members         内置晋升筛选的人工名单 [{ userId, mode:"include"|"exclude", note? }]：排除的一律移出，手动加入的一律列入
//         includeUnmatched true = 基础人群每人一行（matched 标明是否入选；promotion-candidates 用），默认只返回入选的人
//         sort            { col, dir:"asc"|"desc" }；默认按姓名。includeUnmatched 时入选的人排在前面
//         page / pageSize 1 起；pageSize 默认 50、最大 200；all:true = 不分页（导出、计数）
//         idsOnly         只返回入选者 id（ids，最多 200 个，用于「选择全部结果」）
//         computeUnmapped true = 无论条件里有没有 nextLevelExists 都给 unmapped
//       rows = [{ id, name, employeeId, matched, member:"include"|"exclude"|null, values:{ [col]: 原始值 }, hits? }]
//       unmapped = [{ id, name, employeeId, jobLevel }]（不在职级体系内的人；条件里有 nextLevelExists 时才算）
//       columnMeta = { recentRatings:{ n }, violationCount:{ months }, awardCount:{ months } }
//
//   columnValue(col, u, facts, env) → 原始值；env = { catalog, ctx, ladder, today, members:Map, meta:columnMeta }
//   columnText(col, raw, catalog, lang) → 显示文字（CSV 与列表；选项值按 lang 出中文或英文）
//   csvRows({ rows, columns, catalog, lang, summary, columnMeta }) → string[][]
//       第一行 ["# 条件：…"]，第二行表头中英并列（「部门 Department」），其余为数据；CSV 转义由 server.js csvEscape 负责。
//
//   F62（2026-10-09）：perfRecent 参数 withinMonths > 0 时按月份时间窗判（窗内全部记录；窗内无记录按 missing）；
//       字段 levelTenureMonths 与列 levelTenure = 现职级任职满月数（levelSinceDay：最近一条职级有变化的晋升 / 调动记录，否则入职日）。
//   工具：monthsBefore(today, n)、fullMonths(hireDate, today)、levelSinceDay(u, facts)、periodKindOfText(text)、buildLadder(ranks)、
//         ranksInRange(ranks, from, to)、ratingBucket(index, length)、POT_BUCKET、PAGE_MAX、IDS_CAP

const M = require("./filter-model.js");

const PAGE_DEFAULT = 50, PAGE_MAX = 200, IDS_CAP = 200;
const POT_BUCKET = Object.freeze({ High: 2, Medium: 1, Low: 0 });
const EMPTY = Object.freeze([]);
const str = (v) => (v === null || v === undefined ? "" : String(v));
const norm = (v) => str(v).trim().toLowerCase();
const up = (v) => str(v).trim().toUpperCase();
const COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });

// ---------------------------------------------------------------- dates
const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const pad = (x) => String(x).padStart(2, "0");
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// 今天往前推 n 个月的本地日（月末对齐：3-31 往前 1 个月 = 2-28/29），与 TalentReview.jsx monthsBefore 同口径
function monthsBefore(today, n) {
  const t = DAY.exec(str(today));
  if (!t) return "";
  let y = Number(t[1]), m = Number(t[2]) - n;
  while (m < 1) { m += 12; y -= 1; }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(Number(t[3]), last))}`;
}
// 日历满月数（与 TalentReview.jsx tenureBucket 的满年判定同口径：日号未到入职日号不算满月，
// 所以 1-31 入职的人在下月 1 日满 1 个月、2-29 入职的人在 3-1 满 1 年）；入职日期在未来 → 0；没有入职日期 → null
function fullMonths(hireDate, today) {
  const h = DAY.exec(str(hireDate)), t = DAY.exec(str(today));
  if (!h || !t) return null;
  let m = (Number(t[1]) - Number(h[1])) * 12 + (Number(t[2]) - Number(h[2]));
  if (Number(t[3]) < Number(h[3])) m -= 1;
  return Math.max(0, m);
}
// 导入的历史绩效记录按 detail.period 的文字判断期别；认不出来 → null（只在 periodKind = any 时计入）
function periodKindOfText(s) {
  const t = str(s);
  if (!t.trim()) return null;
  if (/\bQ[1-4]\b|第[一二三四1-4]季度|季度|quarter/i.test(t)) return "quarter";
  if (/\bH[12]\b|半年|mid[- ]?year|half/i.test(t)) return "half";
  if (/annual|year[- ]?end|full[- ]?year|年度|全年|\bFY\s?\d{2,4}\b/i.test(t)) return "annual";
  return null;
}

// ---------------------------------------------------------------- job grades
// 职级阶梯：每次请求建一次（代替逐人调用 server.js nextRankOf）。同一通道内按 level 升序、同级按职级尾号降序，
// 与 nextRankOf 逐字同一排序；info(jobLevel) → { rank, grade, level, track, next } | null（null = 不在职级体系内）。
function buildLadder(ranks) {
  const list = (Array.isArray(ranks) ? ranks : []).filter((r) => r && str(r.rank).trim());
  const exact = new Map(), upper = new Map(), byTrack = new Map();
  for (const r0 of list) {
    const r = { rank: str(r0.rank).trim(), grade: r0.grade == null || r0.grade === "" ? null : String(r0.grade), level: Number(r0.level) || 0, track: r0.track == null ? null : String(r0.track) };
    if (!exact.has(r.rank)) exact.set(r.rank, r);
    if (!upper.has(r.rank.toUpperCase())) upper.set(r.rank.toUpperCase(), r);
    if (!byTrack.has(r.track)) byTrack.set(r.track, []);
    byTrack.get(r.track).push(r);
  }
  const suffix = (x) => Number((String(x.rank).match(/(\d+)$/) || [0, 0])[1]);
  const next = new Map();
  for (const arr of byTrack.values()) {
    arr.sort((a, b) => (a.level - b.level) || (suffix(b) - suffix(a)));
    arr.forEach((r, i) => { if (!next.has(r.rank)) next.set(r.rank, arr[i + 1] ? arr[i + 1].rank : null); });
  }
  const memo = new Map();
  return {
    info(jobLevel) {
      const s = str(jobLevel).trim();
      if (!s) return null;
      if (memo.has(s)) return memo.get(s);
      const r = exact.get(s) || upper.get(s.toUpperCase()) || null;
      const out = r ? { ...r, next: next.get(r.rank) === undefined ? null : next.get(r.rank) } : null;
      memo.set(s, out);
      return out;
    },
  };
}
// 与 web/src/jobgrades.js ranksInRange 同口径：两端之间（含两端）的全部职级；两端不在同一通道时两个通道都取
function ranksInRange(ranks, from, to) {
  const list = Array.isArray(ranks) ? ranks : [];
  const k = (v) => str(v).trim();
  const a = list.find((r) => k(r.rank) === k(from));
  const b = list.find((r) => k(r.rank) === k(to));
  if (!a || !b) return [from, to].map(k).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
  const lo = Math.min(Number(a.level) || 0, Number(b.level) || 0);
  const hi = Math.max(Number(a.level) || 0, Number(b.level) || 0);
  const tracks = new Set([k(a.track), k(b.track)]);
  return list.filter((r) => tracks.has(k(r.track)) && (Number(r.level) || 0) >= lo && (Number(r.level) || 0) <= hi).map((r) => k(r.rank));
}
// 九宫格绩效轴：评级在选项里的位置三等分（2 = 高），与 server.js perfBucketOf 同口径
function ratingBucket(i, len) {
  if (i === -1 || i === undefined || i === null || !len) return null;
  const third = len / 3;
  return i < third ? 2 : i < 2 * third ? 1 : 0;
}

// ---------------------------------------------------------------- population & facts
function inService(u) {
  return !!u && u.active !== 0 && u.active !== false && u.active !== "0" && u.empStatus !== "exited";
}
function basePopulation(users, opts) {
  const o = opts || {};
  return (users || []).filter((u) => u && u.role !== "admin" && (o.includeExited || inService(u)) && (!o.inScope || o.inScope(u)));
}

function createFacts(population, loaders, ctx) {
  loaders = loaders || {};
  const pop = Array.isArray(population) ? population : [];
  const popById = new Map(pop.map((u) => [u.id, u]));
  const memo = new Map();
  const once = (key, fn) => () => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const recMemo = new Map();
  const extrasMemo = new Map(), tagsMemo = new Map();
  const allUsers = once("users", () => (typeof loaders.users === "function" ? loaders.users() || [] : pop));
  const allById = once("usersById", () => new Map(allUsers().map((u) => [u.id, u])));
  const facts = {
    population: pop,
    popById,
    records(type) {
      if (!recMemo.has(type)) {
        const raw = typeof loaders.records === "function" ? loaders.records(type) || [] : [];
        const by = new Map();
        for (const r of raw) {
          if (!r || !popById.has(r.userId)) continue;
          let arr = by.get(r.userId);
          if (!arr) by.set(r.userId, (arr = []));
          arr.push(r);
        }
        for (const arr of by.values()) arr.sort((a, b) => (str(a.date) < str(b.date) ? 1 : str(a.date) > str(b.date) ? -1 : 0));
        recMemo.set(type, by);
      }
      return recMemo.get(type);
    },
    recordsOf(type, userId) { return facts.records(type).get(userId) || EMPTY; },
    periodKinds: once("periodKinds", () => {
      const m = typeof loaders.periodKinds === "function" ? loaders.periodKinds() : null;
      return m instanceof Map ? m : new Map(Object.entries(m || {}));
    }),
    training: once("training", () => (typeof loaders.training === "function" ? loaders.training() : null)),
    succession: once("succession", () => {
      const by = new Map();
      for (const s of (typeof loaders.succession === "function" ? loaders.succession() || [] : [])) {
        if (!s || !popById.has(s.userId)) continue;
        if (!by.has(s.userId)) by.set(s.userId, []);
        by.get(s.userId).push(s);
      }
      return by;
    }),
    allUsers,
    userById(id) { return allById().get(id) || null; },
    directReports: once("directReports", () => {
      const m = new Map();
      for (const x of allUsers()) if (x && x.managerId && inService(x)) m.set(x.managerId, (m.get(x.managerId) || 0) + 1);
      return m;
    }),
    extras(u) {
      if (!extrasMemo.has(u.id)) {
        let x = u.extras;
        if (typeof x === "string") { try { x = x ? JSON.parse(x) : {}; } catch { x = {}; } }
        extrasMemo.set(u.id, x && typeof x === "object" ? x : {});
      }
      return extrasMemo.get(u.id);
    },
    tags(u) {
      if (!tagsMemo.has(u.id)) {
        let x = u.talentTags;
        if (typeof x === "string") { try { x = x ? JSON.parse(x) : []; } catch { x = []; } }
        tagsMemo.set(u.id, Array.isArray(x) ? x.map((t) => str(t).trim()).filter(Boolean) : []);
      }
      return tagsMemo.get(u.id);
    },
    ladder(ranks) {
      if (!memo.has("ladder") || memo.get("ladderSrc") !== ranks) { memo.set("ladder", buildLadder(ranks)); memo.set("ladderSrc", ranks); }
      return memo.get("ladder");
    },
  };
  return facts;
}

// ---------------------------------------------------------------- compile
function defaultDeptParse(id) {
  const s = str(id).trim();
  if (s === "__none") return (d) => !str(d).trim();
  if (s.startsWith("name:") && s.length > 5) { const want = norm(s.slice(5)); return (d) => norm(d) === want; }
  return null;
}
function ratingTools(catalog) {
  const opts = (catalog && catalog.ratingOptions) || [];
  const zh = (catalog && catalog.ratingOptions_zh) || [];
  const idx = new Map(opts.map((v, i) => [String(v), i]));
  zh.forEach((v, i) => { if (!idx.has(String(v))) idx.set(String(v), i); });
  return {
    len: opts.length,
    indexOf(v) { if (v === null || v === undefined || v === "") return -1; const i = idx.get(String(v).trim()); return i === undefined ? -1 : i; },
    canon(v) { const i = this.indexOf(v); return i === -1 ? (v === null || v === undefined || v === "" ? null : String(v)) : opts[i]; },
  };
}

function compile(filter, catalog, ctx, facts) {
  ctx = ctx || {};
  const ix = M.indexCatalog(catalog);
  const today = ctx.today || todayStr();
  const ranks = (catalog && catalog.ranks) || [];
  const ladder = facts.ladder(ranks);
  const R = ratingTools(catalog);
  const skipped = [], warnings = [];
  const usage = { nextLevel: false, perfN: 0, violationMonths: null, awardMonths: null };
  const NEVER = () => false;

  const leafFn = (leaf, fallbackId) => {
    const id = leaf.id || fallbackId;
    const skip = (reason) => { skipped.push({ id, reason }); warnings.push({ id, code: reason }); return null; };
    const lost = (n) => { if (n > 0) warnings.push({ id, code: "value_unavailable", count: n }); };
    const def = ix.fields.get(leaf.field);
    // F61：已停用的内置字段（isManager → 职级通道）判为忽略，警告 field_retired；其余查不到的字段仍是 field_removed
    if (!def) return skip(M.RETIRED_FIELDS && M.RETIRED_FIELDS[leaf.field] ? "field_retired" : "field_removed");
    if (def.available === false) return skip("module_off");
    const v = leaf.value;
    const P = leaf.params || {};
    const op = leaf.op;
    const list = Array.isArray(v) ? v : [];
    switch (leaf.field) {
      case "dept": {
        const parse = typeof ctx.deptParse === "function" ? ctx.deptParse : defaultDeptParse;
        const ms = [];
        let gone = 0;
        for (const x of list) { const m = parse(x); if (typeof m === "function") ms.push(m); else gone++; }
        lost(gone);
        if (!ms.length) return NEVER;
        const cache = new Map();
        const hit = (u) => {
          const d = str(u.department);
          if (!cache.has(d)) cache.set(d, ms.some((m) => m(u.department)));
          return cache.get(d);
        };
        return op === "notIn" ? (u) => !hit(u) : hit;
      }
      case "jobLevel": {
        const want = new Set((op === "between" && v ? ranksInRange(ranks, v.from, v.to) : list).map(up));
        const has = (u) => !!str(u.jobLevel).trim() && want.has(up(u.jobLevel));
        return op === "notIn" ? (u) => !has(u) : has;
      }
      case "jobGrade": {
        const want = new Set(list);
        const g = (u) => { if (!str(u.jobLevel).trim()) return "__none"; const i = ladder.info(u.jobLevel); return i && i.grade ? i.grade : "__nogrid"; };
        return op === "notIn" ? (u) => !want.has(g(u)) : (u) => want.has(g(u));
      }
      case "jobTrack": {
        const want = new Set(list.map(up));
        return (u) => { const i = ladder.info(u.jobLevel); return !!i && want.has(up(i.track)); };
      }
      case "nextLevelExists": {
        usage.nextLevel = true;
        const has = (u) => { const i = ladder.info(u.jobLevel); return !!(i && i.next); };
        return op === "isFalse" ? (u) => !has(u) : has;
      }
      case "position": {
        if (op === "contains") { const w = norm(v); return (u) => norm(u.position).includes(w); }
        const want = new Set(list.map(norm));
        return (u) => !!str(u.position).trim() && want.has(norm(u.position));
      }
      case "manager": {
        const ok = list.filter((mid) => { const m = facts.userById(mid); return !!m && (!ctx.inScope || ctx.inScope(m)); });
        lost(list.length - ok.length);
        if (!ok.length) return NEVER;
        const want = new Set(ok);
        return (u) => !!u.managerId && want.has(u.managerId);
      }
      case "empStatus": {
        const want = new Set(list);
        return (u) => want.has(u.empStatus || "__none");
      }
      case "tenureMonths": case "levelTenureMonths": {
        const since = leaf.field === "levelTenureMonths" ? (u) => levelSinceDay(u, facts) : (u) => u.hireDate;
        return (u) => {
          const m = fullMonths(since(u), today);
          if (m === null) return false;
          if (op === "gte") return m >= v;
          if (op === "lte") return m <= v;
          return m >= v.from && m <= v.to;
        };
      }
      case "perfRecent": {
        const n = P.n || 1, mode = P.mode || "all", k = P.k || 1, kind = P.periodKind || "any", missing = P.missing || "fail";
        // F62：withinMonths > 0 = 按月份的时间窗（窗内全部记录，不再取近 n 期）；窗内没有记录按 missing 判
        const win = Number(P.withinMonths) || 0;
        const winCut = win > 0 ? monthsBefore(today, win) : null;
        usage.perfN = Math.max(usage.perfN, win > 0 ? 1 : n);
        let pred;
        if (op === "atLeast") { const lim = R.indexOf(v); pred = (r) => { const i = R.indexOf(r.detail && r.detail.rating); return i !== -1 && lim !== -1 && i <= lim; }; }
        else if (op === "atMost") { const lim = R.indexOf(v); pred = (r) => { const i = R.indexOf(r.detail && r.detail.rating); return i !== -1 && lim !== -1 && i >= lim; }; }
        else if (op === "in") { const want = new Set(list.map((x) => R.canon(x))); pred = (r) => want.has(R.canon(r.detail && r.detail.rating)); }
        const recsOf = (u) => {
          let recs = facts.recordsOf("performance", u.id);
          if (kind !== "any") {
            const pk = facts.periodKinds();
            recs = recs.filter((r) => (pk.get(r.id) || periodKindOfText(r.detail && r.detail.period)) === kind);
          }
          return recs;
        };
        if (op === "noRecord") return (u) => recsOf(u).length === 0;
        if (winCut) return (u) => {
          const take = recsOf(u).filter((r) => str(r.date).slice(0, 10) >= winCut);
          if (!take.length) return missing !== "fail";
          let hits = 0;
          for (const r of take) if (pred(r)) hits++;
          return mode === "any" ? hits >= 1 : mode === "atLeastK" ? hits >= k : hits === take.length;
        };
        return (u) => {
          const take = recsOf(u).slice(0, n);
          if (!take.length || (take.length < n && missing === "fail")) return false;
          let hits = 0;
          for (const r of take) if (pred(r)) hits++;
          return mode === "any" ? hits >= 1 : mode === "atLeastK" ? hits >= k : hits === take.length;
        };
      }
      case "potential": {
        const want = new Set(list);
        const cut = P.freshOnly ? monthsBefore(today, 12) : null;
        return (u) => {
          let p = u.potential || "__none";
          if (cut && p !== "__none" && !(u.potentialAt && str(u.potentialAt).slice(0, 10) > cut)) p = "__none";
          return want.has(p);
        };
      }
      case "nineBox": {
        const want = new Set(list);
        return (u) => want.has(nineBoxOf(u, facts, R));
      }
      case "talentTag": {
        const want = list.map(norm);
        return (u) => {
          const have = new Set(facts.tags(u).map(norm));
          if (op === "allOf") return want.every((t) => have.has(t));
          const any = want.some((t) => have.has(t));
          return op === "noneOf" ? !any : any;
        };
      }
      case "trainingMandatoryDone": {
        const all = (u) => mandatoryOf(u, facts).every((a) => a.done);
        return op === "isFalse" ? (u) => !all(u) : all;
      }
      case "trainingCompletion": {
        const scopeAll = P.scope === "all";
        return (u) => {
          const asg = scopeAll ? assignedOf(u, facts) : mandatoryOf(u, facts);
          if (!asg.length) return false;
          const pct = (asg.filter((a) => a.done).length * 100) / asg.length;
          return op === "gte" ? pct >= v : pct <= v;
        };
      }
      case "trainingProgram": {
        const known = new Set((def.options || []).map((o) => o.value));
        const ok = list.filter((p) => known.has(p));
        lost(list.length - ok.length);
        if (!ok.length) return NEVER;
        const done = (u, p) => { const t = facts.training(); return !!(t && t.programDone(u.id, p)); };
        if (op === "allOf") return (u) => ok.every((p) => done(u, p));
        if (op === "noneOf") return (u) => !ok.some((p) => done(u, p));
        return (u) => ok.some((p) => done(u, p));
      }
      case "award": case "violation": {
        const months = Number(P.months) || 0;
        if (leaf.field === "violation" && usage.violationMonths === null) usage.violationMonths = months;
        if (leaf.field === "award" && usage.awardMonths === null) usage.awardMonths = months;
        const cut = months > 0 ? monthsBefore(today, months) : null;
        let pick;
        if (leaf.field === "award") {
          const names = new Set((P.names || []).map(norm));
          const opts = def.awardOptions || [];
          pick = names.size ? (r) => { const raw = r.detail && r.detail.awardName; const c = M.canonOpt(opts, raw); return names.has(norm(c === null ? raw : c)); } : null;
        } else {
          const sev = P.severity || [];
          const opts = def.severityOptions || [];
          pick = sev.length ? (r) => severityMatch(r.detail && r.detail.severity, sev, opts) : null;
        }
        const count = (u) => {
          let c = 0;
          for (const r of facts.recordsOf(leaf.field, u.id)) {
            if (cut && str(r.date) < cut) continue;
            if (pick && !pick(r)) continue;
            c++;
          }
          return c;
        };
        return op === "none" ? (u) => count(u) === 0 : (u) => count(u) >= v;
      }
      case "record": {
        const t = ix.recordTypes.get(P.type);
        if (!t) return skip("field_removed");
        if (t.moduleOff) return skip("module_off");
        const cut = Number(P.months) > 0 ? monthsBefore(today, Number(P.months)) : null;
        const preds = Object.entries(P.fields || {}).map(([fk, want]) => {
          const fd = (t.fields || []).find((x) => x.key === fk);
          const opts = fd ? fd.options || [] : [];
          return (r) => {
            const raw = r.detail ? r.detail[fk] : undefined;
            if (raw === undefined || raw === null || raw === "") return false;
            if (opts.length) { const c = M.canonOpt(opts, raw); if ((c === null ? String(raw) : c) === want) return true; }
            return norm(raw) === norm(want);
          };
        });
        const count = (u) => {
          let c = 0;
          for (const r of facts.recordsOf(P.type, u.id)) {
            if (cut && str(r.date) < cut) continue;
            if (preds.every((p) => p(r))) c++;
          }
          return c;
        };
        if (op === "exists") return (u) => count(u) >= 1;
        if (op === "notExists") return (u) => count(u) === 0;
        return (u) => count(u) >= v;
      }
      case "succession": {
        const pos = P.position ? M.positionKey(P.position) : null;
        const listed = (u) => (facts.succession().get(u.id) || EMPTY).some((s) => !pos || M.positionKey(s.positionName) === pos);
        return op === "notListed" ? (u) => !listed(u) : listed;
      }
      default:
        if (leaf.field.startsWith("custom:")) return customFn(leaf, def, facts, today);
        return skip("field_removed");
    }
  };

  const combine = (fns, logic) => (fns.length === 1 ? fns[0] : logic === "or" ? (u) => fns.some((f) => f(u)) : (u) => fns.every((f) => f(u)));
  const heads = [], top = [];
  ((filter && filter.items) || []).forEach((it, i) => {
    if (it && Array.isArray(it.items)) {
      const id = "g" + (i + 1);
      const kids = it.items.map((l, j) => leafFn(l, `i${i}_${j}`)).filter(Boolean);
      heads.push({ id, kind: "group", logic: it.logic === "or" ? "or" : "and", leafIds: it.items.map((l) => l.id) });
      top.push({ id, fn: kids.length ? combine(kids, it.logic) : null });
    } else if (it) {
      const id = it.id || `i${i}`;
      heads.push({ id, kind: "leaf", field: it.field, op: it.op, tag: it.tag || null });
      top.push({ id, fn: leafFn(it, id) });
    }
  });
  const active = top.filter((t) => t.fn).map((t) => t.fn);
  const test = active.length ? combine(active, filter && filter.logic) : () => true;
  return {
    test,
    explain(u) { const o = {}; for (const t of top) o[t.id] = t.fn ? !!t.fn(u) : null; return o; },
    heads, skipped, warnings, usage, ladder, today,
  };
}

function assignedOf(u, facts) {
  const t = facts.training();
  if (!t) return EMPTY;
  return (t.assignments(u.id) || EMPTY).filter((a) => a && !a.self);
}
function mandatoryOf(u, facts) { return assignedOf(u, facts).filter((a) => a.mandatory); }
function severityMatch(raw, wants, opts) {
  const s = str(raw).trim();
  if (!s) return false;
  const c = M.canonOpt(opts, s);
  const toks = norm(s).split(/\s+/);
  return wants.some((w) => {
    if (c !== null && c === w) return true;
    if (toks.includes(norm(w))) return true;
    const o = opts.find((x) => x.value === w);
    return !!(o && o.label_zh && o.label_zh !== o.value && s.includes(o.label_zh));
  });
}
function nineBoxOf(u, facts, R) {
  const pot = u.potential ? POT_BUCKET[u.potential] : undefined;
  const latest = facts.recordsOf("performance", u.id)[0];
  const perf = latest ? ratingBucket(R.indexOf(latest.detail && latest.detail.rating), R.len) : null;
  return pot === undefined || pot === null || perf === null ? "__unplaced" : `${pot}-${perf}`;
}
function customFn(leaf, def, facts, today) {
  const key = leaf.field.slice(7);
  const op = leaf.op, v = leaf.value;
  const raw = (u) => facts.extras(u)[key];
  const input = def.input || "text";
  if (input === "select" || input === "suggest") {
    const want = new Set(Array.isArray(v) ? v : []);
    const has = (u) => { const x = raw(u); if (x === undefined || x === null || x === "") return false; const c = M.canonOpt(def.options || [], x); return want.has(c === null ? str(x).trim() : c); };
    return op === "notIn" ? (u) => !has(u) : has;
  }
  if (input === "level") { const want = new Set((Array.isArray(v) ? v : []).map(up)); return (u) => !!str(raw(u)).trim() && want.has(up(raw(u))); }
  if (input === "department") return (u) => !!str(raw(u)).trim() && norm(raw(u)) === norm(v);
  if (input === "checkbox") { const yes = (u) => { const x = raw(u); return x === true || x === 1 || x === "1" || x === "true"; }; return op === "isFalse" ? (u) => !yes(u) : yes; }
  if (input === "number") {
    const num = (u) => { const x = raw(u); if (x === undefined || x === null || str(x).trim() === "") return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
    if (op === "isEmpty") return (u) => num(u) === null;
    return (u) => { const n = num(u); if (n === null) return false; return op === "gte" ? n >= v : op === "lte" ? n <= v : n >= v.from && n <= v.to; };
  }
  if (input === "date") {
    const day = (u) => { const d = str(raw(u)).slice(0, 10); return DAY.test(d) ? d : null; };
    if (op === "withinMonths") { const cut = monthsBefore(today, v); return (u) => { const d = day(u); return !!d && d >= cut && d <= today; }; }
    return (u) => { const d = day(u); if (!d) return false; return op === "onOrAfter" ? d >= v : op === "onOrBefore" ? d <= v : d >= v.from && d <= v.to; };
  }
  // text / textarea
  const s = (u) => str(raw(u)).trim();
  if (op === "isEmpty") return (u) => !s(u);
  if (op === "notEmpty") return (u) => !!s(u);
  if (op === "equals") return (u) => norm(s(u)) === norm(v);
  return (u) => norm(s(u)).includes(norm(v));
}

// ---------------------------------------------------------------- columns
// F62 现职级起算日：最近一条「职级有变化」的晋升 / 调动记录（detail.toLevel 非空且 ≠ fromLevel，不分大小写；晋升记录结果为
// 「未通过 / Failed」的不算，与 server.js passOk 的否定分支同一正则）的日期；没有这类记录 → 入职日；两者都没有 → null
const FAIL_RE = /未通过|failed/i;
function levelSinceDay(u, facts) {
  let best = null;
  for (const type of ["promotion", "transfer"]) {
    for (const r of facts.recordsOf(type, u.id)) {
      const d = r.detail || {};
      const to = up(d.toLevel), from = up(d.fromLevel);
      if (!to || to === from) continue;
      if (type === "promotion" && FAIL_RE.test(str(d.result))) continue;
      const day = str(r.date).slice(0, 10);
      if (!DAY.test(day)) continue;
      if (!best || day > best) best = day;
      break;   // 记录按日期从新到旧，同类型第一条命中即最新
    }
  }
  return best || (u.hireDate ? str(u.hireDate).slice(0, 10) : null);
}
function windowCount(type, u, facts, months, today) {
  const cut = months > 0 ? monthsBefore(today, months) : null;
  let c = 0;
  for (const r of facts.recordsOf(type, u.id)) if (!cut || str(r.date) >= cut) c++;
  return c;
}
function columnValue(col, u, facts, env) {
  env = env || {};
  const ctx = env.ctx || {};
  const today = env.today || ctx.today || todayStr();
  const ladder = env.ladder || facts.ladder((env.catalog && env.catalog.ranks) || []);
  const R = env.rating || ratingTools(env.catalog);
  const meta = env.meta || {};
  switch (col) {
    case "name": return u.name || null;
    case "employeeId": return u.employeeId || null;
    case "department": return typeof ctx.deptLabel === "function" ? ctx.deptLabel(u) || null : u.department || null;
    case "position": return u.position || null;
    case "jobLevel": return u.jobLevel || null;
    case "nextLevel": { const i = ladder.info(u.jobLevel); return i ? i.next : null; }
    case "jobGrade": { const i = ladder.info(u.jobLevel); return i ? i.grade : null; }
    case "jobTrack": { const i = ladder.info(u.jobLevel); return i ? i.track : null; }
    case "hireDate": return u.hireDate ? str(u.hireDate).slice(0, 10) : null;
    case "tenure": return fullMonths(u.hireDate, today);
    case "levelTenure": return fullMonths(levelSinceDay(u, facts), today);
    case "manager": {
      if (!u.managerId) return null;
      const m = facts.userById(u.managerId);
      if (!m) return null;
      return { id: m.id, name: m.name || null, employeeId: !ctx.inScope || ctx.inScope(m) ? m.employeeId || null : null };
    }
    case "empStatus": return u.empStatus || null;
    case "latestRating": { const r = facts.recordsOf("performance", u.id)[0]; return r ? R.canon(r.detail && r.detail.rating) : null; }
    case "recentRatings": return facts.recordsOf("performance", u.id).slice(0, (meta.recentRatings && meta.recentRatings.n) || 3).map((r) => R.canon(r.detail && r.detail.rating));
    case "potential": return u.potential ? { value: u.potential, at: u.potentialAt ? str(u.potentialAt).slice(0, 10) : null } : null;
    case "nineBox": { const c = nineBoxOf(u, facts, R); return c === "__unplaced" ? null : c; }
    case "trainingMandatory": { const a = mandatoryOf(u, facts); return { done: a.filter((x) => x.done).length, total: a.length }; }
    case "trainingCompletion": { const a = assignedOf(u, facts); return a.length ? Math.round((a.filter((x) => x.done).length * 100) / a.length) : null; }
    case "awardCount": return windowCount("award", u, facts, meta.awardCount ? meta.awardCount.months : 12, today);
    case "violationCount": return windowCount("violation", u, facts, meta.violationCount ? meta.violationCount.months : 12, today);
    case "successionPositions": return [...new Set((facts.succession().get(u.id) || EMPTY).map((s) => s.positionName))];
    case "member": return (env.members && env.members.get(u.id)) || null;
    case "talentTags": return facts.tags(u).slice();
    default:
      if (str(col).startsWith("custom:")) { const x = facts.extras(u)[col.slice(7)]; return x === undefined || x === "" ? null : x; }
      return null;
  }
}
function sortKey(col, raw, env) {
  if (raw === null || raw === undefined) return null;
  switch (col) {
    case "latestRating": { const i = env.rating.indexOf(raw); return i === -1 ? null : env.rating.len - i; }
    case "recentRatings": { const i = raw.length ? env.rating.indexOf(raw[0]) : -1; return i === -1 ? null : env.rating.len - i; }
    case "jobLevel": case "nextLevel": { const i = env.ladder.info(raw); return i ? i.level : null; }
    case "potential": { const b = POT_BUCKET[raw.value]; return b === undefined ? null : b; }
    case "nineBox": { const [p, f] = String(raw).split("-").map(Number); return p * 3 + f; }
    case "trainingMandatory": return raw.total ? raw.done / raw.total : null;
    case "manager": return raw.name || null;
    default:
      if (Array.isArray(raw)) return raw.join(", ") || null;
      return raw;
  }
}
function cmpKeys(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return COLLATOR.compare(String(a), String(b));
}

// ---------------------------------------------------------------- run
function run(opts) {
  const o = opts || {};
  const population = Array.isArray(o.population) ? o.population : [];
  const catalog = o.catalog || { fields: [], columns: [], ranks: [], ratingOptions: [] };
  const ctx = o.ctx || {};
  const filter = o.filter || { v: 1, logic: "and", items: [] };
  const facts = o.facts || createFacts(population, o.loaders, ctx);
  const c = compile(filter, catalog, ctx, facts);
  const R = ratingTools(catalog);
  const members = new Map();
  for (const m of o.members || []) if (m && facts.popById.has(m.userId) && (m.mode === "include" || m.mode === "exclude")) members.set(m.userId, m.mode);
  const columns = Array.isArray(o.columns) && o.columns.length ? o.columns.slice() : M.DEFAULT_COLUMNS.slice();
  const meta = {
    recentRatings: { n: c.usage.perfN || 3 },
    violationCount: { months: c.usage.violationMonths === null ? 12 : c.usage.violationMonths },
    awardCount: { months: c.usage.awardMonths === null ? 12 : c.usage.awardMonths },
  };
  const env = { catalog, ctx, ladder: c.ladder, today: c.today, rating: R, members, meta };

  const items = [];
  let matchedTotal = 0;
  for (const u of population) {
    const mode = members.get(u.id) || null;
    const matched = mode === "exclude" ? false : mode === "include" ? true : !!c.test(u);
    if (matched) matchedTotal++;
    if (!matched && !o.includeUnmatched) continue;
    items.push({ u, matched, member: mode });
  }
  // 排序：只为排序列算一遍值；入选者在前（includeUnmatched 时）；空值总在最后；同值按姓名、id
  const sort = o.sort && o.sort.col ? o.sort : null;
  const dir = sort && sort.dir === "desc" ? -1 : 1;
  for (const it of items) it.k = sort ? sortKey(sort.col, columnValue(sort.col, it.u, facts, env), env) : null;
  items.sort((a, b) => {
    if (o.includeUnmatched && a.matched !== b.matched) return a.matched ? -1 : 1;
    if (sort) {
      if (a.k === null && b.k !== null) return 1;
      if (b.k === null && a.k !== null) return -1;
      if (a.k !== null && b.k !== null) { const d = cmpKeys(a.k, b.k); if (d) return d * dir; }
    }
    return COLLATOR.compare(str(a.u.name), str(b.u.name)) || COLLATOR.compare(str(a.u.employeeId), str(b.u.employeeId)) || COLLATOR.compare(str(a.u.id), str(b.u.id));
  });
  const out = {
    total: items.length, matchedTotal, columns, columnMeta: meta,
    skipped: c.skipped, warnings: c.warnings,
  };
  if (c.usage.nextLevel || o.computeUnmapped) {
    out.unmapped = population.filter((u) => !c.ladder.info(u.jobLevel)).map((u) => ({ id: u.id, name: u.name || null, employeeId: u.employeeId || null, jobLevel: u.jobLevel || null }));
  }
  if (o.idsOnly) {
    const ids = items.filter((it) => it.matched).map((it) => it.u.id);
    out.ids = ids.slice(0, IDS_CAP);
    out.truncated = ids.length > IDS_CAP;
    out.rows = [];
    return out;
  }
  let slice = items;
  if (!o.all) {
    const size = Math.max(1, Math.min(PAGE_MAX, Math.floor(Number(o.pageSize) || PAGE_DEFAULT)));
    const page = Math.max(1, Math.floor(Number(o.page) || 1));
    slice = items.slice((page - 1) * size, page * size);
    out.page = page; out.pageSize = size;
  } else { out.page = 1; out.pageSize = items.length; }
  out.rows = slice.map((it) => {
    const values = {};
    for (const col of columns) values[col] = columnValue(col, it.u, facts, env);
    const row = { id: it.u.id, name: it.u.name || null, employeeId: it.u.employeeId || null, matched: it.matched, member: it.member, values };
    if (o.explain) row.hits = c.explain(it.u);
    return row;
  });
  if (o.explain) out.explainHeads = c.heads;
  return out;
}

// ---------------------------------------------------------------- text & CSV
const MEMBER_TEXT = { include: ["手动加入", "Manually added"], exclude: ["已排除", "Excluded"] };
function optText(options, v, zh) {
  const o = (options || []).find((x) => x.value === v);
  return o ? (zh ? o.label_zh : o.label) : str(v);
}
function columnText(col, raw, catalog, lang) {
  const zh = lang !== "en";
  if (raw === null || raw === undefined || (Array.isArray(raw) && !raw.length)) return "";
  const ix = M.indexCatalog(catalog);
  const field = (id) => ix.fields.get(id) || null;
  const rating = (v) => { const f = field("perfRecent"); return f ? optText(f.options, v, zh) : str(v); };
  switch (col) {
    case "latestRating": return rating(raw);
    case "recentRatings": return raw.map((v) => (v === null ? "—" : rating(v))).join(" · ");
    case "tenure": case "levelTenure": { const y = Math.floor(raw / 12), m = raw % 12; return zh ? (y ? `${y} 年 ${m} 个月` : `${m} 个月`) : (y ? `${y} yr ${m} mo` : `${m} mo`); }
    case "manager": return raw.employeeId ? `${raw.name || ""} (${raw.employeeId})` : str(raw.name);
    case "potential": { const t = optText(M.POTENTIAL_OPTIONS, raw.value, zh); return raw.at ? `${t} (${raw.at})` : t; }
    case "nineBox": return optText(M.NINEBOX_OPTIONS, raw, zh);
    case "empStatus": return optText(M.EMP_STATUS_OPTIONS, raw, zh);
    case "jobTrack": return optText(M.TRACK_OPTIONS, raw, zh);
    case "trainingMandatory": return `${raw.done}/${raw.total}`;
    case "trainingCompletion": return `${raw}%`;
    case "member": return MEMBER_TEXT[raw] ? MEMBER_TEXT[raw][zh ? 0 : 1] : str(raw);
    case "successionPositions": case "talentTags": return raw.join("; ");
    default:
      if (str(col).startsWith("custom:")) {
        const c = ix.columns.get(col);
        if (c && c.input === "checkbox") return raw === true || raw === 1 || raw === "1" || raw === "true" ? (zh ? "是" : "Yes") : (zh ? "否" : "No");
        if (c && c.options && c.options.length) return Array.isArray(raw) ? raw.map((v) => optText(c.options, v, zh)).join("; ") : optText(c.options, raw, zh);
      }
      return Array.isArray(raw) ? raw.join("; ") : typeof raw === "object" ? JSON.stringify(raw) : str(raw);
  }
}
function headerOf(col, catalog, meta) {
  const ix = M.indexCatalog(catalog);
  const c = ix.columns.get(col) || M.COLUMN_DEFS.find((x) => x.id === col) || { label: col, label_zh: col };
  let zh = c.label_zh || c.label, en = c.label;
  const win = (months) => (months > 0 ? [`（近 ${months} 个月）`, ` (last ${months} months)`] : ["（全部）", " (all time)"]);
  if (col === "violationCount" || col === "awardCount") {
    const m = meta && meta[col] ? meta[col].months : 12;
    const [a, b] = win(m);
    zh += a; en += b;
  }
  if (col === "recentRatings" && meta && meta.recentRatings) { zh += `（近 ${meta.recentRatings.n} 期）`; en += ` (last ${meta.recentRatings.n})`; }
  return zh && zh !== en ? `${zh} ${en}` : en;
}
function csvRows({ rows, columns, catalog, lang, summary, columnMeta }) {
  const zh = lang !== "en";
  const out = [];
  out.push([(zh ? "# 条件：" : "# Conditions: ") + str(summary)]);
  out.push(columns.map((col) => headerOf(col, catalog, columnMeta)));
  for (const r of rows || []) out.push(columns.map((col) => columnText(col, r.values ? r.values[col] : undefined, catalog, lang)));
  return out;
}

module.exports = {
  PAGE_DEFAULT, PAGE_MAX, IDS_CAP, POT_BUCKET,
  basePopulation, createFacts, compile, run, columnValue, columnText, csvRows,
  monthsBefore, fullMonths, levelSinceDay, periodKindOfText, buildLadder, ranksInRange, ratingBucket,
};
