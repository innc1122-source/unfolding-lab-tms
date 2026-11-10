// Review cycles 绩效评估 (Phase 3, HR side) — create a cycle, watch self/manager
// progress, calibrate final ratings, close. Closing writes每人 a performance
// record onto the talent profile, which the timeline and 9-box pick up.
// 第二批（2026-10-08，W2-C）：周期、视图、部门明细、看板筛选与列表筛选都走地址栏（设计 0.2）——
//   列表 ?kind=&status=&year=；周期 ?cycle=&view=depts|board（旧流程只有评估表）；部门明细 &unit=<一级部门 id> + 校准筛选键；
//   看板 &dept=&mgr=&lv=&stage=。v2 周期不再有可编辑的「评估表」：HR 在「部门确认」点部门名打开只读明细
//   （DeptCalibration mode="hr"），无 HoD 的组与 HoD 本人的评估在明细里点「校准」。
import DrillModal from '../../components/DrillModal.jsx';
import { csvText, saveCsv } from '../../csv.js';
import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import {
  Button, Input, TextArea, Select, DatePicker, Table, Tag, Space, Toast, Banner, Spin, Empty, Modal, Popconfirm, Typography, Tooltip,
} from '@douyinfe/semi-ui';
import { IconPlus, IconArrowLeft, IconRefresh, IconDownload } from '@douyinfe/semi-icons';
import { api, useAsync, daysUntil } from '../../api.js';
import { date as fmtDate, datetime as fmtDateTime } from '../../fmt.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { canReadDomain, canWriteDomain, canUseAction, appealDeskVisible } from '../../rbac.js';
import { errCodeText } from '../../reviewcodes.js';
import { PAGE_TIERS, DEFAULT_PAGE_WIDE } from '../../pagesize.js';
import { cardify, resizableTable } from '../../cardify.js';
import { dataTableColumns } from '../../components/DataTable.jsx';   // 一致性整改 2
import { errText } from '../../apierr.js';
import { BULK_SEL_EXTRA, useBulkSelection, BulkBar, BulkConfirmModal, useBulkRunner } from '../../components/BulkActions.jsx';
import DeptFilter from '../../components/DeptFilter.jsx';
import DeptCalibration from '../../components/DeptCalibration.jsx';
import * as dc from '../../deptcal.js';
import { useUrlState, mergeParams, BOARD_KEYS, REVIEW_FILTER_KEYS } from '../../urlstate.js';

const { Text } = Typography;
// 关闭周期返回 depts_changed 时列出的部门：服务端给部门名，也兼容 { dept1 | name } 对象
const deptNames = (dd) => ((dd && dd.depts) || []).map((x) => (typeof x === 'string' ? x : (x && (x.dept1 || x.name)) || '—'));
// 成员快照差异 { added, removed }（服务端 membership_changed / membershipChanged）→ 「新增 a、移出 r」；没有人数就不写
const memberDiff = (d, fmt) => (d && (Number(d.added) || Number(d.removed)) ? fmt(Number(d.added) || 0, Number(d.removed) || 0) : '');

