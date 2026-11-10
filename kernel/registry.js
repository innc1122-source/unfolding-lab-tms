// 内核 · 模块注册表（M0「模块契约与注册表」，ARCHITECTURE-MODULAR.md §4 / §8）。
//
// 职责：加载 modules/index.js 登记的每个 modules/<id>/manifest.js，校验，然后生成
// server.js 过去手抄的那几张表 —— 从 M0 起，manifest 是模块定义的唯一事实源：
//
//   MODULE_ROUTES   [[pattern, moduleId], …]   模块开关关门表（handleApi 入口）
//   RBAC_DOMAINS    [domainId, …]              RBAC 能力域（顺序 = grants 对象的键序）
//   RBAC_SHELL      [RegExp, …]                任何后台角色都能进的外壳路由
//   RBAC_READONLY   [RegExp, …]                不论 HTTP 方法都按「读」算的路径
//   RBAC_ROUTES     [{ re, methods?, domain }] 路径 → 能力域，首匹配生效
//   STATIC_GATES    [{ prefix, module }]       handleApi 之外的静态门（/videos）
//   SELLABLE        [moduleId, …]              可售（可关）模块，modulesOn() 的键
//
// 第二段（modules/culture/CONTRACT.md 第 2 节、第 13 节 A；PHASE2-KERNEL.md 第 3 节）新增的输出：
//   DEFAULT_ON      { 可售模块: boolean }       config.json 的 modules 块没写该键时的开关（manifest 的 defaultOn，缺省 true）
//   HANDLER_MODULES [moduleId, …]              声明了 handler 路由的模块：内核替它们分发请求、在启动时调用工厂
//   matchModuleRoute(method, path)             → { module, route, params } | null（见文件末尾）
//   isModuleHandlerPath(path) / handlerGateOf(path)  路径是否落在 HANDLER_MODULES 某个模块的 gate 里
//   STATIC_MOUNTS   [{ prefix, module, dir, entry }]  模块自带的静态目录（如 /culture/ → modules/culture/public）
//   staticMountOf(normLower)                   与 moduleOfStatic 同一判定形状
//   JOBS            [{ module, id, minute, hour, cron }]  定时任务（kernel/jobs.js 调度，+08:00 按 services.tz 解释）
//   MIGRATIONS      [{ module, dir, files, tables }]      模块迁移（store.runModuleMigrations 的输入）
//   validateFactory(moduleId, result)          模块工厂返回值的启动校验（handlers / jobs 与 manifest 一一对应、同步、hooks 同一对象）
//
// 零依赖：不读库、不读 config.json、不起服务；只读模块目录（static 的 dir / entry 与 migrations
// 目录是否存在、迁移文件名）。server.js 在打开数据库之前调用 load()；校验失败抛错，server.js
// 打印原因后拒绝启动。build(manifests, { hooks, dir }) 的 dir 是模块根目录（缺省为仓库的 modules/）。
//
// ── manifest 字段（ARCHITECTURE-MODULAR.md §4 的 M0 子集）───────────────────────────
//   id          小写 id，必须与目录名一致，全局唯一
//   name        { zh, en }
//   version     可选字符串
//   sellable    false = 永开（core）；true = 可售、可由 config.json modules 块关掉
//   defaultOn   可选 boolean，只允许 sellable 模块写：config.json 的 modules 块没写该模块时是否开启。
//               缺省 true（现有三个模块的行为不变）；culture 为 false（DigiPlus 部署在配置里打开）
//   requires    依赖的模块 id；必须已安装且在 modules/index.js 里排在本模块之前
//   optional    有则增强、无则降级的模块 id（不要求已安装）。也放宽订阅校验：订阅的事件类型前缀
//               （type.split(".")[0]）是 optional 里一个**未安装**的模块时，不要求有已安装模块发布它
//   domains     [{ id, name:{zh,en}, order, scoped? }] 本模块拥有的 RBAC 能力域；
//               order 决定在 RBAC_DOMAINS 里的位置，全局唯一
//   gate        模块开关关门的路径空间：字符串 = 精确路径及其全部子路径，正则 = 整段匹配。
//               按 modules/index.js 的顺序拼成 MODULE_ROUTES。永开模块不得有 gate
//   static      [{ prefix, dir?, entry? }] handleApi 之外的静态门（按 normalize 后的小写路径判定）。
//               带 dir / entry 的条目同时是模块自带的静态目录（STATIC_MOUNTS）：dir 为模块目录下
//               已存在的子目录（如 "./public"，不得是模块目录本身、不得含 ..），entry 为 dir 下已存在的
//               入口文件名；两者必须同时写
//   routes      handleApi 的每个分支一条；或带 handler、由内核分发给模块处理函数的路由（见下）
//   tables      本模块拥有的表名，全局唯一
//   publishes   可选，[事件类型]：本模块发布的领域事件（"entity.action"，见 kernel/events.js TYPE_RE）。
//               一个事件类型只能由一个模块发布
//   subscribes  可选，[事件类型]：本模块订阅的事件。每一项都必须由某个已安装模块 publishes；
//               声明了就必须有 modules/<id>/hooks.js，导出 { "<事件类型>": (event, ctx) => {…} }，
//               且导出的键与 subscribes 逐一对应（多一个少一个都报错；有 hooks.js 却没有
//               subscribes 也报错）。处理函数必须是同步函数（不能是 async）。hooks.js 在
//               load() 时 require（早于打开数据库），顶层不得做 I/O
//   extensions  可选，{ "<扩展点>": [...] }：挂到 core 渲染位置的内容（ARCHITECTURE-MODULAR.md §5.4）。
//               目前只解释 "profile.tabs"（员工档案页签，见下）；写了别的扩展点名一律报错 ——
//               拼错的扩展点不会静默地「永远不显示」
//   migrations  可选，模块目录下的迁移目录（如 "./migrations"）：必须存在，其中的 .sql 文件名一律为
//               <id>-NNNN.sql（NNNN 四位、从 0001 起连续）。由 store.runModuleMigrations 执行（MIGRATIONS）
//   jobs        可选，[{ id, cron }]：id 匹配 JOB_ID_RE、模块内唯一；cron 只接受「分 时 * * *」（分 0–59、
//               时 0–23 的整数，按部署时区 +08:00 解释）。任务函数按 id 从模块工厂返回的 jobs 里取，
//               所以只有声明了 handler 路由（有工厂）的模块才能写 jobs
//   provides    §4 预留字段，只接受、不解释
//
// ── extensions["profile.tabs"] 每条 ─────────────────────────────────────────────────
//   id          页签 id（小写 id），所有模块的页签之间全局唯一；前端 web/src/profileTabs.js 用它找组件
//   title       { zh, en } 页签名
//   order       数字，小者在前；相同时按 modules/index.js 顺序、再按声明顺序
//   audiences   非空数组，取值 "self"（员工本人「我的记录」，GET /api/me/growth）、
//               "line"（汇报线上级看下属，GET /api/me/reports/:userId）、
//               "admin"（后台员工档案，GET /api/admin/employees/:id/profile），不得重复
//   domain      可选，某个 manifest 声明过的能力域；只对 "admin" 生效（该能力域可读才显示），
//               因此填了 domain 的页签 audiences 必须含 "admin"
// build() 输出 PROFILE_TABS（全部页签，已排序、冻结）与 profileTabs({ audience, modulesOn, canRead })
// （某个位置、某个用户实际可见的页签），见文件末尾。
//
// ── 事件（领域事件第一阶段，ARCHITECTURE-MODULAR.md §5.3）──────────────────────────
// build() 输出 events = { publishers: { 类型: 模块 }, subscriptions: [{ module, type, fn }] }，
// server.js 用它建 kernel/events.js 的分发总线。subscriptions 按 modules/index.js 顺序、
// 同一模块内按 subscribes 顺序排列，即同一事件的处理函数调用顺序。
//
// ── routes[] 每条 ────────────────────────────────────────────────────────────────
//   method | methods   "GET"/"POST"/"PUT"/"PATCH"/"DELETE"，或 "*"（handler 不看方法）
//   path               精确字符串，或与 server.js handler 逐字相同的正则（^…$ 锚定）
//   domain             /api/admin/* 路由的 RBAC 能力域；非后台路由必须为 null
//   order              RBAC_ROUTES（shell:true 时为 RBAC_SHELL）里的首匹配位置，小者在前。
//                      现有表依赖「具体路径排在 :id 通配之前」，新增路由时照此取值
//   readonly           true = 不论方法都按读算（进 RBAC_READONLY）；按路径生效，同路径各条须一致
//   readonlyOrder      可选，RBAC_READONLY 列表内的位置（缺省用 order）；只影响列表顺序
//   shell              true = 外壳路由（进 RBAC_SHELL，任何后台角色放行）；domain 须为 null
//   rbac: "custom"     由 rbacGate 里的手写规则判定（/api/admin/roster）；domain 须为 null
//   rbacPath           RBAC 闸门用的正则与 handler 的 path 不同时填（如 roles 的 (\d+) vs [\w-]+）
//
// 后台路由（/api/admin/ 开头）必须且只能是三者之一：有 domain / shell:true / rbac:"custom"。
// 同一路径若被多个能力域按方法拆分（/api/admin/employees：GET→learning、POST→accounts），
// 生成的 RBAC_ROUTES 条目带 methods；只有一个能力域的路径不带 methods（对所有方法生效）。
//
// ── 带 handler 的路由（接入方式 B：内核按 manifest 分发，CONTRACT.md 2.2–2.5）───────────
//   handler     处理函数名，匹配 HANDLER_RE，模块内唯一；与模块工厂返回的 handlers 一一对应
//   method      只写一个：GET / POST / PUT。不接受 methods、"*"；PATCH 不接受（handleApi 对 PATCH 既不读
//               请求体也不做 Origin 校验），DELETE 不接受（access 三档都不允许它）
//   access      "participant"（在职即放行）| "<能力域>:read" | "<能力域>:manage"，能力域必须是本模块声明的。
//               GET 不得是 :manage；非 GET 的 :read 必须同时写 readonly: true
//   readonly    true：只用于 access 为 :read 的非 GET 路由（权限按读算）；不影响事务（非 GET 仍在事务内执行）
//   check       可选：处理函数内的细粒度判定，CHECK_TOKENS 或本模块能力域的 :read / :manage 用 | 连接。
//               内核只校验取值，不执行
//   params      正则路径的捕获组名，按顺序、个数等于捕获组数（只用不具名捕获组）、名称匹配 PARAM_RE 且不重复；
//               精确字符串路径不得带 params
//   domain      必须为 null；不得带 order / shell / rbac / rbacPath / readonlyOrder；不得落进 /api/admin/
//   只有 sellable 模块能写 handler 路由（路径必须落在本模块的 gate 里）；写了 handler 路由的模块，每条路由
//   都必须带 handler —— gate 内没有命中的路径由内核直接回 404，server.js 里的分支到不了。
"use strict";
const fs = require("fs");
const path = require("path");

