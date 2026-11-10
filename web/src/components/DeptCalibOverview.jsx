// 绩效看板第二期（负责人 2026-10-10 开工）：HoD「部门校准概览」。只在员工端「绩效评估 › 部门校准」（DeptCalibration mode="hod"）顶部出现，
// 默认收起。内容：按子部门 / 直属上级的进度与逾期、按子部门的评级分布、上级评分尺度（只给 HoD 看，用于校准讨论）、本次校准的调整记录。
// 输入是 DeptCalibration 已套上草稿的行（applied），概览随未保存的调整即时变化。员工端包：不引 Semi。计算见 ../calibOverview.js。
import { useMemo, useState } from 'react';
import * as CO from '../calibOverview.js';

const T = {
  zh: {
    title: '部门校准概览', sumAdj: (n) => `本次调整 ${n} 人`, sumOver: (n) => `逾期 ${n} 人`,
    progT: '进度', byUnit: '按子部门', byMgr: '按直属上级', direct: '本部门直属', noMgr: '无直属上级',
    cName: '名称', cN: '人数', cSelf: '自评', cOne: '面谈双方确认', cRated: '上级评级', cRatedA: '已评级', cOver: '逾期',
    distT: '评级分布（按子部门）', distLead: '按生效评级（含你尚未保存的调整）；C、D 合并。名额对比见下方配额条。', cTotal: '已评级',
    lenT: '上级评分尺度', lenLead: (n) => `每位直属上级给出评级的平均档位与本部门平均的差（A+ = 6 … D = 1）。只计算评了 ${n} 人及以上的上级；差 ≥ 0.5 档标出。只给你看，用于校准讨论。`,
    cMgr: '直属上级', cAvg: '平均档位', cDept: '部门平均', cDiff: '差', lenient: '偏宽', strict: '偏严', lenNone: '还没有评够人数的上级。',
    adjT: '本次校准', adjN: '调整', up: '上调', down: '下调', proxyN: '代评', reasonsT: '调整理由', reasonsNone: '还没有调整。', reasonsEmpty: '还没有填写调整理由。',
  },
  en: {
    title: 'Department calibration overview', sumAdj: (n) => `${n} adjusted`, sumOver: (n) => `${n} overdue`,
    progT: 'Progress', byUnit: 'By sub-department', byMgr: 'By manager', direct: 'Directly under the department', noMgr: 'No direct manager',
    cName: 'Name', cN: 'People', cSelf: 'Self-review', cOne: '1-on-1 confirmed', cRated: 'Manager rating', cRatedA: 'Rated', cOver: 'Overdue',
    distT: 'Rating distribution (by sub-department)', distLead: 'Effective ratings, including adjustments you have not saved yet; C and D combined. Compare with the quota bar below.', cTotal: 'Rated',
    lenT: 'Manager rating tendency', lenLead: (n) => `Each direct manager's average rating level minus the department average (A+ = 6 … D = 1). Only managers who rated ${n} or more people; differences of 0.5 or more are flagged. Only you see this; it is for calibration discussion.`,
    cMgr: 'Manager', cAvg: 'Average', cDept: 'Dept average', cDiff: 'Difference', lenient: 'Lenient', strict: 'Strict', lenNone: 'No manager has rated enough people yet.',
    adjT: 'This calibration', adjN: 'Adjusted', up: 'Raised', down: 'Lowered', proxyN: 'Proxy ratings', reasonsT: 'Reasons for adjustment', reasonsNone: 'No adjustments yet.', reasonsEmpty: 'No reason has been written for the adjustments yet.',
  },
};

