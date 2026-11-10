// 人才筛选的前端纯函数（第五批 8.1，2026-10-08）：TalentFilter.jsx、TalentReview.jsx 与 test/talent-filter-ui.test.js 共用。
// 无 import、无 JSX、不读写网络；localStorage 由调用方传进来（读写都包 try/catch）。
//
// 条件的形状与服务端 modules/talent/filter-model.js 相同（设计第 2.1 节）：
//   { v:1, logic:'and'|'or', items:[leaf | group], includeExited?:bool }
//   group = { logic, items:[leaf] }（最多两层）；leaf = { id:'c1', field, op, value?, params?, tag? }
// 字段目录（GET /api/admin/talent-filters/catalog → catalog.fields）每项：
//   { id, group, label, label_zh, ops:[{op,label,label_zh}], valueKind, options?:[{value,label,label_zh}], params?, module, available, reason? }
// valueKind 决定值控件（valueControl）：dept 部门 · level 职级 · enum 选项 · rating 评级 · user 人员 · program 培养项目
//   · tag 人才标签 · text 文本 · number 数字 · percent 百分比 · months 月数 · count 次数 · date 日期 · bool 是非（无值）· record 档案记录
// 本页只负责「能编辑、能读懂」；合法性以服务端 validateFilter 为准（AI 生成的条件同样过它）。

export const NOVALUE_OPS = ['isTrue', 'isFalse', 'isEmpty', 'notEmpty', 'exists', 'notExists', 'none', 'noRecord', 'listed', 'notListed'];
export const MULTI_OPS = ['in', 'notIn', 'anyOf', 'allOf', 'noneOf'];
export const MAX_ROOT_ITEMS = 20;
export const MAX_GROUP_ITEMS = 12;
export const MAX_LEAVES = 30;
export const PAGE_SIZE = 50;
export const PAGE_SIZES = [20, 50, 100, 200];
export const IDS_CAP = 200;
export const NOTE_MAX = 300;
export const AI_TEXT_MAX = 500;
// 默认列（设计 6.1）：姓名、工号、部门、职级、最近评级、潜力、司龄
export const DEFAULT_COLUMNS = ['name', 'employeeId', 'department', 'jobLevel', 'latestRating', 'potential', 'tenure'];
// 姓名列不能去掉（结果行靠它识别、跳转档案）
export const LOCKED_COLUMNS = ['name'];
export const DRAFT_KEY = 'tms.talentFilter.draft.v1';
// 列 → 取选项文字的字段（列值是规范值，按当前语言显示，options_zh 按下标对应）
// F61：已停用的内置字段（「管理者 / 个人贡献者」并入职级通道）。目录里没有它们；已保存筛选里改写不了的叶子原样保留，
// 服务端警告 field_retired、运行时忽略，编辑器与摘要提示「该条件已停用，请改用岗位序列」。
export const RETIRED_FIELDS = ['isManager'];
export const isRetiredField = (id) => RETIRED_FIELDS.includes(String(id === null || id === undefined ? '' : id));
// F60：人才盘点顶部筛选（页面人群范围）的地址栏键，与服务端 modules/talent/review-scope.js SCOPE_KEYS 相同。
// 人才筛选整页从人才盘点打开时带着这些键，查询、选择全部结果、导出与批量操作都把它们作为 scope 发给服务端（结果 = 范围 ∩ 条件）。
export const SCOPE_KEYS = ['dept', 'band', 'track', 'mgr', 'tenure', 'estatus', 'pot'];
// URLSearchParams | 普通对象 → 只含非空范围键的对象
export function scopeOf(params) {
  const get = (k) => (params && typeof params.get === 'function' ? params.get(k) : params ? params[k] : null);
  const out = {};
  for (const k of SCOPE_KEYS) { const v = get(k); if (v !== null && v !== undefined && String(v).trim()) out[k] = String(v); }
  return out;
}
export const scopeActive = (scope) => !!scope && SCOPE_KEYS.some((k) => !!scope[k]);
// 范围对象 → 查询串（不带「?」）；没有范围 = ''
export function scopeQuery(scope) {
  const q = new URLSearchParams();
  for (const k of SCOPE_KEYS) if (scope && scope[k]) q.set(k, String(scope[k]));
  return q.toString();
}
// 路径追加查询串（已有「?」时用「&」）
export function withQuery(path, ...parts) {
  const q = parts.filter(Boolean).join('&');
  return q ? `${path}${String(path).includes('?') ? '&' : '?'}${q}` : path;
}
const COLUMN_FIELD = { latestRating: 'perfRecent', recentRatings: 'perfRecent', potential: 'potential', empStatus: 'empStatus', nineBox: 'nineBox', jobTrack: 'jobTrack', jobGrade: 'jobGrade', talentTags: 'talentTag' };

