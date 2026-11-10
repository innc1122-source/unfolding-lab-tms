import { useMemo, useState } from 'react';
import {
  Table, Input, Select, Tag, Typography, Empty, Banner,
} from '@douyinfe/semi-ui';
import { IconSearch } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useI18n } from '../../i18n.jsx';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { aiPageVisible } from '../../rbac.js';
import { SettingsWorkspace } from '../../v2.jsx';
import AiGovernance from './AiGovernance.jsx';
import { PAGE_TIERS, DEFAULT_PAGE_LOG } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';

const { Text } = Typography;

/* Counts reach the English strings already grouped ("1,204"), so singular is a
   string test rather than `n === 1`. */
const pl = (n, one, many) => (String(n) === '1' ? one : many);

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    title: '审计日志',
    secLog: '审计日志', secAi: 'AI 治理',
    lead: '记录后台的每一次关键操作，以及登录、登录失败与登出，仅供查阅、不可修改或删除。',
    searchPh: '搜索操作人、对象或详情…',
    actionAll: '全部动作',
    colTime: '时间', colActor: '操作人', colAction: '动作', colObject: '对象', colDetail: '详情',
    system: '系统',
    total: (n) => `共 ${n} 条记录`,
    empty: '没有符合条件的记录',
    diffTitle: '变更详情', fieldChanges: '字段变更',
    field: '字段', dash: '—',
    loadErr: '无法加载审计日志',
    created: '新建', deleted: '删除',
    changedN: (n) => `${n} 项变更`,
    retention: '本日志只追加、不可修改或删除；系统不会自动清理，旧记录一直保留。',
    /* time range — the main way to narrow a log that only ever grows (design
       default: 近 7 天) */
    r7: '近 7 天', r30: '近 30 天', r90: '近 90 天', rAll: '全部时间',
    window: (total, shown) => `共 ${total} 条，当前只载入最近 ${shown} 条。`,
    /* detail-column summary vocabulary */
    smJoin: '、', smYes: '是', smNo: '否', smUpdated: '已更新',
    smPlusN: (n) => `+${n} 项`,
    smRemoved: (name) => `已删除「${name}」`,
    smRenamed: (b, a) => `${b} → ${a}`,
    smOpenScore: (b, a) => `简答题 ${b} → ${a} 分`,
    smWasTotal: (p) => `改分前总分 ${p}%`,
    smFinal: (b, a) => `最终评级 ${b} → ${a}`,
    smRecRating: (b, a) => `档案评级 ${b} → ${a}`,
    smDates: '截止日期已改',
    smQuota: (t, b, a) => `配额 ${t} ${b}%→${a}%`,
    smConvReason: { timeout: '转换超时', error: '转换出错', no_pdf: '没有生成 PDF', changed: '附件已被改动', unavailable: '转换组件不可用' },
    smMediaReason: { unavailable: '未安装转码组件', no_encoder: '缺少编码器', timeout: '转码超时', error: '视频已损坏或格式无法识别', no_mp4: '没有生成可播放的文件', source_missing: '原始视频丢失', too_large: '超过 500 MB', too_long: '超过 4 小时', unsupported_format: '格式不支持', linked_file: '视频未嵌入', disk_full: '磁盘空间不足', storage_limit: '已达存储上限' },
    smMediaLine: (deck, slides, name, reason) => `「${deck}」${slides}「${name}」：${reason}`,
    smMediaSlides: (list) => '第 ' + list.join('、') + ' 页',
    smMediaHidden: '隐藏页',
    smGradeSame: (n) => `${n} 项职级（名称或顺序调整）`,
    smGradeMoved: (b, a) => `职级目录 ${b} → ${a} 项`,
    smPaper: (b, a, add, rm) => `试卷 ${b} → ${a} 题（+${add} / −${rm}）`,
    smPaperOrder: (n) => `试卷 ${n} 题（调整了题序）`,
    smAssignN: (n) => `指派 ${n} 人`,
    smUnassignN: (n) => `取消指派 ${n} 人`,
    smAssignedProg: (n) => `指派 ${n} 门课`,
    smRemovedProg: (n) => `移除 ${n} 门课`,
    smDue: (d) => `截止 ${d}`,
    smWritten: (n) => `归档 ${n} 条绩效记录`,
    smNoRating: (n) => `跳过 ${n} 人（无评级）`,
    smBoxDone: '九宫格已更新',
    smSynced: '已同步职级',
    smNewPeople: (n) => `新增 ${n} 人`,
    smFieldsList: (list) => `修改字段 ${list}`,
    smEmployees: (n) => `${n} 人`,
    smParticipants: (n) => `${n} 人参与`,
    smRows: (n) => `${n} 行`,
    smCreated: (n) => `新增 ${n} 条`,
    smSkipped: (n) => `跳过 ${n} 条`,
    smSkippedPeople: (n) => `跳过 ${n} 人`,
    smSkippedInactive: (n) => `跳过离职 ${n} 人`,
    smSkippedNoLevel: (n) => `跳过无职级 ${n} 人`,
    smVoided: (n) => `作废 ${n} 次考试`,
    smReminded: (n) => `提醒 ${n} 人`,
    smIssued: (n) => `重置 ${n} 人密码`,
    smCount: (n) => `${n} 人`,
    smModules: (n) => `${n} 个模块`,
    smAffected: (n) => `涉及 ${n} 人学习记录`,
    /* —— 访问日志 (auth.*) 词表。动作名在 ACTIONS，这里只翻译 payload 里的
       reason / method / scope 代码，「详情」列才不会出现英文代码。 */
    smAuthMethod: {
      password: '工号密码', lark: 'Lark 登录',
      // 自助重置的 method 码:申请阶段 email,真正重置时 email_token。
      email: '邮件重置链接', email_token: '邮件重置令牌',
    },
    smAuthWhy: {
      bad_password: '密码错误', unknown_id: '工号不存在',
      disabled: '账号已停用', locked: '已锁定，被拒绝',
    },
    smAuthScope: { session: '退出本次会话', all: '退出所有设备' },
    smAuthRevoke: {
      deactivated: '账号被停用', password_reset: '密码被重置',
      bulk_password_reset: '批量重置密码', exited: '离职同步',
    },
    smAuthLockMin: (n) => `还需等待 ${n} 分钟`,
    smResetTtl: (n) => `链接 ${n} 分钟内有效`,
  },
  en: {
    title: 'Audit Log',
    secLog: 'Audit Log', secAi: 'AI Governance',
    lead: 'An append-only record of every key console action plus every sign-in, failed sign-in and sign-out — read-only, never edited or deleted.',
    searchPh: 'Search actor, object or details…',
    actionAll: 'All actions',
    colTime: 'Time', colActor: 'Actor', colAction: 'Action', colObject: 'Object', colDetail: 'Details',
    system: 'System',
    total: (n) => `${n} entries`,
    empty: 'No matching entries',
    diffTitle: 'Change detail', fieldChanges: 'Field changes',
    field: 'Field', dash: '—',
    loadErr: 'Could not load the audit log',
    created: 'Created', deleted: 'Deleted',
    changedN: (n) => `${n} field${n === 1 ? '' : 's'} changed`,
    retention: 'Append-only — never edited or deleted. No automatic cleanup; entries are kept indefinitely.',
    /* time range — the main way to narrow a log that only ever grows (design
       default: last 7 days) */
    r7: 'Last 7 days', r30: 'Last 30 days', r90: 'Last 90 days', rAll: 'All time',
    window: (total, shown) => `${total} entries in total — the ${shown} most recent are loaded.`,
    /* detail-column summary vocabulary */
    smJoin: ', ', smYes: 'yes', smNo: 'no', smUpdated: 'updated',
    smPlusN: (n) => `+${n} more`,
    smRemoved: (name) => `Deleted “${name}”`,
    smRenamed: (b, a) => `${b} → ${a}`,
    smOpenScore: (b, a) => `Short answer ${b} → ${a} pts`,
    smWasTotal: (p) => `total was ${p}%`,
    smFinal: (b, a) => `Final rating ${b} → ${a}`,
    smRecRating: (b, a) => `Rating on file ${b} → ${a}`,
    smDates: 'Dates changed',
    smQuota: (t, b, a) => `Quota ${t} ${b}%→${a}%`,
    smConvReason: { timeout: 'timed out', error: 'conversion error', no_pdf: 'no PDF produced', changed: 'attachment changed meanwhile', unavailable: 'converter unavailable' },
    smMediaReason: { unavailable: 'transcoder not installed', no_encoder: 'encoder missing', timeout: 'timed out', error: 'damaged or unrecognised video', no_mp4: 'no playable file produced', source_missing: 'original video missing', too_large: 'over 500 MB', too_long: 'over 4 hours', unsupported_format: 'unsupported format', linked_file: 'video not embedded', disk_full: 'low disk space', storage_limit: 'storage limit reached' },
    smMediaLine: (deck, slides, name, reason) => `"${deck}" ${slides} "${name}": ${reason}`,
    smMediaSlides: (list) => (list.length > 1 ? 'slides ' : 'slide ') + list.join(', '),
    smMediaHidden: 'hidden slide',
    smGradeSame: (n) => `${n} grade${pl(n, '', 's')} (renamed or reordered)`,
    smGradeMoved: (b, a) => `Grade catalog ${b} → ${a} rows`,
    smPaper: (b, a, add, rm) => `Paper ${b} → ${a} questions (+${add} / −${rm})`,
    smPaperOrder: (n) => `Paper of ${n} questions (order changed)`,
    smAssignN: (n) => `Assigned to ${n} ${pl(n, 'person', 'people')}`,
    smUnassignN: (n) => `Unassigned ${n} ${pl(n, 'person', 'people')}`,
    smAssignedProg: (n) => `${n} program${pl(n, '', 's')} assigned`,
    smRemovedProg: (n) => `${n} program${pl(n, '', 's')} removed`,
    smDue: (d) => `due ${d}`,
    smWritten: (n) => `${n} performance record${pl(n, '', 's')} archived`,
    smNoRating: (n) => `${n} skipped (no rating)`,
    smBoxDone: '9-box refreshed',
    smSynced: 'job level synced',
    smNewPeople: (n) => `${n} ${pl(n, 'person', 'people')} added`,
    smFieldsList: (list) => `fields: ${list}`,
    smEmployees: (n) => `${n} ${pl(n, 'person', 'people')}`,
    smParticipants: (n) => `${n} participant${pl(n, '', 's')}`,
    smRows: (n) => `${n} row${pl(n, '', 's')}`,
    smCreated: (n) => `${n} created`,
    smSkipped: (n) => `${n} skipped`,
    smSkippedPeople: (n) => `${n} ${pl(n, 'person', 'people')} skipped`,
    smSkippedInactive: (n) => `${n} inactive skipped`,
    smSkippedNoLevel: (n) => `${n} without a job level skipped`,
    smVoided: (n) => `${n} attempt${pl(n, '', 's')} voided`,
    smReminded: (n) => `${n} ${pl(n, 'person', 'people')} reminded`,
    smIssued: (n) => `${n} password${pl(n, '', 's')} reset`,
    smCount: (n) => `${n} ${pl(n, 'person', 'people')}`,
    smModules: (n) => `${n} module${pl(n, '', 's')}`,
    smAffected: (n) => `${n} learner${pl(n, '', 's')} affected`,
    /* —— access-log (auth.*) vocabulary. Action names live in ACTIONS; these
       translate the reason / method / scope CODES inside the payload, so the
       Details column never leaks a raw snake_case code to the reader. */
    smAuthMethod: {
      password: 'employee ID + password', lark: 'Lark sign-in',
      // Self-service reset method codes: `email` on the request, `email_token`
      // when the password is actually changed.
      email: 'reset link by email', email_token: 'emailed reset token',
    },
    smAuthWhy: {
      bad_password: 'wrong password', unknown_id: 'no such employee ID',
      disabled: 'account deactivated', locked: 'locked out, refused',
    },
    smAuthScope: { session: 'this session only', all: 'all devices' },
    smAuthRevoke: {
      deactivated: 'account deactivated', password_reset: 'password reset',
      bulk_password_reset: 'bulk password reset', exited: 'exit synced',
    },
    smAuthLockMin: (n) => `${n} minute${pl(n, '', 's')} left`,
    smResetTtl: (n) => `link valid for ${n} minute${pl(n, '', 's')}`,
  },
};

