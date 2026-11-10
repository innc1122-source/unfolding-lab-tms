import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { LEARNING_ITEMS } from '../learningnav.js';

// 页头模块路径（IA 1.4）：第一段是员工端入口名，中间段是上级页面，最后一段是当前页（不可点）；每段文字与导航、页面标题一致；
// 分隔符「›」。locked 时全部不可点（答题中防止中途离开）。沿用 .crumb 样式，取代各页自写的面包屑。
//   items: [{ label, to? | onClick? }]（onClick 用于同一路由内的视图切换，如班级详情回到班级列表）
export default function ModuleTrail({ items, locked }) {
  const { t } = useI18n();
  const list = (items || []).filter((it) => it && it.label);
  if (!list.length) return null;
  return (
    <nav className="crumb" aria-label={t('trailLabel')}>
      {list.map((it, i) => {
        const last = i === list.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <span className="sep" aria-hidden="true">›</span>}
            {!last && !locked && it.to ? <Link to={it.to}>{it.label}</Link>
              : !last && !locked && it.onClick ? <a href="#" onClick={(e) => { e.preventDefault(); it.onClick(); }}>{it.label}</a>
                : <span aria-current={last ? 'page' : undefined}>{it.label}</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}

/** 「培训 › 〈入口〉」两段（入口 id 见 learningnav.js：courses、programs、sessions、classes、team）。 */
export function learnTrail(lang, id) {
  const hub = { label: lang === 'zh' ? '培训' : 'Learning', to: '/learn' };
  const it = LEARNING_ITEMS.find((x) => x.id === id);
  return it ? [hub, { label: lang === 'zh' ? it.zh : it.en, to: it.to }] : [hub];
}
