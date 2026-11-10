import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Table, Form, Modal, Button, Tag, Select, Popconfirm, Toast, Typography,
  Banner, Empty, Spin, Progress, Switch, Input, TextArea, Tooltip,
} from '@douyinfe/semi-ui';
import {
  IconPlus, IconTick, IconClose, IconDelete, IconRefresh, IconEdit,
  IconArrowUp, IconArrowDown, IconSearch,
} from '@douyinfe/semi-icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, useAsync } from '../../api.js';
import { date as fmtDate, datetime as fmtDateTime } from '../../fmt.js';
import { categoryLabel } from '../../categories.js';   // CX-047：类别按语言显示   // 一致性整改 3：日期时间统一格式
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE, useDataVersion, clampPage } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { dataTableColumns } from '../../components/DataTable.jsx';   // 一致性整改 2
import { canUseAction } from '../../rbac.js';
import { BULK_SEL_EXTRA, useBulkSelection, BulkBar, BulkConfirmModal, useBulkRunner } from '../../components/BulkActions.jsx';
import DeptFilter, { deptFilterInvalidText, dpfModalProps } from '../../components/DeptFilter.jsx';
import { useDeptTree, deptMatcher } from '../../deptfilter.js';
import { useUrlState } from '../../urlstate.js';
import { JobGradeSelect } from '../../components/TrainingFilters.jsx';
import { splitByGrade } from '../../jobgrades.js';
import { AssignModes, AssignCriteria, AssignResult, AssignFooter, AssignHelp, assignBlockReason } from '../../components/AssignPanel.jsx';

// ── 只读档下写控件的总闸门(RBAC P1)──────────────────────────────────────────
// 判据:一个动作控件的显隐取决于**它实际调用的那个接口**所属的能力域与读写,不是它所在
// 页面的域;逐条查仓库根 RBAC-ROUTE-MATRIX.md(108 条后台路由)。本页所有写接口在矩阵里
// 都归「培训 learning · 写」,与本页同域,所以 manage 档一律照旧显示;只有 read 档(客户
// 自建的只读角色)要把写控件收起 —— 服务端对 read 档的写操作回 403。
// 跨域的只有 GET /api/admin/roster(W1 白名单:people/learning/performance/talent 任一
// >=read 即可读),能进本页的角色必然已持 learning>=read,不另设门。
// 可售模块开关与 grants 两层**叠加**,由 canUseAction 一并过完(既有模块开关逻辑照旧)。
// 老服务(/api/me 无 grants)→ isSuperAdmin 为 true → 全部照旧显示,不会锁死界面。
const useCanWrite = () => canUseAction(useAuth().user, { domain: 'learning', module: 'learning', write: true });

const { Text } = Typography;

