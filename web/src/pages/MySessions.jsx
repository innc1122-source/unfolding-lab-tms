import Overlay from '../components/Overlay.jsx';
import { useState, useEffect } from 'react';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { useAsync, api } from '../api.js';
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';

// 讲师工作台 — the sessions THIS person delivers (project activities or
// standalone in-person courses assigned to them as trainer). A trainer owns the
// session: its attendees can span several classes, and they take the roll for
// everyone present. Contrast MyClasses.jsx (班主任), which is scoped to one
// class across the whole programme.
// A trainer-recorded 线上活动 (online activity, completion 'trainer') is a
// session too: the server answers its roll with rollKind 'completion' — no
// check-in code, statuses completed / excused — and the trainer records each
// learner's completion here (never their own row: the server answers 403 self_mark).
// (Employee app is Semi-free: plain elements + shared CSS.)
const T = {
  zh: {
    title: '我的授课', lead: '你负责讲授的场次、现场签到与出勤登记，以及线上活动的完成登记',
    empty: '目前没有安排给你的授课场次', loadErr: '加载失败，请刷新页面重试。',
    tbd: '时间待定', attendees: (n) => `${n} 人参加`,
    runCheckin: '开始签到', close: '关闭', refresh: '刷新',
    notOpen: '发展项目「进行中」才开放签到，现在不生成签到码。名单与补签照常可用。',
    ended: '该期次已过结束日，不再生成签到码。名单与补签照常可用。',
    code: '签到码', codeHint: '请学员在手机上打开对应课程或发展项目页面，输入此签到码', rotate: '每分钟自动更换',
    big: '投屏模式', exitBig: '点击任意位置退出投屏',
    stAttended: '出席', stLate: '迟到', stExcused: '请假', stAbsent: '缺席', stMissing: '未签到',
    colName: '学员', colClass: '班级', colState: '状态',
    markup: '补签', excuse: '登记请假', toPresent: '改为出席',
    makeupAttended: '补课出席', makeupDone: '补登记完成', // 负责人 2026-10-06：请假需补课
    present: (a, b) => `${a} / ${b} 已到`,
    runMark: '登记完成', stCompleted: '已完成', stNotDone: '未完成', markDone: '标记完成', openLink: '打开链接',
    durMin: (n) => `${n} 分钟`, cpHint: '线上活动没有签到码：学员完成后，请在下方逐一登记。',
    selfRow: '本人的完成由 HR 登记', markErr: '登记未成功，请刷新后重试。',
  },
  en: {
    title: 'My Sessions', lead: 'Sessions you deliver: check-in, attendance and online-activity completion',
    empty: 'No sessions are assigned to you yet', loadErr: 'Couldn’t load. Refresh the page to try again.',
    tbd: 'Time TBD', attendees: (n) => `${n} attending`,
    runCheckin: 'Start check-in', close: 'Close', refresh: 'Refresh',
    notOpen: 'Check-in opens only while the program is In progress, so no code is shown yet. You can still use the list and record make-ups.',
    ended: 'This cohort is past its end date, so no code is generated. You can still use the list and record make-ups.',
    code: 'Check-in code', codeHint: 'Ask learners to open the course or program page on their phone and enter this code', rotate: 'Rotates every minute',
    big: 'Projector mode', exitBig: 'Click anywhere to exit',
    stAttended: 'Present', stLate: 'Late', stExcused: 'Excused', stAbsent: 'Absent', stMissing: 'Not checked in',
    colName: 'Learner', colClass: 'Class', colState: 'Status',
    markup: 'Mark present', excuse: 'Mark excused', toPresent: 'Change to present',
    makeupAttended: 'Mark make-up attended', makeupDone: 'Mark make-up done',
    present: (a, b) => `${a} / ${b} present`,
    runMark: 'Record completion', stCompleted: 'Completed', stNotDone: 'Not done', markDone: 'Mark done', openLink: 'Open link',
    durMin: (n) => `${n} min`, cpHint: 'Online activities have no check-in code. Record each learner below once they have completed it.',
    selfRow: 'HR records your own completion', markErr: 'That didn’t go through. Refresh and try again.',
  },
};
const SAFE_LINK = /^https?:\/\//i;