const T = {
  zh: {
    all: '满足全部：', any: '满足任一：', and: ' 且 ', or: ' 或 ', sep: ' · ', listSep: '、', colon: '：',
    empty: '未设条件：列出数据范围内的全部在职员工', exited: '含已离职员工', unset: '（待填写）',
    more: (n) => `等 ${n} 项`, yes: '是', no: '否', inclSub: '（含下级）', notIn: '不属于', range: (a, b) => `${a}–${b}`,
    dept: (v) => `部门 ${v}（含下级）`, deptNot: (v) => `部门不属于 ${v}（含下级）`,
    perfAtLeast: (n, mode, k, v) => (n <= 1 ? `最近一期绩效不低于 ${v}` : mode === 'any' ? `近 ${n} 期绩效任一期不低于 ${v}` : mode === 'atLeastK' ? `近 ${n} 期绩效至少 ${k} 期不低于 ${v}` : `近 ${n} 期绩效均不低于 ${v}`),
    perfAtMost: (n, mode, k, v) => (n <= 1 ? `最近一期绩效不高于 ${v}` : mode === 'any' ? `近 ${n} 期绩效任一期不高于 ${v}` : mode === 'atLeastK' ? `近 ${n} 期绩效至少 ${k} 期不高于 ${v}` : `近 ${n} 期绩效均不高于 ${v}`),
    perfIn: (n, v) => (n <= 1 ? `最近一期绩效为 ${v}` : `近 ${n} 期绩效均为 ${v}`),
    perfNone: '没有绩效记录',
    period: { quarter: '（按季度）', half: '（按半年）', annual: '（按年度）' },
    missIgnore: '（不足期数按已有期数计算）',
    // F62：按月份时间窗（窗内全部记录）
    perfWindow: (m, mode, k, v, atMost) => `近 ${m} 个月内绩效${mode === 'any' ? '任一期' : mode === 'atLeastK' ? `至少 ${k} 期` : '各期均'}${atMost ? '不高于' : '不低于'} ${v}`,
    perfWindowIn: (m, v) => `近 ${m} 个月内绩效属于 ${v}`, missWinIgnore: '（无评级视为满足）',
    tenureGte: (n) => `司龄不少于 ${n} 个月`, tenureLte: (n) => `司龄不超过 ${n} 个月`, tenureBetween: (a, b) => `司龄 ${a}–${b} 个月`,
    levelTenureGte: (n) => `现职级任职不少于 ${n} 个月`, levelTenureLte: (n) => `现职级任职不超过 ${n} 个月`, levelTenureBetween: (a, b) => `现职级任职 ${a}–${b} 个月`,
    vioNone: (m, sev) => `${m > 0 ? `近 ${m} 个月` : ''}无${sev ? sev : ''}违纪记录`,
    vioCount: (m, sev, n) => `${m > 0 ? `近 ${m} 个月` : ''}${sev ? sev : ''}违纪记录至少 ${n} 条`,
    sevMajor: '重大', sevMinor: '轻微',
    awardNone: (m) => `${m > 0 ? `近 ${m} 个月` : ''}没有获奖记录`,
    awardCount: (m, n) => `${m > 0 ? `近 ${m} 个月` : ''}获奖至少 ${n} 次`,
    mandDone: '必修课程全部完成', mandNot: '必修课程未全部完成',
    compGte: (p, sc) => `培训完成率不低于 ${p}%${sc === 'all' ? '（全部指派）' : '（必修）'}`,
    compLte: (p, sc) => `培训完成率不高于 ${p}%${sc === 'all' ? '（全部指派）' : '（必修）'}`,
    recExists: (t, m) => `${m > 0 ? `近 ${m} 个月` : ''}有「${t}」记录`,
    recNot: (t, m) => `${m > 0 ? `近 ${m} 个月` : ''}没有「${t}」记录`,
    recCount: (t, m, n) => `${m > 0 ? `近 ${m} 个月` : ''}「${t}」记录至少 ${n} 条`,
    succListed: (p) => `已列入继任计划${p ? `（岗位 ${p}）` : ''}`, succNot: (p) => `未列入继任计划${p ? `（岗位 ${p}）` : ''}`,
    nextYes: '有下一职级', nextNo: '已到顶（没有下一职级）', retired: '管理者 / 个人贡献者（该条件已停用，请改用岗位序列）',
    freshOnly: '（12 个月内评定）',
  },
  en: {
    all: 'Match all: ', any: 'Match any: ', and: ' and ', or: ' or ', sep: ' · ', listSep: ', ', colon: ': ',
    empty: 'No conditions: everyone active in your data scope', exited: 'including separated employees', unset: ' (to be completed)',
    more: (n) => `${n} in total`, yes: 'yes', no: 'no', inclSub: ' (incl. sub-departments)', notIn: 'not', range: (a, b) => `${a}–${b}`,
    dept: (v) => `Department ${v} (incl. sub-departments)`, deptNot: (v) => `Department not ${v} (incl. sub-departments)`,
    perfAtLeast: (n, mode, k, v) => (n <= 1 ? `Latest rating ${v} or above` : mode === 'any' ? `At least one of the last ${n} ratings ${v} or above` : mode === 'atLeastK' ? `At least ${k} of the last ${n} ratings ${v} or above` : `Last ${n} ratings all ${v} or above`),
    perfAtMost: (n, mode, k, v) => (n <= 1 ? `Latest rating ${v} or below` : mode === 'any' ? `At least one of the last ${n} ratings ${v} or below` : mode === 'atLeastK' ? `At least ${k} of the last ${n} ratings ${v} or below` : `Last ${n} ratings all ${v} or below`),
    perfIn: (n, v) => (n <= 1 ? `Latest rating is ${v}` : `Last ${n} ratings all ${v}`),
    perfNone: 'No performance rating on file',
    period: { quarter: ' (quarterly)', half: ' (half-yearly)', annual: ' (annual)' },
    missIgnore: ' (fewer periods count as they are)',
    // F62: look-back window in months (every rating inside the window)
    perfWindow: (m, mode, k, v, atMost) => `${mode === 'any' ? 'At least one rating' : mode === 'atLeastK' ? `At least ${k} ratings` : 'Every rating'} in the last ${m} months ${v} or ${atMost ? 'below' : 'above'}`,
    perfWindowIn: (m, v) => `Ratings in the last ${m} months are any of ${v}`, missWinIgnore: ' (no rating counts as met)',
    tenureGte: (n) => `Tenure at least ${n} months`, tenureLte: (n) => `Tenure at most ${n} months`, tenureBetween: (a, b) => `Tenure ${a}–${b} months`,
    levelTenureGte: (n) => `Time in current level at least ${n} months`, levelTenureLte: (n) => `Time in current level at most ${n} months`, levelTenureBetween: (a, b) => `Time in current level ${a}–${b} months`,
    vioNone: (m, sev) => `No ${sev ? sev + ' ' : ''}disciplinary record${m > 0 ? ` in the last ${m} months` : ''}`,
    vioCount: (m, sev, n) => `At least ${n} ${sev ? sev + ' ' : ''}disciplinary record${n === 1 ? '' : 's'}${m > 0 ? ` in the last ${m} months` : ''}`,
    sevMajor: 'major', sevMinor: 'minor',
    awardNone: (m) => `No award${m > 0 ? ` in the last ${m} months` : ''}`,
    awardCount: (m, n) => `At least ${n} award${n === 1 ? '' : 's'}${m > 0 ? ` in the last ${m} months` : ''}`,
    mandDone: 'All required courses completed', mandNot: 'Required courses not all completed',
    compGte: (p, sc) => `Training completion at least ${p}%${sc === 'all' ? ' (all assignments)' : ' (required)'}`,
    compLte: (p, sc) => `Training completion at most ${p}%${sc === 'all' ? ' (all assignments)' : ' (required)'}`,
    recExists: (t, m) => `Has a "${t}" record${m > 0 ? ` in the last ${m} months` : ''}`,
    recNot: (t, m) => `No "${t}" record${m > 0 ? ` in the last ${m} months` : ''}`,
    recCount: (t, m, n) => `At least ${n} "${t}" record${n === 1 ? '' : 's'}${m > 0 ? ` in the last ${m} months` : ''}`,
    succListed: (p) => `On a succession plan${p ? ` (${p})` : ''}`, succNot: (p) => `Not on a succession plan${p ? ` (${p})` : ''}`,
    nextYes: 'Has a next job level', nextNo: 'At the top level (no next job level)', retired: 'People manager / individual contributor (this condition has been retired; use Track instead)',
    freshOnly: ' (assessed within 12 months)',
  },
};
const dict = (lang) => T[lang === 'zh' ? 'zh' : 'en'];

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const isGroup = (it) => isObj(it) && Array.isArray(it.items) && !('field' in it);

