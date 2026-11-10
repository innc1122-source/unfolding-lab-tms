// 简化 10/11：后台专用样式（从 app.css / v2.css 拆出）。放在最前面 import，保持「本项目样式在 Semi 样式之前」的原有顺序。
import '../admin.css';
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { LocaleProvider, Toast } from '@douyinfe/semi-ui';
import { api } from '../api.js';
import zh_CN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import en_US from '@douyinfe/semi-ui/lib/es/locale/source/en_US';
// Semi's stylesheet loads with this (lazy) chunk, so the employee app stays Semi-free.
import '../../node_modules/@douyinfe/semi-ui/dist/css/semi.min.css';
import { brandText } from '../brand.js';
import BrandMark, { brandMarkClass } from './BrandMark.jsx';
import { NavIcon, UtilIcon, adminNavIcon } from '../v2.jsx';
import { useI18n } from '../i18n.jsx';
import { useAuth, onSessionReset } from '../auth.jsx';
import { ADMIN_NAV_GROUPS, navPages, canSeeAdminPath, adminExternalLinks, appealDeskVisible, modOn } from '../rbac.js';
import NotifBell from './NotifBell.jsx';

// CX-044：退出 / 换账号时清掉后台的 Semi 提示（auth.jsx 不再直接引 Semi，见那里的 onSessionReset）。后台包一加载就登记，之后一直有效。
onSessionReset(() => Toast.destroyAll());

// HR console IA: grouped by HR domain (Workday/北森 pattern), not by feature.
// Training is ONE domain among five — the console reads as an HR system first.
const T = {
  zh: {
    menu: '菜单',
    console: '人才管理后台', consoleShort: '后台', exit: '返回员工端', logout: '退出登录', lang: '中文',
    dashboard: '工作台',
    gPeople: '员工与组织', people: '员工档案', departments: '部门', org: '组织架构',
    gPerformance: '绩效与人才', reviews: '评估周期', perfDash: '绩效看板', orgPerf: '组织绩效', appeals: '绩效申诉',
    gTalent: '人才发展', trev: '人才盘点',
    gCulture: '行为实践',
    gLearning: '培训管理', tOverview: '培训概览', projects: '发展项目', content: '课程库', exams: '考试', questions: '题库', results: '考试成绩', requests: '申请审批',
    gSystem: '系统设置', tset: '档案与职级设置', brandset: '品牌设置', roles: '角色与授权', audit: '审计日志', modules: '功能模块', aiGov: 'AI 治理', hrbp: 'HRBP 分工',
    instanceTip: '实例指纹，排障时报给支持人员',
    langLabel: '切换语言',
    culture: 'Action 3+3 挑战', extTip: '打开 Action 3+3 挑战的管理页面，将离开后台',
  },
  en: {
    menu: 'Menu',
    console: 'Talent Console', consoleShort: 'Console', exit: 'Back to Employee View', logout: 'Sign out', lang: 'English',
    dashboard: 'Dashboard',
    gPeople: 'People & Organization', people: 'Employee Profiles', departments: 'Departments', org: 'Org Chart',
    gPerformance: 'Performance & Talent', reviews: 'Review Cycles', perfDash: 'Performance Dashboard', orgPerf: 'Org Performance', appeals: 'Performance Appeals',
    gTalent: 'Talent Development', trev: 'Talent Review',
    gCulture: 'Behavior Practice',
    gLearning: 'Learning', tOverview: 'Learning Overview', projects: 'Development Programs', content: 'Course Library', exams: 'Exams', questions: 'Question Bank', results: 'Exam Results', requests: 'Application Approvals',
    gSystem: 'System Settings', tset: 'Profile & Job Level Settings', brandset: 'Brand Settings', roles: 'Roles & Access', audit: 'Audit Log', modules: 'Modules', aiGov: 'AI Governance', hrbp: 'HRBP Coverage',
    instanceTip: 'Instance fingerprint — quote it to support when troubleshooting',
    langLabel: 'Switch language',
    culture: 'Action 3+3 Challenge', extTip: 'Opens the Action 3+3 Challenge management pages and leaves the console',
  },
};
const item = ({ isActive }) => 'adm-nav-item' + (isActive ? ' on' : '');

// Semi's default page-size label is verbose ("Items per page: N"); show just the
// number. Note: ${pageSize} is a Semi template token, kept literal on purpose
// (single-quoted → no JS interpolation).
const EN_LOCALE = { ...en_US, Pagination: { ...en_US.Pagination, pageSize: '${pageSize}' } };
const ZH_LOCALE = { ...zh_CN, Pagination: { ...zh_CN.Pagination, pageSize: '${pageSize}' } };

