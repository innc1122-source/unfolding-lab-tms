import Overlay from '../components/Overlay.jsx';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAsync, api } from '../api.js';
import { date as fmtDate } from '../fmt.js';   // 一致性整改 3
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';
import { withFrom } from '../trailsource.js';

// Employee project home: phase stepper + per-activity status. Five activity
// categories (server field `category`):
//   线上课程 online_course   — course activity whose course.mode is not offline (legacy
//                              学习包 'program' activities also read as 线上课程) → course/program page
//   线下课程 offline_course  — course activity whose course.mode is offline → course page (check-in there)
//   线上活动 online_activity — stored type 'online': a link + start time + duration
//   线下活动 offline_activity — stored type 'offline': check in here with the rotating 6-digit code
//   结业考试 exam            → exam-prep page
// An online activity completes one of three ways (a.completion):
//   click   — opening its link records completion (POST …/complete via:'click');
//   self    — the learner presses 我已完成 (via:'self');
//   trainer — the trainer or HR records it; the learner only sees 待讲师确认.
// Learners can complete it while the program is running or closing; the server
// withholds the link (url null) while its phase is locked.
const T = {
  zh: {
    loadErr: '加载失败，请刷新页面重试。', notFound: '未找到该发展项目，或你不在参与名单中。',
    phase: (n) => `阶段 ${n}`, locked: '完成上一阶段全部必修后解锁', lockedTime: (d) => `${d} 开放`,
    required: '必修', optional: '选修', done: '已完成', todo: '进行', phCur: '进行中',
    actCount: (n, r) => `${n} 项 · ${r} 必修`,
    typeProgram: '线上课程', typeCourse: '线上课程', typeExam: '结业考试', typeOffline: '线下活动',
    typeOfflineCourse: '线下课程', typeOnline: '线上活动', tbd: '时间待定', goCheckin: '查看 / 签到',
    openLink: '打开链接', markDone: '我已完成', waitTrainer: '待讲师确认', stCompleted: '已完成',
    clickHint: '打开链接即记为完成', durMin: (n) => `${n} 分钟`, actNotOpen: '项目进行中或收尾中才可完成',
    noLink: '链接待发布', phaseNotOpen: '该阶段尚未开放', cpErr: '操作未成功，请刷新页面后重试。',
    brokenTitle: '内容已下架', brokenHint: '这项内容已被移除，不计入本阶段完成要求。如有疑问请联系 HR。',
    goLearn: '开始学习', goExam: '前往考试', review: '复习', checkin: '签到', ckNotOpen: '项目进行中才可签到',
    stAttended: '已签到', stLate: '已签到 · 迟到', stExcused: '已请假 · 需补课',
    stStudied: '已学完', stPassed: '已通过', stFailed: '未通过',
    progressPct: (n) => `进度 ${n}%`, scorePct: (n) => `成绩 ${n}%`, bestPct: (n) => `最好成绩 ${n}%`,
    classOf: (c) => `班级 ${c}`, phaseOf: (n, tot) => `阶段 ${n}/${tot}`,
    ckTitle: (t2) => `现场签到 · ${t2}`, ckLead: '输入现场大屏上的 6 位签到码',
    ckSubmit: '签到', ckCancel: '取消', ckOk: '签到成功', ckOkLate: '签到成功（迟到）', ckDone: '完成',
    ckBadCode: '签到码错误或已过期，请查看大屏上的最新签到码后重试。',
    ckEnded: '期次已结束，不能签到。',
    ckNotToday: (d) => `签到只在活动当天开放（活动日期 ${d}）。`,
    dueAt: (d) => `截止 ${d}`, at: (t2) => t2, loc2: (l) => l,
  },
  en: {
    loadErr: 'Couldn’t load. Refresh the page to try again.', notFound: 'This program was not found, or you are not enrolled in it.',
    phase: (n) => `Phase ${n}`, locked: 'Unlocks after every required activity in the previous phase',
    lockedTime: (d) => `Opens ${d}`,
    required: 'Required', optional: 'Elective', done: 'Done', todo: 'Open', phCur: 'In progress',
    actCount: (n, r) => `${n} items · ${r} required`,
    typeProgram: 'Online course', typeCourse: 'Online course', typeExam: 'Final exam', typeOffline: 'In-person activity',
    typeOfflineCourse: 'In-person course', typeOnline: 'Online activity', tbd: 'Time TBD', goCheckin: 'View / Check in',
    openLink: 'Open link', markDone: 'Mark as done', waitTrainer: 'Awaiting trainer confirmation', stCompleted: 'Completed',
    clickHint: 'Opening the link marks it done', durMin: (n) => `${n} min`, actNotOpen: 'Available while the program is in progress or wrapping up',
    noLink: 'Link not yet available', phaseNotOpen: 'This phase is not open yet', cpErr: 'That didn’t go through. Refresh the page and try again.',
    brokenTitle: 'Content removed', brokenHint: 'This item was removed and no longer counts toward this phase. Contact HR if you have questions.',
    goLearn: 'Start', goExam: 'Go to exam', review: 'Review', checkin: 'Check in', ckNotOpen: 'Check-in opens when the program is in progress',
    stAttended: 'Checked in', stLate: 'Checked in · late', stExcused: 'Excused · make-up required',
    stStudied: 'Completed', stPassed: 'Passed', stFailed: 'Not passed',
    progressPct: (n) => `${n}% complete`, scorePct: (n) => `Score ${n}%`, bestPct: (n) => `Best score ${n}%`,
    classOf: (c) => `Class ${c}`, phaseOf: (n, tot) => `Phase ${n}/${tot}`,
    ckTitle: (t2) => `Check in · ${t2}`, ckLead: 'Enter the 6-digit code on the screen',
    ckSubmit: 'Check in', ckCancel: 'Cancel', ckOk: 'Checked in', ckOkLate: 'Checked in (late)', ckDone: 'Done',
    ckBadCode: 'Incorrect or expired code. Check the latest code on the screen and try again.',
    ckEnded: 'This cohort has ended, so check-in is closed.',
    ckNotToday: (d) => `Check-in is open only on the day of the session (${d}).`,
    dueAt: (d) => `Due ${d}`, at: (t2) => t2, loc2: (l) => l,
  },
};
/* Activity-type and state marks. Line icons on the existing svg.ic convention
   (stroke 1.8, stroke:currentColor), so each one takes the colour its badge
   already sets — .st.done green, .st.cur brand, .st.lock grey, .dot per step. */