// 目录里取名：中文界面 label_zh 优先，缺了回落英文；英文反之
export function nameOf(x, lang) {
  if (!x) return '';
  return str(lang === 'zh' ? (x.label_zh || x.label) : (x.label || x.label_zh));
}

export function fieldMap(catalog) {
  const m = new Map();
  for (const f of (catalog && Array.isArray(catalog.fields) ? catalog.fields : [])) if (f && f.id) m.set(f.id, f);
  return m;
}
export function fieldOf(catalog, id) {
  return fieldMap(catalog).get(id) || null;
}

// 字段下拉按 group 分组（保留目录顺序）；不可用的字段（模块关闭）带 disabled 与原因
export function groupedFields(catalog, lang) {
  const groups = [];
  const at = new Map();
  for (const f of (catalog && Array.isArray(catalog.fields) ? catalog.fields : [])) {
    if (!f || !f.id) continue;
    const g = str(lang === 'zh' ? (f.group_zh || f.group) : (f.group || f.group_zh)) || '—';
    if (!at.has(g)) { at.set(g, groups.length); groups.push({ label: g, fields: [] }); }
    groups[at.get(g)].fields.push({ value: f.id, label: nameOf(f, lang), disabled: f.available === false, reason: f.reason || null });
  }
  return groups;
}

