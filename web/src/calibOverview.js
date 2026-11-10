// 绩效看板第二期（负责人 2026-10-10 开工）：HoD「部门校准概览」的计算。放在员工端「绩效评估 › 部门校准」页顶部。
// 纯函数、无 import（test/perf-dashboard-phase23.test.js 用 vm 跑）。输入是 DeptCalibration 已有的行（view.rows 套上草稿后的 applied），
// 所以概览随 HoD 未保存的调整即时变化，与下方名单同一份数据。字段见 deptcal.js 文件头。
//
//   unitOf(row, names)                  子部门：一级部门之下的第一级。服务端给部门校准行的 deptPath 已去掉一级部门本身
//                                       （server.js reviewCalibView），所以取 deptPath[0]；deptPath 为空 = 直接挂在一级部门 =「本部门直属」
//   progressBy(rows, keyOf, labelOf, annual)   按子部门 / 直属上级：人数、自评、面谈双方确认、上级评级、逾期（不计入的人不算）
//   distBy(rows, keyOf, labelOf)        按子部门：各档人数（生效评级，C、D 合并为 C/D）
//   leniencyRows(rows, scale, minN)     上级评分尺度：每位上级给出评级的平均档位 − 本部门平均（只给 HoD 看）
//   adjustSummary(rows, scale)          本次校准：调整了几人、上调几人、下调几人、理由摘要（不含代评）

export const LENIENCY_MIN = 3;
export const LENIENCY_FLAG = 0.5;
export const TIERS = ['A+', 'A', 'B+', 'B', 'C/D'];
export const DIRECT = '__direct';
export const NO_MANAGER = '__nomgr';

const counted = (r) => !!r && !r.notCounted;
const effective = (r) => (r ? r.finalRating || r.managerRating || null : null);
const bucketOf = (v) => (v === 'C' || v === 'D' ? 'C/D' : v || null);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const proxied = (r) => !!(r && r.hodProxy);
export function scoreOf(rating, scale) {
  const sc = Array.isArray(scale) && scale.length ? scale : ['A+', 'A', 'B+', 'B', 'C', 'D'];
  const k = sc.indexOf(rating);
  return k < 0 ? null : sc.length - k;
}

export function unitOf(row, names) {
  const p = row && Array.isArray(row.deptPath) ? row.deptPath : [];
  if (p.length >= 1) return { key: p[0], label: (names && names.get(p[0])) || null };
  return { key: DIRECT, label: null };
}
export const byUnit = (names) => (r) => unitOf(r, names).key;
export const unitLabel = (names) => (r) => unitOf(r, names).label;
export const byManager = (r) => r.managerId || NO_MANAGER;
export const managerLabel = (r) => r.manager || null;

function groups(rows, keyOf, labelOf) {
  const m = new Map();
  for (const r of (rows || []).filter(counted)) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, { key: k, label: labelOf ? labelOf(r) : null, rows: [] });
    m.get(k).rows.push(r);
  }
  return [...m.values()];
}

export function progressBy(rows, keyOf, labelOf, annual) {
  return groups(rows, keyOf, labelOf).map((g) => {
    const n = g.rows.length;
    const self = annual ? [] : g.rows.filter((r) => !!r.selfAt);
    const one = annual ? [] : g.rows.filter((r) => r.oneState === 'both');
    const rated = g.rows.filter((r) => !!(r.managerRating || proxied(r) || (annual && effective(r))));
    const overdue = g.rows.filter((r) => Array.isArray(r.overdue) && r.overdue.length > 0);
    return { key: g.key, label: g.label, n, rows: g.rows, self, one, rated, overdue,
      selfPct: annual ? null : pct(self.length, n), onePct: annual ? null : pct(one.length, n), ratedPct: pct(rated.length, n) };
  }).sort((a, b) => (a.key === DIRECT || a.key === NO_MANAGER) - (b.key === DIRECT || b.key === NO_MANAGER) || b.n - a.n || String(a.label || '').localeCompare(String(b.label || '')));
}

export function distBy(rows, keyOf, labelOf) {
  return groups(rows, keyOf, labelOf).map((g) => {
    const tiers = {};
    let n = 0;
    for (const r of g.rows) {
      const b = bucketOf(effective(r));
      if (!b) continue;
      n++;
      (tiers[b] = tiers[b] || []).push(r);
    }
    return { key: g.key, label: g.label, n, tiers, all: g.rows.length };
  }).filter((g) => g.all > 0).sort((a, b) => (a.key === DIRECT) - (b.key === DIRECT) || b.all - a.all);
}

export function leniencyRows(rows, scale, minN = LENIENCY_MIN) {
  const rated = (rows || []).filter((r) => counted(r) && r.managerRating && !proxied(r) && scoreOf(r.managerRating, scale) != null);
  if (!rated.length) return [];
  const deptAvg = rated.reduce((a, r) => a + scoreOf(r.managerRating, scale), 0) / rated.length;
  const by = new Map();
  for (const r of rated) {
    if (!r.managerId) continue;
    if (!by.has(r.managerId)) by.set(r.managerId, { managerId: r.managerId, manager: r.manager || null, rows: [] });
    by.get(r.managerId).rows.push(r);
  }
  const out = [];
  for (const e of by.values()) {
    if (e.rows.length < minN) continue;
    const avg = e.rows.reduce((a, r) => a + scoreOf(r.managerRating, scale), 0) / e.rows.length;
    const diff = Math.round((avg - deptAvg) * 100) / 100;
    out.push({ ...e, n: e.rows.length, avg: Math.round(avg * 100) / 100, deptAvg: Math.round(deptAvg * 100) / 100, diff,
      flag: diff >= LENIENCY_FLAG ? 'lenient' : diff <= -LENIENCY_FLAG ? 'strict' : null });
  }
  return out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

export function adjustSummary(rows, scale) {
  const adjusted = [], up = [], down = [];
  for (const r of (rows || []).filter(counted)) {
    if (proxied(r) || !r.managerRating || !r.finalRating || r.finalRating === r.managerRating) continue;
    adjusted.push(r);
    const a = scoreOf(r.managerRating, scale), b = scoreOf(r.finalRating, scale);
    if (a != null && b != null) (b > a ? up : down).push(r);
  }
  const reasons = adjusted.filter((r) => String(r.hodText || '').trim()).map((r) => ({ id: r.id, name: r.name, from: r.managerRating, to: r.finalRating, text: String(r.hodText).trim() }));
  const proxies = (rows || []).filter((r) => counted(r) && proxied(r));
  return { adjusted, up, down, reasons, proxies };
}