/* ---------------- action-type catalog (Tag color + bilingual label) ----------------
   Keys map to the server's dotted action values (see /api/admin/audit contract). */
const ACTIONS = {
  'program.create': { zh: '创建课程（内部结构）', en: 'Create course (internal structure)', color: 'green' },
  'program.update': { zh: '更新课程（内部结构）', en: 'Update course (internal structure)', color: 'amber' },
  'course.create': { zh: '创建课程', en: 'Create course', color: 'green' },
  'course.update': { zh: '更新课程', en: 'Update course', color: 'amber' },
  'course.self-enroll': { zh: '自主加入课程', en: 'Joined a public course', color: 'grey' },
  'course.self-leave': { zh: '退出自主学习课程', en: 'Left a self-directed course', color: 'grey' },
  'course.public.open': { zh: '设为公开课程', en: 'Course made public', color: 'blue' },
  'course.public.close': { zh: '取消公开课程', en: 'Course no longer public', color: 'amber' },
  'course.delete': { zh: '删除课程', en: 'Delete course', color: 'red' },
  'attachment.convert': { zh: '课件转为在线查看', en: 'Convert attachment for online viewing', color: 'blue' },
  'attachment.convert.fail': { zh: '课件转换失败', en: 'Attachment conversion failed', color: 'red' },
  'attachment.media.extract': { zh: '提取课件内视频', en: 'Extract videos from courseware', color: 'blue' },
  'attachment.media.transcode': { zh: '课件视频转码完成', en: 'Courseware video converted', color: 'blue' },
  'attachment.media.transcode.fail': { zh: '课件视频转码失败', en: 'Courseware video conversion failed', color: 'red' },
  'attachment.media.retry': { zh: '重新转码课件视频', en: 'Retry courseware video conversion', color: 'amber' },
  'exam.create': { zh: '创建考试', en: 'Create exam', color: 'green' },
  'exam.update': { zh: '更新考试', en: 'Update exam', color: 'amber' },
  'question.create': { zh: '创建题目', en: 'Create question', color: 'green' },
  'question.update': { zh: '修改题目', en: 'Update question', color: 'amber' },
  'question.delete': { zh: '删除题目', en: 'Delete question', color: 'red' },
  'employee.create': { zh: '创建员工', en: 'Create employee', color: 'green' },
  'employee.update': { zh: '更新员工', en: 'Update employee', color: 'amber' },
  'employee.reset-password': { zh: '重置密码', en: 'Reset password', color: 'grey' },
  'employee.bulk-import': { zh: '批量导入', en: 'Bulk import', color: 'green' },
  'assignments.update': { zh: '指派项目', en: 'Update assignments', color: 'blue' },
  'assignments.bulk': { zh: '批量指派', en: 'Bulk assign', color: 'blue' },
  'attempt.regrade': { zh: '改分', en: 'Regrade attempt', color: 'amber' },
  'export.completion-csv': { zh: '导出完成情况', en: 'Export completion CSV', color: 'grey' },
  'export.training-people': { zh: '导出培训名单', en: 'Export training list', color: 'grey' },
  'export.attempts-csv': { zh: '导出考试记录', en: 'Export attempts CSV', color: 'grey' },
  'export.hods-csv': { zh: '导出 HoD 名单', en: 'Export HoD list CSV', color: 'grey' },
  /* CX-147：删除课程时一并删除其题库题目 */
  'question.course-deleted': { zh: '随课程删除题目', en: 'Deleted questions with course', color: 'red' },
  /* CX-139：人才记录 CSV 导出 */
  'export.records-csv': { zh: '导出人才记录', en: 'Export talent records CSV', color: 'grey' },
  'talent.record.create': { zh: '添加人才记录', en: 'Create talent record', color: 'green' },
  'talent.record.update': { zh: '更新人才记录', en: 'Update talent record', color: 'amber' },
  'talent.record.rating-amend': { zh: '修改档案绩效评级', en: 'Amended a performance rating on file', color: 'amber' },
  'talent.record.delete': { zh: '删除人才记录', en: 'Delete talent record', color: 'red' },
  'talent.record.bulk-import': { zh: '批量导入记录', en: 'Bulk import records', color: 'green' },
  'talent.config.type': { zh: '记录类型配置', en: 'Record type config', color: 'blue' },
  'talent.config.type-delete': { zh: '删除记录类型', en: 'Delete record type', color: 'red' },
  'talent.config.field': { zh: '字段配置', en: 'Field config', color: 'blue' },
  'talent.config.field-delete': { zh: '删除字段', en: 'Delete field', color: 'red' },
  'talent.portrait': { zh: '生成 AI 人才画像草稿', en: 'Generate AI talent portrait draft', color: 'grey' },
  // AI 治理（NEXT-WORK/specs/03-ai-governance-spec.md 2.3.5）：关键的人工决定与系统事件
  'talent.portrait.confirm': { zh: '确认 AI 人才画像', en: 'Confirm AI talent portrait', color: 'green' },
  'talent.portrait.discard': { zh: '丢弃 AI 人才画像草稿', en: 'Discard AI talent portrait draft', color: 'grey' },
  'talent.portrait.objection': { zh: '记录画像异议', en: 'Record portrait objection', color: 'amber' },
  'talent.portrait.purge': { zh: '删除离职员工画像', en: 'Delete portraits of a departed employee', color: 'red' },
  'talent.tags.strip-emoji': { zh: '清除人才标签中的 emoji', en: 'Remove emoji from talent tags', color: 'grey' },
  // 12.2 受控人才标签（高潜 / 关键人才 / 流失风险）：逐个打标与取消需理由；迁移 87 把存量写法纳入受控标签
  'talent.tag.add': { zh: '打上受控标签', en: 'Add controlled talent tag', color: 'green' },
  'talent.tag.remove': { zh: '取消受控标签', en: 'Remove controlled talent tag', color: 'red' },
  'talent.tags.controlled-map': { zh: '存量标签纳入受控标签', en: 'Map existing tags to controlled talent tags', color: 'grey' },
  'attempt.ai.confirm': { zh: '确认简答题 AI 初评', en: 'Confirm AI pre-score', color: 'green' },
  'attempt.ai.retry': { zh: '重新 AI 初评', en: 'Retry AI pre-score', color: 'blue' },
  'question.ai.adopt': { zh: '采纳 AI 起草的题目', en: 'Adopt AI-drafted question', color: 'blue' },
  'ai.budget.alert': { zh: 'AI 用量预警', en: 'AI usage alert', color: 'amber' },
  'ai.config.change': { zh: 'AI 配置变更', en: 'AI configuration changed', color: 'amber' },
  'ai.datashare.change': { zh: '修改字段发送给 AI 的范围', en: 'Change what a field sends to AI', color: 'amber' },
  'ai.test': { zh: 'AI 连接测试', en: 'AI connection test', color: 'grey' },
  'ai.calls.export': { zh: '导出 AI 调用记录', en: 'Export AI call log', color: 'grey' },
  'module.config.change': { zh: '修改功能模块开关', en: 'Change module switches', color: 'red' },
  'department.create': { zh: '创建部门', en: 'Create department', color: 'green' },
  'department.update': { zh: '更新部门', en: 'Update department', color: 'amber' },
  'department.delete': { zh: '删除部门', en: 'Delete department', color: 'red' },
  'jobgrades.update': { zh: '职级体系配置', en: 'Job grades config', color: 'blue' },
  'review.cycle.create': { zh: '发起评估周期', en: 'Launch review cycle', color: 'green' },
  'review.calibrate': { zh: '校准绩效评级', en: 'Calibrate rating', color: 'amber' },
  // B-P72：服务端写此审计，之前页面没有标签
  'review.nudge': { zh: '提醒提交自评', en: 'Self-review reminder sent', color: 'grey' },
  'review.remind': { zh: '提醒评估待办', en: 'Review reminder sent', color: 'grey' },
  'review.cycle.close': { zh: '关闭评估周期', en: 'Close review cycle', color: 'blue' },
  'review.cycle.due': { zh: '修改评估周期日期与配额', en: 'Change review cycle dates and quota', color: 'amber' },
  'review.cycle.delete': { zh: '删除评估周期', en: 'Delete review cycle', color: 'red' },
  // 绩效 v2 部门校准流程：HoD 调整评级并提交本部门校准，HR 确认或退回
  'review.hod.calibrate': { zh: 'HoD 调整绩效评级', en: 'HoD adjusted a performance rating', color: 'amber' },
  'review.hod.submit': { zh: 'HoD 提交部门绩效校准', en: 'HoD submitted department calibration', color: 'blue' },
  'review.dept.confirm': { zh: 'HR 确认部门绩效校准', en: 'HR confirmed department calibration', color: 'green' },
  'review.dept.return': { zh: 'HR 退回部门绩效校准', en: 'HR returned department calibration', color: 'red' },
  // 第二批 2.1 / 2.2（2026-10-08）：面谈由员工与上级各自登记（可补登记）；上级不在职或已过评级截止日时 HoD 代评（须写理由）
  'review.one-on-one': { zh: '登记 1 对 1 面谈', en: 'Logged a 1-on-1', color: 'grey' },
  'review.hod.proxy': { zh: 'HoD 代评绩效评级', en: 'HoD rated on behalf of the manager', color: 'amber' },
  // 第二批 2.8（2026-10-08）绩效申诉与 HRBP 分工：target 为评估条目 id（解析到申诉人）、周期 id 或部门 id；载荷不含任何正文
  'review.appeal.submit': { zh: '提交绩效申诉', en: 'Submit performance appeal', color: 'blue' },
  'review.appeal.withdraw': { zh: '撤回绩效申诉', en: 'Withdraw performance appeal', color: 'grey' },
  'review.appeal.start': { zh: '开始处理绩效申诉', en: 'Start appeal review', color: 'blue' },
  'review.appeal.category': { zh: '改正申诉原因分类', en: 'Correct appeal reason category', color: 'blue' },
  'review.appeal.reassign': { zh: '转交绩效申诉', en: 'Reassign performance appeal', color: 'amber' },
  'review.appeal.consult': { zh: '征询申诉意见', en: 'Request opinion on appeal', color: 'blue' },
  'review.appeal.opinion': { zh: '提交申诉征询意见', en: 'Submit opinion on appeal', color: 'blue' },
  'review.appeal.maintain': { zh: '申诉结论：维持原评级', en: 'Appeal decided: rating maintained', color: 'green' },
  'review.appeal.adjust': { zh: '申诉结论：调整评级', en: 'Appeal decided: rating adjusted', color: 'amber' },
  'review.appeal.view': { zh: '查看申诉内容', en: 'View appeal content', color: 'grey' },
  'review.cycle.communicate': { zh: '通知员工评估结果', en: 'Communicate review results', color: 'blue' },
  'department.hrbp': { zh: '设置部门 HRBP', en: 'Set department HRBPs', color: 'amber' },
  // 第二批 8.3（2026-10-08）：记录类型「经理可见」开关
  'talent.record-type.mgrvis': { zh: '修改记录类型经理可见', en: 'Change record type visibility to managers', color: 'amber' },
  'secondary.line.add': { zh: '新增虚线汇报或兼任岗位', en: 'Add dotted line or concurrent post', color: 'green' },
  'secondary.line.delete': { zh: '删除虚线汇报或兼任岗位', en: 'Remove dotted line or concurrent post', color: 'red' },
  'secondary.line.bulk': { zh: '批量导入虚线汇报与兼任岗位', en: 'Bulk import dotted lines and concurrent posts', color: 'blue' },
  'brand.update': { zh: '更新品牌设置', en: 'Update brand settings', color: 'amber' },
  'role.create': { zh: '创建角色', en: 'Create role', color: 'green' },
  'role.update': { zh: '更新角色', en: 'Update role', color: 'amber' },
  'role.delete': { zh: '删除角色', en: 'Delete role', color: 'red' },
  'role.assign': { zh: '指派角色', en: 'Assign role', color: 'amber' },
  /* —— 派生身份（经理）。manager.view_profile 是一次**只读**：经理打开了汇报线内
     某个下属（含隔层）的完整档案。高层一天可能翻几百人，所以量大且不改任何数据
     —— 用灰色，与其他“看了/导了”类动作一致。target = 被查看人的工号。 */
  'manager.view_profile': { zh: '经理查看下属档案', en: 'Manager viewed a direct report’s profile', color: 'grey' },
  /* —— 行为实践（culture 模块）。服务端 services.audit 统一加 culture. 前缀（modules/culture/CONTRACT.md 4.3，
     共 19 个动作）；人员级动作的 target 是被操作人的 userId，批量动作 target 是 programId、after 放计数。
     学员本人的作答与提交不写审计；简版 360 度反馈严禁写审计。查看类（view_*、导出）与 manager.view_profile
     同为灰色。 */
  'culture.programs.create': { zh: '行为实践：创建期次', en: 'Behavior Practice: create cohort', color: 'green' },
  'culture.programs.update': { zh: '行为实践：修改期次', en: 'Behavior Practice: update cohort', color: 'amber' },
  'culture.programs.close': { zh: '行为实践：关闭期次', en: 'Behavior Practice: close cohort', color: 'blue' },
  'culture.programs.delete': { zh: '行为实践：删除期次', en: 'Behavior Practice: delete cohort', color: 'red' },
  'culture.participants.import': { zh: '行为实践：导入参与名单', en: 'Behavior Practice: import participants', color: 'green' },
  'culture.participants.add_depts': { zh: '行为实践：按一级部门加入参与名单', en: 'Behavior Practice: add participants by level-1 department', color: 'green' },
  'culture.participants.exclude': { zh: '行为实践：移出参与名单', en: 'Behavior Practice: remove from the participant list', color: 'red' },
  'culture.participants.update': { zh: '行为实践：修改参与者', en: 'Behavior Practice: update participant', color: 'amber' },
  'culture.participants.track_override': { zh: '行为实践：指定轨道', en: 'Behavior Practice: set track', color: 'amber' },
  'culture.cards.review': { zh: '行为实践：审核认可卡', en: 'Behavior Practice: review recognition card', color: 'blue' },
  'culture.tasks.spot_check': { zh: '行为实践：抽查行为实践记录', en: 'Behavior Practice: spot-check practice record', color: 'amber' },
  'culture.jobs.leaderboard': { zh: '行为实践：重算部门排名', en: 'Behavior Practice: recalculate department ranking', color: 'grey' },
  'culture.badges.image': { zh: '行为实践：更换勋章图', en: 'Behavior Practice: change badge image', color: 'amber' },
  // 批次 3 取消请假功能：以下两个标签只用于显示历史审计行
  'culture.leaves.mark': { zh: '行为实践：标记请假', en: 'Behavior Practice: mark leave', color: 'amber' },
  'culture.leaves.clear': { zh: '行为实践：取消请假', en: 'Behavior Practice: clear leave', color: 'amber' },
  'culture.meetings.submit': { zh: '行为实践：登记例会', en: 'Behavior Practice: log meeting', color: 'green' },
  'culture.meetings.check': { zh: '行为实践：核对例会承诺', en: 'Behavior Practice: check meeting commitments', color: 'blue' },
  'culture.hosts.set': { zh: '行为实践：设置团队主持人', en: 'Behavior Practice: set team hosts', color: 'amber' },
  'culture.hosts.apply_suggestions': { zh: '行为实践：采用预选团队主持人', en: 'Behavior Practice: apply suggested team hosts', color: 'amber' },
  'culture.meetings.legacy_host_fix': { zh: '行为实践：更正旧例会主持人', en: 'Behavior Practice: correct legacy meeting hosts', color: 'grey' },
  'culture.export.create': { zh: '行为实践：发起导出', en: 'Behavior Practice: start export', color: 'grey' },
  'culture.export.download': { zh: '行为实践：下载导出文件', en: 'Behavior Practice: download export', color: 'grey' },
  'culture.people.view_summary': { zh: '行为实践：查看档案汇总', en: 'Behavior Practice: view profile summary', color: 'grey' },
  // 培训：培养项目与选修课程申请、签到、考试、提醒（B-AC71，术语按 IA 2.3）
  'tproject.create': { zh: '创建发展项目', en: 'Create development program', color: 'green' },
  'tproject.update': { zh: '更新发展项目', en: 'Update development program', color: 'amber' },
  'tproject.delete': { zh: '删除发展项目', en: 'Delete development program', color: 'red' },
  'tproject.apply': { zh: '申请参加发展项目', en: 'Apply to a development program', color: 'blue' },
  'tproject.members.add': { zh: '添加期次成员', en: 'Add cohort members', color: 'green' },
  'tproject.members.move': { zh: '调整期次成员', en: 'Move cohort members', color: 'amber' },
  'tproject.members.withdraw': { zh: '办理退训', en: 'Withdraw from program', color: 'red' },
  'tproject.checkin.mark': { zh: '标记签到', en: 'Mark check-in', color: 'blue' },
  'tproject.checkin.unmark': { zh: '取消补签/请假', en: 'Undo check-in mark', color: 'amber' },
  'tproject.activity.mark': { zh: '登记线上活动完成', en: 'Record online activity completion', color: 'blue' },
  'tproject.activity.unmark': { zh: '撤销线上活动完成登记', en: 'Undo online activity completion', color: 'amber' },
  'tproject.nomination.approve': { zh: '通过发展项目申请', en: 'Approve development program application', color: 'green' },
  'tproject.nomination.reject': { zh: '驳回发展项目申请', en: 'Reject development program application', color: 'red' },
  'enroll.request': { zh: '申请选修课程', en: 'Apply for an elective course', color: 'blue' },
  'enroll.approve': { zh: '通过课程申请', en: 'Approve course application', color: 'green' },
  'enroll.reject': { zh: '驳回课程申请', en: 'Reject course application', color: 'red' },
  'course.checkin': { zh: '线下课程签到', en: 'In-person course check-in', color: 'blue' },
  // 组织绩效（2026-10-10）
  'orgperf.round.create': { zh: '新建部门互评', en: 'Create department peer review', color: 'green' },
  'orgperf.round.update': { zh: '修改部门互评', en: 'Edit department peer review', color: 'amber' },
  'orgperf.round.delete': { zh: '删除部门互评草稿', en: 'Delete department peer review draft', color: 'red' },
  'orgperf.round.open': { zh: '开放部门互评', en: 'Open department peer review', color: 'green' },
  'orgperf.round.close': { zh: '结束部门互评', en: 'Close department peer review', color: 'grey' },
  'orgperf.round.publish': { zh: '发布部门互评结果', en: 'Publish department peer review results', color: 'blue' },
  'orgperf.round.remind': { zh: '提醒部门互评', en: 'Remind department peer review', color: 'blue' },
  'orgperf.round.return': { zh: '退回部门互评', en: 'Return department peer review', color: 'amber' },
  'orgperf.round.export': { zh: '导出部门互评', en: 'Export department peer review', color: 'grey' },
  'orgperf.submit': { zh: '提交部门互评', en: 'Submit department peer review', color: 'blue' },
  'orgperf.results.import': { zh: '导入组织绩效结果', en: 'Import organisational performance results', color: 'amber' },
  // CX-032（2026-10-09）课程包导出
  'course.export': { zh: '导出课程包', en: 'Export course package', color: 'grey' },
  'course.checkin.mark': { zh: '登记出勤', en: 'Record attendance', color: 'blue' },
  'trainer.checkin.mark': { zh: '登记出勤', en: 'Record attendance', color: 'blue' },
  'trainer.activity.mark': { zh: '讲师登记线上活动完成', en: 'Trainer recorded online activity completion', color: 'blue' },
  'training.remind-overdue': { zh: '提醒逾期人员', en: 'Remind overdue learners', color: 'grey' },
  'training.remind-due-soon': { zh: '提醒即将到期人员', en: 'Remind people with training due soon', color: 'grey' },
  'exam.reset-attempts': { zh: '重置考试次数', en: 'Reset attempts', color: 'amber' },
  'exam.auto-retrain': { zh: '自动重新指派课程', en: 'Reassign course automatically', color: 'amber' },
  'question.bulk-import': { zh: '批量导入题目', en: 'Bulk import questions', color: 'green' },
  'attempt.appeal': { zh: '提交申诉', en: 'Submit appeal', color: 'blue' },
  'attempt.appeal.resolve': { zh: '处理申诉', en: 'Resolve appeal', color: 'amber' },
  // 人员、人才与组织
  'succession.add': { zh: '添加继任安排', en: 'Add succession plan', color: 'green' },
  'succession.update': { zh: '更新继任安排', en: 'Update succession plan', color: 'amber' },
  'succession.remove': { zh: '移除继任安排', en: 'Remove succession plan', color: 'red' },
  'succession.bulk-add': { zh: '批量加入继任名单', en: 'Bulk add to succession plan', color: 'green' },
  'succession.import': { zh: '批量导入继任计划', en: 'Import succession plans', color: 'green' },
  // 12.2 关键岗位清单（继任覆盖率的分母）
  'keyposition.create': { zh: '新增关键岗位', en: 'Add key position', color: 'green' },
  'keyposition.update': { zh: '更新关键岗位', en: 'Update key position', color: 'amber' },
  'keyposition.delete': { zh: '删除关键岗位', en: 'Delete key position', color: 'red' },
  'keyposition.import': { zh: '批量导入关键岗位', en: 'Import key positions', color: 'green' },
  'promotion.config': { zh: '修改晋升评审候选条件', en: 'Change promotion panel candidate criteria', color: 'amber' },
  'talent.filter.create': { zh: '新建人才筛选', en: 'Create talent filter', color: 'green' },
  'talent.filter.update': { zh: '修改人才筛选', en: 'Update talent filter', color: 'amber' },
  'talent.filter.delete': { zh: '删除人才筛选', en: 'Delete talent filter', color: 'red' },
  'talent.filter.members': { zh: '调整晋升评审候选名单', en: 'Change promotion panel candidate list', color: 'amber' },
  'export.talent-filter': { zh: '导出人才筛选结果', en: 'Export talent filter results', color: 'blue' },
  'employee.bulk-update': { zh: '批量修改员工', en: 'Bulk update employees', color: 'amber' },
  'employee.bulk-reset-password': { zh: '批量重置密码', en: 'Bulk reset passwords', color: 'red' },
  'department.rename': { zh: '部门改名', en: 'Rename department', color: 'amber' },
  'culture.people.view_tasks': { zh: '行为实践：查看行为实践记录', en: 'Behavior Practice: view practice records', color: 'grey' },
  /* —— 访问日志 / access log. These are the highest-volume rows in the table
     (every employee signs in), so a successful login/logout is deliberately
     quiet: only a FAILED sign-in gets the red rail, because a run of those is
     the one thing on this page that wants to be seen from across the room. */
  'auth.login': { zh: '登录', en: 'Sign in', color: 'blue' },
  'auth.login_failed': { zh: '登录失败', en: 'Sign-in failed', color: 'red' },
  'auth.logout': { zh: '登出', en: 'Sign out', color: 'grey' },
  'auth.sessions_revoked': { zh: '会话被终止', en: 'Sessions revoked', color: 'amber' },
  /* 自助找回密码(邮件令牌)。「申请」只是要了一封邮件,还没改任何东西 —— 蓝色;
     「已重置」真的换了密码并踢掉了全部会话 —— 和其他改密动作一样用琥珀色。
     两条记录里都没有令牌,服务端刻意不写。 */
  'auth.password_reset_requested': { zh: '申请重置密码', en: 'Password reset requested', color: 'blue' },
  'auth.password_reset': { zh: '自助重置密码', en: 'Password reset (self-service)', color: 'amber' },
  /* Lark SSO already wrote these two before the access log existed; unlabeled
     they showed the raw dotted key in both languages. */
  'auth.lark.jit': { zh: 'Lark 首次登录开通账号', en: 'Lark auto-provisioned account', color: 'green' },
  'auth.lark.link': { zh: '绑定 Lark 账号', en: 'Linked Lark identity', color: 'blue' },
};

