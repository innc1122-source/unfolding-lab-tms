// Route manifest for the smoke script (scripts/smoke.js).
//
// Exports:
//   ROUTES            — every route in web/src/App.jsx, with a selector that
//                       proves the page really rendered.
//   resolveParams     — fetches real ids out of the running server for the
//                       routes that take a parameter.
//   AMBIGUOUS_READY   — (optional) selectors shared by more than one route, i.e.
//                       the ones where stale DOM could fake a pass.
//   PREFERRED_EMPLOYEE— (optional) the employee account the ids belong to.
//
// ---------------------------------------------------------------------------
// How `ready` was chosen (read this before editing a selector)
// ---------------------------------------------------------------------------
// Every one of these pages renders a `.wrap` (employee) or `.wrap xxx-wrap`
// (console) shell BEFORE its data arrives, and most of them keep the shell while
// a spinner or a "…" placeholder sits inside it. So the shell class is a *mount*
// marker, not a *rendered* marker, and using it would let a page that fetched
// nothing pass. Each `ready` below is therefore a node that only exists on the
// far side of the component's own data guard:
//
//   * employee pages guard with `if (loading) return <div className="wrap">
//     <div className="greet">…</div></div>` — so any class that appears only in
//     the main return is safe (e.g. `.pg-head`, `.tp-esteps`, `.ml-title`).
//     MyLearning is the exception: it renders `.ml-head`/`.ml-title` during
//     loading too, so it keys on `.ml-toolbar` which needs a non-empty list.
//   * console pages that guard with `if (!data) return <Spin/>` expose a
//     loaded-only class (`.dash-kpis`, `.ppl-id-name`, `.trev-grid`,
//     `.tset-content`, `.rvc-wrap .ppl-card`, `.co-ctable`, `.orgd2-stage`).
//   * console pages built on `<Table loading={q.loading}>` do NOT guard — the
//     card and the table skeleton render immediately. Those key on a real body
//     row: `.xxx-tablecard .semi-table-tbody .semi-table-row`. Semi's own class
//     names, confirmed present in public/dist/assets/*.css.
//
// `ready` is a string when one selector does the job, or an array when the page
// has two legitimate rendered shapes (responsive branch, or rows-vs-empty). The
// array means "any one hit is enough".
//
// `act` (optional) reaches a page that is NOT its own route — one that appears
// only after a click inside the route (the review-cycle detail is switched in by
// setOpenId, not by the router). This matters: the白屏 that shipped in the
// 2026-08-20 handover package lived on exactly such a page, and a route-driven
// crawl could never reach it.
//     act: { waitFor: '<selector to wait for before clicking>',
//            clickText: '按钮文字' | ['查看', 'View'] ,   // 多语言给数组
//            click: '<css selector>' }                    // 或直接给选择器
// A missing click target is reported as a FAIL, never skipped — otherwise a
// renamed button silently downgrades the case to "we tested the list again".
//
// `needs` is likewise a string for one parameter and an ARRAY when a route takes
// two — #/exam-prep/:programId/:examId is the only such route, and it genuinely
// needs both, since substituting one and leaving `:programId` literal in the hash
// would load a different (wrong) page rather than fail loudly. A driver must
// therefore iterate `needs`, not index `params` with it directly.
//
// ---------------------------------------------------------------------------
// Stale DOM: why the ORDER of this list matters
// ---------------------------------------------------------------------------
// Measured in Edge against this build: after `location.hash = '#/classes'` from
// #/team, the OLD page is still mounted at +0ms and only gone by +50ms. So a
// driver that queries immediately can match the previous route's nodes and score
// a false pass. That only bites when two routes share a selector, so the list is
// ordered such that NO TWO NEIGHBOURING ROUTES SHARE A `ready` SELECTOR —
// /sessions and /classes (both `.ml-title`, both empty for this account, DOM
// otherwise identical) are separated by /team, and the five paramless guard
// routes that all show GUARD_FRAME are interleaved with data routes.
// `AMBIGUOUS_READY` below lists the selectors this applies to. If you add or
// reorder routes, keep the invariant. It holds not just for the full list but for
// every degraded run too — --include-side-effects on or off, and with any subset
// of the resolveParams ids unavailable (those routes get skipped, which changes
// who is adjacent to whom). Asserting that is ~15 lines and worth re-running
// after any edit here.
//
// Belt and braces: the safest driver does not rely on the ordering at all — it
// waits for the PREVIOUS route's selector to disappear (or for one settle tick)
// before it starts polling for the new one.
//
// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------
// Only ONE route in this app writes DOMAIN data just by being opened:
// /exam/:examId, whose ExamRunner does `api.post('/api/exam/start')` on mount and
// creates an exam_attempts row every single time. It is marked
// `skipByDefault: true`.
//
// One route writes an AUDIT row by being opened, and that is by design (P3 / D8,
// 2026-09-03): /team/:reportId GETs /api/me/reports/:userId, which appends one
// `manager.view_profile` line to audit_logs — "who looked at whose file" is the
// whole reason a manager may read the full record of anyone in their reporting
// line. It stays in the default run: the row IS the correct record of the read,
// it touches no person's data, and skipping the route would leave a brand-new
// employee-facing page outside the white-screen guard. If you ever smoke a live
// instance, expect one such row per language pass.
//
// Things that LOOK like writes but are not, so they stay in the default run:
//   * /exam  (no examId) — ExamRunner rejects locally without ever POSTing
//     (`examId ? api.post(...) : Promise.reject(...)`), so the paramless form is
//     a pure read of the error branch.
//   * /record — Record.jsx only GETs /api/me/learning-record and /api/me/growth
//     on mount; the appeal POST needs a click.
//   * /review — GETs /api/me/reviews on mount; the self/manager/nudge POSTs need
//     a click.
//   * /admin/* — every console page loads with GETs; every mutation is behind a
//     button or a Popconfirm.
//
// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
// `as` names an account in smoke.js's account table: 'admin' | 'employee' | 'anon',
// plus 'hod' for routes only a department head reaches (第二批 3.2). Console routes
// are admin-only (App.jsx bounces a non-admin off /admin*), and /login is the only
// route that requires being logged OUT (an authenticated user is redirected to '/').
// Since RBAC P1, 'admin' means specifically ADMIN — the built-in 超级管理员.
// Multi-account runs (smoke.js --as=admin,employee,hod,…): a route also runs under
// every other selected account of the same side — 'admin' routes under scoped
// console accounts (a bounce to #/admin is then reported as "no access", skipped,
// not as a failure), paramless 'employee' routes under hod/manager accounts. Routes
// with `needs` stay on the account the ids were resolved for, and so does a route
// marked `crossRun: false` (its rendered state depends on that account's data).
// /change-password is reachable by any signed-in account; it runs as 'employee'
// because that is the stricter of the two and the forced-change banner is the
// employee-facing case.

'use strict';

// The employee account the parameterised employee routes are resolved against.
// T-00229 (Corvina Dumaline) is the deliberately data-rich row in the fake test
// set: 4 assigned programs, a finished exam attempt, a project membership, and 5
// direct reports — so /team, /projects/:id, /program/:id and /result/:attemptId
// all have something to render instead of an empty state.
const PREFERRED_EMPLOYEE = 'T-00229';

