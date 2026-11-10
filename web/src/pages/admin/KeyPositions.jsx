// 关键岗位清单（12.2 工作台改版，设计 b12 §4 / §7.4；2026-10-09）。整页：/admin/talent-review/key-positions
// （App.jsx 在 talent 路由组内登记，rbac.js ADMIN_PAGES nav:false，与继任导入页同法）。
//
// 清单是「关键岗位继任覆盖率」的分母：isKey=1 的岗位计入，0 留在清单里但不计入。岗位名按服务端 positionKey 归并、全局唯一
// （同名岗位分属不同部门时在名称中区分）。接口（talent 读 / 写，服务端按数据范围裁剪）：
//   GET    /api/admin/key-positions            → { rows:[{ id, name, deptId, deptName, isKey, note, source, coverage:{ ready, oneYear, twoYears, total }, holders }],
//                                                  unmatchedSuccessionPositions:[string | { name, deptId?, deptName? }] }
//   POST   /api/admin/key-positions            { name, deptId, isKey, note } → { row, matchedSuccession }；409 position_exists（带已有行 id）；400 dept_out_of_scope
//   PUT    /api/admin/key-positions/:id        同上（行不在范围内 → 404）
//   DELETE /api/admin/key-positions/:id        硬删除，继任行不受影响
//   POST   /api/admin/key-positions/import/preview { rows, source } → { rows:[{ line, action, codes:[{code,level}], name, deptName, isKey, note }], summary, previewHash }
//   POST   /api/admin/key-positions/import         { rows, source, previewHash } → { created, updated, unchanged, skipped }
// 导入与继任导入同一交互：选择文件（浏览器端解析，表格读取复用 successionImport.js）→ 服务端逐行校验预览 → 确认弹窗写明
// 新增 / 更新 / 跳过行数 → 一次提交；409 preview_stale 自动重新预览。「从继任计划带入」把继任表里有、清单里没有的岗位名
// 生成预览行（source = succession），部门不唯一的行在预览里补选部门后重新预览。
// 只用现有 class 与 Semi 组件，不新增样式；手机宽度下表格经 resizableTable（cardify）变成逐行卡片，不横向滚动。
import { useUrlState } from '../../urlstate.js';
import { num } from '../../fmt.js';
import { saveCsv } from '../../csv.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Table, Tag, Toast, Banner, Spin, Modal, Typography, Input, Switch, TextArea, Popconfirm, Empty, Select } from '@douyinfe/semi-ui';
import { IconArrowLeft, IconUpload, IconExport, IconRefresh, IconPlus, IconSearch } from '@douyinfe/semi-icons';
import { api, useAsync } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useI18n } from '../../i18n.jsx';
import { canWriteDomain } from '../../rbac.js';
import { PAGE_TIERS, DEFAULT_PAGE } from '../../pagesize.js';
import { resizableTable } from '../../cardify.js';
import { dataTableColumns } from '../../components/DataTable.jsx';   // 一致性整改 2
import { errText } from '../../apierr.js';
import { useLeaveGuard, confirmLeave } from '../../components/useLeaveGuard.js';
import DeptFilter, { dpfModalProps, deptFilterInvalidText } from '../../components/DeptFilter.jsx';
import ReadOnlyPill from '../../components/ReadOnlyPill.jsx';
import { useDeptTree, deptMatcher, DEPT_NONE } from '../../deptfilter.js';
import { succSplitCsv, succSheetGrid, succSummary, SUCC_READINESS_TEXT } from './successionImport.js';

const { Text } = Typography;
const BACK_PATH = '/admin/talent-review?tab=succession';
const fmtN = (n) => num(n || 0);
const NAME_MAX = 80;      // 与 SUCC_IMPORT.POSITION_MAX 一致
const NOTE_MAX = 300;
const KP_MAX_ROWS = 1000; // 与服务端 validateRows 上限一致

