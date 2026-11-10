// 12.2 工作台 部门健康度对照表（b12-design §3.4，替代原部门人数条形图）。
// 行 = 查看者范围内的一级部门，末行「合计（当前范围）」；列按能力域由服务端裁剪（无权的列整列不下发），3+3 参与率由前端合并。
// 比率列低于合计 10 个百分点及以上标「落后」（胶囊在数字右侧，F47）；在职 < 5 人的部门显示「样本少」、不标落后。
// ≥ 768 为表格（表头可排序）；< 768 每个一级部门一张紧凑卡片，不横向滚动。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../../i18n.jsx';
import { cellOf, healthCellState, lagCount, sortHealthRows, drillHref, mergeCultureDepts, cultureTotal, HEALTH_NO_MARK } from '../../../workbench.js';
import { nf, pf, usePhone, IcUp, IcDown } from './shared.jsx';

const T = {
  zh: {
    title: '部门健康度对照', dept: '一级部门', total: '合计（当前范围）',
    cols: { headcount: '在职人数', probation: '试用期占比', compliance: '必修完成率', reviewOnTime: '评估按时率', hipo: '高潜占比', culture: '3+3 参与率' },
    lag: '落后', small: '样本少', lagN: (n) => `${n} 项落后`,
    sortBy: (c) => `按${c}排序`,
    note: (pp, n) => `比率低于合计 ${pp} 个百分点及以上标为落后；在职少于 ${n} 人的部门不计算比率。必修完成率按指派人次计算，名单显示仍有未完成必修的员工。`,
    empty: '当前范围内没有一级部门。',
  },
  en: {
    title: 'Department Health Comparison', dept: 'Department', total: 'Total (current scope)',
    cols: { headcount: 'Active headcount', probation: 'On probation', compliance: 'Required training', reviewOnTime: 'On-time reviews', hipo: 'High-potential share', culture: '3+3 participation' },
    lag: 'Lagging', small: 'Small sample', lagN: (n) => `${n} lagging`,
    sortBy: (c) => `Sort by ${c}`,
    note: (pp, n) => `Rates ${pp} or more points below the total are marked lagging. Departments with fewer than ${n} active employees show no rates. Required training is counted by assignment; the list shows employees with incomplete required courses.`,
    empty: 'No departments in your current scope.',
  },
};

const deptIdOf = (r) => (r.deptId != null ? r.deptId : r.id);
const deptNameOf = (r) => r.deptName || r.name || '—';

function Value({ col, c }) {
  if (c.value === null || c.value === undefined) return <span className="wb-hc-v muted">—</span>;
  return <span className="wb-hc-v tnum">{col === 'headcount' ? nf(c.value) : pf(c.value)}</span>;
}

/* 一个单元格：数值 + 状态胶囊（落后 / 样本少），可点开名单（3+3 列由 3+3 后台提供名单，不在工作台名单接口里）。 */
function HealthCell({ row, col, total, cfg, s, isTotal }) {
  const navigate = useNavigate();
  const c = cellOf(row, col);
  const hc = cellOf(row, 'headcount').value;
  const st = isTotal ? (c.value === null ? 'empty' : 'ok') : healthCellState({ ...c, headcount: hc }, cellOf(total, col), { ...cfg, mark: !HEALTH_NO_MARK.includes(col) });
  const drill = col === 'culture' ? null : { metric: `dept.${col}`, dept: isTotal ? undefined : deptIdOf(row) };
  const href = drill ? drillHref(drill) : null;
  const inner = st === 'small' && col !== 'headcount'
    ? <span className="wb-hc-small">{s.small}</span>
    : <><Value col={col} c={c} />{st === 'lag' && <span className="pill warn wb-lag">{s.lag}</span>}</>;
  return href && st !== 'empty'
    ? <button type="button" className={'wb-hc ' + st} onClick={() => navigate(href)}>{inner}</button>
    : <span className={'wb-hc ' + st}>{inner}</span>;
}

