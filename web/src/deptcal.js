// 部门校准的纯函数（第二批 2.2 / 2.7 / 2.3-C，2026-10-08）：DeptCalibration.jsx（员工端 HoD 部门校准、后台部门明细）
// 与后台周期看板共用。没有 JSX、没有 import，test/deptcal-ui.test.js 用 vm 直接跑。
//
// 行（view.rows[]，契约见设计 1.4，服务端 reviewCalibView 产出）用到的字段：
//   id, userId, name, employeeId, department, deptPath, jobLevel, jobGrade, jobTrack, managerId, manager, managerStatus,
//   selfAt, oneOnOneAt, employeeOneOnOneAt, oneState, managerRating, highlights, finalRating, hodText, hodProxy,
//   effective, bucket, adjusted, overQuota, notCounted, overdue, pending, locked, editable
// hodProxy 兼容三种写法：null / 类型字符串（'manager_pending' | 'manager_departed'）/ 迁移 69 的对象 { by, at, reason, type? }。
// 口径：
//   · 生效评级 = finalRating || managerRating；配额档 C、D 合并为 C/D（与 server.js reviewBucket 相同，地址栏里写 tier=C%2FD）。
//   · 计数用的评级 = ratingOf：已关闭周期的后台行带 recordRating（档案里现在的评级，2.6 关闭后改过的取改后的值；null = 档案记录已删）
//     时以它为准，否则 = 生效评级（第二批波次 3：已关闭周期的计数按档案评级，与后台周期列表、看板、首页同一口径）。
//   · 不计入（notCounted：'departed' 已离职 / 'hod_self' HoD 本人）的人不参与配额、阻断项、待处理和进度分母。
//   · 待处理 = 计入且（季度：面谈不是双方都登记；或没有生效评级；或落在超额档）。
//   · 代评：季度周期、上级没有评级、HoD 给了评级。只有上级已离职 / 没有上级，或已过评级截止日（dueRateAt）才能代评；
//     HoD 本人就是直属上级时不走代评，用上级评级入口（审查 P0-3）。年度周期本来就由 HoD 评级，不算代评。

export const RATING_ORDER = ['A+', 'A', 'B+', 'B', 'C', 'D'];
export const TIER_ORDER = ['A+', 'A', 'B+', 'B', 'C/D'];
export const QUOTA_CAPPED = ['A+', 'A', 'B+'];
export const HL_RATINGS = ['A+', 'A', 'C', 'D'];
export const ONE_STATES = ['both', 'mgr', 'emp', 'none'];
export const STAGES = ['self', 'one', 'rate', 'hod', 'hr', 'confirmed', 'norating'];
// 按上级看分布（M6）：已评 ≥ MGR_DIST_MIN 人才判断；与整体均值差 ≥ +MGR_DIST_DIFF 档为偏宽，≤ −MGR_DIST_DIFF 档为偏严
export const MGR_DIST_MIN = 5;
export const MGR_DIST_DIFF = 0.5;
export const NONE = '__none';

const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const lower = (v) => String(v === null || v === undefined ? '' : v).trim().toLowerCase();
const upper = (v) => String(v === null || v === undefined ? '' : v).trim().toUpperCase();
const COLLATOR = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }) : null;
const cmpText = (a, b) => (COLLATOR ? COLLATOR.compare(String(a || ''), String(b || '')) : String(a || '').localeCompare(String(b || '')));

export const bucketOf = (r) => (r === 'C' || r === 'D' ? 'C/D' : r || null);
export const effectiveOf = (row) => (row ? row.finalRating || row.managerRating || null : null);
// 计数、档位、排序、进度用的评级：行上有 recordRating 字段（服务端只给已关闭周期的后台行）→ 档案评级，否则 = 生效评级
export const ratingOf = (row) => (row && row.recordRating !== undefined ? row.recordRating || null : effectiveOf(row));
export const isCounted = (row) => !!row && !row.notCounted;

