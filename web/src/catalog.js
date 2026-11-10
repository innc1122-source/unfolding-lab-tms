// 课程目录（第四批 7「公开课程」，2026-10-08）：员工端「课程目录」页（pages/Catalog.jsx）的纯函数 ——
// 地址栏筛选、搜索、排序、按学习状态给出操作按钮，以及学习记录的累计学时（Record.jsx）。
// 不 import 任何东西（test/catalog-filter.test.js 用 vm 直接跑）；类别排序由调用方传入 categoryRank。
//
// 读取的接口字段（GET /api/catalog/courses，设计 b4-design §6）：
//   items[]: programId, courseId, title, title_zh, summary, summary_zh, category, mode, hours, minutes,
//            moduleCount, hasExam, sessionAt, location, enrollType,
//            my: { status: 'none' | 'self' | 'assigned', learnStatus, progress, done, retakeExamId? }
// 目录只列公开、已发布的课程；线下课程开课日已过的服务端已经不列（已加入的人除外），这里不再按日期筛。

export const CATALOG_UNCAT = '__none';
export const CATALOG_MODES = ['online', 'offline'];

const str = (v) => (v === null || v === undefined ? '' : String(v));

// 地址栏参数 → 筛选：q 搜索、cat 类别（逗号列表，含 __none = 未分类）、mode 授课方式、mine=1 只看未加入
export function catalogFiltersOf(params) {
  const p = params || {};
  const cat = [];
  for (const x of str(p.cat).split(',')) { const t = x.trim(); if (t && !cat.includes(t)) cat.push(t); }
  return {
    q: str(p.q).trim(),
    cat,
    mode: CATALOG_MODES.includes(p.mode) ? p.mode : '',
    mine: p.mine === '1' || p.mine === 1 || p.mine === true,
  };
}

// 生效的筛选个数（不含搜索词）
export function catalogFilterCount(f) {
  return (f.cat.length ? 1 : 0) + (f.mode ? 1 : 0) + (f.mine ? 1 : 0);
}

// 本人与这门课的关系：none = 还没加入；self = 从目录自主加入；assigned = HR / 培养项目 / 审批通过的指派
export function myStatusOf(it) {
  const st = it && it.my && it.my.status;
  return st === 'self' || st === 'assigned' ? st : 'none';
}

// 一门课是否符合筛选。搜索：课程名（中英）与简介（中英），不区分大小写
export function matchCatalog(it, f) {
  if (!it) return false;
  const ff = f || {};
  const cat = it.category ? String(it.category) : CATALOG_UNCAT;
  if (ff.cat && ff.cat.length && !ff.cat.includes(cat)) return false;
  if (ff.mode && (it.mode === 'offline' ? 'offline' : 'online') !== ff.mode) return false;
  if (ff.mine && myStatusOf(it) !== 'none') return false;
  const q = str(ff.q).trim().toLowerCase();
  if (!q) return true;
  return [it.title, it.title_zh, it.summary, it.summary_zh].some((v) => str(v).toLowerCase().includes(q));
}

export function filterCatalog(items, f) {
  return (Array.isArray(items) ? items : []).filter((it) => matchCatalog(it, f));
}

// 当前语言的课程名（英文缺省时用中文，反之亦然）
export function catalogTitle(it, lang) {
  if (!it) return '';
  return str(lang === 'zh' ? (it.title_zh || it.title) : (it.title || it.title_zh));
}

// 默认排序：类别目录顺序（rankOf = categories.js categoryRank；未分类在最后），同类按当前语言的课程名
export function sortCatalog(items, lang, rankOf) {
  const rank = typeof rankOf === 'function' ? rankOf : () => 0;
  const loc = lang === 'zh' ? 'zh' : 'en';
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => (rank(a.category || null) - rank(b.category || null))
    || str(a.category).localeCompare(str(b.category))
    || catalogTitle(a, lang).localeCompare(catalogTitle(b, lang), loc)
    || str(a.programId).localeCompare(str(b.programId)));
}

// 目录里出现过的类别（筛选下拉的选项；服务端 categories 优先，没有时从列表里收集）
export function catalogCategories(data) {
  if (data && Array.isArray(data.categories)) return data.categories.map((k) => (k ? String(k) : CATALOG_UNCAT));
  const out = [];
  for (const it of (data && Array.isArray(data.items) ? data.items : [])) {
    const k = it.category ? String(it.category) : CATALOG_UNCAT;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

// 每门课的操作（设计 §7.2「Actions by state」）：
//   none + 线上           → start   「开始学习」：加入后进入课程
//   none + 线下           → join    「加入课程」：加入后留在本页，提示按时参加
//   已完成                → done    「已完成 ✓」+「查看」
//   learnStatus 待补考     → retake  「去补考」：考前说明页（有考试 id 时），否则课程详情
//   已加入的线下课程（未完成）→ joined 「已加入」+「查看」
//   其余（已加入、未完成）  → continue「继续学习 n%」：学完待考 → 课程详情（考试入口在那里），否则直接进课程
export function catalogAction(it) {
  const my = (it && it.my) || {};
  const pid = str(it && it.programId);
  const programHref = '/program/' + pid;
  const courseHref = it && it.courseId ? '/course/' + it.courseId : programHref;
  const offline = !!it && it.mode === 'offline';
  if (myStatusOf(it) === 'none') return offline ? { kind: 'join', enroll: true, href: null } : { kind: 'start', enroll: true, href: courseHref };
  if (my.done === true) return { kind: 'done', enroll: false, href: programHref };
  if (my.learnStatus === 'retake_pending') {
    return { kind: 'retake', enroll: false, href: my.retakeExamId ? `/exam-prep/${pid}/${my.retakeExamId}` : programHref };
  }
  if (offline) return { kind: 'joined', enroll: false, href: courseHref };
  const progress = pct(my.progress);
  return { kind: 'continue', enroll: false, progress, href: it.hasExam && progress >= 100 ? programHref : courseHref };
}

// 学习记录的累计学时（设计 §7.3 / §9.6）：服务端给 totals（hoursDone / hoursSelf）时以它为准；
// 只有每行 hours + source 时按「已完成的课程 × 学时」在本地合计。known = 服务端是否支持学时（旧服务端两者都没有，不显示这一行）。
// 接受两种形状：数组（旧接口，每行可带 hours / source / done）或 { items, totals | hoursDone, hoursSelf }。
export function learningHoursOf(data) {
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
  const box = data && !Array.isArray(data) ? (data.totals || data) : {};
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let total = num(box.hoursDone);
  let self = num(box.hoursSelf);
  const rowHours = items.some((r) => r && num(r.hours) !== null);
  if (total === null || self === null) {
    let a = 0, b = 0;
    for (const r of items) {
      const h = num(r && r.hours) || 0;
      const done = r && (r.done === true || (r.done === undefined && r.status === 'passed'));
      if (!done || h <= 0) continue;
      a += h;
      if (r.source === 'self') b += h;
    }
    if (total === null) total = a;
    if (self === null) self = b;
  }
  const r1 = (n) => Math.round(n * 10) / 10;
  return {
    items,
    total: r1(total),
    self: r1(Math.min(self, total)),
    assigned: r1(Math.max(0, total - self)),
    known: rowHours || num(box.hoursDone) !== null,
  };
}