// The five paramless "guard" routes (/course, /program, /exam-prep, /exam,
// /exam-prep/:examId) all land in the same framed message: a breadcrumb, then a
// sibling div holding a <p> and a ghost button back to the catalogue. This is
// the shape, and it is worth asserting: an unmatched/param-less link used to be
// exactly how this app produced a white screen, which is bug class #1.
const GUARD_FRAME = '.wrap > .crumb + div > .btn.ghost';

const ROUTES = [
  // ---------------------------------------------------------------- bare pages
  {
    hash: '#/login',
    name: '登录页',
    as: 'anon',
    ready: '.login-card',
    note: '必须先登出：App.jsx 对已登录用户会把 /login 重定向到 /。',
  },
  {
    // 邮件里的重置链接落在这里。token 是假的：本页不会自动提交，所以只是让
    // 表单态（两个密码框 + 规则说明）渲染出来受检；不带 token 时渲染的是
    // 「链接无效」那一屏，覆盖面更小。提交才有写操作，冒烟不点。
    hash: '#/reset-password?token=smoke-not-a-real-token',
    name: '重置密码',
    as: 'anon',
    ready: '.login-card',
    note: '预登录页：App.jsx 的 preAuth 放行，无会话也能开；页面读完 token 会把它从地址栏抹掉。',
  },
  {
    hash: '#/change-password',
    name: '修改密码',
    as: 'employee',
    ready: '.cp-card',
    note: '非强制改密时也能直接打开（多一个「取消」按钮）；提交才有写操作。',
  },

  // ------------------------------------------------------------- employee app
  {
    hash: '#/',
    name: '首页',
    as: 'employee',
    // `.greet` also renders while loading, but only the loaded branch puts the
    // name in a <b> — so require the <b>, not the container.
    ready: '.greet b',
  },
  {
    hash: '#/learning',
    name: '我的学习',
    as: 'employee',
    // `.ml-head`/`.ml-title` render during loading here, unlike the sibling
    // workbench pages — the filter toolbar only appears once the list is in.
    ready: ['.ml-toolbar', '.ml-grid'],
  },
  {
    // 第四批 7：课程目录（公开课程）。有公开课程时出现筛选栏 .cg-toolbar；演示库 / 全新库没有公开课程时
    // 是 .ml-empty 空状态，也算渲染成功（加载中同用 .ml-empty，故只能作兜底）。挂载只 GET，「加入学习」要点击。
    hash: '#/catalog',
    name: '公开课（员工端）',
    as: 'employee',
    ready: ['.cg-wrap .cg-toolbar', '.cg-wrap .ml-empty'],
    note: '只读 GET /api/catalog/courses；加入 / 退出是点击后才写，冒烟不点。',
  },
  {
    hash: '#/projects',
    name: '发展项目列表（员工端）',
    as: 'employee',
    ready: '.cat-title',
  },
  {
    hash: '#/projects/:projectId',
    name: '发展项目详情（员工端）',
    as: 'employee',
    needs: 'projectId',
    ready: '.tp-esteps',
  },
  {
    hash: '#/sessions',
    name: '我的授课（讲师）',
    as: 'employee',
    ready: '.ml-title',
    note: 'T-00229 的 /api/me/sessions 为空 → 走 .ml-empty 空态，只剩共用的 .ml-title 可认。'
        + '所以它和 /classes 之间必须隔开（见顶部 stale DOM 说明）。',
  },
  {
    // Sits between /sessions and /classes on purpose: those two share `.ml-title`
    // and this one does not, so a stale node can never satisfy either of them.
    hash: '#/team',
    name: '我的团队（经理）',
    as: 'employee',
    ready: ['.tm-stats', '.tm-list'],
    // 只在 employee 账号上跑：多账号运行时借跑的账号（普通员工 staff 等）没有下属，空态会被报成 MISS。
    crossRun: false,
    note: 'T-00229 有 5 名直属下属 → 走有数据分支。换成没有下属的账号会因空态报 MISS，'
        + '那是数据问题；宁可显式失败，也不要退回共用的 .ml-title 换来一个假通过。',
  },
  {
    // 经理只读下属档案 (RBAC-DESIGN.md D3 + D8). Sits directly after #/team
    // because that is where it is reached from, and its `ready` is shared with
    // nothing, so it also keeps #/team and #/classes apart. Skipped when the
    // resolver finds nobody reporting to PREFERRED_EMPLOYEE.
    hash: '#/team/:reportId',
    name: '下属档案（经理只读）',
    as: 'employee',
    needs: 'reportId',
    // `.rp-wrap` exists ONLY on the loaded success branch of ReportProfile.jsx;
    // the loading and the denied/404 branches render a bare `.wrap`, and every
    // other class on the page (.grw-card / .grw-meta / .ml-title / .sec) is
    // shared with Record.jsx or MyTeam.jsx.
    ready: '.rp-wrap',
    note: '开一次就落一条 manager.view_profile 审计行 —— 见顶部「Side effects」，是设计如此。',
  },
  {
    hash: '#/classes',
    name: '我的班级（班主任）',
    as: 'employee',
    ready: '.ml-title',
    note: 'T-00229 的 /api/me/classes 为空 → 已知空态，DOM 与 /sessions 空态完全一样。',
  },
  {
    hash: '#/course/:courseId',
    name: '课程学习',
    as: 'employee',
    needs: 'courseId',
    // `.course` is the two-column grid (rail + body) and only exists once the
    // course document is in hand; the loading/404 branches stop at `.crumb`.
    ready: '.course .rail',
  },
  {
    hash: '#/course',
    name: '课程学习（缺 id 的兜底）',
    as: 'employee',
    ready: GUARD_FRAME,
    note: '已知兜底态：没有 id 时应框出「找不到」+返回按钮，而不是白屏。',
  },
  {
    // Separator: no parameter, and a selector shared with nothing — so the two
    // GUARD_FRAME routes around it can never satisfy each other from stale DOM,
    // even in a degraded run where every parameterised route was skipped.
    hash: '#/record',
    name: '我的成长档案',
    as: 'employee',
    // `.rec-wrap` mounts before either fetch resolves (the tabs are static), so
    // key on the two data-gated cards instead: `.grw-card` needs /api/me/growth,
    // `.rec-table` needs a non-empty learning record.
    ready: ['.grw-card', '.rec-table'],
    note: '挂载时只有两个 GET，没有写操作（申诉 POST 要点按钮）。',
  },
  {
    hash: '#/program/:programId',
    name: '培训计划详情',
    as: 'employee',
    needs: 'programId',
    ready: '.pg-head',
  },
  {
    hash: '#/program',
    name: '培训计划详情（缺 id 的兜底）',
    as: 'employee',
    ready: GUARD_FRAME,
    note: '已知兜底态。',
  },
  {
    // Separator, same reason as /record above.
    hash: '#/review',
    name: '绩效评估（员工/经理填写）',
    as: 'employee',
    ready: '.rv-wrap',
    note: '挂载只 GET /api/me/reviews；自评/评下属/催办都是点击才 POST。',
  },
  {
    // 第二批 3.1：团队评估名单（地址栏 ?view=team）。`.rvt-list` 只在 GET /api/me/reviews 落地、
    // 且当前周期有名单时渲染（加载中是 .rv-note，空名单是 .rv-empty），是渲染完成标记，且全站唯一。
    // 只在 employee 账号上跑：借跑的 staff / hod 账号要么没有下属（view=team 不在页签里，
    // 页面回落到「我的评估」），要么下属不同 —— 都会把数据问题报成 MISS。
    // 波次 3 复核：needs teamCycleId —— 登录员工在进行中的季度周期里没有下属时（周期之间、账号表的 employee 不是上级）
    // 页签不出现、页面回落到「我的评估」，按「取不到参数」跳过，不报没渲染出来。
    hash: '#/review?view=team',
    name: '绩效评估（团队评估名单）',
    as: 'employee',
    crossRun: false,
    needs: 'teamCycleId',
    ready: '.rvt-list',
    note: '挂载只 GET /api/me/reviews；提醒、评级都是点击才写。--boot 的 v2 夹具里 employee（SMK-1002）有三名下属。',
  },
  {
    // 第二批 3.1：团队评估单人页（?view=team&item=<review item id>）。数据来自 GET /api/me/reviews/team/:id；
    // `.rvt-person .rvt-step` 是三步卡片，只在单人数据落地后渲染（加载中与 404 都没有 .rvt-step）。
    // teamItemId 由 resolveParams 从后台周期详情里取「直属上级 = 登录员工」的条目，只属于这个账号。
    hash: '#/review?view=team&item=:teamItemId',
    name: '绩效评估（团队评估单人页）',
    as: 'employee',
    needs: 'teamItemId',
    ready: '.rvt-person .rvt-step',
    note: '挂载只 GET team/:id；登记面谈、评级都是点击才写。',
  },
  {
    // 第二批 3.2：部门校准只有 HoD 看得到（smoke.js --as=…,hod；--boot 的 v2 夹具自带 HoD 账号 SMK-1001）。
    // 波次 2 起视图由地址栏 ?view=hod 直接决定（不再点页签）。ready 收紧为 HoD 视图里的
    // DeptCalibration 根节点（`.dcal-hod`，W1-B），它只在组列表和本组明细都落地后才挂载；
    // 加载中是 .rv-note，没有组是 .rv-empty。
    // 波次 3 复核：needs hodCycleId —— 库里没有「进行中的 v2 周期、其中有 HoD 的部门」时谁都不是 HoD，跳过。
    // 只判库里有没有，判不了账号表里的 hod 是不是那位 HoD（smoke.js 只把员工账号传给 resolveParams）。
    hash: '#/review?view=hod',
    name: '绩效评估（HoD 部门校准）',
    as: 'hod',
    needs: 'hodCycleId',
    ready: '.rv-hod .dcal.dcal-hod',
    note: '挂载只 GET；保存、提交、提醒都是点击才写。',
  },
  {
    // 第二批 2.8 绩效申诉：员工的申诉页（?view=history&item=<review item id>，整页）。数据来自 GET /api/me/reviews/:item/appeal；
    // `.rv-ap-page` 只挂在该接口落地后的主返回上（加载中是 .rv-note；404 会去掉 item 回到「我的绩效」，没有 .rv-ap-page）。
    // 任何状态（可申诉、已提交、已有结论、已过期限、本周期不开放）都渲染 .rv-ap-page，所以没有申诉数据的库也照样能查。
    // needs appealItemId：resolveParams 取登录员工在已关闭周期里、已归档（有 recordId）的一条评估；没有就跳过。
    hash: '#/review?view=history&item=:appealItemId',
    name: '绩效申诉（员工申诉页）',
    as: 'employee',
    needs: 'appealItemId',
    ready: '.rv-ap-page',
    note: '挂载只 GET；上传、提交、撤回都是点击才写（提交、撤回另有确认框）。',
  },
  {
    // 第二批 2.8：申诉征询列表（?view=consult）。页签只在 GET /api/me/reviews 的 appealConsults.total > 0 时出现，
    // 否则页面回落到「我的评估」—— 所以 needs appealConsultId：resolveParams 在后台申诉详情里找「征询对象 = 登录员工」的一条，
    // 找不到（库里没有申诉或没有征询，常见）就跳过。`.rv-cs-page` 只在征询列表数据落地后渲染，列表为空也算。
    hash: '#/review?view=consult',
    name: '绩效申诉（征询列表）',
    as: 'employee',
    crossRun: false,
    needs: 'appealConsultId',
    ready: '.rv-cs-page',
    note: '挂载只 GET /api/me/reviews 与 appeal-consults。',
  },
  {
    // 征询详情（整页）：GET /api/me/reviews/appeal-consults/:id 落地后才渲染 `.rv-cs-detail`（列表页没有这个类）。
    // 已关闭的征询同样渲染 .rv-cs-detail（只显示「征询已关闭」）。
    hash: '#/review?view=consult&item=:appealConsultId',
    name: '绩效申诉（征询详情）',
    as: 'employee',
    crossRun: false,
    needs: 'appealConsultId',
    ready: '.rv-cs-detail',
    note: '挂载只 GET；提交意见是点击后确认才写，冒烟不点。',
  },
  {
    hash: '#/exam-prep/:programId/:examId',
    name: '考前说明',
    as: 'employee',
    needs: ['programId', 'examId'],
    // `.ep-head` renders whether or not the exam is unlocked — the lock only
    // swaps the hint text — so this passes even if the account hasn't finished
    // the courses.
    ready: '.ep-head',
  },
  {
    hash: '#/exam-prep/:examId',
    name: '考前说明（只给 examId）',
    as: 'employee',
    needs: 'examId',
    ready: GUARD_FRAME,
    note: '已知兜底态：缺 programId 时提示「请从培训计划里打开」。',
  },
  {
    // Separator between the two GUARD_FRAME routes on either side.
    hash: '#/result',
    name: '考试结果（无 id 兜底）',
    as: 'employee',
    // Result throws inside useAsync when attemptId is missing, so it lands in
    // its own error branch — which still carries `.res-actions`.
    ready: '.res-actions',
    note: '已知兜底态。',
  },
  {
    hash: '#/exam-prep',
    name: '考前说明（无参数兜底）',
    as: 'employee',
    ready: GUARD_FRAME,
    note: '已知兜底态。',
  },
  {
    hash: '#/result/:attemptId',
    name: '考试结果',
    as: 'employee',
    needs: 'attemptId',
    ready: '.res-head',
    note: '只读 GET /api/me/attempts/:id；attemptId 必须属于当前登录员工。',
  },
  {
    // Also the separator that keeps /exam-prep and /exam apart when attemptId
    // could not be resolved and the route above was skipped.
    hash: '#/__smoke-no-such-page',
    name: '404（员工端）',
    as: 'employee',
    // App.jsx's own comment says an unmatched hash used to render "TopBar +
    // blank page". This asserts the replacement is really there.
    ready: 'a.btn[href="#/"]',
    note: '故意打一个不存在的 hash，验证 NotFound 而不是白屏。',
  },
  {
    hash: '#/exam',
    name: '考试（无 examId 兜底）',
    as: 'employee',
    ready: GUARD_FRAME,
    note: '无副作用：没有 examId 时 ExamRunner 本地 reject，根本不发 /api/exam/start。',
  },
  {
    // Last in the employee block on purpose: it is the one route that writes,
    // so when --include-side-effects is on, everything else has already run.
    hash: '#/exam/:examId',
    name: '考试进行中',
    as: 'employee',
    needs: 'examId',
    ready: '.exam-crumb',
    skipByDefault: true,
    note: '副作用：ExamRunner 挂载即 POST /api/exam/start，每跑一次就在库里多一条'
        + '考试记录。默认跳过，--include-side-effects 才跑。',
  },

  // -------------------------------------------------------------- HR console
  {
    hash: '#/admin',
    name: '工作台总览',
    as: 'admin',
    // `.dash-kpis` is also used by OrgChart's diagnostics block, so scope every
    // one of these to Dashboard's own root (`.wrap dash-wrap`) — OrgChart's root
    // is `.wrap`.
    //
    // Three shapes, not one, since分级权限 (RBAC P1) landed: the KPI row is now
    // `{kpis.length > 0 && …}` and all three KPIs belong to the 人员 domain, so a
    // role without people ≥只读 (只读审计员、培训管理员) renders NO `.dash-kpis`
    // at all. Such a role still gets a real page — the module cards it may see
    // (`.dash-grid .dash-card`), or Dashboard's own Empty (`.semi-empty`) when it
    // may see none. Keying on `.dash-kpis` alone would report not-ready for a
    // perfectly healthy page as soon as this runs as anything but 超级管理员.
    ready: ['.dash-wrap .dash-kpis', '.dash-wrap .semi-empty', '.dash-wrap .dash-grid .dash-card'],
  },
  {
    hash: '#/admin/training-overview',
    name: '培训总览',
    as: 'admin',
    // 第三批 4.1：看板换成 .ovx-*（旧 .ov-kpis 不再渲染）。KpiCards 在加载中也渲染（按钮 disabled），
    // 所以就绪标记取「可点的指标卡」—— 只有数据落地后才出现。
    ready: '.ovx-kpis .ovx-kpi:not([disabled])',
  },
  {
    // 第三批 4.2：指标名单整页（?list=<metric>）。整页壳在加载中就渲染，表格自带 loading 骨架；
    // 演示库 / 全新库可能没有逾期人员（空表也算渲染成功），所以只认整页根节点。
    hash: '#/admin/training-overview?list=overdue',
    name: '培训总览 · 逾期名单',
    as: 'admin',
    ready: '.ovx-listpage',
  },
  {
    // 第三批 4.2：员工培训记录整页（?person=<userId>）。needs userId（resolveParams 选的员工）；
    // 加载中 / 404 也有 .ovx-personpage 外壳，所以就绪标记取只在主返回里出现的姓名标题。
    hash: '#/admin/training-overview?person=:userId',
    name: '培训总览 · 员工培训记录',
    as: 'admin',
    needs: 'userId',
    ready: '.ovx-personpage h1.ovx-wrap-title',
  },
  {
    hash: '#/admin/employees',
    name: '员工名册',
    as: 'admin',
    ready: '.emp-tablecard .semi-table-tbody .semi-table-row',
    note: '名册 927 行，必然有 body row；卡片化是纯 CSS（cardify 只加 data-label），'
        + '窄屏下 DOM 仍是 table。',
  },
  {
    hash: '#/admin/projects',
    name: '发展项目管理',
    as: 'admin',
    // 全新库（--boot 不带库）没有项目，页面显示 Empty，也算就绪
    ready: ['.tp-card', '.emp-wrap > .semi-empty'],
    note: '默认是项目卡片栅格；点卡片才进 .ptabs 详情。',
  },
  {
    hash: '#/admin/departments',
    name: '部门与组织单元',
    as: 'admin',
    ready: '.dept-table .semi-table-tbody .semi-table-row',
    note: '272 个部门。',
  },
  {
    hash: '#/admin/org-chart',
    name: '组织架构图',
    as: 'admin',
    // Responsive fork, not a fallback: wide screens mount the d3 canvas,
    // narrow screens render a drill-down list instead. Either is "rendered".
    ready: ['.orgd2-stage', '.orgl-rows'],
    note: '宽屏 d3 画布 / 窄屏下钻列表，两种都算渲染成功。',
  },
  {
    hash: '#/admin/people/:userId',
    name: '人才档案',
    as: 'admin',
    needs: 'userId',
    ready: '.ppl-id-name',
  },
  {
    hash: '#/admin/talent-review',
    name: '人才盘点九宫格',
    as: 'admin',
    ready: '.trev-grid',
  },
  {
    hash: '#/admin/reviews',
    name: '绩效周期管理',
    as: 'admin',
    // The list view renders `.ppl-card` only after `listQ.data` arrives, and it
    // holds either the table or an Empty — both count.
    ready: '.rvc-wrap .ppl-card',
  },
  {
    // Not a route of its own: CycleDetail is switched in by setOpenId. This is
    // the page that white-screened in the 2026-08-20 package (CycleDetail read
    // `lang` without taking it from useI18n), and no route-driven crawl could
    // ever reach it. `ready` is `.rvc-dist` on purpose — that block is where
    // ratingLabel() runs, i.e. the crash site itself, so an unbound identifier
    // there means this selector never appears.
    hash: '#/admin/reviews',
    name: '绩效周期详情(校准视角)',
    as: 'admin',
    // 进行中的周期按钮叫「管理 / Manage」，已关闭的叫「查看 / View」—— 列表第一行是哪种取决于库，
    // 四个都认。v2 周期（--boot 的夹具）详情缺省是部门视图，没有 .rvc-dist，用只在详情里出现的
    // 「返回」按钮兜住；旧流程周期仍以 .rvc-dist 为准。
    act: {
      waitFor: '.rvc-wrap .semi-table-tbody .semi-table-row',
      clickText: ['查看', 'View', '管理', 'Manage'],
    },
    ready: ['.rvc-dist', '.rvc-wrap .ppl-back'],
  },
  {
    // 第二批 2.3-D：周期详情走地址栏（?cycle=&view=），通知和书签直达。cycleId 由 resolveParams 取
    // 一个 v2 周期（优先进行中、优先含登录员工下属的那个）；没有 v2 周期的库整组跳过。
    // `.rvc-board` 只在周期详情落地后的看板分支里渲染。
    hash: '#/admin/reviews?cycle=:cycleId&view=board',
    name: '绩效周期看板（地址栏直达）',
    as: 'admin',
    needs: 'cycleId',
    ready: '.rvc-board',
    note: '只读 GET 周期详情；数字下钻是点击后的弹窗。',
  },
  {
    // 部门视图（v2 周期缺省视图）：部门表要有真实行，Semi 表格骨架不算。
    hash: '#/admin/reviews?cycle=:cycleId&view=depts',
    name: '绩效周期部门列表（地址栏直达）',
    as: 'admin',
    needs: 'cycleId',
    ready: '.rvc-depts .semi-table-tbody .semi-table-row',
    note: '确认、退回、提醒都在按钮后面。',
  },
  {
    // 2.2 HR 部门明细（&unit=<一级部门 id>）：GET /review-cycles/:id/depts/:unit 落地后才挂 DeptCalibration（hr 模式）。
    hash: '#/admin/reviews?cycle=:cycleId&view=depts&unit=:unitId',
    name: '绩效周期部门明细（HR 校准）',
    as: 'admin',
    needs: ['cycleId', 'unitId'],
    ready: '.rvc-unit .dcal.dcal-hr',
    note: '只读 GET；校准、提醒、导出都是点击。',
  },
  {
    // 第二批 2.8 绩效申诉台（列表视图）。超级管理员（账号表的 admin）按「绩效管理 + 空范围」能看到全部申诉的状态行。
    // `.rap-page` 只挂在 GET /api/admin/review-appeals 落地后的主返回上（加载中是 Spin）；没有申诉的库显示空状态，
    // 一样有 .rap-page —— 所以不需要参数，任何库都能跑。
    hash: '#/admin/review-appeals',
    name: '绩效申诉台',
    as: 'admin',
    ready: '.rap-page',
    note: '只读 GET；开始处理、征询、结论、转交都在按钮与确认框后面。',
  },
  {
    // 申诉处理页（?appeal=<id>，整页）。超级管理员对有 HRBP 的部门只看到状态（meta 视图），对没有 HRBP 的部门是处理人（full 视图）；
    // 两种视图都渲染 `.rap-case`（只在 GET /api/admin/review-appeals/:id 落地后挂载，列表视图没有这个类）。
    // needs appealId：resolveParams 取列表第一条；库里没有申诉（常见）就跳过。
    hash: '#/admin/review-appeals?appeal=:appealId',
    name: '绩效申诉处理页',
    as: 'admin',
    needs: 'appealId',
    ready: '.rap-case',
    note: '只读 GET；任何写操作都要先点按钮并确认，冒烟不点。',
  },
  {
    // 第二批 2.8 HRBP 分工（系统设置，仅超级管理员）。`.hrbp-page` 只挂在 GET /api/admin/review-appeals/coverage 落地后的主返回上；
    // 没有任何分工时显示「未覆盖」提示与部门树，仍有 .hrbp-page。
    hash: '#/admin/hrbp-coverage',
    name: 'HRBP 分工',
    as: 'admin',
    ready: '.hrbp-page',
    note: '超管专属页，跟着 ADMIN 会话跑；只读 GET，保存在弹窗按钮后面，冒烟不会写分工。',
  },
  {
    hash: '#/admin/talent-settings',
    name: '人才字段配置',
    as: 'admin',
    // `.tset-wrap` is shared with Departments and OrgChart's error branches;
    // `.tset-content` belongs to this page only and sits behind the `!cfg` guard.
    ready: '.tset-content',
  },
  {
    hash: '#/admin/brand-settings',
    name: '品牌设置',
    as: 'admin',
    // 加载/错误分支只渲染 `.wrap tset-wrap`（Spin/Banner），`.brandset-wrap`
    // 只挂在 GET /api/admin/brand-config 落地后的主返回上 —— 渲染完成标记，
    // 且全站唯一（.tset-color/.ppl-card 都和别的页共用，不能用）。
    ready: '.brandset-wrap',
    note: '只读 GET；保存/上传都在按钮后面，冒烟不会写 config。',
  },
  {
    hash: '#/admin/roles',
    name: '角色与授权',
    as: 'admin',
    // 三个前置分支（非超管的 Banner、加载失败的 Banner、Spin）都只渲染
    // `.wrap tset-wrap`，主返回才有角色列表 —— 所以任何 tset-* 类都是挂载标记。
    // `.adm-nav-item` 全站有三处：侧栏（`.adm-side` 里）、字段设置的类型菜单
    // （`.ppl-card > .tset-cols > .tset-menu` 里）、以及这一页的角色列表按钮
    // （`.ppl-card` 的**直接**子元素）。所以「.ppl-card 的直接子 .adm-nav-item」
    // 只此一家，且必须等 GET /api/admin/roles 落地才有 —— 渲染完成标记。
    ready: '.ppl-card > .adm-nav-item',
    note: '超管专属页：Roles.jsx 对 isSuperAdmin=false 直接回一条 Banner，所以这条'
        + '用例只在 ADMIN（内置超级管理员）会话下有意义，跟着管理员那一趟跑。'
        + '库里恒有 6 个内置角色且超管角色不可删，角色列表不会空。'
        + '只读 GET /api/admin/roles + /api/admin/roster；建/改/删角色都在按钮后面。',
  },
  {
    // 功能模块（只有超级管理员能进，与角色与授权同一道门）。加载中只有 Spin、失败是 Banner，`.mods-wrap .mods-list`
    // 只在 GET 落地后的主返回里 —— 渲染完成标记，全站唯一。第二批 3.2 V4（说明文字行宽）要查这一页。
    hash: '#/admin/modules',
    name: '功能模块',
    as: 'admin',
    ready: '.mods-wrap .mods-list',
    note: '只读 GET；模块开关、AI 开关都是点击才写。',
  },
  {
    hash: '#/admin/content',
    name: '课程与培训计划',
    as: 'admin',
    // 第三批 10.3：课程库只有列表视图（.co-ctable，一行一门课），卡片视图 .co-clist 已删除；
    // 没有课程时是 .co-nocourse 空状态卡片，也算渲染成功。
    ready: ['.co-ctable', '.co-nocourse'],
    note: '15 门课；加载/错误走 .co-emptycard/.co-nocard，不会误判。',
  },
  {
    hash: '#/admin/exams',
    name: '考试管理',
    as: 'admin',
    ready: '.exm-tablecard .semi-table-tbody .semi-table-row',
    note: '2 场已发布考试。',
  },
  {
    // 第四批：考试编辑页的「组卷」子视图（地址栏 &view=paper）。整页编辑器加载完才渲染 .exc-page
    // （加载中是 .exm-page-loading）；随机抽题考试同样能打开组卷视图。挂载只 GET，保存要点击。
    hash: '#/admin/exams?edit=:examId&view=paper',
    name: '考试编辑 · 组卷',
    as: 'admin',
    needs: 'examId',
    ready: '.exc-page',
    note: '只读；加题 / 移除只改页面草稿，保存才写。',
  },
  {
    // 第四批：「预览试卷」子视图（&view=preview）：固定题目按卷面顺序，随机抽题按当前设置抽一份样卷（只在页面上抽）。
    hash: '#/admin/exams?edit=:examId&view=preview',
    name: '考试编辑 · 预览试卷',
    as: 'admin',
    needs: 'examId',
    ready: '.excp-page',
    note: '只读；「换一份」只在页面上重抽，不写库。',
  },
  {
    hash: '#/admin/questions',
    name: '题库',
    as: 'admin',
    ready: '.qb-tablecard .semi-table-tbody .semi-table-row',
    note: '69 道题。',
  },
  {
    hash: '#/admin/results',
    name: '考试成绩',
    as: 'admin',
    // 全新库（--boot 不带库）没有作答记录，表格显示 Empty，也算就绪
    ready: ['.rs-tablecard .semi-table-tbody .semi-table-row', '.rs-tablecard .semi-empty'],
    note: '15 条作答记录。',
  },
  {
    hash: '#/admin/requests',
    name: '选课与提名审批',
    as: 'admin',
    // Two stacked sections, each independently rows-or-Empty. Right now
    // /api/admin/enroll-requests is 0 (Empty) and /api/admin/nominations is 3
    // (rows), so both shapes are live on this one page — hence both selectors.
    ready: ['.emp-wrap .semi-table-tbody .semi-table-row', '.emp-wrap .semi-empty'],
    note: '选课申请当前为 0（Empty），提名有 3 条（表格）。.emp-wrap 与员工名册/'
        + '发展项目共用，靠 React 每次只挂载一个路由来区分。',
  },
  {
    hash: '#/admin/audit',
    name: '操作日志',
    as: 'admin',
    ready: '.audit-tablecard .semi-table-tbody .semi-table-row',
    note: '8 条日志。',
  },
  {
    hash: '#/admin/__smoke-no-such-page',
    name: '404（控制台内）',
    as: 'admin',
    // App.jsx keeps a bad /admin path inside the console (sidebar stays), so the
    // way back points at /admin, not /.
    ready: 'a.btn[href="#/admin"]',
    note: '故意打一个不存在的控制台 hash，验证留在控制台里的 NotFound。',
  },
];