/* ---------------- payload vocabulary ----------------
   Same bilingual-in-one-place shape as ACTIONS above, so a summary can never
   come out half-translated. Keys are the field names the write sites store in
   their before/after payloads. */
const FIELDS = {
  dueAt: { zh: '截止日期', en: 'Due date' },
  title: { zh: '名称', en: 'Title' },
  name: { zh: '名称', en: 'Name' },
  label: { zh: '名称', en: 'Label' },
  status: { zh: '状态', en: 'Status' },
  active: { zh: '启用', en: 'Active' },
  department: { zh: '部门', en: 'Department' },
  position: { zh: '职位', en: 'Position' },
  jobLevel: { zh: '职级', en: 'Job level' },
  hireDate: { zh: '入职日期', en: 'Hire date' },
  empStatus: { zh: '在职状态', en: 'Employment status' },
  role: { zh: '角色', en: 'Role' },
  email: { zh: '邮箱', en: 'Email' },
  parentId: { zh: '上级部门', en: 'Parent department' },
  /* department.update records the head both ways (name first, so the one-line
     summary reads a person; the id tells two people of the same name apart).
     A level-1 department's head is its HoD — who may read Friday stories. */
  ownerName: { zh: '负责人', en: 'Head' },
  ownerId: { zh: '负责人 ID', en: 'Head ID' },
  /* CX-206：删除课程时随之删除 / 保留的题数（question.course-deleted） */
  questionsDeleted: { zh: '删除题数', en: 'Questions deleted' },
  /* CX-213：课程的创建 / 删除载荷（中文名、模块数，删除前的引用情况 usage 逐项展开） */
  title_zh: { zh: '名称（中文）', en: 'Name (Chinese)' },
  modules: { zh: '模块数', en: 'Modules' },
  'usage.projects': { zh: '关联的发展项目', en: 'Linked development programs' },
  'usage.exams': { zh: '关联的考试', en: 'Linked exams' },
  'usage.learnersWithProgress': { zh: '有学习进度的学员', en: 'Learners with progress' },
  'usage.attempts': { zh: '考试答卷数', en: 'Exam attempts' },
  'usage.assigned': { zh: '已指派人数', en: 'Assigned learners' },
  'usage.blocking': { zh: '仍被占用', en: 'Still in use' },
  questionsKept: { zh: '保留题数', en: 'Questions kept' },
  defaultDueDays: { zh: '默认期限（天）', en: 'Default due (days)' },
  passingScore: { zh: '及格分', en: 'Passing score' },
  mcqCount: { zh: '客观题数量', en: 'Objective questions' },
  timeLimitMinutes: { zh: '限时（分钟）', en: 'Time limit (min)' },
  maxAttempts: { zh: '最多考试次数', en: 'Max attempts' },
  shuffleOptions: { zh: '选项每次随机', en: 'Shuffle options' },
  partialCredit: { zh: '按答对比例给分', en: 'Proportional credit' },
  caseCount: { zh: '情境案例组数', en: 'Scenario cases' },
  /* F58：考试设置「考前须知（选填）」，exam.update 载荷里中英文各一个键 */
  preNotice: { zh: '考前须知（英文）', en: 'Pre-exam notice (EN)' },
  preNotice_zh: { zh: '考前须知（中文）', en: 'Pre-exam notice (ZH)' },
  questionIds: { zh: '试卷题目', en: 'Paper questions' },
  courseIds: { zh: '关联课程', en: 'Linked courses' },
  finalRating: { zh: '最终评级', en: 'Final rating' },
  readiness: { zh: '就绪度', en: 'Readiness' },
  rating: { zh: '评级', en: 'Rating' },
  date: { zh: '日期', en: 'Date' },
  type: { zh: '类型', en: 'Type' },
  detail: { zh: '内容', en: 'Content' },
  input: { zh: '输入类型', en: 'Input' },
  options: { zh: '选项', en: 'Options' },
  required: { zh: '必填', en: 'Required' },
  showInTimeline: { zh: '时间线', en: 'On timeline' },
  filterable: { zh: '可筛选', en: 'Filterable' },
  employeeVisible: { zh: '员工可见', en: 'Employee-visible' },
  managerVisible: { zh: '经理可见', en: 'Visible to managers' },
  sort: { zh: '排序', en: 'Order' },
  icon: { zh: '图标', en: 'Icon' },
  color: { zh: '颜色', en: 'Color' },
  score: { zh: '得分', en: 'Score' },
  percent: { zh: '总分', en: 'Total' },
  note: { zh: '备注', en: 'Note' },
  synced: { zh: '同步职级', en: 'Job level synced' },
  /* 评估按阶段批量提醒（review.remind，2026-10-07）与一键提醒逾期（training.remind-overdue）的载荷 */
  stage: { zh: '提醒步骤', en: 'Step' },
  items: { zh: '涉及条目', en: 'Items' },
  filtered: { zh: '按看板筛选', en: 'Dashboard filter applied' },
  /* —— brand.update payload keys (品牌设置). Text fields come as X / X_zh
     pairs, so both spellings need a label or half the diff shows bare keys. */
  name_zh: { zh: '品牌名（中文）', en: 'Brand name (zh)' },
  tagline: { zh: '标语', en: 'Tagline' },
  tagline_zh: { zh: '标语（中文）', en: 'Tagline (zh)' },
  heroLine: { zh: '副标题', en: 'Hero line' },
  heroLine_zh: { zh: '副标题（中文）', en: 'Hero line (zh)' },
  welcome: { zh: '登录框标题', en: 'Sign-in title' },
  welcome_zh: { zh: '登录框标题（中文）', en: 'Sign-in title (zh)' },
  subtitle: { zh: '登录框副题', en: 'Sign-in subtitle' },
  subtitle_zh: { zh: '登录框副题（中文）', en: 'Sign-in subtitle (zh)' },
  footer: { zh: '页脚', en: 'Footer' },
  footer_zh: { zh: '页脚（中文）', en: 'Footer (zh)' },
  pillA: { zh: '登录页胶囊一', en: 'Login pill A' },
  pillA_zh: { zh: '登录页胶囊一（中文）', en: 'Login pill A (zh)' },
  pillB: { zh: '登录页胶囊二', en: 'Login pill B' },
  pillB_zh: { zh: '登录页胶囊二（中文）', en: 'Login pill B (zh)' },
  brandSub: { zh: 'Logo 旁小字', en: 'Logo sub-label' },
  brandSub_zh: { zh: 'Logo 旁小字（中文）', en: 'Logo sub-label (zh)' },
  console: { zh: '后台名', en: 'Console name' },
  console_zh: { zh: '后台名（中文）', en: 'Console name (zh)' },
  logo: { zh: 'Logo', en: 'Logo' },
  logoLight: { zh: 'Logo（浅底）', en: 'Logo (light)' },
  favicon: { zh: '页签图标', en: 'Favicon' },
  colors: { zh: '配色表', en: 'Colors' },
  /* 第二批 2.8 绩效申诉、HRBP 分工、通知结果的载荷键 */
  appealId: { zh: '申诉编号', en: 'Appeal ID' },
  outcome: { zh: '结论', en: 'Outcome' },
  hrbpIds: { zh: 'HRBP', en: 'HRBPs' },
  hrbpNames: { zh: 'HRBP', en: 'HRBPs' },
  consulteeId: { zh: '征询对象', en: 'Consultee' },
  consulteeName: { zh: '征询对象', en: 'Consultee' },
  relation: { zh: '关系', en: 'Relation' },
  handlerId: { zh: '处理人', en: 'Handler' },
  handlerName: { zh: '处理人', en: 'Handler' },
  via: { zh: '来源', en: 'Source' },
  attachments: { zh: '附件数', en: 'Attachments' },
  attachmentIds: { zh: '附件', en: 'Attachment IDs' },
  reasonLength: { zh: '说明字数', en: 'Explanation length' },
  notified: { zh: '通知人数', en: 'Notified' },
  deadline: { zh: '截止日', en: 'Deadline' },
  route: { zh: '路由', en: 'Route' },
  consultId: { zh: '征询编号', en: 'Consultation ID' },
  afterAppeal: { zh: '申诉结论后修改', en: 'Changed after appeal decision' },
};

