// 继任计划批量导入：浏览器端解析（第 5 批 8.2，设计 §9.1 / §9.2；2026-10-08）。
// 纯 ESM、零依赖：SuccessionImport.jsx、web/scripts/succession-template.mjs 与 test/succession-import-parse.test.js 共用。
//
// 只做「表格 → 原始行」：
//   - 表头识别中英文与不同写法（去掉空白、星号、括号后比较，与 questionImport.js 的 norm 同一口径）；
//   - 没有能识别的表头时按固定列序（SUCC_FIXED，即模板的列序）读取；
//   - 跳过空行，保留 Excel 行号 line；
//   - 输出 [{ line, positionName, employeeId, name, readiness, note }]，全是去掉首尾空白的原始字符串。
// 数据对不对（工号是否存在、就绪度写法、岗位归并、重复、数据范围）一律由服务端
// POST /api/admin/succession/import/preview 逐行判定，前端不判断，免得两边口径不一致。

// 模板表头（web/public/templates/succession-import-template.xlsx 的第一行，由 web/scripts/succession-template.mjs 生成）
export const SUCC_TEMPLATE_HEADERS = [
  '关键岗位 Key position *',
  '继任人工号 Successor employee ID *',
  '继任人姓名 Name（核对用，选填）',
  '就绪度 Readiness *',
  '备注 Notes',
];

// 固定列序（无表头时）：与模板列序相同
export const SUCC_FIXED = { positionName: 0, employeeId: 1, name: 2, readiness: 3, note: 4 };

// 每次最多导入的行数（与服务端 over_cap 同一口径；超过时前端提示、不截断、不发预览请求）
export const SUCC_MAX_ROWS = 2000;

// 就绪度取值（服务端存的键）。说明页与预览表的中英文文字与 TalentReview 继任卡一致。
export const SUCC_READINESS = ['ready', 'oneYear', 'twoYears'];
export const SUCC_READINESS_TEXT = {
  zh: { ready: '即刻就绪', oneYear: '1–2 年内就绪', twoYears: '2 年以上就绪' },
  en: { ready: 'Ready now', oneYear: 'Ready in 1–2 years', twoYears: 'Ready in 2+ years' },
};

// 服务端校验码（设计 §9.3）→ 级别与中英文说明。级别以服务端返回的 level 为准，这里的 level 只在服务端没给时兜底。
export const SUCC_CODES = {
  position_required: 'error',
  position_too_long: 'error',
  employee_required: 'error',
  employee_not_found: 'error',
  employee_out_of_scope: 'error',
  employee_inactive: 'error',
  readiness_required: 'error',
  readiness_invalid: 'error',
  note_too_long: 'error',
  duplicate_in_file: 'error',
  position_merged: 'info',
  position_new: 'info',
  name_mismatch: 'info',
  successor_is_holder: 'info',
};
export const SUCC_CODE_TEXT = {
  zh: {
    position_required: '未填写关键岗位',
    position_too_long: '关键岗位超过 80 字',
    employee_required: '未填写继任人工号',
    employee_not_found: '系统中没有这个工号',
    employee_out_of_scope: '该员工不在你的数据范围内；有这类行时整批不能导入',
    employee_inactive: '该员工已离职或账号已停用',
    readiness_required: '未填写就绪度',
    readiness_invalid: '就绪度无法识别，请填写：即刻就绪 / 1–2 年内就绪 / 2 年以上就绪',
    note_too_long: '备注超过 300 字',
    duplicate_in_file: '同一岗位、同一继任人在文件中重复出现，以第一次出现的行为准',
    position_merged: '与已有岗位只差大小写、空格或连字符，已按已有岗位名称导入',
    position_new: '新的关键岗位',
    name_mismatch: '填写的姓名与该工号在系统中的姓名不一致，请核对',
    successor_is_holder: '该继任人目前就在这个岗位上',
  },
  en: {
    position_required: 'Key position is missing',
    position_too_long: 'Key position is longer than 80 characters',
    employee_required: 'Successor employee ID is missing',
    employee_not_found: 'No employee has this employee ID',
    employee_out_of_scope: 'This employee is outside your data scope — the file cannot be imported while such rows remain',
    employee_inactive: 'This employee has left or the account is deactivated',
    readiness_required: 'Readiness is missing',
    readiness_invalid: 'Readiness not recognized — use Ready now / Ready in 1–2 years / Ready in 2+ years',
    note_too_long: 'Notes are longer than 300 characters',
    duplicate_in_file: 'Same key position and successor appear more than once in the file — the first row is used',
    position_merged: 'Differs from an existing key position only in case, spaces or hyphens — imported under the existing name',
    position_new: 'New key position',
    name_mismatch: 'The name entered differs from the name on file for this employee ID — please check',
    successor_is_holder: 'This successor currently holds this position',
  },
};

// 表头单元格 → 规范化文本：去空白、括号、星号、冒号、点、连字符，转小写（与 questionImport.js 的 norm 相同）。
const norm = (raw) => String(raw || '').replace(/[\s*_（）()【】\[\]:：·\-]/g, '').toLowerCase();

