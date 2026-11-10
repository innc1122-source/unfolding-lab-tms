// 部门 × 类别完成率（第三批 4.1，含 V3 修复）：部门名是行表头，永不截断 —— 第一列 sticky、自动换行（200–280px，手机 132px），
// 类别表头也换行、不加省略号，表格 table-layout:auto，在 .ovx-scroll 里横向滚动。
// 默认按风险排序（逾期人次降序 → 完成率升序），先显示 12 行，可展开全部（UX 审查 3）；部门名下写在职人数；
// 指派少于 5 人次的格子只印数字、不上色（仅供参考）；每格都是按钮，读屏名称 =「部门 · 类别：已完成 x / 指派 y · 逾期 z」。
// 颜色从不是唯一线索：格子里总印百分比，无指派印「—」。
import { useMemo, useState } from 'react';
import { categoryLabel, UNCATEGORIZED } from '../../../categories.js';
import { bucketOf, sortHeatRows, fmt1, SMALL_N } from './ovquery.js';

const FIRST = 12;
const keyOf = (k) => (k === null || k === undefined || k === '' ? UNCATEGORIZED : k);

export default function HeatTable({ s, lang, heat, onList, onFocusDept, dept }) {
  const [sort, setSort] = useState('risk');
  const [all, setAll] = useState(false);
  const h = heat || {};
  const cols = Array.isArray(h.cols) ? h.cols : [];
  const cellMap = useMemo(() => {
    const m = new Map();
    for (const c of Array.isArray(h.cells) ? h.cells : []) m.set(c.deptId + '|' + keyOf(c.key), c);
    return m;
  }, [h.cells]);
  const overdueOf = useMemo(() => {
    const m = new Map();
    for (const c of Array.isArray(h.cells) ? h.cells : []) m.set(c.deptId, (m.get(c.deptId) || 0) + (c.overdue || 0));
    return (r) => m.get(r.deptId) || 0;
  }, [h.cells]);
  const rows = useMemo(() => sortHeatRows((Array.isArray(h.rows) ? h.rows : []).filter((r) => (r.assigned || 0) > 0), sort, overdueOf), [h.rows, sort, overdueOf]);
  const shown = all ? rows : rows.slice(0, FIRST);

  const rowName = (r) => (r.deptId === '__none' ? s.heatNone : r.direct ? s.heatDirect(r.name) : r.name);
  const catName = (k) => categoryLabel(k === UNCATEGORIZED ? null : k, lang);
  const cell = (r, k, total) => {
    const c = total
      ? { assigned: r.assigned, done: r.done, completion: r.completion, overdue: overdueOf(r) }
      : cellMap.get(r.deptId + '|' + keyOf(k));
    const label = `${rowName(r)} · ${total ? s.heatTotal : catName(keyOf(k))}：`;
    if (!c || !c.assigned) return <td key={total ? '__t' : keyOf(k)} className="ovx-heat-na" aria-label={label + s.heatEmpty}>{s.dash}</td>;
    const small = c.assigned < SMALL_N;
    const b = small ? null : bucketOf(c.completion);
    const tip = s.heatCellTip(c.done || 0, c.assigned || 0, c.overdue || 0);
    return (
      <td key={total ? '__t' : keyOf(k)} className={total ? 'ovx-heat-total' : undefined} data-b={b === null ? undefined : b} data-small={small ? '1' : undefined}>
        <button type="button" className="ovx-heat-btn tnum" title={tip} aria-label={label + tip}
          onClick={() => onList('assigned', total ? { ldept: r.filterKey || r.deptId } : { ldept: r.filterKey || r.deptId, lcat: keyOf(k) })}>
          {c.completion === null || c.completion === undefined ? s.dash : `${fmt1(c.completion)}%`}
        </button>
      </td>
    );
  };

  return (
    <section className="ovx-sec">
      <div className="ovx-sec-h">
        <h2>{s.heatTitle}</h2>
        <div className="ovx-legend" aria-label={s.heatLegend}>
          <span className="ovx-legend-l">{s.heatLegend}</span>
          {['<50%', '50–69%', '70–84%', '85–94%', '≥95%'].map((t, i) => <span key={t} className="ovx-legend-i"><i data-b={i} aria-hidden />{t}</span>)}
          <span className="ovx-legend-i ovx-legend-na">{s.heatEmpty}</span>
        </div>
        <div className="ovx-seg" role="group" aria-label={s.sortLabel}>
          {[['risk', s.heatSortRisk], ['rate', s.heatSortRate], ['name', s.heatSortName]].map(([k, t]) => (
            <button key={k} type="button" aria-pressed={sort === k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="ovx-sec-note">{s.heatHint} · {s.heatSmall}</div>
      <div className="card ovx-tablecard">
        {!rows.length ? <div className="ovx-panel-empty">{s.heatNoData}</div> : (
          <div className="ovx-scroll">
            <table className="ovx-heat">
              <thead>
                <tr>
                  <th scope="col" className="ovx-heat-dept">{s.heatDept}</th>
                  {cols.map((k) => <th scope="col" key={keyOf(k)}>{catName(keyOf(k))}</th>)}
                  <th scope="col" className="ovx-heat-total">{s.heatTotal}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.deptId + (r.direct ? '|direct' : '')}>
                    <th scope="row" className="ovx-heat-dept">
                      {r.direct || r.deptId === dept ? <span className="ovx-heat-name">{rowName(r)}</span> : (
                        <button type="button" className="ovx-heat-name ovx-link" onClick={() => onFocusDept(r.deptId)} title={s.actFocus}>{rowName(r)}</button>
                      )}
                      {r.headcount != null && <span className="ovx-heat-head">{s.heatHead(r.headcount)}</span>}
                    </th>
                    {cols.map((k) => cell(r, k, false))}
                    {cell(r, null, true)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > FIRST && (
          <div className="ovx-more">
            <button type="button" className="ovx-link" onClick={() => setAll((v) => !v)}>{all ? s.heatShowLess : s.heatShowAll(rows.length)}</button>
          </div>
        )}
      </div>
    </section>
  );
}
