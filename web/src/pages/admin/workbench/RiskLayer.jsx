// 12.2 工作台 第二层「组织风险」（b12-design §2）：六项指标卡，带环比。
// 卡片：标题行（图标 + 名称 + 统计期胶囊 + 口径说明）、主数（可点开名单）、环比行（语义色按 better 方向）、附带数、底部「查看名单」。
// empty 状态给一句说明，有写权限时给操作按钮（继任覆盖率 → 关键岗位清单）。
import { useNavigate } from 'react-router-dom';
import { Banner, Tooltip } from '@douyinfe/semi-ui';
import { IconHelpCircle } from '@douyinfe/semi-icons';
import { useI18n } from '../../../i18n.jsx';
import { useAuth } from '../../../auth.jsx';
import { canWriteDomain } from '../../../rbac.js';
import { metricKind } from '../../../workbench.js';
import { nf, pf, DeltaLine, DrillNumber, ListLink, IcSuccession, IcBadge, IcCap, IcChart, IcPeople, IcOrg } from './shared.jsx';

export const RISK_ORDER = ['succession', 'retention', 'compliance', 'reviewOnTime', 'probation', 'span'];
const ICONS = { succession: IcSuccession, retention: IcBadge, compliance: IcCap, reviewOnTime: IcChart, probation: IcPeople, span: IcOrg };

const T = {
  zh: {
    title: {
      succession: '关键岗位继任覆盖率', retention: '高潜与关键人才保留', compliance: '必修合规完成率',
      reviewOnTime: '评估按时完成率', probation: '试用期转正通过率', span: '管理幅度异常',
    },
    def: {
      succession: '关键岗位清单中，至少有 1 名就绪度为「即刻就绪」或「1–2 年内就绪」、在职且在你数据范围内的继任者的岗位占比。',
      retention: '本季度离职、且离职当天持有「高潜」或「关键人才」受控标签的人数；离职率分母为季度初持有标签的在职人数加季度内新打标人数。另列当前被标记「流失风险」的在职人数。',
      compliance: '与培训概览同一口径：本季度应完成的必修指派人次中已完成的比例，不含自主学习。必修完成率按指派人次计算，名单显示仍有未完成必修的员工。',
      reviewOnTime: '当期评估周期中已过截止日的阶段（自评、上级评级、HoD 校准）按时完成的比例；未到截止日的阶段不计入。与上一个同类周期比较。',
      probation: '本季度转正结论中按期或延期转正的比例；试用期内离职计入分母。平均转正周期按通过者入职至转正的天数计算。',
      span: '直属下属为 0 人（仅管理序列或部门负责人）或超过上限的管理者人数；只计在职、在你数据范围内的直属下属。',
    },
    quarter: (y, q) => `${y} 年第 ${q} 季度`,
    exits: (n) => `本季度离职 ${n} 人`,
    exitRate: (p) => `离职率 ${p}`,
    voluntary: (n) => `其中主动离职 ${n} 人`,
    flight: '当前被标记流失风险', people: (n) => `${n} 人`,
    noSuccessor: (n) => `${n} 个关键岗位尚无继任者`,
    lowest: (name, p) => `最低：${name} ${p}`,
    stages: { self: '自评', rate: '上级评级', calib: 'HoD 校准' },
    avgCycle: (m) => `平均转正周期 ${m} 个月`,
    spanSplit: (a, b, max) => `直属 0 人：${a} · 超过 ${max} 人：${b}`,
    managers: (n) => `${n} 名管理者`,
    of: (a, b) => `${a} / ${b}`,
    empty: {
      no_key_positions: '尚未建立关键岗位清单。', no_cycle: '暂无可统计的评估周期。', no_data: '本期暂无可统计的数据。',
    },
    maintain: '维护关键岗位清单', help: '口径说明',
    loadFail: '组织风险指标加载失败，请刷新页面重试。',
  },
  en: {
    title: {
      succession: 'Key Position Succession Coverage', retention: 'High-Potential & Key Talent Retention', compliance: 'Required Training Compliance',
      reviewOnTime: 'On-Time Review Completion', probation: 'Probation Pass Rate', span: 'Span-of-Control Exceptions',
    },
    def: {
      succession: 'Share of key positions with at least one successor rated Ready now or Ready in 1–2 years who is active and within your data scope.',
      retention: 'Employees who left this quarter while holding the controlled High potential or Key talent tag. The exit rate is based on tagged active employees at the start of the quarter plus those tagged during it. Also shows active employees currently flagged Flight risk.',
      compliance: 'Same definition as the Learning Overview: completed share of required assignments due this quarter, excluding self-directed learning. Required training is counted by assignment; the list shows employees with incomplete required courses.',
      reviewOnTime: 'Share of past-due review stages (self-review, manager rating, HoD calibration) completed on time in the current cycle. Stages not yet due are excluded. Compared with the previous cycle of the same type.',
      probation: 'Share of this quarter’s probation outcomes that were regularized on time or after extension. Exits during probation count in the base. Average time is hire date to regularization for those who passed.',
      span: 'Managers with no direct reports (management track or department heads only) or more than the limit. Only active direct reports within your data scope count.',
    },
    quarter: (y, q) => `Q${q} ${y}`,
    exits: (n) => `${n} left this quarter`,
    exitRate: (p) => `Exit rate ${p}`,
    voluntary: (n) => `${n} voluntary`,
    flight: 'Currently flagged Flight risk', people: (n) => `${n}`,
    noSuccessor: (n) => `${n} key positions have no successor`,
    lowest: (name, p) => `Lowest: ${name} ${p}`,
    stages: { self: 'Self-review', rate: 'Manager rating', calib: 'HoD calibration' },
    avgCycle: (m) => `Average time to regularization: ${m} months`,
    spanSplit: (a, b, max) => `No direct reports: ${a} · More than ${max}: ${b}`,
    managers: (n) => `${n} managers`,
    of: (a, b) => `${a} of ${b}`,
    empty: {
      no_key_positions: 'No key position list yet.', no_cycle: 'No review cycle to measure yet.', no_data: 'No data for this period yet.',
    },
    maintain: 'Maintain key positions', help: 'Definition',
    loadFail: 'Couldn’t load the organizational risk indicators. Refresh the page to try again.',
  },
};

