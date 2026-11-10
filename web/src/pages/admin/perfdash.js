// 绩效看板（后台）第一期的计算（负责人 2026-10-10 拍板，方案 docs/PROPOSAL-20261010-performance-dashboard.md 第四节）。
// 纯函数、无 import：输入是 GET /api/admin/review-cycles/:id 的 items / depts（已按调用者的数据范围过滤），
// 所以看板上的每个数都由同一份 items 导出，点开的名单与数字一致（与工作台 12.2 同一约束）。测试用 vm 直接跑（test/perf-dashboard.test.js）。
//
//   ratingOf(item, closed)             已关闭周期按档案评级（recordRating），进行中按生效评级（最终 || 上级）
//   counted(item)                      计入：离职 / HoD 本人等 notCounted 的不计
//   progressRows(items, depts, kind)   按一级部门的阶段完成情况（+ 合计行），季度：自评 / 面谈 / 上级评级 / HoD 代评；年度：评级 / HoD 代评
//   overdueGroups(items)               逾期名单：{ self:[], rate:[] }（item.overdue 由服务端算）
//   deptStatus(depts)                  部门确认状态计数：待 HoD 提交 / 待 HR 确认 / 已退回 / 已确认 / 无 HoD
//   transfer(items, scale, closed)     上级评级 → 最终评级 的转移：{ cells:{from:{to:[items]}}, up:[], down:[], same:[] }（不含代评）
//   moveRows(items, depts, scale, closed) 按一级部门的上调率 / 下调率
//   leniency(items, scale, minN)       上级评分尺度：每位上级给出评级的平均档位 − 所在一级部门平均档位
//   distRows(items, keyOf, closed)     按任意键（序列、职级）分组的各档人数
//   scoreOf(rating, scale)             档位分值：最高档 = scale.length … 最低档 = 1（只用于比较，不对员工展示）

export const TIERS = ['A+', 'A', 'B+', 'B', 'C/D'];
export const LENIENCY_MIN = 3;          // 上级至少评了这么多人才计算尺度
export const LENIENCY_FLAG = 0.5;       // 与部门平均差 ≥ 0.5 档标出

export const bucketOf = (r) => (r === 'C' || r === 'D' ? 'C/D' : r || null);
export const counted = (i) => !!i && !i.notCounted;
export function ratingOf(i, closed) {
  if (!i) return null;
  if (closed && i.recordRating !== undefined) return i.recordRating || null;
  return i.finalRating || i.managerRating || null;
}
const proxied = (i) => !!(i && i.hodProxy);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

export function scoreOf(rating, scale) {
  const sc = Array.isArray(scale) && scale.length ? scale : ['A+', 'A', 'B+', 'B', 'C', 'D'];
  const k = sc.indexOf(rating);
  return k < 0 ? null : sc.length - k;
}

function groupByDept(items, depts) {
  const order = (depts || []).map((d) => d.dept1Id);
  const name = new Map((depts || []).map((d) => [d.dept1Id, d.dept1 || null]));
  // 旧流程周期没有部门行（depts 为空）：名称取条目自带的 dept1（服务端按所属一级部门补）
  for (const i of items || []) if (i && i.dept1Id && !name.get(i.dept1Id) && i.dept1) name.set(i.dept1Id, i.dept1);
  const g = new Map(order.map((id) => [id, []]));
  for (const i of items) {
    const k = i.dept1Id || null;
    if (!g.has(k)) { g.set(k, []); order.push(k); }
    g.get(k).push(i);
  }
  return order.filter((k, n) => order.indexOf(k) === n).map((k) => ({ dept1Id: k, dept1: name.get(k) || null, items: g.get(k) || [] }));
}

