// 员工端统一的弹窗外壳（简化 10/11；不引 Semi）。原来 10 处各自手写遮罩 + 对话框，7 处不响应 Esc、5 处没有 aria-modal。
// 行为统一在这里：Esc 与点遮罩关闭（busy 时不关）、role="dialog" + aria-modal、点对话框内部不冒泡到遮罩。
// 两种既有样式原样保留：kind="apply" → .apply-mask > .apply-box（申请、签到、请假等）；kind="exam" → .exam-overlay > .exam-dialog（交卷、申诉确认等）。
// escape={false}：页面自己已经处理 Esc 时关掉这里的监听，免得关两次。
import { useEffect } from 'react';

export default function Overlay({ kind = 'apply', className, boxClassName, onClose, busy, label, labelledBy, style, escape = true, children }) {
  useEffect(() => {
    if (!escape || !onClose) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escape, busy, onClose]);
  const mask = kind === 'exam' ? 'exam-overlay' : 'apply-mask';
  const box = kind === 'exam' ? 'exam-dialog' : 'apply-box';
  return (
    <div className={mask + (className ? ' ' + className : '')} onClick={() => { if (!busy && onClose) onClose(); }}>
      <div className={box + (boxClassName ? ' ' + boxClassName : '')} role="dialog" aria-modal="true"
        aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} style={style} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
