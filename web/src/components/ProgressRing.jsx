// SVG progress ring — the ring starts at 12 o'clock (app.css rotates the svg -90deg).
// `check`: for a completed/passed item, show a ✓ instead of "100%" so the ring
// (completion) doesn't read as a second, competing number next to the exam score.
// `danger`: overdue — the ring itself turns red so the card reads as late even
// before you get to the pill (design 18).
// `v3`: a three-digit value ("100") gets a narrower type in small rings (app.css, QA D1).
export default function ProgressRing({ p, size = 64, sm = false, check = false, danger = false }) {
  const sw = size > 70 ? 7 : 5;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - p / 100);
  const col = danger ? 'var(--danger)' : p >= 100 ? 'var(--success)' : 'var(--brand)';
  return (
    <div className={'ring' + (sm ? ' sm' : '')} style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--line)" strokeWidth={sw} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth={sw} fill="none"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} />
      </svg>
      <div className="lab" style={{ color: col }}>
        {check
          ? <svg className="ring-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          : <><span className={'v' + (Math.round(p) >= 100 ? ' v3' : '')}>{Math.round(p)}</span><small>%</small></>}
      </div>
    </div>
  );
}