/* ---------------- co-located bilingual strings ---------------- */
const T = {
  zh: {
    back: '返回继任计划',
    title: '关键岗位清单',
    sub: '维护计入继任覆盖率的关键岗位。继任者按岗位名称与继任计划自动关联，只统计你数据范围内的在职继任者。',
    roTip: '你的角色对人才发展只有查看权限，可以查看清单，不能新增、编辑、删除或导入。',
    searchPh: '搜索岗位名称或备注',
    uncoveredOnly: '只看未覆盖',
    uncoveredHint: '未覆盖：没有 1 年内就绪的继任者',
    add: '新增', importBtn: '导入', fromSucc: '从继任计划带入',
    shownN: (n, t) => `显示 ${fmtN(n)} / ${fmtN(t)} 个岗位`,
    loadFail: '加载失败',
    empty: '还没有关键岗位。可以逐个新增、从表格导入，或从继任计划带入已有的岗位名称。',
    emptyRo: '还没有关键岗位。',
    noMatch: '没有符合筛选条件的岗位',
    colName: '岗位名称', colDept: '所属部门', colReady: '就绪继任者（1 年内）', colTotal: '继任者总数', colHolders: '在任人数',
    colNote: '备注', colOps: '操作',
    nonKey: '非关键',
    uncovered: '未覆盖',
    edit: '编辑', del: '删除', cancel: '取消',
    delAsk: '删除这个关键岗位？',
    delDesc: '只从清单中移除，继任计划中的继任安排保持不变。',
    deleted: '已删除',
    succTitle: '范围内的继任者',
    succNone: '这个岗位还没有范围内的继任者。',
    succLoadFail: '继任者加载失败',
    addTitle: '新增关键岗位', editTitle: '编辑关键岗位',
    fName: '岗位名称', fDept: '所属部门', fIsKey: '计入继任覆盖率', fIsKeyHint: '关闭后岗位保留在清单中，但不计入覆盖率分母。', fNote: '备注',
    fNamePh: '例如：Team Lead - Sales', fDeptPh: '选择部门',
    needName: '请填写岗位名称', needDept: '请选择所属部门',
    save: '保存', saved: '已保存',
    matched: (n) => `已关联 ${fmtN(n)} 条继任安排`,
    existsTitle: '岗位已在清单中',
    existsBody: (n) => `清单中已有岗位「${n}」（名称只差大小写、空格或连字符也视为同一岗位）。`,
    existsGo: '查看已有岗位',
    deptScope: '所选部门不在你的数据范围内',
    posScope: '清单中已有同名岗位，但它所属的部门不在你的数据范围内',
    nameTooLong: `岗位名称不能超过 80 字`,
    noteTooLong: `备注不能超过 300 字`,
    notFound: '这个岗位已不存在或不在你的数据范围内，已刷新清单',
    // 导入
    impTitle: '导入关键岗位', succImpTitle: '从继任计划带入',
    impLead: '按模板填写岗位名称、所属部门、是否计入覆盖率与备注，然后上传。支持 .xlsx 与 .csv。',
    succImpLead: '以下是继任计划中出现、但尚未列入清单的岗位名称。部门无法自动确定的行，请在「所属部门」列选择后再导入。',
    tmpl: '下载 CSV 模板', pick: '上传表格（.xlsx / .csv）', repick: '重新选择文件',
    limitHint: `每次最多 1,000 行。岗位名称已在清单中时，更新部门、是否计入覆盖率与备注；有错误的行不会导入。`,
    fileFail: '文件读取失败，请确认是 .xlsx 或 .csv 格式',
    fileEmpty: '文件里没有可导入的数据行',
    headerOk: (n) => `已识别表头 ${n} 列`, noHeader: '未识别到表头，按模板列序读取',
    rowsN: (n) => `${fmtN(n)} 行数据`,
    overCap: (n) => `文件有 ${fmtN(n)} 行数据，超过每次 1,000 行的上限。请拆分成多个文件分批导入。`,
    noUnmatched: '继任计划中的岗位都已在清单中，没有需要带入的岗位。',
    step2: '预览与核对', step2Lead: '系统已逐行核对岗位名称、部门与数据范围。请确认每行的处理结果后再导入。',
    previewing: '正在核对…', previewFail: '预览失败', retry: '重新预览',
    tabAll: '全部', tabCreate: '将新增', tabUpdate: '将更新', tabUnchanged: '无变化', tabError: '有错误',
    tablist: '按处理结果筛选',
    actCreate: '将新增', actUpdate: '将更新', actUnchanged: '无变化', actError: '有错误',
    colLine: '行号', colAction: '处理结果', colIsKey: '计入覆盖率', colCodes: '说明',
    yes: '是', no: '否',
    pickDept: '选择部门',
    noRows: '没有符合的行',
    scopeBlock: (n) => `有 ${fmtN(n)} 行的部门或已有同名岗位不在你的数据范围内。只要有这类行，整批都不能导入；请删除或改正这些行后重新上传。`,
    nothingToDo: '没有需要写入的行（全部无变化或有错误）。',
    importN: (n) => `导入 ${fmtN(n)} 行`,
    confirmTitle: '确认导入关键岗位',
    confirmBody: (c, u) => `将导入 ${fmtN(c + u)} 行：新增 ${fmtN(c)} 行，更新 ${fmtN(u)} 行。`,
    confirmSkip: (e) => `${fmtN(e)} 行有错误，将跳过，不会导入。`,
    confirmSame: (n) => `${fmtN(n)} 行与清单现有内容相同，不做修改。`,
    confirmTx: '所有行在一次操作中写入；任一行写入失败时整批回滚，不会只导入一部分。',
    confirmOk: '确认导入',
    stale: '预览之后清单或部门数据有变化，已重新预览，请核对后再次确认。',
    outOfScope: (n) => `有 ${fmtN(n)} 行的部门或已有同名岗位不在你的数据范围内，本次未导入任何数据。`,
    overCapSrv: `超过每次 1,000 行的上限，本次未导入任何数据。`,
    importFail: '导入失败',
    doneTitle: '导入完成',
    doneBody: (r) => `新增 ${fmtN(r.created)} 行，更新 ${fmtN(r.updated)} 行，无变化 ${fmtN(r.unchanged)} 行，跳过 ${fmtN(r.skipped)} 行（有错误）。`,
    doneToast: (n) => `已导入 ${fmtN(n)} 个关键岗位`,
    backList: '返回清单',
    leaveAsk: '已选择的数据尚未导入，离开后需要重新选择。确定离开吗？',
  },
  en: {
    back: 'Back to succession plans',
    title: 'Key positions',
    sub: 'Maintain the key positions that count toward succession coverage. Successors are linked to a position by its name in the succession plans; only active successors within your data scope are counted.',
    roTip: 'Your role has read-only access to talent development: you can view the list but not add, edit, delete or import positions.',
    searchPh: 'Search position name or notes',
    uncoveredOnly: 'Uncovered only',
    uncoveredHint: 'Uncovered: no successor ready within 1 year',
    add: 'Add', importBtn: 'Import', fromSucc: 'Bring in from succession plans',
    shownN: (n, t) => `Showing ${fmtN(n)} of ${fmtN(t)} positions`,
    loadFail: 'Could not load',
    empty: 'No key positions yet. Add them one by one, import a spreadsheet, or bring in the position names already used in succession plans.',
    emptyRo: 'No key positions yet.',
    noMatch: 'No positions match the filters',
    // W4：表头文案要在列宽内按单词换行，不在单词中间断（130 / 90 / 80px）
    colName: 'Position', colDept: 'Department', colReady: 'Ready (within 1 yr)', colTotal: 'Successors', colHolders: 'Holders',
    colNote: 'Notes', colOps: 'Actions',
    nonKey: 'Not key',
    uncovered: 'Uncovered',
    edit: 'Edit', del: 'Delete', cancel: 'Cancel',
    delAsk: 'Delete this key position?',
    delDesc: 'It is removed from this list only; succession plan entries stay unchanged.',
    deleted: 'Deleted',
    succTitle: 'Successors within your scope',
    succNone: 'This position has no successors within your scope yet.',
    succLoadFail: 'Could not load successors',
    addTitle: 'Add key position', editTitle: 'Edit key position',
    fName: 'Position name', fDept: 'Department', fIsKey: 'Count toward succession coverage', fIsKeyHint: 'When off, the position stays on the list but is not counted in the coverage denominator.', fNote: 'Notes',
    fNamePh: 'e.g. Team Lead - Sales', fDeptPh: 'Select a department',
    needName: 'Enter a position name', needDept: 'Select a department',
    save: 'Save', saved: 'Saved',
    matched: (n) => `Linked to ${fmtN(n)} succession plan entr${n === 1 ? 'y' : 'ies'}`,
    existsTitle: 'Position already on the list',
    existsBody: (n) => `"${n}" is already on the list (names that differ only in case, spaces or hyphens count as the same position).`,
    existsGo: 'View existing position',
    deptScope: 'The selected department is outside your data scope',
    posScope: 'A position with this name is already on the list in a department outside your data scope',
    nameTooLong: `Position name cannot exceed 80 characters`,
    noteTooLong: `Notes cannot exceed 300 characters`,
    notFound: 'This position no longer exists or is outside your data scope. The list has been refreshed.',
    impTitle: 'Import key positions', succImpTitle: 'Bring in from succession plans',
    impLead: 'Fill in position name, department, whether it counts toward coverage, and notes using the template, then upload it. .xlsx and .csv are supported.',
    succImpLead: 'These position names appear in succession plans but are not on the list yet. Where the department cannot be determined automatically, choose it in the Department column before importing.',
    tmpl: 'Download CSV template', pick: 'Upload spreadsheet (.xlsx / .csv)', repick: 'Choose another file',
    limitHint: `Up to 1,000 rows per import. A position already on the list has its department, coverage setting and notes updated; rows with errors are not imported.`,
    fileFail: 'Could not read the file. Make sure it is .xlsx or .csv',
    fileEmpty: 'The file has no data rows to import',
    headerOk: (n) => `Header recognized · ${n} columns`, noHeader: 'No header recognized; read in template column order',
    rowsN: (n) => `${fmtN(n)} data rows`,
    overCap: (n) => `The file has ${fmtN(n)} data rows, more than the limit of 1,000 per import. Split it into several files and import them one by one.`,
    noUnmatched: 'Every position in the succession plans is already on the list. There is nothing to bring in.',
    step2: 'Preview and check', step2Lead: 'Each row has been checked for position name, department and data scope. Review the result for each row before importing.',
    previewing: 'Checking…', previewFail: 'Preview failed', retry: 'Preview again',
    tabAll: 'All', tabCreate: 'To add', tabUpdate: 'To update', tabUnchanged: 'Unchanged', tabError: 'Errors',
    tablist: 'Filter by result',
    actCreate: 'To add', actUpdate: 'To update', actUnchanged: 'Unchanged', actError: 'Error',
    colLine: 'Row', colAction: 'Result', colIsKey: 'Counts toward coverage', colCodes: 'Details',
    yes: 'Yes', no: 'No',
    pickDept: 'Select department',
    noRows: 'No matching rows',
    scopeBlock: (n) => `${fmtN(n)} row(s) point at a department or an existing position outside your data scope. Nothing can be imported while such rows remain; delete or correct them and upload again.`,
    nothingToDo: 'There are no rows to write (every row is unchanged or has an error).',
    importN: (n) => `Import ${fmtN(n)} row${n === 1 ? '' : 's'}`,
    confirmTitle: 'Confirm key position import',
    confirmBody: (c, u) => `${fmtN(c + u)} row(s) will be imported: ${fmtN(c)} added and ${fmtN(u)} updated.`,
    confirmSkip: (e) => `${fmtN(e)} row(s) have errors and will be skipped.`,
    confirmSame: (n) => `${fmtN(n)} row(s) match the list and will not change.`,
    confirmTx: 'All rows are written in a single operation; if any row fails, the whole import is rolled back and nothing is saved.',
    confirmOk: 'Import',
    stale: 'The list or department data changed after the preview. The preview has been refreshed; check it and confirm again.',
    outOfScope: (n) => `${fmtN(n)} row(s) point at a department or an existing position outside your data scope. Nothing was imported.`,
    overCapSrv: `More than 1,000 rows. Nothing was imported.`,
    importFail: 'Import failed',
    doneTitle: 'Import complete',
    doneBody: (r) => `${fmtN(r.created)} added, ${fmtN(r.updated)} updated, ${fmtN(r.unchanged)} unchanged, ${fmtN(r.skipped)} skipped (errors).`,
    doneToast: (n) => `${fmtN(n)} key position(s) imported`,
    backList: 'Back to the list',
    leaveAsk: 'The selected rows have not been imported. If you leave, you will need to choose them again. Leave this page?',
  },
};

