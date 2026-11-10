// v2.jsx — 界面优化方案 Layout v2（Downloads\TMS-Layout-v2，2026-10-06）的接入辅助。
// 方案的样式（web/src/v2.css）按 body 上的类名生效：v2-layout + v2-admin|v2-employee + v2-page-<slug>；
// 这里按路由写这三个类，并提供侧栏导航图标（方案 theme.js / layout.js 用脚本补的 SVG，这里改成组件）。
import { useEffect, useState, useRef, Children, isValidElement } from 'react';
import { isAdminPath } from './rbac.js';

// 员工端路由 → 方案快照的页面名（tms-ui-html/employee/<slug>.html）
const EMP_SLUG = {
  '': 'home', learn: 'learn', learning: 'my-learning', projects: 'my-projects', sessions: 'sessions', classes: 'classes',
  team: 'team', course: 'course', program: 'program', 'exam-prep': 'exam-prep', exam: 'exam', result: 'result',
  record: 'record', review: 'review', login: 'login', 'change-password': 'change-password', 'reset-password': 'reset-password',
};

export function v2BodyClasses(pathname) {
  const segs = String(pathname || '/').replace(/^\/+/, '').split('/');
  if (isAdminPath(pathname)) {
    // /admin → dashboard；/admin/people/:id → people；其余取第一段（employees、talent-settings…，与快照同名）
    const slug = (segs[1] || 'dashboard').replace(/[^a-z0-9-]/gi, '');
    return ['v2-layout', 'v2-admin', 'v2-page-' + slug];
  }
  let slug = EMP_SLUG[segs[0]] || segs[0].replace(/[^a-z0-9-]/gi, '') || 'home';
  if (segs[0] === 'projects' && segs[1]) slug = 'project-home';
  if (segs[0] === 'team' && segs[1]) slug = 'team-member';
  return ['v2-layout', 'v2-employee', 'v2-page-' + slug];
}

// 挂在 App 上：路由变化时换 body 类名；卸载时清掉
export function useV2Body(pathname) {
  useEffect(() => {
    const cls = v2BodyClasses(pathname);
    document.body.classList.add(...cls);
    return () => document.body.classList.remove(...cls);
  }, [pathname]);
}

// 导航图标（线条 SVG，24 网格；路径取自方案 theme.js / layout.js）
const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87',
  book: 'M4 4h6a2 2 0 0 1 2 2v15a3 3 0 0 0-3-2H4zM20 4h-6a2 2 0 0 0-2 2v15a3 3 0 0 1 3-2h5z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  org: 'M12 3v7M5 15v-5h14v5M2 15h6v6H2zM9 2h6v5H9zM16 15h6v6h-6z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  record: 'M7 3h10v18H7zM10 8h4M10 12h4M10 16h3',
  target: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3',
  // 第二批 2.8：绩效申诉（天平）与 HRBP 分工（人员 + 对勾）
  scale: 'M12 3v18M8 21h8M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM12 3l-1 4h2z',
  assign: 'M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M16 11l2 2 4-4',
  // F54（2026-10-09）系统设置组每项一个图标（分组标题仍用齿轮）：角色与授权（盾牌 + 对勾）、档案与职级设置（证件）、
  // 功能模块（四宫格）、品牌设置（调色板）、审计日志（记录板 + 条目）
  shield: 'M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6zM9 12l2 2 4-4',
  idcard: 'M3 5h18v14H3zM8.5 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M5.5 16c.5-1.7 1.6-2.6 3-2.6s2.5.9 3 2.6M14 9.5h4M14 13h4',
  modules: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  palette: 'M12 3a9 9 0 1 0 0 18c.9 0 1.5-.6 1.5-1.4 0-.4-.2-.7-.4-1-.3-.3-.4-.6-.4-1 0-.8.6-1.4 1.4-1.4H16a5 5 0 0 0 5-5c0-4.4-4-7.7-9-7.7zM7.5 12h.01M9.5 8h.01M14.5 8h.01',
  audit: 'M9 3h6v3H9zM9 4.5H5V21h14V4.5h-4M8.5 11h7M8.5 14.5h7M8.5 18h4',
};