// 一个表头单元格属于哪一列。表头通常是「中文 + 英文」写在同一格里，所以按「包含」判断；
// 顺序有讲究：先认工号、就绪度、备注，再认岗位，最后认姓名（「Position name」应算岗位，不算姓名）。
function columnOf(t) {
  if (/(工号|员工编号|员工号|employeeid|employeeno|employeenumber|staffid|empid|^id$)/.test(t)) return 'employeeId';
  if (/(就绪|准备度|readiness|^ready$)/.test(t)) return 'readiness';
  if (/(备注|notes?$|^notes?|remarks?|comments?)/.test(t)) return 'note';
  if (/(岗位|职位|position|^role$|keyrole)/.test(t)) return 'positionName';
  if (/(姓名|名字|^name|name$|fullname)/.test(t)) return 'name';
  return null;
}

// 表头行 → 列号映射；不是表头时返回 null。必须同时认出「关键岗位」和「工号」两列，数据行不会被误当成表头。
export function succHeaderMap(cells) {
  const map = { positionName: -1, employeeId: -1, name: -1, readiness: -1, note: -1, hits: 0 };
  (cells || []).forEach((raw, i) => {
    const t = norm(raw);
    if (!t) return;
    const key = columnOf(t);
    if (key && map[key] < 0) { map[key] = i; map.hits++; }
  });
  if (map.positionName < 0 || map.employeeId < 0) return null;
  return map;
}

// CSV 文本 → 表格（支持双引号包裹、引号内的逗号与换行、"" 转义；去掉 BOM）。
export function succSplitCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const grid = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r' && src[i + 1] === '\n') continue;
    if (ch === '\n' || ch === '\r') { row.push(cell); grid.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); grid.push(row); }
  return grid;
}

// SheetJS 工作表 → 表格。XLSX 由调用方传入（页面里是懒加载的 import('xlsx')，脚本与测试各自加载），本模块保持零依赖。
// 范围从 A1 开始取（工作表的 !ref 可能从第 3 行才开始），保留空行，这样表格下标 + 1 就是 Excel 行号。
export function succSheetGrid(XLSX, ws) {
  if (!ws || !ws['!ref']) return [];
  const r = XLSX.utils.decode_range(ws['!ref']);
  return XLSX.utils.sheet_to_json(ws, {
    header: 1, raw: false, defval: '', blankrows: true,
    range: { s: { r: 0, c: 0 }, e: r.e },
  });
}

// 表格（下标 0 = Excel 第 1 行）→ { rows, headerCols, overCap }。
//   rows：[{ line, positionName, employeeId, name, readiness, note }]，原始字符串（去首尾空白）
//   headerCols：认出的表头列数（0 = 没有表头，按固定列序读取）
//   overCap：数据行超过 SUCC_MAX_ROWS（页面据此提示，不截断、不发预览请求）
export function succParseGrid(grid) {
  const body = (grid || [])
    .map((cells, i) => ({ cells: (Array.isArray(cells) ? cells : []).map((c) => String(c ?? '')), line: i + 1 }))
    .filter((r) => r.cells.some((c) => c.trim()));
  if (!body.length) return { rows: [], headerCols: 0, overCap: false };
  const hdr = succHeaderMap(body[0].cells);
  const map = hdr || SUCC_FIXED;
  const data = hdr ? body.slice(1) : body;
  const at = (cells, i) => (i == null || i < 0 ? '' : String(cells[i] ?? '').trim());
  const rows = data
    .map(({ cells, line }) => ({
      line,
      positionName: at(cells, map.positionName),
      employeeId: at(cells, map.employeeId),
      name: at(cells, map.name),
      readiness: at(cells, map.readiness),
      note: at(cells, map.note),
    }))
    // 只有未映射的列有内容（例如表头外的额外列）的行，读出来五项全空：同样当空行跳过
    .filter((r) => r.positionName || r.employeeId || r.name || r.readiness || r.note);
  return { rows, headerCols: hdr ? hdr.hits : 0, overCap: rows.length > SUCC_MAX_ROWS };
}

// 预览 / 提交请求体里的行：只带接口约定的六个字段
export function succPayloadRows(rows) {
  return (rows || []).map((r) => ({
    line: r.line,
    positionName: String(r.positionName ?? ''),
    employeeId: String(r.employeeId ?? ''),
    name: String(r.name ?? ''),
    readiness: String(r.readiness ?? ''),
    note: String(r.note ?? ''),
  }));
}

// 预览行的校验码级别：服务端给了 level 就用它，否则按 SUCC_CODES 兜底（未知码按错误处理）
export function succCodeLevel(c) {
  if (c && (c.level === 'error' || c.level === 'info' || c.level === 'warn' || c.level === 'warning')) return c.level === 'error' ? 'error' : 'info';
  const k = c && typeof c === 'object' ? c.code : c;
  return SUCC_CODES[k] === 'info' ? 'info' : 'error';
}

// 预览汇总：优先用服务端的 summary，缺项时按行重算
export function succSummary(preview) {
  const rows = (preview && Array.isArray(preview.rows)) ? preview.rows : [];
  const count = (a) => rows.filter((r) => r && r.action === a).length;
  const sm = (preview && preview.summary) || {};
  const pick = (k) => (Number.isFinite(Number(sm[k])) && sm[k] !== null && sm[k] !== '' ? Number(sm[k]) : count(k));
  return { create: pick('create'), update: pick('update'), unchanged: pick('unchanged'), error: pick('error'), total: rows.length };
}
