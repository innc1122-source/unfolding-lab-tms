import { modOn } from '../rbac.js';
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useAsync, api } from '../api.js';
import { ProfileTabs } from '../profileTabs.js';
import ModuleTrail from '../components/ModuleTrail.jsx';
import { learningHoursOf } from '../catalog.js';

// Co-located bilingual UI strings (do NOT edit the shared i18n dictionary).
const T = {
  zh: {
    title: '成长档案',
    sub: '成长轨迹与学习记录。潜力评级、人才标签等 HR 内部评估信息不在本页显示。',
    passAtLeast: (n) => `及格分 ${n}%`,
    tabGrowth: '成长轨迹', viewSwitch: '切换视图',
    lrTitle: '学习记录', lrHint: '点击任一行查看模块完成情况与考试记录',
    colProgram: '课程', colStatus: '状态', colProgress: '进度', colBest: '最好成绩',
    colPassed: '通过日期',
    passed: '已通过', failed: '未通过', progress: '进行中', ready: '待考试',
    overdue: '逾期', notStarted: '未开始',
    noAttempt: '暂无记录', dash: '—',
    histTitle: '考试记录', modTitle: '模块完成情况', nth: (n) => `第 ${n} 次`,
    hDate: '日期', hTime: '用时', hScore: '成绩', hResult: '结果',
    resultPass: '通过', resultFail: '未通过', resultGrading: '评分中', resultReview: '待复核', manualTag: '简答题待评分',
    viewAnswers: '查看答卷', bestTag: '最好', adjTag: '成绩经 HR 调整', dur: (m, ss) => `${m} 分 ${ss} 秒`,
    appeal: '申诉', appealAgain: '再次申诉', apOpen: '申诉处理中', apAccepted: '申诉成立', apRejected: '申诉已驳回',
    apAsk: '请说明你认为判分有误之处', apPh: '例如：第 3 题我的答案与标准答案意思一致，但被判为错误…',
    apMine: '我的申诉：', apReply: 'HR 回复：', apSend: '提交申诉', apCancel: '取消',
    apHint: '提交后 HR 会复核这份答卷，也可以对简答题的 AI 初评提出申诉；结果会通知你。至少 10 个字。',
    gTitle: '成长轨迹', gLead: '记录你在公司的关键经历，包括入职、培训、荣誉与晋升。',
    gHired: '入职日期', gTenure: '司龄', gTenureFmt: (y, m) => (y ? `${y} 年 ${m} 个月` : `${m} 个月`),
    gRecords: '成长记录', gAwards: '荣誉', gPromos: '晋升',
    gAll: '全部', gTrainings: '培训', gFilter: '成长轨迹筛选',
    gProgress: '进度', gBest: '考试最好成绩', gRank: '同期排名', gPass: '通过', gFail: '未通过',
    gEmpty: '暂无成长记录。完成培训、获得荣誉或晋升后将在此显示。',
    probation: '试用期', regular: '正式', exited: '已离职',
    loading: '加载中…', error: '加载失败，请刷新页面重试。',
    empty: '暂无学习记录', emptyDetail: '暂无详情',
    // 模块页签（web/src/profileTabs.js）：tablist 的无障碍名 / 占位 / 加载中 / 出错。
    tabsLabel: '模块页签', tabSoon: '该模块内容即将上线', tabLoading: '加载中…',
    tabFailed: '这个页签加载失败，请刷新页面重试',
    // 第四批 7 / 9.6：累计学时（已完成课程 × 学时），自主学习的部分单独列出
    selfTag: '自主学习',
    hoursTotal: (h) => `累计学时 ${h} 小时`,
    hoursSplit: (a, b) => `（指派 ${a} 小时 · 自主学习 ${b} 小时）`,
    hoursHint: '已完成课程的学时合计，含从「公开课」自主学习的课程',
  },
  en: {
    title: 'Development Record',
    sub: 'Your growth timeline and learning record. HR-internal assessments such as potential rating and talent tags are not shown here.',
    passAtLeast: (n) => `Passing score ${n}%`,
    tabGrowth: 'Growth Timeline', viewSwitch: 'Switch view',
    lrTitle: 'Learning Record', lrHint: 'Select a row to see module completion and exam attempts',
    colProgram: 'Course', colStatus: 'Status', colProgress: 'Progress', colBest: 'Best score',
    colPassed: 'Passed on',
    passed: 'Passed', failed: 'Not passed', progress: 'In progress', ready: 'Ready for exam',
    overdue: 'Overdue', notStarted: 'Not started',
    noAttempt: 'No attempts', dash: '—',
    histTitle: 'Exam Attempts', modTitle: 'Module Completion', nth: (n) => `Attempt ${n}`,
    hDate: 'Date', hTime: 'Time taken', hScore: 'Score', hResult: 'Result',
    resultPass: 'Passed', resultFail: 'Not passed', resultGrading: 'Scoring', resultReview: 'Awaiting review', manualTag: 'Short answer awaiting scoring',
    viewAnswers: 'View answers', bestTag: 'Best', adjTag: 'Adjusted by HR', dur: (m, ss) => `${m}m ${ss}s`,
    appeal: 'Appeal', appealAgain: 'Appeal again', apOpen: 'Under review', apAccepted: 'Upheld', apRejected: 'Rejected',
    apAsk: 'Explain which answers you believe were marked incorrectly', apPh: 'e.g. Question 3 — my answer means the same as the key but was marked incorrect…',
    apMine: 'Your appeal: ', apReply: 'HR reply: ', apSend: 'Submit appeal', apCancel: 'Cancel',
    apHint: 'HR will re-check this paper; you can also appeal an AI pre-score of a short answer. You will be notified of the result. At least 10 characters.',
    gTitle: 'Growth Timeline', gLead: 'Key events in your time with the company, including joining, training, awards and promotions.',
    gHired: 'Hire date', gTenure: 'Tenure', gTenureFmt: (y, m) => (y ? `${y} yr ${m} mo` : `${m} mo`),
    gRecords: 'Records', gAwards: 'Awards', gPromos: 'Promotions',
    gAll: 'All', gTrainings: 'Learning', gFilter: 'Filter timeline',
    gProgress: 'Progress', gBest: 'Best exam score', gRank: 'Cohort rank', gPass: 'Passed', gFail: 'Not passed',
    gEmpty: 'No records yet. Training completions, awards and promotions will appear here.',
    probation: 'Probation', regular: 'Regular', exited: 'Separated',
    loading: 'Loading…', error: 'Couldn’t load. Refresh the page to try again.',
    empty: 'No learning records yet', emptyDetail: 'No details',
    tabsLabel: 'Module tabs', tabSoon: 'Content for this module is coming soon', tabLoading: 'Loading…',
    tabFailed: 'This tab failed to load — refresh the page to try again',
    selfTag: 'Self-directed',
    hoursTotal: (h) => `${h} learning hour${Number(h) === 1 ? '' : 's'}`,   // CX-194：单复数
    hoursSplit: (a, b) => ` (assigned ${a} h · self-directed ${b} h)`,
    hoursHint: 'Hours of the courses you have completed, including self-directed courses from Public Courses',
  },
};

