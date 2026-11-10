// 绩效评估（员工端）。第二批 2.1（2026-10-08，W2-B）起分四个视图，由地址栏 ?view= 驱动（设计 0.2；通知可直达）：
//   mine     我的评估：自评（第一部分 回顾上一周期目标，第二部分 下一周期目标）+ 员工一侧登记 1 对 1 面谈（v2，可补登记日期）
//   team     团队评估：下属名单与单人评估页（ReviewTeam.jsx，数据读 teamRows / teamStats 与 GET team/:id）
//   hod      部门校准：HoD 按一级部门校准、代评、一次保存、提交（共享组件 DeptCalibration，GET /api/me/reviews/hod?v=2）
//   history  我的绩效：已关闭周期的最终评级（只显示服务端下发的字段；评语是否下发由服务端决定）；
//            第二批 2.8 起卡片下方有申诉行（AppealLine），?view=history&item=<reviewItemId> 是申诉整页（ReviewAppeal.jsx）
//   consult  申诉征询（第二批 2.8）：HRBP 征询本人（直属上级 / 部门负责人）意见的申诉；有征询（appealConsults.total > 0）才出现
// 1 对 1 面谈与评级互不为前提；进行中的 v2 周期，员工本人看不到上级评级、评语与关键亮点。
// 默认视图：本人有待交自评 → mine；否则团队有待办 → team；否则 HoD 有未提交的组 → hod；否则 mine。定下来后写进地址栏（replace）。
// 我的评估常驻、只隐藏，切页签不丢自评草稿（审查 P1-9）；切页签前问一次离开守卫（团队单人页、部门校准有未保存修改时）。
// 员工端页面：不 import Semi（只用全局样式类）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAsync } from '../api.js';
import { errText } from '../apierr.js';
import { useI18n } from '../i18n.jsx';
import ModuleTrail from '../components/ModuleTrail.jsx';
import DeptCalibration from '../components/DeptCalibration.jsx';
import { confirmLeave } from '../components/useLeaveGuard.js';
import OrgPeerReview from './OrgPeerReview.jsx';   // 组织绩效：一级部门负责人互评（2026-10-10）
import { useUrlState, REVIEW_FILTER_KEYS } from '../urlstate.js';
import { localDay } from '../deptcal.js';
import ReviewTeam, { teamPendingCount, TEAM_PARAM_KEYS } from './ReviewTeam.jsx';
import AppealPage, { AppealLine, ConsultView } from './ReviewAppeal.jsx';
import * as MP from '../myperf.js';   // 绩效看板第三期（10/10）：「我的绩效」概要

