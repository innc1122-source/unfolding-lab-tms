// 组卷页常驻概况（第四批 6.2，2026-10-08）：纯函数，无 import（test/paper-summary.test.js 直接 import 跑）。
//
// paperSummary(paper, bank, exam) →
//   { count, cases, items, total, passPct, passPoints, typeMix: [{ type, count }],
//     modules: { covered, total, zero: [moduleId] }, outOfPool: [id], missing: [id], points: { [id]: 分值 } }
//   paper  试卷上的题目 id（按答题顺序）
//   bank   题库条目（GET /api/admin/questions 原样）
//   exam   { typePoints, passingScore, poolCourseIds, enabled, order }
//            typePoints     当前表单的题型默认分值（null = 旧口径：客观题 1 分、简答按满分 / 10）
//            poolCourseIds  关联课程（没勾 = 所属课程下全部内容，调用方先展开）；缺省 = 整个题库
//            enabled        已开放的题型；缺省 = 全部
// 口径与服务端一致：题目自带分值优先，其次考试的题型默认分值（缺的键按题型默认：简答 10、其余 1）；
// 案例题组的分值 = 各小题分值之和（小题自带分值 → 题型默认分值 → 1），案例本身的分值字段不计。
// 不在关联课程题库里的题（或已删除的题）列进 outOfPool，不计入题数与总分 —— 保存时服务端会把它们去掉。

export const SUMMARY_ORDER = ['mcq', 'multi', 'tf', 'fill', 'cloze', 'ordering', 'matching', 'classify', 'open', 'case'];
const DEFAULT_POINTS = { open: 10 };

const r1 = (x) => Math.round(x * 10) / 10;
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// 一道小题 / 普通题在当前设置下的分值
function basePoints(q, typePoints) {
  const own = num(q && q.points);
  if (own != null) return own;
  if (typePoints && typeof typePoints === 'object') {
    const tp = num(typePoints[q.type]);
    if (tp != null) return tp;
    return DEFAULT_POINTS[q.type] != null ? DEFAULT_POINTS[q.type] : 1;
  }
  // 旧口径（typePoints 为空）
  if (q.type === 'open') return (num(q.maxPoints) || 10) / 10;
  return 1;
}

export function pointsOf(q, typePoints) {
  if (!q) return 0;
  if (q.type === 'case') {
    const items = Array.isArray(q.items) ? q.items : [];
    return r1(items.reduce((s, it) => s + basePoints(it || {}, typePoints), 0));
  }
  return basePoints(q, typePoints);
}

export function itemsOf(q) {
  if (q && q.type === 'case') return Array.isArray(q.items) ? q.items.length : 0;
  return 1;
}

export function paperSummary(paper, bank, exam = {}) {
  const tp = exam.typePoints == null ? null : exam.typePoints;
  const order = Array.isArray(exam.order) && exam.order.length ? exam.order : SUMMARY_ORDER;
  const enabled = Array.isArray(exam.enabled) ? new Set(exam.enabled) : null;
  const poolIds = Array.isArray(exam.poolCourseIds) ? new Set(exam.poolCourseIds.map(String)) : null;
  const byId = new Map((bank || []).map((q) => [String(q.id), q]));
  const inPool = (q) => !!q && !q.unsupported
    && (!enabled || enabled.has(q.type))
    && (!poolIds || poolIds.has(String(q.courseId)));

  const out = {
    count: 0, cases: 0, items: 0, total: 0,
    passPct: num(exam.passingScore), passPoints: null,
    typeMix: [], modules: { covered: 0, total: 0, zero: [] },
    outOfPool: [], missing: [], points: {},
  };
  const mix = {};
  const paperMods = new Set();
  const seen = new Set();
  for (const raw of paper || []) {
    const id = String(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const q = byId.get(id);
    if (!q) { out.missing.push(raw); out.outOfPool.push(raw); continue; }
    if (!inPool(q)) { out.outOfPool.push(raw); continue; }
    const pts = pointsOf(q, tp);
    out.points[id] = pts;
    out.count += 1;
    out.items += itemsOf(q);
    if (q.type === 'case') out.cases += 1;
    out.total += pts;
    mix[q.type] = (mix[q.type] || 0) + 1;
    if (q.moduleId) paperMods.add(String(q.moduleId));
  }
  out.total = r1(out.total);
  out.passPoints = out.passPct != null && out.total > 0 ? r1((out.total * out.passPct) / 100) : null;
  const keys = [...order, ...Object.keys(mix).filter((k) => !order.includes(k)).sort()];
  out.typeMix = keys.filter((k) => mix[k]).map((k) => ({ type: k, count: mix[k] }));

  // 模块覆盖：关联课程题库里至少有 1 道题的模块中，试卷覆盖了几个；0 题的模块按题库出现顺序列出
  const bankMods = [];
  const bankModSet = new Set();
  for (const q of bank || []) {
    if (!inPool(q) || !q.moduleId) continue;
    const m = String(q.moduleId);
    if (!bankModSet.has(m)) { bankModSet.add(m); bankMods.push(m); }
  }
  out.modules.total = bankMods.length;
  out.modules.covered = bankMods.filter((m) => paperMods.has(m)).length;
  out.modules.zero = bankMods.filter((m) => !paperMods.has(m));
  return out;
}

// 试卷顺序调整（组卷页的 ↑↓、拖动、「移到第 n 题」共用）：把 from 位置的题移到 to 位置，越界时夹到两端
export function moveItem(list, from, to) {
  const a = (list || []).slice();
  if (from < 0 || from >= a.length) return a;
  const t = Math.max(0, Math.min(a.length - 1, to));
  const [x] = a.splice(from, 1);
  a.splice(t, 0, x);
  return a;
}