// 本地日历日（审查 P2：oneOnOneAt.slice(0,10) 是 UTC 日，马尼拉 08:00 前登记的会显示成前一天）
export function localDay(v) {
  if (blank(v)) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function todayLocal() { return localDay(new Date().toISOString()); }
// 本地时间「yyyy-MM-dd HH:mm」（部门「已确认 · 时间 · 确认人」，与后台部门确认列表同一写法；不用 slice，那是 UTC）
export function localStamp(v) {
  if (blank(v)) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${localDay(s)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 确认人姓名：部门状态上的 hrName（服务端 O1）；几种旧写法也认，没有就是空串
export function confirmerOf(st) {
  if (!st || typeof st !== 'object') return '';
  return String(st.hrName || (st.hrBy && st.hrBy.name) || (st.confirmedBy && st.confirmedBy.name) || st.confirmedByName || '');
}
// 没有 HoD 的组（HR 直接校准、直接确认）：服务端给了 hodOwned 就用它，旧接口没有时按 hod / 提交记录推（与后台部门确认列表同口径）
export function noHodOf(dept) {
  if (!dept || typeof dept !== 'object') return false;
  // CX-171：HoD 待确认（多名候选人或负责人已停用，服务端 hodUnresolved）不是「没有 HoD」——不进 HR 直接校准，
  // 先到部门页指定负责人（服务端也会以 hod_unresolved 拒绝 HR 确认）
  if (dept.hodUnresolved) return false;
  if (typeof dept.hodOwned === 'boolean') return !dept.hodOwned;
  const st = dept.status && typeof dept.status === 'object' ? dept.status : {};
  return !(dept.hod || st.hodId || st.hodSubmittedAt);
}

export function oneStateOf(row) {
  if (!row) return 'none';
  if (ONE_STATES.includes(row.oneState)) return row.oneState;
  return row.oneOnOneAt && row.employeeOneOnOneAt ? 'both' : row.oneOnOneAt ? 'mgr' : row.employeeOneOnOneAt ? 'emp' : 'none';
}

// 代评类型；不是代评 → null
export function proxyOf(row) {
  if (!row || !row.hodProxy) return null;
  const p = row.hodProxy;
  if (typeof p === 'string') return p === 'manager_departed' || p === 'manager_pending' ? p : 'manager_pending';
  if (typeof p === 'object') {
    if (p.type === 'manager_departed' || p.type === 'manager_pending') return p.type;
    return row.managerStatus && row.managerStatus !== 'active' ? 'manager_departed' : 'manager_pending';
  }
  return 'manager_pending';
}

// A+ / A / C / D 缺关键亮点：代评行看理由（G1），其余看上级写的亮点
export function highlightsMissing(row, hl = HL_RATINGS) {
  if (!row) return false;
  if (proxyOf(row)) return hl.includes(effectiveOf(row)) && blank(row.hodText);
  if (typeof row.highlightsMissing === 'boolean') return row.highlightsMissing;
  return !!row.managerRating && hl.includes(row.managerRating) && blank(row.highlights);
}

// ---------- 草稿 ----------
// drafts：{ [行 id]: { rating: 'A' | null（清空 HoD 评级）, reason: string, base?: { managerRating, finalRating } } }
// base = 开始改这一行时服务端的上级评级与 HoD 评级（draftBaseOf）。保存时按 base 发 expect，恢复草稿、或同一部门的数据
// 刷新后，base 与现在的行对不上的草稿丢掉（staleDraft）—— 不能拿「现在」的值当 expect，否则上级在此期间评了级，
// 代评会被悄悄改成调整（审查 P1-4 的绕过）。
const normRating = (r) => (blank(r) ? null : String(r));
export function draftBaseOf(row) {
  return { managerRating: normRating(row && row.managerRating), finalRating: normRating(row && row.finalRating) };
}
// 草稿的 base 与现在的行不一致（上级或 HoD 评级在此期间变了）→ true；没有 base 的旧草稿不判
export function staleDraft(row, d) {
  if (!row || !d || !d.base || typeof d.base !== 'object') return false;
  return normRating(d.base.managerRating) !== normRating(row.managerRating) || normRating(d.base.finalRating) !== normRating(row.finalRating);
}
export function draftDirty(row, d) {
  if (!row || !d) return false;
  // CX-177：行上原本没有 HoD 调整，草稿又改回与上级评级相同（或清空）= 没有调整；残留的理由不算一项修改
  const target = normRating(d.rating);
  if (!normRating(row.finalRating) && (!target || (row.managerRating && target === normRating(row.managerRating)))) return false;
  return normRating(d.rating) !== normRating(row.finalRating) || String(d.reason || '').trim() !== String(row.hodText || '').trim();
}

// 把草稿合成进行（不改原对象）：finalRating / hodText / effective / bucket / adjusted / hodProxy 按草稿重算，_draft = true
export function applyDrafts(rows, drafts, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!drafts || !Object.keys(drafts).length) return list;
  const annual = opts.kind === 'annual';
  return list.map((row) => {
    const d = drafts[row.id];
    if (!d || !draftDirty(row, d)) return row;
    const finalRating = normRating(d.rating);
    const effective = finalRating || row.managerRating || null;
    let hodProxy = null;
    if (!annual && finalRating && !row.managerRating) {
      hodProxy = row.hodProxy || (row.managerStatus && row.managerStatus !== 'active' ? 'manager_departed' : 'manager_pending');
    }
    return {
      ...row, finalRating, hodText: String(d.reason || ''), effective, bucket: bucketOf(effective),
      adjusted: !annual && !!(finalRating && row.managerRating && finalRating !== row.managerRating),
      hodProxy, _draft: true,
    };
  });
}

// 改动清单（提交给 PUT /api/me/reviews/hod/items）：每行带 expect = 开始改这一行时的上级评级与 HoD 评级（草稿的 base；
// 没有 base 的旧草稿按现在的行），服务端发现不一致时整批不写、该行报 stale（审查 P1-4：保存前上级刚评了，代评不能悄悄变成调整）
export function buildChanges(rows, drafts) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const d = drafts && drafts[row.id];
    if (!d || !draftDirty(row, d)) continue;
    const b = d.base && typeof d.base === 'object' ? d.base : draftBaseOf(row);
    out.push({
      id: row.id, rating: normRating(d.rating), reason: String(d.reason || '').trim(),
      expect: { managerRating: normRating(b.managerRating), finalRating: normRating(b.finalRating) },
    });
  }
  return out;
}