const Ic = ({ d }) => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;
// Keyed by activity category (same vocabulary as the server's `category`).
const TYPE_IC = {
  online_course: <Ic d={<><path d="M4 14v-2a8 8 0 0116 0v2" /><path d="M4 14h3v5H5a1 1 0 01-1-1z" /><path d="M20 14h-3v5h2a1 1 0 001-1z" /></>} />, // headset — recorded content
  program: <Ic d={<><path d="M5 4h9a2 2 0 012 2v14H7a2 2 0 01-2-2z" /><path d="M9 8h6M9 12h6" /></>} />,  // stacked pages
  exam: <Ic d={<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9z" /><path d="M9 11h6M9 15h4" /></>} />, // clipboard
  offline_activity: <Ic d={<><path d="M3 21h18" /><path d="M5 21V6l7-3 7 3v15" /><path d="M10 21v-5h4v5" /><path d="M9 10h2M13 10h2" /></>} />, // venue building
  offline_course: <Ic d={<><rect x="4" y="4" width="16" height="10" rx="1" /><path d="M12 14v3" /><path d="M8 21l4-4 4 4" /></>} />, // whiteboard on an easel
  online_activity: <Ic d={<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M10 8l4 2-4 2z" /><path d="M8 20h8M12 16v4" /></>} />, // monitor with play mark
};
// The activity's category. The server sends `category`; the fallback derives the
// same value from the stored type so an older response still gets a label/icon.
const catOf = (a) => a.category || (a.type === 'course'
  ? (a.mode === 'offline' ? 'offline_course' : 'online_course')
  : ({ online: 'online_activity', offline: 'offline_activity' }[a.type] || a.type));
const SAFE_LINK = /^https?:\/\//i;
// Unrecognised type; the not-yet-unlocked state; a removed course/exam.
const IC_OTHER = <Ic d={<circle cx="12" cy="12" r="7" />} />;
const IC_LOCK = <Ic d={<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>} />;
const IC_WARN = <Ic d={<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>} />;

export default function ProjectHome() {
  const { lang, loc } = useI18n();
  const { id } = useParams();
  const nav = useNavigate();
  const s = T[lang] || T.en;
  const { loading, error, data, reload } = useAsync(() => api.get(`/api/me/tprojects/${id}`), [id]);
  const [ck, setCk] = useState(null); // activity being checked into
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [ckMsg, setCkMsg] = useState(null); // {ok, text}
  const [actErr, setActErr] = useState(null); // {id, text} — online-activity completion failed
  const [actBusy, setActBusy] = useState(null); // id of the online activity being marked done

  // Only the first load shows the placeholder: reload() after a check-in or a
  // completion keeps the page (and its scroll position) while it refetches.
  // Switching to another program still shows the placeholder, never the old one.
  if (loading && (!data || data.id !== id)) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>…</div></div>;
  if (error || !data) {
    return (
      <div className="wrap">
        <ModuleTrail items={learnTrail(lang, 'programs')} />
        <div style={{ padding: '72px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>
          {error && error.status === 404 ? s.notFound : s.loadErr}
        </div>
      </div>
    );
  }

  const catLabel = (a) => ({
    online_course: s.typeCourse, offline_course: s.typeOfflineCourse, online_activity: s.typeOnline,
    offline_activity: s.typeOffline, exam: s.typeExam, program: s.typeProgram,
  })[catOf(a)] || '';
  // 负责人 2026-10-06：学员在项目「进行中」或「收尾中」都可完成线上活动（收尾中留给补做问卷、补看回放）
  const actOpen = data.status === 'running' || data.status === 'closing';

  // The phase you are on — the phone header shows only this line, since the
  // stepper is hidden at that width. All phases done falls back to the last one.
  const firstOpen = data.phases.findIndex((p) => !p.complete);
  const curNo = (firstOpen >= 0 ? firstOpen : data.phases.length - 1) + 1;
  const curPhase = data.phases[curNo - 1] || null;

  const openActivity = (a) => {
    // 从培养项目进入课程与考试：页头路径显示「培训 › 培养项目 › 〈项目名〉 › …」（D-29）
    if (a.type === 'exam' && a.programId && a.examId) nav(withFrom(`/exam-prep/${a.programId}/${a.examId}`, { kind: 'project', id }));
    else if (a.type === 'course' && a.courseId) nav(withFrom(`/course/${a.courseId}`, { kind: 'project', id }));
    else if (a.type === 'program' && a.programId) nav(withFrom(`/program/${a.programId}`, { kind: 'project', id }));
  };

  const submitCk = async (val) => {
    setBusy(true);
    try {
      const r = await api.post(`/api/me/tprojects/${id}/checkin`, { activityId: ck.id, code: String(val ?? code).trim() });
      setCkMsg({ ok: true, text: r.status === 'late' ? s.ckOkLate : s.ckOk });
      reload();
    } catch (e) {
      const code = e && e.data && e.data.code;   // CX-025：期次已结束另给文案
      setCkMsg({ ok: false, text: code === 'badcode' ? s.ckBadCode : code === 'cohort_ended' ? s.ckEnded : code === 'checkin_not_today' ? s.ckNotToday(e.data.sessionDay) : (e && e.message) || s.loadErr });
    } finally { setBusy(false); }
  };

  // 线上活动完成失败的提示：项目未在进行/收尾 → actNotOpen；阶段未开放 → phaseNotOpen（不用 s.locked，
  // 按时间开放的阶段并不是「完成上一阶段后解锁」）；其余（trainer_only / mode_mismatch / not_found）说明页面已过期。
  const actErrText = (code) => code === 'not_running' ? s.actNotOpen : code === 'phase_locked' ? s.phaseNotOpen : s.cpErr;

  // 「学员自行确认」：点「我已完成」。
  const complete = async (a, via) => {
    setActErr(null); setActBusy(a.id);
    try {
      await api.post(`/api/me/tprojects/${id}/complete`, { activityId: a.id, via });
      reload();
    } catch (e) {
      setActErr({ id: a.id, text: actErrText(e && e.data && e.data.code) });
    } finally { setActBusy(null); }
  };

  // 「打开链接即完成」：链接是真正的 <a target=_blank>，这里不阻止默认行为、也不在导航前等待，
  // 浏览器照常开新标签页。请求用 fetch keepalive 发出 —— 切到新标签页后（手机上本页常被挂起）
  // 请求也能送达。请求方式与 api.js 一致：同源 cookie + JSON，服务端按 Origin 校验 CSRF。
  const completeByClick = (a) => {
    setActErr(null);
    let req;
    try {
      req = fetch(`/api/me/tprojects/${id}/complete`, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId: a.id, via: 'click' }),
      });
    } catch (e) { req = Promise.reject(e); }
    req.then(async (res) => {
      if (res.ok) { reload(); return; }
      const d = await res.json().catch(() => null);
      setActErr({ id: a.id, text: actErrText(d && d.code) });
    }).catch(() => setActErr({ id: a.id, text: s.cpErr }));
  };

  // 线上活动的操作区。「打开链接」一律是真正的 <a target=_blank rel=noopener noreferrer>，
  // 只有服务端给了 http(s) 链接时才显示。
  const onlineCta = (a, link) => {
    const ghost = link ? <a className="btn ghost sm" href={link} target="_blank" rel="noopener noreferrer">{s.openLink}</a> : null;
    if (a.done) return <>{ghost}<span className="pill ok">{s.done}</span></>;
    // 讲师登记的活动已登记请假：不再显示「待讲师确认」，改显示「已请假 · 需补课」
    // （负责人 2026-10-06：请假一律不算完成、需补课，见服务端 TP_ONLINE_DONE）
    if (a.completion === 'trainer') return <>{ghost}<span className="pill">{a.state === 'excused' ? s.stExcused : s.waitTrainer}</span></>;
    if (!actOpen) return a.completion === 'click' ? <span className="pill">{s.actNotOpen}</span> : <>{ghost}<span className="pill">{s.actNotOpen}</span></>;
    if (a.completion === 'click') {
      return link
        ? <a className="btn sm" href={link} target="_blank" rel="noopener noreferrer"
            onClick={() => completeByClick(a)}
            onAuxClick={(e) => { if (e.button === 1) completeByClick(a); }}>{s.openLink}</a>
        : <span className="pill">{s.noLink}</span>;
    }
    return (
      <>
        {ghost}
        <button className="btn sm" disabled={actBusy === a.id} onClick={() => complete(a, 'self')}>{actBusy === a.id ? '…' : s.markDone}</button>
      </>
    );
  };

  return (
    <div className="wrap">{/* 11.1 宽度规则 A：内容区撑满，不单独限宽 */}
      <ModuleTrail items={[...learnTrail(lang, 'programs'), { label: loc(data, 'title') }]} />

      <div className="hero" style={{ marginBottom: 22 }}>
        <div className="body">
          <span className="pill pri">{data.cohort}{data.class ? ` · ${s.classOf(data.class)}` : ''}</span>
          <h1>{loc(data, 'title')}</h1>
          <div className="tp-esteps">
            {data.phases.map((ph, i) => (
              // 锁定的阶段一律显示锁定态：请假需补课时，结业阶段可能已有通过的考试，但仍未解锁（QA 2026-10-06 第 8 节）
              <span key={ph.id} className={'tp-estep' + (ph.unlocked && ph.complete ? ' done' : ph.unlocked ? ' cur' : '')}>
                <span className="dot">{ph.unlocked && ph.complete ? '✓' : ph.unlocked ? i + 1 : IC_LOCK}</span>
                {loc(ph, 'name')}
                {i < data.phases.length - 1 && <i className="ln" aria-hidden="true" />}
              </span>
            ))}
          </div>
        </div>
        <div className="tpe-ring lg tnum">{data.progress}<span>%</span></div>
        {/* Phone-only summary of the stepper. It sits after the ring so the
            stacked phone header reads 48% → 阶段 2/4 · 能力建设. */}
        {curPhase && (
          <div className="tp-ephase">{s.phaseOf(curNo, data.phases.length)} · {loc(curPhase, 'name')}</div>
        )}
      </div>

      {data.phases.map((ph, i) => (
        <div key={ph.id} className={ph.unlocked ? '' : 'tp-locked'}>
          <div className="sec-h">
            <h2>{s.phase(i + 1)} · {loc(ph, 'name')}</h2>
            {/* 解锁的阶段给一个「N 项 · M 必修」计数（设计稿有，之前只有锁住的阶段有 .count）。
                锁住的阶段继续只说解锁条件 —— 那句比计数有用，而 .sec-h 是 flex 无 space-between，
                两个 .count 会挤在一起。 */}
            {ph.unlocked && ph.activities.length > 0 && (
              <span className="count">
                {s.actCount(ph.activities.length, ph.activities.filter((a) => a.required).length)}
              </span>
            )}
            {!ph.unlocked ? (
              <span className="count">
                {ph.gateMode === 'time' && ph.startAt ? s.lockedTime(fmtDate(ph.startAt)) : s.locked}
              </span>
            ) : ph.complete ? (
              <span className="pill ok tp-phase-st">{s.done}</span>
            ) : ph.activities.length ? (
              // An open phase with nothing in it isn't "in progress" — no badge.
              <span className="pill pri tp-phase-st">{s.phCur}</span>
            ) : null}
          </div>
          {ph.activities.map((a) => {
            // An in-person COURSE behaves like an offline session, not like
            // self-paced content: show its schedule and send people to the
            // course page (where the check-in box lives), never "去学习".
            // A dead reference (course/exam deleted) can't be opened — say so
            // instead of showing a button that does nothing.
            if (a.broken) {
              return (
                <div key={a.id} className="card eact" style={{ background: 'var(--card)', border: '1px dashed var(--line)', borderRadius: 'var(--radius-lg)', opacity: 0.75 }}>
                  <span className="st lock">{IC_WARN}</span>
                  <div className="b" style={{ flex: 1 }}>
                    <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>{loc(a, 'title') || s.brokenTitle}</h3>
                    <div className="m" style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>{s.brokenHint}</div>
                  </div>
                </div>
              );
            }
            const inPerson = a.type === 'offline' || (a.type === 'course' && a.mode === 'offline');
            const isOnlineAct = a.type === 'online';
            const link = a.url && SAFE_LINK.test(a.url) ? a.url : null;
            const meta = [];
            const when = a.startAt || a.sessionAt;
            if (when) meta.push(when.replace('T', ' '));
            else if (inPerson) meta.push(s.tbd);
            if (a.location) meta.push(a.location);
            if (isOnlineAct && a.durationMin) meta.push(s.durMin(a.durationMin));
            if (isOnlineAct && !a.done && a.completion === 'click' && link && actOpen) meta.push(s.clickHint);
            // 「在线课程 · 进度 50%」—— 之前学到一半的课和没开始的课在项目页上一模一样。
            // 三个取舍(设计稿只给了「进度 50%」这一种状态,其余由这里决定):
            //  - 已完成的不显示:meta 尾部已经有「已学完 / 已通过」,右边还有「已完成」,
            //    再来个「进度 100%」是第三遍说同一件事;
            //  - 0% 的也不显示:一个「进度 0%」和右边的「去学习」按钮说的是同一句话,
            //    不如空着 —— 这样「行里有百分比」本身就等于「你开过这一项」,
            //    员工扫一眼就知道哪几项是半途而废的,这才是他要找的信息;
            //  - 线下活动/线下课程不显示:它们的进度只有 0/100(签到与否),百分比
            //    只是把「已签到」换个写法;线下课的完成也是靠签到而不是点内容进度,
            //    显示内容百分比会误导。
            // 考试走下面的分数分支 —— 对考试来说「最好成绩 62%」比「进度 62%」有意义。
            const pct = Number.isFinite(a.progressPercent) ? Math.round(a.progressPercent) : null;
            if (!inPerson && a.type !== 'exam' && !a.done && pct > 0) meta.push(s.progressPct(pct));
            if (a.dueAt) meta.push(s.dueAt(a.dueAt));
            // The meta line ends with how the activity was finished (已签到 /
            // 已学完 / 已通过); the right-hand pill just says 已完成.
            // 请假（负责人 2026-10-06）不算完成：服务端给 done:false，这里写「已请假 · 需补课」，
            // 右侧照常给签到 / 前往签到按钮，学员补课时输码即可。
            if (a.state === 'late') meta.push(s.stLate);
            else if (a.state === 'excused') meta.push(s.stExcused);
            else if (a.done) meta.push(inPerson ? s.stAttended : a.type === 'exam' ? s.stPassed : isOnlineAct ? s.stCompleted : s.stStudied);
            // 「成绩自动同步」是这个模块的卖点，但员工端原来只能看到「已通过」。
            // 通过 → 已通过 · 成绩 85%;考过没通过 → 最好成绩 62% · 未通过(重考按钮就在右边);
            // 没考过 examScore 为 null,什么都不加。
            if (a.type === 'exam' && Number.isFinite(a.examScore)) {
              if (a.examPassed) meta.push(s.scorePct(Math.round(a.examScore)));
              // 走到这里 a.done 必然是 false：考试活动的 done 就等于 best.passed
              // （服务端没有豁免/手工完成这条路），所以不需要再判一次。
              else meta.push(s.bestPct(Math.round(a.examScore)), s.stFailed);
            }
            return (
              <div key={a.id} className="card eact" style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)' }}>
                <span className={'st ' + (a.done ? 'done' : ph.unlocked ? 'cur' : 'lock')}>
                  {a.done ? '✓' : ph.unlocked ? (TYPE_IC[catOf(a)] || IC_OTHER) : IC_LOCK}
                </span>
                <div className="b" style={{ flex: 1 }}>
                  <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>
                    {loc(a, 'title') || catLabel(a)}
                    <span className={a.required ? 'req' : 'opt'} style={{ marginLeft: 8 }}>{a.required ? s.required : s.optional}</span>
                  </h3>
                  <div className="m" style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>
                    {[catLabel(a), ...meta].filter(Boolean).join(' · ')}
                  </div>
                  {actErr && actErr.id === a.id && <div className="apply-err">{actErr.text}</div>}
                </div>
                {ph.unlocked && (
                  isOnlineAct
                    ? <div className="eact-cta">{onlineCta(a, link)}</div>
                    : a.type === 'offline'
                    ? (a.done
                        ? <span className="pill ok">{s.done}</span>
                        : data.status !== 'running'   // 负责人 2026-10-06：发展项目进行中才允许签到
                          ? <span className="pill">{s.ckNotOpen}</span>
                          : <button className="btn sm" onClick={() => { setCk(a); setCode(''); setCkMsg(null); }}>{s.checkin}</button>)
                    : inPerson
                      ? (a.done
                          ? <span className="pill ok">{s.done}</span>
                          : <button className="btn sm" onClick={() => openActivity(a)}>{s.goCheckin}</button>)
                      : (a.done
                          ? <button className="btn ghost sm" onClick={() => openActivity(a)}>{s.review}</button>
                          : <button className="btn sm" onClick={() => openActivity(a)}>{a.type === 'exam' ? s.goExam : s.goLearn}</button>)
                )}
              </div>
            );
          })}
        </div>
      ))}

      {ck && (
        <Overlay style={{ width: 'min(400px,100%)' }} busy={busy} onClose={() => setCk(null)}>
            {!ckMsg || !ckMsg.ok ? (
              <>
                <h3>{s.ckTitle(loc(ck, 'title') || '')}</h3>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', margin: '4px 0 12px' }}>{s.ckLead}</div>
                <input
                  className="apply-note tnum" style={{ fontSize: 26, fontWeight: 700, letterSpacing: 8, textAlign: 'center', resize: 'none' }}
                  maxLength={6} inputMode="numeric" autoFocus value={code}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, '');
                    setCode(v);
                    if (v.length === 6 && !busy) setTimeout(() => submitCk(v), 60);
                  }}
                />
                {ckMsg && !ckMsg.ok && <div className="apply-err">{ckMsg.text}</div>}
                <div className="apply-foot">
                  <button className="btn ghost" disabled={busy} onClick={() => setCk(null)}>{s.ckCancel}</button>
                  <button className="btn" disabled={busy || code.length !== 6} onClick={() => submitCk()}>{busy ? '…' : s.ckSubmit}</button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
                <div style={{ width: 62, height: 62, borderRadius: '50%', background: '#e6f6ee', color: 'var(--success, #1f9e63)', display: 'grid', placeItems: 'center', fontSize: 28, margin: '0 auto 10px' }}>✓</div>
                <div style={{ fontWeight: 600, fontSize: 16 }}>{ckMsg.text}</div>
                <div style={{ marginTop: 14 }}>
                  <button className="btn sm" onClick={() => setCk(null)}>{s.ckDone}</button>
                </div>
              </div>
            )}
        </Overlay>
      )}
    </div>
  );
}
