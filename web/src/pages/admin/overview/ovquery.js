// 培训概览（第三批 4.1 / 4.2，2026-10-08）：地址栏筛选 ⇄ 接口查询串、环比文案、热力分档等纯函数。
// 不 import 任何东西（test/overview-ui-b3.test.js 用 vm 直接跑）。所有窗口日期由服务端算好返回，这里只做展示。

// 看板筛选键（顺序 = 查询串里的顺序，稳定，便于缓存与比对）
// 第四批 7：src 来源（all | assigned 指派 | self 自主学习），缺省 all、不进查询串
export const FILTER_KEYS = ['period', 'from', 'to', 'dept', 'cat', 'enroll', 'mode', 'tp', 'programs', 'cohort', 'src'];
// 名单整页的键（离开名单时一并删除；看板筛选不受影响）
export const LIST_KEYS = ['list', 'ldept', 'lcat', 'lprog', 'lenroll', 'lst', 'lq', 'lp', 'lsort'];
// 名单口径覆盖键：各自只替换同名的看板筛选，且只用于名单请求
export const OVERRIDE_KEYS = ['ldept', 'lcat', 'lprog', 'lenroll'];
export const PERIODS = ['all', 'month', 'quarter', 'year', 'custom'];
export const METRICS = ['assigned', 'done', 'notdone', 'overdue', 'dueSoon', 'covered', 'uncovered', 'attempts'];
export const LIST_STATUS = ['done', 'notdone', 'overdue', 'notstarted', 'inprog'];
export const COHORTS = ['all', 'probation', 'new30'];
export const SOURCES = ['all', 'assigned', 'self'];
export const UNIT_OF = { covered: 'person', uncovered: 'person', attempts: 'attempt' };
export const unitOf = (metric) => UNIT_OF[metric] || 'cell';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

// "a,b,,c" → ['a','b','c']（去重、去空）
export function splitList(v) {
  const out = [];
  for (const x of str(v).split(',')) { const t = x.trim(); if (t && !out.includes(t)) out.push(t); }
  return out;
}
export const joinIds = (arr) => (Array.isArray(arr) && arr.length ? arr.join(',') : null);

// 地址栏参数 → 规范化的筛选对象（period 缺省 = 本季度；自定义缺日期时退回本季度）
export function filtersFromParams(p) {
  const q = p || {};
  let period = PERIODS.includes(q.period) ? q.period : 'quarter';
  let from = DAY_RE.test(str(q.from)) ? str(q.from) : null;
  let to = DAY_RE.test(str(q.to)) ? str(q.to) : null;
  if (period === 'custom') {
    if (!from || !to) period = 'quarter';
    else if (from > to) { const t = from; from = to; to = t; }
  }
  if (period !== 'custom') { from = null; to = null; }
  return {
    period, from, to,
    dept: str(q.dept) || null,
    cat: splitList(q.cat),
    enroll: ['mandatory', 'elective'].includes(q.enroll) ? q.enroll : '',
    mode: ['online', 'offline'].includes(q.mode) ? q.mode : '',
    tp: str(q.tp) || null,
    programs: splitList(q.programs),
    cohort: COHORTS.includes(q.cohort) ? q.cohort : 'all',
    src: SOURCES.includes(q.src) ? q.src : 'all',
  };
}

// 生效的看板筛选个数（「筛选 · n」按钮；时间不算，时间在按钮外单独显示）
export function activeFilterCount(f) {
  let n = 0;
  if (f.dept) n++;
  if (f.cat.length) n++;
  if (f.enroll) n++;
  if (f.mode) n++;
  if (f.tp) n++;
  if (f.programs.length) n++;
  if (f.cohort && f.cohort !== 'all') n++;
  if (f.src && f.src !== 'all') n++;
  return n;
}

// 筛选对象 + 覆盖项 → 查询串（不带「?」）。键顺序固定：先 FILTER_KEYS，再 overrides 按传入顺序。
// period 总是带上（接口缺省是 all，界面缺省是本季度）；cohort=all、src=all、空数组、空串都省略。
export function queryOf(filters, overrides) {
  const f = filters || {};
  const parts = [];
  const put = (k, v) => {
    if (v === null || v === undefined || v === '' || v === false) return;
    if (Array.isArray(v)) { if (!v.length) return; v = v.join(','); }
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  };
  for (const k of FILTER_KEYS) {
    if (k === 'cohort' && f.cohort === 'all') continue;
    if (k === 'src' && (!f.src || f.src === 'all')) continue;
    if ((k === 'from' || k === 'to') && f.period !== 'custom') continue;
    put(k, f[k]);
  }
  for (const [k, v] of Object.entries(overrides || {})) put(k, v);
  return parts.join('&');
}

// 名单请求的请求体（提醒接口用；与 queryOf 同一组键）
export function bodyOf(filters, overrides) {
  const out = {};
  const qs = queryOf(filters, overrides);
  if (!qs) return out;
  for (const kv of qs.split('&')) {
    const i = kv.indexOf('=');
    out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
  }
  return out;
}