// ---------- 值控件 ----------
// 返回 { kind, multiple?, min?, max?, allowCreate? }；kind：
//   none 无值 · dept 部门（DeptFilter）· multi 多选 · single 单选 · text 文本 · number 数字
//   · numberRange / levelRange / dateRange 「从…到…」（值为 {from,to}）· date 日期
export function valueControl(field, op) {
  const vk = (field && field.valueKind) || 'enum';
  if (!op || NOVALUE_OPS.includes(op) || vk === 'bool') return { kind: 'none' };
  if (vk === 'dept') return { kind: 'dept', multiple: op !== 'equals' };
  if (op === 'between') {
    if (vk === 'level') return { kind: 'levelRange' };
    if (vk === 'date') return { kind: 'dateRange' };
    return { kind: 'numberRange', ...numBounds(field, op) };
  }
  if (MULTI_OPS.includes(op)) return { kind: 'multi', allowCreate: vk === 'text' || vk === 'tag' };
  if (op === 'atLeast' || op === 'atMost') return { kind: 'single' };
  if (op === 'contains' || op === 'equals') return { kind: 'text', maxLength: 100 };
  if (op === 'onOrAfter' || op === 'onOrBefore') return { kind: 'date' };
  if (op === 'gte' || op === 'lte' || op === 'countAtLeast' || op === 'withinMonths') return { kind: 'number', ...numBounds(field, op) };
  return { kind: 'text', maxLength: 100 };
}
function numBounds(field, op) {
  const vk = field && field.valueKind;
  let b = { min: 0, max: 99999 };
  if (vk === 'percent') b = { min: 0, max: 100 };
  else if (vk === 'months') b = { min: 0, max: 600 };
  if (op === 'countAtLeast') b = { min: 1, max: 999 };
  if (op === 'withinMonths') b = { min: 1, max: 120 };
  if (field && Number.isFinite(field.min)) b.min = field.min;
  if (field && Number.isFinite(field.max)) b.max = field.max;
  return b;
}
export function defaultValue(control) {
  switch (control && control.kind) {
    case 'none': return undefined;
    case 'dept': return control.multiple ? [] : '';
    case 'multi': return [];
    case 'number': return null;
    case 'numberRange': case 'dateRange': case 'levelRange': return { from: null, to: null };
    default: return '';
  }
}
export function isValueFilled(control, v) {
  switch (control && control.kind) {
    case 'none': return true;
    case 'dept': return control.multiple ? Array.isArray(v) && v.length > 0 : !blank(v);
    case 'multi': return Array.isArray(v) && v.length > 0;
    case 'number': return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    case 'numberRange': return isObj(v) && Number.isFinite(Number(v.from)) && Number.isFinite(Number(v.to)) && !blank(v.from) && !blank(v.to);
    case 'dateRange': case 'levelRange': return isObj(v) && !blank(v.from) && !blank(v.to);
    default: return !blank(v);
  }
}

// 各字段参数的缺省值（设计 2.2）；没有参数的字段返回 undefined
export function defaultParams(fieldId) {
  switch (fieldId) {
    case 'perfRecent': return { n: 1, mode: 'all', k: 1, periodKind: 'any', missing: 'fail', withinMonths: 0 };
    case 'potential': return { freshOnly: false };
    case 'trainingCompletion': return { scope: 'mandatory' };
    case 'award': return { months: 0 };
    case 'violation': return { months: 12, severity: [] };
    case 'record': return { type: '', months: 0, fields: {} };
    case 'succession': return {};
    default: return undefined;
  }
}