export function NavIcon({ kind, className = 'theme-nav-icon' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[kind] || PATHS.file} />
    </svg>
  );
}

// 后台侧栏：按页面路径选图标（与方案 theme.js 的判定一致）
export function adminNavIcon(path) {
  if (path === '/admin') return 'home';
  // 第二批 2.8：放在通用规则之前（review-appeals 不含「reviews」，hrbp-coverage 不会命中任何既有规则）
  if (/review-appeals/.test(path)) return 'scale';
  if (/perf-dashboard/.test(path)) return 'chart';   // 绩效看板（2026-10-10）
  if (/orgperf/.test(path)) return 'org';            // 组织绩效（2026-10-10）
  if (/hrbp-coverage/.test(path)) return 'assign';
  // F54：系统设置各项各自一个图标，放在通用 settings 规则之前（以前四项共用齿轮、审计日志落到通用的 file）
  if (path === '/admin/roles') return 'shield';
  if (path === '/admin/talent-settings') return 'idcard';
  if (path === '/admin/modules') return 'modules';
  if (path === '/admin/brand-settings') return 'palette';
  if (path === '/admin/audit') return 'audit';
  if (/employees|people/.test(path)) return 'people';
  if (/org-chart|departments/.test(path)) return 'org';
  if (/reviews|talent-review/.test(path)) return 'chart';
  if (/settings|roles|modules|ai-governance/.test(path)) return 'settings';
  if (/content|projects|training-overview/.test(path)) return 'book';
  return 'file';
}

// 设置类页面的主从布局（方案 layout.js 的 v2-settings-workspace）：左边一列分节页签，右边只显示当前分节的卡片。
// 用法：<SettingsWorkspace footer={...}>{<div className="ppl-card" data-section="标题">…</div>}…</SettingsWorkspace>
// 每个直接子元素一个分节，标题取其 data-section；条件渲染为 false 的子元素自动跳过。
// 非当前分节用 hidden 隐藏而不卸载，分节里的表单状态不会因为切换而丢失。
export function SettingsWorkspace({ children, footer, initial = 0 }) {
  const kids = Children.toArray(children).filter(isValidElement);
  const [active, setActive] = useState(initial);
  const navRef = useRef(null);
  const cur = Math.min(active, Math.max(kids.length - 1, 0));
  const onKey = (e, i) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % kids.length : (i - 1 + kids.length) % kids.length;
    setActive(next);
    const btns = navRef.current ? navRef.current.querySelectorAll('button') : [];
    if (btns[next]) btns[next].focus();
  };
  if (kids.length === 0) return null;
  // 只剩一个分节（如 AI 治理不可见时的审计日志页）就不画页签列，直接放内容
  if (kids.length === 1) return <>{kids[0]}{footer}</>;
  return (
    <div className="v2-settings-workspace">
      <nav className="v2-section-tabs" ref={navRef}>
        {kids.map((k, i) => (
          <button key={i} type="button" aria-expanded={i === cur} aria-controls={'v2-section-' + i}
            onClick={() => setActive(i)} onKeyDown={(e) => onKey(e, i)}>
            <h2>{k.props['data-section']}</h2>
          </button>
        ))}
      </nav>
      <div className="v2-section-panels">
        {/* 子元素可能是自带 .ppl-card 根节点的组件（接不到 className / hidden），所以套一层宿主来做显隐；
            宿主本身无样式，卡片的内边距由 v2.css .v2-section-host>.ppl-card 补成方案的 30px。 */}
        {kids.map((k, i) => (
          <div key={i} className="v2-section-host" id={'v2-section-' + i} hidden={i !== cur}>{k}</div>
        ))}
        {footer}
      </div>
    </div>
  );
}

// 顶栏右侧工具图标（方案 layout.js）
export const UTIL_PATHS = {
  swap: 'M4 7h15M15 3l4 4-4 4M20 17H5M9 13l-4 4 4 4',
  out: 'M9 5H5v14h4M13 8l4 4-4 4M9 12h12',
  caret: 'M7 10l5 5 5-5',
};
export function UtilIcon({ kind, className = 'v2-utility-icon' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={UTIL_PATHS[kind]} />
    </svg>
  );
}
