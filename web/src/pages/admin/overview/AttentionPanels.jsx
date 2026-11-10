// 「需要关注」四块（第三批 4.1）：风险最高的课程 / 风险最高的部门 / 7 天内到期 / 待处理。
// 段标题是普通标题，四块各自是顶层卡片（不卡片套卡片，UX 审查 2）；每块最多 5 行，每行的数字都能点开名单。
// 「提醒」只在 remindablePeople > 0 且有培训写权限时出现（完成率偏低的课程行没有可提醒的人，只给「名单」，UX 审查 11）。
// 待处理：数为 0 的行隐藏；跳转都带上当前部门；只读档显示「查看」。
import { categoryLabel } from '../../../categories.js';
import { fmtN, fmt1, fmtMD } from './ovquery.js';

export default function AttentionPanels({ s, lang, loc, attention, metaById, dept, canWrite, onList, onFocusDept, onRemind, nav }) {
  const a = attention || {};
  const courses = Array.isArray(a.courses) ? a.courses.slice(0, 5) : [];
  const depts = Array.isArray(a.depts) ? a.depts.slice(0, 5) : [];
  const due = a.dueSoon || { people: 0, rows: 0, items: [] };
  const dueItems = Array.isArray(due.items) ? due.items.slice(0, 5) : [];
  const pend = a.pending || {};
  const title = (id) => { const m = metaById.get(id); return m ? loc(m, 'title') : id; };
  const tags = (id) => {
    const m = metaById.get(id);
    if (!m) return null;
    return (
      <span className="ovx-a-tags">
        <span className={'ovx-tag' + (m.enrollType === 'elective' ? '' : ' req')}>{m.enrollType === 'elective' ? s.enrollEle : s.enrollReq}</span>
        <span className="ovx-tag">{categoryLabel(m.category || null, lang)}</span>
      </span>
    );
  };
  const deptQ = dept ? 'dept=' + encodeURIComponent(dept) : '';
  const go = (path, q) => nav(path + (q || deptQ ? '?' + [q, deptQ].filter(Boolean).join('&') : ''));
  const pendRows = [
    { k: 'enroll', label: s.pEnroll, n: pend.enroll, act: s.actApprove, to: () => go('/admin/requests', '') },
    { k: 'nominations', label: s.pNom, n: pend.nominations, act: s.actApprove, to: () => go('/admin/requests', '') },
    { k: 'review', label: s.pReview, n: pend.review, act: s.actReview, to: () => go('/admin/results', 'status=pending'), late: pend.reviewOverdue },
    { k: 'manual', label: s.pManual, n: pend.manual, act: s.actReview, to: () => go('/admin/results', 'status=pending') },
    { k: 'appeals', label: s.pAppeal, n: pend.appeals, act: s.actHandle, to: () => go('/admin/results', 'status=appealing') },
  ].filter((r) => (r.n || 0) > 0);

  return (
    <section className="ovx-sec ovx-attn">
      <div className="ovx-sec-h"><h2>{s.attnTitle}</h2></div>
      <div className="ovx-attn-grid">
        {/* 风险最高的课程 */}
        <div className="card ovx-panel">
          <h3 className="ovx-panel-h">{s.aCourses}</h3>
          {!courses.length ? <div className="ovx-panel-empty">{s.aCoursesEmpty}</div> : (
            <ul className="ovx-alist">
              {courses.map((c) => {
                const low = c.reason === 'lowCompletion';
                return (
                  <li key={c.programId} className="ovx-arow">
                    <div className="ovx-arow-main">
                      <span className="ovx-arow-t">{title(c.programId)}</span>
                      {tags(c.programId)}
                    </div>
                    <div className="ovx-arow-meta">
                      {low && <span className="ovx-tag warn">{s.aLow}</span>}
                      <span>{low ? s.aLowLine(fmt1(c.completion), c.assigned) : s.aCourseLine(c.overduePeople, fmt1(c.completion))}</span>
                    </div>
                    <div className="ovx-arow-act">
                      <button type="button" className="ovx-link" onClick={() => (low ? onList('assigned', { lprog: c.programId, lst: 'notdone' }) : onList('overdue', { lprog: c.programId }))}>{s.actList}</button>
                      {!low && canWrite && (c.remindablePeople || 0) > 0 && (
                        <button type="button" className="ovx-link" onClick={() => onRemind({ metric: 'overdue', overrides: { lprog: c.programId }, count: c.remindablePeople })}>{s.actRemind}</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 风险最高的部门 */}
        <div className="card ovx-panel">
          <h3 className="ovx-panel-h">{s.aDepts}</h3>
          {!depts.length ? <div className="ovx-panel-empty">{s.aDeptsEmpty}</div> : (
            <ul className="ovx-alist">
              {depts.map((d) => {
                const low = d.reason === 'lowCompletion';
                const name = d.deptId === '__none' ? s.heatNone : d.name;
                return (
                  <li key={d.deptId} className="ovx-arow">
                    <div className="ovx-arow-main">
                      <span className="ovx-arow-t">{name}</span>
                      {d.path && d.path !== d.name && <span className="ovx-arow-path">{d.path}</span>}
                    </div>
                    <div className="ovx-arow-meta">
                      {low && <span className="ovx-tag warn">{s.aLow}</span>}
                      <span>{low ? s.aLowLine(fmt1(d.completion), d.assigned) : s.aDeptLine(d.overduePeople, fmt1(d.completion))}</span>
                    </div>
                    <div className="ovx-arow-act">
                      <button type="button" className="ovx-link" onClick={() => (low ? onList('assigned', { ldept: d.filterKey || d.deptId, lst: 'notdone' }) : onList('overdue', { ldept: d.filterKey || d.deptId }))}>{s.actList}</button>
                      {d.deptId !== dept && <button type="button" className="ovx-link" onClick={() => onFocusDept(d.deptId)}>{s.actFocus}</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 7 天内到期 */}
        <div className="card ovx-panel">
          <h3 className="ovx-panel-h">{s.aDue}{(due.people || 0) > 0 && <span className="ovx-panel-n">{s.aDueTotal(due.people, due.rows)}</span>}</h3>
          {!dueItems.length ? <div className="ovx-panel-empty">{s.aDueEmpty}</div> : (
            <ul className="ovx-alist">
              {dueItems.map((d) => (
                <li key={d.programId} className="ovx-arow">
                  <div className="ovx-arow-main"><span className="ovx-arow-t">{title(d.programId)}</span></div>
                  <div className="ovx-arow-meta"><span>{s.aDueLine(d.people, fmtMD(d.firstDue, lang))}</span></div>
                  <div className="ovx-arow-act">
                    <button type="button" className="ovx-link" onClick={() => onList('dueSoon', { lprog: d.programId })}>{s.actList}</button>
                    {canWrite && (d.remindablePeople || 0) > 0 && (
                      <button type="button" className="ovx-link" onClick={() => onRemind({ metric: 'dueSoon', overrides: { lprog: d.programId }, count: d.remindablePeople })}>{s.actRemindEarly}</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 待处理 */}
        <div className="card ovx-panel">
          <h3 className="ovx-panel-h">{s.aPending}<span className="ovx-panel-note">{s.aPendingNote}</span></h3>
          {!pendRows.length ? <div className="ovx-panel-empty">{s.aPendingEmpty}</div> : (
            <ul className="ovx-alist">
              {pendRows.map((r) => (
                <li key={r.k} className="ovx-arow ovx-arow-pend">
                  <div className="ovx-arow-main">
                    <span className="ovx-arow-t">{r.label}</span>
                    <b className="ovx-pend-n tnum">{fmtN(r.n)}</b>
                  </div>
                  {(r.late || 0) > 0 && <div className="ovx-arow-meta"><span className="ovx-late">{s.pReviewLate(r.late)}</span></div>}
                  <div className="ovx-arow-act">
                    <button type="button" className="ovx-link" onClick={r.to}>{canWrite ? r.act : s.actView}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