export default function DeptHealthTable({ data, cultureColumn, cultureDepts }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const phone = usePhone();
  const [sort, setSort] = useState({ key: null, dir: 'desc' });
  if (!data) return null;
  const cfg = { lagPp: 10, minDeptHeadcount: 5, ...(data.config || {}) };
  const columns = [...(data.columns || []), ...(cultureColumn ? ['culture'] : [])];
  const baseTotal = data.total || {};
  const total = cultureColumn ? { ...baseTotal, cells: { ...(baseTotal.cells || {}), culture: cultureTotal(cultureDepts) } } : baseTotal;
  const baseRows = cultureColumn ? mergeCultureDepts(data.rows || [], cultureDepts) : (data.rows || []);
  const rows = sortHealthRows(baseRows, columns, total, cfg, sort.key, sort.dir);
  const head = (
    <div className="wb-block-head">
      <h3 className="wb-card-title"><span className="wb-card-name">{s.title}</span></h3>
    </div>
  );
  const note = <div className="wb-note">{s.note(nf(cfg.lagPp), nf(cfg.minDeptHeadcount))}</div>;
  if (!rows.length) return <div className="wb-card wb-health">{head}<div className="wb-empty">{s.empty}</div></div>;

  if (phone) {
    return (
      <div className="wb-card wb-health">
        {head}
        <ul className="wb-hcards">
          {rows.map((r) => {
            const n = lagCount(r, columns, total, cfg);
            return (
              <li className="wb-hcard" key={deptIdOf(r) ?? deptNameOf(r)}>
                <div className="wb-hcard-head">
                  <span className="wb-hcard-name">{deptNameOf(r)}</span>
                  <span className="wb-hcard-hc tnum">{nf(cellOf(r, 'headcount').value)}</span>
                  {n > 0 && <span className="pill warn">{s.lagN(nf(n))}</span>}
                </div>
                <div className="wb-hcard-grid">
                  {columns.filter((c) => c !== 'headcount').map((col) => (
                    <div className="wb-hcard-cell" key={col}>
                      <span className="wb-hcard-k">{s.cols[col] || col}</span>
                      <HealthCell row={r} col={col} total={total} cfg={cfg} s={s} />
                    </div>
                  ))}
                </div>
              </li>
            );
          })}
          <li className="wb-hcard total">
            <div className="wb-hcard-head"><span className="wb-hcard-name">{s.total}</span><span className="wb-hcard-hc tnum">{nf(cellOf(total, 'headcount').value)}</span></div>
            <div className="wb-hcard-grid">
              {columns.filter((c) => c !== 'headcount').map((col) => (
                <div className="wb-hcard-cell" key={col}><span className="wb-hcard-k">{s.cols[col] || col}</span><HealthCell row={total} col={col} total={total} cfg={cfg} s={s} isTotal /></div>
              ))}
            </div>
          </li>
        </ul>
        {note}
      </div>
    );
  }

  const sortBtn = (key, label) => {
    const on = sort.key === key;
    const next = () => setSort(on ? (sort.dir === 'desc' ? { key, dir: 'asc' } : { key: null, dir: 'desc' }) : { key, dir: key === 'name' ? 'asc' : 'desc' });
    return (
      <button type="button" className={'wb-th-sort' + (on ? ' on' : '')} aria-label={s.sortBy(label)} onClick={next}>
        {label}{on && <span className="wb-th-dir">{sort.dir === 'asc' ? <IcUp /> : <IcDown />}</span>}
      </button>
    );
  };
  return (
    <div className="wb-card wb-health">
      {head}
      <table className="wb-htable">
        <thead>
          <tr>
            <th scope="col" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>{sortBtn('name', s.dept)}</th>
            {columns.map((col) => (
              <th scope="col" key={col} aria-sort={sort.key === col ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>{sortBtn(col, s.cols[col] || col)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={deptIdOf(r) ?? deptNameOf(r)}>
              <th scope="row">{deptNameOf(r)}</th>
              {columns.map((col) => <td key={col}><HealthCell row={r} col={col} total={total} cfg={cfg} s={s} /></td>)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{s.total}</th>
            {columns.map((col) => <td key={col}><HealthCell row={total} col={col} total={total} cfg={cfg} s={s} isTotal /></td>)}
          </tr>
        </tfoot>
      </table>
      {note}
    </div>
  );
}
