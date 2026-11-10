import Overlay from '../components/Overlay.jsx';
import { useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { useAsync, api } from '../api.js';
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';

// 班主任视图 — the classes this person shepherds. Where a 讲师 owns a single
// session (see MySessions.jsx), a class head follows ONE class through the whole
// programme: who is falling behind, and the roll for their own class members.
const T = {
  zh: {
    title: '我的班级', lead: '你担任班主任的班级：学员进度与本班出勤',
    empty: '你目前未担任任何班级的班主任', loadErr: '加载失败，请刷新页面重试。',
    learners: (n) => `${n} 名学员`, period: '起止日期',
    open: '查看班级', back: '← 我的班级',
    rosterH: '学员名册', progress: '发展项目进度', phase: (a, b) => `阶段 ${a}/${b}`,
    sessionsH: '本期次线下场次', attendance: (a, b) => `本班出勤 ${a}/${b}`,
    roll: '本班点名', tbd: '时间待定', close: '关闭',
    stAttended: '出席', stLate: '迟到', stExcused: '请假', stAbsent: '缺席', stMissing: '未签',
    markup: '补签', excuse: '记请假', toPresent: '改为出席', noLearners: '本班还没有学员',
    makeupAttended: '补课出席', // 负责人 2026-10-06：请假需补课
    noSessions: '本期暂无线下场次',
  },
  en: {
    title: 'My Classes', lead: 'Classes you coordinate: learner progress and class attendance',
    empty: "You are not assigned to coordinate a class", loadErr: 'Couldn’t load. Refresh the page to try again.',
    learners: (n) => `${n} learners`, period: 'Dates',
    open: 'Open class', back: '← My Classes',
    rosterH: 'Roster', progress: 'Development Program Progress', phase: (a, b) => `Phase ${a}/${b}`,
    sessionsH: 'In-person Sessions (This Cohort)', attendance: (a, b) => `Class attendance ${a}/${b}`,
    roll: 'Take attendance', tbd: 'Time TBD', close: 'Close',
    stAttended: 'Present', stLate: 'Late', stExcused: 'Excused', stAbsent: 'Absent', stMissing: 'Missing',
    markup: 'Mark present', excuse: 'Excuse', toPresent: 'Set present', noLearners: 'No learners in this class yet',
    makeupAttended: 'Mark make-up attended',
    noSessions: 'No in-person sessions in this cohort',
  },
};

export default function MyClasses() {
  const { lang, loc } = useI18n();
  const s = T[lang] || T.en;
  const { loading, error, data } = useAsync(() => api.get('/api/me/classes'), []);
  const [openCls, setOpenCls] = useState(null);

  if (loading) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>…</div></div>;
  if (error) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>{s.loadErr}</div></div>;
  const classes = (data && data.classes) || [];

  if (openCls) return <ClassDetail s={s} loc={loc} lang={lang} c={openCls} onBack={() => setOpenCls(null)} />;

  return (
    <div className="wrap">
      <ModuleTrail items={learnTrail(lang, 'classes')} />
      <div className="ml-head">
        <h1 className="ml-title">{s.title}</h1>
        <p className="ml-lead">{s.lead}</p>
      </div>
      {classes.length === 0 ? (
        <div className="ml-empty">{s.empty}</div>
      ) : (
        <div className="grid">
          {classes.map((c) => (
            <div key={c.classId} className="pcard">
              <div className="cat-badge" aria-hidden="true">
                <svg className="ic" viewBox="0 0 24 24"><path d="M4 21V8l8-5 8 5v13" /><path d="M10 21v-6h4v6" /><path d="M2 21h20" /></svg>
              </div>
              <div className="cinfo">
                <h3>{c.className}</h3>
                <div className="sub">
                  <span className="pill muted">{loc(c, 'project')}</span>
                  <span>{c.cohort} · {s.learners(c.learnerCount)}</span>
                </div>
              </div>
              <div className="cact">
                <button className="btn sm" onClick={() => setOpenCls(c)}>{s.open}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClassDetail({ s, loc, lang, c, onBack }) {
  const q = useAsync(() => api.get(`/api/me/classes/${c.projectId}/${c.cohortId}/${c.classId}`), [c.classId]);
  const d = q.data;
  const [roll, setRoll] = useState(null); // activityId being rolled

  return (
    <div className="wrap">
      {/* 培训 › 我的班级 › 〈班级名〉（IA 1.4）：「我的班级」一段回到班级列表 */}
      <ModuleTrail items={[learnTrail(lang, 'classes')[0], { label: s.title, onClick: onBack }, { label: c.className }]} />
      <div className="ml-head">
        <h1 className="ml-title">{c.className}</h1>
        <p className="ml-lead">{loc(c, 'project')} · {c.cohort}{c.startAt ? ` · ${s.period} ${c.startAt} → ${c.endAt || '—'}` : ''}</p>
      </div>

      {!d ? <div className="ml-empty">…</div> : (
        <>
          <div className="sec">
            <div className="sec-h"><h2>{s.rosterH}</h2><span className="count">{(d.learners || []).length}</span></div>
            {(d.learners || []).length === 0 ? <div className="ml-empty">{s.noLearners}</div> : (
              <div className="grid">
                {d.learners.map((l) => (
                  <div key={l.userId} className="pcard">
                    <div className="tpe-ring tnum">{l.progress}<span>%</span></div>
                    <div className="cinfo">
                      <h3>{l.name}</h3>
                      <div className="sub">
                        {/* 9.1：员工端不显示工号 */}
                        {l.department && <span className="pill muted">{l.department}</span>}
                        <span>{s.phase(l.phaseDone, l.phaseCount)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="sec">
            <div className="sec-h"><h2>{s.sessionsH}</h2><span className="count">{(d.sessions || []).length}</span></div>
            {(d.sessions || []).length === 0 ? <div className="ml-empty">{s.noSessions}</div> : (
              <div className="grid">
                {d.sessions.map((x) => (
                  <div key={x.id} className="pcard">
                    <div className="cat-badge" aria-hidden="true">
                      <svg className="ic" viewBox="0 0 24 24"><path d="M9 3h6v3H9z" /><path d="M15 4h3v17H6V4h3" /><path d="M9 11h6" /><path d="M9 15h6" /></svg>
                    </div>
                    <div className="cinfo">
                      <h3>{loc(x, 'title')}</h3>
                      <div className="sub">
                        <span>{x.startAt ? x.startAt.replace('T', ' ') : s.tbd}{x.location ? ` · ${x.location}` : ''}</span>
                        <span className="pill muted">{s.attendance(x.present, x.total)}</span>
                      </div>
                    </div>
                    <div className="cact"><button className="btn sm ghost" onClick={() => setRoll(x)}>{s.roll}</button></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {roll && <RollPanel s={s} loc={loc} c={c} act={roll} onClose={() => { setRoll(null); q.reload(); }} />}
    </div>
  );
}

// Roll call limited to this class. No code display here — the trainer running
// the session owns the code; a class head is confirming who of THEIRS showed up.
function RollPanel({ s, loc, c, act, onClose }) {
  const q = useAsync(() => api.get(`/api/me/classes/${c.projectId}/checkin/${act.id}`), [act.id]);
  const d = q.data;
  const mark = async (userId, status) => {
    try { await api.post(`/api/me/classes/${c.projectId}/checkin/${act.id}/mark`, { userId, status }); q.reload(); }
    catch { /* next refresh reflects reality */ }
  };
  const label = (st) => st === 'attended' ? s.stAttended : st === 'late' ? s.stLate : st === 'excused' ? s.stExcused : st === 'absent' ? s.stAbsent : s.stMissing;
  const cls = (st) => st === 'attended' ? 'ok' : st === 'late' ? 'warn' : st === 'absent' ? 'fail' : 'muted';

  return (
    <Overlay boxClassName="ck-panel" onClose={onClose}>
        <h3>{loc(act, 'title')} · {c.className}</h3>
        {!d ? <div className="ml-empty">…</div> : (
          <>
            <div className="ck-stats">
              <span className="pill ok">{s.stAttended} {d.stats.attended}</span>
              <span className="pill warn">{s.stLate} {d.stats.late}</span>
              <span className="pill muted">{s.stExcused} {d.stats.excused}</span>
              <span className="pill fail">{s.stMissing} {d.stats.missing}</span>
            </div>
            <div className="ck-list">
              {d.list.map((r) => (
                <div key={r.userId} className="ck-row">
                  <div className="ck-who"><b>{r.name}</b></div>
                  <span className={'pill ' + cls(r.status)}>{label(r.status)}</span>
                  <div className="ck-ops">
                    {!r.status && <button className="btn sm ghost" onClick={() => mark(r.userId, 'attended')}>{s.markup}</button>}
                    {!r.status && <button className="btn sm ghost" onClick={() => mark(r.userId, 'excused')}>{s.excuse}</button>}
                    {r.status === 'late' && <button className="btn sm ghost" onClick={() => mark(r.userId, 'attended')}>{s.toPresent}</button>}
                    {/* 负责人 2026-10-06：请假需补课，补课后直接改为出席 */}
                    {r.status === 'excused' && <button className="btn sm ghost" onClick={() => mark(r.userId, 'attended')}>{s.makeupAttended}</button>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="apply-foot"><button className="btn ghost" onClick={onClose}>{s.close}</button></div>
    </Overlay>
  );
}
