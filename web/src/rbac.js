// RBAC P1 — 后台「路由 → 可售模块 / 能力域」对照表的单一事实来源。
//
// 侧栏导航裁剪(AdminLayout.jsx)与 /admin/* 路由守卫(App.jsx)都从这里取表:
// 表只有一份,两处就不会漂移。以前这张表长在 AdminLayout 的 GROUPS 里,App.jsx
// 只整体守 /admin,于是 learning-admin 手敲 #/admin/employees 仍能渲出该页外壳
// 与工具栏(数据层安全 —— 所有 API 回 403/404 —— 但界面显残)。
//
// 每条:
//   path   路由(:段 为占位符,匹配任意非空段)
//   group  侧栏分组 id;顺序即侧栏顺序
//   module 可售模块开关名(MODULES.md);null = core,开关永不隐藏它
//   domain RBAC 能力域(/api/me 的 grants);null = 外壳页,恒可见/恒可达
//   end    NavLink 的精确匹配(只有工作台需要)
//   nav    false = 有路由但侧栏无入口(员工档案详情从列表点进去)
//
// 向后兼容铁律(与 modules / brand 同一条):老服务的 /api/me 不带 grants 块,
// 「没有 grants」必须读成「超管,全放行」—— 新前端跑在老服务上绝不能把侧栏清空
// 或把页面弹走。roles 域只属超管,任何 grant 都授不出它(D6:接管原 accounts 的锁定;
// accounts 域现在可授予、受部门范围约束)。
export const ADMIN_PAGES = [
  { path: '/admin', group: 'shell', module: null, domain: null, end: true },

  { path: '/admin/employees', group: 'people', module: null, domain: 'people' },
  { path: '/admin/org-chart', group: 'people', module: null, domain: 'people' },
  { path: '/admin/departments', group: 'people', module: null, domain: 'people' },
  // 员工档案详情:侧栏无入口,但守卫要认得它,否则点列表进详情会被弹回工作台。
  { path: '/admin/people/:id', group: 'people', module: null, domain: 'people', nav: false },

  // 绩效单设一组（IA D-10）：performance、talent、culture 三个模块可分开售卖，只开其中一个时侧栏不出现名不副实的分组
  // 绩效看板（2026-10-10 负责人拍板，第一期）：绩效读；数据范围由周期明细接口裁剪
  { path: '/admin/perf-dashboard', group: 'performance', module: 'performance', domain: 'performance' },
  // 看板是绩效管理的默认概览，侧栏顺序固定在评估周期之前。
  { path: '/admin/reviews', group: 'performance', module: 'performance', domain: 'performance' },
  // 组织绩效（2026-10-10）：一级部门负责人互评与季度组织绩效结果；绩效读
  { path: '/admin/orgperf', group: 'performance', module: 'performance', domain: 'performance' },
  // 第二批 2.8（2026-10-08）绩效申诉台：不按能力域，按 appealDeskVisible（超级管理员、绩效可读，或 /api/me 的
  // appealDesk.hrbp = 生效中的 HRBP 分工）。HRBP 分工是独立设置、不是角色，所以 domain 为空、另用 appealDesk 标记。
  { path: '/admin/review-appeals', group: 'performance', module: 'performance', domain: null, appealDesk: true },

  { path: '/admin/talent-review', group: 'performance', module: 'talent', domain: 'talent' },
  { path: '/admin/talent-review/filter/:id', group: 'performance', module: 'talent', domain: 'talent', nav: false },
  { path: '/admin/talent-review/succession-import', group: 'performance', module: 'talent', domain: 'talent', nav: false },
  // 12.2 关键岗位清单（2026-10-09）：继任卡标题旁与工作台继任覆盖卡进入，侧栏无入口；读 = talent 读，增删改与导入 = talent 写
  { path: '/admin/talent-review/key-positions', group: 'performance', module: 'talent', domain: 'talent', nav: false },

  // 培训管理组内顺序与员工端「课程 → 培养项目」一致（IA 1.7）
  { path: '/admin/training-overview', group: 'learning', module: 'learning', domain: 'learning' },
  { path: '/admin/content', group: 'learning', module: 'learning', domain: 'learning' },
  { path: '/admin/projects', group: 'learning', module: 'learning', domain: 'learning' },
  { path: '/admin/exams', group: 'learning', module: 'learning', domain: 'learning' },
  { path: '/admin/questions', group: 'learning', module: 'learning', domain: 'learning' },
  { path: '/admin/results', group: 'learning', module: 'learning', domain: 'learning' },
  { path: '/admin/requests', group: 'learning', module: 'learning', domain: 'learning' },

  // 系统设置组内顺序（F54，2026-10-09 负责人授权）：权限与分工 → 数据口径 → 平台设置 → 审计，
  // 即 角色与授权、HRBP 分工、档案与职级设置、功能模块、品牌设置、审计日志。
  { path: '/admin/roles', group: 'system', module: null, domain: 'roles' },
  // 第二批 2.8：部门 → HRBP 分工（仅超级管理员可看可改，与 roles 域同一把闸；随绩效模块开关）
  { path: '/admin/hrbp-coverage', group: 'system', module: 'performance', domain: 'roles' },
  // talent-settings 不挂 talent 模块:它是核心字段/记录类型/职级配置(MODULES.md
  // §2.3 归 core),RBAC 域是 fields。brand-settings 同理,核心白标配置。
  { path: '/admin/talent-settings', group: 'system', module: null, domain: 'fields' },
  // 功能模块开关（负责人 9/28 决定）：roles 域 = 只限超级管理员
  { path: '/admin/modules', group: 'system', module: null, domain: 'roles' },
  { path: '/admin/brand-settings', group: 'system', module: null, domain: 'brand' },
  // AI 治理：ai 模块缺省关闭（defaultOn:false），只有 modules.ai 显式为 true 才算开；模块关闭后，只要已有调用记录
  // （/api/me 的 ai.history）仍显示 —— 应急关闭之后恰恰最需要查调用记录（方案 2.1.1、5.3）
  // 2026-10-06 起不单独进侧栏（nav:false）：页面并入「审计日志」的「AI 治理」分节，这条只给守卫与旧地址跳转用
  { path: '/admin/ai-governance', group: 'system', module: 'ai', aiPage: true, domain: 'audit', nav: false },
  { path: '/admin/audit', group: 'system', module: null, domain: 'audit' },
];