const T = {
  zh: {
    title: '评估周期', lead: '发起评估周期 → 员工自评 → 上级评级（1 对 1 面谈由员工与上级各自登记，评级前后均可）→ HoD 按部门配额校准并提交 → HR 打开部门明细确认或退回 → 关闭周期，最终评级记入员工档案（九宫格同步更新）。年度评级由 HoD 提出、HR 审核。',
    tagQuarter: '季度', tagAnnual: '年度', lOne: '面谈', lHod: 'HoD 提交', lHr: 'HR 确认', legacyTag: '旧流程',
    newCycle: '发起评估周期', newCycleTitle: '发起评估周期', name: '周期名称', namePh: '例如：2026-H2', scope: '参与范围', scopeAll: '全部在职员工（默认不含未设职级人员）', reqName: '请填写周期名称',
    colCycle: '周期', colStatus: '状态', colProgress: '进度', colDue: '自评截止日期', colCreated: '创建时间',
    dueLabel: '自评截止日期', dueHint: '留空表示不设截止日期', overdue: '已逾期',
    editDue: '修改截止日期', dueTitle: '修改自评截止日期', dueSaved: '截止日期已更新', dueCleared: '已清除截止日期', save: '保存',
    open: '进行中', closed: '已关闭', view: '查看', openCycle: '管理', created: (n) => `已发起，纳入 ${n} 人`, createdExcl: (n, k) => `已发起，纳入 ${n} 人；已排除 ${k} 位一级部门负责人（按组织绩效另行考核）`,
    exclHods: (n) => `已排除 ${n} 位一级部门负责人（他们按组织绩效另行考核，不参加个人绩效评估）`,
    self: '自评', mgr: '上级评级', final: '可归档',
    back: '返回列表', close: '关闭并归档', closeTitle: '关闭并归档此评估周期？',
    closeDesc: '有评级的员工将生成一条绩效记录并记入员工档案（未校准的按上级评级记入），员工本人可见；没有任何评级的员工将被跳过。关闭后不可再修改。',
    closed2: (w, k) => `已关闭：归档 ${w} 条绩效记录${k ? `，跳过 ${k} 人（无评级）` : ''}`,
    dist: '最终评级分布（未校准者按上级评级计）', distFile: '评级分布（以档案为准）', noRatings: '还没有评级',
    // 绩效流程 v2（2026-10-06）
    kind: '周期类型', kindQuarter: '季度评估', kindAnnual: '年度评级', kindHint: '年度评级由各部门 HoD 提出、HR 审核，员工与上级不填写。',
    dueRate: '上级评级截止日期', dueCalib: 'HoD 校准截止日期', quota: '评级配额（%，按一级部门人数折算名额）', quotaHint: 'A+ / A / B+ 为上限；人数少于 10 的部门超额只提示。',
    vDepts: '部门确认', vBoard: '看板',
    dDept: '一级部门', dHod: 'HoD', dHc: '人数', dSelf: '自评', dOne: '面谈双确认', dRated: '上级评级', dDist: '评级分布（人数 / 名额）', dDistFile: '评级分布（以档案为准；人数 / 名额）', dStatus: '状态', dOps: '',
    noDept1: '未归入一级部门',
    stNone: '待 HoD 提交', stNoHod: '无 HoD，由 HR 直接确认', stSubmitted: (d) => `HoD 已提交 · ${d}`, stConfirmed: (d, who) => `已确认 · ${d}${who ? ` · ${who}` : ''}`, stReturned: '已退回',
    confirm: '确认', confirmAsk: (d) => `确认「${d}」的部门评级？`, confirmAskBody: '确认后该部门的评级进入周期结论；如需再改，须先撤销确认或退回 HoD。', returnBtn: '退回', returnTitle: '退回给 HoD 重新校准', returnReason: '退回理由', returnPh: '说明需要调整的地方…',
    confirmedOk: '已确认', returnedOk: '已退回，已通知 HoD', overTag: '超额',
    bStages: '各阶段完成率', bSelf: '自评提交', bOne: '面谈双方确认', bRated: '上级评级', bHod: 'HoD 提交（部门）', bHr: 'HR 确认（部门）',
    bDist: '全公司评级分布 vs 配额', bActual: '实际', bQuota: '配额', bMatrix: '部门 × 评级（人数，红色 = 超额）',
    xHighlights: '关键亮点', xHod: '校准说明',
    eDeptsUnconfirmed: (dd) => `还有部门未确认：${(dd.depts || []).slice(0, 5).join('、')}${(dd.depts || []).length > 5 ? ' 等' : ''}`,
    eNotSubmitted: 'HoD 尚未提交本部门', eReasonReq: '请填写退回理由', eDeptConfirmed: '该部门已确认，不能再修改',
    // P0 1.1 / 1.2 / 1.5（2026-10-07）：HR 校准只读、确认前检查、撤销确认、部门筛选含下级部门
    stReopened: '已撤销确认', stHodPending: 'HoD 待确认：请在部门页指定负责人', hodPendingShort: '待确认',
    adjusted: '已调整', calibTitle: '校准评级', calibReason: '调整理由', calibReasonOpt: '调整理由（选填）', calibReasonPh: '改了上级评级须填写理由',
    calibPick: (v) => `校准为：${v}`, calibClear: '清除校准，沿用上级评级',
    eHodReadonly: '本周期由 HoD 校准该部门，HR 只能确认或退回', eReasonCalib: '改了上级评级须填写理由',
    eConfirmBlocked: '该部门还不能确认', eAlreadyConfirmed: '该部门已确认',
    eHodUnresolved: '该部门的 HoD 待确认（有多名候选人或负责人已停用），请先在部门页指定负责人',
    eHodUnresolvedRo: '该部门的 HoD 待确认（有多名候选人或负责人已停用）。',
    eDeptInactive: '该一级部门已停用，没有 HoD：请在部门页重新启用该部门，或把这些人员调到在用的部门',
    stDeptInactive: '一级部门已停用：请重新启用部门或调整人员', deptInactiveShort: '部门已停用',
    issueRatingsChanged: (n) => `HoD 提交后有 ${n} 人的评级被改动`,
    issueRatingsChangedConfirmed: (n) => `确认后有 ${n} 人的评级被改动，须退回或撤销确认后重新确认，否则不能关闭周期`,
    eSelfConfirm: '你是该部门的 HoD，须由另一名 HR 确认或退回',
    eDeptNotFound: '未找到该部门，请重新选择',
    eDeptsChanged: (dd) => `以下已确认部门的成员有变动，须退回后重新确认：${deptNames(dd).slice(0, 5).join('、')}${deptNames(dd).length > 5 ? ' 等' : ''}`,
    issueRatingMissing: (n) => `${n} 人还没有评级`,
    issueOverQuota: (o) => `超出配额：${(o || []).map((x) => `${x.tier} ${x.count}/${x.allowed}`).join('、')}`,
    issueMembershipChanged: (d) => `HoD 提交后部门成员有变动${memberDiff(d, (a, r) => `（新增 ${a} 人、移出 ${r} 人）`)}`,
    issueMembersChangedConfirmed: (d) => `确认后部门成员有变动${memberDiff(d, (a, r) => `（新增 ${a} 人、移出 ${r} 人）`)}，须退回或撤销确认后重新确认，否则不能关闭周期`,
    issueScopePartial: '部门有成员不在你的数据范围内，不能确认',
    mustReturn: '须退回 HoD 调整', fixInSheet: '请在部门明细中调整',
    reopen: '撤销确认', reopenTitle: '撤销确认', reopenReason: '撤销理由', reopenedOk: '已撤销确认',
    inclSub: '选择上级部门即包含其全部下级部门',
    oneBoth: '双方已确认', oneHalf: '仅一方确认',
    colName: '姓名', colDept: '部门', colManager: '直属上级', colSelf: '自评', colOne: '1 对 1 面谈', colMgrRating: '上级评级', colFinal: '最终评级', colCalib: '校准评级', sameAsMgr: '同上级评级',
    calibHintV2: '有 HoD 的部门由 HoD 校准，HR 确认或退回；无 HoD 的部门与 HoD 本人的评估由 HR 在部门明细中校准（点部门名打开；HoD 待确认的部门须先在部门页指定负责人）。',
    calibHintLegacy: 'HR 校准评级：留空即沿用上级评级', csvSelfAt: '自评提交时间', csvOneAt: '1 对 1 面谈完成时间',
    selfDone: '已提交', selfPending: '未提交', oneDone: '已完成', onePending: '未完成',
    mgrPending: '待评级', noMgr: '未设直属上级（由 HR 直接评级）', finalPh: '未校准',
    saved: '已保存', recordOk: '已归档', writtenN: (n) => `已归档 ${n} 人`,
    empty: '暂无评估周期，可点击右上角「发起评估周期」。', emptyRo: '暂无评估周期。', loadFail: '加载失败，请刷新页面重试。', cancel: '取消',
    scopeCount: (n) => `将纳入 ${n} 人`, scopeCounting: '统计中…',
    launchAskT: '确认发起评估周期', launchAsk: (scope, n) => `参与范围：${scope}；将纳入 ${n} 人。发起后会通知这些员工开始自评。`, launchScopeDept: (name) => `${name}（含下级部门）`,   // CX-176
    inclNoLevel: (n) => `同时纳入未设职级的 ${n} 人`,
    noLevelWhy: '未设职级的通常是中介或外部聘用人员，默认不参与绩效评估。',
    del: '删除', delTitle: '删除此评估周期？', delDesc: '尚无人提交，可以安全删除（参与名单一并清除）。已有提交的周期只能关闭。',
    deleted: (n) => `已删除，清除 ${n} 条参与记录`,
    fAll: '全部', fSelfPending: '未提交自评', fSelfDone: '已提交自评', fUnrated: '待上级评级', fRated: '上级已评级', fNoFinal: '无评级（关闭时跳过）',
    filterDept: '全部部门', searchPh: '搜索姓名或工号…', shown: (n, t) => `显示 ${n} / ${t} 人`,
    pSelf: '自评', pOne: '1 对 1 面谈', pRated: '上级已评级', pFinal: '可归档', colEmpId: '工号',

    // 列表页的关闭确认：列表拿不到「绩效记录」的员工可见开关，按设置说明（G-10）
    closeDescList: '有评级的员工将生成一条绩效记录并记入员工档案（未校准的按上级评级记入），员工本人是否可见取决于「绩效记录」的员工可见设置；没有任何评级的员工将被跳过。关闭后不可再修改。',
    closeDescHidden: '有评级的员工将生成一条绩效记录并记入员工档案（未校准的按上级评级记入）；没有任何评级的员工将被跳过。关闭后不可再修改。',
    // 明细展开（B-F06）与面谈要点（D-17）
    colNotes: '面谈要点', xSelf: '自评', xPrevGoal: (n) => `上一周期目标 ${n}`, xOutcome: '关键成果', xChallenges: '遇到的挑战', xFeedback: '对团队/公司的建议',
    xExtra: '其他贡献', xGoalsNext: '下一周期目标', xMgr: '上级评语', xNotes: '面谈要点（上级与 HR 可见，不记入员工档案）', xNone: '（未填写）',
    // 服务端 code（B-S08）
    eNotFound: '未找到该员工的评估记录', eCycleNotFound: '未找到该评估周期', eCycleClosed: '该评估周期已关闭', eRating: '请选择有效的绩效评级',
    eHasSubmissions: '该评估周期已有提交内容，只能关闭，不能删除', eName: '请填写周期名称',
    export: '导出', colComment: '上级评语', exportedOk: (n) => `已导出 ${n} 人`, exportEmpty: '当前筛选没有人可导出',
    /* 只读档(performance=read):发起/改截止/校准/关闭/删除全是绩效域写接口,
       服务端一律 403,所以控件收起,只留可看的进度与评级。导出是纯前端拼 CSV
       (无服务端端点),不受影响,照旧可用。 */
    roPerf: '你的角色对绩效评估是只读权限：周期进度、评级分布与名单都能查看，但不能发起周期、修改截止日期、校准评级或关闭、删除周期。导出仍可用。',
    // 第二批波次 3（W3-S）：已关闭周期的各档人数、分布与名单都按档案评级（服务端部门行、分布、已归档人数同一口径）
    fileNote: '本周期已关闭：各档人数、评级分布与名单里的评级都以员工档案里的绩效记录为准；关闭后在档案里改过的按改后的评级计，并标「已改动」。',
    // 第二批 2.8（设计 8.6）：已关闭周期的结果告知与申诉入口
    resInfo: (on, dl) => `结果已于 ${on} 告知员工 · 申诉截止 ${dl}（含当日）`,
    resAppeals: (n, adj) => `申诉 ${n}（调整 ${adj}）`,
    resNotYet: '员工尚未收到结果通知，申诉期限未开始。',
    resPreFeature: '本周期结果在系统内申诉上线前已通知员工，按制度申诉期限已届满，本周期不开放系统内申诉。',
    resNotify: '通知员工并开放申诉',
    resNotifyT: '通知员工并开放申诉？',
    resNotifyAsk: (n, dl) => `将向本周期 ${n} 名员工发送结果通知。申诉期限为告知次日起 5 个工作日，截止 ${dl}（含当日）。发送后不能撤回。`,
    resNotifyOk: '发送通知',
    resNotified: (n, dl) => `已通知 ${n} 名员工，申诉截止 ${dl}`,
    /* 跨域:姓名点进去是 /admin/people/:id,属员工档案(people)域。 */
    noProfileLink: '你的角色没有「员工档案」权限，名单里的姓名不能点进档案页。',
    // 按阶段批量提醒（2026-10-07 B6）：周期列表、人员表、部门确认三处共用
    remindBtn: '按阶段提醒', remindStage: '提醒哪一步',
    stageLabel: {
      self: '自评未提交（提醒员工）',
      one_on_one: '1 对 1 面谈未确认（提醒员工）',
      manager: '上级未评级（提醒直属上级）',
      hod: '部门校准未提交（提醒 HoD）',
    },
    remindLead: '每位收件人只收到一条站内通知（留有邮箱的同时发邮件）；1 小时内已提醒过的会跳过；已完成这一步的不会收到。',
    remindMgrNote: '每位直属上级只收到一条提醒，写明其在本周期还有多少位下属待评级。',
    remindSkipN: (n) => `其中 ${n} 人在这一步已完成，将跳过。`,
    remindBlockedN: (n) => `其中 ${n} 人还不满足这一步的前提（未交自评、上级尚未完成面谈，或没有直属上级），将跳过，结果里逐条列出原因。`,
    remindHodPartial: (list) => `以下部门有成员不在你的数据范围内，不能按部门提醒 HoD：${list.join('、')}。请取消勾选这些部门，或改选其他步骤。`,
    // CX-184：结果框上方「成功 / 跳过 N 项」数的是部门，这里 k 数的是人（skippedPeople）—— 写「人」，不再与「项」混用
    remindDone: (n, k) => `已向 ${n} 人发出提醒${k ? `；另有 ${k} 人未发送（1 小时内已提醒过或不在提醒范围）` : ''}`,   // CX-218：与提醒规则同一说法
    remindNone: '这一步没有需要提醒的人，未发出提醒',

    // 第二批 W2-C（2026-10-08）：列表筛选（2.3-B）、地址栏失效提示（2.3-D）、部门明细（2.2）、看板（2.3-C）
    fKind: '类型', fStatus: '状态', fYear: '年份', fAllYears: '全部年份',
    shownCycles: (n, t) => (n === t ? `共 ${t} 个周期` : `显示 ${n} / ${t} 个周期`), noMatchCycles: '没有符合筛选条件的周期。',
    eCycleGone: '该评估周期不存在或已被删除，已回到周期列表。',
    eUnitGone: '未找到该部门（可能已调整，或不在你的数据范围内），已回到部门列表。',
    filterCleared: '有筛选条件已失效，已清除。',
    openDept: '打开部门明细', backDepts: '返回部门确认', exportDept: '导出本部门',
    stageAll: '全部阶段', fStage2: '阶段', fLevel: '职级', mgrAll: '全部直属上级', noMgrOpt: '无直属上级',
    lvAll: '全部职级', lvGrade: (g) => `职等 ${g}`, lvGroupGrade: '职等', lvGroupRank: '职级', lvNone: '未设职级', lvNoGrid: '未纳入职级体系',
    stageName: { self: '待自评', one: '待面谈', rate: '待上级评级', hod: '待 HoD 提交', hr: '待 HR 确认', confirmed: '已确认', norating: '无评级' },
    clearFilters: '清除筛选', shownPeople: (n, t) => `当前筛选 ${n} / ${t} 人`,
    bRatedAny: '已评级', bDistF: '当前筛选的评级分布 vs 配额',
    bQuotaOff: '有直属上级、职级或阶段筛选，或选了二级及以下部门时，不显示名额与超额。',
    bDirect: '本部门直属', bTotal: (name) => `${name}（合计）`,
    bExcl: (n) => `另有 ${n} 人不计入配额（已离职或 HoD 本人），不在以上统计中。`,
    bMgrTitle: '按直属上级看评级分布',
    bMgrLead: (min, diff) => `按上级本人给出的评级统计，不含 HoD 代评与已离职人员。已评 ${min} 人及以上、平均评级比整体高 ${diff} 档及以上标「偏宽」，低 ${diff} 档及以上标「偏严」。`,
    bMgrAnnual: '年度评级没有上级评级，不提供按直属上级的分布。', bMgrNone: '还没有上级评级。',
    tagLoose: '偏宽', tagTight: '偏严', tagFew: '样本不足', filteredNote: '当前筛选',
    mColTeam: '下属', mColRated: '已评', mColDiff: '与整体均值差（档）', mColAdj: 'HoD 调高 / 调低', mColTag: '标记',
    drillTitle: (dept, tier) => `${dept} · ${tier}`, drillAll: '全部', drillEmpty: '没有符合条件的人。',
    amended: (x) => `已改动（原评级 ${x}）`, proxyTag: 'HoD 代评', mgrLeft: '已离职',
  },
  en: {
    title: 'Review Cycles', lead: 'Launch a cycle → self-review → manager rating (the employee and the manager each log the 1-on-1, before or after the rating) → the HoD calibrates against the department quota and submits → HR opens the department detail to confirm or return it → close the cycle; final ratings go to the employee profile (and the 9-box). Annual ratings are proposed by the HoD and reviewed by HR.',
    tagQuarter: 'Quarterly', tagAnnual: 'Annual', lOne: '1-on-1', lHod: 'HoD submitted', lHr: 'HR confirmed', legacyTag: 'Legacy flow',
    newCycle: 'Launch review cycle', newCycleTitle: 'Launch Review Cycle', name: 'Cycle name', namePh: 'e.g. 2026-H2', scope: 'Scope', scopeAll: 'All active employees (excluding staff without a job level by default)', reqName: 'Enter a cycle name',
    colCycle: 'Cycle', colStatus: 'Status', colProgress: 'Progress', colDue: 'Self-Review Deadline', colCreated: 'Created',
    dueLabel: 'Self-review deadline', dueHint: 'Leave blank for no deadline', overdue: 'Overdue',
    editDue: 'Change deadline', dueTitle: 'Change Self-Review Deadline', dueSaved: 'Deadline updated', dueCleared: 'Deadline cleared', save: 'Save',
    open: 'In progress', closed: 'Closed', view: 'View', openCycle: 'Manage', created: (n) => `Launched · ${n} participant${n === 1 ? '' : 's'}`, createdExcl: (n, k) => `Launched · ${n} participant${n === 1 ? '' : 's'}; ${k} top-level department head${k === 1 ? '' : 's'} excluded (assessed under organizational performance)`,
    exclHods: (n) => `${n} top-level department head${n === 1 ? '' : 's'} excluded — they are assessed under organizational performance, not individual reviews`,
    self: 'Self-review', mgr: 'Manager rating', final: 'Ready to archive',
    back: 'Back to list', close: 'Close and archive', closeTitle: 'Close and archive this review cycle?',
    closeDesc: 'Each employee with a rating gets a performance record on their profile (the manager rating is used where not calibrated), visible to the employee. Employees with no rating are skipped. The cycle cannot be edited after closing.',
    closed2: (w, k) => `Closed: ${w} record${w === 1 ? '' : 's'} archived${k ? `, ${k} skipped (no rating)` : ''}`,
    dist: 'Final Rating Distribution (manager rating where not calibrated)', distFile: 'Rating distribution (on file)', noRatings: 'No ratings yet',
    kind: 'Cycle type', kindQuarter: 'Quarterly review', kindAnnual: 'Annual rating', kindHint: 'Annual ratings are proposed by each department’s HoD and reviewed by HR; employees and managers fill in nothing.',
    dueRate: 'Manager rating deadline', dueCalib: 'HoD calibration deadline', quota: 'Rating quota (%, converted to places per top-level department)', quotaHint: 'A+ / A / B+ are caps; departments under 10 people only get a warning.',
    vDepts: 'Department Confirmation', vBoard: 'Dashboard',
    dDept: 'Department', dHod: 'HoD', dHc: 'People', dSelf: 'Self-review', dOne: '1-on-1 (both)', dRated: 'Manager rating', dDist: 'Distribution (people / places)', dDistFile: 'Distribution on file (people / places)', dStatus: 'Status', dOps: '',
    noDept1: 'No level-1 department',
    stNone: 'Waiting for the HoD', stNoHod: 'No HoD — HR confirms directly', stSubmitted: (d) => `Submitted by HoD · ${d}`, stConfirmed: (d, who) => `Confirmed · ${d}${who ? ` · ${who}` : ''}`, stReturned: 'Returned',
    confirm: 'Confirm', confirmAsk: (d) => `Confirm the ratings of "${d}"?`, confirmAskBody: 'Once confirmed the department\'s ratings enter the cycle result; to change them later, undo the confirmation or return to the HoD first.', returnBtn: 'Return', returnTitle: 'Return to the HoD for recalibration', returnReason: 'Reason', returnPh: 'What needs to change…',
    confirmedOk: 'Confirmed', returnedOk: 'Returned; the HoD has been notified', overTag: 'Over',
    bStages: 'Stage completion', bSelf: 'Self-review', bOne: '1-on-1 confirmed by both', bRated: 'Manager rating', bHod: 'HoD submitted (depts)', bHr: 'HR confirmed (depts)',
    bDist: 'Company distribution vs quota', bActual: 'Actual', bQuota: 'Quota', bMatrix: 'Department × rating (people; red = over quota)',
    xHighlights: 'Key highlights', xHod: 'Calibration note',
    eDeptsUnconfirmed: (dd) => `Departments not confirmed yet: ${(dd.depts || []).slice(0, 5).join(', ')}${(dd.depts || []).length > 5 ? ' …' : ''}`,
    eNotSubmitted: 'The HoD has not submitted this department yet', eReasonReq: 'Give a reason for returning', eDeptConfirmed: 'This department has been confirmed and can no longer be changed',
    stReopened: 'Reopened', stHodPending: 'HoD unresolved: set the department owner on the Departments page', hodPendingShort: 'Unresolved',
    adjusted: 'Adjusted', calibTitle: 'Calibrate rating', calibReason: 'Reason', calibReasonOpt: 'Reason (optional)', calibReasonPh: 'Required when you change the manager rating',
    calibPick: (v) => `Calibrate to: ${v}`, calibClear: 'Clear the calibration and keep the manager rating',
    eHodReadonly: 'The HoD calibrates this department in this cycle; HR can only confirm or return it', eReasonCalib: 'Give a reason for changing the manager rating',
    eConfirmBlocked: 'This department can’t be confirmed yet', eAlreadyConfirmed: 'This department has already been confirmed',
    eHodUnresolved: 'This department’s HoD is unresolved (several candidates, or the owner is inactive). Set the department owner on the Departments page first',
    eHodUnresolvedRo: 'This department’s HoD is unresolved (several candidates, or the owner is inactive).',
    eDeptInactive: 'This level-1 department is inactive, so it has no HoD. Reactivate it on the Departments page, or move these people to an active department',
    stDeptInactive: 'Department inactive: reactivate it or move these people', deptInactiveShort: 'Dept inactive',
    issueRatingsChanged: (n) => `${n} rating(s) changed after the HoD submitted`,
    issueRatingsChangedConfirmed: (n) => `${n} rating(s) changed after confirmation; return or reopen it and confirm again, or the cycle can’t be closed`,
    eSelfConfirm: 'You are this department’s HoD, so another HR user must confirm or return it',
    eDeptNotFound: 'Department not found. Choose it again',
    eDeptsChanged: (dd) => `Members changed in these confirmed departments; return them and confirm again: ${deptNames(dd).slice(0, 5).join(', ')}${deptNames(dd).length > 5 ? ' …' : ''}`,
    issueRatingMissing: (n) => `${n} without a rating`,
    issueOverQuota: (o) => `Over quota: ${(o || []).map((x) => `${x.tier} ${x.count}/${x.allowed}`).join(', ')}`,
    issueMembershipChanged: (d) => `Members changed after the HoD submitted${memberDiff(d, (a, r) => ` (${a} added, ${r} removed)`)}`,
    issueMembersChangedConfirmed: (d) => `Members changed after confirmation${memberDiff(d, (a, r) => ` (${a} added, ${r} removed)`)}; return or reopen it and confirm again, or the cycle can’t be closed`,
    issueScopePartial: 'Some members are outside your data scope, so you can’t confirm this department',
    mustReturn: 'Return it to the HoD to adjust', fixInSheet: 'Adjust it in the department detail',
    reopen: 'Reopen', reopenTitle: 'Reopen department', reopenReason: 'Reason', reopenedOk: 'Department reopened',
    inclSub: 'Choosing a department includes all its sub-departments',
    oneBoth: 'Both confirmed', oneHalf: 'One side only',
    colName: 'Name', colDept: 'Department', colManager: 'Manager', colSelf: 'Self-Review', colOne: '1-on-1', colMgrRating: 'Manager Rating', colFinal: 'Final Rating', colCalib: 'Calibrated Rating', sameAsMgr: 'Same as manager',
    calibHintV2: 'Departments with an HoD are calibrated by the HoD, and HR confirms or returns them. For departments without an HoD, and for the HoD’s own review, HR calibrates in the department detail (select the department name; where the HoD is unresolved, set the department owner first).',
    calibHintLegacy: 'HR calibrated rating: leave blank to keep the manager rating', csvSelfAt: 'Self-Review Submitted At', csvOneAt: '1-on-1 Completed At',
    selfDone: 'Submitted', selfPending: 'Not submitted', oneDone: 'Completed', onePending: 'Not completed',
    mgrPending: 'Not rated', noMgr: 'No manager (rated by HR)', finalPh: 'Not calibrated',
    saved: 'Saved', recordOk: 'Archived', writtenN: (n) => `${n} archived`,
    empty: 'No review cycles yet. Select “Launch review cycle” at the top right.', emptyRo: 'No review cycles yet.', loadFail: 'Couldn’t load. Refresh the page to try again.', cancel: 'Cancel',
    scopeCount: (n) => `${n} participant${n === 1 ? '' : 's'}`, scopeCounting: 'Counting…',
    launchAskT: 'Launch this review cycle?', launchAsk: (scope, n) => `Scope: ${scope}; ${n} participant${n === 1 ? '' : 's'}. Launching notifies them to start their self-reviews.`, launchScopeDept: (name) => `${name} (incl. sub-departments)`,
    inclNoLevel: (n) => `Also include ${n} without a job level`,
    noLevelWhy: 'Staff with no job level are normally agency or external hires, and are excluded from performance reviews by default.',
    del: 'Delete', delTitle: 'Delete this review cycle?', delDesc: 'Nothing has been submitted yet, so this is safe (the participant list goes too). Cycles with submissions can only be closed.',
    deleted: (n) => `Deleted — ${n} participant rows removed`,
    fAll: 'All', fSelfPending: 'Self-review not submitted', fSelfDone: 'Self-review submitted', fUnrated: 'Awaiting manager rating', fRated: 'Rated by manager', fNoFinal: 'No rating (skipped at close)',
    filterDept: 'All departments', searchPh: 'Search name or ID…', shown: (n, t) => `${n} of ${t}`,
    pSelf: 'Self-review', pOne: '1-on-1', pRated: 'Rated by manager', pFinal: 'Ready to archive', colEmpId: 'Employee ID',

    closeDescList: 'Each employee with a rating gets a performance record on their profile (the manager rating is used where not calibrated); whether employees can see it follows the Performance Record type’s employee-visible setting. Employees with no rating are skipped. The cycle cannot be edited after closing.',
    closeDescHidden: 'Each employee with a rating gets a performance record on their profile (the manager rating is used where not calibrated). Employees with no rating are skipped. The cycle cannot be edited after closing.',
    colNotes: 'Conversation Notes', xSelf: 'Self-review', xPrevGoal: (n) => `Previous cycle goal ${n}`, xOutcome: 'Key outcomes', xChallenges: 'Challenges encountered', xFeedback: 'Suggestions for the team/company',
    xExtra: 'Other contributions', xGoalsNext: 'Goals for the next cycle', xMgr: 'Manager comments', xNotes: 'Conversation notes (visible to the manager and HR; not saved to the employee profile)', xNone: '(not provided)',
    eNotFound: 'Review record not found', eCycleNotFound: 'Review cycle not found', eCycleClosed: 'This review cycle is closed', eRating: 'Select a valid performance rating',
    eHasSubmissions: 'This cycle already has submissions; close it instead of deleting it', eName: 'Enter a cycle name',
    export: 'Export', colComment: 'Manager Comments', exportedOk: (n) => `${n} row${n === 1 ? '' : 's'} exported`,
    exportEmpty: 'Nothing to export in this filter',
    roPerf: 'Your role has read-only access to performance reviews — progress, rating distribution and the roster all read normally, but you cannot launch a cycle, change a deadline, calibrate a rating or close/delete a cycle. Export still works.',
    fileNote: 'This cycle is closed. Rating counts, distributions and the ratings in the lists follow the performance record on file; a rating changed on the profile after closing counts as changed and is marked "Changed".',
    resInfo: (on, dl) => `Results communicated on ${on} · Appeal deadline ${dl} (inclusive)`,
    resAppeals: (n, adj) => `Appeals ${n} (adjusted ${adj})`,
    resNotYet: 'Employees have not been notified of their results; the appeal window has not started.',
    resPreFeature: 'Results for this cycle were communicated to employees before in-system appeals were introduced. Under the policy the appeal period has ended, so in-system appeals are not open for this cycle.',
    resNotify: 'Notify employees and open appeals',
    resNotifyT: 'Notify employees and open appeals?',
    resNotifyAsk: (n, dl) => `Results will be sent to ${n} employee${n === 1 ? '' : 's'} in this cycle. The appeal period is five working days starting the next working day; the deadline is ${dl} (inclusive). This cannot be undone.`,
    resNotifyOk: 'Send notifications',
    resNotified: (n, dl) => `${n} employee${n === 1 ? '' : 's'} notified. Appeal deadline ${dl}`,
    noProfileLink: 'Your role has no access to Employee profiles, so names in the roster do not open a profile.',
    remindBtn: 'Send reminders', remindStage: 'Step',
    stageLabel: {
      self: 'Self-review not submitted (employees)',
      one_on_one: '1-on-1 not confirmed (employees)',
      manager: 'Rating missing (managers)',
      hod: 'Calibration not submitted (HoDs)',
    },
    remindLead: 'Each recipient gets one in-app notification (plus email where an address is on file). Anyone reminded in the last hour, or already done at this step, is skipped.',
    remindMgrNote: 'Each manager gets a single reminder stating how many direct reports in this cycle still await their rating.',
    remindSkipN: (n) => `${n} of them are already done at this step and will be skipped.`,
    remindBlockedN: (n) => `${n} of them are not ready for this step yet (self-review not submitted, the manager has not held the 1-on-1, or no manager) and will be skipped; the result lists each reason.`,
    remindHodPartial: (list) => `These departments have members outside your data scope, so their HoD can't be reminded by department: ${list.join(', ')}. Deselect them or pick another step.`,
    remindDone: (n, k) => `Reminded ${n} ${n === 1 ? 'person' : 'people'}${k ? `; ${k} ${k === 1 ? 'person was' : 'people were'} not reminded (reminded within the last hour or out of scope)` : ''}`,
    remindNone: 'Nobody needs a reminder at this step — none sent',

    fKind: 'Type', fStatus: 'Status', fYear: 'Year', fAllYears: 'All years',
    shownCycles: (n, t) => (n === t ? `${t} cycle${t === 1 ? '' : 's'}` : `${n} of ${t} cycles`), noMatchCycles: 'No cycles match these filters.',
    eCycleGone: 'That review cycle no longer exists. You are back on the cycle list.',
    eUnitGone: 'That department wasn’t found (it may have changed, or it is outside your data scope). You are back on the department list.',
    filterCleared: 'A filter no longer applied and was cleared.',
    openDept: 'Open department detail', backDepts: 'Back to departments', exportDept: 'Export department',
    stageAll: 'All stages', fStage2: 'Stage', fLevel: 'Job level', mgrAll: 'All managers', noMgrOpt: 'No direct manager',
    lvAll: 'All job levels', lvGrade: (g) => `Grade ${g}`, lvGroupGrade: 'Job grade', lvGroupRank: 'Job level', lvNone: 'No job level', lvNoGrid: 'Not in job grade structure',
    stageName: { self: 'Awaiting self-review', one: '1-on-1 pending', rate: 'Awaiting manager rating', hod: 'Awaiting HoD submission', hr: 'Awaiting HR confirmation', confirmed: 'Confirmed', norating: 'No rating' },
    clearFilters: 'Clear filters', shownPeople: (n, t) => `${n} of ${t} people in this filter`,
    bRatedAny: 'Rated', bDistF: 'Distribution vs quota (current filter)',
    bQuotaOff: 'Quota and over-quota marks show only with no filter, or with a top-level department filter alone.',
    bDirect: 'Directly in this department', bTotal: (name) => `${name} (total)`,
    bExcl: (n) => `${n} more ${n === 1 ? 'person is' : 'people are'} not counted toward the quota (left, or the HoD’s own review) and are not in these figures.`,
    bMgrTitle: 'Rating distribution by manager',
    bMgrLead: (min, diff) => `Counts each manager’s own ratings, excluding HoD ratings on their behalf and people who have left. With ${min} or more ratings, an average at least ${diff} grade above the overall average is marked Lenient; ${diff} grade or more below, Strict.`,
    bMgrAnnual: 'Annual ratings have no manager rating, so there is no breakdown by manager.', bMgrNone: 'No manager ratings yet.',
    tagLoose: 'Lenient', tagTight: 'Strict', tagFew: 'Too few ratings', filteredNote: 'Current filter',
    mColTeam: 'Reports', mColRated: 'Rated', mColDiff: 'Vs. overall (grades)', mColAdj: 'HoD raised / lowered', mColTag: 'Flag',
    drillTitle: (dept, tier) => `${dept} · ${tier}`, drillAll: 'All', drillEmpty: 'Nobody matches.',
    amended: (x) => `Changed (was ${x})`, proxyTag: 'Rated by HoD', mgrLeft: 'Left',
  },
};

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