// ---------- 编辑器状态（全部返回新对象，不改入参） ----------
export function emptyFilter() {
  return { v: 1, logic: 'and', items: [], includeExited: false };
}
function allLeaves(def) {
  const out = [];
  for (const it of (def && def.items) || []) {
    if (isGroup(it)) for (const l of it.items || []) out.push(l);
    else if (it) out.push(it);
  }
  return out;
}
export function countLeaves(def) { return allLeaves(def).length; }
export function nextLeafId(def) {
  const used = new Set(allLeaves(def).map((l) => l && l.id).filter(Boolean));
  for (let n = 1; ; n += 1) { const id = 'c' + n.toString(36); if (!used.has(id)) return id; }
}
// 读进来的定义（库里、AI、localStorage）补齐形状与叶子 id，便于编辑；不删除任何条件
export function normalizeDef(raw) {
  const d = isObj(raw) ? raw : {};
  const out = { v: 1, logic: d.logic === 'or' ? 'or' : 'and', items: [], includeExited: !!d.includeExited };
  const used = new Set();
  const allIds = new Set();
  const fix = (leaf) => {
    const l = { ...leaf };
    if (!l.id || !/^c[0-9a-z]{1,8}$/.test(String(l.id)) || used.has(l.id)) {
      let n = 1;
      while (used.has('c' + n.toString(36)) || allIds.has('c' + n.toString(36))) n += 1;
      l.id = 'c' + n.toString(36);
    }
    used.add(l.id);
    return l;
  };
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (isGroup(it)) {
      for (const l of it.items) { if (l && l.id) allIds.add(l.id); }
    } else if (it && it.id) {
      allIds.add(it.id);
    }
  }
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (!it) continue;
    if (isGroup(it)) out.items.push({ logic: it.logic === 'and' ? 'and' : 'or', items: it.items.filter(Boolean).map(fix) });
    else out.items.push(fix(it));
  }
  return out;
}
export function getAt(def, path) {
  if (!def || !Array.isArray(path) || !path.length) return null;
  const top = (def.items || [])[path[0]];
  if (path.length === 1) return top || null;
  return top && isGroup(top) ? top.items[path[1]] || null : null;
}
function updateAt(def, path, fn) {
  const items = (def.items || []).slice();
  if (path.length === 1) { items[path[0]] = fn(items[path[0]]); return { ...def, items }; }
  const g = items[path[0]];
  if (!isGroup(g)) return def;
  const inner = g.items.slice();
  inner[path[1]] = fn(inner[path[1]]);
  items[path[0]] = { ...g, items: inner };
  return { ...def, items };
}
export function blankLeaf(def) { return { id: nextLeafId(def), field: '', op: '' }; }
// 加一条条件：groupIndex 省略 = 加在根上；超过上限时原样返回
export function addCondition(def, groupIndex) {
  if (countLeaves(def) >= MAX_LEAVES) return def;
  if (groupIndex === undefined || groupIndex === null) {
    if ((def.items || []).length >= MAX_ROOT_ITEMS) return def;
    return { ...def, items: [...(def.items || []), blankLeaf(def)] };
  }
  const g = (def.items || [])[groupIndex];
  if (!isGroup(g) || g.items.length >= MAX_GROUP_ITEMS) return def;
  return updateAt(def, [groupIndex], (x) => ({ ...x, items: [...x.items, blankLeaf(def)] }));
}
// 加一个条件组（带一条空条件）；组内逻辑缺省与根相反，「(A 且 B) 或 C」「A 且 (B 或 C)」都是一步到位
export function addGroup(def) {
  if (countLeaves(def) >= MAX_LEAVES || (def.items || []).length >= MAX_ROOT_ITEMS) return def;
  return { ...def, items: [...(def.items || []), { logic: def.logic === 'or' ? 'and' : 'or', items: [blankLeaf(def)] }] };
}
// 删除：组里最后一条被删时整组一起删
export function removeAt(def, path) {
  if (!Array.isArray(path) || !path.length) return def;
  const items = (def.items || []).slice();
  if (path.length === 1) { items.splice(path[0], 1); return { ...def, items }; }
  const g = items[path[0]];
  if (!isGroup(g)) return def;
  const inner = g.items.filter((_, j) => j !== path[1]);
  if (!inner.length) items.splice(path[0], 1);
  else items[path[0]] = { ...g, items: inner };
  return { ...def, items };
}
// path 为空 = 根节点
export function setLogic(def, path, logic) {
  const lg = logic === 'or' ? 'or' : 'and';
  if (!path || !path.length) return { ...def, logic: lg };
  return updateAt(def, path, (g) => (isGroup(g) ? { ...g, logic: lg } : g));
}
// 换字段：运算符取该字段第一个，值与参数重置为缺省
export function setLeafField(def, path, fieldId, catalog) {
  const f = fieldOf(catalog, fieldId);
  return updateAt(def, path, (leaf) => {
    const out = { id: leaf && leaf.id ? leaf.id : nextLeafId(def), field: fieldId || '', op: '' };
    if (leaf && leaf.tag) out.tag = leaf.tag;
    if (!f) return out;
    const op = f.ops && f.ops[0] ? f.ops[0].op : '';
    out.op = op;
    const v = defaultValue(valueControl(f, op));
    if (v !== undefined) out.value = v;
    const p = defaultParams(f.id);
    if (p !== undefined) out.params = p;
    return out;
  });
}
// 换运算符：值控件类型变了才重置值（in → notIn 保留已选的值）
export function setLeafOp(def, path, op, catalog) {
  return updateAt(def, path, (leaf) => {
    const f = fieldOf(catalog, leaf && leaf.field);
    const before = valueControl(f, leaf && leaf.op);
    const after = valueControl(f, op);
    const out = { ...leaf, op };
    if (before.kind !== after.kind || before.multiple !== after.multiple) {
      const v = defaultValue(after);
      if (v === undefined) delete out.value; else out.value = v;
    }
    return out;
  });
}
export function setLeafValue(def, path, value) {
  return updateAt(def, path, (leaf) => ({ ...leaf, value }));
}
export function setLeafParams(def, path, patch) {
  return updateAt(def, path, (leaf) => ({ ...leaf, params: { ...((leaf && leaf.params) || {}), ...patch } }));
}
export function findLeafPath(def, leafId) {
  const items = (def && def.items) || [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (isGroup(it)) { const j = it.items.findIndex((l) => l && l.id === leafId); if (j >= 0) return [i, j]; }
    else if (it && it.id === leafId) return [i];
  }
  return null;
}
// AI 返回的多个候选（部门、培养项目、人才标签）：HR 选中一项后写进对应叶子
export function applyChoice(def, leafId, value) {
  const p = findLeafPath(def, leafId);
  if (!p || blank(value)) return def;
  return updateAt(def, p, (leaf) => {
    if (Array.isArray(leaf.value)) return leaf.value.includes(value) ? leaf : { ...leaf, value: [...leaf.value, value] };
    if (blank(leaf.value) || isObj(leaf.value)) return { ...leaf, value: [value] };
    return { ...leaf, value };
  });
}