/* Payload keys that are plain counts. Driving them from a table is what lets
   one summarizer speak for every import / export / bulk action, instead of a
   branch per endpoint. Value = the T key that phrases the count. */
const COUNT_KEYS = [
  ['employees', 'smEmployees'], ['participants', 'smParticipants'],
  ['written', 'smWritten'], ['rows', 'smRows'],
  ['created', 'smCreated'], ['skipped', 'smSkipped'],
  ['skippedInactive', 'smSkippedInactive'], ['skippedNoLevel', 'smSkippedNoLevel'],
  ['voided', 'smVoided'], ['reminded', 'smReminded'], ['issued', 'smIssued'],
  ['count', 'smCount'], ['modules', 'smModules'], ['assigned', 'smAssignedProg'],
];
/* SQLite hands these back as 0/1, so they need saying as yes/no rather than as
   numbers ("启用 1 → 0" is a riddle). */
const BOOLISH = new Set(['active', 'required', 'showInTimeline', 'filterable', 'employeeVisible', 'managerVisible', 'synced', 'builtin']);
/* Counts whose zero is noise, not news ("跳过 0 条" tells nobody anything). */
const HIDE_ZERO = new Set(['skipped', 'skippedInactive', 'skippedNoLevel', 'employees']);

/* ---------------- helpers ---------------- */
const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const nf = (n) => Number(n).toLocaleString('en-US'); // 4469 → "4,469"
// Audit payloads store due/record dates as YYYY-MM-DD; the summary only needs MM-DD.
const mmdd = (d) => (/^\d{4}-\d{2}-\d{2}/.test(String(d)) ? String(d).slice(5, 10) : String(d || ''));
const clip = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));