const MODULES_DIR = path.join(__dirname, "..", "modules");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ADMIN_PREFIX = "/api/admin/";
const ID_RE = /^[a-z][a-z0-9-]*$/;
const MANIFEST_KEYS = new Set([
  "id", "name", "version", "sellable", "defaultOn", "requires", "optional", "domains", "gate", "static", "routes", "tables",
  "migrations", "provides", "subscribes", "publishes", "jobs", "extensions",
]);
const ROUTE_KEYS = new Set(["method", "methods", "path", "domain", "order", "readonly", "readonlyOrder", "shell", "rbac", "rbacPath",
  "handler", "access", "check", "params"]);
const DOMAIN_KEYS = new Set(["id", "name", "order", "scoped"]);
const STATIC_KEYS = new Set(["prefix", "dir", "entry"]);
// 带 handler 的路由（CONTRACT.md 2.2–2.5）
const HANDLER_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const PARAM_RE = /^[a-z][A-Za-z0-9]*$/;
const HANDLER_METHODS = ["GET", "POST", "PUT"];
const ACCESS_RE = /^(?:participant|([a-z][a-z0-9-]*):(read|manage))$/;
// host：团队例会主持人（culture 批次 3）。内核只校验取值，判定由模块的 check 求值函数做。
const CHECK_TOKENS = ["self", "line", "hod", "witness", "host"];
const CHECK_DOMAIN_RE = /^([a-z][a-z0-9-]*):(read|manage)$/;
// 定时任务（CONTRACT.md 第 7 节）
const JOB_KEYS = new Set(["id", "cron"]);
const JOB_ID_RE = /^[a-z][a-z0-9.-]*$/;
// 扩展点（§5.4）。只列已经有渲染方的；新增扩展点时连同渲染方一起加进来。
const EXTENSION_POINTS = ["profile.tabs"];
const PROFILE_TAB_KEYS = new Set(["id", "title", "order", "audiences", "domain"]);
const PROFILE_TAB_AUDIENCES = ["self", "line", "admin"];

const isRegExp = (v) => v instanceof RegExp;
const isName = (v) => !!v && typeof v === "object" && typeof v.zh === "string" && v.zh.trim() !== "" && typeof v.en === "string" && v.en.trim() !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const showPath = (p) => (isRegExp(p) ? String(p) : JSON.stringify(p));
const pathKey = (p) => (isRegExp(p) ? "r:" + p.source + "/" + p.flags : "s:" + p);
// 与 kernel/events.js 的 TYPE_RE 同一条规则（这里不 require events.js：注册表保持零依赖、纯校验）。
const EVENT_TYPE_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_]*)+$/;
const isAsyncFn = (fn) => typeof fn === "function" && !!fn.constructor && /^Async(Generator)?Function$/.test(fn.constructor.name);
// 精确字符串 → 锚定正则。只转义 / 与正则元字符（"-" 不转义），与 M0 之前手写表的写法一字不差：
// "/api/admin/export/records.csv" → /^\/api\/admin\/export\/records\.csv$/
const exactRe = (p) => (isRegExp(p) ? new RegExp(p.source, p.flags) : new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "$"));
const isAdminPath = (p) => (isRegExp(p) ? p.source.startsWith("^\\/api\\/admin\\/") : p.startsWith(ADMIN_PREFIX));

