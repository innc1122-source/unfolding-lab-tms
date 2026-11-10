// 人才筛选整页（第五批 8.1，2026-10-08）：/admin/talent-review/filter/new 与 /admin/talent-review/filter/:id。
// ① AI 一句话转条件（可用时显示）② 条件编辑器（且 / 或，最多两层）③ 结果栏：人数、列、导出、加入继任名单、加入晋升候选
// ④ 结果表（服务端分页、可多选、显示条件命中）⑤ 保存 / 另存为（弹窗）。离开时有未保存修改用 useLeaveGuard 提示。
// 接口（设计第 4.3、6、7 节）：GET catalog、GET/POST/PUT talent-filters、POST run / export / ai-parse / :id/members、POST succession/bulk。
// 条件的增删改、摘要、值控件选择都在 ./talentFilter.js（纯函数，test/talent-filter-ui.test.js 直接跑）。
// 条件变化后防抖 400 ms 自动查询；AI 生成的条件不自动查询，HR 核对后点「查询」。
import { useUrlState } from '../../urlstate.js';
import { saveCsv } from '../../csv.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Button, Select, Input, InputNumber, Checkbox, Radio, RadioGroup, Tag, Toast, Banner, Spin, Empty, Table, Typography, Modal, Popconfirm, TextArea,
} from '@douyinfe/semi-ui';
import { IconArrowLeft, IconPlus, IconDelete, IconArrowUp, IconArrowDown, IconRefresh } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { canReadDomain, canWriteDomain } from '../../rbac.js';
import { resizableTable } from '../../cardify.js';
import { errText } from '../../apierr.js';
import DeptFilter from '../../components/DeptFilter.jsx';
import { useDeptTree } from '../../deptfilter.js';
import { ranksInRange } from '../../jobgrades.js';
import { useLeaveGuard, confirmLeave } from '../../components/useLeaveGuard.js';
import { BulkBar, BulkConfirmModal, BULK_SEL_EXTRA, bulkErrorText } from '../../components/BulkActions.jsx';
import * as TF from './talentFilter.js';

const { Text } = Typography;
// AI 输入框：off_module / off_owner / off_feature 时整块不显示；not_configured / budget_exhausted 时灰显并说明原因
const AI_SHOWN = ['on', 'demo', 'not_configured', 'budget_exhausted'];
const READINESS = ['ready', 'oneYear', 'twoYears'];
// QA D6（§19）：结果列由用户选，列宽收紧。1440 宽时表格区约 1116px：默认 7 列 766 + 勾选列 60 + 条件命中（≤ 200）放得下；
// 列更多（如晋升评审候选 10 列）时横向滚动，勾选列与姓名列固定在左侧、条件命中固定在右侧。scroll.x 由 resizableTable 按实际列宽合计。
const COL_W = { name: 140, employeeId: 96, department: 170, position: 140, jobLevel: 84, nextLevel: 92, latestRating: 96, recentRatings: 130, potential: 90, tenure: 90, levelTenure: 110, manager: 130, trainingMandatory: 110, trainingCompletion: 110, violationCount: 90, awardCount: 90, successionPositions: 160, talentTags: 160, member: 104 };
const COL_W_DEFAULT = 120;
// 条件命中：每个「1✓」约 34px，一行排下；超过 200px（约 5 条）换行
const hitsWidth = (n) => Math.min(200, Math.max(96, 34 * n + 28));

