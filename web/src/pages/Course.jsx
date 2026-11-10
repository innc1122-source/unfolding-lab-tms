import { useMedia } from '../useMedia.js';
import { useState, useEffect, useRef } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAsync, api } from '../api.js';
import { useCourseScope } from '../coursescope.jsx';
import PdfViewer from '../components/PdfViewer.jsx';
import WatermarkedVideo from '../components/WatermarkedVideo.jsx';
import ModuleTrail from '../components/ModuleTrail.jsx';
import { useTrailSource, withFrom } from '../trailsource.js';
import { examReachable, nextAfterCourse } from '../afterCourse.js';

// Co-located bilingual UI strings for this screen (do NOT edit the shared dict).
const T = {
  zh: {
    courseModules: '课程模块',
    readAloud: '朗读',
    stopReading: '停止朗读',
    modOfMin: (a, b, min) => `模块 ${a} / ${b} · 约 ${min} 分钟`,
    viewOnly: '仅在线查看 · 不可下载',
    pendingConv: '课件正在等待转换为在线查看格式，暂时无法打开。',
    pendingTag: '待转换',
    prevMod: '← 上一模块',
    prevModShort: '← 上一模块',
    completeNext: '标记完成并继续',
    completeLast: '标记完成',
    nextModule: '下一模块 →',
    backToPath: '← 课程详情',
    finishCourse: '完成课程，继续 →',
    open: '打开',
    loading: '加载中…',
    error: '加载失败，请刷新页面重试。',
    notFound: '未找到该课程，或它未被指派给你。',
    backToLearning: '返回我的课程',
    emptyModule: '本模块暂无内容。',
    completing: '提交中…',
    offlineTag: '线下课程',
    offlineTime: '上课时间', offlineLoc: '地点', offlineTbd: '时间待定',
    offlineHint: '本课程为线下面授。上课当天，现场投屏会显示 6 位签到码，在下方输入即完成签到；如有课件材料可提前查看。',
    ckLabel: '现场签到', ckPh: '6 位签到码',
    ckBad: '签到码错误或已过期，请查看大屏上的最新签到码后重试。',
    ckNotToday: (d) => `签到只在活动当天开放（活动日期 ${d}）。`,
    ckSt: { attended: '已签到', late: '已签到 · 迟到', excused: '已请假 · 需补课', absent: '缺席' },
    finalExam: '结业考试',
    examMin: (m) => `${m} 分钟`,
    examLocked: '完成全部学习内容后解锁',
    goExam: '前往考试 →',
    doneTitle: '本课程已完成',
    doneWithExam: '结业考试已解锁，可以直接开始。',
    doneExamLocked: '完成其余学习内容后，结业考试才会解锁。',
    doneNoExam: '本课程的全部模块都已完成。',
  },
  en: {
    courseModules: 'Course Modules',
    readAloud: 'Read aloud',
    stopReading: 'Stop reading',
    modOfMin: (a, b, min) => `Module ${a} of ${b} · ~${min} min`,
    viewOnly: 'View only · no download',
    pendingConv: 'This file is waiting to be converted for online viewing and can’t be opened yet.',
    pendingTag: 'Pending conversion',
    prevMod: '← Previous',
    prevModShort: '← Previous',
    completeNext: 'Mark complete & continue',
    completeLast: 'Mark complete',
    nextModule: 'Next module →',
    backToPath: '← Course details',
    finishCourse: 'Finish & continue →',
    open: 'Open',
    loading: 'Loading…',
    error: 'Couldn’t load. Refresh the page to try again.',
    notFound: 'This course was not found, or it is not assigned to you.',
    backToLearning: 'Back to My Courses',
    emptyModule: 'This module has no content yet.',
    completing: 'Submitting…',
    offlineTag: 'In-person course',
    offlineTime: 'Session time', offlineLoc: 'Venue', offlineTbd: 'Time TBD',
    offlineHint: 'This is an in-person course. On the day, the projector shows a 6-digit code — enter it below to check in. Materials (if any) can be reviewed in advance.',
    ckLabel: 'Check in', ckPh: '6-digit code',
    ckBad: 'Incorrect or expired code. Check the latest code on the screen and try again.',
    ckNotToday: (d) => `Check-in is open only on the day of the session (${d}).`,
    ckSt: { attended: 'Checked in', late: 'Checked in · late', excused: 'Excused · make-up required', absent: 'Absent' },
    finalExam: 'Final exam',
    examMin: (m) => `${m} min`,
    examLocked: 'Unlocks after all content is complete',
    goExam: 'Go to exam →',
    doneTitle: 'Course complete',
    doneWithExam: 'The final exam is unlocked — you can start it now.',
    doneExamLocked: 'The final exam unlocks once the remaining content is complete.',
    doneNoExam: 'Every module in this course is complete.',
  },
};

