// 12.2 工作台：各层共用的小件（数字格式、窄屏判断、线性图标、可折叠的层、差值行、名单入口）。
// F48：不用 emoji，图标一律 svg.ic 线性图标（stroke 1.8，跟随文字颜色）。
import { num } from '../../../fmt.js';
import { useMedia } from '../../../useMedia.js';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../../i18n.jsx';
import { deltaText, drillHref } from '../../../workbench.js';

/* 4,469 —— 两种语言都按三位分组；不是有限数字的原样返回，不编造 0。 */
export const nf = (n) => (Number.isFinite(n) ? num(n) : n);
/* 百分数（服务端给 0–100 的数）：一位小数，整数不带 .0 */
export const pf = (v) => (Number.isFinite(Number(v)) && v !== null ? `${Number(v).toFixed(1).replace(/\.0$/, '')}%` : '—');

/* 窄屏（≤ 900px）：表格改卡片、按钮换行等值改写在 JS 里判断，与 Dashboard / OrgChart 的 useNarrow 同一查询。 */
const NARROW_Q = '(max-width:900px)';
export { useMedia };   // 简化 10/11：公共实现在 web/src/useMedia.js
export const useNarrow = () => useMedia(NARROW_Q);
/* 部门健康度表与名单：< 768 改为每行一张卡片，不横向滚动（b12-design §7.2）。 */
export const usePhone = () => useMedia('(max-width:767px)');

const Ic = ({ children, sm }) => <svg className={sm ? 'ic sm' : 'ic'} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{children}</svg>;
export const IcTodo = () => <Ic><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></Ic>;
export const IcRisk = () => <Ic><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6l8-3z" /><path d="M12 8v5M12 16h.01" /></Ic>;
export const IcStructure = () => <Ic><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Ic>;
export const IcPeople = () => <Ic><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 4.5a3 3 0 010 6M21 20c0-2.8-1.8-5-4-5.7" /></Ic>;
export const IcSuccession = () => <Ic><path d="M12 3v6M12 15v6M5 9h14v6H5z" /></Ic>;
export const IcCap = () => <Ic><path d="M12 4L2 9l10 5 10-5-10-5z" /><path d="M6 11.5V17c0 1.1 2.7 2.5 6 2.5s6-1.4 6-2.5v-5.5" /></Ic>;
export const IcChart = () => <Ic><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Ic>;
export const IcBadge = () => <Ic><circle cx="12" cy="9" r="5" /><path d="M8.5 13l-1.5 8 5-3 5 3-1.5-8" /></Ic>;
export const IcOrg = () => <Ic><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-4h12v4" /></Ic>;
export const IcChevron = ({ open }) => <Ic sm><path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} /></Ic>;
export const IcArrow = () => <Ic sm><path d="M5 12h14M13 6l6 6-6 6" /></Ic>;
export const IcBack = () => <Ic sm><path d="M19 12H5M11 6l-6 6 6 6" /></Ic>;
export const IcUp = () => <Ic sm><path d="M12 19V5M6 11l6-6 6 6" /></Ic>;
export const IcDown = () => <Ic sm><path d="M12 5v14M6 13l6 6 6-6" /></Ic>;
const IcFlat = () => <Ic sm><path d="M5 12h14" /></Ic>;

const T = {
  zh: { fold: '收起', unfold: '展开', viewList: '查看名单' },
  en: { fold: 'Collapse', unfold: 'Expand', viewList: 'View list' },
};

/* 一层：h2 标题 + 右侧数量胶囊（F47：同一行、垂直居中）+ 折叠按钮。折叠状态由上层存 localStorage。 */
export function Layer({ id, icon, title, count, folded, onToggle, children }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const bodyId = `wb-layer-${id}`;
  return (
    <section className={'wb-layer' + (folded ? ' folded' : '')} aria-labelledby={bodyId + '-h'}>
      <div className="wb-layer-head">
        <h2 className="wb-layer-title" id={bodyId + '-h'}>{icon}<span className="wb-layer-name">{title}</span>
          {count !== undefined && count !== null && <span className="pill pri wb-count tnum">{nf(count)}</span>}
        </h2>
        <button type="button" className="btn ghost sm wb-fold" aria-expanded={!folded} aria-controls={bodyId} onClick={onToggle}>
          <IcChevron open={!folded} /><span>{folded ? s.unfold : s.fold}</span>
        </button>
      </div>
      {!folded && <div className="wb-layer-body" id={bodyId}>{children}</div>}
    </section>
  );
}

/* 环比行：线性箭头 + 文字；语义色按 better 方向（改善 / 恶化 / 持平 / 无上期）。 */
export function DeltaLine({ metric }) {
  const { lang } = useI18n();
  const d = deltaText(metric, lang);
  return (
    <div className={'wb-delta ' + d.tone}>
      {d.dir === 'up' ? <IcUp /> : d.dir === 'down' ? <IcDown /> : d.dir === 'flat' ? <IcFlat /> : null}
      <span>{d.text}</span>
    </div>
  );
}

/* 「查看名单」：打开名单整页（/admin?list=…）。数字本身也可点，见 DrillNumber。 */
export function ListLink({ drill, to, label }) {
  const { lang } = useI18n();
  const s = T[lang] || T.en;
  const navigate = useNavigate();
  const href = drillHref(drill, to);
  if (!href) return null;
  return <button type="button" className="btn ghost sm wb-listlink" onClick={() => navigate(href)}>{label || s.viewList}<IcArrow /></button>;
}

export function DrillNumber({ drill, to, children, className, label }) {
  const navigate = useNavigate();
  const href = drillHref(drill, to);
  if (!href) return <span className={className}>{children}</span>;
  return <button type="button" className={'wb-num-btn ' + (className || '')} aria-label={label} onClick={() => navigate(href)}>{children}</button>;
}
