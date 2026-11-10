import { modOn } from '../rbac.js';
import { useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useAsync, api } from '../api.js';
import { ProfileTabs } from '../profileTabs.js';
import ModuleTrail, { learnTrail } from '../components/ModuleTrail.jsx';
import { keyOf } from '../controlledTags.js';
import { date as fmtDate } from '../fmt.js';

/* 经理视角的下属档案 — STRICTLY READ-ONLY (RBAC-DESIGN.md D3 + D8).
   Reached from MyTeam by clicking a person in the reporting line; the whole
   payload comes from GET /api/me/reports/:userId, which is the only method that
   route answers. This file therefore contains NO form control of any kind: no
   <input>/<select>/<textarea>, no api.post/put/del import path, and the only
   <button>-shaped things are the two <Link>s that navigate back (plus, once
   two or more modules register profile tabs, the <ProfileTabs> switcher —
   role="tab" buttons that only change which tab is shown). If a manager
   needs a record changed, that goes through HR in the console — the whole point
   of D8 is visibility without a back-office door.
   Visuals reuse the employee-side ink-blue/gold classes already in app.css
   (ppl-tl timeline from Record.jsx, pcard grid, tm-list rows, pill). No Semi UI,
   no new palette. The only new CSS is `.rp-sub`, a byte-for-byte copy of
   `.ml-lead` — see the comment at that <p> for why the class had to differ —
   and `.rp-open-st` (batch 2, 2026-10-08): the status pill row of a cycle still
   in progress, which shows status only, never the rating (D8). */
const T = {
  zh: {
    trailReview: '绩效评估', trailTeamReviews: '团队评估', loadErr: '加载失败，请刷新页面重试。',
    denied: '无权查看，或该记录不存在',
    deniedHint: '该员工不在你的汇报线内，或档案已不存在。',
    readOnly: '只读视图 · 档案的任何修改都由 HR 在后台完成',
    relDirect: '直接下属', relIndirect: '间接下属', depthN: (n) => `第 ${n} 层`,
    chainLab: '汇报路径', me: '我',
    hired: '入职日期', tenure: '司龄', tenureFmt: (y, m) => (y ? `${y} 年 ${m} 个月` : `${m} 个月`),
    probation: '试用期', regular: '正式', exited: '已离职', inactive: '账号已停用',
    tagsLab: '人才标签', potLab: '潜力评级',
    potHigh: '高', potMedium: '中', potLow: '低',
    kPassed: '课程通过', kAwards: '荣誉', kPromos: '晋升', kViolations: '违纪',
    perfH: '历次绩效', perfEmpty: '暂无绩效记录',
    perfArchived: '已归档', perfOpen: '评估进行中', perfPending: '尚未评级',
    // 进行中的周期只显示状态、不显示评级（D8，第二批 2.1）
    stSelfDone: '自评已交', stSelfNone: '未交自评', stRated: '已评级',
    one_both: '面谈双方已登记', one_mgr: '面谈仅上级登记', one_emp: '面谈仅员工登记', one_none: '面谈未登记',
    ratingLab: '最终评级', noSummary: '（无评语）',
    trainH: '学习记录', trainEmpty: '暂无指派课程',
    due: '截止', bestLab: '最好成绩', modules: (a, b) => `模块 ${a}/${b}`,
    stPassed: '已通过', stOverdue: '已逾期', stProgress: '进行中', stNot: '未开始',
    optional: '选修',
    tlH: '成长轨迹', tlEmpty: '暂无记录',
    gProgress: '进度', gBest: '考试最好成绩', gRank: '同期排名', gPass: '通过', gFail: '未通过',
    secH: '虚线汇报与兼任岗位', kDotted: '虚线汇报', kConcurrent: '兼任',
    secTo: '汇报给',
    // 模块页签（web/src/profileTabs.js）：tablist 的无障碍名 / 占位 / 加载中 / 出错。
    tabsLabel: '模块页签', tabSoon: '该模块内容即将上线', tabLoading: '加载中…',
    tabFailed: '这个页签加载失败，请刷新页面重试',
  },
  en: {
    trailReview: 'Performance Reviews', trailTeamReviews: 'Team Reviews', loadErr: 'Couldn’t load. Refresh the page to try again.',
    denied: 'No access, or the record was not found',
    deniedHint: 'This employee is not in your reporting line, or the record no longer exists.',
    readOnly: 'Read-only view · any change to this record is made by HR in the console',
    relDirect: 'Direct report', relIndirect: 'Indirect report', depthN: (n) => `Level ${n}`,
    chainLab: 'Reporting path', me: 'Me',
    hired: 'Hire date', tenure: 'Tenure', tenureFmt: (y, m) => (y ? `${y} yr ${m} mo` : `${m} mo`),
    probation: 'Probation', regular: 'Regular', exited: 'Separated', inactive: 'Account deactivated',
    tagsLab: 'Talent tags', potLab: 'Potential rating',
    potHigh: 'High', potMedium: 'Medium', potLow: 'Low',
    kPassed: 'Courses passed', kAwards: 'Awards', kPromos: 'Promotions', kViolations: 'Disciplinary records',
    perfH: 'Performance History', perfEmpty: 'No performance records yet',
    perfArchived: 'Archived', perfOpen: 'In progress', perfPending: 'Not rated yet',
    stSelfDone: 'Self-review in', stSelfNone: 'No self-review yet', stRated: 'Rated',
    one_both: '1-on-1 logged by both', one_mgr: '1-on-1 logged by manager only', one_emp: '1-on-1 logged by employee only', one_none: '1-on-1 not logged',
    ratingLab: 'Final rating', noSummary: '(No comments)',
    trainH: 'Learning Record', trainEmpty: 'No courses assigned yet',
    due: 'Due', bestLab: 'Best score', modules: (a, b) => `Modules ${a}/${b}`,
    stPassed: 'Passed', stOverdue: 'Overdue', stProgress: 'In progress', stNot: 'Not started',
    optional: 'Elective',
    tlH: 'Growth Timeline', tlEmpty: 'Nothing recorded yet',
    gProgress: 'Progress', gBest: 'Best exam score', gRank: 'Cohort rank', gPass: 'Passed', gFail: 'Not passed',
    secH: 'Dotted-line Reporting and Concurrent Posts', kDotted: 'Dotted line', kConcurrent: 'Concurrent post',
    secTo: 'reports to',
    tabsLabel: 'Module tabs', tabSoon: 'Content for this module is coming soon', tabLoading: 'Loading…',
    tabFailed: 'This tab failed to load — refresh the page to try again',
  },
};