// ---------- co-located bilingual strings ----------
const T = {
  zh: {
    title: '发展项目', lead: '面向期次与班级的混合式培养；线上课程、线下课程与结业考试引用课程库，线上活动与线下活动在项目内创建。',
    newProject: '+ 新建发展项目', loading: '加载中…', loadFail: '加载失败，请刷新页面重试。', listEmpty: '还没有发展项目',
    stDraft: '草稿', stPlanning: '筹备中', stRunning: '进行中', stClosing: '收尾中', stClosed: '已关闭',
    // Plain-language explanations — HR shouldn't have to guess what a state does.
    // 按系统实际行为写（2026-10-06 核对 server.js：草稿对学员隐藏；筹备中/进行中可申请；收尾中、已关闭不可申请；已关闭内容只读）
    stHelp: {
      draft: '草稿：只有后台可见，学员看不到、也不能申请。适合先搭建期次、阶段与活动。',
      planning: '筹备中：尚未开班。学员能在「培训 › 发展项目」看到；期次设为开放申请时可以提交申请。',
      running: '进行中：已经开班，学员按阶段学习；期次仍开放申请时也可以提交申请。系统权限与筹备中相同，区别是告诉大家项目已经开始。',
      closing: '收尾中：学习基本结束，不再接受申请。已加入的学员仍可继续完成，后台仍可修改内容和名单。',
      closed: '已关闭：项目归档，学员仍能看到自己的记录。名称、描述、期次与活动不能再改；要修改，在「设置」里把状态改成其他状态后保存即可。',
    },
    stHelpTitle: '发展项目状态说明',
    stRemindNote: '逾期提醒与项目状态无关：由管理员在「培训概览」手动发送，按课程截止日期判断。',
    openRef: '点击打开',
    gateHelp: [
      '完成解锁：学员必须先做完上一阶段的全部必修项，本阶段才打开——适合有先后依赖的内容（先学完再考试）。',
      '按时间开放：到了你设的开始日期就自动打开，不管前面学没学完——适合按周排期、集中开课的班期。',
      '第 1 个阶段：选「完成解锁」时默认立即开放（前面没有阶段）；选「按时间开放」则等到开始日期。',
    ],
    membersN: (n) => `${n} 名学员`, membersWd: (n) => `另有 ${n} 名已退训`, delCohort: '删除期次', delCohortAsk: (n) => `删除期次「${n}」？只能删除没有学员、也没有签到与完成记录的期次。`, okCohortDeleted: '期次已删除', nomN: (n) => `${n} 条待审申请`,
    notStarted: '未开始',
    delProj: '删除发展项目', delProjOk: '发展项目已删除',
    delProjAsk: '将连同阶段、期次、活动一并删除，不可恢复。已有学员、签到记录或线上活动完成记录的发展项目不能删除，请把状态改为「已关闭」。',
    delProjHint: '只有尚无学员、签到记录和线上活动完成记录的发展项目可以删除；已开班的发展项目请把状态改为「已关闭」，记录将保留。',
    back: '← 返回发展项目',
    tabStruct: '阶段与活动', tabCohort: '期次与成员', tabNom: '待审申请', tabDash: '看板', tabSet: '设置',
    // Action bar — the three jobs HR opens a project to do, each of which used
    // to take two or three clicks through the tabs.
    actPhases: '编排阶段', actImport: '批量导入学员', actCode: '生成签到码',
    needCohort: '先添加一个期次，再导入学员', noOffline: '本期还没有线下活动或线下课程 —— 先添加一个，才能生成签到码',
    // create
    cTitle: '新建发展项目', fTitleZh: '名称（中文）', fTitleEn: '名称（EN · 选填）', fCategory: '分类', fSponsor: '发起人',
    reqTitle: '名称至少填一项（中文或英文）', created: '发展项目已创建',
    // structure
    cohortPick: '期次', addPhase: '+ 添加阶段', phaseName: '阶段名称（中文）', phaseNameEn: '阶段名称（EN · 选填）',
    addActivity: '+ 添加活动', delPhaseAsk: '删除该阶段及其活动安排？（学员已有的学习/签到记录保留）',
    gate: '按顺序解锁', noPhases: '暂无阶段，先添加一个',
    editPhase: '编辑阶段', gateMode: '下一阶段解锁方式（本阶段的门槛）', phGate: '本阶段开放方式',
    gateCompletion: '完成上一阶段全部必修后开放', gateTime: '按时间开放（到开始日期自动开放）',
    phStart: '开始日期（按时间开放时生效）', phEnd: '结束日期（展示用）',
    gateTextTime: (d) => `按时间开放${d ? ` · ${d} 起` : ''}`,
    aType: '活动类型', aProgram: '学习包（旧）', aCourse: '课程（所引用的课程已不存在）', aExam: '结业考试', aOffline: '线下活动',
    aCourseOnline: '线上课程（引用课程库）', aCourseOffline: '线下课程（引用课程库）', aOnline: '线上活动',
    aRef: '引用对象', aReqd: '必修', aOpt: '选修', aTitleZh: '活动名称（中文）', aTitleEn: '活动名称（EN · 选填）',
    aRefTo: '引用', nPeople: (n) => `${n}人`, colDept: '部门',
    aStart: '开始时间（日期+时分，签到按此判定迟到）', aLoc: '地点', aDue: '截止日期', reqRef: '请选择引用对象',
    // 线上活动（项目内创建；三种完成方式，创建后不能更改）
    aOnStart: '开始时间（日期+时分）', aUrl: '链接（直播、问卷或外部课程地址）',
    aUrlBad: '链接须以 http:// 或 https:// 开头', aUrlReq: '「打开链接即完成」须填写链接',
    aDuration: '时长（分钟）', aCompletion: '完成方式',
    cmClick: '打开链接即完成', cmSelf: '学员自行确认完成', cmTrainer: '讲师或 HR 登记完成',
    cmHelp: [
      '打开链接即完成：学员在发展项目页点开链接即记为完成，适合直播、回放与通知类内容。',
      '学员自行确认：学员看完后点「我已完成」，适合问卷与外部课程。',
      '讲师或 HR 登记：本场讲师在「我的授课」或 HR 在「完成登记」中逐人登记，适合需要核实的线上研讨。',
      '设为必修且下一阶段按「完成解锁」时，未完成会挡住下一阶段；选「讲师或 HR 登记」须有人及时登记。',
    ],
    aCompletionLocked: '已创建的线上活动不能更改完成方式（学员的完成记录按原方式产生）。',
    aDueOnline: '截止日期（选填；不填则以开始日期计逾期）',
    aTrainerOnlineHint: '被指定的人会在员工端「培训 › 我的授课」中看到本活动，为本期学员登记完成（没有签到码，不含任何后台权限）。',
    noOnlineCourse: '课程库中还没有线上课程', noOfflineCourse: '课程库中还没有线下课程',
    durationText: (n) => `${n} 分钟`,
    delActAsk: '移除该活动？', saved: '已保存', doneOf: (d, t) => `${d}/${t} 完成`,
    editAct: '编辑活动', aTypeLocked: '已创建的活动不能更改类型（学员的学习/签到记录挂在该活动上）；如需换类型，请删除后重新添加。',
    moveUp: '上移', moveDown: '下移', reordered: '顺序已保存',
    brokenTag: '引用失效', brokenHint: '所引用的课程/考试已不存在，已自动不计入完成要求 — 请重新选择内容或移除本活动。',
    // 按活动类别取名（kindOf 的结果；course = 所引用课程已不存在、判不出线上线下）
    actTypeLabel: { online_course: '线上课程', offline_course: '线下课程', online_activity: '线上活动', offline_activity: '线下活动', exam: '结业考试', program: '学习包（旧）', course: '课程' },
    overCapTitle: '超出期次容量',
    overCapAsk: (cap, cur, add) => `本期容量 ${cap} 人，已有 ${cur} 人，再加 ${add} 人会超出。仍要继续吗？`,
    overCapOk: '仍然添加',
    closedLocked: '发展项目已关闭，处于只读状态。如需修改，请先在「设置」中把状态改回「进行中」。',
    orderHint: '用 ↑ ↓ 调整顺序。阶段顺序决定「完成解锁」的先后：排在前面的阶段先做完，后面的才打开（按时间开放的阶段不受影响）。',
    checkin: '签到管理', ckCode: '现场签到码', ckRefresh: '刷新',
    ckNotOpen: (st) => `发展项目「进行中」才开放签到，当前为「${st}」，暂不生成签到码。名单查看与补签、请假登记照常可用。`,
    ckEnded: '该期次已过结束日，不再生成签到码，学员也不能再签到。名单查看与补签、请假登记照常可用。',
    ckBig: '投屏模式', ckExit: '点击任意位置退出投屏', ckRotate: '签到码每分钟自动更换',
    ckRefreshIn: (n) => `${n} 秒后刷新`, ckEnterHint: '学员在发展项目页输入', ckCheckedIn: '已签到',
    ckAttended: '出席', ckLate: '迟到', ckExcused: '请假', ckMissing: '未签到', ckAbsent: '缺席',
    ckMakeup: '补签', ckExcuse: '登记请假', ckToPresent: '改为出席', ckClose: '关闭',
    ckUndoMakeup: '取消补签', ckUndoExcuse: '取消请假', ckSelfNoUndo: '该学员是自己输码签到的，不能撤销', ckHint: '员工手机：培训 › 发展项目 → 本活动 → 输入签到码',
    // 负责人 2026-10-06：请假不算完成、需补课；补课后可直接把请假改为出席 / 完成，不必先撤销
    ckMakeupExcused: '补课出席', cpMakeupExcused: '补登记完成',
    // 线上活动的完成登记（没有签到码；HR 可补登记、登记请假或撤销任何一条）
    cpBtn: '完成登记', cpTitle: '完成登记',
    cpModeNote: (m) => ({ click: '学员打开链接即自动记为完成；可在此查看名单、补登记或撤销。', self: '学员点「我已完成」即记为完成；可在此查看名单、补登记或撤销。', trainer: '本活动由讲师或 HR 登记完成，学员端显示「待讲师确认」。' })[m] || '',
    cpCompleted: '已完成', cpExcused: '请假', cpMissing: '未完成',
    cpMark: '标记完成', cpExcuse: '登记请假', cpUndo: '撤销登记',
    cpColBy: '登记方式', cpBySelf: '学员本人', cpByStaff: '讲师 / HR', cpColAt: '时间',
    // 签到 / 完成登记名单的批量登记与撤销（2026-10-06 批量操作 B3）
    ckBulkPresent: '批量补签', ckBulkExcuse: '批量登记请假', ckBulkUndo: '批量撤销登记',
    cpBulkDone: '批量标记完成', cpBulkExcuse: '批量登记请假', cpBulkUndo: '批量撤销登记',
    bulkUndoOp: '撤销登记',
    ckBulkPresentNote: '已登记为缺席的学员不会被覆盖，会在结果中列出；迟到的学员将改为出席，请假的学员将登记为补课出席。',
    cpBulkDoneNote: '已登记请假的学员将改为已完成（补登记）；已完成的保持不变。',
    bulkMarkNote: '已有其他登记的学员不会被覆盖，会在结果中列出；如需更改，请先撤销原登记。',
    ckBulkUndoNote: '学员本人输码签到的记录不会被撤销，会在结果中列出。',
    cpBulkUndoNote: '学员自己完成的记录也会被撤销。',
    bulkName: (n, id) => `${n}（${id}）`,
    // cohorts & members
    addCohort: '+ 新增期次', eCohort: '编辑期次', fCName: '期次名称', fStart: '开始日期', fEnd: '结束日期',
    fCap: '容量（人）', fOpen: '开放申请', openTag: '开放申请',
    classes: '班级', addClass: '+ 添加班级', fClsName: '班级名称', fHead: '班主任（任何员工或管理员均可担任）',
    clsEdit: '编辑班级', clsDelAsk: '删除该班级？班内学员保留，仅变为未分班。', adminTag: '管理员',
    aTrainer: '讲师（负责讲授本场）',
    aTrainerHint: '被指定的人会在员工端「培训 › 我的授课」中显示签到码、为本场全体学员登记出勤（不含任何后台权限）。与班主任不同：班主任负责一个班的全程，讲师负责自己讲授的这一场。',
    members: '学员', addMembers: '+ 添加学员', pickEmployees: '搜索并选择员工', pickClass: '分到班级（可选）',
    byDept: '按部门',
    byDeptPh: '选择一个或多个部门，整批加入', byPastePh: '粘贴工号，空格/逗号/换行分隔均可\n例如：DP-2011 DP-2012 DP-2013',
    pasteMissing: (n) => `${n} 个工号未找到`,
    colName: '学员', colClass: '班级', colProgress: '进度', colState: '状态', colOps: '操作',
    searchMember: '搜索学员姓名或工号…', memberNone: '没有匹配的学员',
    memberMatch: (n, t) => `匹配 ${n} / ${t} 人`, totalText: (n) => `共 ${n} 条`,
    stActive: '在训', stWithdrawn: '已退训', move: '调班', withdraw: '办理退训',
    trajectory: '期次轨迹', trajNow: '至今', trajLeftUnknown: '已退训（退出时间未记录）',
    withdrawAsk: (n) => `为 ${n} 办理退训？学习与签到记录将保留。`,
    mvTitle: '调整期次/班级', mvCohort: '期次', mvClass: '班级（可不选）', okMoved: '已调整', okWithdrawn: '已退训',
    // 期次与成员的批量调整与批量退训（2026-10-06 批量操作 B2）
    bulkMove: '批量调整期次/班级', bulkWithdraw: '批量退训',
    bulkMoveHint: '只能在本发展项目内调整。班级不选时，所选学员将变为未分班；已在目标期次与班级的学员保持不变。',
    bulkWithdrawNote: '学习与签到记录将保留。',
    addedN: (n) => `已添加 ${n} 名学员（已自动指派发展项目内的课程）`,
    // 部门筛选（第二批 3.1）：期次成员、签到 / 完成登记名单；按部门加学员含下级（P3）
    deptAll: '全部部门', memDeptHint: '部门筛选对本页全部期次生效，选上级即含全部下级',
    rosterDept: (n, t) => `当前部门 ${n} / ${t} 人`,
    byDeptConfirmT: '按部门添加学员', byDeptConfirm: (n) => `将加入 ${n} 人。确认添加？`, byDeptOk: '确认添加',
    // 第三批 8.6：按部门 / 职级加学员
    byGradeConfirmT: '按部门 / 职级添加学员',
    // UI 批 U2 11.5：与课程库指派弹窗同一布局 —— 人数结果条、底部按钮与不可用原因、标题旁「?」说明
    addDo: '添加', addWill: '将新加入', addMatched: '符合条件', addFound: '找到', addPicked: '已选',
    addSkipped: '已在本期（跳过）', addSkippedOther: '已在其他期次（跳过）', addPasteSkipped: '已在本期或不可添加（跳过）', addNoGradeR: '未设职级（不含）', addMissingR: '工号未找到',
    addHelp: '按条件：部门与职级可以单独用，也可以组合（如某部门含下级 × P1–P3），选上级部门即包含全部下级部门，职级可在下拉底部按区间加入；只含在职员工，选了职级时未设职级的人不纳入。三种方式都会自动跳过已在本期的学员和管理员账号；加入后自动指派发展项目内的课程。',
    confirmSkip: (n) => `已扣除已在本期的 ${n} 人。`, confirmSkipOther: (n) => `已在其他期次的 ${n} 人不在其中（如需调入请用「调班」）。`, confirmNoGrade: (n) => `未设职级的 ${n} 人不在其中。`,
    projGone: '该发展项目不存在或已删除，已返回列表。',
    // F53 + 12.1（UI 批 U2）：培养项目列表改为表格 + 筛选条（与课程库列表一致）
    colProj: '发展项目', colCat: '类别', colCohorts: '期次', colMembers: '学员数', colDone: '完成度', colDates: '开始—结束', colOwner: '负责人',
    lstManage: '管理', cohortsCur: (n, cur) => `${n} 期 · 当前第 ${cur} 期`, cohortsOnly: (n) => `${n} 期`,
    lstSearchPh: '搜索项目名称或编号', lstStOpen: '未关闭', lstStAll: '全部', lstCatAll: '全部类别', lstCatNone: '未分类',
    lstYear: '开始年份', lstYearAll: '全部年份', lstYearNone: '暂无开始日期', lstYearN: (y) => `${y} 年开始`, lstOwnerAll: '全部负责人',
    lstSort: '排序', lstSortDefault: '默认顺序', lstSortStartDesc: '开始日期：最近在前', lstSortStartAsc: '开始日期：最早在前',
    lstSortDoneDesc: '完成度：从高到低', lstSortDoneAsc: '完成度：从低到高', lstSortMembersDesc: '学员数：从多到少', lstSortMembersAsc: '学员数：从少到多',
    lstSortByCol: '按表头排序', lstClear: '清除筛选', lstTotal: (n) => `共 ${n} 个项目`, lstEmptyFiltered: '没有符合筛选条件的发展项目',
    // nominations
    nomEmpty: '暂无待审申请', nApprove: '通过并入班', nReject: '驳回', nRejectTitle: '驳回申请',
    nNote: '驳回理由（必填，员工可见）', nApproved: '已通过', nRejected: '已驳回', nCohort: '期次', nReason: '申请说明',
    // dashboard
    kMembers: '在训学员', kProgress: '平均进度', kAttendance: '出勤率', kRisk: '风险条目', dashEmpty: '暂无数据（先添加期次与学员）', dashCohortEmpty: '这一期暂无在训学员，可切换其他期次查看。',
    funnel: '阶段漏斗（完成人数）', funnelEmpty: '这一期还没有阶段。', cohortLabel: (n) => `期次：${n}`, riskList: '逾期风险', riskItem: '事项', riskDue: '截止', noRisk: '暂无逾期',
    // settings
    save: '保存', fStatus: '发展项目状态', fDescZh: '描述（中文）', fDescEn: 'Description (EN)', updated: '设置已保存',
    cancel: '取消',
    // 只读档(learning=read)的说明:写接口服务端一律 403,按钮留着就是「假按钮」。
    roWrite: '只读权限：当前角色对培训只能查看、不能修改，写操作不可用；如需操作请联系超级管理员调整授权。',
  },
  en: {
    title: 'Development Programs', lead: 'Blended development programs run by cohort and class. Online courses, in-person courses and final exams come from the Course Library; online and in-person activities are set up inside the program.',
    newProject: '+ New program', loading: 'Loading…', loadFail: 'Couldn’t load. Refresh the page to try again.', listEmpty: 'No development programs yet',
    stDraft: 'Draft', stPlanning: 'Planning', stRunning: 'In progress', stClosing: 'Wrapping up', stClosed: 'Closed',
    stHelp: {
      draft: 'Draft: console only. Learners cannot see it or apply. Use it to build cohorts, phases and activities first.',
      planning: 'Planning: not started yet. Learners can see it under Learning › Development Programs and apply when a cohort is open for applications.',
      running: 'In progress: the program has started and learners work through the phases; they can still apply while a cohort is open. Same permissions as Planning; it tells everyone the program is under way.',
      closing: 'Wrapping up: learning is mostly done and applications are closed. Enrolled learners can still finish, and you can still edit content and members.',
      closed: 'Closed: archived. Learners still see their own records. Name, description, cohorts and activities can no longer be edited; to edit, change the status in Settings and save.',
    },
    stHelpTitle: 'What the states mean',
    stRemindNote: 'Overdue reminders do not depend on the program status: an admin sends them from Learning Overview, based on course due dates.',
    openRef: 'Click to open',
    gateHelp: [
      'By completion: the phase opens only after every required item of the PREVIOUS phase is done — use it when order matters (finish the course, then sit the exam).',
      'By schedule: it opens on the start date you set, regardless of earlier progress — use it for week-by-week cohorts.',
      'The FIRST phase: "by completion" means open immediately (nothing precedes it); "by schedule" waits for the start date.',
    ],
    membersN: (n) => `${n} learners`, membersWd: (n) => `${n} withdrawn`, delCohort: 'Delete cohort', delCohortAsk: (n) => `Delete cohort "${n}"? Only a cohort with no learners and no check-in or completion records can be deleted.`, okCohortDeleted: 'Cohort deleted', nomN: (n) => `${n} pending applications`,
    notStarted: 'Not started',
    delProj: 'Delete program', delProjOk: 'Program deleted',
    delProjAsk: 'Deletes its phases, cohorts and activities as well. This cannot be undone. A program that already has learners, attendance records or online activity completion records cannot be deleted; set its status to Closed instead.',
    delProjHint: 'Only a program with no learners, attendance records or online activity completion records can be deleted. For a program already under way, set its status to Closed so the records are kept.',
    back: '← Back to Development Programs',
    tabStruct: 'Phases & activities', tabCohort: 'Cohorts & members', tabNom: 'Pending Applications', tabDash: 'Board', tabSet: 'Settings',
    actPhases: 'Arrange phases', actImport: 'Bulk-import learners', actCode: 'Generate check-in code',
    needCohort: 'Add a cohort first, then import learners', noOffline: 'No offline session or in-person course in this cohort yet — add one to generate a check-in code',
    cTitle: 'New Development Program', fTitleZh: 'Name (Chinese)', fTitleEn: 'Name (EN · optional)', fCategory: 'Category', fSponsor: 'Sponsor',
    reqTitle: 'Fill in at least one name (Chinese or English)', created: 'Program created',
    cohortPick: 'Cohort', addPhase: '+ Add phase', phaseName: 'Phase name (Chinese)', phaseNameEn: 'Phase name (EN · optional)',
    addActivity: '+ Add activity', delPhaseAsk: 'Delete this phase and its planned activities? (learning/attendance records are kept)',
    gate: 'Unlocks in order', noPhases: 'No phases yet — add one',
    editPhase: 'Edit phase', gateMode: 'How the NEXT phase unlocks', phGate: 'How this phase opens',
    gateCompletion: 'After every required activity of the previous phase', gateTime: 'By schedule (opens on its start date)',
    phStart: 'Start date (used by schedule mode)', phEnd: 'End date (display)',
    gateTextTime: (d) => `Opens by schedule${d ? ` · from ${d}` : ''}`,
    aType: 'Activity type', aProgram: 'Learning package (legacy)', aCourse: 'Course (the referenced course no longer exists)', aExam: 'Final exam', aOffline: 'In-person activity',
    aCourseOnline: 'Online course (from the library)', aCourseOffline: 'In-person course (from the library)', aOnline: 'Online activity',
    aRef: 'Reference', aReqd: 'Required', aOpt: 'Elective', aTitleZh: 'Activity name (Chinese)', aTitleEn: 'Activity name (EN · optional)',
    aRefTo: 'References', nPeople: (n) => `${n} people`, colDept: 'Department',
    aStart: 'Start time (date + hh:mm; lateness is judged from this)', aLoc: 'Location', aDue: 'Due date', reqRef: 'Pick what this references',
    aOnStart: 'Start time (date + hh:mm)', aUrl: 'Link (live stream, survey or external course)',
    aUrlBad: 'The link must start with http:// or https://', aUrlReq: 'Opening-the-link completion needs a link',
    aDuration: 'Duration (minutes)', aCompletion: 'How it is completed',
    cmClick: 'Opening the link completes it', cmSelf: 'Learner marks it done', cmTrainer: 'Trainer or HR records completion',
    cmHelp: [
      'Opening the link: the learner opens it from the program page and it counts as done — for live streams, recordings and notices.',
      'Learner marks it done: they press Mark as done afterwards — for surveys and external courses.',
      'Trainer or HR records it: the trainer (My Sessions) or HR (Completion) marks each learner — for online workshops that need checking.',
      'If it is required and the next phase unlocks on completion, it holds that phase until done; with trainer/HR recording, someone must record it promptly.',
    ],
    aCompletionLocked: "An existing online activity's completion method can't be changed (learners' records were made under it).",
    aDueOnline: 'Due date (optional; if empty, the start date is used for overdue)',
    aTrainerOnlineHint: "They see this activity under My Sessions and record completion for this cohort's learners (no check-in code, no admin rights).",
    noOnlineCourse: 'No online courses in the Course Library yet', noOfflineCourse: 'No in-person courses in the Course Library yet',
    durationText: (n) => `${n} min`,
    delActAsk: 'Remove this activity?', saved: 'Saved', doneOf: (d, t) => `${d}/${t} done`,
    editAct: 'Edit activity', aTypeLocked: "An existing activity's type can't be changed (learner progress/attendance is tied to it); to switch type, remove it and add a new one.",
    moveUp: 'Move up', moveDown: 'Move down', reordered: 'Order saved',
    brokenTag: 'Broken link', brokenHint: 'The referenced course/exam no longer exists; it is excluded from completion — pick new content or remove this activity.',
    actTypeLabel: { online_course: 'Online course', offline_course: 'In-person course', online_activity: 'Online activity', offline_activity: 'In-person activity', exam: 'Final exam', program: 'Learning package (legacy)', course: 'Course' },
    overCapTitle: 'Over cohort capacity',
    overCapAsk: (cap, cur, add) => `Capacity is ${cap}; ${cur} already enrolled and ${add} more would exceed it. Continue anyway?`,
    overCapOk: 'Add anyway',
    closedLocked: 'This program is closed and read-only. To edit it, change its status back to In progress in Settings.',
    orderHint: 'Use ↑ ↓ to resequence. Phase order drives completion gating: an earlier phase must be finished before the next one opens (schedule-gated phases are unaffected).',
    checkin: 'Check-in', ckCode: 'On-site code', ckRefresh: 'Refresh',
    ckNotOpen: (st) => `Check-in opens only while the program is In progress. It is currently ${st}, so no code is shown. You can still view the list and record make-ups or leave.`,
    ckEnded: 'This cohort is past its end date, so no code is generated and learners can no longer check in. You can still view the list and record make-ups or leave.',
    ckBig: 'Projector mode', ckExit: 'Click anywhere to exit', ckRotate: 'Code rotates every minute',
    ckRefreshIn: (n) => `Refreshes in ${n}s`, ckEnterHint: 'Learners enter it on their program page', ckCheckedIn: 'Checked in',
    ckAttended: 'Present', ckLate: 'Late', ckExcused: 'Excused', ckMissing: 'Not checked in', ckAbsent: 'Absent',
    ckMakeup: 'Mark present', ckExcuse: 'Mark excused', ckToPresent: 'Change to present', ckClose: 'Close',
    ckUndoMakeup: 'Undo check-in', ckUndoExcuse: 'Undo excused', ckSelfNoUndo: 'This learner checked in with the code themselves — that can’t be undone', ckHint: "On the employee's phone: Learning › Development Programs → this activity → enter the code",
    ckMakeupExcused: 'Mark make-up attended', cpMakeupExcused: 'Mark make-up done',
    cpBtn: 'Completion', cpTitle: 'Completion',
    cpModeNote: (m) => ({ click: 'Opening the link marks a learner done automatically; view the list, record or undo here.', self: 'Learners mark it done themselves; view the list, record or undo here.', trainer: 'The trainer or HR records completion; learners see Awaiting trainer confirmation.' })[m] || '',
    cpCompleted: 'Completed', cpExcused: 'Excused', cpMissing: 'Not done',
    cpMark: 'Mark done', cpExcuse: 'Mark excused', cpUndo: 'Undo',
    cpColBy: 'Recorded by', cpBySelf: 'Learner', cpByStaff: 'Trainer / HR', cpColAt: 'Time',
    ckBulkPresent: 'Mark selected present', ckBulkExcuse: 'Mark selected excused', ckBulkUndo: 'Undo selected records',
    cpBulkDone: 'Mark selected done', cpBulkExcuse: 'Mark selected excused', cpBulkUndo: 'Undo selected records',
    bulkUndoOp: 'Undo record',
    ckBulkPresentNote: 'Learners already recorded as absent are not overwritten and are listed in the result; late arrivals are changed to present and excused learners are recorded as make-up attended.',
    cpBulkDoneNote: 'Excused learners are changed to completed (make-up); completed ones stay as they are.',
    bulkMarkNote: 'Learners who already have a different record are not overwritten and are listed in the result. To change a record, undo it first.',
    ckBulkUndoNote: 'Self check-ins (the learner entered the code) are kept and listed in the result.',
    cpBulkUndoNote: 'Records the learners completed themselves will be undone too.',
    bulkName: (n, id) => `${n} (${id})`,
    addCohort: '+ New cohort', eCohort: 'Edit cohort', fCName: 'Cohort name', fStart: 'Start date', fEnd: 'End date',
    fCap: 'Capacity', fOpen: 'Open for application', openTag: 'Open for application',
    classes: 'Classes', addClass: '+ Add class', fClsName: 'Class name', fHead: 'Class coordinator (any employee or admin)',
    clsEdit: 'Edit class', clsDelAsk: 'Delete this class? Its learners stay, just unassigned.', adminTag: 'Admin',
    aTrainer: 'Trainer (delivers this session)',
    aTrainerHint: 'They get a "My Sessions" workbench: show the check-in code and take the roll for everyone attending this session (no admin rights). Different from a class coordinator, who follows one class through the whole program.',
    members: 'Learners', addMembers: '+ Add learners', pickEmployees: 'Search and pick employees', pickClass: 'Class (optional)',
    byDept: 'By department',
    byDeptPh: 'Pick one or more departments to add in bulk', byPastePh: 'Paste employee IDs separated by spaces/commas/newlines\ne.g. DP-2011 DP-2012 DP-2013',
    pasteMissing: (n) => `${n} IDs not found`,
    colName: 'Learner', colClass: 'Class', colProgress: 'Progress', colState: 'Status', colOps: 'Actions',
    searchMember: 'Search name or employee ID…', memberNone: 'No learners match',
    memberMatch: (n, t) => `${n} of ${t} learners`, totalText: (n) => `${n} total`,
    stActive: 'Active', stWithdrawn: 'Withdrawn', move: 'Move', withdraw: 'Withdraw',
    trajectory: 'Cohort history', trajNow: 'now', trajLeftUnknown: 'withdrawn (time not recorded)',
    withdrawAsk: (n) => `Withdraw ${n} from this program? Learning and attendance records are kept.`,
    mvTitle: 'Move cohort / class', mvCohort: 'Cohort', mvClass: 'Class (optional)', okMoved: 'Moved', okWithdrawn: 'Withdrawn',
    bulkMove: 'Move selected', bulkWithdraw: 'Withdraw selected',
    bulkMoveHint: 'Learners can only be moved within this program. If no class is chosen, the selected learners become unassigned; learners already in the chosen cohort and class stay as they are.',
    bulkWithdrawNote: 'Learning and attendance records are kept.',
    addedN: (n) => `${n} learner${n === 1 ? '' : 's'} added (program courses assigned automatically)`,
    deptAll: 'All departments', memDeptHint: 'The department filter applies to every cohort on this tab; a parent department includes all its sub-departments',
    rosterDept: (n, t) => `${n} of ${t} in this department`,
    byDeptConfirmT: 'Add learners by department', byDeptConfirm: (n) => `This adds ${n} ${n === 1 ? 'person' : 'people'}. Add them?`, byDeptOk: 'Add',
    byGradeConfirmT: 'Add learners by department / job grade',
    addDo: 'Add', addWill: 'Newly added', addMatched: 'Match', addFound: 'Found', addPicked: 'Picked',
    addSkipped: 'Already in this cohort (skipped)', addSkippedOther: 'Already in another cohort (skipped)', addPasteSkipped: 'Already in this cohort or not eligible (skipped)', addNoGradeR: 'No job grade (not included)', addMissingR: 'IDs not found',
    addHelp: 'By criteria: use a department, a job grade, or both (e.g. one department with its sub-departments × P1–P3). A parent department includes all its sub-departments, and a range of grades can be added at the bottom of the grade list. Active employees only; when a grade is chosen, people without a job grade are not included. All three ways skip learners already in this cohort and admin accounts; the program courses are assigned automatically once learners are added.',
    confirmSkip: (n) => `${n} ${n === 1 ? 'person already in this cohort was' : 'people already in this cohort were'} left out.`, confirmSkipOther: (n) => `${n} already in another cohort ${n === 1 ? 'is' : 'are'} not included (use Move to transfer them).`, confirmNoGrade: (n) => `${n} ${n === 1 ? 'person' : 'people'} without a job grade ${n === 1 ? 'is' : 'are'} not included.`,
    projGone: 'That development program no longer exists. Returned to the list.',
    colProj: 'Development Program', colCat: 'Category', colCohorts: 'Cohorts', colMembers: 'Learners', colDone: 'Completion', colDates: 'Start – end', colOwner: 'Owner',
    lstManage: 'Manage', cohortsCur: (n, cur) => `${n} · current: cohort ${cur}`, cohortsOnly: (n) => `${n}`,
    lstSearchPh: 'Search program name or code', lstStOpen: 'Not closed', lstStAll: 'All', lstCatAll: 'All categories', lstCatNone: 'Uncategorized',
    lstYear: 'Start year', lstYearAll: 'All years', lstYearNone: 'No start dates yet', lstYearN: (y) => `Starting in ${y}`, lstOwnerAll: 'All owners',
    lstSort: 'Sort', lstSortDefault: 'Default order', lstSortStartDesc: 'Start date: latest first', lstSortStartAsc: 'Start date: earliest first',
    lstSortDoneDesc: 'Completion: high to low', lstSortDoneAsc: 'Completion: low to high', lstSortMembersDesc: 'Learners: most first', lstSortMembersAsc: 'Learners: fewest first',
    lstSortByCol: 'Sorted by column', lstClear: 'Clear filters', lstTotal: (n) => `${n} program${n === 1 ? '' : 's'}`, lstEmptyFiltered: 'No development programs match the filters',
    nomEmpty: 'No pending applications', nApprove: 'Approve and add to cohort', nReject: 'Reject', nRejectTitle: 'Reject application',
    nNote: 'Reason (required, visible to the employee)', nApproved: 'Approved', nRejected: 'Rejected', nCohort: 'Cohort', nReason: 'Reason for applying',
    kMembers: 'Active learners', kProgress: 'Avg progress', kAttendance: 'Attendance', kRisk: 'Risk items', dashEmpty: 'No data yet — add a cohort and learners', dashCohortEmpty: 'This cohort has no active learners. Switch to another cohort to view it.',
    funnel: 'Phase funnel (completed)', funnelEmpty: 'This cohort has no phases yet.', cohortLabel: (n) => `Cohort: ${n}`, riskList: 'Overdue risks', riskItem: 'Item', riskDue: 'Due', noRisk: 'Nothing overdue',
    save: 'Save', fStatus: 'Program status', fDescZh: 'Description (Chinese)', fDescEn: 'Description (EN)', updated: 'Settings saved',
    cancel: 'Cancel',
    roWrite: 'Read-only: your role can view training but not change it, so the write actions are unavailable. Ask a super-admin to widen the grant.',
  },
};

const genId = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
// Immutable swap for reordering phases / activities.
const swap = (arr, i, j) => {
  const next = (arr || []).slice();
  if (i < 0 || j < 0 || i >= next.length || j >= next.length) return next;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};
const STATUS_COLOR = { draft: 'grey', planning: 'amber', running: 'indigo', closing: 'cyan', closed: 'green' };

