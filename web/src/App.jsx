import { Suspense, useEffect } from 'react';
import { lazyRetry as lazy } from './lazyRetry.js';   // CX-109：分包加载失败（发版后旧页面）自动刷新一次
import { Routes, Route, useLocation, Navigate, Link } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { useI18n } from './i18n.jsx';
import { applyBrand } from './brand.js';
import { adminRedirect, isAdminPath, normalizeAdminPath, hasConsoleAccess, modOn } from './rbac.js';
import { nextFromSearch } from './nextpath.js';
import { useV2Body } from './v2.jsx';
import TopBar from './components/TopBar.jsx';
import MobileTabBar from './components/MobileTabBar.jsx';
import AIChat from './components/AIChat.jsx';
// Employee pages ship in the initial bundle, which carries no Semi UI (simplification 10/11: auth.jsx no
// longer imports Semi, and the exam / result pages use qtypes/views.jsx without the editors). The heavier
// pages a learner opens only now and then (course, program, exam, result, record, review, a report's
// profile) are code-split below and load on first visit behind the same <Loading /> fallback.
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
// Pre-auth like Login: the mailed reset link has to open for someone who cannot
// sign in, so this page must not sit behind the lazy admin chunk or the gate.
import ResetPassword from './pages/ResetPassword.jsx';
import MyLearning from './pages/MyLearning.jsx';
import LearningHub from './pages/LearningHub.jsx';
// 第四批 7：课程目录（公开课程，员工自主加入）
import Catalog from './pages/Catalog.jsx';
import MyProjects from './pages/MyProjects.jsx';
import ProjectHome from './pages/ProjectHome.jsx';
// Derived-role workbenches: 讲师 (sessions), 班主任 (classes), 经理 (team).
import MySessions from './pages/MySessions.jsx';
import MyClasses from './pages/MyClasses.jsx';
import MyTeam from './pages/MyTeam.jsx';
// 经理只读下属档案 (RBAC-DESIGN.md D3 + D8) — opened from MyTeam by name.

const Course = lazy(() => import('./pages/Course.jsx'));
const ProgramDetail = lazy(() => import('./pages/ProgramDetail.jsx'));
const ExamPrep = lazy(() => import('./pages/ExamPrep.jsx'));
const ExamRunner = lazy(() => import('./pages/ExamRunner.jsx'));
const Result = lazy(() => import('./pages/Result.jsx'));
const Record = lazy(() => import('./pages/Record.jsx'));
const Review = lazy(() => import('./pages/Review.jsx'));
const ReportProfile = lazy(() => import('./pages/ReportProfile.jsx'));

// The HR console (Semi UI: Table/Form/Modal + stylesheet + LocaleProvider) is
// entirely code-split behind AdminLayout, so employees never download it.
const AdminLayout = lazy(() => import('./components/AdminLayout.jsx'));
const Overview = lazy(() => import('./pages/admin/Overview.jsx'));
const Employees = lazy(() => import('./pages/admin/Employees.jsx'));
const Content = lazy(() => import('./pages/admin/Content.jsx'));
const Exams = lazy(() => import('./pages/admin/Exams.jsx'));
const Questions = lazy(() => import('./pages/admin/Questions.jsx'));
const Results = lazy(() => import('./pages/admin/Results.jsx'));
const Requests = lazy(() => import('./pages/admin/Requests.jsx'));
const AdminProjects = lazy(() => import('./pages/admin/Projects.jsx'));
const Audit = lazy(() => import('./pages/admin/Audit.jsx'));
const People = lazy(() => import('./pages/admin/People.jsx'));
const TalentSettings = lazy(() => import('./pages/admin/TalentSettings.jsx'));
const BrandSettings = lazy(() => import('./pages/admin/BrandSettings.jsx'));
const TalentReview = lazy(() => import('./pages/admin/TalentReview.jsx'));
// 第五批 8.1 / 8.2：人才筛选整页（filter/new 与 filter/:id 同一路由，id = new 为新建）、继任计划批量导入整页
const TalentFilter = lazy(() => import('./pages/admin/TalentFilter.jsx'));
const SuccessionImport = lazy(() => import('./pages/admin/SuccessionImport.jsx'));
// 12.2 关键岗位清单（组 4，2026-10-09）：继任卡与工作台继任覆盖卡进入，侧栏无入口
const KeyPositions = lazy(() => import('./pages/admin/KeyPositions.jsx'));
const ReviewCycles = lazy(() => import('./pages/admin/ReviewCycles.jsx'));
const PerfDashboard = lazy(() => import('./pages/admin/PerfDashboard.jsx'));
const OrgPerf = lazy(() => import('./pages/admin/OrgPerf.jsx'));
const Dashboard = lazy(() => import('./pages/admin/Dashboard.jsx'));
const Departments = lazy(() => import('./pages/admin/Departments.jsx'));
const OrgChart = lazy(() => import('./pages/admin/OrgChart.jsx'));
const Roles = lazy(() => import('./pages/admin/Roles.jsx'));
// AI 治理（core，审计域：模块关闭后只要有调用记录仍可查看）与功能模块开关（超级管理员）
const Modules = lazy(() => import('./pages/admin/Modules.jsx'));
// 第二批 2.8：绩效申诉台（HRBP 与绩效可读）、部门 → HRBP 分工（超级管理员）
const ReviewAppeals = lazy(() => import('./pages/admin/ReviewAppeals.jsx'));
const HrbpCoverage = lazy(() => import('./pages/admin/HrbpCoverage.jsx'));

