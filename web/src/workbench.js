// 12.2 工作台（2026-10-09，b12-design §1.2、§7、§9 组 3）：三层工作台的纯函数。
// 不依赖 React、不发请求，Dashboard.jsx 与 pages/admin/workbench/* 共用，test/workbench-ui.test.js 在 node 里直接 import。
//
//   workbenchLayout(user)              视角（按 /api/me 的 grants 判定，不按角色名）、三层顺序、各块是否可见
//   todoVisible(item, layout)          第一层某条待办在该视角下是否显示（服务端已按授权裁剪，这里只做视角隐藏）
//   severityOrder(items)               待办排序：严重度 → 截止日 → 数量
//   metricKind(key)                    第二层指标键归一（服务端键名的几种写法都认）
//   deltaText(metric, lang)            环比文字与语义方向（按 better 判改善 / 恶化 / 持平）
//   healthCellState(cell, total, cfg)  部门健康度单元格：样本少 / 落后 / 正常 / 无数据
//   mergeCultureDepts(rows, depts)     把 3+3 各一级部门参与人数并进健康度表的行（按 id，对不上按名称）
//   cultureWeek(program, today)        3+3 期次的当前周
//   drillHref(drill) / drillQuery(drill)  名单页地址与名单接口查询串
import { isSuperAdmin, canReadDomain, grantLevel, moduleEnabled, appealDeskVisible } from './rbac.js';

/* ---------------- 视角与可见块 ---------------- */

// 每块所需的可售模块与能力域（b12-design §7.3）。module 为 null = core（开关不隐藏）；culture 模块缺省关闭，只认显式 true。
export const BLOCKS = {
  // 第二层 组织风险
  succession: { layer: 'risk', module: 'talent', domain: 'talent' },
  retention: { layer: 'risk', module: 'talent', domain: 'talent' },
  compliance: { layer: 'risk', module: 'learning', domain: 'learning' },
  reviewOnTime: { layer: 'risk', module: 'performance', domain: 'performance' },
  probation: { layer: 'risk', module: null, domain: 'people' },
  span: { layer: 'risk', module: null, domain: 'people' },
  // 第三层 人才结构与组织效能
  nineBox: { layer: 'structure', module: 'talent', domain: 'talent' },
  perfQuota: { layer: 'structure', module: 'performance', domain: 'performance' },
  pipeline: { layer: 'structure', module: 'talent', domain: 'talent' },
  deptHealth: { layer: 'structure', module: null, domain: 'people' },
  culture: { layer: 'structure', module: 'culture', domain: 'culture' },
};

// 第一层待办的来源（b12-design §6.4 表的「域」列）
const TODO_SOURCES = [
  { module: null, domain: 'people' }, { module: 'performance', domain: 'performance' },
  { module: 'learning', domain: 'learning' }, { module: 'culture', domain: 'culture' },
];

const ORDER = {
  admin: ['todo', 'risk', 'structure'],
  talent: ['todo', 'structure', 'risk'],
  learning: ['todo', 'risk'],
  custom: ['todo', 'risk', 'structure'],
};
// 视角隐藏的能力域（只影响显示顺序与取舍；数据可见性仍以服务端裁剪为准）
const VIEW_HIDES = {
  admin: [],
  talent: ['learning'],
  learning: ['performance', 'talent'],
  custom: [],
};

export function moduleOn(user, module) {
  if (!module) return true;
  return moduleEnabled(user, module);   // culture 缺省关闭由 rbac 的 DEFAULT_OFF 处理
}

/** 视角：管理员（超级管理员或 people=manage）→ 绩效与人才（performance 或 talent 可读）→ 培训（只有 learning 可读）→ 其他。 */
export function workbenchView(user) {
  if (isSuperAdmin(user) || grantLevel(user, 'people') === 'manage') return 'admin';
  if (canReadDomain(user, 'performance') || canReadDomain(user, 'talent')) return 'talent';
  if (canReadDomain(user, 'learning')) return 'learning';
  return 'custom';
}

export function workbenchLayout(user) {
  const view = workbenchView(user);
  const hides = VIEW_HIDES[view];
  const blocks = {};
  for (const [id, b] of Object.entries(BLOCKS)) {
    blocks[id] = moduleOn(user, b.module) && canReadDomain(user, b.domain) && !hides.includes(b.domain)
      && (view !== 'learning' || b.layer !== 'structure');
  }
  // 第一层：任一待办所属的能力域可读（且该视角不隐藏），或可进绩效申诉台（HRBP 分工不是角色，见 rbac.appealDeskVisible）
  blocks.todo = TODO_SOURCES.some((x) => moduleOn(user, x.module) && canReadDomain(user, x.domain) && !hides.includes(x.domain))
    || (moduleOn(user, 'performance') && appealDeskVisible(user) && !hides.includes('performance'));
  const layerHas = (layer) => (layer === 'todo' ? blocks.todo : Object.entries(BLOCKS).some(([id, b]) => b.layer === layer && blocks[id]));
  return { view, order: ORDER[view].filter(layerHas), blocks, hides };
}