// Selectors that more than one route relies on — computed, not hand-listed, so
// it cannot drift out of date. These are the ones where a stale previous page
// could score a false pass (see the "Stale DOM" note at the top). The list is
// ordered by the route order above. A driver that settles between routes can
// ignore this; one that polls immediately should treat these as needing the
// previous route's DOM to be gone first.
const AMBIGUOUS_READY = (() => {
  const count = new Map();
  for (const r of ROUTES) {
    for (const s of (Array.isArray(r.ready) ? r.ready : [r.ready])) {
      count.set(s, (count.get(s) || 0) + 1);
    }
  }
  return [...count.entries()].filter(([, n]) => n > 1).map(([s]) => s);
})();

// ---------------------------------------------------------------------------
// resolveParams
// ---------------------------------------------------------------------------
// `apiGet(path) -> Promise<json>` comes from the driver and already carries an
// admin session. Everything here is a GET.
//
// Design note: there is no admin endpoint that reports one employee's course
// assignments, so programId/courseId/examId are derived a different way —
// /api/admin/overview reports `assigned` per program, and the top one (nho,
// 919 of 927 accounts) is mandatory for effectively everybody, so it is safe to
// assume the smoke employee has it. Preferring a program that also owns a
// published exam means one programId serves /program/:id, /exam-prep/:p/:e and
// /course/:id at once, all consistent with each other.
//
// Every step is independently guarded: one dead endpoint nulls one id and the
// driver skips just the routes that need it, instead of losing the whole run.
async function resolveParams(apiGet, opts) {
  // smoke.js passes the employee account it will actually log in as (--accounts,
  // the --boot fixture, …) so the ids below belong to that person.
  const preferred = (opts && opts.preferredEmployee) || PREFERRED_EMPLOYEE;
  const out = {
    // Extra key, additive to the contract: which employee the ids belong to, so
    // the driver can log in as the right person. All fake-data employees share
    // the password Test1234.
    employeeId: null,
    userId: null,
    projectId: null,
    programId: null,
    courseId: null,
    examId: null,
    attemptId: null,
    reportId: null,
    // 第二批 3.2（W3-C）：绩效 v2 的地址栏直达路由
    cycleId: null,     // 一个 v2 周期（后台 ?cycle=）
    unitId: null,      // 该周期里的一个一级部门（后台 &unit=）
    teamItemId: null,  // 该周期里直属上级 = 登录员工的一条评估（员工端 ?view=team&item=）
    teamCycleId: null, // 进行中、非年度、登录员工在其中有下属的周期（新旧流程都算；员工端 ?view=team 的守卫）
    hodCycleId: null,  // 进行中、其中有 HoD 部门的 v2 周期（员工端 ?view=hod 的守卫）
    // 第二批 2.8 绩效申诉
    appealItemId: null,    // 登录员工在已关闭周期里已归档的一条评估（员工申诉页 ?view=history&item=）
    appealConsultId: null, // 征询对象 = 登录员工的一条征询（?view=consult 的守卫与详情）
    appealId: null,        // 后台申诉台列表的第一条（?appeal=）
  };
  const notes = [];
  const tryGet = async (path) => {
    try {
      return await apiGet(path);
    } catch (err) {
      notes.push(`GET ${path} 失败：${(err && err.message) || err}`);
      return null;
    }
  };

  // ---- 1. who are we resolving for -------------------------------------
  const roster = await tryGet('/api/admin/roster');
  const people = Array.isArray(roster) ? roster : [];
  const employees = people.filter((u) => u.role !== 'admin' && u.active !== false);
  const attemptsRaw = await tryGet('/api/admin/attempts');
  const attempts = Array.isArray(attemptsRaw) ? attemptsRaw : [];

  let me = employees.find((u) => u.employeeId === preferred) || null;
  if (!me) {
    // The rich account is gone (reseed / different dataset). Fall back to
    // somebody who at least has an exam attempt, so /result/:attemptId still
    // gets covered; otherwise any active employee.
    const withAttempt = new Set(attempts.map((a) => a.userId));
    me = employees.find((u) => withAttempt.has(u.id)) || employees[0] || null;
    if (me) notes.push(`${preferred} 不在名册里，改用 ${me.employeeId}`);
  }
  if (me) {
    out.userId = me.id;         // /admin/people/:userId
    out.employeeId = me.employeeId; // who the driver should log in as
  } else {
    notes.push('名册里没有可用员工账号，员工端带参路由全部跳过');
  }

  // ---- 1b. reportId — somebody in `me`'s reporting line ------------------
  // Direct report first (depth 1 renders the "直接下属" branch); if this account
  // has none, any grandchild still exercises the same page. Nobody at all →
  // the route is skipped, exactly like a missing attemptId.
  if (me) {
    const direct = employees.filter((u) => u.managerId === me.id);
    let pick = direct[0] || null;
    if (!pick) {
      const kids = new Set(direct.map((u) => u.id));
      pick = employees.find((u) => kids.has(u.managerId)) || null;
    }
    if (pick) out.reportId = pick.id;
    else notes.push(`${me.employeeId} 没有下属，#/team/:reportId 跳过`);
  }

  // ---- 2. attemptId — must belong to `me`, or /api/me/attempts/:id 403s ----
  if (me) {
    const mine = attempts.find((a) => a.userId === me.id && !a.voided)
      || attempts.find((a) => a.userId === me.id);
    if (mine) out.attemptId = mine.id;
    else notes.push(`${me.employeeId} 没有考试记录，/result/:attemptId 跳过`);
  }

  // ---- 3. programId / examId / courseId --------------------------------
  const overview = await tryGet('/api/admin/overview');
  const perProgram = (overview && Array.isArray(overview.perProgram)) ? overview.perProgram : [];
  // Widest reach first: the more accounts a program is assigned to, the safer
  // the assumption that our employee is one of them.
  const byReach = [...perProgram].sort((a, b) => (b.assigned || 0) - (a.assigned || 0));

  const examsRaw = await tryGet('/api/admin/exams');
  const exams = (Array.isArray(examsRaw) ? examsRaw : []).filter((e) => e.status === 'published');

  let program = byReach.find((p) => (p.assigned || 0) > 0 && exams.some((e) => e.programId === p.id));
  if (!program) {
    // No assigned program owns a published exam — take the widest-assigned one
    // anyway so /program/:id and /course/:id still run, and let exam-prep skip.
    program = byReach.find((p) => (p.assigned || 0) > 0) || null;
    if (program) notes.push('没有「已分配且带已发布考试」的培训计划，/exam-prep 跳过');
  }
  if (program) {
    out.programId = program.id;
    const exam = exams.find((e) => e.programId === program.id);
    if (exam) out.examId = exam.id;
  } else {
    notes.push('没有任何已分配的培训计划，/program、/course、/exam-prep 全部跳过');
  }

  // A program's courseIds come from the content endpoint, not the overview.
  if (out.programId) {
    const content = await tryGet('/api/admin/content?kind=program');
    const programs = (content && Array.isArray(content.programs)) ? content.programs
      : (Array.isArray(content) ? content : []);
    const doc = programs.find((p) => p.id === out.programId);
    const cid = doc && Array.isArray(doc.courseIds) ? doc.courseIds[0] : null;
    if (cid) out.courseId = cid;
    else notes.push(`培训计划 ${out.programId} 没有课程，/course/:courseId 跳过`);
  }

  // ---- 4. projectId — must be one `me` is a member of ------------------
  if (me) {
    const list = await tryGet('/api/admin/tprojects');
    const projects = Array.isArray(list) ? list : [];
    // A draft project has no members and a closed one has no next activity, so
    // walk running projects (biggest roster first) before anything else.
    const order = [...projects].sort((a, b) => {
      const rank = (p) => (p.status === 'running' ? 0 : p.status === 'closed' ? 1 : 2);
      return rank(a) - rank(b) || (b.memberCount || 0) - (a.memberCount || 0);
    });
    for (const p of order) {
      if (!p.memberCount) continue;
      const doc = await tryGet(`/api/admin/tprojects/${p.id}`);
      const members = (doc && Array.isArray(doc.members)) ? doc.members : [];
      if (members.some((m) => m.userId === me.id)) { out.projectId = p.id; break; }
    }
    if (!out.projectId) notes.push(`${me.employeeId} 不在任何发展项目里，/projects/:id 跳过`);
  }

  // ---- 5. cycleId / unitId / teamItemId — 绩效 v2（第二批 3.2，W3-C）----------
  // 只看 v2 周期（旧流程没有看板、部门视图和团队单人页）。进行中的优先；同为进行中时，
  // 优先「有登录员工下属」的那个，这样三条路由落在同一个周期、同一个部门上。
  // teamItemId 只在登录员工就是首选账号时才取（换了人，条目就不归他，只会得到 404）。
  const cyclesRaw = await tryGet('/api/admin/review-cycles');
  const v2 = (Array.isArray(cyclesRaw) ? cyclesRaw : []).filter((c) => c.flow === 'v2')
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1));
  const detailCache = new Map();
  const detailOf = async (id) => {
    if (!detailCache.has(id)) detailCache.set(id, await tryGet(`/api/admin/review-cycles/${encodeURIComponent(id)}`));
    return detailCache.get(id);
  };
  let picked = null;
  for (const c of v2.slice(0, 6)) {
    const d = await detailOf(c.id);
    if (!d || !Array.isArray(d.items)) continue;
    const mine = me && me.employeeId === preferred && c.status === 'open'
      ? d.items.find((i) => i.managerId === me.id) : null;
    if (!picked || (mine && !picked.mine)) picked = { c, d, mine };
    if (mine) break;
  }
  if (picked) {
    out.cycleId = picked.c.id;
    const depts = Array.isArray(picked.d.depts) ? picked.d.depts : [];
    const unit = (picked.mine && depts.find((x) => (picked.mine.deptPath || []).includes(x.dept1Id)))
      || depts.find((x) => (x.headcount || 0) > 0) || depts[0];
    if (unit && unit.dept1Id) out.unitId = unit.dept1Id;
    else notes.push(`周期 ${picked.c.id} 没有部门行，&unit= 跳过`);
    if (picked.mine) out.teamItemId = picked.mine.id;
    else notes.push(`没有进行中的 v2 周期里有 ${me ? me.employeeId : '登录员工'} 的下属，?view=team&item= 跳过`);
  } else {
    notes.push('库里没有 v2 绩效周期，后台 ?cycle= 直达与团队单人页跳过（--boot 的 v2 夹具会建一个）');
  }
  // 团队评估名单（?view=team）：与 GET /api/me/reviews 的 teamRows 同一条件（store.listTeamReviewItems）——
  // 进行中、非年度的周期（新旧流程都算）里直属上级 = 登录员工。只对首选账号判（换了人，名单就不是他的）。
  const allCycles = Array.isArray(cyclesRaw) ? cyclesRaw : [];
  if (me && me.employeeId === preferred) {
    for (const c of allCycles.filter((x) => x.status === 'open' && x.kind !== 'annual').slice(0, 8)) {
      const d = await detailOf(c.id);
      if (d && Array.isArray(d.items) && d.items.some((i) => i.managerId === me.id)) { out.teamCycleId = c.id; break; }
    }
  }
  if (!out.teamCycleId) notes.push(`${me ? me.employeeId : '登录员工'} 在进行中的季度周期里没有下属（没有团队评估页签），?view=team 跳过`);
  // HoD 部门校准（?view=hod）：isHod = 进行中的 v2 周期里有本人担任 HoD 的组（hodGroupsFor）
  for (const c of v2.filter((x) => x.status === 'open').slice(0, 6)) {
    const d = await detailOf(c.id);
    if (d && Array.isArray(d.depts) && d.depts.some((x) => x && x.hod)) { out.hodCycleId = c.id; break; }
  }
  if (!out.hodCycleId) notes.push('没有进行中的 v2 周期里有 HoD 的部门，?view=hod 跳过');

  // ---- 6. 绩效申诉（第二批 2.8）--------------------------------------------
  // appealItemId：登录员工在已关闭周期里、已归档（有 recordId）的评估；已告知结果（resultsAt）的周期优先，
  // 没有告知的也行（申诉页照样渲染「本周期不开放」状态）。只对首选账号取（换了人，条目就不归他，只会 404）。
  if (me && me.employeeId === preferred) {
    const closed = allCycles.filter((x) => x.status === 'closed')
      .sort((a, b) => (b.resultsAt ? 1 : 0) - (a.resultsAt ? 1 : 0) || String(b.closedAt || '').localeCompare(String(a.closedAt || '')));
    for (const c of closed.slice(0, 8)) {
      const d = await detailOf(c.id);
      const it = d && Array.isArray(d.items) ? d.items.find((i) => i.userId === me.id && i.recordId) : null;
      if (it) { out.appealItemId = it.id; break; }
    }
  }
  if (!out.appealItemId) notes.push(`${me ? me.employeeId : '登录员工'} 在已关闭周期里没有归档的评估，员工申诉页跳过`);
  // appealId / appealConsultId：后台申诉台（超级管理员看得到全部行）。征询只在 full 视图的详情里有（超级管理员是
  // 没有 HRBP 的部门的处理人），所以最多看前 20 条 full 行；performance 关闭或接口不存在时整段跳过。
  const desk = await tryGet('/api/admin/review-appeals');
  const deskRows = desk && Array.isArray(desk.items) ? desk.items : [];
  if (deskRows.length) out.appealId = deskRows[0].id;
  else notes.push('后台申诉台没有申诉，申诉处理页跳过');
  if (me && me.employeeId === preferred) {
    for (const r of deskRows.filter((x) => x.view === 'full').slice(0, 20)) {
      const d = await tryGet(`/api/admin/review-appeals/${encodeURIComponent(r.id)}`);
      const cs = d && d.appeal && Array.isArray(d.appeal.consults) ? d.appeal.consults : [];
      const mine = cs.find((x) => x && x.consultee && x.consultee.id === me.id);
      if (mine) { out.appealConsultId = mine.id; break; }
    }
  }
  if (!out.appealConsultId) notes.push(`${me ? me.employeeId : '登录员工'} 没有被征询过申诉意见（或超级管理员看不到征询），?view=consult 跳过`);

  if (notes.length) out.notes = notes;
  return out;
}

