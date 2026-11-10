import { datetime } from '../fmt.js';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { api, useAsync } from '../api.js';
import ProgressRing from '../components/ProgressRing.jsx';
import ModuleTrail from '../components/ModuleTrail.jsx';
import { useTrailSource, withFrom } from '../trailsource.js';
// 第四批 6.1（2026-10-08）：逐题回顾按题型注册表渲染（web/src/qtypes 的 Review 部件），题型名取 spec.js；
// 每题得分与对错状态用 qtypes/model.js 的 earnedOf / maxOf / stateOf（新题型 = 分值 × credit，老题型沿用旧口径）。
import { qtype, typeLabel, stemOf } from '../qtypes/views.jsx';   // 简化 10/11：员工端只引作答 / 回顾部件，不带编辑器
import { earnedOf, maxOf, stateOf } from '../qtypes/model.js';

// Co-located bilingual UI strings (do not touch the shared i18n dictionary).
const T = {
  zh: {
    examResult: '考试结果',
    passed: '已通过', failed: '未通过',
    passNote: '已达到及格分。成绩已记入你的学习记录。',
    failNote: '本次未达到及格分，重考等待期结束后可再次参加考试。',
    // CX-003（2026-10-09 验收）：按补考状态分三种文案，并给「去补考」入口
    failReady: (left) => left == null ? '本次未达到及格分，可以再次参加考试（不限次数）。' : `本次未达到及格分，可以再次参加考试（剩余 ${left} 次）。`,
    failWaiting: (at) => `本次未达到及格分，重考等待期到 ${at} 结束后可再次参加考试。`,
    failUsedUp: '本次未达到及格分，考试次数已用完，请联系 HR。',
    goRetake: '去补考',
    retrainNote: '已达尝试次数上限：系统已自动重置本课程进度与考试机会，请重新完成课程模块后再次参加考试。',
    passLine: (n) => `及格分 ${n}%`, yourScore: '你的成绩',
    correctOf: (a, b) => `答对 ${a} / ${b} 题`,
    submittedAt: (d) => `提交时间 ${d}`,
    reviewH: '逐题回顾', reviewCount: (n) => `${n} 题`,
    qN: (n) => `第 ${n} 题`,
    correct: '正确', incorrect: '错误', partial: '部分正确',
    totalOf: (a, b) => `得分 ${a} / ${b} 分`, ptsOf: (a, b) => `${a} / ${b} 分`,
    hidden: '本次考试不显示正确答案',
    backRecord: '查看学习记录',
    loading: '加载中…', error: '加载失败，请刷新页面重试。', notFound: '未找到这份成绩，可能已被删除，或不是你的答卷。',
    // 简答题 AI 初评与 HR 复核（AI 治理方案 2.5、2.6）
    grading: '评分中', reviewing: '待复核', manualPending: '简答题待评分',
    gradingNote: '简答题评分中，通常几分钟内完成，完成后会通知你。',
    gradingSlow: '简答题仍在评分，评分完成后会通知你。',
    reviewNote: '简答题待 HR 复核，复核后确定是否通过，完成后会通知你。',
    manualNote: '是否通过已确定，不受简答题影响。简答题待 HR 评分，当前得分不含该题。',
    atLeast: (n) => `≥ ${n}%（不含待评题）`,
    pendingScore: '待 HR 评分', gradingScore: '评分中',
  },
  en: {
    examResult: 'Exam Result',
    passed: 'Passed', failed: 'Not passed',
    passNote: 'You reached the passing score. Your result has been added to your Learning Record.',
    failNote: 'You did not reach the passing score. You can retake the exam after the waiting period.',
    failReady: (left) => left == null ? 'You did not reach the passing score. You can retake the exam (unlimited attempts).' : `You did not reach the passing score. You can retake the exam (${left} attempt${left === 1 ? '' : 's'} left).`,
    failWaiting: (at) => `You did not reach the passing score. You can retake the exam after the waiting period ends at ${at}.`,
    failUsedUp: 'You did not reach the passing score and have used all attempts. Please contact HR.',
    goRetake: 'Retake exam',
    retrainNote: 'Attempt limit reached: the course progress and your attempts were reset automatically — redo the modules, then take the exam again.',
    passLine: (n) => `Passing score ${n}%`, yourScore: 'Your score',
    correctOf: (a, b) => `${a} of ${b} correct`,
    submittedAt: (d) => `Submitted ${d}`,
    reviewH: 'Question-by-Question Review', reviewCount: (n) => `${n} questions`,
    qN: (n) => `Question ${n}`,
    correct: 'Correct', incorrect: 'Incorrect', partial: 'Partially correct',
    totalOf: (a, b) => `${a} / ${b} pts`, ptsOf: (a, b) => `${a} / ${b} pts`,
    hidden: 'Correct answers are hidden for this exam',
    backRecord: 'View Learning Record',
    loading: 'Loading…', error: 'Couldn’t load. Refresh the page to try again.', notFound: 'This result wasn’t found. It may have been removed, or it isn’t your attempt.',
    grading: 'Scoring', reviewing: 'Awaiting review', manualPending: 'Short answer awaiting scoring',
    gradingNote: 'Your short answer is being scored. This usually takes a few minutes; you will be notified when it is done.',
    gradingSlow: 'Your short answer is still being scored; you will be notified when it is done.',
    reviewNote: 'Your short answer is awaiting HR review. Whether you pass will be confirmed after the review; you will be notified.',
    manualNote: 'Your pass/fail result is final and does not depend on the short answer. That answer is awaiting HR scoring, so the score shown excludes it.',
    atLeast: (n) => `≥ ${n}% (excluding unscored answers)`,
    pendingScore: 'Awaiting HR scoring', gradingScore: 'Scoring',
  },
};