/** 第一层某条待办在该视角下是否显示。没有 domain 的条目（外壳类）一律显示。 */
export function todoVisible(item, layout) {
  if (!item) return false;
  const d = item.domain || null;
  return !(d && layout && layout.hides && layout.hides.includes(d));
}

/* ---------------- 第一层 待办排序 ---------------- */

export const SEVERITY_RANK = { overdue: 0, soon: 1, normal: 2 };

export function severityOrder(items) {
  const rank = (s) => (s in SEVERITY_RANK ? SEVERITY_RANK[s] : 3);
  return [...(items || [])].sort((a, b) => rank(a.severity) - rank(b.severity)
    || (a.dueOn ? (b.dueOn ? String(a.dueOn).localeCompare(String(b.dueOn)) : -1) : (b.dueOn ? 1 : 0))
    || (Number(b.count) || 0) - (Number(a.count) || 0));
}

/* ---------------- 第二层 指标 ---------------- */

/** 服务端指标键归一到前端六类（succession / retention / compliance / reviewOnTime / probation / span）。 */
export function metricKind(key) {
  const k = String(key || '');
  if (BLOCKS[k] && BLOCKS[k].layer === 'risk') return k;
  if (/succ/i.test(k)) return 'succession';
  if (/retent|hipo|exit|attrition/i.test(k)) return 'retention';
  if (/compl|required|mandatory/i.test(k)) return 'compliance';
  if (/review|ontime|on_time/i.test(k)) return 'reviewOnTime';
  if (/probation|regular/i.test(k)) return 'probation';
  if (/span/i.test(k)) return 'span';
  return null;
}

const round1 = (n) => Math.round(n * 10) / 10;
const signed = (n, unit) => (n > 0 ? '+' : n < 0 ? '−' : '') + (unit === 'pct' ? Math.abs(n).toFixed(1) : String(Math.abs(n)));

const T = {
  zh: {
    quarter: '较上季度', cycle: '较上一周期', pp: ' 个百分点', people: ' 人',
    flatQuarter: '与上季度持平', flatCycle: '与上一周期持平',
    noPrev: '上期暂无数据', noPrevSince: (since) => `上期暂无数据（自 ${since} 起留存）`,
  },
  en: {
    quarter: 'vs last quarter', cycle: 'vs previous cycle', pp: ' pp', people: '',
    flatQuarter: 'Unchanged from last quarter', flatCycle: 'Unchanged from previous cycle',
    noPrev: 'No prior-period data', noPrevSince: (since) => `No prior-period data (retained from ${since})`,
  },
};

/**
 * 环比文字与语义：{ text, tone: 'better' | 'worse' | 'flat' | 'none', dir: 'up' | 'down' | 'flat' | null }。
 * 比率（unit pct）给百分点差，计数给人数差；prev 为 null 时「上期暂无数据」，不显示 0。
 * 评估按时率按评估周期比较（basis cycle），其余按自然季度。
 */
export function deltaText(metric, lang) {
  const s = T[lang] || T.en;
  const m = metric || {};
  if (m.prev === null || m.prev === undefined || !Number.isFinite(Number(m.prev)) || !Number.isFinite(Number(m.value))) {
    const since = m.snapshotSince || (m.period && m.period.snapshotSince);
    return { text: since ? s.noPrevSince(since) : s.noPrev, tone: 'none', dir: null };
  }
  const pct = m.unit === 'pct';
  const raw = Number.isFinite(Number(m.delta)) ? Number(m.delta) : Number(m.value) - Number(m.prev);
  const d = pct ? round1(raw) : Math.round(raw);
  const cycle = metricKind(m.key) === 'reviewOnTime' || m.basis === 'cycle';
  if (d === 0) return { text: cycle ? s.flatCycle : s.flatQuarter, tone: 'flat', dir: 'flat' };
  const dir = d > 0 ? 'up' : 'down';
  const better = m.better === 'down' ? 'down' : 'up';
  const unit = pct ? s.pp : s.people;
  const lead = cycle ? s.cycle : s.quarter;
  const text = lang === 'zh' ? `${lead} ${signed(d, m.unit)}${unit}` : `${signed(d, m.unit)}${unit} ${lead}`;
  return { text, tone: dir === better ? 'better' : 'worse', dir };
}