// 只留还在名单里、可编辑、base 仍与行一致的草稿（sessionStorage 恢复时、同一部门的数据刷新后用）
export function sanitizeDrafts(drafts, rows) {
  const out = {};
  if (!drafts || typeof drafts !== 'object') return out;
  const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.id), r]));
  for (const [id, d] of Object.entries(drafts)) {
    const row = byId.get(String(id));
    if (!row || !d || typeof d !== 'object') continue;
    if (row.editable === false || row.locked || row.notCounted) continue;
    if (staleDraft(row, d)) continue;
    const clean = { rating: normRating(d.rating), reason: String(d.reason || '').slice(0, 1000) };
    if (d.base && typeof d.base === 'object') clean.base = { managerRating: normRating(d.base.managerRating), finalRating: normRating(d.base.finalRating) };
    if (draftDirty(row, clean)) out[row.id] = clean;
  }
  return out;
}

// 该行这次评级要不要理由：'proxy'（代评理由）| 'adjust'（调整理由）| null。年度周期选填。
export function reasonNeeded(row, rating, kind) {
  if (kind === 'annual' || !row || blank(rating)) return null;
  if (!row.managerRating) return 'proxy';
  return String(rating) !== row.managerRating ? 'adjust' : null;
}

// HoD 能不能给这一行代评（只在上级未评、要新给评级时判断；已代评的行可以改或清空）：
// null = 可以；'use_manager_entry' = HoD 就是直属上级；'manager_not_overdue' = 上级在职且评级截止日未过
export function proxyGate(row, ctx = {}) {
  if (!row || ctx.kind === 'annual' || row.managerRating || row.finalRating) return null;
  if (ctx.hodId && row.managerId && String(row.managerId) === String(ctx.hodId)) return 'use_manager_entry';
  if (row.managerStatus && row.managerStatus !== 'active') return null;
  if (!row.managerId) return null;
  const due = ctx.dueRateAt ? localDay(ctx.dueRateAt) : '';
  const today = ctx.today ? localDay(ctx.today) : todayLocal();
  if (due && today > due) return null;
  return 'manager_not_overdue';
}