// 导入校验码（服务端 modules/talent/key-positions.js validateRows）→ 中英文说明
const KP_CODE_TEXT = {
  zh: {
    name_required: '未填写岗位名称',
    name_too_long: `岗位名称超过 ${NAME_MAX} 字`,
    dept_required: '未填写所属部门',
    dept_unknown: '系统中没有这个部门',
    dept_out_of_scope: '该部门不在你的数据范围内；有这类行时整批不能导入',
    dup_in_file: '同一岗位在文件中重复出现，以第一次出现的行为准',
    is_key_invalid: '「是否计入覆盖率」无法识别，请填写：是 / 否',
    note_too_long: `备注超过 ${NOTE_MAX} 字`,
    position_out_of_scope: '清单中已有同名岗位，但它所属的部门不在你的数据范围内；有这类行时整批不能导入',
    name_merged: '与清单中已有岗位只差大小写、空格或连字符，沿用清单中的名称（导入不改名）',
  },
  en: {
    name_required: 'Position name is missing',
    name_too_long: `Position name is longer than ${NAME_MAX} characters`,
    dept_required: 'Department is missing',
    dept_unknown: 'No department has this name',
    dept_out_of_scope: 'This department is outside your data scope; nothing can be imported while such rows remain',
    dup_in_file: 'The same position appears more than once in the file; the first row is used',
    is_key_invalid: 'Counts toward coverage not recognized; use Yes / No',
    note_too_long: `Notes are longer than ${NOTE_MAX} characters`,
    position_out_of_scope: 'A position with this name is already on the list in a department outside your data scope; nothing can be imported while such rows remain',
    name_merged: 'Differs from a position on the list only in case, spaces or hyphens; the existing name is kept (an import never renames a position)',
  },
};

// ---- 导入解析纯函数（无 import、无 JSX；test/talent-tags-ui.test.js 按源码截取后直接跑）----
// 模板表头（下载的 CSV 第一行）
const KP_TEMPLATE_HEADERS = ['岗位名称 Position *', '所属部门 Department *', '计入覆盖率 Key (是/否 Y/N)', '备注 Notes'];
const KP_FIXED = { name: 0, dept: 1, isKey: 2, note: 3 };