/* ---------------- 第三层 部门健康度 ---------------- */

export const HEALTH_DEFAULTS = { lagPp: 10, minDeptHeadcount: 5 };
// 只展示、不标落后的列（b12-design §3.4）
export const HEALTH_NO_MARK = ['headcount', 'probation', 'hipo'];

/** 单元格取值：服务端可能给数字，也可能给 { value, num, den }；行上可能是 row.cells[col]，也可能是 row[col]。 */
export function cellOf(row, col) {
  if (!row) return { value: null };
  const raw = row.cells && col in row.cells ? row.cells[col] : row[col];
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw === 'object') return { value: Number.isFinite(Number(raw.value)) && raw.value !== null ? Number(raw.value) : null, num: raw.num, den: raw.den };
  return { value: Number.isFinite(Number(raw)) ? Number(raw) : null };
}

/**
 * 健康度单元格状态：'small'（在职 < 5 人，不给比率、不标落后）| 'empty'（无数据）| 'lag'（低于合计 ≥ lagPp 个百分点）| 'ok'。
 * cell = { value, headcount }；total = 合计行同列 { value }；cfg = { lagPp, minDeptHeadcount, mark }（mark=false：只展示的列）。
 */
export function healthCellState(cell, total, cfg) {
  const c = Object.assign({}, HEALTH_DEFAULTS, cfg || {});
  const hc = cell && Number(cell.headcount);
  if (Number.isFinite(hc) && hc < c.minDeptHeadcount) return 'small';
  const v = cell ? cell.value : null;
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return 'empty';
  if (c.mark === false) return 'ok';
  const t = total ? total.value : null;
  if (t === null || t === undefined || !Number.isFinite(Number(t))) return 'ok';
  return Number(t) - Number(v) >= c.lagPp - 1e-9 ? 'lag' : 'ok';
}

const headcountOf = (row) => {
  const h = cellOf(row, 'headcount').value;
  return Number.isFinite(h) ? h : (Number.isFinite(Number(row && row.headcount)) ? Number(row.headcount) : null);
};

/** 一行的落后项数（可标记的比率列）。 */
export function lagCount(row, columns, total, cfg) {
  let n = 0;
  for (const col of columns || []) {
    if (HEALTH_NO_MARK.includes(col)) continue;
    const st = healthCellState({ ...cellOf(row, col), headcount: headcountOf(row) }, cellOf(total, col), cfg);
    if (st === 'lag') n++;
  }
  return n;
}

/** 缺省排序：落后项数降序，再按在职人数降序；给了 sortKey 时按该列（无数据的排最后）。 */
export function sortHealthRows(rows, columns, total, cfg, sortKey, dir) {
  const list = [...(rows || [])];
  if (!sortKey) {
    return list.sort((a, b) => lagCount(b, columns, total, cfg) - lagCount(a, columns, total, cfg) || (headcountOf(b) || 0) - (headcountOf(a) || 0));
  }
  const sign = dir === 'asc' ? 1 : -1;
  const val = (r) => (sortKey === 'name' ? String(r.deptName || r.name || '') : cellOf(r, sortKey).value);
  return list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (sortKey === 'name') return sign * x.localeCompare(y);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y);
  });
}

