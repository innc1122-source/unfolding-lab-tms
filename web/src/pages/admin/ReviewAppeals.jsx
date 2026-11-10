// 绩效申诉台（第二批 2.8，2026-10-08；设计 appeal-design §8.4，负责人 10/8 决定）
//   列表 /admin/review-appeals[?status=&cycle=&dept=&q=&mine=1]      —— 筛选写地址栏（replace）
//   统计 /admin/review-appeals?view=stats[&cycle=]                     —— caps.stats 为真才有这个页签
//   案卷 /admin/review-appeals?appeal=<id>                            —— 整页（push 进入；404 时提示并 replace 掉参数）
// 数据：GET /api/admin/review-appeals（行与计数，服务端已按 HRBP 分工、数据范围与利益回避裁过）、…/stats、…/:id（view = full | meta），
//   动作 POST …/:id/start | consult | decide | reassign。可见与可操作一律以服务端给的 view、permissions、caps、actionable 为准，
//   本页不自己推权限（HRBP 分工是独立设置、不是角色）。
// 负责人原则：短操作用弹窗（开始处理、征询意见、转交、提交结论确认、图片预览），长编辑整页（结论表单），不用抽屉。
// 审查意见：转交不收备注（服务端不存，避免「填了却丢」）；结论两种都带 expectRating；小部门（small）不展示各档人数。
import { useEffect, useMemo, useState } from 'react';
import {
  Button, Input, Select, Switch, Table, Tag, Toast, Banner, Spin, Empty, Modal, Radio, RadioGroup, TextArea, Tooltip,
} from '@douyinfe/semi-ui';
import { IconArrowLeft, IconSearch, IconRefresh } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { PAGE_TIERS, DEFAULT_PAGE, clampPage } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { dataTableColumns } from '../../components/DataTable.jsx';   // 一致性整改 2
import DeptFilter, { deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import PdfViewer from '../../components/PdfViewer.jsx';
import { useLeaveGuard, confirmLeave } from '../../components/useLeaveGuard.js';
import { APPEAL_CATEGORIES, categoryLabel } from '../../appealcats.js';   // 绩效看板第二期：申诉原因分类（迁移 97）
import { pathMatcher } from '../../deptfilter.js';
import { useUrlState } from '../../urlstate.js';
import { bucketOf, tiersOf, QUOTA_CAPPED, localStamp } from '../../deptcal.js';

const T = {
  zh: {
    title: '绩效申诉',
    leadHrbp: '处理员工对最终评级提出的申诉。你只能看到你负责的部门的员工申诉。',
    leadOversight: '查看各周期申诉进度与统计。申诉内容仅负责的 HRBP 可见；没有 HRBP 的部门由拥有绩效管理权限的管理员处理。',
    coverLine: (list) => `你负责的部门：${list}（含下级部门）`,
    vList: '申诉列表', vStats: '统计',
    f: { submitted: '待处理', in_review: '处理中', overdue: '已逾期', closed: '已关闭', all: '全部' },
    st: { submitted: '待处理', in_review: '处理中', withdrawn: '已撤回', maintained: '维持原评级', adjusted: '已调整评级' },
    fCycle: '评估周期', fCycleAll: '全部周期', fDept: '部门', fDeptAll: '全部部门', searchPh: '搜索姓名或工号', mine: '只看我处理的',
    count: (n, all) => `显示 ${n} / ${all} 条`, clear: '清除筛选',
    cEmp: '员工', cDept: '部门', cCycle: '评估周期', cRating: '申诉时评级', cSubmitted: '提交时间', cStatus: '状态', cHandler: '处理人', cDue: '答复时限', cAct: '操作',
    noHrbp: '无 HRBP', stale: '待转交', notStarted: '尚未开始处理',
    overdueBy: (n) => `已逾期 ${n} 个工作日`, daysLeft: (n) => `剩 ${n} 个工作日`, dueToday: '今天到期', repliedOnTime: '按时答复', repliedLate: '逾期答复',
    review: '处理', view: '查看', empty: '暂无申诉', emptyFiltered: '没有符合筛选条件的申诉',
    loadFail: '加载失败，请刷新页面重试。', refresh: '刷新', noDesk: '你还没有被指定任何部门的 HRBP 分工，看不到申诉台。请超级管理员在「系统设置 › HRBP 分工」中指定后再进入。',
    // 统计
    sCycle: '评估周期', kAppeals: '申诉数', kRate: '申诉率（不含已撤回）', kAdjust: '调整率', kAvg: '平均处理时长', kAvgUnit: (n) => `${n} 个工作日`,
    kSla: '按时答复', kSlaN: (a, b) => `${a} / ${b} 条已作结论`, kOverdue: '逾期未结', kRateN: (a, b) => `${a} / ${b} 人`,
    sKind: '类型', kindQuarter: '季度', kindAnnual: '年度', kindLegacy: '旧流程',
    sComm: '结果告知日', sDeadline: '申诉截止', sEligible: '可申诉人数', sAppeals: '申诉', sWithdrawn: '撤回', sOpen: '处理中',
    sMaintained: '维持', sAdjusted: '调整', sAdjustRate: '调整率', sAvg: '平均处理（工作日）', sWindowOpen: '申诉期内',
    sFoot: '调整率 = 调整数 ÷ 已作结论数；处理时长自提交日起按工作日计。申诉数不含已撤回（与绩效看板同口径，撤回另列）；申诉率 = 申诉数 ÷ 可申诉人数（不含告知时已离职者）。',   // CX-215
    sEmpty: '还没有已告知结果的评估周期。',
    // 案卷
    back: '返回申诉列表', caseTitle: (n, c) => `${n} ·「${c}」最终评级申诉`, overdueTag: (n) => `逾期 ${n} 个工作日`,
    notFound: '未找到该申诉', metaBanner: '申诉内容仅负责的 HRBP 可见。',
    coBanner: (n) => `该申诉由 ${n} 处理，你可以查看。`,
    exitedBanner: '申诉人已离职，系统不会向其发送结论。请通过其他书面渠道告知结论，并在内部说明中记录。',
    langKey: 'zh', catL: '原因分类', catFix: '改正分类', catSaved: '已改正原因分类', catHint: '员工提交时自选；分类不准时可改正，只影响统计，不通知员工。',
    secReason: '书面说明', submittedAt: '提交时间', windowDeadline: '申诉截止日',
    secFiles: '佐证材料', noFiles: '员工未提交佐证材料。', filePdf: 'PDF', fileImg: '图片', openPdf: '查看', closePdf: '收起', preview: '预览',
    secReview: '评估材料', annualNote: '年度周期没有员工自评与上级评级，评级由部门负责人（HoD）提议、HR 确认。',
    hSelf: '员工自评', prevGoal: (n) => `上期目标 ${n}`, outcome: '完成情况', challenges: '困难与挑战', feedback: '对上级与公司的反馈', extra: '补充说明', goalsNext: '下期目标',
    hMgr: '上级评级与评语', mgrRating: '上级评级', mgrText: '上级评语', highlights: '关键亮点', mgrName: '直属上级（本周期）', exitedMark: '（已离职）',
    hOne: '1 对 1 面谈', oneMgr: '上级登记', oneEmp: '员工确认', oneNotes: '面谈记录',
    hCal: '部门校准', finalRating: '校准后评级', hodText: '部门负责人（HoD）校准说明', hodName: '部门负责人（HoD）', proxy: '部门负责人代评',
    proxyHint: '由部门负责人代直属上级评级', hodSubmitted: 'HoD 提交', hrConfirmed: 'HR 确认', returned: '退回', calLog: '校准记录',
    hRecord: '评级档案', recordRating: '当前档案评级', amended: (r) => `已改动（原评级 ${r}）`,
    none: '无', at: (v) => v || '—',
    secDist: '名额分布', distUnit: (u, n) => `${u} · 计入 ${n} 人`, distSrcSnap: '按 HR 确认时的部门名单统计', distSrcCur: '按当前部门名单统计',
    dTier: '档位', dQuota: '名额比例', dAllowed: '上限', dCur: '当前', dAfter: '调整后', dMine: '申诉人所在档',
    distClosed: '周期已关闭，调整评级不受名额限制；此表仅展示调整后的分布，供参考。',
    distSmall: (n) => `该部门人数少于 ${n} 人，不适用名额限制。`, distNoQuota: '本周期未设名额。', distNone: '暂无分布数据。',
    secConsult: '征询意见', consultBtn: '征询意见', consultNone: '尚未征询任何人。', relManager: '直属上级', relHod: '部门负责人（HoD）',
    askedBy: (n, t) => `${n} 于 ${t} 征询`, answeredAt: (t) => `${t} 答复`, awaiting: '尚未答复', question: '问题', opinion: '意见',
    consultT: '征询意见', consultWho: '征询对象', consultQ: '问题（选填）',
    consultNote: '对方只能看到书面说明和评估记录，看不到佐证材料；对方的意见员工看不到。',
    candMgrCur: '直属上级（当前）', candMgrCycle: '直属上级（本周期）', candHodCur: '部门负责人（当前）', candHodCycle: '部门负责人（本周期）',
    consultLimit: '每条申诉最多征询 4 人。', consultSend: '发送征询', consultDone: '已发送征询',
    secDecision: '处理结论', oMaintain: '维持原评级', oAdjust: '调整评级', newRating: '调整后的评级', newRatingPh: '选择评级',
    reply: '给员工的答复', replyHint: '员工会看到这段答复。请说明复核依据和结论，不要写入内部说明或调整前的评级。',
    noteMaintain: '内部说明（选填）', noteAdjust: '调整理由（仅内部可见，记入评级修改记录）',
    infoHint: '如需员工补充说明或材料，请在系统外联系员工，并在内部说明中记录。',
    replyMin: (n) => `答复至少 ${n} 字`, noteRange: '调整理由需 10–1000 字', ratingNeed: '请选择调整后的评级',
    submit: '提交结论', confirmT: '提交结论？',
    confirmMaintain: '结论提交后不能更改，员工将收到通知。',
    confirmAdjust: (r) => `结论提交后不能更改。评级将改为 ${r}，员工、部门负责人和直属上级将收到通知。`,
    decided: '已提交结论', outcomeL: '结论', newRatingL: '调整后评级', replyL: '给员工的答复', noteL: '内部说明', reasonL: '调整理由', decidedBy: '作出结论', decidedOn: (n, t) => `${n} · ${t}`,
    withdrawnNote: (t) => `员工已于 ${t} 撤回申诉。`,
    leaveAsk: '处理结论尚未提交，离开后填写的内容会丢失。确定离开？',
    secStatus: '申诉状态', slaDue: '答复时限', handler: '处理人', hrbps: '负责的 HRBP', routedVia: '路由部门', fallbackNote: '该部门没有可处理的 HRBP，由拥有绩效管理权限的管理员处理',
    deptAtRating: '评级时所在部门', deptWhenFiled: '提交申诉时所在部门', deptNow: '当前部门',
    secAppellant: '申诉人', empId: '工号', position: '职位', level: '职级', manager: '直属上级（当前）', hod: '部门负责人（当前）', notInService: '已离职',
    start: '开始处理', startT: '开始处理？', startAsk: '开始处理后员工不能再撤回申诉。', started: '已开始处理',
    reassign: '转交', reassignT: '转交申诉', reassignTo: '转交给', reassignPh: '选择处理人', reassignNone: '没有其他可转交的处理人。', reassigned: '已转交',
    takeOver: '接手处理', takeOverT: '接手处理？', takeOverAsk: '原处理人已不再负责该部门。接手后由你作出结论。', tookOver: '已接手处理',
    secActivity: '处理记录', ev: {
      submit: '提交申诉', withdraw: '员工撤回', start: '开始处理', reassign: '转交', consult: '征询意见', opinion: '提交意见',
      maintain: '维持原评级', adjust: '调整评级', remind_soon: '即将到期提醒', remind_overdue: '逾期提醒', escalate: '逾期升级提醒',
      view: '查看案卷', appellant_exited: '申诉人已离职',
    },
    system: '系统', timeline: '时间',
    ok: '确认', cancel: '取消', done: '已保存',
    err: {
      appeal_not_found: '未找到该申诉。', not_found: '未找到该申诉。', appeal_state: '申诉状态已变化，请刷新后重试。',
      appeal_no_permission: '你没有处理这条申诉的权限。', appeal_reply: '给员工的答复需 20–4000 字。',
      appeal_note: '调整评级须写明调整理由（10–1000 字）；内部说明最多 4000 字。', rating_invalid: '请选择一个与当前评级不同的有效评级。',
      rating_changed: '该员工的评级已被修改，请刷新后再作结论。', record_missing: '找不到对应的绩效记录。',
      consultee_invalid: '只能征询该员工的直属上级或部门负责人。', consult_exists: '已向此人征询过意见。', consult_limit: '每条申诉最多征询 4 人。',
      assignee_invalid: '只能转交给负责该部门且无利益冲突的处理人。',
    },
  },
  en: {
    title: 'Performance Appeals',
    leadHrbp: 'Review appeals against final ratings. You see appeals only from employees in the departments you cover.',
    leadOversight: 'Track appeal progress and statistics by cycle. Appeal content is visible only to the responsible HRBP; appeals from departments without an HRBP are handled by administrators with performance management access.',
    coverLine: (list) => `Departments you cover: ${list} (including sub-departments)`,
    vList: 'Appeals', vStats: 'Statistics',
    f: { submitted: 'Awaiting review', in_review: 'Under review', overdue: 'Overdue', closed: 'Closed', all: 'All' },
    st: { submitted: 'Awaiting review', in_review: 'Under review', withdrawn: 'Withdrawn', maintained: 'Rating maintained', adjusted: 'Rating adjusted' },
    fCycle: 'Cycle', fCycleAll: 'All cycles', fDept: 'Department', fDeptAll: 'All departments', searchPh: 'Search name or employee ID', mine: 'Only mine',
    count: (n, all) => `Showing ${n} of ${all}`, clear: 'Clear filters',
    cEmp: 'Employee', cDept: 'Department', cCycle: 'Cycle', cRating: 'Rating appealed', cSubmitted: 'Submitted', cStatus: 'Status', cHandler: 'Handled by', cDue: 'Response due', cAct: 'Action',
    noHrbp: 'No HRBP', stale: 'Needs reassignment', notStarted: 'Not started yet',
    overdueBy: (n) => `Overdue by ${n} working day${n === 1 ? '' : 's'}`, daysLeft: (n) => `${n} working day${n === 1 ? '' : 's'} left`, dueToday: 'Due today', repliedOnTime: 'Replied on time', repliedLate: 'Replied late',
    review: 'Review', view: 'View', empty: 'No appeals', emptyFiltered: 'No appeals match these filters',
    loadFail: 'Couldn’t load. Refresh the page to try again.', refresh: 'Refresh', noDesk: 'You are not assigned as HRBP for any department, so the appeal desk is not available. Ask a super admin to assign you under Settings › HRBP coverage.',
    sCycle: 'Cycle', kAppeals: 'Appeals', kRate: 'Appeal rate (excl. withdrawn)', kAdjust: 'Adjustment rate', kAvg: 'Average handling time', kAvgUnit: (n) => `${n} working day${n === 1 ? '' : 's'}`,
    kSla: 'Answered within SLA', kSlaN: (a, b) => `${a} of ${b} decided`, kOverdue: 'Overdue open', kRateN: (a, b) => `${a} of ${b} people`,
    sKind: 'Type', kindQuarter: 'Quarterly', kindAnnual: 'Annual', kindLegacy: 'Legacy',
    sComm: 'Results communicated', sDeadline: 'Appeal deadline', sEligible: 'Eligible', sAppeals: 'Appeals', sWithdrawn: 'Withdrawn', sOpen: 'Open',
    sMaintained: 'Maintained', sAdjusted: 'Adjusted', sAdjustRate: 'Adjustment rate', sAvg: 'Avg handling (working days)', sWindowOpen: 'Window open',
    sFoot: 'Adjustment rate = adjusted ÷ decided. Handling time is counted in working days from the submission date. Appeals exclude withdrawn ones (same as the performance dashboard; withdrawals are listed separately). Appeal rate = appeals ÷ eligible employees (excluding those who had left when results were communicated).',
    sEmpty: 'No cycle has communicated results yet.',
    back: 'Back to appeals', caseTitle: (n, c) => `${n} · Appeal against the ${c} final rating`, overdueTag: (n) => `Overdue ${n} working day${n === 1 ? '' : 's'}`,
    notFound: 'Appeal not found', metaBanner: 'Appeal content is visible only to the responsible HRBP.',
    coBanner: (n) => `${n} is handling this appeal; you have view access.`,
    exitedBanner: 'The appellant has left the company. The system will not send them the outcome. Communicate the decision in writing through another channel and record this in the internal note.',
    langKey: 'en', catL: 'Reason category', catFix: 'Correct category', catSaved: 'Reason category corrected', catHint: 'Chosen by the employee. Correct it if it does not fit; this only affects reporting and the employee is not notified.',
    secReason: 'Written explanation', submittedAt: 'Submitted', windowDeadline: 'Appeal deadline',
    secFiles: 'Supporting documents', noFiles: 'The employee did not submit supporting documents.', filePdf: 'PDF', fileImg: 'Image', openPdf: 'View', closePdf: 'Hide', preview: 'Preview',
    secReview: 'Review materials', annualNote: 'Annual cycles have no self-review or manager rating; the head of department (HoD) proposes the rating and HR confirms it.',
    hSelf: 'Self-review', prevGoal: (n) => `Previous goal ${n}`, outcome: 'Outcome', challenges: 'Challenges', feedback: 'Feedback to manager and company', extra: 'Additional notes', goalsNext: 'Next goals',
    hMgr: 'Manager rating and comment', mgrRating: 'Manager rating', mgrText: 'Manager comment', highlights: 'Key highlights', mgrName: 'Direct manager (this cycle)', exitedMark: ' (left)',
    hOne: 'One-on-one', oneMgr: 'Logged by manager', oneEmp: 'Confirmed by employee', oneNotes: 'Meeting notes',
    hCal: 'Department calibration', finalRating: 'Calibrated rating', hodText: 'Head of department (HoD) calibration note', hodName: 'Head of department (HoD)', proxy: 'Rated by the HoD',
    proxyHint: 'Rated by the head of department on the manager’s behalf', hodSubmitted: 'HoD submitted', hrConfirmed: 'HR confirmed', returned: 'Returned', calLog: 'Calibration log',
    hRecord: 'Rating on record', recordRating: 'Current rating on record', amended: (r) => `Changed (originally ${r})`,
    none: 'None', at: (v) => v || '—',
    secDist: 'Rating distribution', distUnit: (u, n) => `${u} · ${n} counted`, distSrcSnap: 'Counted from the department list at HR confirmation', distSrcCur: 'Counted from the current department list',
    dTier: 'Tier', dQuota: 'Quota %', dAllowed: 'Allowed', dCur: 'Current', dAfter: 'After adjustment', dMine: 'Appellant’s tier',
    distClosed: 'The cycle is closed, so quotas are not enforced; the table shows the resulting distribution for reference.',
    distSmall: (n) => `Quotas do not apply to departments with fewer than ${n} people.`, distNoQuota: 'This cycle has no quota.', distNone: 'No distribution data.',
    secConsult: 'Consultations', consultBtn: 'Request an opinion', consultNone: 'No one has been consulted yet.', relManager: 'Direct manager', relHod: 'Head of department (HoD)',
    askedBy: (n, t) => `Requested by ${n} on ${t}`, answeredAt: (t) => `Answered ${t}`, awaiting: 'Awaiting reply', question: 'Question', opinion: 'Opinion',
    consultT: 'Request an opinion', consultWho: 'Consult', consultQ: 'Question (optional)',
    consultNote: 'They will see the written explanation and review record, not the supporting documents. The employee will not see their opinion.',
    candMgrCur: 'Direct manager (current)', candMgrCycle: 'Direct manager (this cycle)', candHodCur: 'Head of department (current)', candHodCycle: 'Head of department (this cycle)',
    consultLimit: 'You can consult at most 4 people per appeal.', consultSend: 'Send request', consultDone: 'Request sent',
    secDecision: 'Decision', oMaintain: 'Maintain the rating', oAdjust: 'Adjust the rating', newRating: 'New rating', newRatingPh: 'Select a rating',
    reply: 'Reply to the employee', replyHint: 'The employee will see this reply. Explain the basis of the review and its outcome; do not include internal notes or the previous rating.',
    noteMaintain: 'Internal note (optional)', noteAdjust: 'Reason for adjustment (internal; recorded with the rating change)',
    infoHint: 'If you need more information or documents from the employee, contact them outside the system and record this in the internal note.',
    replyMin: (n) => `The reply needs at least ${n} characters`, noteRange: 'The reason for adjustment must be 10–1,000 characters', ratingNeed: 'Select the new rating',
    submit: 'Submit decision', confirmT: 'Submit the decision?',
    confirmMaintain: 'The decision is final once submitted; the employee will be notified.',
    confirmAdjust: (r) => `The decision is final once submitted. The rating will change to ${r}, and the employee, the head of department and the direct manager will be notified.`,
    decided: 'Decision submitted', outcomeL: 'Outcome', newRatingL: 'New rating', replyL: 'Reply to the employee', noteL: 'Internal note', reasonL: 'Reason for adjustment', decidedBy: 'Decided by', decidedOn: (n, t) => `${n} · ${t}`,
    withdrawnNote: (t) => `The employee withdrew this appeal on ${t}.`,
    leaveAsk: 'The decision has not been submitted. What you entered will be lost if you leave. Leave anyway?',
    secStatus: 'Appeal status', slaDue: 'Response due', handler: 'Handled by', hrbps: 'Covering HRBPs', routedVia: 'Routed via', fallbackNote: 'No HRBP is available for this department; administrators with performance management access handle it',
    deptAtRating: 'Department at rating', deptWhenFiled: 'Department when filed', deptNow: 'Current department',
    secAppellant: 'Appellant', empId: 'Employee ID', position: 'Position', level: 'Job level', manager: 'Direct manager (current)', hod: 'Head of department (current)', notInService: 'Left the company',
    start: 'Start review', startT: 'Start the review?', startAsk: 'Once you start the review, the employee can no longer withdraw the appeal.', started: 'Review started',
    reassign: 'Reassign', reassignT: 'Reassign the appeal', reassignTo: 'Reassign to', reassignPh: 'Select a handler', reassignNone: 'There is no other handler to reassign to.', reassigned: 'Reassigned',
    takeOver: 'Take over', takeOverT: 'Take over this appeal?', takeOverAsk: 'The previous handler no longer covers this department. Once you take over, you make the decision.', tookOver: 'You are now handling this appeal',
    secActivity: 'Activity', ev: {
      submit: 'Appeal submitted', withdraw: 'Withdrawn by employee', start: 'Review started', reassign: 'Reassigned', consult: 'Opinion requested', opinion: 'Opinion submitted',
      maintain: 'Rating maintained', adjust: 'Rating adjusted', remind_soon: 'Due-soon reminder', remind_overdue: 'Overdue reminder', escalate: 'Overdue escalation',
      view: 'Case viewed', appellant_exited: 'Appellant had left',
    },
    system: 'System', timeline: 'Time',
    ok: 'Confirm', cancel: 'Cancel', done: 'Saved',
    err: {
      appeal_not_found: 'Appeal not found.', not_found: 'Appeal not found.', appeal_state: 'The appeal status has changed. Refresh and try again.',
      appeal_no_permission: 'You do not have permission to act on this appeal.', appeal_reply: 'The reply to the employee must be 20–4,000 characters.',
      appeal_note: 'A reason for the adjustment is required (10–1,000 characters); internal notes are limited to 4,000 characters.', rating_invalid: 'Choose a valid rating that differs from the current one.',
      rating_changed: 'This employee’s rating has changed. Refresh before deciding.', record_missing: 'The performance record could not be found.',
      consultee_invalid: 'You can consult only the employee’s direct manager or head of department.', consult_exists: 'This person has already been consulted.', consult_limit: 'You can consult at most 4 people per appeal.',
      assignee_invalid: 'You can reassign only to a handler who covers this department and has no conflict of interest.',
    },
  },
};

const OPEN = ['submitted', 'in_review'];
const CLOSED = ['withdrawn', 'maintained', 'adjusted'];
const STATUS_KEYS = ['submitted', 'in_review', 'overdue', 'closed', 'all'];
const STATUS_COLOR = { submitted: 'amber', in_review: 'blue', withdrawn: 'grey', maintained: 'green', adjusted: 'violet' };
const QUOTA_MIN_HC = 10;          // 与服务端 REVIEW_QUOTA_MIN_HC 相同；只用于「不适用名额」那句话里的人数，服务端另给 small
const REPLY_MIN = 20, REPLY_MAX = 4000, NOTE_MAX = 4000, REASON_MIN = 10, REASON_MAX = 1000, QUESTION_MAX = 1000, CONSULT_MAX = 4;

const isOpen = (r) => !!r && OPEN.includes(r.status);
const nonEmpty = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const textOf = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? String(v.text || v.title || v.goal || v.name || '') : String(v));
const stamp = (v) => (v ? localStamp(v) : '');
const errOf = (s, err) => {
  const code = err && err.data && err.data.code;
  return (code && s.err[code]) || (err && err.message) || '';
};
const statusOf = (r) => (STATUS_KEYS.includes(r) ? r : 'all');
function matchStatus(r, k) {
  if (k === 'submitted') return r.status === 'submitted';
  if (k === 'in_review') return r.status === 'in_review';
  if (k === 'overdue') return isOpen(r) && !!r.overdue;
  if (k === 'closed') return CLOSED.includes(r.status);
  return true;
}
// 排序：需要我处理的在前；未结的按答复时限升序；已关闭的按提交时间倒序
function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    if (!!b.actionable !== !!a.actionable) return b.actionable ? 1 : -1;
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
    if (isOpen(a)) { const c = String(a.slaDueOn || '').localeCompare(String(b.slaDueOn || '')); if (c) return c; }
    return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
  });
}
function DueCell({ r, s }) {
  // 测试反馈（10/8）：有结论后不再显示「—」，改为答复时限 + 按时 / 逾期答复
  if (!isOpen(r)) {
    if (!r.decidedAt || !r.slaDueOn) return <span className="u-hint rap-muted">—</span>;
    const decidedOn = new Date(Date.parse(r.decidedAt) + 8 * 3600e3).toISOString().slice(0, 10);
    return <span className="rap-due"><span className="u-date tnum">{r.slaDueOn}</span><span className={decidedOn <= r.slaDueOn ? 'rap-left' : 'rap-over'}>{decidedOn <= r.slaDueOn ? s.repliedOnTime : s.repliedLate}</span></span>;
  }
  const due = r.slaDueOn ? <span className="u-date tnum">{r.slaDueOn}</span> : null;
  if (r.overdue) return <span className="rap-due">{due}<span className="rap-over">{s.overdueBy(Number(r.overdueWorkdays) || 0)}</span></span>;
  const n = Number(r.workdaysLeft);
  return <span className="rap-due">{due}<span className="rap-left">{Number.isFinite(n) && n <= 0 ? s.dueToday : s.daysLeft(Number.isFinite(n) ? n : 0)}</span></span>;
}
function StatusTag({ r, s }) {
  return <Tag size="small" type="light" color={STATUS_COLOR[r.status] || 'grey'}>{s.st[r.status] || r.status}</Tag>;
}
function HandlerCell({ r, s }) {
  return (
    <span className="u-tag-wrap">
      <span>{r.handler ? r.handler.name : (r.status === 'submitted' ? s.notStarted : '—')}</span>
      {r.route === 'fallback' && <Tag size="small" type="light" color="orange" className="u-tag-gap">{s.noHrbp}</Tag>}
      {r.handlerStale && <Tag size="small" type="light" color="red" className="u-tag-gap">{s.stale}</Tag>}
    </span>
  );
}