// ---------- 批量操作（2026-10-06 SPEC-bulk-ops：B2 期次与成员、B3 签到 / 完成登记名单）----------
// 表格数据的空值用同一个数组：useBulkSelection 与 useDataVersion 都按引用判断数据是否换了一份。
const NONE = [];
// 只有在训学员可勾选（与单条操作一致：已退训的行没有「调班 / 办理退训」）。模块级函数，引用稳定。
const isActiveMember = (r) => r.state === 'active';
// 打开确认弹窗时取快照：所选行 → 请求用的 id 列表、名单与「id → 名称」对照（结果弹窗用）。
// sel.rows 已按屏幕上的顺序排好（当前页按表格行先后，其余按数据顺序，E18），请求也按这个顺序发，结果逐条对得上。
function bulkSnapshot(sel, s) {
  const list = sel.rows || NONE;
  const names = list.map((r) => s.bulkName(r.name || r.userId, r.employeeId || '—'));
  return { ids: list.map((r) => r.userId), names, labels: Object.fromEntries(list.map((r, i) => [r.userId, names[i]])) };
}

// 签到 / 完成登记名单的部门筛选（第二批 3.1）：弹窗内部状态，不进地址栏。名单行（服务端）不带部门，用本页已加载的人员名单
// （GET /api/admin/roster，与名单同一数据范围）按 userId 补上部门原文，再按全站口径匹配（含全部下级）。
// 返回筛选后的行（引用稳定：没筛选时就是原数组，勾选与表格不会因此重挂）和「userId → 部门」对照（名字后面显示部门）。
function useRosterDept(roster, list) {
  const tree = useDeptTree();
  const [dept, setDept] = useState(null);
  const deptOf = useMemo(() => new Map((roster || NONE).map((r) => [r.id, r.department || null])), [roster]);
  const ok = useMemo(() => deptMatcher(tree, dept), [tree, dept]);
  const rows = useMemo(() => (dept ? list.filter((r) => ok(deptOf.get(r.userId))) : list), [list, dept, ok, deptOf]);
  const rosterReady = !!(roster && roster.length);
  return { tree, dept, setDept, rows, deptOf, rosterReady };
}
function RosterDeptBar({ s, lang, rd, total }) {
  return (
    <div className="u-filterbar">
      <DeptFilter options={rd.tree ? rd.tree.options : NONE} value={rd.dept} onChange={(v) => rd.setDept(v || null)}
        lang={lang} size="small" label={s.colDept} placeholder={s.deptAll} ready={!!rd.tree}
        disabled={rd.tree === null || !rd.rosterReady} showNone={!!(rd.tree && rd.tree.hasNone)} />
      {rd.dept && <span className="u-count">{s.rosterDept(rd.rows.length, total)}</span>}
    </div>
  );
}

/* Activity-type marks. Line icons on the existing svg.ic convention (stroke 1.8,
   stroke:currentColor) so each one takes the colour of the badge it sits in —
   .tp-ic normally, .tp-ic-broken when the reference is dead. */
const Ic = ({ d }) => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;
const IC_BOOK = <Ic d={<><path d="M12 7v13" /><path d="M12 7C10 5.5 7 5.2 4 5.6v12c3-.4 6-.1 8 1.4" /><path d="M12 7c2-1.5 5-1.8 8-1.4v12c-3-.4-6-.1-8 1.4" /></>} />; // open book
// 按活动类别（kindOf 的结果）取图标，不按存储的 type：线上 / 线下课程同为 type 'course'，要分开显示。
const TYPE_IC = {
  online_course: IC_BOOK,
  course: IC_BOOK, // 所引用的课程已不存在，判不出线上线下
  offline_course: <Ic d={<><rect x="4" y="4" width="16" height="10" rx="1" /><path d="M12 14v3" /><path d="M8 21l4-4 4 4" /></>} />, // whiteboard on an easel
  online_activity: <Ic d={<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M10 8l4 2-4 2z" /><path d="M8 20h8M12 16v4" /></>} />, // monitor with play
  offline_activity: <Ic d={<><path d="M3 21h18" /><path d="M5 21V6l7-3 7 3v15" /><path d="M10 21v-5h4v5" /><path d="M9 10h2M13 10h2" /></>} />, // venue building
  exam: <Ic d={<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9z" /><path d="M9 11h6M9 15h4" /></>} />, // clipboard
  program: <Ic d={<><path d="M5 4h9a2 2 0 012 2v14H7a2 2 0 01-2-2z" /><path d="M9 8h6M9 12h6" /></>} />,   // stacked pages
};
// Unrecognised activity type, and the dead-reference mark next to 「引用失效」.
const IC_OTHER = <Ic d={<circle cx="12" cy="12" r="7" />} />;
const IC_WARN = <Ic d={<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>} />;

/* ── 五类活动（负责人 2026-10-06 拍板）──────────────────────────────────────────
   界面按「类别」分五类，存储仍按 type：
   - 线上课程 / 线下课程：都存为 type 'course'（引用课程库），线上还是线下按所引课程的 mode 现算，
     与服务端 tpActivityView(a).category 同一套取值（GET /api/admin/tprojects/:id 返回原始文档，所以后台自己算）；
   - 线上活动：type 'online'（项目内创建，完成方式 click / self / trainer，创建后不能改）；
   - 线下活动：type 'offline'；结业考试：type 'exam'；
   - 旧学习包 type 'program' 只显示、不能新建；course 的引用失效时类别为 'course'。
   界面上的类别名（online_course 等）只在前端用，写回服务端前一律经 STORED_TYPE 换回 type。 */
const KINDS = ['online_course', 'offline_course', 'online_activity', 'offline_activity', 'exam'];
const STORED_TYPE = { online_course: 'course', offline_course: 'course', course: 'course', online_activity: 'online', offline_activity: 'offline', exam: 'exam', program: 'program' };
const kindOf = (a, courses) => {
  if (a.type === 'course') {
    const c = (courses || []).find((x) => x.id === a.refId);
    return c ? ((c.mode || 'online') === 'offline' ? 'offline_course' : 'online_course') : 'course';
  }
  return ({ online: 'online_activity', offline: 'offline_activity' })[a.type] || a.type;
};
// 与服务端 TP_URL_RE 相同：只认 http(s) 链接，挡掉 javascript: / data: 等
const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

export default function Projects() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  const canWrite = useCanWrite();
  const listQ = useAsync(() => api.get('/api/admin/tprojects'), []);
  // 打开的培养项目与页签写进地址栏（第二批 2.5 / 3.1）：?project=<id>&tab=struct|cohort|nom|dash|set。
  // 「待审申请」通知直达 #/admin/projects?project=<id>&tab=nom；刷新、返回键、分享链接都能还原。
  // 打开 / 返回列表用 push（安卓返回键回到列表）；切页签用 replace。合并写回，不整串覆盖。
  const [urlp, patchUrl] = useUrlState();
  const sel = urlp.project || null;
  const setSel = (id) => patchUrl({ project: id || null, tab: null, dept: null }, { push: true });
  // 回到列表（按钮或浏览器返回键）时重拉：成员数、待审数、进度可能已变
  const prevSel = useRef(sel);
  useEffect(() => {
    if (prevSel.current && !sel) listQ.reload();
    prevSel.current = sel;
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  // 项目不存在（已删除、链接错误）：提示并回到列表，替换掉这条地址，返回键不会再回到坏链接
  const dropGone = () => { Toast.warning(s.projGone); patchUrl({ project: null, tab: null, dept: null }, { push: false }); };

  if (sel) return <Detail key={sel} id={sel} s={s} lang={lang} loc={loc} onBack={() => setSel(null)} onGone={dropGone} />;

  // The server counts learners and attendance itself and answers has_history
  // when either exists, so this does not need to re-check — it just reports.
  const remove = async (p) => {
    try {
      await api.del(`/api/admin/tprojects/${p.id}`);
      Toast.success(s.delProjOk);
      listQ.reload();
    } catch (e) { Toast.error(e.message); }
  };

  return (
    <div className="wrap emp-wrap">
      <div className="emp-head">
        <div>
          <h1 className="emp-title">{s.title}</h1>
          <div className="emp-lead">{s.lead}</div>
          {!canWrite && <div className="emp-lead" style={{ color: 'var(--semi-color-text-2)' }}>{s.roWrite}</div>}
        </div>
        {canWrite && <NewProjectButton s={s} onCreated={(id) => { listQ.reload(); setSel(id); }} />}
      </div>
      {listQ.error && <Banner type="danger" closeIcon={null} description={[s.loadFail, listQ.error.message].filter(Boolean).join(' · ')} />}
      {listQ.loading && !listQ.data ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : !(listQ.data && listQ.data.length) ? (
        <Empty description={s.listEmpty} style={{ padding: '64px 0' }} />
      ) : (
        <ProjectList s={s} lang={lang} loc={loc} rows={listQ.data} canWrite={canWrite} onOpen={setSel} onRemove={remove} />
      )}
      {listQ.data && listQ.data.length > 0 && <div className="tp-foot">{s.delProjHint}</div>}
    </div>
  );
}

// ---------- 培养项目列表（F53 + 12.1，UI 批 U2 2026-10-09）----------
// 表格（与课程库列表同一套样式：co-filters-b3 筛选条 + co-ctable 表格 + co-row-* 名称格）；390 宽每行一张紧凑卡片。
// 筛选与排序全部写进地址栏（useUrlState，replace）：q 搜索（名称 / 编号）、st 状态（缺省 = 不含已关闭，all = 全部）、
// cat 类别（__none = 未分类）、year 开始年份、owner 负责人、sort + dir 排序。打开项目只改 project / tab，筛选保留。
// 数据只用 GET /api/admin/tprojects 已有的字段；开始 / 结束日期、当前期次、负责人姓名该接口暂未返回 ——
// 字段到位前（startAt / endAt / currentCohort / ownerName）列里显示「—」，负责人姓名先用人员名单按 ownerId 补。
const PJ_STATUSES = ['draft', 'planning', 'running', 'closing', 'closed'];
const PJ_ST_TONE = { '': 'pri', draft: 'muted', planning: 'warn', running: 'pri', closing: 'muted', closed: 'ok', all: 'muted' };
const PJ_SORTS = ['name', 'cat', 'cohorts', 'members', 'progress', 'start', 'owner'];
const PJ_NONE = '__none';
const pjDay = (v) => fmtDate(v);   // 一致性整改 3
const pjYear = (p) => (/^\d{4}/.test(pjDay(p.startAt)) ? pjDay(p.startAt).slice(0, 4) : '');

function ProjectList({ s, lang, loc, rows, canWrite, onOpen, onRemove }) {
  const [urlp, patchUrl] = useUrlState();
  const rosterQ = useAsync(() => api.get('/api/admin/roster').catch(() => []), []);
  const ownerName = useMemo(() => {
    const m = new Map();
    for (const r of rosterQ.data || NONE) m.set(r.id, r.name);
    return m;
  }, [rosterQ.data]);
  const ownerOf = (p) => p.ownerName || (p.ownerId ? ownerName.get(p.ownerId) : '') || '';
  const stLabel = (st) => s['st' + st.charAt(0).toUpperCase() + st.slice(1)] || st;

  const query = urlp.q || '';
  const fSt = urlp.st === 'all' || PJ_STATUSES.includes(urlp.st) ? urlp.st : '';
  const fCat = urlp.cat || '';
  const fYear = urlp.year || '';
  const fOwner = urlp.owner || '';
  const sortKey = PJ_SORTS.includes(urlp.sort) ? urlp.sort : '';
  const sortDir = urlp.dir === 'asc' ? 'asc' : 'desc';
  const setFilter = (k, v) => patchUrl({ [k]: v || null }, { push: false });
  const hasFilters = ['q', 'st', 'cat', 'year', 'owner'].some((k) => !!urlp[k]);
  const clearFilters = () => patchUrl({ q: null, st: null, cat: null, year: null, owner: null }, { push: false });

  // 状态计数不随其他筛选变（与课程库状态胶囊同一口径）
  const counts = useMemo(() => {
    const c = { '': 0, all: rows.length };
    for (const st of PJ_STATUSES) c[st] = 0;
    for (const p of rows) { c[p.status] = (c[p.status] || 0) + 1; if (p.status !== 'closed') c['']++; }
    return c;
  }, [rows]);
  const cats = useMemo(() => [...new Set(rows.map((p) => p.category).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), lang === 'zh' ? 'zh' : 'en')), [rows, lang]);
  const hasNoCat = rows.some((p) => !p.category);
  const years = useMemo(() => [...new Set(rows.map(pjYear).filter(Boolean))].sort().reverse(), [rows]);
  const owners = useMemo(() => {
    const m = new Map();
    for (const p of rows) if (p.ownerId && !m.has(p.ownerId)) m.set(p.ownerId, ownerOf(p) || p.ownerId);
    return [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), lang === 'zh' ? 'zh' : 'en'));
  }, [rows, ownerName, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((p) => {
      if (fSt === '' && p.status === 'closed') return false;
      if (fSt && fSt !== 'all' && p.status !== fSt) return false;
      if (fCat && (fCat === PJ_NONE ? !!p.category : p.category !== fCat)) return false;
      if (fYear && pjYear(p) !== fYear) return false;
      if (fOwner && p.ownerId !== fOwner) return false;
      if (!q) return true;
      return [p.title, p.title_zh, p.code].some((v) => v && String(v).toLowerCase().includes(q));
    });
    if (!sortKey) return out;
    const coll = lang === 'zh' ? 'zh' : 'en';
    const val = {
      name: (p) => loc(p, 'title') || '', cat: (p) => p.category || '', cohorts: (p) => p.cohortCount, members: (p) => p.memberCount,
      progress: (p) => p.progress, start: (p) => pjDay(p.startAt), owner: (p) => ownerOf(p),
    }[sortKey];
    const empty = (v) => v == null || v === '';
    // 空值（未开始、没有日期、没有类别）始终排在最后，不随升降序翻转
    return out.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (empty(x) || empty(y)) return empty(x) - empty(y);
      const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), coll);
      return sortDir === 'asc' ? d : -d;
    });
  }, [rows, query, fSt, fCat, fYear, fOwner, sortKey, sortDir, lang, ownerName]); // eslint-disable-line react-hooks/exhaustive-deps

  const sortOf = (k) => (sortKey === k ? (sortDir === 'asc' ? 'ascend' : 'descend') : false);
  const onTableChange = ({ sorter }) => {
    if (!sorter) return;
    const k = PJ_SORTS.includes(sorter.dataIndex) ? sorter.dataIndex : null;
    patchUrl(sorter.sortOrder && k ? { sort: k, dir: sorter.sortOrder === 'ascend' ? 'asc' : 'desc' } : { sort: null, dir: null }, { push: false });
  };
  const sortSel = sortKey ? `${sortKey}.${sortDir}` : '';
  const setSortSel = (v) => {
    const [k, d] = String(v || '').split('.');
    patchUrl(k ? { sort: k, dir: d } : { sort: null, dir: null }, { push: false });
  };

  const stTag = (p) => (
    <Tooltip content={s.stHelp[p.status]} position="topLeft">
      <span className="tp-st"><Tag color={STATUS_COLOR[p.status] || 'grey'} type="light" size="small">{stLabel(p.status)}</Tag></span>
    </Tooltip>
  );
  const progCell = (p) => (p.progress == null
    ? <span className="tp-prog-none">{s.notStarted}</span>
    : (
      <span className="tp-prog tp-prog-row">
        <Progress percent={p.progress} size="small" aria-label={`${p.progress}%`} />
        <span className="tnum tp-prog-n">{p.progress}%</span>
      </span>
    ));
  const datesText = (p) => (p.startAt || p.endAt ? `${pjDay(p.startAt) || '—'} – ${pjDay(p.endAt) || '—'}` : '');
  const cohortText = (p) => (p.currentCohort ? s.cohortsCur(p.cohortCount, p.currentCohort) : s.cohortsOnly(p.cohortCount));

  const columns = [
    {
      title: s.colProj, dataIndex: 'name', width: 250, className: 'tp-namecol', sorter: true, sortOrder: sortOf('name'),
      render: (_, p) => (
        <>
          <div className="co-row-title tp-namecell-wrap">
            <div className="tp-namecell">
              <button type="button" className="co-row-link tp-name" onClick={() => onOpen(p.id)}>{loc(p, 'title')}</button>
              {stTag(p)}
            </div>
            {p.code && <div className="co-row-alt tnum">{p.code}</div>}
          </div>
          {/* 390 宽的紧凑卡片（桌面隐藏）：名称 + 状态 / 编号 · 类别 / 期次 · 学员 · 完成度 / 日期 · 负责人 */}
          <div className="tp-mcard">
            <div className="tp-namecell">
              <button type="button" className="co-row-link tp-name" onClick={() => onOpen(p.id)}>{loc(p, 'title')}</button>
              {stTag(p)}
            </div>
            <div className="tp-mc-l">{[p.code, p.category && (categoryLabel(p.category, lang) || p.category)].filter(Boolean).join(' · ')}</div>{/* CX-073：手机卡片的类别也按语言显示 */}
            <div className="tp-mc-l">{[cohortText(p), s.membersN(p.memberCount), p.progress == null ? s.notStarted : `${s.colDone} ${p.progress}%`].join(' · ')}</div>
            {(datesText(p) || ownerOf(p)) && <div className="tp-mc-l">{[datesText(p), ownerOf(p)].filter(Boolean).join(' · ')}</div>}
          </div>
        </>
      ),
    },
    {
      title: s.colCat, dataIndex: 'cat', width: 100, sorter: true, sortOrder: sortOf('cat'),
      render: (_, p) => (p.category ? <span>{categoryLabel(p.category, lang) || p.category}</span> : <span className="co-row-muted">{s.lstCatNone}</span>),
    },
    {
      title: s.colCohorts, dataIndex: 'cohorts', width: 130, sorter: true, sortOrder: sortOf('cohorts'),
      render: (_, p) => <span className="tnum">{cohortText(p)}</span>,
    },
    {
      title: s.colMembers, dataIndex: 'members', width: 110, sorter: true, sortOrder: sortOf('members'),
      render: (_, p) => (
        <span className="tp-members">
          <span className="tnum">{p.memberCount}</span>
          {p.pendingNominations > 0 && <Tag color="red" type="light" size="small">{s.nomN(p.pendingNominations)}</Tag>}
        </span>
      ),
    },
    {
      title: s.colDone, dataIndex: 'progress', width: 160, sorter: true, sortOrder: sortOf('progress'),
      render: (_, p) => progCell(p),
    },
    {
      title: s.colDates, dataIndex: 'start', width: 180, sorter: true, sortOrder: sortOf('start'),
      // G1（2026-10-09）：开始在上、结束在下，各自不断开（原来一行放不下，结束日期被折断成「2026-10-」+「05」）
      render: (_, p) => (datesText(p)
        ? <span className="tp-dates tnum"><span>{pjDay(p.startAt) || '—'}</span><span>{pjDay(p.endAt) || '—'}</span></span>
        : <span className="co-row-muted">—</span>),
    },
    {
      title: s.colOwner, dataIndex: 'owner', width: 100, sorter: true, sortOrder: sortOf('owner'),
      render: (_, p) => (ownerOf(p) ? <span>{ownerOf(p)}</span> : <span className="co-row-muted">—</span>),
    },
    {
      title: s.colOps, dataIndex: 'op', width: 110, fixed: 'right', className: 'co-opcol tp-opcol',
      render: (_, p) => (
        <span className="co-row-acts">
          <Button theme="light" size="small" onClick={() => onOpen(p.id)}>{s.lstManage}</Button>
          {/* 已有学员的项目只能关闭、不能删除（服务端同样拒绝），按钮只在仍可删除时出现 */}
          {canWrite && p.memberCount === 0 && (
            <Popconfirm title={s.delProj} content={s.delProjAsk} okType="danger"
              okText={s.delProj} cancelText={s.cancel} onConfirm={() => onRemove(p)}>
              <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} aria-label={s.delProj} title={s.delProj} />
            </Popconfirm>
          )}
        </span>
      ),
    },
  ];

  const chips = [['', s.lstStOpen], ...PJ_STATUSES.map((st) => [st, stLabel(st)]), ['all', s.lstStAll]];
  return (
    <>
      <div className="co-filters co-filters-b3 tp-filters">
        <Input prefix={<IconSearch />} placeholder={s.lstSearchPh} value={query} onChange={(v) => setFilter('q', v)}
          showClear className="co-search" aria-label={s.lstSearchPh} />
        <div className="co-chips" role="group" aria-label={s.fStatus}>
          {chips.map(([val, label]) => (
            <button key={val || 'open'} type="button" aria-pressed={fSt === val}
              className={'pill ' + PJ_ST_TONE[val] + ' co-chip' + (fSt === val ? ' on' : '')}
              onClick={() => setFilter('st', val)}>
              {label} <b className="tnum">{counts[val] || 0}</b>
            </button>
          ))}
        </div>
        <div className="co-fsel">
          <Select className="tf-select" aria-label={s.colCat} value={fCat} onChange={(v) => setFilter('cat', v)}
            optionList={[{ value: '', label: s.lstCatAll }, ...cats.map((c) => ({ value: c, label: c })), ...(hasNoCat ? [{ value: PJ_NONE, label: s.lstCatNone }] : [])]} />
          <Select className="tf-select" aria-label={s.lstYear} value={fYear} onChange={(v) => setFilter('year', v)} disabled={!years.length && !fYear}
            optionList={[{ value: '', label: years.length ? s.lstYearAll : s.lstYearNone }, ...years.map((y) => ({ value: y, label: s.lstYearN(y) }))]} />
          <Select className="tf-select" aria-label={s.colOwner} value={fOwner} onChange={(v) => setFilter('owner', v)} filter
            optionList={[{ value: '', label: s.lstOwnerAll }, ...owners.map(([id, name]) => ({ value: id, label: name }))]} />
          <Select className="tf-select" aria-label={s.lstSort} value={sortSel} onChange={setSortSel}
            optionList={[
              { value: '', label: s.lstSortDefault },
              { value: 'start.desc', label: s.lstSortStartDesc }, { value: 'start.asc', label: s.lstSortStartAsc },
              { value: 'progress.desc', label: s.lstSortDoneDesc }, { value: 'progress.asc', label: s.lstSortDoneAsc },
              { value: 'members.desc', label: s.lstSortMembersDesc }, { value: 'members.asc', label: s.lstSortMembersAsc },
              ...(sortKey && !['start', 'progress', 'members'].includes(sortKey) ? [{ value: sortSel, label: s.lstSortByCol }] : []),
            ]} />
          {hasFilters && <Button theme="borderless" className="co-fclear" onClick={clearFilters}>{s.lstClear}</Button>}
          <span className="u-count tp-count">{s.lstTotal(visible.length)}</span>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="card co-nocourse co-nocard">
          {s.lstEmptyFiltered}
          {hasFilters && <div style={{ marginTop: 10 }}><Button theme="light" onClick={clearFilters}>{s.lstClear}</Button></div>}
        </div>
      ) : (
        <div className="co-ctable tp-ctable">
          <Table rowKey="id" dataSource={visible} onChange={onTableChange}
            {...resizableTable(dataTableColumns(columns, { titleKey: 'name', opsKey: 'op' }))}
            pagination={visible.length > DEFAULT_PAGE ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: () => s.lstTotal(visible.length) } : false} />
        </div>
      )}
    </>
  );
}

