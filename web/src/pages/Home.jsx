import Overlay from '../components/Overlay.jsx';
import { modOn } from '../rbac.js';
import { useMedia } from '../useMedia.js';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { useAsync, api, daysUntil } from '../api.js';
import { fetchMyProjects } from '../tprojects.js';
import ProgressRing from '../components/ProgressRing.jsx';
import { cultureOn, fetchCultureEntry, cultureEntryKind, cultureEntryHref } from '../modules/culture/entry.js';
import { learnStatusOf, examAction, retakeInfo, retakeHref, sortForLearner, pickTop, stampOf } from '../learnstatus.js';
import { categoryLabel } from '../categories.js';
import { fetchCatalogCount } from '../learningnav.js';

// Home is the employee's TALENT home, not a course list. It opens with where
// they sit in the org (position, grade, tenure, reporting lines) and what is
// waiting for them, then their growth milestones; training is one section
// further down rather than the identity of the page.
// (Employee app is Semi-free — plain elements + shared CSS only.)
const T = {
  zh: {
    loadErr: '加载失败，请刷新页面重试。', empty: '暂无课程',
    continueTitle: '继续学习',
    elective: '选修', mandatory: '必修',
    study: '开始学习', resume: '继续学习', review: '复习', apply: '申请学习', reapply: '重新申请',
    pending: '待审批', mandatoryWait: '必修 · 待 HR 安排', passed: '已通过',
    // 5.4 / 10.8：首页课程卡与「课程」页同一套状态与下一步
    stOverdue: (d) => `逾期 ${d} 天`, stReady: '待考试', stRetake: '待补考', stFailed: '未通过', stPending: '成绩待定',
    toExam: '前往考试', retake: '去补考', details: '查看详情',
    leftN: (n) => `剩余 ${n} 次考试机会`, leftUnlimited: '考试次数不限', retakeFrom: (at) => `${at} 起可补考`, usedUp: '考试次数已用完，请联系 HR',
    // Home says 「成绩 92 分」; the shared t('score') is a percentage.
    scoreFmt: (s) => `成绩 ${s}%`,
    rejectedNote: (n) => `上次申请被驳回：${n}`,
    applyTitle: (p) => `申请学习「${p}」`,
    applyReasonPh: '申请说明（选填，供审批参考）',
    applySubmit: '提交申请', cancel: '取消',
    applyOk: '申请已提交，等待 HR 审批', applyFail: '提交失败，请重试',
    continueBtn: '继续', mods: '模块', min: '分钟', about: '约',
    offlineTag: '线下', offlineTbd: '时间待定', view: '查看',
    // Fallback labels so a missing activity title never leaks a raw type key.
    // Keyed by the activity category the server sends (nextActivity.category).
    actType: { online_course: '线上课程', offline_course: '线下课程', online_activity: '线上活动', offline_activity: '线下活动', exam: '结业考试', program: '线上课程' }, actFallback: '下一项内容',
    projTag: '发展项目', projNextIs: '下一步', projEnter: '进入发展项目',
    viewAll: '查看全部', phaseOf: (d, t) => `阶段 ${d}/${t}`, viaProject: '属于发展项目',
    todoGoSelf: '去提交自评', todoGoTeam: '去团队评估',
    // ---- talent home ----
    meOpen: '查看成长档案', meMgr: '直属上级', meDotted: '虚线上级', meConc: '兼任岗位',
    meHired: '入职日期', meTenure: '司龄', meNoLevel: '未设职级',
    // Phone card uses the short labels the design writes on the 390 variant.
    meOpenShort: '成长档案', meMgrShort: '直属上级', meDottedShort: '虚线上级', stRecordsShort: '记录',
    meTenureFmt: (y, m) => (y ? `${y} 年 ${m} 个月` : `${m} 个月`),
    probation: '试用期', regular: '正式', exited: '已离职',
    stRecords: '成长记录', stAwards: '荣誉', stPromos: '晋升',
    mileTitle: '最近成长记录', mileEmpty: '暂无成长记录。完成培训、获得荣誉或晋升后将在此显示。',
    learnTitle: '我的课程', electTitle: '可申请的选修课程',
    browseCatalog: '浏览公开课 ›', // 第四批 7：有公开课程时「课程」区块标题旁的入口
    browseCat: (n) => `展开其余 ${n} 门课程`, browseClose: '收起',
    // ---- 行为实践（culture）入口卡 ----
    culFrozen: '计分已截止',
    culLearnerTitle: 'Action 3+3 挑战', culManageTitle: 'Action 3+3 挑战 · 管理',
    culStart: (d) => `开始日期 ${d}`,
    culLearnerLead: '完成本周的微学习与行为实践记录；个人进度、积分与部门排名在 Action 3+3 挑战中查看。',
    culLearnerUpcoming: (d, from) => (from && from === d
      ? `Action 3+3 挑战于 ${d} 开始；前测在挑战第一天同时开放，请在第 1 周内完成。`
      : `Action 3+3 挑战于 ${d} 开始；${from ? `${from} 起` : '开始前'}开放前测。`),
    culLearnerPretest: (to) => `前测已开放，请于${to ? ` ${to}（含当日）` : '挑战开始'}前完成；挑战开始后，每周的微学习与行为实践记录在 Action 3+3 挑战中完成。`,
    culLearnerPreOpen: (to) => `前测开放到 ${to}（含当日），请在此之前完成；不做前测也不影响每天的学习。本周的微学习与行为实践记录在 Action 3+3 挑战中完成。`,
    culLearnerFrozen: '本期计分已截止，积分已固定；后测与保持度测评在开放期内仍可参加。',
    culManageLead: '你不在本期参与名单中。进入后可进行期次管理、参与名单、认可卡审核、行为实践记录抽查、例会汇总与数据导出，可用功能以你的授权为准。',
    culLearnerGo: '进入 Action 3+3 挑战', culManageGo: '进入 Action 3+3 挑战',
    culHostTitle: 'Action 3+3 挑战 · 例会主持', culHostLead: '登记每周例会并查看评分。',
    culPendingRatings: (n) => `有 ${n} 场例会待评分。`,
    culConfirmHostsBy: (d) => `请在 ${d} 前确认团队主持人。`,
    culConfirmHosts: '团队主持人还没有确认：确认之前，本部门所有成员都归 HoD 例会。',
  },
  en: {
    loadErr: 'Couldn’t load. Refresh the page to try again.', empty: 'No courses yet.',
    continueTitle: 'Continue learning',
    elective: 'Elective', mandatory: 'Required',
    study: 'Start', resume: 'Resume', review: 'Review', apply: 'Apply', reapply: 'Apply again',
    pending: 'Pending approval', mandatoryWait: 'Required · HR will assign', passed: 'Passed',
    stOverdue: (d) => `${d} day${d === 1 ? '' : 's'} overdue`, stReady: 'Ready for exam', stRetake: 'Retake pending', stFailed: 'Not passed', stPending: 'Result pending',
    toExam: 'Go to exam', retake: 'Retake exam', details: 'View details',
    leftN: (n) => (n === 1 ? '1 attempt left' : `${n} attempts left`), leftUnlimited: 'Unlimited attempts', retakeFrom: (at) => `You can retake from ${at}`, usedUp: 'No attempts left — please contact HR',
    scoreFmt: (s) => `Score ${s}%`,
    rejectedNote: (n) => `Last request rejected: ${n}`,
    applyTitle: (p) => `Apply for "${p}"`,
    applyReasonPh: 'Reason for applying (optional, shared with the approver)',
    applySubmit: 'Submit request', cancel: 'Cancel',
    applyOk: 'Request submitted — awaiting HR approval', applyFail: 'Submit failed, please try again',
    continueBtn: 'Continue', mods: 'modules', min: 'min', about: '~',
    offlineTag: 'In-person', offlineTbd: 'Time TBD', view: 'View',
    actType: { online_course: 'Online course', offline_course: 'In-person course', online_activity: 'Online activity', offline_activity: 'In-person activity', exam: 'Final exam', program: 'Online course' }, actFallback: 'Next item',
    projTag: 'Development Program', projNextIs: 'Next', projEnter: 'Open program',
    viewAll: 'View all', phaseOf: (d, t) => `Phase ${d}/${t}`, viaProject: 'Part of a development program',
    todoGoSelf: 'Submit self-review', todoGoTeam: 'Open team reviews',
    // ---- talent home ----
    meOpen: 'Open Development Record', meMgr: 'Manager', meDotted: 'Dotted-line manager', meConc: 'Concurrent post',
    meHired: 'Hire date', meTenure: 'Tenure', meNoLevel: 'Job level not set',
    meOpenShort: 'Development Record', meMgrShort: 'Manager', meDottedShort: 'Dotted-line', stRecordsShort: 'Records',
    meTenureFmt: (y, m) => (y ? `${y} yr ${m} mo` : `${m} mo`),
    probation: 'Probation', regular: 'Regular', exited: 'Separated',
    stRecords: 'Records', stAwards: 'Awards', stPromos: 'Promotions',
    mileTitle: 'Recent Records', mileEmpty: 'No records yet. Training completions, awards and promotions will appear here.',
    learnTitle: 'My Courses', electTitle: 'Electives Open for Application',
    browseCatalog: 'Browse public courses ›',
    browseCat: (n) => `Show ${n} more courses`, browseClose: 'Show less',
    // ---- Behavior Practice (culture) entry card ----
    culFrozen: 'Scoring closed',
    culLearnerTitle: 'Action 3+3 Challenge', culManageTitle: 'Action 3+3 Challenge · Management',
    culStart: (d) => `Start date ${d}`,
    culLearnerLead: 'Complete this week’s micro-learning and practice record. Your progress, points and the department ranking are in the Action 3+3 Challenge.',
    culLearnerUpcoming: (d, from) => (from && from === d
      ? `The Action 3+3 Challenge starts on ${d}. The pre-test opens on the first day too; complete it during week 1.`
      : `The Action 3+3 Challenge starts on ${d}. The pre-test opens ${from ? `on ${from}` : 'before the start'}.`),
    culLearnerPretest: (to) => `The pre-test is open${to ? ` until ${to} (inclusive)` : ' until the challenge starts'}. Once the challenge starts, the weekly micro-learning and practice records are in the Action 3+3 Challenge.`,
    culLearnerPreOpen: (to) => `The pre-test is open until ${to} (inclusive); complete it by then. Daily learning is not held back if you have not done it. This week's micro-learning and practice records are in the Action 3+3 Challenge.`,
    culLearnerFrozen: 'Scoring for this cohort has closed and points are final. The post-test and retention test stay open during their windows.',
    culManageLead: 'You are not on this cohort’s participant list. From here you can manage cohorts, participants, recognition card review, practice-record spot checks, meeting summaries and exports, as far as your access allows.',
    culLearnerGo: 'Open the Action 3+3 Challenge', culManageGo: 'Open the Action 3+3 Challenge',
    culHostTitle: 'Action 3+3 Challenge · Meeting Host', culHostLead: 'Log weekly meetings and see ratings.',
    culPendingRatings: (n) => (n === 1 ? '1 meeting is waiting for your rating.' : `${n} meetings are waiting for your rating.`),
    culConfirmHostsBy: (d) => `Please confirm the team hosts by ${d}.`,
    culConfirmHosts: 'Team hosts are not confirmed yet: until then, everyone in the department belongs to the HoD meeting.',
  },
};