// Same three glyphs Record.jsx uses on the employee's own timeline, so the two
// screens read as one system.
function EvIcon({ kind }) {
  if (kind === 'hired')
    return (
      <svg className="ic grw-dot-ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20h16M7 20V4h10v16M11 20v-5h2v5" />
      </svg>
    );
  if (kind === 'lms')
    return (
      <svg className="ic grw-dot-ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 6v14M12 6H5v13h7M12 6h7v13h-7" />
      </svg>
    );
  return (
    <svg className="ic grw-dot-ic" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

export default function ReportProfile() {
  const { userId } = useParams();
  const { user: me } = useAuth();
  const { lang, loc } = useI18n();
  const s = T[lang] || T.en;
  const { loading, error, data } = useAsync(() => api.get(`/api/me/reports/${encodeURIComponent(userId || '')}`), [userId]);

  // This profile is cross-domain (identity + lifecycle + performance + learning)
  // and its route is NOT gated on the learning module — same call the server
  // made when it kept /api/me/reports out of MODULE_ROUTES. /team however IS
  // learning-gated, so with learning off the crumb points home instead of at a
  // route that no longer exists. Absence of the block = all modules on.
  // 页头模块路径按来源（IA 1.4 注 3）：从团队学习进入为「培训 › 团队学习 › 〈姓名〉」，从绩效评估的团队评估进入
  // （路由 state.from === 'review'）为「绩效评估 › 团队评估 › 〈姓名〉」；直接打开时 learning 开启按前者、否则 performance
  // 开启按后者，两者都关时只显示姓名。
  const { state: navState } = useLocation();
  const mods = (me && me.modules) || {};
  const teamOn = modOn(mods, 'learning');
  const reviewOn = modOn(mods, 'performance');
  const fromReview = reviewOn && ((navState && navState.from === 'review') || !teamOn);
  // 第二批 2.1：第二段回到团队评估；从单人评估页进来时 state.back 带着单人页的地址（含 &item= 与名单筛选），原样回去
  const reviewBack = navState && typeof navState.back === 'string' && navState.back.startsWith('/review?') ? navState.back : '/review?view=team';
  const head = fromReview ? [{ label: s.trailReview, to: '/review' }, { label: s.trailTeamReviews, to: reviewBack }]
    : teamOn ? learnTrail(lang, 'team') : [];
  const Back = () => <ModuleTrail items={[...head, { label: data && data.user ? data.user.name : '' }]} />;

  if (loading) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>…</div></div>;
  // 404 is the server's single answer for "not yours" AND "no such person"
  // (deliberately indistinguishable). Show one friendly bilingual page for it
  // rather than a blank frame; anything else is a plain load failure.
  if (error) {
    const gone = error.status === 404;
    return (
      <div className="wrap">
        <Back />
        <div className="ml-head">
          <h1 className="ml-title">{gone ? s.denied : s.loadErr}</h1>
        </div>
        <div className="ml-empty">{gone ? s.deniedHint : s.loadErr}</div>
      </div>
    );
  }
  const d = data || {};
  const u = d.user || {};
  // 12.2 / REQ 12.3：「流失风险」不对直属上级显示（服务端已不下发，这里再兜一层，任何写法都不显示）
  const shownTags = (u.talentTags || []).filter((t) => keyOf(t) !== 'flight');
  const chain = d.chain || [];
  const stats = d.stats || {};
  const perf = d.performance || [];
  const asg = d.assignments || [];
  const events = d.events || [];
  const secondary = d.secondaryLines || [];

  const tenure = (() => {
    if (!u.hireDate) return null;
    const h = new Date(u.hireDate + 'T00:00:00');
    if (Number.isNaN(h.getTime()) || h > new Date()) return null;
    const months = Math.floor((Date.now() - h.getTime()) / (30.44 * 86400000));
    return s.tenureFmt(Math.floor(months / 12), months % 12);
  })();
  const stLabel = u.empStatus ? s[u.empStatus] || u.empStatus : null;
  const potLabel = { High: s.potHigh, Medium: s.potMedium, Low: s.potLow }[u.potential] || u.potential;
  const meta = [u.position, u.jobLevel, u.department].filter(Boolean).join(' · ');
  const today = fmtDate(new Date());   // 本地日历日（toISOString 取的是 UTC 日，马尼拉 0–8 点会差一天）
  const stateOf = (a) => a.passed ? 'passed' : (a.dueAt && a.dueAt < today ? 'overdue' : (a.progress > 0 ? 'progress' : 'not'));
  const stLab = { passed: s.stPassed, overdue: s.stOverdue, progress: s.stProgress, not: s.stNot };
  const stCls = { passed: 'ok', overdue: 'fail', progress: 'pri', not: 'muted' };

  return (
    // `rp-wrap` marks the LOADED success branch only (the loading and the
    // denied/404 branches above return a bare `.wrap`). scripts/smoke-routes.js
    // keys #/team/:reportId on it — the other classes on this page are all
    // shared with Record.jsx, and a shared selector is how a stale-DOM false
    // pass happens. Don't put it on the guard branches.
    <div className="wrap rp-wrap">
      <Back />

      <div className="ml-head">
        <h1 className="ml-title">{u.name}</h1>
        {/* .rp-sub, not .ml-lead: this line is DATA (position / level /
            department, English in this dataset), and .ml-lead is
            a chrome class the smoke language check scans for untranslated
            Latin text. Same styling, no false warning.
            9.1 (batch 3): the employee side never shows employee IDs. */}
        <p className="rp-sub">{meta}</p>
      </div>

      {/* The read-only promise, stated in the interface as well as enforced by
          the route: there is nothing on this page to click that writes. */}
      <div className="ml-empty rp-readonly" style={{ marginBottom: 18, textAlign: 'left' }}>{s.readOnly}</div>

      <div className="card grw-card">
        <div className="grw-meta">
          <div className="grw-ident">
            <span className={'pill ' + (u.relation === 'direct' ? 'pri' : 'muted')}>
              {u.relation === 'direct' ? s.relDirect : s.relIndirect}
            </span>
            {u.depth > 1 && <span className="pill muted">{s.depthN(u.depth)}</span>}
            {u.jobLevel && <span className="pill pri">{u.jobLevel}</span>}
            {stLabel && <span className={'pill ' + (u.empStatus === 'regular' ? 'ok' : u.empStatus === 'exited' ? 'muted' : 'warn')}>{stLabel}</span>}
            {u.active === false && <span className="pill muted">{s.inactive}</span>}
            {u.hireDate && <span>{s.hired} <b className="tnum">{u.hireDate}</b></span>}
            {tenure && <span>{s.tenure} <b>{tenure}</b></span>}
          </div>
          <div className="grw-stats">
            <span className="pill muted">{s.kPassed} <b className="tnum">{stats.trainingsPassed || 0}</b></span>
            <span className="pill warn">{s.kAwards} <b className="tnum">{stats.awards || 0}</b></span>
            <span className="pill ok">{s.kPromos} <b className="tnum">{stats.promotions || 0}</b></span>
            {stats.violations > 0 && <span className="pill fail">{s.kViolations} <b className="tnum">{stats.violations}</b></span>}
          </div>
        </div>
        {/* Skip-level: spell out who sits between us, otherwise "level 3" is a
            number with no meaning. A direct report has an empty chain. */}
        {(chain.length > 0 || u.managerName) && (
          <div className="ppl-ev-body" style={{ marginTop: 10 }}>
            <span className="ppl-kv">
              <span className="k">{s.chainLab}</span>
              <b>{[s.me, ...chain.map((c) => c.name), u.name].join(' → ')}</b>
            </span>
          </div>
        )}
        {shownTags.length > 0 || potLabel ? (
          <div className="ppl-ev-body" style={{ marginTop: 8 }}>
            {shownTags.length > 0 && (
              <span className="ppl-kv">
                <span className="k">{s.tagsLab}</span>
                {shownTags.map((t) => <span key={t} className="pill pri">{t}</span>)}
              </span>
            )}
            {potLabel && <span className="ppl-kv"><span className="k">{s.potLab}</span><b>{potLabel}</b></span>}
          </div>
        ) : null}
      </div>

      {/* 绩效史 (D3): the whole history, archived cycles and open ones alike —
          not only the reviews this manager happens to have written. */}
      <div className="sec">
        <div className="sec-h"><h2>{s.perfH}</h2><span className="count">{perf.length}</span></div>
        {perf.length === 0 ? <div className="ml-empty">{s.perfEmpty}</div> : (
          <div className="tm-list">
            {perf.map((p, i) => {
              // 进行中的 v2 周期（source 'open'，flow 'v2' 或带 status）只显示状态，不显示评级与评语（D8）：status = { self, one, rated }
              // （W2-A 服务端契约）；评级值即使下发了也不显示。旧流程进行中的周期照原样（服务端仍给上级评级与评语）
              if (p.source === 'open' && (p.flow === 'v2' || (p.status && typeof p.status === 'object'))) {
                const st = p.status && typeof p.status === 'object' ? p.status : null;
                const selfIn = st ? !!(st.self === true || st.selfAt) : null;
                const one = st ? (['both', 'mgr', 'emp', 'none'].includes(st.oneState) ? st.oneState : ['both', 'mgr', 'emp', 'none'].includes(st.one) ? st.one : null) : null;
                const rated = st && typeof st.rated === 'boolean' ? st.rated : !p.pending;
                return (
                  <div key={i} className="tm-row">
                    <div className="tm-head">
                      <div className="tm-who">
                        <div className="tm-name">{p.cycle || '—'}</div>
                      </div>
                      <span className="pill pri">{s.perfOpen}</span>
                    </div>
                    <div className="rp-open-st">
                      {selfIn !== null && <span className={'pill ' + (selfIn ? 'ok' : 'muted')}>{selfIn ? s.stSelfDone : s.stSelfNone}</span>}
                      {one && <span className={'pill ' + (one === 'both' ? 'ok' : one === 'none' ? 'muted' : 'warn')}>{s['one_' + one]}</span>}
                      <span className={'pill ' + (rated ? 'ok' : 'muted')}>{rated ? s.stRated : s.perfPending}</span>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="tm-row">
                  <div className="tm-head">
                    <div className="tm-who">
                      <div className="tm-name">{p.cycle || '—'}</div>
                      <div className="tm-meta">
                        <span className="tnum">{p.date || '—'}</span>
                        {' · '}
                        {p.source === 'archived' ? s.perfArchived : s.perfOpen}
                      </div>
                    </div>
                    {p.rating
                      ? <span className="pill ok">{s.ratingLab} {loc(p, 'rating')}</span>
                      : <span className="pill muted">{s.perfPending}</span>}
                  </div>
                  <div style={{ padding: '0 18px 14px', fontSize: 13, lineHeight: 1.65, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>
                    {p.summary ? p.summary : <span style={{ color: 'var(--ink-3)' }}>{s.noSummary}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 培训记录 — the same numbers MyTeam shows in the row, with the module
          split and best score the list has no room for. */}
      <div className="sec">
        <div className="sec-h"><h2>{s.trainH}</h2><span className="count">{asg.length}</span></div>
        {asg.length === 0 ? <div className="ml-empty">{s.trainEmpty}</div> : (
          <div className="grid">
            {asg.map((a) => {
              const st = stateOf(a);
              return (
                <div key={a.programId} className="pcard catalog">
                  <div className="tpe-ring tnum">{a.progress}<span>%</span></div>
                  <div className="cinfo">
                    <h3>{loc(a, 'title')}</h3>
                    <div className="sub">
                      <span className={'pill ' + stCls[st]}>{stLab[st]}</span>
                      {a.enrollType === 'elective' && <span className="pill muted">{s.optional}</span>}
                      <span>{s.modules(a.moduleDone, a.moduleTotal)}</span>
                      {a.dueAt && <span className="tnum">{s.due} {a.dueAt}</span>}
                      {a.bestPercent != null && <span className="tnum">{s.bestLab} {a.bestPercent}%</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 入转调离 + 培训的合流时间线. The server pre-rendered every label/value
          pair bilingually, so there is no field config here to edit against. */}
      <div className="sec">
        <div className="sec-h"><h2>{s.tlH}</h2><span className="count">{events.length}</span></div>
        {events.length === 0 ? <div className="ml-empty">{s.tlEmpty}</div> : (
          <div className="ppl-tl">
            {events.map((e, i) => (
              <div className="ppl-ev" key={i}>
                <span className="ppl-dot" style={{ borderColor: e.color || 'var(--brand)', color: e.color || 'var(--brand)' }}>
                  <EvIcon kind={e.kind} />
                </span>
                <div className="ppl-ev-card">
                  <div className="ppl-ev-head">
                    <span className="ppl-ev-date tnum">{e.date}</span>
                    {e.typeLabel && <span className="ppl-ev-pill" style={{ background: e.color || 'var(--brand)' }}>{loc(e, 'typeLabel')}</span>}
                    <span className="ppl-ev-title">{loc(e, 'title') || loc(e, 'typeLabel')}</span>
                  </div>
                  {e.kind === 'lms' && e.lms && (
                    <div className="ppl-ev-body">
                      <span className="ppl-kv"><span className="k">{s.gProgress}</span><b className="tnum">{e.lms.progress}%</b></span>
                      {e.lms.best && <span className="ppl-kv"><span className="k">{s.gBest}</span><b className="tnum">{e.lms.best.percent}%</b> <span className={'pill ' + (e.lms.best.passed ? 'ok' : 'fail')}>{e.lms.best.passed ? s.gPass : s.gFail}</span></span>}
                      {e.lms.rank && <span className="ppl-kv"><span className="k">{s.gRank}</span><b className="tnum">{e.lms.rank}/{e.lms.cohort}</b></span>}
                    </div>
                  )}
                  {e.kind === 'record' && (e.lines || []).length > 0 && (
                    <div className="ppl-ev-body">
                      {e.lines.map((l, j) => <span className="ppl-kv" key={j}><span className="k">{loc(l, 'label')}</span><b>{loc(l, 'value')}</b></span>)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Matrix lines this person sits on. Names and scope only — the server
          strips ids and HR's private note before it ever leaves. */}
      {secondary.length > 0 && (
        <div className="sec">
          <div className="sec-h"><h2>{s.secH}</h2><span className="count">{secondary.length}</span></div>
          <div className="tm-list">
            {secondary.map((r, i) => (
              <div key={i} className="tm-row">
                <div className="tm-head">
                  <div className="tm-who">
                    <div className="tm-name">{r.position || r.department || '—'}</div>
                    <div className="tm-meta">
                      {r.managerName ? `${s.secTo} ${r.managerName}` : ''}
                      {r.department && r.position ? `${r.managerName ? ' · ' : ''}${r.department}` : ''}
                    </div>
                  </div>
                  <span className="pill muted">{r.kind === 'dotted' ? s.kDotted : s.kConcurrent}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Module tabs (manifest extensions["profile.tabs"], audience "line").
          Still read-only here: a tab component only reads its own module's
          data. No module registers one yet: tabs is [] and this renders nothing. */}
      <ProfileTabs tabs={d.tabs} userId={u.id || userId} audience="line" lang={lang}
        s={{ label: s.tabsLabel, soon: s.tabSoon, loading: s.tabLoading, failed: s.tabFailed }} cls={TAB_CLS} />
    </div>
  );
}

// Module-tab section styling: the page's own section heading + filter chips.
const TAB_CLS = { wrap: 'sec', head: 'sec-h', bar: 'ml-filters', tab: 'ml-chip', on: 'active', empty: 'ml-empty' };