function NewProjectButton({ s, onCreated }) {
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  // Semi hands out the form api once, at Form mount — a plain local variable
  // is wiped by any re-render, leaving Save clicking into null. Keep it in a ref.
  const formApi = useRef(null);
  const submit = () => formApi.current && formApi.current.validate().then(async (v) => {
    // Chinese-first: the English name falls back to the Chinese one.
    if (!v.title && !v.title_zh) { Toast.warning(s.reqTitle); return; }
    setSaving(true);
    try {
      const r = await api.post('/api/admin/tprojects', { ...v, title: v.title || v.title_zh });
      Toast.success(s.created);
      setVisible(false);
      onCreated(r.id);
    } catch (e) { Toast.error(e.message); } finally { setSaving(false); }
  }).catch(() => {});
  return (
    <>
      <Button theme="solid" type="primary" icon={<IconPlus />} onClick={() => setVisible(true)}>{s.newProject.replace('+ ', '')}</Button>
      <Modal title={s.cTitle} visible={visible} onCancel={() => setVisible(false)} onOk={submit} confirmLoading={saving} okText={s.save} cancelText={s.cancel} maskClosable={false}>
        <Form getFormApi={(a) => { formApi.current = a; }} labelPosition="top">
          <Form.Input field="title_zh" label={s.fTitleZh} />
          <Form.Input field="title" label={s.fTitleEn} />
          <Form.Input field="category" label={s.fCategory} />
          <Form.Input field="sponsor" label={s.fSponsor} />
        </Form>
      </Modal>
    </>
  );
}

// ================= project detail =================
const TAB_KEYS = ['dash', 'struct', 'cohort', 'nom', 'set'];

