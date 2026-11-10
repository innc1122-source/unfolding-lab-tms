import { Tooltip } from '@douyinfe/semi-ui';
import { useI18n } from '../i18n.jsx';

// 11.4（2026-10-09，F49）：只读档不再在页面上放整段权限说明 —— 看不到的按钮直接不显示，
// 页面标题右侧（F47：同一行、垂直居中）放一个「只读」胶囊，悬停时给一句说明（读屏从 aria-label 读到同一句）。
// 用法：<div className="u-title-line"><h1 …>标题</h1>{readOnly && <ReadOnlyPill tip={s.roTip} />}</div>
const T = {
  zh: { label: '只读' },
  en: { label: 'Read-only' },
};

export default function ReadOnlyPill({ tip }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  return (
    <Tooltip content={tip} position="bottomLeft" trigger="hover">
      <span className="pill muted ro-pill" tabIndex={0} role="note" aria-label={tip ? `${s.label}: ${tip}` : s.label}>{s.label}</span>
    </Tooltip>
  );
}
