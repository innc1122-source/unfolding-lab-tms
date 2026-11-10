// 培训概览 5 张指标卡（第三批 4.1）：整张卡是一个 button，点开对应名单；可访问名称就是卡片文字（标签、数值、环比、说明），
// 不另设 aria-label（UX 审查 22）。▲▼ 对读屏隐藏，另给「上升 / 下降」的隐藏文字；环比按「好的方向」着色（逾期人数下降为好）。
import { fmtDelta, fmt1 } from './ovquery.js';

const BASE = { month: 'baseMonth', quarter: 'baseQuarter', year: 'baseYear', custom: 'baseCustom' };

// metric = 名单口径，o = 名单覆盖项
const CARDS = [
  { key: 'coverage', kind: 'rate', label: 'kCoverage', tip: 'kCoverageTip', metric: 'covered', o: {} },
  { key: 'hoursPerHead', kind: 'hours', label: 'kHours', metric: 'covered', o: { lsort: 'hours' } },
  { key: 'requiredCompletion', kind: 'rate', label: 'kReq', metric: 'assigned', o: { lenroll: 'mandatory', lst: 'notdone' } },
  { key: 'overduePeople', kind: 'count', label: 'kOverdue', metric: 'overdue', o: {} },
  { key: 'passRate', kind: 'rate', label: 'kPass', metric: 'attempts', o: {} },
];

export default function KpiCards({ s, kpis, period, loading, onOpen }) {
  const k = kpis || {};
  const base = s[BASE[period]] || s.baseCustom;
  const valueOf = (c, v) => {
    if (v === null || v === undefined) return s.dash;
    if (c.kind === 'rate') return `${fmt1(v)}%`;
    if (c.kind === 'hours') return s.unitHours(v);
    return s.unitPeople(v);
  };
  const subOf = (c, x) => {
    if (c.key === 'coverage') return s.kCoverageSub(x.num || 0, x.den || 0);
    if (c.key === 'hoursPerHead') return s.kHoursSub(x.num || 0);
    if (c.key === 'requiredCompletion') return x.value === null || x.value === undefined ? s.kReqNa : s.kReqSub(x.num || 0, x.den || 0);
    if (c.key === 'overduePeople') return s.kOverdueSub(x.rows || 0);
    return x.value === null || x.value === undefined ? s.kPassNa : s.kPassSub(x.num || 0, x.den || 0);
  };
  // 第四批 7：参训覆盖率与人均学时拆成「指派 · 自主」（split.self.num > 0 时才显示；同一人两边都算、合计只算一次）
  const splitOf = (c, x) => {
    const sp = x && x.split;
    if (!sp || !sp.self || !(Number(sp.self.num) > 0) || !sp.assigned) return null;
    if (c.key === 'coverage') return s.kSplitRate(fmt1(sp.assigned.value || 0), fmt1(sp.self.value || 0));
    if (c.key === 'hoursPerHead') return s.kSplitHours(fmt1(sp.assigned.value || 0), fmt1(sp.self.value || 0));
    return null;
  };
  return (
    <div className="ovx-kpis">
      {CARDS.map((c) => {
        const x = k[c.key] || {};
        const d = fmtDelta(x, c.kind, c.key);
        const absTxt = d.abs === null ? '' : c.kind === 'rate' ? s.pts(d.abs) : c.kind === 'hours' ? s.unitHours(d.abs) : s.unitPeople(d.abs);
        return (
          <button type="button" key={c.key} className={'ovx-kpi ovx-kpi-' + c.key} onClick={() => onOpen(c.metric, c.o)}
            title={c.tip ? s[c.tip] : s.kpiOpen} disabled={loading}>
            <span className="ovx-kpi-lab">{s[c.label]}</span>
            <span className="ovx-kpi-val tnum">{loading ? s.dash : valueOf(c, x.value)}</span>
            <span className={'ovx-kpi-delta' + (d.good === true ? ' good' : d.good === false ? ' bad' : '')}>
              {loading ? '' : period === 'all' ? '' : d.dir === null ? s.noPrev : d.dir === 'flat' ? s.flat(base) : (
                <>
                  <span aria-hidden>{d.dir === 'up' ? '▲ ' : '▼ '}</span>
                  <span className="ovx-sr">{d.dir === 'up' ? s.srUp : s.srDown} </span>
                  {s.delta(absTxt, base)}
                </>
              )}
            </span>
            <span className="ovx-kpi-sub">{loading ? '' : subOf(c, x)}</span>
            {!loading && splitOf(c, x) && <span className="ovx-kpi-split tnum">{splitOf(c, x)}</span>}
          </button>
        );
      })}
    </div>
  );
}