// 「这个值该不该连标签一起渲染」的唯一判据。刻意 **不** 写成 `v ||`：0 和 false 都是
// 合法值，用真值判断会把它们当空值藏掉，标签也一起消失。只有 null / undefined /
// 空串 / 纯空白算空。
function hasVal(v) {
  return v != null && String(v).trim() !== '';
}

// ISO -> YYYY-MM-DD (null-safe).
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Attempt duration as whole minutes + seconds. The server's durationMin is a
// one-decimal minute count ("14.3"), which reads as a broken number, so derive
// the real seconds from the two timestamps it also sends; durationMin is only a
// fallback (and is NaN on an attempt that was never submitted).
function durParts(a) {
  let sec = null;
  if (a.startedAt && a.submittedAt) {
    const ms = new Date(a.submittedAt).getTime() - new Date(a.startedAt).getTime();
    if (Number.isFinite(ms) && ms >= 0) sec = Math.round(ms / 1000);
  }
  if (sec == null && Number.isFinite(a.durationMin)) sec = Math.round(a.durationMin * 60);
  if (sec == null) return null;
  return { m: Math.floor(sec / 60), ss: String(sec % 60).padStart(2, '0') };
}

export default function Record() {
  const { lang, loc } = useI18n();
  const nav = useNavigate();
  const s = T[lang];
  // Page shell + growth timeline are core and always render; the learning-record
  // half (exam history, appeals) belongs to the learning module. A /api/me
  // payload without `modules` is an older server: everything stays on.
  const { user } = useAuth();
  const learningOn = modOn(user && user.modules, 'learning');
  const [open, setOpen] = useState(null);
  // Which half is on screen. Only the phone layout acts on it (the tab row is
  // hidden above 820px, where both halves are shown side by side). 'growth' is
  // the default, so with learning off nothing ever selects the hidden half.
  // 从考试结果页「查看学习记录」进入时直接打开学习记录页签（路由 state.tab = 'learn'）
  const { state: navState } = useLocation();
  const [tab, setTab] = useState(navState && navState.tab === 'learn' ? 'learn' : 'growth');
  // Per-program detail cache: { [id]: { loading, error, data } }.
  const [details, setDetails] = useState({});

  // /api/me/growth feeds the growth pane AND carries this page's module tabs
  // (`tabs`, audience "self"), so it is fetched here once and handed down.
  // Declared before the learning-record query so the two requests go out in the
  // same order as when GrowthSection fetched it itself.
  const growthQ = useAsync(() => api.get('/api/me/growth'), []);
  // With learning off the endpoint is gone (404) and the pane is hidden — skip
  // the request rather than collecting an error nobody renders.
  const { loading, error, data } = useAsync(() => (learningOn ? api.get('/api/me/learning-record') : Promise.resolve(null)), [learningOn]);
  // 第四批 7：接口可能是数组（旧）或 { items, totals }（新增 hoursDone / hoursSelf）—— learningHoursOf 两种都认
  const hours = learningHoursOf(data);
  const records = hours.items;
  const fmtH = (h) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

  const loadDetail = (id) => {
    setDetails((d) => ({ ...d, [id]: { loading: true, error: null, data: null } }));
    api.get(`/api/me/programs/${id}/record`).then(
      (rec) => setDetails((d) => ({ ...d, [id]: { loading: false, error: null, data: rec } })),
      (err) => setDetails((d) => ({ ...d, [id]: { loading: false, error: err, data: null } })),
    );
  };

  // Grade appeal: which attempt is being appealed, and the text so far. Only one
  // form is open at a time — appealing is deliberate, not a bulk action.
  const [appealFor, setAppealFor] = useState(null);
  const [appealText, setAppealText] = useState('');
  const [appealBusy, setAppealBusy] = useState(false);
  const [appealErr, setAppealErr] = useState('');

  const openAppeal = (id) => { setAppealFor(id); setAppealText(''); setAppealErr(''); };
  const submitAppeal = async (programId, attemptId) => {
    setAppealBusy(true); setAppealErr('');
    try {
      await api.post(`/api/me/attempts/${attemptId}/appeal`, { reason: appealText.trim() });
      setAppealFor(null);
      loadDetail(programId); // pull the row back with its new appeal state
    } catch (err) { setAppealErr(err.message); }
    setAppealBusy(false);
  };
  const toggle = (id) => {
    setOpen((cur) => {
      const next = cur === id ? null : id;
      if (next && !details[id]) loadDetail(id); // cache: only fetch once
      return next;
    });
  };

  const CaretIcon = ({ up }) => (
    <svg className="ic sm rec-caret" viewBox="0 0 24 24" style={up ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );

  const statusPill = (r) => {
    if (r.status === 'passed')
      return <span className="pill ok"><svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>{s.passed}</span>;
    if (r.status === 'notstarted')
      return <span className="pill muted">{s.notStarted}</span>;
    if (r.status === 'overdue')
      return <span className="pill warn">{s.overdue}</span>;
    if (r.status === 'failed')
      return <span className="pill fail">{s.failed}</span>;
    if (r.status === 'ready')
      return <span className="pill pri">{s.ready}</span>;
    return <span className="pill pri">{s.progress}</span>;
  };

  const bestCell = (r) => {
    if (r.bestPercent == null) return <span className="rec-muted">{s.dash}</span>;
    const pass = r.passingScore != null ? r.passingScore : 80;
    // F57: colour by the stored pass/fail of the best attempt (server bestPassed); the
    // rounded percent can read 87% for an 86.5% fail. Older servers without it: old rule.
    const cls = (r.bestPassed != null ? r.bestPassed : r.bestPercent >= pass) ? 'ok' : 'warn';
    return <span className={'tnum rec-best ' + cls}>{Math.round(r.bestPercent)}%</span>;
  };

  // Module completion, which is the only thing that separates an in-progress row
  // from an overdue one at a glance — both have "—" for score and pass date.
  const progressCell = (r) => {
    if (r.progress == null) return <span className="rec-muted">{s.dash}</span>;
    const pct = Math.max(0, Math.min(100, Math.round(r.progress)));
    return (
      <span className={'rec-prg' + (pct >= 100 ? ' done' : '')}>
        <span className="rec-prg-track"><i style={{ width: pct + '%' }} /></span>
        <b className="tnum">{pct}%</b>
      </span>
    );
  };

  const renderDetail = (r) => {
    const d = details[r.id];
    if (!d || d.loading) return <div className="rec-hist-h">{s.loading}</div>;
    if (d.error) return <div className="rec-hist-h">{s.error}</div>;
    const rec = d.data || {};
    const courses = rec.courses || [];
    const exams = rec.exams || [];
    if (courses.length === 0 && exams.length === 0)
      return <div className="rec-hist-h">{s.emptyDetail}</div>;

    return (
      <>
        {courses.map((c) => (
          <div key={c.id} className="rec-modblock">
            <div className="rec-hist-h">{s.modTitle} · {loc(c, 'title')}</div>
            <div className="rec-mods">
              {(c.modules || []).map((m) => (
                <span key={m.id} className={'rec-mod' + (m.doneAt ? ' done' : '')}>
                  {m.doneAt
                    ? <svg className="ic sm ok" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
                    : <svg className="ic sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></svg>}
                  {loc(m, 'title')}
                </span>
              ))}
            </div>
          </div>
        ))}

        {exams.map((ex) => {
          const attempts = [...(ex.attempts || [])].reverse(); // newest first
          // Tag exactly ONE row "Best" — the highest-scoring attempt (earliest on
          // a tie) — instead of every attempt that ties the best score.
          const top = attempts.reduce(
            (b, a) => (!b || a.percent > b.percent || (a.percent === b.percent && a.n < b.n) ? a : b), null);
          const bestId = top && r.bestPercent != null && top.percent === r.bestPercent ? top.id : null;
          return (
            <div key={ex.id} className="rec-examblock">
              <div className="rec-hist-h">
                {s.histTitle} · {loc(ex, 'title')}
                {ex.passingScore != null && <span className="rec-passtag">{s.passAtLeast(ex.passingScore)}</span>}
              </div>
              {attempts.length === 0 ? (
                <div className="rec-muted">{s.noAttempt}</div>
              ) : (
                <div className="rec-htable">
                  <div className="rec-hrow2 rec-hhead">
                    <span className="rec-h-n">#</span>
                    <span className="rec-h-date">{s.hDate}</span>
                    <span className="rec-h-time">{s.hTime}</span>
                    <span className="rec-h-score">{s.hScore}</span>
                    <span className="rec-h-res">{s.hResult}</span>
                    <span className="rec-h-act" />
                  </div>
                  {attempts.map((a) => {
                    const dur = durParts(a);
                    return (
                      // The appeal state block and the appeal form are full-width
                      // panels, not a 7th cell of the 6-track attempt grid, so
                      // they sit beside the row rather than inside it.
                      <div key={a.id} className="rec-hgroup">
                        <div className="rec-hrow2">
                          <span className="rec-h-n tnum">{s.nth(a.n)}</span>
                          <span className="rec-h-date tnum">{fmtDate(a.submittedAt) || fmtDate(a.startedAt) || s.dash}</span>
                          <span className="rec-h-time tnum">
                            {dur ? s.dur(dur.m, dur.ss) : s.dash}
                          </span>
                          <span className="rec-h-score tnum">
                            <b className={a.passed ? 'rec-best ok' : 'rec-best warn'}>{Math.round(a.percent)}%</b>
                            {a.id === bestId && <span className="rec-tag">{s.bestTag}</span>}
                            {a.adjusted && <span className="rec-tag">{s.adjTag}</span>}
                          </span>
                          <span className="rec-h-res">
                            {a.gradingStatus === 'grading' ? <span className="pill muted">{s.resultGrading}</span>
                              : a.gradingStatus === 'pending_review' ? <span className="pill pri">{s.resultReview}</span>
                                : a.passed
                                  ? <span className="pill ok"><svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>{s.resultPass}</span>
                                  : <span className="pill fail">{s.resultFail}</span>}
                            {a.gradingStatus === 'manual_pending' && <span className="rec-tag">{s.manualTag}</span>}
                          </span>
                          <span className="rec-h-act">
                            {ex.showAnswersAfterExam ? (
                              <button className="btn ghost sm" onClick={() => nav(`/result/${a.id}`)}>
                                {s.viewAnswers}
                                <svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                              </button>
                            ) : (
                              <span className="rec-muted">{s.dash}</span>
                            )}
                            {/* Appealing is only meaningful while the result stands:
                                not on a voided paper, not while one is already open,
                                and not once it has been accepted and actioned. */}
                            {!a.voided && (!a.appeal || a.appeal.status === 'rejected') && (
                              <button className="rec-appeal-link" onClick={() => openAppeal(a.id)}>
                                {a.appeal ? s.appealAgain : s.appeal}
                              </button>
                            )}
                          </span>
                        </div>
                        {/* Appeal state for this attempt, below its row. */}
                        {a.appeal && (
                          <div className={'rec-appeal rec-appeal--' + a.appeal.status}>
                            <span className={'pill ' + (a.appeal.status === 'open' ? 'warn' : a.appeal.status === 'accepted' ? 'ok' : 'fail')}>
                              {a.appeal.status === 'open' ? s.apOpen : a.appeal.status === 'accepted' ? s.apAccepted : s.apRejected}
                            </span>
                            <div className="rec-appeal-body">
                              {/* 「我的申诉：」是本页唯一一个带冒号、却没有守卫的标签：值为空
                                  时会只剩一个空冒号。两行现在用同一条规则——值去空白后为空
                                  就整行不渲染（HR 回复那行本来就有守卫，这里补齐它的孪生条件）。
                                  用 hasVal（!= null 判空）而不是 `v ||`：0 和 false 是合法值，
                                  不能被当成空值藏掉。这两个字段现在是文本，但守卫要照抄给别处，
                                  所以规则本身必须是 0-safe 的。 */}
                              {hasVal(a.appeal.reason) && <div className="rec-appeal-mine"><b>{s.apMine}</b>{a.appeal.reason}</div>}
                              {hasVal(a.appeal.resolution) && <div className="rec-appeal-reply"><b>{s.apReply}</b>{a.appeal.resolution}</div>}
                            </div>
                          </div>
                        )}
                        {appealFor === a.id && (
                          <div className="rec-appeal rec-appeal--form">
                            <label className="rec-appeal-lab" htmlFor={'ap-' + a.id}>{s.apAsk}</label>
                            <textarea id={'ap-' + a.id} className="rv-ta" rows={3} value={appealText}
                              placeholder={s.apPh} onChange={(e) => setAppealText(e.target.value)} />
                            <div className="rec-appeal-foot">
                              <button className="btn sm" disabled={appealBusy || appealText.trim().length < 10}
                                onClick={() => submitAppeal(r.id, a.id)}>{s.apSend}</button>
                              <button className="btn ghost sm" onClick={() => setAppealFor(null)}>{s.apCancel}</button>
                              {appealErr && <span className="rv-msg err">{appealErr}</span>}
                              {!appealErr && <span className="rec-appeal-hint">{s.apHint}</span>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div className={'wrap rec-wrap rec-view-' + tab}>
      <ModuleTrail items={[{ label: s.title }]} />

      <div className="rec-head">
        <div>
          <h1 className="rec-title">{s.title}</h1>
          <div className="rec-sub">{s.sub}</div>
        </div>
      </div>

      {/* A one-view page needs no switcher: with learning off only the growth
          half exists, so the tab row goes with the learning pane. */}
      {/* Layout v2：左侧固定栏放身份与统计（GrowthMeta），右侧是页签与两块内容；v2.css .v2-record-workspace */}
      <div className="v2-record-workspace">
      <aside className="v2-record-rail"><GrowthMeta s={s} d={growthQ.data} /></aside>
      <div className="v2-record-main">
      {learningOn && (
        <div className="rec-tabs v2-record-tabs" role="group" aria-label={s.viewSwitch}>
          <button className={'rec-tab' + (tab === 'growth' ? ' active' : '')}
            aria-pressed={tab === 'growth'} onClick={() => setTab('growth')}>{s.tabGrowth}</button>
          <button className={'rec-tab' + (tab === 'learn' ? ' active' : '')}
            aria-pressed={tab === 'learn'} onClick={() => setTab('learn')}>{s.lrTitle}</button>
        </div>
      )}

      <div className="rec-pane rec-pane--growth">
        <GrowthSection s={s} loc={loc} q={growthQ} />
      </div>

      {learningOn && (
      <div className="rec-pane rec-pane--learn">
        <div className="sec-h rec-sec-h">
          <h2>{s.lrTitle}</h2>
          {/* The count and the "rows open" hint are only true once rows exist. */}
          {!loading && !error && records.length > 0 && (
            <>
              <span className="count tnum">{records.length}</span>
              <span className="rec-sec-hint">{s.lrHint}</span>
            </>
          )}
        </div>
        {!loading && !error && hours.known && (
          <div className="rec-hours" title={s.hoursHint}>
            <b className="tnum">{s.hoursTotal(fmtH(hours.total))}</b>
            {hours.self > 0 && <span className="tnum">{s.hoursSplit(fmtH(hours.assigned), fmtH(hours.self))}</span>}
          </div>
        )}
        {loading ? (
          <div className="card rec-card"><div className="rec-hist-h">{s.loading}</div></div>
        ) : error ? (
          <div className="card rec-card"><div className="rec-hist-h">{s.error}</div></div>
        ) : records.length === 0 ? (
          <div className="card rec-card"><div className="rec-hist-h">{s.empty}</div></div>
        ) : (
          <div className="card rec-card">
            <div className="rec-table">
              <div className="rec-row rec-hrow">
                <span className="rec-c-prog">{s.colProgram}</span>
                <span className="rec-c-stat">{s.colStatus}</span>
                <span className="rec-c-prg">{s.colProgress}</span>
                <span className="rec-c-best">{s.colBest}</span>
                <span className="rec-c-date">{s.colPassed}</span>
                <span className="rec-c-caret" />
              </div>

              {records.map((r) => {
                const isOpen = open === r.id;
                const hasDetail = (r.courseCount || 0) > 0 || (r.examCount || 0) > 0;
                const passedOn = fmtDate(r.passedAt);
                return (
                  <div key={r.id} className={'rec-group' + (isOpen ? ' open' : '')}>
                    <button
                      className="rec-row rec-drow"
                      onClick={() => hasDetail && toggle(r.id)}
                      disabled={!hasDetail}
                      aria-expanded={isOpen}
                    >
                      <span className="rec-c-prog rec-prog">
                        {loc(r, 'title')}
                        {r.source === 'self' && <span className="pill pri rec-self">{s.selfTag}</span>}
                      </span>
                      <span className="rec-c-stat">{statusPill(r)}</span>
                      <span className="rec-c-prg" data-lab={s.colProgress}>{progressCell(r)}</span>
                      <span className="rec-c-best" data-lab={s.colBest}>{bestCell(r)}</span>
                      <span className="rec-c-date tnum" data-lab={s.colPassed}>
                        {passedOn ? passedOn : <span className="rec-muted">{s.dash}</span>}
                      </span>
                      <span className="rec-c-caret">
                        {hasDetail && <CaretIcon up={isOpen} />}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="rec-hist">
                        {renderDetail(r)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      )}

      </div>
      </div>

      {/* Module tabs (manifest extensions["profile.tabs"], audience "self").
          No module registers one yet: tabs is [] and this renders nothing. */}
      <ProfileTabs tabs={growthQ.data && growthQ.data.tabs} userId={user && user.id} audience="self" lang={lang}
        s={{ label: s.tabsLabel, soon: s.tabSoon, loading: s.tabLoading, failed: s.tabFailed }} cls={TAB_CLS} />
    </div>
  );
}

// Module-tab section styling: the page's own section heading + filter chips.
const TAB_CLS = { wrap: 'sec', head: 'sec-h', bar: 'ml-filters', tab: 'ml-chip', on: 'active', empty: 'ml-empty' };

// Timeline node mark. The dot is the whole visual at that spot, so it keeps a
// glyph instead of sitting empty: a building for joining the company, an open
// book for a training, and a plain ring for every other record — whose type is
// already named on the pill beside it and carried by the dot's colour.
function EvIcon({ kind }) {
  if (kind === 'hired')
    return (
      <svg className="ic grw-dot-ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h16M7 20V4h10v16M11 20v-5h2v5" />
      </svg>
    );
  if (kind === 'lms')
    return (
      <svg className="ic grw-dot-ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 6v14M12 6H5v13h7M12 6h7v13h-7" />
      </svg>
    );
  return (
    <svg className="ic grw-dot-ic" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

// 身份行要用的三个派生值（GrowthMeta 与 GrowthSection 共用）
function growthIdentity(s, d) {
  const tenure = (() => {
    if (!d.me.hireDate) return null;
    const h = new Date(d.me.hireDate + 'T00:00:00');
    if (Number.isNaN(h.getTime()) || h > new Date()) return null;
    const months = Math.floor((Date.now() - h.getTime()) / (30.44 * 86400000));
    return s.gTenureFmt(Math.floor(months / 12), months % 12);
  })();
  const stLabel = d.me.empStatus ? s[d.me.empStatus] : null;
  // An admin account carries no level / position / hire date — without this the
  // identity block renders as an empty flex child and the counts sit alone.
  const hasIdentity = !!(d.me.jobLevel || stLabel || d.me.position || d.me.hireDate || tenure);
  return { tenure, stLabel, hasIdentity };
}

// Layout v2：身份与统计搬到成长档案左侧固定栏（.v2-record-rail），数据仍是 Record 持有的 /api/me/growth 查询。
function GrowthMeta({ s, d }) {
  if (!d) return null;
  const { tenure, stLabel, hasIdentity } = growthIdentity(s, d);
  return (
    <div className="grw-meta">
      {hasIdentity && (
        <div className="grw-ident">
          {d.me.jobLevel && <span className="pill pri">{d.me.jobLevel}</span>}
          {stLabel && <span className={'pill ' + (d.me.empStatus === 'regular' ? 'ok' : d.me.empStatus === 'exited' ? 'muted' : 'warn')}>{stLabel}</span>}
          {d.me.position && <b>{d.me.position}</b>}
          {d.me.hireDate && <span>{s.gHired} <b className="tnum">{d.me.hireDate}</b></span>}
          {tenure && <span>{s.gTenure} <b>{tenure}</b></span>}
        </div>
      )}
      <div className="grw-stats">
        <span className="pill muted">{s.gRecords} <b className="tnum">{d.stats.records}</b></span>
        <span className="pill warn">{s.gAwards} <b className="tnum">{d.stats.awards}</b></span>
        <span className="pill ok">{s.gPromos} <b className="tnum">{d.stats.promotions}</b></span>
      </div>
    </div>
  );
}

/* ---- my growth timeline (Phase 5) — server pre-renders visible lines; the
   admin field config and hidden record types never reach the employee. ---- */
// `q` is the /api/me/growth query, owned by Record (it also carries the tabs).
function GrowthSection({ s, loc, q }) {
  const [tl, setTl] = useState('all'); // timeline filter: 'all' | 'lms' | 'type:<label>'
  const d = q.data;
  if (!d) return null;
  const { tenure, stLabel, hasIdentity } = growthIdentity(s, d); // eslint-disable-line no-unused-vars

  // Filter chips come from what this person actually has: the training stream,
  // plus one chip per record type present, labelled as HR configured it (the
  // events only expose the label, never the internal key). The label alone names
  // the stream, so the chip carries no glyph. The hire milestone belongs to no
  // type, so it lives under "all" only — which is what the design shows.
  const chips = [{ key: 'all', label: s.gAll, n: d.events.length }];
  const byKey = new Map();
  for (const e of d.events) {
    const key = e.kind === 'lms' ? 'lms' : e.kind === 'record' ? 'type:' + e.typeLabel : null;
    if (!key) continue;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        label: e.kind === 'lms' ? s.gTrainings : loc(e, 'typeLabel'),
        n: 0,
      };
      byKey.set(key, g);
      chips.push(g);
    }
    g.n++;
  }
  const shown = tl === 'all'
    ? d.events
    : d.events.filter((e) => (tl === 'lms' ? e.kind === 'lms' : e.kind === 'record' && 'type:' + e.typeLabel === tl));

  return (
    <div className="card grw-card">
      <div className="grw-head">
        <h2>{s.gTitle}</h2>
        <span className="grw-count tnum">{d.events.length}</span>
        <span className="grw-lead">{s.gLead}</span>
      </div>
      {/* One event is still a timeline — a new hire has only the joining line and
          must see it, not "nothing here yet". */}
      {/* A lone "all" chip filters nothing, so the row only appears once there is
          more than one stream to switch between. */}
      {chips.length > 1 && (
        <div className="ml-filters grw-filters" role="group" aria-label={s.gFilter}>
          {chips.map((c) => (
            <button key={c.key} className={'ml-chip' + (tl === c.key ? ' active' : '')}
              aria-pressed={tl === c.key} onClick={() => setTl(c.key)}>
              {c.label}
              <span className="ml-chip-n tnum">{c.n}</span>
            </button>
          ))}
        </div>
      )}
      {d.events.length === 0 ? (
        <div style={{ color: 'var(--ink-3)', fontSize: 13, padding: '10px 0' }}>{s.gEmpty}</div>
      ) : (
        <div className="ppl-tl">
          {shown.map((e, i) => (
            <div className="ppl-ev" key={i}>
              {/* color feeds currentColor, so the mark inside matches the ring. */}
              <span className="ppl-dot" style={{ borderColor: e.color || 'var(--brand)', color: e.color || 'var(--brand)' }}>
                <EvIcon kind={e.kind} />
              </span>
              <div className="ppl-ev-card">
                <div className="ppl-ev-head">
                  <span className="ppl-ev-date tnum">{e.date}</span>
                  {e.typeLabel && <span className="ppl-ev-pill" style={{ background: e.color || 'var(--brand)' }}>{loc(e, 'typeLabel')}</span>}
                  {/* LMS-derived events carry both titles; without loc() the
                      Chinese UI showed the English programme name. */}
                  {/* 标题可能是空的（服务端不再把类型名写进库），用类型名顶上。 */}
                  <span className="ppl-ev-title">{loc(e, 'title') || loc(e, 'typeLabel')}</span>
                </div>
                {e.kind === 'lms' && e.lms && (
                  <div className="ppl-ev-body">
                    <span className="ppl-kv"><span className="k">{s.gProgress}</span><b className="tnum">{e.lms.progress}%</b></span>
                    {e.lms.best && <span className="ppl-kv"><span className="k">{s.gBest}</span><b className="tnum">{e.lms.best.percent}%</b> <span className={'pill ' + (e.lms.best.passed ? 'ok' : 'fail')}>{e.lms.best.passed ? s.gPass : s.gFail}</span></span>}
                    {e.lms.rank && <span className="ppl-kv"><span className="k">{s.gRank}</span><b className="tnum">{e.lms.rank}/{e.lms.cohort}</b></span>}
                  </div>
                )}
                {/* 与申诉那两行同一条规则：值去空白后为空的字段整行不渲染，不留
                    一个只有标签、后面空着的键值对（服务端只滤掉 null 和 ""，纯空白
                    的值会漏过来）。全部被滤掉时连外层 body 也不渲染。 */}
                {e.kind === 'record' && e.lines.some((l) => hasVal(loc(l, 'value'))) && (
                  <div className="ppl-ev-body">
                    {/* Both the field NAME and its VALUE are bilingual: a select
                        field stores the canonical option string ("Passed"), and
                        the server sends the Chinese display name alongside it,
                        so a value needs loc() exactly like the label does.
                        Free-text and number values carry no _zh and fall
                        through to the stored string. */}
                    {e.lines.filter((l) => hasVal(loc(l, 'value'))).map((l, j) => <span className="ppl-kv" key={j}><span className="k">{loc(l, 'label')}</span><b>{loc(l, 'value')}</b></span>)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