// 地址栏里名单的口径覆盖 → 接口参数（l* → 同名覆盖，lst → status，lq → q，lp → page，lsort → sort）
export function listParamsOf(p) {
  const q = p || {};
  const metric = METRICS.includes(q.list) ? q.list : 'assigned';
  const o = { metric };
  for (const k of OVERRIDE_KEYS) if (str(q[k])) o[k] = str(q[k]);
  if (metric === 'assigned' && LIST_STATUS.includes(q.lst)) o.status = q.lst;
  if (str(q.lq)) o.q = str(q.lq).slice(0, 50);
  if (str(q.lsort)) o.sort = str(q.lsort);
  const page = parseInt(q.lp, 10);
  if (page > 1) o.page = page;
  return o;
}

// 数字展示（千分位固定 en-US，中英一致）
export const fmtN = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));
// 一位小数（rate / hours）；整数时不带 .0
export function fmt1(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const r = Math.round(Number(v) * 10) / 10;
  return Number.isInteger(r) ? r.toLocaleString('en-US') : r.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// 指标的「好」的方向：逾期人数下降为好，其余上升为好
export const GOOD_UP = { coverage: true, hoursPerHead: true, requiredCompletion: true, overduePeople: false, passRate: true };

// 环比：kpi = { delta }，kind = 'rate' | 'hours' | 'count'，key = 指标键（决定好坏方向）。
// 返回 { dir: 'up'|'down'|'flat'|null, good: true|false|null, abs: '7.0' }；delta 为 null → dir null（上期无数据）
export function fmtDelta(kpi, kind, key) {
  const d = kpi && kpi.delta;
  if (d === null || d === undefined || Number.isNaN(Number(d))) return { dir: null, good: null, abs: null };
  const v = Number(d);
  const dir = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const a = Math.abs(v);
  const abs = kind === 'count' ? Math.round(a).toLocaleString('en-US') : (Math.round(a * 10) / 10).toFixed(1);
  const goodUp = GOOD_UP[key] !== false;
  const good = dir === 'flat' ? null : (dir === 'up') === goodUp;
  return { dir, good, abs };
}

// 完成率分档：0 = <50，1 = 50–69，2 = 70–84，3 = 85–94，4 = ≥95；null = 无指派
export function bucketOf(pct) {
  if (pct === null || pct === undefined || Number.isNaN(Number(pct))) return null;
  const v = Number(pct);
  if (v < 50) return 0;
  if (v < 70) return 1;
  if (v < 85) return 2;
  if (v < 95) return 3;
  return 4;
}

// 指派少于 5 人次的格子只作参考（不上色）
export const SMALL_N = 5;

const PL = {
  zh: { all: '全部时间', month: '本月', quarter: '本季度', year: '本年', custom: '自定义' },
  en: { all: 'All time', month: 'This month', quarter: 'This quarter', year: 'This year', custom: 'Custom' },
};
// 期间的短名（自定义显示日期）
export function periodText(filters, lang) {
  const f = filters || {};
  const L = PL[lang === 'zh' ? 'zh' : 'en'];
  if (f.period === 'custom' && f.from && f.to) return `${f.from} – ${f.to}`;
  return L[f.period] || L.quarter;
}

// "2026-10-14" → 「10月14日」/ "Oct 14"
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtMD(iso, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(iso));
  if (!m) return '—';
  return lang === 'zh' ? `${+m[2]}月${+m[3]}日` : `${MON[+m[2] - 1]} ${+m[3]}`;
}
// ISO 时间 → 本地 "YYYY-MM-DD"（日期列）；已是 YYYY-MM-DD 的原样
export function fmtDay(iso) {
  const s = str(iso);
  if (!s) return '—';
  if (DAY_RE.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// 搜索最少字符：含中日韩字符时 1 个，否则 2 个
export function searchReady(q) {
  const t = str(q).replace(/\s+/g, ' ');
  if (!t) return false;
  if (/[぀-ヿ㐀-鿿가-힯]/.test(t)) return true;
  return t.length >= 2;
}

// 热力表行排序：risk = 逾期人数降序 → 完成率升序 → 指派降序；rate = 完成率升序；name = 名称
export function sortHeatRows(rows, mode, overdueOf) {
  const list = (rows || []).slice();
  const od = (r) => (overdueOf ? overdueOf(r) : 0) || 0;
  const rate = (r) => (r.completion === null || r.completion === undefined ? 101 : Number(r.completion));
  if (mode === 'name') list.sort((a, b) => str(a.name).localeCompare(str(b.name)));
  else if (mode === 'rate') list.sort((a, b) => rate(a) - rate(b) || (b.assigned || 0) - (a.assigned || 0));
  else list.sort((a, b) => od(b) - od(a) || rate(a) - rate(b) || (b.assigned || 0) - (a.assigned || 0));
  return list;
}