// DatePicker 交回来的是 Date,而 dueAt 的服务端契约是纯日历日 'YYYY-MM-DD'
// (POST /review-cycles 用 /^\d{4}-\d{2}-\d{2}$/ 校验,不合就当没填)。所以按
// **本地** 年月日拼串,不能用 toISOString().slice(0,10) —— 那取的是 UTC 日,
// Asia/Manila / Asia/Shanghai 一入夜就整体差一天。
const toDateStr = (d) => {
  if (!d) return '';
  if (typeof d === 'string') return fmtDate(d);   // 一致性整改 3
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};

/* ---------- 按阶段批量提醒（2026-10-07 B6）：POST /api/admin/review-reminders ----------
   三处入口：周期列表（by:'cycle'）、周期详情人员表（by:'item'）、部门确认（by:'dept'）。
   各周期有哪些步骤与服务端 reviewStageApplies 同口径：年度只有 HoD；v2 季度四步；旧流程只有自评与上级评级。
   下面的函数与常量都在模块级，引用稳定（useBulkSelection 的 isSelectable 要求）。 */
const RVC_STAGES = ['self', 'one_on_one', 'manager', 'hod'];
const rvcStagesFor = (c) => (c && c.kind === 'annual' ? ['hod'] : c && c.flow === 'v2' ? RVC_STAGES : ['self', 'manager']);
const rvcOpen = (c) => c.status === 'open';
// 部门确认面板：HR 已确认的部门整组锁定，没有可提醒的步骤
const rvcDeptSelectable = (r) => !(r.status && r.status.hrConfirmedAt);
// 部门有成员在当前账号的数据范围外（服务端在 depts[] 上标 scopePartial）：HoD 阶段要求整组在范围内，不能按部门提醒 HoD
const rvcPartialScope = (r) => !!(r && r.scopePartial);
// 人员表：已完成这一步 / 还不满足这一步的前提（服务端会逐条跳过：self_pending、manager_pending、no_manager）
const RVC_DONE = { self: (r) => !!r.selfAt, one_on_one: (r) => !!r.employeeOneOnOneAt, manager: (r) => !!r.managerRating };
const RVC_BLOCKED = { self: () => false, one_on_one: (r) => !r.selfAt || !r.oneOnOneAt, manager: (r) => !r.selfAt || !r.manager };
const remindDoneText = (s) => (r) => (r && (r.reminded || r.skippedPeople) ? s.remindDone(r.reminded || 0, r.skippedPeople || 0) : s.remindNone);

/* ---------- 第二批 2.3-B：周期列表筛选（地址栏 kind / status / year；纯函数，test/review-board-ui.test.js 用 vm 跑）----------
   kind：quarter = v2 季度、annual = v2 年度、legacy = 旧流程；year 按发起日期 createdAt 的本地年份（M2）。不认识的值当没选。 */
const RVC_KINDS = ['quarter', 'annual', 'legacy'];
const RVC_STATUSES = ['open', 'closed'];
const rvcKindOf = (c) => (c && c.flow === 'v2' ? (c.kind === 'annual' ? 'annual' : 'quarter') : 'legacy');
const rvcYearOf = (c) => dc.localDay(c && c.createdAt).slice(0, 4);
const rvcYears = (list) => [...new Set((list || []).map(rvcYearOf).filter(Boolean))].sort().reverse();
function rvcListQuery(p) {
  const q = p || {};
  return { kind: RVC_KINDS.includes(q.kind) ? q.kind : '', status: RVC_STATUSES.includes(q.status) ? q.status : '', year: /^\d{4}$/.test(String(q.year || '')) ? String(q.year) : '' };
}
function rvcFilterCycles(list, p) {
  const q = rvcListQuery(p);
  return (list || []).filter((c) => (!q.kind || rvcKindOf(c) === q.kind) && (!q.status || c.status === q.status) && (!q.year || rvcYearOf(c) === q.year));
}
// 页面层级签名：周期 | 部门 | 视图（缺省 = 部门确认，只有 board 算不同）。已在本页时再次点进同一层（通知、侧栏、工作台）
// = 签名不变的 push，要重新取数（设计 3.2，波次 2 复核修正）；筛选只用 replace，换周期 / 部门 / 视图会重挂或本身就取数，都不算
function rvcPageSig(search) {
  const p = new URLSearchParams(search || '');
  return [p.get('cycle') || '', p.get('unit') || '', p.get('view') === 'board' ? 'board' : ''].join('|');
}

/* ---------- 第二批 2.3-C：看板（纯函数）----------
   阶段判定用 deptcal.js 的 stageOf（与员工端 / 部门明细同口径）。年度周期没有自评这一步：deptcal.stageOf 先判「未交自评」，
   年度条目按「已交」代入，免得全部落在 self（W1-B 的 stageOf 待修，见交接说明）。 */
const RVC_STAGE_Q = ['self', 'one', 'rate', 'hod', 'hr', 'confirmed', 'norating'];
const RVC_STAGE_A = ['hod', 'hr', 'confirmed', 'norating'];
const rvcStagesOf = (kind) => (kind === 'annual' ? RVC_STAGE_A : RVC_STAGE_Q);
const rvcStageOf = (i, depts, kind) => dc.stageOf(kind === 'annual' ? { ...i, selfAt: i.selfAt || 'n/a', kind: 'annual' } : i, depts, kind);
// 已关闭周期：评级以档案为准（2.6 改过的取改后的值，服务端给 recordRating）；没有这个字段（进行中、旧接口）时用生效评级
const rvcRatingOf = (i, closed) => (closed && i && i.recordRating !== undefined ? i.recordRating || null : dc.effectiveOf(i));
// 配额档：周期配额的键（C、D 合并为 C/D），没有配额时用 deptcal 的默认顺序
const rvcTiersOf = (cycle) => { const k = cycle && cycle.quota ? Object.keys(cycle.quota) : []; return k.length ? k : dc.TIER_ORDER.slice(); };
// 看板的部门选项只到三级（四级及以下并入所属三级，匹配仍走 deptPath 全链）；范围裁剪后父级不在选项里的更深部门保留为根
function rvcBoardDeptOptions(opts) {
  const list = Array.isArray(opts) ? opts : [];
  const ids = new Set(list.map((o) => String(o.id)));
  return list.filter((o) => o.level == null || o.level <= 3 || !o.parentId || !ids.has(String(o.parentId)));
}
// 看板筛选：dept 走 deptPath（含下级），mgr 是 managerId（'__none' = 没有直属上级），lv 同 deptcal.matchLevel，stage 同 rvcStageOf
function rvcBoardFilter(items, q, depts, kind) {
  const f = q || {};
  return (items || []).filter((i) => {
    if (f.dept) {
      const p = Array.isArray(i.deptPath) ? i.deptPath : [];
      if (f.dept === dc.NONE ? p.length > 0 : !p.includes(String(f.dept))) return false;
    }
    if (f.mgr && (f.mgr === dc.NONE ? !!i.managerId : String(i.managerId || '') !== String(f.mgr))) return false;
    if (!dc.matchLevel(i, f.lv)) return false;
    if (f.stage && rvcStageOf(i, depts, kind) !== f.stage) return false;
    return true;
  });
}
// 只按一级部门（或不按部门）筛选、没有其他筛选时才显示名额与超额
function rvcQuotaMode(q, depts) {
  const f = q || {};
  if (f.mgr || f.lv || f.stage) return false;
  return !f.dept || (depts || []).some((x) => String(x.dept1Id) === String(f.dept));
}
const rvcCount = (items, closed) => {
  const counts = {};
  for (const i of items) { const b = dc.bucketOf(rvcRatingOf(i, closed)); if (b) counts[b] = (counts[b] || 0) + 1; }
  return counts;
};
/* 「部门 × 评级」的行：[{ key, label, sub, items, counts, allowed }]，只数计入配额的人（离职、HoD 本人不计）。
   没选部门：每个一级部门一行（d.depts 的顺序；有筛选时只列筛到人的部门）。
   选了部门：先一行该部门合计，再按 parentId 列出它的下一级部门（看板选项只到三级），不属于任何下一级的人归「本部门直属」。
   不按 deptPath 的下标找下一级：范围裁剪会去掉链上的部门，下标会错位。allowed 只在 rvcQuotaMode 时给。 */
function rvcMatrixRows(fItems, q, d, closed, noneLabel = '—') {
  const f = q || {};
  const depts = (d && d.depts) || [];
  const counted = (fItems || []).filter(dc.isCounted);
  const quota = rvcQuotaMode(f, depts);
  const filtered = !!(f.dept || f.mgr || f.lv || f.stage);
  const row = (key, label, list, extra) => ({ key, label, sub: false, items: list, counts: rvcCount(list, closed), allowed: null, ...extra });
  if (!f.dept) {
    return depts.map((g) => row(g.dept1Id, g.dept1 || noneLabel, counted.filter((i) => i.dept1Id === g.dept1Id), { allowed: quota ? g.allowed || null : null }))
      .filter((r) => !filtered || r.items.length > 0);
  }
  const opts = rvcBoardDeptOptions(d && d.deptOptions);
  const sel = String(f.dept);
  const me = opts.find((o) => String(o.id) === sel) || ((d && d.deptOptions) || []).find((o) => String(o.id) === sel);
  const g1 = depts.find((x) => String(x.dept1Id) === sel);
  const name = (me && (me.path || me.name)) || (g1 && g1.dept1) || sel;
  const out = [row('all:' + sel, name, counted, { allowed: quota && g1 ? g1.allowed || null : null, total: true })];
  const kids = opts.filter((o) => o.parentId != null && String(o.parentId) === sel);
  if (!kids.length) return out;
  const inKid = (i) => kids.some((k) => (i.deptPath || []).includes(String(k.id)));
  for (const k of kids) {
    const list = counted.filter((i) => (i.deptPath || []).includes(String(k.id)));
    if (list.length) out.push({ ...row(k.id, k.name, list), sub: true });
  }
  const direct = counted.filter((i) => !inKid(i));
  if (direct.length) out.push({ ...row('direct:' + sel, null, direct), sub: true, direct: true });
  return out;
}
const rvcOverTiers = (r) => (r && r.allowed ? dc.QUOTA_CAPPED.filter((t) => r.allowed[t] !== undefined && r.allowed[t] !== null && (r.counts[t] || 0) > Number(r.allowed[t])) : []);
/* 按直属上级看评级分布（M6）：deptcal.mgrDist（只看上级本人给的 managerRating，排除代评与不计入的人），另补
   team（计入的直属下属人数）、up / down（HoD 或 HR 把上级评级调高 / 调低的人数，代评不算）。没有上级的不列。
   默认按与整体均值差的绝对值倒序，差值相同按姓名。 */
function rvcMgrRows(items, ratingOptions) {
  const base = dc.mgrDist(items, ratingOptions);
  const scale = Array.isArray(ratingOptions) && ratingOptions.length ? ratingOptions : dc.RATING_ORDER;
  const extra = new Map();
  for (const i of items || []) {
    if (!dc.isCounted(i) || !i.managerId) continue;
    const k = String(i.managerId);
    const e = extra.get(k) || { team: 0, up: 0, down: 0 };
    e.team++;
    if (!dc.proxyOf(i) && i.managerRating && i.finalRating && i.finalRating !== i.managerRating) {
      const a = scale.indexOf(i.managerRating), b = scale.indexOf(i.finalRating);
      if (a >= 0 && b >= 0) { if (b < a) e.up++; else e.down++; }
    }
    extra.set(k, e);
  }
  const rows = base.rows.filter((r) => r.managerId !== null && r.managerId !== undefined)
    .map((r) => ({ ...r, team: 0, up: 0, down: 0, ...(extra.get(String(r.managerId)) || {}) }));
  const abs = (r) => (r.diff === null || r.diff === undefined ? -1 : Math.abs(r.diff));
  rows.sort((a, b) => abs(b) - abs(a) || String(a.manager || '').localeCompare(String(b.manager || '')));
  return { overall: base.overall, rows };
}

