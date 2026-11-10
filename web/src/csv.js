// CSV 导出（简化 10/11：原来员工档案、评估周期、关键岗位、人才筛选、人才盘点五处各写一份）。
// csvCell 与 server.js 的 csvEscape() 同一口径，含防 Excel 公式注入的前置单引号（CWE-1236）。
export function csvCell(v) {
  let t = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// 二维数组 → CSV 文本；CRLF 分行（Excel 按此识别）
export function csvText(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 下载一段 CSV 文本。开头补 BOM（fetch 的 text() 会去掉它），Excel 才按 UTF-8 打开中文。
export function saveCsv(text, fileName) {
  const t = String(text || '');
  const body = t.charAt(0) === '﻿' ? t : '﻿' + t;
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 稍后再释放 —— 同步释放可能取消下载
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