// The phone footer swaps in shorter button labels (上一节 / 标记完成) rather than
// wrapping the long ones onto two rows, so the breakpoint has to be readable
// from JS. 820px is where app.css already turns the module rail into chips.
const NARROW_Q = '(max-width:820px)';
const useNarrow = () => useMedia(NARROW_Q);

// Human-readable file size from a byte count (null-safe).
function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

// Strip HTML tags to plain text for read-aloud (uses the DOM to decode entities).
function htmlToText(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
}

// Inline icons — copy the existing Course/ProgramDetail SVG style.
const IcDoc = ({ brand }) => (
  <svg className="ic sm" viewBox="0 0 24 24" style={brand ? { color: 'var(--brand)' } : undefined}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" />
  </svg>
);
const IcSpeaker = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 010 7" /></svg>
);
const IcCheck = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
);
const IcLock = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
);
const IcExam = () => (
  <svg className="ic sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /><path d="M9 14l2 2 4-4" /></svg>
);
// Venue — the in-person course card's mark. Same outline Home.jsx and the
// 班级 tab already use for a physical classroom, so the three agree.
const IcVenue = () => (
  <svg className="ic" viewBox="0 0 24 24"><path d="M3 21V9l9-6 9 6v12" /><path d="M9 21v-6h6v6" /></svg>
);

