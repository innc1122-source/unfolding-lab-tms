// 12.2 工作台 Action 3+3 挑战落地（b12-design §3.5）：前端直接读 3+3 模块现有接口，不改 modules/culture。
//   GET /api/v1/culture/programs                         进行中期次 → 当前周
//   GET /api/v1/culture/meetings?week=&missing=1         coverageByDept（参与覆盖率、HoD 例会是否登记、团队例会登记数 / 应登记数）与未登记占位行
//   GET /api/v1/culture/cards?status=new&pageSize=1      total = 待审核认可卡数
//   GET /api/v1/culture/depts                            各一级部门参与人数（并进部门健康度表）
// 只列参与人数 ≥ 5 的一级部门，按参与覆盖率排名。任一接口失败时该块只给「进入 Action 3+3 挑战后台」链接，不影响其他块。
import { date as fmtDate } from '../../../fmt.js';
import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import { useI18n } from '../../../i18n.jsx';
import { cultureWeek, rankCultureDepts } from '../../../workbench.js';
import { nf, pf, IcArrow } from './shared.jsx';

export const CULTURE_HR = '/culture/#/hr';

const T = {
  zh: {
    title: 'Action 3+3 挑战落地情况', week: (n) => `第 ${n} 周`, noProgram: '当前没有进行中的期次。',
    dept: '一级部门', coverage: '参与覆盖率', hod: 'HoD 例会', team: '团队例会',
    hodYes: '已登记', hodNo: '未登记', teamOf: (a, b) => `${a} / ${b}`,
    cards: (n) => `待审核认可卡 ${n} 张`, unregistered: (n) => `本周未登记例会 ${n} 场`,
    minNote: (n) => `只列参与人数不少于 ${n} 人的一级部门。`,
    none: '暂无达到人数门槛的一级部门。',
    open: '进入 Action 3+3 挑战后台',
  },
  en: {
    title: 'Action 3+3 Challenge Adoption', week: (n) => `Week ${n}`, noProgram: 'No program is running right now.',
    dept: 'Department', coverage: 'Participation coverage', hod: 'HoD meeting', team: 'Team meetings',
    hodYes: 'Logged', hodNo: 'Not logged', teamOf: (a, b) => `${a} of ${b}`,
    cards: (n) => `${n} recognition cards awaiting review`, unregistered: (n) => `${n} meetings not logged this week`,
    minNote: (n) => `Only departments with at least ${n} participants are listed.`,
    none: 'No department meets the participant threshold yet.',
    open: 'Open the Action 3+3 Challenge console',
  },
};

const todayYmd = () => fmtDate(new Date());

/** 3+3 数据（enabled = culture 模块开启且 culture 可读）。返回 { loading, error, program, week, coverage, unregistered, pendingCards, depts, deptsError }。 */
export function useCultureData(enabled) {
  const [st, setSt] = useState({ loading: !!enabled });
  useEffect(() => {
    if (!enabled) { setSt({ loading: false }); return undefined; }
    let alive = true;
    (async () => {
      const out = { loading: false };
      try {
        const progs = await api.get('/api/v1/culture/programs?pageSize=50');
        const program = ((progs && progs.items) || []).find((p) => p.status === 'active') || null;
        out.program = program;
        out.week = program ? cultureWeek(program, todayYmd()) : null;
        const pid = program ? `programId=${encodeURIComponent(program.id)}&` : '';
        const [cards, depts, meet] = await Promise.allSettled([
          program ? api.get(`/api/v1/culture/cards?${pid}status=new&pageSize=1`) : Promise.resolve(null),
          api.get(`/api/v1/culture/depts?${pid}pageSize=200`),
          program && out.week ? api.get(`/api/v1/culture/meetings?${pid}week=${out.week}&missing=1&pageSize=200`) : Promise.resolve(null),
        ]);
        if (depts.status === 'fulfilled') out.depts = (depts.value && depts.value.items) || [];
        else out.deptsError = true;
        if (cards.status === 'rejected' || meet.status === 'rejected') out.error = true;
        if (cards.status === 'fulfilled' && cards.value) out.pendingCards = Number(cards.value.total) || 0;
        if (meet.status === 'fulfilled' && meet.value) {
          let items = meet.value.items || [];
          const total = Number(meet.value.total) || items.length;
          // 未登记占位行可能跨页：按 pageSize 200 续取，最多 10 页
          for (let page = 2; items.length < total && page <= 10; page++) {
            const more = await api.get(`/api/v1/culture/meetings?${pid}week=${out.week}&missing=1&pageSize=200&page=${page}`);
            const got = (more && more.items) || [];
            if (!got.length) break;
            items = items.concat(got);
          }
          out.coverage = meet.value.coverageByDept || [];
          out.unregistered = items.filter((x) => x && x.registered === false).length;
        }
      } catch {
        out.error = true;
      }
      if (alive) setSt(out);
    })();
    return () => { alive = false; };
  }, [enabled]);
  return st;
}

/** 3+3 进第一层的两条待办（数量 > 0 才显示，链接为 3+3 后台整页）。 */
export function cultureTodoItems(c) {
  if (!c || c.loading || c.error) return [];
  return [
    { key: 'cultureMeetings', domain: 'culture', module: 'culture', count: c.unregistered || 0, severity: 'normal', link: CULTURE_HR },
    { key: 'cultureCards', domain: 'culture', module: 'culture', count: c.pendingCards || 0, severity: 'normal', link: CULTURE_HR },
  ];
}

const MIN_N = 5;

export default function CulturePanel({ data }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const c = data || {};
  const open = <a className="btn ghost sm wb-listlink" href={CULTURE_HR}>{s.open}<IcArrow /></a>;
  const head = (
    <div className="wb-card-head">
      <h3 className="wb-card-title"><span className="wb-card-name">{s.title}</span></h3>
      {c.week ? <span className="pill muted wb-period">{s.week(nf(c.week))}</span> : null}
    </div>
  );
  if (c.loading) return <div className="wb-card wb-culture">{head}</div>;
  if (c.error) return <div className="wb-card wb-culture">{head}<div className="wb-card-foot">{open}</div></div>;
  if (!c.program) return <div className="wb-card wb-culture">{head}<div className="wb-empty">{s.noProgram}</div><div className="wb-card-foot">{open}</div></div>;
  const ranked = rankCultureDepts(c.coverage, MIN_N);
  return (
    <div className="wb-card wb-culture">
      {head}
      <div className="wb-extra">
        <span>{s.unregistered(nf(c.unregistered || 0))}</span>
        <span>{s.cards(nf(c.pendingCards || 0))}</span>
      </div>
      {ranked.length === 0 ? <div className="wb-empty">{s.none}</div> : (
        <ol className="wb-culture-list">
          {ranked.map((d) => (
            <li className="wb-culture-row" key={d.dept1Id}>
              <span className="wb-culture-name">{d.dept1 || '—'}</span>
              <span className="wb-culture-rate tnum">{pf(Number(d.rate) * 100)}</span>
              <span className={'pill ' + (d.hodRegistered ? 'ok' : 'warn')}>{s.hod} {d.hodRegistered ? s.hodYes : s.hodNo}</span>
              <span className="wb-culture-team tnum">{s.team} {s.teamOf(nf(Number(d.teamRegistered) || 0), nf(Number(d.teamExpected) || 0))}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="wb-note">{s.minNote(nf(MIN_N))}</div>
      <div className="wb-card-foot">{open}</div>
    </div>
  );
}
