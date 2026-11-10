// 部门校准（第二批 2.2 / 2.7，2026-10-08）：员工端 HoD「部门校准」与后台 HR「部门明细」共用同一个组件，所以不 import Semi。
//
// <DeptCalibration
//   mode="hod" | "hr"  lang
//   view={reviewCalibView}                 // 服务端契约（设计 1.4）：{ cycle, dept, rows, deptOptions, ratingOptions…, today }
//   query={obj} onQuery={(patch) => {}}     // 筛选键（urlstate.js REVIEW_FILTER_KEYS），宿主写进地址栏
//   ready                                   // 数据已按当前地址加载好（缺省 true）；为 false 时不校验地址栏参数（审查 P1-8）
//   onSaveAll={async (changes) => ({ ok, view } | { errors:[{id,code}] })}   // 仅 hod；changes 每行带 expect（审查 P1-4）
//   onSubmit={async () => {}}               // 仅 hod
//   onRemindManagers={async (itemIds) => bulkResult}   // hod 必传；hr 有 performance 写权限时传
//   onCalibrateRow={(row) => {}}            // hr：只对 row.editable 的行出现「校准」，宿主弹出现有的理由框
//   actions={ReactNode}                     // hr：确认 / 退回 + 原因说明
//   renderDetail={(row) => ReactNode}       // hr：ItemDetail；hod：一般不传 —— 服务端已把自评放在 row.selfReview 里
//   loadSelf={async (row) => selfReview}    // hod：仅当行里没有 selfReview 时按需拉（{ prevGoals, selfOutcomes, selfChallenges, selfFeedback, goalsNext }；
//                                           // 是否已交按 row.selfAt 判断）
// hod 模式「查看自评」只对 row.proxyEligible（可代评）或已代评的行出现，与服务端下发 selfReview 的口径一致（审查 P1-5）。
//   personHref={(row) => string|null}       // hr 且可读 people 时为 /admin/people/:userId；hod 不传
//   managerEntryHref={(row) => string|null} // hod：HoD 本人就是直属上级时，指向团队评估的单人页
//   onDirtyChange={(bool) => {}}
// />
// 草稿按「周期 + 一级部门」存进 sessionStorage（审查 P1-6），有草稿时启用离开守卫；宿主切页签、切部门组之前调用
// useLeaveGuard.js 的 confirmLeave()。地址栏只放筛选键，点阻断项「只看这些人」是组件内部状态。
// 波次 3（10/8）：hr 头部「已确认 · 本地时间 · 确认人」（view.dept.status.hrName）；hr 模式无 HoD 的组列头写「校准评级」、
// 不给「HoD 代评」筛选；已关闭周期的行带 recordRating 时，配额条、档位、排序、进度按档案评级（deptcal.ratingOf）并加说明。
import Overlay from './Overlay.jsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { canWriteDomain } from '../rbac.js';
import DeptFilter, { deptFilterInvalidText } from './DeptFilter.jsx';
import { useLeaveGuard } from './useLeaveGuard.js';
import * as dc from '../deptcal.js';
import DeptCalibOverview from './DeptCalibOverview.jsx';
import { whyText, issueText, noticeText, errCodeText } from '../reviewcodes.js';