function Detail({ id, s, lang, loc, onBack, onGone }) {
  const q = useAsync(() => api.get(`/api/admin/tprojects/${id}`), [id]);
  const catQ = useAsync(() => api.get('/api/admin/catalog'), []);
  const examsQ = useAsync(() => api.get('/api/admin/exams'), []);
  const empQ = useAsync(() => api.get('/api/admin/roster'), []); // light people list
  // Owned here, not inside NomTab: the tab label carries the pending count, so
  // it has to be known before that tab is ever opened.
  const nomQ = useAsync(() => api.get(`/api/admin/tprojects/${id}/nominations`), [id]);
  // 页签来自地址栏 ?tab=（缺省 / 不认识的值 = 看板）。部门筛选 ?dept= 只用于「期次与成员」，切到别的页签时一并清掉。
  const [urlp, patchUrl] = useUrlState();
  const tab = TAB_KEYS.includes(urlp.tab) ? urlp.tab : 'dash';
  const setTab = (k) => patchUrl({ tab: k === 'dash' ? null : k, ...(k === 'cohort' ? {} : { dept: null }) });
  // 通知直达 ?project=<本项目>&tab=nom 时 Detail 不重挂（key 仍是项目 id）：每次进入申请页签、或停在该页签时地址栏
  // 又被导航一次（location.key 变），都重取申请名单，页签上的待审人数一并刷新。首次挂载由 useAsync 自己取，跳过。
  const locKey = useLocation().key;
  const nomFirst = useRef(true);
  useEffect(() => {
    if (nomFirst.current) { nomFirst.current = false; return; }
    if (tab === 'nom') nomQ.reload();
  }, [tab, locKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (q.error && q.error.status === 404 && !q.data && onGone) onGone();
  }, [q.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const canWrite = useCanWrite();
  // One-shot shortcut from the action bar, consumed by the tab that owns it.
  const [intent, setIntent] = useState(null); // 'import' | 'checkin'
  const clearIntent = () => setIntent(null);
  const doc = q.data;

  const saveDoc = async (patch, okMsg) => {
    try {
      await api.put(`/api/admin/tprojects/${id}`, patch);
      Toast.success(okMsg || s.saved);
      q.reload();
    } catch (e) {
      // Closed projects are read-only records; bad dates are refused. Both come
      // back as 409/400 with a code — explain rather than echo the raw message.
      const code = e && e.data && e.data.code;
      // 服务端的校验错误（日期格式、活动类型锁定、线上活动链接/完成方式等）带 error_zh：中文界面优先显示中文
      const msg = (lang === 'zh' && e && e.data && e.data.error_zh) || e.message;
      if (code === 'closed') Toast.warning({ content: s.closedLocked, duration: 5 });
      else if (code === 'bad_dates') Toast.error({ content: msg, duration: 4 });
      else Toast.error(msg);
    }
  };

  // Spinner only until the FIRST load. A refetch (after a save, or after roll-call
  // changes) keeps the page mounted with the previous doc until the new one lands
  // — otherwise every reload blanked the page and reset the tab's own state
  // (selected cohort, scroll).
  if (!doc) return <div className="wrap emp-wrap" style={{ padding: 60, textAlign: 'center' }}>{q.error ? `${s.loadFail}` : <Spin />}</div>;

  const stLabel = (st) => s['st' + st.charAt(0).toUpperCase() + st.slice(1)] || st;
  const pendingNoms = (nomQ.data || []).length;
  const tabs = [
    ['dash', s.tabDash],
    ['struct', s.tabStruct], ['cohort', s.tabCohort],
    ['nom', pendingNoms ? `${s.tabNom} ${pendingNoms}` : s.tabNom],
    ['set', s.tabSet],
  ];

  return (
    <div className="wrap emp-wrap">
      <a style={{ fontSize: 13, color: 'var(--semi-color-primary)', cursor: 'pointer' }} onClick={onBack}>{s.back}</a>
      <div className="emp-head" style={{ marginTop: 8 }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <Tooltip content={s.stHelp[doc.status]} position="bottomLeft"><span className="tp-st" style={{ display: 'inline-flex', cursor: 'help' }}><Tag color={STATUS_COLOR[doc.status]} type="light" shape="circle">{stLabel(doc.status)}</Tag></span></Tooltip>
            {doc.category && <Tag type="light" shape="circle">{categoryLabel(doc.category, lang)}</Tag>}
            <Text type="tertiary" className="tnum">{doc.code}</Text>
          </div>
          <h1 className="emp-title">{loc(doc, 'title')}</h1>
          {!canWrite && <div className="emp-lead" style={{ color: 'var(--semi-color-text-2)' }}>{s.roWrite}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '2px 0 14px' }}>
        <Button theme="light" onClick={() => setTab('struct')}>{s.actPhases}</Button>
        {/* 批量导入学员 = POST tprojects/:id/members(写);生成签到码只发 GET,留给只读档。 */}
        {canWrite && <Button theme="light" onClick={() => { setTab('cohort'); setIntent('import'); }}>{s.actImport}</Button>}
        <Button theme="light" onClick={() => { setTab('struct'); setIntent('checkin'); }}>{s.actCode}</Button>
      </div>
      <div className="ptabs" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--semi-color-border)', marginBottom: 18 }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ background: 'none', border: 'none', padding: '10px 14px', fontSize: 14, cursor: 'pointer', color: tab === k ? 'var(--semi-color-primary)' : 'var(--semi-color-text-1)', borderBottom: tab === k ? '2.5px solid var(--semi-color-primary)' : '2.5px solid transparent', fontWeight: tab === k ? 600 : 400 }}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'struct' && <StructTab doc={doc} s={s} lang={lang} loc={loc} saveDoc={saveDoc} catalog={catQ.data} exams={examsQ.data || []} actStats={doc.actStats || {}} projectId={id} roster={empQ.data || []} intent={intent} clearIntent={clearIntent} reload={() => q.reload()} />}
      {tab === 'cohort' && <CohortTab doc={doc} s={s} lang={lang} loc={loc} saveDoc={saveDoc} roster={empQ.data || []} projectId={id} reload={() => q.reload()} intent={intent} clearIntent={clearIntent} />}
      {tab === 'nom' && <NomTab doc={doc} s={s} loc={loc} projectId={id} nomQ={nomQ} reload={() => q.reload()} />}
      {tab === 'dash' && <DashTab s={s} loc={loc} projectId={id} doc={doc} />}
      {tab === 'set' && <SetTab doc={doc} s={s} saveDoc={saveDoc} stLabel={stLabel} />}
    </div>
  );
}

// ---------- 阶段与活动 ----------
function StructTab({ doc, s, lang, loc, saveDoc, catalog, exams, actStats, projectId, roster, intent, clearIntent, reload }) {
  const cohorts = doc.cohorts || [];
  // 目录放在最前：下面的 hasCheckin、活动行与弹窗都要按课程的 mode 判定线上 / 线下课程
  const programs = (catalog && catalog.programs) || [];
  const courses = (catalog && catalog.courses) || [];
  // 课程目录未加载完时判不出课程活动的类别（会被当成「引用失效」）：先不开放新增与编辑
  const catalogReady = !!catalog;
  // CX-198：默认期次与项目看板同口径（今天所在期次 → 最近已开始的一期 → 第一期）
  const [cohortId, setCohortId] = useState(() => dashDefaultCohort(cohorts));
  const cohort = cohorts.find((c) => c.id === cohortId) || cohorts[0] || null;
  const [actModal, setActModal] = useState(null); // { phaseId }
  const [phaseModal, setPhaseModal] = useState(false);
  const nav = useNavigate();
  // 有签到的活动：线下活动，以及引用线下课程的课程活动（负责人 2026-10-06：两者都要签到码；后者的签到记在课程出勤上）。
  // 线上活动没有签到码，走「完成登记」。
  const hasCheckin = (a) => ['offline_activity', 'offline_course'].includes(kindOf(a, courses));
  // 「引用 某课程/考试」点击跳到对应页面并直接打开（课程库读 ?course=，考试页读 ?edit=）；旧学习包没有单独的页面，保持纯文字
  const refPath = (a) => (a.type === 'course' && a.refId ? `/admin/content?course=${encodeURIComponent(a.refId)}`
    : a.type === 'exam' && a.refId ? `/admin/exams?edit=${encodeURIComponent(a.refId)}` : null);
  const [ckAct, setCkAct] = useState(null);
  // 线上活动的完成登记弹窗；与其他 hook 一样必须在下面 `if (!cohort) return` 之前声明
  const [cpAct, setCpAct] = useState(null);
  const canWrite = useCanWrite();

  const mutateCohort = (fn, okMsg) => {
    const next = cohorts.map((c) => (c.id === cohort.id ? fn(structuredClone(c)) : c));
    return saveDoc({ cohorts: next }, okMsg);
  };

  // 生成签到码 from the action bar: jump straight to the first offline session
  // of this cohort instead of hunting for it in the phase list.
  useEffect(() => {
    if (intent !== 'checkin') return;
    clearIntent();
    const act = ((cohort && cohort.phases) || []).flatMap((p) => p.activities || []).find(hasCheckin);
    if (act) setCkAct(act); else Toast.info(s.noOffline);
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cohort) return <Empty description={s.dashEmpty} style={{ padding: '48px 0' }} />;

  return (
    <div>
      {cohorts.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <Select value={cohort.id} onChange={setCohortId} optionList={cohorts.map((c) => ({ label: s.cohortLabel(c.name), value: c.id }))} />
        </div>
      )}
      {(cohort.phases || []).length > 1 && (
        <div className="tp-fieldhelp" style={{ marginBottom: 10 }}>{s.orderHint}</div>
      )}
      {(cohort.phases || []).map((ph, pi, allPhases) => (
        <div key={ph.id} className="tp-phase">
          <div className="tp-ph">
            <span className="tp-no">{pi + 1}</span>
            <b style={{ flex: 1 }}>{loc(ph, 'name')}</b>
            <Text type="tertiary" size="small">
              {ph.gateMode === 'time' ? s.gateTextTime(ph.startAt) : s.gate}
            </Text>
            {/* Order matters: with completion gating, phase N unlocks only
                after N-1 is done — so HR must be able to resequence.
                只读档(learning=read)整组收起:这几个按钮都打 PUT /api/admin/tprojects/:id。 */}
            {canWrite && (<>
            <Tooltip content={s.moveUp}>
              <Button theme="borderless" size="small" icon={<IconArrowUp />} aria-label={s.moveUp}
                disabled={pi === 0}
                onClick={() => mutateCohort((c) => { c.phases = swap(c.phases, pi, pi - 1); return c; }, s.reordered)} />
            </Tooltip>
            <Tooltip content={s.moveDown}>
              <Button theme="borderless" size="small" icon={<IconArrowDown />} aria-label={s.moveDown}
                disabled={pi === allPhases.length - 1}
                onClick={() => mutateCohort((c) => { c.phases = swap(c.phases, pi, pi + 1); return c; }, s.reordered)} />
            </Tooltip>
            <Button theme="borderless" size="small" onClick={() => setPhaseModal(ph)}>{s.editPhase}</Button>
            <Popconfirm title={s.delPhaseAsk} okType="danger" onConfirm={() => mutateCohort((c) => { c.phases = c.phases.filter((x) => x.id !== ph.id); return c; })}>
              <Button theme="borderless" type="danger" size="small" icon={<IconDelete />} />
            </Popconfirm>
            </>)}
          </div>
          {(ph.activities || []).map((a, ai, allActs) => {
            const st = actStats[a.id];
            const kind = kindOf(a, courses);
            const kindLabel = s.actTypeLabel[kind];
            const canEdit = canWrite && catalogReady;
            const refTitle = a.type === 'program' ? loc(programs.find((p) => p.id === a.refId) || {}, 'title')
              : a.type === 'course' ? loc(courses.find((c) => c.id === a.refId) || {}, 'title')
              : a.type === 'exam' ? loc(exams.find((e) => e.id === a.refId) || {}, 'title') : null;
            return (
              <div key={a.id} className="tp-act" style={st && st.broken ? { background: 'var(--semi-color-danger-light-default)' } : undefined}>
                <span className={'tp-ic' + (st && st.broken ? ' tp-ic-broken' : '')} role="img" title={kindLabel} aria-label={kindLabel || a.type}>{st && st.broken ? IC_WARN : TYPE_IC[kind] || IC_OTHER}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                    {/* Name doubles as the edit entry point (same as the pencil). */}
                    <span style={canEdit ? { cursor: 'pointer' } : undefined} title={canEdit ? s.editAct : undefined}
                      onClick={canEdit ? () => setActModal({ phaseId: ph.id, act: a }) : undefined}>
                      {loc(a, 'title') || refTitle || kindLabel || a.type}
                    </span>
                    {st && st.broken && <Tag color="red" type="light" size="small" style={{ marginLeft: 8 }}>{s.brokenTag}</Tag>}
                    {kindLabel && <Tag color="grey" type="light" size="small" style={{ marginLeft: 8 }}>{kindLabel}</Tag>}
                    {a.required !== false
                      ? <Tag color="red" type="light" size="small" style={{ marginLeft: 8 }}>{s.aReqd}</Tag>
                      : <Tag type="light" size="small" style={{ marginLeft: 8 }}>{s.aOpt}</Tag>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--semi-color-text-2)' }}>
                    {st && st.broken && <Text type="danger">{s.brokenHint}　</Text>}
                    {/* 「A · B」拼接（第三批 10.5）：空项不留分隔点 —— 先收集非空项，再在项与项之间加「 · 」 */}
                    {[
                      refTitle ? <>{s.aRefTo} {refPath(a)
                        ? <Text link title={s.openRef} onClick={() => nav(refPath(a))}>{refTitle}</Text>
                        : <Text>{refTitle}</Text>}</> : null,
                      ...(kind === 'online_activity' ? [
                        /* 线上活动：链接（只显示域名）· 开始时间 · 时长 · 完成方式 · 截止 */
                        SAFE_URL.test(a.url || '') ? <Text link={{ href: a.url, target: '_blank', rel: 'noopener noreferrer' }}>{hostOf(a.url)}</Text> : null,
                        a.startAt ? a.startAt.replace('T', ' ') : null,
                        a.durationMin > 0 ? s.durationText(a.durationMin) : null,
                        ({ click: s.cmClick, self: s.cmSelf, trainer: s.cmTrainer })[a.completion || 'self'] || s.cmSelf,
                        a.dueAt ? `${s.aDue} ${a.dueAt}` : null,
                      ] : [
                        a.startAt ? a.startAt.replace('T', ' ') : null,
                        a.location || null,
                        a.dueAt ? `${s.aDue} ${a.dueAt}` : null,
                      ]),
                      st ? <span className="tnum">{s.doneOf(st.done, st.total)}</span> : null,
                    ].filter(Boolean).map((x, i) => <span key={i}>{i ? ' · ' : ''}{x}</span>)}
                  </div>
                </div>
                {hasCheckin(a) && <Button size="small" theme="solid" onClick={() => setCkAct(a)}>{s.checkin}</Button>}
                {/* 只读档也能打开名单查看；补登记 / 撤销按钮在弹窗里按写权限收起 */}
                {kind === 'online_activity' && <Button size="small" theme="solid" onClick={() => setCpAct(a)}>{s.cpBtn}</Button>}
                {canWrite && (<>
                <Tooltip content={s.editAct}>
                  <Button theme="borderless" size="small" icon={<IconEdit />} aria-label={s.editAct} disabled={!catalogReady}
                    onClick={() => setActModal({ phaseId: ph.id, act: a })} />
                </Tooltip>
                <Tooltip content={s.moveUp}>
                  <Button theme="borderless" size="small" icon={<IconArrowUp />} aria-label={s.moveUp}
                    disabled={ai === 0}
                    onClick={() => mutateCohort((c) => { const p = c.phases.find((x) => x.id === ph.id); p.activities = swap(p.activities, ai, ai - 1); return c; }, s.reordered)} />
                </Tooltip>
                <Tooltip content={s.moveDown}>
                  <Button theme="borderless" size="small" icon={<IconArrowDown />} aria-label={s.moveDown}
                    disabled={ai === allActs.length - 1}
                    onClick={() => mutateCohort((c) => { const p = c.phases.find((x) => x.id === ph.id); p.activities = swap(p.activities, ai, ai + 1); return c; }, s.reordered)} />
                </Tooltip>
                <Popconfirm title={s.delActAsk} okType="danger" onConfirm={() => mutateCohort((c) => { for (const p of c.phases) p.activities = (p.activities || []).filter((x) => x.id !== a.id); return c; })}>
                  <Button theme="borderless" type="danger" size="small" icon={<IconDelete />} />
                </Popconfirm>
                </>)}
              </div>
            );
          })}
          {canWrite && (
            <div style={{ padding: '8px 14px' }}>
              <Button theme="borderless" size="small" icon={<IconPlus />} disabled={!catalogReady} onClick={() => setActModal({ phaseId: ph.id })}>{s.addActivity.replace('+ ', '')}</Button>
            </div>
          )}
        </div>
      ))}
      {(cohort.phases || []).length === 0 && <Empty description={s.noPhases} style={{ padding: '32px 0' }} />}
      {canWrite && <Button icon={<IconPlus />} theme="light" onClick={() => setPhaseModal(true)}>{s.addPhase.replace('+ ', '')}</Button>}

      {phaseModal && (
        <QuickForm
          title={phaseModal === true ? s.addPhase.replace('+ ', '') : (phaseModal.id ? s.editPhase : s.addPhase.replace('+ ', ''))} s={s}
          init={phaseModal.id ? { name_zh: phaseModal.name_zh, name: phaseModal.name, gateMode: phaseModal.gateMode || 'completion', startAt: phaseModal.startAt, endAt: phaseModal.endAt } : { gateMode: 'completion' }}
          fields={[
            { f: 'name_zh', label: s.phaseName },
            { f: 'name', label: s.phaseNameEn },
            { f: 'gateMode', label: s.phGate, type: 'select', opts: [{ label: s.gateCompletion, value: 'completion' }, { label: s.gateTime, value: 'time' }], help: s.gateHelp },
            { f: 'startAt', label: s.phStart, type: 'date' },
            { f: 'endAt', label: s.phEnd, type: 'date' },
          ]}
          onCancel={() => setPhaseModal(false)}
          onOk={(v) => {
            // At least one name; English falls back to Chinese (zh-first HR).
            if (!v.name && !v.name_zh) { Toast.warning(s.reqTitle); return; }
            const patch = { name: v.name || v.name_zh, name_zh: v.name_zh || null, gateMode: v.gateMode || 'completion', startAt: v.startAt ? fmtD(v.startAt) : null, endAt: v.endAt ? fmtD(v.endAt) : null };
            const editingId = phaseModal.id || null;
            setPhaseModal(false);
            mutateCohort((c) => {
              if (editingId) c.phases = (c.phases || []).map((x) => (x.id === editingId ? { ...x, ...patch } : x));
              else (c.phases = c.phases || []).push({ id: genId('ph'), activities: [], ...patch });
              return c;
            });
          }}
        />
      )}
      {actModal && (
        <ActivityModal s={s} loc={loc} programs={programs} courses={courses} exams={exams} roster={roster} editing={actModal.act || null}
          onCancel={() => setActModal(null)}
          onOk={(act) => {
            const pid = actModal.phaseId; const orig = actModal.act; setActModal(null);
            mutateCohort((c) => {
              const ph = c.phases.find((x) => x.id === pid);
              // Edit = replace in place, keeping id (attendance/progress key) and
              // any fields this form doesn't cover. 新建时 act.type 已由 STORED_TYPE 换回存储类型。
              if (orig) ph.activities = (ph.activities || []).map((x) => (x.id === orig.id ? { ...x, ...act, id: x.id, type: x.type } : x));
              else (ph.activities = ph.activities || []).push(act);
              return c;
            }, orig ? s.saved : undefined);
          }}
        />
      )}
      {/* Refresh actStats ("x/N 完成") on close: marks made here, and learners
          checking in with the code while it was open, both change the counts. */}
      {ckAct && <CheckinModal s={s} lang={lang} loc={loc} roster={roster} projectId={projectId} act={ckAct} title={loc(ckAct, 'title') || loc(courses.find((c) => c.id === ckAct.refId) || {}, 'title')} onClose={() => { setCkAct(null); if (reload) reload(); }} />}
      {cpAct && <CompletionModal s={s} lang={lang} loc={loc} roster={roster} projectId={projectId} act={cpAct} onClose={() => { setCpAct(null); if (reload) reload(); }} />}
    </div>
  );
}

function QuickForm({ title, fields, onOk, onCancel, s, init }) {
  const formApi = useRef(null); // ref, not a local — see NewProjectButton
  return (
    <Modal title={title} visible onCancel={onCancel} okText={s.save} cancelText={s.cancel} maskClosable={false}
      onOk={() => formApi.current && formApi.current.validate().then((v) => onOk(v)).catch(() => {})}>
      <Form getFormApi={(a) => { formApi.current = a; }} labelPosition="top" initValues={init || {}}>
        {fields.map((f) => (
          <div key={f.f}>
            {f.type === 'date'
              ? <Form.DatePicker field={f.f} label={f.label} style={{ width: '100%' }} />
              : f.type === 'switch'
                ? <Form.Switch field={f.f} label={f.label} />
                : f.type === 'number'
                  ? <Form.InputNumber field={f.f} label={f.label} style={{ width: '100%' }} />
                  : f.type === 'select'
                    ? <Form.Select field={f.f} label={f.label} style={{ width: '100%' }} optionList={f.opts || []} />
                    : <Form.Input field={f.f} label={f.label} rules={f.required ? [{ required: true, message: f.label }] : undefined} />}
            {/* Inline plain-language help — e.g. what the two gate modes do. */}
            {f.help && (
              <div className="tp-fieldhelp">
                {f.help.map((line, i) => <div key={i}>· {line}</div>)}
              </div>
            )}
          </div>
        ))}
      </Form>
    </Modal>
  );
}

function ActivityModal({ s, loc, programs, courses, exams, roster, editing, onOk, onCancel }) {
  // 五类活动（负责人 2026-10-06 拍板），下拉按这个顺序：
  //   线上课程 / 线下课程 —— 引用课程库（存 type 'course'；可选的课程按 mode 过滤，避免选了线下课程却当线上课程）；
  //   线上活动 —— 项目内创建（type 'online'：名称、链接、开始时间、时长、完成方式）；
  //   线下活动 —— 项目内创建（type 'offline'，签到）；结业考试 —— 引用考试（type 'exam'）。
  // 旧学习包（type 'program'）和引用失效的课程（类别 'course'）只在编辑时出现，不能新建。
  // `editing` = an existing activity: same form, prefilled; its type is locked
  // because learner progress / attendance is keyed to the activity as-is.
  // 线上活动的完成方式同样锁定：学员已有的完成记录是按原方式产生的（服务端也拒绝改，completion_locked）。
  const [kind, setKind] = useState(editing ? kindOf(editing, courses) : 'online_course');
  const [completion, setCompletion] = useState(editing ? (editing.completion || 'self') : 'self');
  const isRef = ['online_course', 'offline_course', 'course', 'exam', 'program'].includes(kind);
  // MUST be a ref: picking an activity type re-renders this component, and a
  // plain `let formApi` would be null afterwards — Save would silently no-op
  // (the exact "点保存没反应" Chelsea hit on offline activities).
  const formApi = useRef(null);
  const KIND_LABEL = { online_course: s.aCourseOnline, offline_course: s.aCourseOffline, online_activity: s.aOnline, offline_activity: s.aOffline, exam: s.aExam, program: s.aProgram, course: s.aCourse };
  const courseOpt = (c) => ({ label: loc(c, 'title'), value: c.id });
  const refOpts = kind === 'online_course' ? courses.filter((c) => (c.mode || 'online') !== 'offline').map(courseOpt)
    : kind === 'offline_course' ? courses.filter((c) => c.mode === 'offline').map(courseOpt)
    : kind === 'course' ? courses.map(courseOpt)
    : kind === 'exam' ? exams.map((e) => ({ label: loc(e, 'title'), value: e.id }))
    : kind === 'program' ? programs.map((p) => ({ label: loc(p, 'title'), value: p.id })) : [];
  const typeOpts = KINDS.map((k) => ({ label: KIND_LABEL[k], value: k }));
  if (editing && (kind === 'program' || kind === 'course')) typeOpts.push({ label: KIND_LABEL[kind], value: kind });
  const trainerOpts = (roster || []).filter((r) => r.active).map((r) => ({ label: `${r.name}（${r.employeeId}）${r.role === 'admin' ? ' · ' + s.adminTag : ''}`, value: r.id }));
  const init = editing ? {
    type: kind, required: editing.required !== false,
    refId: editing.refId, dueAt: editing.dueAt ? parseD(editing.dueAt) : undefined,
    title_zh: editing.title_zh || undefined, title: editing.title || undefined,
    startAt: editing.startAt ? parseDT(editing.startAt) : undefined,
    location: editing.location || undefined, trainerId: editing.trainerId || undefined,
    url: editing.url || undefined, durationMin: editing.durationMin || undefined, completion: editing.completion || 'self',
  } : { type: 'online_course', required: true, completion: 'self' };
  // 换类别时清掉已选的引用对象：原先换类型后 refId 仍留着上一类的值（课程 id 被当成考试 id 提交）。
  // 完成方式回到默认，与重新出现的「完成方式」下拉保持一致。类型下拉只在新建时可改，所以不影响编辑。
  const onKind = (v) => {
    setKind(v);
    setCompletion('self');
    if (formApi.current) { formApi.current.setValue('refId', undefined); formApi.current.setValue('completion', 'self'); }
  };
  return (
    <Modal title={editing ? s.editAct : s.addActivity.replace('+ ', '')} visible onCancel={onCancel} okText={s.save} cancelText={s.cancel} maskClosable={false} width={520}
      onOk={() => formApi.current && formApi.current.validate().then((v) => {
        const act = { id: editing ? editing.id : genId('act'), type: STORED_TYPE[kind] || kind, required: v.required !== false };
        if (kind === 'offline_activity') {
          if (!v.title && !v.title_zh) { Toast.warning(s.reqTitle); return; }
          // An offline session is a point-in-time event — startAt (with hh:mm)
          // is its only date; no separate "due date" at a different granularity.
          // trainerId = the 讲师 who delivers it (gets the roll-call workbench).
          Object.assign(act, { title: v.title || v.title_zh, title_zh: v.title_zh || null, startAt: v.startAt ? fmtDT(v.startAt) : null, location: v.location || null, dueAt: null, trainerId: v.trainerId || null });
        } else if (kind === 'online_activity') {
          const tZh = String(v.title_zh || '').trim(), tEn = String(v.title || '').trim();
          if (!tEn && !tZh) { Toast.warning(s.reqTitle); return; }
          const url = String(v.url || '').trim();
          if (url && (url.length > 2000 || !SAFE_URL.test(url))) { Toast.warning(s.aUrlBad); return; }
          const mode = editing ? (editing.completion || 'self') : (v.completion || 'self');
          if (!url && mode === 'click') { Toast.warning(s.aUrlReq); return; }
          const dur = Number(v.durationMin);
          // 线上活动没有地点；讲师只在「讲师或 HR 登记」方式下有意义（其他方式下服务端也会清空）
          Object.assign(act, {
            title: tEn || tZh, title_zh: tZh || null, url: url || null,
            startAt: v.startAt ? fmtDT(v.startAt) : null,
            durationMin: dur > 0 ? Math.round(dur) : null,
            completion: mode, trainerId: mode === 'trainer' ? (v.trainerId || null) : null,
            dueAt: v.dueAt ? fmtD(v.dueAt) : null,
          });
        } else Object.assign(act, { refId: v.refId, dueAt: v.dueAt ? fmtD(v.dueAt) : null });
        onOk(act);
      }).catch(() => {})}>
      <Form getFormApi={(a) => { formApi.current = a; }} labelPosition="top" initValues={init}>
        <Form.Select field="type" label={s.aType} style={{ width: '100%' }} onChange={onKind} disabled={!!editing}
          extraText={editing ? s.aTypeLocked : undefined} optionList={typeOpts} />
        {isRef && <Form.Select field="refId" label={s.aRef} style={{ width: '100%' }} filter optionList={refOpts} rules={[{ required: true, message: s.reqRef }]}
          emptyContent={refOpts.length ? undefined : kind === 'online_course' ? s.noOnlineCourse : kind === 'offline_course' ? s.noOfflineCourse : undefined} />}
        {kind === 'offline_activity' && (<>
          <Form.Input field="title_zh" label={s.aTitleZh} />
          <Form.Input field="title" label={s.aTitleEn} />
          {/* `format` lets a hand-typed time parse instead of being dropped. */}
          <Form.DatePicker field="startAt" type="dateTime" label={s.aStart} format="yyyy-MM-dd HH:mm" placeholder="2026-08-05 14:00" style={{ width: '100%' }} />
          <Form.Input field="location" label={s.aLoc} />
          <Form.Select field="trainerId" label={s.aTrainer} extraText={s.aTrainerHint} filter showClear style={{ width: '100%' }}
            optionList={trainerOpts} />
        </>)}
        {kind === 'online_activity' && (<>
          <Form.Input field="title_zh" label={s.aTitleZh} />
          <Form.Input field="title" label={s.aTitleEn} />
          <Form.Input field="url" label={s.aUrl} placeholder="https://" />
          <Form.DatePicker field="startAt" type="dateTime" label={s.aOnStart} format="yyyy-MM-dd HH:mm" placeholder="2026-08-05 14:00" style={{ width: '100%' }} />
          <Form.InputNumber field="durationMin" label={s.aDuration} min={1} max={1440} step={15} style={{ width: '100%' }} />
          <Form.Select field="completion" label={s.aCompletion} style={{ width: '100%' }} onChange={setCompletion} disabled={!!editing}
            extraText={editing ? s.aCompletionLocked : undefined}
            optionList={[{ label: s.cmClick, value: 'click' }, { label: s.cmSelf, value: 'self' }, { label: s.cmTrainer, value: 'trainer' }]} />
          <div className="tp-fieldhelp">
            {s.cmHelp.map((line, i) => <div key={i}>· {line}</div>)}
          </div>
          {completion === 'trainer' && (
            <Form.Select field="trainerId" label={s.aTrainer} extraText={s.aTrainerOnlineHint} filter showClear style={{ width: '100%' }}
              optionList={trainerOpts} />
          )}
          <Form.DatePicker field="dueAt" label={s.aDueOnline} style={{ width: '100%' }} />
        </>)}
        {isRef && <Form.DatePicker field="dueAt" label={s.aDue} style={{ width: '100%' }} />}
        <Form.Switch field="required" label={s.aReqd} />
      </Form>
    </Modal>
  );
}
const fmtD = (d) => fmtDate(new Date(d));
const fmtDT = (d) => { const x = new Date(d); return fmtD(x) + 'T' + String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
// Inverses for prefilling an edit form. Parse as LOCAL time explicitly:
// new Date('2026-08-05') is UTC midnight and would shift a day west of UTC.
const parseD = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : undefined; };
const parseDT = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s)); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : parseD(s); };