// 本地日历日。**不能**用 toISOString().slice(0,10)：那是 UTC 日，菲律宾/中国时区在
// 晚上会算成明天，于是「今天到期」的自评被标成已逾期。
const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const T = {
  zh: {
    title: '绩效评估', lead: '流程：提交自评 → 直属上级与你进行 1 对 1 绩效面谈并评级 → HR 校准。周期关闭后，最终评级记入成长档案，并可在「我的绩效」查看；如有异议，可在「我的绩效」提出申诉。',
    leadHidden: '流程：提交自评 → 直属上级与你进行 1 对 1 绩效面谈并评级 → HR 校准。周期关闭后，最终评级记入员工档案。',
    leadV2: '先提交自评。1 对 1 面谈由你和上级各自登记，可在评级前或评级后补登记；周期关闭后在「我的绩效」查看最终评级，如有异议也在该处提出申诉。',
    leadV2Hidden: '先提交自评。1 对 1 面谈由你和上级各自登记，可在评级前或评级后补登记；周期关闭后，最终评级记入员工档案。',
    vMine: '我的评估', vTeam: '团队评估', vHod: '部门校准', vHistory: '我的绩效', vConsult: '申诉征询', vOrg: '组织绩效互评', vOrgRec: '互评记录', vOrgRes: '组织绩效查看', viewsLab: '绩效评估视图',
    mPersonal: '个人绩效', mPersonalSub: '自评、面谈、评级、校准与申诉', mOrg: '组织绩效', mOrgSub: '一级部门负责人互评与组织绩效结果', modsLab: '绩效评估子模块',
    dueBy: (d) => `自评截止日期 ${d}`, emptyMine: '你本人当前没有进行中的评估周期。',
    p1: '第一部分 · 上一周期目标回顾', p2: '第二部分 · 下一周期目标',
    goalN: (n) => `上一周期目标 ${n}`, noPrev: '（首次参加评估，没有上一周期目标，请直接总结本周期成果）',
    outcomePh: '关键成果：总结该目标下的主要里程碑与可衡量结果…', outcome1Req: '上一周期目标 1 的关键成果为必填项',
    challenges: '遇到的挑战', challengesPh: '遇到的挑战、障碍及其影响…',
    feedback: '对团队/公司的建议', feedbackPh: '对团队或公司的建议：流程、机制、协作方式…',
    goalNextPh: (n) => `目标 ${n}${n === 3 ? '（选填）' : ''}：具体、可衡量、有时限…`,
    submitted: '已提交', pendingSelf: '待提交自评', mgrDone: '上级已评级', oneDone: '1 对 1 面谈已完成', mgrOneLogged: '上级已登记面谈',
    save: '提交自评', resave: '更新自评', saved: '已提交 ✓', selfHint: '提交后，在本部门 HoD 提交校准前仍可更新。',   // CX-172：HoD 提交校准后自评锁定（负责人 10/9 口径）
    selfLocked: '部门已提交校准，自评已锁定。', eSelfLocked: '部门已提交校准，自评已锁定，不能再修改。', lockedPill: '已锁定',
    empOne: '1 对 1 面谈：与上级面谈后，在这里登记。', empOneDone: (d) => `你已登记 1 对 1 面谈 · ${d}`,
    oneLog: '登记 1 对 1 面谈', oneDate: '面谈日期', oneUndo: '撤销登记', oneDateRange: (d) => `可选 ${d}（周期发起日）至今天`,
    managerGoneHod: '你目前没有在职的直属上级，本期评级由 HoD 完成，不需要登记 1 对 1 面谈。',
    managerGoneHr: '你目前没有在职的直属上级，本期评级由 HR 完成，不需要登记 1 对 1 面谈。',
    err: '提交失败：', loadErr: '加载失败，请刷新页面重试。', loading: '加载中…',
    eOutcomes: '上一周期目标 1 的关键成果为必填项', eFeedback: '请填写对团队/公司的建议', eGoals: '请至少填写一个下一周期目标',
    eNotFound: '未找到该评估记录', eCycleClosed: '该评估周期已关闭', e_date_invalid: '日期不能晚于今天，也不能早于周期发起日。',
    // HoD 部门校准
    hodLead: '你是以下一级部门的 HoD。核对上级评级与部门比例，必要时调整或代评（都须写理由），保存全部修改后提交给 HR。',
    hodLeadAnnual: '你是以下一级部门的 HoD。年度评估没有上级评级：请按部门比例为每个人给出评级（调整须写理由），保存全部修改后提交给 HR。',   // CX-182
    hodEmpty: '当前没有需要你校准的部门。', hodGroups: '选择部门', hodLockedChip: '已提交',
    // 我的绩效
    histLead: '已关闭评估周期的最终评级。', histEmpty: '还没有已关闭的评估周期。',
    histAnnual: '年度', histTrend: '近期评级走势', histComment: '上级评语', histHighlights: '关键亮点',
    smTitle: '我的绩效概要', smNow: '本期进度', smNone: '目前没有进行中的评估周期。', smResults: '历次结果', smLatest: (c, r) => `最近一期：${c} · ${r}`,
    smAppeal: '申诉', smNoAppeal: '没有进行中的申诉。',
    stepSelf: '自评', stepOne: '1 对 1 面谈', stepRate: '上级评级', stepCalib: '部门校准与 HR 确认', stepResult: '结果告知', stepMissed: '未按期提交', lateSelf: '可补交', lateOne: '可补登记',
    whoMe: '下一步：你', whoBoth: '下一步：你和直属上级各自登记面谈', whoManager: '下一步：直属上级', whoHod: '下一步：部门负责人与 HR', dueOn: (d) => `截止 ${d}`,
  },
  en: {
    title: 'Performance Reviews', lead: 'Steps: submit your self-review → your manager holds a 1-on-1 performance conversation with you and gives a rating → HR calibration. When the cycle closes, your final rating is added to your Development Record and shown under My performance, where you can also file an appeal.',
    leadHidden: 'Steps: submit your self-review → your manager holds a 1-on-1 performance conversation with you and gives a rating → HR calibration. When the cycle closes, the final rating is saved to your employee profile.',
    leadV2: 'Submit your self-review first. You and your manager each log the 1-on-1, before or after the rating, and can log it later. Your final rating appears under My performance when the cycle closes, where you can also file an appeal.',
    leadV2Hidden: 'Submit your self-review first. You and your manager each log the 1-on-1, before or after the rating, and can log it later. When the cycle closes, your final rating is saved to your employee profile.',
    vMine: 'My review', vTeam: 'Team reviews', vHod: 'Department calibration', vHistory: 'My performance', vConsult: 'Appeal consultations', vOrg: 'Peer review', vOrgRec: 'Peer review records', vOrgRes: 'Organizational results', viewsLab: 'Performance review views',
    mPersonal: 'Individual performance', mPersonalSub: 'Self-review, 1-on-1, rating, calibration and appeals', mOrg: 'Organizational performance', mOrgSub: 'Peer review among heads of department and the results', modsLab: 'Performance review modules',
    dueBy: (d) => `Self-review deadline ${d}`, emptyMine: 'You have no review cycle in progress.',
    p1: 'Part 1 · Review of Previous Cycle Goals', p2: 'Part 2 · Goals for the Next Cycle',
    goalN: (n) => `Previous cycle goal ${n}`, noPrev: '(First review cycle: no previous goals. Summarize your results for this cycle.)',
    outcomePh: 'Key outcomes: summarize the main milestones and measurable results for this goal…', outcome1Req: 'Key outcomes for previous cycle goal 1 are required',
    challenges: 'Challenges encountered', challengesPh: 'Challenges, obstacles and their impact…',
    feedback: 'Suggestions for the team/company', feedbackPh: 'Suggestions for the team or the company: processes, mechanisms, ways of working…',
    goalNextPh: (n) => `Goal ${n}${n === 3 ? ' (optional)' : ''}: specific, measurable, time-bound…`,
    submitted: 'Submitted', pendingSelf: 'Self-review pending', mgrDone: 'Rated by manager', oneDone: '1-on-1 completed', mgrOneLogged: 'Manager logged the 1-on-1',
    save: 'Submit self-review', resave: 'Update self-review', saved: 'Submitted ✓', selfHint: 'You can update it until your department head submits the calibration.',
    selfLocked: 'Your department\'s calibration has been submitted, so your self-review is locked.', eSelfLocked: 'Your department\'s calibration has been submitted — the self-review can no longer be changed.', lockedPill: 'Locked',
    empOne: '1-on-1: log it here after the conversation with your manager.', empOneDone: (d) => `You logged the 1-on-1 · ${d}`,
    oneLog: 'Log 1-on-1', oneDate: 'Meeting date', oneUndo: 'Undo', oneDateRange: (d) => `Pick a date from ${d} (cycle start) to today`,
    managerGoneHod: 'You have no active direct manager right now, so your HoD will complete this cycle’s rating. No 1-on-1 needs to be logged.',
    managerGoneHr: 'You have no active direct manager right now, so HR will complete this cycle’s rating. No 1-on-1 needs to be logged.',
    err: 'Couldn’t submit: ', loadErr: 'Couldn’t load. Refresh the page to try again.', loading: 'Loading…',
    eOutcomes: 'Key outcomes for previous cycle goal 1 are required', eFeedback: 'Suggestions for the team/company are required', eGoals: 'Set at least one goal for the next cycle',
    eNotFound: 'Review record not found', eCycleClosed: 'This review cycle is closed', e_date_invalid: 'The date can’t be in the future or before the cycle started.',
    hodLead: 'You are the HoD of the departments below. Check the manager ratings against the department distribution, adjust or rate on the manager’s behalf where needed (both need a reason), save all changes, then submit to HR.',
    hodLeadAnnual: 'You are the HoD of the departments below. Annual reviews have no manager rating: rate each person against the department distribution (adjustments need a reason), save all changes, then submit to HR.',
    hodEmpty: 'There is no department waiting for your calibration.', hodGroups: 'Choose a department', hodLockedChip: 'Submitted',
    histLead: 'Final ratings from closed review cycles.', histEmpty: 'No closed review cycle yet.',
    histAnnual: 'Annual', histTrend: 'Recent ratings', histComment: 'Manager comments', histHighlights: 'Key highlights',
    smTitle: 'My performance at a glance', smNow: 'This cycle', smNone: 'There is no review cycle in progress.', smResults: 'Past results', smLatest: (c, r) => `Latest: ${c} · ${r}`,
    smAppeal: 'Appeals', smNoAppeal: 'No appeal in progress.',
    stepSelf: 'Self-review', stepOne: '1-on-1', stepRate: 'Manager rating', stepCalib: 'Calibration and HR confirmation', stepResult: 'Result shared', stepMissed: 'Not submitted in time', lateSelf: 'can still be submitted', lateOne: 'can still be recorded',
    whoMe: 'Next: you', whoBoth: 'Next: you and your manager each record the 1-on-1', whoManager: 'Next: your manager', whoHod: 'Next: your head of department and HR', dueOn: (d) => `Due ${d}`,
  },
};

