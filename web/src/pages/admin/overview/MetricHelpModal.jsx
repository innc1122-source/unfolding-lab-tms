// 「指标口径」弹窗（第三批 4.1，设计 §2.5）：只读说明，短内容用弹窗。参训覆盖率的定义放第一条（以完成为准，UX 审查 9）。
import { Modal, Button } from '@douyinfe/semi-ui';

export default function MetricHelpModal({ s, visible, onClose }) {
  return (
    <Modal title={s.helpTitle} visible={visible} onCancel={onClose} footer={<Button theme="solid" onClick={onClose}>{s.close}</Button>}>
      <ul className="ovx-help">
        {s.helpLines.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </Modal>
  );
}
