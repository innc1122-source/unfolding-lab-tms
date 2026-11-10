// 生成继任计划批量导入模板 succession-import-template.xlsx（第 5 批 8.2，设计 §9.1；2026-10-08）。
//
//   cd web && ..\runtime\node.exe scripts\succession-template.mjs
//
// 写两份（与 question-template.mjs 同一写法）：
//   web/public/templates/succession-import-template.xlsx —— 源文件。vite 的 publicDir 是 web/public，
//     `vite build` 会把它原样拷进 public/dist/templates/，所以构建清空 dist 后模板也会回来。
//   public/dist/templates/succession-import-template.xlsx —— 当前线上读取的那份，免得非得重新构建才生效。
//
// 表头取自 src/pages/admin/successionImport.js 的 SUCC_TEMPLATE_HEADERS，与解析器是同一份定义；
// test/succession-import-parse.test.js 会读回生成的文件，用解析器逐行检查示例行都能解析。
// SheetJS 社区版写不了数据有效性下拉，所以就绪度的取值写在「填写说明」页，导入时由服务端校验。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { SUCC_TEMPLATE_HEADERS, SUCC_MAX_ROWS, SUCC_READINESS, SUCC_READINESS_TEXT } from '../src/pages/admin/successionImport.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTS = [
  path.join(WEB, 'public', 'templates', 'succession-import-template.xlsx'),
  path.join(WEB, '..', 'public', 'dist', 'templates', 'succession-import-template.xlsx'),
];

// 示例行：工号用 T-00001 这类占位格式（测试库的假工号写法），姓名、岗位都是虚构的
const EXAMPLES = [
  ['财务经理 Finance Manager', 'T-00001', '示例员工 A', '1–2 年内就绪', '已完成财务分析轮岗'],
  ['财务经理 Finance Manager', 'T-00002', '', 'Ready now', ''],
];

const R = SUCC_READINESS_TEXT;
const NOTES = [
  ['继任计划批量导入模板 · Succession plan import template'],
  [''],
  ['必填列：关键岗位、继任人工号、就绪度。示例行请删除后再填写。 · Required: Key position, Successor employee ID, Readiness. Delete the example rows before filling in.'],
  [''],
  ['就绪度可填写以下任一写法（不分大小写）： · Readiness — any of these spellings (case-insensitive):'],
  ...SUCC_READINESS.map((k) => [`  ${R.zh[k]} / ${R.en[k]} / ${k}`]),
  ['  也可简写为：即刻、1-2年、2年以上。 · Short forms also accepted: 即刻, 1-2年, 2年以上.'],
  [''],
  ['关键岗位：每行填写一个岗位名称，最多 80 字。与已有岗位只差大小写、空格或连字符时，导入后按已有岗位名称归并；预览时会逐行提示。'],
  ['Key position: one position name per row, up to 80 characters. A name that differs from an existing key position only in case, spaces or hyphens is merged into the existing name; the preview flags each such row.'],
  ['继任人工号：填写员工工号（如 T-00001），不分大小写；只能导入你数据范围内、在职的员工。'],
  ['Successor employee ID: the employee ID (e.g. T-00001), case-insensitive. Only active employees within your data scope can be imported.'],
  ['继任人姓名：选填，仅用于核对；与系统中的姓名不一致时，预览会提示，但不影响导入。'],
  ['Name: optional and used only as a check; a mismatch is flagged in the preview but does not block the import.'],
  ['备注：选填，最多 300 字。已有的「岗位 + 继任人」组合会更新就绪度和备注；备注留空时保留原备注。'],
  ['Notes: optional, up to 300 characters. An existing key position + successor pair has its readiness and notes updated; a blank note keeps the existing note.'],
  [`每次最多导入 ${SUCC_MAX_ROWS.toLocaleString('en-US')} 行。 · Up to ${SUCC_MAX_ROWS.toLocaleString('en-US')} rows per import.`],
  [''],
  ['使用方法 · How to use'],
  ['1. 删除示例行，从第 2 行开始填写。 · Delete the example rows and fill in from row 2.'],
  ['2. 后台 → 人才盘点 → 继任计划 →「批量导入」→ 上传本文件。 · Console → Talent Review → Succession plans → Bulk import → upload this file.'],
  ['3. 核对预览：每行显示将新增、将更新、无变化或有错误，以及原因。有错误的行不会导入，确认弹窗会写明数量。 · Check the preview: each row shows whether it will be added, updated, left unchanged or has an error, with the reason. Rows with errors are skipped, and the confirmation states how many.'],
];

const ws = XLSX.utils.aoa_to_sheet([SUCC_TEMPLATE_HEADERS, ...EXAMPLES]);
ws['!cols'] = [{ wch: 28 }, { wch: 26 }, { wch: 26 }, { wch: 20 }, { wch: 40 }];
ws['!freeze'] = { xSplit: 0, ySplit: 1 };
const notes = XLSX.utils.aoa_to_sheet(NOTES);
notes['!cols'] = [{ wch: 120 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '继任计划 Succession');
XLSX.utils.book_append_sheet(wb, notes, '填写说明 Instructions');

for (const out of OUTS) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  XLSX.writeFile(wb, out);
  console.log('wrote', path.relative(path.join(WEB, '..'), out));
}
