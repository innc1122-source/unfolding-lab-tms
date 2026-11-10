// Talent profile 人才档案 — one person, whole development trajectory.
// Reached from Employees (click a name). Identity card + tags/potential +
// stats + filterable timeline (config-driven fields) + record editor + AI
// portrait. Everything renders from the server's field config, so HR-added
// fields appear here with zero code changes.
import { useEffect, useMemo, useRef, useState } from 'react';
import PortraitCard from '../../components/PortraitCard.jsx';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, Input, TextArea, InputNumber, Select, DatePicker, Checkbox, Modal,
  Form, Tag, Space, Toast, Banner, Spin, Empty, Popconfirm, Typography, Avatar, Tooltip,
} from '@douyinfe/semi-ui';
import { IconPlus, IconEdit, IconDownload, IconArrowLeft, IconRefresh } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { date as fmtDate, datetime as fmtDateTime } from '../../fmt.js';
import { useAuth } from '../../auth.jsx';
import { canWriteDomain, canReadDomain, canUseAccounts, canUseRoles, isDomainReadOnly, isSuperAdmin, modOn } from '../../rbac.js';
import { errText } from '../../apierr.js';
import { useI18n } from '../../i18n.jsx';
import { ProfileTabs } from '../../profileTabs.js';
import { localDay } from '../../deptcal.js';
import { invalidateDeptTree } from '../../deptfilter.js';
import { IcWarn } from '../../components/LineIcons.jsx';
// 12.2 受控人才标签（高潜 / 关键人才 / 流失风险）：白名单在 web/src/controlledTags.js，界面在 ControlledTags.jsx
import {
  ControlledTagPills, ControlledTagsEditor, TagEventBody, tagEventTitle, controlledTagText, splitTags, reservedKeyOf,
} from './ControlledTags.jsx';

const { Text } = Typography;