// 评级的显示名：canonical 值 → 当前语言（按下标与 ratingOptions_zh 配对；取不到中文就用 canonical）
const ratingLabelOf = (d, lang) => (v) => {
  const i = ((d && d.ratingOptions) || []).indexOf(v);
  const zh = i >= 0 ? ((d && d.ratingOptions_zh) || [])[i] : null;
  return lang === 'zh' && zh ? zh : v;
};
// 评级刻度说明（迁移 56，IA 4.8）：当前语言优先
const ratingDescOf = (d, lang) => (v) => {
  const i = ((d && d.ratingOptions) || []).indexOf(v);
  if (i < 0) return '';
  const zh = (d.ratingOptions_desc_zh || [])[i] || '', en = (d.ratingOptions_desc || [])[i] || '';
  return lang === 'zh' ? (zh || en) : (en || zh);
};
// 本地时间「yyyy-MM-dd HH:mm」（O1：已确认 · 时间 · 确认人；不用 slice(0,10)，那是 UTC 日）
const localStamp = (v) => {
  if (!v) return '';
  const x = new Date(v);
  if (Number.isNaN(x.getTime())) return String(v).slice(0, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${dc.localDay(v)} ${p(x.getHours())}:${p(x.getMinutes())}`;
};
// 确认人姓名（W2-A 在部门行 status 上补的字段；几种写法都认，没有就不显示）
const confirmerOf = (st) => (st ? st.hrName || (st.hrBy && st.hrBy.name) || (st.confirmedBy && st.confirmedBy.name) || st.confirmedByName || '' : '');

/* ---- CSV export ----
   Built client-side: /api/admin/export/* covers records/completion/attempts and
   has no reviews endpoint, while the whole cycle is already loaded here. v2 周期导出全部条目，部门明细另有「导出本部门」；
   旧流程导出评估表当前筛选的人。Escaping mirrors server.js csvEscape(), including
   the leading-apostrophe guard against Excel formula injection (CWE-1236). */
// Dates rather than the table's ✓ / ✗ marks: a spreadsheet is where HR chases
// who submitted when. Blank means not submitted.
const csvStamp = (v) => (v ? fmtDateTime(v) : '');
function downloadReviewCsv(s, name, rows, closed) {
  if (!rows.length) { Toast.warning(s.exportEmpty); return; }
  const lines = [
    [s.colName, s.colEmpId, s.colDept, s.colManager, s.csvSelfAt, s.csvOneAt, s.colNotes, s.colMgrRating, s.colComment, s.colCalib, s.colFinal],
    // 最终评级 = HR / HoD 校准评级，未校准时为上级评级（IA 2.5）；已关闭周期以档案里的评级为准（2.6）
    ...rows.map((i) => [
      i.name, i.employeeId, i.department || '', i.manager || '',
      csvStamp(i.selfAt), csvStamp(i.oneOnOneAt), i.oneOnOneNotes || '',
      i.managerRating || '', i.managerText || '', i.finalRating || '', rvcRatingOf(i, closed) || '',
    ]),
  ];
  saveCsv(csvText(lines), `${String(name).replace(/[\\/:*?"<>|]+/g, '-')}-${fmtDate(new Date())}.csv`);
  Toast.success(s.exportedOk(rows.length));
}

// 周期详情与部门明细共用的服务端错误码 → 文案（B-S08）
const rvcErrMap = (s) => ({ not_found: () => s.eNotFound, cycle_not_found: () => s.eCycleNotFound, cycle_closed: () => s.eCycleClosed, rating_required: () => s.eRating,
  depts_unconfirmed: (dd) => s.eDeptsUnconfirmed(dd), dept_confirmed: () => s.eDeptConfirmed,
  hod_calibration_readonly: () => s.eHodReadonly, reason_required: () => s.eReasonCalib, hod_unresolved: () => s.eHodUnresolved,
  dept_inactive: () => s.eDeptInactive, depts_changed: (dd) => s.eDeptsChanged(dd) });
// 放 DeptFilter 的 Semi 弹窗：内容层 overflow:hidden 会截掉部门弹层，改成 visible（配合 motion={false}，见发起对话框）
const dpfModalRender = (node) => cloneElement(node, { style: { ...((node && node.props && node.props.style) || {}), overflow: 'visible' } });

// 三处共用的确认窗：选步骤 + 说明；disabled 里的步骤置灰（如部门有成员越界时的 HoD）
function RemindModal({ s, visible, names, stages, disabled, stage, setStage, notes, loading, onOk, onCancel }) {
  const off = disabled || new Set();
  return (
    <BulkConfirmModal visible={visible} op={s.remindBtn} names={names} okDisabled={!stage || off.has(stage)} loading={loading} onOk={onOk} onCancel={onCancel}>
      <div className="ppl-flabel">{s.remindStage}</div>
      <Select className="rvc-remind-sel" value={stage || undefined} onChange={(v) => setStage(v || '')} aria-label={s.remindStage}
        optionList={(stages || []).map((k) => ({ value: k, label: s.stageLabel[k], disabled: off.has(k) }))} />
      <p className="rvc-remind-note">{s.remindLead}</p>
      {stage === 'manager' && <p className="rvc-remind-note">{s.remindMgrNote}</p>}
      {(notes || []).filter(Boolean).map((n, i) => <p key={i} className="rvc-remind-note">{n}</p>)}
    </BulkConfirmModal>
  );
}

export default function ReviewCycles() {
  const { lang } = useI18n();
  const s = T[lang];
  const listErrMap = { name_required: () => s.eName, cycle_not_found: () => s.eCycleNotFound, cycle_closed: () => s.eCycleClosed, has_submissions: () => s.eHasSubmissions,
    dept_not_found: () => s.eDeptNotFound, depts_unconfirmed: (dd) => s.eDeptsUnconfirmed(dd), depts_changed: (dd) => s.eDeptsChanged(dd) };
  const navigate = useNavigate();
  /* 授权闸门。本页所属域是 performance,页面的读接口(GET review-cycles、GET
     review-cycles/:id)进得来就已经过了;发起对话框的部门选项与人数来自 POST review-cycles
     的预览(dryRun)响应,本页不再读员工名单(P0 1.5)。
     要判两件事:
       1) 发起/改截止/校准/关闭/删除全是 performance 写 —— read 档必 403,收起控件;
       2) 名单里的姓名跳 /admin/people/:id 是 **people** 域,跨域 —— 无 people 读
          权限时不做成链接(点了会被 App.jsx 的守卫弹回工作台)。
     导出是纯前端拼 CSV,没有服务端端点,不受任何授权影响,保持原样。
     老服务(无 grants)与超管:两个都为 true,与改动前完全一致。 */
  const { user } = useAuth();
  const canEdit = canWriteDomain(user, 'performance');
  const canProfile = canReadDomain(user, 'people');
  const listQ = useAsync(() => api.get('/api/admin/review-cycles'), []);
  // 2.3-D：打开哪个周期由地址栏 ?cycle= 决定（通知直达、刷新、返回都能还原；已在本页时点通知同样直接从参数推导）
  const [params, patch] = useUrlState();
  const openId = params.cycle ? String(params.cycle) : '';
  const openCycle = useCallback((cid) => patch({ cycle: cid, view: null, unit: null }, { clear: [...BOARD_KEYS, ...REVIEW_FILTER_KEYS] }), [patch]);
  // 回到列表：保留列表筛选（kind / status / year），清掉周期层的参数
  const backToList = useCallback(() => patch({ cycle: null, view: null, unit: null }, { clear: [...BOARD_KEYS, ...REVIEW_FILTER_KEYS] }), [patch]);
  // 周期不存在（404）时回列表用 replace：失效的地址不留在历史里 —— push 的话按返回键又回到它、再被送回列表，退不出本页（波次 2 复核修正）
  const dropGoneCycle = useCallback(() => patch({ cycle: null, view: null, unit: null }, { clear: [...BOARD_KEYS, ...REVIEW_FILTER_KEYS], push: false }), [patch]);
  // 2.3-B：列表筛选
  const lq = rvcListQuery(params);
  const years = useMemo(() => rvcYears(listQ.data), [listQ.data]);
  const cycles = useMemo(() => rvcFilterCycles(listQ.data, lq), [listQ.data, lq.kind, lq.status, lq.year]); // eslint-disable-line react-hooks/exhaustive-deps
  // 地址栏里的年份在列表里已不存在（周期被删）：清掉并提示，免得列表看起来是空的（只在列表已加载、且不在周期详情时判断）
  useEffect(() => {
    if (openId || !listQ.data || !params.year) return;
    if (!lq.year || !years.includes(lq.year)) { patch({ year: null }); Toast.info(s.filterCleared); }
  }, [openId, listQ.data, params.year, lq.year, years]); // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cName, setCName] = useState('');
  const [cDept, setCDept] = useState('');
  // 自评截止日期,选填。存 'yyyy-MM-dd' 字符串而不是 Date:定型得越早,越不会
  // 在提交那一步被时区拉走一天。'' = 不填 = 服务端写 null。
  const [cDue, setCDue] = useState('');
  const [includeNoLevel, setIncludeNoLevel] = useState(false);
  // 绩效流程 v2：类型、上级评级 / HoD 校准截止日、配额（%）
  const [cKind, setCKind] = useState('quarter');
  const [cDueRate, setCDueRate] = useState('');
  const [cDueCalib, setCDueCalib] = useState('');
  const [cQuota, setCQuota] = useState({ 'A+': 2, A: 8, 'B+': 15, B: 70, 'C/D': 5 });
  // U1：发起前向服务端预览人数（同一口径：在职、职级、范围、排除一级部门负责人）
  const [preview, setPreview] = useState(null);
  // P0 1.5：部门选项取自预览响应的 deptOptions（按数据范围裁过、含没有直属成员的上级部门，value 是部门 id）。
  // 单独保存最近一次成功的选项：某次预览失败（越界、网络）只清掉人数，不清空下拉，HR 仍能改选。
  const [deptOpts, setDeptOpts] = useState([]);
  useEffect(() => {
    if (!creating) { setPreview(null); return undefined; }
    let alive = true;
    const base = { dryRun: true, flow: 'v2', kind: cKind, includeNoLevel };
    const keepOpts = (r) => { if (alive && r && Array.isArray(r.deptOptions)) setDeptOpts(r.deptOptions); };
    api.post('/api/admin/review-cycles', { ...base, departmentId: cDept || undefined })
      .then((r) => { if (!alive) return; setPreview(r); keepOpts(r); })
      .catch((err) => {
        if (!alive) return;
        setPreview(null);
        // 草稿里留着的部门已被删除或改组：清掉，下一次预览不带部门，顺带取回选项
        if (cDept && err && err.data && err.data.code === 'dept_not_found') setCDept('');
      });
    // 还没有拿到过选项、而草稿里已带部门时，另发一次不带部门的预览只取选项
    if (cDept && !deptOpts.length) api.post('/api/admin/review-cycles', base).then(keepOpts).catch(() => {});
    return () => { alive = false; };
  }, [creating, cDept, includeNoLevel, cKind]); // eslint-disable-line react-hooks/exhaustive-deps
  // 行内改截止日期:dueEdit 是正在改的那个周期(null = 弹窗关着),dueVal 同样是
  // 'yyyy-MM-dd' 或 ''(留空即清除截止日期)。
  const [dueEdit, setDueEdit] = useState(null);
  const [dueVal, setDueVal] = useState('');
  const [dueSaving, setDueSaving] = useState(false);
  // Launching a cycle is a 4k-row write with no undo once anyone submits, so the
  // headcount the chosen scope resolves to is shown BEFORE the button is hit.
  // P0 1.5：人数与「未设职级」人数都取服务端预览（participants / noLevel），与正式发起同一口径
  // （所选部门含全部下级部门、数据范围、排除一级部门负责人）。前端不再按 roster 的部门名精确计数。
  // Agency / externally-hired staff have no job level and are not rated by default;
  // including them stays an explicit opt-in so HR sees who is left out and why.
  const noLevelInScope = preview ? Number(preview.noLevel) || 0 : 0;

  // CX-176：发起前用确认框写明范围与人数（未选部门 = 全部在职员工）—— 原来直接发起，误选范围时会建出全员周期
  // CX-176（R193）：部门选项是扁平的 { id, name, path }（org.js deptOptionsOf），按 id 找名称；名称有层级时写完整路径
  const deptLabelOf = (list, v) => { const o = (list || []).find((x) => x && String(x.id) === String(v)); if (!o) return null; return (typeof o.path === 'string' && o.path) || (Array.isArray(o.path) && o.path.join(' › ')) || o.name || null; };
  const confirmCreate = () => {
    if (!cName.trim()) { Toast.error(s.reqName); return; }
    const scope = cDept ? s.launchScopeDept(deptLabelOf(deptOpts, cDept) || cDept) : s.scopeAll;
    Modal.confirm({ title: s.launchAskT, content: s.launchAsk(scope, preview ? Number(preview.participants) || 0 : '—'), okText: s.newCycle, cancelText: s.cancel, onOk: () => create() });
  };
  const create = async () => {
    if (!cName.trim()) { Toast.error(s.reqName); return; }
    setSaving(true);
    try {
      // dueAt 必须是纯日历日字符串 —— 服务端只认 /^\d{4}-\d{2}-\d{2}$/,Date 或
      // ISO 时间戳都会被当成没填。不填就整个省掉字段,截止日期保持 null(员工端
      // 待办里那句「截止 …」也就不显示)。
      const r = await api.post('/api/admin/review-cycles', {
        name: cName.trim(), departmentId: cDept || undefined, includeNoLevel, dueAt: cDue || undefined,
        flow: 'v2', kind: cKind, dueRateAt: cDueRate || undefined, dueCalibAt: cDueCalib || undefined, quota: cQuota,
      });
      Toast.success(r.excludedHods ? s.createdExcl(r.participants, r.excludedHods) : s.created(r.participants));
      setCreating(false); setCName(''); setCDept(''); setCDue(''); setIncludeNoLevel(false); setCDueRate(''); setCDueCalib(''); setCKind('quarter');
      listQ.reload();
      openCycle(r.cycle.id);
    } catch (err) { Toast.error(errText(err, listErrMap)); }
    setSaving(false);
  };

  // 关掉创建弹窗时把日期清掉。名称/范围留着还算「上次没填完的草稿」,而一个上个
  // 周期的截止日期留在框里,下次打开很容易被顺手确认掉。
  const cancelCreate = () => { setCreating(false); setCDue(''); };

  // Closing is a per-row action, not a detail-page-only one: HR runs several
  // cycles at once and the list is where they see which ones are finished.
  const closeCycle = async (c) => {
    try {
      const r = await api.post(`/api/admin/review-cycles/${c.id}/close`, {});
      Toast.success(s.closed2(r.written, r.skipped));
      listQ.reload();
    } catch (err) { Toast.error(errText(err, listErrMap)); }
  };

  const removeCycle = async (c) => {
    try {
      const r = await api.del(`/api/admin/review-cycles/${c.id}`);
      Toast.success(s.deleted(r.removed));
      listQ.reload();
    } catch (err) { Toast.error(errText(err, listErrMap)); }
  };

  // 改截止日期同样是行内动作:一个周期的截止日期通常是在列表上看到「快到了 / 已
  // 逾期」时才想改的,不该逼 HR 先点进详情页。
  const openDueEdit = (c) => { setDueEdit(c); setDueVal(c.dueAt ? String(c.dueAt).slice(0, 10) : ''); };
  const closeDueEdit = () => { setDueEdit(null); setDueVal(''); };
  const saveDue = async () => {
    if (!dueEdit) return;
    setDueSaving(true);
    try {
      // 留空要显式发 null(而不是省掉字段):null 才是「清除截止日期」的意思。
      await api.put(`/api/admin/review-cycles/${dueEdit.id}/due`, { dueAt: dueVal || null });
      Toast.success(dueVal ? s.dueSaved : s.dueCleared);
      closeDueEdit();
      listQ.reload();
    } catch (err) { Toast.error(errText(err, listErrMap)); }
    setDueSaving(false);
  };

  // 入口 1：周期列表勾选进行中的周期 → 按阶段提醒（by:'cycle'；数据范围受限的账号由服务端收窄到范围内的人）。
  // hook 必须写在下面的提前返回之前。
  const sel = useBulkSelection({ rows: cycles, isSelectable: rvcOpen, resetOn: [lq.kind, lq.status, lq.year], ready: !!listQ.data });
  const runner = useBulkRunner();
  const [remind, setRemind] = useState(null);       // { ids, list: [名称], names: { id: 名称 }, stages }
  const [remindStage, setRemindStage] = useState('');
  const openRemind = () => {
    const picked = sel.rows;
    if (!picked.length) return;
    const stages = RVC_STAGES.filter((k) => picked.some((c) => rvcStagesFor(c).includes(k)));
    const names = {};
    picked.forEach((c) => { names[String(c.id)] = c.name; });
    setRemind({ ids: picked.map((c) => String(c.id)), list: picked.map((c) => c.name), names, stages });
    setRemindStage(stages[0] || '');
  };
  const submitRemind = async () => {
    if (!remind || !remindStage) return;
    await runner.run({
      op: s.remindBtn, names: remind.names,
      request: () => api.post('/api/admin/review-reminders', { stage: remindStage, by: 'cycle', ids: remind.ids }),
      doneText: remindDoneText(s),
      onSettled: () => sel.clear(),
    });
    setRemind(null);
  };

  // 周期详情不等列表：通知直达时列表还没加载完也能先打开（key = 周期 id：换周期整页重挂，旧周期的数据与筛选不会带过去）
  if (openId) {
    return (
      <CycleDetail key={openId} s={s} id={openId} params={params} patch={patch}
        onBack={() => { backToList(); listQ.reload(); }} onGone={() => { dropGoneCycle(); listQ.reload(); }}
        navigate={navigate} canEdit={canEdit} canProfile={canProfile} />
    );
  }
  if (listQ.error) return <div className="wrap rvc-wrap"><Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${listQ.error.message}`} /></div>;
  if (!listQ.data) return <div className="wrap rvc-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;
  const listFiltered = !!(lq.kind || lq.status || lq.year);

  return (
    <div className="wrap rvc-wrap">
      <div className="tset-head" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div><h1 className="tset-title">{s.title}</h1><div className="tset-lead">{s.lead}</div></div>
        {/* POST /api/admin/review-cycles 是绩效写:只读档收起,换一行说明。 */}
        {canEdit && <Button icon={<IconPlus />} theme="solid" type="primary" onClick={() => setCreating(true)}>{s.newCycle}</Button>}
      </div>
      {!canEdit && <div className="tset-foot">{s.roPerf}</div>}
      {!canProfile && <div className="tset-foot">{s.noProfileLink}</div>}
      {canEdit && (
        <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} pageOnly={false} selectPage={sel.togglePage}>
          <Button size="small" theme="light" type="primary" disabled={runner.busy} onClick={openRemind}>{s.remindBtn}</Button>
        </BulkBar>
      )}
      {/* 2.3-B：类型 / 状态 / 年份，写进地址栏（replace），打开周期再返回时还在 */}
      {listQ.data.length > 0 && (
        <div className="rvc-filters">
          <Select insetLabel={s.fKind} value={lq.kind || undefined} placeholder={s.fAll} showClear style={{ width: 170 }}
            onChange={(v) => patch({ kind: v || null })}
            optionList={[{ value: 'quarter', label: s.kindQuarter }, { value: 'annual', label: s.kindAnnual }, { value: 'legacy', label: s.legacyTag }]} />
          <Select insetLabel={s.fStatus} value={lq.status || undefined} placeholder={s.fAll} showClear style={{ width: 150 }}
            onChange={(v) => patch({ status: v || null })}
            optionList={[{ value: 'open', label: s.open }, { value: 'closed', label: s.closed }]} />
          <Select insetLabel={s.fYear} value={lq.year || undefined} placeholder={s.fAllYears} showClear style={{ width: 150 }}
            onChange={(v) => patch({ year: v || null })}
            optionList={years.map((y) => ({ value: y, label: y }))} />
          <Text type="tertiary" size="small">{s.shownCycles(cycles.length, listQ.data.length)}</Text>
        </div>
      )}
      <div className="ppl-card">
        {listQ.data.length === 0 ? <Empty description={canEdit ? s.empty : s.emptyRo} style={{ padding: 30 }} />
          : cycles.length === 0 && listFiltered ? <Empty description={s.noMatchCycles} style={{ padding: 30 }} /> : (
          <div ref={sel.wrapRef}>
          <Table rowKey="id" dataSource={cycles} pagination={false} size="small" className="dt-table"
            rowSelection={canEdit ? sel.rowSelection : undefined}
            {...resizableTable(dataTableColumns([   // 一致性整改 2：标题列 ≥ 220 不折行、操作列靠右
              // 名称折行时 <a> 只有文字本身可点（两行之间点不到），改成整格可点（QA 2026-10-06 P5）
              { title: s.colCycle, dataIndex: 'name', width: 190, render: (v, c) => (   // CX-012：160 → 190，英文周期名不在单词中折行
                <div className="rvc-name" role="button" tabIndex={0} onClick={() => openCycle(c.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCycle(c.id); } }}>
                  <span className="rvc-name-t">{v}</span>
                  {c.flow === 'v2'
                    ? <Tag size="small" color={c.kind === 'annual' ? 'violet' : 'blue'} type="light">{c.kind === 'annual' ? s.tagAnnual : s.tagQuarter}</Tag>
                    : <Tag size="small" type="light">{s.legacyTag}</Tag>}
                </div>
              ) },
              { title: s.colStatus, dataIndex: 'status', width: 125, render: (v) => <Tag color={v === 'open' ? 'green' : 'grey'} type="light" shape="circle">{v === 'open' ? s.open : s.closed}</Tag> },
              // Three nowrap pills with 4-digit denominators need ~400px, and .ppl-card
              // tables are table-layout:fixed with overflow:hidden, so the old width:300
              // cut 已定级 off. A bigger width is no fix: the auto 周期 column absorbs the
              // whole deficit and collapses. Sharing the slack and wrapping instead.
              { title: s.colProgress, dataIndex: 'total', width: 320, render: (_, c) => (
                <>
                  {/* V1（10/8 同行反馈）：手机卡片里宽、窄两套同时出现、右侧被截断 —— Semi 的 .semi-space{display:inline-flex}
                      压过了 .rvc-prog-wide 在 ≤900px 的 display:none。类名放到外层 span 上，Space 只管排版。 */}
                  <span className="rvc-prog-wide">
                  {c.flow === 'v2' ? (
                    // 绩效流程 v2：自评 / 面谈双方确认 / 上级评级 / HoD 提交（部门）/ HR 确认（部门），不再显示「可归档」
                    <Space wrap>
                      {c.kind !== 'annual' && <span className="pill muted">{s.self} <b className="tnum">{c.selfDone}/{c.total}</b></span>}
                      {c.kind !== 'annual' && <span className="pill muted">{s.lOne} <b className="tnum">{c.oneDone || 0}/{c.total}</b></span>}
                      {c.kind !== 'annual' && <span className="pill muted">{s.mgr} <b className="tnum">{c.mgrDone}/{c.total}</b></span>}
                      <span className="pill muted">{s.lHod} <b className="tnum">{c.deptSubmitted || 0}/{c.deptTotal || 0}</b></span>
                      <span className={'pill ' + (c.deptTotal && c.deptConfirmed === c.deptTotal ? 'ok' : 'muted')}>{s.lHr} <b className="tnum">{c.deptConfirmed || 0}/{c.deptTotal || 0}</b></span>
                    </Space>
                  ) : (
                    <Space wrap>
                      <span className="pill muted">{s.self} <b className="tnum">{c.selfDone}/{c.total}</b></span>
                      <span className="pill muted">{s.mgr} <b className="tnum">{c.mgrDone}/{c.total}</b></span>
                      {/* 已关闭周期：finalDone = 档案里有评级的人数（W3-S），标「已归档」，与手机的「已归档 N 人」一致；进行中仍是「可归档」 */}
                      <span className="pill ok">{c.status === 'open' ? s.final : s.recordOk} <b className="tnum">{c.finalDone}/{c.total}</b></span>
                    </Space>
                  )}
                  </span>
                  {/* Card mode: three fractions with 4-digit denominators wrap onto
                      three lines at 390px, so the phone gets the share instead —
                      and a closed cycle only has one number worth reading. */}
                  <span className="rvc-prog-narrow">
                    {c.status === 'open' ? (c.flow === 'v2' ? (
                      <>
                        {c.kind !== 'annual' && <span className="pill muted">{s.self} <b className="tnum">{pct(c.selfDone, c.total)}%</b></span>}
                        <span className="pill muted">{s.lHr} <b className="tnum">{c.deptConfirmed || 0}/{c.deptTotal || 0}</b></span>
                      </>
                    ) : (
                      <>
                        <span className="pill muted">{s.self} <b className="tnum">{pct(c.selfDone, c.total)}%</b></span>
                        <span className="pill muted">{s.mgr} <b className="tnum">{pct(c.mgrDone, c.total)}%</b></span>
                      </>
                    )) : <span className="pill ok">{s.writtenN(c.finalDone)}</span>}
                  </span>
                </>
              ) },
              // 自评截止日期,可以为空。逾期只对进行中的周期有意义 —— 已关闭的
              // 周期截止日期几乎必然在过去,标红只是噪音。判定用 daysUntil():它按
              // 本地午夜算天数,和员工端那句「截止 …」用的是同一套算法。
              { title: s.colDue, dataIndex: 'dueAt', width: 150, render: (v, c) => {
                const day = v ? String(v).slice(0, 10) : '';
                if (!day) return <Text type="quaternary" size="small">—</Text>;
                if (c.status === 'open' && daysUntil(day) < 0) {
                  return (
                    <span title={`${day} · ${s.overdue}`}>
                      <Tag color="red" type="light" shape="circle" className="tnum">{day}</Tag>
                    </span>
                  );
                }
                return <Text type="tertiary" size="small" className="tnum">{day}</Text>;
              } },
              // 日期不折行（W1-C 排版检查：「2026-10-07」在 105 宽的列里被折成两行）；按本地日历日显示
              { title: s.colCreated, dataIndex: 'createdAt', width: 118, render: (v) => <Text type="tertiary" size="small" className="tnum" style={{ whiteSpace: 'nowrap' }}>{dc.localDay(v)}</Text> },
              { title: '', dataIndex: 'op', width: 200, align: 'right', render: (_, c) => (
                <Space spacing={2} className="rvc-rowops">
                  <Button theme="borderless" size="small" onClick={() => openCycle(c.id)}>{c.status === 'open' ? s.openCycle : s.view}</Button>
                  {/* 已关闭的周期不给改:截止日期此时只是历史记录。
                      改截止 / 关闭 / 删除三条都是绩效写,只读档一并收起。 */}
                  {c.status === 'open' && canEdit && (
                    <Button theme="borderless" size="small" type="tertiary" onClick={() => openDueEdit(c)}>{s.editDue}</Button>
                  )}
                  {c.status === 'open' && canEdit && (
                    <Popconfirm title={s.closeTitle} content={s.closeDescList} okType="danger" okText={s.close}
                      cancelText={s.cancel} onConfirm={() => closeCycle(c)}>
                      <Button theme="borderless" size="small" type="tertiary">{s.close}</Button>
                    </Popconfirm>
                  )}
                  {/* Only an untouched, still-open cycle can be discarded — the
                      server enforces the same rule, this just hides a dead button. */}
                  {c.status === 'open' && canEdit && !c.selfDone && !c.mgrDone && !c.finalDone && (
                    <Popconfirm title={s.delTitle} content={s.delDesc} okType="danger" okText={s.del}
                      cancelText={s.cancel} onConfirm={() => removeCycle(c)}>
                      <Button theme="borderless" size="small" type="danger">{s.del}</Button>
                    </Popconfirm>
                  )}
                </Space>
              ) },
            ], { titleKey: 'name', opsKey: 'op' }), { extra: canEdit ? BULK_SEL_EXTRA : 0 })} />
          </div>
        )}
      </div>
      {canEdit && (
        <RemindModal s={s} visible={!!remind} names={remind ? remind.list : []} stages={remind ? remind.stages : []}
          stage={remindStage} setStage={setRemindStage} loading={runner.busy} onOk={submitRemind} onCancel={() => setRemind(null)} />
      )}
      {runner.modal}
      {/* 3.1：参与范围用全站的部门筛选（DeptFilter）。它的弹层是绝对定位、手机上是 position:fixed 的底部抽屉：
          Semi 弹窗内容层 overflow:hidden 会把弹层截掉，入场动画留下的 transform 又会让抽屉相对弹窗定位 ——
          所以这个弹窗关掉动画，并把内容层改成 overflow:visible（内联样式，不追加 CSS）。 */}
      <Modal visible={creating} title={s.newCycleTitle} width={520} maskClosable={false} confirmLoading={saving}
        motion={false} modalRender={dpfModalRender}
        onCancel={cancelCreate} onOk={confirmCreate} okText={s.newCycle} cancelText={s.cancel}>
        <div className="ppl-flabel">{s.name}</div>
        <Input value={cName} onChange={setCName} placeholder={s.namePh} />
        <div className="ppl-flabel">{s.kind}</div>
        <Select style={{ width: '100%' }} value={cKind} onChange={(v) => setCKind(v || 'quarter')}
          optionList={[{ label: s.kindQuarter, value: 'quarter' }, { label: s.kindAnnual, value: 'annual' }]} />
        {cKind === 'annual' && <div style={{ marginTop: 6 }}><Text type="tertiary" size="small">{s.kindHint}</Text></div>}
        <div className="ppl-flabel">{s.scope}</div>
        {/* P0 1.5：value 是部门 id，显示「Finance › AP」路径；选上级部门即包含全部下级部门。
            选项取自预览响应的 deptOptions（已按数据范围裁过）；DeptFilter 自己不在选项里的值不回调（没给 onInvalid），
            草稿里的部门失效由预览的 dept_not_found 清掉（见上）。 */}
        <div><DeptFilter options={deptOpts} value={cDept || null} onChange={(v) => setCDept(v || '')} lang={lang} placeholder={s.scopeAll} label={s.scope} /></div>
        <div style={{ marginTop: 4 }}><Text type="tertiary" size="small">{s.inclSub}</Text></div>
        <div style={{ marginTop: 8 }}>
          <Text type={preview ? 'tertiary' : 'quaternary'} size="small">
            {preview ? s.scopeCount(preview.participants) : s.scopeCounting}
          </Text>
          {preview && preview.excludedHods > 0 && (
            <div style={{ marginTop: 4 }}>
              <Text type="tertiary" size="small" title={(preview.excludedHodNames || []).join('、')}>{s.exclHods(preview.excludedHods)}</Text>
            </div>
          )}
        </div>
        {/* Who is being left out, said plainly. Launching a cycle is a bulk write
            with no undo once anyone submits, so the exclusion cannot be silent. */}
        {noLevelInScope > 0 && (
          <div className="rvc-exclude">
            <label className="rvc-exclude-row">
              <input type="checkbox" checked={includeNoLevel}
                onChange={(e) => setIncludeNoLevel(e.target.checked)} />
              <span>{s.inclNoLevel(noLevelInScope)}</span>
            </label>
            <div className="rvc-exclude-why">{s.noLevelWhy}</div>
          </div>
        )}
        {/* 选填:留空写 null,员工端待办里就不出现截止提示。 */}
        {cKind !== 'annual' && (<>
          <div className="ppl-flabel">{s.dueLabel}</div>
          <DatePicker type="date" format="yyyy-MM-dd" style={{ width: '100%' }} showClear
            placeholder={s.dueHint} value={cDue || undefined} onChange={(d) => setCDue(toDateStr(d))} />
          <div className="ppl-flabel">{s.dueRate}</div>
          <DatePicker type="date" format="yyyy-MM-dd" style={{ width: '100%' }} showClear
            placeholder={s.dueHint} value={cDueRate || undefined} onChange={(d) => setCDueRate(toDateStr(d))} />
        </>)}
        <div className="ppl-flabel">{s.dueCalib}</div>
        <DatePicker type="date" format="yyyy-MM-dd" style={{ width: '100%' }} showClear
          placeholder={s.dueHint} value={cDueCalib || undefined} onChange={(d) => setCDueCalib(toDateStr(d))} />
        <div className="ppl-flabel">{s.quota}</div>
        <div className="rvc-quota-in">
          {Object.keys(cQuota).map((k) => (
            <label key={k}><b>{k}</b>
              <Input size="small" value={String(cQuota[k])} suffix="%" onChange={(v) => setCQuota((q) => ({ ...q, [k]: v.replace(/[^\d.]/g, '') }))} aria-label={k} />
            </label>
          ))}
        </div>
        <div style={{ marginTop: 4 }}><Text type="tertiary" size="small">{s.quotaHint}</Text></div>
      </Modal>
      {/* 改截止日期。清空后确认 = 取消截止(PUT 发 dueAt: null),所以这里不做必填校验。 */}
      <Modal visible={!!dueEdit} width={380} maskClosable={false} confirmLoading={dueSaving}
        title={dueEdit ? `${s.dueTitle} · ${dueEdit.name}` : s.dueTitle}
        onCancel={closeDueEdit} onOk={saveDue} okText={s.save} cancelText={s.cancel}>
        <div className="ppl-flabel">{s.dueLabel}</div>
        <DatePicker type="date" format="yyyy-MM-dd" style={{ width: '100%' }} showClear
          placeholder={s.dueHint} value={dueVal || undefined} onChange={(d) => setDueVal(toDateStr(d))} />
      </Modal>
    </div>
  );
}

// 自评 / 1对1 are ticked columns rather than word tags — HR scans four stage
// columns down thousands of rows. A glyph has no text of its own, so the wording
// rides along as its label. A 1-on-1 that hasn't happened is neutral (—), not a
// miss (✗) — and it is a different fact from an unsubmitted self-review, which
// is why the two columns no longer share one string.
const GLYPH = { yes: '✓', no: '✗', na: '—' };
// 明细行展开（B-F06）：HR 校准的依据 —— 自评全文、上级评语全文；面谈要点（D-17）只在后台与上级视图出现
function ItemDetail({ r, s }) {
  const txt = (v) => (v && String(v).trim() ? v : s.xNone);
  const prev = r.prevGoals || [];
  const outs = r.selfOutcomes || [];
  return (
    <div className="rvc-x">
      <div className="rvc-x-col">
        <b className="rvc-x-h">{s.xSelf}</b>
        {prev.map((g, i) => (
          <div key={i} className="rvc-x-row"><span className="rvc-x-k">{s.xPrevGoal(i + 1)}</span><span>{g}</span>
            <span className="rvc-x-k">{s.xOutcome}</span><span>{txt(outs[i])}</span></div>
        ))}
        {!prev.length && outs.some(Boolean) && <div className="rvc-x-row"><span className="rvc-x-k">{s.xOutcome}</span><span>{outs.filter(Boolean).join(' / ')}</span></div>}
        <div className="rvc-x-row"><span className="rvc-x-k">{s.xChallenges}</span><span>{txt(r.selfChallenges)}</span></div>
        <div className="rvc-x-row"><span className="rvc-x-k">{s.xFeedback}</span><span>{txt(r.selfFeedback)}</span></div>
        {r.selfExtra ? <div className="rvc-x-row"><span className="rvc-x-k">{s.xExtra}</span><span>{r.selfExtra}</span></div> : null}
        <div className="rvc-x-row"><span className="rvc-x-k">{s.xGoalsNext}</span><span>{(r.goalsNext || []).filter(Boolean).join(' / ') || s.xNone}</span></div>
      </div>
      <div className="rvc-x-col">
        <b className="rvc-x-h">{s.xMgr}</b>
        <div className="rvc-x-p">{txt(r.managerText)}</div>
        <b className="rvc-x-h">{s.xNotes}</b>
        <div className="rvc-x-p">{txt(r.oneOnOneNotes)}</div>
        {r.highlights ? <><b className="rvc-x-h">{s.xHighlights}</b><div className="rvc-x-p">{r.highlights}</div></> : null}
        {r.hodText ? <><b className="rvc-x-h">{s.xHod}</b><div className="rvc-x-p">{r.hodText}</div></> : null}
      </div>
    </div>
  );
}

function Mark({ kind, label }) {
  return (
    <span className={`rvc-mark is-${kind}`} role="img" aria-label={label} title={label}>{GLYPH[kind]}</span>
  );
}

// 已在本页时再点进同一层（rvcPageSig 不变的 push）→ 计数加一；周期详情、部门明细把它放进取数的依赖里，重新取一次
function useRenavTick() {
  const loc = useLocation();
  const navType = useNavigationType();
  const sig = rvcPageSig(loc.search);
  const prev = useRef({ key: loc.key, sig });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (prev.current.key === loc.key) return;
    if (navType === 'PUSH' && prev.current.sig === sig) setN((x) => x + 1);
    prev.current = { key: loc.key, sig };
  }, [loc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return n;
}

/* 第二批 2.8（设计 8.6；政策审查 1 / 负责人 10/8 决定）：已关闭周期的结果告知与申诉入口。
   GET /api/admin/review-cycles/:id 的 cycle.results = { at, communicatedOn, deadline, windowOpen, employeeVisible, deadlineIfNow,
   recipients, reasonCode? }，cycle.appeals = { total, open, decided, adjusted }（老服务没有 results 块 → 不渲染）。
   · 已告知：信息行 + 「申诉 N（调整 M）」链接到申诉台（看得到申诉台才给链接）。
   · 未告知且关闭时员工从未收到结果（绩效记录当时对员工不可见）：提示 + 「通知员工并开放申诉」（绩效写；记录对员工不可见时置灰）。
   · 关闭时已通知过员工、只是早于本功能上线（reasonCode 'pre_feature'）：只给说明，不给按钮 —— 逾期申诉不予处理，不能重开期限。 */
function CycleResults({ s, lang, d, id, navigate, reload }) {
  const { user } = useAuth();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const c = (d && d.cycle) || {};
  const r = c.results || (d && d.results) || null;
  if (!r) return null;
  const ap = c.appeals || (d && d.appeals) || null;
  const deskOk = appealDeskVisible(user);
  const canComm = canUseAction(user, { domain: 'performance', module: 'performance', write: true });
  const preFeature = !r.at && (r.reasonCode === 'pre_feature' || r.reason === 'pre_feature' || r.preFeature === true);
  const hiddenText = errCodeText(lang, 'results_hidden');
  const send = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/api/admin/review-cycles/${id}/communicate`, {});
      Toast.success(s.resNotified(Number(res && res.notified) || 0, (res && res.deadline) || ''));
      setAsk(false);
      reload();
    } catch (err) {
      const code = err && err.data && err.data.code;
      Toast.error((code && errCodeText(lang, code)) || (err && err.message) || errCodeText(lang, 'generic'));
      if (code === 'results_communicated' || code === 'pre_feature') { setAsk(false); reload(); }
    } finally { setBusy(false); }
  };
  if (r.at) {
    return (
      <div className="tset-foot rvc-results">
        <span>{s.resInfo(r.communicatedOn || '—', r.deadline || '—')}</span>
        {deskOk && ap && (
          <button type="button" className="dash-cardlink rvc-results-link" onClick={() => navigate(`/admin/review-appeals?cycle=${encodeURIComponent(id)}`)}>
            {s.resAppeals(Number(ap.total) || 0, Number(ap.adjusted) || 0)} →
          </button>
        )}
      </div>
    );
  }
  if (preFeature) return <div className="tset-foot rvc-results">{s.resPreFeature}</div>;
  const visible = r.employeeVisible !== false;
  return (
    <div className="tset-foot rvc-results">
      <span>{s.resNotYet}</span>
      {canComm && (
        visible
          ? <Button size="small" theme="light" type="primary" onClick={() => setAsk(true)}>{s.resNotify}</Button>
          : <Tooltip content={hiddenText}><span className="rvc-results-dis"><Button size="small" theme="light" disabled>{s.resNotify}</Button></span></Tooltip>
      )}
      <Modal visible={ask} title={s.resNotifyT} width={460} maskClosable={false} onCancel={() => !busy && setAsk(false)}
        okText={s.resNotifyOk} cancelText={s.cancel} onOk={send} confirmLoading={busy}>
        <p className="u-lead" style={{ margin: 0 }}>{s.resNotifyAsk(Number(r.recipients) || 0, r.deadlineIfNow || '—')}</p>
      </Modal>
    </div>
  );
}

function CycleDetail({ s, id, params, patch, onBack, onGone, navigate, canEdit, canProfile }) {
  // lang 必须在这里自己取：这个组件只从 props 收到 s，而下面的 ratingLabel 要读 lang。
  // 少了这一行就是 ReferenceError —— 而 ratingLabel 在评级分布 pill 里被调用，
  // 也就是说打开任意一个有评级分布的周期详情都会白屏（8-20 的交接包里就是坏的）。
  const { lang } = useI18n();
  const renav = useRenavTick();
  const q = useAsync(() => api.get(`/api/admin/review-cycles/${id}`), [id, renav]);
  // A company-wide cycle is thousands of rows; calibration is only workable if
  // HR can narrow to the slice they are working through.（旧流程评估表的筛选，不进地址栏）
  const [fQuery, setFQuery] = useState('');
  const [fDept, setFDept] = useState('');
  const [fStage, setFStage] = useState('');
  const d = q.data;
  const v2 = !!(d && d.cycle && d.cycle.flow === 'v2');
  const items = d ? d.items : [];
  // P0 1.5：部门筛选按部门 id 走 items[].deptPath（一级部门 → 本部门的 id 链），选上级部门即包含全部下级部门。
  // 选项由服务端汇总并按数据范围裁过（deptOptions：{ id, name, parentId, path, level }，含 name: 伪选项）。
  const deptOptions = useMemo(() => (d && Array.isArray(d.deptOptions) ? d.deptOptions : []), [d]);
  const inDept = (i, id) => (i.deptPath || []).includes(id);
  const managers = useMemo(
    () => [...new Set(items.map((i) => i.manager).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [items],
  );
  // 已关闭周期的「已归档」按档案里的评级计（rvcRatingOf，与列表 finalDone 同一口径）；进行中仍按生效评级算「可归档」
  const closedC = !!(d && d.cycle && d.cycle.status !== 'open');
  const progress = useMemo(() => items.reduce((a, i) => ({
    total: a.total + 1,
    self: a.self + (i.selfAt ? 1 : 0),
    one: a.one + (i.oneOnOneAt ? 1 : 0),
    rated: a.rated + (i.managerRating ? 1 : 0),
    final: a.final + (rvcRatingOf(i, closedC) ? 1 : 0),
  }), { total: 0, self: 0, one: 0, rated: 0, final: 0 }), [items, closedC]);
  const shown = useMemo(() => {
    const qq = fQuery.trim().toLowerCase();
    return items.filter((i) => {
      if (qq && !(String(i.name || '').toLowerCase().includes(qq) || String(i.employeeId || '').toLowerCase().includes(qq))) return false;
      if (fDept && !inDept(i, fDept)) return false;
      if (fStage === 'selfPending' && i.selfAt) return false;
      if (fStage === 'selfDone' && !i.selfAt) return false;
      if (fStage === 'unrated' && i.managerRating) return false;
      if (fStage === 'rated' && !i.managerRating) return false;
      if (fStage === 'noFinal' && (i.finalRating || i.managerRating)) return false;
      return true;
    });
  }, [items, fQuery, fDept, fStage]);

  // 2.3-D / 2.2：视图走地址栏。v2 只有「部门确认」（缺省）和「看板」，可编辑的「评估表」已去掉；旧流程只有评估表（含 HR 校准）。
  // 部门明细 = 部门确认 + unit=<一级部门 id>（HoD 提交后给 HR 的通知直达这里）。
  const view = !d ? '' : v2 ? (params.view === 'board' ? 'board' : 'depts') : 'table';
  const unit = view === 'depts' && params.unit ? String(params.unit) : '';
  // 切视图：清掉全部筛选键与 unit（设计 0.2 清理规则）
  const setView = (k) => { if (k !== view) patch({ view: k, unit: null }, { clear: [...BOARD_KEYS, ...REVIEW_FILTER_KEYS] }); };
  // 打开部门明细：清掉看板键；返回：清掉校准筛选键。列表键（kind / status / year）始终保留
  const unitHref = (dept1Id) => ({ search: '?' + mergeParams(params, { view: 'depts', unit: dept1Id }, BOARD_KEYS).toString() });
  const closeUnit = useCallback(() => patch({ unit: null }, { clear: REVIEW_FILTER_KEYS }), [patch]);
  const dropGoneUnit = useCallback(() => patch({ unit: null }, { clear: REVIEW_FILTER_KEYS, push: false }), [patch]);   // 404：replace，同 dropGoneCycle
  const pick = (keys) => Object.fromEntries(keys.filter((k) => params[k] !== undefined && params[k] !== '').map((k) => [k, params[k]]));
  // 周期不存在（被删、地址失效）：删掉参数回到列表并提示（2.3-D）
  useEffect(() => {
    if (q.error && q.error.status === 404) { Toast.warning(s.eCycleGone); onGone(); }
  }, [q.error]); // eslint-disable-line react-hooks/exhaustive-deps

  // 入口 2：评估表勾选员工 → 按阶段提醒（by:'item'，不提供 HoD 步骤）。评估表现在只给旧流程；v2 在部门明细里「提醒他们的上级」，
  // 或在「部门确认」按部门提醒。提醒不改数据，完成后只清空勾选，不重载，页码与排序保留。
  // hook 必须写在下面的提前返回之前。
  const itemStages = d && d.cycle ? rvcStagesFor(d.cycle).filter((k) => k !== 'hod') : [];
  const canBulk = canEdit && view === 'table' && !!(d && d.cycle && d.cycle.status === 'open') && itemStages.length > 0;
  const sel = useBulkSelection({ rows: shown, resetOn: [fQuery, fDept, fStage], ready: !!d });
  const runner = useBulkRunner();
  const [remind, setRemind] = useState(null);       // { ids, list: [名称], names: { id: 名称 }, rows }
  const [remindStage, setRemindStage] = useState('');
  const openRemind = () => {
    const picked = sel.rows;
    if (!picked.length) return;
    const label = (r) => `${r.name} · ${r.employeeId}`;
    const names = {};
    picked.forEach((r) => { names[String(r.id)] = label(r); });
    setRemind({ ids: picked.map((r) => String(r.id)), list: picked.map(label), names, rows: picked });
    const pre = fStage === 'unrated' ? 'manager' : 'self';
    setRemindStage(itemStages.includes(pre) ? pre : (itemStages[0] || ''));
  };
  const remindNotes = () => {
    if (!remind || !RVC_DONE[remindStage]) return [];
    const done = remind.rows.filter(RVC_DONE[remindStage]).length;
    const blocked = remind.rows.filter((r) => !RVC_DONE[remindStage](r) && RVC_BLOCKED[remindStage](r)).length;
    return [done > 0 ? s.remindSkipN(done) : null, blocked > 0 ? s.remindBlockedN(blocked) : null];
  };
  const submitRemind = async () => {
    if (!remind || !remindStage) return;
    await runner.run({
      op: s.remindBtn, names: remind.names,
      request: () => api.post('/api/admin/review-reminders', { stage: remindStage, by: 'item', cycleId: id, ids: remind.ids }),
      doneText: remindDoneText(s),
      onSettled: () => sel.clear(),
    });
    setRemind(null);
  };
  // 旧流程评估表的 HR 校准（选完即保存）；v2 的校准在部门明细里（DeptDetail 自己的一份）
  const calib = useCalib({ s, d, lang, v2, onSaved: () => q.reload() });

  if (q.error) {
    return (
      <div className="wrap rvc-wrap">
        <Button icon={<IconArrowLeft />} theme="borderless" onClick={onBack} className="ppl-back">{s.back}</Button>
        <Banner type="danger" closeIcon={null} description={q.error.message} />
      </div>
    );
  }
  if (!d) return <div className="wrap rvc-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;
  const open = d.cycle.status === 'open';
  const errMap = rvcErrMap(s);
  // 「已调整」标签与必填理由都只对季度周期有意义：年度周期没有上级评级（M10）。
  const quarterly = d.cycle.kind !== 'annual';
  const closeCycle = async () => {
    try {
      const r = await api.post(`/api/admin/review-cycles/${id}/close`, {});
      Toast.success(s.closed2(r.written, r.skipped));
      q.reload();
    } catch (err) { Toast.error(errText(err, errMap)); }
  };
  // v2：导出全部条目（不再受评估表筛选影响；部门明细另有「导出本部门」）；旧流程：导出评估表当前筛选的人
  const exportCsv = () => downloadReviewCsv(s, d.cycle.name, v2 ? items : shown, !open);

  const distTotal = Object.values(d.distribution).reduce((a, b) => a + b, 0);
  // canonical 值 → 当前语言的显示名（按下标与 ratingOptions_zh 配对）。取不到中文就落回 canonical。
  const ratingLabel = ratingLabelOf(d, lang);
  // 评级刻度说明（迁移 56，IA 4.8）：当前语言优先
  const ratingDesc = ratingDescOf(d, lang);
  return (
    <div className="wrap rvc-wrap">
      <Button icon={<IconArrowLeft />} theme="borderless" onClick={onBack} className="ppl-back">{s.back}</Button>
      <div className="ppl-card">
        <div className="ppl-sec-h">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 17 }}>{d.cycle.name}</h2>
            <Tag color={open ? 'green' : 'grey'} type="light" shape="circle">{open ? s.open : s.closed}</Tag>
          </div>
          <Space>
            <Button icon={<IconRefresh />} theme="borderless" onClick={() => q.reload()} />
            {/* 导出是纯前端拼 CSV(见上),没有服务端端点 —— 只读档照旧可用。 */}
            <Button icon={<IconDownload />} theme="light" onClick={exportCsv}>{s.export}</Button>
            {open && canEdit && (
              <Popconfirm title={s.closeTitle} content={d.resultVisibleToEmployee === false ? s.closeDescHidden : s.closeDesc} okType="danger" okText={s.close} cancelText={s.cancel} onConfirm={closeCycle}>
                <Button theme="solid" type="danger">{s.close}</Button>
              </Popconfirm>
            )}
          </Space>
        </div>
        {!canEdit && <div className="tset-foot">{s.roPerf}</div>}
        {/* 姓名链接到档案页(people 域):没有 people 读权限时是纯文本。 */}
        {!canProfile && <div className="tset-foot">{s.noProfileLink}</div>}
        {!open && <div className="tset-foot">{s.fileNote}</div>}
        {!open && <CycleResults s={s} lang={lang} d={d} id={id} navigate={navigate} reload={() => q.reload()} />}
        {v2 && (
          <div className="rvc-views" role="tablist">
            {[['depts', s.vDepts], ['board', s.vBoard]].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} className={'ppl-chip' + (view === k ? ' on' : '')} onClick={() => setView(k)}>{label}</button>
            ))}
          </div>
        )}
        {view === 'depts' && !unit && <DeptPanel d={d} s={s} id={id} open={open} canEdit={canEdit} unitHref={unitHref} reload={() => q.reload()} />}
        {view === 'depts' && unit && (
          <DeptDetail key={unit} d={d} s={s} lang={lang} cycleId={id} unit={unit} canEdit={canEdit} canProfile={canProfile}
            query={pick(REVIEW_FILTER_KEYS)} onQuery={patch} onBack={closeUnit} onGone={dropGoneUnit} reloadCycle={() => q.reload()} />
        )}
        {view === 'board' && (
          <Board d={d} s={s} lang={lang} ratingLabel={ratingLabel} canProfile={canProfile} navigate={navigate}
            query={pick(BOARD_KEYS)} onQuery={patch} />
        )}
        {view === 'table' && (<>
        <div className="rvc-dist">
          <Text type="tertiary" size="small">{open ? s.dist : s.distFile}</Text>
          {/* 评级的存储值是 canonical（英文半边），中文名在 ratingOptions_zh 里按下标配对。
              分布与校准下拉都显示当前语言的名字，但**提交/比对永远用 canonical**。 */}
          {distTotal === 0 ? <Text type="quaternary" size="small" style={{ marginLeft: 8 }}>{s.noRatings}</Text> : d.ratingOptions.map((r) => (
            d.distribution[r] ? <span className="pill pri" key={r}>{ratingLabel(r)} <b className="tnum">{d.distribution[r]}</b></span> : null
          ))}
        </div>
        <div className="rvc-dist">
          <span className="pill muted">{s.pSelf} <b className="tnum">{progress.self}/{progress.total}</b></span>
          <span className="pill muted">{s.pOne} <b className="tnum">{progress.one}/{progress.total}</b></span>
          <span className="pill muted">{s.pRated} <b className="tnum">{progress.rated}/{progress.total}</b></span>
          <span className="pill ok">{open ? s.pFinal : s.recordOk} <b className="tnum">{progress.final}/{progress.total}</b></span>
        </div>
        <div className="rvc-filters">
          <Input value={fQuery} onChange={setFQuery} placeholder={s.searchPh} showClear style={{ width: 210 }} />
          {/* 3.1：全站统一的部门筛选（含下级）；原来列头上那份重复的部门筛选已删 */}
          <DeptFilter options={deptOptions} value={fDept || null} onChange={(v) => setFDept(v || '')} lang={lang} placeholder={s.filterDept} size="small" />
          <Select value={fStage || undefined} onChange={(v) => setFStage(v || '')} placeholder={s.fAll}
            showClear style={{ width: 160 }} optionList={[
              { label: s.fSelfPending, value: 'selfPending' },
              { label: s.fSelfDone, value: 'selfDone' },
              { label: s.fUnrated, value: 'unrated' },
              { label: s.fRated, value: 'rated' },
              { label: s.fNoFinal, value: 'noFinal' },
            ]} />
          <Text type="tertiary" size="small">{s.shown(shown.length, progress.total)}</Text>
        </div>
        {canBulk && (
          <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} selectPage={sel.togglePage}>
            <Button size="small" theme="light" type="primary" disabled={runner.busy} onClick={openRemind}>{s.remindBtn}</Button>
          </BulkBar>
        )}
        <div ref={sel.wrapRef}>
        <Table rowKey="id" dataSource={shown} size="small"
          rowSelection={canBulk ? sel.rowSelection : undefined}
          expandedRowRender={(r) => <ItemDetail r={r} s={s} />}
          pagination={shown.length > 20 ? { pageSize: DEFAULT_PAGE_WIDE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
          {...resizableTable([
            // 跨域:目标是 /admin/people/:id(people 域)。无 people 读权限 → 纯文本。
            { title: s.colName, dataIndex: 'name', width: 140, render: (v, r) => (canProfile
              ? <span className="emp-namelink" style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/people/${r.userId}`)}>{v}</span>
              : <span>{v}</span>
            ) },
            // 58 pairs of employees share a full name — the ID is what tells
            // them apart during calibration.
            { title: s.colEmpId, dataIndex: 'employeeId', width: 100, render: (v) => <Text type="tertiary" size="small" className="tnum">{v}</Text> },
            { title: s.colDept, dataIndex: 'department', width: 120, render: (v) => v || <Text type="quaternary">—</Text> },
            { title: s.colManager, dataIndex: 'manager', width: 110, render: (v) => v || <Text type="quaternary" size="small">{s.noMgr}</Text>,
              filters: managers.map((x) => ({ text: x, value: x })), onFilter: (val, r) => r.manager === val },
            { title: s.colSelf, dataIndex: 'selfAt', width: 85, render: (v) => (
              <Mark kind={v ? 'yes' : 'no'} label={v ? s.selfDone : s.selfPending} />) },
            { title: s.colOne, dataIndex: 'oneOnOneAt', width: 80, render: (v, r) => {
              // 绩效流程 v2：上级与员工都确认才算完成；只有一方确认显示「—」并在提示里说明（评估表现在只给旧流程，保留通用写法）
              const both = !!v && (!v2 || !!r.employeeOneOnOneAt);
              const half = !both && (!!v || !!r.employeeOneOnOneAt);
              return <Mark kind={both ? 'yes' : 'na'} label={both ? (v2 ? s.oneBoth : s.oneDone) : half ? s.oneHalf : s.onePending} />;
            } },
            { title: s.colMgrRating, dataIndex: 'managerRating', width: 170,
              filters: d.ratingOptions.map((o) => ({ text: ratingLabel(o), value: o })), onFilter: (val, r) => r.managerRating === val,
              render: (v, r) => (
              <span>{v ? <Tag color="indigo" type="light" shape="circle">{ratingLabel(v)}</Tag> : <Text type="quaternary" size="small">{s.mgrPending}</Text>}
                {r.managerText ? <Text type="tertiary" size="small" className="u-tag-gap">{r.managerText.slice(0, 40)}{r.managerText.length > 40 ? '…' : ''}</Text> : null}</span>
            ) },
            // 校准 = PUT /api/admin/review-items/:id(绩效写):只读档退回到与已关闭
            // 周期同一套只读渲染(终评或上级评的 Tag),而不是留一个必 403 的下拉。
            // 校准评级（2026-10-06 负责人决定）：未校准时默认等于上级评级，下拉占位显示上级评级并注「同上级评级」；
            // 本列筛选按生效评级（finalRating || managerRating）。
            // P0 1.1：能不能改只认服务端的 hrCalibratable（旧流程 = 进行中），前端不重写这套规则。不能改的行显示生效评级；
            // 季度周期里校准值与上级评级不同时加「已调整」，悬停显示校准说明。已关闭周期以档案评级为准，改过的标「已改动（原评级 X）」（2.6）。
            { title: open && canEdit ? <span title={s.calibHintLegacy} className="u-th-plain">{s.colCalib}</span> : s.colFinal, dataIndex: 'finalRating', width: 200,
              filters: d.ratingOptions.map((o) => ({ text: ratingLabel(o), value: o })), onFilter: (val, r) => rvcRatingOf(r, !open) === val,
              render: (v, r) => ((open && canEdit && r.hrCalibratable)
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Select size="small" showClear placeholder={r.managerRating ? ratingLabel(r.managerRating) : s.finalPh} value={v || undefined} style={{ width: 146 }}
                    onChange={(nv) => calib.pickCalib(r, nv)}
                    optionList={d.ratingOptions.map((o) => ({ label: ratingLabel(o), value: o, title: ratingDesc(o) || undefined }))} />
                  {!v && r.managerRating && <Text type="quaternary" size="small">{s.sameAsMgr}</Text>}
                </span>
              : <span>{rvcRatingOf(r, !open) ? <Tag color="indigo" type="solid" shape="circle">{ratingLabel(rvcRatingOf(r, !open))}</Tag> : <Text type="quaternary">—</Text>}
                  {quarterly && v && r.managerRating && v !== r.managerRating && (
                    <Tag size="small" color="amber" type="light" className="u-tag-gap" title={r.hodText || undefined}>{s.adjusted}</Tag>
                  )}
                  {r.amendedFrom && <Tag size="small" color="amber" type="light" className="u-tag-gap">{s.amended(ratingLabel(r.amendedFrom))}</Tag>}
                  {r.recordId && <Text type="tertiary" size="small" className="u-tag-gap">✓ {s.recordOk}</Text>}</span>
            ) },
          ], { extra: canBulk ? BULK_SEL_EXTRA : 0 })} />
        </div>
        </>)}
      </div>
      {canBulk && (
        <RemindModal s={s} visible={!!remind} names={remind ? remind.list : []} stages={itemStages}
          stage={remindStage} setStage={setRemindStage} notes={remindNotes()} loading={runner.busy}
          onOk={submitRemind} onCancel={() => setRemind(null)} />
      )}
      {runner.modal}
      {calib.modal}
    </div>
  );
}

/* P0 1.1 HR 校准：旧流程评估表选完即保存，只发 finalRating（不要求理由）。v2（部门明细里 editable 的行 = 无 HoD 的组、HoD 本人）
   先弹窗选评级、填理由：季度周期改了上级评级须填，年度选填；理由写进该条的校准说明（hodText）。
   评估表与部门明细各用一份，弹窗随 hook 返回（第二批从 CycleDetail 上移）。 */
function useCalib({ s, d, lang, v2, onSaved }) {
  const [calib, setCalib] = useState(null);           // { r: 评估条目, value: 新评级 | null（清除校准） }
  const [calibNote, setCalibNote] = useState('');
  const [calibBusy, setCalibBusy] = useState(false);
  // 「已调整」与必填理由都只对季度周期有意义：年度周期没有上级评级（M10）。必填条件与服务端 HoD 校准同口径：有上级评级、且改成了别的评级。
  const quarterly = !(d && d.cycle && d.cycle.kind === 'annual');
  const calibrate = async (itemId, v, reason) => {
    try {
      await api.put(`/api/admin/review-items/${itemId}`, reason === undefined ? { finalRating: v || null } : { finalRating: v || null, reason });
      Toast.success(s.saved);
      if (onSaved) onSaved();
      return true;
    } catch (err) { Toast.error(errText(err, rvcErrMap(s))); return false; }
  };
  const calibReasonNeeded = (r, v) => quarterly && !!v && !!r.managerRating && v !== r.managerRating;
  const pickCalib = (r, nv) => {
    if (!v2) { calibrate(r.id, nv); return; }
    setCalib({ r, value: nv || null });
    setCalibNote(r.hodText || '');
  };
  const submitCalib = async () => {
    if (!calib) return;
    setCalibBusy(true);
    const ok = await calibrate(calib.r.id, calib.value, calibNote.trim());
    setCalibBusy(false);
    if (ok) setCalib(null);
  };
  const label = ratingLabelOf(d, lang);
  const desc = ratingDescOf(d, lang);
  // P0 1.1：v2 的 HR 校准（无 HoD 的组 / HoD 本人）。季度周期改了上级评级时理由必填，未填不能保存。
  const modal = (
    <Modal visible={!!calib} title={calib ? `${s.calibTitle} · ${calib.r.name}` : s.calibTitle} width={440} maskClosable={false}
      onCancel={() => setCalib(null)} onOk={submitCalib} okText={s.save} cancelText={s.cancel} confirmLoading={calibBusy}
      okButtonProps={{ disabled: !!calib && calibReasonNeeded(calib.r, calib.value) && !calibNote.trim() }}>
      {calib && (<>
        <div className="ppl-flabel">{s.colCalib}</div>
        <Select style={{ width: '100%' }} showClear value={calib.value || undefined}
          placeholder={calib.r.managerRating ? `${label(calib.r.managerRating)} · ${s.sameAsMgr}` : s.finalPh}
          onChange={(nv) => setCalib((c) => (c ? { ...c, value: nv || null } : c))}
          optionList={((d && d.ratingOptions) || []).map((o) => ({ label: label(o), value: o, title: desc(o) || undefined }))} />
        <div style={{ marginTop: 6 }}><Text strong>{calib.value ? s.calibPick(label(calib.value)) : s.calibClear}</Text></div>
        {calib.r.managerRating && (
          <div style={{ marginTop: 4 }}><Text type="tertiary" size="small">{s.colMgrRating} · {label(calib.r.managerRating)}</Text></div>
        )}
        <div className="ppl-flabel">{calibReasonNeeded(calib.r, calib.value) ? s.calibReason : s.calibReasonOpt}</div>
        <TextArea value={calibNote} onChange={setCalibNote} placeholder={s.calibReasonPh} autosize={{ minRows: 2, maxRows: 6 }} maxLength={1000} />
      </>)}
    </Modal>
  );
  return { pickCalib, openCalib: (r) => pickCalib(r, r.finalRating || null), modal };
}

// ---------- 绩效流程 v2：部门确认（HR 按一级部门确认 / 退回）----------
const TIERS = dc.TIER_ORDER;   // 简化 10/11：与 deptcal 同一份档位
// 确认阻断项（depts[].confirmIssues，与服务端 confirm_blocked 的 issues 同形）→ 当前语言的一句话
const deptIssueText = (s, x) => {
  if (!x) return s.eConfirmBlocked;
  if (x.code === 'over_quota') return s.issueOverQuota(x.over);
  if (x.code === 'rating_missing') return s.issueRatingMissing(x.n || 0);
  if (x.code === 'membership_changed') return s.issueMembershipChanged(x);
  if (x.code === 'ratings_changed') return s.issueRatingsChanged(x.n || 0);
  if (x.code === 'hod_unresolved') return s.eHodUnresolved;
  if (x.code === 'dept_inactive') return s.eDeptInactive;
  if (x.code === 'self_confirm') return s.eSelfConfirm;
  return s.eConfirmBlocked;
};
/* P0 1.1 / 1.2（2026-10-07，E1–E5）：一行部门现在能不能确认、退回，以及不能的原因。
   规则的事实源在服务端（depts[].confirmIssues / hod / status / scopePartial），这里只负责把原因摆在按钮旁边，
   服务端仍会兜底拒绝（confirm_blocked、hod_unresolved、self_confirm、already_confirmed）。
   - hodOwned 与服务端 reviewHodOwned 同口径：现在有 HoD，或曾有 HoD 提交过（status.hodId / hodSubmittedAt）。
   - HoD 待确认（多个顶端、负责人已停用；服务端标 hodUnresolved 或给 hod_unresolved 阻断项）：HR 只读、不能确认，
     须先在部门页指定负责人。曾由 HoD 提交、现在却找不到 HoD 的部门同样显示「HoD 待确认」。
   - 确认人自己就是该部门的 HoD（当前 HoD 或提交人）：确认与退回都须由另一名 HR 操作。
   - 部门有成员在数据范围外（scopePartial）：服务端对整组操作返回 404，按钮置灰并说明。 */
function deptConfirmState(r, me, s) {
  const st = r.status || {};
  const issues = Array.isArray(r.confirmIssues) ? r.confirmIssues.filter(Boolean) : [];
  // 服务端给了 hodOwned（reviewHodOwned 的结果）就直接用；旧接口没有时按 hod / status 推
  const hodOwned = typeof r.hodOwned === 'boolean' ? r.hodOwned : !!(r.hod || st.hodId || st.hodSubmittedAt);
  const unresolvedNow = !!r.hodUnresolved || !!r.deptInactive || issues.some((x) => x.code === 'hod_unresolved' || x.code === 'dept_inactive');
  // 只拦尚未提交的部门：HoD 提交之后才变成「待确认」的部门照常由 HR 确认（与服务端同口径）
  const hodUnresolved = unresolvedNow && !st.hodSubmittedAt;
  const hodPending = unresolvedNow || (hodOwned && !r.hod);
  const selfHod = !!(me && me.id && ((r.hod && r.hod.id === me.id) || (st.hodId && st.hodId === me.id)))
    || issues.some((x) => x.code === 'self_confirm');
  const scopePartial = !!r.scopePartial;
  const blockers = issues.filter((x) => x.code !== 'hod_unresolved' && x.code !== 'dept_inactive' && x.code !== 'self_confirm');
  // 有 HoD 的部门须先由 HoD 提交；无 HoD 的组由 HR 直接确认
  const submitted = !hodOwned || !!st.hodSubmittedAt;
  const reasons = [];
  if (scopePartial) reasons.push(s.issueScopePartial);
  // CX-229：没有员工与组织写权限的人只陈述原因（下一句由部门明细给「请联系有部门管理权限的同事…」）
  if (hodUnresolved) reasons.push(r.deptInactive || issues.some((x) => x.code === 'dept_inactive') ? s.eDeptInactive : (canWriteDomain(me, 'people') ? s.eHodUnresolved : s.eHodUnresolvedRo));
  if (selfHod) reasons.push(s.eSelfConfirm);
  // CX-171：HoD 待确认时只给这一个原因与下一步（去部门页指定负责人）；「N 人还没有评级」等等指定负责人后再由 HoD 处理
  if (!hodUnresolved) blockers.forEach((x) => reasons.push(deptIssueText(s, x)));
  // 收尾提示：HoD 待确认的组 HR 在评估表里也是只读，「请在评估表中调整」做不到 —— 上面的待确认原因已经说了下一步
  if (blockers.length && !hodUnresolved) reasons.push(hodOwned ? s.mustReturn : s.fixInSheet);
  return {
    hodOwned, hodPending, selfHod, scopePartial,
    canConfirm: submitted && !reasons.length,
    // 退回 / 撤销确认：确认人是 HoD 本人、或部门有成员在范围外时都不行
    canReturn: !selfHod && !scopePartial,
    // 还没轮到确认（HoD 未提交）时不列阻断项，免得「须退回」出现在尚未提交的部门上；HoD 待确认始终提示
    reasons: submitted || hodUnresolved ? reasons : [],
    // 已确认的行：不能退回的原因；确认后成员有变动（服务端 membershipChanged，关闭周期会被 depts_changed 拦住）
    confirmedNotes: [
      scopePartial && s.issueScopePartial, selfHod && s.eSelfConfirm,
      r.membershipChanged && s.issueMembersChangedConfirmed(r.membershipChanged),
      r.ratingsChanged > 0 && s.issueRatingsChangedConfirmed(r.ratingsChanged),
    ].filter(Boolean),
  };
}
function DeptReasons({ list }) {
  if (!list || !list.length) return null;
  return (
    <div style={{ marginTop: 4, whiteSpace: 'normal', lineHeight: 1.4 }}>
      {list.map((t, i) => <div key={i}><Text type="danger" size="small">{t}</Text></div>)}
    </div>
  );
}
/* 部门确认 / 退回（P0 1.2）：「部门确认」列表的操作列与部门明细顶部共用（第二批从 DeptPanel 上移）。退回弹窗随 hook 返回。 */
function useDeptActs({ s, id, reload }) {
  const { user: me } = useAuth();
  const [ret, setRet] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const actErrMap = {
    not_submitted: () => s.eNotSubmitted, reason_required: () => s.eReasonReq, cycle_closed: () => s.eCycleClosed,
    confirm_blocked: (dd) => [s.eConfirmBlocked, ...((dd && dd.issues) || []).map((x) => deptIssueText(s, x))].join(' · '),
    already_confirmed: () => s.eAlreadyConfirmed, hod_unresolved: () => s.eHodUnresolved, self_confirm: () => s.eSelfConfirm,
    dept_inactive: () => s.eDeptInactive,
  };
  const act = async (dept, kind, body) => {
    const hodOwned = deptConfirmState(dept, me, s).hodOwned;
    setBusy(true);
    try {
      await api.post(`/api/admin/review-cycles/${id}/depts/${dept.dept1Id}/${kind}`, body || {});
      // 无 HoD 的组退回 = 撤销确认（不通知任何人）
      Toast.success(kind === 'confirm' ? s.confirmedOk : hodOwned ? s.returnedOk : s.reopenedOk);
      setRet(null); setReason(''); reload();
    } catch (err) {
      Toast.error(errText(err, actErrMap));
      // 被拒多半是页面上的状态已过时（别人刚确认、HoD 刚变更、成员有变动）：刷新一次，按钮与原因随之更新
      reload();
    }
    setBusy(false);
  };
  const openRet = (r) => { setRet(r); setReason(''); };
  const retHodOwned = !!ret && deptConfirmState(ret, me, s).hodOwned;
  const modal = (
    <Modal visible={!!ret} title={ret ? `${retHodOwned ? s.returnTitle : s.reopenTitle} · ${ret.dept1 || s.noDept1}` : s.returnTitle} width={440} maskClosable={false}
      onCancel={() => setRet(null)} onOk={() => act(ret, 'return', { reason })} okText={retHodOwned ? s.returnBtn : s.reopen} cancelText={s.cancel} confirmLoading={busy}
      okButtonProps={{ disabled: !reason.trim(), type: 'danger' }}>
      <div className="ppl-flabel">{retHodOwned ? s.returnReason : s.reopenReason}</div>
      <Input value={reason} onChange={setReason} placeholder={s.returnPh} />
    </Modal>
  );
  return { me, busy, act, openRet, modal };
}
// 确认 / 退回按钮与不能操作的原因（r = 部门行：周期详情的 depts[] 或部门明细接口的 row，同一个 reviewDeptRow）
function DeptActs({ r, s, open, canEdit, acts }) {
  const st = r.status || {};
  if (!open || !canEdit) return null;
  const { me, busy, act, openRet } = acts;
  const c = deptConfirmState(r, me, s);
  // 已确认、周期进行中：有 HoD 的「退回」，无 HoD 的「撤销确认」，都走退回弹窗（理由必填）
  if (st.hrConfirmedAt) {
    return (<div>
      <Button size="small" type="danger" theme="light" disabled={busy || !c.canReturn} onClick={() => openRet(r)}>{c.hodOwned ? s.returnBtn : s.reopen}</Button>
      <DeptReasons list={c.confirmedNotes} />
    </div>);
  }
  return (<div>
    <Space>
      <Button size="small" theme="solid" disabled={!c.canConfirm || busy}
        onClick={() => Modal.confirm({ title: s.confirmAsk(r.dept1 || s.noDept1), content: s.confirmAskBody, okText: s.confirm, cancelText: s.cancel, onOk: () => act(r, 'confirm') })}>{s.confirm}</Button>   {/* CX-046：不可逆动作二次确认 */}
      {st.hodSubmittedAt && <Button size="small" type="danger" theme="light" disabled={busy || !c.canReturn} onClick={() => openRet(r)}>{s.returnBtn}</Button>}
    </Space>
    <DeptReasons list={c.reasons} />
  </div>);
}

function DeptPanel({ d, s, id, open, canEdit, unitHref, reload }) {
  const acts = useDeptActs({ s, id, reload });
  const { me, busy } = acts;
  // 入口 3：勾选部门 → 按阶段提醒（by:'dept'，默认 HoD 步骤）。HR 已确认的部门不可勾；
  // 有成员在数据范围外的部门不能提醒 HoD（服务端要求整组在范围内），其余步骤由服务端收窄到范围内的人。
  const bulkOn = open && canEdit;
  const deptStages = rvcStagesFor(d.cycle);
  const sel = useBulkSelection({ rows: d.depts, rowKey: 'dept1Id', isSelectable: rvcDeptSelectable, ready: true });
  const runner = useBulkRunner();
  const [remind, setRemind] = useState(null);       // { ids, list: [名称], names: { id: 名称 }, partial: [名称] }
  const [remindStage, setRemindStage] = useState('');
  const openRemind = () => {
    const picked = sel.rows;
    if (!picked.length) return;
    const label = (r) => r.dept1 || s.noDept1;
    const names = {};
    picked.forEach((r) => { names[String(r.dept1Id)] = label(r); });
    const partial = picked.filter(rvcPartialScope).map(label);
    setRemind({ ids: picked.map((r) => String(r.dept1Id)), list: picked.map(label), names, partial });
    const first = partial.length ? deptStages.find((k) => k !== 'hod') : 'hod';
    setRemindStage(first && deptStages.includes(first) ? first : '');
  };
  const submitRemind = async () => {
    if (!remind || !remindStage) return;
    await runner.run({
      op: s.remindBtn, names: remind.names,
      request: () => api.post('/api/admin/review-reminders', { stage: remindStage, by: 'dept', cycleId: id, ids: remind.ids }),
      doneText: remindDoneText(s),
      onSettled: () => sel.clear(),
    });
    setRemind(null);
  };
  const hodOff = remind && remind.partial.length ? new Set(['hod']) : null;
  const statusOf = (r) => {
    const st = r.status || {};
    const c = deptConfirmState(r, me, s);
    // O1（10/8 同行反馈）：已确认的行写明「已确认 · 本地时间 · 确认人」；文字长时在格内换行，不截断
    if (st.hrConfirmedAt) {
      const text = s.stConfirmed(localStamp(st.hrConfirmedAt), confirmerOf(st));
      return <Tag color="green" type="light" shape="circle" className="u-tag-wrap" title={text}><span>{text}</span></Tag>;
    }
    if (st.hodSubmittedAt) return <Tag color="indigo" type="light" shape="circle">{s.stSubmitted(dc.localDay(st.hodSubmittedAt))}</Tag>;
    return (<span>
      {/* 无 HoD 的组被撤销确认后不是「退回给谁」，单独显示「已撤销确认」（M11） */}
      {st.returnedAt && <Tag color="orange" type="light" shape="circle" style={{ marginRight: 6 }}>{c.hodOwned ? s.stReturned : s.stReopened}</Tag>}
      <Text type={c.hodPending ? 'warning' : 'tertiary'} size="small">{c.hodPending ? (r.deptInactive ? s.stDeptInactive : s.stHodPending) : c.hodOwned ? s.stNone : s.stNoHod}</Text>
    </span>);
  };
  return (
    <div>
      {bulkOn && (
        <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy || busy} selectPage={sel.togglePage}>
          <Button size="small" theme="light" type="primary" disabled={runner.busy || busy} onClick={openRemind}>{s.remindBtn}</Button>
        </BulkBar>
      )}
      {/* 列多：横向滚动，操作列固定在右侧（QA 2026-10-06 P2：1440 宽下确认 / 退回被挤出可视区）。
          左侧部门列是 fixed:'left'，勾选列也必须固定，否则横向滚动时会叠在部门名下面。 */}
      <div ref={sel.wrapRef}>
      <Table rowKey="dept1Id" size="small" dataSource={d.depts || []} pagination={(d.depts || []).length > 20 ? { pageSize: 20, formatPageText: false } : false}
        // 操作列只给能确认 / 退回的人（进行中 + 绩效写权限 = bulkOn）：已关闭周期与只读角色那一列是空的，固定在右侧还会盖住「状态」列
        // （W3-S 浏览器核对：1440 宽下已关闭周期的状态被挡住）。去掉后其余列合计约 1070，1440 宽下不再横向滚动
        scroll={{ x: bulkOn ? 1290 + BULK_SEL_EXTRA : 1070 }} className="rvc-depts"
        rowSelection={bulkOn ? { ...sel.rowSelection, fixed: true } : undefined}
        // 手机宽度下后台表格变卡片（cardify 给每格 data-label，app.css 显示成「标签：值」）
        columns={cardify([
          // 2.2：部门名打开该部门的只读明细（地址栏 &unit=，push：返回键回到部门列表）
          { title: s.dDept, dataIndex: 'dept1', width: 170, fixed: 'left', render: (v, r) => (
            <Link className="emp-namelink" to={unitHref(r.dept1Id)} title={s.openDept}>{v || s.noDept1}</Link>) },
          { title: s.dHod, dataIndex: 'hod', width: 120, render: (v, r) => (v ? v.name
            : deptConfirmState(r, me, s).hodPending ? <Text type="warning" size="small">{r.deptInactive ? s.deptInactiveShort : s.hodPendingShort}</Text> : <Text type="quaternary">—</Text>) },
          { title: s.dHc, dataIndex: 'headcount', width: 60, render: (v) => <span className="tnum">{v}</span> },
          { title: s.dSelf, dataIndex: 'selfDone', width: 72, render: (v, r) => <span className="tnum">{v}/{r.headcount}</span> },
          { title: s.dOne, dataIndex: 'oneDone', width: 92, render: (v, r) => <span className="tnum">{v}/{r.headcount}</span> },
          { title: s.dRated, dataIndex: 'rated', width: 84, render: (v, r) => <span className="tnum">{v}/{r.headcount}</span> },
          { title: open ? s.dDist : s.dDistFile, dataIndex: 'counts', width: 250, render: (c, r) => (
            <span className="rvc-dcells">{TIERS.map((t) => {
              const over = (r.over || []).some((o) => o.tier === t);
              return <span key={t} className={'rvc-dcell' + (over ? ' over' : '')} title={over ? s.overTag : undefined}><b>{t}</b> <span className="tnum">{(c || {})[t] || 0}{t !== 'B' && t !== 'C/D' ? `/${(r.allowed || {})[t] ?? 0}` : ''}</span></span>;
            })}</span>
          ) },
          { title: s.dStatus, dataIndex: 'status', width: 220, render: (_, r) => statusOf(r) },
          ...(bulkOn ? [{ title: s.dOps, dataIndex: 'ops', width: 220, fixed: 'right', render: (_, r) => <DeptActs r={r} s={s} open={open} canEdit={canEdit} acts={acts} /> }] : []),
        ])} />
      </div>
      {open && canEdit && <div className="tset-foot">{s.calibHintV2}</div>}
      {bulkOn && (
        <RemindModal s={s} visible={!!remind} names={remind ? remind.list : []} stages={deptStages} disabled={hodOff}
          stage={remindStage} setStage={setRemindStage}
          notes={[remind && remind.partial.length ? s.remindHodPartial(remind.partial) : null]}
          loading={runner.busy} onOk={submitRemind} onCancel={() => setRemind(null)} />
      )}
      {runner.modal}
      {acts.modal}
    </div>
  );
}

/* ---------- 第二批 2.2：HR 部门明细（只读，与员工端 HoD 部门校准同一个组件 DeptCalibration mode="hr"）----------
   数据：GET /api/admin/review-cycles/:id/depts/:dept1Id → { view（reviewCalibView hr 模式）, row（部门行，同 depts[]）}。
   顶部 actions = 确认 / 退回 + 原因（与「部门确认」列表同一套）；「校准」只给有绩效写权限的人（onCalibrateRow），
   服务端另在行上给 editable（= hrCalibratable 且有写权限）；「提醒他们的上级」同样只给写权限。
   找不到该部门（404：已调整、越出范围）→ 提示并回到部门列表。 */
function DeptDetail({ d, s, lang, cycleId, unit, canEdit, canProfile, query, onQuery, onBack, onGone, reloadCycle }) {
  const renav = useRenavTick();
  const q = useAsync(() => api.get(`/api/admin/review-cycles/${cycleId}/depts/${encodeURIComponent(unit)}`), [cycleId, unit, renav]);
  const reloadDept = q.reload;
  const reloadAll = useCallback(() => { reloadDept(); reloadCycle(); }, [reloadDept, reloadCycle]);
  const acts = useDeptActs({ s, id: cycleId, reload: reloadAll });
  const calib = useCalib({ s, d, lang, v2: true, onSaved: reloadAll });
  useEffect(() => {
    if (q.error && q.error.status === 404) { Toast.warning(s.eUnitGone); onGone(); }
  }, [q.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = q.data;
  const view = data && data.view;
  const open = d.cycle.status === 'open';
  // 地址栏的筛选参数只在数据与地址一致时校验（审查 P1-8）
  const ready = !q.loading && !!view && String(view.cycle && view.cycle.id) === String(cycleId) && String(view.dept && view.dept.unit) === String(unit);
  const remindManagers = useMemo(() => (open && canEdit
    ? (ids) => api.post('/api/admin/review-reminders', { stage: 'manager', by: 'item', cycleId, ids })
    : undefined), [open, canEdit, cycleId]);
  const exportDept = () => downloadReviewCsv(s, `${d.cycle.name}-${(view && view.dept && view.dept.dept1) || unit}`, (view && view.rows) || [], !open);
  return (
    <div className="rvc-unit">
      <div className="rvc-filters">
        <Button icon={<IconArrowLeft />} theme="borderless" size="small" onClick={onBack}>{s.backDepts}</Button>
        {view && <Button icon={<IconDownload />} theme="light" size="small" onClick={exportDept}>{s.exportDept}</Button>}
      </div>
      {q.error && q.error.status !== 404 && <Banner type="danger" closeIcon={null} description={q.error.message} />}
      {!view && !q.error && <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>}
      {view && (
        <DeptCalibration mode="hr" lang={lang} view={view} query={query} onQuery={onQuery} ready={ready}
          onRemindManagers={remindManagers}
          onCalibrateRow={canEdit && open ? (row) => calib.openCalib(row) : undefined}
          actions={data.row ? <DeptActs r={data.row} s={s} open={open} canEdit={canEdit} acts={acts} /> : null}
          renderDetail={(row) => <ItemDetail r={{ ...row, ...(row.selfReview || {}) }} s={s} />}
          personHref={canProfile ? (row) => `/admin/people/${row.userId}` : undefined} />
      )}
      {acts.modal}
      {calib.modal}
    </div>
  );
}

// ---------- 绩效流程 v2：看板（阶段完成率、分布 vs 配额、部门 × 评级矩阵、按直属上级看分布）----------
// 第二批 2.3-C：筛选 dept / mgr / lv / stage 写进地址栏；数字可点开名单（RvcDrill）；已关闭周期按档案评级（recordRating）统计。
function Board({ d, s, lang, ratingLabel, canProfile, navigate, query, onQuery }) {
  const items = useMemo(() => d.items || [], [d]);
  const kind = d.cycle && d.cycle.kind === 'annual' ? 'annual' : 'quarter';
  const closed = !!(d.cycle && d.cycle.status === 'closed');
  const depts = useMemo(() => d.depts || [], [d]);
  const deptMap = useMemo(() => new Map(depts.map((x) => [x.dept1Id, x])), [depts]);
  const fq = { dept: (query && query.dept) || '', mgr: (query && query.mgr) || '', lv: (query && query.lv) || '', stage: (query && query.stage) || '' };
  const deptOpts = useMemo(() => rvcBoardDeptOptions(d.deptOptions), [d]);
  const mgrOpts = useMemo(() => dc.managerOptions(items), [items]);
  const lvOpts = useMemo(() => dc.levelOptions(items), [items]);
  const stageOpts = rvcStagesOf(kind);
  const fItems = useMemo(() => rvcBoardFilter(items, fq, deptMap, kind), [items, fq.dept, fq.mgr, fq.lv, fq.stage, deptMap, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = !!(fq.dept || fq.mgr || fq.lv || fq.stage);
  const [drill, setDrill] = useState(null);       // { title, items }
  // 地址栏里失效的筛选值（上级不在本周期、职级不存在、阶段不适用于该类型）清掉并提示一次。看板只在本周期数据到了以后才渲染
  // （CycleDetail 按周期 id 重挂），所以这里的数据一定与地址一致（审查 P1-8）。部门由 DeptFilter 的 onInvalid 处理；
  // 没有部门选项、DeptFilter 不渲染时在这里核
  useEffect(() => {
    const patch = {};
    if (fq.mgr && !mgrOpts.some((m) => m.id === fq.mgr)) patch.mgr = null;
    if (fq.lv && !lvOpts.some((o) => o.value === fq.lv)) patch.lv = null;
    if (fq.stage && !stageOpts.includes(fq.stage)) patch.stage = null;
    if (fq.dept && !deptOpts.length) patch.dept = null;
    if (Object.keys(patch).length) { onQuery(patch); Toast.info(s.filterCleared); }
  }, [fq.mgr, fq.lv, fq.stage, fq.dept, mgrOpts, lvOpts, deptOpts]); // eslint-disable-line react-hooks/exhaustive-deps

  const counted = fItems.filter(dc.isCounted);
  const excluded = fItems.length - counted.length;
  const n = counted.length;
  const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  // 部门两项的分母 = 筛到的人所在的一级部门（没有筛选时 = 全部部门）
  const inF = new Set(counted.map((i) => i.dept1Id));
  const dl = filtered ? depts.filter((x) => inF.has(x.dept1Id)) : depts;
  const hodDepts = dl.filter((x) => x.hod || x.hodOwned);
  const stDone = (x) => x.status && (x.status.hodSubmittedAt || x.status.hrConfirmedAt);
  const stages = [
    ...(kind === 'annual' ? [[s.bRatedAny, counted.filter((i) => rvcRatingOf(i, closed)).length, n]] : [
      [s.bSelf, counted.filter((i) => i.selfAt).length, n],
      [s.bOne, counted.filter((i) => dc.oneStateOf(i) === 'both').length, n],
      [s.bRated, counted.filter((i) => i.managerRating).length, n],
    ]),
    [s.bHod, hodDepts.filter(stDone).length, hodDepts.length],
    [s.bHr, dl.filter((x) => x.status && x.status.hrConfirmedAt).length, dl.length],
  ];
  const quota = (d.cycle && d.cycle.quota) || {};
  const tiers = rvcTiersOf(d.cycle);
  const total = rvcCount(counted, closed);
  const rated = Object.values(total).reduce((a, b) => a + b, 0);
  const matrix = rvcMatrixRows(fItems, fq, d, closed, s.noDept1);
  const quotaMode = rvcQuotaMode(fq, depts);
  const mgr = useMemo(() => (kind === 'annual' ? null : rvcMgrRows(fItems, d.ratingOptions)), [kind, fItems, d.ratingOptions]);
  const tierOf = (i) => dc.bucketOf(rvcRatingOf(i, closed));
  const openDrill = (title, list) => setDrill({ title, items: list });
  // 数字 > 0 可点开名单（.u-num-link）；超额的格子标红加粗（.u-num-over）—— 两个类由 W3-C 在 app.css 定义，替代波次 2 的内联样式
  const num = (v, onClick, over) => {
    const ov = over ? ' u-num-over' : '';
    return v > 0
      ? <button type="button" className={'u-num-link tnum' + ov} onClick={onClick}>{v}</button>
      : <span className={'tnum' + ov}>{v}</span>;
  };
  const rowLabel = (r) => (r.direct ? s.bDirect : r.total ? s.bTotal(r.label) : r.label);

  return (
    <div className="rvc-board">
      {/* 筛选：部门（一级–三级，含下级）、直属上级、职级、阶段 —— 写进地址栏（replace） */}
      <div className="rvc-filters">
        {deptOpts.length > 0 && (
          <DeptFilter options={deptOpts} value={fq.dept || null} lang={lang} size="small" ready
            onChange={(v) => onQuery({ dept: v || null })} onInvalid={() => { onQuery({ dept: null }); Toast.info(s.filterCleared); }} />
        )}
        <Select size="small" filter showClear value={fq.mgr || undefined} placeholder={s.mgrAll} style={{ width: 220 }}
          onChange={(v) => onQuery({ mgr: v || null })} insetLabel={s.colManager}
          optionList={mgrOpts.map((m) => ({ value: m.id, label: m.id === dc.NONE ? s.noMgrOpt : `${m.name || '—'}${m.status === 'departed' ? ` · ${s.mgrLeft}` : ''}` }))} />
        {lvOpts.length > 0 && (
          <Select size="small" showClear value={fq.lv || undefined} placeholder={s.lvAll} style={{ width: 210 }} insetLabel={s.fLevel}
            onChange={(v) => onQuery({ lv: v || null })}
            optionList={lvOpts.map((o) => ({ value: o.value, label: o.kind === 'g' ? s.lvGrade(o.label) : o.kind === 'none' ? s.lvNone : o.kind === 'nogrid' ? s.lvNoGrid : o.label }))} />
        )}
        <Select size="small" showClear value={fq.stage || undefined} placeholder={s.stageAll} style={{ width: 190 }} insetLabel={s.fStage2}
          onChange={(v) => onQuery({ stage: v || null })}
          optionList={stageOpts.map((k) => ({ value: k, label: s.stageName[k] }))} />
        <Text type="tertiary" size="small">{s.shownPeople(fItems.length, items.length)}</Text>
        {filtered && <Button size="small" theme="borderless" onClick={() => onQuery({ dept: null, mgr: null, lv: null, stage: null })}>{s.clearFilters}</Button>}
      </div>

      <div className="rvc-sub">{s.bStages}{filtered ? ` · ${s.filteredNote}` : ''}</div>
      <div className="rvc-kpis">
        {stages.map(([label, a, b]) => (
          <div key={label} className="rvc-kpi">
            <div className="rvc-kpi-l">{label}</div>
            <div className="rvc-kpi-v tnum">{pctOf(a, b)}%</div>
            <div className="rvc-kpi-bar"><i style={{ width: pctOf(a, b) + '%' }} /></div>
            <div className="rvc-kpi-n tnum">{a} / {b}</div>
          </div>
        ))}
      </div>
      {excluded > 0 && <div className="tset-foot">{s.bExcl(excluded)}</div>}

      <div className="rvc-sub">{filtered ? s.bDistF : s.bDist}</div>
      <div className="rvc-dbars">
        {tiers.map((t) => {
          const act = pctOf(total[t] || 0, rated), qv = Number(quota[t] || 0);
          const over = dc.QUOTA_CAPPED.includes(t) && act > qv;
          return (
            <div key={t} className={'rvc-dbar' + (over ? ' over' : '')}>
              <b>{t}</b>
              <div className="rvc-dbar-track"><i className="act" style={{ width: Math.min(100, act) + '%' }} /><i className="q" style={{ left: Math.min(100, qv) + '%' }} title={`${s.bQuota} ${qv}%`} /></div>
              <span className="tnum">{s.bActual} {act}% · {s.bQuota} {qv}%</span>
            </div>
          );
        })}
      </div>

      <div className="rvc-sub">{s.bMatrix}</div>
      {!quotaMode && <div className="tset-foot">{s.bQuotaOff}</div>}
      <Table rowKey="key" size="small" dataSource={matrix} pagination={matrix.length > 15 ? { pageSize: 15, formatPageText: false } : false}
        columns={cardify([
          { title: s.dDept, dataIndex: 'label', width: 220, render: (_, r) => (
            <span style={r.sub ? { paddingLeft: 14, display: 'inline-block' } : r.total ? { fontWeight: 600 } : undefined}>{r.sub ? '› ' : ''}{rowLabel(r)}</span>) },
          { title: s.dHc, dataIndex: 'n', width: 70, render: (_, r) => num(r.items.length, () => openDrill(s.drillTitle(rowLabel(r), s.drillAll), r.items)) },
          ...tiers.map((t) => ({ title: t, dataIndex: 't' + t, width: 84, render: (_, r) => {
            const c = r.counts[t] || 0;
            const over = rvcOverTiers(r).includes(t);
            const a = r.allowed && dc.QUOTA_CAPPED.includes(t) ? r.allowed[t] : undefined;
            return (<span>
              {num(c, () => openDrill(s.drillTitle(rowLabel(r), t), r.items.filter((i) => tierOf(i) === t)), over)}
              {a !== undefined && a !== null ? <Text type="quaternary" size="small"> /{a}</Text> : null}
            </span>);
          } })),
        ])} />

      {/* 按直属上级看评级分布（M6）：年度周期没有上级评级，不显示 */}
      <div className="rvc-sub">{s.bMgrTitle}{filtered ? ` · ${s.filteredNote}` : ''}</div>
      {kind === 'annual' ? <div className="tset-foot">{s.bMgrAnnual}</div> : (<>
        <div className="tset-foot">{s.bMgrLead(dc.MGR_DIST_MIN, dc.MGR_DIST_DIFF)}</div>
        {!mgr || !mgr.rows.length ? <div className="tset-foot">{s.bMgrNone}</div> : (
          <MgrDist rows={mgr.rows} s={s} d={d} ratingLabel={ratingLabel} items={fItems} openDrill={openDrill} num={num} />
        )}
      </>)}

      <RvcDrill drill={drill} s={s} ratingLabel={ratingLabel} canProfile={canProfile} navigate={navigate} closed={closed} onClose={() => setDrill(null)} />
    </div>
  );
}

// 按直属上级看评级分布的表：每位上级一行；数字可点开名单（按上级本人给的评级）
function MgrDist({ rows, s, d, ratingLabel, items, openDrill, num }) {
  const scale = (d.ratingOptions && d.ratingOptions.length ? d.ratingOptions : dc.RATING_ORDER);
  const mine = (m) => items.filter((i) => dc.isCounted(i) && String(i.managerId || '') === String(m.managerId));
  const tagOf = (t) => (t === 'loose' ? <Tag size="small" color="orange" type="light">{s.tagLoose}</Tag>
    : t === 'tight' ? <Tag size="small" color="blue" type="light">{s.tagTight}</Tag>
      : t === 'few' ? <Tag size="small" color="grey" type="light">{s.tagFew}</Tag> : null);
  const fmtDiff = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`);
  return (
    <Table rowKey={(r) => String(r.managerId)} size="small" dataSource={rows} pagination={rows.length > 15 ? { pageSize: 15, formatPageText: false } : false}
      scroll={{ x: 670 + scale.length * 56 }}
      columns={cardify([
        { title: s.colManager, dataIndex: 'manager', width: 160, render: (v, r) => <span>{v || '—'}{r.managerStatus === 'departed' ? <Text type="tertiary" size="small"> · {s.mgrLeft}</Text> : null}</span> },
        { title: s.mColTeam, dataIndex: 'team', width: 90, render: (v, r) => num(v, () => openDrill(s.drillTitle(r.manager || '—', s.drillAll), mine(r))) },
        { title: s.mColRated, dataIndex: 'n', width: 64, render: (v) => <span className="tnum">{v}</span> },
        ...scale.map((o) => ({ title: ratingLabel(o), dataIndex: 'r' + o, width: 56, render: (_, r) => num((r.counts || {})[o] || 0,
          () => openDrill(s.drillTitle(r.manager || '—', ratingLabel(o)), mine(r).filter((i) => i.managerRating === o && !dc.proxyOf(i)))) })),
        { title: s.mColDiff, dataIndex: 'diff', width: 110, render: (v) => <span className="tnum">{fmtDiff(v)}</span> },
        // 表头默认大写：「HoD」会变成「HOD」，这一列不转；标题是节点，cardify 不给它标签，手机卡片的标签手动补
        { title: <span className="u-th-plain">{s.mColAdj}</span>, dataIndex: 'up', width: 110, onCell: () => ({ 'data-label': s.mColAdj }),
          render: (_, r) => <span className="tnum">{r.up} / {r.down}</span> },
        { title: s.mColTag, dataIndex: 'tag', width: 136, render: (v) => tagOf(v) },
      ])} />
  );
}

/* 下钻名单（Semi Modal + 搜索 + 分页）：姓名（可读档案时链到 /admin/people/:id）、工号、部门、直属上级、上级评级、最终评级，
   以及「已调整」「HoD 代评」「已改动（原评级 X）」（2.6，仅已关闭周期、服务端给了 amendedFrom 时）。
   名单状态不进地址栏；看板筛选在地址栏里，从档案页后退回到同一个看板。 */
function RvcDrill({ drill, s, ratingLabel, canProfile, navigate, closed, onClose }) {
  return (
    <DrillModal drill={drill} s={s} onClose={onClose}
      columns={[
          { title: s.colName, dataIndex: 'name', width: 130, render: (v, r) => (canProfile
            ? <span className="emp-namelink" style={{ cursor: 'pointer' }} onClick={() => { onClose(); navigate(`/admin/people/${r.userId}`); }}>{v}</span>
            : <span>{v}</span>) },
          { title: s.colEmpId, dataIndex: 'employeeId', width: 100, render: (v) => <Text type="tertiary" size="small" className="tnum">{v}</Text> },
          { title: s.colDept, dataIndex: 'department', width: 150, render: (v) => v || <Text type="quaternary">—</Text> },
          { title: s.colManager, dataIndex: 'manager', width: 110, render: (v) => v || <Text type="quaternary" size="small">—</Text> },
          { title: s.colMgrRating, dataIndex: 'managerRating', width: 100, render: (v) => (v ? ratingLabel(v) : <Text type="quaternary">—</Text>) },
          { title: s.colFinal, dataIndex: 'finalRating', width: 170, render: (_, r) => {
            const v = rvcRatingOf(r, closed);
            return (<span>
              {v ? <Tag color="indigo" type="light" shape="circle">{ratingLabel(v)}</Tag> : <Text type="quaternary">—</Text>}
              {dc.proxyOf(r) && <Tag size="small" color="amber" type="light" className="u-tag-gap" title={r.hodText || undefined}>{s.proxyTag}</Tag>}
              {!dc.proxyOf(r) && r.managerRating && r.finalRating && r.finalRating !== r.managerRating && (
                <Tag size="small" color="amber" type="light" className="u-tag-gap" title={r.hodText || undefined}>{s.adjusted}</Tag>
              )}
              {closed && r.amendedFrom && <Tag size="small" color="amber" type="light" className="u-tag-gap">{s.amended(ratingLabel(r.amendedFrom))}</Tag>}
            </span>);
          } },
        ]} />
  );
}