// ISO -> "YYYY-MM-DD HH:MM" (null-safe).
function fmtDateTime(iso) {
  return datetime(iso) || null;
}

// 对错状态（ok / partial / bad；简答没分数时 pending）与每题得分：qtypes/model.js 的 stateOf / earnedOf。
// 「答对 a / b 题」按小题计：案例展开成它的小题（与答题页的题数一致）。
const flatItems = (detail) => detail.flatMap((d) => (d && d.type === 'case' && Array.isArray(d.items) && d.items.length ? d.items : [d]));

export default function Result() {
  const { lang, loc } = useI18n();
  // 页头路径与页间跳转按来源（D-29）：从培养项目进入时带 ?from=project:<id>
  const { src: trailSrc, head: trailHead } = useTrailSource();
  const nav = useNavigate();
  const { attemptId } = useParams();
  const { state } = useLocation();
  const s = T[lang];
  // CX-003：未通过文案按补考状态（retake 来自 GET /api/me/attempts/:id）：ready → 可再考（剩余次数）、waiting → 等待期、usedUp → 次数用完；没有 retake 的旧服务端沿用原文案
  const retakeOf = (d) => (d && d.retake) || null;
  const failTextOf = (d) => { const rt = retakeOf(d); if (!rt) return s.failNote; if (rt.state === 'ready') return s.failReady(rt.attemptsLeft); if (rt.state === 'waiting') return s.failWaiting(rt.retryAt ? new Date(rt.retryAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''); if (rt.state === 'usedUp') return s.failUsedUp; return s.failNote; };

  // Prefer the submit response passed via router state; otherwise (deep link /
  // refresh) fetch the stored attempt. Both share the same field shape.
  // CX-072（10/11 上线前测试）：交卷接口的返回没有 retake / earned / totalPoints，只用它渲染时，交卷后直接看到的页面
  // 缺「去补考」和得分、文案落到等待期，刷新后才对。有答卷编号就总是取完整答卷；交卷返回里独有的 autoRetrained 保留。
  const { loading, error, data: first } = useAsync(async () => {
    if (!attemptId) { if (state) return state; throw new Error('missing attempt'); }
    let full;
    try { full = await api.get(`/api/me/attempts/${attemptId}`); } catch (e) { if (state) return state; throw e; }   // 取不到时仍按交卷返回显示
    return state ? { ...state, ...full, autoRetrained: state.autoRetrained } : full;
  }, [attemptId]);
  // 评分中（gradingStatus = grading）时每 5 秒取一次答卷，15 分钟后停止轮询，改为提示「评分完成后会通知你」
  const [live, setLive] = useState(null);
  const [slow, setSlow] = useState(false);
  const data = live || first;
  const pollId = attemptId || (first && first.attemptId);
  useEffect(() => {
    setLive(null); setSlow(false);
  }, [pollId]);
  useEffect(() => {
    if (!data || data.gradingStatus !== 'grading' || !pollId) return undefined;
    const started = Date.now();
    let alive = true;
    const t = setInterval(() => {
      if (Date.now() - started > 15 * 60 * 1000) { clearInterval(t); if (alive) setSlow(true); return; }
      api.get(`/api/me/attempts/${pollId}`).then((d) => { if (alive && d && d.gradingStatus !== 'grading') setLive({ ...d, autoRetrained: false }); }).catch(() => {});
    }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [data && data.gradingStatus, pollId]); // eslint-disable-line react-hooks/exhaustive-deps

  const Check = () => (
    <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
  );
  const Cross = () => (
    <svg className="ic sm" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
  );
  const BackIcon = () => (
    <svg className="ic sm" viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
  );

  if (loading) {
    return (
      <div className="wrap">
        <ModuleTrail items={[...trailHead(lang, loc), { label: s.examResult }]} />
        <div className="card"><div className="rec-hist-h">{s.loading}</div></div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="wrap">
        <ModuleTrail items={[...trailHead(lang, loc), { label: s.examResult }]} />
        {/* CX-097：404 时说明找不到，不提示刷新 */}
        <div className="card"><div className="rec-hist-h">{error && error.status === 404 ? s.notFound : s.error}</div></div>
        <div className="res-actions">
          <button className="btn" onClick={() => nav('/record', { state: { tab: 'learn' } })}>
            <BackIcon />{s.backRecord}
          </button>
        </div>
      </div>
    );
  }

  const percent = Math.round(Number(data.percent) || 0);
  const gs = data.gradingStatus || 'final';
  const pendingResult = gs === 'grading' || gs === 'pending_review'; // 结论待定：不显示「未通过」
  const pass = !!data.passed && !pendingResult;
  const failText = failTextOf(data);
  const passingScore = data.passingScore != null ? data.passingScore : 80;
  const detail = Array.isArray(data.detail) ? data.detail : [];
  const showAnswers = data.showAnswers !== false;
  // Both titles are bilingual content, so both go through loc() — the fallback
  // used to be a bare read, which showed English program names in the zh UI.
  const title = loc(data, 'examTitle') || loc(data, 'programTitle') || s.examResult;
  const items = flatItems(detail);
  const rightCount = items.filter((d) => stateOf(d) === 'ok').length;
  const total = items.length;
  const submitted = fmtDateTime(data.submittedAt);


  return (
    <div className="wrap">
      <ModuleTrail items={[...trailHead(lang, loc), { label: loc(data, 'programTitle') || title, to: data.programId ? withFrom(`/program/${data.programId}`, trailSrc) : undefined }, { label: s.examResult }]} />

      {/* Layout v2：左侧深色结果栏（成绩环、状态、操作），右侧逐题回顾；v2.css .v2-result-workspace / .v2-result-rail */}
      <div className="v2-result-workspace">
      <aside className="v2-result-rail">
      {/* result header */}
      <div className={'res-head' + (pass || pendingResult ? '' : ' fail')}>
        <ProgressRing p={percent} size={92} />
        <div className="res-body">
          {/* F46：结果胶囊与「简答题待评分」同一 flex 行，垂直居中、同高（app.css .res-tags） */}
          <div className="res-tags">
            {gs === 'grading' ? <span className="pill muted">{s.grading}</span>
              : gs === 'pending_review' ? <span className="pill warn">{s.reviewing}</span>
                : pass
                  ? <span className="pill ok"><Check />{s.passed}</span>
                  : <span className="pill res-failpill"><Cross />{s.failed}</span>}
            {gs === 'manual_pending' && <span className="pill muted">{s.manualPending}</span>}
          </div>
          <h1>{title}</h1>
          <div className="res-meta">
            {data.totalPoints != null && <><span className="tnum">{s.totalOf(data.earned, data.totalPoints)}</span><span className="dot">·</span></>}
            <span className="tnum">{s.correctOf(rightCount, total)}</span>
            <span className="dot">·</span>
            <span>{s.passLine(passingScore)}</span>
            {submitted && <>
              <span className="dot">·</span>
              <span className="tnum">{s.submittedAt(submitted)}</span>
            </>}
          </div>
          {gs === 'manual_pending' && <div className="res-meta tnum">{s.atLeast(percent)}</div>}
          <div className="res-note">{gs === 'grading' ? (slow ? s.gradingSlow : s.gradingNote) : gs === 'pending_review' ? s.reviewNote : gs === 'manual_pending' ? s.manualNote + ' ' + (pass ? s.passNote : data.autoRetrained ? s.retrainNote : failText) : pass ? s.passNote : data.autoRetrained ? s.retrainNote : failText}</div>
        </div>
      </div>
      {/* actions · CX-003：未通过且还能考 → 「去补考」直达考前说明 */}
      <div className="res-actions">
        {!pass && gs !== 'grading' && gs !== 'pending_review' && data.retake && data.retake.examId && data.retake.state === 'ready' && data.programId && (
          <button className="btn" onClick={() => nav(`/exam-prep/${data.programId}/${data.retake.examId}`)}>{s.goRetake}</button>
        )}
        <button className={'btn' + (!pass && data.retake && data.retake.state === 'ready' ? ' ghost' : '')} onClick={() => nav('/record', { state: { tab: 'learn' } })}>
          <BackIcon />
          {s.backRecord}
        </button>
      </div>
      </aside>

      {/* answer review */}
      <div className="sec">
        <div className="sec-h">
          <h2>{s.reviewH}</h2>
          <span className="count">{s.reviewCount(total)}</span>
        </div>

        {!showAnswers && (
          <div className="res-note" style={{ marginBottom: 12 }}>{s.hidden}</div>
        )}

        <div className="res-list">
          {detail.map((d, i) => {
            const st = stateOf(d);
            const good = st === 'ok';
            const cls = good ? ' ok' : st === 'pending' ? ' pending' : ' bad';
            // 每种题型自己的回顾部件（你的作答 / 正确答案 / 分数与评语 / 解析）；答案不公开时服务端已去掉答案字段
            const Review = qtype(d.type).Review;
            const statePill =
              st === 'pending' ? <span className="pill muted">{gs === 'grading' ? s.gradingScore : s.pendingScore}</span>
              : st === 'ok' ? <span className="pill ok">{s.correct}</span>
                : st === 'partial' ? <span className="pill warn">{s.partial}</span>
                  : <span className="pill res-failpill">{s.incorrect}</span>;
            return (
              <div key={d.id || i} className={'res-q' + cls}>
                <div className="res-qtop">
                  <span className={'res-mark' + cls}>
                    {good ? <Check /> : <Cross />}
                  </span>
                  <div className="res-qhead">
                    <div className="res-qmeta">
                      <span className="res-qn tnum">{s.qN(i + 1)}</span>
                      <span className="pill muted">{typeLabel(d.type, lang)}</span>
                      {(d.points != null || d.type === 'case') && <span className="pill muted tnum">{s.ptsOf(earnedOf(d), d.type === 'case' ? maxOf(d) : d.points)}</span>}
                      {statePill}
                    </div>
                    <div className="res-prompt">{stemOf(d, lang)}</div>
                  </div>
                </div>

                <div className="res-ans">
                  <Review d={d} lang={lang} showAnswers={showAnswers} audience="learner" />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
}
