import Overlay from '../components/Overlay.jsx';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAsync, api, daysUntil } from '../api.js';
import { date as fmtDate } from '../fmt.js';
import ProgressRing from '../components/ProgressRing.jsx';
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';
import { learnStatusOf, examAction, retakeInfo, retakeHref, sortForLearner, stampOf } from '../learnstatus.js';
import { fetchCatalogCount } from '../learningnav.js';

// Co-located bilingual UI strings for this screen.
const T = {
  zh: {
    title: '我的课程',
    lead: '指派给你和你自主加入的课程',
    // chip labels (keys match FILTERS)
    all: '全部', progress: '进行中', ready: '待考试',
    completed: '已通过', overdue: '逾期', offline: '线下',
    // status pills
    inProgress: '进行中', notStarted: '未开始', passed: '已通过', failed: '未通过', pendingResult: '成绩待定',
    overdueTag: '已逾期', readyTag: '待考试', retakeTag: '待补考',
    resume: '继续学习', start: '开始学习', review: '复习', view: '查看', toExam: '前往考试',
    retake: '去补考', details: '查看详情',
    dueIn: (d) => (d <= 0 ? '今天截止' : `${d} 天后截止`),
    dueOn: (ymd) => `${ymd} 截止`,
    overdueBy: (d) => `逾期 ${d} 天`,
    noDue: '无截止日期',
    metaModMin: (m, min) => `${m} 模块 · 约 ${min} 分钟`,
    score: (s) => `成绩 ${s}%`,
    offlineTag: '线下', offlineTbd: '时间待定', attendedLbl: '已签到',
    excusedMakeup: '已请假 · 需补课', // 负责人 2026-10-06：请假不算完成
    doneLbl: '已完成', // 无结业考试的课程：学完即完成，不显示分数
    // 5.4 / 10.8：学完但考试未通过时写清下一步
    failedNext: '学习已完成，考试未通过',
    leftN: (n) => `剩余 ${n} 次考试机会`,
    leftUnlimited: '考试次数不限',
    retakeFrom: (at) => `${at} 起可补考`,
    usedUpNext: '考试次数已用完，请联系 HR',
    searchPh: '搜索课程…',
    empty: '该分类下暂无课程', none: '尚未指派任何课程', noResult: '没有匹配的课程',
    loading: '加载中…',
    error: '加载失败，请刷新页面重试。',
    // 第四批 7：从课程目录自主加入的课程（无截止日期，可退出）
    selfTag: '自主学习',
    closedNote: '该课程已不再公开，你仍可学完',
    browseCatalog: '浏览公开课',
    more: '更多操作', leave: '退出学习',
    leaveTitle: (t) => `退出「${t}」？`,
    leaveBody: '退出后课程从列表移除，学习进度保留，可随时在「公开课」重新加入。',
    leaveClosedBody: '该课程已不再公开，退出后无法从「公开课」重新加入；学习进度保留。',
    leaveOk: '退出学习', cancel: '取消', leaveFail: '操作失败，请重试',
  },
  en: {
    title: 'My Courses',
    lead: 'Courses assigned to you or that you joined',
    all: 'All', progress: 'In progress', ready: 'Ready for exam',
    completed: 'Passed', overdue: 'Overdue', offline: 'In-person',
    inProgress: 'In progress', notStarted: 'Not started', passed: 'Passed', failed: 'Not passed', pendingResult: 'Result pending',
    overdueTag: 'Overdue', readyTag: 'Ready for exam', retakeTag: 'Retake pending',
    resume: 'Resume', start: 'Start', review: 'Review', view: 'View', toExam: 'Go to exam',
    retake: 'Retake exam', details: 'View details',
    dueIn: (d) => (d <= 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`),
    dueOn: (ymd) => `Due ${ymd}`,
    overdueBy: (d) => `${d} day${d === 1 ? '' : 's'} overdue`,
    noDue: 'No due date',
    metaModMin: (m, min) => `${m} module${m === 1 ? '' : 's'} · ~${min} min`,
    score: (s) => `Score ${s}%`,
    offlineTag: 'In-person', offlineTbd: 'Time TBD', attendedLbl: 'Checked in',
    excusedMakeup: 'Excused · make-up required',
    doneLbl: 'Completed',
    failedNext: 'Course finished — exam not passed',
    leftN: (n) => (n === 1 ? '1 attempt left' : `${n} attempts left`),
    leftUnlimited: 'Unlimited attempts',
    retakeFrom: (at) => `You can retake from ${at}`,
    usedUpNext: 'No attempts left — please contact HR',
    searchPh: 'Search courses…',
    empty: 'No courses in this filter', none: 'No courses assigned yet', noResult: 'No matching courses',
    loading: 'Loading…',
    error: 'Couldn’t load. Refresh the page to try again.',
    selfTag: 'Self-directed',
    closedNote: 'This course is no longer public; you can still finish it',
    browseCatalog: 'Browse public courses',
    more: 'More actions', leave: 'Leave course',
    leaveTitle: (t) => `Leave “${t}”?`,
    leaveBody: 'The course leaves your list; your progress is kept and you can rejoin from Public Courses.',
    leaveClosedBody: 'This course is no longer public, so you cannot rejoin it from Public Courses. Your progress is kept.',
    leaveOk: 'Leave course', cancel: 'Cancel', leaveFail: 'Couldn’t complete that. Please try again',
  },
};

/* Chip set per design 06: 全部 / 进行中 / 待考试 / 已通过 / 逾期 / 线下. No
   "not started" chip — an untouched course is already sitting in 全部, while
   "waiting on an exam" and "overdue" are the two an employee has to act on.
   `offline` is a mode, not a status, so it sits alongside as its own lens.
   The phone shows only 全部 / 逾期 / 进行中 / 已通过; that trim is done in CSS
   off `data-f` so a chip currently in use is never the one hidden. */
const FILTERS = ['all', 'progress', 'ready', 'completed', 'overdue', 'offline'];

// Which programs each chip shows. 10.8（负责人 10/8）：考试未通过、还能补考的课程是「待补考」，
// 和「待考试」同属「要去考试」，归在「待考试」里（不再混进「进行中」）；次数用完的未通过留在「进行中」。
const MATCH = {
  all: () => true,
  progress: (p, st) => st === 'inprog' || st === 'failed',
  ready: (p, st) => st === 'ready' || st === 'retake',
  completed: (p, st) => st === 'passed',
  overdue: (p, st) => st === 'overdue',
  offline: (p) => p.mode === 'offline',
};

// Venue — the in-person session's stand-in for a progress ring. Same outline
// Home.jsx uses on its catalog card, so the two card styles agree.
const IcVenue = () => (
  <svg className="ic" viewBox="0 0 24 24"><path d="M3 21V9l9-6 9 6v12" /><path d="M9 21v-6h6v6" /></svg>
);

const ymdOf = (dueAt) => fmtDate(dueAt);   // 一致性整改 3

// 第四批 7：自主学习的课程（source = 'self'，从课程目录加入）。完成前可以「退出学习」。
const isSelf = (p) => p.source === 'self';
const canLeave = (p) => isSelf(p) && p.done !== true;

// 行尾的 ⋯ 菜单（只有一项「退出学习」）：与整行按钮并排，不嵌套在行按钮里。Esc、点外面收起。
function RowMenu({ s, onLeave }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <span className="ml-more" ref={ref}>
      <button type="button" className="ml-more-btn" aria-label={s.more} title={s.more} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
      </button>
      {open && (
        <span className="ml-more-pop" role="menu">
          <button type="button" role="menuitem" className="ml-more-item" onClick={() => { setOpen(false); onLeave(); }}>{s.leave}</button>
        </span>
      )}
    </span>
  );
}

// 「退出学习」确认（短操作 = 弹窗）：DELETE /api/catalog/courses/:programId/enroll，进度与考试记录保留
function LeaveDialog({ s, loc, p, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.del(`/api/catalog/courses/${encodeURIComponent(p.id)}/enroll`);
      onDone();
    } catch (e) {
      setErr((e && e.message) || s.leaveFail);
      setBusy(false);
    }
  };
  return (
    <Overlay labelledBy="ml-leave-t" busy={busy} onClose={onClose}>
        <h3 id="ml-leave-t">{s.leaveTitle(loc(p, 'title'))}</h3>
        <p className="ml-leave-body">{p.publicClosed ? s.leaveClosedBody : s.leaveBody}</p>
        {err && <div className="apply-err">{err}</div>}
        <div className="apply-foot">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{s.cancel}</button>
          <button type="button" className="btn" onClick={submit} disabled={busy}>{busy ? '…' : s.leaveOk}</button>
        </div>
    </Overlay>
  );
}

export default function MyLearning() {
  const { lang, loc } = useI18n();
  const nav = useNavigate();
  const s = T[lang];
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [leaveFor, setLeaveFor] = useState(null);
  const [hasCatalog, setHasCatalog] = useState(false);
  useEffect(() => { let alive = true; fetchCatalogCount().then((n) => { if (alive) setHasCatalog(n > 0); }); return () => { alive = false; }; }, []);

  const { loading, error, data, reload } = useAsync(() => api.get('/api/programs'), []);
  const programs = data || [];

  // Search narrows the pool the chips count over, so a chip's number always
  // matches what clicking it actually shows. Same haystack as the Home catalog.
  const q = query.trim().toLowerCase();
  const pool = q
    ? programs.filter((p) => `${loc(p, 'title') || ''} ${loc(p, 'description') || ''}`.toLowerCase().includes(q))
    : programs;

  const countFor = (f) => pool.filter((p) => MATCH[f](p, learnStatusOf(p))).length;
  // 排序与首页同一口径（10.7）：逾期 → 待考试 / 待补考 → 进行中 → …
  const shown = sortForLearner(pool.filter((p) => MATCH[filter](p, learnStatusOf(p))));

  const statusPill = (p, st) => {
    if (st === 'passed')
      return (
        <span className="pill ok">
          <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
          {p.mode === 'offline' ? s.attendedLbl : p.hasExam === false ? s.doneLbl : s.passed}
        </span>
      );
    // How late, not just "late" — the number is what makes it actionable.
    if (st === 'overdue') {
      const late = daysUntil(p.dueAt);
      return <span className="pill warn">{late != null && late < 0 ? s.overdueBy(-late) : s.overdueTag}</span>;
    }
    // 线下课程登记了请假：不算完成、需补课（负责人 2026-10-06）。
    if (p.mode === 'offline' && p.attendance === 'excused') return <span className="pill warn">{s.excusedMakeup}</span>;
    if (st === 'retake') return <span className="pill fail">{s.retakeTag}</span>;
    if (st === 'failed') return <span className="pill fail">{s.failed}</span>;
    if (st === 'pending') return <span className="pill pri">{s.pendingResult}</span>;
    if (st === 'ready') return <span className="pill pri">{s.readyTag}</span>;
    if (st === 'notstarted') return <span className="pill muted">{s.notStarted}</span>;
    return <span className="pill pri">{s.inProgress}</span>;
  };

  // 第二行：课程信息；未通过时改写下一步（剩余次数 / 可补考时间 / 联系 HR）
  const metaLine = (p, st, act) => {
    if (act === 'retake' || st === 'failed') {
      const r = retakeInfo(p);
      const parts = [s.failedNext];
      if (r.usedUp) parts.push(s.usedUpNext);
      else {
        parts.push(r.attemptsLeft == null ? s.leftUnlimited : s.leftN(r.attemptsLeft));
        if (r.waiting) parts.push(s.retakeFrom(stampOf(r.availableAt)));
      }
      return <span className="ml-next">{parts.join(' · ')}</span>;
    }
    if (p.mode === 'offline')
      return <span>{p.sessionAt ? p.sessionAt.replace('T', ' ') : s.offlineTbd}{p.location ? ` · ${p.location}` : ''}</span>;
    if (st === 'passed' && p.hasExam !== false && p.best)
      return <span className="tnum">{s.score(p.best.percent)}</span>;
    return <span>{s.metaModMin(p.moduleCount ?? p.courseCount ?? 0, p.minutes || 0)}</span>;
  };

  const dueCell = (p, st) => {
    const d = daysUntil(p.dueAt);
    if (d == null) return <span className="ml-due muted">{s.noDue}</span>;
    if (st === 'passed') return <span className="ml-due muted tnum">{s.dueOn(ymdOf(p.dueAt))}</span>;
    if (d < 0) return <span className="ml-due late tnum">{s.dueOn(ymdOf(p.dueAt))}</span>;
    return <span className={'ml-due tnum' + (d <= 7 ? ' soon' : '')}>{s.dueIn(d)}</span>;
  };

  // 下一步：可补考（不在等待期）→「去补考」直达考前说明；等待期 / 次数用完 →「查看详情」；
  // 线下课程一律「查看」。整行是一个按钮，所以去向与行点击一致（不嵌套第二个按钮）。
  const nextStep = (p, st, act) => {
    if (act === 'retake') {
      const r = retakeInfo(p);
      if (r.waiting || r.usedUp) return { label: s.details, ghost: true, go: () => nav(`/program/${p.id}`) };
      return { label: s.retake, ghost: false, go: () => nav(retakeHref(p)) };
    }
    if (p.mode === 'offline') return { label: s.view, ghost: true, go: () => nav(`/program/${p.id}`) };
    if (st === 'failed') return { label: s.details, ghost: true, go: () => nav(`/program/${p.id}`) };
    if (act === 'first') return { label: s.toExam, ghost: false, go: () => nav(`/program/${p.id}`) };
    if (st === 'passed') return { label: s.review, ghost: true, go: () => nav(`/program/${p.id}`) };
    if (st === 'notstarted') return { label: s.start, ghost: false, go: () => nav(`/program/${p.id}`) };
    return { label: s.resume, ghost: true, go: () => nav(`/program/${p.id}`) };
  };

  return (
    <div className="wrap">
      <ModuleTrail items={learnTrail(lang, 'courses')} />
      <div className="ml-head">
        <h1 className="ml-title">{s.title}</h1>
        <p className="ml-lead">{s.lead}</p>
      </div>

      {loading ? (
        <div className="ml-empty">{s.loading}</div>
      ) : error ? (
        <div className="ml-empty">{s.error}</div>
      ) : programs.length === 0 ? (
        <div className="ml-empty">
          <div>{s.none}</div>
          {hasCatalog && <button type="button" className="btn sm ghost ml-empty-go" onClick={() => nav('/catalog')}>{s.browseCatalog} →</button>}
        </div>
      ) : (
        <>
          <div className="ml-toolbar">
            <div className="ml-filters" role="group" aria-label={s.title}>
              {FILTERS.map((f) => {
                const n = countFor(f);
                return (
                  <button
                    key={f}
                    data-f={f}
                    aria-pressed={filter === f}
                    className={'ml-chip' + (filter === f ? ' active' : '') + (f === 'overdue' && n > 0 ? ' danger' : '')}
                    onClick={() => setFilter(f)}
                  >
                    {s[f]}
                    <span className="ml-chip-n tnum">{n}</span>
                  </button>
                );
              })}
            </div>
            <input
              className="home-search ml-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={s.searchPh}
              aria-label={s.searchPh}
            />
          </div>

          {/* 10.4 紧凑列表：一行一门课（状态、进度、截止、下一步），一张卡片内分隔线分行，不再一门一张大卡片 */}
          {shown.length > 0 ? (
            <ul className="ml-list">
              {shown.map((p) => {
                const st = learnStatusOf(p);
                const act = examAction(p, st);
                const step = nextStep(p, st, act);
                return (
                  <li key={p.id} className={canLeave(p) ? 'ml-li-menu' : undefined}>
                    <button
                      type="button"
                      className={'ml-row' + (st === 'overdue' ? ' is-overdue' : act ? ' is-exam' : '')}
                      data-status={st}
                      onClick={step.go}
                    >
                      <span className="ml-row-mark">
                        {p.mode === 'offline'
                          ? <span className="ml-venue" aria-hidden="true"><IcVenue /></span>
                          : <ProgressRing p={p.progress || 0} size={40} sm check={st === 'passed'} danger={st === 'overdue'} />}
                      </span>
                      <span className="ml-row-main">
                        <span className="ml-row-title">{loc(p, 'title')}</span>
                        <span className="ml-row-meta">
                          {metaLine(p, st, act)}
                        </span>
                        {isSelf(p) && p.publicClosed && st !== 'passed' && <span className="ml-closed-note">{s.closedNote}</span>}
                      </span>
                      {/* F46：「线下 / 自主学习」与状态胶囊同在状态格，和按钮同一中线、同一标签样式 */}
                      <span className="ml-row-status">
                        {p.mode === 'offline' && <span className="pill muted">{s.offlineTag}</span>}
                        {isSelf(p) && <span className="pill pri ml-self">{s.selfTag}</span>}
                        {statusPill(p, st)}
                      </span>
                      <span className="ml-row-due">{dueCell(p, st)}</span>
                      <span className="ml-row-act">
                        <span className={'btn sm' + (step.ghost ? ' ghost' : '')}>{step.label}</span>
                      </span>
                    </button>
                    {canLeave(p) && <RowMenu s={s} onLeave={() => setLeaveFor(p)} />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="ml-empty">{q ? s.noResult : s.empty}</div>
          )}
        </>
      )}
      {leaveFor && <LeaveDialog s={s} loc={loc} p={leaveFor} onClose={() => setLeaveFor(null)} onDone={() => { setLeaveFor(null); reload(); }} />}
    </div>
  );
}