// 一个能被该路由模式匹配到的具体路径（捕获组 → "123"，去掉负向先行断言）。用于
// 「路由是否落在正确模块的 gate 里」的一致性校验。
function samplePath(p) {
  if (!isRegExp(p)) return p;
  let s = p.source;
  let prev;
  do { prev = s; s = s.replace(/\(\?![^()]*(?:\([^()]*\)[^()]*)*\)/g, ""); } while (s !== prev);
  s = s.replace(/\((?!\?)[^()]*\)/g, "123")
    .replace(/\[\^\/\]\+/g, "123")
    .replace(/^\^/, "").replace(/\$$/, "")
    .replace(/\\\//g, "/").replace(/\\\./g, ".").replace(/\\-/g, "-");
  if (!p.test(s)) throw new Error("cannot derive a sample path for " + String(p));
  return s;
}

// 与 server.js moduleOfPath 同一语义（字符串 = 精确或子路径；正则 = test）。
function gateMatch(moduleRoutes, pathname) {
  for (const [pat, mod] of moduleRoutes) {
    if (typeof pat === "string") {
      if (pathname === pat || pathname.startsWith(pat + "/")) return mod;
    } else if (pat.test(pathname)) return mod;
  }
  return null;
}

function routeMethods(r) {
  if (r.method != null) return [r.method];
  return Array.isArray(r.methods) ? r.methods.slice() : [];
}

// 正则里的捕获组个数（含具名组；具名组另行拒绝）。
function captureGroups(re) { return new RegExp(re.source + "|").exec("").length - 1; }
const hasNamedGroup = (re) => /\(\?<(?![=!])/.test(re.source);

// cron 子集「分 时 * * *」→ { minute, hour }；不合法时返回 null。
function parseCron(cron) {
  if (typeof cron !== "string") return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, hr, dom, mon, dow] = parts;
  if (!/^\d{1,2}$/.test(mi) || !/^\d{1,2}$/.test(hr) || dom !== "*" || mon !== "*" || dow !== "*") return null;
  const minute = Number(mi), hour = Number(hr);
  if (minute > 59 || hour > 23) return null;
  return { minute, hour };
}

// 模块目录下的子目录（static 的 dir、migrations）：相对路径、逐段是普通名称、不得是模块目录本身、必须存在。
// 返回 { abs } 或 { error }。
function moduleSubdir(moduleDir, rel) {
  if (typeof rel !== "string" || rel.trim() === "") return { error: 'must be a relative sub-directory such as "./public"' };
  const r = rel.replace(/\\/g, "/");
  if (path.isAbsolute(rel) || r.startsWith("/") || /^[A-Za-z]:/.test(r)) return { error: "must be relative to the module directory" };
  const parts = r.split("/").filter((x) => x !== "" && x !== ".");
  if (!parts.length) return { error: "must name a sub-directory, not the module directory itself" };
  if (parts.some((x) => x === ".." || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(x))) return { error: "must stay inside the module directory (plain names, no ..)" };
  const abs = path.join(moduleDir, ...parts);
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st || !st.isDirectory()) return { error: `does not exist (${abs})` };
  return { abs };
}

