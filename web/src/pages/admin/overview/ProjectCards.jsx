// 进行中的培养项目（第三批 4.1，设计 §2.7）：段标题是普通标题，每个项目一张顶层卡片（不卡片套卡片）。
// 卡片：名称与编号、类别、学员与期次数、平均进度条、出勤率、下一阶段、有逾期活动的人数；点开项目看板（tab=dash，含逾期名单）。
import { useNavigate } from 'react-router-dom';
import { categoryLabel } from '../../../categories.js';
import { fmtMD } from './ovquery.js';

export default function ProjectCards({ s, lang, loc, projects }) {
  const nav = useNavigate();
  const list = Array.isArray(projects) ? projects : [];
  const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  return (
    <section className="ovx-sec ovx-projects">
      <div className="ovx-sec-h"><h2>{s.prjTitle}</h2>{list.length > 0 && <span className="ovx-sec-count">{list.length}</span>}</div>
      {!list.length ? <div className="card ovx-panel-empty">{s.prjEmpty}</div> : (
        <div className="ovx-prj-grid">
          {list.map((t) => {
            const next = t.nextPhase;
            return (
              <div className="card ovx-prj" key={t.id}>
                <div className="ovx-prj-h">
                  <b className="ovx-prj-t">{loc(t, 'title')}</b>
                  <span className="ovx-prj-code">{t.code}</span>
                </div>
                <div className="ovx-prj-meta">
                  {t.category && <span className="ovx-tag">{categoryLabel(t.category, lang)}</span>}
                  <span>{s.prjMembers(t.members || 0, t.cohorts || 0)}</span>
                </div>
                <div className="ovx-prj-bar" role="img" aria-label={s.prjProgress(pct(t.progress))}><i style={{ width: `${pct(t.progress)}%` }} /></div>
                <div className="ovx-prj-facts">
                  <span>{s.prjProgress(pct(t.progress))}</span>
                  <span>{t.attendance === null || t.attendance === undefined ? s.prjAttendNa : s.prjAttend(pct(t.attendance))}</span>
                  <span>{next && next.at ? s.prjNext(loc(next, 'name'), fmtMD(next.at, lang)) : s.prjNextNone}</span>
                </div>
                <div className="ovx-prj-foot">
                  {(t.behind || 0) > 0 && (
                    <button type="button" className="ovx-link warn" onClick={() => nav('/admin/projects?project=' + encodeURIComponent(t.id) + '&tab=dash')}>{s.prjBehind(t.behind)}</button>
                  )}
                  <button type="button" className="ovx-link" onClick={() => nav('/admin/projects?project=' + encodeURIComponent(t.id) + '&tab=dash')}>{s.prjOpen}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
