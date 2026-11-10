import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAsync, api, daysUntil, serverNow } from '../api.js';
import ProgressRing from '../components/ProgressRing.jsx';
import ModuleTrail from '../components/ModuleTrail.jsx';
import { useTrailSource, withFrom } from '../trailsource.js';

// Co-located bilingual UI strings for this screen (do NOT edit the shared dict).
const T = {
  zh: {
    inProgress: '进行中',
    notStarted: '未开始',
    ready: '待考试',
    passed: '已通过',
    pendingResult: '成绩待定',
    overdue: '已逾期',
    dueIn: (d) => (d <= 0 ? '今天截止' : `${d} 天后截止`),
    overallProgress: '总体进度',
    steps: '学习路径',
    module: '模块',
    minute: '分钟',
    done: '已完成',
    current: '进行中',
    locked: '未解锁',
    resume: '继续',
    start: '开始',
    review: '复习',
    finalExam: '结业考试',
    examLockedHint: '完成全部学习内容后解锁',
    passLine: '及格分',
    timeLimit: '限时',
    attempts: '已考次数',
    best: '最好成绩',
    minutes: (m) => `${m} 分钟`,
    unlimited: '不限',
    notYet: '—',
    startExam: '开始考试',
    // 10.8：考试未通过、还能再考 →「待补考」与「去补考」
    retakePending: '待补考', retraining: '重修中',
    retakeExam: '去补考',
    leftShort: (n) => `剩余 ${n} 次`,
    // 考试被挡住时的按钮字样 + 原因（原因写全，光把按钮置灰用户会以为页面坏了）
    usedUp: '考试次数已用完',
    cooling: '暂不可重考',
    attemptsGone: (n) => `已用完 ${n} 次考试机会。如需重考，请联系 HR。`,
    retakeInH: (h) => `约 ${h} 小时后可重考`,
    retakeInM: (m) => `约 ${m} 分钟后可重考`,
    retakeAt: (wait, at) => `${wait}（${at}）`,
    examQ: (n) => `${n} 题`,
    loading: '加载中…',
    error: '加载失败，请刷新页面重试。',
    notFound: '未找到该课程，或该课程未指派给你。',
    backToLearning: '返回我的课程',
  },
  en: {
    inProgress: 'In progress',
    notStarted: 'Not started',
    ready: 'Ready for exam',
    passed: 'Passed',
    pendingResult: 'Result pending',
    overdue: 'Overdue',
    dueIn: (d) => (d <= 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}`),
    overallProgress: 'Overall progress',
    steps: 'Learning path',
    module: 'modules',
    minute: 'min',
    done: 'Done',
    current: 'In progress',
    locked: 'Locked',
    resume: 'Resume',
    start: 'Start',
    review: 'Review',
    finalExam: 'Final exam',
    examLockedHint: 'Unlocks after all content is complete',
    passLine: 'Passing score',
    timeLimit: 'Time limit',
    attempts: 'Attempts used',
    best: 'Best score',
    minutes: (m) => `${m} min`,
    unlimited: 'Unlimited',
    notYet: '—',
    startExam: 'Start exam',
    retakePending: 'Retake pending', retraining: 'Re-study required',
    retakeExam: 'Retake exam',
    leftShort: (n) => (n === 1 ? '1 attempt left' : `${n} attempts left`),
    usedUp: 'No attempts left',
    cooling: 'Retake not yet available',
    attemptsGone: (n) => `All ${n} attempts used. Please contact HR if you need a retake.`,
    retakeInH: (h) => `Retake available in about ${h} hour${h === 1 ? '' : 's'}`,
    retakeInM: (m) => `Retake available in about ${m} minute${m === 1 ? '' : 's'}`,
    retakeAt: (wait, at) => `${wait} (${at})`,
    examQ: (n) => `${n} Q`,
    loading: 'Loading…',
    error: 'Couldn’t load. Refresh the page to try again.',
    notFound: 'This course was not found, or it is not assigned to you.',
    backToLearning: 'Back to My Courses',
  },
};

// Days until a due date (null when unknown); negative when overdue.
// Icons (inline SVG, stroke inherits) — copy Home/Course icon style.
const IcCheck = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
);
const IcLock = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
);
const IcArrow = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
const IcExam = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /><path d="M9 14l2 2 4-4" /></svg>
);
const IcClock = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);

// "MM-DD HH:MM", dropping the date when the moment is today — a bare HH:MM would
// read as today, and a 24h cooldown almost never ends on the same day.
const coolStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? clock : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${clock}`;
};

// When the retake reopens. retryAt is authoritative; without it we recompute the
// server's own rule (last attempt + retakeCooldownHours) so an older payload
// still gates the button instead of silently letting it through.
const retryAtOf = (ex) => {
  if (ex.retryAt) {
    const d = new Date(ex.retryAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (ex.lastAttemptAt && ex.retakeCooldownHours) {
    const d = new Date(ex.lastAttemptAt);
    if (!Number.isNaN(d.getTime()))
      return new Date(d.getTime() + Number(ex.retakeCooldownHours) * 3600000);
  }
  return null;
};

// Why this exam cannot be started, in the same order /api/exam/start rejects:
// not unlocked -> attempts exhausted -> cooldown. null means "go ahead".
// Mirrored client-side so the reason shows here rather than after three clicks.
const examBlock = (s, ex) => {
  if (!ex.unlocked) return { action: s.locked, why: s.examLockedHint };
  const max = Number(ex.maxAttempts) || 0;
  const used = Number(ex.attemptsUsed) || 0;
  if (max > 0 && used >= max) return { action: s.usedUp, why: s.attemptsGone(max) };
  const at = retryAtOf(ex);
  const mins = at ? Math.ceil((at.getTime() - serverNow()) / 60000) : 0;   // CX-156：按服务器时间
  if (mins > 0) {
    const wait = mins >= 60 ? s.retakeInH(Math.round(mins / 60)) : s.retakeInM(mins);
    return { action: s.cooling, why: s.retakeAt(wait, coolStamp(at)) };
  }
  return null;
};

export default function ProgramDetail() {
  const { lang, loc } = useI18n();
  // 页头路径与页间跳转按来源（D-29）：从培养项目进入时带 ?from=project:<id>
  const { src: trailSrc, head: trailHead } = useTrailSource();
  const nav = useNavigate();
  const { id } = useParams();
  const s = T[lang];

  const { loading, error, data } = useAsync(
    () => (id ? api.get(`/api/programs/${id}`) : Promise.resolve(null)),
    [id]
  );

  // Courses are the product now: a single-course wrapper with no exam has
  // nothing to show here — jump straight into the course itself.
  if (data && Array.isArray(data.courses) && data.courses.length === 1 && !(data.exams || []).length) {
    return <Navigate to={`/course/${data.courses[0].id}`} replace />;
  }

  // 第四批 7：没加入、但在课程目录里的公开课程 → 404 public_not_enrolled，转到课程目录并打开这门课的介绍
  if (error && error.status === 404 && error.data && error.data.code === 'public_not_enrolled') {
    return <Navigate to={`/catalog?open=${encodeURIComponent(error.data.programId || id)}`} replace />;
  }

  // Loading / error / not-found frames (keep the wrap + crumb chrome).
  if (loading) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          {s.loading}
        </div>
      </div>
    );
  }
  if (error && !(error.status === 404)) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          {s.error}
        </div>
      </div>
    );
  }
  if (!id || !data || (error && error.status === 404)) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '72px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          <p style={{ marginBottom: 16 }}>{s.notFound}</p>
          <button className="btn ghost" onClick={() => nav('/learning')}>{s.backToLearning}</button>
        </div>
      </div>
    );
  }

  const p = data;
  const courses = Array.isArray(p.courses) ? p.courses : [];
  const exams = Array.isArray(p.exams) ? p.exams : [];

  // Course states: done (>=100), current (first course still <100), else upcoming.
  const firstCurrentIdx = courses.findIndex((c) => (c.progress || 0) < 100);
  const courseState = (c, i) => {
    if ((c.progress || 0) >= 100) return 'done';
    if (i === firstCurrentIdx) return 'current';
    return 'upcoming';
  };

  // Overall hero status + due pill.
  const days = daysUntil(p.dueAt);
  const heroPill = () => {
    // 统一完成口径（2026-10-07）：服务端 done = programDone（有考试 = 通过且线下课程已出席 / 迟到；无考试 = 学完）。
    // done 为 false 时绝不显示「已完成 / 已通过」—— 逾期提醒邮件的链接打开的就是这一页，两边必须一致。
    // 旧服务端不带 done 时按原来的本地推算。
    const legacy = p.done === undefined;
    // 无结业考试：学完（100%）即「已完成」，没有「待考试」这一步
    if (p.hasExam === false && (legacy ? (p.progress || 0) >= 100 : p.done)) return <span className="pill ok"><IcCheck />{s.done}</span>;
    // CX-010（2026-10-09 验收）：自动重修把课程进度清空、考试重新锁定后，页头不再显示「已通过」，改为「重修中」
    if (!legacy && p.done && (p.progress || 0) < 100 && exams.some((e) => !e.unlocked)) return <span className="pill warn">{s.retraining}</span>;
    if (legacy ? (p.best && p.best.passed) : p.done) return <span className="pill ok"><IcCheck />{s.passed}</span>;
    if ((p.exams || []).some((e) => e.pending)) return <span className="pill pri">{s.pendingResult}</span>;
    if (days != null && days < 0) return <span className="pill warn">{s.overdue}</span>;
    // 考过但未通过（且还没用完次数）：「待补考」，与「课程」页同一口径（10.8）
    if (exams.some((e) => e.best && !e.best.passed && !(Number(e.maxAttempts) > 0 && (Number(e.attemptsUsed) || 0) >= Number(e.maxAttempts))))
      return <span className="pill fail">{s.retakePending}</span>;
    if ((p.progress || 0) >= 100) return <span className="pill pri">{s.ready}</span>;
    if ((p.progress || 0) > 0) return <span className="pill pri">{s.inProgress}</span>;
    return <span className="pill muted">{s.notStarted}</span>;
  };

  const openCourse = (c) => nav(withFrom(`/course/${c.id}`, trailSrc));
  const openExam = (ex) => { if (!examBlock(s, ex)) nav(withFrom(`/exam-prep/${id}/${ex.id}`, trailSrc)); };

  const statePill = (state) => {
    if (state === 'done') return <span className="pill ok"><IcCheck />{s.done}</span>;
    if (state === 'current') return <span className="pill pri">{s.current}</span>;
    return <span className="pill muted">{s.notStarted}</span>;
  };
  const courseAction = (state) =>
    state === 'done' ? s.review : state === 'current' ? s.resume : s.start;

  const attemptsLabel = (ex) => {
    const used = ex.attemptsUsed || 0;
    return `${used}/${ex.maxAttempts ? ex.maxAttempts : s.unlimited}`;
  };

  return (
    <div className="wrap">
      <ModuleTrail items={[...trailHead(lang, loc), { label: loc(p, 'title') }]} />

      {/* ---- program header ---- */}
      <div className="pg-head">
        <div className="pg-hbody">
          <div className="pg-htop">
            {heroPill()}
            {days != null && days >= 0 && <span className="pill warn"><IcClock />{s.dueIn(days)}</span>}
          </div>
          <h1 className="pg-title">{loc(p, 'title')}</h1>
          {loc(p, 'description') && <p className="pg-desc">{loc(p, 'description')}</p>}
        </div>
        <div className="pg-hring">
          <ProgressRing p={p.progress || 0} size={92} />
          <div className="pg-ringlab">{s.overallProgress}</div>
        </div>
      </div>

      {/* ---- step list ---- */}
      <div className="sec">
        <div className="sec-h"><h2>{s.steps}</h2><span className="count">{courses.length + exams.length}</span></div>

        <div className="pg-steps">
          {courses.map((c, i) => {
            const state = courseState(c, i);
            return (
              <button
                key={c.id}
                className={'pg-step' + (state === 'current' ? ' current' : '')}
                onClick={() => openCourse(c)}
              >
                <span className={'pg-mark ' + state}>
                  {state === 'done' ? <IcCheck /> : i + 1}
                </span>
                <div className="pg-info">
                  <div className="pg-steptitle">{loc(c, 'title')}</div>
                  <div className="pg-meta">
                    <span className="tnum">{c.moduleCount || 0}</span> {s.module}
                    <span className="pg-dot">·</span>
                    <span className="tnum">{c.minutes || 0}</span> {s.minute}
                  </div>
                </div>
                {/* F46：状态胶囊放在按钮左侧，与按钮同一中线 */}
                <span className="pg-stepst">{statePill(state)}</span>
                <span className={'btn sm' + (state === 'current' ? '' : ' ghost')}>
                  {courseAction(state)}<IcArrow />
                </span>
              </button>
            );
          })}

          {/* ---- exam steps ---- */}
          {exams.map((ex) => {
            const locked = !ex.unlocked;
            // Attempts used up / still cooling down are also non-starters, so they
            // grey the row out too — with block.why spelling out which one it is.
            const block = examBlock(s, ex);
            // CX-009（2026-10-09 验收）：题数与考前说明同一口径 —— itemCount（案例按小题展开）；旧服务端没有时按 mcq + open
            const questions = ex.itemCount != null && Number.isFinite(Number(ex.itemCount)) ? Number(ex.itemCount) : (ex.mcqCount || 0) + (ex.openCount || 0);
            const isRetake = !!(ex.best && !ex.best.passed);
            const maxA = Number(ex.maxAttempts) || 0;
            return (
              <button
                key={ex.id}
                className={'pg-step pg-exam' + (block ? ' locked' : '')}
                onClick={() => openExam(ex)}
                disabled={!!block}
              >
                <span className={'pg-mark ' + (block ? 'locked' : 'exam')}>
                  {block ? <IcLock /> : <IcExam />}
                </span>
                <div className="pg-info">
                  <div className="pg-steptitle">
                    {loc(ex, 'title') || s.finalExam}
                    <span className="pg-examq">{s.examQ(questions)}</span>
                  </div>
                  {locked ? (
                    <div className="pg-meta"><span className="pg-lockhint">{s.examLockedHint}</span></div>
                  ) : (
                    <>
                      <div className="pg-examstats">
                        <span className="pg-stat"><b>{s.passLine}</b><span className="tnum">{ex.passingScore}%</span></span>
                        <span className="pg-stat"><b>{s.timeLimit}</b><span className="tnum">{ex.timeLimitMinutes != null ? s.minutes(ex.timeLimitMinutes) : s.notYet}</span></span>
                        <span className="pg-stat"><b>{s.attempts}</b><span className="tnum">{attemptsLabel(ex)}</span></span>
                        <span className="pg-stat"><b>{s.best}</b><span className="tnum">{ex.best != null ? ex.best.percent + '%' : s.notYet}</span></span>
                      </div>
                      {block && (
                        <div className="pg-meta"><span className="pg-lockhint">{block.why}</span></div>
                      )}
                      {!block && isRetake && maxA > 0 && (
                        <div className="pg-meta"><span className="pg-lockhint">{s.leftShort(Math.max(0, maxA - (Number(ex.attemptsUsed) || 0)))}</span></div>
                      )}
                    </>
                  )}
                </div>
                <span className={'btn sm' + (block ? ' ghost' : '')}>
                  {block ? block.action : isRetake ? s.retakeExam : s.startExam}{!block && <IcArrow />}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
