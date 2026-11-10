// 绩效看板（后台）第一期（负责人 2026-10-10 拍板，方案 docs/PROPOSAL-20261010-performance-dashboard.md 第四节）：
//   页签「周期进度」—— 按一级部门的阶段完成率（低于全公司的标出）、按阶段的逾期名单、部门确认状态；
//   页签「结果与一致性」—— 上级评级 → 最终评级的转移矩阵、各部门上调 / 下调率、上级评分尺度、按序列 / 职级的评级分布。
// 第二期（10/10 开工）页签「申诉」—— 所选周期的申诉数、申诉率、按时答复、处理结果与调整后的评级变化，按部门 / HRBP / 原因分类拆开，
//   即将超时与已超时名单。数据：/api/admin/review-appeals?cycle=（名单）与 /api/admin/review-appeals/stats（申诉率、按时答复，同周期一行）。
// 第三期（10/10 开工）页签「趋势与人才信号」—— 与所选周期同类型的最近 4 个已关闭周期：评级分布变化（可按一级部门）、
//   相邻两期差两档及以上、连续两期 C / D、连续两期 A 及以上（带流失风险 / 已列为继任人的标记，需人才发展读权限）。
//   数据：逐期 /api/admin/review-cycles/:id（同第一期，评级按档案评级），不另存快照。
// 数据：GET /api/admin/review-cycles（选周期）与 /api/admin/review-cycles/:id（已按调用者的数据范围过滤）。
// 每个数字都能点开名单，名单与数字来自同一份 items（perfdash.js）。单周期明细仍在「评估周期 › 看板」，本页顶部有入口。
// 权限：绩效读（rbac.js 页面表 domain: performance），数据范围由服务端裁剪。
import DrillModal from '../../components/DrillModal.jsx';
import { useUrlState } from '../../urlstate.js';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Select, Table, Tag, Modal, Input, Empty, Spin, Banner, Typography } from '@douyinfe/semi-ui';
import { api, useAsync } from '../../api.js';
import { useI18n } from '../../i18n.jsx';
import { useAuth } from '../../auth.jsx';
import { canReadDomain } from '../../rbac.js';
import * as PD from './perfdash.js';
import { cardify } from '../../cardify.js';   // 手机宽度表格转卡片时带列名（QA 第 31 节）
import { APPEAL_CATEGORIES, categoryLabel } from '../../appealcats.js';

const { Text } = Typography;