function Loading() {
  return <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-3)', fontSize: 14 }}>…</div>;
}

// Module pages (e.g. the Behavior Practice learner app at /culture/) are served
// by the server, not by this SPA's routes, so reaching one is a full page load.
// replace(): the /login entry with ?next= should not stay in history.
function FullPageRedirect({ to }) {
  useEffect(() => { window.location.replace(to); }, [to]);
  return <Loading />;
}

// Copy lives here rather than in i18n.jsx's DICT: DICT holds chrome words reused
// across the app, these three strings belong to one component only — same
// co-located `T` pattern every page already uses.
const T404 = {
  zh: {
    title: '页面不存在',
    body: '该页面地址可能已变更或输入有误，请返回首页重新进入。',
    bodyAdmin: '该页面不存在，或你的角色没有访问它的权限。请返回工作台；需要权限请联系 HR。',
    home: '返回首页', console: '返回工作台',
  },
  en: {
    title: 'Page not found',
    body: 'This page may have moved, or the address is incorrect. Return to the home page and try again.',
    bodyAdmin: 'This page does not exist, or your role has no access to it. Return to the dashboard; contact HR if you need access.',
    home: 'Back to Home', console: 'Back to Dashboard',
  },
};

// An unmatched hash used to render as "TopBar + blank page": no explanation and
// no way back. `admin` sends a mistyped console path back to the workbench
// instead of the employee home, since the console sidebar is still around it.
function NotFound({ admin = false }) {
  const { lang } = useI18n();
  const s = T404[lang] || T404.en;
  return (
    <div className="wrap" style={{ padding: '64px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--brand-100)', letterSpacing: 2 }} aria-hidden="true">404</div>
      <h1 style={{ fontSize: 19, fontWeight: 700, margin: '10px 0 8px', color: 'var(--ink)' }}>{s.title}</h1>
      <p style={{ fontSize: 14, color: 'var(--ink-3)', lineHeight: 1.6, maxWidth: 420, margin: '0 auto 20px' }}>{admin ? s.bodyAdmin : s.body}</p>
      <Link className="btn" to={admin ? '/admin' : '/'}>{admin ? s.console : s.home}</Link>
    </div>
  );
}