const ACTIONS = ['create', 'update', 'unchanged', 'error'];
const ACTION_TAG = { create: 'green', update: 'blue', unchanged: 'grey', error: 'red' };
const ACTION_KEY = { create: 'actCreate', update: 'actUpdate', unchanged: 'actUnchanged', error: 'actError' };
const TAB_KEY = { all: 'tabAll', create: 'tabCreate', update: 'tabUpdate', unchanged: 'tabUnchanged', error: 'tabError' };
const DEPT_FIXABLE = ['dept_required', 'dept_unknown'];
// 校验码级别以服务端返回的 level 为准；没给时按 modules/talent/key-positions.js 的 CODES 兜底（只有 name_merged 是 info，未知码按错误）
const KP_INFO_CODES = ['name_merged'];
const SCOPE_CODES = ['dept_out_of_scope', 'position_out_of_scope'];

const codeOf = (c) => (c && typeof c === 'object' ? c.code : c);
const n0 = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const covOf = (r) => (r && r.coverage) || {};
const readyN = (r) => n0(covOf(r).ready, 0) + n0(covOf(r).oneYear, 0);
const isKeyRow = (r) => !(r && (r.isKey === 0 || r.isKey === false));
// 岗位名归并（展开继任者时前端对行；口径与服务端 positionKey 相同：NFKC、小写、去空白与各种连字符）
const posKey = (v) => String(v == null ? '' : v).normalize('NFKC').toLowerCase().replace(/[\s\-‐-―−]+/g, '');

// 表头单元格规范化（与 successionImport.js 同一口径）
const norm = (raw) => String(raw || '').replace(/[\s*_（）()【】\[\]:：·\-/]/g, '').toLowerCase();
function kpColumnOf(t) {
  if (/(备注|notes?$|^notes?|remarks?|comments?)/.test(t)) return 'note';
  if (/(部门|department|^dept)/.test(t)) return 'dept';
  if (/(覆盖|是否关键|关键岗位否|iskey|^key(yn|是否|$)|counts?toward)/.test(t)) return 'isKey';
  if (/(岗位|职位|position|^role$|keyrole)/.test(t)) return 'name';
  return null;
}
function kpHeaderMap(cells) {
  const map = { name: -1, dept: -1, isKey: -1, note: -1, hits: 0 };
  (cells || []).forEach((raw, i) => {
    const t = norm(raw);
    if (!t) return;
    const key = kpColumnOf(t);
    if (key && map[key] < 0) { map[key] = i; map.hits++; }
  });
  if (map.name < 0 || map.dept < 0) return null;
  return map;
}
// 表格 → { rows:[{ line, name, dept, isKey, note }], headerCols, overCap }，原始字符串；对错由服务端判定
function kpParseGrid(grid) {
  const body = (grid || [])
    .map((cells, i) => ({ cells: (Array.isArray(cells) ? cells : []).map((c) => String(c ?? '')), line: i + 1 }))
    .filter((r) => r.cells.some((c) => c.trim()));
  if (!body.length) return { rows: [], headerCols: 0, overCap: false };
  const hdr = kpHeaderMap(body[0].cells);
  const map = hdr || KP_FIXED;
  const data = hdr ? body.slice(1) : body;
  const at = (cells, i) => (i == null || i < 0 ? '' : String(cells[i] ?? '').trim());
  const rows = data
    .map(({ cells, line }) => ({ line, name: at(cells, map.name), dept: at(cells, map.dept), deptId: '', isKey: at(cells, map.isKey), note: at(cells, map.note) }))
    .filter((r) => r.name || r.dept || r.isKey || r.note);
  return { rows, headerCols: hdr ? hdr.hits : 0, overCap: rows.length > KP_MAX_ROWS };
}
const kpPayloadRows = (rows) => (rows || []).map((r) => ({
  line: r.line, name: String(r.name ?? ''), dept: String(r.dept ?? ''), deptId: String(r.deptId ?? ''),
  isKey: String(r.isKey ?? ''), note: String(r.note ?? ''),
}));
// 「从继任计划带入」：unmatchedSuccessionPositions（字符串或 { name, deptId, deptName }）→ 预览行
function rowsFromSuccession(list) {
  return (Array.isArray(list) ? list : []).map((x, i) => {
    const o = x && typeof x === 'object' ? x : { name: x };
    return { line: i + 1, name: String(o.name || o.positionName || ''), dept: String(o.deptName || o.dept || ''), deptId: String(o.deptId || ''), isKey: '', note: '' };
  }).filter((r) => r.name);
}
// ---- /导入解析纯函数 ----