const T = {
  zh: {
    back: '返回员工档案',
    hired: '入职', tenure: '司龄', lastLogin: '最近登录', never: '从未',
    stTrain: '课程通过', stAward: '荣誉', stViol: '违纪', stPromo: '晋升',
    probation: '试用期', regular: '正式', exited: '已离职', deactivated: '已停用', hr: 'HR',
    edit: '编辑资料', editRec: '编辑', addRecord: '添加记录', exportCsv: '导出 CSV', fields: '档案与职级设置',
    recRequired: '必填', recFixFields: '请先补全标红的必填字段',
    eRequired: (n) => `「${n}」是必填项`,
    eNumber: (n) => `「${n}」需要填数字`,
    eDate: (n) => `「${n}」的格式应为 YYYY-MM-DD`,
    eOption: (n, v) => `「${n}」不接受「${v}」——请从配置好的选项里选`,
    slTitle: '汇报关系', slSolid: '实线上级', slNoSolid: '未设置（顶层）', slDotted: '虚线上级', slConcurrent: '兼任岗位',
    slMatrixTeam: '矩阵团队', slEmpty: '除实线上级外，暂无虚线汇报或兼任岗位。',
    // slAdd* titles the dialog; slBtn* labels the card-head buttons, where the + icon already says "add".
    slAddDotted: '加虚线汇报', slAddConcurrent: '加兼任岗位',
    slBtnDotted: '虚线上级', slBtnConc: '兼任',
    slDottedHint: '虚线汇报为矩阵关系：业务上也向此人汇报，实线上级不变。绩效评估仍由实线上级负责面谈与评级。',
    slConcHint: '兼任=一人多岗：除本职外还担任的岗位，可另属部门、可另有上级。',
    slMgr: '虚线上级', slMgrOptional: '该岗位上级（选填）', slPosition: '兼任岗位', slPositionPh: '如 反洗钱专员（兼）',
    slDept: '所属部门', slScope: '汇报范围（选填）', slScopePh: '如 合规事务 / 区域项目',
    slNote: '备注（选填）', slNotePh: '如 2026-Q3 起，项目期内有效',
    slNeedMgr: '请选择虚线上级', slNeedPos: '请填写兼任岗位', slDelAsk: '删除这条汇报关系？',
    tlTitle: '成长轨迹', all: '全部', auto: 'AUTO', noEvents: '没有符合筛选条件的记录',
    tabTl: '成长轨迹', tabAi: 'AI 人才画像', tabLearn: '学习记录', tabRel: '汇报关系',
    lmTitle: '学习记录', lmNone: '还没有培训活动 — 指派培训后进度自动汇入这里。',
    boxTitle: '人才定位', boxPos: '九宫格位置', boxLink: '在人才盘点里查看',
    boxPerf: '绩效', boxPot: '潜力', boxLv: ['低', '中', '高'],
    potNames: { High: '高', Medium: '中', Low: '低' },
    boxNone: '未定位', boxMissPerf: '缺绩效评级', boxMissPot: '缺潜力评级',
    boxHint: '绩效与潜力两个维度都有数据后才进入九宫格：绩效取最近一条绩效记录的评级（按「档案与职级设置」中的选项顺序分高、中、低），潜力在「编辑资料」中设置。',
    boxCells: [
      ['绩效待改进', '稳定贡献', '岗位绩效突出'],
      ['表现不稳定', '核心贡献', '高绩效'],
      ['潜力待发挥', '高潜力', '高潜力、高绩效'],
    ],
    aiTitle: 'AI 人才画像', aiGen: '生成', aiDemo: '演示模式 — 配置 API key 后为真实 AI 生成',
    aiReady: '晋升准备度',
    synced: '已同步到员工主数据',
    syncedLevel: '已同步职级到档案', syncedDept: '已同步部门到档案',
    syncedRegular: '已将人员状态同步为「正式」。', syncedExit: '已将人员状态同步为「已离职」，账号已停用。',
    // 措辞只陈述**这条记录**做了什么,不断言员工现在是什么状态 —— 同一条记录先存
    // 「按期转正」(同步成功) 再改成「延期转正」时,员工确实已经是正式,
    // 写成「未同步员工状态」就是假话。
    notSynced: '本条记录未触发主数据同步',
    notSyncedLevel: '本条记录未同步职级——勾了同步，但结果或新职级不满足条件',
    notSyncedDept: '本条记录未同步部门——勾了同步，但没填新部门',
    notSyncedRegular: '本条记录未同步员工状态——勾了同步，但结果不是「按期转正」',
    whyNoLevel: '未填「新职级」——本次保存不会同步档案里的职级',
    whyPromoFail: '结果不是「通过」——本次保存不会同步档案里的职级',
    whyNoDept: '未填「新部门」——本次保存不会同步档案里的部门',
    whyNotOnTime: '结果不是「按期转正」——本次保存不会把员工状态改成「正式」。等实际转正时再补一条「按期转正」的记录',
    lmsProgress: '进度', lmsBest: '最好成绩', lmsRank: '同期排名', lmsBlur: '切屏', lmsPass: '通过', lmsFail: '未通过',
    recNew: '添加记录', recEdit: '编辑记录', recType: '类型', recDate: '日期', recTitle: '标题', recTitlePh: '留空自动生成',
    save: '保存', cancel: '取消', saved: '已保存', deleted: '已删除',
    delRecord: '删除该记录？', delRecordDesc: '已同步过的职级/部门/状态不会回滚（现状与历史分离）。', delete: '删除',
    tenureFmt: (y, m) => (y ? `${y} 年 ${m} 个月` : `${m} 个月`),
    fName: '姓名', fDept: '部门', fPos: '职位', fLevel: '职级', fHire: '入职日期', fStatus: '员工状态', fManager: '直属上级', mgrLabel: '直属上级',
    fRole: '账号类型', fActive: '账号状态', fAdminRole: '后台角色', adminRoleNone: '无（普通员工）',
    adminRoleHint: '后台角色决定此人在后台能看/能改什么（在「角色与授权」页定义）。「账号类型」选超级管理员 = 全部权限；给某个角色时账号类型保持「员工」即可。', fTags: '其他标签', fTagsPh: '选择或输入自定义标签，回车确认',
    fPotential: '潜力评级', potShort: '潜力', roleEmp: '员工', roleAdmin: '超级管理员',
    editTitle: '编辑资料', reqName: '姓名不能为空', filterHint: '筛选',
    // 编辑资料整页（2026-10-07，原侧边抽屉改为 #/admin/people/:id?edit=1）
    backProfile: '返回档案', unsaved: '有未保存的修改', fEmpId: '工号',
    discardTitle: '放弃未保存的修改？', discardAsk: '资料有未保存的修改，离开后会丢失。', discardOk: '放弃修改',
    secBasic: '基本信息', secTalent: '人才信息', secCustom: '其他字段', secAccount: '账号与权限',
    loadFail: '加载失败，请刷新页面重试。',
    notFoundProfile: '该员工不存在，或不在你的数据范围内。',
    // 控件显隐看它**实际调用的那个接口**属哪个能力域(查 RBAC-ROUTE-MATRIX.md),
    // 不是看它长在哪一页。本页是「员工与组织」域,但 AI 画像打的是人才发展域的写接口,
    // 角色/账号可用两个字段是账号域的权力 —— 下面几行解释「为什么这里少了个按钮」。
    hintReadOnly: '你对「员工与组织」只有查看权限：编辑资料、记录的增删改与汇报关系维护已隐藏。',
    acctFieldsSuperOnly: '「角色」与「账号可用」需要相应权限，此处不显示；其余资料照常保存。',
    roleSuperOnly: '「角色」仅超级管理员可修改，此处不显示；「账号可用」可正常修改。',
    potFieldsTalentOnly: '「潜力评级」与「人才标签」属人才发展域，需要该域的管理权限，此处不显示；其余资料照常保存。',
    // 模块页签（web/src/profileTabs.js）：tablist 的无障碍名 / 占位 / 加载中 / 出错。
    tabsLabel: '模块页签', tabSoon: '该模块内容即将上线', tabLoading: '加载中…',
    tabFailed: '这个页签加载失败，请刷新页面重试',
    // 第二批 2.6（周期关闭后修改档案评级）与 2.4（潜力评定日期），10/8
    ratingReason: '修改理由（必填，写入审计，员工不可见）', ratingReasonPh: '例如：申诉复核后调整',
    amended: (x) => `已改动（原评级 ${x}）`,
    amendBy: (name, date, reason) => `${name} 于 ${date} 修改：${reason}`,
    amendCount: (n) => `共修改 ${n} 次`,
    e_rating_reason_required: '修改评级须填写理由（不超过 1000 字）。',
    e_record_type_locked: '该记录由评估周期归档，不能更改类型。',
    e_record_from_review_cycle: '该记录由评估周期归档，不能删除；如需更正评级，请编辑并写明理由。',
    e_period_has_cycle_record: '此人这一期已有评估周期归档的绩效记录，请编辑原记录并写明理由，不要另建一条。',
    potentialAt: (d) => `评定于 ${d}`, potentialNoDate: '评定日期不详',
  },
  en: {
    back: 'Back to Employee Profiles',
    hired: 'Hired', tenure: 'Tenure', lastLogin: 'Last login', never: 'never',
    stTrain: 'Courses passed', stAward: 'Awards', stViol: 'Disciplinary records', stPromo: 'Promotions',
    probation: 'Probation', regular: 'Regular', exited: 'Separated', deactivated: 'Deactivated', hr: 'HR',
    edit: 'Edit info', editRec: 'Edit', addRecord: 'Add record', exportCsv: 'Export CSV', fields: 'Field settings',
    recRequired: 'Required', recFixFields: 'Fill in the highlighted required fields',
    eRequired: (n) => `"${n}" is required`,
    eNumber: (n) => `"${n}" must be a number`,
    eDate: (n) => `"${n}" must look like YYYY-MM-DD`,
    eOption: (n, v) => `"${v}" is not one of the options configured for "${n}"`,
    slTitle: 'Reporting Lines', slSolid: 'Solid-line manager', slNoSolid: 'Not set (top level)', slDotted: 'Dotted-line manager', slConcurrent: 'Concurrent post',
    slMatrixTeam: 'Matrix team', slEmpty: 'No dotted lines or concurrent posts beyond the solid-line manager.',
    slAddDotted: 'Add dotted line', slAddConcurrent: 'Add concurrent post',
    slBtnDotted: 'Dotted line', slBtnConc: 'Concurrent',
    slDottedHint: 'Dotted-line reporting is a matrix relationship: the employee also reports to this person on the work, while the solid-line manager stays the same. The solid-line manager still holds the review conversation and gives the rating.',
    slConcHint: 'A concurrent post is a second role held alongside the main one — it can sit in another department and have its own manager.',
    slMgr: 'Dotted-line manager', slMgrOptional: 'Manager for this post (optional)', slPosition: 'Concurrent post', slPositionPh: 'e.g. AML Officer (concurrent)',
    slDept: 'Department', slScope: 'Scope (optional)', slScopePh: 'e.g. Compliance matters / regional project',
    slNote: 'Note (optional)', slNotePh: 'e.g. from 2026-Q3, for the project duration',
    slNeedMgr: 'Pick a dotted-line manager', slNeedPos: 'Enter the concurrent post', slDelAsk: 'Remove this relationship?',
    tlTitle: 'Growth Timeline', all: 'All', auto: 'AUTO', noEvents: 'No records match the filter.',
    tabTl: 'Growth Timeline', tabAi: 'AI Talent Insights', tabLearn: 'Learning Record', tabRel: 'Reporting Lines',
    lmTitle: 'Learning Record', lmNone: 'No training activity yet — assigned programs report their progress here.',
    boxTitle: 'Talent position', boxPos: '9-box position', boxLink: 'Open in talent review',
    boxPerf: 'Performance', boxPot: 'Potential', boxLv: ['Low', 'Mid', 'High'],
    potNames: { High: 'High', Medium: 'Mid', Low: 'Low' },
    boxNone: 'Not placed', boxMissPerf: 'No performance rating', boxMissPot: 'No potential rating',
    boxHint: 'Both axes need data before the employee is placed on the 9-box: performance uses the latest performance record’s rating (bucketed by the option order in Profile & Job Level Settings); potential is set in Edit Info.',
    boxCells: [
      ['Performance Needs Improvement', 'Steady Contribution', 'Strong Performance in Current Role'],
      ['Inconsistent Performance', 'Core Contribution', 'High Performance'],
      ['Unrealized Potential', 'High Potential', 'High Potential, High Performance'],
    ],
    aiTitle: 'AI Talent Portrait', aiGen: 'Generate', aiDemo: 'Demo mode — add an API key for real AI output',
    aiReady: 'Promotion Readiness',
    synced: 'Synced to employee master data',
    syncedLevel: 'Job level synced to the profile', syncedDept: 'Department synced to the profile',
    syncedRegular: 'Employment status set to Regular.', syncedExit: 'Employment status set to Separated; account deactivated.',
    notSynced: 'This record did not trigger a master-data sync',
    notSyncedLevel: 'This record did not sync the job level — sync was ticked, but the result or the new level did not qualify',
    notSyncedDept: 'This record did not sync the department — sync was ticked, but no new department was recorded',
    notSyncedRegular: 'This record did not sync the employment status — sync was ticked, but the result was not "On time"',
    whyNoLevel: 'No new level picked — this save will not sync the job level to the profile',
    whyPromoFail: 'The result is not a pass — this save will not sync the job level to the profile',
    whyNoDept: 'No new department picked — this save will not sync the department to the profile',
    whyNotOnTime: 'The result is not "On time" — this save will not set the status to Regular. Add a fresh "On time" record when the person is actually made regular',
    lmsProgress: 'Progress', lmsBest: 'Best score', lmsRank: 'Cohort rank', lmsBlur: 'tab-switch', lmsPass: 'Passed', lmsFail: 'Not passed',
    recNew: 'Add record', recEdit: 'Edit record', recType: 'Type', recDate: 'Date', recTitle: 'Title', recTitlePh: 'Leave empty to auto-generate',
    save: 'Save', cancel: 'Cancel', saved: 'Saved', deleted: 'Deleted',
    delRecord: 'Delete this record?', delRecordDesc: 'Synced level/department/status will NOT be reverted.', delete: 'Delete',
    tenureFmt: (y, m) => (y ? `${y} yr ${m} mo` : `${m} mo`),
    fName: 'Full name', fDept: 'Department', fPos: 'Position', fLevel: 'Job level', fHire: 'Hire date', fStatus: 'Employment status', fManager: 'Manager', mgrLabel: 'Manager',
    fRole: 'Account type', fActive: 'Account status', fAdminRole: 'Admin role', adminRoleNone: 'None (regular employee)',
    adminRoleHint: 'The admin role decides what this person can see and change in the console (defined under Roles & Access). Account type "Super Admin" = everything; for a specific role keep the account type as Employee.', fTags: 'Other tags', fTagsPh: 'Pick or type custom tags, Enter to confirm',
    fPotential: 'Potential', potShort: 'Potential', roleEmp: 'Employee', roleAdmin: 'Super Admin',
    editTitle: 'Edit info', reqName: 'Name is required', filterHint: 'Filter',
    backProfile: 'Back to profile', unsaved: 'Unsaved changes', fEmpId: 'Employee ID',
    discardTitle: 'Discard unsaved changes?', discardAsk: 'This profile has unsaved changes that will be lost if you leave.', discardOk: 'Discard',
    secBasic: 'Basic information', secTalent: 'Talent', secCustom: 'Other fields', secAccount: 'Account and access',
    loadFail: 'Couldn’t load. Refresh the page to try again.',
    notFoundProfile: 'This employee doesn’t exist or is outside your data scope.',
    hintReadOnly: 'You have view-only rights on Employees & org: editing info, adding/editing/deleting records and maintaining reporting lines are hidden.',
    acctFieldsSuperOnly: 'Role and account status need the corresponding permissions and are not shown here. Everything else saves normally.',
    roleSuperOnly: 'Role can only be changed by a super-admin, so it is not shown here; account status can still be changed.',
    potFieldsTalentOnly: 'Potential and talent tags belong to the talent domain and need manage rights there, so they are not shown here. Everything else saves normally.',
    tabsLabel: 'Module tabs', tabSoon: 'Content for this module is coming soon', tabLoading: 'Loading…',
    tabFailed: 'This tab failed to load — refresh the page to try again',
    ratingReason: 'Reason for the change (required; recorded in the audit log, not shown to the employee)', ratingReasonPh: 'e.g. Adjusted after the appeal review',
    amended: (x) => `Changed (was ${x})`,
    amendBy: (name, date, reason) => `Changed by ${name} on ${date}: ${reason}`,
    amendCount: (n) => `Changed ${n} times in total`,
    e_rating_reason_required: 'Give a reason for changing the rating (up to 1,000 characters).',
    e_record_type_locked: 'This record was archived from a review cycle; its type can’t be changed.',
    e_record_from_review_cycle: 'This record was archived from a review cycle and can’t be deleted. To correct the rating, edit it and give a reason.',
    e_period_has_cycle_record: 'This person already has a performance record for this period, archived from a review cycle. Edit that record and give a reason instead of adding another.',
    potentialAt: (d) => `Assessed ${d}`, potentialNoDate: 'Assessment date unknown',
  },
};

// 自由标签的预设。高潜 / 关键人才 / 流失风险是受控标签（12.2），只能在「受控人才标签」区逐个打上或取消，不再出现在这里。
const PRESET_TAGS = ['继任候选 Successor'];
// Module-tab section styling (<ProfileTabs>): this page's card, card heading and timeline chips.
const TAB_CLS = { wrap: 'ppl-card', head: 'ppl-sec-h', bar: 'ppl-filters', tab: 'ppl-chip', on: 'on', empty: 'ml-empty' };
const STATUS_TAG = { probation: 'blue', regular: 'green', exited: 'grey' };
// A synced lifecycle record says WHAT it wrote to the master data — the other
// half of server.js applyRecordSideEffects (晋级→职级, 调动→部门, 转正/离职→状态).
// Types outside this map fall back to the generic line.
const SYNC_MSG = { promotion: 'syncedLevel', transfer: 'syncedDept', regularization: 'syncedRegular', exit: 'syncedExit' };

/* ---- will a ticked 同步 checkbox actually write through? ----
   server.js applyRecordSideEffects only touches the master data when the rest of
   the record qualifies too: 晋级 needs a new level AND a passing result, 调动 needs
   a new department, 转正 needs 按期转正 (延期转正 means not regular YET — a later
   record carries the real thing). Tick the box without that and the save still
   succeeds while the profile stays put, so HR walks away believing the person was
   made regular. The same rules are restated here to warn BEFORE the save and to
   explain the silence afterwards on the timeline.
   Judged on the STORED value, never on the label — same reason as the tone
   colouring in eventBody below: the label follows the UI language, the meaning of
   通过/未通过 does not.
   PASS_RE must stay character-for-character identical to the passOk regex in
   server.js. The two sit on opposite sides of the wire with no shared module, so
   editing one silently desyncs the hint from the behaviour it describes —
   test/sync-hint.test.js pins them together. */