const T = {
  zh: {
    title: '绩效看板', lead: '按周期看评估进度、校准变动与评分一致性。数字可点开名单；范围按你的角色数据范围计算。',
    cycle: '评估周期', noCycle: '还没有评估周期。', loadFail: '加载失败，请刷新页面重试。', toCycle: '打开该周期的明细',
    tabProgress: '周期进度', tabResults: '结果与一致性',
    open: '进行中', closed: '已关闭', annual: '年度', quarter: '季度', legacyKind: '旧流程周期', legacyKind1: '旧流程周期',
    pDept: '一级部门', pN: '人数', pSelf: '自评提交', pOne: '面谈双方确认', pRated: '上级评级', pRatedA: '已评级', pProxy: 'HoD 代评', pStatus: '部门状态',
    pTotal: '全公司（范围内）', pBelow: '低于全公司', noDept: '未归入一级部门',
    stPendingHod: '待 HoD 提交', stPendingHr: '待 HR 确认', stReturned: '已退回', stConfirmed: '已确认', stNoHod: '无 HoD',
    overTitle: '逾期名单', overSelf: '自评逾期', overRate: '上级评级逾期', overNone: '没有逾期。',
    deptTitle: '部门确认状态',
    trTitle: '校准变动：上级评级 → 最终评级', trLead: '只统计有上级评级的人（HoD 代评不计）。行 = 上级给的评级，列 = 最终评级。',
    trFrom: '上级评级', trUp: '上调', trDown: '下调', trSame: '未变', trNone: '还没有可比较的评级。',
    mvTitle: '各部门上调率 / 下调率', mvN: '可比人数', mvUp: '上调', mvDown: '下调',
    lnTitle: '上级评分尺度', lnLead: (n) => `每位上级给出评级的平均档位与所在一级部门平均的差（A+ = 6 … D = 1）。只计算评了 ${n} 人及以上的上级；差 ≥ 0.5 档标出。仅供校准讨论，不对员工展示。`,
    lnMgr: '上级', lnN: '评了几人', lnAvg: '平均档位', lnDept: '部门平均', lnDiff: '差', lnLenient: '偏宽', lnStrict: '偏严', lnNone: '没有评够人数的上级。',
    dsTitle: '评级分布', dsTrack: '按序列', dsGrade: '按职级段', dsGradeOf: (g) => `职级段 ${g}`, dsN: '人数', dsNone: '未设', dsEmpty: '还没有评级。', dsFrom: '分组',
    trackM: '管理序列 M', trackP: '专业序列 P',
    drillAll: '全部', searchPh: '搜索姓名或工号', shown: (a, b) => `${a} / ${b} 人`, drillEmpty: '没有人。',
    colName: '姓名', colEmpId: '工号', colDept: '部门', colManager: '直属上级', colMgrRating: '上级评级', colFinal: '最终评级', proxyTag: 'HoD 代评',
    tabAppeals: '申诉', tabTrends: '趋势与人才信号', langKey: 'zh',
    apNoResults: '这个周期还没有通知员工结果，没有申诉。', apNone: '这个周期没有申诉。', apNoAccess: '你的角色看不到申诉。',
    apTotal: '申诉', apRate: '申诉率', apRateHint: (n) => `每百名可申诉员工（${n} 人），不含已撤回`, apOpen: '处理中', apSoon: (n) => `即将超时（≤ ${n} 个工作日）`, apOverdue: '已超时',
    apOnTime: '按时答复', apOnTimeHint: '10 个工作日内给出结论', apAvg: (d) => `平均 ${d} 个工作日`, apWithdrawn: '已撤回',
    apOutcome: '处理结果', apMaintain: '维持原评级', apAdjust: '调整评级', apChange: '调整后的评级变化', apChangeNone: '没有调整评级的申诉。',
    apByDept: '按一级部门', apByHrbp: '按 HRBP', apByCat: '按原因分类', apUnassigned: '待开始处理', apN: '申诉',
    apListT: '需要跟进的申诉', apNoFollow: '没有即将超时或已超时的申诉。',
    colStatus: '状态', colDue: '答复截止', colHandler: '处理人', colCat: '原因分类',
    stSubmitted: '待开始', stInReview: '处理中', stMaintained: '维持', stAdjusted: '已调整', stWithdrawn: '已撤回',
    left: (n) => `${n} 个工作日`, overBy: (n) => `超时 ${n} 个工作日`, openAppeal: '打开案卷',
    trLead2: (n, k) => `与所选周期同类型（${k}）的最近 ${n} 个已关闭周期，评级按档案评级（关闭后改过的按改后的计）。`, trNeed2: '至少要有两个已关闭的同类型周期，才能看趋势。',
    trNoClosed: '还没有已关闭的同类型周期。', trDist: '评级分布变化', trAllDept: '全公司（范围内）', trDeptPick: '一级部门',
    sgTitle: (a, b) => `人才信号（${a} → ${b}）`, sgUnstable: '评级差两档及以上', sgLow: '连续两期 C / D', sgLowHint: '可作为绩效改进计划的候选',
    sgHigh: '连续两期 A 及以上', sgFlight: '其中带「流失风险」标签', sgSucc: '其中已列为继任人', sgNoFlags: '你的角色没有人才发展读权限，不显示流失风险与继任标记。',
    colPrev: '上一期', colLast: '本期', colFlags: '标记', flagFlight: '流失风险', flagSucc: '继任人',
  },
  en: {
    title: 'Performance Dashboard', lead: 'Review progress, calibration changes and rating consistency by cycle. Click a number for the list; figures follow your role\'s data scope.',
    cycle: 'Review cycle', noCycle: 'There are no review cycles yet.', loadFail: 'Couldn’t load. Refresh the page to try again.', toCycle: 'Open this cycle\'s details',
    tabProgress: 'Cycle progress', tabResults: 'Results and consistency',
    open: 'Open', closed: 'Closed', annual: 'Annual', quarter: 'Quarterly', legacyKind: 'Legacy-flow cycles', legacyKind1: 'Legacy-flow cycle',   // CX-226：单个周期的标签用单数
    pDept: 'Department', pN: 'People', pSelf: 'Self-review', pOne: '1-on-1 confirmed', pRated: 'Manager rating', pRatedA: 'Rated', pProxy: 'HoD proxy', pStatus: 'Department status',
    pTotal: 'Company (in scope)', pBelow: 'Below company', noDept: 'No top-level department',
    stPendingHod: 'Awaiting HoD', stPendingHr: 'Awaiting HR', stReturned: 'Returned', stConfirmed: 'Confirmed', stNoHod: 'No HoD',
    overTitle: 'Overdue', overSelf: 'Self-review overdue', overRate: 'Manager rating overdue', overNone: 'Nothing is overdue.',
    deptTitle: 'Department confirmation',
    trTitle: 'Calibration changes: manager rating → final rating', trLead: 'Only people with a manager rating (HoD proxy ratings excluded). Rows = manager rating, columns = final rating.',
    trFrom: 'Manager rating', trUp: 'Raised', trDown: 'Lowered', trSame: 'Unchanged', trNone: 'No ratings to compare yet.',
    mvTitle: 'Raised / lowered by department', mvN: 'Comparable', mvUp: 'Raised', mvDown: 'Lowered',
    lnTitle: 'Manager rating tendency', lnLead: (n) => `Each manager's average rating level minus their department's average (A+ = 6 … D = 1). Only managers who rated ${n} or more people; differences of 0.5 or more are flagged. For calibration discussion only; never shown to employees.`,
    lnMgr: 'Manager', lnN: 'Rated', lnAvg: 'Average', lnDept: 'Dept average', lnDiff: 'Difference', lnLenient: 'Lenient', lnStrict: 'Strict', lnNone: 'No manager has rated enough people.',
    dsTitle: 'Rating distribution', dsTrack: 'By track', dsGrade: 'By grade band', dsGradeOf: (g) => `Grade band ${g}`, dsN: 'People', dsNone: 'Not set', dsEmpty: 'No ratings yet.', dsFrom: 'Group',
    trackM: 'Management track M', trackP: 'Professional track P',
    drillAll: 'All', searchPh: 'Search name or employee ID', shown: (a, b) => `${a} of ${b}`, drillEmpty: 'Nobody.',
    colName: 'Name', colEmpId: 'Employee ID', colDept: 'Department', colManager: 'Manager', colMgrRating: 'Manager rating', colFinal: 'Final rating', proxyTag: 'HoD proxy',
    tabAppeals: 'Appeals', tabTrends: 'Trends and talent signals', langKey: 'en',
    apNoResults: 'Results for this cycle have not been communicated, so there are no appeals.', apNone: 'There are no appeals for this cycle.', apNoAccess: 'Your role cannot see appeals.',
    apTotal: 'Appeals', apRate: 'Appeal rate', apRateHint: (n) => `Per 100 employees who could appeal (${n}); withdrawn appeals excluded`, apOpen: 'Open', apSoon: (n) => `Due soon (≤ ${n} working days)`, apOverdue: 'Overdue',
    apOnTime: 'Answered on time', apOnTimeHint: 'Decision within 10 working days', apAvg: (d) => `Average ${d} working days`, apWithdrawn: 'Withdrawn',
    apOutcome: 'Outcome', apMaintain: 'Rating maintained', apAdjust: 'Rating adjusted', apChange: 'Rating changes after adjustment', apChangeNone: 'No appeal led to a rating change.',
    apByDept: 'By department', apByHrbp: 'By HRBP', apByCat: 'By reason', apUnassigned: 'Not started', apN: 'Appeals',
    apListT: 'Appeals to follow up', apNoFollow: 'No appeal is due soon or overdue.',
    colStatus: 'Status', colDue: 'Decision due', colHandler: 'Handler', colCat: 'Reason',
    stSubmitted: 'Not started', stInReview: 'In review', stMaintained: 'Maintained', stAdjusted: 'Adjusted', stWithdrawn: 'Withdrawn',
    left: (n) => `${n} working days`, overBy: (n) => `${n} working days overdue`, openAppeal: 'Open case',
    trLead2: (n, k) => `The last ${n} closed cycles of the same type as the selected one (${k}). Ratings are the archived ratings (amended ones count as amended).`, trNeed2: 'You need at least two closed cycles of the same type to see trends.',
    trNoClosed: 'There are no closed cycles of this type yet.', trDist: 'Rating distribution over time', trAllDept: 'Company (in scope)', trDeptPick: 'Department',
    sgTitle: (a, b) => `Talent signals (${a} → ${b})`, sgUnstable: 'Rating moved two or more levels', sgLow: 'C / D twice in a row', sgLowHint: 'Candidates for a performance improvement plan',
    sgHigh: 'A or above twice in a row', sgFlight: 'of whom tagged flight risk', sgSucc: 'of whom named as a successor', sgNoFlags: 'Your role cannot read talent development data, so flight-risk and successor flags are not shown.',
    colPrev: 'Previous', colLast: 'Latest', colFlags: 'Flags', flagFlight: 'Flight risk', flagSucc: 'Successor',
  },
};