function quarterOf(period) {
  const m = period && /^(\d{4})-(\d{2})/.exec(String(period.from || ''));
  return m ? { y: m[1], q: Math.floor((Number(m[2]) - 1) / 3) + 1 } : null;
}

const KEY_POSITIONS = '/admin/talent-review/key-positions';

function MainNumber({ m, kind, s }) {
  const pct = m.unit === 'pct';
  const shown = pct ? pf(m.value) : nf(Number(m.value));
  const label = kind === 'retention' ? s.exits(nf(Number(m.value))) : kind === 'span' ? s.managers(nf(Number(m.value))) : null;
  return (
    <div className="wb-main">
      <DrillNumber drill={m.drill || { metric: m.key }} to={m.link} className="wb-main-v tnum" label={s.title[kind]}>{shown}</DrillNumber>
      {pct && Number.isFinite(Number(m.num)) && Number.isFinite(Number(m.den)) && <span className="wb-main-sub tnum">{s.of(nf(Number(m.num)), nf(Number(m.den)))}</span>}
      {label && <span className="wb-main-sub">{label}</span>}
    </div>
  );
}

function Extra({ m, kind, s }) {
  const x = m.extra || {};
  const lines = [];
  if (kind === 'succession' && Number(x.noSuccessor) > 0) lines.push(s.noSuccessor(nf(Number(x.noSuccessor))));
  if (kind === 'retention') {
    if (x.rate !== undefined && x.rate !== null) lines.push(s.exitRate(pf(x.rate)));
    if (Number(x.voluntary) > 0) lines.push(s.voluntary(nf(Number(x.voluntary))));
  }
  if (kind === 'compliance' && x.lowestDept && x.lowestDept.name) lines.push(s.lowest(x.lowestDept.name, pf(x.lowestDept.value)));
  if (kind === 'reviewOnTime' && x.stages) {
    const parts = ['self', 'rate', 'calib'].filter((k) => x.stages[k] !== undefined && x.stages[k] !== null).map((k) => `${s.stages[k]} ${pf(x.stages[k])}`);
    if (parts.length) lines.push(parts.join(' · '));
  }
  if (kind === 'probation' && Number.isFinite(Number(x.avgMonths)) && x.avgMonths !== null) lines.push(s.avgCycle(Number(x.avgMonths).toFixed(1)));
  if (kind === 'span') lines.push(s.spanSplit(nf(Number(x.zero) || 0), nf(Number(x.over) || 0), nf(Number(x.spanMax) || 10)));
  return lines.length ? <div className="wb-extra">{lines.map((l) => <span key={l}>{l}</span>)}</div> : null;
}

