import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAsync, api } from '../api.js';
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';

// 经理视图 — read-only. D8 (RBAC-DESIGN.md §8.2) widened a manager's range from
// direct reports to the WHOLE reporting line, so /api/me/team now also returns
// skip-levels. Every pre-existing field is untouched; relation / depth /
// managerId / managerName / directCount are the additive half we lean on here.
// F2 (cost): a 924-person line was 750KB / ~630ms because the server priced the
// training detail for every row. It now ships that detail for DIRECT reports
// only — a skip-level row carries identity + org + lineage and no
// assigned/done/overdue/items at all (262KB / ~16ms). So:
//   · `trained(r)` gates every training affordance on the row. A skip-level row
//     shows a 「明细见档案」 placeholder instead of empty pills or NaN counts, and
//     its name is still the door to the full read-only profile (D3), where the
//     training detail lives. Nobody disappears from the list.
//   · the two roll-up counters (逾期 / 全部完成) can therefore only be honest
//     about direct reports, and say so in their label once a second layer
//     exists. 「汇报线人数」 still counts the whole line.
//   · the gate is `typeof r.assigned === 'number'`, not `relation`, so an OLD
//     server (which sent the detail for skip-levels too) still renders it.
// Two things keep a 900-person line readable without new CSS:
//   · the list is ordered depth-first (a skip-level sits directly beneath their
//     own manager) and indented one notch per level, so the shape of the org is
//     visible in the left edge alone;
//   · every indirect row carries a 「隔层」 pill and 「汇报给 X」 in its meta line,
//     because indentation alone disappears on a phone-width row.
// Clicking a name opens that person's read-only profile (D3): /team/:userId.
// No editing, no assigning: that stays with HR.
const T = {
  zh: {
    title: '团队学习', lead: '汇报线成员的学习情况（仅查看）',
    leadN: (d, n) => `直接下属 ${d} 人，汇报线共 ${n} 人（仅查看）`,
    empty: '你目前没有下属', loadErr: '加载失败，请刷新页面重试。',
    kReports: '汇报线人数', kOverdue: '有逾期课程的人数', kAllDone: '课程全部通过的人数',
    // 手机上三张统计卡各只有 ~118px 宽,标签换短的。
    kReportsS: '汇报线', kOverdueS: '逾期', kAllDoneS: '全部通过',
    // 有隔层时,后两张卡只统计直接下属(隔层行不带培训字段),标签要说清楚。
    kOverdueDir: '有逾期课程的人数（直接下属）', kOverdueDirS: '逾期（直接下属）',
    kAllDoneDir: '课程全部通过的人数（直接下属）', kAllDoneDirS: '全部通过（直接下属）',
    fAll: '全部', fDirect: '直接下属', fIndirect: '间接下属',
    indirect: '间接', reportsTo: '汇报给', openProfile: (n) => `查看 ${n} 的档案`,
    assignedN: (n) => `${n} 门课程`, doneN: (n) => `${n} 门通过`, overdueN: (n) => `${n} 门逾期`,
    passFrac: (d, n) => `${d}/${n} 通过`, allPass: '全部通过',
    detail: '展开', hide: '收起', noCourses: '尚未指派课程',
    inProfile: '详见下属档案',
    stPassed: '已通过', stOverdue: '逾期', stProgress: '进行中', stNot: '未开始',
    due: '截止', score: (n) => `成绩 ${n}%`, inactive: '账号已停用',
    // 第四批 7：成员从课程目录自主加入的课程。只做标注，不计入课程数、通过数与逾期（服务端口径，设计 §4.2）
    selfTag: '自主学习', selfDoneN: (n) => `自主学习完成 ${n} 门`,
  },
  en: {
    title: 'Team Learning', lead: 'Learning progress across your reporting line (view only)',
    leadN: (d, n) => `${d} direct report${d === 1 ? '' : 's'}, ${n} in your reporting line (view only)`,
    empty: 'No one reports to you yet', loadErr: 'Couldn’t load. Refresh the page to try again.',
    kReports: 'People in Reporting Line', kOverdue: 'People with Overdue Courses', kAllDone: 'All Courses Passed',
    kReportsS: 'Reporting line', kOverdueS: 'Overdue', kAllDoneS: 'All passed',
    kOverdueDir: 'People with Overdue Courses (Direct Reports)', kOverdueDirS: 'Overdue (direct)',
    kAllDoneDir: 'All Courses Passed (Direct Reports)', kAllDoneDirS: 'All passed (direct)',
    fAll: 'All', fDirect: 'Direct', fIndirect: 'Indirect reports',
    indirect: 'Indirect', reportsTo: 'Reports to', openProfile: (n) => `Open ${n}'s profile`,
    assignedN: (n) => `${n} courses`, doneN: (n) => `${n} passed`, overdueN: (n) => `${n} overdue`,
    passFrac: (d, n) => `${d}/${n} passed`, allPass: 'All passed',
    detail: 'Expand', hide: 'Collapse', noCourses: 'No courses assigned yet',
    inProfile: 'Details in profile',
    stPassed: 'Passed', stOverdue: 'Overdue', stProgress: 'In progress', stNot: 'Not started',
    due: 'Due', score: (n) => `Score ${n}%`, inactive: 'Account deactivated',
    selfTag: 'Self-directed', selfDoneN: (n) => `${n} self-directed completed`,
  },
};