const apStatusText = (s, st) => ({ submitted: s.stSubmitted, in_review: s.stInReview, maintained: s.stMaintained, adjusted: s.stAdjusted, withdrawn: s.stWithdrawn }[st] || st);
function Drill({ drill, s, closed, canProfile, onClose, navigate }) {
  return (
    <DrillModal drill={drill} s={s} onClose={onClose}
      columns={drill && drill.mode === 'appeal' ? appealCols(s, onClose, navigate) : drill && drill.mode === 'signal' ? signalCols(s, canProfile, onClose, navigate) : [
          { title: s.colName, dataIndex: 'name', width: 140, render: (v, r) => (canProfile
            ? <span className="emp-namelink" style={{ cursor: 'pointer' }} onClick={() => { onClose(); navigate(`/admin/people/${r.userId}`); }}>{v}</span>
            : <span>{v}</span>) },
          { title: s.colEmpId, dataIndex: 'employeeId', width: 100, render: (v) => <Text type="tertiary" size="small" className="tnum">{v}</Text> },
          { title: s.colDept, dataIndex: 'department', width: 160, render: (v) => v || <Text type="quaternary">—</Text> },
          { title: s.colManager, dataIndex: 'manager', width: 120, render: (v) => v || <Text type="quaternary">—</Text> },
          { title: s.colMgrRating, dataIndex: 'managerRating', width: 100, render: (v) => v || <Text type="quaternary">—</Text> },
          { title: s.colFinal, dataIndex: 'finalRating', width: 140, render: (_, r) => (
            <span>{PD.ratingOf(r, closed || (drill && drill.mode === 'trend')) || <Text type="quaternary">—</Text>}{r.hodProxy ? <Tag size="small" color="amber" type="light" className="u-tag-gap">{s.proxyTag}</Tag> : null}</span>
          ) },
        ]} />
  );
}

function appealCols(s, onClose, navigate) {
  return [
    { title: s.colName, dataIndex: 'name', width: 140, render: (v, r) => <span className="emp-namelink" style={{ cursor: 'pointer' }} onClick={() => { onClose(); navigate(`/admin/review-appeals?appeal=${encodeURIComponent(r.id)}`); }}>{v}</span> },
    { title: s.colEmpId, dataIndex: 'employeeId', width: 100, render: (v) => <Text type="tertiary" size="small" className="tnum">{v}</Text> },
    { title: s.colDept, dataIndex: 'department', width: 160, render: (v) => v || <Text type="quaternary">—</Text> },
    { title: s.colStatus, dataIndex: 'status', width: 100, render: (v) => apStatusText(s, v) },
    { title: s.colDue, dataIndex: 'slaDueOn', width: 150, render: (v, r) => <span className="tnum">{v || '—'}{r.overdue ? <Tag size="small" color="red" type="light" className="u-tag-gap">{s.overBy(r.overdueWorkdays || 0)}</Tag> : r.workdaysLeft != null ? <Text type="tertiary" size="small">{' · ' + s.left(r.workdaysLeft)}</Text> : null}</span> },
    { title: s.colHandler, dataIndex: 'handler', width: 120, render: (v) => (v && v.name) || <Text type="tertiary">{s.apUnassigned}</Text> },
    { title: s.colCat, dataIndex: 'reasonCategory', width: 180, render: (v) => categoryLabel(v, s.langKey) },
  ];
}
function signalCols(s, canProfile, onClose, navigate) {
  return [
    { title: s.colName, dataIndex: 'name', width: 140, render: (v, r) => (canProfile
      ? <span className="emp-namelink" style={{ cursor: 'pointer' }} onClick={() => { onClose(); navigate(`/admin/people/${r.userId}`); }}>{v}</span>
      : <span>{v}</span>) },
    { title: s.colEmpId, dataIndex: 'employeeId', width: 100, render: (v) => <Text type="tertiary" size="small" className="tnum">{v}</Text> },
    { title: s.colDept, dataIndex: 'department', width: 160, render: (v) => v || <Text type="quaternary">—</Text> },
    { title: s.colPrev, dataIndex: 'prevRating', width: 80, render: (v) => v || '—' },
    { title: s.colLast, dataIndex: 'lastRating', width: 80, render: (v) => v || '—' },
    { title: s.colFlags, dataIndex: 'flight', width: 160, render: (_, r) => (
      <span>{r.flight ? <Tag size="small" color="red" type="light">{s.flagFlight}</Tag> : null}{r.successor ? <Tag size="small" color="blue" type="light" className="u-tag-gap">{s.flagSucc}</Tag> : null}</span>
    ) },
  ];
}