const T = {
  zh: {
    newTitle: '新建筛选', back: '返回人才盘点', unsaved: '有未保存的修改', leaveAsk: '筛选条件有未保存的修改，确定离开吗？',
    loadFail: '加载失败，请刷新页面重试。', notFound: '该筛选不存在，或你无权查看。',
    roNote: '你的角色对人才发展是只读权限：可以设置条件查询，不能保存筛选、使用 AI 生成条件或执行批量操作。',
    redacted: (n) => `有 ${n} 个条件值在你的数据范围外，已隐藏。另存为时保存的是隐藏后的条件。`,
    kindBuiltin: '内置', kindShared: '共享', kindPrivate: '私有', ownerOf: (n) => `创建人：${n}`,
    sharedReadOnly: (n) => `这是${n ? n + ' ' : ''}创建的共享筛选，只有创建人和超级管理员可以修改。你可以改条件查询，保存请用「另存为」存成自己的筛选。`,
    save: '保存', saveAs: '另存为', props: '名称与共享', reset: '恢复默认', resetAsk: '恢复晋升评审候选的默认条件？',
    resetDesc: '条件、列与排序恢复为默认设置；手动加入与排除名单不受影响。', resetDone: '已恢复默认条件',
    saved: '已保存', created: '筛选已保存', copyName: (n) => `${n}（副本）`,
    nameZh: '中文名', nameEn: '英文名（English）', needName: '至少填写一个名称', visibility: '可见范围',
    visPrivate: '仅自己可见', visShared: '共享给全部人才管理员', visSharedHint: '共享筛选只有创建人和超级管理员可以修改，其他人可以另存为自己的筛选。',
    saveTitle: '保存筛选', saveAsTitle: '另存为新的筛选', propsTitle: '名称与共享设置',
    secCond: '筛选条件', condLead: '每条条件选择字段、运算符和取值；条件组用于表达「(A 且 B) 或 C」这类组合。条件变化后自动查询。',
    logicAll: '全部满足', logicAny: '任一满足', addCond: '添加条件', addGroup: '添加条件组', removeCond: '删除条件', removeGroup: '删除条件组',
    groupTitle: (n) => `条件组 ${n}`, includeExited: '包含已离职员工', pickField: '选择字段', pickOp: '运算符', pickValue: '选择取值', modOff: '所属模块未开启',
    incomplete: '待填写：这条条件不参与查询，填完后自动生效。', incompleteSave: '还有未填写完整的条件，请填写或删除后再保存。',
    maxNote: '每个筛选最多 30 条条件、根节点最多 20 项、每个条件组最多 12 条。',
    from: '从', to: '到', rangeIs: (list) => `包含：${list}`, months: '个月', monthsAny: '0 = 不限', percent: '%', times: '次',
    pN: '近', pPeriods: '期', pMode: '计算方式', modeAll: '每期都满足', modeAny: '任一期满足', modeK: '至少 K 期满足', pK: 'K =',
    pPeriod: '期别', periodAny: '不区分期别', periodQ: '季度', periodH: '半年', periodA: '年度',
    pMissing: '不足期数时', missFail: '判为不满足', missIgnore: '按已有期数计算',
    pWindow: '时间窗', pWindowOff: '按期数', pWindowOn: '按近 N 个月', pWindowMonths: '个月内的全部评级', pMissingWin: '窗内没有评级时', missWinIgnore: '判为满足',
    defaultsPending: '默认条件已更新（公司晋升门槛，2026-10-09）。此筛选曾被修改，所以保留了原条件；可以「恢复默认」改用新条件。',
    pFresh: '只认 12 个月内的评定', pScope: '统计范围', scopeMand: '仅必修', scopeAll: '全部指派',
    pWithin: '时间范围（近 N 个月）', pAwardNames: '奖项（选填，不选 = 不限）', pSeverity: '严重程度（不选 = 不限）', sevMajor: '重大', sevMinor: '轻微',
    pRecType: '记录类型', pRecField: (n) => `${n}（不选 = 不限）`, pPosition: '关键岗位（选填）',
    run: '查询', running: '查询中…', refresh: '刷新结果', total: (n) => `共 ${n} 人`, noResults: '没有符合条件的员工', noCond: '还没有条件：结果为数据范围内的全部在职员工。',
    colHits: '条件命中', hitsTip: '按条件编号显示：✓ 满足 · ✗ 不满足 · – 未参与（未填写或已忽略）',
    columns: '列', columnsTitle: '选择结果列', colShown: '已显示（按顺序）', colHidden: '可添加', moveUp: '上移', moveDown: '下移', apply: '应用', cancel: '取消', close: '关闭',
    exportCsv: '导出', exported: '已导出', eExport: '你的角色没有导出权限（需要员工档案的查看权限）。',
    selectAll: '选择全部结果', capNote: (n) => `批量操作每次最多 ${n} 人，已选中排序靠前的 ${n} 人。`, overCap: (n) => `已选人数超过 ${n} 人，请减少后再执行批量操作。`,
    bulkSucc: '加入继任名单', bulkPromo: '加入晋升候选',
    scPos: '关键岗位', scPosPh: '选择已有岗位，或输入新的关键岗位', scReady: '就绪度', scNote: '备注（选填）',
    ready: '即刻就绪', oneYear: '1–2 年内就绪', twoYears: '2 年以上就绪',
    succSkipHint: (n) => (n > 0 ? `已在该岗位继任名单中的 ${n} 人将跳过。` : '所选人员都不在该岗位的继任名单中。'),
    promoNote: '说明（选填，写入审计）', promoLoading: '正在核对晋升评审候选名单…',
    promoHint: (a, b) => `已在名单中的 ${a} 人将跳过；${b} 人没有下一职级，将列入但下一职级显示为「—」，需人工确定。`,
    promoNone: '晋升评审候选筛选尚未就绪，暂时无法加入。',
    resultTitle: (op) => `「${op}」部分未完成`, resultSum: (d, k) => `已完成 ${d} 人，跳过 ${k} 人：`, doneN: (n) => `已完成 ${n} 人`,
    why: { already_listed: '已在该岗位的继任名单中', inactive: '已离职或账号已停用', already_member: '已在名单中', already_included: '已手动加入', already_eligible: '已满足条件，无需手动加入', already_excluded: '已在排除名单中', not_member: '不在人工名单中', not_found: '查无此人', out_of_view: '不在人才盘点页面顶部筛选的范围内' },
    // F60：从人才盘点打开时叠加页面顶部筛选（结果 = 顶部范围 ∩ 本页条件）
    scopeOn: '已叠加页面顶部筛选', scopeLead: '结果只含人才盘点页面顶部筛选范围内的员工；导出与批量操作同样按此范围。', scopeOff: '不叠加顶部筛选',
    memberInclude: '手动加入', memberExclude: '已排除', inactive: '已离职',
    warnTitle: '以下条件未按设置生效：',
    warn: {
      module_off: (l) => `条件 ${l} 所属模块未开启，已忽略。`,
      field_removed: (l) => `条件 ${l} 的字段已停用或删除，已忽略。`,
      field_retired: (l) => `条件 ${l} 已停用，请改用岗位序列；查询时已忽略。`,
      value_unavailable: (l, n) => `条件 ${l} 有 ${n} 个取值已删除或在你的数据范围外，已去掉；去掉后没有取值的条件不匹配任何人。`,
    },
    warnOther: (l, c) => `条件 ${l}：${c}`,
    unmappedTitle: '职级未纳入职级体系', unmappedLead: (n) => `${n} 人的职级未纳入职级体系，无法判断是否有下一职级。请在「档案与职级设置 › 职级体系」中补充，或在员工档案中修改职级。`,
    aiTitle: 'AI 生成条件', aiLead: '用一句话描述要找的人，AI 将其转换为下方的筛选条件。只发送你输入的这句话（人名先脱敏），不发送任何员工数据；生成的条件需要你核对后再查询。',
    aiPh: '例如：财务部 P1 到 P3、近两期绩效都在 A 以上、近 12 个月无违纪记录的高潜员工', aiRun: '生成条件', aiUndo: '撤销 AI 修改',
    aiNotice: '以下条件由 AI 生成，请核对后点「查询」。', aiDemo: '演示模式：条件由本地规则生成，未调用 AI 服务。',
    aiUnsupported: '以下内容无法转换为条件，请手动补充：', aiChoice: (t) => `「${t}」对应多个选项，请选择：`,
    aiOffConf: 'AI 服务尚未接入，暂时无法生成条件；可以直接在下方手动设置。', aiOffBudget: '本月 AI 用量已达上限，暂时无法生成条件；可以直接在下方手动设置。',
    aiErr: { ai_feature_off: '该 AI 功能未开启', ai_not_configured: 'AI 服务尚未接入', ai_rate_limited: 'AI 生成次数已达上限，请稍后再试', ai_budget_exhausted: '本月 AI 用量已达上限', ai_output_invalid: 'AI 未能生成有效的条件，请换一种说法再试', ai_input_too_large: '描述过长，请控制在 500 字以内' },
    eConflict: '此筛选已被他人修改，请刷新后再改。', eInvalid: '条件有误，请按标出的条件修改。', eNameTaken: '你能看到的筛选（自己的私有筛选与共享筛选）中已有同名的中文名或英文名，请换一个名称。', eLimit: '筛选数量已达上限（每人最多 50 条私有筛选，共享筛选全公司最多 200 条）。',
    e: {
      not_object: '条件格式不正确', bad_version: '条件版本不受支持', bad_logic: '「全部满足 / 任一满足」设置不正确', too_deep: '条件最多两层',
      too_many_items: '条件项数超过上限', too_many_leaves: '条件总数超过 30 条', too_large: '条件内容过大', unknown_field: '字段不存在',
      bad_op: '该字段不支持这个运算符', bad_value: '取值类型不正确', value_not_in_options: '取值不在可选范围内', value_out_of_range: '取值超出允许范围',
      too_many_values: '取值数量超过上限（200 项）', string_too_long: '文字超过 100 字', bad_params: '附加设置不正确', record_type_unknown: '记录类型不存在',
      record_type_unavailable: '该记录类型所属模块未开启', custom_field_unknown: '自定义字段不存在', module_off: '所属模块未开启，已忽略',
      field_removed: '字段已停用或删除，已忽略', value_unavailable: '部分取值已删除或在你的数据范围外',
      field_retired: '该条件已停用，请改用岗位序列',
    },
  },
  en: {
    newTitle: 'New filter', back: 'Back to Talent Review', unsaved: 'Unsaved changes', leaveAsk: 'The filter has unsaved changes. Leave anyway?',
    loadFail: 'Couldn’t load. Refresh the page to try again.', notFound: 'This filter doesn’t exist, or you don’t have access to it.',
    roNote: 'Your role has read-only access to talent development: you can set conditions and run queries, but not save filters, draft conditions with AI or run bulk actions.',
    redacted: (n) => `${n} condition value${n === 1 ? ' is' : 's are'} outside your data scope and hidden. Saving a copy saves the conditions without them.`,
    kindBuiltin: 'Built-in', kindShared: 'Shared', kindPrivate: 'Private', ownerOf: (n) => `Created by ${n}`,
    sharedReadOnly: (n) => `This shared filter was created by ${n || 'someone else'}; only the creator and super admins can change it. You can edit the conditions to run them — use "Save as" to keep your own copy.`,
    save: 'Save', saveAs: 'Save as', props: 'Name and sharing', reset: 'Restore default', resetAsk: 'Restore the default promotion panel criteria?',
    resetDesc: 'Conditions, columns and sorting return to the defaults. Manually added and excluded employees are kept.', resetDone: 'Default criteria restored',
    saved: 'Saved', created: 'Filter saved', copyName: (n) => `${n} (copy)`,
    nameZh: 'Chinese name', nameEn: 'English name', needName: 'Enter at least one name', visibility: 'Visible to',
    visPrivate: 'Only me', visShared: 'All talent administrators', visSharedHint: 'Only the creator and super admins can change a shared filter; others can save their own copy.',
    saveTitle: 'Save filter', saveAsTitle: 'Save as a new filter', propsTitle: 'Name and sharing',
    secCond: 'Conditions', condLead: 'Each condition is a field, an operator and a value. Use a condition group for combinations such as “(A and B) or C”. Results refresh automatically.',
    logicAll: 'Match all', logicAny: 'Match any', addCond: 'Add condition', addGroup: 'Add condition group', removeCond: 'Remove condition', removeGroup: 'Remove group',
    groupTitle: (n) => `Group ${n}`, includeExited: 'Include separated employees', pickField: 'Choose a field', pickOp: 'Operator', pickValue: 'Choose values', modOff: 'module off',
    incomplete: 'To be completed: this condition is left out of the query until it is filled in.', incompleteSave: 'Some conditions are incomplete. Complete or remove them before saving.',
    maxNote: 'Up to 30 conditions per filter, 20 items at the top level and 12 conditions per group.',
    from: 'From', to: 'To', rangeIs: (list) => `Covers: ${list}`, months: 'months', monthsAny: '0 = any time', percent: '%', times: 'times',
    pN: 'Last', pPeriods: 'periods', pMode: 'Rule', modeAll: 'Every period', modeAny: 'At least one period', modeK: 'At least K periods', pK: 'K =',
    pPeriod: 'Period type', periodAny: 'Any period type', periodQ: 'Quarterly', periodH: 'Half-yearly', periodA: 'Annual',
    pMissing: 'Too few periods', missFail: 'Does not match', missIgnore: 'Count the periods on file',
    pWindow: 'Window', pWindowOff: 'By periods', pWindowOn: 'Last N months', pWindowMonths: 'months, every rating inside', pMissingWin: 'No rating in the window', missWinIgnore: 'Counts as met',
    defaultsPending: 'The default criteria changed (company promotion threshold, 2026-10-09). This filter had been edited, so its conditions were kept; use "Restore default" to switch to the new criteria.',
    pFresh: 'Only assessments within 12 months', pScope: 'Count', scopeMand: 'Required only', scopeAll: 'All assignments',
    pWithin: 'Time window (last N months)', pAwardNames: 'Awards (optional; none = any)', pSeverity: 'Severity (none selected = any)', sevMajor: 'Major', sevMinor: 'Minor',
    pRecType: 'Record type', pRecField: (n) => `${n} (optional)`, pPosition: 'Key position (optional)',
    run: 'Run', running: 'Running…', refresh: 'Refresh results', total: (n) => `${n} ${n === 1 ? 'person' : 'people'}`, noResults: 'No matching employees', noCond: 'No conditions yet: results are everyone active in your data scope.',
    colHits: 'Conditions met', hitsTip: 'By condition number: ✓ met · ✗ not met · – not applied (incomplete or ignored)',
    columns: 'Columns', columnsTitle: 'Result columns', colShown: 'Shown (in order)', colHidden: 'Available', moveUp: 'Move up', moveDown: 'Move down', apply: 'Apply', cancel: 'Cancel', close: 'Close',
    exportCsv: 'Export', exported: 'Exported', eExport: 'Your role cannot export (it needs read access to Employee Profiles).',
    selectAll: 'Select all results', capNote: (n) => `Bulk actions take up to ${n} people at a time; the first ${n} in the current order are selected.`, overCap: (n) => `More than ${n} people selected. Reduce the selection to run a bulk action.`,
    bulkSucc: 'Add to succession plan', bulkPromo: 'Add to promotion panel candidates',
    scPos: 'Key position', scPosPh: 'Choose a position or type a new key position', scReady: 'Readiness', scNote: 'Note (optional)',
    ready: 'Ready now', oneYear: 'Ready in 1–2 years', twoYears: 'Ready in 2+ years',
    succSkipHint: (n) => (n > 0 ? `${n} ${n === 1 ? 'person is' : 'people are'} already successors for this position and will be skipped.` : 'None of the selected people are successors for this position yet.'),
    promoNote: 'Note (optional; recorded in the audit log)', promoLoading: 'Checking the promotion panel candidate list…',
    promoHint: (a, b) => `${a} already on the list will be skipped; ${b} with no next job level will be added with the next level shown as “—” for HR to decide.`,
    promoNone: 'The promotion panel candidate filter is not ready yet, so people cannot be added.',
    resultTitle: (op) => `“${op}” partly completed`, resultSum: (d, k) => `${d} done, ${k} skipped:`, doneN: (n) => `${n} done`,
    why: { already_listed: 'Already a successor for this position', inactive: 'Separated or account deactivated', already_member: 'Already on the list', already_included: 'Already added manually', already_eligible: 'Already meets the criteria; no need to add manually', already_excluded: 'Already excluded', not_member: 'Not on the manual list', not_found: 'Employee not found', out_of_view: 'Outside the Talent Review page filters' },
    scopeOn: 'Talent Review page filters applied', scopeLead: 'Results include only employees within the filters set at the top of Talent Review; exports and bulk actions use the same scope.', scopeOff: 'Remove page filters',
    memberInclude: 'Added manually', memberExclude: 'Excluded', inactive: 'Separated',
    warnTitle: 'These conditions did not apply as set:',
    warn: {
      module_off: (l) => `Condition ${l} belongs to a module that is off, so it was ignored.`,
      field_removed: (l) => `The field in condition ${l} was deactivated or deleted, so it was ignored.`,
      field_retired: (l) => `Condition ${l} has been retired, so it was ignored. Use Track instead.`,
      value_unavailable: (l, n) => `Condition ${l} had ${n} ${n === 1 ? 'value that no longer exists or is' : 'values that no longer exist or are'} outside your data scope; they were removed, and a condition left with no value matches nobody.`,
    },
    warnOther: (l, c) => `Condition ${l}: ${c}`,
    unmappedTitle: 'Job level not in the Job Level Framework', unmappedLead: (n) => `${n} ${n === 1 ? 'person has a job level' : 'people have job levels'} outside the Job Level Framework, so the next job level cannot be determined. Add the level under Profile & Job Level Settings › Job Level Framework, or correct it on the profile.`,
    aiTitle: 'Draft conditions with AI', aiLead: 'Describe the people you are looking for in one sentence and AI turns it into the conditions below. Only your sentence is sent (names are masked first), never employee data. Check the conditions before running the query.',
    aiPh: 'e.g. High-potential employees in Finance at P1 to P3, rated A or above in the last two periods, with no disciplinary record in the last 12 months', aiRun: 'Draft conditions', aiUndo: 'Undo AI changes',
    aiNotice: 'These conditions were drafted by AI. Check them, then select Run.', aiDemo: 'Demo mode: the conditions came from local rules; no AI service was called.',
    aiUnsupported: 'These parts could not be turned into conditions; add them by hand:', aiChoice: (t) => `“${t}” matches more than one option. Choose one:`,
    aiOffConf: 'The AI service is not connected yet. Set the conditions below by hand.', aiOffBudget: 'This month’s AI usage limit has been reached. Set the conditions below by hand.',
    aiErr: { ai_feature_off: 'This AI feature is not enabled', ai_not_configured: 'The AI service is not connected yet', ai_rate_limited: 'AI drafting limit reached — try again later', ai_budget_exhausted: 'This month’s AI usage limit has been reached', ai_output_invalid: 'AI could not produce valid conditions. Try wording it differently.', ai_input_too_large: 'Keep the description within 500 characters' },
    eConflict: 'Someone else changed this filter. Refresh the page before editing it.', eInvalid: 'Some conditions are invalid. Correct the marked conditions.', eNameTaken: 'A filter you can see (your private filters or the shared ones) already uses this Chinese or English name. Use another name.', eLimit: 'Filter limit reached (50 private filters per person, 200 shared filters company-wide).',
    e: {
      not_object: 'The conditions are malformed', bad_version: 'Unsupported condition version', bad_logic: 'Invalid “match all / match any” setting', too_deep: 'Conditions can be nested only two levels deep',
      too_many_items: 'Too many items', too_many_leaves: 'More than 30 conditions', too_large: 'The conditions are too large', unknown_field: 'Unknown field',
      bad_op: 'This field does not support that operator', bad_value: 'Wrong kind of value', value_not_in_options: 'Value not among the options', value_out_of_range: 'Value out of range',
      too_many_values: 'Too many values (200 at most)', string_too_long: 'Text longer than 100 characters', bad_params: 'Invalid extra settings', record_type_unknown: 'Unknown record type',
      record_type_unavailable: 'This record type belongs to a module that is off', custom_field_unknown: 'Unknown custom field', module_off: 'Its module is off, so it was ignored',
      field_removed: 'The field was deactivated or deleted, so it was ignored', value_unavailable: 'Some values no longer exist or are outside your data scope',
      field_retired: 'This condition has been retired. Use Track instead',
    },
  },
};