export default function MySessions() {
  const { lang, loc } = useI18n();
  const s = T[lang] || T.en;
  const { loading, error, data, reload } = useAsync(() => api.get('/api/me/sessions'), []);
  const [ck, setCk] = useState(null); // session being checked in

  const sessions = (data && data.sessions) || [];
  if (loading) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>…</div></div>;
  if (error) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>{s.loadErr}</div></div>;

  return (
    <div className="wrap">
      <ModuleTrail items={learnTrail(lang, 'sessions')} />
      <div className="ml-head">
        <h1 className="ml-title">{s.title}</h1>
        <p className="ml-lead">{s.lead}</p>
      </div>

      {sessions.length === 0 ? (
        <div className="ml-empty">{s.empty}</div>
      ) : (
        <div className="grid">
          {sessions.map((x) => {
            // 线上活动（讲师登记完成）：显示时长而不是地点，按钮是「登记完成」，打开同一个名单面板
            const online = x.category === 'online_activity';
            const link = online && x.url && SAFE_LINK.test(x.url) ? x.url : null;
            return (
            <div key={x.key} className="pcard">
              <div className="cat-badge" aria-hidden="true">
                {online
                  ? <svg className="ic" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M10 8l4 2-4 2z" /><path d="M8 20h8M12 16v4" /></svg>
                  : <svg className="ic" viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v4" /><path d="M9 21h6" /></svg>}
              </div>
              <div className="cinfo">
                <h3>{loc(x, 'title') || s.title}</h3>
                <div className="sub">
                  {loc(x, 'context') && <span className="pill muted">{loc(x, 'context')}</span>}
                  <span>
                    {x.startAt ? x.startAt.replace('T', ' ') : s.tbd}
                    {online ? (x.durationMin ? ` · ${s.durMin(x.durationMin)}` : '') : (x.location ? ` · ${x.location}` : '')}
                  </span>
                </div>
              </div>
              <div className="cact ses-cact">
                {link && <a className="btn sm ghost" href={link} target="_blank" rel="noopener noreferrer">{s.openLink}</a>}
                <button className="btn sm" onClick={() => setCk(x)}>{online ? s.runMark : s.runCheckin}</button>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {ck && <CheckinPanel s={s} loc={loc} session={ck} onClose={() => { setCk(null); reload(); }} />}
    </div>
  );
}

// Rotating-code console + roll call. Same mechanics as the HR view, but the
// list only ever contains this session's attendees.
function CheckinPanel({ s, loc, session, onClose }) {
  const { lang } = useI18n();
  const { user } = useAuth();
  const q = useAsync(() => api.get(`/api/me/sessions/${encodeURIComponent(session.key)}/checkin`), [session.key]);
  const d = q.data;
  // 线上活动的完成名单（rollKind 'completion'）：没有签到码，状态只有 已完成 / 请假 / 未完成
  const isCp = !!d && d.rollKind === 'completion';
  const [big, setBig] = useState(false);
  const [left, setLeft] = useState(null);
  const [markErr, setMarkErr] = useState(null);

  // Poll faster while projecting; tick the countdown locally and refetch the
  // moment the code expires so the screen is never showing a stale number.
  useEffect(() => {
    const iv = setInterval(() => q.reload(), big ? 10000 : 20000);
    return () => clearInterval(iv);
  }, [big]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (d) setLeft(d.secondsLeft); }, [d]);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => {
      if (v == null) return v;
      if (v <= 1) { q.reload(); return null; }
      return v - 1;
    }), 1000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const mark = async (userId, status) => {
    setMarkErr(null);
    try { await api.post(`/api/me/sessions/${encodeURIComponent(session.key)}/checkin/mark`, { userId, status }); q.reload(); }
    catch (e) {
      // 签到名单照旧由下一次刷新体现；完成登记失败（如 bad_status、self_mark）则直接说明
      const msg = lang === 'zh' ? (e && e.data && e.data.error_zh) : (e && e.message);
      if (isCp) setMarkErr(msg || s.markErr);
    }
  };
  const label = (st) => st === 'completed' ? s.stCompleted : st === 'attended' ? s.stAttended : st === 'late' ? s.stLate : st === 'excused' ? s.stExcused : st === 'absent' ? s.stAbsent : isCp ? s.stNotDone : s.stMissing;
  const cls = (st) => st === 'completed' || st === 'attended' ? 'ok' : st === 'late' ? 'warn' : st === 'absent' ? 'fail' : 'muted';
  const present = d ? (isCp ? d.stats.completed : d.stats.attended + d.stats.late) : 0;
  const total = d ? d.list.length : 0;

  return (
    <Overlay boxClassName="ck-panel" onClose={onClose}>
        {big && d && d.code && (
          <div className="ckbig" onClick={() => setBig(false)}>
            <div className="ckbig-exit">{s.exitBig}</div>
            <div className="ckbig-title">{loc(session, 'title')}</div>
            <div className="ckbig-code tnum">{String(d.code).split('').map((ch, i) => <span key={i}>{ch}</span>)}</div>
            <div className="ckbig-bar"><i style={{ width: `${((left || 0) / 60) * 100}%` }} /></div>
            <div className="ckbig-meta">{s.rotate} · {s.codeHint}</div>
            <div className="ckbig-count tnum">{present} / {total}</div>
          </div>
        )}
        <h3>{loc(session, 'title')}</h3>
        {!d ? <div className="ml-empty">…</div> : (
          <>
            {isCp ? <div className="ck-codebox"><div className="ck-codehint">{s.cpHint}</div></div>
              : d.checkinOpen === false ? <div className="ck-codebox"><div className="ck-codehint">{d.cohortEnded ? s.ended : s.notOpen}</div></div> : (
            <div className="ck-codebox">
              <div className="ck-codelab">{s.code}{left != null ? ` · ${left}s` : ''}</div>
              <div className="ck-code tnum">{d.code}</div>
              <div className="ck-codehint">{s.codeHint}</div>
              <div className="ck-codeact">
                <button className="btn sm" onClick={() => setBig(true)}>{s.big}</button>
                <button className="btn sm ghost" onClick={() => q.reload()}>{s.refresh}</button>
              </div>
            </div>
            )}
            {isCp ? (
              <div className="ck-stats">
                <span className="pill ok">{s.stCompleted} {d.stats.completed}</span>
                <span className="pill muted">{s.stExcused} {d.stats.excused}</span>
                <span className="pill fail">{s.stNotDone} {d.stats.missing}</span>
              </div>
            ) : (
            <div className="ck-stats">
              <span className="pill ok">{s.stAttended} {d.stats.attended}</span>
              <span className="pill warn">{s.stLate} {d.stats.late}</span>
              <span className="pill muted">{s.stExcused} {d.stats.excused}</span>
              <span className="pill fail">{s.stMissing} {d.stats.missing}</span>
            </div>
            )}
            {markErr && <div className="apply-err">{markErr}</div>}
            <div className="ck-list">
              {d.list.map((r) => (
                <div key={r.userId} className="ck-row">
                  <div className="ck-who">
                    <b>{r.name}</b>
                    {/* 9.1：员工端不显示工号 */}
                    {r.department && <span className="ck-sub">{r.department}</span>}
                    {r.className && <span className="pill muted">{r.className}</span>}
                  </div>
                  <span className={'pill ' + cls(r.status)}>{label(r.status)}</span>
                  <div className="ck-ops">
                    {isCp && user && r.userId === user.id ? (
                      // 讲师本人也在本期学员里：服务端不允许给自己登记（403 self_mark），由 HR 登记
                      !r.status && <span className="pill muted">{s.selfRow}</span>
                    ) : (
                      <>
                        {!r.status && (isCp
                          ? <button className="btn sm ghost" onClick={() => mark(r.userId, 'completed')}>{s.markDone}</button>
                          : <button className="btn sm ghost" onClick={() => mark(r.userId, 'attended')}>{s.markup}</button>)}
                        {!r.status && <button className="btn sm ghost" onClick={() => mark(r.userId, 'excused')}>{s.excuse}</button>}
                        {!isCp && r.status === 'late' && <button className="btn sm ghost" onClick={() => mark(r.userId, 'attended')}>{s.toPresent}</button>}
                        {/* 负责人 2026-10-06：请假需补课，补完直接改为出席 / 已完成 */}
                        {r.status === 'excused' && <button className="btn sm ghost" onClick={() => mark(r.userId, isCp ? 'completed' : 'attended')}>{isCp ? s.makeupDone : s.makeupAttended}</button>}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="apply-foot">
          <button className="btn ghost" onClick={onClose}>{s.close}</button>
        </div>
    </Overlay>
  );
}