// 保存前的本地校验：{ [id]: code }（code 与服务端同名：reason_required / proxy_reason_required / manager_not_overdue / use_manager_entry）
export function validateChanges(rows, changes, ctx = {}) {
  const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.id, r]));
  const errs = {};
  for (const c of changes || []) {
    const row = byId.get(c.id);
    if (!row) { errs[c.id] = 'not_found'; continue; }
    if (c.rating && !row.finalRating) { const g = proxyGate(row, ctx); if (g) { errs[c.id] = g; continue; } }
    const need = reasonNeeded(row, c.rating, ctx.kind);
    if (need && blank(c.reason)) errs[c.id] = need === 'proxy' ? 'proxy_reason_required' : 'reason_required';
  }
  return errs;
}

// ---------- 配额 ----------
// 按草稿实时重算配额条：{ counts, over:[{tier,count,allowed}], overTiers:Set, headcount }。
// allowed 用服务端给的（有提交快照时服务端已按「当前人数 + 提交后离职的人」算基数，审查 P1-1），这里不重算名额。
// allowed 为 null（范围不全，审查 P1-2）→ 返回 null。
export function quotaPreview(rows, allowed, drafts, opts = {}) {
  if (!allowed || typeof allowed !== 'object') return null;
  const applied = applyDrafts(rows, drafts, opts);
  const counts = {};
  let headcount = 0;
  for (const r of applied) {
    if (!isCounted(r)) continue;
    headcount++;
    const b = bucketOf(ratingOf(r));
    if (b) counts[b] = (counts[b] || 0) + 1;
  }
  const over = QUOTA_CAPPED.filter((t) => allowed[t] !== undefined && allowed[t] !== null && (counts[t] || 0) > Number(allowed[t]))
    .map((t) => ({ tier: t, count: counts[t] || 0, allowed: Number(allowed[t]) }));
  return { counts, over, overTiers: new Set(over.map((o) => o.tier)), headcount };
}

// 档位顺序：服务端 allowed / counts 的键按 TIER_ORDER 排，不认识的排在后面
export function tiersOf(allowed, counts) {
  const keys = new Set([...Object.keys(allowed || {}), ...Object.keys(counts || {})]);
  const known = TIER_ORDER.filter((t) => keys.has(t));
  const rest = [...keys].filter((t) => !TIER_ORDER.includes(t)).sort();
  return known.length || rest.length ? [...known, ...rest] : TIER_ORDER.slice();
}

// kind === 'annual'：年度周期没有面谈这一步（与服务端 row.pending 同一口径），只看评级与超额
export function rowPending(row, overTiers, kind) {
  if (!isCounted(row)) return false;
  if (kind !== 'annual' && oneStateOf(row) !== 'both') return true;
  const eff = ratingOf(row);
  if (!eff) return true;
  if (overTiers instanceof Set) return overTiers.has(bucketOf(eff));
  return !!row.overQuota;
}