const parseJson = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
};
const safeStorage = () => { try { return window.localStorage; } catch (e) { return null; } };
const snap = (def, cols, sort) => JSON.stringify({ def, cols, sort: sort || null });
const arrOr = (v, d) => (Array.isArray(v) && v.length ? v.map(String) : d);
// 记录类型：目录里有 recordTypes 就用；没有时退回 /api/admin/config/records（只列启用、模块开启的类型与可筛选字段）
function recordTypesOf(field, cfg) {
  if (field && Array.isArray(field.recordTypes)) return field.recordTypes.filter((t) => t && t.available !== false);
  if (!cfg || !Array.isArray(cfg.types)) return [];
  return cfg.types.filter((t) => t.active && !t.moduleOff).map((t) => ({
    key: t.key, label: t.label, label_zh: t.label_zh,
    fields: (cfg.fields || []).filter((f) => f.typeKey === t.key && f.active && f.filterable && Array.isArray(f.options) && f.options.length)
      .map((f) => ({ key: f.key, label: f.label, label_zh: f.label_zh, options: f.options.map((o, i) => ({ value: o, label: o, label_zh: (f.options_zh || [])[i] || o })) })),
  }));
}

export default function TalentFilter() {
  const { lang } = useI18n();
  const s = T[lang];
  const navigate = useNavigate();
  const params = useParams();
  const [sp] = useSearchParams();
  const [, patchUrl] = useUrlState();
  const routeId = params.id && params.id !== 'new' ? params.id : null;
  const fromId = routeId ? null : sp.get('from');
  const recordType = routeId ? null : sp.get('record');
  // F60：人才盘点顶部筛选（地址栏同名键）= 页面人群范围；有范围时查询、选择全部、导出、批量操作都带 scope，结果 = 范围 ∩ 条件
  const scopeQs = TF.scopeQuery(TF.scopeOf(sp));
  const scope = useMemo(() => TF.scopeOf(new URLSearchParams(scopeQs)), [scopeQs]);
  const scoped = TF.scopeActive(scope);
  const dropScope = () => patchUrl(Object.fromEntries(TF.SCOPE_KEYS.map((k) => [k, null])), { push: false });
  const { user } = useAuth();
  const canWrite = canWriteDomain(user, 'talent');
  const canProfile = canReadDomain(user, 'people');
  // 导出与「人才记录 CSV」同一判定（canExportTalentRecords = 员工档案读权限）
  const canExport = canReadDomain(user, 'people');
  const aiState = user && user.ai ? user.ai.talentFilter : null;
  const aiVisible = canWrite && AI_SHOWN.includes(aiState);
  const aiReady = aiState === 'on' || aiState === 'demo';

  const catQ = useAsync(() => api.get('/api/admin/talent-filters/catalog'), []);
  const srcId = routeId || fromId || null;
  const srcQ = useAsync(() => (srcId ? api.get(`/api/admin/talent-filters/${encodeURIComponent(srcId)}`) : Promise.resolve(null)), [srcId]);
  const listQ = useAsync(() => api.get('/api/admin/talent-filters').catch(() => null), []);
  const gradeQ = useAsync(() => api.get('/api/admin/job-grades').catch(() => null), []);
  const cfgQ = useAsync(() => api.get('/api/admin/config/records').catch(() => null), []);
  const tree = useDeptTree();
  const catalog = catQ.data;
  const ranks = (gradeQ.data && gradeQ.data.ranks) || [];
  const promoId = useMemo(() => {
    const list = listQ.data && Array.isArray(listQ.data.filters) ? listQ.data.filters : [];
    const b = list.find((f) => f.builtinKey === 'promotion');
    return b ? b.id : null;
  }, [listQ.data]);

  // ---- 编辑状态 ----
  const [st, setSt] = useState(null);           // { meta, def, cols, sort, redacted }
  const [baseline, setBaseline] = useState('');
  const inited = useRef('');
  const initKey = `${routeId || ''}|${fromId || ''}|${recordType || ''}`;
  useEffect(() => {
    if (!catalog) return;
    if (srcId && !(srcQ.data && srcQ.data.filter)) return;
    if (inited.current === initKey) return;
    inited.current = initKey;
    let meta = { id: null, name: '', name_zh: '', builtinKey: null, visibility: 'private', version: null, canEdit: true, mine: true, owner: null };
    let def; let cols = TF.DEFAULT_COLUMNS.slice(); let sort = null; let redacted = 0;
    if (srcId) {
      const f = srcQ.data.filter;
      def = TF.normalizeDef(parseJson(f.definition));
      cols = arrOr(parseJson(f.columns), cols);
      sort = parseJson(f.sort) || null;
      redacted = Number(srcQ.data.redactedValues) || 0;
      if (routeId) {
        meta = { id: f.id, name: f.name || '', name_zh: f.name_zh || '', builtinKey: f.builtinKey || null, visibility: f.visibility || 'private', version: f.version, canEdit: !!f.canEdit, mine: !!f.mine, owner: f.owner || null, defaultsPending: !!f.defaultsPending };
      } else {
        // 复制：另起一条私有筛选，名称加「副本」；内置筛选的人工名单不随之复制（members 只属于内置晋升筛选）
        meta = { ...meta, name: f.name ? T.en.copyName(f.name) : '', name_zh: f.name_zh ? T.zh.copyName(f.name_zh) : '' };
        cols = cols.filter((c) => c !== 'member');
      }
    } else if (recordType) {
      def = TF.recordTypeFilter(recordType);
    } else {
      const d = TF.readDraft(safeStorage());
      def = d ? d.definition : TF.emptyFilter();
      if (d) { cols = d.columns; sort = d.sort; }
    }
    setSt({ meta, def, cols, sort, redacted });
    setBaseline(snap(def, cols, sort));
  }, [catalog, srcId, srcQ.data, initKey, routeId, recordType]);

  const setDef = useCallback((fn) => setSt((x) => (x ? { ...x, def: fn(x.def) } : x)), []);
  const dirty = !!st && snap(st.def, st.cols, st.sort) !== baseline;
  useLeaveGuard(canWrite && dirty, s.leaveAsk);
  // 未保存的新筛选存在浏览器里（只对 /filter/new），刷新不丢
  useEffect(() => {
    if (!st || routeId) return;
    TF.writeDraft(safeStorage(), { definition: st.def, columns: st.cols, sort: st.sort });
  }, [st, routeId]);

  // ---- 查询 ----
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(TF.PAGE_SIZE);
  const [res, setRes] = useState(null);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState(null);
  const [errs, setErrs] = useState(() => new Map());
  const [aiPending, setAiPending] = useState(false);
  const cleaned = useMemo(() => (st && catalog ? TF.cleanForRun(st.def, catalog) : null), [st, catalog]);
  const incompleteKeys = useMemo(() => new Set((cleaned ? cleaned.incomplete : []).map(TF.pathKey)), [cleaned]);
  const condKey = cleaned ? JSON.stringify([cleaned.definition, st.cols, st.sort]) : '';
  useEffect(() => { setPage(1); }, [condKey]);
  // CX-102：已保存筛选里有范围外的条件值（已隐藏）且条件未改时，只传 filterId，由服务端按保存的完整条件运行 ——
  // 隐藏后某条件可能被整条略去，按隐藏后的条件跑会得到更宽的名单，与按筛选编号调用的接口不一致。改过条件后按页面条件运行。
  const useSaved = !!(st && st.meta.id && st.redacted > 0 && !dirty);
  const runBody = useMemo(() => (cleaned ? {
    filterId: st.meta.id || undefined, definition: useSaved ? undefined : cleaned.definition, columns: st.cols, sort: st.sort || undefined, page, pageSize, explain: true,
    scope: scoped ? scope : undefined,
  } : null), [cleaned, st, page, pageSize, scoped, scope, useSaved]);
  const runKey = runBody ? JSON.stringify(runBody) : '';
  const seq = useRef(0);
  const lastKey = useRef('');
  const doRun = useCallback(async (body) => {
    if (!body) return;
    const my = ++seq.current;
    lastKey.current = JSON.stringify(body);
    setRunning(true);
    try {
      const r = await api.post('/api/admin/talent-filters/run', body);
      if (my !== seq.current) return;
      setRes(r || null); setErrs(new Map()); setRunErr(null);
    } catch (err) {
      if (my !== seq.current) return;
      if (err && err.status === 400 && err.data && err.data.code === 'filter_invalid') { setErrs(TF.errorsByPath(err.data.errors)); setRes(null); setRunErr(null); }
      else setRunErr(err);
    } finally {
      if (my === seq.current) setRunning(false);
    }
  }, []);
  useEffect(() => {
    if (!runKey || aiPending || runKey === lastKey.current) return undefined;
    const t = setTimeout(() => doRun(JSON.parse(runKey)), 400);
    return () => clearTimeout(t);
  }, [runKey, aiPending, doRun]);
  const runNow = () => { setAiPending(false); if (runBody) doRun(runBody); };

  // ---- 勾选（跨页保留；条件变化时清空） ----
  const [sel, setSel] = useState(() => new Map());   // userId → 姓名
  useEffect(() => { setSel(new Map()); }, [condKey]);
  const pickRows = (rows, on) => setSel((m) => {
    const n = new Map(m);
    for (const r of rows || []) { if (!r) continue; if (on) n.set(r.id, String(TF.cellOf(r, 'name') || r.name || r.id)); else n.delete(r.id); }
    return n;
  });
  const selectAllResults = async () => {
    if (!runBody) return;
    try {
      const r = await api.post('/api/admin/talent-filters/run', { ...runBody, explain: undefined, page: 1, pageSize: TF.IDS_CAP, idsOnly: true });
      const list = Array.isArray(r && r.ids) ? r.ids.map((id) => ({ id })) : Array.isArray(r && r.rows) ? r.rows : [];
      const known = new Map(((res && res.rows) || []).map((x) => [x.id, String(TF.cellOf(x, 'name') || x.name || x.id)]));
      setSel(() => {
        const n = new Map();
        for (const x of list.slice(0, TF.IDS_CAP)) n.set(x.id, x.name ? String(x.name) : known.get(x.id) || String(x.id));
        return n;
      });
      const total = r && Number.isFinite(r.total) ? r.total : res ? res.total : list.length;
      if (total > TF.IDS_CAP) Toast.info(s.capNote(TF.IDS_CAP));
    } catch (err) { Toast.error(errText(err, {})); }
  };

  // ---- 保存 ----
  const [saving, setSaving] = useState(false);
  const [saveDlg, setSaveDlg] = useState(null);     // { mode:'new'|'saveAs'|'props', zh, en, vis }
  const applySaved = (f) => {
    if (!f) return;
    const def = TF.normalizeDef(parseJson(f.definition));
    const cols = arrOr(parseJson(f.columns), st.cols);
    const sort = parseJson(f.sort) || null;
    const meta = { ...st.meta, id: f.id, name: f.name || '', name_zh: f.name_zh || '', builtinKey: f.builtinKey || null, visibility: f.visibility || st.meta.visibility, version: f.version, canEdit: f.canEdit !== false, mine: f.mine !== false, owner: f.owner || st.meta.owner, defaultsPending: !!f.defaultsPending };
    setSt((x) => ({ ...x, meta, def, cols, sort }));
    setBaseline(snap(def, cols, sort));
  };
  const saveErr = (err) => {
    const d = err && err.data;
    if (d && d.code === 'filter_invalid') setErrs(TF.errorsByPath(d.errors));
    Toast.error(errText(err, {
      filter_conflict: () => s.eConflict, filter_invalid: () => s.eInvalid,
      name_taken: () => s.eNameTaken, filter_name_taken: () => s.eNameTaken, duplicate_name: () => s.eNameTaken,
      too_many_filters: () => s.eLimit, filter_limit: () => s.eLimit,
    }));
  };
  const guardIncomplete = () => {
    if (cleaned && cleaned.incomplete.length) { Toast.warning(s.incompleteSave); return false; }
    return true;
  };
  const saveExisting = async (over = {}) => {
    if (!st || !st.meta.id || !guardIncomplete()) return false;
    setSaving(true);
    let ok = false;
    try {
      const body = { definition: cleaned.definition, columns: st.cols, sort: st.sort, version: st.meta.version };
      if (!st.meta.builtinKey) Object.assign(body, { name: st.meta.name, name_zh: st.meta.name_zh, visibility: st.meta.visibility }, over);
      const r = await api.put(`/api/admin/talent-filters/${encodeURIComponent(st.meta.id)}`, body);
      applySaved(r && r.filter);
      Toast.success(s.saved);
      ok = true;
    } catch (err) { saveErr(err); }
    setSaving(false);
    return ok;
  };
  const resetBuiltin = async () => {
    setSaving(true);
    try {
      const r = await api.put(`/api/admin/talent-filters/${encodeURIComponent(st.meta.id)}`, { reset: true, version: st.meta.version });
      applySaved(r && r.filter);
      Toast.success(s.resetDone);
    } catch (err) { saveErr(err); }
    setSaving(false);
  };
  const openSave = (mode) => {
    if (mode !== 'props' && !guardIncomplete()) return;
    // CX-100：另存为默认在原名后加「（副本）/ (copy)」，直接保存不再必报重名（名称上限 60 字，先截原名）
    const copyOf = (n, suf) => (n ? n.slice(0, 60 - suf.length) + suf : '');
    const zh0 = st.meta.name_zh || '', en0 = st.meta.name || '';
    setSaveDlg({ mode, zh: mode === 'saveAs' ? copyOf(zh0, '（副本）') : zh0, en: mode === 'saveAs' ? copyOf(en0, ' (copy)') : en0, vis: mode === 'saveAs' && !st.meta.mine ? 'private' : st.meta.builtinKey ? 'private' : st.meta.visibility || 'private' });
  };
  const submitSave = async () => {
    const zh = saveDlg.zh.trim(); const en = saveDlg.en.trim();
    if (!zh && !en) { Toast.warning(s.needName); return; }
    const names = { name: en || zh, name_zh: zh || en, visibility: saveDlg.vis };
    if (saveDlg.mode === 'props') {
      const ok = await saveExisting(names);
      if (ok) setSaveDlg(null);
      return;
    }
    setSaving(true);
    try {
      const r = await api.post('/api/admin/talent-filters', { ...names, definition: cleaned.definition, columns: st.cols.filter((c) => c !== 'member'), sort: st.sort });
      const f = r && r.filter;
      setSaveDlg(null);
      Toast.success(s.created);
      if (!routeId) TF.writeDraft(safeStorage(), null);
      setBaseline(snap(st.def, st.cols, st.sort));   // 跳转前先清掉「未保存」，免得守卫拦下
      if (f && f.id) navigate(TF.withQuery(`/admin/talent-review/filter/${encodeURIComponent(f.id)}`, scopeQs), { replace: true });
    } catch (err) { saveErr(err); }
    setSaving(false);
  };

  // ---- AI ----
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInfo, setAiInfo] = useState(null);       // { unsupported, choices, demo }
  const [aiUndo, setAiUndo] = useState(null);
  const parseAi = async () => {
    const text = aiText.trim();
    if (!text || !st) return;
    setAiBusy(true);
    try {
      const r = await api.post('/api/admin/talent-filters/ai-parse', { text, lang });
      const nd = TF.normalizeDef((r && (r.definition || r.filter)) || TF.emptyFilter());
      setAiUndo(st.def);
      setDef(() => nd);
      setAiInfo({ unsupported: Array.isArray(r && r.unsupported) ? r.unsupported : [], choices: Array.isArray(r && r.choices) ? r.choices : [], demo: !!(r && r.demo) });
      setAiPending(true);
      setRes(null);
    } catch (err) {
      Toast.error(errText(err, Object.fromEntries(Object.entries(s.aiErr).map(([k, v]) => [k, () => v]))));
    }
    setAiBusy(false);
  };
  const undoAi = () => { if (aiUndo) setDef(() => aiUndo); setAiUndo(null); setAiInfo(null); setAiPending(false); };
  const pickChoice = (c, value) => {
    setDef((d) => TF.applyChoice(d, c.leafId, value));
    setAiInfo((x) => (x ? { ...x, choices: x.choices.filter((y) => y !== c) } : x));
  };

  // ---- 导出 ----
  const [exporting, setExporting] = useState(false);
  const doExport = async () => {
    if (!runBody) return;
    setExporting(true);
    try {
      const { page: _p, pageSize: _s, explain: _e, ...rest } = runBody;
      const text = await api.post('/api/admin/talent-filters/export', { ...rest, lang });
      const nm = st.meta.id ? (lang === 'zh' ? st.meta.name_zh || st.meta.name : st.meta.name || st.meta.name_zh) : '';
      saveCsv(typeof text === 'string' ? text : '', TF.exportFileName(nm));
      Toast.success(s.exported);
    } catch (err) { Toast.error(errText(err, { export_forbidden: () => s.eExport })); }
    setExporting(false);
  };

  // ---- 批量 ----
  const [bulk, setBulk] = useState(null);           // 'succ' | 'promo'
  const [outcome, setOutcome] = useState(null);     // { op, done, skipped, names }
  const selIds = [...sel.keys()];
  const selNames = [...sel.values()];
  const overCap = sel.size > TF.IDS_CAP;
  const finishBulk = (op, resp) => {
    const o = TF.bulkOutcome(resp);
    const names = Object.fromEntries(sel);
    setBulk(null);
    if (!o.skipped.length) Toast.success(s.doneN(o.done));
    else setOutcome({ op, ...o, names });
    setSel(new Map());
    if (runBody) doRun(runBody);
  };

  // ---- 列 ----
  const [colDlg, setColDlg] = useState(null);       // 列草稿

  // ---------------- 渲染 ----------------
  const backTo = () => {
    if (!confirmLeave()) return;
    navigate(TF.withQuery('/admin/talent-review' + (st && st.meta.builtinKey === 'promotion' ? '' : '?tab=filters'), scopeQs));
  };
  // F47：类型标签（内置 / 共享 / 私有）与标题同一行、在标题右侧（app.css .co-page-tline）
  const bar = (title, sub, extra, tag) => (
    <div className="co-page-bar">
      <Button theme="borderless" icon={<IconArrowLeft />} onClick={backTo}>{s.back}</Button>
      <div className="co-page-titles">
        <div className="co-page-tline">
          <h1 className="co-page-title" title={title}>{title}</h1>
          {tag || null}
        </div>
        {sub ? <div className="co-page-sub">{sub}</div> : null}
      </div>
      {extra}
    </div>
  );
  if (catQ.error || srcQ.error) {
    const nf = srcQ.error && srcQ.error.status === 404;
    return (
      <div className="wrap tset-wrap tf-wrap">
        {bar(s.newTitle)}
        <div className="ppl-card">
          {nf ? <Empty description={s.notFound} /> : <Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${(catQ.error || srcQ.error).message}`} />}
        </div>
      </div>
    );
  }
  if (!st || !catalog) return <div className="wrap tset-wrap tf-wrap" style={{ textAlign: 'center', paddingTop: 80 }}><Spin size="large" /></div>;

  const meta = st.meta;
  const isBuiltin = !!meta.builtinKey;
  const editable = canWrite && (!meta.id || meta.canEdit);
  const title = meta.id ? ((lang === 'zh' ? meta.name_zh || meta.name : meta.name || meta.name_zh) || s.newTitle) : s.newTitle;
  const kind = isBuiltin ? s.kindBuiltin : meta.visibility === 'shared' ? s.kindShared : s.kindPrivate;
  const deptLabel = (id) => {
    const o = tree && Array.isArray(tree.options) ? tree.options.find((x) => String(x.id) === String(id)) : null;
    if (o) return o.name || o.path || String(id);
    return String(id).startsWith('name:') ? String(id).slice(5) : String(id);
  };
  const summary = TF.summarize(st.def, catalog, lang, { deptLabel });
  const notices = res ? TF.leafNotices(st.def, [...(res.skipped || []), ...(res.warnings || [])]) : [];
  const fieldGroups = TF.groupedFields(catalog, lang);
  const colMeta = (id) => (Array.isArray(catalog.columns) ? catalog.columns.find((c) => c && c.id === id) : null);
  const colTitle = (id) => TF.nameOf(colMeta(id), lang) || id;

  const actions = (
    <div className="tf-page-acts">
      {canWrite && dirty && <span className="pill warn">{s.unsaved}</span>}
      {canWrite && isBuiltin && meta.canEdit && (
        <Popconfirm title={s.resetAsk} content={s.resetDesc} okText={s.reset} cancelText={s.cancel} onConfirm={resetBuiltin}>
          <Button disabled={saving}>{s.reset}</Button>
        </Popconfirm>
      )}
      {canWrite && meta.id && meta.canEdit && !isBuiltin && <Button disabled={saving} onClick={() => openSave('props')}>{s.props}</Button>}
      {canWrite && !isBuiltin && (meta.id || st.def.items.length > 0) && <Button disabled={saving} onClick={() => openSave('saveAs')}>{s.saveAs}</Button>}
      {editable && (
        <Button theme="solid" type="primary" loading={saving} disabled={!!meta.id && !dirty}
          onClick={() => (meta.id ? saveExisting() : openSave('new'))}>{s.save}</Button>
      )}
    </div>
  );

  // 结果表的列
  const sortOf = (cid) => (st.sort && st.sort.col === cid ? (st.sort.dir === 'asc' ? 'ascend' : 'descend') : false);
  // 姓名列在第一列时固定在左侧（用户把它移到中间时不固定，避免固定列夹在滚动列之间）
  const tableCols = st.cols.map((cid, ci) => ({
    title: colTitle(cid), dataIndex: cid, width: COL_W[cid] || COL_W_DEFAULT, sorter: cid !== 'member', sortOrder: sortOf(cid),
    ...(cid === 'name' && ci === 0 ? { fixed: 'left' } : null),
    render: (_, r) => {
      if (cid === 'name') {
        const nm = String(TF.cellOf(r, 'name') || r.name || '');
        return (
          <span className="tf-namecell">
            {canProfile
              ? <span className="emp-namelink emp-ellip" title={nm} style={{ cursor: 'pointer' }} onClick={() => { if (confirmLeave()) navigate(`/admin/people/${r.id}`); }}>{nm}</span>
              : <span className="emp-ellip" title={nm}>{nm}</span>}
            {r.member === 'include' && <Tag size="small" color="blue" type="light" shape="circle">{s.memberInclude}</Tag>}
            {r.member === 'exclude' && <Tag size="small" color="grey" type="light" shape="circle">{s.memberExclude}</Tag>}
            {r.active === false && <Tag size="small" color="grey" type="light" shape="circle">{s.inactive}</Tag>}
          </span>
        );
      }
      if (cid === 'member') return r.member === 'include' ? s.memberInclude : r.member === 'exclude' ? s.memberExclude : '—';
      const txt = TF.displayCell(cid, TF.cellOf(r, cid), catalog, lang);
      return <span className="emp-ellip" title={txt}>{txt}</span>;
    },
  }));
  if (st.def.items.length) {
    tableCols.push({
      title: s.colHits, dataIndex: '__hits', width: hitsWidth(st.def.items.length), fixed: 'right', className: 'tf-hitcol',
      render: (_, r) => (
        <span className="tf-hits" title={s.hitsTip}>
          {TF.topHits(st.def, r).map((h, i) => (
            <span key={i} className={'tf-hit ' + (h === true ? 'is-ok' : h === false ? 'is-no' : 'is-na')}>{i + 1}{h === true ? '✓' : h === false ? '✗' : '–'}</span>
          ))}
        </span>
      ),
    });
  }
  const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
  const total = res && Number.isFinite(res.total) ? res.total : rows.length;
  const unmapped = res && Array.isArray(res.unmapped) ? res.unmapped : [];

  return (
    <div className="wrap tset-wrap tf-wrap">
      {bar(title, meta.owner && !meta.mine && meta.owner.name ? (
        <span className="tf-sub">{s.ownerOf(meta.owner.name)}</span>
      ) : null, actions, (
        <Tag size="small" color={isBuiltin ? 'violet' : meta.visibility === 'shared' ? 'blue' : 'grey'} type="light" shape="circle">{kind}</Tag>
      ))}
      {!canWrite && <div className="tset-foot">{s.roNote}</div>}
      {/* CX-016（2026-10-09 验收）：共享筛选对非创建人一打开就说明「不可修改、可另存为」（原来只在另存为弹窗里才出现） */}
      {canWrite && meta.id && !isBuiltin && !meta.canEdit && (
        <Banner type="info" closeIcon={null} className="tf-shared-ro" description={s.sharedReadOnly(meta.owner && meta.owner.name)} style={{ marginBottom: 12 }} />
      )}
      {scoped && (
        <div className="u-hint tf-scope-hint">
          <b>{s.scopeOn}</b> · {s.scopeLead}
          <Button size="small" theme="borderless" onClick={dropScope}>{s.scopeOff}</Button>
        </div>
      )}
      {st.redacted > 0 && <Banner type="warning" closeIcon={null} className="tf-banner" description={s.redacted(st.redacted)} />}

      {/* ① AI 一句话转条件 */}
      {aiVisible && (
        <div className="ppl-card tf-ai">
          <div className="ppl-sec-h"><div><h2>{s.aiTitle}</h2><div className="tset-lead">{s.aiLead}</div></div></div>
          <TextArea value={aiText} onChange={setAiText} maxCount={TF.AI_TEXT_MAX} maxLength={TF.AI_TEXT_MAX} autosize={{ minRows: 2, maxRows: 5 }}
            placeholder={s.aiPh} disabled={!aiReady || aiBusy} />
          <div className="tf-ai-acts">
            <Button theme="solid" type="primary" loading={aiBusy} disabled={!aiReady || !aiText.trim()} onClick={parseAi}>{s.aiRun}</Button>
            {aiUndo && <Button theme="borderless" onClick={undoAi}>{s.aiUndo}</Button>}
            {!aiReady && <Text type="tertiary" size="small">{aiState === 'budget_exhausted' ? s.aiOffBudget : s.aiOffConf}</Text>}
          </div>
          {aiInfo && (
            <div className="tf-ai-out">
              {aiPending && <Banner type="info" closeIcon={null} description={s.aiNotice} />}
              {(aiInfo.demo || aiState === 'demo') && <div className="u-hint">{s.aiDemo}</div>}
              {aiInfo.unsupported.length > 0 && (
                <div className="tf-ai-uns">
                  <div className="u-hint">{s.aiUnsupported}</div>
                  <ul>{aiInfo.unsupported.map((u, i) => <li key={i}>{String(u)}</li>)}</ul>
                </div>
              )}
              {aiInfo.choices.map((c, i) => (
                <div className="tf-ai-choice" key={i}>
                  <span className="u-hint">{s.aiChoice(String(c.text || ''))}</span>
                  <Select size="small" className="u-w-lg" placeholder={s.pickValue} onChange={(v) => pickChoice(c, v)}
                    optionList={(Array.isArray(c.options) ? c.options : []).map((o) => ({ value: o.id !== undefined ? o.id : o.value, label: String(o.label || o.id || o.value) }))} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ② 条件编辑器 */}
      <div className="ppl-card tf-editor">
        <div className="ppl-sec-h">
          <div><h2>{s.secCond}</h2><div className="tset-lead">{s.condLead}</div></div>
        </div>
        {/* F62：迁移 92 没有改写被 HR 改过的内置筛选 → 提示可恢复默认（按钮在页头 actions） */}
        {isBuiltin && meta.defaultsPending && <div className="u-hint tf-defaults-pending" style={{ marginBottom: 8 }}>{s.defaultsPending}</div>}
        <div className="tf-summary">{summary}</div>
        <ConditionEditor s={s} lang={lang} def={st.def} catalog={catalog} setDef={setDef} errs={errs} incompleteKeys={incompleteKeys}
          fieldGroups={fieldGroups} tree={tree} ranks={ranks} cfg={cfgQ.data} />
        <div className="tf-run">
          <Button theme="solid" type={aiPending ? 'primary' : 'tertiary'} icon={<IconRefresh />} loading={running} onClick={runNow}>{s.run}</Button>
          <Text type="tertiary" size="small">{s.maxNote}</Text>
        </div>
      </div>

      {notices.length > 0 && (
        <Banner type="warning" closeIcon={null} className="tf-banner" description={(
          <div>
            <div>{s.warnTitle}</div>
            <ul className="tf-notes">
              {notices.map((n, i) => {
                const w = s.warn[n.code];
                return <li key={i}>{w ? w(n.label || '—', n.count || 0) : s.warnOther(n.label || '—', s.e[n.code] || n.code)}</li>;
              })}
            </ul>
          </div>
        )} />
      )}
      {errs.size > 0 && <Banner type="danger" closeIcon={null} className="tf-banner" description={s.eInvalid} />}
      {runErr && <Banner type="danger" closeIcon={null} className="tf-banner" description={`${s.loadFail} · ${runErr.message}`} />}

      {/* ③④ 结果 */}
      <div className="ppl-card tf-results">
        <div className="tf-resbar">
          <span className="tf-count tnum">{running ? s.running : res ? s.total(total) : ''}</span>
          <Button size="small" onClick={() => setColDlg(st.cols.slice())}>{s.columns}</Button>
          {canExport && <Button size="small" loading={exporting} disabled={!res} onClick={doExport}>{s.exportCsv}</Button>}
          {canWrite && res && total > 0 && <Button size="small" theme="borderless" onClick={selectAllResults}>{s.selectAll}</Button>}
          <Button size="small" theme="borderless" icon={<IconRefresh />} aria-label={s.refresh} title={s.refresh} onClick={() => runBody && doRun(runBody)} />
        </div>
        {!st.def.items.length && <div className="u-hint" style={{ marginBottom: 8 }}>{s.noCond}</div>}
        {canWrite && (
          <BulkBar count={sel.size} pageOnly={false} onClear={() => setSel(new Map())} selectPage={() => pickRows(rows, true)}>
            <Button size="small" disabled={overCap} onClick={() => setBulk('succ')}>{s.bulkSucc}</Button>
            {!(isBuiltin && meta.builtinKey === 'promotion') && <Button size="small" disabled={overCap || !promoId} onClick={() => setBulk('promo')}>{s.bulkPromo}</Button>}
          </BulkBar>
        )}
        {overCap && <div className="u-hint">{s.overCap(TF.IDS_CAP)}</div>}
        <Table rowKey="id" size="small" dataSource={rows} loading={running && !!res}
          empty={<Empty description={res ? s.noResults : ''} style={{ padding: 20 }} />}
          rowSelection={canWrite ? {
            fixed: 'left',
            selectedRowKeys: selIds,
            onSelect: (r, on) => pickRows([r], on),
            onSelectAll: (on, _all, changed) => pickRows(changed && changed.length ? changed : rows, on),
          } : undefined}
          pagination={res && total > 0 ? {
            currentPage: page, pageSize, total, pageSizeOpts: TF.PAGE_SIZES, showSizeChanger: true, formatPageText: false,
            onPageChange: setPage, onPageSizeChange: (n) => { setPageSize(n); setPage(1); },
          } : false}
          onChange={({ sorter, extra }) => {
            if (extra && extra.changeType && extra.changeType !== 'sorter') return;
            if (!sorter || !sorter.dataIndex) return;
            const dir = sorter.sortOrder === 'ascend' ? 'asc' : sorter.sortOrder === 'descend' ? 'desc' : null;
            setSt((x) => ({ ...x, sort: dir ? { col: sorter.dataIndex, dir } : null }));
          }}
          {...resizableTable(tableCols, { extra: canWrite ? BULK_SEL_EXTRA : 0 })} />
        {unmapped.length > 0 && (
          <div className="trev-summary">
            <div className="trev-summary-txt">
              <b>{s.unmappedTitle}</b>
              <span className="trev-sum-n tnum">{unmapped.length}</span>
              <Text type="tertiary" size="small">{s.unmappedLead(unmapped.length)}</Text>
            </div>
          </div>
        )}
      </div>

      {/* ⑤ 保存 / 另存为 / 名称与共享 */}
      <Modal visible={!!saveDlg} width={460} maskClosable={false} confirmLoading={saving}
        title={saveDlg ? (saveDlg.mode === 'saveAs' ? s.saveAsTitle : saveDlg.mode === 'props' ? s.propsTitle : s.saveTitle) : ''}
        okText={s.save} cancelText={s.cancel} onOk={submitSave} onCancel={() => setSaveDlg(null)}>
        {saveDlg && (
          <>
            <div className="ppl-flabel">{s.nameZh}</div>
            <Input value={saveDlg.zh} maxLength={80} autoFocus onChange={(v) => setSaveDlg((d) => ({ ...d, zh: v }))} />
            <div className="ppl-flabel">{s.nameEn}</div>
            <Input value={saveDlg.en} maxLength={80} onChange={(v) => setSaveDlg((d) => ({ ...d, en: v }))} />
            <div className="ppl-flabel">{s.visibility}</div>
            <RadioGroup value={saveDlg.vis} onChange={(e) => setSaveDlg((d) => ({ ...d, vis: e.target.value }))} direction="vertical">
              <Radio value="private">{s.visPrivate}</Radio>
              <Radio value="shared">{s.visShared}</Radio>
            </RadioGroup>
            {saveDlg.vis === 'shared' && <div className="u-hint">{s.visSharedHint}</div>}
          </>
        )}
      </Modal>

      {colDlg && (
        <ColumnsModal s={s} lang={lang} cols={colDlg} catalog={catalog} allowMember={isBuiltin}
          onOk={(next) => { setSt((x) => ({ ...x, cols: next })); setColDlg(null); }} onCancel={() => setColDlg(null)} />
      )}

      {bulk === 'succ' && (
        <SuccessionBulkModal s={s} ids={selIds} names={selNames} catalog={catalog} sourceFilterId={meta.id || undefined} scope={scoped ? scope : undefined}
          onDone={(resp) => finishBulk(s.bulkSucc, resp)} onCancel={() => setBulk(null)} lang={lang} />
      )}
      {bulk === 'promo' && (
        <PromoIncludeModal s={s} ids={selIds} names={selNames} promoId={promoId} scope={scoped ? scope : undefined}
          onDone={(resp) => finishBulk(s.bulkPromo, resp)} onCancel={() => setBulk(null)} lang={lang} />
      )}
      <Modal visible={!!outcome} width={520} title={outcome ? s.resultTitle(outcome.op) : ''} onCancel={() => setOutcome(null)}
        footer={<Button onClick={() => setOutcome(null)}>{s.close}</Button>}>
        {outcome && (
          <div className="bulk-result">
            <div className="bulk-result-sum">{s.resultSum(outcome.done, outcome.skipped.length)}</div>
            <ul className="bulk-result-list">
              {outcome.skipped.map((x, i) => (
                <li key={i}>
                  <span className="bulk-result-name">{outcome.names[x.id] || x.employeeId || x.id}</span>
                  <span className="bulk-result-why">{s.why[x.code] || x.code}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------- 条件编辑器 ---------------- */
function ConditionEditor({ s, lang, def, catalog, setDef, errs, incompleteKeys, fieldGroups, tree, ranks, cfg }) {
  const leaves = TF.countLeaves(def);
  const full = leaves >= TF.MAX_LEAVES;
  const rowProps = { s, lang, catalog, setDef, errs, incompleteKeys, fieldGroups, tree, ranks, cfg };
  return (
    <div className="tf-cond-tree">
      <div className="tf-logic">
        <RadioGroup type="button" buttonSize="small" value={def.logic} onChange={(e) => setDef((d) => TF.setLogic(d, [], e.target.value))}>
          <Radio value="and">{s.logicAll}</Radio>
          <Radio value="or">{s.logicAny}</Radio>
        </RadioGroup>
      </div>
      {def.items.map((it, i) => (Array.isArray(it.items) && !('field' in it) ? (
        <div className="tf-group" key={'g' + i}>
          <div className="tf-group-h">
            <span className="tf-group-t">{s.groupTitle(i + 1)}</span>
            <RadioGroup type="button" buttonSize="small" value={it.logic} onChange={(e) => setDef((d) => TF.setLogic(d, [i], e.target.value))}>
              <Radio value="and">{s.logicAll}</Radio>
              <Radio value="or">{s.logicAny}</Radio>
            </RadioGroup>
            <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} className="tf-group-del" aria-label={s.removeGroup} title={s.removeGroup}
              onClick={() => setDef((d) => TF.removeAt(d, [i]))} />
          </div>
          {it.items.map((leaf, j) => <CondRow key={leaf.id || j} {...rowProps} leaf={leaf} path={[i, j]} />)}
          <Button size="small" theme="borderless" icon={<IconPlus />} disabled={full || it.items.length >= TF.MAX_GROUP_ITEMS}
            onClick={() => setDef((d) => TF.addCondition(d, i))}>{s.addCond}</Button>
        </div>
      ) : <CondRow key={it.id || i} {...rowProps} leaf={it} path={[i]} />))}
      <div className="tf-cond-add">
        <Button size="small" icon={<IconPlus />} disabled={full || def.items.length >= TF.MAX_ROOT_ITEMS} onClick={() => setDef((d) => TF.addCondition(d))}>{s.addCond}</Button>
        <Button size="small" theme="borderless" icon={<IconPlus />} disabled={full || def.items.length >= TF.MAX_ROOT_ITEMS} onClick={() => setDef((d) => TF.addGroup(d))}>{s.addGroup}</Button>
        <Checkbox checked={!!def.includeExited} onChange={(e) => setDef((d) => ({ ...d, includeExited: !!e.target.checked }))}>{s.includeExited}</Checkbox>
      </div>
    </div>
  );
}

function CondRow({ s, lang, catalog, setDef, errs, incompleteKeys, fieldGroups, tree, ranks, cfg, leaf, path }) {
  const f = TF.fieldOf(catalog, leaf.field);
  const ctrl = TF.valueControl(f, leaf.op);
  const key = TF.pathKey(path);
  const codes = errs.get(key) || [];
  const incomplete = incompleteKeys.has(key);
  const setValue = (v) => setDef((d) => TF.setLeafValue(d, path, v));
  const setParams = (p) => setDef((d) => TF.setLeafParams(d, path, p));
  return (
    <div className={'tf-cond' + (codes.length ? ' tf-cond-err' : '')}>
      <span className="tf-cond-n tnum">{TF.pathLabel(path)}</span>
      <div className="tf-cond-main">
        <Select className="tf-cond-field" filter size="small" placeholder={s.pickField} value={leaf.field || undefined} dropdownMatchSelectWidth={false}
          onChange={(v) => setDef((d) => TF.setLeafField(d, path, v, catalog))}>
          {fieldGroups.map((g) => (
            <Select.OptGroup label={g.label} key={g.label}>
              {g.fields.map((o) => (
                <Select.Option key={o.value} value={o.value} label={o.label} disabled={o.disabled}>{o.label}{o.disabled ? ` · ${s.modOff}` : ''}</Select.Option>
              ))}
            </Select.OptGroup>
          ))}
        </Select>
        {f && (
          <Select className="tf-cond-op" size="small" value={leaf.op || undefined} placeholder={s.pickOp} dropdownMatchSelectWidth={false}
            onChange={(v) => setDef((d) => TF.setLeafOp(d, path, v, catalog))}
            optionList={(f.ops || []).map((o) => ({ value: o.op, label: TF.nameOf(o, lang) || o.op }))} />
        )}
        {f && <ValueInput s={s} lang={lang} field={f} ctrl={ctrl} value={leaf.value} onChange={setValue} tree={tree} ranks={ranks} />}
        {f && <ParamsInput s={s} lang={lang} field={f} leaf={leaf} onChange={setParams} cfg={cfg} />}
        {!f && leaf.field && <Text type="warning" size="small">{leaf.field}</Text>}
      </div>
      <Button className="tf-cond-del" size="small" theme="borderless" type="danger" icon={<IconDelete />} aria-label={s.removeCond} title={s.removeCond}
        onClick={() => setDef((d) => TF.removeAt(d, path))} />
      {codes.length > 0 && <div className="tf-cond-msg">{codes.map((c) => s.e[c] || c).join('；')}</div>}
      {!codes.length && !f && leaf.field && <div className="tf-cond-msg">{TF.isRetiredField(leaf.field) ? s.e.field_retired : s.e.field_removed}</div>}
      {!codes.length && f && incomplete && <div className="tf-cond-hint">{s.incomplete}</div>}
    </div>
  );
}

function ValueInput({ s, lang, field, ctrl, value, onChange, tree, ranks }) {
  const opts = (Array.isArray(field.options) ? field.options : []).map((o) => ({ value: o.value, label: TF.nameOf(o, lang) || String(o.value) }));
  const range = value && typeof value === 'object' && !Array.isArray(value) ? value : { from: null, to: null };
  const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  switch (ctrl.kind) {
    case 'none': return null;
    case 'dept':
      // R179：条件值为空（含范围外取值被隐藏后）时写「请选择部门」，不写「全部部门」（空条件不匹配任何人）
      return (
        <DeptFilter options={tree ? tree.options : []} multiple={ctrl.multiple} lang={lang} size="small"
          value={ctrl.multiple ? (Array.isArray(value) ? value : []) : (value || null)}
          onChange={(v) => onChange(ctrl.multiple ? (Array.isArray(v) ? v : v ? [v] : []) : (v || ''))}
          showNone={!!(tree && tree.hasNone)} disabled={tree === null} ready={!!tree} className="tf-cond-val"
          placeholder={lang === 'zh' ? '请选择部门' : 'Choose departments'} />
      );
    case 'multi':
      return (
        <Select className="tf-cond-val" size="small" multiple filter maxTagCount={3} allowCreate={!!ctrl.allowCreate} showClear
          placeholder={s.pickValue} value={Array.isArray(value) ? value : []} onChange={(v) => onChange(Array.isArray(v) ? v : [])} optionList={opts} />
      );
    case 'single':
      return <Select className="tf-cond-val" size="small" filter placeholder={s.pickValue} value={value || undefined} onChange={(v) => onChange(v || '')} optionList={opts} />;
    case 'levelRange': {
      const list = range.from && range.to ? ranksInRange(ranks, range.from, range.to) : [];
      return (
        <span className="tf-range">
          <Select size="small" filter placeholder={s.from} value={range.from || undefined} onChange={(v) => onChange({ ...range, from: v || null })} optionList={opts} className="tf-range-sel" />
          <span className="tf-range-sep">–</span>
          <Select size="small" filter placeholder={s.to} value={range.to || undefined} onChange={(v) => onChange({ ...range, to: v || null })} optionList={opts} className="tf-range-sel" />
          {list.length > 0 && <Text type="tertiary" size="small" className="tf-range-note">{s.rangeIs(list.join(lang === 'zh' ? '、' : ', '))}</Text>}
        </span>
      );
    }
    case 'numberRange':
      return (
        <span className="tf-range">
          <InputNumber size="small" min={ctrl.min} max={ctrl.max} value={range.from} placeholder={s.from} onChange={(v) => onChange({ ...range, from: num(v) })} className="tf-num" />
          <span className="tf-range-sep">–</span>
          <InputNumber size="small" min={ctrl.min} max={ctrl.max} value={range.to} placeholder={s.to} onChange={(v) => onChange({ ...range, to: num(v) })} className="tf-num" />
          {field.valueKind === 'months' && <Text type="tertiary" size="small">{s.months}</Text>}
        </span>
      );
    case 'dateRange':
      return (
        <span className="tf-range">
          <Input size="small" type="date" value={range.from || ''} onChange={(v) => onChange({ ...range, from: v || null })} className="tf-date" aria-label={s.from} />
          <span className="tf-range-sep">–</span>
          <Input size="small" type="date" value={range.to || ''} onChange={(v) => onChange({ ...range, to: v || null })} className="tf-date" aria-label={s.to} />
        </span>
      );
    case 'number':
      return (
        <InputNumber size="small" className="tf-num" min={ctrl.min} max={ctrl.max} value={value === null || value === undefined ? undefined : value}
          onChange={(v) => onChange(num(v))}
          suffix={field.valueKind === 'percent' ? s.percent : field.valueKind === 'months' ? s.months : field.valueKind === 'count' ? s.times : undefined} />
      );
    case 'date':
      return <Input size="small" type="date" className="tf-date" value={value || ''} onChange={(v) => onChange(v || '')} />;
    default:
      return <Input size="small" className="tf-cond-val" maxLength={ctrl.maxLength || 100} value={value || ''} onChange={(v) => onChange(v)} />;
  }
}

// 各字段的附加设置（设计 2.2 的 params）
function ParamsInput({ s, lang, field, leaf, onChange, cfg }) {
  const p = leaf.params || {};
  const po = field.paramOptions || {};
  const optList = (list) => (Array.isArray(list) ? list : []).map((o) => (typeof o === 'object' && o
    ? { value: o.value, label: TF.nameOf(o, lang) || String(o.value) } : { value: o, label: String(o) }));
  const months = (
    <label className="tf-param">
      <span>{s.pWithin}</span>
      <InputNumber size="small" className="tf-num" min={0} max={120} value={Number(p.months) || 0} onChange={(v) => onChange({ months: Math.max(0, Math.round(Number(v) || 0)) })} suffix={s.months} />
      <Text type="tertiary" size="small">{s.monthsAny}</Text>
    </label>
  );
  switch (field.id) {
    case 'perfRecent': {
      if (leaf.op === 'noRecord') return null;
      const n = Math.max(1, Number(p.n) || 1);
      // F62：时间窗模式（withinMonths > 0）看窗内全部评级，不再按期数
      const win = Math.max(0, Number(p.withinMonths) || 0);
      return (
        <div className="tf-params">
          <label className="tf-param">
            <span>{s.pWindow}</span>
            <Select size="small" value={win > 0 ? 'months' : 'periods'} onChange={(v) => onChange({ withinMonths: v === 'months' ? 12 : 0 })} dropdownMatchSelectWidth={false}
              optionList={[{ value: 'periods', label: s.pWindowOff }, { value: 'months', label: s.pWindowOn }]} />
          </label>
          {win > 0 && (
            <label className="tf-param">
              <span>{s.pN}</span>
              <InputNumber size="small" className="tf-num" min={1} max={120} value={win} onChange={(v) => onChange({ withinMonths: Math.min(120, Math.max(1, Math.round(Number(v) || 1))) })} />
              <span>{s.pWindowMonths}</span>
            </label>
          )}
          {win === 0 && (
            <label className="tf-param">
              <span>{s.pN}</span>
              <InputNumber size="small" className="tf-num" min={1} max={8} value={n} onChange={(v) => onChange({ n: Math.min(8, Math.max(1, Math.round(Number(v) || 1))) })} />
              <span>{s.pPeriods}</span>
            </label>
          )}
          {(n > 1 || win > 0) && (
            <label className="tf-param">
              <span>{s.pMode}</span>
              <Select size="small" value={p.mode || 'all'} onChange={(v) => onChange({ mode: v })} dropdownMatchSelectWidth={false}
                optionList={[{ value: 'all', label: s.modeAll }, { value: 'any', label: s.modeAny }, { value: 'atLeastK', label: s.modeK }]} />
              {p.mode === 'atLeastK' && (
                <>
                  <span>{s.pK}</span>
                  <InputNumber size="small" className="tf-num" min={1} max={n} value={Number(p.k) || 1} onChange={(v) => onChange({ k: Math.min(n, Math.max(1, Math.round(Number(v) || 1))) })} />
                </>
              )}
            </label>
          )}
          <label className="tf-param">
            <span>{s.pPeriod}</span>
            <Select size="small" value={p.periodKind || 'any'} onChange={(v) => onChange({ periodKind: v })} dropdownMatchSelectWidth={false}
              optionList={[{ value: 'any', label: s.periodAny }, { value: 'quarter', label: s.periodQ }, { value: 'half', label: s.periodH }, { value: 'annual', label: s.periodA }]} />
          </label>
          {(n > 1 || win > 0) && (
            <label className="tf-param">
              <span>{win > 0 ? s.pMissingWin : s.pMissing}</span>
              <Select size="small" value={p.missing || 'fail'} onChange={(v) => onChange({ missing: v })} dropdownMatchSelectWidth={false}
                optionList={[{ value: 'fail', label: s.missFail }, { value: 'ignore', label: win > 0 ? s.missWinIgnore : s.missIgnore }]} />
            </label>
          )}
        </div>
      );
    }
    case 'potential':
      return (
        <div className="tf-params">
          <Checkbox checked={!!p.freshOnly} onChange={(e) => onChange({ freshOnly: !!e.target.checked })}>{s.pFresh}</Checkbox>
        </div>
      );
    case 'trainingCompletion':
      return (
        <div className="tf-params">
          <label className="tf-param">
            <span>{s.pScope}</span>
            <Select size="small" value={p.scope || 'mandatory'} onChange={(v) => onChange({ scope: v })} dropdownMatchSelectWidth={false}
              optionList={[{ value: 'mandatory', label: s.scopeMand }, { value: 'all', label: s.scopeAll }]} />
          </label>
        </div>
      );
    case 'award':
      return (
        <div className="tf-params">
          {months}
          {Array.isArray(po.names) && po.names.length > 0 && (
            <label className="tf-param tf-param-wide">
              <span>{s.pAwardNames}</span>
              <Select size="small" multiple filter maxTagCount={2} showClear value={Array.isArray(p.names) ? p.names : []}
                onChange={(v) => onChange({ names: Array.isArray(v) && v.length ? v : undefined })} optionList={optList(po.names)} className="tf-cond-val" />
            </label>
          )}
        </div>
      );
    case 'violation':
      return (
        <div className="tf-params">
          {months}
          <label className="tf-param tf-param-wide">
            <span>{s.pSeverity}</span>
            <Select size="small" multiple showClear value={Array.isArray(p.severity) ? p.severity : []} onChange={(v) => onChange({ severity: Array.isArray(v) ? v : [] })}
              optionList={Array.isArray(po.severity) && po.severity.length ? optList(po.severity) : [{ value: 'Major', label: s.sevMajor }, { value: 'Minor', label: s.sevMinor }]}
              className="tf-cond-val" />
          </label>
        </div>
      );
    case 'record': {
      const types = recordTypesOf(field, cfg);
      const ty = types.find((t) => t.key === p.type) || null;
      const fv = p.fields && typeof p.fields === 'object' ? p.fields : {};
      return (
        <div className="tf-params">
          <label className="tf-param">
            <span>{s.pRecType}</span>
            <Select size="small" filter value={p.type || undefined} placeholder={s.pRecType} dropdownMatchSelectWidth={false}
              onChange={(v) => onChange({ type: v || '', fields: {} })}
              optionList={types.map((t) => ({ value: t.key, label: TF.nameOf(t, lang) || t.key }))} />
          </label>
          {months}
          {ty && (Array.isArray(ty.fields) ? ty.fields : []).map((rf) => (
            <label className="tf-param" key={rf.key}>
              <span>{s.pRecField(TF.nameOf(rf, lang) || rf.key)}</span>
              <Select size="small" filter showClear value={fv[rf.key] || undefined} dropdownMatchSelectWidth={false}
                onChange={(v) => { const next = { ...fv }; if (v) next[rf.key] = v; else delete next[rf.key]; onChange({ fields: next }); }}
                optionList={optList(rf.options)} />
            </label>
          ))}
        </div>
      );
    }
    case 'succession':
      return (
        <div className="tf-params">
          <label className="tf-param tf-param-wide">
            <span>{s.pPosition}</span>
            <Select size="small" filter allowCreate showClear value={p.position || undefined} dropdownMatchSelectWidth={false}
              onChange={(v) => onChange({ position: v || undefined })} optionList={optList(po.positions)} className="tf-cond-val" />
          </label>
        </div>
      );
    default:
      return null;
  }
}

/* ---------------- 列（勾选 + 上移下移，不用拖拽） ---------------- */
function ColumnsModal({ s, lang, cols, catalog, allowMember, onOk, onCancel }) {
  const [draft, setDraft] = useState(cols);
  const all = (Array.isArray(catalog.columns) ? catalog.columns : []).filter((c) => c && c.available !== false && (allowMember || c.id !== 'member'));
  const label = (id) => TF.nameOf(all.find((c) => c.id === id), lang) || id;
  const hidden = all.filter((c) => !draft.includes(c.id));
  return (
    <Modal visible width={480} title={s.columnsTitle} okText={s.apply} cancelText={s.cancel} onOk={() => onOk(draft)} onCancel={onCancel}
      bodyStyle={{ maxHeight: '60vh', overflowY: 'auto' }}>
      <div className="ppl-flabel">{s.colShown}</div>
      <ul className="tf-colslist">
        {draft.map((id, i) => (
          <li key={id}>
            <Checkbox checked disabled={TF.LOCKED_COLUMNS.includes(id)} onChange={() => setDraft((d) => TF.toggleColumn(d, id))}>{label(id)}</Checkbox>
            <span className="tf-colsbtns">
              <Button size="small" theme="borderless" icon={<IconArrowUp />} disabled={i === 0} aria-label={s.moveUp} title={s.moveUp} onClick={() => setDraft((d) => TF.moveColumn(d, id, -1))} />
              <Button size="small" theme="borderless" icon={<IconArrowDown />} disabled={i === draft.length - 1} aria-label={s.moveDown} title={s.moveDown} onClick={() => setDraft((d) => TF.moveColumn(d, id, 1))} />
            </span>
          </li>
        ))}
      </ul>
      {hidden.length > 0 && (
        <>
          <div className="ppl-flabel">{s.colHidden}</div>
          <ul className="tf-colslist">
            {hidden.map((c) => (
              <li key={c.id}><Checkbox checked={false} onChange={() => setDraft((d) => TF.toggleColumn(d, c.id))}>{TF.nameOf(c, lang) || c.id}</Checkbox></li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

/* ---------------- 加入继任名单（7.1） ---------------- */
function SuccessionBulkModal({ s, lang, ids, names, catalog, sourceFilterId, scope, onDone, onCancel }) {
  const succQ = useAsync(() => api.get('/api/admin/succession').catch(() => []), []);
  const [pos, setPos] = useState('');
  const [ready, setReady] = useState('oneYear');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const list = Array.isArray(succQ.data) ? succQ.data : [];
  const positions = useMemo(() => {
    const posField = TF.fieldOf(catalog, 'position');
    const succField = TF.fieldOf(catalog, 'succession');
    const from = [
      ...list.map((r) => r.positionName),
      ...((posField && Array.isArray(posField.options)) ? posField.options.map((o) => (o && typeof o === 'object' ? o.value : o)) : []),
      ...((succField && succField.paramOptions && Array.isArray(succField.paramOptions.positions)) ? succField.paramOptions.positions.map((o) => (o && typeof o === 'object' ? o.value : o)) : []),
    ].filter(Boolean).map(String);
    const seen = new Map();
    for (const p of from) { const k = TF.positionKey(p); if (k && !seen.has(k)) seen.set(k, p); }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [list, catalog]);
  const idSet = new Set(ids.map(String));
  const already = pos ? list.filter((r) => TF.positionKey(r.positionName) === TF.positionKey(pos) && idSet.has(String(r.userId))).length : 0;
  const submit = async () => {
    if (!pos.trim()) return;
    setBusy(true);
    try {
      const r = await api.post('/api/admin/succession/bulk', { positionName: pos.trim(), userIds: ids, readiness: ready, note: note.trim(), sourceFilterId, scope });
      onDone(r);
    } catch (err) { Toast.error({ content: bulkErrorText(err, lang), duration: 6 }); }
    setBusy(false);
  };
  return (
    <BulkConfirmModal visible op={s.bulkSucc} names={names} okDisabled={!pos.trim()} loading={busy} onOk={submit} onCancel={onCancel}>
      <div className="ppl-flabel">{s.scPos}</div>
      <Select filter allowCreate showClear placeholder={s.scPosPh} value={pos || undefined} onChange={(v) => setPos(v || '')} style={{ width: '100%' }}
        optionList={positions.map((p) => ({ value: p, label: p }))} />
      <div className="ppl-flabel">{s.scReady}</div>
      <Select value={ready} onChange={setReady} style={{ minWidth: 200 }} dropdownMatchSelectWidth={false}
        optionList={READINESS.map((k) => ({ value: k, label: s[k] }))} />
      <div className="ppl-flabel">{s.scNote}</div>
      <Input value={note} maxLength={TF.NOTE_MAX} onChange={setNote} />
      {pos.trim() && <div className="u-hint">{s.succSkipHint(already)}</div>}
    </BulkConfirmModal>
  );
}

/* ---------------- 加入晋升候选（7.2） ---------------- */
function PromoIncludeModal({ s, lang, ids, names, promoId, scope, onDone, onCancel }) {
  const candQ = useAsync(() => api.get('/api/admin/promotion-candidates').catch(() => null), []);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => {
    const rows = candQ.data && Array.isArray(candQ.data.rows) ? candQ.data.rows : [];
    const by = new Map(rows.map((r) => [String(r.id), r]));
    const unm = new Set((candQ.data && Array.isArray(candQ.data.unmapped) ? candQ.data.unmapped : []).map((u) => String(u.id)));
    return TF.includePreview(ids.map((id) => by.get(String(id)) || (unm.has(String(id)) ? { id, nextLevel: null } : null)).filter(Boolean));
  }, [candQ.data, ids]);
  const submit = async () => {
    if (!promoId) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/admin/talent-filters/${encodeURIComponent(promoId)}/members`, { action: 'include', userIds: ids, note: note.trim() || undefined, scope });
      onDone(r);
    } catch (err) { Toast.error({ content: bulkErrorText(err, lang), duration: 6 }); }
    setBusy(false);
  };
  return (
    <BulkConfirmModal visible op={s.bulkPromo} names={names} okDisabled={!promoId} loading={busy} onOk={submit} onCancel={onCancel}>
      {!promoId ? <div className="u-hint">{s.promoNone}</div>
        : candQ.loading ? <div className="u-hint"><Spin size="small" /> {s.promoLoading}</div>
          : <div className="u-hint">{s.promoHint(preview.already, preview.noNext)}</div>}
      <div className="ppl-flabel">{s.promoNote}</div>
      <Input value={note} maxLength={TF.NOTE_MAX} onChange={setNote} />
    </BulkConfirmModal>
  );
}