/* 高潜保留卡的附数：当前被标记流失风险的在职人数（better: down），带自己的环比与名单。 */
function FlightLine({ m, s }) {
  const f = m.extra && m.extra.flight;
  if (f === undefined || f === null) return null;
  const fm = typeof f === 'object' ? { key: 'flight', unit: 'count', better: 'down', ...f } : { key: 'flight', unit: 'count', better: 'down', value: f, prev: null };
  return (
    <div className="wb-sub-metric">
      <div className="wb-sub-head">
        <span>{s.flight}</span>
        <DrillNumber drill={fm.drill || { metric: 'flight' }} className="wb-sub-v tnum" label={s.flight}>{s.people(nf(Number(fm.value)))}</DrillNumber>
      </div>
      <DeltaLine metric={fm} />
    </div>
  );
}

/* 评估按时率：当期周期一行，直达该周期（/admin/reviews?cycle=<id>），与原工作台「评估周期进度」每个周期一行的做法一致。 */
function CycleRow({ c, navigate }) {
  if (!c || !c.id) return null;
  return (
    <div className="wb-cycle" role="link" tabIndex={0}
      onClick={(e) => { e.stopPropagation(); navigate(`/admin/reviews?cycle=${encodeURIComponent(c.id)}`); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); navigate(`/admin/reviews?cycle=${encodeURIComponent(c.id)}`); } }}>
      <b className="emp-namelink">{c.name}</b>
    </div>
  );
}

function RiskCard({ m, kind }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const navigate = useNavigate();
  const { user } = useAuth();
  const Icon = ICONS[kind];
  const q = quarterOf(m.period);
  const cycle = kind === 'reviewOnTime' && m.extra ? m.extra.cycle : null;
  const periodLabel = kind === 'reviewOnTime' ? null : q ? s.quarter(q.y, q.q) : null;
  return (
    <article className={'wb-card wb-risk ' + kind}>
      <div className="wb-card-head">
        <h3 className="wb-card-title"><Icon /><span className="wb-card-name">{s.title[kind]}</span></h3>
        {periodLabel && <span className="pill muted wb-period">{periodLabel}</span>}
        <Tooltip content={<div className="u-help-tip">{s.def[kind]}</div>} position="bottomRight">
          <button type="button" className="u-help-btn" aria-label={s.help}><IconHelpCircle size="small" /></button>
        </Tooltip>
      </div>
      {kind === 'reviewOnTime' && <CycleRow c={cycle} navigate={navigate} />}
      {m.empty ? (
        <div className="wb-card-empty">
          <span>{s.empty[m.empty] || s.empty.no_data}</span>
          {m.empty === 'no_key_positions' && canWriteDomain(user, 'talent') && (
            <button type="button" className="btn sm wb-go" onClick={() => navigate(KEY_POSITIONS)}>{s.maintain}</button>
          )}
        </div>
      ) : (
        <>
          <MainNumber m={m} kind={kind} s={s} />
          <DeltaLine metric={{ ...m, key: kind }} />
          <Extra m={m} kind={kind} s={s} />
          {kind === 'retention' && <FlightLine m={m} s={s} />}
          <div className="wb-card-foot"><ListLink drill={m.drill || { metric: m.key }} to={m.link} /></div>
        </>
      )}
    </article>
  );
}

/** 第二层卡片：按固定顺序取服务端下发且该视角可见的指标（无权的指标服务端整块不下发）。 */
export function riskMetrics(data, layout) {
  const got = new Map();
  for (const m of (data && data.metrics) || []) {
    const kind = metricKind(m && m.key);
    if (kind && !got.has(kind)) got.set(kind, m);
  }
  return RISK_ORDER.filter((k) => got.has(k) && (!layout || layout.blocks[k])).map((k) => ({ kind: k, m: got.get(k) }));
}

export default function RiskLayer({ cards, error }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  if (error) return <Banner type="danger" closeIcon={null} description={s.loadFail} />;
  return (
    <div className="wb-risk-grid">
      {cards.map(({ kind, m }) => <RiskCard key={kind} kind={kind} m={m} />)}
    </div>
  );
}