function CheckinModal({ s, lang, loc, roster, projectId, act, onClose, title }) {
  const q = useAsync(() => api.get(`/api/admin/tprojects/${projectId}/checkin/${act.id}`), [act.id]);
  const d = q.data;
  const [big, setBig] = useState(false);
  const [left, setLeft] = useState(null);
  const canWrite = useCanWrite();
  // 批量登记（B3）。勾选按 userId 记，轮询换来的新名单不影响已勾选的人；名单里没有了的人自动去掉。
  // ready：轮询失败时 useAsync 会把 data 置空，这时不做「去掉已不在名单的人」，勾选不被清掉（E16）。
  // 部门筛选（3.1）：表格、勾选与「全选本页」都只针对筛选后的行；上面的出勤统计仍是整份名单。
  const all = d ? d.list || NONE : NONE;
  const rd = useRosterDept(roster, all);
  const rows = rd.rows;
  const sel = useBulkSelection({ rows, rowKey: 'userId', ready: !!q.data, resetOn: [rd.dept] });
  const runner = useBulkRunner();
  const [bulk, setBulk] = useState(null); // null | { status, op, note, danger, ids, names, labels }
  // 确认弹窗打开或批量执行中，暂停轮询与签到码到期刷新：结果要与 HR 确认时看到的名单一致。
  const pauseRef = useRef(false);
  useEffect(() => { pauseRef.current = !!bulk || runner.busy; }, [bulk, runner.busy]);
  // Live roll-call: poll faster in projector mode; tick the code countdown
  // locally and refetch the moment it expires.
  useEffect(() => {
    const iv = setInterval(() => { if (!pauseRef.current) q.reload(); }, big ? 10000 : 20000);
    return () => clearInterval(iv);
  }, [big]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (d) setLeft(d.secondsLeft); }, [d]);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => {
      if (v == null) return v;
      // 暂停期间停在 0，每秒再判一次；恢复后的第一秒立即刷新
      if (v <= 1) { if (pauseRef.current) return 0; q.reload(); return null; }
      return v - 1;
    }), 1000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openBulk = (status, op, note, danger) => {
    if (!sel.count) return;
    setBulk({ status, op, note, danger: !!danger, ...bulkSnapshot(sel, s) });
  };
  const runBulk = async () => {
    const b = bulk;
    if (!b || runner.busy) return;
    await runner.run({
      op: b.op, names: b.labels,
      request: () => api.post(`/api/admin/tprojects/${projectId}/checkin/${act.id}/bulk-mark`, { userIds: b.ids, status: b.status }),
      onSettled: () => { sel.clear(); q.reload(); },
    });
    setBulk(null);
  };
  // status 'clear' = 取消补签 / 取消请假 (server only allows it on staff-entered rows).
  const mark = async (userId, status) => {
    try { await api.post(`/api/admin/tprojects/${projectId}/checkin/${act.id}/mark`, { userId, status }); q.reload(); }
    catch (e) { Toast.error(e && e.data && e.data.code === 'self_checkin' ? s.ckSelfNoUndo : e.message); }
  };
  const present = d ? d.stats.attended + d.stats.late : 0;
  const total = d ? d.list.length : 0;
  return (
    <Modal {...dpfModalProps()} className="u-modal-visible" title={[s.checkin, title || loc(act, 'title')].filter(Boolean).join(' · ')} visible onCancel={onClose} footer={<Button onClick={onClose}>{s.ckClose}</Button>} width={720}>
      {big && d && d.code && (
        <div className="ckbig" onClick={() => setBig(false)}>
          <div className="ckbig-exit">{s.ckExit}</div>
          <div className="ckbig-title">{title || loc(act, 'title')}</div>
          <div className="ckbig-code tnum">{String(d.code).split('').map((ch, i) => <span key={i}>{ch}</span>)}</div>
          <div className="ckbig-meta">
            <span>{s.ckRotate}{left != null ? ` · ${left}s` : ''}</span>
            <span className="ckbig-count tnum">{present} / {total}</span>
          </div>
          <div className="ckbig-bar"><i style={{ width: `${left != null ? Math.max(0, Math.min(100, (left / 60) * 100)) : 0}%` }} /></div>
          <div className="ckbig-hint">{s.ckHint}</div>
        </div>
      )}
      {/* Spinner on the FIRST load only. Gating on q.loading swapped the roster
          for a spinner on every reload (each 补签, and the 10/20s poll), which
          unmounted the table and threw HR back to the top of a 29-row list. */}
      {!d ? <div style={{ padding: 30, textAlign: 'center' }}><Spin /></div> : (
        // The code card sits ABOVE the roster instead of taking a 200px column
        // beside it — same call as the course roll-call in Content.jsx. Side by
        // side, a width=720 modal leaves 670 of content, minus 200 for the card
        // and an 18 gap = 452 for a 590-wide table, so the make-up / excuse
        // column fell off the right edge. Stacked, the roster gets all 670 —
        // without widening the modal past what a narrow screen can show.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {d.checkinOpen === false ? (
            <Banner type="warning" fullMode={false} closeIcon={null} description={d.cohortEnded && d.projectStatus === 'running' ? s.ckEnded : s.ckNotOpen(({ draft: s.stDraft, planning: s.stPlanning, running: s.stRunning, closing: s.stClosing, closed: s.stClosed })[d.projectStatus] || d.projectStatus)} />
          ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', border: '1px solid var(--semi-color-border)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flex: 'none' }}>
              <span style={{ fontSize: 12, color: 'var(--semi-color-text-2)' }}>{s.ckCode}</span>
              <span className="tnum" style={{ fontSize: 30, fontWeight: 800, letterSpacing: 4, color: 'var(--semi-color-primary)' }}>{d.code}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--semi-color-text-2)', flex: 1, minWidth: 140 }}>
              {left != null && <>{s.ckRefreshIn(left)} · </>}{s.ckEnterHint}
            </span>
            {/* The one number the room asks for, without reading four tags. */}
            <span style={{ fontSize: 13, flex: 'none' }}>
              {s.ckCheckedIn} <b className="tnum">{present} / {total}</b>
              {d.stats.late > 0 && <span style={{ color: 'var(--semi-color-warning)' }}> · {s.ckLate} <span className="tnum">{d.stats.late}</span></span>}
            </span>
            <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <Button size="small" theme="solid" type="primary" onClick={() => setBig(true)}>{s.ckBig}</Button>
              <Button size="small" icon={<IconRefresh />} onClick={() => q.reload()} aria-label={s.ckRefresh} />
            </div>
          </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <Tag color="green" type="light">{s.ckAttended} {d.stats.attended}</Tag>
              <Tag color="amber" type="light">{s.ckLate} {d.stats.late}</Tag>
              <Tag type="light">{s.ckExcused} {d.stats.excused}</Tag>
              <Tag color="red" type="light">{s.ckMissing} {d.stats.missing}</Tag>
            </div>
            {total > 0 && <RosterDeptBar s={s} lang={lang} rd={rd} total={total} />}
            {/* 批量登记（B3）：名单不分页，全选即本名单（筛选后）全部学员。只读档不显示勾选框与批量按钮。 */}
            {canWrite && (
              <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} pageOnly={false} selectPage={sel.togglePage}>
                <Button size="small" onClick={() => openBulk('attended', s.ckMakeup, s.ckBulkPresentNote)}>{s.ckBulkPresent}</Button>
                <Button size="small" onClick={() => openBulk('excused', s.ckExcuse, s.bulkMarkNote)}>{s.ckBulkExcuse}</Button>
                <Button size="small" type="danger" onClick={() => openBulk('clear', s.bulkUndoOp, s.ckBulkUndoNote, true)}>{s.ckBulkUndo}</Button>
              </BulkBar>
            )}
            {/* Height cap comes from `.ck-roster` in app.css, which puts it on
                .semi-table-body. On the Table's own style it left the horizontal
                scrollbar at the bottom of the whole list — HR had to scroll all
                the way down before they could scroll sideways. */}
            <div ref={sel.wrapRef}>
            <Table size="small" rowKey="userId" dataSource={rows} pagination={false} className="ck-roster"
              rowSelection={canWrite ? sel.rowSelection : undefined}
              {...resizableTable([
                { title: s.colName, dataIndex: 'name', width: 220, render: (v, r) => <span>{v} <Text type="tertiary" size="small" className="tnum">{r.employeeId}{rd.deptOf.get(r.userId) ? ` · ${rd.deptOf.get(r.userId)}` : ''}</Text></span> },
                { title: s.colClass, dataIndex: 'class', width: 90, render: (v) => v || '—' },
                { title: s.colState, dataIndex: 'status', width: 90, render: (v) => v === 'attended' ? <Tag color="green" type="light">{s.ckAttended}</Tag> : v === 'late' ? <Tag color="amber" type="light">{s.ckLate}</Tag> : v === 'excused' ? <Tag type="light">{s.ckExcused}</Tag> : v === 'absent' ? <Tag color="red" type="light">{s.ckAbsent}</Tag> : <Text type="quaternary">{s.ckMissing}</Text> },
                { title: '', dataIndex: 'op', width: 190, render: (_, r) => (
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {canWrite && !r.status && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'attended')}>{s.ckMakeup}</Button>}
                    {canWrite && !r.status && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'excused')}>{s.ckExcuse}</Button>}
                    {canWrite && r.status === 'late' && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'attended')}>{s.ckToPresent}</Button>}
                    {/* 负责人 2026-10-06：请假需补课，补课后直接改为出席，不必先取消请假 */}
                    {canWrite && r.status === 'excused' && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'attended')}>{s.ckMakeupExcused}</Button>}
                    {/* Undo a staff-entered mark → back to 未签到. A learner's own
                        code check-in (r.self) is proof they were there: no undo. */}
                    {canWrite && !r.self && ['attended', 'late', 'absent'].includes(r.status) && <Button size="small" theme="borderless" type="tertiary" onClick={() => mark(r.userId, 'clear')}>{s.ckUndoMakeup}</Button>}
                    {canWrite && !r.self && r.status === 'excused' && <Button size="small" theme="borderless" type="tertiary" onClick={() => mark(r.userId, 'clear')}>{s.ckUndoExcuse}</Button>}
                  </span>
                ) },
              ], { extra: canWrite ? BULK_SEL_EXTRA : 0 })} />
            </div>
          </div>
        </div>
      )}
      {canWrite && bulk && (
        <BulkConfirmModal visible op={bulk.op} names={bulk.names} danger={bulk.danger} loading={runner.busy}
          onOk={runBulk} onCancel={() => { if (!runner.busy) setBulk(null); }}>
          <div className="bulk-hint">{bulk.note}</div>
        </BulkConfirmModal>
      )}
      {runner.modal}
    </Modal>
  );
}

// 线上活动的完成登记（负责人 2026-10-06）。与「签到管理」共用后台名单与登记接口
// （GET/POST /api/admin/tprojects/:id/checkin/:actId[/mark]，服务端按 rollKind 'completion' 区分），
// 但没有签到码、投屏和轮询：线上活动的完成不在现场实时发生，打开时取一次、每次登记后刷新即可。
// 撤销规则与线下签到不同：HR 可以撤销任何一条完成记录，包括学员自己点链接或自行确认产生的
// （点开链接不等于真的参加了）；线下活动学员自己输码签到的记录仍不能撤销。
function CompletionModal({ s, lang, loc, roster, projectId, act, onClose }) {
  const q = useAsync(() => api.get(`/api/admin/tprojects/${projectId}/checkin/${act.id}`), [act.id]);
  const d = q.data;
  const canWrite = useCanWrite();
  // 批量登记（B3）：与签到管理同一个批量接口，服务端按 rollKind 'completion' 处理；
  // 撤销时学员自己完成的记录也撤销（现行单条规则），确认弹窗写明。ready 同 CheckinModal（E16）。
  // 部门筛选（3.1）同签到管理：表格与勾选只针对筛选后的行，统计仍是整份名单。
  const all = d ? d.list || NONE : NONE;
  const rd = useRosterDept(roster, all);
  const rows = rd.rows;
  const sel = useBulkSelection({ rows, rowKey: 'userId', ready: !!q.data, resetOn: [rd.dept] });
  const runner = useBulkRunner();
  const [bulk, setBulk] = useState(null); // null | { status, op, note, danger, ids, names, labels }
  const openBulk = (status, op, note, danger) => {
    if (!sel.count) return;
    setBulk({ status, op, note, danger: !!danger, ...bulkSnapshot(sel, s) });
  };
  const runBulk = async () => {
    const b = bulk;
    if (!b || runner.busy) return;
    await runner.run({
      op: b.op, names: b.labels,
      request: () => api.post(`/api/admin/tprojects/${projectId}/checkin/${act.id}/bulk-mark`, { userIds: b.ids, status: b.status }),
      onSettled: () => { sel.clear(); q.reload(); },
    });
    setBulk(null);
  };
  const mark = async (userId, status) => {
    try { await api.post(`/api/admin/tprojects/${projectId}/checkin/${act.id}/mark`, { userId, status }); q.reload(); }
    catch (e) { Toast.error((lang === 'zh' && e && e.data && e.data.error_zh) || e.message); }
  };
  const stats = (d && d.stats) || {};
  const cols = [
    { title: s.colName, dataIndex: 'name', width: 190, render: (v, r) => <span>{v} <Text type="tertiary" size="small" className="tnum">{r.employeeId}{rd.deptOf.get(r.userId) ? ` · ${rd.deptOf.get(r.userId)}` : ''}</Text></span> },
    { title: s.colClass, dataIndex: 'class', width: 80, render: (v) => v || '—' },
    { title: s.colState, dataIndex: 'status', width: 90, render: (v) => v === 'completed' ? <Tag color="green" type="light">{s.cpCompleted}</Tag> : v === 'excused' ? <Tag type="light">{s.cpExcused}</Tag> : <Text type="quaternary">{s.cpMissing}</Text> },
    { title: s.cpColBy, dataIndex: 'self', width: 100, render: (v, r) => (r.status ? (r.self ? s.cpBySelf : s.cpByStaff) : '—') },
    { title: s.cpColAt, dataIndex: 'at', width: 130, render: (v) => (v ? <span className="tnum">{fmtDT(v).replace('T', ' ')}</span> : '—') },
  ];
  if (canWrite) cols.push({ title: '', dataIndex: 'op', width: 170, render: (_, r) => (
    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {!r.status && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'completed')}>{s.cpMark}</Button>}
      {!r.status && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'excused')}>{s.cpExcuse}</Button>}
      {/* 负责人 2026-10-06：请假需补课，补完直接改为已完成，不必先撤销 */}
      {r.status === 'excused' && <Button size="small" theme="borderless" onClick={() => mark(r.userId, 'completed')}>{s.cpMakeupExcused}</Button>}
      {r.status && <Button size="small" theme="borderless" type="tertiary" onClick={() => mark(r.userId, 'clear')}>{s.cpUndo}</Button>}
    </span>
  ) });
  return (
    <Modal {...dpfModalProps()} className="u-modal-visible" title={[s.cpTitle, loc(act, 'title')].filter(Boolean).join(' · ')} visible onCancel={onClose} footer={<Button onClick={onClose}>{s.ckClose}</Button>} width={720}>
      {/* Spinner on the FIRST load only (same as CheckinModal): a reload after each
          mark keeps the previous list mounted so HR stays where they were. */}
      {!d ? (q.error
        ? <Banner type="danger" fullMode={false} closeIcon={null} description={[s.loadFail, (lang === 'zh' && q.error.data && q.error.data.error_zh) || q.error.message].filter(Boolean).join(' · ')} />
        : <div style={{ padding: 30, textAlign: 'center' }}><Spin /></div>) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Banner type="info" fullMode={false} closeIcon={null} description={s.cpModeNote(d.completion || act.completion || 'self')} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <Tag color="green" type="light">{s.cpCompleted} <span className="tnum">{stats.completed || 0}</span></Tag>
              <Tag type="light">{s.cpExcused} <span className="tnum">{stats.excused || 0}</span></Tag>
              <Tag color="red" type="light">{s.cpMissing} <span className="tnum">{stats.missing || 0}</span></Tag>
            </div>
            {all.length > 0 && <RosterDeptBar s={s} lang={lang} rd={rd} total={all.length} />}
            {canWrite && (
              <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} pageOnly={false} selectPage={sel.togglePage}>
                <Button size="small" onClick={() => openBulk('completed', s.cpMark, s.cpBulkDoneNote)}>{s.cpBulkDone}</Button>
                <Button size="small" onClick={() => openBulk('excused', s.cpExcuse, s.bulkMarkNote)}>{s.cpBulkExcuse}</Button>
                <Button size="small" type="danger" onClick={() => openBulk('clear', s.bulkUndoOp, s.cpBulkUndoNote, true)}>{s.cpBulkUndo}</Button>
              </BulkBar>
            )}
            <div ref={sel.wrapRef}>
            <Table size="small" rowKey="userId" dataSource={rows} pagination={false} className="ck-roster"
              rowSelection={canWrite ? sel.rowSelection : undefined}
              {...resizableTable(cols, { extra: canWrite ? BULK_SEL_EXTRA : 0 })} />
            </div>
          </div>
        </div>
      )}
      {canWrite && bulk && (
        <BulkConfirmModal visible op={bulk.op} names={bulk.names} danger={bulk.danger} loading={runner.busy}
          onOk={runBulk} onCancel={() => { if (!runner.busy) setBulk(null); }}>
          <div className="bulk-hint">{bulk.note}</div>
        </BulkConfirmModal>
      )}
      {runner.modal}
    </Modal>
  );
}

