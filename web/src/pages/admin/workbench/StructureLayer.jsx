// 12.2 工作台 第三层「人才结构与组织效能」（b12-design §3）：九宫格分布缩略、绩效分布与配额偏离、晋升与梯队（≥ 1200 三列，其下单列），
// 其下部门健康度对照表与 Action 3+3 挑战落地。每块由服务端按模块开关与能力域裁剪（无权整块不下发），前端再按视角取舍。
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banner } from '@douyinfe/semi-ui';
import { useI18n } from '../../../i18n.jsx';
import { nineBoxCount, quotaOverage, drillHref } from '../../../workbench.js';
import { nf, pf, IcArrow, IcStructure, IcChart, IcBadge } from './shared.jsx';
import DeptHealthTable from './DeptHealthTable.jsx';
import CulturePanel from './CulturePanel.jsx';

const T = {
  zh: {
    nineBox: '九宫格分布', perf: '绩效', pot: '潜力', levels: ['低', '中', '高'],
    unrated: (n) => `未评 ${n} 人`, current: '当前', potNote: '对比周期的潜力轴取当前值（潜力不留历史）。',
    cell: (p, q, n) => `绩效${p}、潜力${q}：${n} 人`,
    perfQuota: '绩效分布与配额偏离', overBand: (b, pp) => `${b} 超配 +${pp} 个百分点`, within: '未超配',
    small: '人数不足 10 人，仅提示', headcount: (n) => `${n} 人`, noCycle: '暂无已关闭的评估周期。',
    pipeline: '晋升与梯队', candidates: '晋升评审候选', promoRate: '近 12 个月晋升率',
    promoted: (a) => `近 12 个月晋升 ${a} 人`, gaps: '梯队断层', noGaps: '各职等均有符合条件的晋升评审候选。',
    gap: (t, g) => `${t === 'M' ? '管理序列' : '专业序列'} ${g} 职等`,
    toTalent: '人才盘点', toReviews: '评估周期',
    loadFail: '人才结构数据加载失败，请刷新页面重试。',
  },
  en: {
    nineBox: '9-Box Distribution', perf: 'Performance', pot: 'Potential', levels: ['Low', 'Medium', 'High'],
    unrated: (n) => `${n} not rated`, current: 'Current', potNote: 'Comparison cycles use current potential (potential has no history).',
    cell: (p, q, n) => `Performance ${p}, potential ${q}: ${n}`,
    perfQuota: 'Rating Distribution vs. Quota', overBand: (b, pp) => `${b} over quota by ${pp} pp`, within: 'Within quota',
    small: 'Fewer than 10 people, for reference only', headcount: (n) => `${n} people`, noCycle: 'No closed review cycle yet.',
    pipeline: 'Promotion & Bench Strength', candidates: 'Promotion Panel Candidates', promoRate: 'Promotion rate, last 12 months',
    promoted: (a) => `${a} promoted in the last 12 months`, gaps: 'Bench gaps', noGaps: 'Every grade has eligible promotion panel candidates.',
    gap: (t, g) => `${t === 'M' ? 'Management' : 'Professional'} track, grade ${g}`,
    toTalent: 'Talent Review', toReviews: 'Review Cycles',
    loadFail: 'Couldn’t load the talent structure data. Refresh the page to try again.',
  },
};

function NineBox({ data, s }) {
  const navigate = useNavigate();
  const sets = [{ id: 'current', name: s.current, cells: data.cells, unrated: data.unrated, drill: true }];
  if (data.compare && data.compare.latest && data.compare.previous) {
    sets.push({ id: 'latest', name: data.compare.latest.name, cells: data.compare.latest.cells, unrated: data.compare.latest.unrated });
    sets.push({ id: 'previous', name: data.compare.previous.name, cells: data.compare.previous.cells, unrated: data.compare.previous.unrated });
  }
  const [pick, setPick] = useState('current');
  const set = sets.find((x) => x.id === pick) || sets[0];
  return (
    <div className="wb-card wb-ninebox">
      <div className="wb-card-head">
        <h3 className="wb-card-title"><IcStructure /><span className="wb-card-name">{s.nineBox}</span></h3>
      </div>
      {sets.length > 1 && (
        <div className="wb-seg" role="group" aria-label={s.nineBox}>
          {sets.map((x) => <button type="button" key={x.id} className={'wb-seg-btn' + (x.id === set.id ? ' on' : '')} aria-pressed={x.id === set.id} title={x.name} onClick={() => setPick(x.id)}>{x.name}</button>)}
        </div>
      )}
      <div className="wb-9">
        <span className="wb-9-y">{s.perf}</span>
        <div className="wb-9-grid">
          {[2, 1, 0].map((p) => [0, 1, 2].map((q) => {
            const n = nineBoxCount(set.cells, p, q);
            const label = s.cell(s.levels[p], s.levels[q], nf(n));
            const href = set.drill && n > 0 ? drillHref({ metric: 'nineBox', cell: `${p}-${q}` }, '/admin/talent-review') : null;
            return href
              ? <button type="button" key={`${p}-${q}`} className={`wb-9-cell p${p} q${q}`} aria-label={label} title={label} onClick={() => navigate(href)}><span className="tnum">{nf(n)}</span></button>
              : <span key={`${p}-${q}`} className={`wb-9-cell p${p} q${q}` + (n ? '' : ' zero')} title={label}><span className="tnum">{nf(n)}</span></span>;
          }))}
        </div>
        <span className="wb-9-x">{s.pot}</span>
      </div>
      <div className="wb-extra">{Number(set.unrated) > 0 && <span>{s.unrated(nf(Number(set.unrated)))}</span>}{sets.length > 1 && <span>{s.potNote}</span>}</div>
      <div className="wb-card-foot"><button type="button" className="btn ghost sm wb-listlink" onClick={() => navigate('/admin/talent-review')}>{s.toTalent}<IcArrow /></button></div>
    </div>
  );
}

