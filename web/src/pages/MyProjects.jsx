import Overlay from '../components/Overlay.jsx';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { categoryLabel } from '../categories.js';   // CX-047：类别按语言显示
import { useAsync, api } from '../api.js';
import { clearMyProjectsCache } from '../tprojects.js';
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';

// Employee "My Projects": active cohort memberships + open-for-application
// projects (self-nomination). Semi-free, same visual language as Home.
const T = {
  zh: {
    title: '发展项目', lead: '你参加的发展项目与可申请的发展项目',
    loadErr: '加载失败，请刷新页面重试。', emptyMine: '暂无进行中的发展项目',
    phaseOf: (d, t) => `阶段 ${d}/${t}`, next: '下一步', enter: '进入',
    openTitle: '可申请的发展项目', apply: '申请参加', applied: '已申请 · 待审批',
    applyTitle: (t2) => `申请参加《${t2}》`, applyPh: '申请说明（选填，供审批参考）',
    submit: '提交申请', cancel: '取消', applyOk: '已提交，等待审批', applyFail: '提交失败，请重试',
    doneAll: '全部完成',
    // 下一项没有标题时按活动类别显示（服务端 nextActivity.category），不再露出 course / exam 这类原始类型名
    actType: { online_course: '线上课程', offline_course: '线下课程', online_activity: '线上活动', offline_activity: '线下活动', exam: '结业考试', program: '线上课程' },
  },
  en: {
    title: 'Development Programs', lead: 'Development programs you are in and those open for application',
    loadErr: 'Couldn’t load. Refresh the page to try again.', emptyMine: 'No active development programs',
    phaseOf: (d, t) => `Phase ${d}/${t}`, next: 'Next', enter: 'Open',
    openTitle: 'Open for Application', apply: 'Apply', applied: 'Applied · Pending approval',
    applyTitle: (t2) => `Apply for “${t2}”`, applyPh: 'Reason for applying (optional, shared with the approver)',
    submit: 'Submit application', cancel: 'Cancel', applyOk: 'Submitted — awaiting approval', applyFail: 'Submit failed, please retry',
    doneAll: 'All done',
    actType: { online_course: 'Online course', offline_course: 'In-person course', online_activity: 'Online activity', offline_activity: 'In-person activity', exam: 'Final exam', program: 'Online course' },
  },
};

export default function MyProjects() {
  const { lang, loc } = useI18n();
  const nav = useNavigate();
  const s = T[lang] || T.en;
  const { loading, error, data, reload } = useAsync(() => api.get('/api/me/tprojects'), []);
  const [applyFor, setApplyFor] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (loading) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>…</div></div>;
  if (error) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>{s.loadErr}</div></div>;

  const mine = (data && data.mine) || [];
  const open = (data && data.open) || [];

  const submitApply = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/me/tprojects/${applyFor.id}/apply`, { note });
      setApplyFor(null); setNote('');
      clearMyProjectsCache();
      reload();
    } catch (e) { setErr((e && e.message) || s.applyFail); } finally { setBusy(false); }
  };

  return (
    <div className="wrap">{/* 11.1 宽度规则 A：内容区撑满，不单独限宽 */}
      <ModuleTrail items={learnTrail(lang, 'programs')} />
      <div className="cat-head" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="cat-title">{s.title}</h2>
          <div className="cat-lead">{s.lead}</div>
        </div>
      </div>

      {mine.length === 0 && <div className="cat-empty">{s.emptyMine}</div>}
      {mine.map((p) => (
        <button key={p.id} className="pcard tpe-card" onClick={() => nav(`/projects/${p.id}`)}>
          <div className="tpe-ring tnum">{p.progress}<span>%</span></div>
          <div className="cinfo">
            <h3>{loc(p, 'title')}</h3>
            <div className="sub">
              <span className="pill pri">{s.phaseOf(p.phaseDone, p.phaseCount)}</span>
              {p.category && <span className="pill muted">{categoryLabel(p.category, lang)}</span>}
              <span>{p.cohort}{p.class ? ` · ${p.class}` : ''}</span>
            </div>
            <div className="tpe-next">
              {p.nextActivity
                ? <>{s.next}: <b>{loc(p.nextActivity, 'title') || s.actType[p.nextActivity.category] || ''}</b></>
                : s.doneAll}
            </div>
          </div>
          <div className="cact"><span className="btn sm">{s.enter}</span></div>
        </button>
      ))}

      {open.length > 0 && (
        <>
          <div className="sec-h" style={{ marginTop: 26 }}><h2>{s.openTitle}</h2><span className="count">{open.length}</span></div>
          {open.map((p) => (
            <div key={p.id} className="pcard tpe-card" style={{ cursor: 'default' }}>
              <div className="cat-badge" aria-hidden="true">{(loc(p, 'title') || '?').trim().charAt(0)}</div>
              <div className="cinfo">
                <h3>{loc(p, 'title')}</h3>
                <div className="sub">
                  {p.category && <span className="pill muted">{categoryLabel(p.category, lang)}</span>}
                  <span>{p.cohort}</span>
                </div>
              </div>
              <div className="cact">
                {p.applied
                  ? <span className="btn sm ghost home-disabled">{s.applied}</span>
                  : <button className="btn sm" onClick={() => { setApplyFor(p); setNote(''); setErr(null); }}>{s.apply}</button>}
              </div>
            </div>
          ))}
        </>
      )}

      {applyFor && (
        <Overlay label={s.applyTitle(loc(applyFor, 'title'))} busy={busy} onClose={() => setApplyFor(null)}>
            <h3>{s.applyTitle(loc(applyFor, 'title'))}</h3>
            <textarea className="apply-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={s.applyPh} />
            {err && <div className="apply-err">{err}</div>}
            <div className="apply-foot">
              <button className="btn ghost" disabled={busy} onClick={() => setApplyFor(null)}>{s.cancel}</button>
              <button className="btn" disabled={busy} onClick={submitApply}>{busy ? '…' : s.submit}</button>
            </div>
        </Overlay>
      )}
    </div>
  );
}