export default function AdminLayout() {
  const { lang, toggle } = useI18n();
  const { user, logout } = useAuth();
  const s = T[lang];
  const initial = ((user && user.name) || 'HR').trim().charAt(0) || 'H';
  // Sellable-module switches from the /api/me payload; a payload without the
  // block means all on (an old server must not empty the sidebar). Kept here
  // for the pending-counts fetch below; nav trimming asks rbac.js instead.
  const mods = (user && user.modules) || {};
  const on = (m) => modOn(mods, m);
  // White-label brand rides the same /api/me payload as modules; absent
  // (old server) means the generic text wordmark and T-dict copy below.
  const brand = (user && user.brand) || null;
  // Pending-approval counts for the nav badges; refresh on each admin navigation.
  const location = useLocation();
  const [pending, setPending] = useState({ enroll: 0, nominations: 0, gradingReview: 0, gradingManual: 0 });
  // Below 900px the sidebar slides in over the page instead of taking a third
  // of it. Any navigation closes it, so tapping a link never leaves the drawer
  // covering the page you just asked for.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  // Escape closes it too — it is a modal surface while open.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  // Layout v2 顶栏右侧的账号菜单（头像 + 下拉里的「退出登录」）：点外部或 Esc 关闭，↓ 键打开。
  const [accOpen, setAccOpen] = useState(false);
  const accRef = useRef(null);
  useEffect(() => {
    if (!accOpen) return undefined;
    const onDoc = (e) => { if (accRef.current && !accRef.current.contains(e.target)) setAccOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setAccOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [accOpen]);
  // CX-151：审批、评分等页面处理完后发 tms:pending-changed，侧栏角标随即重新拉取（原来要换页或刷新才更新）
  const [pendingTick, setPendingTick] = useState(0);
  useEffect(() => {
    const bump = () => setPendingTick((n) => n + 1);
    window.addEventListener('tms:pending-changed', bump);
    return () => window.removeEventListener('tms:pending-changed', bump);
  }, []);
  useEffect(() => {
    // Both counts are training approvals; with learning off the endpoint is
    // gone (404), so don't ask at all rather than lean on the catch below.
    if (!on('learning')) return undefined;
    let alive = true;
    api.get('/api/admin/pending-counts')
      .then((r) => { if (alive && r) setPending({ enroll: r.enroll || 0, nominations: r.nominations || 0, gradingReview: r.gradingReview || 0, gradingManual: r.gradingManual || 0 }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [location.pathname, pendingTick]);
  // 第二批 2.8 绩效申诉台角标：需要我处理的申诉数（GET /api/admin/review-appeals/summary 的 actionable，与申诉列表同一口径）。
  // 独立于培训的 pending-counts：培训模块关闭时角标照常；绩效模块关闭或看不到申诉台时不请求。进后台、换页与每 60 秒刷新一次。
  const appealOn = on('performance') && appealDeskVisible(user);
  const [appealN, setAppealN] = useState(0);
  const [appealTick, setAppealTick] = useState(0);
  useEffect(() => {
    if (!appealOn) return undefined;
    const t = setInterval(() => setAppealTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, [appealOn]);
  useEffect(() => {
    if (!appealOn) { setAppealN(0); return undefined; }
    let alive = true;
    api.get('/api/admin/review-appeals/summary')
      .then((r) => { if (alive) setAppealN(r && Number(r.actionable) > 0 ? Number(r.actionable) : 0); })
      .catch(() => {});
    return () => { alive = false; };
  }, [appealOn, location.pathname, location.search, appealTick]);
  const BADGES = {
    '/admin/review-appeals': appealN,
    '/admin/projects': pending.nominations,
    '/admin/requests': pending.enroll + pending.nominations,
    // 简答题待 HR 复核（决定是否通过）与待 HR 评分（方案 2.5）
    '/admin/results': pending.gradingReview + pending.gradingManual,
  };
  // Instance fingerprint for the sidebar footer — "which DB are you on?" is
  // the first support question, so it lives on every console screen. /api/env
  // is public and carries only the 8-char fingerprint; the full detail lives
  // behind GET /api/admin/instance, which we deliberately do NOT call here —
  // one line of footer text doesn't justify a dedicated admin request. An old
  // server sends no `instance` field, and the row simply doesn't render.
  const [inst, setInst] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/api/env')
      .then((e) => { if (alive && e && typeof e.instance === 'string' && e.instance) setInst(e); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // Which page belongs to which sellable module / RBAC domain now lives in
  // web/src/rbac.js — one table, shared with App.jsx's /admin/* route guard so
  // the sidebar and the guard can never disagree. This file keeps only what is
  // language-dependent: the group labels and the item labels (双语铁律 — 用户
  // 可见文字进本文件的 T)。An item survives only if it passes BOTH filters
  // (module switch AND grants), which is what canSeeAdminPath() applies.
  // A group whose items all drop disappears with its label; one with survivors
  // keeps the label (P5 default). The 'shell' group (工作台) has no label.
  const GROUP_LABEL = { shell: null, people: s.gPeople, performance: s.gPerformance, talent: s.gTalent, culture: s.gCulture, learning: s.gLearning, system: s.gSystem };
  const NAV_LABEL = {
    '/admin': s.dashboard,
    '/admin/employees': s.people, '/admin/org-chart': s.org, '/admin/departments': s.departments,
    '/admin/talent-review': s.trev, '/admin/reviews': s.reviews, '/admin/perf-dashboard': s.perfDash, '/admin/orgperf': s.orgPerf, '/admin/review-appeals': s.appeals,
    '/admin/training-overview': s.tOverview, '/admin/projects': s.projects, '/admin/content': s.content,
    '/admin/exams': s.exams, '/admin/questions': s.questions, '/admin/results': s.results, '/admin/requests': s.requests,
    '/admin/talent-settings': s.tset, '/admin/brand-settings': s.brandset, '/admin/roles': s.roles, '/admin/audit': s.audit,
    '/admin/modules': s.modules, '/admin/ai-governance': s.aiGov, '/admin/hrbp-coverage': s.hrbp,
  };
  // Full-page links to module pages (rbac.js ADMIN_EXTERNAL_LINKS — e.g. the
  // Behavior Practice management view at /culture/#/hr): not SPA routes, so they
  // render as plain <a href> after the group's NavLinks. A group that only has
  // such a link still shows (with its label).
  const LINK_LABEL = { culture: s.culture };
  const GROUPS = ADMIN_NAV_GROUPS
    .map((gid) => ({
      gid,
      label: GROUP_LABEL[gid],
      items: navPages(gid)
        .filter((p) => canSeeAdminPath(user, p.path))
        .map((p) => [p.path, NAV_LABEL[p.path], !!p.end]),
      links: adminExternalLinks(user, gid).map((l) => [l.href, LINK_LABEL[l.id] || l.id, l.id]),
    }))
    .filter((g) => g.items.length > 0 || g.links.length > 0);
  // 一级目录折叠（负责人 2026-10-06「一级目录可折叠、二级缺省收起」）：分组标题是按钮，缺省只展开当前页所在的分组；
  // 用户手动展开 / 收起记在本机（localStorage），换页时当前分组自动展开，不收别人的。'shell'（工作台）没有二级，照常是一个入口。
  const GROUP_ICON = { people: 'people', performance: 'chart', culture: 'target', learning: 'book', system: 'settings' };
  const NAV_OPEN_KEY = 'tms-adm-nav-open';
  const inGroup = (g) => g.items.some(([to, , end]) => (end ? location.pathname === to : location.pathname === to || location.pathname.startsWith(to + '/')))
    || (g.gid === 'people' && location.pathname.startsWith('/admin/people/'));
  const currentGid = (GROUPS.find(inGroup) || {}).gid || null;
  const [navOpen, setNavOpen] = useState(() => { try { const v = JSON.parse(localStorage.getItem(NAV_OPEN_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } });
  useEffect(() => { if (currentGid && !navOpen[currentGid]) setNavOpen((o) => ({ ...o, [currentGid]: true })); }, [currentGid]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleGroup = (gid) => setNavOpen((o) => { const n = { ...o, [gid]: !o[gid] }; try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(n)); } catch (e) { /* 隐私模式等 */ } return n; });
  const groupBadge = (g) => g.items.reduce((a, [to]) => a + (BADGES[to] > 0 ? BADGES[to] : 0), 0);
  return (
    <LocaleProvider locale={lang === 'zh' ? ZH_LOCALE : EN_LOCALE}>
      <div className="topbar">
        <button className="adm-burger" onClick={() => setDrawerOpen((v) => !v)}
          aria-label={s.menu} aria-expanded={drawerOpen} aria-controls="adm-side">
          <svg className="ic" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        {/* Layout v2：品牌区在桌面固定到左侧栏顶部的深色底上（深底版 logo），≤900px 回到白色顶栏 ——
            上传了浅底版时手机上去掉深色药丸底、直接显示浅底版（10/11 负责人定：两版都用上，见 BrandMark.jsx）。 */}
        <Link className={['brand', brandMarkClass(brand, 'adaptive')].filter(Boolean).join(' ')} to="/admin" aria-label={brandText(brand, 'console', lang, s.console)}><BrandMark brand={brand} lang={lang} surface="adaptive" /><span className="sub">{brandText(brand, 'console', lang, s.console)}</span><span className="sub sub-short">{s.consoleShort}</span></Link>
        {/* Layout v2 顶栏右侧四件：视图切换（带交换图标，手机上只留图标）· 语言 · 通知 · 账号菜单（内含退出登录）。 */}
        <div className="top-right">
          <Link className="adm-exit v2-view-switch" to="/" title={s.exit} aria-label={s.exit}><UtilIcon kind="swap" /><span className="v2-control-label">{s.exit}</span></Link>
          {/* 语言按钮「中 / EN」：与员工端顶栏、登录页、Action 3+3 挑战学员端同一写法（app.css .lang-pick；v2.css 画成分段控件）。 */}
          <button className="icon-btn lang-toggle lang-pick" onClick={toggle} aria-label={s.langLabel}>
            <span className={lang === 'zh' ? 'on' : undefined}>中</span><span className="sep" aria-hidden="true">/</span><span className={lang === 'en' ? 'on' : undefined}>EN</span>
          </button>
          {/* 申诉、报名申请等通知本来只发给管理员,却只有员工端有铃铛 ——
              这里补上,顺序与 TopBar 保持一致(语言 → 铃铛 → 用户)。 */}
          <NotifBell />
          <div className="v2-account" ref={accRef}
            onKeyDown={(e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target === e.currentTarget.firstChild) { e.preventDefault(); setAccOpen(true); } }}>
            <button className="avatar v2-account-trigger" type="button" title={user && user.name} aria-label={user && user.name}
              aria-haspopup="menu" aria-expanded={accOpen} onClick={() => setAccOpen((o) => !o)}>{initial}<UtilIcon kind="caret" className="v2-caret" /></button>
            {accOpen && (
              <div className="v2-account-pop" role="menu">
                <button className="adm-exit" role="menuitem" onClick={logout}><UtilIcon kind="out" />{s.logout}</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="adm-shell">
        <aside id="adm-side" className={'adm-side' + (drawerOpen ? ' open' : '')}>
          {GROUPS.map((g) => {
            const open = g.gid === 'shell' || !!navOpen[g.gid];
            const body = (
              <>
                {g.items.map(([to, label, end]) => (
                  <NavLink key={to} to={to} end={!!end} className={item}>
                    <NavIcon kind={adminNavIcon(to)} />{label}{BADGES[to] > 0 && <span className="adm-badge">{BADGES[to]}</span>}
                  </NavLink>
                ))}
                {g.links.map(([href, label, id]) => (
                <a key={id} href={href} className="adm-nav-item adm-nav-ext" title={s.extTip} data-nav-ext={id}>
                  <NavIcon kind="target" /><span>{label}</span>
                  <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></svg>
                </a>
                ))}
              </>
            );
            if (g.gid === 'shell') return <div className="adm-nav-group" key={g.gid}>{body}</div>;
            const n = groupBadge(g);
            return (
              <div className="adm-nav-group" key={g.gid}>
                <button type="button" className={'adm-nav-grp' + (g.gid === currentGid ? ' has-on' : '')} aria-expanded={open} aria-controls={'adm-nav-' + g.gid} onClick={() => toggleGroup(g.gid)}>
                  <NavIcon kind={GROUP_ICON[g.gid] || 'file'} /><span className="adm-nav-grp-t">{g.label}</span>
                  {!open && n > 0 && <span className="adm-badge">{n}</span>}
                  <svg className="adm-nav-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {open && <div className="adm-nav-sub" id={'adm-nav-' + g.gid}>{body}</div>}
              </div>
            );
          })}
          {inst && (
            // schemaVersion normally rides /api/admin/instance only; append it
            // opportunistically if a future /api/env ever carries it, without
            // spending a request on it today.
            <div className="adm-instance" title={s.instanceTip}
              style={{ padding: '14px 12px 0', fontSize: 12, color: 'var(--ink-3)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', letterSpacing: '.4px', userSelect: 'all' }}>
              {inst.instance}{inst.schemaVersion != null ? ` · v${inst.schemaVersion}` : ''}
            </div>
          )}
        </aside>
        {drawerOpen && <div className="adm-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
        <div className="adm-main"><Outlet /></div>
      </div>
    </LocaleProvider>
  );
}
