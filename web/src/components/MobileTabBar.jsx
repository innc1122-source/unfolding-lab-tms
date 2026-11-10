import { modOn } from '../rbac.js';
import { NavLink, useLocation } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { isLearningPath } from '../learningnav.js';

// Bottom navigation for narrow screens. The top-bar nav is hidden below 820px,
// so this carries primary navigation on phones. Rendered only on employee pages
// (not admin, login, or an exam).
//
// 固定四项（IA 1.3）：首页 · 培训 · 成长档案 · 绩效。「培训」进中转页 /learn，讲师、班主任、经理的工作入口都在中转页里，
// 兼任多个角色的人在手机上也能进全部入口（不再按角色三选一）。英文显示短标签 Records / Performance，读屏用全称。
// learning 关闭时为三项（首页 · 成长档案 · 绩效）；performance 关闭时为三项（首页 · 培训 · 成长档案）。
// Action 3+3 挑战不进底栏，手机上由首页入口卡进入。
const cls = ({ isActive }) => 'tabbar-item' + (isActive ? ' on' : '');

export default function MobileTabBar() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { pathname } = useLocation();
  // Sellable-module switches from the /api/me payload; a payload without the
  // block means all on (an old server must not empty the tab bar).
  const mods = (user && user.modules) || {};
  const on = (m) => modOn(mods, m);
  const learnOn = isLearningPath(pathname);
  return (
    <>
      <div className="tabbar-spacer" aria-hidden="true" />
      <nav className="tabbar" aria-label={t('primaryNav')}>
        <NavLink to="/" end className={cls} aria-label={t('navHome')}>
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h5v-6h4v6h5V10" /></svg>
          <span>{t('navHome')}</span>
        </NavLink>
        {on('learning') && (
          <NavLink to="/learn" className={() => cls({ isActive: learnOn })} aria-label={t('navLearningGroup')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z" /><path d="M8 3v4M16 3v4M4 9h16" /></svg>
            <span>{t('navLearningGroup')}</span>
          </NavLink>
        )}
        <NavLink to="/record" className={cls} aria-label={t('navRecord')}>
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9" /><path d="M9 11l3 3 6-6" /></svg>
          <span>{t('tabRecord')}</span>
        </NavLink>
        {on('performance') && (
          <NavLink to="/review" className={cls} aria-label={t('navReview')}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z" /></svg>
            <span>{t('tabReview')}</span>
          </NavLink>
        )}
      </nav>
    </>
  );
}