export default function ReviewAppeals() {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const [params, patch] = useUrlState();
  const appealId = params.appeal ? String(params.appeal) : '';
  const listQ = useAsync(() => api.get('/api/admin/review-appeals'), []);
  const data = listQ.data;
  const caps = (data && data.caps) || {};
  const view = params.view === 'stats' && caps.stats ? 'stats' : 'list';
  const openCase = (id) => patch({ appeal: id }, { push: true });
  const closeCase = () => { if (!confirmLeave()) return; patch({ appeal: null }, { push: true }); };
  const dropCase = () => patch({ appeal: null }, { push: false });

  if (appealId) {
    return <AppealCase key={appealId} id={appealId} s={s} lang={lang} onBack={closeCase} onGone={dropCase} onChanged={() => listQ.reload()} />;
  }
  const me = (data && data.me) || {};
  const covers = (me.coverDepts || []).map((d) => d.name).filter(Boolean);
  return (
    <div className="wrap rap-page">
      <div className="tset-head rap-head">
        <div>
          <h1 className="tset-title">{s.title}</h1>
          <div className="tset-lead">{me.hrbp ? s.leadHrbp : s.leadOversight}</div>
          {me.hrbp && covers.length > 0 && <div className="u-hint rap-cover">{s.coverLine(covers.join(lang === 'zh' ? '、' : ', '))}</div>}
        </div>
        <Button icon={<IconRefresh />} theme="borderless" aria-label={s.refresh} title={s.refresh} onClick={() => listQ.reload()} />
      </div>
      {caps.stats && (
        <div className="rvc-views rap-views" role="tablist">
          {[['list', s.vList], ['stats', s.vStats]].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={'ppl-chip' + (view === k ? ' on' : '')}
              onClick={() => patch({ view: k === 'list' ? null : k }, { push: true })}>{label}</button>
          ))}
        </div>
      )}
      {listQ.error ? <Banner type={listQ.error.status === 404 ? 'warning' : 'danger'} fullMode={false} closeIcon={null} description={listQ.error.status === 404 ? s.noDesk : `${s.loadFail} · ${listQ.error.message}`} />   /* CX-014：无分工的 HRBP 不再静默 */
        : !data ? <div className="rap-loading"><Spin size="large" /></div>
          : view === 'stats' ? <StatsView s={s} lang={lang} params={params} patch={patch} />
            : <ListView s={s} lang={lang} data={data} params={params} patch={patch} onOpen={openCase} />}
    </div>
  );
}