export default function App() {
  const { user } = useAuth();
  const { pathname, search } = useLocation();

  // White-label: the /api/me payload carries the server-merged brand block
  // (same ride-along pattern as modules). Apply the CSS-variable overrides /
  // tab title once a session exists; the login page applies the identical
  // block itself from /api/env, so both surfaces are covered. No brand in
  // the payload (old server) = no-op. Must run before the early returns
  // below — hooks can't be conditional.
  useEffect(() => { if (user && user.brand) applyBrand(user.brand); }, [user]);
  // Layout v2：body 上的 v2-layout / v2-admin|v2-employee / v2-page-<slug>（v2.css 按它们排版）
  useV2Body(pathname);

  // Still checking the session — hold the frame to avoid a login flash.
  if (user === undefined) return <Loading />;

  // Normalized the way React Router itself matches (case-insensitive, after
  // percent-decoding, trailing slash trimmed) — the same normalizeAdminPath()
  // the console guard uses. Without it #/Reset-Password renders the reset route
  // while the gate below still reads the path as "not a pre-auth page" and
  // bounces the user to /login, i.e. a dead mail link.
  const path = normalizeAdminPath(pathname);
  // Pre-auth pages: reachable with NO session at all. /reset-password belongs
  // here by design — it is the page for people who cannot sign in, and the
  // mailed token (verified server-side) is what authorizes the change, not a
  // session. It stays reachable WITH a session too, including a
  // mustChangePassword one: resetting clears that flag and revokes every
  // session anyway, so bouncing such a user to /change-password would only
  // strand a valid link.
  const preAuth = path === '/login' || path === '/reset-password';

  // Auth gate.
  if (!user && !preAuth) return <Navigate to="/login" replace />;
  // A temporary-password account that signed in from a module page (/#/login?next=/culture/) keeps that
  // next through the forced change: ChangePassword leaves for it with a full load once the new password
  // is saved (the agreed "back to /culture/ after sign-in"). Only whitelisted module pages survive
  // (nextFromSearch); anything else goes to the plain change-password page, then home.
  // user.modules (/api/me): a switched-off module's page is not a valid next — same rule as the server.
  if (user && user.mustChangePassword && path !== '/change-password' && path !== '/reset-password') {
    const next = path === '/login' ? nextFromSearch(search, user.modules) : null;
    return <Navigate to={next ? '/change-password?next=' + encodeURIComponent(next) : '/change-password'} replace />;
  }
  // Already signed in but on /login?next=<module page> (the module page's own
  // session check sent them here, e.g. from another tab): go straight to next
  // with a full load instead of landing on home. nextFromSearch() only passes
  // in-site pages of a switched-ON module such as /culture/ (see nextpath.js);
  // with the module off its page is a 404 on the server, so this lands on home.
  if (user && !user.mustChangePassword && path === '/login') {
    const next = nextFromSearch(search, user.modules);
    return next ? <FullPageRedirect to={next} /> : <Navigate to="/" replace />;
  }
  // Admin-console access: legacy `role==='admin'` OR a custom admin role
  // (adminRoleId, RBAC P1). Old /api/me carries no adminRoleId, so the OR
  // collapses to the legacy check — a new bundle on an old server is unchanged.
  // isAdminPath() rather than pathname.startsWith('/admin'): React Router matches
  // routes case-insensitively and after percent-decoding, so a plain string prefix
  // test let #/ADMIN/employees and #/%61dmin/employees past this gate entirely —
  // the console shell, sidebar and page toolbar rendered for a non-admin employee
  // (APIs still 403, but that is exactly the residual-UI leak this batch closes).
  // hasConsoleAccess() (rbac.js) is that same OR, shared with the employee top
  // bar's "Go to Console" button so the button and this gate cannot drift apart.
  if (user && isAdminPath(pathname) && !hasConsoleAccess(user)) return <Navigate to="/" replace />;
  // Per-domain guard for the console's sub-pages (RBAC P1). The gate above
  // only asks "is this an admin at all"; without this a learning-admin who
  // hand-types #/admin/employees still gets that page's shell and toolbar
  // (「新增员工」「批量导入」) over an empty table — every API behind it already
  // answers 403/404, so this is the interface catching up with the data layer.
  // The route→domain table is web/src/rbac.js, shared with AdminLayout's nav
  // trimming so the sidebar and the guard cannot drift apart. Bounced pages go
  // to /admin — the workbench shell is always reachable, so nobody white-screens.
  // /admin/roles is accounts-domain = super-admin only. An old server sends no
  // grants block and rbac.js reads that as super-admin, so nothing gets locked.
  if (user) {
    const bounce = adminRedirect(user, pathname);
    if (bounce) return <Navigate to={bounce} replace />;
  }

  // Same normalization as the gate above, so a case/encoding variant of a console
  // path doesn't render the employee TopBar and AI panel on top of the console.
  const isAdmin = isAdminPath(pathname);
  const bare = preAuth || path === '/change-password'; // focused, no chrome
  const hideAssist = bare || isAdmin || pathname === '/exam' || pathname.startsWith('/exam/'); // no AI panel during an exam (anti-cheat)

  // Sellable-module switches ride on the /api/me payload. An older server
  // omits the block entirely, so absence must read as "all on" — only an
  // explicit false switches a module off (a new bundle against an old server
  // must never blank the UI).
  const mods = (user && user.modules) || {};
  const on = (m) => modOn(mods, m);

  return (
    <>
      {!bare && !isAdmin && <TopBar />}
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/change-password" element={<ChangePassword forced={!!(user && user.mustChangePassword)} />} />
          {/* Target of the mailed reset link: /#/reset-password?token=… */}
          <Route path="/reset-password" element={<ResetPassword />} />
          {/* A switched-off module's routes are simply not registered, so a
              direct link falls into the catch-all 404 below — the same answer
              the server gives for that module's APIs. /team hides with
              learning because its payload is 100% training data (P2-A). */}
          {on('learning') && (
            <>
              <Route path="/learn" element={<LearningHub />} />
              <Route path="/learning" element={<MyLearning />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/projects" element={<MyProjects />} />
              <Route path="/projects/:id" element={<ProjectHome />} />
              <Route path="/sessions" element={<MySessions />} />
              <Route path="/classes" element={<MyClasses />} />
              <Route path="/team" element={<MyTeam />} />
              <Route path="/course/:id" element={<Course />} />
              <Route path="/course" element={<Course />} />
              <Route path="/program/:id" element={<ProgramDetail />} />
              <Route path="/program" element={<ProgramDetail />} />
              <Route path="/exam-prep/:programId/:examId" element={<ExamPrep />} />
              <Route path="/exam-prep/:examId" element={<ExamPrep />} />
              <Route path="/exam-prep" element={<ExamPrep />} />
              <Route path="/exam/:examId" element={<ExamRunner />} />
              <Route path="/exam" element={<ExamRunner />} />
              <Route path="/result/:attemptId" element={<Result />} />
              <Route path="/result" element={<Result />} />
            </>
          )}
          <Route path="/record" element={<Record />} />
          {/* A manager reading one report's file (D3 + D8). Deliberately NOT
              inside the learning gate above: the payload is cross-domain
              (identity + 入转调离 + 绩效史 + 培训), and GET /api/me/reports/:id
              trims sections by module rather than 404-ing wholesale — closing
              learning must not take a manager's lifecycle/performance view with
              it. Not yours / no such person both answer 404, which the page
              renders as a friendly bilingual notice. */}
          <Route path="/team/:userId" element={<ReportProfile />} />
          {on('performance') && <Route path="/review" element={<Review />} />}
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Dashboard />} />
            {on('learning') && <Route path="training-overview" element={<Overview />} />}
            <Route path="employees" element={<Employees />} />
            {on('learning') && <Route path="projects" element={<AdminProjects />} />}
            <Route path="departments" element={<Departments />} />
            <Route path="org-chart" element={<OrgChart />} />
            <Route path="people/:id" element={<People />} />
            {on('talent') && <Route path="talent-review" element={<TalentReview />} />}
            {on('talent') && <Route path="talent-review/filter/:id" element={<TalentFilter />} />}
            {on('talent') && <Route path="talent-review/succession-import" element={<SuccessionImport />} />}
            {on('talent') && <Route path="talent-review/key-positions" element={<KeyPositions />} />}
            {on('performance') && <Route path="reviews" element={<ReviewCycles />} />}
            {on('performance') && <Route path="perf-dashboard" element={<PerfDashboard />} />}
            {on('performance') && <Route path="orgperf" element={<OrgPerf />} />}
            {/* 第二批 2.8：两页都随绩效模块开关；可见性由 rbac.js 守卫（申诉台 appealDeskVisible，HRBP 分工 roles 域 = 仅超级管理员） */}
            {on('performance') && <Route path="review-appeals" element={<ReviewAppeals />} />}
            {on('performance') && <Route path="hrbp-coverage" element={<HrbpCoverage />} />}
            {/* talent-settings stays put: it is the core field/record-type/
                job-grade configuration page, not the talent module
                (MODULES.md §2.3 归 core). */}
            <Route path="talent-settings" element={<TalentSettings />} />
            {/* brand-settings is core white-label configuration — like
                talent-settings it hangs off no sellable-module switch. */}
            <Route path="brand-settings" element={<BrandSettings />} />
            {/* 角色与授权 (RBAC): accounts domain = super-admin only. The route
                guard above bounces a non-super-admin to /admin before this
                renders; the page keeps its own in-page notice as a backstop. */}
            <Route path="roles" element={<Roles />} />
            {/* 功能模块开关（roles 域 = 只限超级管理员）与 AI 治理（audit 域；ai 模块关闭后只要有调用记录仍可查看） */}
            <Route path="modules" element={<Modules />} />
            {(on('ai') || (user && user.ai && user.ai.history)) && <Route path="ai-governance" element={<Navigate to="/admin/audit?section=ai" replace />} />}
            {on('learning') && (
              <>
                <Route path="content" element={<Content />} />
                <Route path="exams" element={<Exams />} />
                <Route path="questions" element={<Questions />} />
                <Route path="results" element={<Results />} />
                <Route path="requests" element={<Requests />} />
              </>
            )}
            <Route path="audit" element={<Audit />} />
            {/* A bad path under /admin stays in the console — the sidebar is
                still there, so nobody gets thrown back to the employee app. */}
            <Route path="*" element={<NotFound admin />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      {!hideAssist && <MobileTabBar />}
      {/* The assistant only answers about course content, so it leaves with
          the learning module instead of sitting there unable to help (P3-A). */}
      {/* ai 模块默认关闭（defaultOn:false）：必须显式为 true，不能用上面「缺省即开」的 on() */}
      {!hideAssist && on('learning') && on('ai') && <AIChat />}
    </>
  );
}