const PASS_RE = /通过|passed|按期|on time/i;
const FAIL_RE = /未通过|failed/i;
const passOk = (v) => PASS_RE.test(String(v || '')) && !FAIL_RE.test(String(v || ''));
// Which checkbox carries the sync for each type, and what the timeline says when
// that box was ticked but nothing was written. 离职 always syncs once ticked, so it
// needs no "not synced" line of its own and falls back to the generic one.
const SYNC_FIELD = { promotion: 'syncLevel', transfer: 'syncDept', regularization: 'syncStatus', exit: 'syncStatus' };
const NOSYNC_MSG = { promotion: 'notSyncedLevel', transfer: 'notSyncedDept', regularization: 'notSyncedRegular' };
// Ticked but blocked → the T key that says why; null when this save really will
// write through, or when the box is not ticked at all — an untouched form has to
// stay quiet or the hint is just noise.
function syncBlockedWhy(typeKey, detail) {
  const key = SYNC_FIELD[typeKey];
  if (!key || !detail || !detail[key]) return null;
  if (typeKey === 'promotion') return !detail.toLevel ? 'whyNoLevel' : passOk(detail.result) ? null : 'whyPromoFail';
  if (typeKey === 'transfer') return detail.toDept ? null : 'whyNoDept';
  if (typeKey === 'regularization') return passOk(detail.result) ? null : 'whyNotOnTime';
  return null;
}

/* ---- 9-box placement (人才定位) ----
   Deliberately the SAME rule as the grid on 人才盘点 (server.js perfBucketOf):
   the performance bucket is the rating's POSITION in the configured options
   list — top third = high — so renaming or reordering the scale in 字段设置
   moves this card with it instead of drifting from the grid it links to. */
const POT_BUCKET = { High: 2, Medium: 1, Low: 0 };
// tone by [potential][performance], matching TalentReview's cell tones.
const BOX_TONE = [
  ['bad', 'mid', 'mid'],
  ['mid', 'mid', 'good'],
  ['mid', 'good', 'star'],
];
function perfBucketOf(rating, options) {
  if (!rating || !options || !options.length) return null;
  const i = options.indexOf(String(rating));
  if (i === -1) return null;
  const third = options.length / 3;
  return i < third ? 2 : i < 2 * third ? 1 : 0; // 2=high 1=mid 0=low
}

function tenureOf(hireDate, fmt) {
  if (!hireDate) return null;
  const h = new Date(hireDate + 'T00:00:00');
  if (Number.isNaN(h.getTime()) || h > new Date()) return null;
  const months = Math.floor((Date.now() - h.getTime()) / (30.44 * 86400000));
  return fmt(Math.floor(months / 12), months % 12);
}
function toDateStr(d) {
  if (!d) return '';
  if (typeof d === 'string') return fmtDate(d);   // 一致性整改 3
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0][0] || '') + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

/* ---- select/suggest options are a PAIR ----
   record_fields.options[i] is the value stored in talent_records.detail (and the
   English display name); options_zh[i] is a display name only. So a dropdown
   LABELS in the current language and always SUBMITS options[i], and anything
   read back out of detail is mapped from the stored value to a label.
   Modelled as a {value, value_zh} object so the choice runs through loc() — the
   project's single localization rule — instead of a second one living here. */
const optPair = (f, i) => {
  const value = (f.options || [])[i];
  const zh = (f.options_zh || [])[i];
  // per ITEM, not per array: a missing or short options_zh must fall back to
  // English on those items rather than shift every label by one
  return { value, value_zh: zh || value };
};
const optionList = (f, loc) => (f.options || []).map((_, i) => {
  const o = optPair(f, i);
  return { label: loc(o, 'value'), value: o.value };
});
// Stored value → label for the current language. A value that is not in options
// (a legacy row, or free text typed into a suggest field) prints exactly as it
// was stored instead of vanishing.
const optLabel = (f, v, loc) => {
  const i = (f.options || []).indexOf(String(v));
  return i === -1 ? String(v) : loc(optPair(f, i), 'value');
};

// One config-driven input. `f` is a record_fields row; controlled via vals/setVal.
// `cat` = live catalogs {jobRanks, departments} for the level/department types
// (职级和部门是"调取",不是文本 — always picked from the managed catalogs).
// `loc` is threaded in (not read from useI18n here) to match how `s` / `cat`
// flow down in this file; the checkbox variant is the one that prints f.label.
function FieldInput({ f, value, onChange, cat, loc }) {
  const w = { width: '100%' };
  if (f.input === 'number') return <InputNumber style={w} value={value ?? ''} onChange={(v) => onChange(v === '' || v === null ? undefined : v)} />;
  if (f.input === 'date') return <DatePicker style={w} value={value || undefined} onChange={(d) => onChange(toDateStr(d) || undefined)} />;
  if (f.input === 'level') return <Select style={w} filter showClear value={value || undefined} onChange={(v) => onChange(v || undefined)}
    optionList={((cat && cat.jobRanks) || []).map((r) => ({ label: `${r.rank} · ${r.grade} / L${r.level}`, value: r.rank }))} />;
  if (f.input === 'department') return <Select style={w} filter showClear value={value || undefined} onChange={(v) => onChange(v || undefined)}
    optionList={((cat && cat.departments) || []).map((d) => ({ label: d, value: d }))} />;
  // label in the current language, value always canonical — which is also what
  // makes editing an existing record work: detail holds options[i], so Semi
  // matches the option by value and shows whichever label the UI is set to.
  if (f.input === 'select') return <Select style={w} showClear value={value || undefined} onChange={(v) => onChange(v || undefined)} optionList={optionList(f, loc)} />;
  // allowCreate: a typed-in value has no pair, so it stays its own label
  if (f.input === 'suggest') return <Select style={w} filter allowCreate showClear value={value || undefined} onChange={(v) => onChange(v || undefined)} optionList={optionList(f, loc)} />;
  if (f.input === 'textarea') return <TextArea rows={2} value={value || ''} onChange={(v) => onChange(v || undefined)} />;
  if (f.input === 'checkbox') return <Checkbox checked={!!value} onChange={(e) => onChange(e.target.checked || undefined)}>{loc(f, 'label')}</Checkbox>;
  return <Input value={value || ''} onChange={(v) => onChange(v || undefined)} />;
}