const T = {
  zh: {
    saveAll: (n) => `保存全部修改（${n}）`, submit: '提交部门评级', saveFirst: '请先保存修改', submitAsk: '提交部门评级？', submitAskBody: '提交后本部门的评级交 HR 确认，直属上级与你都不能再修改（HR 退回后才能再改）。', cancel: '取消',
    onlyPending: '只看待处理', flat: '平铺',
    proxy: 'HoD 代评', proxyReason: '代评理由（必填）', adjReason: '调整理由（必填）', reasonOpt: '理由（选填）',
    checkComment: '请核对上级评语是否仍与调整后的评级一致',
    mgrDeparted: '上级已离职', noMgr: '无直属上级', notCounted: '已离职 · 不计入', hodSelf: 'HoD 本人 · 不计入',
    remind: '提醒他们的上级', hrReadonly: 'HR 只读：如需修改，请退回 HoD。', hrWaitHod: '等待 HoD 提交校准；提交后 HR 再确认。', goDepts: '去部门页指定负责人', askOwner: '请联系有部门管理权限的同事在部门页指定负责人。',
    fDept: '子部门', fMgr: '直属上级', fLv: '职级', fOne: '面谈', fMr: '上级评级', fAdj: '调整', fHl: '缺关键亮点', fOd: '逾期未完成',
    fSort: '排序', fSearch: '搜索姓名或工号',
    mgrAll: '全部直属上级', lvAll: '全部职级', lvGrade: (g) => `职等 ${g}`, lvGroupGrade: '职等', lvGroupRank: '职级', lvNone: '未设职级', lvNoGrid: '未纳入职级体系',
    oneAll: '全部面谈状态', one_both: '双方已登记', one_mgr: '仅上级登记', one_emp: '仅员工登记', one_none: '未登记',
    mrAll: '全部上级评级', mrNone: '上级未评',
    adjAll: '全部（调整）', adjAdj: '已调整', adjProxy: 'HoD 代评', adjNo: '未调整',
    odAll: '全部（逾期）', odAny: '有逾期', odSelf: '自评逾期', odRate: '评级逾期',
    sortName: '按姓名', sortRating: '按评级高低', sortDept: '按部门',
    clearFilters: '清除筛选', filters: (n) => (n ? `筛选（${n}）` : '筛选'),
    onlyIds: (label, n) => `只看：${label}（${n} 人）`, showAll: '显示全部',
    quotaTitle: '评级分布与配额', quotaCell: (c, a) => `${c} / 名额 ${a}`, quotaOver: '超额', quotaRef: '超出参考', quotaRefNote: 'A+ / A / B+ 为配额上限（超额不能提交）；其余档位的名额是参考值，超出只提示不拦截。', quotaSmall: (n) => `人数少于 ${n}，超额只提示不拦截`,
    progSelf: (a, b) => `自评 ${a}/${b}`, progOne: (a, b) => `面谈 ${a}/${b}`, progRated: (a, b) => `已评级 ${a}/${b}`,
    scopePartial: '部门有成员不在你的数据范围内：配额、阻断项与人数不显示。',
    colName: '姓名', colMgr: '直属上级', colSelf: '自评', colOne: '面谈', colMgrRating: '上级评级', colHod: 'HoD 评级', colAnnual: '年度评级', colReason: '理由', colAct: '操作',
    colCalib: '校准评级', hrNoHod: '该部门没有 HoD，由 HR 直接校准并确认。', noDept1: '未归入一级部门',
    closedOnFile: '周期已关闭：评级分布、档位筛选、排序与进度按档案里现在的评级统计（含关闭后的修改）。',
    selfDone: (d) => `已交 · ${d}`, selfNone: '未交', sameAsMgr: (r) => `同上级（${r}）`,
    adjusted: '已调整', overQuota: '超额档', overdueSelf: '自评逾期', overdueRate: '评级逾期', lockedOther: '已随原部门锁定', unsaved: '未保存',
    amended: (x) => `已改动（原评级 ${x}）`,
    groupCount: (n) => `${n} 人`, groupRated: (r, t) => `已评 ${r}/${t}`, expand: '展开', collapse: '收起',
    viewSelf: '查看自评', hideSelf: '收起自评', selfLoading: '自评加载中…', selfLoadErr: '自评加载失败', noSelf: '尚未提交自评',
    selfOutcome: (n) => `目标 ${n} 关键成果`, selfChallenges: '遇到的挑战', selfFeedback: '对团队/公司的建议', selfGoals: '下一周期目标',
    calibrate: '校准', profile: '档案',
    gateNotOverdue: (d) => (d ? `上级在职，评级截止 ${d} 后才能代评` : '上级在职，暂不能代评'), gateUseMgr: '你是此人的直属上级，请在「团队评估」里评级', toTeam: '去评级',
    saved: (n) => `已保存 ${n} 项修改`, submitted: '已提交给 HR', fixRows: (n) => `${n} 行需要处理，未保存`,
    remindDone: (n) => `已为 ${n} 人提醒上级`, remindNone: '没有发出提醒', remindSkipped: (n) => `${n} 人未提醒：`,
    restored: (n) => `已恢复上次未保存的 ${n} 项修改`, discard: '放弃这些修改', discardAll: '放弃全部未保存的修改',
    dropped: (n) => `${n} 项未保存的修改已移除：此人的评级或状态在此期间有变动，请核对后重新填写。`,
    unsavedLeave: '有未保存的修改，确定离开？',
    hodSubmitted: (d) => `已提交 · ${d}`, confirmedAt: (d) => `HR 已确认 · ${d}`, returned: (r) => `HR 退回：${r}`,
    confirmedHr: (d, who) => `已确认 · ${d}${who ? ` · ${who}` : ''}`,
    kindQuarter: '季度', kindAnnual: '年度', headcount: (n) => `计入 ${n} 人`, departedN: (n) => `已离职 ${n} 人（不计入）`, dueRate: (d) => `评级截止 ${d}`,
    annualLead: '年度评级由你为本部门每位成员提出，提交后由 HR 审核。',
    empty: '没有符合筛选条件的人。', err: '操作失败：', invalidFilter: '有筛选条件已失效，已清除。', loading: '加载中…',
  },
  en: {
    saveAll: (n) => `Save all changes (${n})`, submit: 'Submit department ratings', saveFirst: 'Save your changes first', submitAsk: 'Submit department ratings?', submitAskBody: 'After submission the ratings go to HR for confirmation; neither managers nor you can change them until HR returns the department.', cancel: 'Cancel',
    onlyPending: 'Pending only', flat: 'Flat list',
    proxy: 'Rated by HoD', proxyReason: 'Reason for rating on behalf (required)', adjReason: 'Reason for adjustment (required)', reasonOpt: 'Reason (optional)',
    checkComment: 'Check that the manager’s comment still fits the adjusted rating',
    mgrDeparted: 'Manager has left', noMgr: 'No direct manager', notCounted: 'Left · not counted', hodSelf: 'HoD (self) · not counted',
    remind: 'Remind their managers', hrReadonly: 'HR view is read-only. Return the department to its HoD for changes.', hrWaitHod: 'Waiting for the HoD to submit the calibration; HR confirms after that.', goDepts: 'Set the department owner', askOwner: 'Ask a colleague who can manage departments to set the department owner on the Departments page.',
    fDept: 'Sub-department', fMgr: 'Manager', fLv: 'Job level', fOne: '1-on-1', fMr: 'Manager rating', fAdj: 'Adjusted', fHl: 'Highlights missing', fOd: 'Overdue',
    fSort: 'Sort', fSearch: 'Search name or employee ID',
    mgrAll: 'All managers', lvAll: 'All job levels', lvGrade: (g) => `Grade ${g}`, lvGroupGrade: 'Job grade', lvGroupRank: 'Job level', lvNone: 'No job level', lvNoGrid: 'Not in job grade structure',
    oneAll: 'Any 1-on-1 status', one_both: 'Logged by both', one_mgr: 'Manager only', one_emp: 'Employee only', one_none: 'Not logged',
    mrAll: 'Any manager rating', mrNone: 'Not rated by manager',
    adjAll: 'Any adjustment', adjAdj: 'Adjusted', adjProxy: 'Rated by HoD', adjNo: 'Not adjusted',
    odAll: 'Any deadline status', odAny: 'Overdue', odSelf: 'Self-review overdue', odRate: 'Rating overdue',
    sortName: 'By name', sortRating: 'By rating', sortDept: 'By department',
    clearFilters: 'Clear filters', filters: (n) => (n ? `Filters (${n})` : 'Filters'),
    onlyIds: (label, n) => `Showing: ${label} (${n})`, showAll: 'Show all',
    quotaTitle: 'Rating distribution and quota', quotaCell: (c, a) => `${c} / quota ${a}`, quotaOver: 'Over', quotaRef: 'Above guide', quotaRefNote: 'A+ / A / B+ are hard quotas (over-quota blocks submission); the other tiers are guide numbers — exceeding them is flagged, not blocked.', quotaSmall: (n) => `Fewer than ${n} people: over-quota is a warning only`,
    progSelf: (a, b) => `Self-reviews ${a}/${b}`, progOne: (a, b) => `1-on-1s ${a}/${b}`, progRated: (a, b) => `Rated ${a}/${b}`,
    scopePartial: 'Some members of this department are outside your data scope, so quota, blockers and headcount are not shown.',
    colName: 'Name', colMgr: 'Manager', colSelf: 'Self-review', colOne: '1-on-1', colMgrRating: 'Manager rating', colHod: 'HoD rating', colAnnual: 'Annual rating', colReason: 'Reason', colAct: 'Actions',
    colCalib: 'Calibrated rating', hrNoHod: 'This department has no HoD. HR calibrates and confirms it directly.', noDept1: 'No level-1 department',
    closedOnFile: 'This cycle is closed. The distribution, tier filter, sorting and progress use the rating on file, including changes made after closing.',
    selfDone: (d) => `Submitted · ${d}`, selfNone: 'Not submitted', sameAsMgr: (r) => `Same as manager (${r})`,
    adjusted: 'Adjusted', overQuota: 'Over-quota tier', overdueSelf: 'Self-review overdue', overdueRate: 'Rating overdue', lockedOther: 'Locked with previous department', unsaved: 'Unsaved',
    amended: (x) => `Changed (was ${x})`,
    groupCount: (n) => `${n} ${n === 1 ? 'person' : 'people'}`, groupRated: (r, t) => `Rated ${r}/${t}`, expand: 'Expand', collapse: 'Collapse',
    viewSelf: 'View self-review', hideSelf: 'Hide self-review', selfLoading: 'Loading self-review…', selfLoadErr: 'Couldn’t load the self-review', noSelf: 'Self-review not submitted yet',
    selfOutcome: (n) => `Goal ${n} key outcomes`, selfChallenges: 'Challenges encountered', selfFeedback: 'Suggestions for the team/company', selfGoals: 'Goals for the next cycle',
    calibrate: 'Calibrate', profile: 'Profile',
    gateNotOverdue: (d) => (d ? `The manager is active. You can rate on their behalf after the rating deadline (${d})` : 'The manager is active, so you can’t rate on their behalf yet'),
    gateUseMgr: 'You are this person’s direct manager. Rate them under Team reviews', toTeam: 'Rate now',
    saved: (n) => `Saved ${n} change${n === 1 ? '' : 's'}`, submitted: 'Submitted to HR', fixRows: (n) => `${n} row${n === 1 ? '' : 's'} need attention. Nothing was saved`,
    remindDone: (n) => `Reminded the managers of ${n} ${n === 1 ? 'person' : 'people'}`, remindNone: 'No reminder was sent', remindSkipped: (n) => `${n} not reminded:`,
    restored: (n) => `Restored ${n} unsaved change${n === 1 ? '' : 's'} from earlier`, discard: 'Discard them', discardAll: 'Discard all unsaved changes',
    dropped: (n) => `Removed ${n} unsaved change${n === 1 ? '' : 's'}: the rating or status changed in the meantime. Check and enter ${n === 1 ? 'it' : 'them'} again.`,
    unsavedLeave: 'You have unsaved changes. Leave anyway?',
    hodSubmitted: (d) => `Submitted · ${d}`, confirmedAt: (d) => `Confirmed by HR · ${d}`, returned: (r) => `Returned by HR: ${r}`,
    confirmedHr: (d, who) => `Confirmed · ${d}${who ? ` · ${who}` : ''}`,
    kindQuarter: 'Quarterly', kindAnnual: 'Annual', headcount: (n) => `${n} counted`, departedN: (n) => `${n} left (not counted)`, dueRate: (d) => `Rating due ${d}`,
    annualLead: 'You propose the annual rating for every member of the department; HR reviews it after you submit.',
    empty: 'Nobody matches these filters.', err: 'Couldn’t complete: ', invalidFilter: 'A filter no longer applied and was cleared.', loading: 'Loading…',
  },
};