// ---------------------------------------------------------------------------
// v2 夹具（第二批 3.2；smoke.js --boot 的全新库默认种它，--seed=v2 也可种进一个库副本）
// ---------------------------------------------------------------------------
// 为什么要有：make-demo-db 只建旧流程周期，旧的冒烟账号 T-00229 也只在假数据测试集里有，
// HoD 的部门校准、上级的团队评估在演示库和全新库里都没有页面可查。夹具只走公开的管理接口
// （和 test/review-v2.test.js 同一套调用），所以服务端改了实现也照样能种；每一步失败只记一条
// 说明、不中断，页面缺数据时由对应路由自己报 not-ready。
// 只允许种进一次性服务（smoke.js 只在 --boot 时调用它）。
//   QA 部门「Smoke Calibration Dept」：HoD → 上级 → 三名员工（其中两个长名字，用来压排版）。
//   v2 季度周期：员工一自评、登记面谈、上级已评 B；员工二只交了自评；员工三什么都没做；上级本人也交了自评。
//   账号：employee = 上级 SMK-1002（有下属、有自评，对应假数据集里 T-00229 的角色，员工端带参路由按他解析），
//   staff = 普通员工 SMK-1003，hod = SMK-1001。
//   工号用真实格式（字母前缀 + 数字，同 T-00001 / DP-1001）：token-split 只认这种形状，长名字行上「(SMK-1004)」被折成两行
//   才查得出来（§15 V2 / K8 回归；审查：原先的 SMK-E2 形状永远不会触发）。
const FIXTURE_PASSWORD = 'Smoke-v2-2026';
const FIXTURE = {
  dept: 'Smoke Calibration Dept',
  people: [
    { key: 'hod', employeeId: 'SMK-1001', name: 'Hana Smoke-Hod' },
    { key: 'manager', employeeId: 'SMK-1002', name: 'Marco Antonio Dela Cruz-Villanueva', manager: 'hod' },
    { key: 'employee', employeeId: 'SMK-1003', name: 'Eve Smoke', manager: 'manager' },
    { key: 'e2', employeeId: 'SMK-1004', name: 'Maria Concepcion Bautista-Santiago de los Reyes', manager: 'manager' },
    { key: 'e3', employeeId: 'SMK-1005', name: 'Ed Three', manager: 'manager' },
  ],
};
const fixtureEid = (key) => FIXTURE.people.find((p) => p.key === key).employeeId;

