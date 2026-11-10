// 内核 · 模块宿主：接入方式 B（modules/culture/CONTRACT.md 第 3、4 节；PHASE2-KERNEL.md 第 5 节）。
//
// 写了 handler 路由的模块（注册表 HANDLER_MODULES，如 culture）不在 server.js 里写分支：内核替它们
//   1. 执行模块迁移（store.runModuleMigrations，按注册表 MIGRATIONS）；
//   2. 为每个模块组装一份冻结的 services（CONTRACT.md 第 4 节全部成员），调用 modules/<id>/index.js 工厂，
//      并按注册表 validateFactory 做启动校验（handlers / jobs 与 manifest 一一对应、同步函数、hooks 同一对象）；
//   3. 把工厂返回的 jobs 交给 kernel/jobs.js 调度；
//   4. 在 handleApi 的登录与改密闸门之后分发 gate 内的请求（dispatch，CONTRACT.md 3.5）；
//   5. 回答 serveStatic 的静态挂载判定（staticMountOf）与登录回跳的站内路径白名单（pageLink，只认开启中的模块的挂载）。
// 模块关闭时同样迁移、同样调用工厂（关闭只关入口）；gate 内的请求在 handleApi 入口的模块开关处已回 404。
// 模块关闭时启动不出声：宿主不报该模块的 raterKey 告警，工厂在启动期记的日志也不打印（见 init）。
//
// 依赖全部由 server.js 注入（store、组织与权限函数、notify、时钟……），本文件不 require store.js / server.js，
// 单元测试可以直接用假依赖驱动（test/kernel-module-host.test.js）。
//
// server.js 的接线（启动顺序固定）：
//   store.init() → host.migrate() → host.init() → …（缓存、体检）… → host.startJobs() → server.listen()
//   任何一步抛错：打印原因，退出码 1（拒绝带着半套模块对外服务）。
"use strict";
const path = require("path");
const { createScheduler } = require("./jobs.js");

// ---------- 内核与模块共用的固定应答（CONTRACT.md 3.4；访问矩阵逐字比对）----------
const FIXED = Object.freeze({
  notFound: Object.freeze({ error: "Not found. 未找到。", code: "not_found" }),
  forbidden: Object.freeze({ error: "You don't have access to this. 你没有此项操作的权限。", code: "forbidden" }),
  notInService: Object.freeze({ error: "Your account is not active. 你的账号不是在职状态。", code: "not_in_service" }),
  badBody: Object.freeze({ error: "The request body must be a JSON object. 请求内容必须是 JSON 对象。", code: "bad_body" }),
  internal: Object.freeze({ error: "Server error. Please try again later. 服务器错误，请稍后再试。", code: "internal" }),
});
const JSON_TYPE = "application/json; charset=utf-8";
const CSV_TYPE = "text/csv; charset=utf-8";
const TZ = Object.freeze({ offsetMinutes: 480, label: "+08:00" });   // 部署时区（CONTRACT.md 4.8）
const AUDIT_ACTION_RE = /^[a-z][a-z0-9_.-]*$/;
const ERROR_CODE_RE = /^[a-z0-9_]+$/;
const CSV_FILENAME_RE = /^[A-Za-z0-9._-]+\.csv$/;
const ACCESS_RE = /^(?:participant|([a-z][a-z0-9-]*):(read|manage))$/;
const LOG_TEXT_MAX = 600;