// ---------- 职级 ----------
// lv：'g:<职等>' | 'r:<职级>' | 'none'（未设职级）| 'nogrid'（有职级但不在职级体系里）
export function matchLevel(row, lv) {
  if (blank(lv)) return true;
  const v = String(lv);
  if (v === 'none') return blank(row && row.jobLevel);
  if (v === 'nogrid') return !blank(row && row.jobLevel) && blank(row && row.jobGrade);
  if (v.startsWith('g:')) return !blank(row && row.jobGrade) && String(row.jobGrade).trim() === v.slice(2).trim();
  if (v.startsWith('r:')) return upper(row && row.jobLevel) === upper(v.slice(2));
  return true;
}
// 名单里出现过的职级选项：[{ value, kind:'g'|'r'|'none'|'nogrid', label }]，职等按数字、职级按自然顺序
export function levelOptions(rows) {
  const grades = new Map(), ranks = new Map();
  let none = false, nogrid = false;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (blank(r.jobLevel)) { none = true; continue; }
    ranks.set(upper(r.jobLevel), String(r.jobLevel).trim());
    if (blank(r.jobGrade)) nogrid = true;
    else grades.set(String(r.jobGrade).trim(), String(r.jobGrade).trim());
  }
  const num = (a, b) => (Number(a) - Number(b)) || cmpText(a, b);
  return [
    ...[...grades.keys()].sort(num).map((g) => ({ value: 'g:' + g, kind: 'g', label: g })),
    ...[...ranks.entries()].sort((a, b) => cmpText(a[0], b[0])).map(([, r]) => ({ value: 'r:' + r, kind: 'r', label: r })),
    ...(nogrid ? [{ value: 'nogrid', kind: 'nogrid', label: '' }] : []),
    ...(none ? [{ value: 'none', kind: 'none', label: '' }] : []),
  ];
}

// ---------- 筛选、排序、分组 ----------
// rows 已按草稿合成（applyDrafts）；drafts 只用来让「正在改的行」不被筛掉（改着改着行消失很难用）。
// ctx：{ ids: Set | null（点阻断项只看这些人，组件内部状态）, overTiers, highlightRatings, kind（'annual' 时待处理不看面谈） }
export function filterRows(rows, query, drafts, ctx = {}) {
  const q = query || {};
  const list = Array.isArray(rows) ? rows : [];
  const kw = lower(q.q);
  const hl = ctx.highlightRatings || HL_RATINGS;
  const ids = ctx.ids instanceof Set ? ctx.ids : null;
  const sticky = (row) => !!row._draft || !!(drafts && drafts[row.id] && draftDirty(row, drafts[row.id]));
  return list.filter((row) => {
    if (ids && !ids.has(row.id)) return false;
    if (sticky(row)) return true;
    if (kw && !lower(row.name).includes(kw) && !lower(row.employeeId).includes(kw)) return false;
    if (!blank(q.dept)) {
      const p = Array.isArray(row.deptPath) ? row.deptPath : [];
      if (q.dept === NONE ? p.length > 0 : !p.includes(String(q.dept))) return false;
    }
    if (!blank(q.mgr)) {
      if (q.mgr === NONE ? !blank(row.managerId) : String(row.managerId || '') !== String(q.mgr)) return false;
    }
    if (!matchLevel(row, q.lv)) return false;
    if (!blank(q.one) && oneStateOf(row) !== q.one) return false;
    if (!blank(q.mr)) {
      if (q.mr === 'none' ? !!row.managerRating : row.managerRating !== q.mr) return false;
    }
    if (!blank(q.adj)) {
      const px = !!proxyOf(row);
      const adj = !!row.adjusted && !px;
      if (q.adj === 'adj' && !adj) return false;
      if (q.adj === 'proxy' && !px) return false;
      if (q.adj === 'no' && (adj || px)) return false;
    }
    if (q.hl === '1' && !highlightsMissing(row, hl)) return false;
    if (!blank(q.od)) {
      const od = Array.isArray(row.overdue) ? row.overdue : [];
      if (q.od === '1' ? !od.length : !od.includes(q.od)) return false;
    }
    if (!blank(q.tier) && bucketOf(ratingOf(row)) !== q.tier) return false;
    if (q.pending === '1' && !rowPending(row, ctx.overTiers, ctx.kind)) return false;
    return true;
  });
}