export default function PerfDashboard() {
  const { lang } = useI18n();
  const s = T[lang === 'zh' ? 'zh' : 'en'];
  const { user } = useAuth();
  const navigate = useNavigate();
  const canProfile = canReadDomain(user, 'people');
  const [sp] = useSearchParams();
  const [, patchUrl] = useUrlState();
  const listQ = useAsync(() => api.get('/api/admin/review-cycles'), []);
  const cycles = useMemo(() => (Array.isArray(listQ.data) ? listQ.data : []).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), [listQ.data]);
  const defaultCycle = useMemo(() => { const o = cycles.find((c) => c.status === 'open'); return (o || cycles[0] || {}).id || null; }, [cycles]);
  const cycleId = cycles.some((c) => c.id === sp.get('cycle')) ? sp.get('cycle') : defaultCycle;
  const tab = ['results', 'appeals', 'trends'].includes(sp.get('tab')) ? sp.get('tab') : 'progress';
  const set = (patch) => patchUrl(patch, { push: false });
  const oneQ = useAsync(() => (cycleId ? api.get(`/api/admin/review-cycles/${encodeURIComponent(cycleId)}`) : Promise.resolve(null)), [cycleId]);
  const [drill, setDrill] = useState(null);
  const d = oneQ.data;
  const closed = !!(d && d.cycle && d.cycle.status === 'closed');
  const kind = d && d.cycle && d.cycle.kind === 'annual' ? 'annual' : 'quarter';
  const v2 = !!(d && d.cycle && d.cycle.flow === 'v2');   // 旧流程没有 HoD 提交 / HR 确认，不显示部门状态
  const scale = (d && Array.isArray(d.ratingOptions) && d.ratingOptions.length) ? d.ratingOptions : ['A+', 'A', 'B+', 'B', 'C', 'D'];
  const items = useMemo(() => (d && Array.isArray(d.items) ? d.items : []), [d]);
  const depts = useMemo(() => (d && Array.isArray(d.depts) ? d.depts : []), [d]);
  const prog = useMemo(() => PD.progressRows(items, depts, kind), [items, depts, kind]);
  const over = useMemo(() => PD.overdueGroups(items), [items]);
  const dst = useMemo(() => PD.deptStatus(depts), [depts]);
  const tr = useMemo(() => PD.transfer(items, scale, closed), [items, scale, closed]);
  const moves = useMemo(() => PD.moveRows(items, depts, scale, closed), [items, depts, scale, closed]);
  const len = useMemo(() => PD.leniency(items, scale), [items, scale]);
  const byTrack = useMemo(() => PD.distRows(items, (i) => i.jobTrack, closed), [items, closed]);
  const byGrade = useMemo(() => PD.distRows(items, (i) => i.jobGrade, closed), [items, closed]);
  // 第二期：申诉（只在打开该页签时取）
  const apQ = useAsync(() => (tab === 'appeals' && cycleId
    ? Promise.all([api.get(`/api/admin/review-appeals?cycle=${encodeURIComponent(cycleId)}&status=all`), api.get('/api/admin/review-appeals/stats')])
    : Promise.resolve(null)), [tab, cycleId]);
  const apRows = useMemo(() => (apQ.data && apQ.data[0] && Array.isArray(apQ.data[0].items) ? apQ.data[0].items : []), [apQ.data]);
  const apStat = apQ.data && apQ.data[1] && Array.isArray(apQ.data[1].cycles) ? apQ.data[1].cycles.find((c) => c.cycleId === cycleId) || null : null;
  const aps = useMemo(() => PD.appealSummary(apRows, apQ.data && apQ.data[0] ? apQ.data[0].deptOptions : [], APPEAL_CATEGORIES), [apRows, apQ.data]);
  // 第三期：与所选周期同类型的最近 4 个已关闭周期（按关闭时间从早到晚）
  // CX-185：同类型分三类 —— 年度 / 季度（v2 流程）/ 旧流程周期（如半年度 rc-3）；旧流程不再算作「季度」
  const trendKind = (c) => (!c ? 'quarter' : c.kind === 'annual' ? 'annual' : c.flow === 'v2' ? 'quarter' : 'legacy');
  const selKind = trendKind(cycles.find((c) => c.id === cycleId));
  const trendIds = useMemo(() => cycles.filter((c) => c.status === 'closed' && trendKind(c) === selKind)
    .sort((a, b) => String(a.closedAt || a.createdAt || '').localeCompare(String(b.closedAt || b.createdAt || ''))).slice(-PD.TREND_CYCLES).map((c) => c.id), [cycles, selKind]);
  const trQ = useAsync(() => (tab === 'trends' && trendIds.length
    ? Promise.all(trendIds.map((id) => api.get(`/api/admin/review-cycles/${encodeURIComponent(id)}`)))
    : Promise.resolve(null)), [tab, trendIds.join(',')]);
  const series = useMemo(() => (Array.isArray(trQ.data) ? trQ.data.map((x) => ({ cycle: x.cycle, items: Array.isArray(x.items) ? x.items : [], talentFlags: x.talentFlags === true })) : []), [trQ.data]);
  const trDeptId = sp.get('tdept') || null;
  const trDepts = useMemo(() => PD.trendDepts(series), [series]);
  const trRows = useMemo(() => PD.trendDist(series, trDeptId), [series, trDeptId]);
  const sig = useMemo(() => PD.talentSignals(series, scale), [series, scale]);
  const deptName = (r) => r.label || s.noDept;
  const open = (title, list, mode) => setDrill({ title, items: list, mode: mode || null });
  const num = (list, title, mode) => (list.length > 0
    ? <button type="button" className="u-num-link tnum" onClick={() => open(title, list, mode)}>{list.length}</button>
    : <span className="tnum">0</span>);
  const apNum = (list, title) => num(list, title, 'appeal');
  const sgNum = (list, title) => num(list, title, 'signal');
  const pctCell = (list, n, title) => <span>{num(list, title)}<Text type="tertiary" size="small" className="tnum">{n ? ` · ${Math.round((list.length / n) * 100)}%` : ''}</Text></span>;
  const statusText = (r) => {
    const st = r.status || {};
    if (st.hrConfirmedAt) return <Tag color="green" type="light">{s.stConfirmed}</Tag>;
    if (st.returnedAt && !st.hodSubmittedAt) return <Tag color="red" type="light">{s.stReturned}</Tag>;
    if (st.hodSubmittedAt || !r.hasHod) return <Tag color="blue" type="light">{s.stPendingHr}</Tag>;
    return <Tag type="light">{s.stPendingHod}</Tag>;
  };

  if (listQ.loading) return <div className="wrap"><Spin /></div>;
  if (listQ.error) return <div className="wrap"><Banner type="danger" fullMode={false} closeIcon={null} description={s.loadFail} /></div>;

  // CX-222：周期类型标签与趋势页同口径（旧流程周期不标「季度」）
  const cycleLabel = (c) => `${c.name} · ${trendKind(c) === 'annual' ? s.annual : trendKind(c) === 'legacy' ? s.legacyKind1 : s.quarter} · ${c.status === 'closed' ? s.closed : s.open}`;
  const progCols = [
    { title: s.pDept, dataIndex: 'label', width: 220, render: (_, r) => <span>{deptName(r)}{r.below ? <Tag size="small" color="amber" type="light" className="u-tag-gap">{s.pBelow}</Tag> : null}</span> },
    { title: s.pN, dataIndex: 'n', width: 80, render: (_, r) => num(r.people, `${deptName(r)} · ${s.drillAll}`) },
    ...(kind === 'annual' ? [] : [
      { title: s.pSelf, dataIndex: 'self', width: 130, render: (_, r) => pctCell(r.self, r.n, `${deptName(r)} · ${s.pSelf}`) },
      { title: s.pOne, dataIndex: 'one', width: 140, render: (_, r) => pctCell(r.one, r.n, `${deptName(r)} · ${s.pOne}`) },
    ]),
    { title: kind === 'annual' ? s.pRatedA : s.pRated, dataIndex: 'rated', width: 130, render: (_, r) => pctCell(r.rated, r.n, `${deptName(r)} · ${s.pRated}`) },
    { title: s.pProxy, dataIndex: 'proxy', width: 120, render: (_, r) => pctCell(r.proxy, r.n, `${deptName(r)} · ${s.pProxy}`) },
    { title: s.overSelf, dataIndex: 'overSelf', width: 110, render: (_, r) => num(r.overSelf, `${deptName(r)} · ${s.overSelf}`) },
    { title: s.overRate, dataIndex: 'overRate', width: 130, render: (_, r) => num(r.overRate, `${deptName(r)} · ${s.overRate}`) },
    ...(v2 ? [{ title: s.pStatus, dataIndex: 'status', width: 130, render: (_, r) => statusText(r) }] : []),
  ];
  const fromRows = scale.filter((f) => tr.cells[f]).map((f) => ({ key: f, from: f }));
  const trCols = [
    { title: s.trFrom, dataIndex: 'from', width: 110, render: (v) => <b>{v}</b> },
    ...scale.map((to) => ({ title: to, dataIndex: 'to_' + to, width: 70, render: (_, r) => {
      const list = (tr.cells[r.from] && tr.cells[r.from][to]) || [];
      const sc = PD.scoreOf(to, scale) - PD.scoreOf(r.from, scale);
      return list.length ? <span className={sc > 0 ? 'pd-up' : sc < 0 ? 'pd-down' : ''}>{num(list, `${r.from} → ${to}`)}</span> : <Text type="quaternary">·</Text>;
    } })),
  ];
  const distCols = (labelOf) => [
    { title: s.dsFrom, dataIndex: 'key', width: 160, render: (v) => labelOf(v) },
    { title: s.dsN, dataIndex: 'n', width: 80, render: (_, r) => num(Object.values(r.tiers).flat(), `${labelOf(r.key)} · ${s.drillAll}`) },
    ...PD.TIERS.map((t) => ({ title: t, dataIndex: 't_' + t, width: 90, render: (_, r) => {
      const list = r.tiers[t] || [];
      return <span>{num(list, `${labelOf(r.key)} · ${t}`)}<Text type="tertiary" size="small" className="tnum">{r.n ? ` · ${Math.round((list.length / r.n) * 100)}%` : ''}</Text></span>;
    } })),
  ];
  const trackLabel = (k) => (k === 'M' ? s.trackM : k === 'P' ? s.trackP : k === '__none' ? s.dsNone : k);
  const gradeLabel = (k) => (k === '__none' ? s.dsNone : s.dsGradeOf(k));

  return (
    <div className="wrap tset-wrap pd-wrap">
      {/* CX-085：标题与说明包一层，与其他页面同一结构（窄屏上下排列） */}
      <div className="tset-head">
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
      </div>
      {!cycles.length ? <Empty description={s.noCycle} style={{ padding: 40 }} /> : (
        <>
          <div className="rvc-filters pd-bar">
            <Select value={cycleId || undefined} onChange={(v) => set({ cycle: v })} style={{ width: 360, maxWidth: '100%' }} insetLabel={s.cycle}
              optionList={cycles.map((c) => ({ value: c.id, label: cycleLabel(c) }))} />
            {cycleId && <Button theme="borderless" onClick={() => navigate(`/admin/reviews?cycle=${encodeURIComponent(cycleId)}&view=board`)}>{s.toCycle}</Button>}
          </div>
          <div className="ptabs pd-tabs" role="tablist">
            {[['progress', s.tabProgress], ['results', s.tabResults], ['appeals', s.tabAppeals], ['trends', s.tabTrends]].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={'pd-tab' + (tab === k ? ' on' : '')} onClick={() => set({ tab: k === 'progress' ? null : k })}>{label}</button>
            ))}
          </div>
          {oneQ.loading && (tab === 'progress' || tab === 'results') && <Spin />}
          {oneQ.error && (tab === 'progress' || tab === 'results') && <Banner type="danger" fullMode={false} closeIcon={null} description={s.loadFail} />}
          {d && tab === 'progress' && (
            <div className="rvc-board">
              <div className="rvc-sub">{s.pTotal}</div>
              <div className="rvc-kpis">
                {[...(kind === 'annual' ? [] : [[s.pSelf, prog.total.self], [s.pOne, prog.total.one]]), [kind === 'annual' ? s.pRatedA : s.pRated, prog.total.rated], [s.pProxy, prog.total.proxy]].map(([label, list]) => (
                  <div key={label} className="rvc-kpi">
                    <div className="rvc-kpi-l">{label}</div>
                    <div className="rvc-kpi-v tnum">{prog.total.n ? Math.round((list.length / prog.total.n) * 100) : 0}%</div>
                    <div className="rvc-kpi-bar"><i style={{ width: (prog.total.n ? Math.round((list.length / prog.total.n) * 100) : 0) + '%' }} /></div>
                    <div className="rvc-kpi-n tnum">{num(list, `${s.pTotal} · ${label}`)} / {prog.total.n}</div>
                  </div>
                ))}
              </div>
              <div className="rvc-sub">{s.pDept}</div>
              <Table rowKey="key" size="small" pagination={false} dataSource={prog.rows} columns={cardify(progCols)} className="dt-table"
                scroll={{ x: progCols.reduce((a, c) => a + (c.width || 120), 0) }} />
              <div className="rvc-sub">{s.overTitle}</div>
              {over.self.length + over.rate.length === 0 ? <Text type="tertiary">{s.overNone}</Text> : (
                <div className="pd-chips">
                  <span>{s.overSelf} {num(over.self, s.overSelf)}</span>
                  <span>{s.overRate} {num(over.rate, s.overRate)}</span>
                </div>
              )}
              {v2 && <div className="rvc-sub">{s.deptTitle}</div>}
              {v2 && <div className="pd-chips">
                {[['pendingHod', s.stPendingHod], ['pendingHr', s.stPendingHr], ['returned', s.stReturned], ['confirmed', s.stConfirmed], ['noHod', s.stNoHod]].map(([k, label]) => (
                  <span key={k}>{label} <b className="tnum">{dst[k].length}</b>{dst[k].length ? <Text type="tertiary" size="small">{' · ' + dst[k].map((x) => x.dept1 || s.noDept).join(lang === 'zh' ? '、' : ', ')}</Text> : null}</span>
                ))}
              </div>}
            </div>
          )}
          {d && tab === 'results' && (
            <div className="rvc-board">
              <div className="rvc-sub">{s.trTitle}</div>
              <div className="tset-lead">{s.trLead}</div>
              {tr.n === 0 ? <Text type="tertiary">{s.trNone}</Text> : (
                <>
                  <div className="pd-chips">
                    <span>{s.trUp} {num(tr.up, s.trUp)}</span><span>{s.trDown} {num(tr.down, s.trDown)}</span><span>{s.trSame} {num(tr.same, s.trSame)}</span>
                  </div>
                  <Table rowKey="key" size="small" pagination={false} dataSource={fromRows} columns={cardify(trCols)} scroll={{ x: trCols.reduce((a, c) => a + c.width, 0) }} />
                  <div className="rvc-sub">{s.mvTitle}</div>
                  <Table rowKey="key" size="small" pagination={false} dataSource={moves} className="dt-table"
                    columns={cardify([
                      { title: s.pDept, dataIndex: 'label', width: 220, render: (_, r) => deptName(r) },
                      { title: s.mvN, dataIndex: 'n', width: 100, render: (v) => <span className="tnum">{v}</span> },
                      { title: s.mvUp, dataIndex: 'up', width: 120, render: (_, r) => pctCell(r.up, r.n, `${deptName(r)} · ${s.mvUp}`) },
                      { title: s.mvDown, dataIndex: 'down', width: 120, render: (_, r) => pctCell(r.down, r.n, `${deptName(r)} · ${s.mvDown}`) },
                    ])} />
                </>
              )}
              <div className="rvc-sub">{s.lnTitle}</div>
              <div className="tset-lead">{s.lnLead(PD.LENIENCY_MIN)}</div>
              {len.length === 0 ? <Text type="tertiary">{s.lnNone}</Text> : (
                <Table rowKey="managerId" size="small" dataSource={len} pagination={len.length > 10 ? { pageSize: 10, formatPageText: false } : false} className="dt-table"
                  columns={cardify([
                    { title: s.lnMgr, dataIndex: 'manager', width: 200, render: (v, r) => <span>{v || '—'}{r.flag ? <Tag size="small" color={r.flag === 'lenient' ? 'amber' : 'blue'} type="light" className="u-tag-gap">{r.flag === 'lenient' ? s.lnLenient : s.lnStrict}</Tag> : null}</span> },
                    { title: s.lnN, dataIndex: 'n', width: 90, render: (_, r) => num(r.people, `${r.manager || '—'} · ${s.drillAll}`) },
                    { title: s.lnAvg, dataIndex: 'avg', width: 100, render: (v) => <span className="tnum">{v}</span> },
                    { title: s.lnDept, dataIndex: 'deptAvg', width: 110, render: (v) => <span className="tnum">{v == null ? '—' : v}</span> },
                    { title: s.lnDiff, dataIndex: 'diff', width: 90, render: (v) => <span className="tnum">{v == null ? '—' : (v > 0 ? '+' : '') + v}</span> },
                  ])} />
              )}
              <div className="rvc-sub">{s.dsTitle} · {s.dsTrack}</div>
              {byTrack.length === 0 ? <Text type="tertiary">{s.dsEmpty}</Text>
                : <Table rowKey="key" size="small" pagination={false} dataSource={byTrack} columns={cardify(distCols(trackLabel))} scroll={{ x: 160 + 80 + 90 * PD.TIERS.length }} />}
              <div className="rvc-sub">{s.dsTitle} · {s.dsGrade}</div>
              {byGrade.length === 0 ? <Text type="tertiary">{s.dsEmpty}</Text>
                : <Table rowKey="key" size="small" pagination={false} dataSource={byGrade} columns={cardify(distCols(gradeLabel))} scroll={{ x: 160 + 80 + 90 * PD.TIERS.length }} />}
            </div>
          )}
        </>
      )}
      {cycles.length > 0 && tab === 'appeals' && (
        <div className="rvc-board pd-appeals">
          {apQ.loading && <Spin />}
          {apQ.error && <Banner type="danger" fullMode={false} closeIcon={null} description={apQ.error.status === 403 ? s.apNoAccess : s.loadFail} />}
          {apQ.data && (() => {
            const cyc = cycles.find((c) => c.id === cycleId) || {};
            // 代码审查 10/11：已关闭但还没告知结果（没有 resultsAt）的周期写「还没有通知员工结果」
            if (!apStat && !apRows.length) return <Text type="tertiary">{cyc.status === 'closed' && cyc.resultsAt ? s.apNone : s.apNoResults}</Text>;
            // QA 34-1：申诉率不含已撤回。代码审查 10/11：分子与分母都取 /stats 同周期一行（同一数据范围、已排除利益相关），
            // 名单页的行可能多出 HRBP 分工带来的范围外申诉，不拿来算率
            const rate = apStat ? PD.appealRate(apStat.appeals - apStat.withdrawn, apStat.eligible) : null;
            const decidedN = aps.decided.length;
            const groupCols = (labelOf, firstTitle) => cardify([
              { title: firstTitle || s.pDept, dataIndex: 'label', width: 220, render: (_, r) => labelOf(r) },
              { title: s.apN, dataIndex: 'n', width: 80, render: (_, r) => apNum(r.rows, `${labelOf(r)} · ${s.apN}`) },
              { title: s.apOpen, dataIndex: 'open', width: 90, render: (_, r) => apNum(r.open, `${labelOf(r)} · ${s.apOpen}`) },
              { title: s.apOverdue, dataIndex: 'overdue', width: 90, render: (_, r) => apNum(r.overdue, `${labelOf(r)} · ${s.apOverdue}`) },
              { title: s.apMaintain, dataIndex: 'maintained', width: 110, render: (_, r) => apNum(r.maintained, `${labelOf(r)} · ${s.apMaintain}`) },
              { title: s.apAdjust, dataIndex: 'adjusted', width: 110, render: (_, r) => apNum(r.adjusted, `${labelOf(r)} · ${s.apAdjust}`) },
            ]);
            const follow = [...aps.overdue, ...aps.dueSoon];
            return (
              <>
                <div className="rvc-kpis">
                  <div className="rvc-kpi"><div className="rvc-kpi-l">{s.apTotal}</div><div className="rvc-kpi-v tnum">{apNum(aps.live, s.apTotal)}</div>
                    <div className="rvc-kpi-n">{s.apWithdrawn} <span className="tnum">{aps.withdrawn.length}</span></div></div>
                  <div className="rvc-kpi"><div className="rvc-kpi-l">{s.apRate}</div><div className="rvc-kpi-v tnum">{rate == null ? '—' : rate}</div>
                    <div className="rvc-kpi-n">{apStat && apStat.eligible != null ? s.apRateHint(apStat.eligible) : ''}</div></div>
                  <div className="rvc-kpi"><div className="rvc-kpi-l">{s.apOnTime}</div>
                    <div className="rvc-kpi-v tnum">{apStat && (apStat.maintained + apStat.adjusted) ? `${Math.round((apStat.withinSla / (apStat.maintained + apStat.adjusted)) * 100)}%` : '—'}</div>
                    <div className="rvc-kpi-n">{s.apOnTimeHint}{apStat && apStat.avgHandleWorkdays != null ? ` · ${s.apAvg(apStat.avgHandleWorkdays)}` : ''}</div></div>
                  <div className="rvc-kpi"><div className="rvc-kpi-l">{s.apOpen}</div><div className="rvc-kpi-v tnum">{apNum(aps.open, s.apOpen)}</div>
                    <div className="rvc-kpi-n">{s.apOverdue} {apNum(aps.overdue, s.apOverdue)}</div></div>
                </div>
                <div className="rvc-sub">{s.apListT}</div>
                {follow.length === 0 ? <Text type="tertiary">{s.apNoFollow}</Text> : (
                  <div className="pd-chips">
                    <span>{s.apOverdue} {apNum(aps.overdue, s.apOverdue)}</span>
                    <span>{s.apSoon(PD.DUE_SOON_WORKDAYS)} {apNum(aps.dueSoon, s.apSoon(PD.DUE_SOON_WORKDAYS))}</span>
                  </div>
                )}
                <div className="rvc-sub">{s.apOutcome}</div>
                <div className="pd-chips">
                  <span>{s.apMaintain} {apNum(aps.maintained, s.apMaintain)}</span>
                  <span>{s.apAdjust} {apNum(aps.adjusted, s.apAdjust)}{aps.adjustPct != null ? <Text type="tertiary" size="small" className="tnum">{` · ${aps.adjustPct}%`}</Text> : null}</span>
                </div>
                <div className="rvc-sub">{s.apChange}</div>
                {aps.changes.length === 0 ? <Text type="tertiary">{s.apChangeNone}</Text> : (
                  <div className="pd-chips">{aps.changes.map((c) => <span key={c.key}><b>{c.key}</b> {apNum(c.rows, `${s.apChange} · ${c.key}`)}</span>)}</div>
                )}
                <div className="rvc-sub">{s.apByCat}</div>
                <Table rowKey="key" size="small" pagination={false} dataSource={aps.byCategory} className="dt-table"
                  columns={groupCols((r) => categoryLabel(r.key === '__none' ? null : r.key, s.langKey), s.colCat)}
                  scroll={{ x: 700 }} />
                <div className="rvc-sub">{s.apByDept}</div>
                <Table rowKey="key" size="small" pagination={false} dataSource={aps.byDept} className="dt-table" columns={groupCols((r) => r.label || s.noDept)} scroll={{ x: 700 }} />
                <div className="rvc-sub">{s.apByHrbp}</div>
                <Table rowKey="key" size="small" pagination={false} dataSource={aps.byHrbp} className="dt-table"
                  columns={groupCols((r) => (r.key === '__none' ? s.apUnassigned : r.label || '—'), s.colHandler)} scroll={{ x: 700 }} />
              </>
            );
          })()}
        </div>
      )}
      {cycles.length > 0 && tab === 'trends' && (
        <div className="rvc-board pd-trends">
          <div className="tset-lead">{s.trLead2(PD.TREND_CYCLES, selKind === 'annual' ? s.annual : selKind === 'legacy' ? s.legacyKind : s.quarter)}</div>
          {!trendIds.length ? <Text type="tertiary">{s.trNoClosed}</Text> : trQ.loading ? <Spin /> : trQ.error ? <Banner type="danger" fullMode={false} closeIcon={null} description={s.loadFail} /> : (
            <>
              <div className="rvc-filters">
                <Select value={trDeptId || '__all'} onChange={(v) => set({ tdept: v === '__all' ? null : v })} style={{ width: 300, maxWidth: '100%' }} insetLabel={s.trDeptPick}
                  optionList={[{ value: '__all', label: s.trAllDept }, ...trDepts.map((x) => ({ value: x.id, label: x.name || s.noDept }))]} />
              </div>
              <div className="rvc-sub">{s.trDist}</div>
              <Table rowKey="key" size="small" pagination={false} dataSource={trRows} className="dt-table"
                columns={cardify([
                  { title: s.cycle, dataIndex: 'label', width: 220 },
                  { title: s.dsN, dataIndex: 'n', width: 80, render: (_, r) => num(Object.values(r.tiers).flat(), `${r.label} · ${s.drillAll}`, 'trend') },
                  ...PD.TIERS.map((t) => ({ title: t, dataIndex: 't_' + t, width: 90, render: (_, r) => {
                    const list = r.tiers[t] || [];
                    return <span>{num(list, `${r.label} · ${t}`, 'trend')}<Text type="tertiary" size="small" className="tnum">{r.n ? ` · ${Math.round((list.length / r.n) * 100)}%` : ''}</Text></span>;
                  } })),
                ])} scroll={{ x: 220 + 80 + 90 * PD.TIERS.length }} />
              {series.length < 2 ? <Text type="tertiary">{s.trNeed2}</Text> : (
                <>
                  <div className="rvc-sub">{s.sgTitle(sig.prev ? sig.prev.name : '', sig.last ? sig.last.name : '')}</div>
                  <div className="pd-chips">
                    <span>{s.sgUnstable} {sgNum(sig.unstable, s.sgUnstable)}</span>
                    <span>{s.sgLow} {sgNum(sig.lowTwice, s.sgLow)}<Text type="tertiary" size="small">{' · ' + s.sgLowHint}</Text></span>
                  </div>
                  <div className="pd-chips">
                    <span>{s.sgHigh} {sgNum(sig.highTwice, s.sgHigh)}</span>
                    {sig.flagsKnown && <span>{s.sgFlight} {sgNum(sig.highFlight, s.sgFlight)}</span>}
                    {sig.flagsKnown && <span>{s.sgSucc} {sgNum(sig.highSuccessor, s.sgSucc)}</span>}
                  </div>
                  {!sig.flagsKnown && <Text type="tertiary" size="small">{s.sgNoFlags}</Text>}
                </>
              )}
            </>
          )}
        </div>
      )}
      <Drill drill={drill} s={s} closed={closed} canProfile={canProfile} navigate={navigate} onClose={() => setDrill(null)} />
    </div>
  );
}