// 一条条件是否填完。目录里查不到的字段（自定义字段已停用）照样交给服务端，由它给出 field_removed 警告
export function isLeafComplete(leaf, catalog) {
  if (!leaf || blank(leaf.field)) return false;
  const f = fieldOf(catalog, leaf.field);
  if (!f) return true;
  if (blank(leaf.op)) return false;
  if (leaf.field === 'record' && (!leaf.params || blank(leaf.params.type))) return false;
  if (leaf.field === 'perfRecent' && leaf.params && leaf.params.mode === 'atLeastK' && !(Number(leaf.params.k) >= 1)) return false;
  return isValueFilled(valueControl(f, leaf.op), leaf.value);
}
// 运行前去掉没填完的条件与空组；返回 { definition, incomplete:[path…] }
export function cleanForRun(def, catalog) {
  const incomplete = [];
  const items = [];
  (def && def.items ? def.items : []).forEach((it, i) => {
    if (isGroup(it)) {
      const inner = [];
      it.items.forEach((l, j) => { if (isLeafComplete(l, catalog)) inner.push(l); else incomplete.push([i, j]); });
      if (inner.length) items.push({ logic: it.logic, items: inner });
    } else if (isLeafComplete(it, catalog)) items.push(it);
    else incomplete.push([i]);
  });
  const out = { v: 1, logic: def && def.logic === 'or' ? 'or' : 'and', items };
  if (def && def.includeExited) out.includeExited = true;
  return { definition: out, incomplete };
}
// 编号：根上第 i 项为 i+1，组内第 j 条为 「i+1.j+1」
export const pathLabel = (path) => path.map((n) => n + 1).join('.');
export const pathKey = (path) => path.join('.');

// 服务端校验错误 [{path, code}] → Map(pathKey → [code])；path 形如 items[2].items[0].value / items.2.items.0 / /items/2
export function errorsByPath(errors) {
  const m = new Map();
  for (const e of Array.isArray(errors) ? errors : []) {
    if (!e) continue;
    const idx = [...str(e.path).matchAll(/items\D{0,2}(\d+)/g)].map((x) => Number(x[1])).slice(0, 2);
    const k = idx.join('.');
    if (!m.has(k)) m.set(k, []);
    if (!m.get(k).includes(e.code)) m.get(k).push(e.code);
  }
  return m;
}
// 运行结果里的 skipped / warnings（[{id, reason|code, count?}]）→ 按叶子编号列出
export function leafNotices(def, list) {
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    if (!w) continue;
    const p = w.id ? findLeafPath(def, w.id) : null;
    out.push({ code: w.code || w.reason || '', label: p ? pathLabel(p) : '', count: Number.isFinite(w.count) ? w.count : null });
  }
  return out;
}