export function sortRows(rows, sort) {
  const list = (Array.isArray(rows) ? rows : []).slice();
  const byName = (a, b) => cmpText(a.name, b.name) || cmpText(a.employeeId, b.employeeId) || cmpText(a.id, b.id);
  if (sort === 'rating') {
    const rank = (r) => { const i = RATING_ORDER.indexOf(ratingOf(r)); return i < 0 ? RATING_ORDER.length : i; };
    return list.sort((a, b) => rank(a) - rank(b) || byName(a, b));
  }
  if (sort === 'dept') return list.sort((a, b) => cmpText(a.department, b.department) || byName(a, b));
  return list.sort(byName);
}

// 按直属上级分组：[{ key, managerId, manager, managerStatus, rows, total, rated }]；total / rated 只数计入的人。
// 组按上级姓名排序，没有上级的一组排最后。
export function groupByManager(rows) {
  const groups = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = blank(r.managerId) ? NONE : String(r.managerId);
    if (!groups.has(key)) {
      groups.set(key, { key, managerId: key === NONE ? null : r.managerId, manager: key === NONE ? null : r.manager || null,
        managerStatus: key === NONE ? 'none' : r.managerStatus || 'active', rows: [], total: 0, rated: 0 });
    }
    const g = groups.get(key);
    g.rows.push(r);
    if (isCounted(r)) { g.total++; if (ratingOf(r)) g.rated++; }
  }
  return [...groups.values()].sort((a, b) => (a.key === NONE) - (b.key === NONE) || cmpText(a.manager, b.manager) || cmpText(a.key, b.key));
}

// 吸顶区进度（分母只数计入的人）：{ total, self, one, rated }；one = 面谈双方都登记
export function progressOf(rows) {
  const p = { total: 0, self: 0, one: 0, rated: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isCounted(r)) continue;
    p.total++;
    if (r.selfAt) p.self++;
    if (oneStateOf(r) === 'both') p.one++;
    if (ratingOf(r)) p.rated++;
  }
  return p;
}

// 直属上级筛选的选项：[{ id, name, status }]，按姓名；没有上级的人存在时最后加 { id:'__none' }
export function managerOptions(rows) {
  const m = new Map();
  let none = false;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (blank(r.managerId)) { none = true; continue; }
    const k = String(r.managerId);
    if (!m.has(k)) m.set(k, { id: k, name: r.manager || '', status: r.managerStatus || 'active' });
  }
  const out = [...m.values()].sort((a, b) => cmpText(a.name, b.name) || cmpText(a.id, b.id));
  if (none) out.push({ id: NONE, name: '', status: 'none' });
  return out;
}

// 提醒结果（sendBulkResult 的形状）按跳过原因汇总：{ done, unchanged, reminded, groups:[{ code, n, ids }] }
// done 含「未改动」（已评级 / 已代评）；真正提醒到的人数是 reminded = done − unchanged
export function remindSummary(res) {
  const out = { done: 0, unchanged: 0, reminded: 0, groups: [] };
  if (!res || typeof res !== 'object') return out;
  out.done = Number(res.done) || 0;
  out.unchanged = Number(res.unchanged) || 0;
  out.reminded = Math.max(0, out.done - out.unchanged);
  const by = new Map();
  for (const r of Array.isArray(res.results) ? res.results : []) {
    if (r && r.ok) continue;
    const code = (r && r.code) || 'error';
    if (!by.has(code)) by.set(code, { code, n: 0, ids: [] });
    const g = by.get(code);
    g.n++;
    if (r && r.id !== undefined) g.ids.push(r.id);
  }
  out.groups = [...by.values()];
  return out;
}