export function progressRows(items, depts, kind) {
  const annual = kind === 'annual';
  const statusOf = new Map((depts || []).map((d) => [d.dept1Id, d.status || null]));
  const hodOf = new Map((depts || []).map((d) => [d.dept1Id, !!(d.hod || d.hodOwned)]));
  const row = (key, label, list) => {
    const c = list.filter(counted);
    const pick = (fn) => c.filter(fn);
    const self = annual ? [] : pick((i) => !!i.selfAt);
    const one = annual ? [] : pick((i) => i.oneState === 'both');
    // CX-169：HoD 代评不是「上级已评」。两者必须互斥展示，避免把
    // 代评混进直属上级的完成率，也让 HR 能单独看到代评规模。
    const rated = pick((i) => !!i.managerRating && !proxied(i));
    const proxy = pick(proxied);
    const overSelf = pick((i) => Array.isArray(i.overdue) && i.overdue.includes('self'));
    const overRate = pick((i) => Array.isArray(i.overdue) && i.overdue.includes('rate'));
    return {
      key, label, n: c.length, people: c,
      self, one, rated, proxy, overSelf, overRate,
      selfPct: annual ? null : pct(self.length, c.length), onePct: annual ? null : pct(one.length, c.length), ratedPct: pct(rated.length, c.length), proxyPct: pct(proxy.length, c.length),
      status: key === '__total' ? null : statusOf.get(key) || null, hasHod: key === '__total' ? null : !!hodOf.get(key),
    };
  };
  const rows = groupByDept(items || [], depts).map((g) => row(g.dept1Id, g.dept1, g.items)).filter((r) => r.n > 0);
  const total = row('__total', null, (items || []));
  // 低于合计完成率（取最后一个适用阶段：季度看上级评级，年度看评级）的部门标出
  for (const r of rows) r.below = r.ratedPct != null && total.ratedPct != null && r.ratedPct < total.ratedPct;
  return { rows, total };
}

export function overdueGroups(items) {
  const c = (items || []).filter(counted);
  return {
    self: c.filter((i) => Array.isArray(i.overdue) && i.overdue.includes('self')),
    rate: c.filter((i) => Array.isArray(i.overdue) && i.overdue.includes('rate')),
  };
}

export function deptStatus(depts) {
  const out = { pendingHod: [], pendingHr: [], returned: [], confirmed: [], noHod: [] };
  for (const d of depts || []) {
    const st = d.status || {};
    const hasHod = !!(d.hod || d.hodOwned);
    if (st.hrConfirmedAt) out.confirmed.push(d);
    else if (st.returnedAt && !st.hodSubmittedAt) out.returned.push(d);
    else if (st.hodSubmittedAt || !hasHod) out.pendingHr.push(d);
    else out.pendingHod.push(d);
    if (!hasHod) out.noHod.push(d);
  }
  return out;
}

export function transfer(items, scale, closed) {
  const cells = {};
  const up = [], down = [], same = [];
  for (const i of (items || []).filter(counted)) {
    if (!i.managerRating || proxied(i)) continue;
    const to = ratingOf(i, closed);
    if (!to) continue;
    const from = i.managerRating;
    (cells[from] = cells[from] || {});
    (cells[from][to] = cells[from][to] || []).push(i);
    const a = scoreOf(from, scale), b = scoreOf(to, scale);
    if (a == null || b == null || a === b) same.push(i);
    else if (b > a) up.push(i);
    else down.push(i);
  }
  return { cells, up, down, same, n: up.length + down.length + same.length };
}

export function moveRows(items, depts, scale, closed) {
  return groupByDept((items || []).filter(counted), depts).map((g) => {
    const t = transfer(g.items, scale, closed);
    return { key: g.dept1Id, label: g.dept1, n: t.n, up: t.up, down: t.down, upPct: pct(t.up.length, t.n), downPct: pct(t.down.length, t.n) };
  }).filter((r) => r.n > 0);
}