// ---------- 条件摘要 ----------
// ctx：{ deptLabel(id) → 名称 }。只按最终 filter 生成，不用模型自己写的摘要（设计 8.5 第 5 条）
export function summarize(def, catalog, lang, ctx = {}) {
  const s = dict(lang);
  const fm = fieldMap(catalog);
  const items = (def && Array.isArray(def.items) ? def.items : []).filter(Boolean);
  const parts = [];
  for (const it of items) {
    if (isGroup(it)) {
      const inner = it.items.filter(Boolean).map((l) => leafText(l, fm, lang, ctx));
      if (!inner.length) continue;
      parts.push(inner.length === 1 ? inner[0] : (lang === 'zh' ? '（' : '(') + inner.join(it.logic === 'or' ? s.or : s.and) + (lang === 'zh' ? '）' : ')'));
    } else parts.push(leafText(it, fm, lang, ctx));
  }
  let out = parts.length ? (def.logic === 'or' ? s.any : s.all) + parts.join(s.sep) : s.empty;
  if (def && def.includeExited) out += s.sep + s.exited;
  return out;
}
// 单条条件（或条件组）的一句话：晋升评审候选表的「每条条件一列」用作列名
export function itemSummary(item, catalog, lang, ctx = {}) {
  if (!item) return '';
  if (isGroup(item)) return summarize({ v: 1, logic: 'and', items: [item] }, catalog, lang, ctx).replace(dict(lang).all, '');
  return leafText(item, fieldMap(catalog), lang, ctx);
}
function listText(vals, f, lang, ctx, kind) {
  const s = dict(lang);
  const arr = (Array.isArray(vals) ? vals : [vals]).filter((v) => !blank(v));
  const label = (v) => (kind === 'dept' ? str(ctx.deptLabel ? ctx.deptLabel(v) || v : v) : optionText(f, v, lang));
  const shown = arr.slice(0, 3).map(label).join(s.listSep);
  return arr.length > 3 ? `${shown} ${s.more(arr.length)}` : shown;
}
export function optionText(f, v, lang) {
  const o = f && Array.isArray(f.options) ? f.options.find((x) => x && String(x.value) === String(v)) : null;
  return o ? nameOf(o, lang) || str(v) : str(v);
}
function leafText(leaf, fm, lang, ctx) {
  const s = dict(lang);
  if (!leaf || blank(leaf.field)) return s.unset.trim();
  if (isRetiredField(leaf.field) && !fm.get(leaf.field)) return s.retired;
  const f = fm.get(leaf.field) || { id: leaf.field, label: leaf.field, label_zh: leaf.field };
  const F = nameOf(f, lang);
  const p = leaf.params || {};
  const v = leaf.value;
  const ctrl = valueControl(f, leaf.op);
  const done = isValueFilled(ctrl, v);
  const tail = done ? '' : s.unset;
  const months = Number(p.months) || 0;
  switch (leaf.field) {
    case 'dept': {
      const t = listText(v, f, lang, ctx, 'dept');
      return (leaf.op === 'notIn' ? s.deptNot(t) : s.dept(t)) + tail;
    }
    case 'perfRecent': {
      const n = Math.max(1, Number(p.n) || 1);
      const win = Number(p.withinMonths) || 0;
      let t;
      if (leaf.op === 'noRecord') t = s.perfNone;
      else if (win > 0 && leaf.op === 'in') t = s.perfWindowIn(win, listText(v, f, lang, ctx));
      else if (win > 0) t = s.perfWindow(win, p.mode || 'all', Number(p.k) || 1, optionText(f, v, lang), leaf.op === 'atMost');
      else if (leaf.op === 'in') t = s.perfIn(n, listText(v, f, lang, ctx));
      else t = (leaf.op === 'atMost' ? s.perfAtMost : s.perfAtLeast)(n, p.mode || 'all', Number(p.k) || 1, optionText(f, v, lang));
      if (p.periodKind && s.period[p.periodKind]) t += s.period[p.periodKind];
      if (p.missing === 'ignore' && n > 1 && win === 0 && leaf.op !== 'noRecord') t += s.missIgnore;
      if (p.missing === 'ignore' && win > 0 && leaf.op !== 'noRecord') t += s.missWinIgnore;
      return t + tail;
    }
    case 'tenureMonths':
      if (leaf.op === 'between') return s.tenureBetween(str(v && v.from), str(v && v.to)) + tail;
      return (leaf.op === 'lte' ? s.tenureLte : s.tenureGte)(str(v)) + tail;
    case 'levelTenureMonths':
      if (leaf.op === 'between') return s.levelTenureBetween(str(v && v.from), str(v && v.to)) + tail;
      return (leaf.op === 'lte' ? s.levelTenureLte : s.levelTenureGte)(str(v)) + tail;
    case 'violation': {
      const sev = Array.isArray(p.severity) && p.severity.length === 1 ? (/major/i.test(p.severity[0]) ? s.sevMajor : s.sevMinor) : '';
      return leaf.op === 'countAtLeast' ? s.vioCount(months, sev, Number(v) || 0) + tail : s.vioNone(months, sev);
    }
    case 'award':
      return leaf.op === 'countAtLeast' ? s.awardCount(months, Number(v) || 0) + tail : s.awardNone(months);
    case 'trainingMandatoryDone':
      return leaf.op === 'isFalse' ? s.mandNot : s.mandDone;
    case 'trainingCompletion':
      return (leaf.op === 'lte' ? s.compLte : s.compGte)(str(v), p.scope) + tail;
    case 'record': {
      const types = Array.isArray(f.recordTypes) ? f.recordTypes : [];
      const ty = types.find((x) => x && x.key === p.type);
      const tn = ty ? nameOf(ty, lang) : str(p.type) || '…';
      if (leaf.op === 'notExists') return s.recNot(tn, months);
      if (leaf.op === 'countAtLeast') return s.recCount(tn, months, Number(v) || 0) + tail;
      return s.recExists(tn, months);
    }
    case 'succession':
      return leaf.op === 'notListed' ? s.succNot(str(p.position)) : s.succListed(str(p.position));
    case 'nextLevelExists':
      return leaf.op === 'isFalse' ? s.nextNo : s.nextYes;
    default: break;
  }
  // 通用写法：字段 + 运算符 + 值
  const opObj = (f.ops || []).find((o) => o && o.op === leaf.op);
  const OP = opObj ? nameOf(opObj, lang) : str(leaf.op);
  let text;
  if (ctrl.kind === 'none') text = leaf.op === 'isTrue' ? `${F}${s.colon}${s.yes}` : leaf.op === 'isFalse' ? `${F}${s.colon}${s.no}` : `${F} ${OP}`;
  else if (ctrl.kind === 'levelRange' || ctrl.kind === 'numberRange' || ctrl.kind === 'dateRange') text = `${F} ${s.range(str(v && v.from) || '…', str(v && v.to) || '…')}`;
  else if (leaf.op === 'in') text = `${F}${s.colon}${listText(v, f, lang, ctx, ctrl.kind === 'dept' ? 'dept' : '')}`;
  else if (ctrl.kind === 'multi' || ctrl.kind === 'dept') text = `${F} ${OP} ${listText(v, f, lang, ctx, ctrl.kind === 'dept' ? 'dept' : '')}`;
  else if (ctrl.kind === 'single') text = `${F} ${OP} ${optionText(f, v, lang)}`;
  else text = `${F} ${OP} ${str(v)}`;
  if (leaf.field === 'potential' && p.freshOnly) text += s.freshOnly;
  return text + tail;
}