function ListView({ s, lang, data, params, patch, onOpen }) {
  const { user } = useAuth();
  const rows = useMemo(() => (Array.isArray(data.items) ? data.items : []), [data]);
  const status = statusOf(params.status);
  const cycle = params.cycle ? String(params.cycle) : '';
  const dept = params.dept ? String(params.dept) : '';
  const q = params.q ? String(params.q) : '';
  const mine = params.mine === '1';
  const deptOptions = useMemo(() => {
    const o = data.deptOptions;
    return Array.isArray(o) ? o : o && Array.isArray(o.options) ? o.options : [];
  }, [data]);
  const canMine = rows.some((r) => r.view === 'full') || !!(data.me && data.me.hrbp);
  const setF = (k, v) => patch({ [k]: v || null }, { push: false });
  // 先按周期 / 部门 / 搜索 / 只看我的过滤，状态计数按这一层算（计数与点开后看到的行一致），再按状态过滤
  const base = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const inDept = pathMatcher(dept || null);
    return rows.filter((r) => {
      if (cycle && String(r.cycleId) !== cycle) return false;
      if (dept && !inDept(r)) return false;
      if (qq && !(String(r.name || '').toLowerCase().includes(qq) || String(r.employeeId || '').toLowerCase().includes(qq))) return false;
      if (mine && !(r.handler && user && String(r.handler.id) === String(user.id))) return false;
      return true;
    });
  }, [rows, cycle, dept, q, mine, user]);
  const counts = useMemo(() => Object.fromEntries(STATUS_KEYS.map((k) => [k, base.filter((r) => matchStatus(r, k)).length])), [base]);
  const shown = useMemo(() => sortRows(base.filter((r) => matchStatus(r, status))), [base, status]);
  const filtering = !!(cycle || dept || q || mine || status !== 'all');
  const [pg, setPg] = useState({ page: 1, size: DEFAULT_PAGE });
  useEffect(() => { setPg((p) => ({ ...p, page: 1 })); }, [status, cycle, dept, q, mine]);
  const cycles = Array.isArray(data.cycles) ? data.cycles : [];
  const columns = [
    // CX-091：1440 宽列宽合计 1240 → 1150，放进卡片，固定操作列不再压住右侧列
    // CX-091 / CX-125（R180 复测）：表格实际内容宽比列宽合计多约 70px（单元格内边距与固定列），列宽合计压到 1,020，
    // 1440 下内容宽约 1,090 < 可见 1,148；部门 120（英文表头 DEPARTMENT 不断词）；提交时间分日期 / 时刻两行；答复时限允许换行
    { title: s.cEmp, dataIndex: 'name', width: 130, render: (_, r) => (
      <div className="rap-emp"><b>{r.name}</b><span className="u-hint tnum">{r.employeeId || ''}</span></div>
    ) },
    { title: s.cDept, dataIndex: 'department', width: 120, render: (v) => <span className="u-ellipsis" title={v || ''}>{v || '—'}</span> },
    { title: s.cCycle, dataIndex: 'cycle', width: 110 },
    { title: s.cRating, dataIndex: 'ratingAtSubmit', width: 110, render: (v) => <span className="tnum">{v || '—'}</span> },
    { title: s.cSubmitted, dataIndex: 'submittedAt', width: 112, render: (v) => { const t = stamp(v); if (!t) return '—'; const i = t.indexOf(' '); return <span className="u-date tnum rap-stamp">{i > 0 ? <>{t.slice(0, i)}<br />{t.slice(i + 1)}</> : t}</span>; } },
    { title: s.cStatus, dataIndex: 'status', width: 140, render: (_, r) => <StatusTag r={r} s={s} /> },
    { title: s.cHandler, dataIndex: 'handler', width: 100, render: (_, r) => <HandlerCell r={r} s={s} /> },
    { title: s.cDue, dataIndex: 'slaDueOn', width: 120, render: (_, r) => <DueCell r={r} s={s} /> },
    { title: s.cAct, dataIndex: 'act', width: 80, fixed: 'right', render: (_, r) => (
      <Button size="small" theme={r.actionable ? 'solid' : 'light'} type="primary" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>
        {r.actionable ? s.review : s.view}
      </Button>
    ) },
  ];
  const total = shown.length;
  const page = clampPage(pg.page, total, pg.size);
  return (
    <>
      <div className="rs-chips rap-chips">
        {STATUS_KEYS.map((k) => (
          <button key={k} type="button" data-f={k} aria-pressed={status === k}
            className={'pill ' + (k === 'overdue' ? 'fail' : k === 'submitted' ? 'warn' : k === 'in_review' ? 'pri' : 'muted') + ' rs-chip' + (status === k ? ' on' : '')}
            onClick={() => setF('status', k === 'all' ? null : k)}>
            {s.f[k]} <b className="tnum">{counts[k]}</b>
          </button>
        ))}
      </div>
      <div className="u-filterbar">
        <Select insetLabel={s.fCycle} placeholder={s.fCycleAll} showClear value={cycle || undefined} className="u-w-lg"
          onChange={(v) => setF('cycle', v)} optionList={cycles.map((c) => ({ value: String(c.id), label: c.name }))} />
        <DeptFilter options={deptOptions} value={dept || null} lang={lang} label={s.fDept} placeholder={s.fDeptAll}
          ready={deptOptions.length > 0} onChange={(v) => setF('dept', v)}
          onInvalid={() => { Toast.info(deptFilterInvalidText(lang)); setF('dept', null); }} />
        <Input prefix={<IconSearch />} showClear placeholder={s.searchPh} value={q} className="rap-search" aria-label={s.searchPh}
          onChange={(v) => setF('q', v)} />
        {canMine && (
          <label className="rap-mine"><Switch size="small" checked={mine} onChange={(v) => setF('mine', v ? '1' : null)} aria-label={s.mine} />{s.mine}</label>
        )}
        <span className="u-count">{s.count(total, rows.length)}</span>
        {filtering && <Button size="small" theme="borderless" className="u-filterbar-end" onClick={() => patch({ status: null, cycle: null, dept: null, q: null, mine: null }, { push: false })}>{s.clear}</Button>}
      </div>
      <div className="ppl-card rap-tablecard">
        <Table rowKey="id" size="small" dataSource={shown}
          onRow={(r) => ({ onClick: () => onOpen(r.id), className: 'u-click' + (r.actionable ? ' rap-row-act' : '') })}
          pagination={total > pg.size || pg.size !== DEFAULT_PAGE ? {
            currentPage: page, pageSize: pg.size, pageSizeOpts: PAGE_TIERS, showSizeChanger: true,
            onPageChange: (p) => setPg((x) => ({ ...x, page: p })), onPageSizeChange: (n) => setPg({ page: 1, size: n }),
          } : false}
          empty={<Empty description={rows.length ? s.emptyFiltered : s.empty} />}
          {...resizableTable(dataTableColumns(columns, { titleKey: 'name' }), { skip: ['name'] })} />
      </div>
    </>
  );
}

