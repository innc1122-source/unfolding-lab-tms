// 绩效看板第一期（负责人 2026-10-10 拍板，方案 docs/PROPOSAL-20261010-performance-dashboard.md 3.2）：经理「我的团队」看板。
// 放在「绩效评估 › 团队」名单上方。数据 GET /api/me/reviews/team-dashboard —— 只有本人作为直属上级的人（主管只看自己团队）。
//   卡片 1：本期（最近的进行中周期，没有时为最近关闭的周期）我给出的评级分布，与公司配额比例并列；
//   卡片 2：最近关闭周期「我给的 → 最终」变动（上调 / 下调 / 未变），以及需要关注的人（连续两期 C / D、较上期降两档及以上）；
//   卡片 3：近 4 个已关闭周期的团队最终评级分布。
// 员工端包：不引 Semi，只用员工端样式（.tdb-*，v2.css 追加）。团队里没有人时整块不显示。
import { useMemo } from 'react';
import { api, useAsync } from '../api.js';
import { TIER_ORDER as TIERS, bucketOf } from '../deptcal.js';   // 简化 10/11：评级档位与 C/D 合并口径共用 deptcal

const T = {
  zh: {
    cur: (n) => `本期我给出的评级 · ${n}`, curNone: '本期还没有给出评级。', quota: (q) => `配额 ${q}%`, legend: '人数 · 占比 / 配额；竖线为公司配额比例', people: (n) => `${n} 人`,
    cal: (n) => `校准变动 · ${n}`, calNone: '还没有已关闭的周期。', up: '上调', down: '下调', same: '未变',
    att: '需要关注', attNone: '近两期没有需要特别关注的人。', low2: '连续两期 C / D', drop2: '较上期降两档及以上',
    trend: '近 4 期团队最终评级', trendNone: '还没有已关闭的周期。',
  },
  en: {
    cur: (n) => `Ratings I gave this cycle · ${n}`, curNone: 'No ratings given yet this cycle.', quota: (q) => `Quota ${q}%`, legend: 'People · share / quota; the marker is the company quota', people: (n) => `${n} ${n === 1 ? 'person' : 'people'}`,
    cal: (n) => `Calibration changes · ${n}`, calNone: 'No closed cycle yet.', up: 'Raised', down: 'Lowered', same: 'Unchanged',
    att: 'Needs attention', attNone: 'Nobody needs particular attention over the last two cycles.', low2: 'C / D two cycles in a row', drop2: 'Down two levels or more',
    trend: 'Team final ratings, last 4 cycles', trendNone: 'No closed cycle yet.',
  },
};

const tiersOf = (dist) => { const o = {}; for (const [r, n] of Object.entries(dist || {})) { const b = bucketOf(r); if (b) o[b] = (o[b] || 0) + n; } return o; };
const sumOf = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

export default function TeamDashboard({ lang }) {
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const q = useAsync(() => api.get('/api/me/reviews/team-dashboard').catch(() => null), []);
  const d = q.data;
  const cycles = useMemo(() => (d && Array.isArray(d.cycles) ? d.cycles : []), [d]);
  if (!d || !cycles.length || !cycles.some((c) => c.counted > 0)) return null;
  const cur = cycles[0];
  const curT = tiersOf(cur.mine);
  const curN = sumOf(curT);
  const closed = cycles.filter((c) => c.status === 'closed');
  const last = closed[0] || null;
  const att = Array.isArray(d.attention) ? d.attention : [];
  return (
    <div className="tdb">
      <section className="tdb-card" aria-label={s.cur(cur.name)}>
        <div className="tdb-h">{s.cur(cur.name)}</div>
        {curN === 0 ? <div className="tdb-h">{s.curNone}</div> : (
          <div className="tdb-bars">
            {TIERS.map((t) => {
              const n = curT[t] || 0, pct = curN ? Math.round((n / curN) * 100) : 0;
              const qv = cur.quota && cur.quota[t] != null ? Number(cur.quota[t]) : null;
              return (
                <div key={t} className="tdb-bar" title={qv != null ? s.quota(qv) : undefined}>
                  <b>{t}</b>
                  <div className="tdb-track"><i style={{ width: pct + '%' }} />{qv != null && <em style={{ left: Math.min(100, qv) + '%' }} />}</div>
                  <span className="tnum">{n} · {pct}%{qv != null ? ` / ${qv}%` : ''}</span>
                </div>
              );
            })}
            <div className="tdb-legend">{s.legend}</div>
          </div>
        )}
      </section>
      <section className="tdb-card" aria-label={s.att}>
        <div className="tdb-h">{last ? s.cal(last.name) : s.calNone}</div>
        {last && last.moves && (
          <ul className="tdb-list">
            <li><span>{s.up}</span><b className="tnum">{last.moves.up}</b></li>
            <li><span>{s.down}</span><b className="tnum">{last.moves.down}</b></li>
            <li><span>{s.same}</span><b className="tnum">{last.moves.same}</b></li>
          </ul>
        )}
        <div className="tdb-h" style={{ marginTop: 12 }}>{s.att}</div>
        {att.length === 0 ? <div className="tdb-h">{s.attNone}</div> : (
          <ul className="tdb-list">
            {att.map((p) => (
              <li key={p.userId}><span>{p.name}{p.position ? ` · ${p.position}` : ''}</span><span className="pill warn">{p.reasons.map((r) => s[r]).join(' · ')} · {p.previous} → {p.latest}</span></li>
            ))}
          </ul>
        )}
      </section>
      <section className="tdb-card" aria-label={s.trend}>
        <div className="tdb-h">{s.trend}</div>
        {closed.length === 0 ? <div className="tdb-h">{s.trendNone}</div> : (
          <div className="tdb-trend">
            {closed.map((c) => {
              const t = tiersOf(c.final), n = sumOf(t);
              return (
                <div key={c.cycleId} className="tdb-trend-row">
                  <span>{c.name}</span>
                  <span className="tnum">{TIERS.map((k) => `${k} ${t[k] || 0}`).join(' · ')}{n ? ` · ${s.people(n)}` : ''}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