// Format a stored value (any JSON) into a display string.
function fmtVal(v, lang) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // CX-213 / CX-220：数组按名称列出（对象按界面语言取名：中文先 title_zh，英文先 title），不露原始 JSON；空数组按空值显示
  const nm = (x) => (lang === 'en' ? x.title || x.title_zh : x.title_zh || x.title) || x.name || x.id || '';
  if (Array.isArray(v)) return v.map((x) => (x != null && typeof x === 'object' ? nm(x) : String(x))).filter(Boolean).join(lang === 'en' ? ', ' : '、');
  try { return JSON.stringify(v); } catch { return String(v); }
}
// CX-213：载荷里的嵌套对象（如 usage）展开一层，键名为「父.子」，字段名在 FIELDS 里按这个键查
const FLATTEN = new Set(['usage']);   // 只展开字段名都已收进 FIELDS 的嵌套对象
const flatOne = (o) => {
  if (!isObj(o)) return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v) && FLATTEN.has(k)) for (const [k2, v2] of Object.entries(v)) out[k + '.' + k2] = v2;
    else out[k] = v;
  }
  return out;
};

// Build before/after change rows from the entry's before/after payloads.
function buildChange(before0, after0) {
  const before = flatOne(before0), after = flatOne(after0);
  if (isObj(before) && isObj(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    const rows = [];
    const patchLike = Object.keys(after).length > 0;
    for (const k of keys) {
      // CX-011（2026-10-09 验收）：after 是增量载荷（如 exam.update 只带改过的字段）时，before 独有的键（id、programId…）不是「→ —」的变更
      if (patchLike && !(k in after)) continue;
      const b = fmtVal(before[k]);
      const a = fmtVal(after[k]);
      if (b !== a) rows.push({ field: k, before: before[k], after: after[k] });
    }
    return rows;
  }
  // CX-208：只有一侧是对象（新建、删除、随课程删除题目等）时按字段逐项列出，字段名走 FIELDS 词典，不再整段显示原始 JSON
  if (before == null && isObj(after)) return Object.keys(after).map((k) => ({ field: k, before: null, after: after[k] }));
  if (after == null && isObj(before)) return Object.keys(before).map((k) => ({ field: k, before: before[k], after: null }));
  if (before != null || after != null) {
    return [{ field: '', before, after }];
  }
  return [];
}

// Split a stored timestamp into a date + time pair for the two-line cell.
function fmtTime(ts) {
  if (!ts) return { d: '', t: '' };
  const dt = new Date(ts);
  if (!Number.isNaN(dt.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return {
      d: `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`,
      t: `${p(dt.getHours())}:${p(dt.getMinutes())}`,
    };
  }
  const [d, t] = String(ts).split(/[ T]/);
  return { d: d || String(ts), t: (t || '').slice(0, 5) };
}

// An UPDATE's summary is the move itself: "及格线 70 → 80". Two fields is what
// fits on one line; the rest stay one click away in the expanded diff.
function diffSummary(change, s, lang) {
  if (!change.length) return '';
  const label = (k) => (FIELDS[k] ? FIELDS[k][lang] : k || s.field);
  const val = (v, k) => {
    if (typeof v === 'boolean' || (BOOLISH.has(k) && (v === 0 || v === 1))) return v ? s.smYes : s.smNo;
    const t = fmtVal(v);
    return t === '' ? s.dash : clip(t, 18);
  };
  const flat = (v) => v == null || typeof v !== 'object';
  const out = change.slice(0, 2).map((c) => (flat(c.before) && flat(c.after)
    // A nested object/array reads as JSON noise here, so it is only named.
    ? `${label(c.field)} ${val(c.before, c.field)} → ${val(c.after, c.field)}`
    : `${label(c.field)} ${s.smUpdated}`));
  if (change.length > 2) out.push(s.smPlusN(change.length - 2));
  return out.join(' · ');
}

/* The 详情 column has to be scannable — one line saying what actually happened,
   so HR reads the log instead of expanding every row. Every figure below comes
   out of the entry's own before/after payload. Where a write site never stored a
   figure (the recomputed exam total, the name of a new job grade), the summary
   says what it does know rather than inventing the rest. */
function summarize(r, s, lang) {
  const a = isObj(r.after) ? r.after : {};
  const b = isObj(r.before) ? r.before : {};
  const act = r.action || '';
  const out = [];

  // --- actions whose meaning is a specific move, not a generic field diff ---
  if (act === 'attempt.regrade') {
    if (b.score != null || a.score != null) out.push(s.smOpenScore(nf(b.score || 0), nf(a.score || 0)));
    // Only the pre-regrade percent is logged — the new total is recomputed after
    // this entry is written, so it is stated as "before", never guessed.
    if (b.percent != null) out.push(s.smWasTotal(nf(b.percent)));
    if (a.note) out.push(clip(a.note, 24));
    return out.join(' · ');
  }
  if (act === 'review.calibrate') {
    out.push(s.smFinal(fmtVal(b.finalRating) || s.dash, fmtVal(a.finalRating) || s.dash));
    // P0 1.1：v2 无 HoD 的组由 HR 校准时带理由
    if (a.reason) out.push(clip(a.reason, 24));
    return out.join(' · ');
  }
  // 第二批 2.6：周期关闭后修改档案里的绩效评级（理由必填，只在后台审计里可见）
  if (act === 'talent.record.rating-amend') {
    out.push(s.smRecRating(fmtVal(b.rating) || s.dash, fmtVal(a.rating) || s.dash));
    if (a.employeeId) out.push(a.employeeId);
    if (a.reason) out.push(clip(a.reason, 24));
    return out.join(' · ');
  }
  // 第二批 2.8：申诉结论、部门 HRBP、通知结果（载荷不含正文）
  if (act === 'review.appeal.adjust') {
    out.push(`${fmtVal(b.rating) || s.dash} → ${fmtVal(a.rating) || s.dash}`);
    if (a.employeeId) out.push(a.employeeId);
    return out.join(' · ');
  }
  if (act === 'review.appeal.maintain') {
    out.push(fmtVal(a.rating) || s.dash);
    if (a.employeeId) out.push(a.employeeId);
    return out.join(' · ');
  }
  if (act === 'department.hrbp') {
    const sep = lang === 'zh' ? '、' : ', ';
    const names = (x) => (Array.isArray(x.hrbpNames) && x.hrbpNames.length ? clip(x.hrbpNames.join(sep), 30) : s.dash);
    return `${names(b)} → ${names(a)}`;
  }
  if (act === 'review.cycle.communicate') {
    if (a.notified != null) out.push(nf(a.notified));
    if (a.deadline) out.push(String(a.deadline));
    return out.join(' · ');
  }
  if (act === 'review.cycle.due') {
    // P0：before / after 都是 { dueAt, dueRateAt, dueCalibAt, quota }；旧记录只有 dueAt
    if (['dueAt', 'dueRateAt', 'dueCalibAt'].some((k) => (k in a || k in b) && (b[k] || null) !== (a[k] || null))) out.push(s.smDates);
    const bq = isObj(b.quota) ? b.quota : {};
    const aq = isObj(a.quota) ? a.quota : {};
    for (const t of Object.keys({ ...bq, ...aq })) if (bq[t] !== aq[t]) out.push(s.smQuota(t, bq[t] == null ? s.dash : nf(bq[t]), aq[t] == null ? s.dash : nf(aq[t])));
    return out.join(' · ');
  }
  if (act === 'attachment.convert') {
    return `${clip(a.originalName || r.target || '', 30)} → PDF`;
  }
  if (act === 'attachment.convert.fail') {
    if (a.originalName) out.push(clip(a.originalName, 30));
    if (a.reason) out.push(s.smConvReason[a.reason] || clip(a.reason, 18));
    return out.join(' · ');
  }
  if (act === 'attachment.media.transcode.fail') {
    // 第三批 5.7：「{课件}」第 {页} 页「{视频}」：{原因}（页码用 PowerPoint 里的幻灯片编号）
    const sl = Array.isArray(a.slides) ? a.slides : [];
    const nums = sl.map((x) => x && x.slideNo).filter((n) => Number.isFinite(n));
    const slides = sl.length && !sl.some((x) => x && x.pageNo != null) ? s.smMediaHidden : s.smMediaSlides(nums.length ? nums : ['?']);
    return s.smMediaLine(clip(a.deck || '', 30), slides, clip(a.name || '', 30), s.smMediaReason[a.reason] || clip(a.reason || '', 18));
  }
  if (act === 'review.cycle.close') {
    out.push(s.smWritten(nf(a.written || 0)));
    if (a.skipped) out.push(s.smNoRating(nf(a.skipped)));
    // The 9-box reads those performance records, so writing any refreshes it.
    if (a.written) out.push(s.smBoxDone);
    return out.join(' · ');
  }
  if (act === 'jobgrades.update') {
    return b.count === a.count
      ? s.smGradeSame(nf(a.count || 0))
      : s.smGradeMoved(nf(b.count || 0), nf(a.count || 0));
  }
  if (act === 'assignments.bulk') {
    out.push((a.action === 'unassign' ? s.smUnassignN : s.smAssignN)(nf(a.employees || 0)));
    if (a.dueAt) out.push(s.smDue(mmdd(a.dueAt)));
    if (a.skippedInactive) out.push(s.smSkippedInactive(nf(a.skippedInactive)));
    return out.join(' · ');
  }
  if (act === 'assignments.update') {
    const items = Array.isArray(a.items) ? a.items : [];
    const on = items.filter((x) => x && x.assigned).length;
    if (on) out.push(s.smAssignedProg(nf(on)));
    if (items.length - on) out.push(s.smRemovedProg(nf(items.length - on)));
    const withDue = items.find((x) => x && x.assigned && x.dueAt);
    if (withDue) out.push(s.smDue(mmdd(withDue.dueAt)));
    return out.join(' · ');
  }
  if (act === 'department.rename') {
    out.push(s.smRenamed(fmtVal(b.name) || s.dash, fmtVal(a.name) || s.dash));
    if (a.employees) out.push(s.smEmployees(nf(a.employees)));
    return out.join(' · ');
  }
  if (act === 'employee.bulk-import') {
    out.push(s.smNewPeople(nf(a.created || 0)));
    if (a.skipped) out.push(s.smSkippedPeople(nf(a.skipped)));
    return out.join(' · ');
  }
  if (act === 'employee.bulk-update') {
    out.push(s.smCount(nf(a.count || 0)));
    if (Array.isArray(a.fields) && a.fields.length) {
      out.push(s.smFieldsList(a.fields.map((k) => (FIELDS[k] ? FIELDS[k][lang] : k)).join(s.smJoin)));
    }
    return out.join(' · ');
  }
  // 第四批 6.2：组卷改了题目清单时，详情写成「试卷 18 → 20 题（+3 / −1）」，不列整串题目 id
  if (act === 'exam.update' && Array.isArray(b.questionIds) && Array.isArray(a.questionIds)) {
    const bs = new Set(b.questionIds), as = new Set(a.questionIds);
    const add = a.questionIds.filter((x) => !bs.has(x)).length, rm = b.questionIds.filter((x) => !as.has(x)).length;
    const changed = add || rm || b.questionIds.join('|') !== a.questionIds.join('|');
    if (changed) {
      out.push(add || rm ? s.smPaper(nf(b.questionIds.length), nf(a.questionIds.length), nf(add), nf(rm)) : s.smPaperOrder(nf(a.questionIds.length)));
      const rest = diffSummary((r.change || []).filter((c) => c.field !== 'questionIds'), s, lang);
      if (rest) out.push(rest);
      return out.join(' · ');
    }
  }
  if (act === 'course.delete') {
    // Deleting a course logs the course in `before` and its usage in `after`,
    // so the generic field diff would read as "everything → nothing".
    // CX-220：中文界面优先用审计里记下的中文名
    if (b.title || b.title_zh) out.push(s.smRemoved(clip((lang === 'zh' ? b.title_zh || b.title : b.title || b.title_zh), 26)));
    if (b.modules != null) out.push(s.smModules(nf(b.modules)));
    const hit = isObj(a.usage) ? Number(a.usage.learnersWithProgress) : 0;
    if (hit) out.push(s.smAffected(nf(hit)));
    return out.join(' · ');
  }

  /* --- access log. The generic one-sided path would print the payload's codes
     ("reason bad_password"), so these four read their own vocabulary. An
     unrecognised code still prints rather than vanishing — a row that says
     nothing is worse than a row that says something untranslated. */
  if (act === 'auth.login' || act === 'auth.login_failed') {
    if (act === 'auth.login_failed') out.push(s.smAuthWhy[a.reason] || fmtVal(a.reason));
    if (a.method) out.push(s.smAuthMethod[a.method] || fmtVal(a.method));
    if (a.minutes != null) out.push(s.smAuthLockMin(nf(a.minutes)));
    return out.filter(Boolean).join(' · ');
  }
  if (act === 'auth.logout') {
    return s.smAuthScope[a.scope] || s.smAuthScope.session;
  }
  if (act === 'auth.sessions_revoked') {
    out.push(s.smAuthRevoke[a.reason] || fmtVal(a.reason));
    if (a.count != null) out.push(s.smCount(nf(a.count)));
    return out.filter(Boolean).join(' · ');
  }
  /* 自助重置密码。after 只有 method 与 ttlMinutes,两个键都不在 FIELDS 表里,走
     通用支路会退化成「1 项变更」,所以这里自带词表。令牌从不落审计,没什么可打印。 */
  if (act === 'auth.password_reset_requested' || act === 'auth.password_reset') {
    if (a.method) out.push(s.smAuthMethod[a.method] || fmtVal(a.method));
    if (a.ttlMinutes != null) out.push(s.smResetTtl(nf(a.ttlMinutes)));
    return out.filter(Boolean).join(' · ');
  }

  // --- two-sided payload: the changed fields ARE the summary ---
  if (isObj(r.before) && isObj(r.after)) {
    const d = diffSummary(r.change, s, lang);
    if (d) return d;
  }

  // --- one-sided payloads (create / delete / import / export): the object's own
  //     name plus whatever it counted ---
  const del = !Object.keys(a).length && Object.keys(b).length > 0;
  const src = del ? b : a;
  const name = fmtVal(src.title || src.name || src.label || '');
  // Skip a name the 对象 column already shows — no row should say it twice.
  // Test BOTH server labels, not the displayed one: the payload's title is in
  // whatever language it was stored in, so on the Chinese screen the English
  // "Safety Basics" would sail past a comparison with 「安全基础」 and the row
  // would print the same object twice, once per language.
  if (name && name !== r.target && !(r.targetNames || []).includes(name)) {
    out.push(del ? s.smRemoved(clip(name, 26)) : clip(name, 26));
  }
  if (typeof src.program === 'string' && src.program) out.push(clip(src.program, 26));
  for (const [k, key] of COUNT_KEYS) {
    const v = Number(src[k]);
    if (src[k] == null || !Number.isFinite(v)) continue;
    if (!v && HIDE_ZERO.has(k)) continue;
    out.push(s[key](nf(v)));
  }
  if (src.synced) out.push(s.smSynced);
  if (src.dueAt) out.push(s.smDue(mmdd(src.dueAt)));
  // Last resort for one-sided ADDs: name the readable scalars the payload does
  // carry, so a row with real content never degrades to "1 项变更". Internal ids
  // are skipped — they say nothing to a person and the diff still holds them.
  // Deletes stay out of this: a deleted row's whole record is in the payload, so
  // picking two arbitrary columns out of it says less than "删除" does.
  if (!out.length && !del) {
    for (const [k, v] of Object.entries(src)) {
      if (out.length >= 2) break;
      if (!FIELDS[k] || /ids?$/i.test(k) || k === 'title' || k === 'name' || k === 'label') continue;
      if (v == null || v === '' || typeof v === 'object') continue;
      const bool = typeof v === 'boolean' || (BOOLISH.has(k) && (v === 0 || v === 1));
      out.push(`${FIELDS[k][lang]} ${bool ? (v ? s.smYes : s.smNo) : clip(v, 18)}`);
    }
  }
  return out.join(' · ');
}

export default function Audit() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  // Layout v2（2026-10-06 她定）：AI 治理不再单独占侧栏一项，作为本页第二个分节（同属 audit 域，可见性仍按 aiPageVisible）；
  // 旧地址 /admin/ai-governance 跳到 /admin/audit?section=ai。
  const { user } = useAuth();
  const { search } = useLocation();
  const aiOn = aiPageVisible(user);
  const initialSection = aiOn && new URLSearchParams(search).get('section') === 'ai' ? 1 : 0;

  const [query, setQuery] = useState('');
  const [fAction, setFAction] = useState('');
  // Nothing prunes the log, so it only grows; the design opens on the last 7 days.
  const [range, setRange] = useState('7d');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_LOG);

  /* F1：动作筛选、时间范围、翻页都下推到服务端（GET /api/admin/audit 的
     action / since / limit / offset 参数）。以前这三件事全在浏览器里做，于是
     「最近 2000 条」就是可见性的天花板——P3 起 manager.view_profile 成了高频行，
     足以把 auth.login_failed 与 employee.update 挤出窗口。现在服务端在全表上筛，
     并返回筛过（且按 D7 范围过滤过）的真实 total，「共 N 条」与页码档位才不撒谎。

     仍留在前端的只有搜索框：它的干草堆里有本地化的动作名与 summarize() 生成的
     「详情」摘要，服务端两样都没有，下推等于砍掉一半可搜的字面。所以搜索照旧只在
     **已载入的窗口**里过滤（与改动前一字不差），而窗口现在还跟着动作/时间参数走，
     能搜到的范围只增不减。 */
  const WINDOW = 2000;                 // 搜索时的窗口（= 端点默认 limit）
  const q = query.trim();
  const since = useMemo(() => {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
    return days ? new Date(Date.now() - days * 86400000).toISOString() : '';
  }, [range]);
  /* 两种取法，取决于搜索框空不空：
     · 没搜索 → 只取**当前这一页**（limit=pageSize, offset=页首）。实测 6000 行的日志上
       一页 100 行是 26KB / ~30ms，而改动前每次开页都要拉 2000 行 = 520KB / ~400ms。
     · 有搜索 → 取一整扇窗口（offset 恒 0），因为搜索的干草堆里有本地化文案，只能在
       前端做；窗口内翻页也就得在命中里做（见 pageRows），否则「第 3 页」会既指服务端
       的第 3 页、又指命中的第 3 页。每个筛选控件都把页码归 1，所以两种模式切换时页码
       永远是 1，不会出现越界的空表。 */
  const limit = q ? WINDOW : pageSize;
  const offset = q ? 0 : (page - 1) * pageSize;
  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (offset) p.set('offset', String(offset));
    if (fAction) p.set('action', fAction);
    if (since) p.set('since', since);
    return p.toString();
  }, [limit, offset, fAction, since]);
  const { loading, error, data } = useAsync(() => api.get('/api/admin/audit?' + qs), [qs]);

  // Normalize the raw log entries into the shape the table/diff expect.
  // /api/admin/audit answers { rows, total, limit, truncated }; the bare-array
  // form is the pre-total contract, still accepted so an older server renders.
  const rows = useMemo(() => {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.rows) ? data.rows : []);
    return list.map((r) => {
      const row = {
        id: r.id,
        createdAt: r.createdAt,
        actor: r.actor || s.system,
        actorId: r.actorId,
        action: r.action,
        target: r.target,
        // The resolved object name comes as a pair (targetLabel + targetLabel_zh,
        // the latter falling back to the English one server-side), so the 对象
        // column follows the interface language instead of always showing the
        // English exam/course name.
        targetLabel: loc(r, 'targetLabel') || null,
        // Both spellings, for the search haystack and the summarizer's
        // don't-say-it-twice check — searching an English name must keep working
        // on the Chinese screen.
        // De-duped because targetLabel_zh falls back to the English string when
        // there is no Chinese name, which is the common case.
        targetNames: [...new Set([r.targetLabel, r.targetLabel_zh].filter(Boolean))],
        requestId: r.requestId,
        sys: !r.actor || r.actor === 'ADMIN',
        change: buildChange(r.before, r.after),
        after: r.after,
        before: r.before,
      };
      // Precomputed so search can match on it as the placeholder promises.
      row.detail = summarize(row, s, lang);
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lang]);

  /* total 由服务端给：筛过 + 按范围过滤过的真实可见条数（不是取回条数）。老的
     裸数组契约没有 total，那时只能退回窗口长度。 */
  const total = data && typeof data.total === 'number' ? data.total : rows.length;
  const truncated = !!(data && data.truncated);

  const actionLabel = (key) => {
    const a = ACTIONS[key];
    return a ? (lang === 'zh' ? a.zh : a.en) : key;
  };

  /* 只剩搜索：动作与时间已经是服务端参数，这里不再重筛一遍（重筛也只会在窗口里
     再削一次，反而让「共 N 条」和服务端的 total 打架）。 */
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => {
      const hay = [
        r.actor, r.target, ...r.targetNames, r.action, actionLabel(r.action), r.detail,
      ].join(' ').toLowerCase();
      return hay.includes(needle);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, lang]);

  /* 本页要渲染的行 + 页码器的总数。无搜索：服务端取回的就**是**这一页，页数由服务端的
     total 决定（能一直翻到日志尽头，页码档位不再是空的）。有搜索：在已载入窗口的命中里
     前端翻页，总数就是命中数 —— 与改动前完全一样的行为。 */
  const pagerTotal = q ? filtered.length : total;
  const pageRows = q ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;

  // 「姓名 (T-00858)」里的工号整段不折行：连字符本身是断行点，窄列里会断成「(T-」「00858)」两行（同事反馈 V2，2026-10-08）
  const keepId = (label) => {
    const m = typeof label === 'string' ? label.match(/^(.*\S)\s+(\([^()\s]+\))$/) : null;
    return m ? <>{m[1]} <span style={{ whiteSpace: 'nowrap' }}>{m[2]}</span></> : label;
  };
  const actionTag = (key) => {
    const a = ACTIONS[key];
    return <Tag color={a ? a.color : 'grey'} type="light" size="large">{actionLabel(key)}</Tag>;
  };

  const detailText = (r) => {
    if (r.action && r.action.endsWith('.create')) return s.created;
    if (r.action && r.action.endsWith('.delete')) return s.deleted;
    if (r.change.length) return s.changedN(r.change.length);
    return s.dash;
  };

  /* One side of one field as a diff line: sign, field name, value. <del>/<ins>
     say which side this is, so the −/+ glyphs can stay decorative and no column
     headers are needed to read the block. */
  const diffLine = (kind, field, v) => {
    const El = kind === 'before' ? 'del' : 'ins';
    // CX-220：布尔值写「是 / 否」，数组名按界面语言
    const yn = (t) => t.charAt(0).toUpperCase() + t.slice(1);   // 英文写 Yes / No
    const txt = typeof v === 'boolean' ? yn(v ? s.smYes : s.smNo) : fmtVal(v, lang);
    const empty = txt === '' || txt == null;
    return (
      <El className={'audit-dline audit-dline-' + kind}>
        <span className="audit-dsign" aria-hidden="true">{kind === 'before' ? '−' : '+'}</span>
        {/* CX-142：字段名按界面语言显示（FIELDS 里没有的才露出原始键名） */}
        {field && <span className="audit-field" title={field}>{FIELDS[field] ? FIELDS[field][lang] : field}{lang === 'zh' ? '：' : ':'}</span>}
        <span className={'audit-dval' + (empty ? ' audit-val-empty' : '')}>{empty ? s.dash : txt}</span>
      </El>
    );
  };

  const renderDiff = (record) => (
    <div className="audit-diff">
      <div className="audit-diff-h">{s.fieldChanges}</div>
      <div className="audit-difftable">
        {record.change.map((c, i) => (
          <div className="audit-dpair" key={i}>
            {diffLine('before', c.field, c.before)}
            {diffLine('after', c.field, c.after)}
          </div>
        ))}
      </div>
    </div>
  );

  // 列宽合计（含展开列）控制在 800px 内：设置工作区右栏在 1280 宽的屏幕上约 806px，原先合计 1,006px，
  // 「详情」一列有一半落在可视区外（同事反馈 V2，2026-10-08）。列仍可拖宽，拖宽后横向滚动。
  const columns = [
    {
      title: s.colTime, dataIndex: 'createdAt', width: 112, className: 'audit-c-time',
      render: (ts, r) => {
        const { d, t } = fmtTime(ts);
        return (
          <>
            <div className="audit-time">
              <span className="audit-date tnum">{d}</span>
              <span className="audit-clock tnum">{t}</span>
            </div>
            {/* Below 900px this one cell draws the whole entry as the design's
                three-line card and the other cells hide, so the log keeps its
                paging and its expandable diff instead of forking into a list. */}
            <div className="audit-mcard">
              <div className="audit-mc-l1">
                <span className="audit-mc-when tnum">{mmdd(d)} {t}</span>
                {actionTag(r.action)}
              </div>
              <div className="audit-mc-l2">{keepId(r.targetLabel || r.target || s.dash)}</div>
              <div className="audit-mc-l3">
                {[r.actor, r.detail || detailText(r)].filter(Boolean).join(' · ')}
              </div>
            </div>
          </>
        );
      },
    },
    {
      title: s.colActor, dataIndex: 'actor', width: 136,
      render: (actor, r) => (
        <div className="audit-actor">
          <span className="audit-avatar" aria-hidden="true">{String(actor || '').slice(0, 1)}</span>
          <span className="audit-actor-body">
            <Text className="audit-actor-name">{actor}</Text>
            {r.sys && <span className="audit-sys">{s.system}</span>}
          </span>
        </div>
      ),
    },
    {
      // The toolbar's 全部动作 is the only action filter. A header funnel on the
      // same field ANDs with it, so the two could empty the table between them
      // with neither control showing why.
      title: s.colAction, dataIndex: 'action', width: 140,
      render: (key) => actionTag(key),
    },
    {
      title: s.colObject, dataIndex: 'target', width: 168,
      // The stored target is an internal id; show the resolved label when the
      // server could find one and keep the id underneath for support.
      render: (target, r) => (
        <div className="audit-obj">
          <Text className="audit-obj-name">{keepId(r.targetLabel || target || s.dash)}</Text>
          {r.targetLabel && target && <span className="audit-obj-sub">{target}</span>}
        </div>
      ),
    },
    {
      title: s.colDetail, dataIndex: 'detail', width: 184,
      render: (_v, r) => (
        <div className="audit-detail">
          <span className="audit-sum">{r.detail || detailText(r)}</span>
          {/* The row expands on click — say so, and say when there is nothing
              to expand, rather than leaving the affordance to be discovered. */}
          <span className={'audit-more' + (r.change.length ? '' : ' audit-more-off')}>
            {r.change.length ? s.diffTitle : s.dash}
          </span>
        </div>
      ),
    },
  ];

  return (
    <div className="wrap audit-wrap">
      {/* header (no icon before the title) */}
      <div className="audit-head">
        <div>
          <h1 className="audit-title">{s.title}</h1>
          <div className="audit-lead">{s.lead}</div>
        </div>
      </div>

      <SettingsWorkspace initial={initialSection}>
      <div data-section={s.secLog}>
      {error && (
        <Banner type="danger" description={`${s.loadErr}${error.message ? ' · ' + error.message : ''}`} style={{ marginBottom: 16 }} />
      )}

      {/* toolbar */}
      <div className="audit-toolbar">
        <Input
          prefix={<IconSearch />}
          placeholder={s.searchPh}
          value={query}
          onChange={(v) => { setQuery(v); setPage(1); }}
          showClear
          className="audit-search"
        />
        <Select
          placeholder={s.actionAll}
          value={fAction || undefined}
          onChange={(v) => { setFAction(v || ''); setPage(1); }}
          showClear
          className="audit-filter"
          optionList={Object.keys(ACTIONS).map((k) => ({
            label: lang === 'zh' ? ACTIONS[k].zh : ACTIONS[k].en, value: k,
          }))}
        />
        <Select
          value={range}
          onChange={(v) => { setRange(v || 'all'); setPage(1); }}
          className="audit-range"
          optionList={[
            { label: s.r7, value: '7d' },
            { label: s.r30, value: '30d' },
            { label: s.r90, value: '90d' },
            { label: s.rAll, value: 'all' },
          ]}
        />
        <span className="audit-count">{s.total(nf(pagerTotal))}</span>
      </div>

      {/* append-only table with expandable before/after diff */}
      <div className="audit-tablecard">
        <Table
          rowKey="id"
          loading={loading}
          {...resizableTable(columns, { extra: 60 })}
          dataSource={pageRows}
          expandedRowRender={(record) => (record && record.change && record.change.length ? renderDiff(record) : null)}
          rowExpandable={(record) => !!(record && record.change && record.change.length)}
          expandRowByClick
          /* Carries the action group onto the row so the mobile card can show it
             as a left border — the same grouping the desktop Tag colour says. */
          onRow={(r) => ({ className: 'audit-row-' + ((r && ACTIONS[r.action] && ACTIONS[r.action].color) || 'grey') })}
          /* 受控页码（传了 currentPage，Semi 就不再自己切 dataSource），总数用
             服务端的 total —— 页码档位不再因为窗口太小而永远是空的。 */
          pagination={{
            currentPage: page, pageSize, total: pagerTotal,
            pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false,
            onChange: (cur, size) => {
              if (size !== pageSize) { setPageSize(size); setPage(1); } else setPage(cur);
            },
          }}
          empty={<Empty description={s.empty} />}
        />
      </div>
      {/* Handoff 16: state the log's guarantee where the log is, not only in the
          page lead — it is what makes the entries worth trusting. */}
      <div className="audit-foot">
        <span>{s.retention}</span>
        {/* 翻页已经能走到日志尽头，所以只有**搜索**还受窗口限制（干草堆里有本地化
            文案，无法下推）。那一种情况才说明「只载入了最近多少条」，免得在能翻到底
            的时候还挂一条无谓的警告。文案未动。 */}
        {truncated && !!q && <span className="audit-window">{s.window(nf(total), nf(rows.length))}</span>}
      </div>
      </div>
      {aiOn && <AiGovernance embedded data-section={s.secAi} />}
      </SettingsWorkspace>
    </div>
  );
}