// ---------- 期次与成员 ----------
function CohortTab({ doc, s, lang, loc, saveDoc, roster, projectId, reload, intent, clearIntent }) {
  const cohorts = doc.cohorts || [];
  // NONE 而不是 []：CohortMembers 以它的引用判断「数据换了一份」（useDataVersion），每次渲染新建空数组会让表格反复重挂
  const members = doc.members || NONE;
  // 部门筛选（第二批 3.1）：一个 DeptFilter 管本页签全部期次的学员表，按学员的 department 含下级过滤；写进地址栏 ?dept=
  const [urlp, patchUrl] = useUrlState();
  const fDept = urlp.dept || null;
  const tree = useDeptTree();
  const deptOk = useMemo(() => deptMatcher(tree, fDept), [tree, fDept]);
  const onDeptInvalid = () => { Toast.warning(deptFilterInvalidText(lang)); patchUrl({ dept: null }); };
  const hasLearners = members.some((m) => m.role === 'learner');
  const [cohortModal, setCohortModal] = useState(null); // null | 'new' | cohort obj
  const [classModal, setClassModal] = useState(null);   // cohortId
  const [addModal, setAddModal] = useState(null);       // cohortId
  const [addMode, setAddMode] = useState(null);         // which "add learners" mode to open on
  const [moveTarget, setMoveTarget] = useState(null);   // member row
  // Learner search, kept per cohort id — each cohort has its own table, so one
  // shared query would silently filter every other cohort on the page too.
  const [memberQuery, setMemberQuery] = useState({});
  // 每期可折叠（2026-10-06 负责人决定）：默认展开开放报名的期次；都不开放时展开第一期；点标题行切换
  const [collapsed, setCollapsed] = useState(() => {
    const list = doc.cohorts || []; const anyOpen = list.some((c) => c.open);
    return Object.fromEntries(list.map((c, i) => [c.id, anyOpen ? !c.open : i !== 0]));
  });
  const toggleCohort = (id) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  // 期次的学员表（含勾选与页码）第一次展开后就一直挂着，折叠只是隐藏：折叠再展开不丢页码与勾选（E15）。
  // 从未展开过的期次不挂，名单多的项目打开时不必把每期的表格都渲染一遍。只增不减，渲染时记入是幂等的。
  const everShown = useRef(null);
  if (!everShown.current) everShown.current = new Set();
  const canWrite = useCanWrite();

  const saveCohorts = (next, ok) => saveDoc({ cohorts: next }, ok);

  const memberOps = async (payload, ok) => {
    try { await api.post(`/api/admin/tprojects/${projectId}/members/update`, payload); Toast.success(ok); reload(); }
    catch (e) { Toast.error(e.message); }
  };

  // 批量导入学员 from the action bar: open the first cohort's picker already on
  // the paste-IDs mode, which is what "bulk import" means to HR.
  useEffect(() => {
    if (intent !== 'import') return;
    clearIntent();
    if (!cohorts[0]) { Toast.warning(s.needCohort); return; }
    setAddModal(cohorts[0].id); setAddMode('paste');
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {hasLearners && (
        <div className="u-filterbar">
          <DeptFilter options={tree ? tree.options : NONE} value={fDept} onChange={(v) => patchUrl({ dept: v || null })}
            lang={lang} label={s.colDept} placeholder={s.deptAll} ready={!!tree} disabled={tree === null}
            showNone={!!(tree && tree.hasNone)} onInvalid={onDeptInvalid} />
          <span className="u-hint">{s.memDeptHint}</span>
        </div>
      )}
      {cohorts.map((c) => {
        const rows = members.filter((m) => m.cohortId === c.id && m.role === 'learner');
        const isCollapsed = !!collapsed[c.id];
        if (!isCollapsed) everShown.current.add(c.id);
        return (
          <div key={c.id} className={'tp-phase tp-cohort' + (isCollapsed ? ' is-collapsed' : '')} style={{ padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: isCollapsed ? 0 : 10 }}>
              <button type="button" className="tp-cohort-toggle" aria-expanded={!isCollapsed} aria-label={c.name} onClick={() => toggleCohort(c.id)}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <b style={{ fontSize: 15, cursor: 'pointer' }} onClick={() => toggleCohort(c.id)}>{c.name}</b>
              {isCollapsed && <Text type="tertiary" size="small" className="tnum">{s.membersN(rows.filter((r) => r.state === 'active').length)}</Text>}   {/* CX-030：按在训计 */}
              {c.open && <Tag color="indigo" type="light" shape="circle">{s.openTag}</Tag>}
              <Text type="tertiary" size="small">{c.startAt || '—'} → {c.endAt || '—'} · {s.fCap} {c.capacity || '∞'}</Text>
              {canWrite && (
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <Button size="small" onClick={() => setCohortModal(c)}>{s.eCohort}</Button>
                  {/* CX-115：没有任何学员（含已退训）的期次可删除；有签到、完成记录时服务端回 409 cohort_in_use */}
                  {rows.length === 0 && (
                    <Popconfirm title={s.delCohort} content={s.delCohortAsk(c.name)} okType="danger" okText={s.delCohort} cancelText={s.cancel}
                      onConfirm={() => saveCohorts(cohorts.filter((x) => x.id !== c.id), s.okCohortDeleted)}>
                      <Button size="small" type="danger">{s.delCohort}</Button>
                    </Popconfirm>
                  )}
                  <Button size="small" onClick={() => setClassModal({ cohortId: c.id, cls: null })}>{s.addClass.replace('+ ', '')}</Button>
                  <Button size="small" theme="solid" onClick={() => { setAddModal(c.id); setAddMode(null); }}>{s.addMembers.replace('+ ', '')}</Button>
                </span>
              )}
            </div>
            {!isCollapsed && (c.classes || []).length > 0 && (
              <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(c.classes || []).map((cl) => {
                  const head = roster.find((r) => r.id === cl.headId);
                  return (
                    <span key={cl.id} className="cls-chip">
                      <b>{cl.name}</b>
                      <span>{head ? ` · ${head.name}` : ''} · {s.nPeople(rows.filter((m) => m.classId === cl.id && m.state === 'active').length)}</span>
                      {canWrite && (<>
                      <Button size="small" theme="borderless" icon={<IconEdit />} aria-label={s.clsEdit}
                        onClick={() => setClassModal({ cohortId: c.id, cls: cl })} />
                      <Popconfirm title={s.clsEdit} content={s.clsDelAsk} okType="danger"
                        onConfirm={() => saveCohorts(cohorts.map((x) => (x.id === c.id ? { ...x, classes: (x.classes || []).filter((y) => y.id !== cl.id) } : x)))}>
                        <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} aria-label={s.withdraw} />
                      </Popconfirm>
                      </>)}
                    </span>
                  );
                })}
              </div>
            )}
            {everShown.current.has(c.id) && (
              <CohortMembers c={c} cohorts={cohorts} members={members} hidden={isCollapsed} s={s} canWrite={canWrite}
                projectId={projectId} reload={reload} deptKey={fDept} deptOk={deptOk}
                query={memberQuery[c.id] || ''} onQuery={(v) => setMemberQuery((prev) => ({ ...prev, [c.id]: v }))}
                onMove={setMoveTarget} onWithdraw={(r) => memberOps({ userId: r.userId, action: 'withdraw' }, s.okWithdrawn)} />
            )}
          </div>
        );
      })}
      {canWrite && <Button icon={<IconPlus />} theme="light" onClick={() => setCohortModal('new')}>{s.addCohort.replace('+ ', '')}</Button>}

      {cohortModal && (
        <QuickForm title={cohortModal === 'new' ? s.addCohort.replace('+ ', '') : s.eCohort} s={s}
          init={cohortModal === 'new' ? { } : { name: cohortModal.name, startAt: cohortModal.startAt, endAt: cohortModal.endAt, capacity: cohortModal.capacity, open: !!cohortModal.open }}
          fields={[{ f: 'name', label: s.fCName, required: true }, { f: 'startAt', label: s.fStart, type: 'date' }, { f: 'endAt', label: s.fEnd, type: 'date' }, { f: 'capacity', label: s.fCap, type: 'number' }, { f: 'open', label: s.fOpen, type: 'switch' }]}
          onCancel={() => setCohortModal(null)}
          onOk={(v) => {
            const patch = { name: v.name, startAt: v.startAt ? fmtD(v.startAt) : null, endAt: v.endAt ? fmtD(v.endAt) : null, capacity: v.capacity || null, open: !!v.open };
            const next = cohortModal === 'new'
              ? [...cohorts, { id: genId('ch'), classes: [], phases: [], ...patch }]
              : cohorts.map((c) => (c.id === cohortModal.id ? { ...c, ...patch } : c));
            setCohortModal(null); saveCohorts(next);
          }} />
      )}
      {classModal && (
        <ClassModal s={s} roster={roster} cls={classModal.cls} onCancel={() => setClassModal(null)}
          onOk={(v) => {
            const next = cohorts.map((c) => {
              if (c.id !== classModal.cohortId) return c;
              return classModal.cls
                ? { ...c, classes: (c.classes || []).map((x) => (x.id === classModal.cls.id ? { ...x, name: v.name, headId: v.headId || null } : x)) }
                : { ...c, classes: [...(c.classes || []), { id: genId('cl'), name: v.name, headId: v.headId || null }] };
            });
            setClassModal(null); saveCohorts(next);
          }} />
      )}
      {addModal && (
        <AddMembersModal s={s} lang={lang} roster={roster} cohort={cohorts.find((c) => c.id === addModal)} existing={members} projectId={projectId} initMode={addMode}
          onCancel={() => { setAddModal(null); setAddMode(null); }} onDone={() => { setAddModal(null); setAddMode(null); reload(); }} />
      )}
      {moveTarget && (
        <MoveModal s={s} cohorts={cohorts} row={moveTarget} onCancel={() => setMoveTarget(null)}
          onOk={(v) => { setMoveTarget(null); memberOps({ userId: moveTarget.userId, action: 'move', cohortId: v.cohortId, classId: v.classId || null }, s.okMoved); }} />
      )}
    </div>
  );
}

// 一个期次的学员表（2026-10-06 批量操作 B2 从 CohortTab 抽出：勾选与页码要用 hooks，不能写在 cohorts.map 里）。
// - 搜索词由 CohortTab 按期次保存，传进来（折叠、重新加载都保留）；搜索词一变，勾选清空、回到第 1 页。
// - 表格以 doc.members 的版本为 key：只有数据换了一份（保存或操作后重新加载）才重挂，并按记住的页码复原；
//   打字搜索不重挂，拖动过的列宽不丢。rows / shown 用 useMemo，勾选引起的重渲染不会把表格弹回第 1 页。
// - 只有在训学员可勾选；只读档没有勾选框与批量按钮。
// - 部门筛选（第二批 3.1）由 CohortTab 统一给出：deptKey = 地址栏 ?dept= 的值，deptOk = (部门原文) => bool（含下级）。
function CohortMembers({ c, cohorts, members, hidden, query, onQuery, s, canWrite, projectId, reload, onMove, onWithdraw, deptKey, deptOk }) {
  const rows = useMemo(() => members.filter((m) => m.cohortId === c.id && m.role === 'learner'), [members, c.id]);
  const needle = (query || '').trim().toLowerCase();
  const shown = useMemo(
    () => rows.filter((m) => (!deptKey || deptOk(m.department))
      && (!needle || `${m.name || ''} ${m.employeeId || ''}`.toLowerCase().includes(needle))),
    [rows, needle, deptKey, deptOk],
  );
  const narrowed = !!(needle || deptKey);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE);
  useEffect(() => { setPage(1); }, [needle, deptKey]);
  const ver = useDataVersion(members);
  const sel = useBulkSelection({ rows: shown, rowKey: 'userId', isSelectable: isActiveMember, resetOn: [needle, deptKey] });
  const runner = useBulkRunner();
  const [bulk, setBulk] = useState(null); // null | { kind: 'move' | 'withdraw', ids, names, labels }
  const [toCohort, setToCohort] = useState(c.id);
  const [toClass, setToClass] = useState(null);
  const target = cohorts.find((x) => x.id === toCohort);

  const openBulk = (kind) => {
    if (!sel.count) return;
    if (kind === 'move') { setToCohort(c.id); setToClass(null); }
    setBulk({ kind, ...bulkSnapshot(sel, s) });
  };
  const runBulk = async () => {
    const b = bulk;
    if (!b || runner.busy) return;
    const move = b.kind === 'move';
    if (move && !toCohort) return;
    const body = move
      ? { userIds: b.ids, action: 'move', cohortId: toCohort, classId: toClass || null }
      : { userIds: b.ids, action: 'withdraw' };
    await runner.run({
      op: move ? s.mvTitle : s.withdraw, names: b.labels,
      request: () => api.post(`/api/admin/tprojects/${projectId}/members/bulk-update`, body),
      onSettled: () => { sel.clear(); reload(); },
    });
    setBulk(null);
  };

  const paged = shown.length > 10;
  return (
    <div style={hidden ? { display: 'none' } : undefined}>
      {rows.length > 0 && (
        <div className="tp-mem-bar">
          <Input className="tp-mem-search" prefix={<IconSearch />} showClear
            placeholder={s.searchMember} aria-label={s.searchMember}
            value={query} onChange={onQuery} />
          <Text type="tertiary" size="small" className="tnum">
            {/* CX-121：与折叠时同口径，只计在训；有已退训的另注 */}
            {narrowed ? s.memberMatch(shown.length, rows.length)
              : [s.membersN(rows.filter((r) => r.state === 'active').length), ...(rows.some((r) => r.state !== 'active') ? [s.membersWd(rows.filter((r) => r.state !== 'active').length)] : [])].join(' · ')}
          </Text>
        </div>
      )}
      {canWrite && rows.length > 0 && (
        <BulkBar count={sel.count} onClear={sel.clear} busy={runner.busy} pageOnly={paged} selectPage={sel.togglePage}>
          <Button size="small" onClick={() => openBulk('move')}>{s.bulkMove}</Button>
          <Button size="small" type="danger" onClick={() => openBulk('withdraw')}>{s.bulkWithdraw}</Button>
        </BulkBar>
      )}
      <div ref={sel.wrapRef}>
        <Table key={ver} size="small" rowKey="userId" dataSource={shown} className="dt-table"
          pagination={paged ? {
            pageSize: size, defaultCurrentPage: clampPage(page, shown.length, size), onPageChange: setPage, onPageSizeChange: setSize,
            pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: () => s.totalText(shown.length),
          } : false}
          rowSelection={canWrite ? sel.rowSelection : undefined}
          empty={narrowed ? <Empty description={s.memberNone} style={{ padding: 24 }} /> : undefined}
          {...resizableTable(dataTableColumns([   // 一致性整改 2：标题列 ≥ 220 不折行、操作列靠右
            { title: s.colName, dataIndex: 'name', width: 200, render: (v, r) => <span>{v} <Text type="tertiary" size="small" className="tnum">{r.employeeId}</Text></span> },
            { title: s.colDept, dataIndex: 'department', width: 140, render: (v) => (v ? <span className="u-ellipsis" title={v}>{v}</span> : '—') },
            { title: s.colClass, dataIndex: 'classId', width: 110, render: (v) => ((c.classes || []).find((x) => x.id === v) || {}).name || '—' },
            { title: s.colProgress, dataIndex: 'progress', width: 180, render: (v) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                <Progress percent={v} style={{ flex: 1 }} aria-label={`${v}%`} />
                <span className="tnum" style={{ fontSize: 12.5, width: 38, textAlign: 'right' }}>{v}%</span>
              </div>
            ) },
            // CX-028（2026-10-09 验收）：状态下方列出期次轨迹（进入 / 退出时间，迁移 66 cohortLog），退训的人也能查到何时加入、何时退出
            { title: s.colState, dataIndex: 'state', width: 210, render: (v, r) => (
              <span>
                {v === 'active' ? <Tag color="green" type="light">{s.stActive}</Tag> : <Tag type="light">{s.stWithdrawn}</Tag>}
                {Array.isArray(r.cohortLog) && r.cohortLog.length > 0 && (
                  <span className="tp-traj" title={s.trajectory} style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.5, marginTop: 2 }}>
                    {r.cohortLog.map((seg, i) => { const co = (cohorts || []).find((x) => x.id === seg.cohortId); const fmtT = (t) => fmtDateTime(t); return <span key={i} className="tnum" style={{ display: 'block' }}>{(co ? co.name : seg.cohortId || '—') + ' ' + fmtT(seg.enteredAt) + ' → ' + (seg.leftAt ? fmtT(seg.leftAt) : v === 'active' ? s.trajNow : s.trajLeftUnknown)}</span>; })}
                  </span>
                )}
              </span>
            ) },
            // 只读档整列去掉,不留一个带「操作」表头的空列(转班/退出都打
            // POST tprojects/:id/members/update,矩阵 5451 · 培训域写)。
            ...(canWrite ? [{ title: s.colOps, dataIndex: 'op', width: 150, render: (_, r) => r.state === 'active' && (
              <span style={{ display: 'flex', gap: 6 }}>
                <Button size="small" theme="borderless" onClick={() => onMove(r)}>{s.move}</Button>
                <Popconfirm title={s.withdrawAsk(r.name)} okType="danger" onConfirm={() => onWithdraw(r)}>
                  <Button size="small" theme="borderless" type="danger">{s.withdraw}</Button>
                </Popconfirm>
              </span>
            ) }] : []),
          ], { titleKey: 'name', opsKey: 'op' }), { extra: canWrite ? BULK_SEL_EXTRA : 0 })} />
      </div>
      {canWrite && bulk && (
        <BulkConfirmModal visible op={bulk.kind === 'move' ? s.mvTitle : s.withdraw} names={bulk.names}
          danger={bulk.kind === 'withdraw'} okDisabled={bulk.kind === 'move' && !toCohort} loading={runner.busy}
          onOk={runBulk} onCancel={() => { if (!runner.busy) setBulk(null); }}>
          {bulk.kind === 'move' ? (
            <div className="bulk-fields">
              <div className="bulk-field">
                <div className="bulk-field-lab">{s.mvCohort}</div>
                {/* 只列本培养项目的期次（同一项目内调整）；换期次时班级清空，班级选项跟着期次走 */}
                <Select style={{ width: '100%' }} value={toCohort} onChange={(v) => { setToCohort(v); setToClass(null); }}
                  optionList={cohorts.map((x) => ({ label: x.name, value: x.id }))} />
              </div>
              <div className="bulk-field">
                <div className="bulk-field-lab">{s.mvClass}</div>
                <Select showClear style={{ width: '100%' }} value={toClass} onChange={(v) => setToClass(v || null)}
                  optionList={((target && target.classes) || []).map((x) => ({ label: x.name, value: x.id }))} />
              </div>
              <div className="bulk-hint">{s.bulkMoveHint}</div>
            </div>
          ) : (
            <div className="bulk-hint">{s.bulkWithdrawNote}</div>
          )}
        </BulkConfirmModal>
      )}
      {runner.modal}
    </div>
  );
}

function ClassModal({ s, roster, cls, onOk, onCancel }) {
  const formApi = useRef(null); // ref, not a local — see NewProjectButton
  return (
    <Modal title={cls ? s.clsEdit : s.addClass.replace('+ ', '')} visible onCancel={onCancel} okText={s.save} cancelText={s.cancel} maskClosable={false}
      onOk={() => formApi.current && formApi.current.validate().then(onOk).catch(() => {})}>
      <Form getFormApi={(a) => { formApi.current = a; }} labelPosition="top" initValues={cls ? { name: cls.name, headId: cls.headId || undefined } : {}}>
        <Form.Input field="name" label={s.fClsName} rules={[{ required: true, message: s.fClsName }]} />
        {/* Class head can be ANYONE active — including admins (they run the
            training; they just can't be added as learners). */}
        <Form.Select field="headId" label={s.fHead} filter showClear style={{ width: '100%' }}
          optionList={roster.filter((r) => r.active).map((r) => ({ label: `${r.name}（${r.employeeId}）${r.role === 'admin' ? ` · ${s.adminTag}` : ''}`, value: r.id }))} />
      </Form>
    </Modal>
  );
}

