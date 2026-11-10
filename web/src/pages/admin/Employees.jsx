import { csvText, saveCsv } from '../../csv.js';
import { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Table, Form, Modal, Button, Tag, Select, Input, TextArea, Popconfirm,
  Toast, Typography, Banner, Empty, Progress, Descriptions, Space, Spin, Dropdown,
} from '@douyinfe/semi-ui';
import {
  IconSearch, IconUpload, IconEdit, IconKey, IconClose,
  IconExport, IconUserAdd, IconCopy, IconRefresh, IconMore, IconDelete, IconBriefcase, IconArrowLeft,
} from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { date as fmtDate, datetime as fmtDateTime } from '../../fmt.js';
import { useAuth } from '../../auth.jsx';
import { canReadDomain, canWriteDomain, canUseAccounts, canUseRoles, isDomainReadOnly, modOn } from '../../rbac.js';
import { useI18n } from '../../i18n.jsx';
import { resizableTable } from '../../cardify.js';
import { dataTableColumns } from '../../components/DataTable.jsx';   // 一致性整改 2
import { PAGE_TIERS, useDataVersion, clampPage } from '../../pagesize.js';
import DeptFilter, { deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import ReadOnlyPill from '../../components/ReadOnlyPill.jsx';
import { useDeptTree, deptMatcher, invalidateDeptTree } from '../../deptfilter.js';
import { useUrlState, PAGE_KEYS } from '../../urlstate.js';

const { Text } = Typography;

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    title: '员工档案',
    lead: '点击姓名查看员工档案。课程指派请在「课程库」操作。',
    colMgr: '直属上级', colEmail: '邮箱', colLast: '最近登录', neverLogin: '从未登录',
    viewLearn: '查看学习记录', enable: '启用', disable: '停用',
    enabledOk: (n) => `已启用 ${n}`, disabledOk: (n) => `已停用 ${n}`,
    bulkDept: '改部门', bulkMgr: '改上级', bulkEnable: '批量启用', bulkDisable: '批量停用',
    bulkDeptTitle: '批量修改部门', bulkMgrTitle: '批量设置上级',
    bulkMgrHint: '留空保存 = 清除所选员工的上级',
    bulkPickFirst: '请先选择或输入部门',
    bulkPot: '设置潜力', bulkPotTitle: '批量设置潜力评级', bulkPotPh: '选择潜力评级（清空=未评估）',
    bulkPotHint: '潜力评级是人才盘点九宫格的纵轴。绩效维度在评估周期关闭时自动写入，潜力维度需在人才盘点会上评定；可按部门筛选后全选，一次设置。',
    potHigh: '高', potMedium: '中', potLow: '低',
    bulkUpdatedOk: (n) => `已更新 ${n} 人`,
    bulkEnabledOk: (n) => `已启用 ${n} 人`, bulkDisabledOk: (n) => `已停用 ${n} 人`,
    bulkEnableAsk: (n) => `启用所选 ${n} 人？`, bulkDisableAsk: (n) => `停用所选 ${n} 人？停用后无法登录，学习记录保留。`, disableAsk1: (n) => `停用 ${n} 的账号？停用后无法登录，学习记录保留。`,
    bulkSelfSkipped: '你自己的账号已跳过（不能停用自己）',
    bulkReset: '批量重置密码', bulkResetTitle: '批量发放临时密码？',
    bulkResetAsk: (n) => '将为所选 '+n+' 人生成新的临时密码，原密码立即失效，首次登录必须修改。密码只显示这一次，请先复制再关闭。',
    bulkResetDone: '临时密码已生成',
    bulkResetWarn: (n) => '已为 '+n+' 人生成临时密码 — 只显示这一次，关闭后无法再查看。请先「复制全部」再关闭。',
    bulkResetSkipped: (n) => '跳过 '+n+' 人（已离职/已停用/你自己的账号）。',
    // Strip segments name the group you are filtering to (试用期 / 已离职); the 状态
    // column names the person's own state (试用 / 离职). Same four states, two
    // vocabularies — the design keeps them apart and so does this.
    total: '全体员工', active: '在职', segProbation: '试用期', segExited: '已离职',
    searchPh: '搜索姓名或工号…', filteredN: (n) => '筛选后 ' + n + ' 人',
    deptAll: '全部部门',
    add: '新增员工', bulk: '批量导入员工',
    colId: '工号', colName: '姓名', colDept: '部门', colRole: '账号类型',
    colPosition: '职位', colStatus: '状态', colAction: '操作',
    noLevel: '未设职级',
    mMgr: (n) => `上级 ${n}`, mLogin: (d) => `${d} 登录`,
    profile: '详情', profileHint: '查看员工档案', stProbation: '试用期', stExited: '已离职',
    recImport: '导入人才记录',
    riTitle: '批量导入人才记录', riLead: '从 Excel 复制粘贴，第一行必须是表头。固定列：工号、类型、日期、标题（可空）；其余列名自动匹配「档案与职级设置」中的字段（中英文都认，如 项目名称/成绩/排名/奖项/严重度/原职级/新职级/结果）。类型认中文；重复行自动跳过；历史导入不触发职级/状态同步。',
    riPh: '工号\t类型\t日期\t标题\t项目名称\t成绩\t排名\t奖项\nDP-1001\t培训\t2024-06-28\t动力营 Batch 3\t动力营\t92\t3/25\t\nDP-1001\t荣誉\t2024-06-28\t优秀学员\t\t\t\t优秀学员',
    riRun: '导入', riNeedHeader: '需要表头行 + 至少一行数据', riNeedCols: '表头必须包含：工号、类型、日期',
    riDone: (c, k) => `导入完成：${c} 条创建，${k} 条跳过`, riLine: (n) => `第 ${n} 行`,
    riUnmatchedTitle: '有表头没有匹配到字段',
    riUnmatched: (n, list) => `有 ${n} 个表头未匹配到任何字段：${list}。这些列会被丢弃，其余列照常导入 —— 请先确认列名与「档案与职级设置」中的中文名、英文名一致。`,
    riImportAnyway: '仍然导入',
    // Per-row outcomes. The server's `reason` is a fixed half-English sentence
    // with the English field label glued in ("\"Period\" is required 必填"), so it
    // can only be localized here, from the code/field pair plus the label_zh this
    // dialog already has in the field config. Unknown codes still print `reason`.
    riOk: '已创建',
    riErrRequired: (f) => `「${f}」必填`,
    riErrNumber: (f) => `「${f}」需为数字`,
    riErrDate: (f) => `「${f}」需为 YYYY-MM-DD 格式`,
    riErrOption: (f, v) => (v ? `「${f}」的「${v}」不在可选项中` : `「${f}」的值不在可选项中`),
    viewAll: '查看全部', more: (n) => `+${n}`, noProg: '未指派课程',
    stActive: '正式', stDisabled: '已停用',
    roleAdmin: '超级管理员', roleEmployee: '员工',
    edit: '编辑', reset: '重置密码', assign: '指派',
    selectedN: (n) => `已选 ${n} 人`, selScope: '仅当前页',
    exportSel: '导出所选', clearSel: '取消选择',
    exportCsv: '导出 CSV', exportedOk: (n) => `已导出 ${n} 条`,
    emptyEmp: '没有符合条件的员工',
    loading: '加载中…', loadFail: '加载失败，请刷新页面重试。',
    // add / edit modal
    addTitle: '新增员工', editTitle: '编辑员工',
    fId: '工号', fName: '姓名', fDept: '部门', fEmail: '邮箱', fPhone: '手机号', fManager: '直属上级', fRole: '账号类型', fActive: '账号状态',
    // 后台角色 = adminRoleId（真正的权限来源）；账户角色 = role（账号类型）。
    fAdminRole: '后台角色', fAdminRolePh: '选择后台角色',
    adminRoleNone: '无（普通员工）',
    adminRoleBuiltin: (n) => `${n}（内置）`,
    adminRoleHint: '后台角色决定这个人在后台实际能看什么、能改什么。上面的「账户角色」只是账号类型；两者同时设置时以后台角色为准。角色在「角色与授权」页定义。',
    adminRoleLoadFail: '后台角色列表加载失败',
    // 服务端把 role / active / adminRoleId 当作同一组超管专属字段：非超管只要带上其中
    // 任何一个，整个请求就 403。所以这三项对非超管一律不渲染，并用这行说明代替。
    acctFieldsSuperOnly: '账户角色、后台角色与账户状态需要相应权限，此处不显示；其余资料照常保存。',
    acctRoleSuperOnly: '账户角色与后台角色仅超级管理员可修改，此处不显示；账户状态可正常修改。',
    // 一个动作控件的显隐看它**实际调用的那个接口**属哪个能力域（RBAC-ROUTE-MATRIX.md），
    // 不是看它长在哪一页上。11.4（2026-10-09，F49）：调不动的按钮直接不显示，不再逐条写说明段落；
    // 只读档只在标题右侧放「只读」胶囊，悬停给这一句。
    roTip: '你对「员工与组织」只有查看权限，编辑类操作不显示。',
    fPhonePh: '选填，如 0917 123 4567',
    fManagerPh: '选填，用于发展项目申请审批、逾期提醒升级与绩效评估',
    fIdPh: '000000', fNamePh: '请输入姓名', fDeptPh: '选择现有部门，或直接输入新部门名', fRolePh: '请选择角色',
    fEmailPh: '选填，如 name@example.com（用于后续邮件通知）', emailBad: '邮箱格式不正确',
    fHireDate: '入职日期', fHireDatePh: '成长轨迹的起点，建议填写', fPosition: '职位', fPositionPh: '如 Customer Service Specialist', fJobLevel: '职级', fJobLevelPh: '从职级体系中选择',
    reqId: '请输入工号', reqName: '请输入姓名', reqDept: '请选择或输入部门',
    idDup: '该工号已存在', idFmt: '工号为 3–20 位字母、数字或短横线',
    manageDept: '部门管理',
    deptCount: (n) => `${n} 人`,
    save: '保存', cancel: '取消',
    createdOk: (id) => `已创建员工 ${id}`, updatedOk: (id) => `已更新员工 ${id}`,
    // reset password
    resetTitle: '重置登录密码',
    resetConfirm: (name) => `确定为 ${name} 重置密码？原密码将立即失效。`,
    resetDoneTitle: '临时密码已生成',
    resetDoneDesc: (name) => `请将下列临时密码转交 ${name}，首次登录后需修改。`,
    tempPwd: '临时密码', copy: '复制', copied: '已复制到剪贴板', done: '完成',
    // bulk import
    importTitle: '批量导入员工',
    importHint: '推荐：下载 Excel 模板填好后直接上传。也可粘贴文本，每行一名员工：工号，姓名，部门，邮箱，直属上级工号，部门负责人（后三项选填；直属上级需已存在或排在名单前面；部门负责人填「是」即把此人设为所在部门的负责人）。系统自动生成初始密码。',
    pickFile: '上传表格（.xlsx / .csv）', tmplBtn: '下载 Excel 模板',
    orPaste: '或直接粘贴文本：',
    fileParsed: (n, f) => `已从「${f}」读取 ${n} 条，请核对预览后确认导入`,
    fileEmpty: '表格里没有读到有效数据（需要「工号+姓名」两列）',
    fileFail: '文件读取失败，请确认是 .xlsx 或 .csv 格式',
    csvPh: 'DP-2011，王强，实践社群，wangqiang@example.com,DP-2001\nDP-2012，李娜，产品工作室，,',
    parse: '解析', reparse: '重新解析', parsedN: (n) => `已解析 ${n} 条`,
    parseEmpty: '请先粘贴要导入的数据', parseBad: '未能解析出有效数据，请检查格式',
    iId: '工号', iName: '姓名', iDept: '部门', iEmail: '邮箱', iMgr: '直属上级工号', iHead: '部门负责人', iHeadYes: '是', iPwd: '初始密码', iStatus: '结果', iWarn: '提示',
    stCreated: '已创建', stSkipped: '已跳过',
    copyAll: '复制全部密码', confirmImport: '确认导入', noCreated: '没有可复制的新密码',
    importedOk: (n) => `已导入 ${n} 名员工`,
    // learning record page (?learn=<userId>)
    detailTitle: '学习记录', progOf: (name) => `${name} · 全部课程`,
    stPassed: '已通过', stProgress: '进行中', stNot: '未开始',
    empId: '工号', empDept: '部门', empRole: '角色', empStatus: '状态',
    empAdminRole: '后台角色',
    // 整页（2026-10-07：抽屉与新增 / 编辑弹窗改为整页，地址栏 ?new=1 / ?edit=<id> / ?learn=<id>）
    backList: '返回员工列表', unsaved: '有未保存的修改',
    discardTitle: '放弃未保存的修改？', discardAsk: '员工资料有未保存的修改，离开后会丢失。', discardOk: '放弃修改',
    notFound: '未找到该员工，可能已被删除或不在你的数据范围内。',
    learnTitle: (n) => `${n} · 学习记录`, openProfile: '查看员工档案',
    stDone: '已完成', stOverdue: '已逾期',
    dueOn: (d) => (d ? `截止 ${d}` : '未设截止日期'),
    newSub: '保存后生成初始密码，请转交员工。', newHint: '新员工首次登录须修改初始密码。',
    secBasic: '基本信息', secAccount: '账号与权限',
  },
  en: {
    title: 'Employee Profiles',
    lead: 'Click a name to open the employee profile. Assign courses from the Course Library.',
    colMgr: 'Manager', colEmail: 'Email', colLast: 'Last login', neverLogin: 'Never signed in',
    viewLearn: 'View Learning Record', enable: 'Enable', disable: 'Disable',
    enabledOk: (n) => `${n} enabled`, disabledOk: (n) => `${n} disabled`,
    bulkDept: 'Set department', bulkMgr: 'Set manager', bulkEnable: 'Enable', bulkDisable: 'Disable',
    bulkDeptTitle: 'Set department for selection', bulkMgrTitle: 'Set manager for selection',
    bulkMgrHint: 'Save with nothing picked = clear the manager for the selected people',
    bulkPickFirst: 'Pick or type a department first',
    bulkPot: 'Set potential', bulkPotTitle: 'Set potential for selection', bulkPotPh: 'Pick a rating (clear = unassessed)',
    bulkPotHint: 'Potential is the vertical axis of the talent review 9-box. The performance axis is written when a review cycle closes; potential is decided in the talent review meeting. Filter by department, select all and set it in one step.',
    potHigh: 'High', potMedium: 'Medium', potLow: 'Low',
    bulkUpdatedOk: (n) => `${n} updated`,
    bulkEnabledOk: (n) => `${n} enabled`, bulkDisabledOk: (n) => `${n} disabled`,
    bulkEnableAsk: (n) => `Enable the ${n} selected people?`, bulkDisableAsk: (n) => `Disable the ${n} selected people? They can't sign in; records are kept.`, disableAsk1: (n) => `Disable ${n}'s account? They can't sign in; records are kept.`,
    bulkSelfSkipped: 'Your own account was skipped (you cannot disable yourself)',
    bulkReset: 'Reset passwords', bulkResetTitle: 'Issue temporary passwords?',
    bulkResetAsk: (n) => 'Generates a new temporary password for the '+n+' selected people. Existing passwords stop working immediately and a change is forced on first sign-in. Shown once — copy before closing.',
    bulkResetDone: 'Temporary passwords issued',
    bulkResetWarn: (n) => n+' passwords issued — shown once only. Copy them all before closing this dialog.',
    bulkResetSkipped: (n) => n+' skipped (exited, disabled, or your own account).',
    total: 'All employees', active: 'Active', segProbation: 'Probation', segExited: 'Separated',
    searchPh: 'Search name or ID…', filteredN: (n) => n + ' after filters',
    deptAll: 'All departments',
    add: 'Add employee', bulk: 'Bulk import employees',
    colId: 'Employee ID', colName: 'Name', colDept: 'Department', colRole: 'Account Type',
    colPosition: 'Position', colStatus: 'Status', colAction: 'Actions',
    noLevel: 'No job level',
    mMgr: (n) => `Manager ${n}`, mLogin: (d) => `Login ${d}`,
    profile: 'Details', profileHint: 'Open employee profile', stProbation: 'Probation', stExited: 'Separated',
    recImport: 'Import talent records',
    riTitle: 'Bulk import talent records', riLead: 'Paste from Excel; the first row must be a header. Fixed columns: employee ID, type, date, title (optional); other headers auto-match the configured fields (Chinese or English). Types accept Chinese names; duplicates are skipped; historical imports never trigger level/status sync.',
    riPh: 'employeeId\ttype\tdate\ttitle\tProgram\tScore\tRank\tAward\nDP-1001\ttraining\t2024-06-28\tPower Camp Batch 3\tPower Camp\t92\t3/25\t\nDP-1001\taward\t2024-06-28\tOutstanding Trainee\t\t\t\tOutstanding Trainee',
    riRun: 'Import', riNeedHeader: 'Header row + at least one data row required', riNeedCols: 'Headers must include: employee ID, type, date',
    riDone: (c, k) => `Done: ${c} created, ${k} skipped`, riLine: (n) => `Row ${n}`,
    riUnmatchedTitle: 'Some headers match no field',
    riUnmatched: (n, list) => `${n} header${n === 1 ? '' : 's'} match no configured field: ${list}. Those columns are dropped; the rest still import — check the names against the Chinese and English labels in Profile & Job Level Settings first.`,
    riImportAnyway: 'Import anyway',
    riOk: 'created',
    riErrRequired: (f) => `"${f}" is required`,
    riErrNumber: (f) => `"${f}" must be a number`,
    riErrDate: (f) => `"${f}" must be YYYY-MM-DD`,
    riErrOption: (f, v) => (v ? `"${v}" is not a configured option of "${f}"` : `not a configured option of "${f}"`),
    viewAll: 'View all', more: (n) => `+${n}`, noProg: 'No courses assigned',
    stActive: 'Regular', stDisabled: 'Deactivated',
    roleAdmin: 'Super Admin', roleEmployee: 'Employee',
    edit: 'Edit', reset: 'Reset password', assign: 'Assign',
    selectedN: (n) => `${n} selected`, selScope: 'this page only',
    exportSel: 'Export selected', clearSel: 'Clear',
    exportCsv: 'Export CSV', exportedOk: (n) => `${n} rows exported`,
    emptyEmp: 'No employees match these filters',
    loading: 'Loading…', loadFail: 'Couldn’t load. Refresh the page to try again.',
    addTitle: 'Add employee', editTitle: 'Edit employee',
    fId: 'Employee ID', fName: 'Name', fDept: 'Department', fEmail: 'Email', fPhone: 'Mobile', fManager: 'Manager', fRole: 'Account type', fActive: 'Account status',
    fAdminRole: 'Admin role', fAdminRolePh: 'Pick an admin role',
    adminRoleNone: 'None (regular employee)',
    adminRoleBuiltin: (n) => `${n} (built-in)`,
    adminRoleHint: 'The admin role decides what this person can actually see and change in the console. "Account role" above is only the account type; when both are set, the admin role wins. Roles are defined on the Roles & access page.',
    adminRoleLoadFail: 'Failed to load the admin role list',
    acctFieldsSuperOnly: 'Account role, admin role and account status need the corresponding permissions and are not shown here. Everything else saves normally.',
    acctRoleSuperOnly: 'Account role and admin role can only be changed by a super-admin, so they are not shown here; account status can still be changed.',
    roTip: 'You have view-only access to People & Organization, so editing actions are not shown.',
    fPhonePh: 'Optional, e.g. 0917 123 4567',
    fManagerPh: 'Optional. Used for program application approvals, overdue escalations and performance reviews',
    fIdPh: '000000', fNamePh: 'Full name', fDeptPh: 'Pick an existing department, or type a new one', fRolePh: 'Select role',
    fEmailPh: 'Optional, e.g. name@example.com (for email notifications)', emailBad: 'Invalid email format',
    fHireDate: 'Hire date', fHireDatePh: 'The starting point of the Growth Timeline', fPosition: 'Position', fPositionPh: 'e.g. Customer Service Specialist', fJobLevel: 'Job level', fJobLevelPh: 'Choose from the Job Level Framework',
    reqId: 'Employee ID is required', reqName: 'Name is required', reqDept: 'Pick or type a department',
    idDup: 'This ID already exists', idFmt: 'Use 3–20 letters, digits or dashes',
    manageDept: 'Departments',
    deptCount: (n) => `${n}`,
    save: 'Save', cancel: 'Cancel',
    createdOk: (id) => `Employee ${id} created`, updatedOk: (id) => `Employee ${id} updated`,
    resetTitle: 'Reset login password',
    resetConfirm: (name) => `Reset the password for ${name}? The old password stops working immediately.`,
    resetDoneTitle: 'Temporary password generated',
    resetDoneDesc: (name) => `Share the temporary password below with ${name}. They must change it on first login.`,
    tempPwd: 'Temporary password', copy: 'Copy', copied: 'Copied to clipboard', done: 'Done',
    importTitle: 'Bulk import employees',
    importHint: 'Recommended: download the Excel template, fill it in and upload. Or paste text, one employee per line: ID, name, department, email, manager ID, department head (the last three optional; the manager must already exist or appear earlier in the list; put "Y" in department head to make this person the head of their department). Initial passwords are generated automatically.',
    pickFile: 'Upload spreadsheet (.xlsx / .csv)', tmplBtn: 'Download Excel template',
    orPaste: 'Or paste text:',
    fileParsed: (n, f) => `Read ${n} rows from "${f}" — review the preview, then confirm`,
    fileEmpty: 'No valid rows found in the file (needs ID + Name columns)',
    fileFail: 'Could not read the file — make sure it is .xlsx or .csv',
    csvPh: 'DP-2011,Wang Qiang,Practice Community,wangqiang@example.com,DP-2001\nDP-2012,Li Na,Product Studio,,',
    parse: 'Parse', reparse: 'Re-parse', parsedN: (n) => `${n} rows parsed`,
    parseEmpty: 'Paste some rows to import first', parseBad: 'No valid rows found — check the format',
    iId: 'ID', iName: 'Name', iDept: 'Department', iEmail: 'Email', iMgr: 'Manager ID', iHead: 'Dept head', iHeadYes: 'Yes', iPwd: 'Initial password', iStatus: 'Result', iWarn: 'Note',
    stCreated: 'Created', stSkipped: 'Skipped',
    copyAll: 'Copy all passwords', confirmImport: 'Import', noCreated: 'No new passwords to copy',
    importedOk: (n) => `Imported ${n} employees`,
    detailTitle: 'Learning Record', progOf: (name) => `${name} · all courses`,
    stPassed: 'Passed', stProgress: 'In progress', stNot: 'Not started',
    empId: 'ID', empDept: 'Department', empRole: 'Role', empStatus: 'Status',
    empAdminRole: 'Admin role',
    backList: 'Back to employees', unsaved: 'Unsaved changes',
    discardTitle: 'Discard unsaved changes?', discardAsk: 'This employee has unsaved changes that will be lost if you leave.', discardOk: 'Discard',
    notFound: 'Employee not found — they may have been deleted or be outside your data scope.',
    learnTitle: (n) => `${n} · Learning Record`, openProfile: 'Open profile',
    stDone: 'Completed', stOverdue: 'Overdue',
    dueOn: (d) => (d ? `Due ${d}` : 'No due date'),
    newSub: 'An initial password is issued on save — pass it to the employee.', newHint: 'New employees must change the initial password at first sign-in.',
    secBasic: 'Basic information', secAccount: 'Account and access',
  },
};

