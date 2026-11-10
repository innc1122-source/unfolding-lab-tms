import Overlay from '../components/Overlay.jsx';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { api, useAsync, serverNow } from '../api.js';
import ModuleTrail from '../components/ModuleTrail.jsx';
import { useTrailSource, withFrom } from '../trailsource.js';
// 第四批 6.1（2026-10-08）：每道题按题型注册表渲染（web/src/qtypes）；题型名取 spec.js 的 typeLabel；
// 答题卡按小题展开（案例 3 有 4 道小题 → 3.1–3.4），作答仍是 { 题目 id: 值 }，案例存 { 题目 id: { 小题 sid: 值 } }。
import { qtype, typeLabel, CasePassage, subDef } from '../qtypes/views.jsx';   // 简化 10/11：员工端只引作答 / 回顾部件，不带编辑器
import { slotsOf, slotAnswered } from '../qtypes/model.js';

// Co-located bilingual UI chrome (do NOT edit the shared dictionary).
const T = {
  zh: {
    finalExam: '结业考试',
    timeLeft: '剩余时间', questionCard: '答题卡', answered: '已答', current: '当前', flagged: '标记',
    unanswered: '未答',
    // 手机题头用精简标签（题型短名见 qtypes/spec.js）：第 6 / 9 题 多选 · 已答 5/9 · 标记按钮
    of: (a, b) => `第 ${a} / ${b} 题`, prev: '上一题', next: '下一题',
    pts: (n) => `${n} 分`,
    flag: '标记本题', unflag: '取消标记', submit: '交卷', pass: (n) => `及格分 ${n}%`,
    multiHint: '（可多选）',
    totalQ: (n, c) => (c > 0 ? `共 ${n} 题 · 含 ${c} 组案例` : `共 ${n} 题`),
    caseNo: (n) => `案例 ${n}`,
    aiNote: '本题由 AI 初评，请勿在作答中填写个人信息。',
    progressN: (a, b) => `已作答 ${a} / ${b}`,
    progressShort: (a, b) => `已答 ${a}/${b}`,
    confirmTitle: '确认交卷？', confirmAll: '所有题目均已作答，确认交卷后不可修改。',
    confirmSome: (n) => `还有 ${n} 题未作答，确认交卷？`,
    reviewUnanswered: '返回作答', confirmSubmit: '确认交卷', cancel: '取消',
    // 中途离开 = 重新开始（服务端丢弃未交卷的答卷），所以不再有「草稿已保存 / 已恢复」
    leaveWarn: '离开后本次作答不保存，重新进入将重新开始考试',
    leaveConfirm: '离开后本次作答不保存，重新进入将重新开始考试。确定离开？',
    loading: '加载中…', back: '返回', noQuestions: '本次考试暂无题目，请联系 HR。', noExamId: '这个链接没有带考试编号，请从课程页面的「结业考试」进入。', startError: '无法开始考试，请稍后重试。',
    errIncomplete: '请先完成全部课程内容，再开始考试。',
    errExhausted: (n) => `你已用完全部 ${n} 次考试机会。如需重考，请联系 HR 重置。`,
    // 冷却文案拆成「说明 + 可重考时间」两段：中英语序不同，拼在一句里必有一边别扭。
    errCooldown: (hint) => `两次考试之间需间隔一段时间。${hint}`,
    errCooldownPlain: '两次考试之间需间隔一段时间，请稍后再试。',
    retakeInH: (h) => `约 ${h} 小时后可重考`,
    retakeInM: (m) => `约 ${m} 分钟后可重考`,
    retakeAt: (wait, at) => `${wait}（${at}）`,
    retakeNow: '重考等待期已结束，可以重新开始考试。',
    errTimeup: '本次考试已超时，无法提交。请重新开始一次。',
    submitFail: '提交失败，请重试', submitting: '提交中…',
  },
  en: {
    finalExam: 'Final exam',
    timeLeft: 'Time left', questionCard: 'Question navigator', answered: 'Answered', current: 'Current', flagged: 'Flagged',
    unanswered: 'Unanswered',
    of: (a, b) => `Question ${a} of ${b}`, prev: 'Previous', next: 'Next',
    pts: (n) => `${n} pt${n === 1 ? '' : 's'}`,
    flag: 'Flag', unflag: 'Unflag', submit: 'Submit', pass: (n) => `Passing score ${n}%`,
    multiHint: '(select all that apply)',
    totalQ: (n, c) => (c > 0 ? `${n} question${n === 1 ? '' : 's'} · incl. ${c} case group${c === 1 ? '' : 's'}` : `${n} question${n === 1 ? '' : 's'}`),
    caseNo: (n) => `Case ${n}`,
    aiNote: 'This answer is pre-scored by AI. Do not include personal information.',
    progressN: (a, b) => `Answered ${a} / ${b}`,
    progressShort: (a, b) => `${a}/${b} answered`,
    confirmTitle: 'Submit exam?', confirmAll: 'All questions answered. You cannot change answers after submitting.',
    confirmSome: (n) => `${n} question(s) still unanswered. Submit anyway?`,
    reviewUnanswered: 'Keep working', confirmSubmit: 'Submit', cancel: 'Cancel',
    leaveWarn: 'If you leave, this attempt is not saved — coming back starts the exam over',
    leaveConfirm: 'If you leave, this attempt is not saved and coming back starts the exam over. Leave anyway?',
    loading: 'Loading…', back: 'Back', noQuestions: 'This exam has no questions yet. Please contact HR.', noExamId: 'This link has no exam id. Open the exam from the course page instead.', startError: 'Could not start the exam. Please try again.',
    errIncomplete: 'Complete all course content before starting this exam.',
    errExhausted: (n) => `You have used all ${n} attempts. Contact HR to reset them if you need a retake.`,
    errCooldown: (hint) => `A waiting period applies between attempts. ${hint}`,
    errCooldownPlain: 'A waiting period applies between attempts. Please try again later.',
    retakeInH: (h) => `Retake available in about ${h} hour${h === 1 ? '' : 's'}`,
    retakeInM: (m) => `Retake available in about ${m} minute${m === 1 ? '' : 's'}`,
    retakeAt: (wait, at) => `${wait} (${at})`,
    retakeNow: 'The waiting period has ended. You can start the exam again.',
    errTimeup: 'Time is up — this attempt can no longer be submitted. Please start a new one.',
    submitFail: 'Submit failed, please try again', submitting: 'Submitting…',
  },
};