// H = test/helpers.js（makeClient / loginAs）；adminCreds = smoke.js 账号表里的 admin。
async function seedFixture(base, H, adminCreds) {
  const notes = [];
  const step = async (label, fn) => {
    try {
      const r = await fn();
      if (r && typeof r.status === 'number' && r.status !== 200) notes.push(`${label}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
      return r;
    } catch (e) { notes.push(`${label}: ${e.message}`); return null; }
  };
  const admin = await H.loginAs(base, adminCreds);
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const clients = {};
  for (const p of FIXTURE.people) {
    const r = await step(`建 ${p.employeeId}`, () => admin.post('/api/admin/employees', { name: p.name, employeeId: p.employeeId, department: FIXTURE.dept, jobLevel: 'P5' }));
    if (!r || r.status !== 200 || !r.data.password) continue;
    const c = H.makeClient(base);
    await step(`${p.employeeId} 首次登录`, () => c.login({ employeeId: p.employeeId, password: r.data.password }));
    await step(`${p.employeeId} 改密`, () => c.post('/api/auth/change-password', { currentPassword: r.data.password, newPassword: FIXTURE_PASSWORD }));
    clients[p.key] = c;
  }
  const roster = ((await step('读名册', () => admin.get('/api/admin/employees'))) || {}).data || [];
  const id = {};
  for (const p of FIXTURE.people) { const u = roster.find((x) => x.employeeId === p.employeeId); if (u) id[p.key] = u.id; }
  for (const p of FIXTURE.people) {
    if (p.manager && id[p.key] && id[p.manager]) await step(`${p.employeeId} 设上级`, () => admin.put(`/api/admin/employees/${id[p.key]}`, { managerId: id[p.manager] }));
  }
  const depts = ((await step('读部门', () => admin.get('/api/admin/departments'))) || {}).data || [];
  const dept = (Array.isArray(depts) ? depts : []).find((d) => d.name === FIXTURE.dept);
  if (dept && id.hod) await step('设 HoD', () => admin.put(`/api/admin/departments/${dept.id}`, { ownerId: id.hod }));
  else notes.push('没找到夹具部门或 HoD，部门校准页会是空的');
  const everyone = FIXTURE.people.map((p) => id[p.key]).filter(Boolean);
  await step('指派 nho', () => admin.post('/api/admin/assignments/bulk', { userIds: everyone, programId: 'nho', dueAt: day(30), action: 'assign' }));
  const q = Math.floor(new Date().getMonth() / 3) + 1;
  const cyc = await step('建 v2 周期', () => admin.post('/api/admin/review-cycles', {
    name: `${new Date().getFullYear()}Q${q} Smoke v2`, flow: 'v2', kind: 'quarter',
    dueAt: day(10), dueRateAt: day(17), dueCalibAt: day(24),
    userIds: ['manager', 'employee', 'e2', 'e3'].map((k) => id[k]).filter(Boolean),
  }));
  const cycleId = cyc && cyc.status === 200 && cyc.data.cycle ? cyc.data.cycle.id : null;
  if (cycleId) {
    const detail = ((await step('读周期', () => admin.get(`/api/admin/review-cycles/${cycleId}`))) || {}).data || {};
    const item = {};
    for (const it of detail.items || []) item[it.employeeId] = it.id;
    const self = { outcomes: ['完成季度目标：把夜班交接做成标准流程'], challenges: '跨部门排期', feedback: '多一些跨部门同步', goalsNext: ['下季度目标'] };
    const E1 = item[fixtureEid('employee')], E2 = item[fixtureEid('e2')], M = item[fixtureEid('manager')];
    if (clients.employee && E1) {
      await step('员工一自评', () => clients.employee.post(`/api/me/reviews/${E1}/self`, self));
      await step('员工一登记面谈', () => clients.employee.post(`/api/me/reviews/${E1}/one-on-one`, { done: true }));
    }
    if (clients.manager && E1) await step('上级评员工一', () => clients.manager.post(`/api/me/reviews/${E1}/manager`, { rating: 'B', oneOnOneDone: true }));
    if (clients.e2 && E2) await step('员工二自评', () => clients.e2.post(`/api/me/reviews/${E2}/self`, self));
    if (clients.manager && M) await step('上级本人自评', () => clients.manager.post(`/api/me/reviews/${M}/self`, self));
  }
  const acct = (k) => ({ employeeId: fixtureEid(k), password: FIXTURE_PASSWORD, side: 'employee' });
  const accounts = {};
  // 账号名与路由的 as 对齐：employee 是有下属的上级（/team、/team/:id 才有内容），staff 是普通员工
  if (clients.manager) accounts.employee = acct('manager');
  if (clients.employee) accounts.staff = acct('employee');
  if (clients.hod) accounts.hod = acct('hod');
  return { accounts, cycleId, notes };
}

module.exports = { ROUTES, resolveParams, AMBIGUOUS_READY, PREFERRED_EMPLOYEE, FIXTURE, seedFixture };
