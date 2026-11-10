// 近 12 周趋势（第三批 4.1，原 Overview.jsx 的纯 SVG 图移来）：柱 = 新增指派，线 = 完成、考试通过。不受时间段筛选影响。
// 每周的数值写在 <title> 里供读屏；手机上 x 轴隔周标注。
import { useMedia, PHONE_Q } from './useMedia.js';
import { fmtN } from './ovquery.js';   // 坐标轴刻度带千分位（2,197）

export default function TrendChart({ s, weeks }) {
  const phone = useMedia(PHONE_Q);
  const list = Array.isArray(weeks) ? weeks : [];
  return (
    <section className="ovx-sec ovx-trend-sec">
      <div className="ovx-sec-h">
        <h2>{s.trendTitle}</h2>
        <div className="ovx-legend">
          <span className="ovx-legend-i"><i className="ovx-sw-bar" aria-hidden />{s.sAssigned}</span>
          <span className="ovx-legend-i"><i className="ovx-sw-done" aria-hidden />{s.sCompleted}</span>
          <span className="ovx-legend-i"><i className="ovx-sw-pass" aria-hidden />{s.sPassed}</span>
        </div>
      </div>
      <div className="ovx-sec-note">{s.trendNote}</div>
      <div className="card ovx-trendcard">
        <Chart s={s} weeks={list} every={phone ? 2 : 1} />
      </div>
    </section>
  );
}

function Chart({ s, weeks, every }) {
  const W = 640, H = 190, padL = 30, padR = 10, padT = 18, padB = 28;
  if (!weeks.length) return <div className="ovx-panel-empty">{s.dash}</div>;
  const n = weeks.length;
  const v = (w, k) => Number(w[k]) || 0;
  const max = Math.max(1, ...weeks.map((w) => Math.max(v(w, 'assigned'), v(w, 'completed'), v(w, 'passed'))));
  const x = (i) => padL + ((W - padL - padR) / n) * (i + 0.5);
  const y = (val) => padT + (H - padT - padB) * (1 - val / max);
  const bw = Math.max(6, ((W - padL - padR) / n) * 0.42);
  const line = (key) => weeks.map((w, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v(w, key)).toFixed(1)}`).join(' ');
  return (
    <svg className="ovx-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={s.trendTitle}>
      {[0, 0.5, 1].map((f) => <line key={f} x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} className="ovx-trend-grid" />)}
      {[0, 0.5, 1].map((f) => <text key={'t' + f} x={padL - 6} y={y(max * f) + 4} className="ovx-trend-ax" textAnchor="end">{fmtN(Math.round(max * f))}</text>)}
      {weeks.map((w, i) => (
        <g key={w.week}>
          <title>{`${s.trWeek(w.week)} · ${s.sAssigned} ${v(w, 'assigned')} · ${s.sCompleted} ${v(w, 'completed')} · ${s.sPassed} ${v(w, 'passed')}`}</title>
          <rect x={x(i) - bw / 2} y={y(v(w, 'assigned'))} width={bw} height={Math.max(0, y(0) - y(v(w, 'assigned')))} rx="3" className="ovx-trend-bar" />
          {i % every === 0 && <text x={x(i)} y={H - 8} className="ovx-trend-ax" textAnchor="middle">{String(w.week).slice(5)}</text>}
        </g>
      ))}
      <path d={line('completed')} className="ovx-trend-line ovx-trend-done" />
      <path d={line('passed')} className="ovx-trend-line ovx-trend-pass" />
      {weeks.map((w, i) => v(w, 'passed') > 0 && <circle key={'c' + w.week} cx={x(i)} cy={y(v(w, 'passed'))} r="3" className="ovx-trend-dot" />)}
    </svg>
  );
}