export default function KeyPositions() {
  const { lang } = useI18n();
  const L = lang === 'zh' ? 'zh' : 'en';
  const s = T[L];
  const codeText = KP_CODE_TEXT[L];
  const readyText = SUCC_READINESS_TEXT[L];
  const navigate = useNavigate();
  const { user } = useAuth();
  const canWrite = canWriteDomain(user, 'talent');
  const tree = useDeptTree();
  const [sp] = useSearchParams();
  const [, patchUrl] = useUrlState();

  const listQ = useAsync(() => api.get('/api/admin/key-positions'), []);
  const data = listQ.data || {};
  const all = Array.isArray(data.rows) ? data.rows : (Array.isArray(listQ.data) ? listQ.data : []);
  const unmatched = Array.isArray(data.unmatchedSuccessionPositions) ? data.unmatchedSuccessionPositions : [];
  // 服务端按在任者部门预填好的带入行（modules/talent/key-positions.js rowsFromSuccession）优先；没有时按岗位名生成、部门留空
  const succRows = Array.isArray(data.successionRows) ? data.successionRows : null;

  // 筛选：搜索、部门（含下级）、只看未覆盖。工作台「查看名单」以 ?focus=<id> / ?uncovered=1 进入
  const [query, setQuery] = useState('');
  const [dept, setDept] = useState(null);
  const [onlyUncovered, setOnlyUncovered] = useState(sp.get('uncovered') === '1');
  const [focusId, setFocusId] = useState(sp.get('focus') || '');
  const [expanded, setExpanded] = useState(() => (sp.get('focus') ? [sp.get('focus')] : []));
  const deptOk = useMemo(() => deptMatcher(tree, dept), [tree, dept]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (focusId && r.id === focusId) return true;
      if (dept && !deptOk(r.deptName)) return false;
      if (onlyUncovered && (!isKeyRow(r) || readyN(r) > 0)) return false;
      if (!q) return true;
      return String(r.name || '').toLowerCase().includes(q) || String(r.note || '').toLowerCase().includes(q);
    });
  }, [all, query, dept, deptOk, onlyUncovered, focusId]);
  useEffect(() => {
    if (!focusId || !all.length) return;
    try {
      const el = document.querySelector(`[data-row-key="${CSS.escape(focusId)}"]`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    } catch { /* no DOM */ }
  }, [focusId, all.length]);

  // 展开行：该岗位范围内的继任者（GET /api/admin/succession 已按范围过滤；首次展开时取一次）
  const [succ, setSucc] = useState(null);       // null 未取；{ rows } | { error }
  const loadSucc = async () => {
    try { const r = await api.get('/api/admin/succession'); setSucc({ rows: Array.isArray(r) ? r : ((r && r.rows) || []) }); } catch (err) { setSucc({ error: err.message || s.succLoadFail }); }
  };
  useEffect(() => { if (expanded.length && !succ) loadSucc(); }, [expanded.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 新增 / 编辑 ---------- */
  const [form, setForm] = useState(null);       // { id?, name, deptId, isKey, note }
  const [saving, setSaving] = useState(false);
  const deptOptions = useMemo(
    () => ((tree && tree.options) || []).filter((o) => o && o.id && o.id !== DEPT_NONE && !String(o.id).startsWith('name:')),
    [tree],
  );
  const openAdd = () => setForm({ name: '', deptId: '', isKey: true, note: '' });
  const openEdit = (r) => setForm({ id: r.id, name: r.name || '', deptId: r.deptId || '', isKey: isKeyRow(r), note: r.note || '' });
  const goExisting = (id) => { setForm(null); setQuery(''); setDept(null); setOnlyUncovered(false); setFocusId(id); setExpanded([id]); };
  const errMap = {
    dept_out_of_scope: () => s.deptScope,
    position_out_of_scope: () => s.posScope,
    name_required: () => s.needName,
    dept_required: () => s.needDept,
    name_too_long: () => s.nameTooLong,
    note_too_long: () => s.noteTooLong,
    out_of_scope: (d) => s.outOfScope(n0(d.outOfScope, 0)),
    over_cap: () => s.overCapSrv,
    preview_stale: () => s.stale,
  };
  const msgOf = (err) => {
    const d = (err && err.data) || {};
    if (d.code && errMap[d.code]) return errText(err, errMap);
    if (lang === 'zh' && d.error_zh) return d.error_zh;
    return errText(err, errMap);
  };
  const saveForm = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { Toast.error(s.needName); return; }
    if (!form.deptId) { Toast.error(s.needDept); return; }
    const body = { name, deptId: form.deptId, isKey: !!form.isKey, note: form.note.trim() };
    setSaving(true);
    try {
      const res = form.id ? await api.put(`/api/admin/key-positions/${form.id}`, body) : await api.post('/api/admin/key-positions', body);
      const matched = n0(res && res.matchedSuccession, 0);
      Toast.success(matched > 0 ? `${s.saved} · ${s.matched(matched)}` : s.saved);
      setForm(null);
      listQ.reload();
    } catch (err) {
      const d = (err && err.data) || {};
      // CX-101：同名岗位在范围外时服务端不给 id —— 只提示「…所属的部门不在你的数据范围内」，不弹「查看已有岗位」
      if (err && err.status === 409 && d.code === 'position_exists' && !(d.id || d.existingId || (d.row && d.row.id))) {
        Toast.error(s.posScope);
      } else if (err && err.status === 409 && d.code === 'position_exists') {
        const existingId = d.id || d.existingId || (d.row && d.row.id);
        Modal.confirm({
          title: s.existsTitle,
          content: s.existsBody(d.existing || (d.row && d.row.name) || name),   // CX-019：引用清单里已有的写法
          okText: s.existsGo, cancelText: s.cancel,
          onOk: () => { if (existingId) goExisting(existingId); },
        });
      } else if (err && err.status === 404) {
        Toast.error(s.notFound); setForm(null); listQ.reload();
      } else {
        Toast.error(msgOf(err));
      }
    } finally {
      setSaving(false);
    }
  };
  const delRow = async (r) => {
    try { await api.del(`/api/admin/key-positions/${r.id}`); Toast.success(s.deleted); } catch (err) { Toast.error(err && err.status === 404 ? s.notFound : msgOf(err)); }
    listQ.reload();
  };

  /* ---------- 导入（文件 / 从继任计划带入） ---------- */
  const fileRef = useRef(null);
  const [imp, setImp] = useState(null);         // { source:'import'|'succession', fileName, rows, headerCols, overCap }
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const [tab, setTab] = useState('all');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const seq = useRef(0);
  useLeaveGuard(!!(imp && imp.rows.length && !result), s.leaveAsk);

  const runPreview = async (rows, source) => {
    const my = ++seq.current;
    setPreviewing(true);
    setPreviewErr('');
    try {
      const res = await api.post('/api/admin/key-positions/import/preview', { rows: kpPayloadRows(rows), source });
      if (my !== seq.current) return;
      setPreview(res || { rows: [], summary: {}, previewHash: '' });
    } catch (err) {
      if (my !== seq.current) return;
      setPreview(null);
      setPreviewErr(msgOf(err) || s.previewFail);
    } finally {
      if (my === seq.current) setPreviewing(false);
    }
  };
  const startImport = (next) => {
    seq.current += 1;
    setResult(null); setPreview(null); setPreviewErr(''); setTab('all'); setConfirmOpen(false);
    setImp(next);
    if (next && next.rows.length && !next.overCap) runPreview(next.rows, next.source);
  };
  const closeImport = () => {
    if (imp && imp.rows.length && !result && !confirmLeave()) return;
    seq.current += 1;
    setImp(null); setPreview(null); setPreviewErr(''); setPreviewing(false); setResult(null); setConfirmOpen(false);
    listQ.reload();
  };
  const handleFile = async (file) => {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let grid;
      if (/\.csv$/i.test(file.name)) {
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) { try { text = new TextDecoder('gb18030').decode(buf); } catch { /* 保留 UTF-8 结果 */ } }
        grid = succSplitCsv(text);
      } else {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(buf, { type: 'array' });
        grid = succSheetGrid(XLSX, wb.Sheets[wb.SheetNames[0]]);
      }
      const out = kpParseGrid(grid);
      if (!out.rows.length) { Toast.warning(s.fileEmpty); return; }
      startImport({ source: 'import', fileName: file.name, ...out });
    } catch {
      Toast.error(s.fileFail);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const pickFile = () => { if (fileRef.current) fileRef.current.click(); };
  const openFileImport = () => { startImport({ source: 'import', fileName: '', rows: [], headerCols: 0, overCap: false }); };
  const openFromSucc = () => {
    const rows = rowsFromSuccession(succRows || unmatched);
    if (!rows.length) { Toast.info(s.noUnmatched); return; }
    startImport({ source: 'succession', fileName: '', rows, headerCols: 0, overCap: rows.length > KP_MAX_ROWS });
  };
  const downloadTemplate = () => {
    saveCsv(KP_TEMPLATE_HEADERS.map((h) => `"${h.replace(/"/g, '""')}"`).join(',') + '\r\n', 'key-positions-template.csv');
  };
  // 预览里补选部门（dept_required / dept_unknown 的行）：改本地行后重新预览
  const setRowDept = (line, deptId) => {
    if (!imp) return;
    const o = deptOptions.find((x) => x.id === deptId);
    const rows = imp.rows.map((r) => (r.line === line ? { ...r, deptId: deptId || '', dept: o ? o.name : '' } : r));
    const next = { ...imp, rows };
    setImp(next);
    runPreview(rows, next.source);
  };

  const sm = useMemo(() => succSummary(preview), [preview]);
  const pRows = (preview && Array.isArray(preview.rows)) ? preview.rows : [];
  const pShown = tab === 'all' ? pRows : pRows.filter((r) => r && r.action === tab);
  const scopeRows = pRows.filter((r) => (r.codes || []).some((c) => SCOPE_CODES.includes(codeOf(c)))).length;
  const toWrite = sm.create + sm.update;
  const canImport = !!(preview && preview.previewHash) && toWrite > 0 && !scopeRows && !previewing;

  const submit = async () => {
    if (!imp || !preview) return;
    setSubmitting(true);
    try {
      const res = (await api.post('/api/admin/key-positions/import', { rows: kpPayloadRows(imp.rows), source: imp.source, previewHash: preview.previewHash })) || {};
      const done = {
        created: n0(res.created, sm.create), updated: n0(res.updated, sm.update),
        unchanged: n0(res.unchanged, sm.unchanged), skipped: n0(res.skipped, sm.error),
      };
      setConfirmOpen(false);
      setResult(done);
      Toast.success(s.doneToast(done.created + done.updated));
    } catch (err) {
      const code = err && err.data && err.data.code;
      setConfirmOpen(false);
      if (err && err.status === 409 && code === 'preview_stale') {
        Toast.warning(s.stale);
        setTab('all');
        runPreview(imp.rows, imp.source);
      } else {
        Toast.error(msgOf(err) || s.importFail);
      }
    } finally {
      setSubmitting(false);
    }
  };

  /* ---------- 渲染 ---------- */
  const goBack = () => { if (!confirmLeave()) return; navigate(BACK_PATH); };
  const cut = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const dash = <Text type="tertiary">—</Text>;

  const head = (
    <div className="co-page-bar kp-page-bar">{/* CX-089：返回链接在标题上方（与其他页一致），见 admin.css .kp-page-bar */}
      <Button theme="borderless" icon={<IconArrowLeft />} onClick={goBack}>{s.back}</Button>
      <div className="co-page-titles">
        <div className="u-title-line">
          <h1 className="co-page-title" title={s.title}>{s.title}</h1>
          {!canWrite && <ReadOnlyPill tip={s.roTip} />}
        </div>
        <div className="co-page-sub">{s.sub}</div>
      </div>
    </div>
  );

  const columns = [
    // W2：列宽合计（含展开列约 50px）要在 1440 宽的卡片内（约 1116px）放得下，不出横向滚动：200+150+130+90+80+140+130 = 920
    { title: s.colName, dataIndex: 'name', width: 200, render: (v, r) => (
      <span className="u-tag-wrap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: 'calc(100% - 28px)', verticalAlign: 'middle' }}>{/* CX-089：给展开箭头留位，不再把岗位名挤到下一行 */}
        <b style={cut} title={v}>{v}</b>
        {!isKeyRow(r) && <span className="pill muted">{s.nonKey}</span>}
        {isKeyRow(r) && readyN(r) === 0 && <span className="pill warn">{s.uncovered}</span>}
      </span>
    ) },
    { title: s.colDept, dataIndex: 'deptName', width: 150, render: (v) => (v ? <span style={cut} title={v}>{v}</span> : dash) },
    { title: s.colReady, dataIndex: 'ready', width: 130, render: (_, r) => <span className="tnum">{fmtN(readyN(r))}</span> },
    { title: s.colTotal, dataIndex: 'total', width: 110, render: (_, r) => <span className="tnum">{fmtN(n0(covOf(r).total, 0))}</span> },
    { title: s.colHolders, dataIndex: 'holders', width: 80, render: (v) => <span className="tnum">{fmtN(n0(v, 0))}</span> },
    { title: s.colNote, dataIndex: 'note', width: 140, render: (v) => (v ? <span style={cut} title={v}>{v}</span> : dash) },
    // W2：操作列不再固定在右侧（sticky 列会盖住备注列的省略号）；窄屏靠 scroll.x 横向滚动到操作列
    ...(canWrite ? [{ title: s.colOps, dataIndex: 'ops', width: 150, /* CX-089：130 放不下英文 Edit / Delete */ render: (_, r) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Button theme="borderless" size="small" onClick={() => openEdit(r)}>{s.edit}</Button>
        <Popconfirm title={s.delAsk} content={s.delDesc} okType="danger" okText={s.del} cancelText={s.cancel} onConfirm={() => delRow(r)}>
          <Button theme="borderless" size="small" type="danger">{s.del}</Button>
        </Popconfirm>
      </span>
    ) }] : []),
  ];

  const successorsOf = (r) => {
    if (!succ) return <Spin size="small" />;
    if (succ.error) return <Text type="danger">{s.succLoadFail} · {succ.error}</Text>;
    const k = posKey(r.name);
    const list = succ.rows.filter((x) => posKey(x.positionName) === k);
    if (!list.length) return <Text type="tertiary">{s.succNone}</Text>;
    return (
      <div>
        <div className="ppl-flabel">{s.succTitle}</div>
        <div className="ppl-chips" style={{ marginBottom: 0 }}>
          {list.map((x) => (
            <span key={x.id} className={'pill ' + (x.readiness === 'twoYears' ? 'muted' : 'pri')}>
              {x.name || x.userName || x.employeeId}{x.employeeId ? ` · ${x.employeeId}` : ''} · {readyText[x.readiness] || x.readiness}
            </span>
          ))}
        </div>
      </div>
    );
  };

  const previewColumns = [
    { title: s.colLine, dataIndex: 'line', width: 64, render: (v) => <span className="tnum">{v}</span> },
    { title: s.colAction, dataIndex: 'action', width: 104, render: (v) => (ACTION_TAG[v] ? <Tag size="small" type="light" color={ACTION_TAG[v]}>{s[ACTION_KEY[v]]}</Tag> : dash) },
    { title: s.colName, dataIndex: 'name', width: 200, render: (v) => (v ? <span style={cut} title={v}>{v}</span> : dash) },
    { title: s.colDept, dataIndex: 'deptName', width: 220, render: (v, r) => {
      const fixable = (r.codes || []).some((c) => DEPT_FIXABLE.includes(codeOf(c)));
      if (fixable) {
        const local = imp && imp.rows.find((x) => x.line === r.line);
        return (
          <Select size="small" filter showClear placeholder={s.pickDept} style={{ width: '100%' }}
            value={(local && local.deptId) || undefined} onChange={(v) => setRowDept(r.line, v || '')}
            optionList={deptOptions.map((o) => ({ label: o.path || o.name, value: o.id }))} />
        );
      }
      const name = v || r.dept;
      return name ? <span style={cut} title={name}>{name}</span> : dash;
    } },
    { title: s.colIsKey, dataIndex: 'isKey', width: 110, render: (v) => (v === undefined || v === null || v === '' ? dash
      : (v === true || v === 1 || v === '1') ? s.yes : (v === false || v === 0 || v === '0') ? s.no : <span title={String(v)}>{String(v)}</span>) },
    { title: s.colNote, dataIndex: 'note', width: 180, render: (v) => (v ? <span style={cut} title={v}>{v}</span> : dash) },
    { title: s.colCodes, dataIndex: 'codes', width: 280, render: (codes) => {
      const list = Array.isArray(codes) ? codes : [];
      if (!list.length) return dash;
      return list.map((c, i) => {
        const k = codeOf(c);
        const lvl = c && typeof c === 'object' && c.level ? c.level : (KP_INFO_CODES.includes(k) ? 'info' : 'error');
        const err = lvl === 'error';
        return (
          <Tag key={`${k}-${i}`} size="small" type="light" color={err ? 'red' : 'blue'} className="u-tag-wrap" style={{ margin: '0 4px 4px 0' }}>
            {codeText[k] || k}
          </Tag>
        );
      });
    } },
  ];

  /* ---------- 导入视图 ---------- */
  if (imp) {
    const fromSucc = imp.source === 'succession';
    return (
      <div className="wrap trev-wrap">
        {head}
        <div className="ppl-card">
          <div className="ppl-sec-h">
            <div><h2>{fromSucc ? s.succImpTitle : s.impTitle}</h2><div className="tset-lead">{fromSucc ? s.succImpLead : s.impLead}</div></div>
            <Button onClick={closeImport}>{s.backList}</Button>
          </div>
          {!fromSucc && (
            <>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={(e) => handleFile(e.target.files && e.target.files[0])} />
              <div className="u-filterbar">
                <Button icon={<IconExport />} onClick={downloadTemplate}>{s.tmpl}</Button>
                <Button theme="solid" type="primary" icon={<IconUpload />} disabled={submitting} onClick={pickFile}>
                  {imp.rows.length ? s.repick : s.pick}
                </Button>
                {imp.rows.length > 0 && (
                  <span className="u-tag-wrap" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0 }}>
                    <Text strong ellipsis={{ showTooltip: true }} style={{ maxWidth: 260 }}>{imp.fileName}</Text>
                    <span className="pill muted">{s.rowsN(imp.rows.length)}</span>
                    <span className={'pill ' + (imp.headerCols ? 'ok' : 'muted')}>{imp.headerCols ? s.headerOk(imp.headerCols) : s.noHeader}</span>
                  </span>
                )}
              </div>
              <div className="u-hint">{s.limitHint}</div>
            </>
          )}
        </div>

        {result && (
          <div className="ppl-card">
            <Banner type="success" fullMode={false} closeIcon={null} title={s.doneTitle} description={s.doneBody(result)} style={{ marginBottom: 12 }} />
            <div className="u-filterbar">
              <Button theme="solid" type="primary" onClick={closeImport}>{s.backList}</Button>
            </div>
          </div>
        )}

        {imp.rows.length > 0 && !result && (
          <div className="ppl-card">
            <div className="ppl-sec-h">
              <div><h2>{s.step2}</h2><div className="tset-lead">{s.step2Lead}</div></div>
            </div>
            {imp.overCap ? (
              <Banner type="danger" fullMode={false} closeIcon={null} description={s.overCap(imp.rows.length)} />
            ) : previewErr ? (
              <>
                <Banner type="danger" fullMode={false} closeIcon={null} description={`${s.previewFail} · ${previewErr}`} style={{ marginBottom: 12 }} />
                <Button icon={<IconRefresh />} onClick={() => runPreview(imp.rows, imp.source)}>{s.retry}</Button>
              </>
            ) : !preview ? (
              <div style={{ textAlign: 'center', padding: '32px 0' }}><Spin size="large" tip={s.previewing} /></div>
            ) : (
              <Spin spinning={previewing} tip={s.previewing}>
                {scopeRows > 0 && <Banner type="danger" fullMode={false} closeIcon={null} description={s.scopeBlock(scopeRows)} style={{ marginBottom: 12 }} />}
                {!scopeRows && toWrite === 0 && <Banner type="warning" fullMode={false} closeIcon={null} description={s.nothingToDo} style={{ marginBottom: 12 }} />}
                <div className="ppl-chips" role="tablist" aria-label={s.tablist}>
                  {['all', ...ACTIONS].map((k) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k}
                      className={'ppl-chip' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>
                      {s[TAB_KEY[k]]} <span className="tnum">{fmtN(k === 'all' ? sm.total : sm[k])}</span>
                    </button>
                  ))}
                </div>
                <Table size="small" rowKey={(r) => String(r.line)} dataSource={pShown}
                  empty={<Text type="tertiary">{s.noRows}</Text>}
                  pagination={pShown.length > DEFAULT_PAGE ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
                  {...resizableTable(previewColumns)} />
                <div className="u-filterbar" style={{ marginTop: 16, marginBottom: 0 }}>
                  <Button theme="solid" type="primary" disabled={!canImport} onClick={() => setConfirmOpen(true)}>{s.importN(toWrite)}</Button>
                  <Button icon={<IconRefresh />} disabled={previewing} onClick={() => runPreview(imp.rows, imp.source)}>{s.retry}</Button>
                  {sm.error > 0 && <Text type="danger">{s.confirmSkip(sm.error)}</Text>}
                </div>
              </Spin>
            )}
          </div>
        )}

        <Modal visible={confirmOpen} title={s.confirmTitle} maskClosable={false} closable={!submitting}
          onCancel={() => { if (!submitting) setConfirmOpen(false); }}
          footer={(
            <>
              <Button theme="borderless" disabled={submitting} onClick={() => setConfirmOpen(false)}>{s.cancel}</Button>
              <Button theme="solid" type="primary" loading={submitting} disabled={!canImport} onClick={submit}>{s.confirmOk}</Button>
            </>
          )}>
          <p style={{ margin: '0 0 8px' }}><b>{s.confirmBody(sm.create, sm.update)}</b></p>
          {sm.error > 0 && <p style={{ margin: '0 0 8px' }}><Text type="danger">{s.confirmSkip(sm.error)}</Text></p>}
          {sm.unchanged > 0 && <p style={{ margin: '0 0 8px' }}>{s.confirmSame(sm.unchanged)}</p>}
          <div className="u-hint">{s.confirmTx}</div>
        </Modal>
      </div>
    );
  }

  /* ---------- 清单视图 ---------- */
  return (
    <div className="wrap trev-wrap">
      {head}

      <div className="ppl-card">
        <div className="u-filterbar">
          <Input prefix={<IconSearch />} showClear placeholder={s.searchPh} value={query} onChange={(v) => { setQuery(v); setFocusId(''); }} className="u-w-lg" />
          <DeptFilter options={tree ? tree.options : []} value={dept} onChange={(v) => { setDept(v || null); setFocusId(''); }} lang={lang}
            showNone={!!(tree && tree.hasNone)} disabled={tree === null} ready={!!tree}
            onInvalid={() => { Toast.info(deptFilterInvalidText(lang)); setDept(null); }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} title={s.uncoveredHint}>
            <Switch size="small" checked={onlyUncovered} aria-label={s.uncoveredOnly}
              onChange={(v) => { setOnlyUncovered(v); setFocusId(''); if (sp.get('uncovered') || sp.get('focus')) patchUrl({ uncovered: null, focus: null }, { push: false }); }} />
            <Text>{s.uncoveredOnly}</Text>
          </span>
          {canWrite && (
            <span className="u-filterbar-end" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>
              <Button onClick={openFromSucc} disabled={listQ.loading}>{s.fromSucc}</Button>
              <Button icon={<IconUpload />} onClick={openFileImport}>{s.importBtn}</Button>
              <Button theme="solid" type="primary" icon={<IconPlus />} onClick={openAdd}>{s.add}</Button>
            </span>
          )}
        </div>
        <Text type="tertiary" size="small" style={{ display: 'block', marginBottom: 10 }}>{s.shownN(shown.length, all.length)} · {s.uncoveredHint}</Text>

        {listQ.error ? (
          <Banner type="danger" fullMode={false} closeIcon={null} description={`${s.loadFail} · ${listQ.error.message}`} />
        ) : listQ.loading && !listQ.data ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}><Spin size="large" /></div>
        ) : !all.length ? (
          <Empty description={canWrite ? s.empty : s.emptyRo} style={{ padding: 24 }} />
        ) : (
          <Table size="small" rowKey="id" dataSource={shown} className="kp-table" scroll={{ x: columns.reduce((a, c) => a + (c.width || 120), 0) }}
            empty={<Empty description={s.noMatch} style={{ padding: 20 }} />}
            expandedRowKeys={expanded}
            onExpandedRowsChange={(rows) => setExpanded((rows || []).map((r) => (r && typeof r === 'object' ? r.id : r)))}
            expandedRowRender={(r) => successorsOf(r)}
            rowExpandable={() => true}
            pagination={shown.length > DEFAULT_PAGE ? { pageSize: DEFAULT_PAGE, pageSizeOpts: PAGE_TIERS, showSizeChanger: true, formatPageText: false } : false}
            {...resizableTable(dataTableColumns(columns, { titleKey: 'name', opsKey: 'ops' }), { extra: 48 })} />
        )}
      </div>

      {/* 新增 / 编辑：短表单用弹窗（「短操作弹窗、长编辑整页」）；部门选择器放在 Modal 里用 dpfModalProps */}
      <Modal {...dpfModalProps()} visible={!!form} title={form && form.id ? s.editTitle : s.addTitle} width={560}
        className="u-modal-visible" maskClosable={false} closable={!saving}
        onCancel={() => { if (!saving) setForm(null); }}
        footer={(
          <>
            <Button theme="borderless" disabled={saving} onClick={() => setForm(null)}>{s.cancel}</Button>
            <Button theme="solid" type="primary" loading={saving} onClick={saveForm}>{s.save}</Button>
          </>
        )}>
        {form && (
          <div>
            <div className="ppl-flabel">{s.fName}<span className="ppl-req">*</span></div>
            <Input value={form.name} maxLength={NAME_MAX} showClear placeholder={s.fNamePh} onChange={(v) => setForm((m) => ({ ...m, name: v }))} />
            <div className="ppl-flabel" style={{ marginTop: 12 }}>{s.fDept}<span className="ppl-req">*</span></div>
            <DeptFilter options={deptOptions} value={form.deptId || null} onChange={(v) => setForm((m) => ({ ...m, deptId: v || '' }))} lang={lang}
              placeholder={s.fDeptPh} disabled={tree === null} ready={!!tree} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <Switch checked={!!form.isKey} onChange={(v) => setForm((m) => ({ ...m, isKey: v }))} aria-label={s.fIsKey} />
              <Text>{s.fIsKey}</Text>
            </div>
            <div className="u-hint">{s.fIsKeyHint}</div>
            <div className="ppl-flabel" style={{ marginTop: 12 }}>{s.fNote}</div>
            <TextArea value={form.note} maxCount={NOTE_MAX} maxLength={NOTE_MAX} autosize={{ minRows: 2, maxRows: 5 }} onChange={(v) => setForm((m) => ({ ...m, note: v }))} />
          </div>
        )}
      </Modal>
    </div>
  );
}