// build(manifests) —— 校验 + 生成。manifests 按启用顺序排列。任何一条校验失败都收集起来，
// 最后一次性抛出（列出全部原因），方便一次改完。
// opts.hooks = { <moduleId>: modules/<id>/hooks.js 的导出 }（load() 负责读取；只列有 hooks.js 的模块）。
// opts.dir   = 模块根目录（缺省仓库的 modules/）：static 的 dir / entry 与 migrations 按 <dir>/<id>/ 解析。
function build(manifests, opts = {}) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  if (!Array.isArray(manifests) || manifests.length === 0) throw new Error("module registry: no manifests loaded");
  const modulesDir = typeof opts.dir === "string" && opts.dir ? opts.dir : MODULES_DIR;
  const moduleDirOf = (id) => path.join(modulesDir, id);

  // ---------- 1. 清单级字段 ----------
  const seenIds = new Set();
  manifests.forEach((m, idx) => {
    const tag = `[${m && m.id ? m.id : "#" + idx}]`;
    if (!m || typeof m !== "object") { err(`${tag} manifest is not an object`); return; }
    for (const k of Object.keys(m)) if (!MANIFEST_KEYS.has(k)) err(`${tag} unknown manifest field "${k}"`);
    if (typeof m.id !== "string" || !ID_RE.test(m.id)) err(`${tag} id must match ${ID_RE}`);
    else if (seenIds.has(m.id)) err(`${tag} duplicate module id "${m.id}"`);
    else seenIds.add(m.id);
    if (!isName(m.name)) err(`${tag} name must be { zh, en } non-empty strings`);
    if (m.version != null && typeof m.version !== "string") err(`${tag} version must be a string`);
    if (typeof m.sellable !== "boolean") err(`${tag} sellable must be true or false`);
    if (m.defaultOn !== undefined) {
      if (typeof m.defaultOn !== "boolean") err(`${tag} defaultOn must be true or false`);
      else if (m.sellable === false) err(`${tag} defaultOn only applies to sellable modules (an always-on module has no switch)`);
    }
    for (const f of ["requires", "optional", "domains", "gate", "static", "routes", "tables"])
      if (!Array.isArray(m[f])) err(`${tag} ${f} must be an array`);
  });
  if (errors.length) throw new Error("module registry invalid:\n  - " + errors.join("\n  - "));

  const byId = new Map(manifests.map((m) => [m.id, m]));
  const position = new Map(manifests.map((m, i) => [m.id, i]));
  if (!byId.has("core")) err("[registry] the core module is not installed");
  else if (byId.get("core").sellable !== false) err("[core] sellable must be false (core is always on)");

  // ---------- 2. 依赖 ----------
  for (const m of manifests) {
    for (const r of m.requires) {
      if (typeof r !== "string") { err(`[${m.id}] requires entries must be module ids`); continue; }
      if (r === m.id) err(`[${m.id}] requires itself`);
      else if (!byId.has(r)) err(`[${m.id}] requires "${r}", which is not installed (modules/index.js)`);
      else if (position.get(r) > position.get(m.id)) err(`[${m.id}] requires "${r}", which must be listed before it in modules/index.js`);
    }
    for (const o of m.optional) if (typeof o !== "string") err(`[${m.id}] optional entries must be module ids`);
  }

  // ---------- 3. 能力域 ----------
  const domainModule = {};
  const domainOrders = new Map();
  const domainList = [];
  for (const m of manifests) {
    m.domains.forEach((d, i) => {
      const tag = `[${m.id}] domains[${i}]`;
      if (!d || typeof d !== "object") { err(`${tag} must be an object`); return; }
      for (const k of Object.keys(d)) if (!DOMAIN_KEYS.has(k)) err(`${tag} unknown field "${k}"`);
      if (typeof d.id !== "string" || !ID_RE.test(d.id)) { err(`${tag} id must match ${ID_RE}`); return; }
      if (domainModule[d.id]) err(`${tag} domain "${d.id}" is already owned by module "${domainModule[d.id]}"`);
      if (!isName(d.name)) err(`${tag} name must be { zh, en }`);
      if (!isNum(d.order)) err(`${tag} order must be a number`);
      else if (domainOrders.has(d.order)) err(`${tag} order ${d.order} is already used by domain "${domainOrders.get(d.order)}"`);
      else domainOrders.set(d.order, d.id);
      if (d.scoped != null && typeof d.scoped !== "boolean") err(`${tag} scoped must be a boolean`);
      domainModule[d.id] = domainModule[d.id] || m.id;
      domainList.push(d);
    });
  }

  // ---------- 4. gate / static / tables ----------
  const MODULE_ROUTES = [];
  const STATIC_GATES = [];
  const STATIC_MOUNTS = [];
  const tableModule = {};
  for (const m of manifests) {
    if (!m.sellable && m.gate.length) err(`[${m.id}] an always-on module must not declare gate entries`);
    if (!m.sellable && m.static.length) err(`[${m.id}] an always-on module must not declare static gates`);
    m.gate.forEach((g, i) => {
      if (typeof g === "string") {
        if (!g.startsWith("/api/") || g.endsWith("/")) err(`[${m.id}] gate[${i}] ${JSON.stringify(g)} must start with /api/ and not end with /`);
      } else if (isRegExp(g)) {
        if (!g.source.startsWith("^\\/api\\/") || !g.source.endsWith("$")) err(`[${m.id}] gate[${i}] ${g} must be anchored ^\\/api\\/…$`);
        if (g.global || g.sticky) err(`[${m.id}] gate[${i}] ${g} must not use the g or y flag`);
      } else err(`[${m.id}] gate[${i}] must be a string or RegExp`);
      if (m.sellable) MODULE_ROUTES.push([g, m.id]);
    });
    m.static.forEach((s, i) => {
      if (!s || typeof s.prefix !== "string" || !/^\/[a-z0-9._-]+$/.test(s.prefix) || s.prefix.startsWith("/api"))
        err(`[${m.id}] static[${i}] prefix must be a lower-case top-level path like "/videos" (and not under /api)`);
      else if (m.sellable) STATIC_GATES.push({ prefix: s.prefix, module: m.id });
      if (!s || typeof s !== "object") return;
      for (const k of Object.keys(s)) if (!STATIC_KEYS.has(k)) err(`[${m.id}] static[${i}] unknown field "${k}"`);
      // dir / entry：模块自带的静态目录（CONTRACT.md 9.1）。
      if (s.dir === undefined && s.entry === undefined) return;
      if (typeof s.dir !== "string" || typeof s.entry !== "string") {
        err(`[${m.id}] static[${i}] dir and entry go together (dir: a sub-directory of the module, entry: a file inside it)`);
        return;
      }
      const sub = moduleSubdir(moduleDirOf(m.id), s.dir);
      if (sub.error) { err(`[${m.id}] static[${i}] dir ${JSON.stringify(s.dir)} ${sub.error}`); return; }
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(s.entry)) { err(`[${m.id}] static[${i}] entry must be a plain file name inside dir (got ${JSON.stringify(s.entry)})`); return; }
      let st = null;
      try { st = fs.statSync(path.join(sub.abs, s.entry)); } catch { st = null; }
      if (!st || !st.isFile()) { err(`[${m.id}] static[${i}] entry ${JSON.stringify(s.entry)} does not exist in ${sub.abs}`); return; }
      if (m.sellable && typeof s.prefix === "string") STATIC_MOUNTS.push(Object.freeze({ prefix: s.prefix, module: m.id, dir: sub.abs, entry: s.entry }));
    });
    m.tables.forEach((t, i) => {
      if (typeof t !== "string" || !/^[a-z_][a-z0-9_]*$/.test(t)) { err(`[${m.id}] tables[${i}] must be a table name`); return; }
      if (tableModule[t]) err(`[${m.id}] table "${t}" is already owned by module "${tableModule[t]}"`);
      else tableModule[t] = m.id;
    });
  }
  const seenStatic = new Set();
  for (const s of STATIC_GATES) {
    if (seenStatic.has(s.prefix)) err(`[${s.module}] static prefix "${s.prefix}" is claimed twice`);
    seenStatic.add(s.prefix);
  }

  // ---------- 4b. 领域事件：publishes / subscribes / hooks.js ----------
  const hooks = opts.hooks && typeof opts.hooks === "object" ? opts.hooks : {};
  for (const hid of Object.keys(hooks)) if (!byId.has(hid)) err(`[registry] hooks given for "${hid}", which is not installed`);
  const publishers = {};
  for (const m of manifests) {
    if (m.publishes == null) continue;
    if (!Array.isArray(m.publishes)) { err(`[${m.id}] publishes must be an array of event types`); continue; }
    m.publishes.forEach((t, i) => {
      if (typeof t !== "string" || !EVENT_TYPE_RE.test(t)) { err(`[${m.id}] publishes[${i}] ${JSON.stringify(t)} must look like "entity.action" (${EVENT_TYPE_RE})`); return; }
      if (publishers[t]) err(`[${m.id}] publishes "${t}", which is already published by module "${publishers[t]}"`);
      else publishers[t] = m.id;
    });
  }
  const subscriptions = [];
  for (const m of manifests) {
    const h = hooks[m.id];
    let subs = [];
    if (m.subscribes != null) {
      if (!Array.isArray(m.subscribes)) err(`[${m.id}] subscribes must be an array of event types`);
      else subs = m.subscribes;
    }
    const valid = [];
    const seenSub = new Set();
    subs.forEach((t, i) => {
      if (typeof t !== "string" || !EVENT_TYPE_RE.test(t)) { err(`[${m.id}] subscribes[${i}] ${JSON.stringify(t)} must look like "entity.action" (${EVENT_TYPE_RE})`); return; }
      if (seenSub.has(t)) { err(`[${m.id}] subscribes lists "${t}" twice`); return; }
      seenSub.add(t);
      // 发布方是本模块 optional 里、尚未安装的模块时放行（core 订阅 culture.program.completed，culture 可能没装）：
      // 事件不会来，处理函数照常校验、照常登记。发布方模块已安装却没有 publishes 这个类型，仍然报错。
      const prefix = t.split(".")[0];
      const optionalAbsent = Array.isArray(m.optional) && m.optional.includes(prefix) && !byId.has(prefix);
      if (!publishers[t] && !optionalAbsent) err(`[${m.id}] subscribes to "${t}", which no installed module publishes`);
      valid.push(t);
    });
    if (h == null) {
      if (subs.length) err(`[${m.id}] declares subscribes but modules/${m.id}/hooks.js does not exist`);
      continue;
    }
    if (typeof h !== "object" || Array.isArray(h)) { err(`[${m.id}] modules/${m.id}/hooks.js must export an object { "<event type>": (event, ctx) => {…} }`); continue; }
    if (!subs.length) err(`[${m.id}] modules/${m.id}/hooks.js exists but the manifest declares no subscribes`);
    for (const k of Object.keys(h)) if (!seenSub.has(k)) err(`[${m.id}] hooks.js exports "${k}", which is not listed in the manifest's subscribes`);
    for (const t of valid) {
      const fn = h[t];
      if (typeof fn !== "function") err(`[${m.id}] hooks.js does not export a handler function for "${t}"`);
      else if (isAsyncFn(fn)) err(`[${m.id}] hooks.js handler for "${t}" must be a synchronous function (events are dispatched synchronously after commit)`);
      else subscriptions.push({ module: m.id, type: t, fn });
    }
  }

  // ---------- 4c. 扩展点：extensions（§5.4；目前只解释 profile.tabs）----------
  const profileTabList = [];
  const tabOwner = new Map(); // 页签 id -> 模块 id
  for (const m of manifests) {
    if (m.extensions == null) continue;
    if (typeof m.extensions !== "object" || Array.isArray(m.extensions) || isRegExp(m.extensions)) {
      err(`[${m.id}] extensions must be an object { "<extension point>": [...] }`);
      continue;
    }
    for (const point of Object.keys(m.extensions))
      if (!EXTENSION_POINTS.includes(point)) err(`[${m.id}] extensions: unknown extension point ${JSON.stringify(point)} (supported: ${EXTENSION_POINTS.join(", ")})`);
    const tabs = m.extensions["profile.tabs"];
    if (tabs === undefined) continue;
    if (!Array.isArray(tabs)) { err(`[${m.id}] extensions["profile.tabs"] must be an array`); continue; }
    tabs.forEach((t, i) => {
      const tag = `[${m.id}] extensions["profile.tabs"][${i}]`;
      if (!t || typeof t !== "object" || Array.isArray(t)) { err(`${tag} must be an object`); return; }
      const before = errors.length;
      for (const k of Object.keys(t)) if (!PROFILE_TAB_KEYS.has(k)) err(`${tag} unknown field "${k}"`);
      if (typeof t.id !== "string" || !ID_RE.test(t.id)) err(`${tag} id must match ${ID_RE}`);
      else if (tabOwner.has(t.id)) err(`${tag} tab id "${t.id}" is already registered by module "${tabOwner.get(t.id)}"`);
      else tabOwner.set(t.id, m.id);
      if (!isName(t.title)) err(`${tag} title must be { zh, en } non-empty strings`);
      if (!isNum(t.order)) err(`${tag} order must be a number`);
      const auds = Array.isArray(t.audiences) ? t.audiences : null;
      if (!auds || auds.length === 0) err(`${tag} audiences must be a non-empty array drawn from ${PROFILE_TAB_AUDIENCES.join(" / ")}`);
      else {
        auds.forEach((a) => { if (!PROFILE_TAB_AUDIENCES.includes(a)) err(`${tag} audiences: unknown audience ${JSON.stringify(a)} (allowed: ${PROFILE_TAB_AUDIENCES.join(", ")})`); });
        if (new Set(auds).size !== auds.length) err(`${tag} audiences lists an audience twice`);
      }
      if (t.domain != null) {
        if (typeof t.domain !== "string") err(`${tag} domain must be a domain id`);
        else if (!domainModule[t.domain]) err(`${tag} domain "${t.domain}" is not declared by any manifest`);
        // domain 只管后台（admin）：给没有 admin 的页签填 domain 什么也不限制，却会让人以为本人/经理侧也被它挡住了。
        if (auds && !auds.includes("admin")) err(`${tag} domain only gates the "admin" audience, so audiences must include "admin" (self / line tabs are not filtered by domain)`);
      }
      if (errors.length !== before) return;
      profileTabList.push({
        module: m.id, id: t.id, title: { zh: t.title.zh, en: t.title.en }, order: t.order,
        audiences: auds.slice(), domain: t.domain == null ? null : t.domain, pos: position.get(m.id), index: i,
      });
    });
  }
  profileTabList.sort((a, b) => a.order - b.order || a.pos - b.pos || a.index - b.index);
  const PROFILE_TABS = Object.freeze(profileTabList.map((t) => Object.freeze({
    id: t.id, module: t.module, title: Object.freeze({ ...t.title }), order: t.order,
    audiences: Object.freeze(t.audiences.slice()), domain: t.domain,
  })));

  // ---------- 5. routes ----------
  const routes = [];
  const claims = new Map(); // pathKey -> Map(method -> "module routes[i]")
  const handlerSeen = new Map(); // moduleId -> Map(handler -> index)
  // 带 handler 的路由（CONTRACT.md 2.3 / 2.5）。method 已在通用段落校验过是合法方法。
  const ownDomain = (m, d) => domainModule[d] === m.id && m.domains.some((x) => x && x.id === d);
  function checkHandlerRoute(m, r, i, where, admin) {
    if (typeof r.handler !== "string" || !HANDLER_RE.test(r.handler)) err(`${where}: handler must look like "area.action" (${HANDLER_RE})`);
    else {
      if (!handlerSeen.has(m.id)) handlerSeen.set(m.id, new Map());
      const seen = handlerSeen.get(m.id);
      if (seen.has(r.handler)) err(`${where}: handler "${r.handler}" is already used by routes[${seen.get(r.handler)}] (handlers are unique within a module)`);
      else seen.set(r.handler, i);
    }
    if (!m.sellable) err(`${where}: handler routes need a gate, so only sellable modules can declare them`);
    if (admin) err(`${where}: handler routes must not live under /api/admin/ (that space belongs to rbacGate)`);
    if (r.methods != null) err(`${where}: a handler route takes a single method (write method, not methods)`);
    const method = r.method;
    if (method === "*") err(`${where}: a handler route cannot use method "*"`);
    else if (method === "PATCH") err(`${where}: PATCH is not supported for handler routes (handleApi neither reads the body nor checks Origin for PATCH) — use PUT or POST`);
    else if (method === "DELETE") err(`${where}: DELETE is not supported for handler routes (the access rules allow GET / POST / PUT only)`);
    if (r.domain !== null) err(`${where}: a handler route must declare domain: null (access carries its permission)`);
    if (r.order != null || r.shell != null || r.rbac != null || r.rbacPath != null || r.readonlyOrder != null)
      err(`${where}: handler routes take no order / shell / rbac / rbacPath / readonlyOrder (those belong to /api/admin/ routes)`);
    // access
    const am = typeof r.access === "string" ? ACCESS_RE.exec(r.access) : null;
    if (!am) err(`${where}: access must be "participant", "<domain>:read" or "<domain>:manage"`);
    else if (am[1] && !ownDomain(m, am[1])) err(`${where}: access ${JSON.stringify(r.access)} names domain "${am[1]}", which module "${m.id}" does not declare`);
    else if (am[1]) {
      if (method === "GET" && am[2] === "manage") err(`${where}: a GET route cannot require ${r.access} (GET is a read)`);
      if (method !== "GET" && am[2] === "read" && r.readonly !== true) err(`${where}: a ${method} route with access ${r.access} must also say readonly: true`);
    }
    if (r.readonly === true && !(am && am[2] === "read" && method !== "GET"))
      err(`${where}: readonly on a handler route only marks a non-GET "<domain>:read" route as a read`);
    // check（内核不执行，只校验取值）
    if (r.check != null) {
      const toks = typeof r.check === "string" && r.check !== "" ? r.check.split("|") : null;
      if (!toks) err(`${where}: check must be a non-empty string of tokens joined by |`);
      else {
        if (new Set(toks).size !== toks.length) err(`${where}: check ${JSON.stringify(r.check)} lists a token twice`);
        for (const tok of toks) {
          const dm = CHECK_DOMAIN_RE.exec(tok);
          if (dm) { if (!ownDomain(m, dm[1])) err(`${where}: check token "${tok}" names domain "${dm[1]}", which module "${m.id}" does not declare`); }
          else if (!CHECK_TOKENS.includes(tok)) err(`${where}: check token ${JSON.stringify(tok)} is not one of ${CHECK_TOKENS.join(" / ")} / <domain>:read / <domain>:manage`);
        }
      }
    }
    // params
    if (!isRegExp(r.path)) {
      if (r.params != null) err(`${where}: an exact path takes no params`);
      return;
    }
    if (hasNamedGroup(r.path)) { err(`${where}: use unnamed capture groups (params gives them names)`); return; }
    const groups = captureGroups(r.path);
    const params = r.params == null ? [] : r.params;
    if (!Array.isArray(params) || params.some((p) => typeof p !== "string")) { err(`${where}: params must be an array of names`); return; }
    if (params.length !== groups) err(`${where}: params lists ${params.length} name(s) but the path has ${groups} capture group(s)`);
    for (const p of params) if (!PARAM_RE.test(p)) err(`${where}: param name ${JSON.stringify(p)} must match ${PARAM_RE}`);
    if (new Set(params).size !== params.length) err(`${where}: params lists a name twice`);
  }
  for (const m of manifests) {
    m.routes.forEach((r, i) => {
      const tag = `[${m.id}] routes[${i}]`;
      if (!r || typeof r !== "object") { err(`${tag} must be an object`); return; }
      for (const k of Object.keys(r)) if (!ROUTE_KEYS.has(k)) err(`${tag} unknown field "${k}"`);
      const where = `${tag} ${r.path != null ? showPath(r.path) : "(no path)"}`;
      // path
      if (typeof r.path === "string") {
        if (!r.path.startsWith("/api/")) err(`${where}: path must start with /api/`);
      } else if (isRegExp(r.path)) {
        if (!r.path.source.startsWith("^\\/api\\/") || !r.path.source.endsWith("$")) err(`${where}: regex path must be anchored ^\\/api\\/…$`);
        if (r.path.global || r.path.sticky) err(`${where}: regex path must not use the g or y flag`);
      } else { err(`${tag}: path must be a string or RegExp`); return; }
      // method(s)
      if ((r.method != null) === (r.methods != null)) { err(`${where}: give exactly one of method / methods`); return; }
      if (r.methods != null && (!Array.isArray(r.methods) || r.methods.length < 2)) err(`${where}: methods must be an array of 2+ (use method for one)`);
      const methods = routeMethods(r);
      for (const x of methods) if (x !== "*" && !HTTP_METHODS.includes(x)) err(`${where}: unknown method ${JSON.stringify(x)}`);
      if (methods.includes("*") && methods.length > 1) err(`${where}: "*" cannot be combined with other methods`);
      if (new Set(methods).size !== methods.length) err(`${where}: duplicate methods`);
      // one method + path, one owner
      const k = pathKey(r.path);
      if (!claims.has(k)) claims.set(k, new Map());
      const c = claims.get(k);
      for (const x of methods) {
        const clash = x === "*" ? [...c.values()][0] : (c.get(x) || c.get("*"));
        if (clash) err(`${where}: ${x} is already claimed by ${clash}`);
      }
      for (const x of methods) if (!c.has(x)) c.set(x, `[${m.id}] routes[${i}]`);
      // RBAC fields
      const admin = isAdminPath(r.path);
      if (r.domain !== null && typeof r.domain !== "string") err(`${where}: domain must be a domain id or null`);
      if (typeof r.domain === "string" && !domainModule[r.domain]) err(`${where}: domain "${r.domain}" is not declared by any manifest`);
      if (r.shell != null && r.shell !== true) err(`${where}: shell must be true or absent`);
      if (r.readonly != null && r.readonly !== true) err(`${where}: readonly must be true or absent`);
      if (r.rbac != null && r.rbac !== "custom") err(`${where}: rbac must be "custom" or absent`);
      if (r.rbacPath != null && !isRegExp(r.rbacPath)) err(`${where}: rbacPath must be a RegExp`);
      if (r.readonlyOrder != null && !isNum(r.readonlyOrder)) err(`${where}: readonlyOrder must be a number`);
      if (r.handler != null) {
        checkHandlerRoute(m, r, i, where, admin);
      } else if (r.access != null || r.check != null || r.params != null) {
        err(`${where}: access / check / params only apply to routes with a handler`);
      } else if (!admin) {
        if (r.domain != null || r.shell || r.readonly || r.rbac || r.rbacPath || r.order != null || r.readonlyOrder != null)
          err(`${where}: only /api/admin/ routes carry domain / shell / readonly / rbac / rbacPath / order`);
      } else {
        const kinds = (typeof r.domain === "string" ? 1 : 0) + (r.shell ? 1 : 0) + (r.rbac ? 1 : 0);
        if (kinds !== 1) err(`${where}: an /api/admin/ route needs exactly one of domain / shell:true / rbac:"custom"`);
        if ((typeof r.domain === "string" || r.shell) && !isNum(r.order)) err(`${where}: order (first-match position) is required`);
        if (r.rbac && r.order != null) err(`${where}: rbac:"custom" routes take no order`);
        if (!(typeof r.domain === "string") && (r.readonly || r.rbacPath || r.readonlyOrder != null))
          err(`${where}: readonly / readonlyOrder / rbacPath only apply to routes with a domain`);
        if (r.readonlyOrder != null && !r.readonly) err(`${where}: readonlyOrder without readonly`);
      }
      routes.push({ module: m.id, sellable: m.sellable, index: i, methods, ...r });
    });
  }
  // 写了 handler 路由的模块：gate 内没有命中的路径由内核回 404，server.js 分支到不了，所以不能混写。
  const HANDLER_MODULES = manifests.filter((m) => m.routes.some((r) => r && r.handler != null)).map((m) => m.id);
  for (const id of HANDLER_MODULES) {
    const plain = byId.get(id).routes.map((r, i) => (r && r.handler == null ? i : -1)).filter((i) => i >= 0);
    if (plain.length) err(`[${id}] routes[${plain.join(", ")}] have no handler, but the module declares handler routes — every route of such a module must name a handler (the kernel answers 404 for any unmatched path inside its gate)`);
  }

  // ---------- 5b. jobs / migrations（CONTRACT.md 第 7、8 节）----------
  const JOBS = [];
  const MIGRATIONS = [];
  for (const m of manifests) {
    if (m.jobs != null) {
      if (!Array.isArray(m.jobs)) err(`[${m.id}] jobs must be an array of { id, cron }`);
      else {
        if (m.jobs.length && !HANDLER_MODULES.includes(m.id)) err(`[${m.id}] jobs need the module's factory, which the kernel only calls for modules with handler routes`);
        const seenJob = new Set();
        m.jobs.forEach((j, i) => {
          const tag = `[${m.id}] jobs[${i}]`;
          if (!j || typeof j !== "object" || Array.isArray(j)) { err(`${tag} must be an object { id, cron }`); return; }
          for (const k of Object.keys(j)) {
            if (k === "handler") err(`${tag} handler is not a job field: job functions come from the factory's jobs, looked up by id`);
            else if (!JOB_KEYS.has(k)) err(`${tag} unknown field "${k}"`);
          }
          if (typeof j.id !== "string" || !JOB_ID_RE.test(j.id)) err(`${tag} id must match ${JOB_ID_RE}`);
          else if (seenJob.has(j.id)) err(`${tag} id "${j.id}" is listed twice`);
          else seenJob.add(j.id);
          const c = parseCron(j.cron);
          if (!c) err(`${tag} cron ${JSON.stringify(j.cron)} must be "minute hour * * *" (minute 0–59, hour 0–23, integers; daily schedules only)`);
          else if (typeof j.id === "string" && JOB_ID_RE.test(j.id)) JOBS.push(Object.freeze({ module: m.id, id: j.id, minute: c.minute, hour: c.hour, cron: j.cron.trim().split(/\s+/).join(" ") }));
        });
      }
    }
    if (m.migrations != null) {
      const sub = moduleSubdir(moduleDirOf(m.id), m.migrations);
      if (sub.error) { err(`[${m.id}] migrations ${JSON.stringify(m.migrations)} ${sub.error}`); continue; }
      const re = new RegExp("^" + m.id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "-(\\d{4})\\.sql$");
      let names = [];
      try { names = fs.readdirSync(sub.abs); } catch (e) { err(`[${m.id}] migrations: cannot read ${sub.abs} (${e.message})`); continue; }
      const files = names.filter((f) => /\.sql$/i.test(f)).sort();
      const bad = files.filter((f) => !re.test(f));
      for (const f of bad) err(`[${m.id}] migrations: ${f} must be named ${m.id}-NNNN.sql (four digits)`);
      if (bad.length) continue;
      if (!files.length) { err(`[${m.id}] migrations: ${sub.abs} has no ${m.id}-0001.sql`); continue; }
      let gap = false;
      files.forEach((f, i) => { if (!gap && Number(re.exec(f)[1]) !== i + 1) { gap = true; err(`[${m.id}] migrations: files must be numbered from 0001 without gaps (${m.id}-${String(i + 1).padStart(4, "0")}.sql is missing; found ${f})`); } });
      if (!gap) MIGRATIONS.push(Object.freeze({ module: m.id, dir: sub.abs, files: Object.freeze(files), tables: Object.freeze(m.tables.slice()) }));
    }
  }
  if (errors.length) throw new Error("module registry invalid:\n  - " + errors.join("\n  - "));

  // ---------- 6. 路由与 gate 一致：可售模块的每条路由必须落在自己的 gate 里，
  //               任何路由都不得落进别的模块的 gate（否则关 A 会误关 B 的路由）。----------
  for (const r of routes) {
    let sample;
    try { sample = samplePath(r.path); } catch (e) { err(`[${r.module}] routes[${r.index}] ${showPath(r.path)}: ${e.message}`); continue; }
    const gated = gateMatch(MODULE_ROUTES, sample);
    const want = r.sellable ? r.module : null;
    if (gated !== want)
      err(`[${r.module}] routes[${r.index}] ${showPath(r.path)}: sample ${sample} is gated as ${gated || "(ungated/core)"}, expected ${want || "(ungated/core)"} — fix the gate lists`);
  }

  // ---------- 7. 生成 RBAC 表 ----------
  const adminDomain = routes.filter((r) => typeof r.domain === "string");
  const byKey = new Map();
  for (const r of adminDomain) {
    const gp = r.rbacPath || r.path;
    const k = pathKey(gp);
    if (!byKey.has(k)) byKey.set(k, { gp, routes: [] });
    byKey.get(k).routes.push(r);
  }
  const entries = [];
  const readonlyEntries = [];
  const label = (r) => `[${r.module}] routes[${r.index}] ${showPath(r.path)}`;
  for (const { gp, routes: rs } of byKey.values()) {
    const ro = new Set(rs.map((r) => !!r.readonly));
    if (ro.size > 1) err(`${rs.map(label).join(" / ")}: readonly is path-wide and must agree across these routes`);
    const domains = [...new Set(rs.map((r) => r.domain))];
    for (const d of domains) {
      const sub = rs.filter((r) => r.domain === d);
      const orders = new Set(sub.map((r) => r.order));
      if (orders.size > 1) err(`${sub.map(label).join(" / ")}: same RBAC path + domain must share one order`);
      const entry = { re: exactRe(gp), domain: d, order: sub[0].order, owners: sub.map(label) };
      if (domains.length > 1) {
        const ms = [...new Set(sub.flatMap((r) => r.methods))];
        if (ms.includes("*")) err(`${sub.map(label).join(" / ")}: a path split across domains by method cannot use method "*"`);
        entry.methods = HTTP_METHODS.filter((x) => ms.includes(x));
      }
      entries.push(entry);
    }
    if (rs[0].readonly) {
      const rorder = Math.min(...rs.map((r) => (r.readonlyOrder != null ? r.readonlyOrder : r.order)));
      readonlyEntries.push({ re: exactRe(gp), order: rorder, owners: rs.map(label) });
    }
  }
  const checkUniqueOrder = (list, what) => {
    const seen = new Map();
    for (const e of list) {
      if (seen.has(e.order)) err(`${what}: order ${e.order} is used by both ${seen.get(e.order)} and ${e.owners.join(" / ")}`);
      else seen.set(e.order, e.owners.join(" / "));
    }
  };
  checkUniqueOrder(entries, "RBAC_ROUTES");
  checkUniqueOrder(readonlyEntries, "RBAC_READONLY");
  entries.sort((a, b) => a.order - b.order);
  readonlyEntries.sort((a, b) => a.order - b.order);

  const shellByKey = new Map();
  for (const r of routes.filter((x) => x.shell)) {
    const k = pathKey(r.path);
    if (byKey.has(k)) err(`${label(r)}: a shell path must not also be a domain route`);
    const prev = shellByKey.get(k);
    if (prev && prev.order !== r.order) err(`${label(r)}: shell routes on one path must share one order`);
    if (!prev) shellByKey.set(k, { re: exactRe(r.path), order: r.order, owners: [label(r)] });
  }
  const shellEntries = [...shellByKey.values()];
  checkUniqueOrder(shellEntries, "RBAC_SHELL");
  shellEntries.sort((a, b) => a.order - b.order);

  if (errors.length) throw new Error("module registry invalid:\n  - " + errors.join("\n  - "));

  const RBAC_ROUTES = entries.map((e) => (e.methods ? { re: e.re, methods: e.methods, domain: e.domain } : { re: e.re, domain: e.domain }));
  const RBAC_DOMAINS = domainList.slice().sort((a, b) => a.order - b.order).map((d) => d.id);
  const SELLABLE = manifests.filter((m) => m.sellable).map((m) => m.id);
  const DEFAULT_ON = Object.freeze(Object.fromEntries(manifests.filter((m) => m.sellable).map((m) => [m.id, m.defaultOn !== false])));

  // ---------- 8. 模块路由分发表（CONTRACT.md 2.5 第 5 条）----------
  // 同一方法下：精确字符串优先，然后按 manifest 顺序（modules/index.js 顺序、模块内声明顺序）逐条试正则。
  const dispatch = new Map(); // method -> { exact: Map(path -> entry), regex: [entry] }
  for (const r of routes) {
    if (r.handler == null) continue;
    const entry = Object.freeze({
      module: r.module, method: r.method, path: r.path, handler: r.handler, access: r.access,
      check: r.check == null ? null : r.check, readonly: r.readonly === true,
      params: Object.freeze(Array.isArray(r.params) ? r.params.slice() : []),
    });
    if (!dispatch.has(r.method)) dispatch.set(r.method, { exact: new Map(), regex: [] });
    const t = dispatch.get(r.method);
    if (isRegExp(r.path)) t.regex.push(entry);
    else t.exact.set(r.path, entry);
  }
  const handlerModuleSet = new Set(HANDLER_MODULES);
  const handlerGates = MODULE_ROUTES.filter(([, mod]) => handlerModuleSet.has(mod));
  const handlerNames = new Map(HANDLER_MODULES.map((id) => [id, byId.get(id).routes.map((r) => r.handler)]));
  const jobIdsOf = (id) => JOBS.filter((j) => j.module === id).map((j) => j.id);

  return Object.freeze({
    manifests: Object.freeze(manifests.slice()),
    ids: manifests.map((m) => m.id),
    SELLABLE,
    DEFAULT_ON,
    HANDLER_MODULES: Object.freeze(HANDLER_MODULES.slice()),
    STATIC_MOUNTS: Object.freeze(STATIC_MOUNTS.slice()),
    JOBS: Object.freeze(JOBS.slice()),
    MIGRATIONS: Object.freeze(MIGRATIONS.slice()),
    MODULE_ROUTES,
    RBAC_DOMAINS,
    RBAC_SHELL: shellEntries.map((e) => e.re),
    RBAC_READONLY: readonlyEntries.map((e) => e.re),
    RBAC_ROUTES,
    STATIC_GATES,
    routes,
    domainModule,
    tableModule,
    events: Object.freeze({
      publishers: Object.freeze({ ...publishers }),
      subscriptions: Object.freeze(subscriptions.map((s) => Object.freeze(s))),
    }),
    PROFILE_TABS,
    // 员工档案页签：某个位置、某个用户实际能看到的页签（§5.4 profile.tabs）。
    //   audience   "self" | "line" | "admin"（取值之外直接抛错：这是调用方的编程错误）
    //   modulesOn  server.js modulesOn() 的结果 { 可售模块: 是否开启 }，或返回它的函数（只在确有候选页签时
    //              才调用，没有模块登记页签时不去读 config.json）。不在表里的模块（core）视为开启，
    //              与事件总线 isModuleOn 同一口径
    //   canRead    (domainId) => 当前用户对该能力域是否可读。只在 audience 为 "admin" 且页签填了 domain
    //              时调用；没给就当不可读（fail closed）
    // 返回按 order 排好的新数组 [{ id, module, title: { zh, en }, order }]，每次都是新对象，调用方可随意修改。
    profileTabs({ audience, modulesOn, canRead } = {}) {
      if (!PROFILE_TAB_AUDIENCES.includes(audience)) throw new Error(`profileTabs: audience must be one of ${PROFILE_TAB_AUDIENCES.join(", ")} (got ${JSON.stringify(audience)})`);
      const candidates = PROFILE_TABS.filter((t) => t.audiences.includes(audience));
      if (!candidates.length) return [];
      const on = typeof modulesOn === "function" ? modulesOn() : modulesOn;
      if (!on || typeof on !== "object") throw new Error("profileTabs: modulesOn must be the modulesOn() object (or a function returning it)");
      const out = [];
      for (const t of candidates) {
        if (t.module in on && !on[t.module]) continue;
        if (audience === "admin" && t.domain && !(typeof canRead === "function" && canRead(t.domain))) continue;
        out.push({ id: t.id, module: t.module, title: { zh: t.title.zh, en: t.title.en }, order: t.order });
      }
      return out;
    },
    // 静态门：normLower 为 path.normalize 之后、反斜杠换正斜杠、再转小写的路径。
    moduleOfStatic(normLower) {
      const g = STATIC_GATES.find((s) => normLower === s.prefix || normLower.startsWith(s.prefix + "/"));
      return g ? g.module : null;
    },
    // 模块自带的静态目录：与 moduleOfStatic 同一判定形状（normLower 同上），返回 { prefix, module, dir, entry } 或 null。
    // 只做挂载判定；文件查找、穿越防护、模块开关由 serveStatic 负责（CONTRACT.md 9.1）。
    staticMountOf(normLower) {
      if (typeof normLower !== "string") return null;
      return STATIC_MOUNTS.find((s) => normLower === s.prefix || normLower.startsWith(s.prefix + "/")) || null;
    },
    // 模块路由匹配。path 为 server.js 已解码过一次的路径；捕获组原样取出，**不再二次解码**（CONTRACT.md 3.2）。
    // 返回 { module, route, params }（route 为冻结的 { module, method, path, handler, access, check, readonly, params }，
    // params 为 { 名称: 捕获组 }），没有命中返回 null。
    matchModuleRoute(method, p) {
      if (typeof p !== "string") return null;
      const t = dispatch.get(method);
      if (!t) return null;
      const e = t.exact.get(p);
      if (e) return Object.freeze({ module: e.module, route: e, params: Object.freeze({}) });
      for (const r of t.regex) {
        const mm = r.path.exec(p);
        if (!mm) continue;
        const params = {};
        r.params.forEach((k, i) => { params[k] = mm[i + 1] === undefined ? "" : mm[i + 1]; });
        return Object.freeze({ module: r.module, route: r, params: Object.freeze(params) });
      }
      return null;
    },
    // 路径落在哪个「写了 handler 路由的模块」的 gate 里（与 moduleOfPath 同一语义）；不在返回 null。
    handlerGateOf(p) { return typeof p === "string" ? gateMatch(handlerGates, p) : null; },
    isModuleHandlerPath(p) { return typeof p === "string" && gateMatch(handlerGates, p) !== null; },
    // 模块工厂返回值的启动校验（CONTRACT.md 3.1）：handlers / jobs 的键与 manifest 完全一致、全是同步函数；
    // hooks 就是注册表加载的 modules/<id>/hooks.js 导出对象（同一引用；没有 hooks.js 的模块不得返回 hooks）。
    // 不通过则抛错，列出全部原因（server.js 打印后以退出码 1 拒绝启动）。
    validateFactory(moduleId, result) {
      if (!handlerModuleSet.has(moduleId)) throw new Error(`module factory: "${moduleId}" declares no handler routes, so it has no factory`);
      const problems = [];
      const checkFns = (what, got, want) => {
        if (!got || typeof got !== "object" || Array.isArray(got)) { problems.push(`${what} must be an object { name: function }`); return; }
        for (const k of want) if (!Object.prototype.hasOwnProperty.call(got, k)) problems.push(`${what}: "${k}" is declared in the manifest but the factory does not return it`);
        for (const k of Object.keys(got)) {
          if (!want.includes(k)) problems.push(`${what}: the factory returns "${k}", which the manifest does not declare`);
          else if (typeof got[k] !== "function") problems.push(`${what}: "${k}" is not a function`);
          else if (isAsyncFn(got[k])) problems.push(`${what}: "${k}" must be a synchronous function`);
        }
      };
      if (!result || typeof result !== "object") problems.push("the factory must return { handlers, hooks, jobs }");
      else {
        checkFns("handlers", result.handlers, handlerNames.get(moduleId));
        const jobIds = jobIdsOf(moduleId);
        if (result.jobs == null && !jobIds.length) { /* 没有任务也可以不返回 jobs */ }
        else checkFns("jobs", result.jobs, jobIds);
        const loaded = hooks[moduleId];
        if (loaded) { if (result.hooks !== loaded) problems.push(`hooks must be the very object exported by modules/${moduleId}/hooks.js`); }
        else if (result.hooks != null) problems.push(`the factory returns hooks but modules/${moduleId}/hooks.js does not exist`);
      }
      if (problems.length) throw new Error(`module factory invalid [${moduleId}]:\n  - ` + problems.join("\n  - "));
    },
  });
}