function PerfQuota({ data, s }) {
  const navigate = useNavigate();
  const cycle = data.cycle || null;
  const depts = data.depts || [];
  return (
    <div className="wb-card wb-quota">
      <div className="wb-card-head">
        <h3 className="wb-card-title"><IcChart /><span className="wb-card-name">{s.perfQuota}</span></h3>
        {/* W1：.pill 是 flex，文字是匿名 flex 项，省略号要放在内层 span 上 */}
        {cycle && cycle.name && <span className="pill muted wb-period" title={cycle.name}><span className="wb-period-text">{cycle.name}</span></span>}
      </div>
      {!cycle ? <div className="wb-empty">{s.noCycle}</div> : (
        <ul className="wb-quota-list">
          {depts.map((d) => {
            const over = quotaOverage(d);
            return (
              <li className={'wb-quota-row' + (d.small ? ' small' : '')} key={d.dept1Id || d.dept1}>
                <span className="wb-quota-name">{d.dept1 || '—'}</span>
                <span className="wb-quota-hc tnum">{s.headcount(nf(Number(d.headcount) || 0))}</span>
                {d.small ? <span className="pill muted">{s.small}</span>
                  : over ? <span className="pill warn">{s.overBand(over.band, over.pp.toFixed(1))}</span>
                    : <span className="pill ok">{s.within}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {cycle && cycle.id && (
        <div className="wb-card-foot"><button type="button" className="btn ghost sm wb-listlink" onClick={() => navigate(`/admin/reviews?cycle=${encodeURIComponent(cycle.id)}`)}>{s.toReviews}<IcArrow /></button></div>
      )}
    </div>
  );
}

function Pipeline({ data, s }) {
  const navigate = useNavigate();
  const gaps = data.gaps || [];
  return (
    <div className="wb-card wb-pipeline">
      <div className="wb-card-head">
        <h3 className="wb-card-title"><IcBadge /><span className="wb-card-name">{s.pipeline}</span></h3>
      </div>
      <div className="wb-kv">
        <div className="wb-kv-row"><span className="wb-kv-k">{s.candidates}</span><span className="wb-kv-v tnum">{nf(Number(data.candidates) || 0)}</span></div>
        <div className="wb-kv-row"><span className="wb-kv-k">{s.promoRate}</span><span className="wb-kv-v tnum">{pf(data.promotionRate)}</span></div>
      </div>
      {Number.isFinite(Number(data.promoted)) && data.promoted !== null && <div className="wb-extra"><span>{s.promoted(nf(Number(data.promoted)))}</span></div>}
      <div className="wb-gaps">
        <span className="wb-kv-k">{s.gaps}</span>
        {gaps.length === 0 ? <span className="wb-note">{s.noGaps}</span>
          : <span className="wb-gap-pills">{gaps.map((g) => <span className="pill warn" key={`${g.track}-${g.grade}`}>{s.gap(g.track, g.grade)}</span>)}</span>}
      </div>
      <div className="wb-card-foot"><button type="button" className="btn ghost sm wb-listlink" onClick={() => navigate('/admin/talent-review')}>{s.toTalent}<IcArrow /></button></div>
    </div>
  );
}

export default function StructureLayer({ data, error, layout, culture }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  if (error) return <Banner type="danger" closeIcon={null} description={s.loadFail} />;
  const d = data || {};
  const show = (k) => layout.blocks[k] && d[k] !== undefined && d[k] !== null;
  const cultureColumn = !!(layout.blocks.culture && culture && Array.isArray(culture.depts));
  const top = [show('nineBox') && <NineBox key="nb" data={d.nineBox} s={s} />, show('perfQuota') && <PerfQuota key="pq" data={d.perfQuota} s={s} />, show('pipeline') && <Pipeline key="pl" data={d.pipeline} s={s} />].filter(Boolean);
  return (
    <>
      {top.length > 0 && <div className={'wb-structure-grid n' + top.length}>{top}</div>}
      {show('deptHealth') && <DeptHealthTable data={d.deptHealth} cultureColumn={cultureColumn} cultureDepts={culture && culture.depts} />}
      {layout.blocks.culture && <CulturePanel data={culture} />}
    </>
  );
}