// ---- 纯函数（test/review-ui-v2.test.js 截取本段求值：本段不写 JSX、不引用 import 进来的名字）----
export const VIEWS = ['mine', 'team', 'hod', 'history', 'consult', 'org', 'orgrec', 'orgres'];
// 可见的视图：我的评估始终有；团队评估在有下属条目时；部门校准在本人是 HoD 时；我的绩效在有已关闭周期且结果对员工可见时；
// 申诉征询（第二批 2.8）在有征询时（服务端 appealConsults.total：处理中或 90 天内有结论的申诉）
export function viewsOf(d) {
  if (!d) return ['mine'];
  const out = ['mine'];
  if (Array.isArray(d.teamRows) && d.teamRows.length) out.push('team');
  if (d.isHod) out.push('hod');
  if (d.hasHistory && d.resultVisibleToEmployee !== false) out.push('history');
  if (d.appealConsults && Number(d.appealConsults.total) > 0) out.push('consult');
  // 组织绩效（2026-10-10）：一级部门负责人，或有过互评任务的人（服务端 orgView）
  // 10/12 负责人：组织绩效下三个页签 —— org 组织绩效互评（待填写）、orgrec 互评记录（已提交 / 已结束）、orgres 组织绩效查看（本部门结果）
  if (d.orgView) out.push('org', 'orgrec', 'orgres');
  return out;
}
export function mineTodo(d) {
  return (d && Array.isArray(d.mine) ? d.mine : []).some((i) => !i.selfAt && !i.selfLocked);
}
// 团队待办：读服务端 teamStats[].todo（排除已离职、已锁定、已代评）
export function teamTodo(d) {
  return (d && Array.isArray(d.teamStats) ? d.teamStats : []).some((x) => x && x.todo && ((Number(x.todo.rate) || 0) + (Number(x.todo.oneOnOne) || 0)) > 0);
}
// 要不要先看一眼 HoD 的组（只有前两步都没有待办、本人又是 HoD 时才需要）
export function probeHod(d) { return !!(d && d.isHod && !mineTodo(d) && !teamTodo(d)); }
export function hodGroupsOpen(r) { return !!(r && Array.isArray(r.groups) && r.groups.some((g) => g && !g.locked)); }
// hodOpen：undefined = 还在探测（返回 null，页面显示加载中）
export function defaultView(d, hodOpen) {
  if (!d) return null;
  const views = viewsOf(d);
  if (mineTodo(d)) return 'mine';
  if (views.includes('team') && teamTodo(d)) return 'team';
  if (views.includes('hod')) {
    if (hodOpen === undefined) return null;
    if (hodOpen) return 'hod';
  }
  return 'mine';
}
// 两个子模块（负责人 2026-10-12）：个人绩效 = 非 org* 视图；组织绩效 = org / orgrec / orgres。各自是二级页签。
// 只有能看组织互评的人才出现一级切换；地址栏仍只有 ?view=，旧通知链接（view=org = 组织绩效互评）不变。
export const MODULES = ['personal', 'org'];
const ORG_VIEWS = ['org', 'orgrec', 'orgres'];
export function moduleOf(view) { return ORG_VIEWS.includes(view) ? 'org' : 'personal'; }
export function personalViews(views) { return (views || []).filter((k) => !ORG_VIEWS.includes(k)); }
export function orgViews(views) { return (views || []).filter((k) => ORG_VIEWS.includes(k)); }
// ---- 纯函数到此 ----