export default function DeptCalibOverview({ rows, deptOptions, ratingOptions, annual, lang }) {
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const [by, setBy] = useState('unit');
  const names = useMemo(() => new Map((deptOptions || []).map((d) => [d.id, d.name])), [deptOptions]);
  const scale = ratingOptions && ratingOptions.length ? ratingOptions : ['A+', 'A', 'B+', 'B', 'C', 'D'];
  const unitName = (r) => (r.key === CO.DIRECT ? s.direct : r.label || '—');
  const mgrName = (r) => (r.key === CO.NO_MANAGER ? s.noMgr : r.label || '—');
  const prog = useMemo(() => (by === 'unit' ? CO.progressBy(rows, CO.byUnit(names), CO.unitLabel(names), annual) : CO.progressBy(rows, CO.byManager, CO.managerLabel, annual)), [rows, by, names, annual]);
  const dist = useMemo(() => CO.distBy(rows, CO.byUnit(names), CO.unitLabel(names)), [rows, names]);
  const len = useMemo(() => CO.leniencyRows(rows, scale), [rows, scale]);
  const adj = useMemo(() => CO.adjustSummary(rows, scale), [rows, scale]);
  const overN = prog.reduce((a, r) => a + r.overdue.length, 0);
  const frac = (a, n) => <span className="tnum">{a}<span className="dco-dim"> / {n}</span></span>;
  return (
    <details className="card dco">
      <summary className="dco-sum">
        <b>{s.title}</b>
        <span className="pill muted tnum">{s.sumAdj(adj.adjusted.length)}</span>
        {overN > 0 && <span className="pill warn tnum">{s.sumOver(overN)}</span>}
      </summary>

      <div className="dco-sec">
        <div className="dco-h">
          <span className="rv-lab">{s.progT}</span>
          <div className="dco-seg" role="tablist">
            {[['unit', s.byUnit], ['mgr', s.byMgr]].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={by === k} className={'dco-segb' + (by === k ? ' on' : '')} onClick={() => setBy(k)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="dco-tw">
          <table className="dco-t">
            <thead><tr>
              <th>{s.cName}</th><th>{s.cN}</th>
              {!annual && <th>{s.cSelf}</th>}{!annual && <th>{s.cOne}</th>}
              <th>{annual ? s.cRatedA : s.cRated}</th><th>{s.cOver}</th>
            </tr></thead>
            <tbody>
              {prog.map((r) => (
                <tr key={r.key}>
                  <td data-label={s.cName}>{by === 'unit' ? unitName(r) : mgrName(r)}</td>
                  <td data-label={s.cN} className="tnum">{r.n}</td>
                  {!annual && <td data-label={s.cSelf}>{frac(r.self.length, r.n)}</td>}
                  {!annual && <td data-label={s.cOne}>{frac(r.one.length, r.n)}</td>}
                  <td data-label={annual ? s.cRatedA : s.cRated}>{frac(r.rated.length, r.n)}</td>
                  <td data-label={s.cOver} className={'tnum' + (r.overdue.length ? ' dco-bad' : '')}>{r.overdue.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dco-sec">
        <div className="rv-lab">{s.distT}</div>
        <p className="rv-hint">{s.distLead}</p>
        <div className="dco-tw">
          <table className="dco-t">
            <thead><tr><th>{s.cName}</th><th>{s.cTotal}</th>{CO.TIERS.map((t) => <th key={t}>{t}</th>)}</tr></thead>
            <tbody>
              {dist.map((r) => (
                <tr key={r.key}>
                  <td data-label={s.cName}>{unitName(r)}</td>
                  <td data-label={s.cTotal}>{frac(r.n, r.all)}</td>
                  {CO.TIERS.map((t) => <td key={t} data-label={t} className="tnum">{(r.tiers[t] || []).length}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dco-sec">
        <div className="rv-lab">{s.lenT}</div>
        <p className="rv-hint">{s.lenLead(CO.LENIENCY_MIN)}</p>
        {len.length === 0 ? <p className="rv-note">{s.lenNone}</p> : (
          <div className="dco-tw">
            <table className="dco-t">
              <thead><tr><th>{s.cMgr}</th><th>{s.cN}</th><th>{s.cAvg}</th><th>{s.cDept}</th><th>{s.cDiff}</th></tr></thead>
              <tbody>
                {len.map((r) => (
                  <tr key={r.managerId}>
                    <td data-label={s.cMgr}>{r.manager || '—'}{r.flag && <span className={'pill ' + (r.flag === 'lenient' ? 'warn' : 'pri') + ' dco-flag'}>{r.flag === 'lenient' ? s.lenient : s.strict}</span>}</td>
                    <td data-label={s.cN} className="tnum">{r.n}</td>
                    <td data-label={s.cAvg} className="tnum">{r.avg}</td>
                    <td data-label={s.cDept} className="tnum">{r.deptAvg}</td>
                    <td data-label={s.cDiff} className="tnum">{(r.diff > 0 ? '+' : '') + r.diff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dco-sec">
        <div className="rv-lab">{s.adjT}</div>
        <div className="dco-chips tnum">
          <span>{s.adjN} <b>{adj.adjusted.length}</b></span>
          <span>{s.up} <b>{adj.up.length}</b></span>
          <span>{s.down} <b>{adj.down.length}</b></span>
          {!annual && <span>{s.proxyN} <b>{adj.proxies.length}</b></span>}
        </div>
        <div className="rv-lab dco-sublab">{s.reasonsT}</div>
        {adj.reasons.length === 0 ? <p className="rv-note">{adj.adjusted.length ? s.reasonsEmpty : s.reasonsNone}</p> : (
          <ul className="dco-reasons">
            {adj.reasons.map((x) => <li key={x.id}><b>{x.name}</b> <span className="tnum">{x.from} → {x.to}</span><div className="dco-reason">{x.text}</div></li>)}
          </ul>
        )}
      </div>
    </details>
  );
}