/* ---------------- helpers ---------------- */
function copyText(text, okMsg) {
  const say = () => Toast.success(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(say).catch(() => Toast.warning(text));
  } else {
    say();
  }
}

function toDateStr(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// lastLoginAt is a UTC ISO string ('2026-08-16T09:12:04.311Z'); shown in local time via fmt.js
// (code review 10/11: slicing it showed UTC, 8 hours behind Manila, and the day before between 00:00 and 08:00).
const loginShort = (v) => (v ? fmtDateTime(v).slice(5) : '');
const loginDay = (v) => (v ? fmtDate(v).slice(5) : '');
const loginFull = (v) => (v ? fmtDateTime(v) : '');
const initial = (name) => (String(name || '?').trim().charAt(0) || '?').toUpperCase();

export default function Employees() {
  const { lang, loc } = useI18n();
  const s = T[lang];
  const navigate = useNavigate();
  // Module switches from the /api/me payload — a payload without `modules`
  // (an older server) means everything is on, so this page renders unchanged.
  const { user } = useAuth();
  const mods = user && user.modules;
  const learningOn = modOn(mods, 'learning');
  const talentOn = modOn(mods, 'talent');
  // RBAC: a control is shown or hidden by the capability domain of the endpoint
  // IT ACTUALLY CALLS, not by the domain of the page it sits on (this page is
  // people, yet half its toolbar calls accounts / roles / talent / learning).
  // Every judgement below comes from rbac.js so the rule lives in exactly one
  // place; an old /api/me carries no grants block at all → everything reads as
  // super-admin / manage, the same backward-compat rule the sidebar uses.
  //   accounts (建号 / 批量建号 / 重置密码 / 启停账号)   → accounts = manage (D6:
  //             可授予、受部门范围约束 —— 范围内的 HRBP 也能看到这些控件)
  //   roles   (账户角色 role / 后台角色 adminRoleId)     → roles 域, 恒超管 (提权面)
  //   talent  写 (bulk-update 的 potential 字段)        → talent  = manage
  //   learning 读 (GET /employees/:id/detail)          → learning >= read
  //   people  写 (本页自身的编辑 / 批量改 / 记录导入)    → people  = manage
  // canAccounts 与 canRoles 拆开是 D6 的关键:accounts=manage 的非超管拿得到建号/
  // 重置/启停,但拿不到「改账号类型 / 授后台角色」—— 提权面仍锁在超管。
  const canAccounts = canUseAccounts(user);
  const canRoles = canUseRoles(user);
  const canWritePeople = canWriteDomain(user, 'people');
  // CX-128：停用 / 启用走 PUT /employees/:id 与 bulk-update，这两条路由按员工与组织（people）域把关 ——
  // 只有账号管理=管理、员工与组织只读的角色点了必然 403，所以要两项都有才显示
  const canToggleActive = canAccounts && canWritePeople;
  const peopleReadOnly = isDomainReadOnly(user, 'people');
  const canWriteTalent = canWriteDomain(user, 'talent');
  const canReadLearning = canReadDomain(user, 'learning');
  // Module switch AND grants, stacked — neither replaces the other.
  const learningView = learningOn && canReadLearning;
  // 设置潜力 needs BOTH legs: the ROUTE it posts to (bulk-update) is people/写, and
  // the FIELD it carries (potential) is gated again at talent=manage. A role with
  // people=read + talent=manage would 403 on the route before the field guard ever
  // ran, so canWritePeople has to be in the gate too — not just canWriteTalent.
  const talentBulk = talentOn && canWritePeople && canWriteTalent;

  /* ---- live data ----
     People-only page: uses the light /roster endpoint (no per-course progress
     computation — that lives in the detail drawer / Results / course side). */
  const empQ = useAsync(() => api.get('/api/admin/roster'), []);
  // A pure service account (admin role, no employment data at all) is not
  // headcount, and the 工作台 dashboard already excludes it. Leaving it in the
  // list made the status strip and "N after filters" disagree by one. An admin
  // who IS a real employee keeps their department/position and stays listed.
  const roster = useMemo(
    () => (empQ.data || []).filter((u) => !(u.role === 'admin' && !u.department && !u.position && !u.hireDate)),
    [empQ.data],
  );
  // Job-grade catalogue, so a new hire's level is picked from the real双通道
  // ladder rather than typed free-hand.
  const gradeQ = useAsync(() => api.get('/api/admin/job-grades'), []);
  const jobRanks = (gradeQ.data && gradeQ.data.ranks) || [];
  // Admin-role catalogue for the 后台角色 picker in the edit dialog. Fetched only
  // for a super-admin: /api/admin/roles is the roles domain (D6) and 403s
  // everyone else — a scoped HRBP with accounts=manage included — so gate the
  // fetch on canRoles, not canAccounts, or every page load 403s for pure noise.
  // The response is an ENVELOPE — { roles: [...] } — not a bare array; the array
  // form stays as a fallback so either shape renders.
  const rolesQ = useAsync(
    () => (canRoles ? api.get('/api/admin/roles') : Promise.resolve(null)),
    [canRoles],
  );
  const adminRoles = useMemo(() => {
    const d = rolesQ.data;
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.roles)) return d.roles;
    return [];
  }, [rolesQ.data]);

  const departments = useMemo(
    () => [...new Set(roster.map((r) => r.department).filter(Boolean))],
    [roster],
  );
  const deptName = (str) => str || '—';
  const roleLabel = (role) => (role === 'admin' ? s.roleAdmin : s.roleEmployee);
  // Role names are a bilingual pair (name / name_zh); fall back to the other
  // language rather than printing an em dash for a half-filled role.
  const adminRoleLabel = (r) => {
    const base = (lang === 'zh' ? (r.name_zh || r.name) : (r.name || r.name_zh)) || '—';
    return r.builtin ? s.adminRoleBuiltin(base) : base;
  };
  // Display name of the admin role a roster row is attached to: the 无（普通员工）
  // wording when nothing is attached, and an em dash while the catalogue is
  // still loading (or if it names an id we cannot resolve) — never silently
  // reported as "no role", which would read as a permission the person lost.
  const adminRoleNameOf = (id) => {
    if (id == null) return s.adminRoleNone;
    const hit = adminRoles.find((r) => r.id === id);
    return hit ? adminRoleLabel(hit) : '—';
  };
  // Employment status is four-state (正式/试用/离职/停用). Kept in one place so the
  // roster column, the detail drawer and the CSV export cannot drift apart —
  // they had, and the drawer was still reporting leavers as 在职.
  const empStatusText = (st, active) => {
    if (st === 'exited') return s.stExited;
    if (!active) return s.stDisabled;
    if (st === 'probation') return s.stProbation;
    return s.stActive;
  };
  const empStatusTag = (st, active) => {
    const color = st === 'exited' ? 'grey' : !active ? 'amber' : st === 'probation' ? 'blue' : 'green';
    return <Tag color={color} type="light" shape="circle">{empStatusText(st, active)}</Tag>;
  };
  const stateColor = (st) => (st === 'passed' ? 'green' : st === 'overdue' ? 'red' : st === 'progress' ? 'amber' : 'grey');
  const stateLabel = (st) => (st === 'passed' ? s.stPassed : st === 'overdue' ? s.stOverdue : st === 'progress' ? s.stProgress : s.stNot);
  const rosterById = useMemo(() => {
    const m = {};
    for (const r of roster) m[r.id] = r;
    return m;
  }, [roster]);

  /* ---- full pages (2026-10-07) ----
     新增 / 编辑员工与学习记录不再用弹窗、抽屉，改为整页，由地址栏驱动（培训模块整页同一做法，地址栏是唯一事实源）：
     ?edit=<userId>（people 写）> ?new=1（accounts 建号）> ?learn=<userId>（learning 读）。
     参数在、权限不在时忽略参数并回到列表（replace，不留历史）。 */
  const [searchParams] = useSearchParams();
  // 第二批 3.1（10/8）：进出整页只增删页面键（PAGE_KEYS = edit/new/learn/attempt），地址栏里的部门筛选 dept 保留；
  // 原来 setSearchParams({}) 会把筛选一并清掉。push = 进整页 / 返回列表留历史记录；false = replace（保存后、参数无效时）。
  const [, patchUrl] = useUrlState();
  const goPage = (set, push = true) => patchUrl(set || {}, { clear: PAGE_KEYS, push });
  const editParam = canWritePeople ? (searchParams.get('edit') || '') : '';
  const isNewPage = !editParam && canAccounts && searchParams.get('new') === '1';
  const learnParam = !editParam && !isNewPage && learningView ? (searchParams.get('learn') || '') : '';
  const pageKind = editParam ? 'edit' : isNewPage ? 'new' : learnParam ? 'learn' : '';
  const hasPageParam = searchParams.has('edit') || searchParams.has('new') || searchParams.has('learn');
  useEffect(() => {
    if (hasPageParam && !pageKind) goPage({}, false);
  }, [hasPageParam, pageKind]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- filters ---- */
  const [query, setQuery] = useState('');
  // 部门筛选（第二批 3.1）：地址栏 dept=<部门 id>，含下级；全站唯一口径（/api/admin/dept-tree + deptMatcher）
  const fDept = searchParams.get('dept') || '';
  const setFDept = (v) => patchUrl({ dept: v || null });
  const deptTree = useDeptTree();
  const deptOk = useMemo(() => deptMatcher(deptTree, fDept || null), [deptTree, fDept]);
  // 名册有写操作后刷新，部门树（选项与在职人数）一并失效
  const reloadRoster = () => { empQ.reload(); invalidateDeptTree(); };
  // Half the roster is archived leavers (4,398 of 8,867). HR works on current
  // staff, so open on them — clearing the filter still shows everyone.
  const [fStatus, setFStatus] = useState('current');
  const [selectedKeys, setSelectedKeys] = useState([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster.filter((r) => {
      if (q && !((r.employeeId || '').toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q))) return false;
      if (fDept && !deptOk(r.department)) return false;
      if (fStatus === 'current' && (r.empStatus === 'exited' || !r.active)) return false;
      if (fStatus === 'probation' && r.empStatus !== 'probation') return false;
      if (fStatus === 'exited' && r.empStatus !== 'exited') return false;
      // Account switched off but the person has not left — the state worth
      // spotting (leave of absence, suspended access, unfinished offboarding).
      if (fStatus === 'disabled' && (r.active || r.empStatus === 'exited')) return false;
      return true;
    });
  }, [roster, query, fDept, deptOk, fStatus]);

  // Admin service accounts are not headcount — excluding them keeps these chips
  // equal to the numbers the 工作台 dashboard reports.
  const counts = useMemo(() => {
    const staff = roster;
    return {
      total: staff.length,
      active: staff.filter((r) => r.active && r.empStatus !== 'exited').length,
      probation: staff.filter((r) => r.empStatus === 'probation').length,
      exited: staff.filter((r) => r.empStatus === 'exited').length,
      // Still employed, login switched off — the state HR has to chase.
      off: staff.filter((r) => !r.active && r.empStatus !== 'exited').length,
    };
  }, [roster]);

  /* ---- add / edit page state ----
     editingId comes from the address bar, never from its own state: with a
     separate state a deep link (?edit=<id>) left it null, so the employee-ID box
     unlocked, validateId reported "ID already exists" against the roster and the
     save would have taken the create path. null => creating. */
  const editingId = editParam || null;
  const [saving, setSaving] = useState(false);
  // Server-side refusals for the edit page, shown verbatim at the top of the form.
  // The RBAC guards answer with a full bilingual sentence (e.g. the "last active
  // super-admin" 400), and a Toast alone is too small/too brief to read it.
  const [editErr, setEditErr] = useState('');
  const editApi = useRef(null);

  // Bulk edit of PEOPLE fields (dept / manager / enable / disable) — course
  // assignment moved to the course library ("指派" per course).
  const [bulkOp, setBulkOp] = useState(null); // 'dept' | 'manager' | null
  const [bulkVal, setBulkVal] = useState(undefined);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [pwdModal, setPwdModal] = useState(null); // { name, pwd }

  const [importVisible, setImportVisible] = useState(false);
  const [recImportVisible, setRecImportVisible] = useState(false);
  const [csv, setCsv] = useState('');
  const [parsed, setParsed] = useState([]);
  const [imported, setImported] = useState(null); // results array | null
  const [importing, setImporting] = useState(false);

  const [pageSize, setPageSize] = useState(10); // employee table page size (10/20/50/100)
  const [currentPage, setCurrentPage] = useState(1);
  // The table unmounts while a full page is open and remounts on the way back
  // (and after every reload): key it on the data version and hand the remembered
  // page (clamped) and job-level sort back as defaults. currentPage is never passed
  // as a controlled prop — that would stop Semi from sorting the columns.
  const listVer = useDataVersion(empQ.data);
  const [listSort, setListSort] = useState(null); // { dataIndex, sortOrder } | null
  // Rows shown on the current page — "select all" scopes to exactly these.
  const pageKeys = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize).map((r) => r.id);
  }, [filtered, currentPage, pageSize]);
  // A filter change resets to page 1 so the view + selection scope stay in sync.
  useEffect(() => { setCurrentPage(1); }, [query, fDept, fStatus]);

  // learnParam already carries learningView, so it gates the fetch too, not just
  // the page: with the module off the endpoint is gone (404), and a role without
  // learning>=read gets a 404 from the RBAC gate as well — nothing to feed.
  const detailQ = useAsync(
    () => (learnParam ? api.get(`/api/admin/employees/${encodeURIComponent(learnParam)}/detail`) : Promise.resolve(null)),
    [learnParam],
  );

  /* ---- scroll + navigation between the list and the full pages ---- */
  // Entering a page starts at the top; coming back puts the list where it was.
  const listScroll = useRef(null);
  const rememberScroll = () => { try { listScroll.current = window.scrollY || 0; } catch { /* no window */ } };
  useEffect(() => {
    if (pageKind) { try { window.scrollTo(0, 0); } catch { /* no window */ } }
    else if (listScroll.current != null) {
      const y = listScroll.current;
      listScroll.current = null;
      try { window.scrollTo(0, y); } catch { /* no window */ }
    }
  }, [pageKind]);
  // Bumped whenever the page (or the person on it) changes, and on unmount: a save
  // that resolves after the operator has left must not drag them back to the list.
  const loadSeq = useRef(0);
  useEffect(() => () => { loadSeq.current += 1; }, [pageKind, editParam]);

  /* ---- add / edit ---- */
  const openAdd = () => { rememberScroll(); setEditErr(''); goPage({ new: '1' }); };
  const openEdit = (r) => { rememberScroll(); setEditErr(''); goPage({ edit: String(r.id) }); };
  const openLearn = (r) => { rememberScroll(); goPage({ learn: String(r.id) }); };
  const blankEdit = {
    id: '', name: '', dept: undefined, email: '', phone: '', managerId: undefined, role: 'employee', active: true,
    hireDate: '', position: '', jobLevel: undefined, adminRoleId: null,
  };
  // The person being edited is looked up in the RAW roster payload, not in
  // `roster`: that one drops pure service accounts, and a deep link to one of
  // them would otherwise open a blank form over a real record.
  const editRow = useMemo(
    () => (editParam ? (empQ.data || []).find((x) => String(x.id) === editParam) || null : null),
    [empQ.data, editParam],
  );
  const editInit = () => {
    if (!editingId) return blankEdit;
    const r = editRow;
    if (!r) return blankEdit; // never rendered: the edit page shows a spinner / not-found instead
    return {
      id: r.employeeId, name: r.name, dept: r.department || undefined, email: r.email || '', phone: r.phone || '',
      managerId: r.managerId || undefined, role: r.role, active: r.active,
      hireDate: r.hireDate || '', position: r.position || '', jobLevel: r.jobLevel || undefined,
      // null (never undefined) is the "no admin role" value: it is a real option
      // in the picker and it is what the server needs in the body to CLEAR an
      // assignment. undefined would make the Select fall back to its placeholder
      // and drop the field out of the JSON.
      adminRoleId: r.adminRoleId == null ? null : r.adminRoleId,
    };
  };
  // The DatePicker hands back a Date; the API contract is a 'YYYY-MM-DD' string.
  const dateStr = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return fmtDate(v);   // 一致性整改 3：统一走 fmt.date
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /* ---- unsaved-changes guard ----
     Snapshot of the form when the page opens vs. the current values. Semi Form
     (allowEmpty off) DELETES a field's key when it is cleared, so the current
     values replace the copy wholesale (never merged into the previous one, which
     would keep the cleared value) and a missing key compares as ''. A shallow
     copy, not a JSON round-trip: the DatePicker hands back a Date, and a UTC
     string would shift the day at +08:00 — dateStr reads it in local time. */
  const pickEmp = (v) => {
    const o = v || {};
    return JSON.stringify({
      id: String(o.id || '').trim(), name: String(o.name || '').trim(), dept: o.dept || '',
      email: String(o.email || '').trim(), phone: String(o.phone || '').trim(), managerId: o.managerId || '',
      hireDate: dateStr(o.hireDate), position: String(o.position || '').trim(), jobLevel: o.jobLevel || '',
      role: o.role || '', active: o.active === undefined ? '' : !!o.active,
      adminRoleId: o.adminRoleId == null ? null : o.adminRoleId,
    });
  };
  // Initialise once per page (and per person): a reload of the roster after a
  // save, or the roster arriving late on a deep link, must not reset the form.
  // Layout effect so the first paint already has the snapshot.
  const initFor = useRef(null);
  const [formBase, setFormBase] = useState('');
  const [formVals, setFormVals] = useState(null);
  useLayoutEffect(() => {
    const k = pageKind === 'new' ? 'new' : pageKind === 'edit' && editRow ? 'edit:' + editRow.id : null;
    if (!k) { initFor.current = null; setFormBase(''); setFormVals(null); return; }
    if (initFor.current === k) return;
    initFor.current = k;
    const iv = editInit();
    setEditErr('');
    setFormBase(pickEmp(iv));
    setFormVals(iv);
  }, [pageKind, editRow]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = (pageKind === 'edit' || pageKind === 'new') && !!formBase && !!formVals && pickEmp(formVals) !== formBase;
  // Back / Cancel / Open profile: confirm first when something would be lost.
  // The browser's own Back button and the sidebar bypass this (HashRouter has no
  // useBlocker) — the same accepted limit as the training full pages.
  const guard = (fn) => {
    if (!dirty) { fn(); return; }
    Modal.confirm({ title: s.discardTitle, content: s.discardAsk, okText: s.discardOk, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: fn });
  };
  // Closing the tab / reloading: the browser's own leave prompt.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const submitEdit = () => {
    const form = editApi.current;
    if (!form) return;
    form.validate().then(async (v) => {
      setSaving(true);
      setEditErr('');
      const seq = loadSeq.current; // left the page (or switched person) mid-save → do not navigate
      try {
        if (editingId) {
          const body = {
            name: v.name, department: v.dept, email: (v.email || '').trim(), phone: (v.phone || '').trim(), managerId: v.managerId || '',
            hireDate: dateStr(v.hireDate), position: (v.position || '').trim(), jobLevel: v.jobLevel || '',
          };
          // D6 splits the old super-only field group by its real guard:
          //   role / adminRoleId → 提权面, still super-admin only (canRoles). The
          //     server 403s the WHOLE request when a non-super carries either.
          //   active            → accounts domain: accounts=manage may write it
          //     (a scoped HRBP disabling someone in range). Carried by anyone
          //     without accounts=manage, the server 403s the whole PUT too.
          // A field the body omits is left untouched server-side, so leaving one
          // out clears nothing. null on adminRoleId is the exception: it CLEARS
          // the admin role. Each group rides only for the role allowed to write it.
          if (canRoles) {
            body.role = v.role;
            body.adminRoleId = v.adminRoleId == null ? null : v.adminRoleId;
          }
          if (canAccounts) {
            body.active = !!v.active;
          }
          await api.put(`/api/admin/employees/${editingId}`, body);
          Toast.success(s.updatedOk(v.id));
          reloadRoster();
          // Back to the list, replacing the edit entry so the browser's Back
          // button does not reopen a form that has just been saved.
          if (seq === loadSeq.current) goPage({}, false);
        } else {
          // People-only: creating an account assigns NO courses — assignment
          // happens per course in the course library.
          const res = await api.post('/api/admin/employees', {
            name: v.name, employeeId: v.id.trim(), department: v.dept, email: (v.email || '').trim(), phone: (v.phone || '').trim(), managerId: v.managerId || '',
            hireDate: dateStr(v.hireDate), position: (v.position || '').trim(), jobLevel: v.jobLevel || '',
            programIds: [],
          });
          // The one-time password dialog lives in the list view, so it opens as
          // soon as the page hands back to the list.
          setPwdModal({ name: v.name, pwd: res.password });
          Toast.success(s.createdOk(res.employeeId));
          reloadRoster();
          if (seq === loadSeq.current) goPage({}, false);
        }
      } catch (err) {
        // Show the server's own sentence, not a generic "save failed": a 400
        // ("last active super-admin") or a 403 (field not yours to change) is
        // the actual answer the operator needs, and it is already bilingual.
        const msg = (err && err.message) || '';
        setEditErr(msg);
        Toast.error(msg);
      } finally {
        setSaving(false);
      }
    }).catch(() => {});
  };
  const validateId = (val) => {
    if (editingId) return '';
    const v = (val || '').trim();
    if (!v) return s.reqId;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,19}$/.test(v)) return s.idFmt;
    if (roster.some((r) => (r.employeeId || '').toLowerCase() === v.toLowerCase())) return s.idDup;
    return '';
  };

  /* ---- reset password ---- */
  const doReset = async (r) => {
    try {
      const res = await api.post(`/api/admin/employees/${r.id}/reset`);
      setPwdModal({ name: r.name, pwd: res.password });
      empQ.reload();
    } catch (err) {
      Toast.error(err.message);
    }
  };
  // Reset lives in the row's actions dropdown, so confirm via a modal (a
  // Popconfirm would be dismissed when the menu closes).
  const confirmReset = (r) => {
    Modal.confirm({
      title: s.resetTitle,
      content: s.resetConfirm(r.name),
      okText: s.reset,
      cancelText: s.cancel,
      okButtonProps: { type: 'danger' },
      onOk: () => doReset(r),
    });
  };

  /* ---- bulk people edits ---- */
  const bulkUpdate = async (fields, okMsg) => {
    setBulkBusy(true);
    try {
      const r = await api.post('/api/admin/employees/bulk-update', { userIds: selectedKeys, fields });
      Toast.success(okMsg(r.count));
      if (r.skippedSelf) Toast.warning(s.bulkSelfSkipped);
      setBulkOp(null);
      setBulkVal(undefined);
      setSelectedKeys([]);
      reloadRoster();
    } catch (err) {
      Toast.error(err.message);
    } finally {
      setBulkBusy(false);
    }
  };
  const confirmBulkActive = (active) => {
    Modal.confirm({
      title: active ? s.bulkEnable : s.bulkDisable,
      content: (active ? s.bulkEnableAsk : s.bulkDisableAsk)(selectedKeys.length),
      okText: active ? s.bulkEnable : s.bulkDisable,
      cancelText: s.cancel,
      okButtonProps: active ? undefined : { type: 'danger' },
      onOk: () => bulkUpdate({ active }, active ? s.bulkEnabledOk : s.bulkDisabledOk),
    });
  };
  // Single-row enable/disable via the actions dropdown.
  // CX-141：单个停用与批量一样先确认（启用不需要确认）
  const toggleActive = (r) => {
    if (r.active) {
      Modal.confirm({ title: s.disable, content: s.disableAsk1(r.name), okText: s.disable, cancelText: s.cancel, okButtonProps: { type: 'danger' }, onOk: () => doToggleActive(r) });
      return;
    }
    doToggleActive(r);
  };
  const doToggleActive = async (r) => {
    try {
      await api.put(`/api/admin/employees/${r.id}`, { active: !r.active });
      Toast.success(!r.active ? s.enabledOk(r.name) : s.disabledOk(r.name));
      reloadRoster();
    } catch (err) {
      Toast.error(err.message);
    }
  };

  /* ---- bulk import ---- */
  // A header row pasted/uploaded by accident ("工号,姓名,…" / "ID,Name,…") is
  // dropped rather than imported as a fake employee.
  const isHeaderRow = (cells) => /工号|employee|^id$/i.test(String(cells[0] || '').replace(/\s|\*/g, ''));
  const rowsToRecords = (rows) => rows
    .map((cells) => cells.map((c) => String(c ?? '').trim()))
    .filter((cells) => cells.some(Boolean) && !isHeaderRow(cells))
    .map(([employeeId, name, department, email, managerEmployeeId, deptHead]) => ({
      employeeId, name,
      department: department || undefined,
      email: email || undefined,
      managerEmployeeId: managerEmployeeId || undefined,
      // 第 6 列「部门负责人」（2026-10-06）：是 / Y / Yes / 1 / ✓ → 该员工成为所在部门的负责人
      deptHead: /^(是|y|yes|1|✓|true)$/i.test(String(deptHead || '').trim()) || undefined,
    }))
    // CX-140：缺姓名或缺工号的行不在这里丢掉，交给服务端列为「缺少姓名或工号」的跳过行（原来 8 行只解析出 7 行、无提示）
    .filter((r) => r.employeeId || r.name);
  const parseCsv = () => {
    if (!csv.trim()) { Toast.warning(s.parseEmpty); return; }
    const out = rowsToRecords(csv.split(/\r?\n/).map((line) => line.split(',')));
    if (!out.length) { Toast.warning(s.parseBad); return; }
    setParsed(out);
    setImported(null);
  };
  // Spreadsheet upload: .xlsx via lazily-loaded SheetJS (admin-only chunk),
  // .csv decoded as UTF-8 with a GB18030 fallback (Excel-on-Windows exports).
  const fileRef = useRef(null);
  const handleImportFile = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let rows;
      if (/\.csv$/i.test(file.name)) {
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) { try { text = new TextDecoder('gb18030').decode(buf); } catch {} }
        rows = text.replace(/^﻿/, '').split(/\r?\n/).map((line) => line.split(','));
      } else {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buf, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      }
      const out = rowsToRecords(rows);
      if (!out.length) { Toast.warning(s.fileEmpty); return; }
      setParsed(out);
      setImported(null);
      setCsv('');
      Toast.success(s.fileParsed(out.length, file.name));
    } catch {
      Toast.error(s.fileFail);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const confirmImport = async () => {
    setImporting(true);
    try {
      // People-only import: no courses are assigned here (course library owns that).
      const res = await api.post('/api/admin/employees/bulk', { rows: parsed, programIds: [] });
      const results = (res && res.results) || [];
      setImported(results);
      const created = results.filter((r) => r.status === 'created').length;
      Toast.success(s.importedOk(created));
      reloadRoster();
    } catch (err) {
      Toast.error(err.message);
    } finally {
      setImporting(false);
    }
  };
  const closeImport = () => {
    setImportVisible(false);
    setCsv('');
    setParsed([]);
    setImported(null);
  };
  const copyAllPwd = () => {
    const created = (imported || []).filter((p) => p.status === 'created');
    if (!created.length) { Toast.warning(s.noCreated); return; }
    const text = created.map((p) => `${p.employeeId}\t${p.name}\t${p.password}`).join('\n');
    copyText(text, s.copied);
  };

  /* ---- bulk temporary passwords ----
     The only practical way to onboard a group: the imported roster shares one
     unusable hash, so nobody can sign in until HR issues real ones. The list is
     returned once and shown once — copy it out before closing. */
  const [bulkResetting, setBulkResetting] = useState(false);
  const [resetBatch, setResetBatch] = useState(null); // { issued: [], skipped: [] }
  const bulkReset = async () => {
    setBulkResetting(true);
    try {
      const r = await api.post('/api/admin/employees/bulk-reset', { userIds: selectedKeys });
      setResetBatch(r);
      setSelectedKeys([]);
      empQ.reload();
    } catch (err) { Toast.error(err.message); }
    setBulkResetting(false);
  };
  const copyResetBatch = () => {
    const rows = (resetBatch && resetBatch.issued) || [];
    if (!rows.length) { Toast.warning(s.noCreated); return; }
    const header = `${s.iId}\t${s.iName}\t${s.colDept}\t${s.tempPwd}`;
    copyText(`${header}\n${rows.map((p) => `${p.employeeId}\t${p.name}\t${p.department || ''}\t${p.password}`).join('\n')}`, s.copied);
  };

  /* ---- CSV export ----
     A real file, not a clipboard copy: HR forwards this to payroll/IT and needs
     an attachment. Built client-side because the roster is already loaded — no
     roster CSV endpoint exists. Escaping mirrors server.js csvEscape(), including
     the leading-apostrophe guard against Excel formula injection (CWE-1236). */
  const downloadCsv = (rows, tag) => {
    saveCsv(csvText(rows), `employees-${tag}-${toDateStr(new Date())}.csv`);
    Toast.success(s.exportedOk(rows.length - 1));
  };
  const exportRows = (people, tag) => {
    const header = [s.iId, s.iName, s.colDept, s.colPosition, s.fJobLevel, s.colRole, s.colStatus, s.colMgr, s.colEmail, s.colLast];
    downloadCsv([header, ...people.map((r) => [
      r.employeeId, r.name, r.department || '', r.position || '', r.jobLevel || '',
      roleLabel(r.role), empStatusText(r.empStatus, r.active),
      (rosterById[r.managerId] || {}).name || '', r.email || '',
      r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : s.neverLogin,
    ])], tag);
  };
  const exportSelected = () => exportRows(roster.filter((r) => selectedKeys.includes(r.id)), 'selected');
  const exportFiltered = () => exportRows(filtered, 'list');

  /* ---- columns ----
     Order is the design's: 姓名 · 工号 · 部门 · 职位/职级 · 状态 · 上级 · 最近登录.
     The person is what you scan for, so the name (with its avatar) leads and the
     ID follows it as an identifier rather than heading the table. 邮箱 dropped
     from the grid — it is not a column anyone scans, and it stays in the detail
     drawer, the edit form and the CSV export. */
  const columns = [
    {
      title: s.colName, dataIndex: 'name', width: 176, className: 'emp-namecol',   // CX-091（复测退回）：让出 20px 给「最近登录」
      render: (name, r) => (
        <>
          <div className="emp-namecell" onClick={() => navigate(`/admin/people/${r.id}`)} title={s.profileHint}>
            <span className="emp-av" aria-hidden="true">{initial(name)}</span>
            <span className="emp-name emp-namelink emp-ellip">{name}</span>
          </div>
          {/* Below 900px this one cell renders the whole record as the design's
              person card and the other cells hide, so the roster keeps its
              selection, paging and row actions instead of forking into a
              second list. */}
          <div className="emp-mcard" onClick={() => navigate(`/admin/people/${r.id}`)} title={s.profileHint}>
            <span className="emp-av" aria-hidden="true">{initial(name)}</span>
            <div className="emp-mc-body">
              <div className="emp-mc-l1">
                <span className="emp-mc-name">{name}</span>
                {r.jobLevel && <span className="emp-mc-lv">{r.jobLevel}</span>}
                {empStatusTag(r.empStatus, r.active)}
              </div>
              <div className="emp-mc-l2">{[r.position, r.department].filter(Boolean).join(' · ') || '—'}</div>
              <div className="emp-mc-l3">
                <span className="tnum">{r.employeeId}</span>
                {r.managerId && rosterById[r.managerId] && <span>{s.mMgr(rosterById[r.managerId].name)}</span>}
                <span className="tnum">{r.lastLoginAt ? s.mLogin(loginDay(r.lastLoginAt)) : s.neverLogin}</span>
              </div>
            </div>
          </div>
        </>
      ),
    },
    {
      title: s.colId, dataIndex: 'employeeId', width: 96,
      render: (id) => <Text strong className="tnum">{id}</Text>,
    },
    {
      // No header filter: Semi's funnel filters the Table's own copy of the data,
      // so 「筛选后 N 人」 and the page-scoped "select all" would both be reading a
      // different set than the one on screen. The toolbar dropdown is the one
      // department filter.
      title: s.colDept, dataIndex: 'department', width: 136,   // CX-091：1440 宽列宽合计放进卡片，固定操作列不压住「最近登录」
      render: (str) => <span className="emp-ellip" title={str || ''}>{deptName(str)}</span>,
    },
    // Training progress moved OUT of the roster (it lives in the Learning
    // domain and on each profile) — the table now fits without x-scroll,
    // which also removes the janky fixed-column behaviour.
    {
      // 职位、职级分两列（2026-10-05 反馈：合在一列时长职位名把职级挤成「M...」）。
      // A missing grade is called out because 晋升条件 cannot be checked without it.
      title: s.colPosition, dataIndex: 'position', width: 142,
      render: (v) => (v ? <span className="emp-ellip" title={v}>{v}</span> : <Text type="quaternary">—</Text>),
    },
    {
      title: s.fJobLevel, dataIndex: 'jobLevel', width: 88,
      sorter: (a, b) => String(a.jobLevel || '~').localeCompare(String(b.jobLevel || '~'), 'en', { numeric: true }),
      defaultSortOrder: listSort && listSort.dataIndex === 'jobLevel' ? listSort.sortOrder : false,
      render: (lv) => (lv
        ? <Tag size="small" color="indigo" type="light" shape="circle">{lv}</Tag>
        : <span className="emp-nolevel">{s.noLevel}</span>),
    },
    {
      // Employment status, not account status — a leaver, someone on probation
      // and someone whose login was switched off are three different things,
      // and the old column collapsed all of them into 在职/停用.
      title: s.colStatus, dataIndex: 'empStatus', width: 92,
      render: (st, r) => empStatusTag(st, r.active),
    },
    {
      title: s.colMgr, dataIndex: 'managerId', width: 110,
      render: (mid) => (mid && rosterById[mid] ? <span className="emp-ellip">{rosterById[mid].name}</span> : <Text type="quaternary">—</Text>),
    },
    {
      // Whether the account is actually in use — the roster's only signal that a
      // seat is dormant, and the one column that tells HR an onboarding never
      // landed. Full timestamp on hover; the cell shows the day and minute.
      title: s.colLast, dataIndex: 'lastLoginAt', width: 128,   // 英文「Never signed in」需要约 124px（含单元格内边距）
      render: (v) => (v
        ? <span className="tnum emp-last" title={loginFull(v)}>{loginShort(v)}</span>
        : <Text type="quaternary" size="small">{s.neverLogin}</Text>),
    },
    {
      // 详情 · 编辑 sit in the row, as the design has them — they are the two
      // actions every row needs and a menu made both of them two clicks. The
      // occasional ones stay behind ⋯ (also the only control the phone card has
      // room for). A leaver keeps 详情 alone: 停用 and 重置密码 are meaningless once
      // someone has gone, and editing a leaver still works from their profile.
      // Not pinned: pinning requires scroll.x, which is what pushed the other
      // columns out of view in the first place.
      title: s.colAction, dataIndex: 'op', width: 120, align: 'center', className: 'emp-op-col',
      render: (_, r) => {
        const exited = r.empStatus === 'exited';
        // Nothing left to put behind ⋯ for a view-only role with no learning and
        // no accounts rights — an empty menu is worse than no menu at all.
        const hasMenu = canWritePeople || learningView || (!exited && canAccounts);
        return (
          <div className="emp-op">
            <button type="button" className="emp-oplink" onClick={() => navigate(`/admin/people/${r.id}`)}>{s.profile}</button>
            {!exited && canWritePeople && <button type="button" className="emp-oplink" onClick={() => openEdit(r)}>{s.edit}</button>}
            {hasMenu && (
            <Dropdown
              trigger="click"
              position="bottomRight"
              render={(
                <Dropdown.Menu>
                  {/* 编辑 writes PUT /employees/:id — people 写, this page's own
                      domain, so a read-only people档 must not see it. */}
                  {canWritePeople && <Dropdown.Item icon={<IconEdit />} onClick={() => openEdit(r)}>{s.edit}</Dropdown.Item>}
                  {/* 查看学习 fires GET /employees/:id/detail — a LEARNING-domain
                      read from a people page. Without learning>=read the RBAC gate
                      answers 404, so the item is hidden (module switch stacked). */}
                  {learningView && <Dropdown.Item icon={<IconSearch />} onClick={() => openLearn(r)}>{s.viewLearn}</Dropdown.Item>}
                  {!exited && canAccounts && <Dropdown.Divider />}
                  {/* 重置密码 = POST /employees/:id/reset — accounts 域 (D6: 可授予、
                      受范围约束), so accounts=manage 的 HRBP 也能重置范围内的人。 */}
                  {!exited && canAccounts && <Dropdown.Item icon={<IconKey />} onClick={() => confirmReset(r)}>{s.reset}</Dropdown.Item>}
                  {/* Enable/disable writes `active` — an accounts-domain field
                      (D6): accounts=manage may write it (server scopes to range).
                      Hidden without accounts=manage since it could only ever 403. */}
                  {!exited && canToggleActive && (
                    <Dropdown.Item icon={<IconClose />} type={r.active ? 'danger' : 'primary'} onClick={() => toggleActive(r)}>
                      {r.active ? s.disable : s.enable}
                    </Dropdown.Item>
                  )}
                </Dropdown.Menu>
              )}
            >
              <Button theme="borderless" size="small" icon={<IconMore />} aria-label={s.colAction} />
            </Dropdown>
            )}
          </div>
        );
      },
    },
  ];

  // "Select all" scopes to the CURRENT PAGE only (add its rows, keep any picked
  // on other pages); individual toggles add/remove one row.
  const rowSelection = {
    selectedRowKeys: selectedKeys,
    onSelect: (record, selected) => {
      setSelectedKeys((prev) => (selected
        ? Array.from(new Set([...prev, record.id]))
        : prev.filter((k) => k !== record.id)));
    },
    onSelectAll: (selected) => {
      setSelectedKeys((prev) => {
        if (selected) return Array.from(new Set([...prev, ...pageKeys]));
        const onPage = new Set(pageKeys);
        return prev.filter((k) => !onPage.has(k));
      });
    },
  };

  const detail = detailQ.data;
  const detailProgs = (detail && detail.programs ? detail.programs : []).filter((p) => p.assigned);

  // ---------- full pages ----------
  // Every hook is above this line; from here on the address bar only picks which
  // view renders. The root is `wrap emp-page …`, never `emp-wrap`: at ≥1600px
  // v2.css lays `.v2-page-employees .emp-wrap` out as the roster's head / stats /
  // table grid, and a page would be squeezed into those areas.

  // ----- add (?new=1) / edit (?edit=<userId>) -----
  if (pageKind === 'edit' || pageKind === 'new') {
    const isEdit = pageKind === 'edit';
    const leave = () => guard(() => goPage({}));
    if (isEdit && !editRow) {
      // Never an empty form for an edit: wait for the roster, then say not found.
      const waiting = empQ.loading || (!empQ.data && !empQ.error);
      return (
        <div className="wrap emp-page emp-edit-page">
          <div className="co-page-bar">
            <Button theme="borderless" icon={<IconArrowLeft />} onClick={() => goPage({})}>{s.backList}</Button>
            <div className="co-page-titles"><h1 className="co-page-title">{s.editTitle}</h1></div>
          </div>
          <div className="card co-ed-card">
            {waiting ? <div className="exm-page-loading"><Spin size="large" tip={s.loading} /></div>
              : empQ.error ? <Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${empQ.error.message}`} />
                : <Empty description={s.notFound} />}
          </div>
        </div>
      );
    }
    const pageTitle = isEdit ? `${s.editTitle} · ${editRow.name}` : s.addTitle;
    const pageSub = isEdit ? `${editRow.employeeId} · ${editRow.department || '—'}` : s.newSub;
    return (
      <div className="wrap emp-page emp-edit-page">
        <div className="co-page-bar">
          <Button theme="borderless" icon={<IconArrowLeft />} onClick={leave}>{s.backList}</Button>
          <div className="co-page-titles">
            <h1 className="co-page-title" title={pageTitle}>{pageTitle}</h1>
            <div className="co-page-sub">{pageSub}</div>
          </div>
          {dirty && <span className="pill warn">{s.unsaved}</span>}
        </div>

        <div className="exm-page-grid">
          <div className="card co-ed-card">
            {editErr && <Banner type="danger" closeIcon={null} className="org-page-err" description={editErr} />}
            <Form
              key={editParam || 'new'}
              initValues={editInit()}
              getFormApi={(formApi) => { editApi.current = formApi; }}
              onValueChange={(values) => setFormVals(values ? { ...values } : null)}
              labelPosition="top"
            >
              <h2 className="org-page-sec">{s.secBasic}</h2>
              <div className="ppl-rec-grid">
                <Form.Input
                  field="id"
                  label={s.fId}
                  placeholder={s.fIdPh}
                  disabled={!!editingId}
                  validate={validateId}
                  trigger={['blur', 'change']}
                />
                <Form.Input field="name" label={s.fName} placeholder={s.fNamePh} rules={[{ required: true, message: s.reqName }]} />
                <Form.Select
                  field="dept"
                  label={s.fDept}
                  placeholder={s.fDeptPh}
                  style={{ width: '100%' }}
                  filter
                  allowCreate
                  optionList={departments.map((d) => ({ label: d, value: d }))}
                  rules={[{ required: true, message: s.reqDept }]}
                />
                <Form.Input field="position" label={s.fPosition} placeholder={s.fPositionPh} />
                <Form.Select field="jobLevel" label={s.fJobLevel} placeholder={s.fJobLevelPh}
                  style={{ width: '100%' }} filter showClear
                  optionList={jobRanks.map((r) => ({ label: r.rank, value: r.rank }))} />
                {/* Employment data, not just account data — a new hire has a start
                    date, a job title and a grade on day one. Without these the record
                    has to be created and then immediately edited on the profile page,
                    and 入职日期 is what anchors the whole development timeline. */}
                <Form.DatePicker field="hireDate" label={s.fHireDate} type="date" format="yyyy-MM-dd"
                  placeholder={s.fHireDatePh} style={{ width: '100%' }} />
                <Form.Input
                  field="email"
                  label={s.fEmail}
                  placeholder={s.fEmailPh}
                  rules={[{ type: 'email', message: s.emailBad }]}
                />
                <Form.Input field="phone" label={s.fPhone} placeholder={s.fPhonePh} />
              </div>
              <Form.Select
                field="managerId"
                label={s.fManager}
                placeholder={s.fManagerPh}
                style={{ width: '100%' }}
                filter
                showClear
                optionList={roster
                  .filter((x) => x.id !== editingId && x.active)
                  .map((x) => ({ label: `${x.name}（${x.employeeId}）`, value: x.id }))}
              />
              {isEdit && (canRoles || canAccounts) && <h2 className="org-page-sec">{s.secAccount}</h2>}
              {/* D6 splits the old super-only group by its real guard. 账户角色 (role)
                  and 后台角色 (adminRoleId) are the 提权面 — the roles domain, so still
                  super-admin only (canRoles), and submitEdit omits them for everyone
                  else so the whole PUT does not 403. 后台角色 is the real permission
                  source; 「无（普通员工）」 carries null, exactly what the PUT body needs
                  to CLEAR an assignment — an empty string would not, undefined would
                  drop the key. showClear is off on purpose: that option IS the clear
                  path and cannot hand the form an undefined. */}
              {isEdit && canRoles && (
                <>
                  <Form.Select
                    field="role"
                    label={s.fRole}
                    placeholder={s.fRolePh}
                    style={{ width: '100%' }}
                    optionList={[{ label: s.roleEmployee, value: 'employee' }, { label: s.roleAdmin, value: 'admin' }]}
                  />
                  <Form.Select
                    field="adminRoleId"
                    label={s.fAdminRole}
                    placeholder={s.fAdminRolePh}
                    style={{ width: '100%' }}
                    filter
                    loading={rolesQ.loading}
                    optionList={[
                      { label: s.adminRoleNone, value: null },
                      ...adminRoles.map((r) => ({ label: adminRoleLabel(r), value: r.id })),
                    ]}
                  />
                  {rolesQ.error && (
                    <div style={{ fontSize: 12, color: 'var(--semi-color-danger)', marginTop: -8, marginBottom: 8 }}>
                      {`${s.adminRoleLoadFail} · ${rolesQ.error.message}`}
                    </div>
                  )}
                  <div className="org-page-hint" style={{ marginTop: -4, marginBottom: 12 }}>{s.adminRoleHint}</div>
                </>
              )}
              {/* 账户状态 (active) is an accounts-domain field (D6): accounts=manage may
                  write it, so a scoped HRBP disabling someone in range sees the switch
                  even without the roles-domain 提权. Since canRoles ⟹ canAccounts, a
                  super-admin still sees it right under the role controls above. */}
              {isEdit && canAccounts && (
                <Form.Switch field="active" label={s.fActive} />
              )}
              {/* Explain whichever account controls are hidden — never a silently
                  missing field. !canRoles but canAccounts: only role/admin-role gone.
                  Neither: all three gone. */}
              {isEdit && !canRoles && (
                <div className="org-page-hint">{canAccounts ? s.acctRoleSuperOnly : s.acctFieldsSuperOnly}</div>
              )}
            </Form>
            <div className="exm-page-foot">
              <Button theme="borderless" onClick={leave}>{s.cancel}</Button>
              <Button theme="solid" type="primary" loading={saving} onClick={submitEdit}>{s.save}</Button>
            </div>
          </div>

          <aside className="exm-page-side">
            <div className="card co-ed-card">
              {isEdit ? (
                <>
                  <Descriptions
                    className="emp-desc"
                    row
                    data={[
                      { key: s.empId, value: <span className="tnum">{editRow.employeeId}</span> },
                      { key: s.empStatus, value: empStatusTag(editRow.empStatus, editRow.active) },
                    ]}
                  />
                  {canReadDomain(user, 'people') && (
                    <Button block onClick={() => guard(() => navigate(`/admin/people/${editRow.id}`))}>{s.openProfile}</Button>
                  )}
                </>
              ) : (
                <div className="org-page-hint" style={{ marginTop: 0 }}>{s.newHint}</div>
              )}
            </div>
          </aside>
        </div>
      </div>
    );
  }

  // ----- learning record (?learn=<userId>, read-only — no guard) -----
  if (pageKind === 'learn') {
    const back = () => goPage({});
    // useAsync keeps the previous payload while the next person loads: only
    // render once the payload is for the person in the address bar.
    const ready = !!(detail && detail.user && String(detail.user.id) === learnParam);
    if (!ready) {
      const err = detailQ.error;
      return (
        <div className="wrap emp-page emp-learn-page">
          <div className="co-page-bar">
            <Button theme="borderless" icon={<IconArrowLeft />} onClick={back}>{s.backList}</Button>
            <div className="co-page-titles"><h1 className="co-page-title">{s.detailTitle}</h1></div>
          </div>
          <div className="card co-ed-card">
            {!err ? <div className="exm-page-loading"><Spin size="large" tip={s.loading} /></div>
              : err.status === 404 ? <Empty description={s.notFound} />
                : <Banner type="danger" closeIcon={null} description={`${s.loadFail} · ${err.message}`} />}
          </div>
        </div>
      );
    }
    const du = detail.user;
    // Raw roster row (service accounts included): the two fields /detail does not
    // carry — adminRoleId, and empStatus/position from an older server.
    const rr = (empQ.data || []).find((x) => String(x.id) === String(du.id)) || {};
    const learnTitle = s.learnTitle(du.name);
    return (
      <div className="wrap emp-page emp-learn-page">
        <div className="co-page-bar">
          <Button theme="borderless" icon={<IconArrowLeft />} onClick={back}>{s.backList}</Button>
          <div className="co-page-titles">
            <h1 className="co-page-title" title={learnTitle}>{learnTitle}</h1>
            <div className="co-page-sub">{`${du.employeeId} · ${deptName(du.department)}`}</div>
          </div>
          {canReadDomain(user, 'people') && (
            <Button onClick={() => navigate(`/admin/people/${du.id}`)}>{s.openProfile}</Button>
          )}
        </div>

        <div className="exm-page-grid">
          <div className="card co-ed-card">
            <div className="emp-detail-h">{s.progOf(du.name)}</div>
            {detailProgs.length === 0 && <Empty description={s.noProg} />}
            {detailProgs.map((p) => {
              const pct = p.progress || 0;
              // The server's verdict (programDone — the rule the overdue reminders
              // use too): exam passed AND offline sessions attended, or 100% for a
              // course without an exam. The attempts fallback only serves an older
              // server that does not send `done`.
              const done = p.done !== undefined ? !!p.done : (p.attempts || []).some((a) => a.passed);
              const st = done ? 'passed' : p.overdue ? 'overdue' : (pct > 0 ? 'progress' : 'notstarted');
              const label = done ? (p.hasExam === false ? s.stDone : s.stPassed) : stateLabel(st);
              const due = p.dueAt ? String(p.dueAt).slice(0, 10) : null;
              return (
                <div key={p.id} className="emp-detail-row">
                  <div className="emp-detail-top">
                    <span className="emp-detail-name">{loc(p, 'title')}</span>
                    <Tag color={stateColor(st)} type="light" size="small" shape="circle">{label}</Tag>
                  </div>
                  <Progress percent={pct} stroke={done ? 'var(--success)' : 'var(--brand)'} aria-label={`${loc(p, 'title')} ${pct}%`} />
                  <div className="emp-detail-top" style={{ marginTop: 4, marginBottom: 0 }}>
                    <span className={'emp-learn-due' + (st === 'overdue' ? ' late' : '')}>{s.dueOn(due)}</span>
                    <span className="emp-detail-pct tnum" style={{ marginTop: 0 }}>{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>

          <aside className="exm-page-side">
            <div className="card co-ed-card">
              <Descriptions
                row
                data={[
                  { key: s.empId, value: <span className="tnum">{du.employeeId}</span> },
                  { key: s.colName, value: du.name },
                  { key: s.empDept, value: deptName(du.department) },
                  { key: s.colPosition, value: du.position || rr.position || '—' },
                  { key: s.fEmail, value: du.email || '—' },
                  { key: s.fManager, value: (roster.find((x) => x.id === du.managerId) || {}).name || '—' },
                  { key: s.empRole, value: roleLabel(du.role) },
                  // 后台角色 is what actually makes someone an administrator, so the
                  // page has to name it — 角色 above only says employee/admin.
                  // roles domain only (canRoles): that is the only session that
                  // fetched the role catalogue, hence the only one that can resolve
                  // an id to a name; /detail carries no adminRoleId, so it is read
                  // from the roster row.
                  ...(canRoles ? [{ key: s.empAdminRole, value: adminRoleNameOf(rr.adminRoleId) }] : []),
                  // Four-state employment status: /detail's own value first, the
                  // roster row as the fallback for an older server.
                  { key: s.empStatus, value: empStatusTag(du.empStatus || rr.empStatus, du.active) },
                ]}
              />
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap emp-wrap">
      {/* header */}
      <div className="emp-head">
        <div>
          {/* 11.4 / F47：只读档在标题右侧放「只读」胶囊，悬停给一句说明 */}
          <div className="u-title-line">
            <h1 className="emp-title">{s.title}</h1>
            {peopleReadOnly && <ReadOnlyPill tip={s.roTip} />}
          </div>
          <div className="emp-lead">{s.lead}</div>
        </div>
        {/* wrap: five actions overflow the header on a narrow window otherwise */}
        <Space wrap>
          <Button icon={<IconBriefcase />} theme="light" onClick={() => navigate('/admin/departments')}>{s.manageDept}</Button>
          {/* 导出 CSV is built client-side from the roster already in memory — no
              endpoint, so no gate beyond being on the page. */}
          <Button icon={<IconExport />} theme="light" disabled={!filtered.length} onClick={exportFiltered}>{s.exportCsv}</Button>
          {/* 导入记录 = POST /records/bulk — people 写 (员工与组织), this page's own
              domain: a read-only people档 has to lose it. */}
          {canWritePeople && <Button icon={<IconUpload />} theme="light" onClick={() => setRecImportVisible(true)}>{s.recImport}</Button>}
          {/* 批量导入 = POST /employees/bulk and 新增员工 = POST /employees — both
              are 建号, i.e. the accounts domain. D6 makes it grantable and scoped,
              so accounts=manage (a super-admin or a scoped HRBP) sees them; the
              server enforces that a new hire's department falls in range. */}
          {canAccounts && <Button icon={<IconUpload />} theme="light" onClick={() => setImportVisible(true)}>{s.bulk}</Button>}
          {canAccounts && <Button icon={<IconUserAdd />} theme="solid" type="primary" onClick={openAdd}>{s.add}</Button>}
        </Space>
      </div>

      {/* 11.4（F49）：原来这里逐条写「某按钮属某域、此处已隐藏」的说明段落，已删除——
          调不动的按钮直接不显示，只读档只在标题右侧放「只读」胶囊。 */}

      {/* Status strip: the counts double as the status filter — the number you
          read and the list you get are the same thing, and this is the design's
          segmented status control, so there is no second status dropdown in the
          toolbar to disagree with it. All five states are here, 已停用 included.
          Counts exclude the admin service account, matching the 工作台 dashboard. */}
      <div className="emp-statstrip">
        {[
          ['', s.total, counts.total, 'muted'],
          ['current', s.active, counts.active, 'ok'],
          ['probation', s.segProbation, counts.probation, 'warn'],
          ['exited', s.segExited, counts.exited, 'muted'],
          ['disabled', s.stDisabled, counts.off, 'muted'],
        ].map(([val, label, n, tone]) => (
          <button key={val || 'all'} className={'emp-stat' + (fStatus === val ? ' on' : '')}
            onClick={() => setFStatus(val)}>
            <span className="emp-stat-k">{label}</span>
            <span className={'emp-stat-v tnum ' + tone}>{n}</span>
          </button>
        ))}
      </div>

      {/* toolbar */}
      <div className="emp-toolbar">
        <Input
          prefix={<IconSearch />}
          placeholder={s.searchPh}
          value={query}
          onChange={setQuery}
          showClear
          className="emp-search"
        />
        <DeptFilter
          options={deptTree ? deptTree.options : []}
          value={fDept || null}
          onChange={(v) => setFDept(v)}
          lang={lang}
          showNone={!!(deptTree && deptTree.hasNone)}
          disabled={deptTree === null}
          ready={!!deptTree}
          onInvalid={() => { Toast.info(deptFilterInvalidText(lang)); setFDept(null); }}
        />
        {/* W3-C-CSS: .emp-toolbar > .dpf — ≤640 时部门筛选独占一行、触发按钮拉满（与 .emp-search 一致） */}
        {/* How many rows the current filter actually yields — otherwise the only
            number on screen is the unfiltered total. */}
        <Text type="tertiary" size="small" className="emp-filtered">{s.filteredN(filtered.length)}</Text>
      </div>

      {/* load error */}
      {empQ.error && (
        <Banner type="danger" className="emp-bulkbar" closeIcon={null} description={`${s.loadFail} · ${empQ.error.message}`} />
      )}

      {/* bulk action bar */}
      {selectedKeys.length > 0 && (
        <Banner
          type="info"
          className="emp-bulkbar emp-bulkbar-dark"
          closeIcon={null}
          description={(
            <div className="emp-bulkinner">
              {/* 「仅当前页」 says out loud what 全选 actually did — it picks the rows
                  on screen, not the whole filtered set. */}
              <span className="emp-bulklab">
                {s.selectedN(selectedKeys.length)}
                <span className="emp-bulkscope">{s.selScope}</span>
              </span>
              <Space wrap>
                {/* 改部门 / 改上级 are people 写 (POST bulk-update, department /
                    managerId) — same domain as the page, so only a read-only档
                    loses them. */}
                {canWritePeople && <Button size="small" theme="solid" type="primary" icon={<IconBriefcase />} onClick={() => { setBulkOp('dept'); setBulkVal(undefined); }}>{s.bulkDept}</Button>}
                {canWritePeople && <Button size="small" icon={<IconUserAdd />} onClick={() => { setBulkOp('manager'); setBulkVal(undefined); }}>{s.bulkMgr}</Button>}
                {/* Potential is the 9-box vertical axis: the ROUTE is people, but
                    the FIELD is talent-development data and the server demands
                    talent=manage for it (403 otherwise). Talent module switch and
                    the talent grant are stacked. */}
                {talentBulk && <Button size="small" onClick={() => { setBulkOp('potential'); setBulkVal(undefined); }}>{s.bulkPot}</Button>}
                {/* Same accounts-domain `active` field as the row dropdown's
                    enable/disable (D6): accounts=manage may write it, and the
                    server scopes the batch to the caller's range. */}
                {canToggleActive && <Button size="small" onClick={() => confirmBulkActive(true)}>{s.bulkEnable}</Button>}
                {canToggleActive && <Button size="small" type="danger" onClick={() => confirmBulkActive(false)}>{s.bulkDisable}</Button>}
                {/* 批量重置密码 = POST /employees/bulk-reset — accounts 域 (D6:
                    可授予、受范围约束), like the row-level reset. */}
                {canAccounts && (
                <Popconfirm title={s.bulkResetTitle} content={s.bulkResetAsk(selectedKeys.length)}
                  okText={s.bulkReset} cancelText={s.cancel} onConfirm={bulkReset}>
                  <Button size="small" icon={<IconKey />} loading={bulkResetting}>{s.bulkReset}</Button>
                </Popconfirm>
                )}
                <Button size="small" icon={<IconExport />} onClick={exportSelected}>{s.exportSel}</Button>
                <Button size="small" theme="borderless" onClick={() => setSelectedKeys([])}>{s.clearSel}</Button>
              </Space>
            </div>
          )}
        />
      )}

      {/* table */}
      <div className="emp-tablecard">
        <Table
          key={listVer}
          rowKey="id"
          loading={empQ.loading}
          {...resizableTable(dataTableColumns(columns, { titleKey: 'name', opsKey: 'op' }), { extra: 60 })}
          dataSource={filtered}
          rowSelection={rowSelection}
          bordered={false}
          onChange={({ sorter }) => setListSort(sorter && sorter.sortOrder ? { dataIndex: sorter.dataIndex, sortOrder: sorter.sortOrder } : null)}
          pagination={{ pageSize, defaultCurrentPage: clampPage(currentPage, filtered.length, pageSize), pageSizeOpts: PAGE_TIERS, showSizeChanger: true, onPageChange: setCurrentPage, onPageSizeChange: (v) => { setPageSize(v); setCurrentPage(1); }, formatPageText: false }}
          // scroll.x comes from resizableTable, which adds the column widths up
          // (plus 60 for the selection column). It was once hand-written as 1230
          // against ~1030 of real columns, and the roster scrolled sideways at
          // ordinary window widths with 状态 out of view.
          empty={<Empty description={s.emptyEmp} />}
          onRow={(r) => (r && !r.active ? { className: 'emp-row-off' } : {})}
        />
      </div>

      {/* ---------- bulk edit modal (dept / manager) ---------- */}
      <Modal
        title={bulkOp === 'dept' ? s.bulkDeptTitle : bulkOp === 'potential' ? s.bulkPotTitle : s.bulkMgrTitle}
        visible={!!bulkOp}
        onCancel={() => { setBulkOp(null); setBulkVal(undefined); }}
        onOk={() => {
          if (bulkOp === 'dept') {
            if (!bulkVal || !String(bulkVal).trim()) { Toast.warning(s.bulkPickFirst); return; }
            bulkUpdate({ department: String(bulkVal).trim() }, s.bulkUpdatedOk);
          } else if (bulkOp === 'potential') {
            // Empty is meaningful here: it clears the rating back to unassessed.
            bulkUpdate({ potential: bulkVal || '' }, s.bulkUpdatedOk);
          } else {
            bulkUpdate({ managerId: bulkVal || '' }, s.bulkUpdatedOk);
          }
        }}
        okText={s.save}
        cancelText={s.cancel}
        confirmLoading={bulkBusy}
        maskClosable={false}
        width={440}
      >
        <div className="emp-assign-sub">{s.selectedN(selectedKeys.length)}</div>
        {bulkOp === 'dept' && (
          <Select
            style={{ width: '100%' }}
            placeholder={s.fDeptPh}
            filter allowCreate showClear
            value={bulkVal}
            onChange={setBulkVal}
            optionList={departments.map((d) => ({ label: d, value: d }))}
          />
        )}
        {bulkOp === 'potential' && (
          <>
            <Select
              style={{ width: '100%' }}
              placeholder={s.bulkPotPh}
              showClear
              value={bulkVal}
              onChange={setBulkVal}
              optionList={[
                { label: s.potHigh, value: 'High' },
                { label: s.potMedium, value: 'Medium' },
                { label: s.potLow, value: 'Low' },
              ]}
            />
            <div style={{ fontSize: 12, color: 'var(--semi-color-text-2)', marginTop: 8 }}>{s.bulkPotHint}</div>
          </>
        )}
        {bulkOp === 'manager' && (
          <>
            <Select
              style={{ width: '100%' }}
              placeholder={s.fManagerPh}
              filter showClear
              value={bulkVal}
              onChange={setBulkVal}
              optionList={roster
                .filter((x) => x.active && !selectedKeys.includes(x.id))
                .map((x) => ({ label: `${x.name}（${x.employeeId}）`, value: x.id }))}
            />
            <div style={{ fontSize: 12, color: 'var(--semi-color-text-2)', marginTop: 8 }}>{s.bulkMgrHint}</div>
          </>
        )}
      </Modal>

      {/* ---------- reset-password / new-account result modal ---------- */}
      <Modal
        title={s.resetDoneTitle}
        visible={!!pwdModal}
        onCancel={() => setPwdModal(null)}
        footer={<Button theme="solid" type="primary" onClick={() => setPwdModal(null)}>{s.done}</Button>}
        width={440}
      >
        {pwdModal && (
          <>
            <p className="emp-modal-desc">{s.resetDoneDesc(pwdModal.name)}</p>
            <div className="emp-pwdbox">
              <span className="emp-pwdlab">{s.tempPwd}</span>
              <code className="emp-pwdval">{pwdModal.pwd}</code>
              <Button size="small" icon={<IconCopy />} onClick={() => copyText(pwdModal.pwd, s.copied)}>{s.copy}</Button>
            </div>
          </>
        )}
      </Modal>

      {/* ---------- bulk temporary passwords result ---------- */}
      <Modal
        title={s.bulkResetDone}
        visible={!!resetBatch}
        onCancel={() => setResetBatch(null)}
        maskClosable={false}
        width={640}
        footer={(
          <Space>
            <Button icon={<IconCopy />} onClick={copyResetBatch}>{s.copyAll}</Button>
            <Button theme="solid" type="primary" onClick={() => setResetBatch(null)}>{s.done}</Button>
          </Space>
        )}
      >
        {resetBatch && (
          <>
            <Banner type="warning" closeIcon={null}
              description={s.bulkResetWarn(resetBatch.issued.length)} />
            {resetBatch.skipped.length > 0 && (
              <p className="emp-modal-desc">{s.bulkResetSkipped(resetBatch.skipped.length)}</p>
            )}
            <Table
              rowKey="employeeId"
              dataSource={resetBatch.issued}
              size="small"
              pagination={resetBatch.issued.length > 10 ? { pageSize: 10, formatPageText: false } : false}
              {...resizableTable([
                { title: s.iId, dataIndex: 'employeeId', width: 100, render: (v) => <Text className="tnum">{v}</Text> },
                { title: s.iName, dataIndex: 'name', width: 150 },
                { title: s.colDept, dataIndex: 'department', width: 150, render: (v) => v || <Text type="quaternary">—</Text> },
                { title: s.tempPwd, dataIndex: 'password', width: 180, render: (v) => <code className="emp-pwdval">{v}</code> },
              ])}
            />
          </>
        )}
      </Modal>

      {/* ---------- bulk import modal ---------- */}
      <Modal
        title={s.importTitle}
        visible={importVisible}
        onCancel={closeImport}
        footer={(
          <Space>
            <Button theme="borderless" onClick={closeImport}>{imported ? s.done : s.cancel}</Button>
            {!imported && parsed.length > 0 && (
              <Button theme="solid" type="primary" loading={importing} onClick={confirmImport}>{s.confirmImport}</Button>
            )}
          </Space>
        )}
        width={700}
      >
        <Banner type="info" className="emp-import-hint" closeIcon={null} description={s.importHint} />
        {!imported && (
          <>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
              onChange={(e) => handleImportFile(e.target.files && e.target.files[0])}
            />
            <div className="emp-import-actions" style={{ marginTop: 0, marginBottom: 12 }}>
              <Button theme="solid" type="primary" icon={<IconUpload />} onClick={() => fileRef.current && fileRef.current.click()}>
                {s.pickFile}
              </Button>
              <Button icon={<IconExport />} onClick={() => window.open(`${import.meta.env.BASE_URL}templates/employee-import-template.xlsx`, '_blank')}>
                {s.tmplBtn}
              </Button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--semi-color-text-2)', margin: '0 0 6px' }}>{s.orPaste}</div>
            <TextArea
              value={csv}
              onChange={setCsv}
              placeholder={s.csvPh}
              rows={4}
              className="emp-csv"
            />
            <div className="emp-import-actions">
              <Button icon={<IconRefresh />} onClick={parseCsv}>{parsed.length ? s.reparse : s.parse}</Button>
              {parsed.length > 0 && <span className="emp-parsed-n">{s.parsedN(parsed.length)}</span>}
            </div>
            {parsed.length > 0 && (
              <Table
                className="emp-import-table"
                rowKey="employeeId"
                size="small"
                pagination={false}
                dataSource={parsed}
                {...resizableTable([
                  { title: s.iId, dataIndex: 'employeeId', width: 100, render: (v) => <Text strong className="tnum">{v}</Text> },
                  { title: s.iName, dataIndex: 'name', width: 110 },
                  { title: s.iDept, dataIndex: 'department', width: 110, render: (v) => v || <Text type="quaternary">—</Text> },
                  { title: s.iEmail, dataIndex: 'email', width: 220, render: (v) => v || <Text type="quaternary">—</Text> },
                  { title: s.iMgr, dataIndex: 'managerEmployeeId', width: 100, render: (v) => v ? <span className="tnum">{v}</span> : <Text type="quaternary">—</Text> },
                  { title: s.iHead, dataIndex: 'deptHead', width: 90, render: (v) => v ? <Tag color="indigo" type="light" shape="circle">{s.iHeadYes}</Tag> : <Text type="quaternary">—</Text> },
                ])}
              />
            )}
          </>
        )}
        {imported && (
          <>
            <div className="emp-import-actions">
              <span className="emp-parsed-n">{s.parsedN(imported.length)}</span>
              <Button theme="borderless" icon={<IconCopy />} onClick={copyAllPwd}>{s.copyAll}</Button>
            </div>
            <Table
              className="emp-import-table"
              rowKey="employeeId"
              size="small"
              pagination={false}
              dataSource={imported}
              {...resizableTable([
                { title: s.iId, dataIndex: 'employeeId', width: 110, render: (v) => <Text strong className="tnum">{v}</Text> },
                { title: s.iName, dataIndex: 'name', width: 110 },
                {
                  title: s.iStatus, dataIndex: 'status', width: 90,
                  render: (st) => (st === 'created'
                    ? <Tag color="green" type="light" shape="circle">{s.stCreated}</Tag>
                    : <Tag color="grey" type="light" shape="circle">{s.stSkipped}</Tag>),
                },
                {
                  title: s.iWarn, dataIndex: 'warning', width: 180,
                  render: (v, r) => (v ? <Tag color="amber" type="light" size="small">{(lang === 'zh' && r.warning_zh) || v}</Tag> : <Text type="quaternary">—</Text>),   // CX-129
                },
                {
                  title: s.iPwd,
                  dataIndex: 'password', width: 160,
                  render: (v, r) => (r.status === 'created'
                    ? (
                      <span className="emp-pwdcell">
                        <code>{v}</code>
                        <Button theme="borderless" size="small" icon={<IconCopy />} onClick={() => copyText(v, s.copied)} aria-label={s.copy} />
                      </span>
                    )
                    : <Text type="quaternary">{(lang === 'zh' && r.reason_zh) || r.reason || '—'}</Text>),
                },
              ])}
            />
          </>
        )}
      </Modal>

      {recImportVisible && <RecordsImportModal s={s} onClose={() => setRecImportVisible(false)} />}
    </div>
  );
}

/* ---- bulk import of talent records (header row maps onto the field config) ---- */
function RecordsImportModal({ s, onClose }) {
  const { loc } = useI18n();
  const cfgQ = useAsync(() => api.get('/api/admin/config/records'), []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // {list, rows}: the submitted rows are kept next to the server's per-row
  // results because a failing `field` is only a key, and a key is unique inside
  // one type (both 培训 and 荣誉 can own `score`) — the row tells us which type's
  // label to print.
  const [results, setResults] = useState(null);

  // A field carries two names now that the labels are split, so both have to be
  // offered: 期间 / Period / 「期间 Period」 all name the same column. Matching only
  // `label` (English) made every Chinese header match nothing — including the ones
  // in this dialog's own example — and the field columns were dropped in silence.
  const candidates = (...labels) => {
    const out = new Set();
    for (const raw of labels) {
      const L = String(raw || '').toLowerCase().trim();
      if (!L) continue;
      out.add(L);
      for (const part of L.split(/\s+/)) out.add(part);
    }
    return [...out];
  };
  const parseLine = (line) => {
    if (line.includes('\t')) return line.split('\t').map((x) => x.trim());
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
      else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };

  const submit = async (rows) => {
    setBusy(true);
    try {
      const r = await api.post('/api/admin/records/bulk', { rows });
      setResults({ list: r.results, rows });
      const created = r.results.filter((x) => x.status === 'created').length;
      Toast.success(s.riDone(created, r.results.length - created));
    } catch (err) { Toast.error(err.message); }
    setBusy(false);
  };

  const run = async () => {
    const cfg = cfgQ.data;
    if (!cfg) return;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) { Toast.error(s.riNeedHeader); return; }
    // Raw headers kept alongside the lowercased ones: matching is
    // case-insensitive, but a warning has to quote the column the way the user
    // typed it or they cannot find it in their spreadsheet.
    const rawHeaders = parseLine(lines[0]);
    const headers = rawHeaders.map((h) => h.toLowerCase());
    const FIXED = {
      employeeId: ['employeeid', 'employee id', '工号', 'id'],
      type: ['type', '类型'], date: ['date', '日期'], title: ['title', '标题'],
    };
    const colMap = headers.map((h) => {
      for (const [k, names] of Object.entries(FIXED)) if (names.includes(h)) return { fixed: k };
      const matches = cfg.fields.filter((f) => f.active && candidates(f.label, f.label_zh).includes(h));
      return matches.length ? { fieldsOf: matches } : null;
    });
    if (!['employeeId', 'type', 'date'].every((k) => colMap.some((c) => c && c.fixed === k))) {
      Toast.error(s.riNeedCols);
      return;
    }
    // moduleOff 的类型（所属模块未开启，例如 culture 关闭时的「行为实践」）不参与匹配：那一行原样提交，由服务端逐行
    // 回 skipped（record_type_unavailable），导入报告照常列出原因。
    const typeOf = (v) => {
      const t = String(v).toLowerCase().trim();
      return cfg.types.find((x) => !x.moduleOff && (x.key === t || candidates(x.label, x.label_zh).includes(t))) || null;
    };
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseLine(lines[i]);
      const row = { fields: {} };
      colMap.forEach((m, ci) => { if (m && m.fixed && cells[ci]) row[m.fixed] = cells[ci]; });
      const rt = typeOf(row.type || '');
      colMap.forEach((m, ci) => {
        if (!m || m.fixed || !cells[ci] || !rt) return;
        const f = m.fieldsOf.find((x) => x.typeKey === rt.key);
        if (f) row.fields[f.key] = cells[ci];
      });
      if (rt) row.type = rt.key;
      rows.push(row);
    }
    // Pre-flight, because the server cannot report this. A header that is
    // neither a fixed column nor a configured field is dropped silently: the row
    // still comes back `created`, just without that column, so per-row `reason`
    // never mentions it and a mistyped 「成绩」 looks like a clean import until
    // someone opens a profile weeks later. Warn, list the offenders, and let HR
    // decide — extra columns in an export are legitimate too.
    const unmatched = rawHeaders.filter((h, i) => h.trim() && !colMap[i]);
    if (unmatched.length) {
      Modal.confirm({
        title: s.riUnmatchedTitle,
        content: s.riUnmatched(unmatched.length, unmatched.join(' / ')),
        okText: s.riImportAnyway,
        cancelText: s.cancel,
        onOk: () => submit(rows),
      });
      return;
    }
    await submit(rows);
  };

  // Per-row outcome text. The server sends both the fixed bilingual `reason` and
  // a machine-readable {code, field} for the field-validation failures; we render
  // from the pair when we recognise the code and fall back to `reason` otherwise,
  // which also covers the row-level skips (unknown employee/type, bad date,
  // duplicate) that carry no code, and an older server that sends none at all.
  const rowText = (r) => {
    if (r.status === 'created') return s.riOk;
    const fields = (cfgQ.data && cfgQ.data.fields) || [];
    const typeKey = results && results.rows[r.line - 1] ? results.rows[r.line - 1].type : null;
    const f = r.field
      ? fields.find((x) => x.key === r.field && x.typeKey === typeKey) || fields.find((x) => x.key === r.field)
      : null;
    // No label to name the field with (config still loading, or the field was
    // deleted between paste and import) — the raw reason at least says something.
    if (!f) return r.reason;
    const label = loc(f, 'label');
    switch (r.code) {
      case 'field_required': return s.riErrRequired(label);
      case 'field_number': return s.riErrNumber(label);
      case 'field_date': return s.riErrDate(label);
      // The server sends the rejected value in `value`. It used to be lifted back out
      // of the English sentence with a regex, which meant rewording that sentence would
      // silently degrade this to a value-less message.
      case 'field_option': return s.riErrOption(label, r.value == null ? '' : String(r.value));
      default: return r.reason;
    }
  };

  return (
    <Modal visible title={s.riTitle} width={720} maskClosable={false} onCancel={onClose}
      onOk={run} okText={s.riRun} cancelText={s.cancel} confirmLoading={busy || cfgQ.loading}>
      <Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 10 }}>{s.riLead}</Text>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={s.riPh}
        style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', font: '12.5px/1.6 Consolas, monospace', resize: 'vertical' }} />
      {results && (
        <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 10, border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
          {results.list.map((r) => (
            <div key={r.line} style={{ color: r.status === 'created' ? 'var(--success)' : 'var(--danger)' }}>
              {r.status === 'created' ? '✓' : '✕'} {s.riLine(r.line)} {r.employeeId || '?'} · {rowText(r)}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}`}`