// 切视图时清掉的地址栏键：校准筛选键、一级部门、团队名单的周期 / 状态 / 搜索 / 单人页（设计 0.2 清理规则）
const VIEW_CLEAR_KEYS = [...new Set([...REVIEW_FILTER_KEYS, 'unit', ...TEAM_PARAM_KEYS])];

export default function Review() {
  const { lang } = useI18n();
  const q = useAsync(() => api.get('/api/me/reviews'), []);
  const [params, patch] = useUrlState();
  const d = q.data;
  // 结果对员工本人是否可见跟「绩效记录」类型的「员工可见」开关（G-10）；老服务端没有该字段时按可见
  const s = d && d.resultVisibleToEmployee === false
    ? { ...T[lang], lead: T[lang].leadHidden, leadV2: T[lang].leadV2Hidden }
    : T[lang];
  // ---- 所有 hook 在提前 return 之前（审查 P1-17）----
  const views = useMemo(() => viewsOf(d), [d]);
  // 申诉整页 / 征询详情（通知直达）：页签没出现时也按地址栏打开（例如结果已隐藏但申诉已有结论、征询已超出列表的 90 天），由页面自己处理 404 / 不开放
  const directItem = !!params.item && (params.view === 'history' || params.view === 'consult');
  const asked = VIEWS.includes(params.view) && (views.includes(params.view) || directItem) ? params.view : null;
  const probe = !!d && !asked && probeHod(d);
  const hodProbe = useAsync(() => (probe ? api.get('/api/me/reviews/hod?v=2').then((r) => ({ probe: true, r })) : Promise.resolve({ probe: false })), [probe]);
  const hodOpen = !probe ? false : hodProbe.data && hodProbe.data.probe ? hodGroupsOpen(hodProbe.data.r) : hodProbe.error ? false : undefined;
  const view = d ? asked || defaultView(d, hodOpen) : null;
  // 视图定下来后写进地址栏（replace，不垫历史）：之后数据刷新（例如交完自评）不会把人从当前页签挪走；
  // 地址栏里不可用的 view 只在数据到了以后才改写（审查 P1-8）
  useEffect(() => {
    if (d && view && params.view !== view) patch({ view }, { push: false });
  }, [d, view, params.view, patch]);
  const switchView = useCallback((k) => {
    if (k === view || !confirmLeave()) return;
    patch({ view: k }, { clear: VIEW_CLEAR_KEYS });
  }, [view, patch]);
  // 一级切换：回到个人绩效时回到上次看的页签；没有（或已不可见）时去掉 view，由默认视图规则决定
  const lastPersonal = useRef(null);
  const lastOrg = useRef(null);
  useEffect(() => { if (view) (moduleOf(view) === 'org' ? lastOrg : lastPersonal).current = view; }, [view]);
  const switchModule = useCallback((m) => {
    if (m === moduleOf(view) || !confirmLeave()) return;
    const back = lastPersonal.current && views.includes(lastPersonal.current) ? lastPersonal.current : null;
    patch({ view: m === 'org' ? lastOrg.current || 'org' : back }, { clear: VIEW_CLEAR_KEYS });
  }, [view, views, patch]);
  // 我的绩效 → 申诉整页（item，push）；「返回」从卡片点进来的用浏览器后退（回到原滚动位置），直接打开的改写地址
  const nav = useNavigate();
  const fromHistory = useRef(false);
  const openAppeal = useCallback((id) => { fromHistory.current = true; patch({ item: id }); }, [patch]);
  const closeAppeal = useCallback(() => {
    if (!confirmLeave()) return;
    if (fromHistory.current) { fromHistory.current = false; nav(-1); return; }
    patch({ item: null }, { push: false });
  }, [nav, patch]);

  if (q.error) return <div className="wrap"><div className="card">{s.loadErr}</div></div>;
  if (!d || !view) return <div className="wrap"><div className="card rv-note">…</div></div>;
  // 整页（团队单人页、申诉整页、征询详情）：不显示页头与页签
  const personPage = !!params.item && (view === 'team' || view === 'history' || view === 'consult');
  // 有进行中的旧流程周期时才用旧说明；其余（含没有进行中周期）一律按新流程说明（QA 2026-10-06 P4）
  const anyLegacy = d.mine.some((i) => i.flow !== 'v2');
  const teamN = teamPendingCount(d.teamRows);
  const consultN = d.appealConsults ? Number(d.appealConsults.open) || 0 : 0;
  const names = { mine: s.vMine, team: s.vTeam, hod: s.vHod, history: s.vHistory, consult: s.vConsult, org: s.vOrg, orgrec: s.vOrgRec, orgres: s.vOrgRes };
  const hasOrg = views.includes('org');
  const mod = moduleOf(view);
  const subViews = mod === 'org' ? orgViews(views) : personalViews(views);
  const modName = { personal: s.mPersonal, org: s.mOrg };
  const modSub = { personal: s.mPersonalSub, org: s.mOrgSub };
  return (
    <div className={'wrap rv-wrap' + (view === 'hod' ? ' rv-wide' : '')}>
      {!personPage && <ModuleTrail items={hasOrg ? [{ label: s.title, to: '/review' }, { label: modName[mod] }] : [{ label: s.title }]} />}
      {!personPage && (
        <div className="ml-head">
          <h1 className="ml-title">{s.title}</h1>
          {hasOrg && (
            <div className="rv-mods" role="tablist" aria-label={s.modsLab}>
              {MODULES.map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mod === m} className={'rv-mod' + (mod === m ? ' on' : '')} onClick={() => switchModule(m)}>
                  <b className="rv-mod-t">{modName[m]}{m === 'personal' && mod !== 'personal' && teamN + consultN > 0 && <span className="rv-view-n tnum">{teamN + consultN}</span>}</b>
                  <small className="rv-mod-d">{modSub[m]}</small>
                </button>
              ))}
            </div>
          )}
          {view === 'mine' && <p className="ml-lead">{anyLegacy ? s.lead : s.leadV2}</p>}
        </div>
      )}
      {!personPage && subViews.length > 1 && (
        <div className={'rv-views rv-views-' + subViews.length} role="tablist" aria-label={s.viewsLab}>
          {subViews.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={'rv-view-tab' + (view === k ? ' on' : '')} onClick={() => switchView(k)}>
              {names[k]}{k === 'team' && teamN > 0 && <span className="rv-view-n tnum">{teamN}</span>}
              {k === 'consult' && consultN > 0 && <span className="rv-view-n tnum">{consultN}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="rv-mine" hidden={view !== 'mine'}>
        {d.mine.length === 0 ? <div className="card rv-empty">{s.emptyMine}</div>
          : d.mine.map((item) => <SelfCard key={item.id} item={item} s={s} onSaved={q.reload} />)}
      </div>
      {view === 'team' && <ReviewTeam lang={lang} data={d} params={params} patch={patch} onReload={q.reload} />}
      {view === 'hod' && <HodView s={s} lang={lang} params={params} patch={patch} onChanged={q.reload} />}
      {view === 'history' && !params.item && <HistoryPanel s={s} lang={lang} options={d.ratingOptions} optionsZh={d.ratingOptions_zh} onOpen={openAppeal} mine={d.mine} />}
      {view === 'history' && !!params.item && (
        <AppealPage key={params.item} itemId={params.item} lang={lang} ratingOptions={d.ratingOptions} ratingOptionsZh={d.ratingOptions_zh} onBack={closeAppeal} />
      )}
      {mod === 'org' && <OrgPeerReview key={view} lang={lang} tab={view === 'orgrec' ? 'records' : view === 'orgres' ? 'result' : 'fill'} />}
      {view === 'consult' && (
        <ConsultView lang={lang} params={params} patch={patch} ratingOptions={d.ratingOptions} ratingOptionsZh={d.ratingOptions_zh} onChanged={q.reload} />
      )}
    </div>
  );
}

function SelfCard({ item, s, onSaved }) {
  const prev = item.prevGoals || [];
  // U3：部门已提交校准（含之后被退回）→ 自评与目标只读，不再有提交按钮
  const locked = !!item.selfLocked;
  const slots = Math.max(prev.length, 1);
  const [outcomes, setOutcomes] = useState(Array.from({ length: slots }, (_, i) => item.selfOutcomes[i] || ''));
  const [challenges, setChallenges] = useState(item.selfChallenges);
  const [feedback, setFeedback] = useState(item.selfFeedback);
  const [goals, setGoals] = useState([0, 1, 2].map((i) => item.goalsNext[i] || ''));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const submit = async () => {
    setBusy(true); setMsg('');
    try {
      // 突出贡献 is no longer collected (design 20), but POST .../self rewrites the
      // whole row — echo the stored value back so an older entry survives.
      await api.post(`/api/me/reviews/${item.id}/self`, { outcomes, challenges, feedback, extra: item.selfExtra, goalsNext: goals.filter((g) => g.trim()) });
      setMsg(s.saved);
      onSaved();
    } catch (err) {
      // 服务端的 error 是中英拼在一句里的（它不知道读者语言），按 code 出本地文案。
      setMsg(s.err + errText(err, {
        self_outcomes_required: () => s.eOutcomes,
        self_feedback_required: () => s.eFeedback,
        self_goals_required: () => s.eGoals,
        not_found: () => s.eNotFound,
        cycle_closed: () => s.eCycleClosed,
        self_locked: () => s.eSelfLocked,
      }));
    }
    setBusy(false);
  };
  const setOut = (i, v) => setOutcomes((a) => a.map((x, j) => (j === i ? v : x)));
  const setGoal = (i, v) => setGoals((a) => a.map((x, j) => (j === i ? v : x)));
  // Server rule (POST .../self): outcome 1 is required as soon as there were
  // previous goals — gate the button on it so the 400 never happens.
  const req1 = prev.length > 0;
  const missingOut1 = req1 && !(outcomes[0] || '').trim();
  const v2 = item.flow === 'v2';
  return (
    <div className="card rv-card">
      <div className="rv-head">
        <b className="rv-cycle">{item.cycle}</b>
        <span className={'pill ' + (item.selfAt ? 'ok' : 'warn')}>{item.selfAt ? s.submitted : s.pendingSelf}</span>
        {locked && <span className="pill muted">{s.lockedPill}</span>}
        {/* HR 在后台设的自评截止日期。已提交就不再催（不标红）。 */}
        {item.dueAt && <span className={'pill ' + (!item.selfAt && item.dueAt < todayStr() ? 'fail' : 'muted')}>{s.dueBy(item.dueAt)}</span>}
        {item.oneOnOneAt && !item.managerGone && <span className="pill pri">{v2 ? s.mgrOneLogged : s.oneDone}</span>}
        {item.managerDone && <span className="pill pri">{s.mgrDone}</span>}
      </div>
      {/* 8.5（第三批）表单页宽度规范：正文限舒适行宽；≥1440 两栏 —— 左「本期回顾」、右「下期目标」（rv-self-grid，CSS 见 B3-G7） */}
      <div className="rv-self-grid">
      <div className="rv-self-col">
      <div className="rv-part">{s.p1}</div>
      {prev.length === 0 && <div className="rv-note">{s.noPrev}</div>}
      {Array.from({ length: slots }).map((_, i) => (
        <div key={i}>
          {prev[i] && (
            <div className="rv-quote"><b>{s.goalN(i + 1)}{i === 0 && req1 && <span className="req">*</span>}</b>{prev[i]}</div>
          )}
          <textarea rows={3} className="rv-ta" value={outcomes[i]} readOnly={locked}
            placeholder={s.outcomePh + (i === 0 && req1 ? ` (${s.outcome1Req})` : '')}
            onChange={(e) => setOut(i, e.target.value)} />
        </div>
      ))}
      <div className="rv-lab">{s.challenges}</div>
      <textarea rows={2} className="rv-ta" value={challenges} readOnly={locked} placeholder={s.challengesPh} onChange={(e) => setChallenges(e.target.value)} />
      <div className="rv-lab">{s.feedback}<span className="req">*</span></div>
      <textarea rows={2} className="rv-ta" value={feedback} readOnly={locked} placeholder={s.feedbackPh} onChange={(e) => setFeedback(e.target.value)} />
      </div>
      <div className="rv-self-col">
      {/* CX-173：下一周期目标至少填一个 —— 标题加必填星号 */}
      <div className="rv-part">{s.p2}<span className="req">*</span></div>
      {[0, 1, 2].map((i) => (
        // The 3rd goal is optional, so it gets a dashed box (design 20).
        <textarea key={i} rows={2} className={'rv-ta' + (i === 2 ? ' opt' : '')} value={goals[i]} readOnly={locked}
          placeholder={s.goalNextPh(i + 1)} onChange={(e) => setGoal(i, e.target.value)} />
      ))}
      </div>
      </div>
      {!locked && (
        <div className="rv-foot">
          <button className="btn sm" disabled={busy || missingOut1 || !feedback.trim() || !goals.some((g) => g.trim())} onClick={submit}>{item.selfAt ? s.resave : s.save}</button>
          {/* CX-173：提交置灰时写明还缺哪一项（原来只置灰不说原因） */}
          <span className={'rv-msg' + (msg.startsWith(s.err) || (!msg && !busy && (missingOut1 || !feedback.trim() || !goals.some((g) => g.trim()))) ? ' err' : '')}>{msg || (busy ? '' : missingOut1 ? s.eOutcomes : !feedback.trim() ? s.eFeedback : !goals.some((g) => g.trim()) ? s.eGoals : '')}</span>
        </div>
      )}
      <div className="rv-hint">{locked ? s.selfLocked : s.selfHint}</div>
      {v2 && <EmpOneOnOne item={item} s={s} onSaved={onSaved} />}
    </div>
  );
}

// 员工一侧登记 1 对 1 面谈（绩效流程 v2：双方各自登记，与自评、评级互不为前提；可补登记过去的日期）
function EmpOneOnOne({ item, s, onSaved }) {
  const today = todayStr();
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = async (done) => {
    setBusy(true); setMsg('');
    try { await api.post(`/api/me/reviews/${item.id}/one-on-one`, done ? { done: true, date } : { done: false }); onSaved(); }
    // P0 S7：部门已提交校准后不能再撤销面谈登记（服务端 409 self_locked）；日期越界 400 date_invalid
    catch (err) { setMsg(s.err + errText(err, { not_found: () => s.eNotFound, cycle_closed: () => s.eCycleClosed, self_locked: () => s.eSelfLocked, date_invalid: () => s.e_date_invalid })); }
    setBusy(false);
  };
  // 第二批 2.7：直属上级已离职 / 停用或没有上级 → 整块换成中性说明；由谁补评按服务端 managerGoneBy（hod / hr）
  if (item.managerGone) return <div className="rv-emp1 muted">{item.managerGoneBy === 'hod' ? s.managerGoneHod : s.managerGoneHr}</div>;
  // 日期下限 = 周期发起日：条目里有 cycleStartedAt / cycleCreatedAt 就用，否则只靠服务端校验
  const minDate = item.cycleStartedAt || item.cycleCreatedAt ? localDay(item.cycleStartedAt || item.cycleCreatedAt) : undefined;
  // 日期范围（第二批波次 3）：上限今天、下限周期发起日（服务端 cycleStartedAt）。手动输入越界时按钮置灰、范围提示标红，不等 400 date_invalid
  const outOfRange = !!date && (date > today || (!!minDate && date < minDate));
  return (
    <div className={'rv-emp1' + (item.employeeOneOnOneAt ? ' ok' : '')}>
      {item.employeeOneOnOneAt ? (
        <>
          <span className="tnum">{s.empOneDone(localDay(item.employeeOneOnOneAt))}</span>
          {!item.selfLocked && <button type="button" className="rv-nudge" disabled={busy} onClick={() => set(false)}>{s.oneUndo}</button>}
        </>
      ) : (
        <>
          <span className="rv-emp1-q">{s.empOne}</span>
          <label className="rv-emp1-date">
            <span>{s.oneDate}</span>
            <input type="date" className="rv-inp" value={date} max={today} min={minDate} disabled={busy} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button type="button" className="btn sm" disabled={busy || !date || outOfRange} onClick={() => set(true)}>{s.oneLog}</button>
          {minDate && <span className={outOfRange ? 'rv-msg err' : 'rv-hint'}>{s.oneDateRange(minDate)}</span>}
        </>
      )}
      {msg && <span className="rv-msg err">{msg}</span>}
    </div>
  );
}

// HoD 部门校准（第二批 2.2 / 2.7）：组选择（地址栏 cycle + unit）+ 共享组件 DeptCalibration（hod 模式）。
// 数据 GET /api/me/reviews/hod?v=2；一次保存 PUT /hod/items（全部成功或全部不写，返回保存后的视图）；提交 POST /hod/submit；
// 提醒上级 POST /hod/remind。草稿由组件按「周期 + 一级部门」存 sessionStorage；切组之前问一次离开守卫。
// 地址栏的 cycle / unit 与已加载的数据对上之后才把 ready 交给组件，组件这时才校验筛选参数（审查 P1-8）。
function HodView({ s, lang, params, patch, onChanged }) {
  const q = useAsync(() => api.get('/api/me/reviews/hod?v=2'), []);
  // 保存后服务端回传的视图，按组存（{ [组键]: view }），重新加载之前用它：在 A 组保存、再到 B 组保存，回到 A 组仍是 A 组
  // 保存后的样子（只存一组时 A 组会退回加载时的旧视图，按旧值再改会被服务端当作 stale 拒绝；波次 2 复核修正）
  const [fresh, setFresh] = useState({});
  useEffect(() => { setFresh({}); }, [q.data]);
  const groups = q.data && Array.isArray(q.data.groups) ? q.data.groups : [];
  const gk = (g) => `${g.cycleId}:${g.unit}`;
  const sel = groups.find((g) => g.cycleId === params.cycle && String(g.unit) === String(params.unit)) || null;
  const cur = sel || groups.find((g) => !g.locked) || groups[0] || null;
  const curKey = cur ? gk(cur) : '';
  // 地址栏没指定组、或指定的组已不在：数据到了以后改成默认组（replace）；原来指定过的，顺手清掉它的筛选键
  useEffect(() => {
    if (q.loading || !q.data || !cur || sel) return;
    patch({ cycle: cur.cycleId, unit: cur.unit }, { push: false, clear: params.cycle || params.unit ? REVIEW_FILTER_KEYS : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.loading, q.data, curKey, !!sel]);
  const query = useMemo(() => {
    const o = {};
    for (const k of REVIEW_FILTER_KEYS) if (params[k] !== undefined && params[k] !== null && params[k] !== '') o[k] = params[k];
    return o;
  }, [params]);
  const onQuery = useCallback((p) => patch(p, { push: false }), [patch]);
  const view = cur ? fresh[curKey] || cur.view : null;
  const ready = !q.loading && !!sel;
  const selectGroup = (g) => {
    if (gk(g) === curKey || !confirmLeave()) return;
    patch({ cycle: g.cycleId, unit: g.unit }, { clear: REVIEW_FILTER_KEYS });
  };
  const onSaveAll = async (changes) => {
    const r = await api.put('/api/me/reviews/hod/items', { cycleId: cur.cycleId, dept1Id: cur.unit, changes });
    if (r && r.view) setFresh((m) => ({ ...m, [curKey]: r.view }));
    return r;
  };
  const onSubmit = async () => {
    await api.post('/api/me/reviews/hod/submit', { cycleId: cur.cycleId, dept1Id: cur.unit });
    q.reload();
    if (onChanged) onChanged();
  };
  const onRemind = (itemIds) => api.post('/api/me/reviews/hod/remind', { cycleId: cur.cycleId, dept1Id: cur.unit, itemIds });
  // HoD 本人就是直属上级的人：到团队评估的单人页用上级入口评级
  const managerEntryHref = (row) => `/review?view=team&item=${encodeURIComponent(row.id)}`;
  return (
    <div className="rv-hod">
      <p className="rv-note">{cur && cur.cycle && cur.cycle.kind === 'annual' ? s.hodLeadAnnual : s.hodLead}</p>
      {!q.data && q.error && <div className="card">{s.loadErr}</div>}
      {!q.data && !q.error && <div className="card rv-note">{s.loading}</div>}
      {q.data && groups.length === 0 && <div className="card rv-empty">{s.hodEmpty}</div>}
      {groups.length > 1 && (
        <div className="ml-filters rv-hodgroups" role="group" aria-label={s.hodGroups}>
          {groups.map((g) => (
            <button key={gk(g)} type="button" className={'ml-chip' + (gk(g) === curKey ? ' active' : '')} aria-pressed={gk(g) === curKey} onClick={() => selectGroup(g)}>
              <span>{g.dept1 || '—'}</span>
              <span className="rv-hodgroup-c">{g.cycle && g.cycle.name}</span>
              {g.locked && <span className="ml-chip-n">{s.hodLockedChip}</span>}
            </button>
          ))}
        </div>
      )}
      {cur && view && (
        <DeptCalibration key={curKey} mode="hod" lang={lang} view={view} query={query} onQuery={onQuery} ready={ready}
          onSaveAll={onSaveAll} onSubmit={onSubmit} onRemindManagers={onRemind} managerEntryHref={managerEntryHref} />
      )}
    </div>
  );
}

const RATING_ORDER = ['A+', 'A', 'B+', 'B', 'C', 'D'];

// 我的绩效：按年份分组的已关闭周期结果 + 近 8 期评级走势。只显示服务端下发的字段：评级是档案里的最终评级（2.6 改过的以改后的为准），
// 评语有才显示（是否下发由服务端决定），关键亮点服务端不再下发（K4），有才显示
// 第二批 2.8：每张卡片下方是申诉行（AppealLine，服务端 item.appeal 为 null 时不显示）
// 绩效看板第三期（负责人 2026-10-10 开工）：「我的绩效」顶部概要 —— 本期进度（下一步由谁、截止日）、历次结果、进行中的申诉。
// 负责人定：员工不看分布、不看他人评级与名次；这里只用本人的数据（计算见 ../myperf.js）。
function MyPerfSummary({ s, lang, mine, items, label, onOpen }) {
  const cur = (mine || []).find((i) => !i.notCounted) || null;
  const st = MP.stepsOf(cur);
  const res = MP.recentResults(items, 4);
  const aps = MP.activeAppeals(items);
  const stepName = { self: s.stepSelf, one: s.stepOne, rate: s.stepRate, calib: s.stepCalib, result: s.stepResult };
  const whoText = { me: s.whoMe, both: s.whoBoth, manager: s.whoManager, hod: s.whoHod };
  return (
    <div className="card rv-card mp-sum">
      <div className="rv-lab">{s.smTitle}</div>
      <div className="mp-grid">
        <div className="mp-block">
          <div className="mp-h">{s.smNow}{cur ? <span className="rv-eid"> · {cur.cycle}</span> : null}</div>
          {!st ? <p className="rv-note">{s.smNone}</p> : (
            <>
              <ol className="mp-steps">
                {st.steps.map((x) => (
                  <li key={x.key} className={'mp-step ' + x.state}>
                    <span className="mp-dot" aria-hidden="true" />
                    <span>{stepName[x.key]}{x.state === 'missed' ? <span className="mp-miss"> · {s.stepMissed}</span> : x.state === 'late' ? <span className="mp-late"> · {x.key === 'self' ? s.lateSelf : s.lateOne}</span> : null}</span>
                  </li>
                ))}
              </ol>
              <p className="mp-next">{whoText[st.who]}{st.due ? <span className="tnum"> · {s.dueOn(localDay(st.due))}</span> : null}</p>
            </>
          )}
        </div>
        <div className="mp-block">
          <div className="mp-h">{s.smResults}</div>
          {res.latest && <p className="mp-latest">{s.smLatest(res.latest.cycle, label(res.latest.rating))}</p>}
          {res.quarters.length > 0 && (
            <div className="mp-chips">
              {res.quarters.map((q2) => <span key={q2.id} className="mp-chip"><span className="rv-eid">{q2.cycle}</span><b>{label(q2.rating)}</b></span>)}
            </div>
          )}
        </div>
        <div className="mp-block">
          <div className="mp-h">{s.smAppeal}</div>
          {aps.length === 0 ? <p className="rv-note">{s.smNoAppeal}</p> : aps.map((i) => (
            <div key={i.id} className="mp-ap"><span className="rv-eid">{i.cycle}</span><AppealLine appeal={i.appeal} lang={lang} onOpen={() => onOpen(i.id)} /></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HistoryPanel({ s, lang, options, optionsZh, onOpen, mine }) {
  const q = useAsync(() => api.get('/api/me/reviews/history'), []);
  const d = q.data;
  if (q.error) return <div className="card">{s.loadErr}</div>;
  if (!d) return <div className="card rv-note">…</div>;
  const label = (v) => { const i = (options || []).indexOf(v); const zh = i >= 0 ? (optionsZh || [])[i] : null; return lang === 'zh' && zh ? zh : v; };
  const items = d.items || [];
  if (!items.length) return <div className="card rv-empty">{s.histEmpty}</div>;
  const summary = <MyPerfSummary s={s} lang={lang} mine={mine} items={items} label={label} onOpen={onOpen} />;
  const years = [...new Set(items.map((i) => i.year))].sort().reverse();
  const quarters = items.filter((i) => i.kind !== 'annual').slice(0, 8).reverse();
  const scale = RATING_ORDER.filter((r) => (options || RATING_ORDER).includes(r));
  const W = 560, H = 120, pad = 28;
  const x = (i) => pad + (quarters.length > 1 ? (i * (W - pad * 2)) / (quarters.length - 1) : (W - pad * 2) / 2);
  const y = (r) => { const k = scale.indexOf(r); return k < 0 ? H - 20 : 16 + (k * (H - 40)) / Math.max(1, scale.length - 1); };
  return (
    <div className="rv-hist">
      {summary}
      <p className="rv-note">{s.histLead}</p>
      {quarters.length > 1 && (
        <div className="card rv-card">
          <div className="rv-lab">{s.histTrend}</div>
          <svg className="rv-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={s.histTrend}>
            {scale.map((r) => <g key={r}><line x1={pad} x2={W - pad} y1={y(r)} y2={y(r)} className="rv-trend-grid" /><text x={6} y={y(r) + 4} className="rv-trend-lab">{r}</text></g>)}
            <polyline points={quarters.map((q2, i) => `${x(i)},${y(q2.rating)}`).join(' ')} className="rv-trend-line" />
            {quarters.map((q2, i) => <circle key={q2.id} cx={x(i)} cy={y(q2.rating)} r={4} className="rv-trend-dot"><title>{`${q2.cycle} · ${q2.rating}`}</title></circle>)}
          </svg>
        </div>
      )}
      {years.map((yr) => (
        <div key={yr} className="rv-year">
          <h2 className="rv-sec">{yr}</h2>
          <div className="rv-year-grid">
            {items.filter((i) => i.year === yr).map((i) => (
              <div key={i.id} className={'card rv-card rv-histcard' + (i.kind === 'annual' ? ' annual' : '')}>
                <div className="rv-head">
                  <b className="rv-cycle">{i.cycle}</b>
                  {i.kind === 'annual' && <span className="pill muted">{s.histAnnual}</span>}
                  <span className="rv-hist-rating">{label(i.rating)}</span>
                </div>
                {i.managerText && <><div className="rv-lab">{s.histComment}</div><div className="rv-quote">{i.managerText}</div></>}
                {i.highlights && <><div className="rv-lab">{s.histHighlights}</div><div className="rv-quote">{i.highlights}</div></>}
                <AppealLine appeal={i.appeal} lang={lang} onOpen={() => onOpen(i.id)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