// ---------- 后台看板复用（W2-C）----------
// 条目所处的阶段（STAGES）：已确认 → confirmed（无评级为 norating，评级按 ratingOf：已关闭周期看档案评级）；已提交 → hr；
// 季度：未交自评 → self；没有生效评级 → 面谈双方未登记为 one，否则 rate；有评级 → 等部门提交（hod）。
// 年度：没有自评、面谈、上级评级这几步（第二批波次 3 修正：原先未交自评的年度条目全落在 self），未提交前一律等 HoD（hod）。
// 没有 HoD 的组（dept.hod 为空且不归 HoD）由 HR 直接确认：本该是 hod 的阶段记为 hr。
// depts：后台周期详情的 depts[]（或 Map(dept1Id → 部门行)），部门行带 { dept1Id, hod, hodOwned, status }。
// kind：周期类型（条目自带 kind === 'annual' 时同样按年度）。
export function stageOf(item, depts, kind) {
  if (!item) return 'norating';
  const d = depts instanceof Map ? depts.get(item.dept1Id) : (Array.isArray(depts) ? depts : []).find((x) => x && x.dept1Id === item.dept1Id);
  const st = d && d.status && typeof d.status === 'object' ? d.status : null;
  if (st && st.hrConfirmedAt) return ratingOf(item) ? 'confirmed' : 'norating';
  if (st && st.hodSubmittedAt) return 'hr';
  const noHod = !!d && noHodOf(d);
  const annual = kind === 'annual' || item.kind === 'annual';
  if (annual) return noHod ? 'hr' : 'hod';
  if (!item.selfAt) return 'self';
  if (!item.managerRating && !proxyOf(item) && !item.finalRating) return oneStateOf(item) === 'both' ? 'rate' : 'one';
  return noHod ? 'hr' : 'hod';
}

// 按直属上级看评级分布（只看上级本人给的 managerRating；排除不计入的人和代评条目）：
// { overall:{ n, mean }, rows:[{ managerId, manager, managerStatus, n, counts, mean, diff, tag }] }
// 分值：ratingOptions 里越靠前越高（A+ 最高）；diff = 该上级均值 − 整体均值（单位：档）；
// tag：已评不足 MGR_DIST_MIN 人为 'few'；diff ≥ +MGR_DIST_DIFF 为 'loose'（偏宽）；≤ −MGR_DIST_DIFF 为 'tight'（偏严）；否则 null。
export function mgrDist(items, ratingOptions) {
  const scale = Array.isArray(ratingOptions) && ratingOptions.length ? ratingOptions : RATING_ORDER;
  const score = (r) => { const i = scale.indexOf(r); return i < 0 ? null : scale.length - 1 - i; };
  const by = new Map();
  let sum = 0, n = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !isCounted(it) || proxyOf(it) || !it.managerRating) continue;
    const s = score(it.managerRating);
    if (s === null) continue;
    sum += s; n++;
    const key = blank(it.managerId) ? NONE : String(it.managerId);
    if (!by.has(key)) by.set(key, { managerId: key === NONE ? null : it.managerId, manager: it.manager || null, managerStatus: key === NONE ? 'none' : it.managerStatus || 'active', n: 0, counts: {}, _sum: 0 });
    const g = by.get(key);
    g.n++; g._sum += s; g.counts[it.managerRating] = (g.counts[it.managerRating] || 0) + 1;
  }
  const mean = n ? sum / n : null;
  const rows = [...by.values()].map(({ _sum, ...g }) => {
    const m = g.n ? _sum / g.n : null;
    const diff = m === null || mean === null ? null : Math.round((m - mean) * 100) / 100;
    const tag = g.n < MGR_DIST_MIN ? 'few' : diff >= MGR_DIST_DIFF ? 'loose' : diff <= -MGR_DIST_DIFF ? 'tight' : null;
    return { ...g, mean: m === null ? null : Math.round(m * 100) / 100, diff, tag };
  }).sort((a, b) => (a.managerId === null) - (b.managerId === null) || cmpText(a.manager, b.manager));
  return { overall: { n, mean: mean === null ? null : Math.round(mean * 100) / 100 }, rows };
}