function StatsView({ s, lang, params, patch }) {
  const q = useAsync(() => api.get('/api/admin/review-appeals/stats'), []);
  const list = (q.data && Array.isArray(q.data.cycles)) ? q.data.cycles : [];
  const scope = (q.data && q.data.scope) || 'all';
  const pick = params.cycle && list.some((c) => String(c.cycleId) === String(params.cycle)) ? String(params.cycle) : (list[0] ? String(list[0].cycleId) : '');
  const cur = list.find((c) => String(c.cycleId) === pick) || null;
  const pct = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${Math.round(Number(v) * 1000) / 10}%`);
  const num = (v) => (v === null || v === undefined ? '—' : String(v));
  const kindOf = (c) => (c.flow === 'v2' ? (c.kind === 'annual' ? s.kindAnnual : s.kindQuarter) : s.kindLegacy);
  const eligibleOf = (c) => (c.eligible !== undefined && c.eligible !== null ? c.eligible : c.archived);
  if (q.error) return <Banner type="danger" fullMode={false} closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} />;
  if (!q.data) return <div className="rap-loading"><Spin size="large" /></div>;
  if (!list.length) return <div className="ppl-card"><Empty description={s.sEmpty} /></div>;
  const decided = cur ? (Number(cur.maintained) || 0) + (Number(cur.adjusted) || 0) : 0;
  const hideEligible = scope === 'hrbp';
  const columns = [
    { title: s.sCycle, dataIndex: 'name', width: 190, render: (v, c) => <span className="u-tag-wrap"><b>{v}</b>{c.windowOpen && <Tag size="small" type="light" color="green" className="u-tag-gap">{s.sWindowOpen}</Tag>}</span> },
    { title: s.sKind, dataIndex: 'kind', width: 90, render: (_, c) => kindOf(c) },
    { title: s.sComm, dataIndex: 'communicatedOn', width: 120, render: (v) => <span className="u-date tnum">{v || '—'}</span> },
    { title: s.sDeadline, dataIndex: 'deadline', width: 120, render: (v) => <span className="u-date tnum">{v || '—'}</span> },
    ...(hideEligible ? [] : [{ title: s.sEligible, dataIndex: 'eligible', width: 100, render: (_, c) => <span className="tnum">{num(eligibleOf(c))}</span> }]),
    // CX-215：申诉数不含已撤回（撤回在下一列），与看板同口径
    { title: s.sAppeals, dataIndex: 'appeals', width: 80, render: (v, c) => <span className="tnum">{num(c.appealsExclWithdrawn ?? ((v || 0) - (c.withdrawn || 0)))}</span> },
    { title: s.sWithdrawn, dataIndex: 'withdrawn', width: 80, render: (v) => <span className="tnum">{num(v)}</span> },
    { title: s.sOpen, dataIndex: 'open', width: 80, render: (v) => <span className="tnum">{num(v)}</span> },
    { title: s.sMaintained, dataIndex: 'maintained', width: 80, render: (v) => <span className="tnum">{num(v)}</span> },
    { title: s.sAdjusted, dataIndex: 'adjusted', width: 80, render: (v) => <span className="tnum">{num(v)}</span> },
    { title: s.sAdjustRate, dataIndex: 'adjustRate', width: 100, render: (v) => <span className="tnum">{pct(v)}</span> },
    { title: s.sAvg, dataIndex: 'avgHandleWorkdays', width: 150, render: (v) => <span className="tnum">{v === null || v === undefined ? '—' : String(v)}</span> },
  ];
  return (
    <>
      <div className="u-filterbar">
        <Select insetLabel={s.sCycle} value={pick || undefined} className="u-w-lg" onChange={(v) => patch({ cycle: v || null }, { push: false })}
          optionList={list.map((c) => ({ value: String(c.cycleId), label: c.name }))} />
      </div>
      {cur && (
        <div className="rvc-kpis rap-kpis">
          <div className="rvc-kpi"><div className="rvc-kpi-l">{s.kAppeals}</div><div className="rvc-kpi-v tnum">{num(cur.appealsExclWithdrawn ?? ((cur.appeals || 0) - (cur.withdrawn || 0)))}</div></div>
          {!hideEligible && <div className="rvc-kpi"><div className="rvc-kpi-l">{s.kRate}</div><div className="rvc-kpi-v tnum">{pct(cur.appealRate)}</div><div className="rvc-kpi-n tnum">{s.kRateN(num(cur.appealsExclWithdrawn ?? ((cur.appeals || 0) - (cur.withdrawn || 0))), num(eligibleOf(cur)))}</div></div>}
          <div className="rvc-kpi"><div className="rvc-kpi-l">{s.kAdjust}</div><div className="rvc-kpi-v tnum">{pct(cur.adjustRate)}</div></div>
          <div className="rvc-kpi"><div className="rvc-kpi-l">{s.kAvg}</div><div className="rvc-kpi-v tnum">{cur.avgHandleWorkdays === null || cur.avgHandleWorkdays === undefined ? '—' : s.kAvgUnit(cur.avgHandleWorkdays)}</div></div>
          <div className="rvc-kpi"><div className="rvc-kpi-l">{s.kSla}</div><div className="rvc-kpi-v tnum">{decided ? pct((Number(cur.withinSla) || 0) / decided) : '—'}</div><div className="rvc-kpi-n tnum">{s.kSlaN(Number(cur.withinSla) || 0, decided)}</div></div>
          <div className="rvc-kpi"><div className="rvc-kpi-l">{s.kOverdue}</div><div className={'rvc-kpi-v tnum' + (Number(cur.overdue) > 0 ? ' rap-over' : '')}>{num(cur.overdue)}</div></div>
        </div>
      )}
      <div className="ppl-card rap-tablecard rap-stats-table">
        <Table rowKey="cycleId" size="small" dataSource={list} pagination={false} {...resizableTable(dataTableColumns(columns, { titleKey: 'name' }), { skip: ['name'] })} />
      </div>
      <div className="tset-foot">{s.sFoot}</div>
    </>
  );
}

// ---------------- 案卷（整页） ----------------
function AppealCase({ id, s, lang, onBack, onGone, onChanged }) {
  const { user } = useAuth();
  const [tick, setTick] = useState(0);
  const q = useAsync(() => api.get(`/api/admin/review-appeals/${encodeURIComponent(id)}`), [id, tick]);
  const d = q.data;
  const reload = () => { setTick((n) => n + 1); onChanged(); };
  useEffect(() => {
    if (q.error && q.error.status === 404) { Toast.warning(s.notFound); onGone(); }
  }, [q.error]); // eslint-disable-line react-hooks/exhaustive-deps

  // 结论表单（只有处理人、且 canDecide 时可填）
  const [outcome, setOutcome] = useState('maintain');
  const [newRating, setNewRating] = useState('');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const perms = (d && d.permissions) || {};
  const canDecide = !!(d && d.view === 'full' && perms.canDecide);
  const dirty = canDecide && !!(reply.trim() || note.trim() || newRating || outcome !== 'maintain');
  useLeaveGuard(dirty, s.leaveAsk);
  const resetForm = () => { setOutcome('maintain'); setNewRating(''); setReply(''); setNote(''); setTried(false); };

  // 弹窗
  const [modal, setModal] = useState(null);   // 'start' | 'consult' | 'reassign' | 'takeover' | 'decide'
  const [busy, setBusy] = useState(false);
  const [consultee, setConsultee] = useState('');
  const [question, setQuestion] = useState('');
  const [assignee, setAssignee] = useState('');
  const close = () => { if (!busy) setModal(null); };
  const act = async (path, body, okText, after) => {
    setBusy(true);
    try {
      await api.post(`/api/admin/review-appeals/${encodeURIComponent(id)}/${path}`, body || {});
      Toast.success(okText);
      setModal(null);
      if (after) after();
      reload();
    } catch (err) {
      Toast.error(errOf(s, err) || s.loadFail);
      const code = err && err.data && err.data.code;
      if (err && err.status === 404) onGone();
      else if (code === 'appeal_state' || code === 'rating_changed') { setModal(null); reload(); }
    } finally { setBusy(false); }
  };

  if (q.error && q.error.status !== 404) {
    return (
      <div className="wrap rap-page rap-case">
        <div className="co-page-bar"><Button theme="borderless" icon={<IconArrowLeft />} onClick={onBack}>{s.back}</Button></div>
        <Banner type="danger" fullMode={false} closeIcon={null} description={`${s.loadFail} · ${q.error.message}`} />
      </div>
    );
  }
  if (!d || !d.appeal) {
    return (
      <div className="wrap rap-page rap-case">
        <div className="co-page-bar"><Button theme="borderless" icon={<IconArrowLeft />} onClick={onBack}>{s.back}</Button></div>
        <div className="rap-loading"><Spin size="large" /></div>
      </div>
    );
  }
  const ap = d.appeal;
  const full = d.view === 'full';
  const opts = Array.isArray(d.ratingOptions) ? d.ratingOptions : [];
  const rl = (v) => {
    if (!nonEmpty(v)) return '—';
    const i = opts.indexOf(v);
    const zh = i >= 0 ? (d.ratingOptions_zh || [])[i] : null;
    return lang === 'zh' && zh ? zh : String(v);
  };
  const review = d.review || {};
  const curRating = review.recordRating !== undefined && review.recordRating !== null ? review.recordRating : ap.currentRating;
  const reassignOpts = (Array.isArray(d.reassignOptions) ? d.reassignOptions : []).filter((o) => !(ap.handler && String(o.id) === String(ap.handler.id)));
  const title = s.caseTitle(ap.name || '', ap.cycle || '');
  const decidedCase = ap.status === 'maintained' || ap.status === 'adjusted';
  const replyLen = reply.trim().length;
  const noteLen = note.trim().length;
  const formErr = {
    rating: outcome === 'adjust' && !newRating ? s.ratingNeed : '',
    reply: replyLen < REPLY_MIN ? s.replyMin(REPLY_MIN) : '',
    note: outcome === 'adjust' && (noteLen < REASON_MIN || noteLen > REASON_MAX) ? s.noteRange : '',
  };
  const formOk = !formErr.rating && !formErr.reply && !formErr.note;
  const askDecide = () => { setTried(true); if (formOk) setModal('decide'); };
  const sendDecide = () => act('decide', outcome === 'adjust'
    ? { outcome, reply: reply.trim(), internalNote: note.trim(), newRating, expectRating: curRating }
    : { outcome, reply: reply.trim(), internalNote: note.trim() || undefined, expectRating: curRating },
  s.decided, resetForm);

  const head = (
    <div className="co-page-bar rap-bar">
      <Button theme="borderless" icon={<IconArrowLeft />} onClick={onBack}>{s.back}</Button>
      <div className="co-page-titles">
        <h1 className="co-page-title" title={title}>{title}</h1>
        <div className="co-page-sub">{[ap.employeeId, ap.department].filter(Boolean).join(' · ')}</div>
      </div>
      <span className="u-tag-wrap rap-bar-tags">
        <StatusTag r={ap} s={s} />
        {isOpen(ap) && ap.overdue && <Tag size="small" type="light" color="red" className="u-tag-gap">{s.overdueTag(Number(ap.overdueWorkdays) || 0)}</Tag>}
        {ap.route === 'fallback' && <Tag size="small" type="light" color="orange" className="u-tag-gap">{s.noHrbp}</Tag>}
        {ap.handlerStale && <Tag size="small" type="light" color="red" className="u-tag-gap">{s.stale}</Tag>}
      </span>
    </div>
  );

  const side = (
    <aside className="exm-page-side rap-side">
      <StatusCard s={s} d={d} ap={ap} full={full} />
      {(perms.canStart || perms.canReassign || perms.canTakeOver) && (
        <div className="card co-ed-card rap-actions">
          {perms.canStart && <Button block theme="solid" type="primary" onClick={() => setModal('start')}>{s.start}</Button>}
          {perms.canTakeOver && <Button block theme="solid" type="primary" onClick={() => setModal('takeover')}>{s.takeOver}</Button>}
          {perms.canReassign && ap.status === 'in_review' && <Button block onClick={() => { setAssignee(''); setModal('reassign'); }}>{s.reassign}</Button>}
        </div>
      )}
      {full && d.appellant && <AppellantCard s={s} d={d} ap={ap} />}
      {full ? <Activity s={s} events={ap.events || []} /> : <MetaTimeline s={s} ap={ap} />}
    </aside>
  );

  const modals = (
    <>
      <Modal visible={modal === 'start'} title={s.startT} width={440} maskClosable={false} onCancel={close} confirmLoading={busy}
        okText={s.start} cancelText={s.cancel} onOk={() => act('start', {}, s.started)}>
        <p className="u-lead rap-modal-p">{s.startAsk}</p>
      </Modal>
      <Modal visible={modal === 'takeover'} title={s.takeOverT} width={440} maskClosable={false} onCancel={close} confirmLoading={busy}
        okText={s.takeOver} cancelText={s.cancel} onOk={() => act('reassign', { toUserId: user && user.id }, s.tookOver)}>
        <p className="u-lead rap-modal-p">{s.takeOverAsk}</p>
      </Modal>
      <Modal visible={modal === 'reassign'} title={s.reassignT} width={460} maskClosable={false} onCancel={close} confirmLoading={busy}
        okText={s.reassign} cancelText={s.cancel} okButtonProps={{ disabled: !assignee }}
        onOk={() => act('reassign', { toUserId: assignee }, s.reassigned)}>
        {reassignOpts.length ? (
          <div className="rap-field">
            <label className="rap-label" htmlFor="rap-assignee">{s.reassignTo}</label>
            <Select id="rap-assignee" value={assignee || undefined} placeholder={s.reassignPh} style={{ width: '100%' }} filter
              onChange={(v) => setAssignee(v || '')} optionList={reassignOpts.map((o) => ({ value: String(o.id), label: o.name }))} />
          </div>
        ) : <p className="u-hint">{s.reassignNone}</p>}
      </Modal>
      {full && (
        <Modal visible={modal === 'consult'} title={s.consultT} width={520} maskClosable={false} onCancel={close} confirmLoading={busy}
          okText={s.consultSend} cancelText={s.cancel} okButtonProps={{ disabled: !consultee }}
          onOk={() => act('consult', { consulteeId: consultee, ...(question.trim() ? { question: question.trim() } : {}) }, s.consultDone)}>
          <ConsultForm s={s} d={d} consultee={consultee} setConsultee={setConsultee} question={question} setQuestion={setQuestion} />
        </Modal>
      )}
      {canDecide && (
        <Modal visible={modal === 'decide'} title={s.confirmT} width={480} maskClosable={false} onCancel={close} confirmLoading={busy}
          okText={s.submit} cancelText={s.cancel} onOk={sendDecide}>
          <p className="u-lead rap-modal-p">{outcome === 'adjust' ? s.confirmAdjust(rl(newRating)) : s.confirmMaintain}</p>
        </Modal>
      )}
    </>
  );

  // 只看状态（绩效可读的监督视图）：不含任何申诉内容
  if (!full) {
    return (
      <div className="wrap rap-page rap-case">
        {head}
        <Banner type="info" fullMode={false} closeIcon={null} className="rap-banner" description={s.metaBanner} />
        <div className="exm-page-grid rap-grid rap-grid-meta">
          <div className="rap-main">
            <StatusCard s={s} d={d} ap={ap} full={false} />
          </div>
          <aside className="exm-page-side rap-side">
            {perms.canReassign && ap.status === 'in_review' && (
              <div className="card co-ed-card rap-actions"><Button block onClick={() => { setAssignee(''); setModal('reassign'); }}>{s.reassign}</Button></div>
            )}
            <MetaTimeline s={s} ap={ap} />
          </aside>
        </div>
        {modals}
      </div>
    );
  }

  const coHrbp = perms.readOnlyReason === 'not_handler' && ap.handler && !perms.canTakeOver;
  const exited = d.appellant && d.appellant.inService === false;
  return (
    <div className="wrap rap-page rap-case">
      {head}
      {coHrbp && <Banner type="info" fullMode={false} closeIcon={null} className="rap-banner" description={s.coBanner(ap.handler.name)} />}
      {exited && <Banner type="warning" fullMode={false} closeIcon={null} className="rap-banner" description={s.exitedBanner} />}
      <div className="exm-page-grid rap-grid">
        <div className="rap-main">
          <section className="card co-ed-card rap-card">
            <h2 className="rap-h">{s.secReason}</h2>
            <div className="rap-pre">{ap.reason || '—'}</div>
            <dl className="rap-kv rap-kv-inline">
              <dt>{s.catL}</dt>
              <dd>
                {perms.canCategorize ? (
                  <Select size="small" value={ap.reasonCategory || undefined} placeholder={categoryLabel(null, s.langKey)} disabled={busy} style={{ width: 300, maxWidth: '100%' }}
                    aria-label={s.catFix} optionList={APPEAL_CATEGORIES.map((c) => ({ value: c.key, label: c[s.langKey] }))}
                    onChange={(v) => act('category', { category: v }, s.catSaved)} />
                ) : categoryLabel(ap.reasonCategory, s.langKey)}
                {perms.canCategorize && <div className="rap-hint">{s.catHint}</div>}
              </dd>
              <dt>{s.submittedAt}</dt><dd className="tnum">{stamp(ap.submittedAt) || '—'}</dd>
              <dt>{s.windowDeadline}</dt><dd className="tnum">{ap.windowDeadline || '—'}</dd>
            </dl>
          </section>
          <Files s={s} files={ap.attachments || []} />
          <ReviewMaterials s={s} d={d} rl={rl} />
          <Distribution s={s} d={d} rl={rl} newRating={canDecide && outcome === 'adjust' ? newRating : ''} />
          <Consults s={s} ap={ap} canConsult={!!perms.canConsult} onAsk={() => { setConsultee(''); setQuestion(''); setModal('consult'); }} />
          {canDecide && (
            <section className="card co-ed-card rap-card rap-decide">
              <h2 className="rap-h">{s.secDecision}</h2>
              <RadioGroup value={outcome} onChange={(e) => setOutcome(e.target.value)} className="rap-outcome" aria-label={s.secDecision}>
                <Radio value="maintain">{s.oMaintain}</Radio>
                <Radio value="adjust">{s.oAdjust}</Radio>
              </RadioGroup>
              {outcome === 'adjust' && (
                <div className="rap-field">
                  <label className="rap-label" htmlFor="rap-newrating">{s.newRating}</label>
                  <Select id="rap-newrating" value={newRating || undefined} placeholder={s.newRatingPh} className="rap-rating-sel"
                    onChange={(v) => setNewRating(v || '')}
                    optionList={opts.filter((o) => o !== curRating).map((o) => ({ value: o, label: rl(o) }))} />
                  {tried && formErr.rating && <div className="rap-err">{formErr.rating}</div>}
                </div>
              )}
              <div className="rap-field">
                <label className="rap-label" htmlFor="rap-reply">{s.reply}</label>
                <div className="u-hint rap-hint">{s.replyHint}</div>
                <TextArea id="rap-reply" rows={5} value={reply} maxCount={REPLY_MAX} maxLength={REPLY_MAX} onChange={setReply} />
                {tried && formErr.reply && <div className="rap-err">{formErr.reply}</div>}
              </div>
              <div className="rap-field">
                <label className="rap-label" htmlFor="rap-note">{outcome === 'adjust' ? s.noteAdjust : s.noteMaintain}</label>
                <div className="u-hint rap-hint">{s.infoHint}</div>
                <TextArea id="rap-note" rows={3} value={note} maxCount={outcome === 'adjust' ? REASON_MAX : NOTE_MAX}
                  maxLength={outcome === 'adjust' ? REASON_MAX : NOTE_MAX} onChange={setNote} />
                {tried && formErr.note && <div className="rap-err">{formErr.note}</div>}
              </div>
              <div className="exm-page-foot rap-foot">
                <Button theme="solid" type="primary" onClick={askDecide}>{s.submit}</Button>
              </div>
            </section>
          )}
          {decidedCase && <DecisionView s={s} ap={ap} rl={rl} />}
          {ap.status === 'withdrawn' && <div className="tset-foot">{s.withdrawnNote(stamp(ap.withdrawnAt) || '—')}</div>}
        </div>
        {side}
      </div>
      {modals}
    </div>
  );
}

function StatusCard({ s, d, ap, full }) {
  const routeDept = ap.closeDept || ap.deptName || null;
  const cur = d.appellant && d.appellant.department;
  const moved = full && routeDept && cur && routeDept !== cur;
  return (
    <section className="card co-ed-card rap-card rap-status">
      <h2 className="rap-h">{s.secStatus}</h2>
      <dl className="rap-kv">
        <dt>{s.cStatus}</dt><dd><StatusTag r={ap} s={s} /></dd>
        <dt>{s.submittedAt}</dt><dd className="tnum">{stamp(ap.submittedAt) || '—'}</dd>
        <dt>{s.slaDue}</dt><dd><DueCell r={ap} s={s} /></dd>
        <dt>{s.handler}</dt><dd><HandlerCell r={ap} s={s} /></dd>
        {full && <><dt>{s.hrbps}</dt><dd>{(ap.hrbps || []).map((h) => h.name).join(', ') || '—'}</dd></>}
        <dt>{s.routedVia}</dt>
        <dd>{ap.route === 'fallback' ? <span className="u-hint rap-inline">{s.fallbackNote}</span> : (ap.coverDept && ap.coverDept.name) || '—'}</dd>
        {moved && <><dt>{ap.closeDept ? s.deptAtRating : s.deptWhenFiled}</dt><dd>{routeDept}</dd><dt>{s.deptNow}</dt><dd>{cur}</dd></>}
      </dl>
    </section>
  );
}

function AppellantCard({ s, d }) {
  const a = d.appellant || {};
  return (
    <section className="card co-ed-card rap-card">
      <h2 className="rap-h">{s.secAppellant}</h2>
      <dl className="rap-kv">
        <dt>{s.empId}</dt><dd className="tnum">{a.employeeId || '—'}{a.inService === false && <Tag size="small" type="light" color="grey" className="u-tag-gap">{s.notInService}</Tag>}</dd>
        <dt>{s.cDept}</dt><dd>{a.department || '—'}</dd>
        <dt>{s.position}</dt><dd>{a.position || '—'}</dd>
        <dt>{s.level}</dt><dd>{[a.jobLevel, a.jobGrade].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>{s.manager}</dt><dd>{(a.manager && a.manager.name) || '—'}</dd>
        <dt>{s.hod}</dt><dd>{(a.hod && a.hod.name) || '—'}</dd>
      </dl>
    </section>
  );
}

function Activity({ s, events }) {
  const list = Array.isArray(events) ? events : [];
  return (
    <section className="card co-ed-card rap-card">
      <h2 className="rap-h">{s.secActivity}</h2>
      {list.length ? (
        <ol className="rap-tl">
          {list.map((e, i) => (
            <li key={i}>
              <span className="rap-tl-k">{s.ev[e.kind] || e.kind}</span>
              <span className="u-hint tnum">{stamp(e.at)}{' · '}{e.actor && e.actor.name ? e.actor.name : s.system}</span>
            </li>
          ))}
        </ol>
      ) : <div className="u-hint">—</div>}
    </section>
  );
}

function MetaTimeline({ s, ap }) {
  const rows = [
    ['submit', ap.submittedAt],
    ['start', ap.startedAt],
    [ap.status === 'withdrawn' ? 'withdraw' : ap.outcome === 'adjust' || ap.status === 'adjusted' ? 'adjust' : 'maintain', ap.status === 'withdrawn' ? ap.withdrawnAt : ap.decidedAt],
  ].filter(([, at]) => !!at);
  return (
    <section className="card co-ed-card rap-card">
      <h2 className="rap-h">{s.secActivity}</h2>
      {rows.length ? (
        <ol className="rap-tl">
          {rows.map(([k, at]) => <li key={k}><span className="rap-tl-k">{s.ev[k]}</span><span className="u-hint tnum">{stamp(at)}</span></li>)}
        </ol>
      ) : <div className="u-hint">—</div>}
    </section>
  );
}

function Files({ s, files }) {
  const list = Array.isArray(files) ? files : [];
  const [pdf, setPdf] = useState('');
  const [img, setImg] = useState(null);
  const size = (n) => {
    const v = Number(n) || 0;
    return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(v / 1024))} KB`;
  };
  return (
    <section className="card co-ed-card rap-card">
      <h2 className="rap-h">{s.secFiles}</h2>
      {!list.length ? <div className="u-hint">{s.noFiles}</div> : (
        <ul className="rap-files">
          {list.map((f) => {
            const isPdf = f.kind === 'pdf';
            const on = isPdf && pdf === f.id;
            return (
              <li key={f.id} className={on ? 'on' : ''}>
                <span className="rap-file-n" title={f.name}>{f.name}</span>
                <span className="u-hint tnum">{isPdf ? s.filePdf : s.fileImg} · {size(f.size)}</span>
                <Button size="small" theme="light" onClick={() => (isPdf ? setPdf(on ? '' : f.id) : setImg(f))}>
                  {isPdf ? (on ? s.closePdf : s.openPdf) : s.preview}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {pdf && (() => {
        const f = list.find((x) => x.id === pdf);
        return f ? <div className="rap-pdf"><PdfViewer key={f.id} url={f.url || `/api/attachments/${f.id}`} /></div> : null;
      })()}
      <Modal visible={!!img} title={img ? img.name : ''} footer={null} width={760} onCancel={() => setImg(null)} className="rap-img-modal">
        {img && <img className="rap-img" src={img.url || `/api/attachments/${img.id}`} alt={img.name || ''} />}
      </Modal>
    </section>
  );
}

function Kv({ k, v, pre }) {
  return <><dt>{k}</dt><dd className={pre ? 'rap-pre' : undefined}>{v}</dd></>;
}

function ReviewMaterials({ s, d, rl }) {
  const r = d.review || {};
  const c = d.cycle || {};
  const annual = c.kind === 'annual';
  const legacy = c.flow !== 'v2';
  const self = r.self || null;
  const t = (v) => (nonEmpty(textOf(v)) ? textOf(v) : s.none);
  const prev = (self && Array.isArray(self.prevGoals) ? self.prevGoals : null) || (Array.isArray(r.prevGoals) ? r.prevGoals : []);
  const outs = self && Array.isArray(self.selfOutcomes) ? self.selfOutcomes : [];
  const ds = d.deptStatus;
  const log = Array.isArray(d.calibrationLog) ? d.calibrationLog : [];
  const mgrState = r.manager && r.manager.status && r.manager.status !== 'active' ? s.exitedMark : '';
  return (
    <section className="card co-ed-card rap-card">
      <h2 className="rap-h">{s.secReview}</h2>
      {annual ? <div className="tset-foot rap-note">{s.annualNote}</div> : (
        <>
          <h3 className="rap-h3">{s.hSelf}{r.selfAt ? <span className="u-hint tnum rap-h3-at">{stamp(r.selfAt)}</span> : null}</h3>
          {self ? (
            <dl className="rap-kv">
              {prev.map((g, i) => <Kv key={'g' + i} k={s.prevGoal(i + 1)} v={<>{t(g)}<span className="rap-sub-k">{s.outcome}</span>{t(outs[i])}</>} pre />)}
              {!prev.length && outs.some((x) => nonEmpty(textOf(x))) && <Kv k={s.outcome} v={outs.map(textOf).filter(Boolean).join(' / ')} pre />}
              <Kv k={s.challenges} v={t(self.selfChallenges)} pre />
              <Kv k={s.feedback} v={t(self.selfFeedback)} pre />
              {nonEmpty(self.selfExtra) && <Kv k={s.extra} v={self.selfExtra} pre />}
              <Kv k={s.goalsNext} v={(Array.isArray(self.goalsNext) ? self.goalsNext.map(textOf).filter(Boolean).join(' / ') : '') || s.none} pre />
            </dl>
          ) : <div className="u-hint">{s.none}</div>}
          <h3 className="rap-h3">{s.hMgr}{r.managerAt ? <span className="u-hint tnum rap-h3-at">{stamp(r.managerAt)}</span> : null}</h3>
          <dl className="rap-kv">
            <Kv k={s.mgrName} v={r.manager ? `${r.manager.name || '—'}${mgrState}` : '—'} />
            <Kv k={s.mgrRating} v={rl(r.managerRating)} />
            <Kv k={s.mgrText} v={t(r.managerText)} pre />
            {nonEmpty(r.highlights) && <Kv k={s.highlights} v={r.highlights} pre />}
          </dl>
          <h3 className="rap-h3">{s.hOne}</h3>
          <dl className="rap-kv">
            <Kv k={s.oneMgr} v={stamp(r.oneOnOneAt) || '—'} />
            <Kv k={s.oneEmp} v={stamp(r.employeeOneOnOneAt) || '—'} />
            <Kv k={s.oneNotes} v={t(r.oneOnOneNotes)} pre />
          </dl>
        </>
      )}
      <h3 className="rap-h3">{s.hCal}{r.hodAt ? <span className="u-hint tnum rap-h3-at">{stamp(r.hodAt)}</span> : null}</h3>
      <dl className="rap-kv">
        <Kv k={s.finalRating} v={<span className="u-tag-wrap">{rl(r.finalRating)}{r.hodProxy ? <Tooltip content={s.proxyHint}><Tag size="small" type="light" color="amber" className="u-tag-gap">{s.proxy}</Tag></Tooltip> : null}</span>} />
        <Kv k={s.hodName} v={(r.hod && r.hod.name) || '—'} />
        {nonEmpty(r.hodText) && <Kv k={s.hodText} v={r.hodText} pre />}
        {!legacy && ds && (
          <>
            {ds.hodSubmittedAt && <Kv k={s.hodSubmitted} v={`${stamp(ds.hodSubmittedAt)}${ds.hod && ds.hod.name ? ` · ${ds.hod.name}` : ''}`} />}
            {ds.returnedAt && <Kv k={s.returned} v={`${stamp(ds.returnedAt)}${nonEmpty(ds.returnReason) ? ` · ${ds.returnReason}` : ''}`} />}
            {ds.hrConfirmedAt && <Kv k={s.hrConfirmed} v={`${stamp(ds.hrConfirmedAt)}${ds.hr && ds.hr.name ? ` · ${ds.hr.name}` : ''}`} />}
          </>
        )}
        {log.length > 0 && (
          <Kv k={s.calLog} v={(
            <ul className="rap-log">
              {log.map((x, i) => (
                <li key={i}><span className="tnum">{stamp(x.at)}</span>{x.by && x.by.name ? ` · ${x.by.name}` : ''}{` · ${rl(x.from)} → ${rl(x.to)}`}{nonEmpty(x.reason) ? ` · ${x.reason}` : ''}</li>
              ))}
            </ul>
          )} />
        )}
      </dl>
      <h3 className="rap-h3">{s.hRecord}</h3>
      <dl className="rap-kv">
        <Kv k={s.recordRating} v={<span className="u-tag-wrap"><b>{rl(r.recordRating)}</b>{nonEmpty(r.amendedFrom) && <Tag size="small" type="light" color="amber" className="u-tag-gap">{s.amended(rl(r.amendedFrom))}</Tag>}</span>} />
      </dl>
    </section>
  );
}

function Distribution({ s, d, rl, newRating }) {
  const x = d.distribution;
  if (!x) return null;
  const head = (
    <>
      <h2 className="rap-h">{s.secDist}</h2>
      {(x.dept1 || x.unit) && <div className="u-hint">{s.distUnit(x.dept1 || x.unit, Number(x.quotaBase || x.headcount) || 0)}{' · '}{x.source === 'confirm_snapshot' ? s.distSrcSnap : s.distSrcCur}</div>}
    </>
  );
  // 小部门（审查意见：人数少时各档人数可推出个人评级）：服务端给 counts:null，只说明不适用名额
  if (x.small || !x.counts) {
    return <section className="card co-ed-card rap-card">{head}<div className="tset-foot rap-note">{x.small ? s.distSmall(QUOTA_MIN_HC) : s.distNone}</div></section>;
  }
  const counts = x.counts || {};
  const allowed = x.allowed || {};
  const quota = x.quota || {};
  const capped = Array.isArray(x.capped) ? x.capped : QUOTA_CAPPED;
  const tiers = Array.isArray(x.tiers) && x.tiers.length ? x.tiers : tiersOf(allowed, counts);
  const mine = x.appellantBucket || null;
  let after = null;
  if (newRating) {
    after = { ...counts };
    const to = bucketOf(newRating);
    if (mine && to && mine !== to) { after[mine] = Math.max(0, (after[mine] || 0) - 1); after[to] = (after[to] || 0) + 1; }
  }
  const quotaOn = x.quotaApplies !== false;
  const over = (t, n) => quotaOn && capped.includes(t) && allowed[t] !== undefined && allowed[t] !== null && n > Number(allowed[t]);
  const tierLabel = (t) => (t === 'C/D' ? t : rl(t));
  return (
    <section className="card co-ed-card rap-card">
      {head}
      <div className="rap-dist-wrap">
        <table className="rap-dist">
          <thead><tr><th>{s.dTier}</th>{quotaOn && <th>{s.dQuota}</th>}{quotaOn && <th>{s.dAllowed}</th>}<th>{s.dCur}</th><th>{s.dAfter}</th></tr></thead>
          <tbody>
            {tiers.map((t) => {
              const c = counts[t] || 0;
              const a = after ? after[t] || 0 : null;
              return (
                <tr key={t} className={t === mine ? 'rap-dist-mine' : undefined}>
                  <th scope="row">{tierLabel(t)}{t === mine && <span className="u-hint rap-dist-tag">{s.dMine}</span>}</th>
                  {quotaOn && <td className="tnum">{quota[t] !== undefined && quota[t] !== null ? `${quota[t]}%` : '—'}</td>}
                  {quotaOn && <td className="tnum">{capped.includes(t) && allowed[t] !== undefined && allowed[t] !== null ? allowed[t] : '—'}</td>}
                  <td className={'tnum' + (over(t, c) ? ' rap-cell-over' : '')}>{c}</td>
                  <td className={'tnum' + (a !== null && over(t, a) ? ' rap-cell-over' : '')}>{a === null ? '—' : a}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tset-foot rap-note">{quotaOn ? s.distClosed : s.distNoQuota}</div>
    </section>
  );
}

function ConsultForm({ s, d, consultee, setConsultee, question, setQuestion }) {
  const cands = (Array.isArray(d.consultCandidates) ? d.consultCandidates : []).filter((c) => !c.consulted);
  const used = ((d.appeal && d.appeal.consults) || []).length;
  const labelOf = (c) => {
    const ls = Array.isArray(c.labels) ? c.labels : [];
    const parts = [];
    if (c.relation === 'hod') { if (ls.includes('current')) parts.push(s.candHodCur); if (ls.includes('cycle')) parts.push(s.candHodCycle); if (!parts.length) parts.push(s.relHod); }
    else { if (ls.includes('current')) parts.push(s.candMgrCur); if (ls.includes('cycle')) parts.push(s.candMgrCycle); if (!parts.length) parts.push(s.relManager); }
    return `${c.name}${c.position ? ` · ${c.position}` : ''} · ${parts.join(' / ')}`;
  };
  if (used >= CONSULT_MAX) return <p className="u-hint">{s.consultLimit}</p>;
  return (
    <>
      <div className="rap-field">
        <label className="rap-label" htmlFor="rap-consultee">{s.consultWho}</label>
        <Select id="rap-consultee" value={consultee || undefined} style={{ width: '100%' }} onChange={(v) => setConsultee(v || '')}
          optionList={cands.map((c) => ({ value: String(c.id), label: labelOf(c) }))} />
      </div>
      <div className="rap-field">
        <label className="rap-label" htmlFor="rap-question">{s.consultQ}</label>
        <TextArea id="rap-question" rows={3} value={question} maxCount={QUESTION_MAX} maxLength={QUESTION_MAX} onChange={setQuestion} />
      </div>
      <div className="u-hint">{s.consultNote}</div>
    </>
  );
}

function Consults({ s, ap, canConsult, onAsk }) {
  const list = Array.isArray(ap.consults) ? ap.consults : [];
  const room = list.length < CONSULT_MAX;
  return (
    <section className="card co-ed-card rap-card">
      <div className="rap-h-row">
        <h2 className="rap-h">{s.secConsult}</h2>
        {canConsult && (room
          ? <Button size="small" theme="light" type="primary" onClick={onAsk}>{s.consultBtn}</Button>
          : <span className="u-hint">{s.consultLimit}</span>)}
      </div>
      {!list.length ? <div className="u-hint">{s.consultNone}</div> : (
        <ul className="rap-consults">
          {list.map((c) => (
            <li key={c.id}>
              <div className="rap-consult-h">
                <b>{(c.consultee && c.consultee.name) || '—'}</b>
                {c.consultee && c.consultee.position && <span className="u-hint">{c.consultee.position}</span>}
                <Tag size="small" type="light" color={c.relation === 'hod' ? 'violet' : 'blue'}>{c.relation === 'hod' ? s.relHod : s.relManager}</Tag>
              </div>
              <div className="u-hint tnum">{s.askedBy((c.askedBy && c.askedBy.name) || '—', stamp(c.askedAt) || '—')}{c.answeredAt ? ` · ${s.answeredAt(stamp(c.answeredAt))}` : ''}</div>
              {nonEmpty(c.question) && <div className="rap-consult-q"><span className="rap-sub-k">{s.question}</span><div className="rap-pre">{c.question}</div></div>}
              <div className="rap-consult-q"><span className="rap-sub-k">{s.opinion}</span>{nonEmpty(c.opinion) ? <div className="rap-pre">{c.opinion}</div> : <div className="u-hint">{s.awaiting}</div>}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DecisionView({ s, ap, rl }) {
  const adj = ap.status === 'adjusted';
  return (
    <section className="card co-ed-card rap-card rap-decided">
      <h2 className="rap-h">{s.secDecision}</h2>
      <dl className="rap-kv">
        <Kv k={s.outcomeL} v={<StatusTag r={ap} s={s} />} />
        {adj && <Kv k={s.newRatingL} v={<b>{rl(ap.newRating)}</b>} />}
        <Kv k={s.replyL} v={ap.reply || '—'} pre />
        {nonEmpty(ap.internalNote) && <Kv k={adj ? s.reasonL : s.noteL} v={ap.internalNote} pre />}
        <Kv k={s.decidedBy} v={s.decidedOn((ap.decidedBy && ap.decidedBy.name) || '—', stamp(ap.decidedAt) || '—')} />
      </dl>
    </section>
  );
}