const hhmm = (d) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// A bare HH:MM reads as "today", but a 24h cooldown lands tomorrow — so stamp
// the month-day too whenever the moment is not today.
const coolStamp = (d) => {
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const p = (n) => String(n).padStart(2, '0');
  return sameDay ? hhmm(d) : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hhmm(d)}`;
};

// Cooldown wait in units a human reads: a 24h cooldown used to render as
// "1440 minutes". retryAt is preferred because it also names the clock time the
// retake opens; minutesLeft stays the fallback for responses without retryAt.
function retakeHint(s, info) {
  if (!info) return null;
  let at = null;
  if (info.retryAt) {
    const d = new Date(info.retryAt);
    if (!Number.isNaN(d.getTime())) at = d;
  }
  let mins = at ? Math.ceil((at.getTime() - serverNow()) / 60000) : null;   // CX-156：按服务器时间
  if (mins == null) {
    const m = Number(info.minutesLeft);
    if (Number.isFinite(m)) mins = Math.ceil(m);
  }
  if (mins == null) return null; // no timing at all — silence beats an invented number
  if (mins <= 0) return s.retakeNow;
  const wait = mins >= 60 ? s.retakeInH(Math.round(mins / 60)) : s.retakeInM(mins);
  return at ? s.retakeAt(wait, coolStamp(at)) : wait;
}

export default function ExamRunner() {
  const { lang, loc } = useI18n();
  // 页头路径与页间跳转按来源（D-29）：从培养项目进入时带 ?from=project:<id>
  const { src: trailSrc, head: trailHead } = useTrailSource();
  const s = T[lang];
  // 简答题由 AI 初评时，题干下方小字提示（AI 治理方案 2.6）
  const { user: authUser } = useAuth();
  const aiGrading = !!(authUser && authUser.ai && authUser.ai.grading === 'on');
  const nav = useNavigate();
  const { examId } = useParams();

  // START: POST /api/exam/start on mount.
  const { loading, error, data } = useAsync(
    () =>
      examId
        ? api.post('/api/exam/start', { examId })
        : Promise.reject(Object.assign(new Error('exam not found'), { status: 404 })),
    [examId]
  );

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({}); // qid -> 该题型的作答值（案例：{ sid: 值 }）
  const [flags, setFlags] = useState({});     // 格子 key（题目 id / 题目 id:小题 sid） -> bool (local-only UI aid)
  // 手机上同一案例的材料第一次看到时展开，再次看到（下一道小题）默认收起
  const seenCases = useRef(new Set());
  const [confirming, setConfirming] = useState(false);
  const [blurCount, setBlurCount] = useState(0);
  const [remainingMs, setRemainingMs] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Refs so timer/autosave callbacks read fresh values without re-subscribing.
  const answersRef = useRef(answers);
  const blurRef = useRef(blurCount);
  const submittedRef = useRef(false);
  useEffect(() => { answersRef.current = answers; }, [answers]);
  useEffect(() => { blurRef.current = blurCount; }, [blurCount]);
  // 每次进入都是一份新卷（服务端已丢弃未交卷的旧答卷），答案从空白开始，不再从草稿恢复。

  // SUBMIT (also used by the countdown auto-submit). Guards double-submit.
  const submit = async () => {
    if (submittedRef.current || !data) return;
    submittedRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.post(`/api/exam/${data.attemptId}/submit`, {
        answers: answersRef.current,
        blurCount: blurRef.current,
      });
      nav(withFrom(`/result/${data.attemptId}`, trailSrc), { state: result });
    } catch (e) {
      submittedRef.current = false; // allow a retry (e.g. transient network error)
      setSubmitting(false);
      setConfirming(false);
      setSubmitError(e);
    }
  };
  // Submit failures carry a machine code (timeup / …) so the copy stays in the
  // active language instead of echoing the server's English.
  const submitErrText = () => {
    const d = submitError && submitError.data;
    if (d && d.code === 'timeup') return s.errTimeup;
    return (submitError && submitError.message) || s.submitFail;
  };
  const submitRef = useRef(submit);
  useEffect(() => { submitRef.current = submit; });

  // TIMER: server-authoritative countdown from `deadline`. Auto-submit at 0.
  useEffect(() => {
    if (!data || !data.deadline) return;
    const deadlineMs = new Date(data.deadline).getTime();
    let id;
    const tick = () => {
      const rem = deadlineMs - Date.now();
      setRemainingMs(Math.max(0, rem));
      if (rem <= 0) {
        clearInterval(id);
        submitRef.current();
      }
    };
    tick();
    id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [data]);

  // HEARTBEAT（原 15 秒草稿自动保存已停用）：离开即重新开始，保存答案没有意义，也会让人
  // 误以为能恢复。这里只每 60 秒告诉服务端「考试页还开着」（刷新 lastSavedAt），让学习助手的
  // 「考试进行中」锁在无时限考试里也保持准确。不带答案。
  useEffect(() => {
    if (!data || !data.attemptId) return;
    const id = setInterval(() => {
      if (submittedRef.current) return;
      api.put(`/api/exam-attempts/${data.attemptId}/draft`, { answers: {} }).catch(() => {});
    }, 60000);
    return () => clearInterval(id);
  }, [data]);

  // LEAVE GUARD：答题中离开（关页 / 刷新 / 站内跳转 / 浏览器后退）先确认。
  // HashRouter 不支持 useBlocker，所以：beforeunload 管关页与刷新；捕获阶段拦截站内链接与
  // 用户菜单的点击；后退键用一条同址的历史记录垫底，popstate 时确认，不离开就再垫一条。
  const examLive = !!(data && Array.isArray(data.questions) && data.questions.length > 0);
  const leaveMsgRef = useRef(s.leaveConfirm);
  useEffect(() => { leaveMsgRef.current = s.leaveConfirm; }, [s.leaveConfirm]);
  useEffect(() => {
    if (!examLive) return undefined;
    const guarding = () => !submittedRef.current;
    const onBeforeUnload = (e) => {
      if (!guarding()) return undefined;
      e.preventDefault();
      e.returnValue = leaveMsgRef.current;
      return leaveMsgRef.current;
    };
    const onClickCapture = (e) => {
      if (!guarding()) return;
      const el = e.target && e.target.closest ? e.target.closest('a[href], .um-item') : null;
      if (!el) return;
      if (el.closest('.exam-grid, .exam-dialog')) return;
      if (el.getAttribute && el.getAttribute('target') === '_blank') return;
      if (!window.confirm(leaveMsgRef.current)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    let leaving = false;
    window.history.pushState(window.history.state, '', window.location.href);
    const onPop = () => {
      if (leaving || !guarding()) return;
      if (window.confirm(leaveMsgRef.current)) {
        leaving = true;
        window.history.back();
      } else {
        window.history.pushState(window.history.state, '', window.location.href);
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClickCapture, true);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('popstate', onPop);
    };
  }, [examLive]);

  // ANTI-CHEAT: count tab/window hides as blur events.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'hidden') setBlurCount((c) => c + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const questions = (data && Array.isArray(data.questions)) ? data.questions : [];
  // 答题卡格子：普通题一格，案例按小题展开（qtypes/model.js slotsOf）
  const slots = useMemo(() => slotsOf(questions), [questions]);
  const caseCount = useMemo(() => questions.filter((x) => x && x.type === 'case').length, [questions]);

  const answeredCount = useMemo(
    () => slots.filter((slot) => slotAnswered(slot, answers)).length,
    [answers, slots]
  );
  const unansweredCount = slots.length - answeredCount;
  const curSlot = slots[Math.min(idx, Math.max(0, slots.length - 1))];
  const curCaseId = curSlot && curSlot.sub ? curSlot.q.id : null;
  useEffect(() => { if (curCaseId) seenCases.current.add(curCaseId); }, [curCaseId]);

  // ---- Loading / start-error frames (do NOT render the exam) ----
  if (loading) {
    return (
      <div className="wrap">
        <ModuleTrail items={[...trailHead(lang, loc), { label: s.finalExam }]} locked />
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          {s.loading}
        </div>
      </div>
    );
  }
  if (error || !data) {
    // 400 (not unlocked / attempts used / cooldown) or 404 exam not found — show server message.
    return (
      <div className="wrap">
        <ModuleTrail items={[...trailHead(lang, loc), { label: s.finalExam }]} locked />
        <div style={{ padding: '72px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          <p style={{ marginBottom: 16 }}>{(() => {
            const d = error && error.data && typeof error.data === 'object' ? error.data : {};
            if (d.code === 'incomplete') return s.errIncomplete;
            if (d.code === 'exhausted') return s.errExhausted(d.max || 0);
            if (d.code === 'cooldown') {
              const hint = retakeHint(s, d);
              return hint ? s.errCooldown(hint) : s.errCooldownPlain;
            }
            return (error && error.message) || s.startError;
          })()}</p>
          <button className="btn ghost" onClick={() => nav(-1)}>{s.back}</button>
        </div>
      </div>
    );
  }

  // A published exam with no questions would otherwise dereference an undefined
  // question below and blank the screen — show a framed message instead.
  if (questions.length === 0) {
    return (
      <div className="wrap">
        <ModuleTrail items={[...trailHead(lang, loc), { label: s.finalExam }]} locked />
        <div style={{ padding: '72px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          <p style={{ marginBottom: 16 }}>{examId ? s.noQuestions : s.noExamId}</p>
          <button className="btn ghost" onClick={() => nav(-1)}>{s.back}</button>
        </div>
      </div>
    );
  }

  // ---- Exam ready ----
  const slot = curSlot;
  const q = slot.q;            // 题目（案例时是整组）
  const cur = slot.sub || q;   // 当前作答的这一题（案例时是小题）
  const def = slot.sub ? (subDef(cur.type) || qtype(null)) : qtype(cur.type);
  const last = idx === slots.length - 1;
  const hasTimer = remainingMs != null && data.deadline;
  const totalSec = hasTimer ? Math.ceil(remainingMs / 1000) : 0;
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  // Design 23: the countdown goes red for the last 2 minutes. Earlier than that
  // and the alarm state covers most of a short exam, which stops meaning anything.
  const warn = hasTimer && remainingMs <= 2 * 60 * 1000;

  // 当前这一格的作答值与写回（案例小题写进 answers[案例 id][sid]）
  const curValue = slot.sub
    ? (answers[q.id] && typeof answers[q.id] === 'object' && !Array.isArray(answers[q.id]) ? answers[q.id][slot.sub.sid] : undefined)
    : answers[q.id];
  const setValue = (val) => setAnswers((a) => {
    if (!slot.sub) return { ...a, [q.id]: val };
    const grp = a[q.id] && typeof a[q.id] === 'object' && !Array.isArray(a[q.id]) ? a[q.id] : {};
    return { ...a, [q.id]: { ...grp, [slot.sub.sid]: val } };
  });
  const toggleFlag = () => setFlags((f) => ({ ...f, [slot.key]: !f[slot.key] }));

  const go = (i) => setIdx(Math.max(0, Math.min(slots.length - 1, i)));
  const phone = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  const caseSeen = slot.sub ? seenCases.current.has(q.id) : false;
  const Runner = def.Runner;

  return (
    <div className="wrap">
      {/* 页头模块路径在答题中全部不可点（防止中途离开，IA 1.4）；计时器仍放在这一行 */}
      <div className="crumb exam-crumb">
        {trailHead(lang, loc).map((it) => <span key={it.to}>{it.label}<span className="sep" aria-hidden="true">›</span></span>)}
        <span>{loc(data, 'examTitle') || s.finalExam}</span>
        {/* Countdown — only when the exam is timed. CSS floats it to the top-right
            on desktop (fixed, so this DOM slot is just a home for it); on phones
            it stays in flow and reads inline on the title row instead of sitting
            on top of the flag button. The label is hidden there, hence aria-label. */}
        {hasTimer && (
          <div
            className={'exam-timer' + (warn ? ' warn' : '')}
            role="timer"
            aria-live="off"
            aria-label={s.timeLeft}
          >
            <svg className="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            <div className="exam-timer-body">
              <span className="exam-timer-lab">{s.timeLeft}</span>
              <span className="exam-timer-val tnum">{mm}:{ss}</span>
            </div>
          </div>
        )}
      </div>

      <div className="exam-grid">
        {/* Single question view. The grid is one column at every width now, so
            DOM order is reading order: question → options → nav → answer sheet. */}
        <main className="exam-main">
          {/* 第 6 / 9 题 → 题型 → 已答 → 标记，与设计同序。每个标签都带
              桌面 / 手机两份文案，短的那份 aria-hidden，读屏只听完整文案。 */}
          <div className="exam-qhead">
            <span className="exam-qidx tnum">{s.of(slot.label, slots.length)}</span>
            {slot.sub && <span className="pill muted exam-qcase">{s.caseNo(slot.caseNo)}</span>}
            <span className="pill pri">
              <span className="exam-lab-lg">{typeLabel(cur.type, lang)}</span>
              <span className="exam-lab-sm" aria-hidden="true">{typeLabel(cur.type, lang, true)}</span>
            </span>
            {cur.points != null && <span className="pill muted tnum exam-qpts">{s.pts(cur.points)}</span>}
            <span className="exam-qcount tnum">
              <span className="exam-lab-lg">{s.progressN(answeredCount, slots.length)}</span>
              <span className="exam-lab-sm" aria-hidden="true">{s.progressShort(answeredCount, slots.length)}</span>
            </span>
            <button
              className={'exam-flagbtn' + (flags[slot.key] ? ' active' : '')}
              onClick={toggleFlag}
              aria-pressed={flags[slot.key] ? 'true' : 'false'}
              aria-label={flags[slot.key] ? s.unflag : s.flag}
            >
              <svg className="ic sm" viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>
              <span className="exam-flagbtn-lab">{flags[slot.key] ? s.unflag : s.flag}</span>
            </button>
          </div>

          {/* 案例小题：先放案例材料（手机上同一案例再次出现时默认收起，可「查看案例」展开）
              CX-007（2026-10-09 验收）：这里的 key 原来与下面 <Runner key={slot.key}> 相同 —— 同级重复 key 让 React（生产构建）漏删旧节点，
              案例材料随小题一份份堆叠并残留到后面的题；key 加前缀区分。 */}
          {slot.sub && <CasePassage key={'case:' + slot.key} q={q} lang={lang} collapsible={phone} defaultOpen={!(phone && caseSeen)} />}

          {/* 多空填空把输入框放在题干里，题干由它的作答部件渲染 */}
          {!def.ownsStem && (
            <h2 className="exam-qtext">
              {loc(cur, 'question')}
              {cur.type === 'multi' && <span className="exam-multi-hint">{s.multiHint}</span>}
            </h2>
          )}

          {/* 按题型渲染作答区（qtypes 注册表）；未知题型提示刷新页面 */}
          <Runner key={slot.key} q={cur} value={curValue} onChange={setValue} lang={lang} />
          {cur.type === 'open' && aiGrading && <div className="exam-ai-note">{s.aiNote}</div>}

          {/* Previous · Next · Submit. On phones this row is the fixed bottom bar,
              so Submit is reachable from any question instead of only from the
              last one; on desktop the third button is hidden and Submit lives at
              the end of the answer sheet below.
              11.3 / F45（2026-10-09）：最后一题（含案例的最后一道小题，slots 已把小题展开成格）时，
              「下一题」那一格换成「交卷」主按钮，与「上一题」同一行，打开同一个交卷确认框（含未答题数提示）。
              同一位置、同为 <button>，React 复用同一个节点，键盘焦点不丢；手机底部条的第三颗交卷此时不再重复显示。 */}
          <div className={'exam-nav' + (last ? ' is-last' : '')}>
            <button className="btn ghost" onClick={() => go(idx - 1)} disabled={idx === 0}>
              <svg className="ic sm" viewBox="0 0 24 24"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>{s.prev}
            </button>
            {last ? (
              <button className="btn exam-nav-last" onClick={() => setConfirming(true)} disabled={submitting}>
                {s.submit}<svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
              </button>
            ) : (
              <button className="btn" onClick={() => go(idx + 1)}>
                {s.next}<svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            )}
            {!last && (
              <button
                className="exam-nav-sub btn ghost"
                onClick={() => setConfirming(true)}
                disabled={submitting}
              >
                {s.submit}<svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
              </button>
            )}
          </div>
        </main>

        {/* Answer sheet / question palette — full width under the question
            (design 11: 底部答题卡), not a 230px left rail. */}
        <section className="exam-rail exam-sheet">
          {/* 常驻提示：中途离开不保存，重新进入重新开始（原「草稿已保存」行的位置与样式）。 */}
          <div className="exam-draft">
            <span className="exam-draft-note">{s.leaveWarn}</span>
          </div>

          <div className="exam-sheet-h">
            <span className="exam-rh">{s.questionCard}</span>
            <span className="pill muted tnum">{s.totalQ(slots.length, caseCount)}</span>
            <span className="pill muted">{s.pass(data.passingScore)}</span>
          </div>

          <div className="exam-palette">
            {slots.map((cell, i) => {
              const on = i === idx;
              const done = slotAnswered(cell, answers);
              const flag = flags[cell.key];
              const cls =
                'exam-cell' +
                (on ? ' on' : '') +
                (done ? ' done' : '') +
                (flag ? ' flag' : '') +
                (cell.sub ? ' sub' : '');
              return (
                <button
                  key={cell.key}
                  className={cls}
                  onClick={() => go(i)}
                  aria-label={s.of(cell.label, slots.length)}
                  aria-current={on ? 'true' : undefined}
                >
                  {cell.label}
                  {flag && <span className="exam-flagdot" aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          <div className="exam-sheet-f">
            <div className="exam-legend">
              <span><i className="lg on" />{s.current}</span>
              <span><i className="lg done" />{s.answered}</span>
              <span><i className="lg flag" />{s.flagged}</span>
              <span><i className="lg" />{s.unanswered}</span>
            </div>
            {/* Same count as .exam-qcount above, so keep it out of the a11y tree. */}
            <div className="exam-bar" aria-hidden="true">
              <i style={{ width: `${slots.length ? (answeredCount / slots.length) * 100 : 0}%` }} />
            </div>
            <button className="btn exam-submit" onClick={() => setConfirming(true)} disabled={submitting}>
              <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>{s.submit}
            </button>
          </div>
        </section>
      </div>

      {/* Keeps the end of the answer sheet clear of the fixed phone action bar. */}
      <div className="exam-navspacer" aria-hidden="true" />

      {/* Submit confirmation */}
      {confirming && (
        <Overlay kind="exam" label={s.confirmTitle} busy={submitting} onClose={() => setConfirming(false)}>
            <h3>{s.confirmTitle}</h3>
            <p>{unansweredCount > 0 ? s.confirmSome(unansweredCount) : s.confirmAll}</p>
            {submitError && (
              <p style={{ color: 'var(--danger, #c0392b)' }}>
                {submitErrText()}
              </p>
            )}
            <div className="exam-dialog-act">
              <button className="btn ghost" onClick={() => setConfirming(false)} disabled={submitting}>
                {unansweredCount > 0 ? s.reviewUnanswered : s.cancel}
              </button>
              <button className="btn" onClick={submit} disabled={submitting}>
                {submitting ? s.submitting : s.confirmSubmit}
              </button>
            </div>
        </Overlay>
      )}

      {/* Submit error surfaced outside the dialog (e.g. after auto-submit at 0) */}
      {submitError && !confirming && (
        <Overlay kind="exam" label={s.submitFail} onClose={() => setSubmitError(null)}>
            <h3>{s.submitFail}</h3>
            <p>{submitErrText()}</p>
            <div className="exam-dialog-act">
              <button className="btn ghost" onClick={() => setSubmitError(null)}>{s.cancel}</button>
              <button className="btn" onClick={submit}>{s.confirmSubmit}</button>
            </div>
        </Overlay>
      )}
    </div>
  );
}