export function leniency(items, scale, minN = LENIENCY_MIN) {
  const c = (items || []).filter((i) => counted(i) && i.managerRating && !proxied(i) && scoreOf(i.managerRating, scale) != null);
  const deptSum = new Map();
  for (const i of c) {
    const k = i.dept1Id || null;
    const e = deptSum.get(k) || { s: 0, n: 0 };
    e.s += scoreOf(i.managerRating, scale); e.n++;
    deptSum.set(k, e);
  }
  const byMgr = new Map();
  for (const i of c) {
    if (!i.managerId) continue;
    const e = byMgr.get(i.managerId) || { managerId: i.managerId, manager: i.manager || null, people: [], dept: new Map() };
    e.people.push(i);
    e.dept.set(i.dept1Id || null, (e.dept.get(i.dept1Id || null) || 0) + 1);
    byMgr.set(i.managerId, e);
  }
  const rows = [];
  for (const e of byMgr.values()) {
    if (e.people.length < minN) continue;
    // 上级的团队跨部门时按人数最多的一级部门比较
    const dept = [...e.dept.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const ds = deptSum.get(dept);
    const avg = e.people.reduce((a, i) => a + scoreOf(i.managerRating, scale), 0) / e.people.length;
    const deptAvg = ds && ds.n ? ds.s / ds.n : null;
    const diff = deptAvg == null ? null : Math.round((avg - deptAvg) * 100) / 100;
    rows.push({ managerId: e.managerId, manager: e.manager, dept1Id: dept, n: e.people.length, people: e.people,
      avg: Math.round(avg * 100) / 100, deptAvg: deptAvg == null ? null : Math.round(deptAvg * 100) / 100, diff,
      flag: diff == null ? null : diff >= LENIENCY_FLAG ? 'lenient' : diff <= -LENIENCY_FLAG ? 'strict' : null });
  }
  return rows.sort((a, b) => Math.abs(b.diff || 0) - Math.abs(a.diff || 0));
}

export function distRows(items, keyOf, closed) {
  const g = new Map();
  for (const i of (items || []).filter(counted)) {
    const b = bucketOf(ratingOf(i, closed));
    if (!b) continue;
    const k = keyOf(i);
    const key = k == null || k === '' ? '__none' : String(k);
    const e = g.get(key) || { key, n: 0, tiers: {} };
    e.n++;
    (e.tiers[b] = e.tiers[b] || []).push(i);
    g.set(key, e);
  }
  return [...g.values()].sort((a, b) => (a.key === '__none') - (b.key === '__none') || String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
}

// ---------- 第二期：申诉（负责人 2026-10-10 开工）----------
// 输入：GET /api/admin/review-appeals?cycle=<id> 的 items（服务端已按调用者能看的申诉过滤、去掉利益相关的）与 deptOptions（id → 名称）。
// 每条行带 status / overdue / workdaysLeft / slaDueOn / decidedAt / ratingAtSubmit / currentRating / handler / deptPath / reasonCategory。
// 汇总头部的申诉率、按时答复数用 /stats 的同周期一行（分母与工作日按马尼拉日由服务端算），这里只做拆分与名单。
export const DUE_SOON_WORKDAYS = 2;     // 剩余 ≤ 2 个工作日 = 即将超时
const isOpenAp = (r) => r.status === 'submitted' || r.status === 'in_review';
const isDecided = (r) => r.status === 'maintained' || r.status === 'adjusted';
function groupRows(rows, keyOf) {
  const g = new Map();
  for (const r of rows) {
    const k = keyOf(r) || '__none';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
}
const apStats = (list) => ({
  n: list.length, rows: list,
  open: list.filter(isOpenAp), overdue: list.filter((r) => isOpenAp(r) && r.overdue),
  maintained: list.filter((r) => r.status === 'maintained'), adjusted: list.filter((r) => r.status === 'adjusted'),
});
export function appealSummary(rows, deptOptions, categories) {
  const all = (rows || []).filter(Boolean);
  const live = all.filter((r) => r.status !== 'withdrawn');
  const deptName = new Map((deptOptions || []).map((d) => [d.id, d.name || d.label || null]));
  const dept1Of = (r) => (Array.isArray(r.deptPath) && r.deptPath.length ? r.deptPath[0] : null);
  const open = live.filter(isOpenAp);
  const overdue = open.filter((r) => r.overdue);
  const dueSoon = open.filter((r) => !r.overdue && r.workdaysLeft != null && r.workdaysLeft <= DUE_SOON_WORKDAYS);
  const decided = live.filter(isDecided);
  const adjusted = decided.filter((r) => r.status === 'adjusted');
  // 调整后的评级变化：申诉时的评级 → 现在档案里的评级
  const changes = new Map();
  for (const r of adjusted) {
    const k = `${r.ratingAtSubmit || '—'} → ${r.currentRating || '—'}`;
    if (!changes.has(k)) changes.set(k, { key: k, from: r.ratingAtSubmit || null, to: r.currentRating || null, rows: [] });
    changes.get(k).rows.push(r);
  }
  const byDept = [...groupRows(live, dept1Of)].map(([k, list]) => ({ key: k, label: k === '__none' ? null : deptName.get(k) || null, ...apStats(list) }))
    .sort((a, b) => b.n - a.n || String(a.label || '').localeCompare(String(b.label || '')));
  // 按 HRBP：已开始处理的按处理人；还没人开始的记「待开始」
  const byHrbp = [...groupRows(live, (r) => (r.handler && r.handler.id) || null)].map(([k, list]) => ({
    key: k, label: k === '__none' ? null : (list[0].handler && list[0].handler.name) || null, ...apStats(list),
  })).sort((a, b) => (a.key === '__none') - (b.key === '__none') || b.n - a.n);
  const catOrder = (categories || []).map((c) => c.key);
  const byCategory = [...groupRows(live, (r) => r.reasonCategory || null)].map(([k, list]) => ({ key: k, ...apStats(list) }))
    .sort((a, b) => {
      const ia = a.key === '__none' ? 1e9 : catOrder.indexOf(a.key), ib = b.key === '__none' ? 1e9 : catOrder.indexOf(b.key);
      return (ia < 0 ? 1e8 : ia) - (ib < 0 ? 1e8 : ib);
    });
  return {
    total: all.length, withdrawn: all.filter((r) => r.status === 'withdrawn'), live,
    open, overdue, dueSoon, decided, adjusted, maintained: decided.filter((r) => r.status === 'maintained'),
    adjustPct: pct(adjusted.length, decided.length), changes: [...changes.values()].sort((a, b) => b.rows.length - a.rows.length),
    byDept, byHrbp, byCategory,
  };
}

// ---------- 第三期：趋势与人才信号（跨周期）----------
// 输入：同一类型（季度 / 年度）最近关闭的若干周期，[{ cycle, items }]，按关闭时间从早到晚；items 同周期明细（已按数据范围过滤），
// 评级取档案评级（ratingOf(i, true)）。最新一期的 items 带 flight / successor 时（服务端只给能读人才发展的人）才算「高绩效保留」的标记。
export const TREND_CYCLES = 4;
export const STABILITY_GAP = 2;          // 相邻两期差两档及以上
export function trendDist(series, deptId) {
  return (series || []).map(({ cycle, items }) => {
    const list = (items || []).filter((i) => counted(i) && (!deptId || i.dept1Id === deptId));
    const tiers = {};
    let n = 0;
    for (const i of list) {
      const b = bucketOf(ratingOf(i, true));
      if (!b) continue;
      n++;
      (tiers[b] = tiers[b] || []).push(i);
    }
    return { key: cycle.id, label: cycle.name, closedAt: cycle.closedAt || null, n, tiers };
  });
}
export function trendDepts(series) {
  const last = series && series.length ? series[series.length - 1] : null;
  const m = new Map();
  for (const i of (last && last.items) || []) if (i.dept1Id && !m.has(i.dept1Id)) m.set(i.dept1Id, i.dept1 || null);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}
export function talentSignals(series, scale) {
  const s = series || [];
  const out = { prev: null, last: null, unstable: [], lowTwice: [], highTwice: [], highFlight: [], highSuccessor: [] };
  if (s.length < 2) return out;
  const prev = s[s.length - 2], last = s[s.length - 1];
  out.prev = prev.cycle; out.last = last.cycle;
  // 代码审查 10/11：高 / 低档按评级刻度取最高两档、最低两档（缺省 A+ A … C D），不写死
  const sc = Array.isArray(scale) && scale.length >= 4 ? scale : ['A+', 'A', 'B+', 'B', 'C', 'D'];
  const HIGH = new Set(sc.slice(0, 2)), LOW = new Set(sc.slice(-2));
  const prevBy = new Map((prev.items || []).filter(counted).map((i) => [i.userId, i]));
  for (const i of (last.items || []).filter(counted)) {
    const p = prevBy.get(i.userId);
    if (!p) continue;
    const a = ratingOf(p, true), b = ratingOf(i, true);
    if (!a || !b) continue;
    const row = { ...i, prevRating: a, lastRating: b };
    const sa = scoreOf(a, scale), sb = scoreOf(b, scale);
    if (sa != null && sb != null && Math.abs(sa - sb) >= STABILITY_GAP) out.unstable.push(row);
    if (LOW.has(a) && LOW.has(b)) out.lowTwice.push(row);
    if (HIGH.has(a) && HIGH.has(b)) {
      out.highTwice.push(row);
      if (i.flight) out.highFlight.push(row);
      if (i.successor) out.highSuccessor.push(row);
    }
  }
  // 有没有人才发展读权限：服务端在周期明细里给 talentFlags；老数据没有这个键时再按条目推断
  out.flagsKnown = last.talentFlags === true || (last.talentFlags === undefined && (last.items || []).some((i) => i.flight !== undefined));
  return out;
}

// QA 34-1（10/10）：申诉率 = 未撤回的申诉 ÷ 可申诉人数 × 100（与「申诉」KPI 同口径；/stats 的 appealRate 含已撤回，看板不用它）
export function appealRate(liveCount, eligible) {
  return eligible ? Math.round((liveCount / eligible) * 1000) / 10 : null;
}