// ---------- 结果列 ----------
export function toggleColumn(cols, id) {
  const list = Array.isArray(cols) ? cols.slice() : DEFAULT_COLUMNS.slice();
  if (list.includes(id)) return LOCKED_COLUMNS.includes(id) ? list : list.filter((c) => c !== id);
  return [...list, id];
}
export function moveColumn(cols, id, dir) {
  const list = Array.isArray(cols) ? cols.slice() : [];
  const i = list.indexOf(id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}
// 列值 → 显示文字。服务端给规范值（或 {value,label,label_zh}），选项类按当前语言取名
export function displayCell(colId, value, catalog, lang) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    const xs = value.map((x) => displayCell(colId, x, catalog, lang)).filter((x) => x !== '—');
    return xs.length ? xs.join(' · ') : '—';
  }
  if (isObj(value)) {
    if ('label' in value || 'label_zh' in value) return nameOf(value, lang) || str(value.value) || '—';
    if ('value' in value) return displayCell(colId, value.value, catalog, lang);
    if ('done' in value && 'total' in value) return `${value.done}/${value.total}`;
    return '—';
  }
  if (typeof value === 'boolean') return value ? dict(lang).yes : dict(lang).no;
  const colDef = catalog && Array.isArray(catalog.columns) ? catalog.columns.find((c) => c && c.id === colId) : null;
  if (colDef && Array.isArray(colDef.options)) return optionText(colDef, value, lang);
  const fid = COLUMN_FIELD[colId] || (String(colId).startsWith('custom:') ? colId : null);
  if (fid) {
    const f = fieldOf(catalog, fid);
    if (f && Array.isArray(f.options)) return optionText(f, value, lang);
  }
  return str(value);
}
export function cellOf(row, colId) {
  if (!row) return null;
  if (isObj(row.cells) && colId in row.cells) return row.cells[colId];
  return row[colId];
}
// 条件命中（explain）：true / false / null（该条被忽略或无从判断）
export function hitOf(row, leafId) {
  if (!row || !leafId) return null;
  const src = isObj(row.explain) ? row.explain : isObj(row.hits) ? row.hits : null;
  if (!src || !(leafId in src)) return null;
  const v = src[leafId];
  if (v === null || v === undefined) return null;
  return isObj(v) ? (v.ok === undefined ? null : !!v.ok) : !!v;
}
// 顶层每一项一个「命中」单元：叶子用其 id；条件组用组内全部叶子按组逻辑合成
export function topHits(def, row) {
  return ((def && def.items) || []).map((it) => {
    if (!isGroup(it)) return hitOf(row, it && it.id);
    const hs = it.items.map((l) => hitOf(row, l && l.id)).filter((h) => h !== null);
    if (!hs.length) return null;
    return it.logic === 'or' ? hs.some(Boolean) : hs.every(Boolean);
  });
}

// ---------- 晋升评审候选的行操作 ----------
// member = include（手动加入）→ 取消加入；exclude（已排除）→ 恢复；满足条件 → 排除（必填理由）；其余无操作
export function promoRowAction(row) {
  if (!row) return null;
  if (row.member === 'include') return 'uninclude';
  if (row.member === 'exclude') return 'restore';
  if (row.eligible) return 'exclude';
  return null;
}
// 加入晋升候选弹窗的提示：已在名单中的人数、没有下一职级的人数
export function includePreview(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    already: list.filter((r) => r && (r.member === 'include' || r.eligible === true)).length,
    noNext: list.filter((r) => r && r.member !== 'include' && r.eligible !== true && r.nextLevel !== undefined && !r.nextLevel).length,
  };
}
// 岗位名比较口径（与服务端去重相同）：不分大小写、去掉多余空格
export const positionKey = (p) => str(p).trim().replace(/\s+/g, ' ').toLowerCase();

// 批量接口的结果 → { done, skipped:[{id, employeeId, code}] }；兼容 created / included / results 几种写法
export function bulkOutcome(resp) {
  const r = isObj(resp) ? resp : {};
  const arr = (x) => (Array.isArray(x) ? x : null);
  let done = 0;
  if (typeof r.done === 'number') done = r.done;
  else if (arr(r.created)) done = r.created.length;
  else if (typeof r.created === 'number') done = r.created;
  else if (arr(r.added)) done = r.added.length;
  else if (typeof r.added === 'number') done = r.added;
  else if (arr(r.results)) done = r.results.filter((x) => x && x.ok).length;
  let skipped = [];
  if (arr(r.skipped)) skipped = r.skipped;
  else if (arr(r.results)) skipped = r.results.filter((x) => x && !x.ok);
  return {
    done,
    skipped: skipped.filter(Boolean).map((x) => (isObj(x)
      ? { id: x.userId !== undefined ? x.userId : x.id, employeeId: x.employeeId || null, code: str(x.code) }
      : { id: x, employeeId: null, code: '' })),
  };
}

// ---------- 未保存的临时筛选（浏览器 localStorage，读写都包 try/catch） ----------
export function readDraft(storage) {
  try {
    const raw = storage && storage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!isObj(d) || !isObj(d.definition)) return null;
    return { definition: normalizeDef(d.definition), columns: Array.isArray(d.columns) && d.columns.length ? d.columns.map(String) : DEFAULT_COLUMNS.slice(), sort: isObj(d.sort) ? d.sort : null };
  } catch (e) { return null; }
}
export function writeDraft(storage, draft) {
  try {
    if (!storage) return false;
    if (!draft) { storage.removeItem(DRAFT_KEY); return true; }
    storage.setItem(DRAFT_KEY, JSON.stringify({ definition: draft.definition, columns: draft.columns, sort: draft.sort || null }));
    return true;
  } catch (e) { return false; }
}

// 快速新建：按档案记录类型找人（取代旧「人才检索」的入口）
export function recordTypeFilter(typeKey) {
  return { v: 1, logic: 'and', items: [{ id: 'c1', field: 'record', op: 'exists', params: { type: str(typeKey), months: 0, fields: {} } }], includeExited: false };
}
// 下载文件名：talent-filter-<名称或 adhoc>-<YYYYMMDD>.csv（非法文件名字符换成 -）
export function exportFileName(name, now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const base = str(name).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'adhoc';
  return `talent-filter-${base}-${stamp}.csv`;
}
