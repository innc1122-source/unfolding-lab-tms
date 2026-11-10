// 按类别汇总（第三批 4.1）：每个类别一行，可展开到该类别下的课程；每个数字都是按钮，点开对应名单（lcat / lprog 覆盖）。
// 桌面是普通 <table>（在 .ovx-scroll 里横向滚动）；≤900px 改成每类一张卡片、7 个数字两列排布，展开的课程是卡片内的分隔行（不嵌套卡片，UX 审查 24）。
import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { categoryLabel, UNCATEGORIZED } from '../../../categories.js';
import { fmtN, fmt1 } from './ovquery.js';
import { useMedia, NARROW_Q } from './useMedia.js';

const catKey = (k) => (k === null || k === undefined || k === '' ? UNCATEGORIZED : k);

export default function CategoryTable({ s, lang, loc, categories, perProgram, onList }) {
  const narrow = useMedia(NARROW_Q);
  const nav = useNavigate();
  const [open, setOpen] = useState(() => new Set());
  const rows = Array.isArray(categories) ? categories : [];
  const progById = new Map((Array.isArray(perProgram) ? perProgram : []).map((p) => [p.id, p]));
  const toggle = (k) => setOpen((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const coursesOf = (c) => (Array.isArray(c.programIds) ? c.programIds : []).map((id) => progById.get(id)).filter(Boolean)
    .sort((a, b) => (b.overduePeople || 0) - (a.overduePeople || 0) || (a.completion ?? 101) - (b.completion ?? 101));

  // 数字按钮：metric + 覆盖项
  const num = (v, metric, o, fmt) => (
    <button type="button" className="ovx-num tnum" onClick={() => onList(metric, o)} disabled={!v}>{fmt ? fmt(v) : fmtN(v || 0)}</button>
  );
  const rate = (v, metric, o) => (
    <button type="button" className="ovx-rate" onClick={() => onList(metric, o)} disabled={v === null || v === undefined}>
      <span className="ovx-rate-bar" aria-hidden><i style={{ width: `${Math.max(0, Math.min(100, Number(v) || 0))}%` }} /></span>
      <span className="tnum">{v === null || v === undefined ? s.dash : `${fmt1(v)}%`}</span>
    </button>
  );
  const cells = (r, o) => ({
    assigned: num(r.assigned, 'assigned', o),
    done: num(r.done, 'done', o),
    rate: rate(r.completion, 'assigned', o),
    overdue: num(r.overdue, 'overdue', o),
    due: num(r.dueSoon, 'dueSoon', o),
    hours: num(r.hoursDone, 'done', o, (v) => fmt1(v || 0)),
  });
  const catName = (c) => categoryLabel(c.key === undefined ? null : c.key, lang);
  // 第四批 7：「自主学习人次」一列只在有自主学习时出现（纯数字，不下钻：名单按看板的「来源」筛选）
  const hasSelf = rows.some((c) => Number(c.selfAssigned) > 0);
  const selfN = (v) => <span className="tnum">{fmtN(v || 0)}</span>;

  if (!rows.length) return <div className="card ovx-empty">{s.empty}</div>;

  if (narrow) {
    return (
      <div className="ovx-catcards">
        {rows.map((c) => {
          const k = catKey(c.key);
          const o = { lcat: k };
          const x = cells(c, o);
          const list = coursesOf(c);
          const isOpen = open.has(k);
          return (
            <div className="card ovx-catcard" key={k}>
              <div className="ovx-catcard-h">
                <b>{catName(c)}</b>
                <span className="ovx-catcard-n">{s.cCourses} {fmtN(c.courses)}</span>
              </div>
              <dl className="ovx-dl">
                <div><dt>{s.cAssigned}</dt><dd>{x.assigned}</dd></div>
                {hasSelf && <div><dt>{s.cSelf}</dt><dd>{selfN(c.selfAssigned)}</dd></div>}
                <div><dt>{s.cDone}</dt><dd>{x.done}</dd></div>
                <div><dt>{s.cRate}</dt><dd>{x.rate}</dd></div>
                <div><dt>{s.cOverdue}</dt><dd>{x.overdue}</dd></div>
                <div><dt>{s.cDue}</dt><dd>{x.due}</dd></div>
                <div><dt>{s.cHours}</dt><dd>{x.hours}</dd></div>
              </dl>
              {k === UNCATEGORIZED && <button type="button" className="ovx-link" onClick={() => nav('/admin/content?cat=' + UNCATEGORIZED)}>{s.cNoneHint}</button>}
              {list.length > 0 && (
                <button type="button" className="ovx-link ovx-expand" aria-expanded={isOpen} onClick={() => toggle(k)}>{isOpen ? s.cCollapse : s.cExpand(list.length)}</button>
              )}
              {isOpen && (
                <ul className="ovx-catcard-list">
                  {list.map((p) => {
                    const po = { lprog: p.id };
                    return (
                      <li key={p.id}>
                        <span className="ovx-catcard-t">{loc(p, 'title')}</span>
                        <span className="ovx-catcard-m">
                          <button type="button" className="ovx-link" onClick={() => onList('assigned', po)}>{s.cAssigned} {fmtN(p.assigned)}</button>
                          <span>{s.cRateOf(fmt1(p.completion ?? 0))}</span>
                          {(p.overdue || 0) > 0 && <button type="button" className="ovx-link warn" onClick={() => onList('overdue', po)}>{s.cOverdue} {fmtN(p.overdue)}</button>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="card ovx-tablecard">
      <div className="ovx-scroll">
        <table className="ovx-cat">
          <thead>
            <tr>
              <th scope="col" className="ovx-cat-name">{s.cCat}</th>
              <th scope="col" className="num">{s.cCourses}</th>
              <th scope="col" className="num">{s.cAssigned}</th>
              {hasSelf && <th scope="col" className="num">{s.cSelf}</th>}
              <th scope="col" className="num">{s.cDone}</th>
              <th scope="col" className="ovx-cat-rate">{s.cRate}</th>
              <th scope="col" className="num">{s.cOverdue}</th>
              <th scope="col" className="num">{s.cDue}</th>
              <th scope="col" className="num">{s.cHours}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const k = catKey(c.key);
              const x = cells(c, { lcat: k });
              const list = coursesOf(c);
              const isOpen = open.has(k);
              return (
                <Fragment key={k}>
                  <tr className="ovx-cat-row">
                    <th scope="row" className="ovx-cat-name">
                      {list.length > 0 ? (
                        <button type="button" className="ovx-caret" aria-expanded={isOpen} onClick={() => toggle(k)} title={isOpen ? s.cCollapse : s.cExpand(list.length)}>
                          <span aria-hidden>{isOpen ? '▾' : '▸'}</span> {catName(c)}
                        </button>
                      ) : <span className="ovx-caret-none">{catName(c)}</span>}
                      {k === UNCATEGORIZED && <button type="button" className="ovx-link ovx-cat-hint" onClick={() => nav('/admin/content?cat=' + UNCATEGORIZED)}>{s.cNoneHint}</button>}
                    </th>
                    <td className="num tnum">{fmtN(c.courses)}</td>
                    <td className="num">{x.assigned}</td>
                    {hasSelf && <td className="num">{selfN(c.selfAssigned)}</td>}
                    <td className="num">{x.done}</td>
                    <td>{x.rate}</td>
                    <td className="num">{x.overdue}</td>
                    <td className="num">{x.due}</td>
                    <td className="num">{x.hours}</td>
                  </tr>
                  {isOpen && list.map((p) => {
                    const y = cells(p, { lprog: p.id });
                    return (
                      <tr key={k + '|' + p.id} className="ovx-cat-sub">
                        <th scope="row" className="ovx-cat-name">
                          <span className="ovx-cat-course">{loc(p, 'title')}</span>
                          <span className="ovx-a-tags">
                            <span className={'ovx-tag' + (p.enrollType === 'elective' ? '' : ' req')}>{p.enrollType === 'elective' ? s.enrollEle : s.enrollReq}</span>
                            <span className="ovx-tag">{p.mode === 'offline' ? s.modeOff : p.mode === 'mixed' ? s.modeMixed : s.modeOn}</span>
                          </span>
                        </th>
                        <td className="num tnum">{s.dash}</td>
                        <td className="num">{y.assigned}</td>
                        {hasSelf && <td className="num">{selfN(p.selfAssigned)}</td>}
                        <td className="num">{y.done}</td>
                        <td>{y.rate}</td>
                        <td className="num">{y.overdue}</td>
                        <td className="num">{y.due}</td>
                        <td className="num">{y.hours}</td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