// 侧栏分组顺序(IA 1.7,按业务链):员工与组织 → 绩效管理 → 人才发展 → 行为实践 → 培训管理 → 系统设置。
// 'shell' 组没有分组标题(标签由 AdminLayout 给 null);culture 组只有整页外链。
// 2026-10-06 负责人决定：绩效管理与人才发展合并为「绩效与人才」一组（模块开关与权限域仍各自独立）。
export const ADMIN_NAV_GROUPS = ['shell', 'people', 'performance', 'culture', 'learning', 'system'];

// 侧栏里的整页外链:模块自带的页面(服务端静态挂载,不在本 SPA 的 HashRouter 路由里),所以不进
// ADMIN_PAGES、不经 adminRedirect 守卫;AdminLayout 把过滤后的条目以普通 <a href> 放在所属分组末尾。
//   id         标签键(AdminLayout 的 T 字典)
//   href       整页地址,必须是 web/src/nextpath.js modulePage 认可的站内路径(与服务端 pageLinkIn 同一白名单)
//   group      挂在哪个侧栏分组
//   module     可售模块开关名;defaultOff: true = 该模块缺省关闭(manifest defaultOn:false,如 culture),
//              /api/me 的 modules 里只有显式 true 才算开 —— 老服务端没有这个键,读成关。与 moduleEnabled 的
//              「缺省即开」相反,别混用
//   domain     需要的能力域(>= read;超管恒可见)
// 行为实践的管理视图在学员端里(/culture/#/hr:认可卡审核、抽查、例会、参与名单、导出),HR/TD 运营
// (culture=manage)与 HRBP(culture=read)从这里进。
export const ADMIN_EXTERNAL_LINKS = [
  { id: 'culture', href: '/culture/#/hr', group: 'culture', module: 'culture', defaultOff: true, domain: 'culture' },
];

/** 某个侧栏分组里该出现的整页外链(模块开关与能力域两层都过)。 */
export function adminExternalLinks(user, groupId) {
  const mods = (user && user.modules) || {};
  return ADMIN_EXTERNAL_LINKS.filter((l) => l.group === groupId
    && moduleEnabled(user, l.module)
    && canSeeDomain(user, l.domain));
}

// 壳恒可达:任何被守卫拦下的 /admin 子页都退到这里,不白屏。
export const ADMIN_HOME = '/admin';

const trimPath = (p) => {
  const s = String(p || '');
  return s.length > 1 ? s.replace(/\/+$/, '') || '/' : s;
};