// The phone variant of the profile card drops content (the hub suffix, the
// employee id, concurrent posts, the milestone list) rather than re-flowing it,
// so the breakpoint is read in JS — same idiom as the admin pages. 560px is the
// width app.css already treats as this card's narrow form.
const NARROW_Q = '(max-width:560px)';
const useNarrow = () => useMedia(NARROW_Q);

/* ---- my place in the org + my milestones ----
   Reuses /api/me/growth: the server already pre-renders exactly what an employee
   is allowed to see (hidden record types, the field config, potential ratings
   and talent tags never leave the admin side). */
// Layout v2：这个组件同时负责首页的三栏骨架（v2.css .v2-home-shell）——顶部横跨的资料条（me-card.v2-profile-strip）、
// 左侧主内容（children：入口卡、待办、继续学习、课程区）、右侧档案栏（成长记录统计 + 最近记录）。档案数据没到时只渲染主内容。
function MyTalentCard({ tt, nav, loc, children }) {
  const q = useAsync(() => api.get('/api/me/growth'), []);
  const narrow = useNarrow();
  const d = q.data;
  if (!d) return <div className="v2-home-shell"><div className="v2-home-content">{children}</div></div>;
  const me = d.me || {};
  const dotted = me.dottedManagers || [];
  // Phone: 「Care Specialist · Customer Care」 — the site/hub suffix goes.
  const dept = narrow && me.department ? me.department.split(' - ')[0] : me.department;
  const tenure = (() => {
    if (!me.hireDate) return null;
    const h = new Date(me.hireDate + 'T00:00:00');
    if (Number.isNaN(h.getTime()) || h > new Date()) return null;
    const months = Math.floor((Date.now() - h.getTime()) / (30.44 * 86400000));
    return tt.meTenureFmt(Math.floor(months / 12), months % 12);
  })();
  const stLabel = me.empStatus ? tt[me.empStatus] : null;
  const stClass = me.empStatus === 'regular' ? 'ok' : me.empStatus === 'exited' ? 'muted' : 'warn';
  // The hire anchor is always present; milestones are what came after it.
  const milestones = (d.events || []).filter((e) => e.kind !== 'hired').slice(0, 3);

  return (
    <div className="v2-home-shell">
    <div className="me-card v2-profile-strip">
      <div className="me-top">
        <span className="me-ava">{(me.name || '?').trim()[0] || '?'}</span>
        <div className="me-ident">
          <div className="me-name">
            {me.name}
            {me.jobLevel ? <span className="pill pri">{me.jobLevel}</span> : <span className="pill muted">{tt.meNoLevel}</span>}
            {stLabel && <span className={'pill ' + stClass}>{stLabel}</span>}
          </div>
          <div className="me-sub">
            {me.position && <b>{me.position}</b>}
            {dept && <span>{dept}</span>}
            {/* 9.1（负责人 10/8）：员工端不显示工号，包括本人资料条 */}
          </div>
        </div>
      </div>

      <div className="me-facts">
        {narrow ? (
          (me.managerName || dotted[0]) && (
            <span>
              {me.managerName && <><i>{tt.meMgrShort}</i> <b>{me.managerName}</b></>}
              {dotted[0] && <>{me.managerName ? ' · ' : ''}<i>{tt.meDottedShort}</i> <b>{dotted[0].name}</b></>}
            </span>
          )
        ) : (
          <>
            {me.managerName && <span><i>{tt.meMgr}</i> <b>{me.managerName}</b></span>}
            {dotted.map((x, i) => (
              <span key={'d' + i} className="me-dotted"><i>{tt.meDotted}</i> <b>{x.name}</b>{x.scope ? ` · ${x.scope}` : ''}</span>
            ))}
            {(me.concurrentPosts || []).map((x, i) => (
              <span key={'c' + i} className="me-conc"><i>{tt.meConc}</i> <b>{x.position}</b>{x.department ? ` · ${x.department}` : ''}</span>
            ))}
          </>
        )}
        {me.hireDate && <span><i>{tt.meHired}</i> <b className="tnum">{me.hireDate}</b></span>}
        {tenure && <span><i>{tt.meTenure}</i> <b>{tenure}</b></span>}
      </div>
      {/* 资料条右侧的操作（v2-profile-strip 的 action 格，须是直接子元素） */}
      <button className="btn sm ghost me-open" onClick={() => nav('/record')}>{narrow ? tt.meOpenShort : tt.meOpen} →</button>
    </div>

    <div className="v2-home-content">{children}</div>

    <aside className="v2-home-rail">
      <div className="me-stats">
        <span className="pill muted">{narrow ? tt.stRecordsShort : tt.stRecords} <b className="tnum">{d.stats.records}</b></span>
        <span className="pill warn">{tt.stAwards} <b className="tnum">{d.stats.awards}</b></span>
        <span className="pill ok">{tt.stPromos} <b className="tnum">{d.stats.promotions}</b></span>
      </div>

      {/* The phone card stops at the stats — the milestone list lives on /record. */}
      {!narrow && (
        <div className="me-miles">
          <div className="me-miles-h">{tt.mileTitle}</div>
          {milestones.length === 0 ? (
            <div className="me-miles-empty">{tt.mileEmpty}</div>
          ) : milestones.map((e, i) => (
            <button className="me-mile" key={i} onClick={() => nav('/record')}>
              {/* Plain colour-coded timeline marker: the row already carries the
                  type label and the title, so the dot needs no glyph of its own
                  (and the server's own icon field is free-text emoji). */}
              <span className="me-mile-dot" style={{ background: e.color || 'var(--brand)' }} aria-hidden="true" />
              <span className="me-mile-date tnum">{e.date}</span>
              {e.typeLabel && <span className="me-mile-type">{loc(e, 'typeLabel')}</span>}
              {/* 自动生成的记录不再把类型名冻进库（服务端 deriveRecordTitle 返回空串），
                  所以标题为空时用类型名顶上 —— 它跟着界面语言走。 */}
              <span className="me-mile-title">{loc(e, 'title') || loc(e, 'typeLabel')}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
    </div>
  );
}

export default function Home() {
  const { t, loc, lang } = useI18n();
  const { user } = useAuth();
  const nav = useNavigate();
  const tt = T[lang] || T.en;

  // Sellable-module switches from the /api/me payload; a payload without the
  // block means all on (an old server must not blank the home page).
  const mods = (user && user.modules) || {};
  const on = (m) => modOn(mods, m);
  const learningOn = on('learning');

  // /api/catalog and /api/me/tprojects are learning routes — 404 once the
  // module is off — and the catalog query gates this WHOLE page (the error
  // branch below replaces everything, profile card included). So with
  // learning off the fetchers resolve empty instead of touching the network,
  // and the loading/error gates step aside.
  const { loading, error, data, reload } = useAsync(() => (learningOn ? api.get('/api/catalog') : Promise.resolve([])), []);
  const projQ = useAsync(() => (learningOn ? fetchMyProjects() : Promise.resolve(null)), []);
  const myProjects = (projQ.data && projQ.data.mine) || [];
  // 第四批 7：课程目录里有公开课程时，「课程」区块标题旁给出入口（与顶栏「培训▾」同一份 30 秒缓存）
  const catQ = useAsync(() => (learningOn ? fetchCatalogCount() : Promise.resolve(0)), []);
  const hasCatalog = (Number(catQ.data) || 0) > 0;
  const [browse, setBrowse] = useState(false);
  const [browseElect, setBrowseElect] = useState(false);
  const [applyFor, setApplyFor] = useState(null);
  const [applyNote, setApplyNote] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState(null);

  if (learningOn && loading) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>…</div></div>;
  if (learningOn && error) return <div className="wrap"><div className="greet" style={{ color: 'var(--muted)' }}>{tt.loadErr}</div></div>;

  const items = (Array.isArray(data) ? data : []).map((p) => ({ ...p, du: daysUntil(p.dueAt) }));
  // 完成口径以服务端 done 为准（无结业考试 = 学完即完成）；旧服务端没有 done → 看考试是否通过
  const isDone = (p) => (p.done != null ? !!p.done : !!(p.best && p.best.passed));

  // Continue-learning hero: most urgent enrolled-but-unfinished ONLINE course
  // (offline sessions have no self-paced progress to continue).
  const active = items
    .filter((p) => p.mode !== 'offline')
    .filter((p) => p.status === 'assigned' && !isDone(p) && (p.progress || 0) < 100)
    .sort((a, b) => {
      const ao = a.du != null && a.du < 0, bo = b.du != null && b.du < 0;
      if (ao !== bo) return ao ? -1 : 1;
      if (a.du != null && b.du != null) return a.du - b.du;
      if (a.du != null) return -1;
      if (b.du != null) return 1;
      return (b.progress || 0) - (a.progress || 0);
    });
  const hero = active[0] || null;

  // 首页两个区块（IA 1.5、D-09）：「课程」只列指派给本人的课程，与「查看全部」打开的课程页一致；
  // 10.7（负责人 10/8）顺序与课程页同一口径：逾期 → 待考试 / 待补考 → 进行中 → 未开始 → 线下 → 已完成，
  // 待考试 / 待补考的课程不会被挤出前 4 门（learnstatus.js pickTop）。「可申请的选修课程」列开放申请的
  // 选修课程（含审批中、被驳回可重新申请的），没有时不显示。未指派给本人的必修课程不在首页出现。搜索与分类在 /learning。
  const byDue = (a, b) => (a.du == null ? (b.du == null ? 0 : 1) : b.du == null ? -1 : a.du - b.du);
  const learn = sortForLearner(items.filter((p) => p.status === 'assigned'));
  const { top, rest } = pickTop(learn, 4);
  const electRank = (p) => (p.status === 'pending' ? 0 : p.status === 'rejected' ? 1 : 2);
  // 第四批 7：公开课程不用申请，在「课程目录」里直接开始学习，不再列进「可申请的选修课程」
  const elect = items.filter((p) => p.status !== 'assigned' && p.enrollType === 'elective' && p.public !== true).sort((a, b) => electRank(a) - electRank(b) || byDue(a, b));
  const electTop = elect.slice(0, 4);
  const electRest = elect.slice(4);

  const openApply = (p) => { setApplyFor(p); setApplyNote(''); setApplyErr(null); };
  const submitApply = async () => {
    if (!applyFor) return;
    setApplying(true); setApplyErr(null);
    try {
      await api.post('/api/me/enroll-requests', { programId: applyFor.id, note: applyNote });
      setApplyFor(null);
      reload();
    } catch (e) {
      setApplyErr(e && e.message ? e.message : tt.applyFail);
    } finally {
      setApplying(false);
    }
  };

  const action = (p) => {
    if (p.status === 'assigned') {
      const passed = isDone(p);
      const offline = p.mode === 'offline';
      const st = learnStatusOf(p);
      const act = examAction(p, st);
      // 10.8：可补考 →「去补考」直达考前说明；等待期 / 次数用完 →「查看详情」
      if (act === 'retake') {
        const r = retakeInfo(p);
        if (r.waiting || r.usedUp) return <button className="btn sm ghost" onClick={() => nav(`/program/${p.id}`)}>{tt.details}</button>;
        return <button className="btn sm" onClick={() => nav(retakeHref(p))}>{tt.retake}</button>;
      }
      if (act === 'first') return <button className="btn sm" onClick={() => nav(`/program/${p.id}`)}>{tt.toExam}</button>;
      if (st === 'failed') return <button className="btn sm ghost" onClick={() => nav(`/program/${p.id}`)}>{tt.details}</button>;
      const label = offline ? tt.view : passed ? tt.review : (p.progress || 0) > 0 ? tt.resume : tt.study;
      const ghost = offline || passed || (p.progress || 0) > 0;
      return <button className={'btn sm' + (ghost ? ' ghost' : '')} onClick={() => nav(`/program/${p.id}`)}>{label}</button>;
    }
    if (p.status === 'pending') return <span className="btn sm ghost home-disabled">{tt.pending}</span>;
    if (p.status === 'rejected') return <button className="btn sm" onClick={() => openApply(p)}>{tt.reapply}</button>;
    if (p.enrollType === 'elective') return <button className="btn sm" onClick={() => openApply(p)}>{tt.apply}</button>;
    return <span className="pill muted">{tt.mandatoryWait}</span>;
  };

  // 指派给本人的课程：需要员工处理的状态才出标签（逾期 / 待考试 / 待补考 / 成绩待定 / 未通过）
  const stPill = (p) => {
    if (p.status !== 'assigned') return null;
    const st = learnStatusOf(p);
    if (st === 'overdue') return <span className="pill warn">{tt.stOverdue(Math.max(1, -(p.du || 0)))}</span>;
    if (st === 'ready') return <span className="pill pri">{tt.stReady}</span>;
    if (st === 'retake') return <span className="pill fail">{tt.stRetake}</span>;
    if (st === 'failed') return <span className="pill fail">{tt.stFailed}</span>;
    if (st === 'pending') return <span className="pill pri">{tt.stPending}</span>;
    return null;
  };
  // 考试未通过：剩余次数与可补考时间（10.8）
  const retakeNote = (p) => {
    if (p.status !== 'assigned' || !(p.best && !p.best.passed) || isDone(p) || p.resultPending) return null;
    const r = retakeInfo(p);
    if (r.usedUp) return tt.usedUp;
    if (!examAction(p)) return null;
    const parts = [r.attemptsLeft == null ? tt.leftUnlimited : tt.leftN(r.attemptsLeft)];
    if (r.waiting) parts.push(tt.retakeFrom(stampOf(r.availableAt)));
    return parts.join(' · ');
  };

  const Card = (p) => {
    const offline = p.mode === 'offline';
    const note = retakeNote(p);
    return (
      <div key={p.id} className="pcard catalog">
        {offline
          ? <div className="cat-badge" aria-hidden="true">
              {/* venue — the in-person session's stand-in for a progress ring */}
              <svg className="ic" viewBox="0 0 24 24"><path d="M3 21V9l9-6 9 6v12" /><path d="M9 21v-6h6v6" /></svg>
            </div>
          : p.status === 'assigned'
            ? <ProgressRing p={p.progress ?? 0} size={52} sm check={isDone(p)} />
            : <div className="cat-badge" aria-hidden="true">{(loc(p, 'title') || '?').trim().charAt(0)}</div>}
        <div className="cinfo">
          <h3>{loc(p, 'title')}</h3>
          <div className="sub">
            {offline && <span className="pill">{tt.offlineTag}</span>}
            {stPill(p)}
            {p.category && <span className="pill muted">{categoryLabel(p.category, lang)}</span>}
            {p.viaProject && <span className="pill pri">{tt.viaProject}</span>}
            {p.enrollType === 'elective' && p.status !== 'assigned' && <span className="pill">{tt.elective}</span>}
            {offline
              ? <span>{p.sessionAt ? p.sessionAt.replace('T', ' ') : tt.offlineTbd}{p.location ? ` · ${p.location}` : ''}</span>
              : p.status === 'assigned' && p.hasExam !== false && p.best && p.best.passed
                ? <span className="tnum">{tt.scoreFmt(p.best.percent ?? 0)}</span>
                : note
                  ? <span className="home-retake-note">{note}</span>
                  : <span>{t('metaModMin', p.moduleCount ?? p.courseCount ?? 0, p.minutes ?? 0)}</span>}
          </div>
          {p.status === 'rejected' && p.rejectNote && <div className="cat-reject">{tt.rejectedNote(p.rejectNote)}</div>}
        </div>
        <div className="cact">{action(p)}</div>
      </div>
    );
  };

  return (
    <div className="wrap">
      <div className="greet">{t('hi')}<b>{user?.name || ''}</b></div>

      {/* Who I am in the org comes before what courses exist. */}
      <MyTalentCard tt={tt} nav={nav} loc={loc}>

      {/* 行为实践入口卡：模块缺省关闭，只有 modules.culture 显式为 true 才挂载（才发请求）；
          没有进行中的项目、或既不是参与者也没有 culture 授权时，卡片自己不渲染。 */}
      {cultureOn(user) && <CultureEntryCard user={user} tt={tt} />}

      {/* The strip hides itself when there is nothing to do, but with the
          module off /api/me/reviews is a 404 — cleaner not to ask at all. */}
      {on('performance') && <ReviewTodoStrip lang={lang} nav={nav} />}

      {/* With learning off the home page is greeting + profile card (+ review
          to-dos) — no replacement content here by design (P4-A). */}
      {learningOn && (() => {
        // "What's next" hero — an in-progress project beats an in-progress course.
        // The hero is the only place a project appears on this page; the others
        // are on /projects.
        const pj = myProjects.find((p) => p.nextActivity) || null;
        if (pj) {
          return (
            <div className="hero">
              <div className="body">
                <span className="pill pri">{tt.projTag} · {tt.phaseOf(pj.phaseDone, pj.phaseCount)}</span>
                <h1>{loc(pj, 'title')}</h1>
                <div className="meta">
                  {pj.cohort}{pj.class ? ` · ${pj.class}` : ''}<span className="dot">·</span>
                  {tt.projNextIs}: <b style={{ color: 'var(--brand)' }}>{loc(pj.nextActivity, 'title') || tt.actType[pj.nextActivity.category] || tt.actFallback}</b>
                </div>
                <button className="btn" onClick={() => nav(`/projects/${pj.id}`)}>
                  {tt.projEnter}<svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </button>
              </div>
              <div className="tpe-ring lg tnum">{pj.progress}<span>%</span></div>
            </div>
          );
        }
        return hero && (
          <div className="hero">
            <div className="body">
              <span className="pill pri">{tt.continueTitle}</span>
              <h1>{loc(hero, 'title')}</h1>
              <div className="meta">
                <span className="tnum">{hero.moduleCount ?? hero.courseCount ?? 0} </span>{tt.mods}<span className="dot">·</span>
                {tt.about} <span className="tnum">{hero.minutes ?? 0}</span> {tt.min}
              </div>
              <button className="btn" onClick={() => nav(`/program/${hero.id}`)}>
                {tt.continueBtn}<svg className="ic sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            </div>
            <ProgressRing p={hero.progress ?? 0} size={92} />
          </div>
        );
      })()}

      {learningOn && (
        <div className="sec">
          <div className="sec-h">
            <h2>{tt.learnTitle}</h2><span className="count">{learn.length}</span>
            {hasCatalog && <button type="button" className="sec-all home-catalog-link" onClick={() => nav('/catalog')}>{tt.browseCatalog}</button>}
            <button type="button" className="sec-all" onClick={() => nav('/learning')}>{tt.viewAll} →</button>
          </div>

          {learn.length === 0 ? (
            <div className="cat-empty">{tt.empty}</div>
          ) : (
            <>
              <div className="grid">{top.map(Card)}</div>
              {rest.length > 0 && (
                <button type="button" className="home-browse" onClick={() => setBrowse(!browse)}>
                  {browse ? tt.browseClose : tt.browseCat(rest.length)}
                </button>
              )}
              {browse && rest.length > 0 && <div className="grid home-more">{rest.map(Card)}</div>}
            </>
          )}
        </div>
      )}

      {learningOn && elect.length > 0 && (
        <div className="sec" data-home-block="electives">
          <div className="sec-h">
            <h2>{tt.electTitle}</h2><span className="count">{elect.length}</span>
          </div>
          <div className="grid">{electTop.map(Card)}</div>
          {electRest.length > 0 && (
            <button type="button" className="home-browse" onClick={() => setBrowseElect(!browseElect)}>
              {browseElect ? tt.browseClose : tt.browseCat(electRest.length)}
            </button>
          )}
          {browseElect && electRest.length > 0 && <div className="grid home-more">{electRest.map(Card)}</div>}
        </div>
      )}

      </MyTalentCard>

      {learningOn && applyFor && (
        <Overlay label={tt.applyTitle(loc(applyFor, 'title'))} busy={applying} onClose={() => setApplyFor(null)}>
            <h3>{tt.applyTitle(loc(applyFor, 'title'))}</h3>
            <textarea
              className="apply-note" value={applyNote} maxLength={500}
              onChange={(e) => setApplyNote(e.target.value)} placeholder={tt.applyReasonPh} rows={3}
            />
            {applyErr && <div className="apply-err">{applyErr}</div>}
            <div className="apply-foot">
              <button className="btn ghost" onClick={() => setApplyFor(null)} disabled={applying}>{tt.cancel}</button>
              <button className="btn" onClick={submitApply} disabled={applying}>{applying ? '…' : tt.applySubmit}</button>
            </div>
        </Overlay>
      )}
    </div>
  );
}

/* ---- 行为实践（culture）入口卡 ----
   模块缺省关闭（manifest defaultOn:false），调用方只在 /api/me 的 modules.culture 为 true 时挂载本组件。
   GET /api/v1/me/culture/entry 与顶栏共用一次请求（modules/culture/entry.js 缓存 60 秒）：
     本期参与者（participant）→「Action 3+3 挑战」卡，整页进入学员端 /culture/；
     不在名单里、但对 culture 能力域有读权限的人（HR/TD 运营、HRBP）→ 管理视图卡（/culture/#/hr）；
     不在名单里、没有授权、但主持例会的 HoD 与团队主持人 →「Action 3+3 挑战 · 例会主持」卡（#/dept 或 #/team，R-143）；
     没有进行中的项目、或以上都不是 → 不渲染任何 DOM。
   学员端不在本 SPA 的路由里，所以按钮是普通 <a href>，不是 nav()。
   学员卡的说明按阶段（entry 的 program.phase，服务端按项目时区的业务日期算出，契约 v5）：开始前、前测窗口内、
   进行中、计分已冻结各一句；老服务端没有 phase 时按「进行中」显示。culture-0009 起前测可提前 0 天（开始日当天开放）：
   开始前写「第一天同时开放前测」，第 1 周前测还开着时写开放到哪天（culLearnerPreOpen）。 */
function culLearnerText(p, tt) {
  if (p.frozen || p.phase === 'frozen') return tt.culLearnerFrozen;
  const pre = p.preTest || {};
  if (p.phase === 'upcoming') return tt.culLearnerUpcoming(p.startDate, pre.from);
  if (p.phase === 'pretest') return tt.culLearnerPretest(pre.to);
  // culture-0009（10/10）：前测提前 0 天时前测窗口落在第 1 周，挑战已开始但前测还开着 → 提示前测开放到哪天（serverToday 为项目时区的业务日期）
  if (pre.from && pre.to && p.serverToday && p.serverToday >= pre.from && p.serverToday <= pre.to && p.serverToday >= p.startDate) return tt.culLearnerPreOpen(pre.to);
  return tt.culLearnerLead;
}
// 参与者与主持人卡的提示行（R-143、设计方案 5.10）：有待评分的例会时提示场数；本人担任 HoD 的一级部门尚未确认团队主持人时
// 提示确认（开始前写明期限 = 第 1 周开始前一天，与学员端 hostsConfirmBy 同一口径；开始后不写日期）。计分截止后不再提示。
function dayBefore(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - 1)).toISOString().slice(0, 10);
}
function culCardNotes(kind, entry, tt) {
  const p = entry.program, out = [];
  if ((kind !== 'learner' && kind !== 'host') || p.frozen || p.phase === 'frozen') return out;
  const n = Number(entry.pendingRatings) || 0;
  if (n > 0) out.push({ k: 'ratings', text: tt.culPendingRatings(n) });
  if (entry.host && entry.host.unconfirmed === true) {
    const by = (p.phase === 'upcoming' || p.phase === 'pretest') ? dayBefore(p.startDate) : '';
    out.push({ k: 'hosts', text: by ? tt.culConfirmHostsBy(by) : tt.culConfirmHosts });
  }
  return out;
}
function CultureEntryCard({ user, tt }) {
  const [entry, setEntry] = useState(null);
  const uid = user && user.id;
  useEffect(() => {
    let alive = true;
    fetchCultureEntry(user).then((d) => { if (alive) setEntry(d); });
    return () => { alive = false; };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const kind = cultureEntryKind(user, entry);
  if (!kind) return null;
  const p = entry.program;
  const learner = kind === 'learner';
  const host = kind === 'host';
  const notes = culCardNotes(kind, entry, tt);
  return (
    <div className="cul-entry" data-culture-entry={kind}>
      <div className="cul-entry-body">
        <div className="cul-entry-h">
          {p.frozen && <span className="pill warn">{tt.culFrozen}</span>}
        </div>
        <div className="cul-entry-title">{learner ? tt.culLearnerTitle : host ? tt.culHostTitle : tt.culManageTitle}</div>
        <div className="cul-entry-meta">
          {p.name && <b>{p.name}</b>}
          {p.startDate && <span className="tnum">{tt.culStart(p.startDate)}</span>}
        </div>
        <div className="cul-entry-sub">{learner ? culLearnerText(p, tt) : host ? tt.culHostLead : tt.culManageLead}</div>
        {notes.map((n) => <div key={n.k} className="cul-entry-note" data-culture-note={n.k}>{n.text}</div>)}
      </div>
      <a className="btn cul-entry-go" href={cultureEntryHref(kind, entry)}>
        {learner || host ? tt.culLearnerGo : tt.culManageGo}
        <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </a>
    </div>
  );
}

/* ---- cross-domain to-dos (IA rebuild): pending self-evals / team reviews
   surface on the home page so "my work" is not just training. ---- */
// 第二批 2.1（2026-10-08）：团队一侧的数字改读服务端 teamStats（已排除离职、已锁定、已代评的人；分母口径与团队评估页一致），
// 不再自己数 team[]。按钮直达对应页签：有自己的自评要交 → /review?view=mine；团队待评级 → /review?view=team&cycle=<有待评级的周期>&status=rate。
export function reviewTodoCounts(d) {
  const stats = d && Array.isArray(d.teamStats) ? d.teamStats : [];
  const sum = (f) => stats.reduce((n, x) => n + (Number(f(x || {})) || 0), 0);
  return {
    mySelf: (d && Array.isArray(d.mine) ? d.mine : []).filter((i) => !i.selfAt && !i.selfLocked).length,
    teamRate: sum((x) => x.todo && x.todo.rate),
    teamOne: sum((x) => x.todo && x.todo.oneOnOne),
    teamNoSelf: sum((x) => x.byStatus && x.byStatus.self),
  };
}
// 「去团队评估」直达哪里：有待评级 → status=rate，否则待面谈 → one，否则待自评 → self；cycle = 第一个有这类待办的周期。
// 首页的数字是所有进行中周期的合计，名单一次只显示一个周期 —— 不带 cycle 会落到第一个周期，可能一个都对不上（波次 2 复核修正）
export function reviewTeamTodoHref(d) {
  const stats = d && Array.isArray(d.teamStats) ? d.teamStats : [];
  const pick = [['rate', (x) => x.todo && x.todo.rate], ['one', (x) => x.todo && x.todo.oneOnOne], ['self', (x) => x.byStatus && x.byStatus.self]];
  for (const [status, f] of pick) {
    const hit = stats.find((x) => (Number(f(x || {})) || 0) > 0);
    if (hit) return `/review?view=team&cycle=${encodeURIComponent(hit.cycleId)}&status=${status}`;
  }
  return '/review?view=team';
}
function ReviewTodoStrip({ lang, nav }) {
  const q = useAsync(() => api.get('/api/me/reviews'), []);
  const d = q.data;
  if (!d) return null;
  const { mySelf, teamRate, teamOne, teamNoSelf } = reviewTodoCounts(d);
  if (mySelf === 0 && teamRate === 0 && teamOne === 0 && teamNoSelf === 0) return null;
  const zh = lang === 'zh';
  const tt = T[lang] || T.en;
  const teamTo = reviewTeamTodoHref(d);
  const teamAny = teamRate > 0 || teamOne > 0 || teamNoSelf > 0;
  // The action is a real button (design: 「去填写」), so the card itself is no
  // longer one — a card-wide button made the pills look clickable too.
  return (
    <div className="card home-todo">
      <b>{zh ? '绩效评估待办' : 'Performance Review Tasks'}</b>
      {mySelf > 0 && <span className="pill warn">{zh ? `待提交自评 ${mySelf}` : `Self-review pending ${mySelf}`}</span>}
      {teamRate > 0 && <span className="pill pri">{zh ? `待评级下属 ${teamRate}` : `Team members to rate ${teamRate}`}</span>}
      {teamOne > 0 && <span className="pill pri">{zh ? `待登记 1 对 1 面谈 ${teamOne}` : `1-on-1s to log ${teamOne}`}</span>}
      {teamNoSelf > 0 && <span className="pill muted">{zh ? `待提交自评的下属 ${teamNoSelf}` : `Team members yet to submit ${teamNoSelf}`}</span>}
      <span className="home-todo-go">
        {mySelf > 0 && <button className="btn sm" onClick={() => nav('/review?view=mine')}>{tt.todoGoSelf}</button>}
        {teamAny && <button className={'btn sm' + (mySelf > 0 ? ' ghost' : '')} onClick={() => nav(teamTo)}>{tt.todoGoTeam}</button>}
      </span>
    </div>
  );
}