// load() —— 读 modules/index.js 与每个 manifest，交给 build()。任何加载或校验错误都抛出。
function load(opts = {}) {
  const dir = opts.dir || MODULES_DIR;
  const ids = opts.ids || require(path.join(dir, "index.js"));
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("module registry: modules/index.js must export a non-empty array of module ids");
  const manifests = ids.map((id) => {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`module registry: bad module id ${JSON.stringify(id)} in modules/index.js`);
    let m;
    try { m = require(path.join(dir, id, "manifest.js")); }
    catch (e) { throw new Error(`module registry: cannot load modules/${id}/manifest.js — ${e.message}`); }
    if (m && m.id !== id) throw new Error(`module registry: modules/${id}/manifest.js declares id "${m && m.id}" (must equal its directory name)`);
    return m;
  });
  // 订阅方的处理函数：modules/<id>/hooks.js（存在才读；是否「必须存在」由 build() 按 subscribes 判定）。
  const hooks = {};
  for (const id of ids) {
    const hp = path.join(dir, id, "hooks.js");
    if (!fs.existsSync(hp)) continue;
    try { hooks[id] = require(hp); }
    catch (e) { throw new Error(`module registry: cannot load modules/${id}/hooks.js — ${e.message}`); }
  }
  return build(manifests, { hooks, dir });
}

module.exports = {
  load, build, samplePath, exactRe, parseCron, HTTP_METHODS, ADMIN_PREFIX, EXTENSION_POINTS, PROFILE_TAB_AUDIENCES,
  HANDLER_METHODS, CHECK_TOKENS,
};
