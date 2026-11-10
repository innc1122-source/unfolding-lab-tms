// 后台「点数字看名单」弹窗（简化 10/11：绩效看板的 Drill 与评估周期看板的 RvcDrill 原来逐行相同，合成这一份）。
// 搜索（姓名 / 工号）、按姓名排序、每页 10 人；列由调用方传入，手机宽度切卡片（见 DataTable）。
// CX-061：弹窗里不锁姓名列 —— 锁列会把姓名列撑到最小 220px，列宽合计超过弹窗正文（808px）出现横向滚动；
// 横向宽度沿用合并前两份弹窗写死的 760（不按列宽求和），三种名单（普通、申诉、人才信号）都与合并前一致。
// drill = { title, items } 或 null（关闭）；s 需要 searchPh、shown(n, total)、drillEmpty 三个文案。
import { useEffect, useMemo, useState } from 'react';
import { Modal, Input, Typography } from '@douyinfe/semi-ui';
import DataTable from './DataTable.jsx';

const { Text } = Typography;

export default function DrillModal({ drill, s, columns, onClose }) {
  const [kw, setKw] = useState('');
  useEffect(() => { setKw(''); }, [drill]);
  const list = useMemo(() => {
    const all = (drill && drill.items) || [];
    const k = kw.trim().toLowerCase();
    const hit = k ? all.filter((i) => String(i.name || '').toLowerCase().includes(k) || String(i.employeeId || '').toLowerCase().includes(k)) : all;
    return hit.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }, [drill, kw]);
  return (
    <Modal visible={!!drill} title={drill ? drill.title : ''} width="min(860px, calc(100vw - 24px))" footer={null} onCancel={onClose}>
      <div className="rvc-filters">
        <Input value={kw} onChange={setKw} placeholder={s.searchPh} showClear style={{ width: 220 }} />
        <Text type="tertiary" size="small">{s.shown(list.length, (drill && drill.items.length) || 0)}</Text>
      </div>
      <DataTable rowKey="id" size="small" dataSource={list} className="dt-drill" scroll={{ x: 760 }}
        empty={<Text type="tertiary" size="small">{s.drillEmpty}</Text>}
        pagination={list.length > 10 ? { pageSize: 10, formatPageText: false } : false}
        columns={columns} />
    </Modal>
  );
}