function AddMembersModal({ s, lang, roster, cohort, existing, projectId, initMode, onDone, onCancel }) {
  // Built for a 3000+ person roster: add by whole department, by pasting
  // employee IDs (from HR sheets), or by picking individuals.
  const inCohort = new Set(existing.filter((m) => m.state === 'active').map((m) => m.userId));
  // CX-027（2026-10-09 验收）：已在本期与已在其他期次分开计（原来都写成「已在本期」）
  const inThis = new Set(existing.filter((m) => m.state === 'active' && m.cohortId === cohort.id).map((m) => m.userId));
  const eligible = roster.filter((r) => r.active && r.role !== 'admin' && !inCohort.has(r.id));
  const [mode, setMode] = useState(initMode || 'dept');
  const [depts, setDepts] = useState([]);
  const [pasted, setPasted] = useState('');
  const [ids, setIds] = useState([]);
  const [classId, setClassId] = useState(null);
  const [busy, setBusy] = useState(false);

  // 「按部门」（第二批 3.1 / P3）：全站统一的 DeptFilter 多选，选上级部门即含全部下级（与各页部门筛选同一口径，
  // 原来只按部门原文精确匹配、不含下级）。提交前弹确认框写明「将加入 N 人（含下级部门）」。
  const tree = useDeptTree();
  const deptOk = useMemo(() => deptMatcher(tree, depts), [tree, depts]);
  // 第三批 8.6：按职级（可与部门组合）。职级目录 GET /api/admin/job-grades；员工职级 = roster 的 jobLevel。
  // 选了职级时没有设职级的人不纳入并提示人数；确认框写明人数，并说明扣除了已在本期的人。
  const gradesQ = useAsync(() => api.get('/api/admin/job-grades').catch(() => ({ ranks: [] })), []);
  const ranks = (gradesQ.data && gradesQ.data.ranks) || NONE;
  const [grades, setGrades] = useState([]);
  const gradesInUse = useMemo(() => [...new Set(roster.filter((r) => r.active).map((r) => r.jobLevel).filter(Boolean))], [roster]);

  const pasteTokens = pasted.split(/[\s,;、，]+/).map((x) => x.trim()).filter(Boolean);
  const byEmpId = new Map(roster.map((r) => [String(r.employeeId).toLowerCase(), r]));
  const pasteMatched = [], pasteMissing = [], pasteAlready = [];
  for (const tk of pasteTokens) {
    const r = byEmpId.get(tk.toLowerCase());
    if (!r) pasteMissing.push(tk);
    else if (inCohort.has(r.id) || !r.active || r.role === 'admin') pasteAlready.push(tk);
    else pasteMatched.push(r.id);
  }

  // 部门树未加载（或不可用）时不按部门解析：deptMatcher 在没有树时一律放行，这里必须挡住，免得整份名单被加进来
  // 部门（含下级）× 职级：两者都可单用；选了部门但部门树没加载好 → 一个人也不解析
  const byDeptGrade = mode === 'dept'
    ? splitByGrade(depts.length && tree ? eligible.filter((r) => deptOk(r.department)) : depts.length ? [] : grades.length ? eligible : [], grades)
    : null;
  const resolved = mode === 'dept'
    ? byDeptGrade.match.map((r) => r.id)
    : mode === 'paste' ? [...new Set(pasteMatched)] : ids;
  // 同一口径下已在本期的人数（确认框里写「已扣除」）
  const inSplit = mode === 'dept' && (depts.length || grades.length)
    ? splitByGrade(roster.filter((r) => r.active && r.role !== 'admin' && inCohort.has(r.id) && (!depts.length || (tree && deptOk(r.department)))), grades)
    : null;
  const alreadyIn = inSplit ? inSplit.match.filter((r) => inThis.has(r.id)).length : 0;
  const alreadyOther = inSplit ? inSplit.match.length - alreadyIn : 0;
  // 未设职级：与课程指派、服务端预览同一口径 —— 条件范围内全部在职员工（含已在本期的人）里没有职级的人数（UI 批 U2 / 验收 U-5）
  const noGradeN = byDeptGrade && grades.length ? byDeptGrade.noGrade.length + (inSplit ? inSplit.noGrade.length : 0) : 0;

  // 按部门：先确认人数（含下级部门），确认后再提交；超容量的再走原来的「仍然添加」
  const confirmDept = () => {
    if (!resolved.length) return;
    Modal.confirm({
      title: grades.length ? s.byGradeConfirmT : s.byDeptConfirmT, content: s.byDeptConfirm(resolved.length) + [alreadyIn ? ' ' + s.confirmSkip(alreadyIn) : '', alreadyOther ? ' ' + s.confirmSkipOther(alreadyOther) : '', noGradeN ? ' ' + s.confirmNoGrade(noGradeN) : ''].join(''),
      okText: s.byDeptOk, cancelText: s.cancel,
      onOk: () => submit(false),
    });
  };
  const submit = async (force) => {
    if (!resolved.length) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/admin/tprojects/${projectId}/members`, { cohortId: cohort.id, userIds: resolved, classId, ...(force ? { force: true } : {}) });
      Toast.success(s.addedN(r.count));
      onDone();
    } catch (e) {
      // Capacity is enforced server-side; offer an explicit override instead of
      // a dead end (rooms sometimes do fit one more).
      const d = e && e.data;
      if (e && e.status === 409 && d && d.code === 'over_capacity') {
        Modal.confirm({
          title: s.overCapTitle,
          content: s.overCapAsk(d.capacity, d.current, d.adding),
          okText: s.overCapOk, cancelText: s.cancel,
          onOk: () => submit(true),
        });
      } else Toast.error(e.message);
    } finally { setBusy(false); }
  };

  // UI 批 U2 11.5（F52）：与课程库「指派课程」同一布局 —— 页签「按条件 / 粘贴工号 / 逐个选择」→ 条件两行等宽 → 人数结果条
  // → 底部左「分到班级」、右 取消 / 添加（不可用时写原因）；说明收进标题旁「?」
  const nameOf = new Map(roster.map((r) => [r.id, `${r.name}（${r.employeeId}）`]));
  const pasteFound = new Set(pasteMatched).size;
  const matched = mode === 'dept' ? resolved.length + alreadyIn + alreadyOther : mode === 'paste' ? pasteFound + pasteAlready.length : ids.length;
  const reason = assignBlockReason({
    mode, criteria: depts.length > 0 || grades.length > 0, waitTree: depts.length > 0 && !tree,
    input: mode === 'paste' ? pasteTokens.length : ids.length, matched, fresh: resolved.length,
  });
  const resultItems = mode === 'dept'
    ? [{ key: 'm', label: s.addMatched, n: matched }, { key: 's', label: s.addSkipped, n: alreadyIn }, ...(alreadyOther ? [{ key: 'o', label: s.addSkippedOther, n: alreadyOther }] : []), { key: 'g', label: s.addNoGradeR, n: noGradeN, tone: 'warn' }]
    : mode === 'paste'
      ? [{ key: 'f', label: s.addFound, n: matched }, { key: 's', label: s.addPasteSkipped, n: pasteAlready.length }, { key: 'x', label: s.addMissingR, n: pasteMissing.length, tone: 'bad' }]
      : [{ key: 'p', label: s.addPicked, n: matched }];
  const classOpts = (cohort.classes || []).map((c) => ({ label: c.name, value: c.id }));

  return (
    <Modal {...dpfModalProps()} className="u-modal-visible"
      title={<span className="asg-title"><span>{`${s.addMembers.replace('+ ', '')} · ${cohort.name}`}</span><AssignHelp text={s.addHelp} /></span>}
      visible onCancel={onCancel} maskClosable={false} width={720}
      footer={(
        <AssignFooter
          left={classOpts.length > 0 && (
            <label className="asg-due"><span className="asg-due-lab">{s.pickClass}</span>
              <Select showClear style={{ width: 180 }} value={classId} onChange={setClassId} optionList={classOpts} /></label>
          )}
          reason={reason} cancelText={s.cancel} onCancel={onCancel} loading={busy}
          onOk={() => (mode === 'dept' ? confirmDept() : submit(false))}
          okText={`${s.addDo}${resolved.length ? `（${resolved.length}）` : ''}`} />
      )}>
      <AssignModes mode={mode} onChange={setMode} />
      {mode === 'dept' && (
        <AssignCriteria
          dept={(
            <DeptFilter multiple options={tree ? tree.options : NONE} value={depts} onChange={(v) => setDepts(Array.isArray(v) ? v : [])}
              lang={lang} label={s.byDept} placeholder={s.byDeptPh} ready={!!tree} disabled={tree === null}
              showNone={!!(tree && tree.hasNone)} />
          )}
          grade={<JobGradeSelect value={grades} onChange={setGrades} ranks={ranks} inUse={gradesInUse} />} />
      )}
      {mode === 'paste' && (
        <>
          <TextArea rows={5} value={pasted} onChange={setPasted} placeholder={s.byPastePh} />
          {pasteMissing.length > 0 && (
            <div className="u-hint asg-missing">{s.pasteMissing(pasteMissing.length)}: {pasteMissing.slice(0, 8).join(', ')}{pasteMissing.length > 8 ? '…' : ''}</div>
          )}
        </>
      )}
      {mode === 'pick' && (
        <Select multiple filter style={{ width: '100%' }} value={ids} onChange={setIds} maxTagCount={6} placeholder={s.pickEmployees}
          optionList={eligible.map((r) => ({ label: `${r.name}（${r.employeeId}）`, value: r.id }))} />
      )}
      <AssignResult main={{ label: s.addWill, n: resolved.length }} items={resultItems}
        names={resolved.map((id) => nameOf.get(id) || id)} />
    </Modal>
  );
}

function MoveModal({ s, cohorts, row, onOk, onCancel }) {
  const [cohortId, setCohortId] = useState(row.cohortId);
  const [classId, setClassId] = useState(row.classId || null);
  const cohort = cohorts.find((c) => c.id === cohortId);
  return (
    <Modal title={`${s.mvTitle} · ${row.name}`} visible onCancel={onCancel} okText={s.save} cancelText={s.cancel} maskClosable={false}
      onOk={() => onOk({ cohortId, classId })}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}>{s.mvCohort}</div>
        <Select style={{ width: '100%' }} value={cohortId} onChange={(v) => { setCohortId(v); setClassId(null); }}
          optionList={cohorts.map((c) => ({ label: c.name, value: c.id }))} />
      </div>
      <div>
        <div style={{ fontSize: 13, marginBottom: 6 }}>{s.mvClass}</div>
        <Select showClear style={{ width: '100%' }} value={classId} onChange={setClassId}
          optionList={((cohort && cohort.classes) || []).map((c) => ({ label: c.name, value: c.id }))} />
      </div>
    </Modal>
  );
}

// ---------- 提名审批 ----------
function NomTab({ doc, s, loc, projectId, nomQ, reload }) {
  const { lang } = useI18n();   // CX-119：服务端带 error_zh 的按界面语言显示
  const q = nomQ; // owned by Detail — the tab label needs the count too
  const rows = q.data || [];
  const [busy, setBusy] = useState(null);
  const [rejectRow, setRejectRow] = useState(null);
  const [note, setNote] = useState('');
  const canWrite = useCanWrite();
  const decide = async (row, decision, n, force) => {
    setBusy(row.id);
    try {
      await api.post(`/api/admin/nominations/${row.id}/decide`, { decision, note: n || '', ...(force ? { force: true } : {}) });
      Toast.success(decision === 'approve' ? s.nApproved : s.nRejected);
      q.reload(); reload();
      window.dispatchEvent(new Event('tms:pending-changed'));   // CX-151
    } catch (e) {
      const d = e && e.data;
      if (e && e.status === 409 && d && d.code === 'over_capacity') {
        Modal.confirm({
          title: s.overCapTitle,
          content: s.overCapAsk(d.capacity, d.current, 1),
          okText: s.overCapOk, cancelText: s.cancel,
          onOk: () => decide(row, decision, n, true),
        });
      } else Toast.error((lang === 'zh' && d && d.error_zh) || e.message);   // CX-119
    } finally { setBusy(null); setRejectRow(null); setNote(''); }
  };
  if (q.loading) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>;
  if (!rows.length) return <Empty description={s.nomEmpty} style={{ padding: '48px 0' }} />;
  return (
    <>
      <Table rowKey="id" dataSource={rows} pagination={false}
        {...resizableTable([
          { title: s.colName, dataIndex: 'name', width: 210, render: (v, r) => <span><b>{v}</b> <Text type="tertiary" size="small" className="tnum">{r.employeeId}</Text></span> },
          { title: s.colDept, dataIndex: 'department', width: 130, render: (v) => v || '—' },
          { title: s.nCohort, dataIndex: 'cohortId', width: 140, render: (v) => (((doc.cohorts || []).find((c) => c.id === v) || {}).name) || '—' },
          { title: s.nReason, dataIndex: 'note', width: 260, render: (v) => v || <Text type="quaternary">—</Text> },
          { title: '', dataIndex: 'op', width: 210, render: (_, r) => canWrite && (
            <span style={{ display: 'flex', gap: 8 }}>
              <Button theme="solid" type="primary" size="small" icon={<IconTick />} loading={busy === r.id} onClick={() => decide(r, 'approve')}>{s.nApprove}</Button>
              <Button theme="borderless" type="danger" size="small" icon={<IconClose />} onClick={() => setRejectRow(r)}>{s.nReject}</Button>
            </span>
          ) },
        ])} />
      <Modal title={s.nRejectTitle} visible={!!rejectRow} onCancel={() => setRejectRow(null)} okText={s.nReject} cancelText={s.cancel}
        okButtonProps={{ type: 'danger', disabled: !note.trim() }} confirmLoading={!!rejectRow && busy === rejectRow.id}
        onOk={() => decide(rejectRow, 'reject', note)}>   {/* CX-113：驳回理由必填，与批量驳回同口径 */}
        <TextArea value={note} onChange={setNote} placeholder={s.nNote} rows={3} maxLength={500} />
      </Modal>
    </>
  );
}

// ---------- 项目看板 ----------
// CX-112：看板按期次查看（服务端 ?cohort=），默认今天所在的期次；没有则取最近已开始的一期，再没有取第一期。
// CX-118：四张指标卡按宽度自动换行，阶段名列在窄屏收窄，风险表在卡片内横向滚动（原来 390 宽撑破页面）。
function dashDefaultCohort(cohorts) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ymd = (v) => (v ? String(v).slice(0, 10) : '');
  const cur = cohorts.find((c) => ymd(c.startAt) && ymd(c.startAt) <= today && (!ymd(c.endAt) || today <= ymd(c.endAt)));
  if (cur) return cur.id;
  const started = cohorts.filter((c) => ymd(c.startAt) && ymd(c.startAt) <= today).sort((a, b) => ymd(a.startAt).localeCompare(ymd(b.startAt)));
  if (started.length) return started[started.length - 1].id;
  return cohorts[0] ? cohorts[0].id : null;
}
function DashTab({ s, loc, projectId, doc }) {
  const cohorts = (doc && doc.cohorts) || [];
  const [cohortId, setCohortId] = useState(() => dashDefaultCohort(cohorts));
  const cid = cohorts.some((c) => c.id === cohortId) ? cohortId : dashDefaultCohort(cohorts);
  const q = useAsync(() => api.get(`/api/admin/tprojects/${projectId}/dashboard${cid ? '?cohort=' + encodeURIComponent(cid) : ''}`), [projectId, cid]);
  const d = q.data;
  if (!cohorts.length) return <Empty description={s.dashEmpty} style={{ padding: '48px 0' }} />;
  const picker = (
    <div style={{ marginBottom: 12 }}>
      <Select value={cid} onChange={setCohortId} style={{ maxWidth: '100%' }}
        optionList={cohorts.map((c) => ({ label: s.cohortLabel(c.name), value: c.id }))} />
    </div>
  );
  if (q.loading || !d) return <div>{picker}<div style={{ padding: 40, textAlign: 'center' }}><Spin /></div></div>;
  if (!d.members) return <div>{picker}<Empty description={s.dashCohortEmpty} style={{ padding: '48px 0' }} /></div>;
  return (
    <div>
      {picker}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 16 }}>
        {[[s.kMembers, d.members], [s.kProgress, d.progressAvg + '%'], [s.kAttendance, d.attendance == null ? '—' : d.attendance + '%'], [s.kRisk, d.risks.length]].map(([lab, val], i) => (
          <div key={i} className="tp-card" style={{ cursor: 'default' }}>
            <div style={{ fontSize: 12.5, color: 'var(--semi-color-text-2)' }}>{lab}</div>
            <div className="tnum" style={{ fontSize: 26, fontWeight: 700, color: i === 3 && d.risks.length ? 'var(--semi-color-danger)' : undefined }}>{val}</div>
          </div>
        ))}
      </div>
      <div className="tp-card" style={{ cursor: 'default', marginBottom: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>{s.funnel}</div>
        {/* CX-190：无阶段的期次给空状态文案 */}
        {!d.phaseFunnel.length && <Text type="tertiary">{s.funnelEmpty}</Text>}
        {d.phaseFunnel.map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ width: 'min(150px, 32%)', flex: '0 0 auto', textAlign: 'right', fontSize: 12.5, color: 'var(--semi-color-text-1)', overflowWrap: 'anywhere' }}>{loc(p, 'name')}</span>
            <div style={{ flex: 1, height: 14, background: 'var(--semi-color-fill-0)', borderRadius: 4, overflow: 'hidden' }}>
              <i style={{ display: 'block', height: '100%', width: `${p.total ? (p.done / p.total) * 100 : 0}%`, background: 'var(--semi-color-primary)', borderRadius: 4 }} />
            </div>
            <span className="tnum" style={{ width: 70, fontSize: 12.5 }}>{p.done} / {p.total}</span>
          </div>
        ))}
      </div>
      <div className="tp-card" style={{ cursor: 'default' }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>{s.riskList}</div>
        {d.risks.length === 0 ? <Text type="tertiary">{s.noRisk}</Text> : (
          <Table size="small" rowKey={(r) => r.employeeId + '|' + r.activityId + '|' + r.dueAt} dataSource={d.risks} pagination={false} scroll={{ x: 620 }}
            {...resizableTable([
              { title: s.colName, dataIndex: 'name', width: 200, render: (v, r) => <span>{v} <Text type="tertiary" size="small" className="tnum">{r.employeeId}</Text></span> },
              // 事项名按语言取（item / item_zh）；没有名称时显示活动类别，不再露出 course / exam 这类内部类型键
              { title: s.riskItem, dataIndex: 'item', width: 300, render: (v, r) => loc(r, 'item') || s.actTypeLabel[r.category] || '—' },
              { title: s.riskDue, dataIndex: 'dueAt', width: 120, render: (v) => <Tag color="red" type="light">{v}</Tag> },
            ])} />
        )}
      </div>
    </div>
  );
}

// ---------- 设置 ----------
function SetTab({ doc, s, saveDoc, stLabel }) {
  const formApi = useRef(null); // ref, not a local — doc reloads re-render this tab
  const canWrite = useCanWrite();
  return (
    <div className="tp-card" style={{ cursor: 'default', maxWidth: 620 }}>
      <Form getFormApi={(a) => { formApi.current = a; }} labelPosition="top"
        initValues={{ title_zh: doc.title_zh, title: doc.title, category: doc.category, sponsor: doc.sponsor, status: doc.status, description_zh: doc.description_zh, description: doc.description }}>
        <Form.Input field="title_zh" label={s.fTitleZh} />
        <Form.Input field="title" label={s.fTitleEn} />
        <Form.Input field="category" label={s.fCategory} />
        <Form.Input field="sponsor" label={s.fSponsor} />
        <Form.TextArea field="description_zh" label={s.fDescZh} autosize rows={2} />
        <Form.TextArea field="description" label={s.fDescEn} autosize rows={2} />
        <Form.Select field="status" label={s.fStatus} style={{ width: '100%' }}
          optionList={['draft', 'planning', 'running', 'closing', 'closed'].map((v) => ({ label: stLabel(v), value: v }))} />
        {/* Spell out what each state actually does — the labels alone were
            ambiguous ("筹备中 vs 进行中?"). */}
        <div className="tp-fieldhelp">
          <b>{s.stHelpTitle}</b>
          {['draft', 'planning', 'running', 'closing', 'closed'].map((k) => <div key={k}>· {s.stHelp[k]}</div>)}
          <div style={{ marginTop: 6 }}>{s.stRemindNote}</div>
        </div>
      </Form>
      {canWrite ? (
        <Button theme="solid" type="primary" style={{ marginTop: 14 }}
          onClick={() => formApi.current && formApi.current.validate().then((v) => {
            if (!v.title && !v.title_zh) { Toast.warning(s.reqTitle); return; }
            const patch = { ...v, title: v.title || v.title_zh };
            // 已关闭的项目是只读记录：服务器只接受「单独改状态」把它重新打开，同一请求里带名称、描述等字段会被拒（409 closed）。
            // 设置页总是整表提交，所以改回其他状态时先单独提交状态，成功后再保存其余字段（负责人 2026-10-06 报：改回进行中保存不了）。
            if (doc.status === 'closed' && v.status && v.status !== 'closed') {
              api.put(`/api/admin/tprojects/${doc.id}`, { status: v.status })
                .then(() => saveDoc(patch, s.updated))
                .catch((e) => Toast.error((e && e.message) || String(e)));
              return;
            }
            saveDoc(patch, s.updated);
          }).catch(() => {})}>{s.save}</Button>
      ) : (
        <div className="tp-fieldhelp" style={{ marginTop: 14 }}>{s.roWrite}</div>
      )}
    </div>
  );
}