// React Router 先把 pathname 归一化再匹配路由,所以守卫必须用同一套归一化 —— 否则
// 大小写或百分号编码的写法能绕过守卫,把该页外壳与工具栏渲出来(实测 #/admin/EMPLOYEES、
// #/admin/%65mployees 都会被 RR 匹配到 Employees;#/ADMIN/employees 连外层「是不是
// 管理员」那道闸门都躲得过)。两条口径出自 @remix-run/router v6:
//   matchRoutesImpl → decodePath(pathname):逐段 decodeURIComponent,解出来的 /
//     再写回 %2F(所以 %2f 不会凭空多切出一段);整串解码失败就原样返回。
//   compilePath → new RegExp(src, caseSensitive ? undefined : 'i'):App.jsx 的
//     <Route> 都没设 caseSensitive,所以路由匹配是大小写不敏感的。
const decodePathLike = (value) => {
  try {
    return value.split('/').map((v) => decodeURIComponent(v).replace(/\//g, '%2F')).join('/');
  } catch (e) {
    return value; // 坏的百分号编码 —— RR 同样原样退回
  }
};

/** 归一化成「RR 真正拿去匹配的那个串」的小写形式;查表与 /admin 前缀判断共用。 */
export function normalizeAdminPath(pathname) {
  return trimPath(decodePathLike(String(pathname || ''))).toLowerCase();
}

/** 这个地址会不会落进后台控制台?口径与 RR 一致(含大小写 / 编码变体)。 */
export function isAdminPath(pathname) {
  const p = normalizeAdminPath(pathname);
  return p === ADMIN_HOME || p.startsWith(ADMIN_HOME + '/');
}

/**
 * 能不能进后台控制台:超级管理员(legacy role==='admin')或持有后台角色(adminRoleId 非空,RBAC P1)。
 * App.jsx 的 /admin 放行与员工端顶栏「进入后台」按钮(第二批 3.3)共用这一处,口径不会分叉。
 * 老服务的 /api/me 没有 adminRoleId,OR 退化成 role 判断 —— 新前端配老服务行为不变。
 */
export function hasConsoleAccess(user) {
  return !!user && (user.role === 'admin' || user.adminRoleId != null);
}

// 缺省关闭的模块(manifest 的 defaultOn: false):只有显式 true 才算开;其余模块缺省开,只有显式 false 才关。
const DEFAULT_OFF = new Set(['ai', 'culture']);
/** 模块开关的唯一判定(简化 10/11:原来各页手写 mods[m] !== false / === true 二十多处)。mods = /api/me 的 modules 块,可为空。 */
export function modOn(mods, module) {
  if (!module) return true;
  const m = mods || {};
  return DEFAULT_OFF.has(module) ? m[module] === true : m[module] !== false;
}
/** 可售模块开关。缺 modules 块(老服务)= 全开(ai、culture 除外,缺省关)。 */
export function moduleEnabled(user, module) {
  return modOn(user && user.modules, module);
}

/** 老服务(无 grants 字段)一律视为超管,向后兼容。 */
export function isSuperAdmin(user) {
  if (!(user && user.grants)) return true;
  return !!user.isSuperAdmin;
}

/** 能力域可见性:域为空 = 外壳页;roles 仅超管(D6);其余(含 accounts)需 >=read。 */
export function canSeeDomain(user, domain) {
  if (!domain) return true;
  if (isSuperAdmin(user)) return true;
  if (domain === 'roles') return false; // 角色与授权 —— 仅超管,任何 grant 都授不出
  const g = ((user && user.grants) || {})[domain];
  return g === 'read' || g === 'manage';
}

// ── 授权判断辅助:各后台页面裁「动作控件」显隐的单一事实来源 ──────────────────
//
// 判据(P1 定稿,页面里别再另写一套,手写必然漂):一个动作控件的显隐,取决于
// **它实际调用的那个接口**所属的能力域与读写,不是它所在页面的域。跨域控件是重灾区
// —— 员工档案页(people 域)上的「新增员工 / 批量导入 / 重置密码 / 启停账号」打的是
// accounts 域(D6:可授予,canUseAccounts),「授后台角色」打 roles 域(仅超管,
// canUseRoles),「设置潜力」打 talent 写,「查看学习」打 learning 读;people=manage 的
// 角色(HRBP)点下去必 403/404,按钮却照显 —— 这就是「假按钮」。每个控件的域与读写,
// 逐条查仓库根 RBAC-ROUTE-MATRIX.md。
//
// 闸门语义与服务端一致:none → 404;read 且是写操作 → 403;manage → 放行。
// 于是前端口径:写控件要 canWriteDomain,读控件(点开就发一次 GET 的那种)要
// canReadDomain,accounts 域控件用 canUseAccounts,roles 域(角色管理/授角色)用 canUseRoles。
//
// 两个过滤**叠加**:可售模块开关(moduleEnabled)与 grants,两个都要过 —— 既有的模块
// 开关逻辑不许被这层替掉,canUseAction() 就是把两层一起过完的那个入口。
//
// 向后兼容(与 modules / brand / 侧栏同一条):老服务的 /api/me 不带 grants,
// isSuperAdmin() 因此为 true,下面所有函数一律给出 manage / true,控件全部照旧显示
// —— 新前端跑在老服务上绝不能把界面锁死。
// roles 是硬编码的:非超管恒 none,哪怕 grants 里被塞了 roles:'manage' 也不认
// (D6:接管原 accounts 的锁定)。accounts 现在按普通域走 grants(可授予、受范围约束)。

/**
 * 10 个能力域(D6 起 9 个;2026-09-26 登记 culture 模块后加入 culture「行为实践」,排在 talent 与 fields 之间)。
 * roles 恒超管、不可授予,只在这张表里留个名;accounts 可授予。与 store.js RBAC_DOMAINS、Roles.jsx DOMAINS、
 * 各模块 manifest(modules/<id>/manifest.js)生成的 RBAC_DOMAINS 逐项相等(test/m0-route-guard.test.js)。
 */
export const CAPABILITY_DOMAINS = [
  'people', 'learning', 'performance', 'talent', 'fields', 'brand', 'audit', 'accounts', 'roles',
];

/**
 * 该角色对某域的授权档:'manage' | 'read' | 'none'。
 *   超管                → 'manage'
 *   老服务(无 grants)  → 'manage'(向后兼容)
 *   roles 且非超管      → 'none'(不可授予,忽略 grants 里的任何值;D6)
 *   domain 为空         → 'manage'(无域控件/外壳,与 canSeeDomain(user, null) 同口径)
 *   grants 里没这域或值不认 → 'none'
 * user 可以是 null/undefined。
 */
export function grantLevel(user, domain) {
  if (!domain) return 'manage';
  if (isSuperAdmin(user)) return 'manage';
  if (domain === 'roles') return 'none'; // 角色与授权 —— 仅超管,任何 grant 都授不出
  const g = ((user && user.grants) || {})[domain];
  if (g === 'manage') return 'manage';
  if (g === 'read') return 'read';
  return 'none';
}

/**
 * 该域 >= read:能发这个域的读接口(GET)。
 * 用于「点了就发一次跨域 GET」的控件,例如员工档案行内「查看学习」(learning 域读)。
 * 与 canSeeDomain 同一条判断,名字按「控件能不能用」的说法另起一个,页面读起来不别扭。
 */
export function canReadDomain(user, domain) {
  return grantLevel(user, domain) !== 'none';
}

/**
 * 该域 == manage:能发这个域的写接口(POST/PUT/DELETE/上传)。
 * read 档在服务端会吃 403,所以只读角色的写控件必须收起或禁用。
 */
export function canWriteDomain(user, domain) {
  return grantLevel(user, domain) === 'manage';
}

/**
 * accounts 域(员工账号:建号/批量建号/重置密码/启停账号)—— D6 起可授予,受部门范围
 * 约束:accounts=manage 或超管即可用(服务端另按逐目标范围校验)。单独一个函数,免得
 * 各页面手写 grants.accounts 判断把它写漏或写反。老服务(无 grants)照旧为 true。
 * 注意:D6 前此函数曾等价于「仅超管」,拆域后建号/重置/启停归 accounts(可授予),
 * 而「改角色/授后台角色」归 roles(仅超管,见 canUseRoles)—— 两者不再是同一把闸。
 */
export function canUseAccounts(user) {
  return canWriteDomain(user, 'accounts');
}

/**
 * roles 域(角色与授权:建/改/删角色、给人指派后台角色 adminRoleId)—— 恒超管、不可
 * 授予(D6)。员工档案上的「后台角色」下拉、角色管理页的写操作都归它。老服务无 grants
 * 时 isSuperAdmin() 为 true,照旧放行。
 */
export function canUseRoles(user) {
  return isSuperAdmin(user);
}

/**
 * 该域恰好是 read(不是 manage、也不是 none)—— 「只读档全站生效」用。
 * true 时本页的写控件应隐藏,或给带双语提示的禁用态(文案放各页自己的 T={zh,en},
 * 这里只出判断,不出文字),让人知道是「只读」而不是「坏了」。
 */
export function isDomainReadOnly(user, domain) {
  return grantLevel(user, domain) === 'read';
}

/**
 * 一个动作控件的总闸门:模块开关与 grants 两层一起过完。
 *   canUseAction(user, { domain: 'talent', module: 'talent', write: true })
 * 参数(都可省):
 *   domain 控件实际调用的那个接口所属的能力域(查 RBAC-ROUTE-MATRIX.md);省 = 无域
 *   module 该接口所属的可售模块开关名(MODULES.md);省/null = core,开关不管它
 *   write  true = 写操作(需 manage);false/省 = 读操作(需 >=read)
 * roles 域走 grantLevel 的硬编码,读写都只有超管过得去(D6)。
 */
export function canUseAction(user, opts) {
  const o = opts || {};
  if (!moduleEnabled(user, o.module)) return false;
  return o.write ? canWriteDomain(user, o.domain) : canReadDomain(user, o.domain);
}

/** 按路径查表(支持 :id 占位段,归一化口径同 RR)。查不到返回 null。 */
export function findAdminPage(pathname) {
  const want = normalizeAdminPath(pathname).split('/');
  for (const page of ADMIN_PAGES) {
    const have = page.path.split('/');
    if (have.length !== want.length) continue;
    let ok = true;
    for (let i = 0; i < have.length; i += 1) {
      if (have[i].charAt(0) === ':') { if (!want[i]) { ok = false; break; } continue; }
      if (have[i].toLowerCase() !== want[i]) { ok = false; break; }
    }
    if (ok) return page;
  }
  return null;
}

/**
 * 侧栏用:两个过滤叠加 —— 模块开关 on() 与 grants,两个都要过。
 * 表外路径不出现在侧栏,返回 false。
 */
export function canSeeAdminPath(user, pathname) {
  const page = findAdminPage(pathname);
  if (!page) return false;
  const modOk = page.aiPage ? aiPageVisible(user) : moduleEnabled(user, page.module);
  const domOk = page.appealDesk ? appealDeskVisible(user) : canSeeDomain(user, page.domain);
  return modOk && domOk;
}

/**
 * 绩效申诉台可见（第二批 2.8）：超级管理员、绩效可读，或 /api/me 的 appealDesk.hrbp（生效中的 HRBP 分工）。
 * 老服务无 grants → isSuperAdmin 为 true，照旧放行。HRBP 分工不是角色（负责人 10/8 决定），所以不能用 canSeeDomain。
 */
export function appealDeskVisible(user) {
  if (isSuperAdmin(user)) return true;
  if (canReadDomain(user, 'performance')) return true;
  return !!(user && user.appealDesk && user.appealDesk.hrbp);
}

/** AI 治理页：ai 模块显式开启，或模块关闭但已有调用记录（/api/me 的 ai.history）。 */
export function aiPageVisible(user) {
  const mods = (user && user.modules) || {};
  return modOn(mods, 'ai') || !!(user && user.ai && user.ai.history);
}

/** 侧栏某一组里该出现的条目(表内顺序,已剔除 nav:false)。 */
export function navPages(groupId) {
  return ADMIN_PAGES.filter((p) => p.group === groupId && p.nav !== false);
}

/**
 * 路由守卫用:该跳哪里,不用跳则 null。
 *   非 /admin 路径            → null(不管)
 *   /admin 本身               → null(壳恒可达)
 *   表外的 /admin/xxx         → null(交给控制台内既有 404,行为不变)
 *   该域无 >=read             → ADMIN_HOME
 * 只看 grants 这一维:模块关掉的页面本来就没注册路由,落到控制台内 404 —— 那条
 * 既有行为(App.jsx 注释里写明的)不动。
 */
export function adminRedirect(user, pathname) {
  // 每个 helper 各自对「原始」pathname 归一化一次 —— 别把归一化过的串再喂回去,
  // 那会二次 decode(%2565 → %65 → e),比 RR 多解一层。
  if (!isAdminPath(pathname)) return null;
  if (normalizeAdminPath(pathname) === ADMIN_HOME) return null;
  const page = findAdminPage(pathname);
  if (!page) return null;
  // CX-014（2026-10-10）：有 HRBP 资格但未被指定分工的人不再静默退回 —— 放行页面，由申诉台显示「尚未分工」横幅（侧栏入口仍只看 appealDeskVisible）
  if (page.appealDesk) return appealDeskVisible(user) || !!(user && user.appealDesk && user.appealDesk.eligible) ? null : ADMIN_HOME;
  return canSeeDomain(user, page.domain) ? null : ADMIN_HOME;
}