const FILTER_KEYS = ['q', 'dept', 'mgr', 'lv', 'one', 'mr', 'adj', 'hl', 'od', 'tier', 'pending', 'sort', 'flat'];
const ENUMS = { one: dc.ONE_STATES, adj: ['adj', 'proxy', 'no'], od: ['1', 'self', 'rate'], sort: ['name', 'rating', 'dept'], hl: ['1'], pending: ['1'], flat: ['1'] };
const EMPTY = {};
const day = (v) => dc.localDay(v);
const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

// 句子里的日期包进 .u-date（不折行）；词典保持纯字符串（dict-pairs 按纯 JS 求值），这里按日期原文切开
function withDate(text, d) {
  const i = d ? String(text).indexOf(d) : -1;
  if (i < 0) return text;
  return <>{text.slice(0, i)}<span className="u-date">{d}</span>{text.slice(i + d.length)}</>;
}

export default function DeptCalibration({
  mode = 'hod', lang = 'zh', view, query, onQuery, ready = true,
  onSaveAll, onSubmit, onRemindManagers, onCalibrateRow, actions, renderDetail, loadSelf,
  personHref, managerEntryHref, onDirtyChange,
}) {
  // ---- 所有 hook 都在任何提前 return 之前（审查 P1-17）----
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  // CX-226：「去部门页指定负责人」只给有员工与组织写权限的人；没有的写「请联系…」
  const { user: me } = useAuth();
  const canSetOwner = canWriteDomain(me, 'people');
  const isHod = mode === 'hod';
  const q = query || EMPTY;
  const cycle = (view && view.cycle) || EMPTY;
  const dept = (view && view.dept) || EMPTY;
  const rows = useMemo(() => (view && Array.isArray(view.rows) ? view.rows : []), [view]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const kind = cycle.kind === 'annual' ? 'annual' : 'quarter';
  const annual = kind === 'annual';
  const locked = !!dept.locked;
  const unit = dept.unit || dept.dept1Id || '';
  const storeKey = isHod && cycle.id && unit ? `dcal:${cycle.id}:${unit}` : null;
  const hlRatings = (view && view.highlightRatings) || dc.HL_RATINGS;
  // hr 模式里没有 HoD 的组：HR 直接校准、直接确认 —— 列头写「校准评级」，筛选里不出现「HoD 代评」（波次 3）
  const hrNoHod = !isHod && dc.noHodOf(dept);
  // 评级列：年度 = 年度评级；hr 模式无 HoD 的组 = 校准评级（HR 校准）；其余 = HoD 评级
  const rateCol = annual ? s.colAnnual : hrNoHod ? s.colCalib : s.colHod;
  // 已关闭周期的后台行带 recordRating：计数、档位、排序、进度按档案评级（dc.ratingOf，波次 3 与后台列表同一口径）
  const onFile = useMemo(() => cycle.status === 'closed' && rows.some((r) => r.recordRating !== undefined), [cycle.status, rows]);
  const ctx = useMemo(() => ({ kind, hodId: dept.hod && dept.hod.id, today: view && view.today, dueRateAt: cycle.dueRateAt }), [kind, dept.hod, view, cycle.dueRateAt]);

  const [ds, setDs] = useState({ key: null, drafts: {} });
  const drafts = ds.key === storeKey && storeKey ? ds.drafts : EMPTY;
  const [restoredN, setRestoredN] = useState(0);
  const [rowErrors, setRowErrors] = useState({});
  const [only, setOnly] = useState(null);          // { label, ids:Set }
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [open, setOpen] = useState(() => new Set());
  const [selfCache, setSelfCache] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);            // { err, text }
  const [asking, setAsking] = useState(false);     // CX-046：提交前二次确认（员工端对话框，不用 Semi）
  const [remind, setRemind] = useState(null);      // remindSummary
  const [note, setNote] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // 草稿：换「周期 + 一级部门」时从 sessionStorage 恢复（只留还能改的行）
  useEffect(() => {
    if (!storeKey) return;
    if (ds.key === storeKey) return;
    let saved = {};
    try { saved = JSON.parse(window.sessionStorage.getItem(storeKey) || '{}') || {}; } catch { saved = {}; }
    const clean = dc.sanitizeDrafts(saved, rows);
    const stale = Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([id, d]) => dc.staleDraft(rowById.get(id), d)).length;
    setDs({ key: storeKey, drafts: clean });
    setRestoredN(Object.keys(clean).length);
    setRowErrors({}); setOnly(null); setMsg(null); setRemind(null); setOpen(new Set()); setSelfCache({});
    setNote(stale ? s.dropped(stale) : '');
    // rows 随 view 一起到达；只在 key 变化时恢复
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey]);
  // 同一「周期 + 一级部门」的数据刷新了（宿主重新拉了 view）：草稿按新数据重新核对 —— base 对不上（上级或 HoD 评级在此期间变了）、
  // 行已不能改（离职、随原部门锁定）的草稿移除并提示，不拿新值悄悄当 expect（审查）。保存中由 saveAll 自己清草稿。
  useEffect(() => {
    if (!storeKey || ds.key !== storeKey || busy === 'save') return;
    const n0 = Object.keys(ds.drafts).length;
    if (!n0) return;
    const clean = dc.sanitizeDrafts(ds.drafts, rows);
    const left = Object.keys(clean).length;
    if (left === n0) return;
    setDs({ key: storeKey, drafts: clean });
    setRestoredN((n) => Math.min(n, left));
    setNote(s.dropped(n0 - left));
    // 只跟随 rows（view 换了）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  useEffect(() => {
    if (!storeKey || ds.key !== storeKey) return;
    try {
      if (Object.keys(ds.drafts).length) window.sessionStorage.setItem(storeKey, JSON.stringify(ds.drafts));
      else window.sessionStorage.removeItem(storeKey);
    } catch { /* 隐私模式等：只是不能恢复 */ }
  }, [ds, storeKey]);

  const changes = useMemo(() => (isHod ? dc.buildChanges(rows, drafts) : []), [isHod, rows, drafts]);
  const dirty = changes.length > 0;
  useEffect(() => { if (onDirtyChange) onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useLeaveGuard(isHod && dirty, s.unsavedLeave);

  const applied = useMemo(() => dc.applyDrafts(rows, drafts, { kind }), [rows, drafts, kind]);
  const partial = !!dept.scopePartial || dept.allowed === null;
  const quota = useMemo(() => (partial ? null : dc.quotaPreview(rows, dept.allowed, drafts, { kind })), [partial, rows, dept.allowed, drafts, kind]);
  const tiers = useMemo(() => dc.tiersOf(dept.allowed, quota ? quota.counts : dept.counts), [dept.allowed, dept.counts, quota]);
  const mgrOpts = useMemo(() => dc.managerOptions(rows), [rows]);
  const lvOpts = useMemo(() => dc.levelOptions(rows), [rows]);
  const progress = useMemo(() => dc.progressOf(applied), [applied]);
  const filtered = useMemo(() => dc.filterRows(applied, q, drafts, { ids: only ? only.ids : null, overTiers: quota ? quota.overTiers : null, highlightRatings: hlRatings, kind }),
    [applied, q, drafts, only, quota, hlRatings, kind]);
  const sorted = useMemo(() => dc.sortRows(filtered, q.sort), [filtered, q.sort]);
  const groups = useMemo(() => (q.flat === '1' ? null : dc.groupByManager(sorted)), [sorted, q.flat]);
  const activeFilters = FILTER_KEYS.filter((k) => k !== 'sort' && k !== 'flat' && has(q[k])).length;

  const label = useCallback((v) => {
    if (!v) return '';
    const opts = (view && view.ratingOptions) || [];
    const i = opts.indexOf(v);
    const zh = i >= 0 ? ((view && view.ratingOptions_zh) || [])[i] : null;
    return lang === 'zh' && zh ? zh : v;
  }, [view, lang]);

  // 地址栏里的筛选值只在数据就绪后校验（审查 P1-8）。部门另由 DeptFilter 的 onInvalid 处理，但没有下级部门时 DeptFilter
  // 不渲染，这里也核一遍（不在 deptOptions 里的 id → 清掉，审查）；年度周期没有自评，od=self 清掉
  useEffect(() => {
    if (!ready || !view || !onQuery) return;
    const patch = {};
    if (has(q.mgr) && q.mgr !== dc.NONE && !mgrOpts.some((m) => m.id === String(q.mgr))) patch.mgr = null;
    if (has(q.lv) && !lvOpts.some((o) => o.value === q.lv)) patch.lv = null;
    if (has(q.tier) && !tiers.includes(q.tier)) patch.tier = null;
    if (has(q.mr) && q.mr !== 'none' && !((view.ratingOptions || dc.RATING_ORDER).includes(q.mr))) patch.mr = null;
    for (const [k, vals] of Object.entries(ENUMS)) if (has(q[k]) && !vals.includes(q[k])) patch[k] = null;
    if (annual && q.od === 'self') patch.od = null;
    if (hrNoHod && q.adj === 'proxy') patch.adj = null;
    if (has(q.dept)) {
      const opts = Array.isArray(view.deptOptions) ? view.deptOptions : [];
      if (!opts.length || (q.dept !== dc.NONE && !opts.some((o) => String(o.id) === String(q.dept)))) patch.dept = null;
    }
    if (Object.keys(patch).length) { onQuery(patch); setNote(s.invalidFilter); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, view, annual, hrNoHod, q.dept, q.mgr, q.lv, q.tier, q.mr, q.one, q.adj, q.od, q.sort, q.hl, q.pending, q.flat]);

  const setQ = (patch) => { if (onQuery) onQuery(patch); };
  const setDraft = (shown, patch) => {
    const row = rowById.get(shown.id) || shown;   // 草稿与「已保存的值」比，不与合成后的行比
    setDs((prev) => {
      const base = prev.key === storeKey ? prev.drafts : {};
      // 第一次改这一行时记下 base（服务端现在的上级评级与 HoD 评级），保存时按它发 expect
      const cur = base[row.id] || { rating: row.finalRating || null, reason: row.hodText || '', base: dc.draftBaseOf(row) };
      const next = { ...cur, ...patch };
      const out = { ...base };
      if (dc.draftDirty(row, next)) out[row.id] = next; else delete out[row.id];
      return { key: storeKey, drafts: out };
    });
    if (rowErrors[row.id]) setRowErrors((e) => { const n = { ...e }; delete n[row.id]; return n; });
    setMsg(null);
  };
  const discardDrafts = () => { setDs({ key: storeKey, drafts: {} }); setRestoredN(0); setRowErrors({}); setMsg(null); };

  const errMsg = (err) => {
    const code = err && err.data && err.data.code;
    const t = code ? errCodeText(lang, code, err.data && Array.isArray(err.data.errors) ? err.data.errors.length : 0) : null;
    return t || (err && err.message) || errCodeText(lang, 'generic');
  };

  const saveAll = async () => {
    if (!onSaveAll || !changes.length) return;
    const local = dc.validateChanges(rows, changes, ctx);
    if (Object.keys(local).length) {
      setRowErrors(local);
      setMsg({ err: true, text: s.fixRows(Object.keys(local).length) });
      return;
    }
    setBusy('save'); setMsg(null);
    try {
      const r = await onSaveAll(changes);
      if (r && Array.isArray(r.errors) && r.errors.length) {
        setRowErrors(Object.fromEntries(r.errors.map((e) => [e.id, e.code])));
        setMsg({ err: true, text: s.fixRows(r.errors.length) });
      } else {
        const n = changes.length;
        setDs({ key: storeKey, drafts: {} }); setRestoredN(0); setRowErrors({});
        setMsg({ err: false, text: s.saved(n) });   // CX-045：页内 rv-msg「已保存 n 项修改」（员工端不用 Semi toast）
      }
    } catch (err) {
      const errs = err && err.data && Array.isArray(err.data.errors) ? err.data.errors : null;
      if (errs && errs.length) {
        setRowErrors(Object.fromEntries(errs.map((e) => [e.id, e.code])));
        setMsg({ err: true, text: s.fixRows(errs.length) });
      } else setMsg({ err: true, text: s.err + errMsg(err) });
    }
    setBusy('');
  };
  const doSubmit = async () => {
    setBusy('submit'); setMsg(null);
    try { await onSubmit(); setMsg({ err: false, text: s.submitted }); }
    catch (err) { setMsg({ err: true, text: s.err + errMsg(err) }); }
    setBusy('');
  };
  // CX-046（2026-10-10）：不可逆动作先二次确认
  const submit = () => {
    if (!onSubmit || dirty) return;
    setAsking(true);
  };
  const doRemind = async (ids) => {
    if (!onRemindManagers || !ids || !ids.length) return;
    setBusy('remind'); setRemind(null); setMsg(null);
    try { setRemind(dc.remindSummary(await onRemindManagers(ids))); }
    catch (err) { setMsg({ err: true, text: s.err + errMsg(err) }); }
    setBusy('');
  };
  const toggleOpen = async (row) => {
    const next = new Set(open);
    if (next.has(row.id)) { next.delete(row.id); setOpen(next); return; }
    next.add(row.id); setOpen(next);
    const inline = isHod && row.selfReview && typeof row.selfReview === 'object';
    if (!inline && !renderDetail && loadSelf && !selfCache[row.id]) {
      setSelfCache((c) => ({ ...c, [row.id]: { loading: true } }));
      try { const data = await loadSelf(row); setSelfCache((c) => ({ ...c, [row.id]: { data } })); }
      catch { setSelfCache((c) => ({ ...c, [row.id]: { error: true } })); }
    }
  };

  if (!view) return <div className="card rv-note">{s.loading}</div>;

  // ---------- 渲染 ----------
  const st = dept.status && typeof dept.status === 'object' ? dept.status : null;
  // hod：提交前的阻断项（dept.issues）；hr：HR 确认前的阻断项（dept.confirmIssues，与确认接口同一函数 —— self_missing 等只拦 HoD 提交，审查）
  // CX-171：HoD 待确认 / 部门已停用的原因已在确认区写明（唯一一句、对应「去部门页指定负责人」），这里不再重复成徽标
  const issues = (Array.isArray(isHod ? dept.issues : dept.confirmIssues) ? (isHod ? dept.issues : dept.confirmIssues) : [])
    .filter((x) => isHod || (x && x.code !== 'hod_unresolved' && x.code !== 'dept_inactive'));
  const notices = Array.isArray(dept.notices) ? dept.notices : [];
  const blocking = issues.length > 0;
  const showIds = (labelText, ids) => setOnly({ label: labelText, ids: new Set(ids || []) });
  // hod：只对可代评（proxyEligible）或已代评的行给「查看自评」—— 服务端只给这些行下发 selfReview（审查 P1-5）。r 是合成草稿后的行，
  // 资格看服务端原行
  const canSeeSelf = (r) => {
    if (!isHod) return !!renderDetail;
    if (annual || !dc.isCounted(r)) return false;
    const o = rowById.get(r.id) || r;
    if (!(o.proxyEligible || dc.proxyOf(o))) return false;
    return !!((o.selfReview && typeof o.selfReview === 'object') || renderDetail || loadSelf);
  };
  // 列：姓名、HoD/年度评级、理由、操作 + 平铺时的直属上级 + 季度的自评、面谈、上级评级（年度没有自评这一步）
  const colCount = 4 + (q.flat === '1' ? 1 : 0) + (annual ? 0 : 3);

  const tierCell = (t) => {
    const c = quota ? quota.counts[t] || 0 : (dept.counts || {})[t] || 0;
    const a = dept.allowed ? dept.allowed[t] : null;
    const over = quota ? quota.overTiers.has(t) : (dept.over || []).some((o) => o.tier === t);
    // CX-039（负责人 2026-10-10：不做硬约束）：非上限档位超出名额 → 软提示「超出参考」（琥珀色），不进 overTiers、不拦截提交
    const soft = !over && !dc.QUOTA_CAPPED.includes(t) && a !== null && a !== undefined && c > Number(a);
    const on = q.tier === t;
    return (
      <button key={t} type="button" className={'dcal-tier' + (over ? ' over' : '') + (soft ? ' over-soft' : '') + (on ? ' on' : '')} aria-pressed={on}
        onClick={() => setQ({ tier: on ? null : t })}>
        <b>{t}</b>
        <span className="tnum">{a === null || a === undefined ? c : s.quotaCell(c, a)}</span>
        {over && <em>{s.quotaOver}</em>}
        {soft && <em>{s.quotaRef}</em>}
      </button>
    );
  };

  const selfPack = (r, data) => {
    const d = data || r;
    if (!d || !d.selfAt) return <div className="rv-pack"><div className="rv-pack-none">{s.noSelf}</div></div>;
    const prev = Array.isArray(d.prevGoals) ? d.prevGoals : [];
    const item = (k, v) => (has(v) ? <div className="rv-pack-row" key={k}><b>{k}</b><br /><span>{v}</span></div> : null);
    return (
      <div className="rv-pack dcal-self">
        {(Array.isArray(d.selfOutcomes) ? d.selfOutcomes : []).map((o, i) => item(`${s.selfOutcome(i + 1)}${prev[i] ? ` · ${String(prev[i]).slice(0, 40)}` : ''}`, o))}
        {item(s.selfChallenges, d.selfChallenges)}
        {item(s.selfFeedback, d.selfFeedback)}
        {Array.isArray(d.goalsNext) && d.goalsNext.length > 0 && item(s.selfGoals, d.goalsNext.map((g, i) => `${i + 1}. ${g}`).join('\n'))}
      </div>
    );
  };
  const detailOf = (r) => {
    const o = rowById.get(r.id) || r;
    if (isHod && o.selfReview && typeof o.selfReview === 'object') return selfPack(o, { selfAt: o.selfAt, ...o.selfReview });
    if (renderDetail) return renderDetail(r);
    const c = selfCache[r.id];
    if (c && c.loading) return <div className="rv-hint">{s.selfLoading}</div>;
    if (c && c.error) return <div className="rv-msg err">{s.selfLoadErr}</div>;
    return selfPack(o, c && c.data ? { selfAt: o.selfAt, ...c.data } : null);
  };

  const renderRow = (r) => {
    const counted = dc.isCounted(r);
    const proxy = dc.proxyOf(r);
    const one = dc.oneStateOf(r);
    const od = Array.isArray(r.overdue) ? r.overdue : [];
    const eff = dc.ratingOf(r);
    const overTier = counted && eff && (quota ? quota.overTiers.has(dc.bucketOf(eff)) : !!r.overQuota);
    const editable = isHod && !locked && counted && r.editable !== false && !r.locked;
    const orig = rowById.get(r.id) || r;           // 服务端的原值（r 已合成草稿）
    const gate = isHod ? dc.proxyGate(orig, ctx) : null;
    const draft = drafts[r.id];
    const rating = draft ? (draft.rating || '') : (orig.finalRating || '');
    const reason = draft ? draft.reason || '' : orig.hodText || '';
    const need = dc.reasonNeeded(r, rating, kind);
    const err = rowErrors[r.id];
    const href = personHref ? personHref(r) : null;
    const opened = open.has(r.id);
    const oneCls = one === 'both' ? 'ok' : one === 'none' ? 'muted' : 'warn';
    return [
      <tr key={r.id} className={'dcal-row' + (counted ? '' : ' is-off') + (r._draft ? ' is-dirty' : '') + (err ? ' is-err' : '')}>
        <td className="rv-td-name">
          <div className="dcal-who">
            {r._draft && <span className="dcal-dot" title={s.unsaved} aria-label={s.unsaved} />}
            {href ? <Link to={href} className="dcal-name"><b>{r.name}</b></Link> : <b className="dcal-name">{r.name}</b>}
            {/* 9.1（第三批）：员工端（HoD 部门校准）不显示工号；后台 HR 部门明细照旧显示。搜索两边都仍可按工号 */}
            {!isHod && <span className="rv-eid tnum">{r.employeeId}</span>}
          </div>
          {r.department && <div className="dcal-dept" title={r.department}>{r.department}{r.jobLevel ? ` · ${r.jobLevel}` : ''}</div>}
          <div className="dcal-tags">
            {r.notCounted === 'departed' && <span className="pill muted">{s.notCounted}</span>}
            {r.notCounted === 'hod_self' && <span className="pill muted">{s.hodSelf}</span>}
            {proxy && <span className="pill warn">{s.proxy}</span>}
            {proxy === 'manager_departed' && <span className="pill muted">{s.mgrDeparted}</span>}
            {r.adjusted && !proxy && <span className="pill pri">{s.adjusted}</span>}
            {counted && !annual && dc.highlightsMissing(r, hlRatings) && <span className="pill warn">{s.fHl}</span>}
            {overTier && <span className="pill fail">{s.overQuota}</span>}
            {od.includes('self') && <span className="pill fail">{s.overdueSelf}</span>}
            {od.includes('rate') && <span className="pill fail">{s.overdueRate}</span>}
            {r.locked && !locked && <span className="pill muted">{s.lockedOther}</span>}
          </div>
        </td>
        {q.flat === '1' && (
          <td data-label={s.colMgr}>
            {r.manager || <span className="rv-eid">{s.noMgr}</span>}
            {r.managerStatus === 'departed' && <span className="pill muted dcal-ml">{s.mgrDeparted}</span>}
          </td>
        )}
        {!annual && <td data-label={s.colSelf}>{r.selfAt ? <span className="tnum">{s.selfDone(day(r.selfAt))}</span> : <span className="rv-eid">{s.selfNone}</span>}</td>}
        {!annual && <td data-label={s.colOne}><span className={'pill ' + oneCls}>{s['one_' + one]}</span></td>}
        {!annual && (
          <td data-label={s.colMgrRating}>
            {r.managerRating ? <span className="pill pri">{label(r.managerRating)}</span> : <span className="rv-eid">—</span>}
            {has(r.highlights) && <div className="rv-hl" title={r.highlights}>{r.highlights}</div>}
          </td>
        )}
        <td data-label={rateCol}>
          {isHod ? (
            <>
              <select className="rv-sel" value={rating} aria-label={annual ? s.colAnnual : s.colHod}
                disabled={!editable || busy !== '' || (!!gate && !orig.finalRating)}
                onChange={(e) => setDraft(r, { rating: e.target.value || null })}>
                <option value="">{!annual && r.managerRating ? s.sameAsMgr(label(r.managerRating)) : '—'}</option>
                {((view.ratingOptions) || dc.RATING_ORDER).map((o) => <option key={o} value={o}>{label(o)}</option>)}
              </select>
              {gate && editable && !orig.finalRating && (
                <div className="rv-hint dcal-gate">
                  {gate === 'use_manager_entry' ? s.gateUseMgr : withDate(s.gateNotOverdue(day(cycle.dueRateAt)), day(cycle.dueRateAt))}
                  {gate === 'use_manager_entry' && managerEntryHref && managerEntryHref(r) && <> <Link to={managerEntryHref(r)}>{s.toTeam}</Link></>}
                </div>
              )}
            </>
          ) : r.amendedFrom ? (
            // 2.6：已关闭周期里 HR 关闭后改过档案评级（服务端 hr 行的 recordRating / amendedFrom，只在后台下发）→ 显示档案里的评级并标原评级，
            // 与看板、整期导出一致（波次 2 复核修正）
            <>{r.recordRating ? <span className="pill pri">{label(r.recordRating)}</span> : <span className="rv-eid">—</span>}<span className="pill warn dcal-ml">{s.amended(label(r.amendedFrom))}</span></>
          ) : (
            r.finalRating ? <span className="pill pri">{label(r.finalRating)}</span> : <span className="rv-eid">—</span>
          )}
        </td>
        <td data-label={s.colReason}>
          {isHod && editable && (need || has(reason) || annual) ? (
            <input className={'rv-inp' + (need && !has(reason) ? ' dcal-need' : '')} value={reason} maxLength={1000}
              placeholder={need === 'proxy' ? s.proxyReason : need === 'adjust' ? s.adjReason : s.reasonOpt}
              aria-label={need === 'proxy' ? s.proxyReason : need === 'adjust' ? s.adjReason : s.reasonOpt}
              aria-required={!!need} disabled={busy !== ''} onChange={(e) => setDraft(r, { reason: e.target.value })} />
          ) : has(r.hodText) ? <span className="dcal-reason" title={r.hodText}>{r.hodText}</span> : <span className="rv-eid">—</span>}
          {/* 第二批 L2（负责人问题 1 待定，W2-B）：HoD 改了上级评级（未保存的调整）时提示核对上级评语，不拦保存。服务端没下发
              managerText 时也提示（看不到评语不等于没有评语）；上级评语为空串时不提示 */}
          {isHod && editable && r._draft && need === 'adjust' && orig.managerText !== '' && <div className="rv-hint dcal-gate dcal-cmt">{s.checkComment}</div>}
        </td>
        <td className="rv-rowact">
          {err && <span className="rv-msg err dcal-err">{errCodeText(lang, err) || err}</span>}
          {canSeeSelf(r) && <button type="button" className="rv-nudge" aria-expanded={opened} onClick={() => toggleOpen(r)}>{opened ? (isHod ? s.hideSelf : s.collapse) : (isHod ? s.viewSelf : s.expand)}</button>}
          {!isHod && onCalibrateRow && r.editable && <button type="button" className="rv-nudge" onClick={() => onCalibrateRow(r)}>{s.calibrate}</button>}
        </td>
      </tr>,
      opened ? <tr key={r.id + ':d'} className="dcal-detail"><td colSpan={colCount}>{detailOf(r)}</td></tr> : null,
    ];
  };

  // 各分组的表格列宽一致（桌面 table-layout:fixed；手机卡片化时不起作用）
  const flat = q.flat === '1';
  // 年度没有自评列
  const widths = annual ? (flat ? [28, 18, 22, 22, 10] : [34, 24, 28, 14])
    : (flat ? [20, 12, 12, 10, 11, 14, 12, 9] : [22, 14, 11, 12, 16, 15, 10]);
  const table = (list) => (
    <div className="rv-tbl-wrap">
      <table className="rv-tbl dcal-tbl">
        <colgroup>{widths.map((w, i) => <col key={i} style={{ width: w + '%' }} />)}</colgroup>
        <thead><tr>
          <th>{s.colName}</th>
          {q.flat === '1' && <th>{s.colMgr}</th>}
          {!annual && <th>{s.colSelf}</th>}
          {!annual && <th>{s.colOne}</th>}
          {!annual && <th>{s.colMgrRating}</th>}
          <th>{rateCol}</th>
          <th>{s.colReason}</th>
          <th aria-label={s.colAct} />
        </tr></thead>
        <tbody>{list.map(renderRow)}</tbody>
      </table>
    </div>
  );

  const ratingMissing = issues.find((i) => i.code === 'rating_missing' || i.code === 'manager_rating_missing');
  // hod：直属上级就是 HoD 本人的人不提醒（提醒只会发给自己；这些行走团队评估的上级入口，审查）
  const hodIdNow = dept.hod && dept.hod.id;
  const remindIds = ratingMissing && Array.isArray(ratingMissing.ids)
    ? ratingMissing.ids.filter((id) => { const r = rowById.get(id); return !(isHod && r && hodIdNow && String(r.managerId || '') === String(hodIdNow)); })
    : [];

  return (
    <div className={'dcal dcal-' + mode}>
      {asking && (
        <Overlay kind="exam" boxClassName="rv-ap-dialog" label={s.submitAsk} busy={busy !== ''} onClose={() => setAsking(false)}>
            <h3>{s.submitAsk}</h3>
            <p>{s.submitAskBody}</p>
            <div className="exam-dialog-act">
              <button type="button" className="btn ghost" onClick={() => setAsking(false)} disabled={busy !== ''}>{s.cancel}</button>
              <button type="button" className="btn" autoFocus disabled={busy !== ''} onClick={async () => { await doSubmit(); setAsking(false); }}>{s.submit}</button>
            </div>
        </Overlay>
      )}
      <div className="dcal-head">
        <b className="dcal-title">{dept.dept1 || s.noDept1}</b>
        <span className="rv-eid">{cycle.name}</span>
        <span className="pill muted">{annual ? s.kindAnnual : s.kindQuarter}</span>
        {!partial && typeof dept.headcount === 'number' && <span className="pill muted tnum">{s.headcount(dept.headcount)}</span>}
        {!partial && dept.departedN > 0 && <span className="pill muted tnum">{s.departedN(dept.departedN)}</span>}
        {!annual && cycle.dueRateAt && <span className="pill muted tnum">{s.dueRate(day(cycle.dueRateAt))}</span>}
        {/* 已确认：hr 模式写「已确认 · 本地时间 · 确认人」（O1，与后台部门确认列表同一写法；确认人读 status.hrName）；hod 模式「HR 已确认 · 时间」 */}
        {/* W3-C-CSS: .dcal-head .dcal-st — 头部状态 pill（已确认 · 时间 · 确认人）姓名长时在手机上换行：white-space:normal; text-align:left; line-height:1.4 */}
        {st && st.hrConfirmedAt ? <span className="pill ok tnum dcal-st">{isHod ? s.confirmedAt(dc.localStamp(st.hrConfirmedAt)) : s.confirmedHr(dc.localStamp(st.hrConfirmedAt), dc.confirmerOf(st))}</span>
          : st && st.hodSubmittedAt ? <span className="pill pri tnum dcal-st">{s.hodSubmitted(dc.localStamp(st.hodSubmittedAt))}</span> : null}
      </div>
      {annual && isHod && <p className="rv-note">{s.annualLead}</p>}
      {st && st.returnedAt && !st.hodSubmittedAt && <div className="rv-returned">{s.returned(st.returnReason || '')}</div>}
      {/* CX-221：HoD 还没提交时没有可退回的内容，写「等待 HoD 提交」；HoD 待确认时给直达部门页（按部门名搜索）的链接 */}
      {!isHod && dept.hodOwned && <p className="rv-note">{dept.status && dept.status.hodSubmittedAt ? s.hrReadonly : s.hrWaitHod}</p>}
      {!isHod && dept.hodUnresolved && dept.dept1 && <p className="rv-note">{canSetOwner ? <a href={`#/admin/departments?q=${encodeURIComponent(dept.dept1)}`}>{s.goDepts} →</a> : s.askOwner}</p>}
      {hrNoHod && <p className="rv-note">{s.hrNoHod}</p>}
      {onFile && <p className="rv-note">{s.closedOnFile}</p>}
      {partial && <p className="rv-note dcal-partial">{s.scopePartial}</p>}
      {/* 绩效看板第二期（10/10）：HoD 部门校准概览，默认收起；用套上草稿后的行，随未保存的调整即时变化 */}
      {isHod && rows.length > 0 && <DeptCalibOverview rows={applied} deptOptions={view.deptOptions} ratingOptions={view.ratingOptions} annual={annual} lang={lang} />}

      <div className="dcal-sticky">
        {quota && (
          <div className="dcal-tiers" role="group" aria-label={s.quotaTitle} title={s.quotaRefNote}>
            {tiers.map(tierCell)}
          </div>
        )}
        <div className="dcal-bar">
          <div className="dcal-prog tnum">
            {!annual && <span>{s.progSelf(progress.self, progress.total)}</span>}
            {!annual && <span>{s.progOne(progress.one, progress.total)}</span>}
            <span>{s.progRated(progress.rated, progress.total)}</span>
          </div>
          <label className="dcal-switch">
            <input type="checkbox" checked={q.pending === '1'} onChange={(e) => setQ({ pending: e.target.checked ? '1' : null })} />
            <span>{s.onlyPending}</span>
          </label>
          <div className="dcal-acts">
            {isHod && !locked && (
              <>
                <button type="button" className="btn ghost sm" disabled={!dirty || busy !== ''} onClick={saveAll}>{s.saveAll(changes.length)}</button>
                <button type="button" className="btn sm" disabled={dirty || blocking || busy !== '' || !onSubmit} title={dirty ? s.saveFirst : undefined} onClick={submit}>{s.submit}</button>
                {dirty && <span className="dcal-hint">{s.saveFirst}</span>}
              </>
            )}
            {!isHod && actions}
          </div>
        </div>
        {quota && dept.small && quota.over.length > 0 && <div className="rv-hint">{s.quotaSmall(view.quotaMinHeadcount || 10)}</div>}
        {quota && tiers.some((t) => !dc.QUOTA_CAPPED.includes(t) && dept.allowed && dept.allowed[t] != null && (quota.counts[t] || 0) > Number(dept.allowed[t])) && <div className="rv-hint dcal-ref-note">{s.quotaRefNote}</div>}
        {msg && <div className={'rv-msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</div>}
      </div>

      {dirty && (restoredN > 0 || Object.keys(rowErrors).length > 0) && (
        <div className="dcal-note">
          {restoredN > 0 && <span>{s.restored(restoredN)}</span>}
          <button type="button" className="dpf-link" onClick={discardDrafts}>{restoredN > 0 ? s.discard : s.discardAll}</button>
        </div>
      )}

      {!partial && (issues.length > 0 || notices.length > 0) && (
        <div className="dcal-issues">
          {issues.map((x, i) => (
            <span key={'i' + i} className="dcal-issue-wrap">
              <button type="button" className="dcal-issue" disabled={!Array.isArray(x.ids) || !x.ids.length}
                onClick={() => showIds(issueText(lang, x), x.ids)}>{issueText(lang, x)}</button>
              {x === ratingMissing && onRemindManagers && remindIds.length > 0 && !locked && (
                <button type="button" className="rv-nudge" disabled={busy !== ''} onClick={() => doRemind(remindIds)}>{s.remind}</button>
              )}
            </span>
          ))}
          {notices.map((x, i) => (
            <button key={'n' + i} type="button" className="dcal-issue dcal-notice" disabled={!Array.isArray(x.ids) || !x.ids.length}
              onClick={() => showIds(noticeText(lang, x), x.ids)}>{noticeText(lang, x)}</button>
          ))}
        </div>
      )}
      {remind && (
        <div className="dcal-note dcal-remind" role="status">
          <span>{remind.reminded ? s.remindDone(remind.reminded) : s.remindNone}</span>
          {remind.groups.length > 0 && (
            <ul>
              {remind.groups.map((g) => <li key={g.code}>{s.remindSkipped(g.n)} {whyText(lang, g.code, isHod ? 'hod' : null)}</li>)}
            </ul>
          )}
        </div>
      )}

      <button type="button" className="btn ghost sm dcal-ftoggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>{s.filters(activeFilters)}</button>
      <div className={'dcal-filters' + (filtersOpen ? ' open' : '')}>
        <input type="search" className="rv-inp dcal-search" value={q.q || ''} placeholder={s.fSearch} aria-label={s.fSearch}
          onChange={(e) => setQ({ q: e.target.value || null })} />
        {Array.isArray(view.deptOptions) && view.deptOptions.length > 0 && (
          <DeptFilter options={view.deptOptions} value={q.dept || null} lang={lang} size="small" label={s.fDept} placeholder={s.fDept}
            ready={ready} onChange={(v) => setQ({ dept: v })}
            onInvalid={() => { setQ({ dept: null }); setNote(deptFilterInvalidText(lang)); }} />
        )}
        <select className="rv-sel" value={q.mgr || ''} aria-label={s.fMgr} onChange={(e) => setQ({ mgr: e.target.value || null })}>
          <option value="">{s.mgrAll}</option>
          {mgrOpts.map((m) => <option key={m.id} value={m.id}>{m.id === dc.NONE ? s.noMgr : `${m.name}${m.status === 'departed' ? `（${s.mgrDeparted}）` : ''}`}</option>)}
        </select>
        {lvOpts.length > 0 && (
          <select className="rv-sel" value={q.lv || ''} aria-label={s.fLv} onChange={(e) => setQ({ lv: e.target.value || null })}>
            <option value="">{s.lvAll}</option>
            {lvOpts.some((o) => o.kind === 'g') && <optgroup label={s.lvGroupGrade}>{lvOpts.filter((o) => o.kind === 'g').map((o) => <option key={o.value} value={o.value}>{s.lvGrade(o.label)}</option>)}</optgroup>}
            {lvOpts.some((o) => o.kind === 'r') && <optgroup label={s.lvGroupRank}>{lvOpts.filter((o) => o.kind === 'r').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>}
            {lvOpts.filter((o) => o.kind === 'nogrid' || o.kind === 'none').map((o) => <option key={o.value} value={o.value}>{o.kind === 'none' ? s.lvNone : s.lvNoGrid}</option>)}
          </select>
        )}
        {!annual && (
          <select className="rv-sel" value={q.one || ''} aria-label={s.fOne} onChange={(e) => setQ({ one: e.target.value || null })}>
            <option value="">{s.oneAll}</option>
            {dc.ONE_STATES.map((k) => <option key={k} value={k}>{s['one_' + k]}</option>)}
          </select>
        )}
        {!annual && (
          <select className="rv-sel" value={q.mr || ''} aria-label={s.fMr} onChange={(e) => setQ({ mr: e.target.value || null })}>
            <option value="">{s.mrAll}</option>
            {((view.ratingOptions) || dc.RATING_ORDER).map((o) => <option key={o} value={o}>{label(o)}</option>)}
            <option value="none">{s.mrNone}</option>
          </select>
        )}
        {!annual && (
          <select className="rv-sel" value={q.adj || ''} aria-label={s.fAdj} onChange={(e) => setQ({ adj: e.target.value || null })}>
            <option value="">{s.adjAll}</option>
            <option value="adj">{s.adjAdj}</option>
            {!hrNoHod && <option value="proxy">{s.adjProxy}</option>}
            <option value="no">{s.adjNo}</option>
          </select>
        )}
        <select className="rv-sel" value={q.od || ''} aria-label={s.fOd} onChange={(e) => setQ({ od: e.target.value || null })}>
          <option value="">{s.odAll}</option>
          <option value="1">{s.odAny}</option>
          {!annual && <option value="self">{s.odSelf}</option>}
          {!annual && <option value="rate">{s.odRate}</option>}
        </select>
        {!annual && (
          <label className="dcal-switch">
            <input type="checkbox" checked={q.hl === '1'} onChange={(e) => setQ({ hl: e.target.checked ? '1' : null })} />
            <span>{s.fHl}</span>
          </label>
        )}
        <select className="rv-sel" value={q.sort || 'name'} aria-label={s.fSort} onChange={(e) => setQ({ sort: e.target.value === 'name' ? null : e.target.value })}>
          <option value="name">{s.sortName}</option>
          <option value="rating">{s.sortRating}</option>
          <option value="dept">{s.sortDept}</option>
        </select>
        <label className="dcal-switch">
          <input type="checkbox" checked={q.flat === '1'} onChange={(e) => setQ({ flat: e.target.checked ? '1' : null })} />
          <span>{s.flat}</span>
        </label>
        {activeFilters > 0 && (
          <button type="button" className="dpf-link" onClick={() => setQ(Object.fromEntries(FILTER_KEYS.filter((k) => k !== 'sort' && k !== 'flat').map((k) => [k, null])))}>{s.clearFilters}</button>
        )}
      </div>
      {note && <div className="rv-hint dcal-notehint" role="status">{note}</div>}
      {only && (
        <div className="dcal-only">
          <span>{s.onlyIds(only.label, only.ids.size)}</span>
          <button type="button" className="dpf-link" onClick={() => setOnly(null)}>{s.showAll}</button>
        </div>
      )}

      {sorted.length === 0 && <div className="card rv-empty">{s.empty}</div>}
      {sorted.length > 0 && !groups && table(sorted)}
      {sorted.length > 0 && groups && groups.map((g) => {
        const shut = collapsed.has(g.key);
        return (
          <section key={g.key} className="dcal-group">
            <button type="button" className="dcal-ghead" aria-expanded={!shut}
              onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}>
              <span className={'dcal-chev' + (shut ? '' : ' open')} aria-hidden="true">›</span>
              <b>{g.key === dc.NONE ? s.noMgr : g.manager || '—'}</b>
              {g.managerStatus === 'departed' && <span className="pill muted">{s.mgrDeparted}</span>}
              <span className="rv-eid tnum">{s.groupCount(g.rows.length)}</span>
              <span className="rv-eid tnum">{s.groupRated(g.rated, g.total)}</span>
            </button>
            {!shut && table(g.rows)}
          </section>
        );
      })}
    </div>
  );
}
