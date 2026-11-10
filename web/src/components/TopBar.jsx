import { useState, useRef, useEffect } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { brandText } from '../brand.js';
import BrandMark, { brandMarkClass } from './BrandMark.jsx';
import { useLearningNav, isLearningPath } from '../learningnav.js';
import { NavIcon, UtilIcon } from '../v2.jsx';
import { hasConsoleAccess, modOn } from '../rbac.js';
import NotifBell from './NotifBell.jsx';
import { confirmLeave } from './useLeaveGuard.js';
import { fetchCultureEntry, cultureEntryKind, cultureEntryHref, cultureNavShown } from '../modules/culture/entry.js';

const active = ({ isActive }) => (isActive ? 'active' : undefined);

const NT = {
  // culLearner 保持在末位：test/culture-web.test.js 按「culLearner: '…' }」断言
  zh: { brandSub: '人才管理', enterConsole: '进入后台', culLearner: 'Action 3+3 挑战' },
  en: { brandSub: 'Talent Management', enterConsole: 'Go to Console', culLearner: 'Action 3+3 Challenge' },
};

export default function TopBar() {
  const { t, toggle, lang } = useI18n();
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const s = NT[lang] || NT.en;

  // Sellable-module switches from the /api/me payload; a payload without the
  // block means all on (an old server must not empty the nav).
  const mods = (user && user.modules) || {};
  const on = (m) => modOn(mods, m);
  // White-label brand rides the same /api/me payload as modules; absent
  // (old server) means the generic text wordmark and T-dict copy below.
  const brand = (user && user.brand) || null;

  // 「培训▾」下拉（IA 1.2）：课程、培养项目、我的授课、我的班级、团队学习，顺序与显示条件在 learningnav.js 一处定义
  // （培养项目要本人参加或可申请的项目数 > 0；授课、班级、团队学习按讲师、班主任、经理身份）。learning 关闭时整组不显示。
  const learning = useLearningNav(user);

  // 行为实践（culture）入口：模块缺省关闭（只认 modules.culture === true），开启且有进行中的项目时，
  // 只给参与者与例会主持人（不在名单里的 HoD、团队主持人）显示「Action 3+3 挑战」（IA D-07、B-C01，R-143）；
  // 有 culture 读权限的非参与者不在顶栏显示，由后台侧栏与首页入口卡进入管理视图。与首页入口卡
  // 共用一次 /api/v1/me/culture/entry（modules/culture/entry.js）。学员端不在 SPA 路由里，所以是普通 <a>。
  // 手机底栏不加这一项（六个标签已满），手机上由首页入口卡进入。
  const [culture, setCulture] = useState(null); // null | { kind: 'learner' | 'host', href }
  const uid = user && user.id;
  useEffect(() => {
    let alive = true;
    fetchCultureEntry(user).then((d) => {
      if (!alive) return;
      const kind = cultureEntryKind(user, d);
      setCulture(cultureNavShown(kind) ? { kind, href: cultureEntryHref(kind, d) } : null);
    });
    return () => { alive = false; };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // 用户菜单的关闭逻辑;通知铃铛已搬到 NotifBell,自己管自己的浮层。
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  const initial = ((user && user.name) || '').trim().charAt(0) || 'U';

  return (
    <>
    <div className="topbar">
      {/* The badge carries the talent name, matching 人才管理后台 on the admin
          side — the employee area spans profile, growth record and performance,
          not just training. */}
      {/* Layout v2：品牌区在桌面固定到左侧栏顶部的深色底上（深底版 logo），≤900px 回到白色顶栏 ——
          上传了浅底版时手机上去掉深色药丸底、直接显示浅底版（10/11 负责人定：两版都用上，见 BrandMark.jsx）。 */}
      <Link className={['brand', brandMarkClass(brand, 'adaptive')].filter(Boolean).join(' ')} to="/" aria-label={t('navHome')}><BrandMark brand={brand} lang={lang} surface="adaptive" /><span className="sub">{brandText(brand, 'brandSub', lang, s.brandSub)}</span></Link>
      <div className="top-right">
        {/* 第二批 3.3：「进入后台」与后台顶栏的「返回员工端」（AdminLayout.jsx 同一位置）对称 —— 同一组类名
            adm-exit v2-view-switch、同一个交换图标；≤900px 由 v2.css 收成只剩图标的方块按钮。只给能进后台的人显示，
            判据 hasConsoleAccess 与 App.jsx 的 /admin 放行共用（rbac.js）。原先藏在头像菜单里的后台入口随之去掉。 */}
        {hasConsoleAccess(user) && (
          <Link className="adm-exit v2-view-switch" to="/admin" title={s.enterConsole} aria-label={s.enterConsole}><UtilIcon kind="swap" /><span className="v2-control-label">{s.enterConsole}</span></Link>
        )}
        {/* 语言按钮「中 / EN」（2026-09-28 负责人决定）：与 Action 3+3 挑战学员端、登录页同一写法；当前语言加粗并用品牌色，
            手机上同样显示文字（app.css .lang-pick）。 */}
        <button className="icon-btn lang-toggle lang-pick" onClick={toggle} aria-label={t('switchLang')}>
          <span className={lang === 'zh' ? 'on' : undefined}>中</span><span className="sep" aria-hidden="true">/</span><span className={lang === 'en' ? 'on' : undefined}>EN</span>
        </button>

        <NotifBell />

        <div className="usermenu" ref={ref}>
          <button className="avatar" onClick={() => setOpen((o) => !o)} title={user && user.name} aria-label={t('account')} aria-haspopup="menu" aria-expanded={open}>{initial}</button>
          {open && (
            <div className="usermenu-pop" role="menu">
              <div className="um-name">{user && user.name}</div>
              {/* 9.1（第三批）：员工端不显示工号（含本人）；唯一保留的是课件水印上的本人工号（5.6，可追溯） */}
              {/* 程序化跳转先问离开守卫（第二批审查 P1-6）：有未保存的草稿时（如部门校准）确认后才走。
                  useLeaveGuard.js 在捕获阶段也拦 .um-item，这里再问一次不会重复弹窗（刚确认过的跳转直接放行），
                  只是不再依赖类名。「进入后台」是普通链接，由捕获阶段的链接拦截负责。 */}
              <button className="um-item" onClick={() => { if (!confirmLeave()) return; setOpen(false); nav('/change-password'); }}>{t('changePw')}</button>
              <button className="um-item" onClick={() => { if (confirmLeave()) logout(); }}>{t('logout')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
    {/* Layout v2：主导航从顶栏移到固定左侧栏；≤900px 隐藏，由手机底栏（MobileTabBar）接手。 */}
    <aside className="v2-employee-side">
      <nav className="nav">
        {/* 顺序（IA 1.2）：首页 · 培训▾ · 成长档案 · 绩效评估 · Action 3+3 挑战。关闭的模块连同入口一起消失；
            成长档案属于 core，始终显示（learning 关闭时只隐藏其中的学习记录页签）。 */}
        <NavLink to="/" end className={active}><NavIcon kind="home" />{t('navHome')}</NavLink>
        {learning.items.length > 0 && <LearningMenu items={learning.items} lang={lang} label={t('navLearningGroup')} />}
        <NavLink to="/record" className={active}><NavIcon kind="record" />{t('navRecord')}</NavLink>
        {on('performance') && <NavLink to="/review" className={active}><NavIcon kind="chart" />{t('navReview')}</NavLink>}
        {culture && <a href={culture.href} data-culture-nav={culture.kind}><NavIcon kind="target" />{s.culLearner}</a>}
      </nav>
    </aside>
    </>
  );
}

// 「培训▾」下拉：按钮不跳转，点击展开、再次点击或 Esc 或点外部收起；下拉项为 role="menuitem" 的链接，上下键移动焦点
// （IA 1.2 交互要求）。当前路由属于培训时按钮显示选中态；换页后自动收起。
function LearningMenu({ items, lang, label }) {
  const ref = useRef(null);
  const btn = useRef(null);
  const { pathname } = useLocation();
  const current = isLearningPath(pathname);
  // Layout v2 侧栏手风琴（负责人 2026-10-06）：进入培训相关页面自动展开并保持展开，点子项、点页面其它地方都不收起，
  // 只有再点一次「培训」（或在菜单里按 Esc）才收起；离开培训页面后保持用户上一次的开合状态。
  const [open, setOpen] = useState(current);
  useEffect(() => { if (current) setOpen(true); }, [current]);
  // 键盘：菜单展开时 Esc 收起并把焦点还给按钮（焦点在菜单内才响应，不劫持页面其它地方的 Esc）
  const onKeyWithin = (e) => { if (e.key === 'Escape') { setOpen(false); if (btn.current) btn.current.focus(); } };
  const onMenuKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = Array.from(ref.current.querySelectorAll('[role="menuitem"]'));
    const i = list.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    list[next].focus();
  };
  return (
    <div className="nav-dd" ref={ref} onKeyDown={onKeyWithin}>
      <button ref={btn} type="button" className={'nav-dd-btn' + (current ? ' active' : '')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <NavIcon kind="book" />{label}
        <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="nav-dd-pop" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {items.map((it) => (
            <NavLink key={it.id} to={it.to} role="menuitem" className={active} data-learning-item={it.id}>{lang === 'zh' ? it.zh : it.en}</NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