export default function MyTeam() {
  const { lang, loc } = useI18n();
  const s = T[lang] || T.en;
  const { loading, error, data } = useAsync(() => api.get('/api/me/team'), []);
  const [open, setOpen] = useState({});
  const [filter, setFilter] = useState('all'); // 'all' | 'direct' | 'indirect'

  if (loading) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>…</div></div>;
  if (error) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>{s.loadErr}</div></div>;
  const all = (data && data.rows) || [];
  // An old server sends no `relation` — read that as "everyone is direct", so a
  // new bundle against an old server renders exactly the flat list it used to.
  const relOf = (r) => (r.relation === 'indirect' ? 'indirect' : 'direct');
  const depthOf = (r) => (typeof r.depth === 'number' && r.depth > 0 ? r.depth : 1);

  // Depth-first order: each person is followed by their own subtree. Within one
  // manager, 已停用的下属排在最后 — 那一行只剩一枚灰胶囊,夹在在职的人中间会打断阅读。
  const rows = (() => {
    const byMgr = new Map();
    for (const r of all) {
      const key = relOf(r) === 'direct' ? '#root' : (r.managerId || '#root');
      if (!byMgr.has(key)) byMgr.set(key, []);
      byMgr.get(key).push(r);
    }
    const cmp = (a, b) => (Number(!a.active) - Number(!b.active))
      || String(a.name || '').localeCompare(String(b.name || ''));
    const out = [];
    const seen = new Set();
    // Iterative walk with a seen-set: the payload is already cycle-free (the
    // server's BFS guarantees it), but a stack + visited costs nothing and means
    // a malformed managerId can never spin this render forever.
    const walk = (key) => {
      for (const r of (byMgr.get(key) || []).slice().sort(cmp)) {
        if (seen.has(r.userId)) continue;
        seen.add(r.userId);
        out.push(r);
        walk(r.userId);
      }
    };
    walk('#root');
    // Anyone whose manager is not themselves in the line (shouldn't happen, but
    // the list must never silently drop a person) lands at the end.
    for (const r of all) if (!seen.has(r.userId)) { seen.add(r.userId); out.push(r); }
    return out;
  })();

  const directN = rows.filter((r) => relOf(r) === 'direct').length;
  const indirectN = rows.length - directN;
  // F2: the server prices the training detail for direct reports only, so the
  // two roll-ups count the rows that actually carry numbers. `trained` is the
  // one gate — a row either has real counts or none, never a half-filled one.
  const trained = (r) => typeof r.assigned === 'number';
  const counted = rows.filter(trained);
  const withOverdue = counted.filter((r) => r.overdue > 0).length;
  const allDone = counted.filter((r) => r.assigned > 0 && r.done === r.assigned).length;
  // Labels stay as they were while every row is counted (a line manager with
  // three direct reports sees no change at all); they get the 「· 直接下属」
  // qualifier only once some rows are outside the count.
  const partial = counted.length < rows.length;
  const shown = filter === 'all' ? rows : rows.filter((r) => relOf(r) === filter);

  const stateOf = (it) => it.passed ? 'passed' : it.overdue ? 'overdue' : (it.progress > 0 ? 'progress' : 'not');
  const stLabel = { passed: s.stPassed, overdue: s.stOverdue, progress: s.stProgress, not: s.stNot };
  const stCls = { passed: 'ok', overdue: 'fail', progress: 'pri', not: 'muted' };
  // 后端给的是 YYYY-MM-DD,行里只留月-日。
  const md = (d) => (typeof d === 'string' && d.length >= 10 ? d.slice(5) : d);

  return (
    <div className="wrap">
      <ModuleTrail items={learnTrail(lang, 'team')} />
      <div className="ml-head">
        <h1 className="ml-title">{s.title}</h1>
        <p className="ml-lead">{rows.length ? s.leadN(directN, rows.length) : s.lead}</p>
      </div>

      {rows.length === 0 ? (
        <div className="ml-empty">{s.empty}</div>
      ) : (
        <>
          <div className="tm-stats">
            <div className="tm-stat">
              <div className="tm-stat-k"><span className="tm-kl">{s.kReports}</span><span className="tm-ks">{s.kReportsS}</span></div>
              <div className="tm-stat-v tnum">{rows.length}</div>
            </div>
            <div className="tm-stat">
              <div className="tm-stat-k"><span className="tm-kl">{partial ? s.kOverdueDir : s.kOverdue}</span><span className="tm-ks">{partial ? s.kOverdueDirS : s.kOverdueS}</span></div>
              <div className={'tm-stat-v tnum' + (withOverdue > 0 ? ' is-bad' : '')}>{withOverdue}</div>
            </div>
            <div className="tm-stat">
              <div className="tm-stat-k"><span className="tm-kl">{partial ? s.kAllDoneDir : s.kAllDone}</span><span className="tm-ks">{partial ? s.kAllDoneDirS : s.kAllDoneS}</span></div>
              <div className={'tm-stat-v tnum' + (allDone > 0 ? ' is-good' : '')}>{allDone}</div>
            </div>
          </div>

          {/* The chips only appear once there IS a second layer — a line manager
              with three direct reports should see no extra machinery. */}
          {indirectN > 0 && (
            <div className="ml-filters" role="group" aria-label={s.fAll}>
              {[['all', s.fAll, rows.length], ['direct', s.fDirect, directN], ['indirect', s.fIndirect, indirectN]].map(([k, label, n]) => (
                <button key={k} className={'ml-chip' + (filter === k ? ' active' : '')}
                  aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {label}
                  <span className="ml-chip-n tnum">{n}</span>
                </button>
              ))}
            </div>
          )}

          <div className="tm-list">
            {shown.map((r) => {
              const off = !r.active;
              const has = trained(r);           // F2: skip-level rows carry no training fields
              const isOpen = open[r.userId] && !off && has;
              const rel = relOf(r);
              const items = has && Array.isArray(r.items) ? r.items : [];
              // One notch per level, capped so a deep line never pushes the name
              // off a phone. Applied to the avatar (the first flex child), which
              // shifts the whole row without fighting .tm-head's own padding.
              const indent = Math.min(depthOf(r) - 1, 4) * 14;
              // 手机端的一枚汇总胶囊,替掉桌面的「N 门课程 + N 门通过/逾期」。
              const sumCls = !has || r.assigned === 0 ? 'muted' : r.overdue > 0 ? 'fail' : r.done === r.assigned ? 'ok' : 'pri';
              const sum = !has ? s.inProfile
                : r.assigned === 0 ? s.noCourses
                  : r.overdue > 0 ? s.overdueN(r.overdue)
                    : r.done === r.assigned ? s.allPass : s.passFrac(r.done, r.assigned);
              const meta = [r.position, r.jobLevel].filter(Boolean).join(' · ');
              return (
                <div key={r.userId} className={'tm-row' + (off ? ' is-off' : '') + (!off && r.overdue > 0 ? ' is-overdue' : '')}>
                  <div className={'tm-head' + (isOpen ? ' is-open' : '')}>
                    <span className="tm-av" aria-hidden="true" style={indent ? { marginLeft: indent } : undefined}>
                      {(r.name || '').trim().slice(0, 1).toUpperCase()}
                    </span>
                    <div className="tm-who">
                      {/* The name is the door to the read-only profile (D3). */}
                      <Link className="tm-name" to={`/team/${r.userId}`} title={s.openProfile(r.name)}
                        style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
                        {r.name}
                      </Link>
                      <div className="tm-meta">
                        {meta}
                        {/* 9.1 (batch 3): the employee side never shows employee IDs —
                            position · job grade · reporting line only. */}
                        {/* Who this person actually reports to — the one fact an
                            indented row still cannot show on a narrow screen. */}
                        {rel === 'indirect' && r.managerName ? `${meta ? ' · ' : ''}${s.reportsTo} ${r.managerName}` : ''}
                      </div>
                    </div>
                    {rel === 'indirect' && <span className="pill muted tm-dsum">{s.indirect}</span>}
                    {off ? <span className="pill muted">{s.inactive}</span> : !has ? (
                      /* F2: no training numbers on this row — one honest
                         placeholder (visible on both widths, like the 已停用
                         pill) instead of「undefined 门课程」and empty pills.
                         The name above is still the link to the profile, which
                         is where the detail actually lives. */
                      <span className="pill muted">{s.inProfile}</span>
                    ) : (
                      <>
                        <span className="tm-count">{s.assignedN(r.assigned)}</span>
                        {r.done > 0 && <span className="pill ok tm-dsum">{s.doneN(r.done)}</span>}
                        {r.overdue > 0 && <span className="pill fail tm-dsum">{s.overdueN(r.overdue)}</span>}
                        {r.selfDone > 0 && <span className="pill muted tm-dsum">{s.selfDoneN(r.selfDone)}</span>}
                        <span className={'pill tm-msum ' + sumCls}>{sum}</span>
                        <button className="tm-more" aria-expanded={!!isOpen}
                          onClick={() => setOpen((o) => ({ ...o, [r.userId]: !o[r.userId] }))}>
                          {isOpen ? s.hide : s.detail}
                          <span className="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                        </button>
                      </>
                    )}
                  </div>
                  {isOpen && (items.length === 0 ? (
                    <div className="tm-none">{s.noCourses}</div>
                  ) : (
                    <div className="tm-detail">
                      {items.map((it) => {
                        const st = stateOf(it);
                        return (
                          <div key={it.id} className="tm-crow">
                            <span className="tm-ctitle">
                              {loc(it, 'title')}
                              {it.source === 'self' && <span className="pill pri tm-self">{s.selfTag}</span>}
                            </span>
                            <span className={'pill ' + stCls[st]}>{stLabel[st]}</span>
                            {/* 一格一个指标:通过看成绩,没通过看截止。 */}
                            <span className="tm-cmetric tnum">
                              {it.passed && it.bestPercent != null ? s.score(it.bestPercent)
                                : it.dueAt ? `${s.due} ${md(it.dueAt)}` : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {/* 手机端没有展开按钮,未完成的课常驻列出(桌面 display:none)。 */}
                  {!off && items.some((it) => !it.passed) && (
                    <div className="tm-mlist">
                      {items.filter((it) => !it.passed).map((it) => {
                        const st = stateOf(it);
                        return (
                          <div key={it.id} className="tm-mrow">
                            <span className="tm-mtitle">
                              {loc(it, 'title')}
                              {it.source === 'self' && <span className="pill pri tm-self">{s.selfTag}</span>}
                            </span>
                            <span className={'pill ' + stCls[st]}>{stLabel[st]}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