const normName = (s) => String(s || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * 3+3 参与率并进健康度表：cultureDepts = GET /api/v1/culture/depts 的 items（{ id, name, memberCount, participantCount }）。
 * 按一级部门 id 合并，id 对不上时按名称；结果写在 row.cells.culture = { value（百分数）, num, den }，合不上的为 null。
 */
export function mergeCultureDepts(rows, cultureDepts) {
  const byId = new Map(), byName = new Map();
  for (const d of cultureDepts || []) {
    if (!d) continue;
    if (d.id != null) byId.set(String(d.id), d);
    if (d.name) byName.set(normName(d.name), d);
  }
  return (rows || []).map((r) => {
    const id = r.deptId != null ? r.deptId : r.id;
    const d = (id != null && byId.get(String(id))) || byName.get(normName(r.deptName || r.name)) || null;
    const den = d ? Number(d.memberCount) || 0 : 0;
    const num = d ? Number(d.participantCount) || 0 : 0;
    const culture = d && den > 0 ? { value: round1((num / den) * 100), num, den } : null;
    return { ...r, cells: { ...(r.cells || {}), culture } };
  });
}

/** 3+3 合计：各部门参与人数与人数之和。 */
export function cultureTotal(cultureDepts) {
  let num = 0, den = 0;
  for (const d of cultureDepts || []) { num += Number(d && d.participantCount) || 0; den += Number(d && d.memberCount) || 0; }
  return den > 0 ? { value: round1((num / den) * 100), num, den } : null;
}

/* ---------------- 第三层 九宫格与配额 ---------------- */

/** 九宫格某格人数：cells 可为 3×3 数组 cells[绩效档][潜力档]（0 低 … 2 高），也可为 { "绩效-潜力": n } 对象。 */
export function nineBoxCount(cells, perf, pot) {
  if (!cells) return 0;
  const v = Array.isArray(cells) ? (cells[perf] || [])[pot] : cells[`${perf}-${pot}`];
  return Number(v) || 0;
}

const CAPPED_BANDS = ['A+', 'A', 'B+'];
/** 配额偏离：A+ / A / B+ 中「实际占比 − 配额占比」> 0 的最大一档；small（人数不足）或都未超配为 null。 */
export function quotaOverage(dept) {
  if (!dept || dept.small) return null;
  let best = null;
  for (const b of CAPPED_BANDS) {
    const x = dept.bands && dept.bands[b];
    if (!x) continue;
    const pp = Math.round((Number(x.actual) - Number(x.quota)) * 10) / 10;
    if (Number.isFinite(pp) && pp > 0 && (!best || pp > best.pp)) best = { band: b, pp };
  }
  return best;
}

/* ---------------- 3+3 ---------------- */

/** 期次的当前周（1…weeks）：开始日前为 null，结束后为最后一周。today = 'YYYY-MM-DD'。 */
export function cultureWeek(program, today) {
  if (!program || !program.startDate || !(Number(program.weeks) > 0)) return null;
  const a = Date.UTC(...program.startDate.slice(0, 10).split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)));
  const b = Date.UTC(...String(today).slice(0, 10).split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.min(Number(program.weeks), Math.floor((b - a) / (7 * 86400000)) + 1);
}

/** 3+3 部门排名：只列参与人数 ≥ minN 的一级部门，按参与覆盖率降序（rate 为 0–1 的比例）。 */
export function rankCultureDepts(coverage, minN = 5) {
  return (coverage || []).filter((c) => c && Number(c.headcount) >= minN)
    .sort((a, b) => (Number(b.rate) || 0) - (Number(a.rate) || 0) || String(a.dept1 || '').localeCompare(String(b.dept1 || '')));
}

/* ---------------- 名单 ---------------- */

const DRILL_KEYS = ['metric', 'dept', 'cell', 'stage', 'period'];

/** 名单参数：服务端 drill 可能是 metric 字符串，也可能是 { metric, dept, cell, stage, period }。 */
export function drillParams(drill) {
  if (!drill) return null;
  const o = typeof drill === 'string' ? { metric: drill } : drill;
  if (!o.metric) return null;
  const out = {};
  for (const k of DRILL_KEYS) if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = String(o[k]);
  return out;
}

/** GET /api/admin/workbench/people 的查询串。 */
export function drillQuery(drill) {
  const p = drillParams(drill);
  if (!p) return '';
  return DRILL_KEYS.filter((k) => k in p).map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&');
}

/** 名单整页地址（工作台路由 /admin 下以 ?list= 打开，返回即回到工作台）；to = 「去处理」的站内页面。 */
export function drillHref(drill, to) {
  const p = drillParams(drill);
  if (!p) return null;
  const q = [`list=${encodeURIComponent(p.metric)}`];
  for (const k of DRILL_KEYS) if (k !== 'metric' && k in p) q.push(`${k}=${encodeURIComponent(p[k])}`);
  if (safeAdminLink(to)) q.push(`to=${encodeURIComponent(to)}`);
  return `/admin?${q.join('&')}`;
}

/** 名单页 URLSearchParams → 名单参数（list 即 metric）。 */
export function drillFromSearch(search) {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search;
  if (!sp || !sp.get('list')) return null;
  const o = { metric: sp.get('list') };
  for (const k of DRILL_KEYS) if (k !== 'metric' && sp.get(k)) o[k] = sp.get(k);
  return o;
}

/** 只放行站内后台路径（「去处理」链接来自服务端或地址栏，不能变成任意跳转）。 */
export function safeAdminLink(to) {
  return typeof to === 'string' && /^\/admin(\/|\?|$)/.test(to) && !/^\/\//.test(to) ? to : null;
}

/* ---------------- 折叠状态 ---------------- */

const FOLD_KEY = 'tms-workbench-folded';
export function readFolded() {
  try { const v = JSON.parse(window.localStorage.getItem(FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export function writeFolded(v) {
  try { window.localStorage.setItem(FOLD_KEY, JSON.stringify(v || {})); } catch { /* 隐私模式等读写失败时按展开 */ }
}
