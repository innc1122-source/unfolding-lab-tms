// 一致性整改 2（2026-10-10 验收后）：后台数据表统一规则的包装。
//   · 标题列（titleKey）左锁定、min-width 220，不在单词中折行；操作列（opsKey）右锁定；
//   · scroll.x 按列宽求和（没写宽的列按 fallbackWidth 计），不再各页写死 760 / 670；
//   · 列经 cardify 带 data-label，≤ 768 由 app.css 切成卡片；
//   · 日期 / 数字列建议固定宽（页面自己给 width）。其余 props 原样透传给 Semi Table。
// 用法：<DataTable columns={cols} titleKey="name" opsKey="op" dataSource={rows} rowKey="id" />
import { Table } from '@douyinfe/semi-ui';
import { cardify } from '../cardify.js';

const TITLE_MIN = 220;

export function dataTableColumns(columns, { titleKey, opsKey, fallbackWidth = 120 } = {}) {
  return (columns || []).map((c) => {
    if (!c) return c;
    if (titleKey && c.dataIndex === titleKey) {
      return { ...c, fixed: c.fixed || 'left', width: Math.max(Number(c.width) || 0, TITLE_MIN), className: [c.className, 'dt-title'].filter(Boolean).join(' ') };
    }
    if (opsKey && c.dataIndex === opsKey) return { ...c, fixed: c.fixed || 'right', className: [c.className, 'dt-ops'].filter(Boolean).join(' ') };
    return c.width ? c : { ...c, width: fallbackWidth };
  });
}

export function dataTableScrollX(columns, fallbackWidth = 120) {
  return (columns || []).reduce((a, c) => a + (Number(c && c.width) || fallbackWidth), 0);
}

export default function DataTable({ columns, titleKey, opsKey, fallbackWidth, scroll, className, ...rest }) {
  const cols = cardify(dataTableColumns(columns, { titleKey, opsKey, fallbackWidth }));
  const x = dataTableScrollX(cols, fallbackWidth);
  return <Table columns={cols} scroll={{ x, ...(scroll || {}) }} className={['dt-table', className].filter(Boolean).join(' ')} {...rest} />;
}