const isPlainObject = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const errorName = (e) => (e && typeof e === "object" && typeof e.name === "string" && /^[A-Za-z_$][\w$]{0,60}$/.test(e.name) ? e.name : "Error");
function codeError(code, msg) { const e = new Error(code + ": " + msg); e.code = code; return e; }
// 日志文本脱敏（与 server.js batchErrorLogText 同口径：scrypt 存储格式与 32 位以上的连续十六进制一律视为凭据）。
function redactLogText(s) {
  let t = String(s).replace(/[0-9a-f]{32}:[0-9a-f]{64}/gi, "[redacted]").replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/[\r\n]+/g, " | ");
  if (t.length > LOG_TEXT_MAX) t = t.slice(0, LOG_TEXT_MAX) + "…";
  return t;
}
// CONTRACT.md 4.11：英文在前、中文在后，中间一个空格。
function bilingual(zh, en) { return `${en} ${zh}`; }
function httpError(status, code, zh, en, details) {
  if (!Number.isInteger(status) || status < 400 || status > 499) throw new Error("httpError: status must be an integer 400–499");
  if (typeof code !== "string" || !ERROR_CODE_RE.test(code)) throw new Error("httpError: code must be lower-case letters, digits and _");
  if (details != null && !isPlainObject(details)) throw new Error("httpError: details must be a plain object");
  const e = new Error(bilingual(zh, en));
  e.status = status;
  e.code = code;
  e.details = details || null;
  e.expose = true;
  return e;
}
// PersonRow（CONTRACT.md 4.5）：org 返回的人员投影，也是 ctx.user 的形状。不含密码哈希、邮箱、电话、Lark id、角色。
function makePersonRow(orgLib) {
  return function personRow(u) {
    if (!u) return null;
    return Object.freeze({
      id: u.id,
      employeeId: u.employeeId || "",
      name: u.name || "",
      department: u.department || null,
      managerId: u.managerId || null,
      jobLevel: u.jobLevel || null,
      position: u.position || null,   // 岗位（CX-051：3+3 选人列表用岗位代替工号区分同名）
      active: u.active !== 0 && u.active !== false,
      empStatus: u.empStatus || null,
      inService: orgLib.isInService(u),
      system: orgLib.isSystemAccount(u),
    });
  };
}
// 登录回跳与整页链接的站内路径白名单（CONTRACT.md 9.5）：只接受落在某个模块静态挂载下的站内相对路径
// （如 "/culture/" 或 "/culture/#/home"）。必须以 "<挂载前缀>/" 开头（区分大小写）；只收可打印 ASCII，
// 不收反斜杠、百分号编码（浏览器会把 %2e%2e 当成 ..）、"//"（协议相对地址）、"." 与 ".." 路径段。其余一律 null。
// mounts 由调用方给定；宿主的 pageLink 只传开启中的模块的挂载（见 createModuleHost 的 liveMounts）。
function pageLinkIn(mounts, v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) return null;
  if (!/^[\x21-\x7e]+$/.test(v) || /[\\%]/.test(v)) return null;
  if (!v.startsWith("/") || v.includes("//")) return null;
  const cut = v.search(/[?#]/);
  const p = cut < 0 ? v : v.slice(0, cut);
  if (p.split("/").some((s) => s === "." || s === "..")) return null;
  return mounts.some((m) => p.startsWith(m.prefix + "/")) ? v : null;
}

// ---------- 每个模块一份的 services（CONTRACT.md 第 4 节）----------
// opts: { moduleId, manifest, handle(store.moduleDb 的句柄), deps(见 createModuleHost), isProd(启动时求值一次), raterKey? }
function createModuleServices(opts) {
  const { moduleId, manifest, handle, deps } = opts;
  const store = deps.store;
  const events = deps.events;
  const personRow = makePersonRow(deps.orgLib);
  const log = typeof deps.log === "function" ? deps.log : (line) => console.error(line);
  const tag = `[${moduleId}]`;
  const prod = !!opts.isProd;
  const publishes = new Set(Array.isArray(manifest.publishes) ? manifest.publishes : []);
  const readOnly = () => handle.isReadOnly();
  const later = typeof deps.setImmediate === "function" ? deps.setImmediate : setImmediate;

  // 职级表挂在快照上：每个快照只读一次 meta（jobGrades() 每次都读 meta 并 JSON.parse，导入 4,000 行时逐行调用不可接受）。
  const rankTables = new WeakMap();
  const rankMap = () => {
    const m = new Map();
    let ranks = [];
    try { ranks = deps.org.jobGrades() || []; } catch { ranks = []; }
    for (const r of Array.isArray(ranks) ? ranks : []) {
      const k = r && r.rank != null ? String(r.rank).trim().toLowerCase() : "";
      if (k && !m.has(k)) m.set(k, r.track == null || r.track === "" ? null : String(r.track));
    }
    return m;
  };
  const ranksFor = (snap) => {
    if (!snap || typeof snap !== "object") return rankMap();
    let t = rankTables.get(snap);
    if (!t) { t = rankMap(); rankTables.set(snap, t); }
    return t;
  };
  // rbac.* 接受 PersonRow 或 userId：内核按 id 读完整的用户行判定（角色、范围都挂在用户行上）。
  const fullUser = (u) => {
    const id = typeof u === "string" ? u : u && u.id != null ? String(u.id) : "";
    return id ? store.getUserById(id) : null;
  };
  const snapOr = (snap) => snap || deps.org.snapshot();

  const org = Object.freeze({
    getUser(userId) { return userId == null || userId === "" ? null : personRow(store.getUserById(String(userId))); },
    getUserByEmployeeId(employeeId) {
      const k = employeeId == null ? "" : String(employeeId).trim();
      return k ? personRow(store.getUserByEmployeeId(k)) : null;
    },
    listUsers() { return store.listUsers().map(personRow); },
    snapshot() { return deps.org.snapshot(); },
    deptLevelsOf(person, snap) {
      const lv = deps.org.deptLevelsOf(person || null, snap);
      return {
        dept1Id: lv.level1Id || null, dept1: lv.level1 || null, dept2Id: lv.level2Id || null, dept2: lv.level2 || null,
        dept3Id: lv.level3Id || null, dept3: lv.level3 || null, isDirect: !!lv.isDirect, isDirect2: !!lv.isDirect2,
      };
    },
    hodOf(dept1IdOrName, snap) {
      const s = snapOr(snap);
      let name = dept1IdOrName;
      const d = dept1IdOrName == null ? null : s.index.byId.get(String(dept1IdOrName));
      if (d) name = d.name;
      const r = deps.org.hodOf(name == null ? null : name, s);
      return r ? { id: r.id, name: r.name, employeeId: r.employeeId, source: r.source, dept1Id: r.level1Id, dept1: r.level1 } : null;
    },
    hodDeptIdsOf(userId, snap) {
      return snapOr(snap).hods.items.filter((it) => it.hod && it.hod.id === userId).map((it) => it.deptId);
    },
    // children 两层：[{ id, name, children: [{ id, name }] }]（在用的二级部门与其下在用的三级部门）。
    // 每个一级部门的子树先按 parentId 分组一次再组装（O(子树大小)，不做 O(D²) 的逐个过滤）。
    listLevel1Depts(snap) {
      const s = snapOr(snap);
      return s.hods.items.map((it) => {
        const kids = new Map();
        for (const d of s.index.subtreeOf(it.deptId)) {
          if (!d.active || !d.parentId) continue;
          const list = kids.get(d.parentId);
          if (list) list.push(d); else kids.set(d.parentId, [d]);
        }
        return {
          id: it.deptId, name: it.deptName,
          hod: it.hod ? { id: it.hod.id, name: it.hod.name, employeeId: it.hod.employeeId, source: it.source } : null,
          hodStatus: it.source, memberCount: it.memberCount,
          children: (kids.get(it.deptId) || []).map((d2) => ({
            id: d2.id, name: d2.name,
            children: (kids.get(d2.id) || []).map((d3) => ({ id: d3.id, name: d3.name })),
          })),
        };
      });
    },
    jobChannelOf(jobLevel, snap) {
      const k = jobLevel == null ? "" : String(jobLevel).trim().toLowerCase();
      if (!k) return null;
      const m = ranksFor(snap);
      return m.has(k) ? m.get(k) : null;
    },
    DIRECT_LABEL: deps.orgLib.DIRECT_LABEL,
  });

  const rbac = Object.freeze({
    canRead(user, domain) { const f = fullUser(user); return !!f && !!deps.rbac.canRead(f, domain); },
    canWrite(user, domain) { const f = fullUser(user); return !!f && !!deps.rbac.canWrite(f, domain); },
    isSuperAdmin(user) { const f = fullUser(user); return !!f && !!deps.rbac.isSuperAdmin(f); },
    scopeAllowsFor(user, target) {
      const t = typeof target === "string" ? store.getUserById(target) : target;
      return !!deps.rbac.scopeAllowsFor(fullUser(user), t || null);
    },
    scopePredicate(user) { return deps.rbac.scopePredicate(fullUser(user)); },
    scopeDeptPredicate(user) { return deps.rbac.scopeDeptPredicate(fullUser(user)); },
    // 一级部门的整棵子树都在范围内（与 GET /api/admin/departments/hods 的过滤规则一致）。
    scopeAllowsLevel1(user, dept1Id, snap) {
      const pred = deps.rbac.scopeDeptPredicate(fullUser(user));
      if (!pred) return true;
      const sub = snapOr(snap).index.subtreeOf(dept1Id);
      return sub.length > 0 && sub.every((d) => pred(d.name));
    },
  });

  const line = Object.freeze({
    isInReportingLine(managerId, targetId) { return !!deps.line.isInReportingLine(managerId, targetId); },
    subtreeOf(managerId) { return deps.line.reportingSubtree(managerId).map((x) => ({ userId: x.user.id, depth: x.depth })); },
  });

  function transaction(fn) {
    if (readOnly()) throw codeError("write_in_get", "transaction() during a GET handler");
    return store.transaction(fn);
  }
  function afterCommit(fn, label) {
    store.afterCommit(fn, `${moduleId}:${label == null ? "" : String(label)}`);
  }
  // 放到之后的事件循环轮次执行：登记时的请求上下文（actorId、requestId）在执行时显式恢复。
  // GET 处理函数里不得登记（CONTRACT.md 3.5 第 6 步）：回调在只读区退出之后才执行，届时写库不再被拦，
  // 等于绕开了「GET 没有业务副作用」。afterCommit 在事务外立即执行、仍在只读区内，不需要另拦。
  function defer(label, fn) {
    if (readOnly()) throw codeError("write_in_get", "defer() during a GET handler");
    if (typeof fn !== "function") throw new Error("defer(label, fn): fn must be a function");
    const c = events.currentContext();
    const ctx = { actorId: c ? c.actorId : null, requestId: c ? c.requestId : null };
    later(() => events.runWithContext(ctx, () => {
      try {
        const r = fn();
        if (r && typeof r.then === "function") {
          if (typeof r.catch === "function") r.catch(() => {});
          throw new TypeError("deferred functions must be synchronous (got a Promise)");
        }
      } catch (e) {
        log(`${tag} deferred ${String(label)} failed (${errorName(e)})`);
      }
    }));
  }
  // 审计：action 加 "<模块>." 前缀；操作人缺省取请求上下文（任务中为 null），actorName 按 id 补全；
  // 事务内于提交后写入（经 afterCommit，回滚则不写），不在事务内立即写入。GET 里也允许（读审计）。
  function audit(entry) {
    const e = entry && typeof entry === "object" ? entry : {};
    const action = typeof e.action === "string" ? e.action : "";
    if (!AUDIT_ACTION_RE.test(action)) throw new Error(`audit: bad action ${JSON.stringify(e.action)}`);
    const before = e.before === undefined ? null : e.before;
    const after = e.after === undefined ? null : e.after;
    JSON.stringify(before); JSON.stringify(after);   // 不可 JSON 化的值当场抛出
    const c = events.currentContext();
    const actorId = e.actorId !== undefined ? (e.actorId == null || e.actorId === "" ? null : String(e.actorId)) : c ? c.actorId : null;
    const requestId = c ? c.requestId : null;
    const target = e.target == null ? null : String(e.target);
    const write = () => {
      const actor = actorId ? store.getUserById(actorId) : null;
      store.addAudit({ actorId, actorName: actor ? actor.name : null, action: `${moduleId}.${action}`, target, before, after, requestId });
    };
    if (store.inTransaction()) store.afterCommit(write, `${moduleId}:audit`);
    else write();
  }
  const eventsSvc = Object.freeze({
    publish(type, subject, data) {
      if (!publishes.has(type)) throw codeError("event_not_declared", `${type} is not in modules/${moduleId}/manifest.js publishes`);
      if (readOnly()) throw codeError("write_in_get", "events.publish during a GET handler");
      return store.publishEvent(type, subject, data);
    },
  });
  // 站内通知（配置了邮件时同时发邮件）。失败不抛出。事务内调用时自动排到提交之后（回滚则不发）。
  function notify(userId, n) {
    if (readOnly()) throw codeError("write_in_get", "notify during a GET handler");
    const send = () => {
      try { deps.notify(userId, n); }
      catch (e) { log(`${tag} notify failed (${errorName(e)})`); }
    };
    if (store.inTransaction()) store.afterCommit(send, `${moduleId}:notify`);
    else send();
  }

  const services = {
    db: handle.db,
    transaction, afterCommit, defer,
    audit,
    events: eventsSvc,
    org, rbac, line,
    now: prod ? () => Date.now() : () => deps.nowMs(),
    tz: TZ,
    isProduction: () => prod,
    csv: (rows, headers) => deps.csv(rows, headers),
    csvLines: (rows) => deps.csvLines(rows),
    notify,
    notifySentSince: (userId, type, link, sinceIso) => !!store.hasNotificationSince(userId, type, link, sinceIso),
    httpError, bilingual,
    log(message) { log(`${tag} ${redactLogText(message)}`); },
  };
  if (typeof opts.raterKey === "string" && opts.raterKey) services.raterKey = opts.raterKey;
  // CX-166（契约 v39）：模块数据目录（绝对路径字符串），模块把上传文件写在 <dataDir>/public/ 下，宿主静态服务优先读它
  if (typeof deps.moduleDataDir === "function") {
    try { const dd = deps.moduleDataDir(moduleId); if (typeof dd === "string" && dd) services.dataDir = dd; } catch { /* 没有数据目录时沿用模块自己的默认 */ }
  }
  return Object.freeze(services);
}

// ---------- 宿主 ----------
// deps（server.js 注入）：
//   registry     kernel/registry.js load() 的结果
//   store        store.js
//   events       kernel/events.js
//   orgLib       modules/core/org.js
//   readConfig   () => config.json 对象（raterKey：config.json 的 "<模块>.raterKey"）
//   modulesOn    () => { 可售模块: 是否开启 }（任务调度按它跳过关闭的模块）
//   isProduction () => boolean（init 时求值一次并缓存）
//   nowMs        () => 毫秒（非生产读 LMS_FAKE_NOW）
//   notify       notify.js 的 notify
//   csv / csvLines  server.js 抽出的 CSV 正文函数（与 sendCsv 同一规则）
//   org          { snapshot, hodOf, deptLevelsOf, jobGrades }（server.js 的 orgSnapshot / hodOf / deptLevelsOf / jobGrades）
//   rbac         { canRead, canWrite, isSuperAdmin, scopeAllowsFor, scopePredicate, scopeDeptPredicate }
//   line         { isInReportingLine, reportingSubtree }
//   modulesDir   缺省为本文件旁的 ../modules
//   log / warn   一行文本的日志函数（缺省 console.error / console.warn）
//   slowMs       处理函数耗时告警线，缺省 1000
function createModuleHost(deps) {
  const registry = deps.registry;
  const store = deps.store;
  const log = typeof deps.log === "function" ? deps.log : (line) => console.error(line);
  const warn = typeof deps.warn === "function" ? deps.warn : (line) => console.warn(line);
  const modulesDir = deps.modulesDir || path.join(__dirname, "..", "modules");
  const slowMs = Number.isFinite(deps.slowMs) ? deps.slowMs : 1000;
  const HANDLER = new Set(registry.HANDLER_MODULES || []);
  const MOUNTS = registry.STATIC_MOUNTS || [];
  const manifestOf = (id) => registry.manifests.find((m) => m.id === id);
  const personRow = makePersonRow(deps.orgLib);
  const services = new Map();   // moduleId -> 冻结的 services
  const handles = new Map();    // moduleId -> store.moduleDb 句柄（runReadOnly / isReadOnly）
  const factories = new Map();  // moduleId -> 工厂返回值 { handlers, hooks, jobs }
  let scheduler = null;

  // 模块迁移：store.init() 之后、调用工厂之前。失败（含已执行文件被改动）抛错，由 server.js 拒绝启动。
  function migrate() {
    return store.runModuleMigrations(registry.MIGRATIONS || []);
  }

  // 模块开关现读（deps.modulesOn，与 serveStatic 的模块门同一判定：值为真才算开）。读取失败按全部关闭（不接受回跳）。
  function onNow() {
    try { const on = deps.modulesOn(); return on && typeof on === "object" ? on : {}; } catch { return {}; }
  }
  // 开启中的模块的静态挂载：登录回跳 next、Lark 回跳与通知的整页链接只认这些（2026-09-28 负责人拍板：模块关闭时
  // 它的挂载已回 404，指向它的 next 不再被接受，落回 TMS 首页；前端 web/src/nextpath.js 按 /api/env、/api/me 的 modules 同样判定）。
  function liveMounts() {
    const on = onNow();
    return MOUNTS.filter((m) => !!on[m.module]);
  }

  // 组装 services、调用工厂、启动校验。按 modules/index.js 的顺序，每个带 handler 路由的模块一次。
  // 启动时关闭的模块不出声（2026-09-28 负责人拍板）：不报 raterKey 缺失或过短，工厂调用期间经 services.log 记的日志
  // 也不打印（例如 culture 的「rater key not configured」）。工厂返回之后恢复，运行期的日志照常；工厂抛错照常拒绝启动。
  // raterKey 不论开关都照常读入（运行中改配置打开模块时用得上）；告警以启动那一刻的开关为准，改开关后建议重启。
  function init() {
    if (factories.size) throw new Error("module host: init() was already called");
    const cfg = (() => { try { return deps.readConfig() || {}; } catch { return {}; } })();
    const prod = !!deps.isProduction();
    const onAtStart = onNow();
    for (const id of registry.HANDLER_MODULES || []) {
      const manifest = manifestOf(id);
      const loud = !!onAtStart[id];
      const block = cfg && typeof cfg === "object" ? cfg[id] : null;
      const raterKey = block && typeof block === "object" && !Array.isArray(block) && typeof block.raterKey === "string" ? block.raterKey.trim() : "";
      if (loud && !raterKey) warn(`[modules] ${id}: config.json "${id}.raterKey" is not set — the module falls back to its own default (culture: LMS_CULTURE_RATER_KEY, then the per-program salt)`);
      else if (loud && raterKey.length < 32) warn(`[modules] ${id}: config.json "${id}.raterKey" is shorter than 32 characters — use a long random string`);
      const handle = store.moduleDb(id, manifest.tables, registry.tableModule);
      let quiet = !loud;
      const svcDeps = loud ? deps : { ...deps, log: (line) => { if (!quiet) log(line); } };
      const svc = createModuleServices({ moduleId: id, manifest, handle, deps: svcDeps, isProd: prod, raterKey: raterKey || undefined });
      handles.set(id, handle);
      services.set(id, svc);
      let factory;
      try { factory = require(path.join(modulesDir, id, "index.js")); }
      catch (e) { throw new Error(`module ${id}: cannot load modules/${id}/index.js — ${e.message}`); }
      if (typeof factory !== "function") throw new Error(`module ${id}: modules/${id}/index.js must export the factory function (services) => ({ handlers, hooks, jobs })`);
      let result;
      try { result = factory(svc); }
      catch (e) { throw new Error(`module ${id}: the factory threw ${errorName(e)}: ${redactLogText(e && e.message)}`); }
      finally { quiet = false; }
      if (result && typeof result.then === "function") {
        if (typeof result.catch === "function") result.catch(() => {});
        throw new Error(`module ${id}: the factory must be synchronous (it returned a Promise)`);
      }
      registry.validateFactory(id, result);
      factories.set(id, result);
    }
  }

  function startJobs() {
    if (scheduler) return scheduler;
    scheduler = createScheduler({
      jobs: registry.JOBS || [],
      jobFns: (id) => { const f = factories.get(id); return f ? f.jobs : null; },
      services: (id) => services.get(id) || null,
      isModuleOn: (id) => deps.modulesOn()[id] !== false,
      getMeta: (k) => store.getMeta(k),
      setMeta: (k, v) => store.setMeta(k, v),
      log,
    });
    scheduler.start();
    return scheduler;
  }

  // 事件总线的 moduleServices：带 handler 路由的模块拿自己的 services（尚未组装时为 null：跳过、按失败记）；
  // 其余模块返回 undefined（走总线共用的每轮服务）。
  function eventServicesFor(id) {
    if (!HANDLER.has(id)) return undefined;
    return services.get(id) || null;
  }

  // ---------- 分发（CONTRACT.md 3.5）----------
  const reply = (status, obj) => ({ status, headers: { "content-type": JSON_TYPE, "cache-control": "no-store" }, body: JSON.stringify(obj) });
  // 处理函数的返回值 → 应答（在事务或只读区之内求值：序列化失败按 500 回滚）。
  function shape(res) {
    if (res && typeof res.then === "function") {
      if (typeof res.catch === "function") res.catch(() => {});
      throw new TypeError("module handlers must be synchronous (the handler returned a Promise)");
    }
    if (!res || typeof res !== "object") throw new TypeError("handler result must be { status?, body } | { status: 204 } | { csv }");
    if (res.csv !== undefined) {
      const c = res.csv;
      if (!c || typeof c !== "object" || typeof c.text !== "string" || typeof c.filename !== "string" || !CSV_FILENAME_RE.test(c.filename))
        throw new TypeError("csv result must be { filename: [A-Za-z0-9._-]+.csv, text }");
      return { status: 200, headers: { "content-type": CSV_TYPE, "content-disposition": `attachment; filename="${c.filename}"`, "cache-control": "no-store" }, body: c.text };
    }
    if (res.status === 204) return { status: 204, headers: { "cache-control": "no-store" }, body: "" };
    const status = res.status === undefined ? 200 : res.status;
    if (status !== 200 && status !== 201 && status !== 202) throw new TypeError(`handler result status must be 200, 201, 202 or 204 (got ${JSON.stringify(res.status)})`);
    if (!res.body || typeof res.body !== "object") throw new TypeError("handler result body must be an object or an array");
    const text = JSON.stringify(res.body);
    if (typeof text !== "string") throw new TypeError("handler result body is not JSON");
    return { status, headers: { "content-type": JSON_TYPE, "cache-control": "no-store" }, body: text };
  }
  function errorReply(e, moduleId, handler) {
    if (e && e.expose === true && Number.isInteger(e.status) && e.status >= 400 && e.status <= 499 && typeof e.code === "string" && ERROR_CODE_RE.test(e.code)) {
      const body = { error: String(e.message), code: e.code };
      if (isPlainObject(e.details)) for (const k of Object.keys(e.details)) if (k !== "error" && k !== "code") body[k] = e.details[k];
      try { return reply(e.status, body); } catch { /* details 不可 JSON 化：按内部错误处理 */ }
    }
    log(`[${moduleId}] ${handler} failed: ${redactLogText(`${errorName(e)}: ${e && e.message != null ? e.message : e}`)}`);
    return reply(500, FIXED.internal);
  }
  const langOf = (headers) => {
    const x = String(headers["x-lms-lang"] || "").trim().toLowerCase();
    if (x === "zh" || x === "en") return x;
    return /^zh/i.test(String(headers["accept-language"] || "").trim()) ? "zh" : "en";
  };
  // req: { method, path(已解码一次), query(URLSearchParams 或 { k: v }), headers, body, user(完整用户行), requestId }
  // 返回 null（不在任何带 handler 路由的模块的 gate 内，交回 handleApi）或应答 { status, headers, body }。
  // 分发层自己兜住全部异常（CONTRACT.md 3.5 第 11 步）：不让任何异常落到 handleApi 的外层 catch —— 那里会把 e.message 原文回给客户端。
  function dispatch(req) {
    const p = req && req.path;
    if (!registry.isModuleHandlerPath(p)) return null;
    try { return dispatchInGate(req, p); }
    catch (e) {
      log(`[modules] dispatch of ${String(req.method)} ${redactLogText(p)} failed: ${redactLogText(`${errorName(e)}: ${e && e.message}`)}`);
      return reply(500, FIXED.internal);
    }
  }
  function dispatchInGate(req, p) {
    const m = registry.matchModuleRoute(req.method, p);
    // gate 内没有命中（含方法不符；handler 路由只有 GET / POST / PUT，PATCH 与 DELETE 一律落到这里）→ 固定 404。
    if (!m) return reply(404, FIXED.notFound);
    const route = m.route;
    const svc = services.get(m.module);
    const fn = factories.get(m.module) && factories.get(m.module).handlers[route.handler];
    if (!svc || typeof fn !== "function") {
      log(`[${m.module}] ${route.handler} failed: module not initialised`);
      return reply(500, FIXED.internal);
    }
    const body = req.method === "GET" ? {} : req.body;
    if (req.method !== "GET" && !isPlainObject(body)) return reply(400, FIXED.badBody);
    const user = req.user;
    const person = personRow(user);
    // access（CONTRACT.md 2.3）：状态码的取舍与 rbacGate 一致 —— 没有授权与不存在同为 404，只有读权限做写 403。
    const a = ACCESS_RE.exec(route.access || "");
    if (!a) { log(`[${m.module}] ${route.handler} failed: unknown access ${JSON.stringify(route.access)}`); return reply(500, FIXED.internal); }
    if (!a[1]) {
      if (!person.inService) return reply(403, FIXED.notInService);
    } else if (a[2] === "read") {
      if (!deps.rbac.canRead(user, a[1])) return reply(404, FIXED.notFound);
    } else if (!deps.rbac.canWrite(user, a[1])) {
      return deps.rbac.canRead(user, a[1]) ? reply(403, FIXED.forbidden) : reply(404, FIXED.notFound);
    }
    const query = Object.create(null);
    const q = req.query;
    if (q && typeof q.forEach === "function" && typeof q.get === "function") q.forEach((v, k) => { if (!(k in query)) query[k] = String(v); });
    else if (q && typeof q === "object") for (const k of Object.keys(q)) query[k] = String(q[k]);
    const headers = req.headers || {};
    const idem = typeof headers["idempotency-key"] === "string" ? headers["idempotency-key"].trim().slice(0, 128) : "";
    const svcNow = svc.now();
    const ctx = Object.freeze({
      user: person,
      params: Object.freeze(Object.assign({}, m.params)),   // 已解码一次的路径里的捕获组，不再二次解码
      query: Object.freeze(query),
      body,
      lang: langOf(headers),
      now: svcNow,
      method: req.method,
      path: p,
      requestId: req.requestId == null ? null : String(req.requestId),
      route: Object.freeze({ handler: route.handler, access: route.access, check: route.check == null ? null : route.check }),
      idempotencyKey: idem || null,
    });
    const handle = handles.get(m.module);
    const t0 = Date.now();
    try {
      // GET：只读区（transaction / events.publish / notify / 写语句一律 write_in_get）；非 GET（含 readonly 路由）：在事务内。
      // 提交之后 store.transaction 先分发本事务写入的事件，再按登记顺序执行 afterCommit（含审计）。
      if (req.method === "GET") return handle.runReadOnly(() => shape(fn(ctx)));
      return store.transaction(() => shape(fn(ctx)));
    } catch (e) {
      return errorReply(e, m.module, route.handler);
    } finally {
      const ms = Date.now() - t0;
      if (ms > slowMs) log(`[${m.module}] slow ${route.handler} ${ms}ms`);
    }
  }

  return Object.freeze({
    FIXED,
    migrate,
    init,
    startJobs,
    stopJobs() { if (scheduler) scheduler.stop(); },
    get scheduler() { return scheduler; },
    servicesOf: (id) => services.get(id) || null,
    factoryOf: (id) => factories.get(id) || null,
    eventServicesFor,
    dispatch,
    // gate 内（带 handler 路由的模块）的路径：外层 catch 据此把非法 JSON 改回 400 bad_body。
    isHandlerPath: (p) => registry.isModuleHandlerPath(p),
    // serveStatic：normLower（normalize、反斜杠换正斜杠、转小写）落在哪个模块自带的静态目录。
    staticMountOf: (normLower) => registry.staticMountOf(normLower),
    // 登录回跳 next 与整页通知链接：落在某个**开启中的**模块静态挂载下的站内相对路径，否则 null（每次调用现读开关）。
    pageLink: (v) => pageLinkIn(liveMounts(), v),
    // 同一判定、开关只读一次：一次请求里要判定多个链接时用（通知列表）。
    pageLinker: () => { const mounts = liveMounts(); return (v) => pageLinkIn(mounts, v); },
  });
}

module.exports = { createModuleHost, createModuleServices, pageLinkIn, makePersonRow, redactLogText, bilingual, httpError, FIXED, TZ };