export default function People() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { lang, loc } = useI18n();
  const s = T[lang];
  // Module switches from the /api/me payload (`me`, not `u` — u is the person
  // whose profile this is). No `modules` = older server = everything on.
  const { user: me } = useAuth();
  const mods = me && me.modules;
  const learningOn = modOn(mods, 'learning');
  const talentOn = modOn(mods, 'talent');
  // 10/11 负责人定：AI 人才画像页签要 talent 与 ai 两个模块都开启才出现（ai 关闭时整个页签不显示，含已确认的历史画像）
  const portraitOn = talentOn && modOn(mods, 'ai');
  // RBAC: each control is judged by the endpoint IT calls, not by this page's
  // domain. This page is people, but AI 画像 posts to a talent-domain write and
  // the 角色 / 账号可用 fields on the edit page are accounts-domain power.
  //   people 写   → 编辑资料, 记录增删改, 虚线/兼任汇报关系
  //   talent 写   → AI 画像, 潜力评级, 人才标签   (module switch stacked on top)
  //   roles       → 角色 (role) —— 恒超管 (提权面, canUseRoles)
  //   accounts    → 账号可用 (active) —— accounts=manage (D6: 可授予、受范围约束)
  // No grants block (older server) → everything reads as manage, unchanged UI.
  const canWritePeople = canWriteDomain(me, 'people');
  const peopleReadOnly = isDomainReadOnly(me, 'people');
  const canWriteTalent = canWriteDomain(me, 'talent');
  // 「在人才盘点里查看 →」跳的是 /admin/talent-review(talent 域):talent=none 的角色
  // (如 HRBP)点了会被 App.jsx 的按域守卫弹回工作台 —— 跨域读控件,需 talent>=read。
  const canReadTalent = canReadDomain(me, 'talent');
  const canAccounts = canUseAccounts(me);
  const canRoles = canUseRoles(me);
  const talentWrite = talentOn && canWriteTalent;
  // 本人查看自己的后台档案（非超级管理员）：不显示自己的「流失风险」标签与相关时间线事件（REQ 12.3）
  const selfView = !!(me && String(me.id) === String(id) && !isSuperAdmin(me));
  const ctS = controlledTagText(lang);

  const profQ = useAsync(() => api.get(`/api/admin/employees/${id}/profile`), [id]);
  const p = profQ.data;

  const [tlType, setTlType] = useState('all');
  const [tlFF, setTlFF] = useState({});
  // Phone-only section switch (轨迹 / AI 画像 / 学习 / 汇报). Desktop lays the same
  // four cards out in two columns and never sees the tab bar — see .ppl-tabs in
  // app.css — so this state simply has no effect above the breakpoint.
  const [tab, setTab] = useState('tl');
  const [recModal, setRecModal] = useState(null);   // {record|null} — null closed, {editing} open
  const [saving, setSaving] = useState(false);

  // 编辑资料整页（2026-10-07，负责人「短操作弹窗、长编辑整页」，同培训模块）：地址栏是唯一事实源，
  // #/admin/people/:id?edit=1 打开、去掉参数回到档案；浏览器后退回档案。没有「员工与组织」写权限时
  // 忽略这个参数并把它从地址栏去掉（档案页上照常显示只读说明 hintReadOnly）。
  // 这里的 hook 都必须写在下面任何提前 return 之前。
  const [searchParams, setSearchParams] = useSearchParams();
  const editAsked = searchParams.get('edit') === '1';
  const editOpen = canWritePeople && editAsked;
  useEffect(() => {
    if (editAsked && !canWritePeople) setSearchParams({}, { replace: true });
  }, [editAsked, canWritePeople]); // eslint-disable-line react-hooks/exhaustive-deps
  // 进整页从顶部开始；回到档案时滚回进入前的位置（时间线等页内状态本来就保留，组件没有卸载）
  const listScroll = useRef(null);
  useEffect(() => {
    if (editOpen) { try { window.scrollTo(0, 0); } catch { /* no window */ } return; }
    if (listScroll.current != null) {
      const y = listScroll.current;
      listScroll.current = null;
      try { window.scrollTo(0, y); } catch { /* no window */ }
    }
  }, [editOpen]);
  const openEdit = () => { try { listScroll.current = window.scrollY || 0; } catch { /* no window */ } setSearchParams({ edit: '1' }); };

  const types = useMemo(() => (p ? p.config.types.filter((t) => t.active) : []), [p]);
  // moduleOff：所属模块未开启的类型（例如 culture 关闭时的「行为实践」，服务端 recordTypesOut 标出）。不出现在新建记录的
  // 类型选择里（服务端同样拒绝新建）；已有记录照常显示 —— 这个人有该类型的记录时，时间线筛选里也照常有它。
  const newTypes = useMemo(() => types.filter((t) => !t.moduleOff), [types]);
  const chipTypes = useMemo(
    () => types.filter((t) => !t.moduleOff || (p && p.events.some((e) => e.source === 'record' && e.type === t.key))),
    [types, p],
  );
  // 入职 is a derived milestone, not a configurable record type, so its label is
  // local. One language per UI — the zh branch used to read "入职 Hired".
  const typeMeta = (key) => (key === 'hired'
    ? { label: lang === 'zh' ? '入职' : 'Hired', icon: '', color: '#00a2c8' }
    : key === 'tag'
    ? { label: ctS.tlType, icon: '', color: '#6355d9' }
    : p.config.types.find((t) => t.key === key) || { label: key, icon: '', color: '#86909c' });
  const activeFields = (typeKey) => p.config.fields.filter((f) => f.typeKey === typeKey && f.active);

  const events = useMemo(() => {
    if (!p) return [];
    let list = p.events.filter((e) => (tlType === 'all' || e.type === tlType) && !(selfView && e.source === 'tag' && e.tagKey === 'flight'));
    const keys = Object.keys(tlFF).filter((k) => tlFF[k]);
    if (keys.length) list = list.filter((e) => e.source === 'record' && keys.every((k) => String(e.detail[k] ?? '') === tlFF[k]));
    return list;
  }, [p, tlType, tlFF, selfView]);

  // CX-082（10/11 上线前测试）：404 = 不存在或不在范围内（服务端故意不区分）—— 不提示刷新、不夹服务端英文，给返回员工档案的入口
  if (profQ.error) return (
    <div className="wrap ppl-wrap">
      <Button icon={<IconArrowLeft />} theme="borderless" onClick={() => navigate('/admin/employees')} className="ppl-back">{s.back}</Button>
      <Banner type={profQ.error.status === 404 ? 'warning' : 'danger'} closeIcon={null} description={profQ.error.status === 404 ? s.notFoundProfile : s.loadFail} />
    </div>
  );
  if (!p) return <div className="wrap ppl-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;

  const u = p.user;
  if (editOpen) {
    // useAsync 换人时保留旧数据：还没拿到这个人的档案前不渲染表单，免得用上一个人的资料初始化
    if (String(u.id) !== String(id)) return <div className="wrap ppl-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;
    return (
      <EditPage key={u.id} s={s} loc={loc} lang={lang} u={u} suggestions={p.suggestions} userFields={activeFields('user')}
        talentOn={talentOn} talentWrite={talentWrite} canAccounts={canAccounts} canRoles={canRoles}
        selfView={selfView} onTagsChanged={() => profQ.reload()}
        onLeave={() => setSearchParams({})}
        /* 保存成功：总是刷新档案；还停留在本页时才回档案，并用 replace —— 浏览器后退不会再回到已保存过的编辑页 */
        onSaved={(stillHere) => { profQ.reload(); invalidateDeptTree(); if (stillHere) setSearchParams({}, { replace: true }); }} />
    );
  }
  const tenure = tenureOf(u.hireDate, s.tenureFmt);
  const ffFields = tlType === 'all' ? [] : activeFields(tlType).filter((f) => f.filterable);
  const pane = (k) => 'ppl-pane' + (tab === k ? '' : ' off');
  const hasTagEvents = p.events.some((e) => e.source === 'tag' && !(selfView && e.tagKey === 'flight'));

  // Learning panel: the LMS side of the timeline, one row per program with real
  // activity — this list is "what happened", not the full assignment sheet
  // (buildTalentTimeline only emits programs that were actually opened).
  // The untouched ones are NOT missing from the response any more: /profile also
  // ships assignments[] (id/title/title_zh/dueAt/progress/moduleDone), which is
  // where a "assigned, never started" view would come from.
  const learning = p.events.filter((e) => e.source === 'lms' && e.lms);

  // 9-box placement from data already on the profile: the rating scale comes
  // from the performance type's own field config, the rating from the newest
  // performance record, potential from the employee record.
  const ratingField = p.config.fields.find((f) => f.typeKey === 'performance' && f.key === 'rating');
  const latestPerf = p.events.find((e) => e.source === 'record' && e.type === 'performance' && e.detail && e.detail.rating);
  const perfRating = latestPerf ? String(latestPerf.detail.rating) : null;
  const perfBucket = perfBucketOf(perfRating, ratingField ? ratingField.options : null);
  const potBucket = u.potential ? POT_BUCKET[u.potential] ?? null : null;
  const placed = perfBucket !== null && potBucket !== null;


  const delRecord = async (rid) => {
    try {
      await api.del(`/api/admin/records/${rid}`);
      Toast.success(s.deleted);
      profQ.reload();
    } catch (err) { Toast.error(errText(err, { record_from_review_cycle: () => s.e_record_from_review_cycle })); }
  };

  /* ---- timeline event body: config-driven field lines ---- */
  const eventBody = (e) => {
    if (e.source === 'tag') return <TagEventBody e={e} />;
    if (e.source === 'lms' && e.type === 'training' && e.lms) {
      const L = e.lms;
      return (
        <div className="ppl-ev-body">
          <span className="ppl-kv"><span className="k">{s.lmsProgress}</span><b className="tnum">{L.progress}%</b></span>
          {L.best && <span className="ppl-kv"><span className="k">{s.lmsBest}</span><b className="tnum">{L.best.percent}%</b> <Tag size="small" shape="circle" type="light" color={L.best.passed ? 'green' : 'red'}>{L.best.passed ? s.lmsPass : s.lmsFail}</Tag></span>}
          {L.rank && <span className="ppl-kv"><span className="k">{s.lmsRank}</span><b className="tnum">{L.rank}/{L.cohort}</b></span>}
          {L.blurMax > 0 && <span className="ppl-kv ppl-warn"><IcWarn /> {s.lmsBlur}×{L.blurMax}</span>}
        </div>
      );
    }
    if (e.source !== 'record') return null;
    const rows = [];
    for (const f of activeFields(e.type)) {
      if (!f.showInTimeline || f.input === 'checkbox') continue;
      const v = e.detail[f.key];
      if (v === undefined || v === null || v === '') continue;
      const str = String(v);
      // Tone is judged on the STORED value, never on the label: the label follows
      // the UI language, the pass/fail meaning does not — so a Chinese console
      // still paints a record whose stored result is "Failed" red.
      const bad = /未通过|failed|major|重大/i.test(str);
      const good = !bad && PASS_RE.test(str);
      const shown = optLabel(f, str, loc);
      rows.push(
        <span className="ppl-kv" key={f.id}>
          <span className="k">{loc(f, 'label')}</span>
          {good || bad
            ? <Tag size="small" shape="circle" type="light" color={good ? 'green' : 'red'}>{shown}</Tag>
            : f.input === 'textarea' ? <span className="v">{shown}</span> : <b>{shown}</b>}
        </span>
      );
    }
    // 第二批 2.6：周期归档的绩效记录在关闭后改过评级 → 「已改动（原评级 X）」，悬停看操作人、日期、理由。
    // amend 只在后台档案接口下发（员工端各接口都不带），改回原评级时服务端不再给（G9）。
    if (e.amend && e.amend.from) {
      const rf = activeFields(e.type).find((f) => f.key === 'rating') || p.config.fields.find((f) => f.typeKey === e.type && f.key === 'rating');
      const fromLabel = rf ? optLabel(rf, e.amend.from, loc) : String(e.amend.from);
      const who = e.amend.by ? e.amend.by.name || e.amend.by.employeeId || '—' : null;
      const tip = e.amend.at ? (
        <>
          <div>{s.amendBy(who || '—', localDay(e.amend.at), e.amend.reason || '—')}</div>
          {e.amend.count > 1 && <div>{s.amendCount(e.amend.count)}</div>}
        </>
      ) : null;
      const tag = <Tag size="small" shape="circle" type="light" color="amber" tabIndex={tip ? 0 : undefined}>{s.amended(fromLabel)}</Tag>;
      rows.push(<span className="ppl-kv" key="__amend">{tip ? <Tooltip content={tip}>{tag}</Tooltip> : tag}</span>);
    }
    // Only ever printing the ✓ makes a blocked sync look exactly like a record
    // where nobody asked for one — the whole reason this bug went unnoticed.
    const askedSync = !!e.detail[SYNC_FIELD[e.type]];
    return (
      <div className="ppl-ev-body">
        {rows}
        {e.detail.synced && <div className="ppl-synced">✓ {s[SYNC_MSG[e.type]] || s.synced}</div>}
        {!e.detail.synced && askedSync && <span className="ppl-kv ppl-warn"><IcWarn /> {s[NOSYNC_MSG[e.type]] || s.notSynced}</span>}
      </div>
    );
  };

  return (
    <div className="wrap ppl-wrap">
      <Button icon={<IconArrowLeft />} theme="borderless" onClick={() => navigate('/admin/employees')} className="ppl-back">{s.back}</Button>

      {/* Layout v2：左侧固定身份栏（身份卡、统计、人才定位）+ 右侧页签内容；v2.css .v2-person-workspace */}
      <div className="v2-person-workspace">
      <aside className="v2-person-rail">
      {/* ---- identity card ---- */}
      <div className="ppl-card ppl-id">
        <Avatar size="large" className="ppl-avatar">{initialsOf(u.name)}</Avatar>
        <div className="ppl-id-main">
          <div className="ppl-id-name">
            <h1>{u.name}</h1>
            {u.jobLevel && <Tag color="indigo" type="light" shape="circle">{u.jobLevel}</Tag>}
            {u.empStatus && <Tag color={STATUS_TAG[u.empStatus] || 'grey'} type="light" shape="circle">{s[u.empStatus] || u.empStatus}</Tag>}
            {u.role === 'admin' && <Tag color="purple" type="light" shape="circle">{s.hr}</Tag>}
            {!u.active && <Tag color="red" type="light" shape="circle">{s.deactivated}</Tag>}
          </div>
          <div className="ppl-id-meta">
            <span className="tnum">{u.employeeId}</span>
            {u.department && <span>{u.department}</span>}
            {u.position && <b>{u.position}</b>}
            {u.hireDate && <span>{s.hired} <b className="tnum">{u.hireDate}</b></span>}
            {tenure && <span>{s.tenure} <b>{tenure}</b></span>}
            {u.managerName && <span>{s.mgrLabel} <b>{u.managerName}</b></span>}
          </div>
          <div className="ppl-id-tags">
            {/* 12.2：受控标签在前（indigo），自由标签在后 */}
            <ControlledTagPills tags={u.talentTags} hideFlight={selfView} />
            {splitTags(u.talentTags).free.map((t) => <Tag key={t} color="grey" type="light">{t}</Tag>)}
            {u.potential && <Tag color="green" type="light">{s.potShort}: {s.potNames[u.potential] || u.potential}</Tag>}
            {/* 第二批 2.4：潜力评定日期（迁移 67 之前评定的没有日期 →「评定日期不详」） */}
            {u.potential && <Text type="tertiary" size="small" className="tnum">{u.potentialAt ? s.potentialAt(localDay(u.potentialAt)) : s.potentialNoDate}</Text>}
          </div>
        </div>
        <div className="ppl-id-side">
          {/* 编辑资料 = PUT /employees/:id — people 写, this page's own domain. */}
          {canWritePeople && <Button icon={<IconEdit />} onClick={openEdit}>{s.edit}</Button>}
          <Text type="tertiary" size="small">{s.lastLogin}: {u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : s.never}</Text>
        </div>
      </div>

      {/* Why the write controls are missing — a read-only role should read this as
          「只读」, not as a broken profile. Nothing renders for a manage档. */}
      {peopleReadOnly && (
        <div style={{ margin: '0 0 10px' }}><Text type="tertiary" size="small">{s.hintReadOnly}</Text></div>
      )}

      {/* ---- stats ---- */}
      <div className="ppl-chips">
        {/* trainingsPassed mixes LMS passes with manual training records; with
            learning off the LMS half is gone and the number reads wrong, so the
            badge hides with the module (待定#6 default). */}
        {learningOn && <span className="pill ok">{s.stTrain} <b className="tnum">{p.stats.trainingsPassed}</b></span>}
        <span className="pill warn">{s.stAward} <b className="tnum">{p.stats.awards}</b></span>
        <span className="pill fail">{s.stViol} <b className="tnum">{p.stats.violations}</b></span>
        <span className="pill pri">{s.stPromo} <b className="tnum">{p.stats.promotions}</b></span>
      </div>

          {/* ---- 9-box placement (talent module — the link targets /admin/talent-review) ---- */}
          {talentOn && (
          <div className="ppl-card ppl-box9">
            <div className="ppl-sec-h">
              <h2>{s.boxTitle}</h2>
              {canReadTalent && <button type="button" className="dash-cardlink" onClick={() => navigate('/admin/talent-review')}>{s.boxLink} →</button>}
            </div>
            {placed ? (
              <div className={'ppl-box9-body ppl-box9-' + BOX_TONE[potBucket][perfBucket]}>
                {/* The grid itself, 3×3, with this person's cell lit — potential runs
                    top-down (high first) exactly as on 人才盘点. */}
                <div className="ppl-box9-mini" aria-hidden="true">
                  {[2, 1, 0].map((pot) => [0, 1, 2].map((perf) => (
                    <i key={`${pot}-${perf}`} className={pot === potBucket && perf === perfBucket ? 'on' : ''} />
                  )))}
                </div>
                <div className="ppl-box9-txt">
                  <div className="ppl-box9-k">{s.boxPos}</div>
                  <div className="ppl-box9-name">{s.boxCells[potBucket][perfBucket]}</div>
                  <div className="ppl-box9-axes">
                    {/* The rating's own date matters: a 2024 rating placing someone
                        in 明星 today is a stale placement, not a fresh one. */}
                    {/* perfBucket !== null implies the rating came from this
                        field's own options, so the pair is always there */}
                    <span>{s.boxPerf} <b>{s.boxLv[perfBucket]}</b> · {optLabel(ratingField, perfRating, loc)}
                      <Text type="tertiary" size="small" className="tnum"> · {latestPerf.date}</Text>
                    </span>
                    {/* users.potential 是固定的 High/Medium/Low 枚举（不是可配置的选项表），
                        所以按字典映射，认不出的值原样显示。 */}
                    {/* CX-107：评级名与格位档名相同（高 · 高）时只写一次 */}
                    <span>{s.boxPot} <b>{s.boxLv[potBucket]}</b>{(s.potNames[u.potential] || u.potential) !== s.boxLv[potBucket] && <> · {s.potNames[u.potential] || u.potential}</>}
                      <Text type="tertiary" size="small" className="tnum"> · {u.potentialAt ? localDay(u.potentialAt) : s.potentialNoDate}</Text>
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ppl-box9-none">
                <b>{s.boxNone}</b>
                {perfBucket === null && <Tag size="small" color="amber" type="light" shape="circle">{s.boxMissPerf}</Tag>}
                {potBucket === null && <Tag size="small" color="blue" type="light" shape="circle">{s.boxMissPot}</Tag>}
                <Text type="tertiary" size="small">{s.boxHint}</Text>
              </div>
            )}
            {/* 12.2 受控人才标签：talent 写即可打标（不需要「员工与组织」写权限，绩效与人才管理员在这里操作） */}
            {talentWrite && (
              <ControlledTagsEditor userId={u.id} tags={u.talentTags} canWrite hideFlight={selfView} onChanged={() => profQ.reload()} />
            )}
          </div>
          )}
      </aside>


      {/* ---- two columns on desktop: 汇报关系 + 发展轨迹 in the main column,
           AI 画像 / 学习进度 / 人才定位 in the rail beside it. Below the rail
           breakpoint the grid is a plain block and the panes above take over,
           so the DOM order is also the phone reading order. ---- */}
      <div className="v2-person-detail">
      {/* ---- section tabs（Layout v2 起桌面端也用页签切换，手机沿用）----
           Hidden on desktop by CSS. The button order is the design's (轨迹 first,
           it is what HR opens the profile for); the panes below stay in desktop
           reading order, which is what makes one DOM serve both layouts. */}
      <div className="ppl-tabs v2-person-tabs" role="tablist">
        {/* A tab whose pane is module-gated goes with its pane; 'tl' stays the
            default state so nothing ever selects a hidden tab. */}
        {[['tl', s.tabTl], ...(portraitOn ? [['ai', s.tabAi]] : []), ...(learningOn ? [['learn', s.tabLearn]] : []), ['rel', s.tabRel]].map(([k, label]) => (
          <button type="button" role="tab" key={k} aria-selected={tab === k}
            className={'ppl-tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

          {/* ---- reporting relationships: solid line + matrix layer ---- */}
          <div className={pane('rel')}>
            <ReportingCard s={s} u={u} lines={p.secondaryLines || []} reports={p.secondaryReports || []}
              managers={p.suggestions.managers} departments={p.suggestions.departments}
              canWrite={canWritePeople}
              onChanged={() => profQ.reload()} />
          </div>

          {/* ---- timeline ---- */}
          <div className={'ppl-card ' + pane('tl')}>
            <div className="ppl-sec-h">
              <h2>{s.tlTitle}</h2>
              <Space>
                {/* 带上 userId：这个按钮在**某个人**的档案页上。不带的话服务端会导出
                    全公司的人才记录 —— HR 想给一个人导一份档案，结果拿到 900 多人的。 */}
                <Button icon={<IconDownload />} theme="light" onClick={() => { window.location.href = `/api/admin/export/records.csv?userId=${encodeURIComponent(id)}`; }}>{s.exportCsv}</Button>
                {/* 加记录 = POST /employees/:id/records — people 写 (矩阵「员工与组织」). */}
                {canWritePeople && <Button icon={<IconPlus />} theme="solid" type="primary" onClick={() => setRecModal({ editing: null })}>{s.addRecord}</Button>}
              </Space>
            </div>
            <div className="ppl-filters">
              <button className={'ppl-chip' + (tlType === 'all' ? ' on' : '')} onClick={() => { setTlType('all'); setTlFF({}); }}>{s.all}</button>
              {chipTypes.map((t) => (
                <button key={t.key} className={'ppl-chip' + (tlType === t.key ? ' on' : '')} onClick={() => { setTlType(t.key); setTlFF({}); }}>
                  {loc(t, 'label')}
                </button>
              ))}
              {hasTagEvents && (
                <button className={'ppl-chip' + (tlType === 'tag' ? ' on' : '')} onClick={() => { setTlType('tag'); setTlFF({}); }}>{ctS.tlType}</button>
              )}
            </div>
            {ffFields.length > 0 && (
              <div className="ppl-ff">
                <Text type="tertiary" size="small">{s.filterHint}:</Text>
                {ffFields.map((f) => {
                  const vals = [...new Set(p.events.filter((e) => e.source === 'record' && e.type === tlType && e.detail[f.key] !== undefined && e.detail[f.key] !== '').map((e) => String(e.detail[f.key])))];
                  return (
                    <Select key={f.id} size="small" showClear placeholder={loc(f, 'label')} value={tlFF[f.key] || undefined} style={{ minWidth: 140 }}
                      onChange={(v) => setTlFF((m) => ({ ...m, [f.key]: v || undefined }))}
                      /* values come straight out of detail and are compared
                         against it, so they stay canonical; only the label is
                         localized. */
                      optionList={vals.map((v) => ({ label: optLabel(f, v, loc), value: v }))} />
                  );
                })}
              </div>
            )}
            {events.length === 0 ? <Empty description={s.noEvents} style={{ padding: 24 }} /> : (
              <div className="ppl-tl">
                {events.map((e, i) => {
                  const t = typeMeta(e.type);
                  return (
                    <div className="ppl-ev" key={e.id || `lms-${i}`}>
                      <span className="ppl-dot" style={{ borderColor: t.color }}>{t.icon}</span>
                      <div className="ppl-ev-card">
                        <div className="ppl-ev-head">
                          <span className="ppl-ev-date tnum">{e.dateUnknown ? ctS.tlDateUnknown : e.date}</span>
                          <span className="ppl-ev-pill" style={{ background: t.color }}>{loc(t, 'label')}</span>
                          {/* 自动生成的记录标题是空的（服务端不再把类型名写进库），
                              用同一行那颗类型胶囊的名字顶上，跟着界面语言走。 */}
                          <span className="ppl-ev-title">{e.source === 'tag' ? tagEventTitle(e, lang) : (loc(e, 'title') || loc(t, 'label'))}</span>
                          {/* 受控标签事件只追加、不可编辑或删除 */}
                          {e.source === 'tag'
                            ? null
                            : !e.id
                            ? (e.source === 'lms' ? <span className="ppl-ev-auto">{s.auto}</span> : null)
                            : e.source === 'lms'
                            ? <span className="ppl-ev-auto">{s.auto}</span>
                            /* 编辑 = PUT /records/:id, 删除 = DELETE /records/:id —
                               both people 写, so a read-only档 sees neither. */
                            : !canWritePeople
                            ? null
                            : (
                              <span className="ppl-ev-act">
                                <Button theme="borderless" size="small" onClick={() => setRecModal({ editing: e })}>{s.editRec}</Button>
                                {/* 周期归档的记录（reviewLinked）不能删除（G7，服务端 409 record_from_review_cycle）；更正评级走「编辑」并写理由 */}
                                {!e.reviewLinked && (
                                  <Popconfirm title={s.delRecord} content={s.delRecordDesc} okType="danger" okText={s.delete} cancelText={s.cancel} onConfirm={() => delRecord(e.id)}>
                                    <Button theme="borderless" size="small" type="danger">{s.delete}</Button>
                                  </Popconfirm>
                                )}
                              </span>
                            )}
                        </div>
                        {eventBody(e)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* ---- AI portrait (talent module) ---- */}
          {/* AI 人才画像（talent 模块；AI 治理方案 2.5）：草稿 → 编辑 / 确认 / 丢弃、历史版本、异议记录。生成与处理
              要求 talent 管理权限与员工档案读权限（服务端判定）；ai 模块关闭时只读显示已确认版本，没有则整卡不出现。 */}
          {portraitOn && <PortraitCard userId={id} canWrite={talentWrite} className={pane('ai')} />}

          {/* ---- learning progress (the LMS half of the timeline, as a list) ---- */}
          {learningOn && (
          <div className={'ppl-card ppl-lm ' + pane('learn')}>
            <div className="ppl-sec-h">
              <h2>{s.lmTitle}</h2>
              {learning.length > 0 && <span className="ppl-lm-n tnum">{learning.length}</span>}
            </div>
            {learning.length === 0 ? <Text type="quaternary" size="small">{s.lmNone}</Text> : learning.map((e) => {
              const L = e.lms;
              return (
                <div className="dash-bar" key={L.programId}>
                  <span className="n" title={loc(e, 'title')}>{loc(e, 'title')}</span>
                  <span className="track"><span className="fill" style={{ width: `${L.progress}%` }} /></span>
                  <span className="c">
                    {L.best
                      ? <><b className="tnum">{L.best.percent}%</b><Tag size="small" shape="circle" type="light" color={L.best.passed ? 'green' : 'red'}>{L.best.passed ? s.lmsPass : s.lmsFail}</Tag></>
                      : <Text type="tertiary" size="small" className="tnum">{L.progress}%</Text>}
                  </span>
                </div>
              );
            })}
          </div>
          )}

      </div>
      </div>

      {/* ---- module tabs (manifest extensions["profile.tabs"], audience "admin";
           the server already dropped tabs whose domain this role cannot read).
           Full width under both columns, outside the phone panes, so it adds
           nothing to the existing layout. No module registers one yet: tabs is
           [] and this renders nothing. ---- */}
      <ProfileTabs tabs={p.tabs} userId={u.id} audience="admin" lang={lang}
        s={{ label: s.tabsLabel, soon: s.tabSoon, loading: s.tabLoading, failed: s.tabFailed }} cls={TAB_CLS} />

      {recModal && (
        <RecordModal
          s={s} loc={loc} userId={id} editing={recModal.editing} types={recModal.editing ? types : newTypes} activeFields={activeFields} cat={p.suggestions}
          onClose={() => setRecModal(null)}
          onSaved={() => { setRecModal(null); profQ.reload(); invalidateDeptTree(); /* 调动记录可能同步部门 */ }}
        />
      )}
    </div>
  );
}

/* ---- reporting relationships 汇报关系 ----
   The solid line lives on users.managerId and is edited in "Edit info" (one
   manager, always). This card owns the matrix layer around it: dotted-line
   managers and concurrent posts, plus who dotted-reports to this person. */
// canWrite = people=manage: POST /employees/:id/secondary-lines and
// DELETE /secondary-lines/:id are both 员工与组织/写, so a read-only档 gets the
// card as a pure read (the matrix layer is worth SEEING without editing rights).
function ReportingCard({ s, u, lines, reports, managers, departments, canWrite, onChanged }) {
  const [adding, setAdding] = useState(null); // 'dotted' | 'concurrent' | null
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  const open = (kind) => { setAdding(kind); setForm({ kind }); };
  const save = async () => {
    if (adding === 'dotted' && !form.managerId) { Toast.error(s.slNeedMgr); return; }
    if (adding === 'concurrent' && !String(form.position || '').trim()) { Toast.error(s.slNeedPos); return; }
    setBusy(true);
    try {
      await api.post(`/api/admin/employees/${u.id}/secondary-lines`, {
        kind: adding, managerId: form.managerId || '', position: form.position || '',
        department: form.department || '', note: form.note || '',
      });
      Toast.success(s.saved);
      setAdding(null); setForm({});
      onChanged();
    } catch (err) { Toast.error(err.message); }
    setBusy(false);
  };
  const remove = async (id) => {
    try {
      await api.del(`/api/admin/secondary-lines/${id}`);
      Toast.success(s.deleted);
      onChanged();
    } catch (err) { Toast.error(err.message); }
  };

  const dotted = lines.filter((l) => l.kind === 'dotted');
  const concurrent = lines.filter((l) => l.kind === 'concurrent');

  return (
    <div className="ppl-card">
      <div className="ppl-sec-h">
        <h2>{s.slTitle}</h2>
        {canWrite && (
        <Space>
          <Button size="small" icon={<IconPlus />} onClick={() => open('dotted')}>{s.slBtnDotted}</Button>
          <Button size="small" icon={<IconPlus />} onClick={() => open('concurrent')}>{s.slBtnConc}</Button>
        </Space>
        )}
      </div>

      <div className="ppl-rel">
        {/* solid line — read-only here, edited with the rest of the master data */}
        <div className="ppl-rel-row">
          <span className="ppl-rel-k"><i className="ppl-rel-solid" />{s.slSolid}</span>
          <span className="ppl-rel-v">
            {u.managerName ? <b>{u.managerName}</b> : <Text type="quaternary">{s.slNoSolid}</Text>}
          </span>
        </div>

        {dotted.map((l) => (
          <div className="ppl-rel-row" key={l.id}>
            <span className="ppl-rel-k"><i className="ppl-rel-dotted" />{s.slDotted}</span>
            <span className="ppl-rel-v">
              <b>{l.managerName}</b>
              {l.managerEmployeeId && <Text type="tertiary" size="small"> · {l.managerEmployeeId}</Text>}
              {l.position && <Text type="tertiary" size="small"> · {l.position}</Text>}
              {l.note && <Text type="quaternary" size="small"> · {l.note}</Text>}
            </span>
            {canWrite && (
            <Popconfirm title={s.slDelAsk} okType="danger" okText={s.delete} cancelText={s.cancel} onConfirm={() => remove(l.id)}>
              <Button size="small" theme="borderless" type="danger">{s.delete}</Button>
            </Popconfirm>
            )}
          </div>
        ))}

        {concurrent.map((l) => (
          <div className="ppl-rel-row" key={l.id}>
            <span className="ppl-rel-k"><i className="ppl-rel-conc" />{s.slConcurrent}</span>
            <span className="ppl-rel-v">
              <b>{l.position}</b>
              {l.department && <Text type="tertiary" size="small"> · {l.department}</Text>}
              {l.managerName && <Text type="tertiary" size="small"> · {s.mgrLabel} {l.managerName}</Text>}
              {l.note && <Text type="quaternary" size="small"> · {l.note}</Text>}
            </span>
            {canWrite && (
            <Popconfirm title={s.slDelAsk} okType="danger" okText={s.delete} cancelText={s.cancel} onConfirm={() => remove(l.id)}>
              <Button size="small" theme="borderless" type="danger">{s.delete}</Button>
            </Popconfirm>
            )}
          </div>
        ))}

        {/* incoming dotted lines — this person's matrix team */}
        {reports.length > 0 && (
          <div className="ppl-rel-row">
            <span className="ppl-rel-k"><i className="ppl-rel-dotted" />{s.slMatrixTeam}</span>
            <span className="ppl-rel-v ppl-rel-team">
              {reports.map((r) => (
                <Tag key={r.id} color="cyan" type="light" shape="circle">
                  {r.name}{r.department ? ` · ${r.department}` : ''}
                </Tag>
              ))}
            </span>
          </div>
        )}

        {!dotted.length && !concurrent.length && !reports.length && (
          <Text type="quaternary" size="small">{s.slEmpty}</Text>
        )}
      </div>

      <Modal visible={!!adding} width={480} maskClosable={false} confirmLoading={busy}
        title={adding === 'concurrent' ? s.slAddConcurrent : s.slAddDotted}
        onCancel={() => { setAdding(null); setForm({}); }} onOk={save}
        okText={s.save} cancelText={s.cancel}>
        <Banner type="info" closeIcon={null} description={adding === 'concurrent' ? s.slConcHint : s.slDottedHint} />
        {adding === 'concurrent' && (
          <>
            <div className="ppl-flabel">{s.slPosition}<span className="ppl-req">*</span></div>
            <Input value={form.position || ''} onChange={(v) => setForm((f) => ({ ...f, position: v }))} placeholder={s.slPositionPh} />
            <div className="ppl-flabel">{s.slDept}</div>
            <Select style={{ width: '100%' }} filter showClear value={form.department || undefined}
              onChange={(v) => setForm((f) => ({ ...f, department: v || '' }))}
              optionList={(departments || []).map((d) => ({ label: d, value: d }))} />
          </>
        )}
        <div className="ppl-flabel">{adding === 'concurrent' ? s.slMgrOptional : <>{s.slMgr}<span className="ppl-req">*</span></>}</div>
        <Select style={{ width: '100%' }} filter showClear value={form.managerId || undefined}
          onChange={(v) => setForm((f) => ({ ...f, managerId: v || '' }))}
          optionList={(managers || []).map((m) => ({ label: `${m.name}（${m.employeeId}）`, value: m.id }))} />
        {adding === 'dotted' && (
          <>
            <div className="ppl-flabel">{s.slScope}</div>
            <Input value={form.position || ''} onChange={(v) => setForm((f) => ({ ...f, position: v }))} placeholder={s.slScopePh} />
          </>
        )}
        <div className="ppl-flabel">{s.slNote}</div>
        <Input value={form.note || ''} onChange={(v) => setForm((f) => ({ ...f, note: v }))} placeholder={s.slNotePh} />
      </Modal>
    </div>
  );
}

/* ---- add / edit record modal (fields rendered from config) ---- */
function RecordModal({ s, loc, userId, editing, types, activeFields, cat, onClose, onSaved }) {
  const [typeKey, setTypeKey] = useState(editing ? editing.type : (types[0] && types[0].key));
  const [date, setDate] = useState(editing ? editing.date : toDateStr(new Date()));
  const [title, setTitle] = useState(editing ? editing.title : '');
  const [vals, setVals] = useState(editing ? { ...editing.detail } : {});
  const [saving, setSaving] = useState(false);
  const fields = activeFields(typeKey);
  // 第二批 2.6（G6）：改了绩效记录的评级 → 必填「修改理由」，作为 ratingReason 提交（服务端只写进审计，员工端不下发）。
  // 判定口径与服务端 PUT /api/admin/records/:id 相同：空值统一为 null 后比较存储值。
  const [ratingReason, setRatingReason] = useState('');
  const ratingOf = (d) => (d && d.rating != null && d.rating !== '' ? String(d.rating) : null);
  const ratingChanged = !!editing && editing.type === 'performance' && typeKey === 'performance' && ratingOf(vals) !== ratingOf(editing.detail);

  // The server validates required fields too (and is the authority), but
  // catching it here marks the offending field instead of firing a toast that
  // names a label the user then has to hunt for in the form.
  const [errs, setErrs] = useState({});
  const save = async () => {
    const missing = {};
    for (const f of fields) {
      if (!f.required) continue;
      const v = vals[f.key];
      if (v === undefined || v === null || String(v).trim() === '') missing[f.key] = s.recRequired;
    }
    if (ratingChanged && !ratingReason.trim()) missing.__ratingReason = s.recRequired;
    setErrs(missing);
    if (Object.keys(missing).length) { Toast.error(s.recFixFields); return; }
    setSaving(true);
    try {
      const body = { type: typeKey, date, title, fields: vals };
      if (ratingChanged) body.ratingReason = ratingReason.trim();
      if (editing) await api.put(`/api/admin/records/${editing.id}`, body);
      else await api.post(`/api/admin/employees/${userId}/records`, body);
      Toast.success(s.saved);
      onSaved();
    } catch (err) {
      // 服务端才是权威（它按配置校验数字/日期/选项，本地只挡了必填）。它回的
      // error 是半中半英的，所以按 code 在这里出本地文案，字段名用 loc() 取，
      // 中文界面说的是「期间」而不是 "Period"。顺手把那一格标红。
      const nameOf = (key) => {
        const f = fields.find((x) => x.key === key);
        return f ? loc(f, 'label') : key;
      };
      Toast.error(errText(err, {
        field_required: (d) => s.eRequired(nameOf(d.field)),
        field_number: (d) => s.eNumber(nameOf(d.field)),
        field_date: (d) => s.eDate(nameOf(d.field)),
        field_option: (d) => s.eOption(nameOf(d.field), vals[d.field]),
        rating_reason_required: () => s.e_rating_reason_required,
        record_type_locked: () => s.e_record_type_locked,
        record_from_review_cycle: () => s.e_record_from_review_cycle,
        period_has_cycle_record: () => s.e_period_has_cycle_record,
      }));
      if (err && err.data && err.data.field) setErrs({ [err.data.field]: s.recRequired });
      else if (err && err.data && err.data.code === 'rating_reason_required') setErrs({ __ratingReason: s.e_rating_reason_required });
    }
    setSaving(false);
  };

  return (
    <Modal visible title={editing ? s.recEdit : s.recNew} width={620} maskClosable={false}
      onCancel={onClose} onOk={save} okText={s.save} cancelText={s.cancel} confirmLoading={saving}>
      <div className="ppl-rec-grid">
        <div>
          <div className="ppl-flabel">{s.recType}</div>
          <Select style={{ width: '100%' }} value={typeKey} disabled={!!editing}
            onChange={(v) => { setTypeKey(v); setVals({}); }}
            optionList={types.map((t) => ({ label: loc(t, 'label'), value: t.key }))} />
        </div>
        <div>
          <div className="ppl-flabel">{s.recDate}</div>
          <DatePicker style={{ width: '100%' }} value={date || undefined} onChange={(d) => setDate(toDateStr(d))} />
        </div>
      </div>
      <div className="ppl-flabel">{s.recTitle}</div>
      <Input value={title} onChange={setTitle} placeholder={s.recTitlePh} />
      <div className="ppl-rec-fields">
        {fields.map((f) => {
          // The sync checkbox stays clickable — the rule is right, the silence was
          // not. Ticked but blocked, say so here rather than after a "saved" toast.
          const noSync = SYNC_FIELD[typeKey] === f.key ? syncBlockedWhy(typeKey, vals) : null;
          return (
            <div key={f.id} className={f.input === 'textarea' ? 'ppl-rec-full' : ''}>
              {f.input !== 'checkbox' && <div className="ppl-flabel">{loc(f, 'label')}{f.required && <span className="ppl-req">*</span>}</div>}
              <FieldInput f={f} value={vals[f.key]}
                onChange={(v) => { setVals((m) => ({ ...m, [f.key]: v })); if (errs[f.key]) setErrs((e) => ({ ...e, [f.key]: null })); }}
                cat={cat} loc={loc} />
              {errs[f.key] && <div className="ppl-ferr">{errs[f.key]}</div>}
              {noSync && <div className="ppl-ferr ppl-warn"><IcWarn /> {s[noSync]}</div>}
            </div>
          );
        })}
        {ratingChanged && (
          <div className="ppl-rec-full">
            <div className="ppl-flabel">{s.ratingReason}<span className="ppl-req">*</span></div>
            <TextArea rows={2} maxCount={1000} maxLength={1000} value={ratingReason} placeholder={s.ratingReasonPh}
              onChange={(v) => { setRatingReason(v); if (errs.__ratingReason) setErrs((e) => ({ ...e, __ratingReason: null })); }} />
            {errs.__ratingReason && <div className="ppl-ferr">{errs.__ratingReason}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---- edit identity page 编辑资料整页 (master data + custom employee fields + tags) ----
   #/admin/people/:id?edit=1 since 2026-10-07 (was a side drawer; 负责人「短操作弹窗、长编辑整页」).
   Same shell as the learning module's full pages: .co-page-bar header, .exm-page-grid
   main column + side card, sticky .exm-page-foot inside the main card, unsaved-changes
   guard on 返回 / 取消 and beforeunload. The browser Back button and the side nav do
   not pass the guard — HashRouter has no useBlocker; same accepted limit as Exams.

   talentOn is threaded in like s/loc: potential and talent tags are talent-module
   inputs (9-box axis / review labels), so they hide with it. The form still
   SUBMITS the untouched stored values — hiding an input must not clear data.

   RBAC on top of that, per the endpoint's own field-level guards (server.js on
   PUT /api/admin/employees/:id):
     role                     → roles domain, super-admin only (canRoles): the
                                提权面. The server 403s the WHOLE request when a
                                non-super merely CARRIES it, so it is omitted from
                                the body (not just disabled) for everyone else —
                                otherwise an HRBP could not save ANY edit here.
     active                   → accounts domain, needs accounts=manage (D6: now
                                grantable and scoped). Same 403-on-carry rule.
     potential / talentTags   → talent domain, needs talent=manage (403 as well).
   A field the body omits is left untouched server-side, so dropping them changes
   nothing about the stored data. */
// 未保存守卫的快照：标签排序；自定义字段去掉空值（清空一格 = 没填）并按键排序；后台角色「无」统一成 null
const pickProfileForm = (f) => JSON.stringify({
  ...f,
  talentTags: [...(f.talentTags || [])].sort(),
  extras: Object.fromEntries(Object.entries(f.extras || {})
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  adminRoleId: f.adminRoleId == null || f.adminRoleId === -1 ? null : f.adminRoleId,
});

function EditPage({ s, loc, lang, u, suggestions, userFields, talentOn, talentWrite, canAccounts, canRoles, selfView, onTagsChanged, onLeave, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [initialForm] = useState(() => ({
    name: u.name, department: u.department || '', position: u.position || '', jobLevel: u.jobLevel || '',
    hireDate: u.hireDate || '', empStatus: u.empStatus || '', role: u.role, active: u.active,
    adminRoleId: u.adminRoleId != null ? u.adminRoleId : null,
    talentTags: splitTags(u.talentTags).free, potential: u.potential || '', managerId: u.managerId || '',
    extras: { ...u.extras },
  }));
  const [form, setForm] = useState(initialForm);
  const [base] = useState(() => pickProfileForm(initialForm));
  const dirty = pickProfileForm(form) !== base;
  const set = (k, v) => setForm((m) => ({ ...m, [k]: v }));
  // 12.2：受控标签不进表单，经专用接口逐个打上 / 取消；保存资料时原样带回当前受控值（服务端要求受控集合不变）
  const [ctl, setCtl] = useState(() => splitTags(u.talentTags).controlled);
  const [tagHint, setTagHint] = useState(false);
  const ctS = controlledTagText(lang);
  // 后台角色 catalogue — roles domain, super-admin only, so fetched only for canRoles
  // (anyone else would just collect a 403). Envelope { roles: [...] }.
  const rolesQ = useAsync(() => (canRoles ? api.get('/api/admin/roles') : Promise.resolve(null)), [canRoles]);
  const adminRoles = (rolesQ.data && Array.isArray(rolesQ.data.roles)) ? rolesQ.data.roles
    : (Array.isArray(rolesQ.data) ? rolesQ.data : []);
  const origAdminRoleId = u.adminRoleId != null ? u.adminRoleId : null;

  // 离开本页（返回 / 后退 / 换人）后，在途的保存不再导航、不再写本组件的 state
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // 关页 / 刷新：浏览器自带的离开提示（HashRouter 不支持 useBlocker）
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  // 返回档案 / 取消：有未保存的修改先确认
  const guard = (fn) => {
    if (!dirty) { fn(); return; }
    Modal.confirm({ title: s.discardTitle, content: s.discardAsk, okText: s.discardOk, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: fn });
  };
  const leave = () => guard(onLeave);

  const save = async () => {
    if (!form.name.trim()) { setErr(s.reqName); Toast.error(s.reqName); return; }
    setErr('');
    setSaving(true);
    try {
      const body = {
        name: form.name, department: form.department, position: form.position, jobLevel: form.jobLevel,
        hireDate: form.hireDate, empStatus: form.empStatus || null, managerId: form.managerId || null,
        extras: form.extras,
      };
      // D6 splits the old account group by its real guard (see the header
      // comment): role → roles domain (super-admin, canRoles), active → accounts
      // domain (accounts=manage). Carried by a role without the right, the server
      // 403s the whole PUT, so each rides only for the role allowed to write it.
      if (canRoles) {
        body.role = form.role;
        // Only when it changed: an untouched picker must not re-assign (or trip
        // the last-super-admin guard on an unrelated profile edit).
        if (form.adminRoleId !== origAdminRoleId) body.adminRoleId = form.adminRoleId;
      }
      if (canAccounts) {
        body.active = form.active;
      }
      if (talentWrite) {
        body.talentTags = [...ctl, ...form.talentTags];
        body.potential = form.potential || null;
      }
      await api.put(`/api/admin/employees/${u.id}`, body);
      Toast.success(s.saved);
      const stillHere = alive.current;
      if (stillHere) setSaving(false);
      onSaved(stillHere);
    } catch (e) {
      // 服务端原话：留在本页，表单顶部显示（中文界面优先 error_zh），同时 Toast
      const msg = (lang === 'zh' && e && e.data && e.data.error_zh) || (e && e.message) || String(e);
      Toast.error(msg);
      if (alive.current) { setErr(msg); setSaving(false); }
    }
  };

  const sel = (list) => list.map((x) => ({ label: x, value: x }));
  const title = `${s.editTitle} · ${u.name}`;
  const sub = `${u.employeeId}${u.department ? ' · ' + u.department : ''}`;
  const statusTag = u.empStatus ? <Tag color={STATUS_TAG[u.empStatus] || 'grey'} type="light" shape="circle">{s[u.empStatus] || u.empStatus}</Tag> : null;
  const hint = (text) => <Text type="tertiary" size="small" className="org-page-hint">{text}</Text>;
  return (
    <div className="wrap ppl-wrap ppl-edit-page">
      <div className="co-page-bar">
        <Button theme="borderless" icon={<IconArrowLeft />} onClick={leave}>{s.backProfile}</Button>
        <div className="co-page-titles">
          <h1 className="co-page-title" title={title}>{title}</h1>
          <div className="co-page-sub tnum">{sub}</div>
        </div>
        {statusTag}
        {!u.active && <Tag color="red" type="light" shape="circle">{s.deactivated}</Tag>}
        {dirty && <span className="pill warn">{s.unsaved}</span>}
      </div>

      <div className="exm-page-grid">
        <div className="card co-ed-card">
          {err && <Banner type="danger" closeIcon={null} className="org-page-err" description={err} />}

          <h2 className="org-page-sec">{s.secBasic}</h2>
          <div className="ppl-rec-grid">
            <div><div className="ppl-flabel">{s.fName}<span className="ppl-req">*</span></div>
              <Input value={form.name} onChange={(v) => set('name', v)} /></div>
            <div><div className="ppl-flabel">{s.fDept}</div>
              <Select style={{ width: '100%' }} filter allowCreate showClear value={form.department || undefined} onChange={(v) => set('department', v || '')} optionList={sel(suggestions.departments)} /></div>
            <div><div className="ppl-flabel">{s.fPos}</div>
              <Select style={{ width: '100%' }} filter allowCreate showClear value={form.position || undefined} onChange={(v) => set('position', v || '')} optionList={sel(suggestions.positions)} /></div>
            <div><div className="ppl-flabel">{s.fLevel}</div>
              <Select style={{ width: '100%' }} filter allowCreate showClear value={form.jobLevel || undefined} onChange={(v) => set('jobLevel', v || '')} optionList={(suggestions.jobRanks || []).map((r) => ({ label: r.rank + ' · ' + r.grade + ' / L' + r.level, value: r.rank }))} /></div>
            <div><div className="ppl-flabel">{s.fHire}</div>
              <DatePicker style={{ width: '100%' }} value={form.hireDate || undefined} onChange={(d) => set('hireDate', toDateStr(d))} /></div>
            <div><div className="ppl-flabel">{s.fStatus}</div>
              <Select style={{ width: '100%' }} showClear value={form.empStatus || undefined} onChange={(v) => set('empStatus', v || '')}
                optionList={[{ label: s.probation, value: 'probation' }, { label: s.regular, value: 'regular' }, { label: s.exited, value: 'exited' }]} /></div>
            <div><div className="ppl-flabel">{s.fManager}</div>
              <Select style={{ width: '100%' }} filter showClear value={form.managerId || undefined} onChange={(v) => set('managerId', v || '')}
                optionList={(suggestions.managers || []).map((m) => ({ label: `${m.name} (${m.employeeId})`, value: m.id }))} /></div>
          </div>

          {talentWrite && (
            <>
              <h2 className="org-page-sec">{s.secTalent}</h2>
              <div className="ppl-rec-grid">
                <div><div className="ppl-flabel">{s.fPotential}</div>
                  <Select style={{ width: '100%' }} showClear value={form.potential || undefined} onChange={(v) => set('potential', v || '')}
                    optionList={['High', 'Medium', 'Low'].map((x) => ({ label: s.potNames[x] || x, value: x }))} /></div>   {/* CX-107：显示按界面语言，存储值仍是 High/Medium/Low */}
              </div>
              <ControlledTagsEditor userId={u.id} tags={ctl} canWrite hideFlight={selfView}
                onChanged={(tags) => { if (Array.isArray(tags)) setCtl(splitTags(tags).controlled); if (onTagsChanged) onTagsChanged(); }} />
              <div className="ppl-flabel">{s.fTags}</div>
              <Select style={{ width: '100%' }} multiple filter allowCreate placeholder={s.fTagsPh}
                // CX-020（2026-10-09 验收）：受控标签的保留写法不给「创建 …」，直接显示提示
                renderCreateItem={(v) => (reservedKeyOf(v) ? <span className="org-page-hint">{ctS.reserved}</span> : <span>{(lang === 'zh' ? '创建 ' : 'Create ') + v}</span>)}
                value={form.talentTags}
                onSearch={(v) => setTagHint(!!reservedKeyOf(v))}
                onChange={(v) => { const list = Array.isArray(v) ? v : []; setTagHint(list.some((x) => reservedKeyOf(x))); set('talentTags', list.filter((x) => !reservedKeyOf(x))); }}
                optionList={sel([...new Set([...PRESET_TAGS, ...form.talentTags])])} />
              {tagHint && <Text type="warning" size="small" className="org-page-hint">{ctS.reserved}</Text>}
            </>
          )}
          {/* The talent inputs are gone because of the GRANT, not the module — say so,
              or the page just looks like it lost two fields. Module off = silent, as
              before (the whole talent surface is meant to be invisible then). */}
          {talentOn && !talentWrite && hint(s.potFieldsTalentOnly)}

          {userFields.length > 0 && (
            <>
              <h2 className="org-page-sec">{s.secCustom}</h2>
              <div className="ppl-rec-grid">
                {userFields.map((f) => (
                  <div key={f.id}>
                    {f.input !== 'checkbox' && <div className="ppl-flabel">{loc(f, 'label')}{f.required && <span className="ppl-req">*</span>}</div>}
                    <FieldInput f={f} value={form.extras[f.key]} onChange={(v) => setForm((m) => ({ ...m, extras: { ...m.extras, [f.key]: v } }))} cat={suggestions} loc={loc} />
                  </div>
                ))}
              </div>
            </>
          )}

          {/* D6 splits this by guard: 角色 (role) is the 提权面 (roles domain, super-
              admin only, canRoles); 账号可用 (active) is the accounts domain
              (accounts=manage, grantable and scoped). Each is omitted from the PUT
              body when hidden, see save() above. Since canRoles ⟹ canAccounts, a
              super-admin sees both. */}
          {(canRoles || canAccounts) && (
            <>
              <h2 className="org-page-sec">{s.secAccount}</h2>
              <div className="ppl-rec-grid">
                {canRoles && <div><div className="ppl-flabel">{s.fRole}</div>
                  <Select style={{ width: '100%' }} value={form.role} onChange={(v) => set('role', v)}
                    optionList={[{ label: s.roleEmp, value: 'employee' }, { label: s.roleAdmin, value: 'admin' }]} /></div>}
                {canAccounts && <div><div className="ppl-flabel">{s.fActive}</div>
                  <Select style={{ width: '100%' }} value={form.active ? 1 : 0} onChange={(v) => set('active', !!v)}
                    optionList={[{ label: '✓', value: 1 }, { label: '✕', value: 0 }]} /></div>}
              </div>
              {canRoles && (
                <>
                  <div className="ppl-flabel">{s.fAdminRole}</div>
                  {/* value -1 stands in for "none": Semi's Select treats null as empty. */}
                  <Select style={{ width: '100%' }} filter loading={rolesQ.loading}
                    value={form.adminRoleId == null ? -1 : form.adminRoleId}
                    onChange={(v) => set('adminRoleId', v === -1 || v == null ? null : v)}
                    optionList={[
                      { label: s.adminRoleNone, value: -1 },
                      ...adminRoles.map((r) => ({ label: (loc(r, 'name') || r.name || r.name_zh), value: r.id })),
                    ]} />
                  {hint(s.adminRoleHint)}
                </>
              )}
            </>
          )}
          {!canRoles && hint(canAccounts ? s.roleSuperOnly : s.acctFieldsSuperOnly)}

          <div className="exm-page-foot">
            <Button theme="borderless" onClick={leave}>{s.cancel}</Button>
            <Button theme="solid" type="primary" loading={saving} onClick={save}>{s.save}</Button>
          </div>
        </div>

        <aside className="exm-page-side">
          <div className="card co-ed-card">
            <div className="ppl-id-name">
              <Avatar className="ppl-avatar">{initialsOf(u.name)}</Avatar>
              <b>{u.name}</b>
            </div>
            <dl className="exm-page-kv" style={{ marginTop: 16 }}>
              <div><dt>{s.fEmpId}</dt><dd className="tnum">{u.employeeId}</dd></div>
              {u.department && <div><dt>{s.fDept}</dt><dd>{u.department}</dd></div>}
              <div><dt>{s.fStatus}</dt><dd>{statusTag || '—'}</dd></div>
              <div><dt>{s.lastLogin}</dt><dd className="tnum">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : s.never}</dd></div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}