export default function Course() {
  const { lang, loc } = useI18n();
  // 页头路径与页间跳转按来源（D-29）：从培养项目进入时带 ?from=project:<id>
  const { src: trailSrc, head: trailHead } = useTrailSource();
  const nav = useNavigate();
  const { id } = useParams();
  const { setScope } = useCourseScope();
  const s = T[lang];
  const narrow = useNarrow();

  const { loading, error, data } = useAsync(
    () => (id ? api.get(`/api/courses/${id}`) : Promise.resolve(null)),
    [id]
  );

  // Sibling courses + exam of the parent program, so finishing a course can send
  // the learner straight to the next course / the (now-unlocked) final exam.
  const { data: prog } = useAsync(
    () => (data && data.programId ? api.get(`/api/programs/${data.programId}`) : Promise.resolve(null)),
    [data && data.programId]
  );

  // Manual module selection + modules completed during this session (merged over
  // the server's `done` map so the rail/advance logic reflect fresh completions).
  const [selectedId, setSelectedId] = useState(null);
  const [localDone, setLocalDone] = useState({});
  const [speaking, setSpeaking] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState(null);
  // In-person course check-in (6-digit rotating code, auto-submits when full).
  const [ckVal, setCkVal] = useState('');
  const [ckBusy, setCkBusy] = useState(false);
  const [ckErr, setCkErr] = useState(null);
  const [ckState, setCkState] = useState(null);
  const submitCk = async (val) => {
    if (ckBusy) return;
    setCkBusy(true); setCkErr(null);
    try {
      const r = await api.post(`/api/courses/${id}/checkin`, { code: val });
      setCkState(r.status);
    } catch (e) {
      const bad = e && e.data && e.data.code === 'badcode';
      const notToday = e && e.data && e.data.code === 'checkin_not_today';   // CX-078：只在活动当天
      setCkErr(bad ? s.ckBad : notToday ? s.ckNotToday(e.data.sessionDay) : (e && e.message) || 'Error');
      setCkVal('');
    } finally {
      setCkBusy(false);
    }
  };

  // Stop any narration when the module/course changes or the screen unmounts.
  useEffect(() => {
    return () => { if (window.speechSynthesis) window.speechSynthesis.cancel(); };
  }, []);
  useEffect(() => {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [selectedId, id, lang]);

  // Report the currently-viewed module to the AI assistant (course scope).
  useEffect(() => {
    if (!data) { setScope({ courseId: null, moduleId: null }); return; }
    const mods = Array.isArray(data.modules) ? data.modules : [];
    const doneMap = { ...(data.done || {}), ...localDone };
    const cur = mods.find((m) => m.id === selectedId) || mods.find((m) => !doneMap[m.id]) || mods[0] || null;
    setScope({ courseId: id, moduleId: cur ? cur.id : null });
    return () => setScope({ courseId: null, moduleId: null });
  }, [data, selectedId, localDone, id, setScope]);

  // As a phone chip row the rail scrolls sideways, so the module that "mark
  // complete" just advanced to can sit off-screen. Centre it. The guard keeps
  // this a no-op for the desktop rail, which never scrolls horizontally.
  const railRef = useRef(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || rail.scrollWidth <= rail.clientWidth + 1) return;
    const chip = rail.querySelector('[aria-current="true"]');
    if (!chip) return;
    const r = rail.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    rail.scrollLeft += (c.left - r.left) - (r.width - c.width) / 2;
  }, [data, selectedId, localDone]);

  // Loading / error / not-found frames (keep the wrap + crumb chrome).
  if (loading) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>{s.loading}</div>
      </div>
    );
  }
  // 第四批 7：没加入、但在课程目录里的公开课程 → 404 public_not_enrolled，转到课程目录并打开这门课的介绍。
  // 已不再公开、加入后没开始的人（9.2 方案 A 已移出）得到普通 404，走下面的「未找到」说明。
  if (error && error.status === 404 && error.data && error.data.code === 'public_not_enrolled' && error.data.programId) {
    return <Navigate to={`/catalog?open=${encodeURIComponent(error.data.programId)}`} replace />;
  }
  if (error && error.status !== 404) {
    return (
      <div className="wrap">
        <ModuleTrail items={trailHead(lang, loc)} />
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>{s.error}</div>
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

  const modules = Array.isArray(data.modules) ? data.modules : [];
  const done = { ...(data.done || {}), ...localDone };
  const isDone = (m) => !!done[m.id];

  // Selected module = explicit pick, else first not-done, else first.
  const current =
    modules.find((m) => m.id === selectedId) ||
    modules.find((m) => !isDone(m)) ||
    modules[0] ||
    null;
  const currentIndex = current ? modules.findIndex((m) => m.id === current.id) : -1;
  const sections = current && Array.isArray(current.sections) ? current.sections : [];

  const selectModule = (m) => { setCompleteError(null); setSelectedId(m.id); };

  // Read-aloud: speak the concatenated plain text of the current module's sections.
  const toggleReadAloud = () => {
    if (!window.speechSynthesis) return;
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const text = sections
      .map((sec) => [loc(sec, 'heading'), htmlToText(loc(sec, 'html'))].filter(Boolean).join('. '))
      .filter(Boolean)
      .join('. ');
    if (!text) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    setSpeaking(true);
  };

  // Mark complete -> POST, then advance to the next not-done module (or stay).
  const markComplete = async () => {
    if (!current || completing) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      await api.post(`/api/courses/${id}/modules/${current.id}/complete`);
      const nextDone = { ...done, [current.id]: new Date().toISOString() };
      setLocalDone((d) => ({ ...d, [current.id]: nextDone[current.id] }));
      const next = modules.find((m) => !nextDone[m.id]);
      if (next) setSelectedId(next.id);
      else setSelectedId(current.id);
    } catch (e) {
      setCompleteError(e);
    } finally {
      setCompleting(false);
    }
  };

  const currentComplete = current ? isDone(current) : false;
  const hasNextNotDone = modules.some((m) => m.id !== (current && current.id) && !isDone(m));
  const allDone = modules.length > 0 && modules.every(isDone);

  // Published exams of the parent program that gate on this course. An exam with
  // no explicit course links spans the whole program (server.js examUnlockedFor).
  const examCourses = (e) => (Array.isArray(e.courseIds) ? e.courseIds : []);
  const courseExams = (prog && Array.isArray(prog.exams) ? prog.exams : []).filter((e) => {
    const cids = examCourses(e);
    return cids.length === 0 || cids.some((c) => String(c) === String(id));
  });
  // `prog` is a snapshot taken before this session's completions, so `unlocked`
  // goes stale the moment the last module is marked done. F44（2026-10-09）：考试只在服务端已解锁，
  // 或它要求的课程（本课按 courseDone 计，其他课按快照进度）全部学完时才可去；多门课的学习包里
  // 其他课没学完时不出现「前往考试」。规则见 afterCourse.js，考前说明页仍会在服务端再校验。
  // 负责人 2026-10-06：请假不算完成、需要补课。线下课程的「学完」只看出勤（服务端 progressPercent
  // 只认出席 / 迟到），看完资料但请假 / 缺席 / 未签到的，不显示完成横幅、不给考试捷径。
  const ckAtt = ckState || data.attendance;
  const ckExcused = ckAtt === 'excused';
  const courseDone = data.mode === 'offline' ? (ckAtt === 'attended' || ckAtt === 'late') : allDone;
  const examOpen = (e) => examReachable(e, prog && prog.courses, id, courseDone);
  const openExam = courseExams.find(examOpen) || null;
  const goExam = (e) => nav(withFrom(`/exam-prep/${data.programId}/${e.id}`, trailSrc));

  // Always-available back: previous module, or up to the program learning path.
  const goBack = () => {
    if (currentIndex > 0) selectModule(modules[currentIndex - 1]);
    else nav(withFrom(`/program/${data.programId}`, trailSrc));
  };
  // Next module (prefer the next not-done, else the next one by order).
  const goNextModule = () => {
    const after = modules.slice(currentIndex + 1);
    const target = after.find((m) => !isDone(m)) || after[0];
    if (target) selectModule(target);
  };
  // Course finished → F44（2026-10-09）：学习包里任何一门没学完的课（先当前课之后的，再之前的）；
  // 全部学完才去可去的考试；考试未解锁或无法确认时回学习路径页。规则见 afterCourse.js。
  const goAfterCourse = () => {
    const pid = data.programId;
    const next = nextAfterCourse(prog, id, courseDone);
    if (next.kind === 'course') { nav(withFrom(`/course/${next.id}`, trailSrc)); return; }
    if (next.kind === 'exam') { nav(withFrom(`/exam-prep/${pid}/${next.id}`, trailSrc)); return; }
    // Single-course wrapper: "continue" means back to the list
    // (the program page would just bounce straight back here).
    if (next.kind === 'list') { nav('/learning'); return; }
    nav(withFrom(`/program/${pid}`, trailSrc));
  };

  // 负责人 2026-10-06：请假不算完成、需要补课。请假行不显示 ✓，并照常给输码框，
  // 学员补课当天输码即改为已签到（服务端覆盖请假行）。缺席的显示维持原样。（ckAtt / ckExcused 见上方 examOpen 处）

  return (
    <div className="wrap">
      <ModuleTrail items={[...trailHead(lang, loc), { label: loc(data, 'title'), to: withFrom(`/program/${data.programId}`, trailSrc) }, { label: current ? loc(current, 'title') : '' }]} />

      {data.mode === 'offline' && (
        <div className="offline-card">
          <div className="offline-ic" aria-hidden="true"><IcVenue /></div>
          <div className="offline-body">
            <div className="offline-title">{s.offlineTag}</div>
            <div className="offline-meta">
              <b>{s.offlineTime}:</b> {data.sessionAt ? data.sessionAt.replace('T', ' ') : s.offlineTbd}
              {data.location && <>　<b>{s.offlineLoc}:</b> {data.location}</>}
            </div>
            {data.sessionNote && <div className="offline-note">{data.sessionNote}</div>}
            <div className="offline-hint">{s.offlineHint}</div>
            <div className="offline-ck">
              {ckAtt && !ckExcused ? (
                <span className="pill ok"><IcCheck /> {s.ckSt[ckAtt] || s.ckSt.attended}</span>
              ) : (
                <>
                  {ckExcused && <span className="pill warn">{s.ckSt.excused}</span>}
                  <span className="offline-ck-lab">{s.ckLabel}:</span>
                  <input
                    className="ck-input tnum" inputMode="numeric" autoComplete="one-time-code"
                    maxLength={6} placeholder={s.ckPh} value={ckVal} disabled={ckBusy}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                      setCkVal(v);
                      if (v.length === 6) submitCk(v);
                    }}
                  />
                  {ckBusy && <span className="offline-hint">…</span>}
                  {ckErr && <span className="ck-err">{ckErr}</span>}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {allDone && courseDone && (
        <div className="done-ban">
          <span className="done-ban-ic" aria-hidden="true"><IcCheck /></span>
          <div className="done-ban-body">
            <div className="done-ban-t">{s.doneTitle}</div>
            <div className="done-ban-s">
              {openExam ? s.doneWithExam : courseExams.length ? s.doneExamLocked : s.doneNoExam}
            </div>
          </div>
          {openExam ? (
            <button className="btn sm" onClick={() => goExam(openExam)}>{s.goExam}</button>
          ) : (
            <button className="btn ghost sm" onClick={goAfterCourse}>{s.finishCourse}</button>
          )}
        </div>
      )}

      <div className="course">
        <aside className="rail" ref={railRef}>
          <div className="rh">{s.courseModules}</div>
          {modules.map((m, i) => {
            const state = isDone(m) ? 'done' : current && m.id === current.id ? 'on' : '';
            return (
              <div
                key={m.id}
                className={'mrow' + (state === 'done' ? ' done' : state === 'on' ? ' on' : '')}
                onClick={() => selectModule(m)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectModule(m); } }}
                role="button"
                tabIndex={0}
                aria-current={state === 'on' ? 'true' : undefined}
                style={{ cursor: 'pointer' }}
              >
                <span className="mk">{isDone(m) ? '✓' : i + 1}</span>
                {/* Done rows trade their number for the ✓; the chip row shows both
                    (design: 「✓ 1 分级」) so the order survives on a phone. */}
                {isDone(m) && <span className="mnum" aria-hidden="true">{i + 1}</span>}
                <span className="lbl">{loc(m, 'title')}</span>
              </div>
            );
          })}
          {courseExams.map((e) => {
            const open = examOpen(e);
            return (
              <div
                key={e.id}
                className={'mrow exam-row' + (open ? '' : ' locked')}
                onClick={open ? () => goExam(e) : undefined}
                onKeyDown={open ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goExam(e); } } : undefined}
                role={open ? 'button' : undefined}
                tabIndex={open ? 0 : undefined}
                aria-disabled={open ? undefined : 'true'}
                title={open ? undefined : s.examLocked}
              >
                <span className="mk">{open ? <IcExam /> : <IcLock />}</span>
                <span className="lbl">{loc(e, 'title') || s.finalExam}</span>
                {e.timeLimitMinutes != null && (
                  <span className="exam-tag tnum">{s.examMin(e.timeLimitMinutes)}</span>
                )}
              </div>
            );
          })}
        </aside>

        <main className="content">
          {!current ? (
            <div style={{ padding: '48px 8px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
              {s.emptyModule}
            </div>
          ) : (
            <>
              <div className="ctitle">
                <h2>{loc(current, 'title')}</h2>
                <button className="tts" onClick={toggleReadAloud}>
                  <IcSpeaker />{speaking ? s.stopReading : s.readAloud}
                </button>
              </div>
              <div className="csub">{s.modOfMin(currentIndex + 1, modules.length, current.minutes || 0)}</div>

              {sections.length === 0 ? (
                <div style={{ padding: '32px 8px', color: 'var(--ink-3)', fontSize: 14 }}>{s.emptyModule}</div>
              ) : (
                sections.map((sec, si) => (
                  <section key={si} style={{ marginBottom: 24 }}>
                    {loc(sec, 'heading') && <h2 style={{ fontSize: 17, marginBottom: 10 }}>{loc(sec, 'heading')}</h2>}
                    {loc(sec, 'html') && (
                      <div className="prose" dangerouslySetInnerHTML={{ __html: loc(sec, 'html') }} />
                    )}

                    {/* 5.6：小节视频与视频附件一律走带查看人水印的播放器（不下载、不画中画、全屏带水印） */}
                    {sec.video && (
                      <WatermarkedVideo src={sec.video} label={loc(sec, 'heading') || loc(current, 'title')} className="course-video" />
                    )}
                    {/* CX-034（2026-10-09 验收）：视频文件直链（videoKind = file）用带水印的播放器，不再 iframe（常见站点 frame-ancestors 拒绝显示） */}
                    {sec.videoEmbed && sec.videoKind === 'file' && (
                      <WatermarkedVideo src={sec.videoEmbed} label={loc(sec, 'heading') || loc(current, 'title')} className="course-video" />
                    )}
                    {sec.videoEmbed && sec.videoKind !== 'file' && (
                      <iframe
                        src={sec.videoEmbed}
                        allowFullScreen
                        title={loc(sec, 'heading') || 'video'}
                        style={{ width: '100%', aspectRatio: '16 / 9', border: 0, borderRadius: 'var(--radius)', margin: '14px 0' }}
                      />
                    )}

                    {Array.isArray(sec.attachments) && sec.attachments.map((a) => {
                      const href = `/api/attachments/${a.id}`;
                      const size = formatSize(a.size);
                      if (a.kind === 'pdf') {
                        return (
                          <div className="doc" key={a.id}>
                            <div className="doc-lab">
                              <span className="t"><IcDoc />{a.name}{size ? ` · ${size}` : ''}</span>
                            </div>
                            {/* 5.6 水印画进课件页面；5.7 slideMedia = 课件内视频，翻到该页时在幻灯片下方播放 */}
                            <PdfViewer url={href} note={s.viewOnly} media={a.slideMedia} watermark />
                          </div>
                        );
                      }
                      if (a.kind === 'audio') {
                        return (
                          <div className="doc" key={a.id}>
                            <div className="doc-lab">
                              <span className="t"><IcDoc />{a.name}{size ? ` · ${size}` : ''}</span>
                            </div>
                            <audio controls src={href} style={{ width: '100%' }} />
                          </div>
                        );
                      }
                      if (a.kind === 'video') {
                        return (
                          <div className="doc" key={a.id}>
                            <div className="doc-lab">
                              <span className="t"><IcDoc />{a.name}{size ? ` · ${size}` : ''}</span>
                            </div>
                            <WatermarkedVideo src={href} label={a.name} />
                          </div>
                        );
                      }
                      // 'doc' (and any other kind) = an Office original still waiting to be
                      // converted to PDF (P0 1.3). PPT / Word / Excel are never offered as a
                      // download, so this card carries no link at all — the server answers
                      // 409 pending_conversion for the file until the console converts it.
                      return (
                        <div className="attach is-pending" key={a.id}>
                          <div className="file"><IcDoc brand /></div>
                          <div className="fmeta">
                            <div className="fn">{a.name}</div>
                            <div className="fs">{s.pendingConv}</div>
                          </div>
                          <span className="pill muted">{s.pendingTag}</span>
                        </div>
                      );
                    })}
                  </section>
                ))
              )}

              {completeError && (
                <div style={{ color: 'var(--ink-3)', fontSize: 13, marginBottom: 10 }}>{s.error}</div>
              )}

              {/* Phones get the design's short labels so both buttons still fit
                  one row; the wide screen keeps the explicit ones. */}
              <div className="footer-nav">
                <button className="btn ghost" onClick={goBack}>
                  {currentIndex > 0 ? (narrow ? s.prevModShort : s.prevMod) : s.backToPath}
                </button>
                {!currentComplete ? (
                  <button className="btn" onClick={markComplete} disabled={completing}>
                    <IcCheck />
                    {completing ? s.completing : (hasNextNotDone && !narrow) ? s.completeNext : s.completeLast}
                  </button>
                ) : allDone ? (
                  <button className="btn" onClick={goAfterCourse}>{s.finishCourse}</button>
                ) : (
                  <button className="btn" onClick={goNextModule}>{s.nextModule}</button>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
