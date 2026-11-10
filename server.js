// DigiPlus Talent (TMS) — server (zero external dependencies).
// Run: runtime\node.exe server.js   (or double-click start.bat)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("node:child_process");
// content.js is only the seed for a fresh database — the live course/program
// content is stored in SQLite (HR edits it in the console) and cached here.
let PROGRAMS = [];
let COURSES = [];
let TPROJECTS = [];
let COURSE_PROGRAMS = {}; // courseId → [programId…] (reverse of program.courseIds)
// 视频文件名 → [courseId…]：/videos/* 鉴权的反向索引（S1）。键是**原样**文件名：
// 大小写不敏感的匹配曾经反而放大授权（见 videoAccessDecision 里的说明），查不到
// 一律落到更严的孤儿分支。在 refreshContent() 里重建，所以新鲜度与 PROGRAMS/
// COURSES 缓存完全一致（切不可改成一次性静态 Map：那样「刚从课程里移除的视频」
// 会继续对学员放行）。
let VIDEO_COURSES = {};
// 缓存基线：上次重建缓存时本连接看到的 PRAGMA data_version，以及重建时刻。
// handleApi 入口拿当前 data_version 与它比对 —— 别的连接（脚本、第二实例）一提交，
// data_version 就 +1，下一个请求先重建缓存再继续，「库变了服务看不见」从此闭环。
let CACHE_DATA_VERSION = null;
let CACHE_REFRESHED_AT = null; // /api/admin/instance 上报，排障时看缓存新鲜度
function refreshContent() {
  // 基线必须在**读数据之前**取：若外部提交恰好落在「读完数据、记版本」之间，后记的
  // 版本会把那次提交算进基线、数据却没读到 —— 下一个请求比对相等，就永远漏刷了
  // （对抗复核用双连接实测过这个窗口）。先记版本再读数据则最坏是多刷一次，方向安全。
  const v = store.dataVersion();
  PROGRAMS = store.listContent("program");
  COURSES = store.listContent("course");
  TPROJECTS = store.listContent("tproject");
  COURSE_PROGRAMS = {};
  for (const p of PROGRAMS)
    for (const cid of p.courseIds || [])
      (COURSE_PROGRAMS[cid] = COURSE_PROGRAMS[cid] || []).push(p.id);
  // Reverse index for the /videos/* authorization check in serveStatic: every
  // uploaded video referenced by a course section, keyed by bare file name.
  VIDEO_COURSES = {};
  for (const c of COURSES)
    for (const m of c.modules || [])
      for (const s of m.sections || []) {
        const name = videoFileName(s && s.video);
        if (!name) continue;
        (VIDEO_COURSES[name] = VIDEO_COURSES[name] || []).push(c.id);
      }
  CACHE_DATA_VERSION = v;
  CACHE_REFRESHED_AT = new Date().toISOString();
}
// Every program (package) that contains a course — courses are standalone
// entities now and may be referenced by several packages (or none).
function programsContaining(courseId, course) {
  const fromIndex = COURSE_PROGRAMS[courseId];
  if (fromIndex && fromIndex.length) return fromIndex;
  const legacy = course || COURSES.find((c) => c.id === courseId);
  return legacy && legacy.programId ? [legacy.programId] : [];
}
// A course section's `video` field holds the URL of a file uploaded under
// public/videos (POST /api/admin/upload-video answers "/videos/<name>"), so this
// reduces such a reference — or an incoming request path — to the bare file name
// that keys VIDEO_COURSES. Anything that is not a /videos/<file> reference (an
// external videoEmbed, an empty field, a nested path) → null.
// No percent-decoding on purpose: upload-video sanitizes the stored name to word
// characters and CJK, and the request path reaching serveStatic was already
// decoded once at the dispatcher — decoding again would be a second pass over
// attacker-controlled text for no gain.
function videoFileName(v) {
  if (!v) return null;
  const s = String(v).trim().split(/[?#]/)[0].replace(/\\/g, "/");
  const m = /(?:^|\/)videos\/([^/]+)$/.exec(s);
  return m ? m[1] : null;
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 8765;
const ROOT = __dirname;

// ---------- AI 辅助（ai 模块；NEXT-WORK/specs/03-ai-governance-spec.md v1.1，接入说明见 docs/HANDOVER-IT.md §10） ----------
// 服务商（openai-chat / anthropic-messages / gemini，地址、密钥、模型、超时、代理、客户端证书）、功能开关、调用记录、
// 限流、月度预算、配置指纹都在 modules/ai/ 下（provider.js / service.js / features.js / redact.js / injection.js …），
// 这里只留配置读取与服务实例（AI，见 notifyAdmins 之后）。AI 模块默认关闭（manifest defaultOn:false）；
// 没有 ai.provider 时，旧字段 anthropicApiKey / geminiApiKey / aiModel 与环境变量 ANTHROPIC_API_KEY / GEMINI_API_KEY
// 仍然有效（默认模型改为 claude-sonnet-5）。演示模式只能显式开启（config.json 写 ai.demo: true），任何故障或未配置
// 都按「未接入」处理 —— 不再根据 isProduction() 推断。
// configPath()/readConfig() live in notify.js now (the email hook reads the
// same config.json, and the cron scripts require notify.js standalone). One
// shared implementation — honours LMS_CONFIG_PATH, default config.json next to
// server.js — so brand/lark/AI reads and email delivery can never disagree.
const { configPath, readConfig } = require("./notify.js");
// 简化 10/11：日期与工作日、HTTP 请求辅助、文本与字段辅助这些纯函数在 modules/core 下（原样从本文件搬出）
const { nowMs, manilaDay, ymdLocal, todayLocal, dateLocalOffset, appealToday, isWorkday, workdayAdd, workdaysBetween, validDateStr } = require("./modules/core/dates.js");
const { normalizeEmail, requestIsHttps, safeDecode, parseCookies, clientIp, loginKey } = require("./modules/core/http-util.js");
const { clampText, csvEscape, optionsZhOf, canonOption, optionZh, parseOptionsZh, parseTags, parseExtras } = require("./modules/core/text-util.js");
const aiFeatures = require("./modules/ai/features.js");

// ---------- module registry（M0：模块定义的唯一事实源是 modules/<id>/manifest.js） ----------
// kernel/registry.js 加载并校验全部 manifest，生成下面用到的 MODULE_ROUTES / RBAC_DOMAINS /
// RBAC_SHELL / RBAC_READONLY / RBAC_ROUTES / 静态门清单 —— 这些表不再在本文件里手抄。
// 放在打开数据库之前：清单有错（id 重复、依赖缺失、能力域未声明、同一 method+path 被两个
// 模块认领……）就打印全部原因并拒绝启动，不带着一张错的权限表对外服务。
const REGISTRY = (() => {
  try { return require("./kernel/registry.js").load(); }
  catch (e) {
    console.error("[modules] 模块注册表校验失败，拒绝启动 / module registry is invalid, refusing to start:\n" + e.message);
    process.exit(1);
  }
})();

// ---------- data store ----------
// All persistence lives in SQLite (see store.js). Every write is synchronous and
// transactional, so a crash can't lose a just-submitted exam. store.init() is
// called at the bottom of this file, once hashPassword is defined.
const store = require("./store.js");
// 「课程算不算完成」的唯一口径与培训提醒资格（modules/learning/completion.js，与 scripts/notify-due.js 共用，2026-10-07）。
// 下面 coursesInProgram / programDone 等同名函数都是一行委托（保留 function 声明的提升，调用点不动）。
const LC = require("./modules/learning/completion.js");
// 第三批（2026-10-08）：培训概览统计引擎（窗口、本期应完成、指标、请求级快照）与课程类别目录
const TS = require("./modules/learning/training-stats.js");
const CAT = require("./modules/learning/categories.js");
// 第四批 7 / 9.2（2026-10-08）：公开课程与自主学习的纯规则（目录收录、加入 / 退出、关闭时的处理方案 PUBLIC_CLOSE_POLICY）
const PUBC = require("./modules/learning/public-courses.js");
const CPKG = require("./modules/learning/course-package.js");   // CX-032 课程包导出 / 导入（2026-10-09 验收）
const VURL = require("./modules/learning/video-url.js");
const OP = require("./modules/performance/orgperf.js");        // 组织绩效（负责人 2026-10-10）        // CX-033 / 034 / 035 外链视频白名单与直链识别（2026-10-09 验收）
// 第四批 6.1：题型注册表（各题型的校验、快照、学员副本、评分、明细与计分；旧四种题型逐字移植，见 test/qtypes-legacy-parity）
const QT = require("./modules/learning/qtypes/index.js");
// listProjects / programsOfCourse：「退训后不再提醒」（withdrawnOnly，2026-10-07）按培养项目期次反查课程，读本进程的缓存。
// 期次引用集合按期次对象缓存在 completion.js 里：refreshContent 整批换掉 TPROJECTS 后自然失效（不要就地改 TPROJECTS 里的文档）。
const COMPLETION = LC.createCompletion({
  store, getCourse: (id) => getCourse(id),
  listProjects: () => TPROJECTS, programsOfCourse: (cid, c) => programsContaining(cid, c),
});
// 组织层级与 HoD 推算（纯函数，modules/core/org.js）；server.js 侧的封装见 orgSnapshot / hodOf / deptLevelsOf。
const orgLib = require("./modules/core/org.js");

// ---------- 领域事件（ARCHITECTURE-MODULAR.md §5.3；机制 kernel/events.js，捕获点 store.js） ----------
// 员工/部门的变化由 store.js 的写函数在同一事务里写进 event_outbox；最外层事务提交之后，store 把
// 这批事件交给这里的总线，按 manifest 的 subscribes（处理函数在 modules/<id>/hooks.js）同步分发，
// 结果写回发件箱。订阅方抛异常只记 [events] 日志 + 发件箱 lastError，不影响请求结果。
// 没有订阅方的事件类型写入时即记为已分发（needsDispatch）；登记 culture 后 employee.transferred / terminated / reactivated 与 department.* 有订阅方（culture 关闭时照常分发、它的处理函数跳过）。
// 被关掉的可售模块，其处理函数不运行（modulesOn 现读配置，每轮分发每个模块读一次）。actorId 由
// handleApi 入口的 domainEvents.enterContext 提供（AsyncLocalStorage，跨 await 不串请求）。
// 在 store.init 之前接上：init 本身不产生事件（种子与迁移都是裸 SQL），接早了也无妨。
const domainEvents = require("./kernel/events.js");
const EVENT_BUS = domainEvents.createBus({
  subscriptions: REGISTRY.events.subscriptions,
  isModuleOn: (id) => { const on = modulesOn(); return !(id in on) || on[id]; },
  // 给处理函数的只读服务（ctx.services）：HoD 与部门层级是 culture 等订阅方最先要问的两件事。
  // 工厂形式：总线在每一轮分发里调用一次，这一轮的全部事件共用同一个组织快照（第一次用到时才建）。
  // 4,000 人的批量调动是一轮 4,000 个事件；逐个 hodOf 各建一次快照（全表读 users + 推算，925 人
  // 约 6ms）会把这次请求卡住几十秒。处理函数自己写库触发了新事件时，总线换一份新服务（见 createBus）。
  services: () => eventServices(false),
  // 按模块提供 services（第二段，modules/culture/CONTRACT.md 4.13 末段、6.2）：带 handler 路由的模块（culture）
  // 拿到的就是它的工厂拿到的同一个冻结对象（尚未组装时为 null：跳过其处理函数、按失败记，不回退到共用对象）；
  // core 另拿一份同样按轮共享快照的服务，多一个幂等写人才记录的函数（它订阅 culture.program.completed）；
  // 其余模块返回 undefined，照旧用上面的共用服务。
  moduleServices: (id) => (id === "core" ? eventServices(true) : MODULE_HOST.eventServicesFor(id)),
  record: (results) => store.recordEventDispatch(results),
});
// then：提交这批事件的事务登记的 afterCommit 回调。总线正在分发时（事务是某个处理函数开的）由它排在这批事件之后
// 执行并返回 true；否则同步分发完返回，由 store 接着执行（modules/culture/CONTRACT.md 4.2「事件分发之后」）。
store.setEventSink((committed, then) => EVENT_BUS.publish(committed, then), { needsDispatch: (type) => EVENT_BUS.hasSubscribers(type) });
// 事件处理函数的每轮服务（见上）。forCore：core 自己的订阅需要写正式人才记录（culture 结束事件 →
// talent_records，按业务键确定性生成 id、INSERT OR IGNORE，同一对只写一次）；这个写入口只给 core。
function eventServices(forCore) {
  let snap = null;
  const snapshot = () => snap || (snap = orgSnapshot());
  const s = {
    hodOf: (deptName) => hodOf(deptName, snapshot()),
    deptLevelsOf: (user) => deptLevelsOf(user, snapshot()),
  };
  if (forCore) s.addTalentRecordOnce = (rec) => store.addTalentRecordOnce(rec);
  return Object.freeze(s);
}

// ---------- 模块宿主（接入方式 B：内核按 manifest 分发模块路由，kernel/module-host.js） ----------
// 写了 handler 路由的模块（culture）不在本文件里写分支：宿主负责模块迁移、按 CONTRACT.md 第 4 节为每个模块组装
// 一份冻结的 services、调用 modules/<id>/index.js 工厂并做启动校验、把工厂的 jobs 交给 kernel/jobs.js 调度，
// 以及 handleApi 里的 dispatchModuleRoute 与 serveStatic 的模块静态挂载。启动顺序见文件末尾（store.init 之后）。
// 这里只创建、不做任何 I/O；依赖以函数传入，调用时才解析（notify 等在本行之后才定义）。
const MODULE_HOST = require("./kernel/module-host.js").createModuleHost({
  registry: REGISTRY,
  store,
  events: domainEvents,
  orgLib,
  readConfig: () => readConfig(),
  modulesOn: () => modulesOn(),
  isProduction: () => store.isProduction(),   // 宿主在 init 时求值一次并缓存：生产环境的 services.now() 忽略 LMS_FAKE_NOW
  nowMs: () => nowMs(),
  notify: (userId, n) => notify(userId, n),
  csv: (rows, headers) => csvText([headers || []].concat(rows || [])),
  csvLines: (rows) => csvLinesText(rows || []),
  org: { snapshot: () => orgSnapshot(), hodOf: (dept, snap) => hodOf(dept, snap), deptLevelsOf: (user, snap) => deptLevelsOf(user, snap), jobGrades: () => jobGrades() },
  rbac: { canRead, canWrite, isSuperAdmin, scopeAllowsFor, scopePredicate, scopeDeptPredicate },
  line: { isInReportingLine, reportingSubtree },
  moduleDataDir: (id) => moduleDataDir(id),   // CX-166
});

// ---------- instance identity（排障第一问：「你连的是哪个库？」） ----------
// 实例指纹 = sha256(解析后的 DB 绝对路径) 前 8 位。/api/env 是公开端点，只放这 8 位
// 十六进制（暴露不了路径，也反推不回去）；两台「看起来一样」的部署，指纹不同就是库
// 不同 —— 客户实例排障从此第一眼可辨。全量信息（含真实路径）在 /api/admin/instance。
const INSTANCE_ID = crypto.createHash("sha256").update(store.dbPath()).digest("hex").slice(0, 8);
const BOOTED_AT = new Date().toISOString();

// ---------- notifications (in-app + pluggable email hook) ----------
// notify() / sendEmail() / escHtml moved to notify.js so the scheduled jobs
// (scripts/notify-due.js) deliver through the exact same path as the live
// server — email config semantics, HTML escaping and the "n-…" id shape are
// defined once. Thin aliases: every call site below stays unchanged.
// (See notify.js for the config.json "email" block that turns delivery on.)
const { notify, sendEmail, escHtml, emailConfigured } = require("./notify.js");
// reviewItemId -> last nudge timestamp. In-memory on purpose: the cooldown is a
// courtesy throttle, and losing it on restart is harmless.
const nudgedAt = new Map();
// notifyAdmins(n, domain): fan a notification out to the admins who can act on
// it. RBAC P1 made "admin" plural, so the old `role === "admin"` filter left
// every non-super-admin role deaf: a learning-admin never saw the appeal /
// enrolment / nomination notices that are the whole reason that role exists.
// Rule: every admin identity (isAdmin — legacy flag OR an assigned role) whose
// grants hold `domain` at read/manage. canRead() is true on every domain for a
// super-admin, so super-admins keep receiving everything. Domain filtering is
// also what keeps the read-only auditor (audit=read) out of business traffic.
// domain omitted → every admin, which is the pre-RBAC behaviour (used for
// console-wide diagnostics that belong to no single domain).
// opts.write（第二批 2.3，2026-10-08）：通知要求的是一个**写**动作（补部门 / 上级、处理同步提示）时传 true，只发给该域
// 有管理权限的人 —— 绩效与人才管理员自此有 people 只读（迁移 68），不该再收到他处理不了的 people 通知。
function notifyAdmins(n, domain, opts) {
  const write = !!(opts && opts.write);
  for (const u of store.listUsers()) {
    if (!isAdmin(u)) continue;
    if (domain && !(write ? canWrite(u, domain) : canRead(u, domain))) continue;
    notify(u.id, n);
  }
}
// AI 治理服务实例（modules/ai/service.js）：功能开关判定、调用记录、限流与并发、月度预算、配置指纹、保留期清理。
// 系统动作（预算预警、配置变更、到期清理）的审计 actor 为空。
const AI = require("./modules/ai/service.js").createAiService({
  store, readConfig, modulesOn: () => modulesOn(), isProduction: () => store.isProduction(), brandName: () => brandCfg().name,
  auditSystem: (action, target, before, after) => store.addAudit({ actorId: null, actorName: null, action, target, before, after, requestId: null }),
  notifyAdmins: (n, domain) => notifyAdmins(n, domain),
});

// ---------- helpers ----------
// Lenient email check for the optional employee email (used by notifications).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return salt + ":" + hash;
}
// 异步版 hashPassword：输出格式逐字相同（16 字节随机盐 hex + ":" + 32 字节 scrypt hex），
// scrypt 成本参数也相同（都用 Node 默认 N=16384, r=8, p=1），所以 checkPassword 照常校验。
// 区别只在执行位置：crypto.scrypt 回调版在 libuv 线程池里算，不占事件循环。
// 批量接口（employees/bulk、bulk-reset）每人一次 scrypt（50–150ms），同步算 4,000 人
// 会让整站卡死 3–10 分钟；走这里，算哈希期间别的请求照常响应。
function hashPasswordAsync(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(pw, salt, 32, (err, key) => (err ? reject(err) : resolve(salt + ":" + key.toString("hex"))));
  });
}
// 并发度刻意比线程池小 1：线程池（默认 4 线程，UV_THREADPOOL_SIZE 可调）同时也服务
// fs 读写（静态文件、附件、备份）和 DNS；把它全部占满，导入期间页面资源就要排队。
// LMS_HASH_CONCURRENCY 可显式覆盖（1–64）。
const HASH_CONCURRENCY = (() => {
  const v = Math.floor(Number(process.env.LMS_HASH_CONCURRENCY));
  if (Number.isFinite(v) && v >= 1) return Math.min(64, v);
  const pool = Math.floor(Number(process.env.UV_THREADPOOL_SIZE)) || 4;
  return Math.max(1, pool - 1);
})();
// 批量算哈希：返回与 passwords 同序的哈希数组。固定数量的 worker 从队列里取活，
// 每个 await 都让出事件循环；任何一个失败 → 整体 reject（调用方此时还没写库）。
async function hashPasswordsAsync(passwords) {
  const out = new Array(passwords.length);
  let next = 0;
  const worker = async () => {
    while (next < passwords.length) {
      const i = next++;
      out[i] = await hashPasswordAsync(passwords[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, passwords.length) }, worker));
  return out;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(pw, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}
function newToken() {
  return crypto.randomBytes(24).toString("hex");
}
function makePassword() {
  // Readable initial password — no confusable characters (0/O, 1/l/I).
  // 至少含 1 个字母和 1 个数字（IA D-25，计划 G-11）：与新密码规则一致；全字母的组合重抽。
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    let pw = "";
    for (let i = 0; i < 8; i++) pw += chars[crypto.randomInt(chars.length)];
    if (/[a-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}
// 新密码规则（IA B-G13、B-F12、D-25 ①；计划 R-371）：修改密码与重置密码同一校验 —— 至少 8 位，须同时包含字母和数字，
// 不能与工号相同，不能与原密码相同。只在设定新密码时校验，已有密码照常登录。返回 null 或 { error, code }。
function newPasswordProblem(np, { employeeId, currentHash, currentPlain } = {}) {
  if (np.length < 8) return { error: "New password must be at least 8 characters. 新密码至少 8 位。", code: "too_short" };
  if (!/[A-Za-z]/.test(np) || !/[0-9]/.test(np)) return { error: "New password must contain both letters and digits. 新密码须同时包含字母和数字。", code: "too_weak" };
  if (employeeId && np.trim().toLowerCase() === String(employeeId).trim().toLowerCase())
    return { error: "New password must not be your employee ID. 新密码不能与工号相同。", code: "same_as_employee_id" };
  if ((currentPlain !== undefined && np === String(currentPlain)) || (currentHash && checkPassword(np, currentHash)))
    return { error: "New password must be different from the current one. 新密码不能与原密码相同。", code: "same_as_current" };
  return null;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function getSessionUser(req) {
  return store.getSessionUser(parseCookies(req).sid);
}

// ---------- login rate limiting (in-memory, keyed by employeeId + client IP) ----------
// After LOGIN_MAX_FAILS failures the pair is locked for LOGIN_LOCK_MS. Keying by
// IP too means an attacker hammering one account can't lock out the real owner
// logging in from a different machine.
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // key -> { count, firstAt, lockedUntil }
// ---------- self-service password reset（自助找回密码 · B1） ----------
// The link mailed to an employee is a bearer credential sitting in a mailbox,
// so its life is deliberately short: 30 minutes is long enough to walk back to
// a desk, short enough that a forwarded or leaked mail is usually already dead.
// LMS_RESET_TTL_MS is a TEST seam only (same family as LMS_FAKE_NOW /
// LMS_DISABLE_AI) — unset means the 30-minute production value.
const RESET_TOKEN_TTL_MS = Number(process.env.LMS_RESET_TTL_MS) || 30 * 60 * 1000;
// Throttling for POST /api/auth/forgot on BOTH dimensions, in the same
// in-memory fixed-window style as the login lockout above:
//   · per employeeId — one person's mailbox can't be flooded with reset mails;
//   · per client IP  — a script can't walk the whole roster from one machine.
// The refusal is a 429 whose body depends only on request COUNTS, never on
// whether the id exists, so throttling is not an enumeration channel either.
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_PER_ID = 5;
const FORGOT_MAX_PER_IP = 20;
// POST /api/auth/reset: a 256-bit token is not guessable, so this is purely
// anti-hammering (a client retrying a dead link in a loop).
const RESET_MAX_PER_IP = 30;
const forgotHits = new Map(); // key -> { count, firstAt }
function hitCount(key, windowMs) {
  const now = Date.now();
  let r = forgotHits.get(key);
  if (!r || now - r.firstAt > windowMs) r = { count: 0, firstAt: now };
  r.count++;
  forgotHits.set(key, r);
  // Opportunistic prune — this map is only ever touched by the two reset routes.
  if (forgotHits.size > 5000) for (const [k, v] of forgotHits) if (now - v.firstAt > windowMs) forgotHits.delete(k);
  return r.count;
}
// Counts BOTH dimensions on every call — no short-circuit: an attacker must not
// be able to keep one counter cold by being the one who trips the other.
function forgotThrottled(req, employeeId) {
  const byId = hitCount("fid|" + String(employeeId || "").trim().toLowerCase(), FORGOT_WINDOW_MS);
  const byIp = hitCount("fip|" + clientIp(req), FORGOT_WINDOW_MS);
  return byId > FORGOT_MAX_PER_ID || byIp > FORGOT_MAX_PER_IP;
}
function resetThrottled(req) {
  return hitCount("rip|" + clientIp(req), FORGOT_WINDOW_MS) > RESET_MAX_PER_IP;
}
// Tokens are stored only as this hash (see store.js migration 45). sha256 is the
// right tool here precisely because the input is high-entropy random bytes — the
// slow-hash argument for passwords does not apply to a 256-bit random string.
const sha256Hex = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
// The ONE response POST /api/auth/forgot ever sends on the non-throttled path.
// Frozen and built from constants: this constancy IS the anti-enumeration
// guarantee, so never interpolate the submitted id, an email address or a branch
// outcome into it. The wording promises nothing about THIS id existing.
const FORGOT_REPLY = Object.freeze({
  ok: true,
  code: "reset_requested",
  message: "If that employee ID exists and has an email address on file, a reset link has been sent to it.",
});
// ---------- module switches（商品化模块开关） ----------
// learning / performance / talent can each be switched off; core (people, org,
// auth, …) has no key and is always on. Two knobs, combined here:
//   · config.json "modules" block — a MISSING block or key means ON; only an
//     explicit false switches a module off. The direction is the OPPOSITE of
//     the lark/ai/email blocks (those turn ON when filled in), so existing
//     deployments with no config keep every module — default = zero change.
//   · LMS_MODULES_OFF="learning,performance" — comma list forced off, wins
//     over config. "core" or unknown names are ignored (only the sellable keys are read).
// Reads config.json on every call — same no-cache contract as larkCfg() and the AI service.
// M0: the keys are the SELLABLE modules from the registry (manifest sellable:true,
// in modules/index.js order → { learning, performance, talent }, same shape as before).
// 第二段（PHASE2-KERNEL.md 4.7）：manifest 可写 defaultOn（只限可售模块）。config 的 modules 块里该键是
// 布尔值时按它；没写（或不是布尔值）时按 REGISTRY.DEFAULT_ON —— 没写 defaultOn 的模块为 true，所以
// learning / performance / talent 仍然是「只有显式 false 才关」，行为逐字不变；culture 写的是 defaultOn:false，
// 要在 config.json 写 "culture": true 才开。LMS_MODULES_OFF 仍然优先。
function modulesOn() {
  const cfg = readConfig().modules || {};
  const off = new Set(String(process.env.LMS_MODULES_OFF || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const on = (k) => (typeof cfg[k] === "boolean" ? cfg[k] : REGISTRY.DEFAULT_ON[k] !== false) && !off.has(k);
  const out = {};
  for (const k of REGISTRY.SELLABLE) out[k] = on(k);
  return out;
}
// Path-pattern → module map for the gate at the top of handleApi. Routes do
// NOT split cleanly by prefix (/api/admin/* and /api/me/* mix all four
// domains), so this is an explicit list. A string entry matches the exact path
// or any subpath under it; anything not listed is core or deliberately ungated
// (aggregates like /api/admin/dashboard trim their response fields instead of
// closing — see that handler).
// M0: generated by kernel/registry.js from each sellable manifest's `gate` list
// (modules/index.js order). Pre-M0 hand-written copy frozen in
// test/fixtures/m0-legacy-tables.js; test/m0-registry-equivalence.test.js pins them equal.
const MODULE_ROUTES = REGISTRY.MODULE_ROUTES;
function moduleOfPath(pathname) {
  for (const [pat, mod] of MODULE_ROUTES) {
    if (typeof pat === "string") {
      if (pathname === pat || pathname.startsWith(pat + "/")) return mod;
    } else if (pat.test(pathname)) return mod;
  }
  return null;
}
// ---------- RBAC P1: capability-domain gate ----------
// Design: RBAC-DESIGN.md v3 (§4/§5); since M0 the route → domain facts live in
// modules/*/manifest.js (RBAC-ROUTE-MATRIX.md is an explanatory snapshot). Keyed by PATH PATTERN, never line numbers
// (which drift as server.js is edited). Runs inside the /api/admin/ gate below,
// in parallel with the module switch (both filters must pass).
// D6（2026-08-28）：9 个能力域。原「账号与角色 accounts」拆为 accounts（员工账号：
// 建号/重置/停用，可授予且受部门范围约束）与 roles（角色与授权：建/改/删角色、指派
// adminRoleId，恒超管、不可授予）。roles 接管原 accounts 的锁定语义。
// M0: generated from the manifests' `domains` (sorted by each domain's order) —
// same 9 ids in the same order as the pre-M0 literal, which fixes the key order of
// grants objects (RBAC_ALL_MANAGE, sanitizeGrants, /api/me grants).
const RBAC_DOMAINS = REGISTRY.RBAC_DOMAINS;
const RBAC_ALL_MANAGE = RBAC_DOMAINS.reduce((o, d) => { o[d] = "manage"; return o; }, {});
// isAdmin: legacy admin flag OR any assigned admin role.
function isAdmin(user) {
  return !!user && (user.role === "admin" || user.adminRoleId != null);
}
// isSuperAdmin: an assigned role whose key is super-admin, or the legacy fallback
// (role==='admin' with no adminRoleId — a half-migrated / freshly seeded db).
function isSuperAdmin(user) {
  if (!user) return false;
  if (user.adminRoleId != null) {
    const r = store.getRole(user.adminRoleId);
    return !!r && r.key === "super-admin";
  }
  return user.role === "admin";
}
// resolveGrants: super-admin → all 9 domains manage; else the assigned role's
// grants with roles forced to none (roles is never grantable — D6: it took over
// the lock from accounts; accounts is now a grantable domain); else {}.
function resolveGrants(user) {
  if (isSuperAdmin(user)) return { ...RBAC_ALL_MANAGE };
  if (user && user.adminRoleId != null) {
    const r = store.getRole(user.adminRoleId);
    const g = r && r.grants && typeof r.grants === "object" && !Array.isArray(r.grants) ? { ...r.grants } : {};
    g.roles = "none";
    return g;
  }
  return {};
}
function canRead(user, domain) {
  if (isSuperAdmin(user)) return true;
  const lvl = resolveGrants(user)[domain];
  return lvl === "read" || lvl === "manage";
}
function canWrite(user, domain) {
  if (isSuperAdmin(user)) return true;
  return resolveGrants(user)[domain] === "manage";
}
// 人才记录 CSV（GET /api/admin/export/records.csv，含违规记录）谁能导出 —— 唯一判定处（第二批 2.3，2026-10-08）。
// 现行 = people 可读（与 rbacGate 的 people 读同口径；方案 A 下绩效与人才管理员因迁移 68 也能导出）。
// 负责人对 docs/DECISIONS-batch2-20261008.md 第 2 项若定「不许导出」，只改这一行为 canWrite(user, "people")。
function canExportTalentRecords(user) {
  return canRead(user, "people");
}
const RECORDS_EXPORT_FORBIDDEN = { error: "You don't have permission to export talent records. 你没有导出人才记录的权限。", code: "export_forbidden" };
// GET /api/admin/dept-tree 的读者（第二批 3.1 规则 W1c，与 roster 的 W1 同一批域；判定写在 handleApi 的后台闸门里，先于 rbacGate）
const DEPT_TREE_READ_DOMAINS = ["people", "learning", "performance", "talent"];
// ---------- 员工档案页签扩展点（ARCHITECTURE-MODULAR.md §5.4 profile.tabs）----------
// 模块在 manifest 的 extensions["profile.tabs"] 登记页签；三个档案接口在响应里带 tabs，
// 即「这个用户在这个位置能看到的页签」（按 order 排好，只含已开启的模块）：
//   "admin" → GET /api/admin/employees/:id/profile（后台 People.jsx；页签填了 domain 时还要该能力域可读）
//   "line"  → GET /api/me/reports/:userId（汇报线上级看下属，ReportProfile.jsx）
//   "self"  → GET /api/me/growth（员工本人「我的记录」，Record.jsx）
// 这里只给清单：页签内容由前端组件（web/src/profileTabs.js 注册）自己向所属模块的接口请求，
// 那些接口各自做权限与范围判定。目前没有模块登记页签，三个接口的 tabs 恒为 []。
// modulesOn 以函数传入：没有候选页签时注册表不调用它，接口不会为此多读一次 config.json。
function profileTabsFor(user, audience) {
  return REGISTRY.profileTabs({ audience, modulesOn, canRead: (domain) => canRead(user, domain) });
}
/* ---------- RBAC P2: 数据范围 scope（A：people / B：learning / C：performance+talent）----------
   下面这五个封装是**唯一**一套范围口径，后面三批（learning 25 + performance 6 +
   talent 8）全部直接复用（别再另起一套：两处口径一旦分叉，泄露就发生在分叉处）。

   阶段 C 只多出一种新形状：**整周期判定**。POST /api/admin/review-cycles/:id/close 是
   全部 112 条里唯一「部分执行会造成不可逆数据缺失」的端点（关账把评级写成永久档案，
   写完周期即锁死，漏写无法补），所以它按整周期拒绝而不是逐条跳过 —— 推理写在那条
   handler 上。其余 13 条都落在已有的三种形状里：过滤（名单）/ 重算（聚合）/ 校验（单人）。

   learning 域多出一种在 people 里没出现过的
   形状 —— **混合主体**：GET /api/admin/tprojects/:id 一个响应里既有项目文档（内容对象、
   不受约束）又有 members[]（员工主体、要过滤）。规则是只过滤员工那一半，绝不把整个
   项目藏掉；理由写在那条 handler 上。内容对象（课程、题库、考试定义、项目文档）一律
   不加门 —— §6.3 记的三个 critical 全是「授权了却用不了」。

   两个**独立**维度，叠加生效：域闸门（canRead/canWrite/rbacGate）决定「能不能碰
   这类数据」，范围决定「能碰**哪些人**的数据」。顺序恒定：先过域闸门，再过范围。
   解析器与它的 fail-closed / 缓存论证在 store.js（parseScope 一节）；这里只有三个
   薄封装 + 两个应答口径，全部对**超管短路**（RBAC-DESIGN.md §2：超管不受范围约束），
   与 canRead/canWrite 的姿态一字不差。

   空范围 = 全公司 = 不过滤（向后兼容红线）：scopePredicate() 在这种情况下回 null，
   调用方走**原样**的全公司代码路径——现有全部角色的 scope 都是空的，所以它们与超管
   一样，一行行为都不变。

   ===== 应答口径 =====
   范围外的单人主体（读或写）一律回 **404**，与 rbacGate 的 none 档一字不差。
   403「你无权」会确认「这个 id 背后确实有个人」，把每个 :id 变成一个越界探测器
   （换个 id 再试就能枚举全公司）；而范围的语义正是「这些人对你不存在」。读同理：
   范围外**整条不返回**，不是隐藏字段——隐藏字段仍然泄露行数与存在性。

   ===== 设计选择① 批量端点部分越界 → 整批拒绝（不是跳过）=====
   跳过是不可接受的：这些批量端点（bulk-update / records/bulk /
   secondary-lines/bulk）的调用方是一次「粘贴 3000 行」的导入，成功回 200 之后没人
   会去逐行读 results。跳过的结果是**静默的部分执行**——HR 以为 3000 人都改了，实际
   改了 2400，差额只有审计日志里一行 count 能看出来，而缺失的那 600 行永远不会被补
   （§9 ② 记的正是这个坑，现有 handler 的 `continue` 风格天然引诱人写成跳过）。
   整批拒绝把错误变成**立刻可见且可修**的一次失败：一个数字告诉 HR 要改几行。
   代价（明确接受）：回报越界条数会让调用方分辨出「这个工号存在但不属于我」与
   「查无此工号」（后者仍按原样逐行 skipped + 200）。这不是免费的，但泄露面被限定在
   「调用方**自己刚提交的那些 id**」上，且拒绝必须可行动——不给数字的 404 等于让 HR
   在 3000 行里盲找。单人主体端点不受此影响：它们回的是**裸 404**，与「不存在」同形。 */
function actingRole(user) {
  return user && user.adminRoleId != null ? store.getRole(user.adminRoleId) : null;
}
// null = 全公司（调用方走原样路径）；否则一个 O(1) 的按行判定函数。
// 判定一律委托 store.scopeAllowsUser（同一份 epoch 缓存，O(1) 的 Map/Set 查找，
// store.js「性能」一节明文背书 925 次调用）——**不在这里重写大小写/空部门口径**：
// 两处口径一旦分叉，泄露就发生在分叉处。
function scopePredicate(user) {
  if (isSuperAdmin(user)) return null;
  const role = actingRole(user);
  if (store.resolveScopeDepartmentNames(role) === null) return null; // 空范围 = 全公司
  return (u) => store.scopeAllowsUser(role, u);
}
// 单个员工是否可见（读的 404 门 + 写的 404 门用同一个判定）。
// 先判「范围是否生效」再判人，不是直接转发 store.scopeAllowsUser：后者对 target=null
// 一律回 false（范围生效时的 fail closed 是对的），而**空范围/超管**必须与改动前
// 一字不变——包括「主体行悬空」这种引用完整性问题原来能删、现在也还能删。
function scopeAllowsFor(user, target) {
  if (isSuperAdmin(user)) return true;
  const role = actingRole(user);
  if (store.resolveScopeDepartmentNames(role) === null) return true; // 空范围 = 全公司
  return store.scopeAllowsUser(role, target);
}
// 单个**部门名**是否在范围内（departments 四条写路径用；部门写 = 对该部门全体员工的
// 一次批量写，理由见 RBAC-SCOPE-INVENTORY.md §7.1）。一次调用一条，别放进循环 ——
// 它每次都要 store.getRole()（一次库查询）；列表过滤用下面的 scopeDeptPredicate。
function scopeAllowsDeptFor(user, deptName) {
  if (isSuperAdmin(user)) return true;
  const role = actingRole(user);
  if (store.resolveScopeDepartmentNames(role) === null) return true; // 空范围 = 全公司
  return store.scopeAllowsDepartment(role, deptName);
}
// 部门名的**列表**过滤器：角色只解析一次（GET /departments 有 272 行，逐行 getRole
// 就是 272 次库查询 —— 这条端点原本就是后台最慢的一条，别再往里加）。null = 全公司。
function scopeDeptPredicate(user) {
  if (isSuperAdmin(user)) return null;
  const role = actingRole(user);
  if (store.resolveScopeDepartmentNames(role) === null) return null;
  return (name) => store.scopeAllowsDepartment(role, name);
}
// ---------- 全站部门筛选唯一口径（第二批 3.1，2026-10-08）----------
// 后台各页的部门筛选（培训概览、completion.csv、GET /api/admin/dept-tree、评估周期的 deptPath / deptOptions）都经这里，
// 判定委托 modules/core/org.js 的 deptOptionsOf / deptPathOf / deptMatcherOf：集团层不算祖先（一级部门 = Lark L3）、
// 选上级即含全部下级、四级及以下并入所属三级（只是不单独成选项）、部门名不在部门表或父链成环用 "name:" 伪 id、
// "__none" = 没有部门；范围受限的角色只看得到范围内的部门（链上范围外的部门去掉）。
//   options(users, { maxLevel = 3, counts })  → { options, idByName, chainById }（counts:true 时 count 只数在职的人）
//   pathOf(u)                                 → 一级 → 本部门的 id 链（范围外的部门去掉）
//   parse(raw)                                → (部门名) => bool；空 / 未知 / 范围外的部门 id → null（调用方按「没筛选」处理）
// opts.deptRows：调用方已读过的部门表（省一次查询）。
function deptFilterFor(user, opts) {
  const deptRows = (opts && opts.deptRows) || store.listDepartments(true);
  const ix = orgLib.buildOrgIndex(deptRows);
  const allow = reviewDeptPredMemo(scopeDeptPredicate(user));
  return {
    ix, allow,
    options(users, o) {
      const list = (users || []).filter(Boolean);
      let counts = null;
      if (o && o.counts) {
        counts = new Map();
        for (const u of list) if (u.department && orgLib.isInService(u)) counts.set(u.department, (counts.get(u.department) || 0) + 1);
      }
      return orgLib.deptOptionsOf(ix, list.map((u) => u.department), allow, { maxLevel: o && o.maxLevel !== undefined ? o.maxLevel : 3, counts });
    },
    pathOf(u) { return orgLib.deptPathOf(ix, u && u.department, allow); },
    parse(raw) {
      const id = raw === null || raw === undefined ? "" : String(raw).trim();
      if (!id) return null;
      if (id === orgLib.DEPT_NONE || id.startsWith("name:")) return orgLib.deptMatcherOf(ix, id);
      const d = ix.byId.get(id);
      if (!d || (allow && !allow(d.name))) return null;
      return orgLib.deptMatcherOf(ix, id);
    },
  };
}
// 批量端点的整批拒绝应答（设计选择①）。404 而非 403，与单人主体同口径。
function sendScopeBulkReject(res, n) {
  return send(res, 404, {
    error: `${n} row(s) point at people outside your data scope — nothing was changed. `
      + `其中 ${n} 行指向你的数据范围之外的员工，本次未做任何修改。`,
    code: "out_of_scope", outOfScope: n,
  });
}
// 目标**部门**不在范围内（调部门、建部门、改父级）。这里用 400 而不是 404：拒绝的对象
// 是调用方**自己刚填进来的那个部门名/ id**，不构成任何人的存在性泄露，而 400 + 明确
// 文案是唯一可行动的形态（404 会被前端当成「部门不存在」，HR 会去建一个重名部门）。
function sendScopeDeptReject(res) {
  return send(res, 400, {
    error: "That department is outside your data scope. 该部门不在你的数据范围内。",
    code: "dept_out_of_scope",
  });
}
// 部门挂到自己的子树下（PUT 改上级、POST 认领孤儿部门共用；判定在 store.departmentWouldCycle）。
function sendDeptCycle(res) {
  return send(res, 400, {
    error: "A department can't sit under its own subtree 不能把部门挂到自己的子部门下",
    code: "dept_cycle",
  });
}
// 部门里还有员工档案时拒绝删除（DELETE /departments/:id 与旧版 POST { action: "delete" } 共用，两条删除路径的应答一致）：
// 只能停用。code 沿用旧版 POST 的 "occupied"，headcount 为按部门名（不分大小写）数到的人数。
// CX-127 / CX-131：人数含已离职员工（删除会让他们的档案失去部门），部门页的「在职」人数只计在职 —— 文案写明含已离职；中英文分开。
function sendDeptOccupied(res, headcount) {
  return send(res, 400, {
    error: `${headcount} employee record(s), including former employees, are in this department — deactivate it instead.`,
    error_zh: `该部门还有 ${headcount} 名员工档案（含已离职员工），不能删除，只能停用。`,
    code: "occupied",
    headcount,
  });
}
// 部门写的审计形状：before 与 after 同一组键，审计页逐键比对时只显示真正变了的字段。
// 负责人同时记 id 与姓名（姓名在前，审计摘要先读到人名；id 用来区分同名的人）。
function deptAuditShape(d) {
  if (!d) return null;
  const owner = d.ownerId ? store.getUserById(d.ownerId) : null;
  return {
    id: d.id, name: d.name, parentId: d.parentId || null, active: d.active !== undefined ? !!d.active : true, sort: d.sort,
    ownerName: owner ? owner.name : null, ownerId: d.ownerId || null,
  };
}
/* ---------- 批量写的原子性（七个批量接口共用）----------
   employees/bulk、employees/bulk-reset、employees/bulk-update、records/bulk、
   secondary-lines/bulk、questions/bulk、assignments/bulk 的写库全部包在一个
   store.transaction() 里：
     · 逐行**校验**类问题（查无此人、日期非法、重复……）照旧逐行 skipped，不回滚；
     · 任何一行**抛异常**（库约束、代码缺陷、磁盘错误）→ 整批回滚，库里一行不留，
       回 500 + code "batch_failed" + 出错行号（line，从 1 起）+ 中英双语提示。
   副作用（审计、会话吊销以外的通知/邮件、缓存刷新）一律放在 runBatch() 返回 ok 之后，
   回滚时一个都不发生。会话吊销（bulk-reset）是库写，放在同一事务里与改密一起提交/回滚。

   测试缝 LMS_TEST_FAIL_BULK_AT=<行号>：处理到该行时在事务里抛异常，用来验证整批回滚。
   四重门：必须同时设了 LMS_DB_PATH、且它解析后位于系统临时目录之内（测试一律注入
   os.tmpdir() 下的一次性库；LMS_DB_PATH 也是运维重定向正式库的变量，只看「设没设」
   不够），且不是生产模式；任一不满足时为 0，bulkFaultPoint 是空操作。 */
function dbPathIsTemp() {
  if (!process.env.LMS_DB_PATH) return false;
  const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(process.env.LMS_DB_PATH));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
const TEST_FAIL_BULK_AT = (() => {
  const v = Math.floor(Number(process.env.LMS_TEST_FAIL_BULK_AT));
  if (!(Number.isFinite(v) && v > 0) || !dbPathIsTemp() || store.isProduction()) return 0;
  console.warn(`[test seam] LMS_TEST_FAIL_BULK_AT=${v}: bulk endpoints will throw at row ${v}`);
  return v;
})();
function bulkFaultPoint(line) {
  if (TEST_FAIL_BULK_AT && line === TEST_FAIL_BULK_AT)
    throw new Error(`injected failure at row ${line} (LMS_TEST_FAIL_BULK_AT)`);
}
// work(cur) 在事务里同步执行；它在处理每一行前把 cur.line 设成当前行号（从 1 起），
// 出错时据此报行号。返回 { ok:true, value } 或 { ok:false, line, error }。
// 事务是同步的，执行期间事件循环被占住：耗时 ≥ 1 秒时记一行 stderr（[batch-tx]），
// 运维能看到大批量导入的阻塞时长；scripts/bench-bulk.js 也读这一行报告事务阶段耗时。
// LMS_BULK_TIMING=1 时每次都记。
const BULK_TIMING_ALWAYS = process.env.LMS_BULK_TIMING === "1";
function runBatch(work) {
  const cur = { line: 0 };
  const t0 = process.hrtime.bigint();
  const logTx = (ok) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (BULK_TIMING_ALWAYS || ms >= 1000)
      console.warn(`[batch-tx] ${ok ? "commit" : "rollback"} ${cur.line} rows in ${ms.toFixed(0)}ms`);
  };
  try {
    const value = store.transaction(() => work(cur));
    logTx(true);
    return { ok: true, value };
  } catch (error) {
    logTx(false);
    return { ok: false, line: cur.line, error };
  }
}
// 提交成功之后的副作用（审计等）。数据此刻已经落库，副作用本身失败（例如审计表写失败）
// 不能再把这次请求变成 500：employees/bulk、bulk-reset 的响应里带着只出现一次的初始 /
// 临时密码，响应丢了，这批账号就谁也登不进去、也查不到密码。所以这里吞掉异常、记日志，
// 让调用方照常把结果发出去。
function afterCommit(what, fn) {
  try { fn(); } catch (e) { console.error(`[after-commit] ${what}:`, e && e.stack || e); }
}
// 整批回滚的应答。响应里**不回传原始异常文本**：SQLite 约束信息会暴露表名/列名，
// 代码缺陷的异常信息可能夹带行内数据 —— 调用方拿到的只有双语提示 + code + 行号。
// 原始异常与出错行号只进 stderr（运维排障用），一行、[batch-tx] 前缀：
//   · 只记异常类型、message 与最靠前的几帧调用栈，整行截断到 BATCH_ERR_LOG_MAX 字符；
//   · 绝不记请求体（rows/items 原样不进日志），形如 scrypt 存储格式的串与会话 token 一律替换成
//     [redacted]（防止某条异常信息把密码哈希带出来）；换行压成 " | "，免得一条异常把
//     日志拆成多行、被日志采集当成多条。
const BATCH_ERR_LOG_MAX = 600;
function batchErrorLogText(err) {
  let s;
  if (err && typeof err === "object") {
    const head = `${err.name || "Error"}: ${err.message || ""}`;
    const frames = String(err.stack || "").split(/\r?\n/).slice(1, 4).map((l) => l.trim()).filter(Boolean);
    s = [head, ...frames].join(" | ");
  } else s = String(err);
  // 32 位以上的连续 hex 一律视为凭据（scrypt 盐/哈希；会话 token 是 48 位 hex）。
  s = s.replace(/[0-9a-f]{32}:[0-9a-f]{64}/gi, "[redacted]").replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/[\r\n]+/g, " | ");
  return s.length > BATCH_ERR_LOG_MAX ? s.slice(0, BATCH_ERR_LOG_MAX) + "…" : s;
}
// 单条人事记录写入失败的应答（records 的 POST / PUT：主数据副作用与记录行在同一事务里，
// 此刻已整笔回滚）。与 sendBatchFailed 同一条原则：原始异常只进 stderr，不回给调用方。
function sendRecordSaveFailed(res, what, err) {
  console.error(`[record-tx] ${what} rolled back: ${batchErrorLogText(err)}`);
  return send(res, 500, {
    error: "Saving the record failed — nothing was changed, employee data included. Try again; if it keeps failing, contact your administrator. "
      + "保存记录失败，未做任何修改（包括员工主数据）。请重试；如仍失败请联系管理员。",
    code: "record_save_failed",
  });
}
// opts.selection=true：按选中人员逐个处理的批量操作（bulk-update、assignments/bulk），
// line 是「第几个选中的人」（userIds 的下标 + 1），文案不说「导入 / 第几行」。
function sendBatchFailed(res, what, fail, opts = {}) {
  const line = fail.line || 0;
  console.error(`[batch-tx] batch_failed ${what} row ${line}: ${batchErrorLogText(fail.error)}`);
  // CX-043（2026-10-10 验收）：并发写冲突不是服务端故障 —— 回 409 busy，行号照给，提示重试；其余仍 500
  const busy = /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(batchErrorLogText(fail.error));
  const status = busy ? 409 : 500;
  if (opts.selection) {
    // opts.noun = "item"：选中的不是人（申请、题目），文案说「第 N 个选中项」（2026-10-06 批量操作 B1、B4）
    const item = opts.noun === "item";
    const where = line ? (item ? `selected item #${line}` : `selected person #${line}`) : "the batch";
    const whereZh = line ? (item ? `第 ${line} 个选中项` : `第 ${line} 个选中人员`) : "本批";
    // opts.split：中英分列（error / error_zh）—— 2026-10-06 批量操作 B1–B4 的新端点用；原有调用方仍是一句双语
    if (opts.split)
      return send(res, status, {
        error: `The bulk action failed at ${where} — the whole batch was rolled back and nothing was changed. Try again; if it keeps failing, ask a super-admin.`,
        error_zh: `批量操作在${whereZh}处出错，整批已回滚，未做任何修改。请重试；如仍失败请联系超级管理员。`,
        code: "batch_failed", line,
      });
    return send(res, status, {
      error: `The batch update failed at ${where} — the whole batch was rolled back and nothing was changed. Try again; if it keeps failing, contact your administrator. `
        + `批量操作在${whereZh}处出错，整批已回滚，未做任何修改。请重试；如仍失败请联系管理员。`,
      code: "batch_failed", line,
    });
  }
  const where = line ? `row ${line}` : "the batch";
  const whereZh = line ? `第 ${line} 行` : "本批";
  return send(res, 500, {
    error: `Import failed at ${where} — the whole batch was rolled back and nothing was saved. Check that row and try again. `
      + `导入在${whereZh}出错，整批已回滚，未写入任何数据。请检查该行后重试。`,
    code: "batch_failed", line,
  });
}
// 异步阶段（算哈希）之后、进事务之前重新核对调用者：几十秒的哈希期间，他的会话可能被
// 吊销、账号被停用、角色被收回。用**当下**的会话重新过一遍 rbacGate（与请求入口同一个
// 闸门），通过则返回最新的 user（后续范围校验用它），否则直接应答并返回 null。
function revalidateBulkActor(req, res, pathname) {
  // 跨进程缓存失效：请求入口那次 data_version 比对发生在几十秒之前；这期间若有脚本 /
  // 另一个进程改了课程（PROGRAMS 等），事务里的 assignPrograms 会拿旧缓存派课。这里
  // 与 handleApi 入口同口径再比对一次。
  if (store.dataVersion() !== CACHE_DATA_VERSION) refreshContent();
  const fresh = getSessionUser(req);
  if (!fresh || fresh.active === 0) {
    send(res, 401, { error: "Your session ended while the import was running — nothing was saved. Sign in and try again. 导入过程中你的登录已失效，未写入任何数据，请重新登录后再试。", code: "session_changed" });
    return null;
  }
  // 与 /api/admin/ 入口逐字同口径：非后台账号 403；超管绕过域闸门，其余过 rbacGate。
  if (!isAdmin(fresh)) { send(res, 403, { error: "Your admin access was removed while the import was running — nothing was saved. 导入过程中你的后台权限已被收回，未写入任何数据。", code: "session_changed" }); return null; }
  const g = isSuperAdmin(fresh) ? null : rbacGate(fresh, pathname, "POST");
  if (g) { send(res, g.status, { error: g.error, code: "session_changed" }); return null; }
  return fresh;
}
/* ---------- 批量操作（2026-10-06 SPEC-bulk-ops，B1–B4）----------
   五个端点：选修课程申请 / 培养项目申请的批量通过与驳回（B1）、期次与成员的批量调整与退训（B2）、
   签到 / 完成登记名单的批量登记与撤销（B3）、题库的批量改分值与改课程模块（B4）。
   口径（docs/SPEC-bulk-ops-20261006.md「统一规则」，负责人 2026-10-06 拍板）：
     · 校验顺序：路径实体（项目 / 活动）→ 操作参数（400）→ 选中项（no_items / over_cap，400）
       → 整批范围预检（任一项的主体员工在范围外 → 404 out_of_scope + 越界条数，什么都没写）→ runBatch。
     · 逐条独立：单条的业务性失败（已处理、期次已满、本人签到……）记 ok:false 跳过，成功的照常生效；
       抛异常 → 整批回滚 batch_failed（与七个批量接口同一先例：不留「派了课却没记决定」的半条）。
     · 已是目标设置的条目（调到原期次与班级、同分值、同课程与模块、同一登记状态、对已退训的人退训）
       算成功：{ ok:true, unchanged:true }，计入 done 与顶层 unchanged，不写库、不写审计。
     · 写库与副作用分开：apply* 在事务里写库，emit* 在提交后写审计、发通知；单条接口调用同一组函数，
       所以批量的数据、审计、通知与逐条做 N 次一致。批量的副作用在业务事务提交之后另开一个事务逐条执行
       （emitBulkEffects），某一条失败只记日志，不影响其余条。
     · 邮件：通知照单条逐条走 notify()（站内通知同步写库；有邮件配置时邮件异步发出，不排队）。一次批量
       N 封邮件同时发出，邮件服务商限流时可能有邮件发不出 —— 与 assignments/bulk 相同的已知限制，站内通知不受影响。 */
const BULK_REASONS = {
  not_found: ["Not found — it may have been deleted.", "未找到，可能已被删除。"],
  already_decided: ["Already decided — skipped.", "已处理，跳过。"],
  admin_not_learner: ["Back-office admin account — can't be enrolled as a learner.", "后台管理员账号，不能作为学员入班。"],
  project_or_user_gone: ["The program or the employee no longer exists.", "发展项目或员工已不存在。"],
  no_cohort: ["The program has no cohort yet.", "该发展项目还没有期次。"],
  over_capacity: (x) => [`Cohort "${x.cohort}" is full (${x.current}/${x.capacity}).`, `期次「${x.cohort}」已满（${x.current}/${x.capacity}）。`],
  not_member: ["Not a learner in this program.", "不是本发展项目的学员。"],
  withdrawn: ["Already withdrawn — skipped.", "已退训，跳过。"],
  not_in_roster: ["Not on this roster (not an active learner of this cohort).", "不在本活动名单中（不是本期次在训学员）。"],
  self_checkin: ["Checked in with the code themselves — a self check-in can't be undone.", "本人签到不可撤销。"],
  already_marked: ["Already recorded — undo it first to change it.", "已有登记，如需更改请先撤销。"],
  nothing_to_clear: ["Nothing to undo.", "没有可撤销的登记。"],
  in_fixed_exam: (x) => {
    const ex = x.exams || [], many = ex.length > 1;
    return [
      `Used by the fixed-question exam${many ? "s" : ""} ${ex.map((e) => `“${e.title}”`).join(", ")}, which ${many ? "are" : "is"} not linked to the new course.`,
      `被固定题目考试${ex.map((e) => `《${e.title_zh || e.title}》`).join("、")}使用，新课程不在${many ? "这些" : "该"}考试的关联课程中。`,
    ];
  },
  // 第二批（2026-10-07，B5 课程库、B6 评估按阶段提醒、B7 考试成绩）。「这一步已完成 / 没有待完成的人」不是跳过，
  // 按统一规则记为未改动（bulkUnchanged），所以没有对应的码。
  empty_course: ["This online course has no modules and no exam yet — not published.", "该线上课程还没有内容（0 个模块、无考试），未发布。"],
  cycle_closed: ["This review cycle is closed.", "评估周期已关闭。"],
  stage_not_applicable: ["This review cycle has no such step.", "该评估周期没有这一步。"],
  self_pending: ["The self-review is not submitted yet — remind the employee first.", "员工尚未提交自评，请先提醒员工提交。"],
  // 第二批 2.1（2026-10-08）：面谈由员工与上级各自登记，与评级互不为前提；员工这一侧的面谈提醒仍等上级先登记
  manager_pending: ["The manager hasn't logged the 1-on-1 yet — remind the manager first.", "上级尚未登记 1 对 1 面谈，请先提醒上级。"],
  no_manager: ["No active direct manager on record.", "没有在职的直属上级。"],
  no_hod: ["This department has no HoD — HR confirms it directly.", "该部门没有 HoD，由 HR 直接确认。"],
  // 2026-10-08 起不再产生（HoD 可以代评，部门未提交就照常提醒 HoD，负责人 G5）；保留给旧的结果与审计记录显示
  hod_not_ready: ["Some ratings or 1-on-1 confirmations in this department are still missing, so the HoD cannot submit yet — remind the managers first.", "部门内仍有上级未评级或面谈未确认，HoD 暂时无法提交，请先提醒上级。"],
  // 第二批 2.7：参与者已离职或停用 —— 不计入、不阻断，也不再为他提醒上级
  participant_departed: ["The employee has left — not counted, so no reminder was sent.", "员工已离职，不计入，不再提醒。"],
  hod_scope_partial: ["Some members of this department are outside your data scope, so you can't remind its HoD.", "该部门有成员不在你的数据范围内，不能提醒 HoD。"],
  // HoD「提醒他们的上级」：HoD 本人就是此人的直属上级，提醒只会发给自己 —— 请在团队评估里直接评级
  hod_is_manager: ["You are this person's direct manager, so no reminder was sent. Rate them under Team reviews.", "你是此人的直属上级，未发送提醒，请在「团队评估」里直接评级。"],
  dept_locked: ["The department calibration has been submitted — this step can no longer be changed.", "部门已提交校准，这一步不能再修改。"],
  cooldown: ["A reminder was already sent in the last hour.", "1 小时内已提醒过。"],
  recipient_inactive: ["The recipient's account is disabled or they have left.", "收件人账号已停用或已离职。"],
  no_exam: ["Not an exam attempt (legacy course quiz, or the exam was deleted).", "不是考试答卷（旧版课程测验，或考试已删除）。"],
  result_pending: ["An attempt is awaiting scoring or review — finish the review first.", "有答卷仍在评分或待复核，请先完成复核。"],
  already_passed: ["Already passed this exam — resetting would void the pass.", "已通过该考试，重置会作废通过记录，已跳过。"],
  // 第四批（2026-10-09）：情境案例题组没有题目级分值（按小题合计），批量改分值时跳过
  case_points: ["A scenario case scores the sum of its sub-questions — edit the sub-question points in the question.", "情境案例题组的分值按小题合计，请在题目中逐个修改小题分值。"],
};
// 逐条跳过的结果行：code 是界面查原因文案的键（BULK_REASONS 的键 = 前端 T.why 的键），extra 是附带字段。
function bulkSkip(id, code, extra) {
  const t = BULK_REASONS[code];
  const [error, error_zh] = typeof t === "function" ? t(extra || {}) : t;
  return { id, ok: false, code, error, error_zh, ...(extra || {}) };
}
const bulkUnchanged = (id) => ({ id, ok: true, unchanged: true });
// 选中项 → 去重后的字符串数组（保留首次出现的顺序）；空 / 不是数组 → 400 no_items，超上限 → 400 over_cap，返回 null。
// 上限与人员类批量接口同一个旋钮 LMS_BULK_CAP（默认 10000），题库这一条也用它（questions/bulk 的 200 是导入的口径）。
function bulkCap() {
  const capRaw = Math.floor(Number(process.env.LMS_BULK_CAP));
  return Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 10000;
}
function bulkIdList(res, raw) {
  const ids = Array.isArray(raw)
    ? [...new Set(raw.map((x) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : "")).filter(Boolean))]
    : [];
  if (!ids.length) { send(res, 400, { error: "Nothing selected.", error_zh: "未选择任何项。", code: "no_items" }); return null; }
  const cap = bulkCap();
  if (ids.length > cap) {
    send(res, 400, {
      error: `${ids.length} items selected, but one bulk action is capped at ${cap} — work in smaller batches.`,
      error_zh: `本次选中 ${ids.length} 项，单次上限 ${cap} 项，请分批操作。`,
      code: "over_cap", selected: ids.length, cap,
    });
    return null;
  }
  return ids;
}
// 整批范围预检：数「存在、但主体员工在操作者范围外」的条目。subjectOf(id) 返回 undefined = 这一项不存在
// （不计数，逐条报 not_found）；返回 null = 主体员工已删 —— 范围生效时算越界（fail closed，与单条的 404 同口径）。
// 超管与空范围角色 scopePredicate 为 null，直接 0。
function bulkOutOfScope(user, ids, subjectOf) {
  const pred = scopePredicate(user);
  if (!pred) return 0;
  let n = 0;
  for (const id of ids) { const s = subjectOf(id); if (s !== undefined && !pred(s)) n++; }
  return n;
}
const bulkUserSubject = (uid) => store.getUserById(uid) || undefined;
// 404 out_of_scope：与 sendScopeBulkReject 同一状态码与 code，中英分列（新端点的错误一律 error + error_zh + code）。
function sendBulkScopeReject(res, n) {
  return send(res, 404, {
    error: `${n} of the selected items are outside your data scope — nothing was changed.`,
    error_zh: `所选项中有 ${n} 项不在你的数据范围内，整批未执行，数据未改动。`,
    code: "out_of_scope", outOfScope: n,
  });
}
function sendBulkResult(res, results, extra) {
  const done = results.filter((r) => r.ok).length;
  const unchanged = results.filter((r) => r.ok && r.unchanged).length;
  return send(res, 200, { ok: true, total: results.length, done, skipped: results.length - done, unchanged, ...(extra || {}), results });
}
// 提交之后的副作用（审计、通知）：整批放进一个事务（几千条审计 / 通知不再逐条自动提交），每条各自 try/catch
// （afterCommit），一条失败只记日志、不连累其余条。业务数据此刻已经落库，这里任何失败都不改变应答。
function emitBulkEffects(what, effects, emit) {
  if (!effects.length) return;
  try {
    store.transaction(() => { for (const e of effects) afterCommit(`${what} ${e.id}`, () => emit(e)); });
  } catch (err) {
    console.error(`[after-commit] ${what}:`, (err && err.stack) || err);
  }
}
// 批量读申请时，主体 JSON 损坏的旧行按「不存在」处理（单条 decide 照旧抛 500，口径不变）。
function bulkEnrollRequest(id) {
  try { return store.getEnrollmentRequest(id); } catch { return null; }
}
function bulkNominationSubject(a) {
  try { const s = JSON.parse(a.subjectJson || "{}"); return s && typeof s === "object" ? s : null; } catch { return null; }
}

/* B7 考试成绩：重置作答次数的副作用（审计 + 通知），单条 reset-attempts 与批量 attempts/bulk-reset 共用（2026-10-07）。
   e = { exam, target, n }：审计照单条（n=0 也写 —— 批量在 n=0 时记未改动、不调用这里）；n>0 才通知员工可以重考。 */
function emitExamReset(audit, e) {
  audit("exam.reset-attempts", e.exam.id, null, { employeeId: e.target.employeeId, voided: e.n });
  if (e.n > 0) notify(e.target.id, {
    type: "exam.reset",
    title: `Your attempts for "${e.exam.title || e.exam.title_zh || ""}" were reset — you can retake it`,
    title_zh: `《${e.exam.title_zh || e.exam.title}》考试机会已重置，可以重新参加`,
    body: "Past attempts no longer count toward the limit.",
    body_zh: "历史尝试不再计入次数限制。",
    link: `#/exam-prep/${e.exam.programId}/${e.exam.id}`,
  });
}
/* B1a 选修课程申请：写库（指派 + 决定）与副作用（审计 + 通知）分开，单条 decide 与批量共用 */
function applyEnrollDecision(actor, r, decision, note) {
  const p = getProgram(r.programId);
  if (decision === "approve") {
    store.setAssignment(r.userId, r.programId, p ? defaultDueAt(p) : null);
  }
  const updated = store.decideEnrollmentRequest(r.id, decision === "approve" ? "approved" : "rejected", actor.id, note);
  return { id: r.id, decision, r, p, updated };
}
function emitEnrollDecision(audit, e) {
  const { decision, r, p, updated } = e;   // decision 必须是裸标识符（test/audit-labels.test.js 按 "enroll." + decision 展开）
  const tgt = store.getUserById(r.userId);
  audit("enroll." + decision, tgt ? tgt.employeeId : r.userId, null, { programId: r.programId, note: updated.decideNote || null });
  const ptitle = p ? p.title : r.programId, ptitleZh = p ? (p.title_zh || p.title) : r.programId;
  if (decision === "approve") {
    notify(r.userId, {
      type: "enroll.approved",
      title: `Your application for “${ptitle}” was approved`,
      title_zh: `你申请的《${ptitleZh}》已通过`,
      body: "It's now under Learning › My Courses. You can start anytime.",
      body_zh: "已加入「培训 › 我的课程」，随时可以开始。",
      link: `#/program/${r.programId}`,
    });
  } else {
    notify(r.userId, {
      type: "enroll.rejected",
      title: `Your application for “${ptitle}” was not approved`,
      title_zh: `你申请的《${ptitleZh}》未通过`,
      body: updated.decideNote ? ("Reason: " + updated.decideNote) : "",
      body_zh: updated.decideNote ? ("原因：" + updated.decideNote) : "",
      link: "#/",
    });
  }
}

/* B1b 培养项目申请（提名）：s = 已解析的 subjectJson。失败返回 { fail: { status, code, body, extra } }
   —— 单条接口按 status + body 原样应答，批量按 code + extra 逐条跳过。 */
function applyNominationDecision(actor, a, s, decision, note, { force = false, classId = null } = {}) {
  const doc = getTProject(s.projectId);
  const tgt = store.getUserById(a.targetUserId);
  if (decision === "approve") {
    if (!doc || !tgt) return { fail: { status: 400, code: "project_or_user_gone", body: { error: "Project or user no longer exists.", error_zh: "项目或员工已不存在。", code: "project_or_user_gone" } } };
    // CX-116：后台管理员账号不作为学员入班（与加学员接口同口径）；单条与批量审批同一处拦截
    if (tgt.role === "admin") return { fail: { status: 400, code: "admin_not_learner", body: { error: "Back-office admin accounts can't be enrolled as learners. Reject this application instead.", error_zh: "后台管理员账号不能作为学员入班，请驳回这条申请。", code: "admin_not_learner" } } };
    const cohort = tpCohort(doc, s.cohortId) || (doc.cohorts || [])[0];
    if (!cohort) return { fail: { status: 400, code: "no_cohort", body: { error: "The project has no cohort yet." } } };
    // Respect the cohort capacity here too, otherwise approvals quietly
    // overfill a class that the manual "add learners" path protects.
    // 批量时在事务里逐条重数：同一批里前面通过的人已经算进 seated。
    const seated = store.listProjectMembers(doc.id)
      .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === cohort.id).length;
    if (cohort.capacity && seated >= cohort.capacity && force !== true) {
      return { fail: { status: 409, code: "over_capacity", extra: { capacity: cohort.capacity, current: seated, cohort: cohort.name }, body: {
        error: `Cohort "${cohort.name}" is full (${seated}/${cohort.capacity}). Increase the capacity or move this person to another cohort.`,
        code: "over_capacity", capacity: cohort.capacity, current: seated,
      } } };
    }
    store.addProjectMember({ projectId: doc.id, cohortId: cohort.id, userId: tgt.id, role: "learner", classId: classId || null });
    tpAssignPrograms(tgt.id, cohort);
  }
  const updated = store.decideApproval(a.id, decision === "approve" ? "approved" : "rejected", actor.id, note);
  return { eff: { id: a.id, decision, a, s, doc, tgt, updated } };
}
function emitNominationDecision(audit, e) {
  const { decision, a, s, doc, tgt, updated } = e;   // decision 必须是裸标识符（同上）
  audit("tproject.nomination." + decision, doc ? doc.id : s.projectId, null, { employeeId: tgt ? tgt.employeeId : a.targetUserId });
  if (tgt && doc) {
    notify(tgt.id, decision === "approve" ? {
      type: "tproject.approved",
      title: `Your application for “${doc.title || doc.title_zh || ""}” was approved`,
      title_zh: `发展项目申请已通过：《${doc.title_zh || doc.title}》`,
      body: "See the schedule under Learning › Development Programs.", body_zh: "可在「培训 › 发展项目」中查看安排。",
      link: `#/projects/${doc.id}`,
    } : {
      type: "tproject.rejected",
      title: `Your application for “${doc.title || doc.title_zh || ""}” was not approved`,
      title_zh: `发展项目申请未通过：《${doc.title_zh || doc.title}》`,
      body: updated.decideNote ? "Reason: " + updated.decideNote : "", body_zh: updated.decideNote ? "原因：" + updated.decideNote : "",
      link: "#/projects",
    });
  }
}

/* B2 期次与成员：req = { cohortId, classId, groupId }（单条直接传请求体：未知期次按 COALESCE 保留原期次，
   班级 / 小组照旧覆盖；审计记请求里的原值）。 */
function applyMemberMove(doc, target, req) {
  const toCohort = req.cohortId ? tpCohort(doc, String(req.cohortId)) : null;
  store.moveProjectMember(doc.id, target.id, "learner", { cohortId: toCohort ? toCohort.id : null, classId: req.classId || null, groupId: req.groupId || null });
  if (toCohort) tpAssignPrograms(target.id, toCohort);
  return { id: target.id, kind: "move", doc, target, cohortId: req.cohortId || null, classId: req.classId || null };
}
function applyMemberWithdraw(doc, target) {
  store.withdrawProjectMember(doc.id, target.id, "learner");
  return { id: target.id, kind: "withdraw", doc, target };
}
function emitMemberOp(audit, e) {
  if (e.kind === "withdraw") {
    audit("tproject.members.withdraw", e.doc.id, null, { employeeId: e.target.employeeId });
    // CX-026（2026-10-09 验收）：退训给学员一条通知（学习与签到记录保留）
    notify(e.target.id, {
      type: "tproject.withdrawn",
      title: `You have been withdrawn from "${e.doc.title || e.doc.title_zh || ""}"`,
      title_zh: `你已从《${e.doc.title_zh || e.doc.title}》退训`,
      body: "Your learning and attendance records are kept. Contact HR if you have questions.",
      body_zh: "学习与签到记录保留；如有疑问请联系 HR。",
      link: "#/projects",
    });
  }
  else audit("tproject.members.move", e.doc.id, null, { employeeId: e.target.employeeId, cohortId: e.cohortId, classId: e.classId });
}

/* B3 签到 / 完成登记名单：tgt = tpRosterTarget(...)；actId = 地址里的活动 id（审计记它，不记 ckId —— 同单条）。
   by 缺省 = 操作人；批量把学员本人输码签到的「迟到」改为出席时传学员本人，保留本人签到的凭证。 */
function applyRosterMark(actor, doc, tgt, target, status, note, actId, by) {
  const completion = tgt.rollKind === "completion";
  if (completion) tpSetCompletion(tgt, target.id, status, by || actor.id, note);
  else store.setActivityState({ projectId: tgt.projectId, cohortId: tgt.cohortId, activityId: tgt.ckId, userId: target.id, status, by: by || actor.id, note });
  return { id: target.id, kind: "mark", completion, doc, target, status, actId };
}
function applyRosterClear(doc, tgt, target, prev, actId) {
  store.deleteActivityState(tgt.ckId, target.id);
  return { id: target.id, kind: "clear", completion: tgt.rollKind === "completion", doc, target, prev, actId };
}
function emitRosterOp(audit, e) {
  if (e.kind === "clear") {
    const before = { status: e.prev.status, by: e.prev.by || null };
    const who = { employeeId: e.target.employeeId, activityId: e.actId };
    if (e.completion) audit("tproject.activity.unmark", e.doc.id, before, who);
    else audit("tproject.checkin.unmark", e.doc.id, before, who);
  } else if (e.completion) audit("tproject.activity.mark", e.doc.id, null, { employeeId: e.target.employeeId, activityId: e.actId, status: e.status });
  else audit("tproject.checkin.mark", e.doc.id, null, { employeeId: e.target.employeeId, activityId: e.actId, status: e.status });
}

/* B4 题库改课程：随机抽题考试（已发布）的题量 —— 按关联课程数客观题与简答题。改课程前后各算一次，
   比出「因这次调整而低于抽题数」的考试（warnings，不拦）。只读计数，不解析题目 JSON。 */
// 第四批：按题型注册表的分组计数（objective / open / case；未开放或未知的题型不计）
function bulkExamPools() {
  const byCourse = new Map();
  for (const r of store.countQuestionsByCourseType()) {
    const c = byCourse.get(r.courseId) || { obj: 0, open: 0, case: 0 };
    const g = QT.isEnabled(r.type) ? QT.groupOf(r.type) : null;
    if (g === "open") c.open += r.n;
    else if (g === "objective") c.obj += r.n;
    else if (g === "case") c.case += r.n;
    byCourse.set(r.courseId, c);
  }
  const out = new Map();
  for (const e of store.listExams()) {
    if (e.mode === "fixed" || e.status !== "published") continue;
    let obj = 0, open = 0, kase = 0;
    for (const cid of store.getExamCourseIds(e.id)) { const c = byCourse.get(cid); if (c) { obj += c.obj; open += c.open; kase += c.case; } }
    out.set(e.id, { exam: e, obj, open, case: kase });
  }
  return out;
}
function bulkPoolWarnings(before) {
  const out = [];
  for (const [id, a] of bulkExamPools()) {
    const b = before.get(id);
    if (!b) continue;
    const e = a.exam;
    if (a.obj < (e.mcqCount || 0) && a.obj < b.obj)
      out.push({ examId: id, title: e.title, title_zh: e.title_zh || null, kind: "objective", pool: a.obj, need: e.mcqCount });
    if (a.open < (e.openCount || 0) && a.open < b.open)
      out.push({ examId: id, title: e.title, title_zh: e.title_zh || null, kind: "open", pool: a.open, need: e.openCount });
    if (a.case < (e.caseCount || 0) && a.case < (b.case || 0))
      out.push({ examId: id, title: e.title, title_zh: e.title_zh || null, kind: "case", pool: a.case, need: e.caseCount });
  }
  return out;
}
// Coerce an incoming grants object to the 9 known domains with only valid levels
// (anything else → none). roles is forced none here (super-admin only, never
// grantable — D6); accounts is now grantable and passes through. The role CRUD
// additionally rejects an explicit roles:manage with a clear error.
function sanitizeGrants(g) {
  const src = g && typeof g === "object" && !Array.isArray(g) ? g : {};
  const out = {};
  for (const d of RBAC_DOMAINS) {
    const v = src[d];
    out[d] = v === "manage" || v === "read" ? v : "none";
  }
  out.roles = "none";
  return out;
}
// Shell routes: any admin role gets the console frame + diagnostics (design: the
// dashboard/pending-counts/instance/integrity keep working for every role).
// M0: generated from manifest routes marked shell:true (sorted by order).
const RBAC_SHELL = REGISTRY.RBAC_SHELL;
// Paths that are READS regardless of HTTP method (design W3): the 4 no-method
// endpoints (3 CSV exports + attempts) and the talent-search POST (pure query,
// no store write, no audit). Everything else: write = (method !== GET).
// M0: generated from manifest routes marked readonly:true.
const RBAC_READONLY = REGISTRY.RBAC_READONLY;
// Path-pattern → domain (RBAC-ROUTE-MATRIX.md is now the explanatory snapshot).
// First match wins, so specific/bulk paths precede the generic :id patterns
// ([\w-]+ also matches "bulk"/"bulk-update"/"bulk-reset"). `methods` narrows an
// entry when a single path splits domain by verb (only /api/admin/employees).
// M0: generated from every /api/admin/ manifest route that carries a domain,
// sorted by its `order` (first match wins — specific paths keep lower orders than
// the :id patterns). A path split across domains by verb (/api/admin/employees)
// gets `methods` on each entry. Row-for-row equal to the pre-M0 hand-written
// table (test/fixtures/m0-legacy-tables.js; pinned by m0-registry-equivalence).
const RBAC_ROUTES = REGISTRY.RBAC_ROUTES;
// Returns null to allow, or { status, error } to deny. Callers gate this only
// for non-super-admins (super-admins bypass the whole thing).
function rbacGate(user, pathname, method) {
  if (RBAC_SHELL.some((re) => re.test(pathname))) return null;
  // roster is the data source for every "pick people" UI (design W1): any of
  // people/learning/performance/talent at >= read is enough.
  if (pathname === "/api/admin/roster" && method === "GET") {
    if (["people", "learning", "performance", "talent"].some((d) => canRead(user, d))) return null;
    return { status: 403, error: "You don't have access to this. 你没有此项操作的权限。" };
  }
  // W1b — same rationale as roster, for the two REFERENCE catalogs: job-grades
  // (rank/grade/level names) and config/records (record types + their field
  // option lists). They carry no person's data, and every page that shows a job
  // level or a performance rating needs them to LABEL what it is already allowed
  // to show: 员工档案 (people) reads job-grades, 人才盘点 (talent) reads
  // config/records. Without this, HRBP's own roster page and talent-admin's own
  // 9-box each fired a 404 on mount. GET only — every WRITE stays in the fields
  // domain through RBAC_ROUTES below.
  if ((pathname === "/api/admin/job-grades" || pathname === "/api/admin/config/records") && method === "GET") {
    if (["people", "learning", "performance", "talent", "fields"].some((d) => canRead(user, d))) return null;
    return { status: 404, error: "Not found" }; // 与 none 域一致，不暴露端点存在
  }
  const route = RBAC_ROUTES.find((r) => r.re.test(pathname) && (!r.methods || r.methods.includes(method)));
  if (!route) return { status: 403, error: "You don't have access to this. 你没有此项操作的权限。" }; // fail closed
  // D6: roles domain (build/edit/delete roles + assign adminRoleId) is the real
  // privilege-escalation face — super-admin only, never grantable. accounts is
  // no longer walled here: it flows through the level check below (a role holding
  // accounts=manage may create/reset/deactivate, subject to per-target scope
  // checked inside each accounts handler).
  if (route.domain === "roles") return { status: 403, error: "Super-admin only. 仅超级管理员可操作。" };
  const write = RBAC_READONLY.some((re) => re.test(pathname)) ? false : method !== "GET";
  const level = resolveGrants(user)[route.domain];
  if (level === "manage") return null;
  if (level === "read") return write ? { status: 403, error: "You don't have access to this. 你没有此项操作的权限。" } : null;
  return { status: 404, error: "Not found" }; // none → indistinguishable from an unknown route
}
// ---------- white-label branding ----------
// config.json {"brand": {…}} re-skins the product: names, taglines, logo,
// favicon and CSS-variable color overrides. EVERY field is optional and a
// missing one falls back to the GENERIC default below — the unconfigured
// product is brand-neutral ("Talent Platform") and nothing it serves may
// mention DigiPlus. DigiPlus is just one preset in config.json.example
// (contract flipped 2026-08: it used to be default=DigiPlus pixel-identical).
// The brand contract tests (test/brand.test.js) pin these character for
// character. logo:null = the front end renders a styled TEXT wordmark from
// `name` (no bundled image fallback); favicon:null = the neutral geometric
// mark inlined in web/index.html; colors:{} = stock app.css.
// Every *_zh has an en twin and vice versa — keep the pairs together.
const BRAND_DEFAULTS = {
  name: "Talent Platform", name_zh: "人才管理平台",
  tagline: "Making every employee's growth visible", tagline_zh: "让每位员工的成长清晰可见",
  heroLine: "Employee profiles, performance reviews, learning and talent review in one platform", heroLine_zh: "员工档案、绩效评估、培训与人才盘点，集中在一个平台",
  footer: "Authorized users only · Access is monitored", footer_zh: "仅供授权用户使用 · 访问受监控",
  welcome: "Welcome back", welcome_zh: "欢迎回来",
  subtitle: "Sign in to continue", subtitle_zh: "请登录以继续",
  pillA: "Profiles · Organization · Performance", pillA_zh: "员工档案 · 组织 · 绩效",
  pillB: "Learning · Exams · Talent Review", pillB_zh: "培训 · 考试 · 人才盘点",
  brandSub: "Talent Management", brandSub_zh: "人才管理",
  console: "Talent Console", console_zh: "人才管理后台",
  logo: null,
  logoLight: null, // 浅底场合（白色顶栏）的变体；缺省回落 logo
  favicon: null,
  colors: {},
};
// brand.colors is the one injection surface of the block: the front end
// writes these straight into a <style> tag as CSS custom-property overrides,
// so BOTH key and value are whitelisted HERE and the client may trust the
// served map blindly.
//   key   — a custom property:  ^--[a-z][a-z0-9-]*$   (--brand, --gold-ink…)
//   value — #hex, rgb()/rgba()/hsl()/hsla() over numeric-ish args, or a bare
//           color keyword. ';' '{' '}' 'url(' etc. cannot pass either regex,
//           so a value can never close the declaration, open a rule, or make
//           the browser fetch anything.
// Pure function (no config/store/env access) so it is unit-testable as-is.
function sanitizeBrandColors(colors) {
  const out = {};
  if (!colors || typeof colors !== "object" || Array.isArray(colors)) return out;
  const KEY = /^--[a-z][a-z0-9-]*$/;
  const VALUE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/-]*\)|[a-zA-Z]+)$/;
  for (const k of Object.keys(colors)) {
    const v = colors[k];
    if (typeof v !== "string") continue;
    const key = k.trim(), val = v.trim();
    if (key.length <= 64 && val.length <= 64 && KEY.test(key) && VALUE.test(val)) out[key] = val;
  }
  return out;
}
// brand.legal — OPTIONAL login-page legal links, shown ONLY when configured:
//   { "privacyUrl": "https://…" | "/legal/privacy.html",
//     "termsUrl":   "https://…" | "/legal/terms.html" }
// Unlike every other brand key there is NO default: an unconfigured (or fully
// invalid) block means the resolved brand carries no `legal` key at all, and
// the login page renders exactly as before. Each URL must be an absolute
// http(s) URL or a site-relative path ("/x", never protocol-relative "//x");
// javascript:/data:/mailto:, backslashes, whitespace, quotes and angle
// brackets are refused, so a configured value can only ever be a plain link.
// An invalid URL is DROPPED (not truncated or repaired); the other one stands.
// Pure functions (no config/store/env access) so they are unit-testable as-is.
const BRAND_LEGAL_KEYS = ["privacyUrl", "termsUrl"];
const BRAND_LEGAL_URL_MAX = 512;
function safeLegalUrl(v) {
  if (typeof v !== "string") return "";
  const u = v.trim();
  if (!u || u.length > BRAND_LEGAL_URL_MAX) return "";
  if (/[\s\\<>"'`\u0000-\u001f\u007f]/.test(u)) return "";
  if (/^https?:\/\//i.test(u)) {
    if (/^https?:\/\/\//i.test(u)) return ""; // "http:///x" — no authority
    try {
      const p = new URL(u);
      return (p.protocol === "http:" || p.protocol === "https:") && p.hostname ? u : "";
    } catch { return ""; }
  }
  return u[0] === "/" && u[1] !== "/" ? u : "";
}
function sanitizeBrandLegal(legal) {
  if (!legal || typeof legal !== "object" || Array.isArray(legal)) return null;
  const out = {};
  for (const k of BRAND_LEGAL_KEYS) { const u = safeLegalUrl(legal[k]); if (u) out[k] = u; }
  return Object.keys(out).length ? out : null;
}
// The resolved brand served on /api/env AND /api/me (both must always agree —
// the pre-auth login page and the post-auth app shell read the same object).
// A configured field must be a non-empty string to win; "" or a wrong type
// keeps the default, so a partial config can never blank part of the UI.
// Text fields are trimmed and clamped so a paste-gone-wrong cannot blow the
// login page apart. logo/favicon are URL *paths* to static assets (put the
// file under public/, configure "/assets/brand/x.svg"): the ceiling is wider
// (256) but a data: URI is refused — assets ship as real files, not inline
// payloads — and an over-long or refused value falls back to the default
// rather than being truncated into a broken URL.
const BRAND_TEXT_MAX = 128;
const BRAND_ASSET_MAX = 256;
const BRAND_ASSET_KEYS = new Set(["logo", "logoLight", "favicon"]);
function brandCfg() {
  const raw = readConfig().brand;
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of Object.keys(BRAND_DEFAULTS)) {
    if (k === "colors") continue;
    const v = typeof src[k] === "string" ? src[k].trim() : "";
    if (BRAND_ASSET_KEYS.has(k)) out[k] = v && v.length <= BRAND_ASSET_MAX && !/^data:/i.test(v) ? v : BRAND_DEFAULTS[k];
    else out[k] = v ? v.slice(0, BRAND_TEXT_MAX) : BRAND_DEFAULTS[k];
  }
  out.colors = sanitizeBrandColors(src.colors);
  // Only present when configured AND valid — see sanitizeBrandLegal above.
  const legal = sanitizeBrandLegal(src.legal);
  if (legal) out.legal = legal;
  return out;
}
// What PUT /api/admin/brand-config WRITES: the same rules brandCfg() applies on
// read, but as a filter — an empty or invalid field is DROPPED from the stored
// block (so it falls back to the default) instead of being stored broken.
// Unknown keys never survive: only BRAND_DEFAULTS keys can reach the file.
function sanitizeBrandInput(src) {
  const out = {};
  if (!src || typeof src !== "object" || Array.isArray(src)) return out;
  for (const k of Object.keys(BRAND_DEFAULTS)) {
    if (k === "colors") continue;
    const v = typeof src[k] === "string" ? src[k].trim() : "";
    if (!v) continue;
    if (BRAND_ASSET_KEYS.has(k)) { if (v.length <= BRAND_ASSET_MAX && !/^data:/i.test(v)) out[k] = v; }
    else out[k] = v.slice(0, BRAND_TEXT_MAX);
  }
  const colors = sanitizeBrandColors(src.colors);
  if (Object.keys(colors).length) out.colors = colors;
  const legal = sanitizeBrandLegal(src.legal);
  if (legal) out.legal = legal;
  return out;
}
// Replace ONLY the brand key of the live config file and write the whole file
// back — modules/lark/email/AI keys must come through untouched. Atomic: write
// a temp file first, then rename over the original, so a crash mid-write can
// never leave half a JSON behind. Missing file = created with just the brand
// key. An existing-but-unparsable file THROWS instead of being clobbered: it
// may hold recoverable Lark/AI secrets a rewrite would destroy.
function writeBrandConfig(brand) {
  const file = configPath();
  let cfg = {};
  let raw = null;
  try { raw = fs.readFileSync(file, "utf8"); } catch { raw = null; }
  if (raw !== null) cfg = JSON.parse(raw);
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
  cfg.brand = brand;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + crypto.randomBytes(6).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
// ---------- brand asset uploads (logo / logoLight / favicon) ----------
// The returned URL (/assets/brand/uploads/<name>) is directly configurable as brand.logo etc.
// Old files are kept on re-upload (the admin may switch back).
// CX-071（10/11 上线前测试）：文件写在数据目录（附件目录下的 _brand，或环境变量 LMS_BRAND_UPLOAD_DIR），
// 不再写进代码目录 public/ —— IT 整包覆盖代码升级时客户上传的 logo 不会丢，几个实例也不会写到同一处。
// 对外地址不变：serveStatic 把 /assets/brand/uploads/* 先映射到数据目录，找不到再读 public/ 下的旧位置（兼容旧文件）。
const BRAND_UPLOAD_MAX = 512 * 1024;
const BRAND_UPLOAD_PUBLIC = path.join(ROOT, "public", "assets", "brand", "uploads");
// CX-166（3+3 勋章图）：每个模块一个数据目录，作为 services.dataDir 交给模块（契约 v39）。设了 LMS_MODULE_DATA_DIR 时为
// <它>/<模块 id>，否则为 <附件目录>/_modules/<模块 id>；目录由模块按需创建。随数据一起备份，整包覆盖升级不丢。
// serveModuleStatic 先查 <dataDir>/public/<相对路径>，没有再读 modules/<id>/public/ 下的原文件（见下）。
function moduleDataDir(id) {
  const base = process.env.LMS_MODULE_DATA_DIR ? path.resolve(process.env.LMS_MODULE_DATA_DIR) : path.join(ATTACH_DIR, "_modules");
  return path.join(base, String(id));
}
function brandUploadDir() {
  return process.env.LMS_BRAND_UPLOAD_DIR ? path.resolve(process.env.LMS_BRAND_UPLOAD_DIR) : path.join(ATTACH_DIR, "_brand");
}
// Lower-cased prefix for the URL-side test in serveStatic — Windows paths are
// case-insensitive, so the comparison must be too.
const BRAND_UPLOAD_PREFIX = (BRAND_UPLOAD_PUBLIC + path.sep).toLowerCase();
const BRAND_SLOTS = new Set(["logo", "logoLight", "favicon"]);
// Type by CONTENT, never by the client's filename or content-type header:
// png/jpg by magic bytes, svg by the document starting with <svg or <?xml.
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  const head = buf.slice(0, 256).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml|<svg)/i.test(head)) return "svg";
  return null;
}
// SVG is an active format — opened directly (not via <img>) it can run script.
// Defang on the way in: strip <script>/<foreignObject> blocks, on* event
// handler attributes and javascript: hrefs. Belt-and-braces with the scriptless
// CSP serveStatic puts on this directory.
function sanitizeSvg(text) {
  let s = String(text);
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<\/?script\b[^>]*>/gi, "");
  s = s.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "").replace(/<\/?foreignObject\b[^>]*>/gi, "");
  s = s.replace(/\son[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/((?:xlink:)?href\s*=\s*)(["'])\s*javascript:[\s\S]*?\2/gi, '$1$2#$2');
  s = s.replace(/((?:xlink:)?href\s*=\s*)javascript:[^\s>]*/gi, '$1"#"');
  return s;
}
// ---------- Lark (Feishu) SSO helpers ----------
const larkStates = new Map(); // anti-CSRF state -> { exp（过期时刻）, next（登录后回跳的站内路径，已按白名单核过；可为 null） }
function larkCfg() {
  const c = readConfig().lark;
  return c && c.appId && c.appSecret ? c : null;
}
function larkHost(cfg) {
  return cfg.base === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
}
// The callback URL Lark sends the browser back to. Explicit config wins; otherwise
// it is derived from the request that is being answered right now.
// NOT a hard-coded domain: this used to fall back to another project's host, so an
// install that set appId/appSecret but forgot redirectUri would have handed its
// authorization codes to a third party. Deriving it also means the value can never
// drift from the one IT registers in the Lark console — that IS the URL the browser
// arrived on.
function larkRedirect(cfg, req) {
  if (cfg.redirectUri) return cfg.redirectUri;
  const pub = readConfig().publicUrl;
  if (pub) return String(pub).replace(/\/+$/, "") + "/api/auth/lark/callback";
  const fwdProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = fwdProto || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}/api/auth/lark/callback`;
}
// Origin (scheme + host, no trailing slash) to put in front of a link we mail
// out. Same rules and the same reasoning as larkRedirect above: configured
// publicUrl wins, otherwise it is derived from the request being answered — a
// hard-coded domain would silently mail every deployment's users to somebody
// else's host. Behind a proxy this needs X-Forwarded-Proto / X-Forwarded-Host.
function publicOrigin(req) {
  const pub = readConfig().publicUrl;
  if (pub) return String(pub).replace(/\/+$/, "");
  const fwdProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = fwdProto || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}
// The front end owns #/reset-password (hash routing, same shape as the
// #/login?sso=… redirect the Lark callback uses).
function resetLink(req, token) {
  return publicOrigin(req) + "/#/reset-password?token=" + encodeURIComponent(token);
}
// ONE mail carrying both languages. The server cannot know which language the
// reader uses — there is no per-user locale and a forgot-password request has no
// session — so it never guesses, exactly like notify()'s bilingual titles. The
// mail contains the link and its lifetime, and NEVER a password (not the old
// one, not a generated one): reading the mailbox must not hand over the account.
function resetEmailHtml(link, minutes) {
  const href = escHtml(link);
  return [
    `<p>你申请了重置 ${escHtml(brandCfg().name_zh || brandCfg().name)} 的登录密码。点击下面的链接设置新密码 —— 链接 ${minutes} 分钟内有效，且只能使用一次：</p>`,
    `<p><a href="${href}">${href}</a></p>`,
    `<p>如果这不是你本人的操作，忽略这封邮件即可，你的密码不会有任何变化。</p>`,
    `<hr>`,
    `<p>You asked to reset your ${escHtml(brandCfg().name)} sign-in password. Use the link below to choose a new one — it is valid for ${minutes} minutes and can be used only once:</p>`,
    `<p><a href="${href}">${href}</a></p>`,
    `<p>If this wasn't you, simply ignore this mail — your password stays unchanged.</p>`,
  ].join("");
}
// Everything the "known account" branch of /api/auth/forgot does. Called from a
// setImmediate AFTER the response is on the wire, which is what makes the two
// branches indistinguishable in TIMING as well as in body: none of the work
// below (user lookup, token insert, mail) can widen or narrow the response.
// Silent by design — it returns without a trace for an unknown id, an id with no
// email, a deactivated account, or an install with no mailer configured.
function issuePasswordReset(req, submittedId, auditAuth) {
  const nowIso = new Date().toISOString();
  store.prunePasswordResets(nowIso);
  // No mailer = no link could ever arrive, so don't mint a token at all
  // (/api/env advertises the same condition as passwordResetEnabled).
  if (!emailConfigured()) return;
  if (!EMPLOYEE_ID_RE.test(String(submittedId))) return;
  const u = store.getUserByEmployeeId(submittedId);
  // A deactivated (offboarded) account gets no usable token and no mail — an
  // ex-employee who still reads that mailbox must not be able to walk back in.
  if (!u || u.active === 0 || !u.email) return;
  store.deleteUnusedPasswordResets(u.id); // only the newest link works
  const token = crypto.randomBytes(32).toString("base64url");
  store.createPasswordReset({
    id: "pr-" + crypto.randomBytes(8).toString("hex"),
    userId: u.id,
    tokenHash: sha256Hex(token), // 明文令牌只出现在这封邮件里，库里永远只有哈希
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
    createdAt: nowIso,
    requestedFor: u.employeeId,
  });
  const minutes = Math.max(1, Math.round(RESET_TOKEN_TTL_MS / 60000));
  // Audited only when a mail actually goes out, so the log answers "did we send
  // this person a link" instead of "did somebody type this box". That does mean
  // the presence of a row confirms the account exists — acceptable, and NOT the
  // enumeration surface the requirement is about: audit_logs is readable by
  // super-admins/auditors only, who can already list every employee. The token
  // itself is never in the row (see the addAudit call: reason codes only).
  auditAuth("auth.password_reset_requested", u, u.employeeId, { method: "email", ttlMinutes: minutes });
  sendEmail(u.email, "重置密码 / Reset your password", resetEmailHtml(resetLink(req, token), minutes)).catch(() => {});
}
// code → app_access_token → user access token → user info (zero-dependency).
async function larkExchange(cfg, code) {
  const host = larkHost(cfg);
  const appTokRes = await fetch(host + "/open-apis/auth/v3/app_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  const appTok = await appTokRes.json();
  if (!appTok || !appTok.app_access_token) throw new Error("lark app token: " + JSON.stringify(appTok).slice(0, 200));
  const oidcRes = await fetch(host + "/open-apis/authen/v1/oidc/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + appTok.app_access_token },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const oidc = await oidcRes.json();
  const userTok = oidc && oidc.data && oidc.data.access_token;
  if (!userTok) throw new Error("lark user token: " + JSON.stringify(oidc).slice(0, 200));
  const infoRes = await fetch(host + "/open-apis/authen/v1/user_info", {
    headers: { authorization: "Bearer " + userTok },
  });
  const info = await infoRes.json();
  if (!info || info.code !== 0 || !info.data) throw new Error("lark user info: " + JSON.stringify(info).slice(0, 200));
  return info.data; // { name, en_name, email, enterprise_email, user_id, open_id, union_id, … }
}
// ---------- Masterlist Base → 组织架构与员工每日同步（modules/core/larksync.js，2026-09-30）----------
// config.json 的 lark.sync 存在（且 enabled 不为 false）时开启：每天 lark.sync.hour 点（服务器本地时间）自动跑一次，
// 超级管理员也可 POST /api/admin/lark-sync 手动触发或预览。同一时刻只跑一个。开启后 Lark 登录只认同步登记过的账号。
const larksync = require("./modules/core/larksync.js");
let larkSyncRunning = null;
function larkSyncCfg() { const c = larkCfg(); return c ? larksync.syncCfg(c) : null; }
async function runLarkSync({ dryRun = false, force = false, actor = null, trigger = "manual" } = {}) {
  const lark = larkCfg();
  const cfg = lark && larksync.syncCfg(lark);
  if (!cfg) throw Object.assign(new Error("Lark sync isn't configured (config.json lark.sync)."), { code: "not_configured" });
  if (larkSyncRunning) throw Object.assign(new Error("A sync is already running."), { code: "running" });
  larkSyncRunning = (async () => {
    const src = await larksync.fetchSource(lark, cfg, larkHost(lark));
    const plan = larksync.buildPlan(src, cfg);
    const rep = larksync.applyPlan(plan, { store, hashPassword, newToken }, { dryRun, force, cfg, trigger });
    if (!dryRun) {
      store.addAudit({ actorId: actor ? actor.id : null, actorName: actor ? actor.name : null, action: "org.lark-sync", target: trigger, before: null, after: larksync.summary(rep), requestId: null });
      if (rep.warnings.length) notifyAdmins({
        type: "lark.sync", title: `Org sync from Lark finished with ${rep.warnings.length} warning(s)`, title_zh: `Lark 组织同步完成，有 ${rep.warnings.length} 条提示`,
        body: rep.warnings.slice(0, 3).join(" / "), body_zh: rep.warnings.slice(0, 3).join(" / "), link: "#/admin/departments",
      }, "people", { write: true });   // 同步提示要人去部门页处理：只发给 people 有管理权限的人（第二批 2.3）
    }
    return rep;
  })();
  try { return await larkSyncRunning; } finally { larkSyncRunning = null; }
}
// 每 10 分钟看一次：到了设定的钟点、今天还没跑过就跑（meta larksync.day 记日期）。
// 第一次必须由超级管理员手动执行（先预览、再执行）：从来没有正式执行过（没有非预览的上次报告）时，定时器不跑。
function larkSyncTick() {
  const cfg = larkSyncCfg();
  if (!cfg || larkSyncRunning) return;
  const last = larksync.lastReport(store);
  if (!last || last.dryRun) return;
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (now.getHours() < cfg.hour || store.getMeta("larksync.day") === day) return;
  store.setMeta("larksync.day", day);
  runLarkSync({ trigger: "daily" })
    .then((rep) => console.log("[lark-sync]", JSON.stringify(larksync.summary(rep))))
    .catch((e) => {
      console.error("[lark-sync] failed:", (e && e.message) || e);
      store.setMeta("larksync.lastError", JSON.stringify({ at: new Date().toISOString(), error: String((e && e.message) || e).slice(0, 500) }));
    });
}
function loginLockRemaining(key) {
  const r = loginFails.get(key);
  return r && r.lockedUntil > Date.now() ? r.lockedUntil - Date.now() : 0;
}
function recordLoginFail(key) {
  const now = Date.now();
  let r = loginFails.get(key);
  if (!r || now - r.firstAt > LOGIN_LOCK_MS) r = { count: 0, firstAt: now, lockedUntil: 0 };
  r.count++;
  if (r.count >= LOGIN_MAX_FAILS) r.lockedUntil = now + LOGIN_LOCK_MS;
  loginFails.set(key, r);
}
function pruneLoginFails() {
  const now = Date.now();
  for (const [k, r] of loginFails) if (r.lockedUntil < now && now - r.firstAt > LOGIN_LOCK_MS) loginFails.delete(k);
}
// True the FIRST time a given lock period refuses a request, false afterwards.
// The access log records the lockout, but it must not record it once per
// request: a locked-out attacker keeps posting, and before this the refusal
// path — the one branch that is supposed to be free, since it returns before
// scrypt and before any DB work — appended an audit row every single time.
// That turns the log into the attack surface: audit_logs is append-only and
// never pruned, and the reader's window is the newest 2000 rows, so a few
// minutes of hammering evicts every back-office row from view exactly during
// the incident the log exists to explain. One row per lock period loses
// nothing: the LOGIN_MAX_FAILS bad_password rows already quantify the run, and
// this row marks the moment throttling engaged. A NEW lockout (fresh
// lockedUntil, i.e. the attacker came back after the window) logs again.
function claimLockoutLog(key) {
  const r = loginFails.get(key);
  if (!r || r.lockLoggedFor === r.lockedUntil) return false;
  r.lockLoggedFor = r.lockedUntil;
  return true;
}
// Employee-ID shape, enforced on BOTH sides (the UI had this regex, the API
// didn't —畸形工号 could be written straight through the import/API).
const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,19}$/;
const EMPLOYEE_ID_HINT = "Employee ID must be 3–20 characters: letters, digits or hyphens, starting with a letter or digit.";
// What a FAILED sign-in is allowed to write into the audit log's `target`.
// A real employee ID is recorded verbatim — that is the whole point of the
// access log (spotting "someone tried T-00007 fourteen times"). Anything that
// is NOT ID-shaped is replaced by a fixed placeholder rather than stored,
// because the single most likely source of junk in that box is a person who
// typed their PASSWORD into the employee-ID field; logging it verbatim would
// turn the audit page into a credential leak. The lockout counter still keys
// off the raw value, so throttling is unaffected.
function safeLoginTarget(employeeId) {
  const s = String(employeeId == null ? "" : employeeId);
  if (!s) return "(blank)";
  return EMPLOYEE_ID_RE.test(s) ? s : "(malformed)";
}
function findUserByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  return store.listUsers().find((u) => (u.email || "").trim().toLowerCase() === e) || null;
}
// Returns a human-readable loop path if setting `newManagerId` as the manager of
// `userId` would create a cycle; null when it's safe.
function managerCycle(userId, newManagerId) {
  const seen = new Set([userId]);
  const path = [];
  let cur = newManagerId;
  while (cur) {
    const u = store.getUserById(cur);
    if (!u) return null;
    path.push(u.name || u.employeeId);
    if (seen.has(u.id)) return path.join(" → ");
    seen.add(u.id);
    cur = u.managerId || null;
  }
  return null;
}
function getCourse(id) {
  return COURSES.find((c) => c.id === id) || null;
}
function getProgram(id) {
  return PROGRAMS.find((p) => p.id === id) || null;
}
// 课程的 1:1 包装程序（指派、选修、考试、记录都挂在程序上；界面上只看得到课程）。只有恰好只含这一门课的程序才算
// 它的包装程序，旧版多课程课程包从不被改写。单条 PUT 与课程库批量操作（2026-10-07 B5）共用。
function courseWrapperOf(courseId) {
  return PROGRAMS.find((p) => p.id === "pw-" + courseId) ||
    PROGRAMS.find((p) => (p.courseIds || []).length === 1 && p.courseIds[0] === courseId) || null;
}
// 包装程序镜像的课程展示字段。旧课程文档可能缺 enrollType / defaultDueDays / status，给与单条 PUT 规范化相同的默认值
const courseDisplayFields = (c) => ({
  title: c.title, title_zh: c.title_zh || null,
  description: c.description || null, description_zh: c.description_zh || null,
  category: c.category || null, enrollType: c.enrollType || "mandatory", status: c.status || "draft",
  defaultDueDays: c.defaultDueDays || 30,
  public: c.public === true,   // 第四批 7：公开课程（包装程序镜像；旧版多课程课程包从不公开）
});
// 把课程的展示字段写到包装程序上。fields 省略 = 全部展示字段（单条 PUT）；批量只传被改的那一个字段。
// 没有包装程序时按单条的默认值新建（带全部展示字段）。先复制再写，不改缓存里的 PROGRAMS 对象 ——
// 批量在事务里调它，回滚时缓存不能留下未提交的值；调用方随后 refreshContent()。
function mirrorCourseWrapper(c, fields) {
  const cur = courseWrapperOf(c.id);
  const w = cur
    ? { ...cur, ...(fields || courseDisplayFields(c)) }
    : {
      id: "pw-" + c.id, courseIds: [c.id],
      passingScore: 80, examMcqCount: 8, examOpenCount: 1,
      examTimeLimitMinutes: null, maxAttempts: 0, retakeCooldownHours: 0,
      showAnswersAfterExam: true,
      ...courseDisplayFields(c),
    };
  store.putContent("program", w.id, w);
  return w;
}
// ---------- 第四批 7 / 9.2 公开课程与自主学习（2026-10-08；规则在 modules/learning/public-courses.js）----------
// 程序是否在「课程目录」里（对本人）：1:1 包装程序 + 课程公开 + 已发布；线下按开课日；本人已有这门课时始终列出。
function catalogListed(p, asg) {
  const cid = programCourseId(p);
  if (!cid) return false;
  return PUBC.catalogEligible(p, getCourse(cid), { today: todayLocal(), hasCourse: !!asg });
}
// 课程（程序）对这个人是否「已开始」：进度 > 0 或有任何答卷（9.2 关闭时据此决定移出还是保留）
function publicCourseStarted(userId, p) {
  return programProgress(userId, p).percent > 0 || store.listUserAttempts(userId, p.id).length > 0;
}
// 这门课全部自主学习行的状态：[{ userId, started, done }]
function selfRowsOf(p) {
  return store.listSelfEnrollments(p.id).map((r) => ({ userId: r.userId, started: publicCourseStarted(r.userId, p), done: programDone(r.userId, p) }));
}
// 设为公开（false → true）：待审批的选修申请一律按「通过」关闭（备注说明），申请人改为自主学习。返回要通知的人（提交后再发）。
const PUBLIC_OPEN_NOTE = "课程已设为公开，无需审批 / Course is now public; no approval needed";
function publicOpenApply(actor, w) {
  const pending = store.listPendingRequests().filter((r) => r.programId === w.id);
  for (const r of pending) {
    store.decideEnrollmentRequest(r.id, "approved", actor.id, PUBLIC_OPEN_NOTE);
    store.selfEnroll(r.userId, w.id);
  }
  return { pendingClosed: pending.length, notifyUserIds: pending.map((r) => r.userId) };
}
function publicOpenNotify(c, userIds) {
  for (const uid of userIds || []) {
    notify(uid, {
      type: "course.public",
      title: `"${c.title || c.title_zh || ""}" is now open; you can start right away`,
      title_zh: `《${c.title_zh || c.title}》已开放，可直接开始学习`,
      body: "Your application is no longer needed. The course is in Learning › My Courses.",
      body_zh: "无需再审批，课程已在「培训 › 我的课程」里。",
      link: `#/course/${c.id}`,
    });
  }
}
// 取消公开（true → false）：按 PUBLIC_CLOSE_POLICY 处理自主学习的人（A：未开始的移出，已开始的保留到学完，已完成的记录与学时保留）
function publicCloseApply(w) {
  const plan = PUBC.planPublicClose(selfRowsOf(w), PUBC.PUBLIC_CLOSE_POLICY);
  for (const uid of plan.remove) store.removeSelfEnrollment(uid, w.id);
  return { removed: plan.remove.length, kept: plan.keep.length, policy: PUBC.PUBLIC_CLOSE_POLICY };
}
// 方案 B / C 才有的访问限制（A 恒为 false）：自主学习、课程已不公开、未完成
function selfAccessBlockedFor(userId, p, asg) {
  if (PUBC.PUBLIC_CLOSE_POLICY === "A" || !asg || asg.source !== "self") return false;
  const cid = programCourseId(p);
  return PUBC.selfAccessBlocked({ asg, course: cid ? getCourse(cid) : null, done: programDone(userId, p), policy: PUBC.PUBLIC_CLOSE_POLICY, nowMs: nowMs() });
}
// 课程目录条目（不含任何人员数据）。my.status 按本人真实的指派行（不按 learning 读者的预览权限）。
function catalogItemOf(userId, p, c, asg) {
  const mods = c.modules || [];
  const status = PUBC.myStatusOf(asg);
  return {
    programId: p.id, courseId: c.id, title: c.title, title_zh: c.title_zh || null,
    summary: PUBC.clipSummary(c.description), summary_zh: PUBC.clipSummary(c.description_zh),
    category: c.category || null, mode: (c.mode || "online") === "offline" ? "offline" : "online",
    hours: courseHours(c), minutes: mods.reduce((s, m) => s + (Number(m.minutes) || 0), 0), moduleCount: mods.length,
    hasExam: publishedProgramExams(p.id).length > 0,
    sessionAt: c.sessionAt || null, location: c.location || null, enrollType: c.enrollType || p.enrollType || "mandatory",
    my: {
      status,
      ...(() => { const ls = asg ? learnerExamState(userId, p) : null; return { learnStatus: ls ? ls.learnStatus : null, retakeExamId: ls ? ls.retakeExamId || null : null }; })(),
      progress: programProgress(userId, p).percent,
      done: programDone(userId, p),
    },
  };
}
// 完成口径相关的函数体都在 modules/learning/completion.js（与定时提醒脚本共用），这里只做委托。
function coursesInProgram(program) { return COMPLETION.coursesInProgram(program); }
function userProgress(userId, courseId) { return COMPLETION.userProgress(userId, courseId); }
// Offline-course attendance lives in activity_state under a reserved namespace
// (projectId "__course__", activityId "course:<id>") — see completion.js.
function courseCkId(courseId) { return LC.courseCkId(courseId); }
// 培养项目里哪些活动有签到、签到记在哪（负责人 2026-10-06「线下活动和线下课程一样，都需要签到码」）：
// 线下活动 → 记在项目自己的活动行（activityId = 活动 id）；
// 引用线下课程的课程活动 → 记在该课程的出勤行（activityId = course:<id>，projectId "__course__"），
// 与课程页的签到码、课程完成（progressPercent）是同一份数据，学员在哪边签到都算。
// 其余活动没有签到，返回 null。sessionAt 用于判迟到（活动自己的时间优先，其次课程的场次时间）。
function tpCheckinTarget(a, doc, cohort) {
  if (!a) return null;
  if (a.type === "offline") return { ckId: a.id, projectId: doc.id, cohortId: cohort.id, sessionAt: a.startAt || null };
  if (a.type === "course") {
    const c = getCourse(a.refId);
    if (c && (c.mode || "online") === "offline") return { ckId: courseCkId(c.id), projectId: "__course__", cohortId: c.id, sessionAt: a.startAt || c.sessionAt || null };
  }
  return null;
}
// 培养项目「进行中」才开放签到（负责人 2026-10-06）：只有这时才出签到码、才接受学员输码；
// 名单查看与工作人员补签 / 请假不受限（事后更正要用）。独立的线下课程（不经培养项目）不受此限。
// CX-025（2026-10-09 上线验收，C-1）：还要看期次 —— 期次有结束日且今天（本地日）已过结束日的，不出码、学员输码 409 cohort_ended；
// 名单查看与工作人员补签 / 请假照旧不受限。cohort 不传（旧调用）只看项目状态。
function tpCohortEnded(cohort) { const end = cohort && cohort.endAt ? String(cohort.endAt).slice(0, 10) : ""; return !!end && todayLocal() > end; }
function tpCheckinOpen(doc, cohort) { return !!doc && doc.status === "running" && !tpCohortEnded(cohort); }
// 学员自己完成线上活动（打开链接 / 自行确认）：项目「进行中」或「收尾中」都接受（负责人 2026-10-06：
// 收尾期让晚到的人补完问卷、看完回放）。签到仍只在进行中开放；讲师 / HR 登记不受项目状态限制，与补签一致。
function tpCompletionOpen(doc) { return !!doc && (doc.status === "running" || doc.status === "closing"); }
// 线上活动（stored type 'online'，负责人 2026-10-06 定的五类活动之一）：完成记在 activity_state 的本活动行，
// status 为 completed（学员打开链接 / 自行确认，或讲师、HR 登记）算完成；excused（请假）不算完成（负责人 2026-10-06），
// 学员之后仍可自己完成并覆盖请假。线下活动、线下课程同一口径：请假不算完成、需补课（负责人 2026-10-06，见 ATTENDED_STATES）。
const TP_ONLINE_DONE = ["completed"];
// 完成方式：click = 打开链接即完成；self = 学员自行确认；trainer = 讲师或 HR 登记。创建后不可更改。
const TP_COMPLETION_MODES = ["click", "self", "trainer"];
// PUT 只允许新建这四种存储类型（线上 / 线下课程都是 course，按课程 mode 区分）；旧的 program（学习包）
// 活动只读保留：随文档原样回传可以（同 id 同类型），新建不行。
const TP_CREATABLE_TYPES = ["course", "exam", "offline", "online"];
const TP_URL_RE = /^https?:\/\/[^\s<>"']+$/i;
// 名单目标：有签到的活动（tpCheckinTarget）→ rollKind 'checkin'；线上活动 → rollKind 'completion'
// （有完成名单，没有签到码）；其余（考试、线上课程、学习包）→ null。
// tpCheckinTarget 刻意不认 online：线上活动因此不出签到码、学员不能输码签到、不计入看板出勤率、
// 班主任点名（/api/me/classes/*）也看不到它。
function tpRosterTarget(a, doc, cohort) {
  const ck = tpCheckinTarget(a, doc, cohort);
  if (ck) return { ...ck, rollKind: "checkin" };
  if (a && a.type === "online") return { ckId: a.id, projectId: doc.id, cohortId: cohort.id, sessionAt: a.startAt || null, rollKind: "completion" };
  return null;
}
// 线上活动完成行的写入（学员端 /complete、HR 完成登记、讲师登记共用）。activity_state 主键只有
// (activityId, userId)，upsert 不改 projectId；活动 id 全库唯一（界面新建用随机 id，PUT 拒绝新活动复用已占用的 id：id_in_use）。万一撞上
// 别的项目写下的同 id 行，先删掉再按本项目重写，免得这一行记在别的项目名下（删除保护、按项目统计都会算错）。
function tpSetCompletion(tgt, userId, status, by, note) {
  const prev = store.getActivityState(tgt.ckId, userId);
  if (prev && prev.projectId !== tgt.projectId) store.deleteActivityState(tgt.ckId, userId);
  store.setActivityState({ projectId: tgt.projectId, cohortId: tgt.cohortId, activityId: tgt.ckId, userId, status, by, note: note || null });
}
function courseAttendance(userId, courseId) { return COMPLETION.courseAttendance(userId, courseId); }
// 出勤类（线下活动、线下课程）的「完成」只认出席 / 迟到。请假（excused）与缺勤一样不算完成、需补课
// （负责人 2026-10-06）：不计进度、不满足按完成解锁的下一阶段、线下课程不算学完、不解锁挂在课程上的考试。
// 出勤率另算（看板 attendance：请假不进分母），与这里的「完成」口径分开。定义在 modules/learning/completion.js。
const ATTENDED_STATES = LC.ATTENDED_STATES;
// For an in-person course, attendance IS completion (completion.js).
function progressPercent(userId, course) { return COMPLETION.progressPercent(userId, course); }
// Program progress rolls up module completion across all of the program's
// courses; an offline course counts as one attendance-driven unit (completion.js).
function programProgress(userId, program) { return COMPLETION.programProgress(userId, program); }
// Exams belong to a program, so attempts are keyed by programId.
function bestAttempt(userId, programId) {
  return store.bestAttempt(userId, programId);
}
// The pool the program exam draws from: every question tagged to one of its courses.
function programQuestions(program) {
  const ids = new Set(program.courseIds);
  return store.listQuestions().filter((q) => ids.has(q.courseId));
}
// ---------- exams (first-class objects since Batch 1) ----------
// Employees only ever see published exams; drafts/archived are HR-side.
function publishedProgramExams(programId) { return COMPLETION.publishedProgramExams(programId); }
// 「这门课（程序）算不算完成」的唯一口径：有已发布考试 → 最好成绩已通过（且线下课程已出席 / 迟到）；
// 无考试（未建或已关闭「需要结业考试」）→ 学习进度 100% 即完成。
// 学习记录、总览、导出、逾期提醒（含定时任务 notify-due.js）、晋升条件等都走这里，避免各处只看考试通过。
// 函数体在 modules/learning/completion.js。
function programHasExam(programId) { return COMPLETION.programHasExam(programId); }
// 线下课程都已出席 / 迟到（没有线下课程时为 true）
function offlineAttended(userId, p) { return COMPLETION.offlineAttended(userId, p); }
function programDone(userId, p) { return COMPLETION.programDone(userId, p); }
// 完成日期（第三批 1.4，ISO；未完成 → null），口径在 completion.js
function programDoneAt(userId, p) { return COMPLETION.programDoneAt(userId, p); }
// ---------- 学时、授课方式与课程（程序）元数据（第三批 1.2 / 1.3，2026-10-08）----------
// courseHours：课程文档的 hours（数字）优先；否则线上课程 = 模块时长合计 / 60（保留 1 位小数）；线下课程没填 = 0。
function courseHours(c) {
  if (!c) return 0;
  if (typeof c.hours === "number" && Number.isFinite(c.hours)) return c.hours;
  if ((c.mode || "online") === "offline") return 0;
  const min = (c.modules || []).reduce((s, m) => s + (Number(m.minutes) || 0), 0);
  return Math.round(min / 6) / 10;
}
function programHours(p) { return TS.round1(coursesInProgram(p).reduce((s, c) => s + courseHours(c), 0)); }
// 全部线上 → online；全部线下 → offline；混合 → mixed（线上 / 线下两个筛选都命中）
function programMode(p) {
  const ms = new Set(coursesInProgram(p).map((c) => ((c.mode || "online") === "offline" ? "offline" : "online")));
  return ms.size === 2 ? "mixed" : ms.has("offline") ? "offline" : "online";
}
// 包装程序 → 它的课程 id；旧版课程包 → null
function programCourseId(p) {
  if (!p || (p.courseIds || []).length !== 1) return null;
  const w = courseWrapperOf(p.courseIds[0]);
  return w && w.id === p.id ? p.courseIds[0] : null;
}
// 程序 → 引用它的培养项目（全部期次的 tpProgramIds 反查）。按 TPROJECTS 数组缓存（refreshContent 整批换掉后失效）。
const PROG_PROJECTS_MEMO = new WeakMap();
function programProjectsIndex() {
  let idx = PROG_PROJECTS_MEMO.get(TPROJECTS);
  if (idx) return idx;
  idx = new Map();
  for (const doc of TPROJECTS) {
    const ids = new Set();
    for (const c of doc.cohorts || []) for (const pid of tpProgramIds(c)) ids.add(pid);
    for (const pid of ids) { if (!idx.has(pid)) idx.set(pid, []); idx.get(pid).push({ id: doc.id, title: doc.title || "", title_zh: doc.title_zh || null }); }
  }
  PROG_PROJECTS_MEMO.set(TPROJECTS, idx);
  return idx;
}
// 培训概览用的程序元数据（设计 §1.3）：类别（课程包缺省取其课程的共同类别）、修读类型（缺省 = 必修）、授课方式、状态、学时、已发布考试数、培养项目
function programMetaOf(p) {
  return {
    id: p.id, courseId: programCourseId(p), title: p.title, title_zh: p.title_zh || null,
    category: CAT.programCategory(p, getCourse), enrollType: p.enrollType || "mandatory",
    mode: programMode(p), status: p.status || "published", hours: programHours(p),
    examCount: publishedProgramExams(p.id).length,
    projects: programProjectsIndex().get(p.id) || [],
  };
}
// 只有一门线下课程的程序：开课日（指派没有截止日时的参考日，设计 §1.5）
function programSessionDay(p) {
  const cs = coursesInProgram(p);
  return cs.length === 1 && (cs[0].mode || "online") === "offline" ? TS.sessionDay(cs[0].sessionAt) : null;
}

// 培训概览的人群、筛选与逐格状态（2026-10-07 从 GET /api/admin/overview 抽出）：看板、名单（/overview/people）、
// POST /api/admin/training/remind-overdue 与 completion.csv 共用这一份解析，所以看板设了筛选时，「一键提醒」提醒的正好是
// 看板名单里可提醒的人（负责人 2026-10-07）。get(k) 取筛选参数（GET 读 query，POST 读请求体）：
//   dept=<部门 id>（含全部下级）、programs=<课程 id,逗号分隔>、cohort=all|probation|new30（在职 / 试用期 / 近 30 天新入职）；
//   第三批（2026-10-08）：cat=<类别键,逗号分隔，"__none" = 未分类>、enroll=mandatory|elective、mode=online|offline（混合课程两边都算）、
//   tp=<培养项目 id>（课程 = 该项目各期次引用的课程，人员 = 该项目在训学员）、period=all|month|quarter|year|custom + from/to。
//   未知部门 / 课程 / 项目 id、非法日期与人员范围一律忽略；没传 period 只传 from/to = custom（旧接口）。
// 人群 = 数据范围内、账号可用、不是纯服务账号的人（也是员工的管理员照常统计，与员工名册同一规则，负责人 2026-10-07）。
// opts.includeInactive：停用账号也算（completion.csv 照旧导出停用账号，Active 列为 NO）。
// 「格子」与「本期应完成」S(W) 的口径见 modules/learning/training-stats.js；完成判定走请求级快照（与实时口径由 parity 测试保证一致）。
function trainingOverviewBase(user, get, opts = {}) {
  const ovScope = scopePredicate(user);
  const deptRows = store.listDepartments(true);
  // 第二批 3.1（2026-10-08）：dept= 的口径改走全站部门筛选 deptFilterFor（集团层不算祖先、含下级、"__none" / "name:"），
  // 与 completion.csv、GET /api/admin/dept-tree 一致（修掉 K2 集团层、K3 三份「含下级」实现）。
  const df = deptFilterFor(user, { deptRows });
  const deptIdx = df.ix;
  const deptScope = scopeDeptPredicate(user);
  const depts = deptRows.filter((d) => !deptScope || deptScope(d.name));
  const deptById = new Map(depts.map((d) => [d.id, d]));
  // 部门树的父子：上级不在范围内、或上级是集团层（Lark L0–L2）的部门当作根 —— 一级部门 = 集团层之下的第一层，
  // 与 org.js chainOf / 评估周期 / HoD 同一口径；矩阵按这棵树的根（范围内即 level1Id）归列。
  const parentOf = (d) => (d && d.parentId && deptById.has(d.parentId) && !deptById.get(d.parentId).group ? d.parentId : null);
  const topOf = (id) => { let cur = deptById.get(id); let guard = 0; while (cur && parentOf(cur) && guard++ < 64) cur = deptById.get(parentOf(cur)); return cur ? cur.id : null; };
  const userDeptId = (u) => { const hit = u && u.department ? deptIdx.deptOf(u.department) : null; return hit && deptById.has(hit.id) ? hit.id : null; };
  const qDept = get("dept");
  // 第三批：dept=direct:<部门 id> = 只看直接挂在该部门的人（不含下级；热力表「本部门直属」行的名单下钻）
  const directId = qDept && String(qDept).startsWith("direct:") ? String(qDept).slice(7) : null;
  const deptSet = directId
    ? (df.parse(directId) ? (name) => { const hit = name ? deptIdx.deptOf(name) : null; return !!hit && hit.id === directId; } : null)
    : qDept ? df.parse(qDept) : null;   // (部门名) => bool；未知 / 范围外的 id → null（忽略）
  // 未知课程 id 忽略（与未知部门 id 同一口径，QA 2026-10-06 O5）
  const knownProgs = new Set(PROGRAMS.map((p) => p.id));
  const qProgs = String(get("programs") || "").split(",").map((x) => x.trim()).filter((x) => x && knownProgs.has(x)); const progSet = qProgs.length ? new Set(qProgs) : null;
  const rawFrom = TS.isDay(get("from")) ? get("from") : null; const rawTo = TS.isDay(get("to")) ? get("to") : null;
  const cohort = ["probation", "new30"].includes(get("cohort")) ? get("cohort") : "all";
  const cat = [...new Set(String(get("cat") || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 30)
    .map((x) => (x === CAT.NONE ? CAT.NONE : CAT.normalizeCategory(x))).filter(Boolean))];
  const catSet = cat.length ? new Set(cat) : null;
  const enroll = ["mandatory", "elective"].includes(get("enroll")) ? get("enroll") : null;
  const mode = ["online", "offline"].includes(get("mode")) ? get("mode") : null;
  const tpDoc = get("tp") ? TPROJECTS.find((d) => d.id === String(get("tp"))) || null : null;
  // 「现在」走 nowMs（LMS_FAKE_NOW 测试缝）：窗口、逾期与近 30 天入职同一个时钟
  const now = new Date(nowMs()); const today = todayLocal(); const day30 = dateLocalOffset(-30);
  const wins = TS.periodWindows({ period: get("period"), from: rawFrom, to: rawTo, today });
  const win = wins.win, prevWin = wins.prevWin, asOf = TS.asOfDay(win, today);
  let tpLearners = null;
  if (tpDoc) tpLearners = new Set(store.listProjectMembers(tpDoc.id).filter((m) => m.role === "learner" && m.state === "active").map((m) => m.userId));
  const users = store.listUsers().filter((u) => !LC.isServiceAccount(u) && (opts.includeInactive || u.active !== 0))
    .filter((u) => !ovScope || ovScope(u))
    .filter((u) => !deptSet || deptSet(u.department))
    .filter((u) => !tpLearners || tpLearners.has(u.id))
    .filter((u) => (cohort === "probation" ? u.empStatus === "probation" : cohort === "new30" ? !!(u.hireDate && String(u.hireDate).slice(0, 10) >= day30) : true));
  const metaMemo = new Map();
  const meta = (p) => { if (!metaMemo.has(p.id)) metaMemo.set(p.id, programMetaOf(p)); return metaMemo.get(p.id); };
  let tpProgs = null;
  if (tpDoc) { tpProgs = new Set(); for (const c of tpDoc.cohorts || []) for (const pid of tpProgramIds(c)) tpProgs.add(pid); }
  const programs = PROGRAMS.filter((p) => !progSet || progSet.has(p.id))
    .filter((p) => !tpProgs || tpProgs.has(p.id))
    .filter((p) => !catSet || catSet.has(meta(p).category || CAT.NONE))
    .filter((p) => !enroll || meta(p).enrollType === enroll)
    .filter((p) => !mode || meta(p).mode === mode || meta(p).mode === "mixed");
  // 请求级快照与完成口径（第一次用到时才建：搜索、人员页用不到）
  let snapS = null, cmpS = null;
  const cmp = () => {
    if (!cmpS) {
      snapS = TS.createSnapshotStore(store);
      cmpS = LC.createCompletion({ store: snapS, getCourse, memoExams: true, listProjects: () => TPROJECTS, programsOfCourse: (cid, c) => programsContaining(cid, c) });
    }
    return cmpS;
  };
  const snap = () => { cmp(); return snapS; };
  const cellMemo = new Map();
  const cellOf = (u, p, a) => {
    const k = u.id + "|" + p.id;
    let c = cellMemo.get(k);
    if (c) return c;
    const C = cmp();
    const done = C.programDone(u.id, p);
    const doneAt = done ? C.programDoneAt(u.id, p) : null;
    const dueDay = a.dueAt ? String(a.dueAt).slice(0, 10) : null;
    const m = meta(p);
    const progress = C.programProgress(u.id, p).percent;
    // 第四批 7：self = 自主学习（source='self'）—— 不算必修、没有截止日（不逾期、不提醒）
    const self = a.source === "self";
    c = {
      u, p, asg: a, userId: u.id, programId: p.id,
      dueDay, refDay: dueDay || programSessionDay(p) || TS.dayOf(a.assignedAt),
      done, doneAt, doneDay: done ? (TS.dayOf(doneAt) || "0000-00-00") : null,
      started: done || progress > 0 || !!snapS.bestAttempt(u.id, p.id),
      published: m.status === "published", mandatory: m.enrollType === "mandatory" && !self, self, hours: m.hours, category: m.category, progress,
    };
    cellMemo.set(k, c);
    return c;
  };
  let cellsS = null;
  // 第四批 7：src = all | assigned | self（来源筛选；未知值 = all），收窄格子、名单、CSV 与提醒
  const src = ["assigned", "self"].includes(get("src")) ? get("src") : "all";
  const srcOk = (a) => src === "all" || (src === "self" ? a.source === "self" : a.source !== "self");
  // P 内全部指派格子（不论时间段）；本期应完成的子集用 inS 判
  const cells = () => {
    if (cellsS) return cellsS;
    const S = snap();
    cellsS = [];
    for (const u of users) {
      const asg = S.getUserAssignments(u.id);
      for (const p of programs) { const a = asg[p.id]; if (a && srcOk(a)) cellsS.push(cellOf(u, p, a)); }
    }
    return cellsS;
  };
  const inS = (c) => TS.inWindowSet(c, win, today);
  // 截至今天的状态（「一键提醒」、旧版看板与名单的可提醒判定）；不在本期应完成集合里 → null
  const statusOf = (u, p, asg) => {
    const a = asg && asg[p.id];
    if (!a || !srcOk(a)) return null;
    const c = cellOf(u, p, a);
    return inS(c) ? TS.statusAt(c, today) : null;
  };
  const filtered = !!(deptSet || progSet || rawFrom || rawTo || cohort !== "all" || catSet || enroll || mode || tpDoc || (wins.period !== "all") || src !== "all");
  return {
    src, srcOk,
    depts, deptById, parentOf, topOf, userDeptId, qDept, deptSet, df, qProgs, progSet, from: rawFrom, to: rawTo, cohort, now, users, programs, statusOf, filtered,
    cat, catSet, enroll, mode, tp: tpDoc ? tpDoc.id : null, tpDoc, wins, win, prevWin, period: wins.period, today, asOf,
    meta, cmp, snap, cells, cellOf, inS,
  };
}
// 侧栏角标与培训概览「待处理」的同源计数（设计 §4.1 / §4.5）：范围内（另可按部门 deptSet 收窄）的选修申请、
// 培养项目申请、待复核 / 待评分答卷（及其中超过 3 个工作日的）、未结的考试成绩申诉。申诉只对 learning 可读的角色计数，其余为 0。
function pendingCountsFor(user, deptSet) {
  const sc = scopePredicate(user);
  const ok = (u) => !!u && (!sc || sc(u)) && (!deptSet || deptSet(u.department));
  const learn = canRead(user, "learning");   // 申诉数只给 learning 可读的角色（pending-counts 是全员壳路由）
  const grading = store.listAttemptsByGradingStatus(["pending_review", "manual_pending"]).filter((a) => ok(store.getUserById(a.userId)));
  const review = grading.filter((a) => a.gradingStatus === "pending_review");
  const lite = store.listSubmittedAttemptsLite();
  const appealMap = store.listAppealsForAttempts(lite.map((a) => a.id));
  const byId = new Map(lite.map((a) => [a.id, a]));
  let appeals = 0;
  if (learn) for (const [aid, ap] of appealMap) { if (ap.status !== "open") continue; const a = byId.get(aid); if (a && ok(store.getUserById(a.userId))) appeals++; }
  const unscoped = !sc && !deptSet;
  return {
    enroll: unscoped ? store.countApprovals("enroll", "pending") : store.listPendingRequests().filter((r) => ok(store.getUserById(r.userId))).length,
    nominations: unscoped ? store.countApprovals("nomination", "pending") : store.listApprovals("nomination", "pending").filter((a) => ok(store.getUserById(a.targetUserId))).length,
    gradingReview: review.length, gradingManual: grading.length - review.length,
    reviewOverdue: review.filter((a) => reviewOverdue(a)).length,
    appeals,
  };
}
// 培养项目一个期次的汇总（项目看板 GET /api/admin/tprojects/:id/dashboard 与培训概览的项目卡片共用，第三批 2026-10-08 抽出）。
// learners = 已按范围过滤、在训、账号可用的学员（[{ userId, u, … }]）。返回 { views, progressAvg, phaseFunnel, attendance:{present,total}, risks[] }，
// risks 每条带 userId（看板路由回给前端前去掉）。口径与原路由逐字相同：
//   出勤率 = 已开始的线下活动 × 学员里签到 + 迟到的占比，请假不进分母；「已开始」= 活动日期（startAt，没有就 dueAt）≤ 今天，没写日期的活动有人签过到也算；
//   风险 = 已解锁阶段里必修、未完成、截止日已过（线上活动没填截止日时以开始日期计）、未登记请假的活动。
function tpCohortSummary(doc, cohort, learners) {
  const views = learners.map((m) => ({ m, phases: tpPhaseView(m.userId, doc.id, cohort) }));
  const phaseFunnel = (cohort.phases || []).map((ph, i) => ({
    id: ph.id, name: ph.name, name_zh: ph.name_zh || null,
    done: views.filter((v) => v.phases[i] && v.phases[i].complete).length,
    total: learners.length,
  }));
  const today = todayLocal(); // local day: a.dueAt is a local calendar date
  const att = { present: 0, total: 0 };
  for (const a of tpActivities(cohort)) {
    const ckT = tpCheckinTarget(a, doc, cohort);   // 线下活动与引用线下课程的活动都算出勤
    if (!ckT) continue;
    const states = new Map(store.listActivityStates(ckT.ckId).map((st) => [st.userId, st]));
    const day = String(a.startAt || ckT.sessionAt || a.dueAt || "").slice(0, 10);
    const started = day ? day <= today : learners.some((m) => states.has(m.userId));
    if (!started) continue;
    for (const m of learners) {
      const st = states.get(m.userId);
      if (st && st.status === "excused") continue;
      att.total++;
      if (st && ["attended", "late"].includes(st.status)) att.present++;
    }
  }
  const risks = [];
  const riskView = new Map();   // 同一活动对每个学员都一样，视图只算一次
  for (const v of views) {
    for (const ph of v.phases) {
      if (!ph.unlocked) break;
      for (const a of ph.activities) {
        const due = a.dueAt || (a.type === "online" && a.startAt ? String(a.startAt).slice(0, 10) : null);
        if (a.required === false || a.done || a.broken || !due || due >= today) continue;
        if (a.state === "excused") continue;
        if (!riskView.has(a.id)) riskView.set(a.id, tpActivityView(a));
        const view = riskView.get(a.id);
        risks.push({ userId: v.m.userId, name: v.m.u.name, employeeId: v.m.u.employeeId, activityId: a.id, item: view.title || null, item_zh: view.title_zh || null, category: view.category || null, dueAt: due });
      }
    }
  }
  return {
    views, phaseFunnel, attendance: att, risks,
    progressAvg: views.length ? Math.round(views.reduce((s, v) => s + tpProgressPercent(v.phases), 0) / views.length) : 0,
  };
}
// ---------- 培训概览 v2、名单、搜索（第三批 4.1 / 4.2，2026-10-08；口径见 docs 设计 §1.5–§1.6、§4.1–§4.3）----------
// 部门 id → 「一级 / … / 本部门」路径文字，只含范围内的部门（deptFilterFor.pathOf，范围外的祖先不出现）
function ovDeptPath(ov, name) {
  if (!name) return "";
  return ov.df.pathOf({ department: name }).map((id) => { const d = ov.df.ix.byId.get(id); return d ? d.name : null; }).filter(Boolean).join(" / ");
}
// 概览人群在 P 内的已提交答卷（轻量，请求级快照）
function ovAttempts(ov) {
  const uids = new Set(ov.users.map((u) => u.id)), pids = new Set(ov.programs.map((p) => p.id));
  return ov.snap().allAttempts().filter((a) => uids.has(a.userId) && pids.has(a.programId));
}
// 考试通过率口径：已出结论、未作废、窗口内（且不晚于今天）提交
function ovAttemptsIn(ov, list, w) {
  const S = ov.snap();
  let passed = 0, total = 0;
  for (const a of list) {
    if (!S.isSettled(a)) continue;
    const d = TS.dayOf(a.submittedAt);
    if (!d || d > ov.today) continue;
    if (w && (w.from || w.to) && !TS.inWin(d, w)) continue;
    total++; if (a.passed) passed++;
  }
  return { passed, total };
}
// 完成日期落在窗口内（窗口不设边界 = 任何已知日期；不晚于今天）
const ovDoneIn = (ov, c, w) => !!(c.done && c.doneDay !== "0000-00-00" && c.doneDay <= ov.today && (!w || (!w.from && !w.to) || TS.inWin(c.doneDay, w)));
// 7 天内到期：P 内、已发布、未完成、截止日在 [今天, 今天 + 7]（永远按今天算）
const ovDueSoon = (ov, c) => !!(c.published && !c.done && c.dueDay && c.dueDay >= ov.today && c.dueDay <= TS.addDays(ov.today, 7));
// 这一格能不能被「一键提醒」提醒：metric overdue = 本期应完成、今天逾期；dueSoon = 7 天内到期。再过 reminderEligible。
function ovRemindable(ov, c, metric) {
  if (metric === "dueSoon") { if (!ovDueSoon(ov, c)) return false; }
  else if (!(ov.inS(c) && TS.statusAt(c, ov.today) === "overdue")) return false;
  if (c._elig === undefined) c._elig = ov.cmp().reminderEligible(c.u, c.p, c.asg);
  return c._elig;
}
// 部门热力表的行归属（设计 §2.6）：没有部门筛选 → 范围内树的根（无部门的人 → "__none"）；
// 筛选了部门 X 且 X 有下级 → X 的直接下级，X 本部门的人 → "X|direct"；X 没有下级 → 只有 X 一行。
function ovHeatRowOf(ov) {
  const qd = ov.deptSet && ov.qDept && ov.deptById.has(ov.qDept) ? ov.qDept : null;
  const kids = qd ? ov.depts.filter((d) => ov.parentOf(d) === qd).map((d) => d.id) : [];
  const kidSet = new Set(kids);
  const memo = new Map();
  const rowOf = (u) => {
    if (memo.has(u.id)) return memo.get(u.id);
    const did = ov.userDeptId(u);
    let r;
    if (!qd) r = did ? ov.topOf(did) || "__none" : "__none";
    else if (!kids.length) r = qd;
    else if (did === qd || !did) r = qd + "|direct";
    else { let cur = did, guard = 0; while (cur && !kidSet.has(cur) && guard++ < 64) cur = ov.parentOf(ov.deptById.get(cur)); r = cur && kidSet.has(cur) ? cur : qd + "|direct"; }
    memo.set(u.id, r);
    return r;
  };
  const meta = (key) => {
    if (key === "__none") return { deptId: "__none", filterKey: "__none", name: null, path: "", direct: false };
    const direct = key.endsWith("|direct");
    const id = direct ? key.slice(0, -7) : key;
    const d = ov.deptById.get(id);
    // filterKey：名单下钻用的 dept / ldept 值（直属行 = "direct:<id>"）
    return { deptId: id, filterKey: direct ? "direct:" + id : id, name: d ? d.name : null, path: d ? ovDeptPath(ov, d.name) : "", direct };
  };
  return { parentId: qd, rowOf, meta };
}
function buildOverviewV2(user, ov) {
  const { today, win, prevWin, asOf } = ov;
  const all = ov.cells();
  const sCells = all.filter(ov.inS);
  const ats = ovAttempts(ov);
  const kpis = TS.computeKpis({ cells: all, H: ov.users.length, wins: ov.wins, today, attemptsIn: (w) => ovAttemptsIn(ov, ats, w) });
  const group = (list, key) => { const m = new Map(); for (const c of list) { const k = key(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); } return m; };
  const sByProg = group(sCells, (c) => c.programId);
  const allByProg = group(all, (c) => c.programId);
  const distinct = (list, pred) => { const s = new Set(); for (const c of list) if (pred(c)) s.add(c.userId); return s.size; };
  const hoursDoneOf = (list) => TS.round1(list.reduce((s, c) => s + (ovDoneIn(ov, c, win) ? c.hours || 0 : 0), 0));
  const atsByProg = group(ats, (a) => a.programId);
  const perProgram = ov.programs.map((p) => {
    const m = ov.meta(p);
    const cs = sByProg.get(p.id) || [], allc = allByProg.get(p.id) || [];
    const t = TS.tally(cs, asOf, null);
    const at = ovAttemptsIn(ov, atsByProg.get(p.id) || [], win);
    return {
      id: p.id, title: p.title, title_zh: p.title_zh || null, category: m.category, enrollType: m.enrollType, mode: m.mode, hours: m.hours,
      assigned: t.assigned, done: t.done, overdue: t.overdue, overduePeople: t.overduePeople, inprog: t.inprog, notstarted: t.notstarted,
      dueSoon: allc.filter((c) => ovDueSoon(ov, c)).length, hoursDone: hoursDoneOf(allc), completion: t.completion,
      attempts: at.total, passRate: TS.pct(at.passed, at.total),
      remindablePeople: distinct(cs, (c) => ovRemindable(ov, c, "overdue")),
      // 第四批 7：其中自主学习的人次与完成人次（本期应完成集合内，口径同 assigned / done）
      selfAssigned: cs.filter((c) => c.self).length, selfDone: cs.filter((c) => c.self && TS.statusAt(c, asOf) === "done").length,
    };
  });
  // 需要关注：课程（选修课程不进「完成率偏低」补位，UX 10）
  const courses = TS.rankRisk(perProgram.map((r) => ({ programId: r.id, assigned: r.assigned, done: r.done, completion: r.completion, overdue: r.overdue, overduePeople: r.overduePeople, dueSoon: r.dueSoon, remindablePeople: r.remindablePeople, enrollType: r.enrollType })),
    { eligible: (r) => r.enrollType === "mandatory" }).map(({ enrollType, ...r }) => r);
  // 热力表
  const H = ovHeatRowOf(ov);
  const rowAgg = new Map(), cellAgg = new Map(), heads = new Map();
  for (const u of ov.users) { const k = H.rowOf(u); heads.set(k, (heads.get(k) || 0) + 1); }
  const colSet = new Set();
  for (const c of sCells) {
    const k = H.rowOf(c.u), st = TS.statusAt(c, asOf), key = c.category || null;
    colSet.add(key);
    let r = rowAgg.get(k); if (!r) { r = { assigned: 0, done: 0, overdue: 0, people: new Set() }; rowAgg.set(k, r); }
    r.assigned++; if (st === "done") r.done++; if (st === "overdue") { r.overdue++; r.people.add(c.userId); }
    const ck = k + "\u0000" + (key || "");
    let x = cellAgg.get(ck); if (!x) { x = { deptKey: k, key, assigned: 0, done: 0, overdue: 0 }; cellAgg.set(ck, x); }
    x.assigned++; if (st === "done") x.done++; if (st === "overdue") x.overdue++;
  }
  const heatRows = [...rowAgg.entries()].filter(([, r]) => r.assigned > 0).map(([k, r]) => ({
    ...H.meta(k), key: k, headcount: heads.get(k) || 0, assigned: r.assigned, done: r.done, overdue: r.overdue, overduePeople: r.people.size, completion: TS.pct(r.done, r.assigned),
  }));
  // 默认风险排序：逾期人数降序 → 完成率升序 → 名称（UX 3）
  heatRows.sort((a, b) => (b.overduePeople - a.overduePeople) || ((a.completion ?? 101) - (b.completion ?? 101)) || String(a.name || "").localeCompare(String(b.name || "")));
  const cols = [...colSet].sort(CAT.compareCategory);
  const heat = {
    parentId: H.parentId,
    rows: heatRows.map(({ key, ...r }) => r),
    cols,
    cells: [...cellAgg.values()].map((x) => { const r = heatRows.find((h) => h.key === x.deptKey); return r ? { deptId: r.deptId, direct: r.direct, filterKey: r.filterKey, key: x.key, assigned: x.assigned, done: x.done, overdue: x.overdue, completion: TS.pct(x.done, x.assigned) } : null; }).filter(Boolean),
  };
  const depts = TS.rankRisk(heatRows.map((r) => ({ ...r })), {}).map((r) => ({ deptId: r.deptId, direct: r.direct, filterKey: r.filterKey, name: r.name, path: r.path, reason: r.reason, headcount: r.headcount, assigned: r.assigned, done: r.done, completion: r.completion, overdue: r.overdue, overduePeople: r.overduePeople }));
  // 7 天内到期
  const dueCells = all.filter((c) => ovDueSoon(ov, c));
  const dueGroups = [...group(dueCells, (c) => c.programId).entries()].map(([pid, cs]) => ({
    programId: pid, people: distinct(cs, () => true), rows: cs.length,
    firstDue: cs.reduce((m, c) => (!m || c.dueDay < m ? c.dueDay : m), null), lastDue: cs.reduce((m, c) => (!m || c.dueDay > m ? c.dueDay : m), null),
    remindablePeople: distinct(cs, (c) => ovRemindable(ov, c, "dueSoon")),
  })).sort((a, b) => (b.people - a.people) || String(a.firstDue).localeCompare(String(b.firstDue)));
  const pc = pendingCountsFor(user, ov.deptSet);
  // 按类别汇总
  const catMap = new Map();
  for (const p of ov.programs) { const k = ov.meta(p).category || null; if (!catMap.has(k)) catMap.set(k, []); catMap.get(k).push(p.id); }
  const categories = [...catMap.entries()].sort((a, b) => CAT.compareCategory(a[0], b[0])).map(([key, pids]) => {
    const cs = pids.flatMap((id) => sByProg.get(id) || []), allc = pids.flatMap((id) => allByProg.get(id) || []);
    const t = TS.tally(cs, asOf, null);
    return { key, courses: pids.length, programIds: pids, assigned: t.assigned, done: t.done, completion: t.completion, overdue: t.overdue, overduePeople: t.overduePeople,
      dueSoon: allc.filter((c) => ovDueSoon(ov, c)).length, hoursDone: hoursDoneOf(allc),
      selfAssigned: cs.filter((c) => c.self).length };   // 第四批 7：自主学习人次
  });
  // 进行中的培养项目
  const projects = ovProjectCards(user, ov);
  // 近 12 周（本地周一）：新增指派、完成、考试提交与通过；不受时间段筛选影响
  const wk = TS.weekBuckets(today);
  const trend = wk.weeks.map((w) => ({ week: w, assigned: 0, completed: 0, submitted: 0, passed: 0 }));
  for (const c of all) {
    const i = wk.idxOf(TS.dayOf(c.asg.assignedAt)); if (i >= 0) trend[i].assigned++;
    if (c.done && c.doneDay !== "0000-00-00") { const j = wk.idxOf(c.doneDay); if (j >= 0) trend[j].completed++; }
  }
  for (const a of ats) { const i = wk.idxOf(TS.dayOf(a.submittedAt)); if (i >= 0) { trend[i].submitted++; if (a.passed) trend[i].passed++; } }
  return {
    v: 2, asOf, today,
    filters: { dept: ov.deptSet ? ov.qDept : null, programs: ov.qProgs, cat: ov.cat, enroll: ov.enroll, mode: ov.mode, tp: ov.tp, cohort: ov.cohort, src: ov.src,
      period: ov.period, compare: ov.wins.base, from: win.from, to: win.to, prevFrom: prevWin ? prevWin.from : null, prevTo: prevWin ? prevWin.to : null },
    employees: ov.users.length,
    programsMeta: ov.programs.map((p) => ov.meta(p)),
    perProgram, kpis,
    attention: {
      courses,
      depts,
      dueSoon: { people: distinct(dueCells, () => true), rows: dueCells.length, items: dueGroups.slice(0, 5) },
      pending: { enroll: pc.enroll, nominations: pc.nominations, review: pc.gradingReview, reviewOverdue: pc.reviewOverdue, manual: pc.gradingManual, appeals: pc.appeals },
    },
    categories, heat, projects, trend,
  };
}
// 进行中的培养项目卡片（设计 §2.7）：只列 running；tp 筛选只看该项目；cat 筛选按项目自己的类别；dept / 范围收窄学员；
// 有范围限制的管理员看不到范围内 0 名学员的项目。
function ovProjectCards(user, ov) {
  const sc = scopePredicate(user);
  const out = [];
  for (const doc of TPROJECTS) {
    if (doc.status !== "running") continue;
    if (ov.tp && doc.id !== ov.tp) continue;
    if (ov.catSet && !ov.catSet.has(doc.category || CAT.NONE)) continue;
    const members = store.listProjectMembers(doc.id).filter((m) => m.role === "learner" && m.state === "active")
      .map((m) => ({ ...m, u: store.getUserById(m.userId) }))
      .filter((m) => m.u && m.u.active !== 0 && (!sc || sc(m.u)) && (!ov.deptSet || ov.deptSet(m.u.department)));
    if (!members.length && sc) continue;
    let progSum = 0, n = 0; const att = { present: 0, total: 0 }; const behind = new Set();
    for (const cohort of doc.cohorts || []) {
      const ls = members.filter((m) => m.cohortId === cohort.id);
      if (!ls.length) continue;
      const s = tpCohortSummary(doc, cohort, ls);
      progSum += s.progressAvg * ls.length; n += ls.length;
      att.present += s.attendance.present; att.total += s.attendance.total;
      for (const r of s.risks) behind.add(r.userId);
    }
    // 下一阶段：各期次里开始日期在今天之后的最早阶段；没有就取最早的、日期在今天之后的活动所在阶段
    let next = null;
    for (const cohort of doc.cohorts || []) for (const ph of cohort.phases || []) {
      const at = ph.startAt ? String(ph.startAt).slice(0, 10) : null;
      if (at && at > ov.today && (!next || at < next.at)) next = { name: ph.name || null, name_zh: ph.name_zh || null, at };
    }
    if (!next) for (const cohort of doc.cohorts || []) for (const ph of cohort.phases || []) for (const a of ph.activities || []) {
      const at = String(a.startAt || a.dueAt || "").slice(0, 10);
      if (TS.isDay(at) && at > ov.today && (!next || at < next.at)) next = { name: ph.name || null, name_zh: ph.name_zh || null, at };
    }
    out.push({ id: doc.id, code: doc.code || null, title: doc.title || "", title_zh: doc.title_zh || null, category: doc.category || null,
      cohorts: (doc.cohorts || []).length, members: members.length, progress: n ? Math.round(progSum / n) : null,
      attendance: att.total ? Math.round((att.present / att.total) * 100) : null, nextPhase: next, behind: behind.size });
  }
  return out;
}
// 名单（GET /api/admin/overview/people，设计 §4.2）。返回 { status, body } 或 { csv: { filename, rows } }。
const OVP_METRICS = ["assigned", "done", "notdone", "overdue", "dueSoon", "covered", "uncovered", "attempts"];
const OVP_TEXT = {
  zh: { name: "姓名", employeeId: "工号", department: "部门", manager: "直属上级", course: "课程", category: "类别", enroll: "修读类型", mode: "授课方式", status: "状态", progress: "进度 %", due: "截止日期", assigned: "指派日期", doneAt: "完成日期", daysOverdue: "逾期天数", best: "最好成绩 %", completed: "已完成课程", assignedN: "指派人次", overdueN: "逾期", hours: "学时", submitted: "提交时间", score: "得分 %", result: "结果", source: "来源", src: { assigned: "指派", self: "自主学习" },
    st: { done: "已完成", inprog: "进行中", notstarted: "未开始", overdue: "已逾期" }, en: { mandatory: "必修", elective: "选修" }, md: { online: "线上", offline: "线下", mixed: "混合" }, pass: "通过", fail: "未通过" },
  en: { name: "Name", employeeId: "Employee ID", department: "Department", manager: "Manager", course: "Course", category: "Category", enroll: "Requirement type", mode: "Delivery", status: "Status", progress: "Progress %", due: "Due date", assigned: "Assigned on", doneAt: "Completed on", daysOverdue: "Days overdue", best: "Best score %", completed: "Courses completed", assignedN: "Assignments", overdueN: "Overdue", hours: "Hours", submitted: "Submitted", score: "Score %", result: "Result", source: "Source", src: { assigned: "Assigned", self: "Self-directed" },
    st: { done: "Completed", inprog: "In progress", notstarted: "Not started", overdue: "Overdue" }, en: { mandatory: "Required", elective: "Elective" }, md: { online: "Online", offline: "In-person", mixed: "Mixed" }, pass: "Passed", fail: "Not passed" },
};
function overviewPeople(user, ov, q) {
  const metric = q.get("metric") || "assigned";
  if (!OVP_METRICS.includes(metric)) return { status: 400, body: { error: "Unknown list.", error_zh: "未知的名单类型。", code: "bad_metric" } };
  const unit = ["covered", "uncovered"].includes(metric) ? "person" : metric === "attempts" ? "attempt" : "cell";
  const { today, win, asOf } = ov;
  const lang = q.get("lang") === "en" ? "en" : "zh";
  const qq = String(q.get("q") || "").normalize("NFKC").trim().toLowerCase().slice(0, 50);
  const mgrMemo = new Map();
  const managerName = (u) => { if (!u.managerId) return null; if (!mgrMemo.has(u.managerId)) { const m = store.getUserById(u.managerId); mgrMemo.set(u.managerId, m ? m.name : null); } return mgrMemo.get(u.managerId); };
  const matchQ = (u) => !qq || String(u.name || "").toLowerCase().includes(qq) || String(u.employeeId || "").toLowerCase().includes(qq);
  let rows = [], remindablePeople;
  const all = ov.cells();
  const S = ov.snap();
  if (unit === "cell") {
    let cs;
    if (metric === "dueSoon") cs = all.filter((c) => ovDueSoon(ov, c));
    else {
      cs = all.filter(ov.inS);
      if (metric === "done") cs = cs.filter((c) => TS.statusAt(c, asOf) === "done");
      else if (metric === "notdone") cs = cs.filter((c) => TS.statusAt(c, asOf) !== "done");
      else if (metric === "overdue") cs = cs.filter((c) => TS.statusAt(c, asOf) === "overdue");
      const status = q.get("status");
      if (metric === "assigned" && ["done", "notdone", "overdue", "notstarted", "inprog"].includes(status))
        cs = cs.filter((c) => { const st = TS.statusAt(c, asOf); return status === "notdone" ? st !== "done" : st === status; });
    }
    if (metric === "overdue" || metric === "dueSoon") {
      const ppl = new Set(); for (const c of cs) if (ovRemindable(ov, c, metric)) ppl.add(c.userId);
      remindablePeople = ppl.size;
    }
    rows = cs.filter((c) => matchQ(c.u)).map((c) => {
      const m = ov.meta(c.p), st = TS.statusAt(c, metric === "dueSoon" ? today : asOf);
      const best = S.bestAttempt(c.userId, c.programId);
      return {
        userId: c.userId, name: c.u.name, employeeId: c.u.employeeId, department: c.u.department || "", managerName: managerName(c.u),
        programId: c.programId, title: c.p.title, title_zh: c.p.title_zh || null, category: m.category, enrollType: m.enrollType, mode: m.mode,
        status: st, progress: c.progress, dueAt: c.asg.dueAt || null, assignedAt: c.asg.assignedAt || null, doneAt: c.done ? c.doneAt : null,
        daysOverdue: st === "overdue" && c.dueDay ? TS.daysBetween(c.dueDay, metric === "dueSoon" ? today : asOf) : null,
        bestPercent: best ? best.percent : null,
        source: c.self ? "self" : "assigned",   // 第四批 7
        remindable: metric === "overdue" || metric === "dueSoon" ? ovRemindable(ov, c, metric) : (ov.inS(c) && TS.statusAt(c, today) === "overdue" ? ovRemindable(ov, c, "overdue") : false),
      };
    });
  } else if (unit === "person") {
    const per = new Map();
    for (const c of all) {
      let r = per.get(c.userId); if (!r) { r = { completed: 0, assigned: 0, overdue: 0, hours: 0 }; per.set(c.userId, r); }
      if (ovDoneIn(ov, c, win)) { r.completed++; r.hours += c.hours || 0; }
      if (ov.inS(c)) { r.assigned++; if (TS.statusAt(c, asOf) === "overdue") r.overdue++; }
    }
    const want = metric === "covered";
    rows = ov.users.filter((u) => { const r = per.get(u.id); return want ? !!(r && r.completed) : !(r && r.completed); }).filter(matchQ).map((u) => {
      const r = per.get(u.id) || { completed: 0, assigned: 0, overdue: 0, hours: 0 };
      return { userId: u.id, name: u.name, employeeId: u.employeeId, department: u.department || "", managerName: managerName(u), completed: r.completed, assigned: r.assigned, overdue: r.overdue, hours: TS.round1(r.hours) };
    });
  } else {
    const uById = new Map(ov.users.map((u) => [u.id, u])), pById = new Map(ov.programs.map((p) => [p.id, p]));
    rows = ovAttempts(ov).filter((a) => {
      if (!S.isSettled(a)) return false;
      const d = TS.dayOf(a.submittedAt); if (!d || d > today) return false;
      return !(win.from || win.to) || TS.inWin(d, win);
    }).filter((a) => matchQ(uById.get(a.userId))).map((a) => {
      const u = uById.get(a.userId), p = pById.get(a.programId);
      return { attemptId: a.id, userId: u.id, name: u.name, employeeId: u.employeeId, department: u.department || "", programId: p.id, title: p.title, title_zh: p.title_zh || null, submittedAt: a.submittedAt, percent: a.percent, passed: !!a.passed };
    });
  }
  // 排序
  const sort = q.get("sort") || (metric === "overdue" ? "overdueDays" : metric === "dueSoon" ? "due" : metric === "covered" ? "hours" : metric === "attempts" ? "submitted" : "dept");
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
  const byDept = (a, b) => String(a.department || "").localeCompare(String(b.department || "")) || byName(a, b);
  const sorters = {
    dept: byDept, name: (a, b) => byName(a, b) || byDept(a, b),
    due: (a, b) => String(a.dueAt || "9999").localeCompare(String(b.dueAt || "9999")) || byDept(a, b),
    overdueDays: (a, b) => ((b.daysOverdue || 0) - (a.daysOverdue || 0)) || byDept(a, b),
    doneAt: (a, b) => String(b.doneAt || "").localeCompare(String(a.doneAt || "")) || byDept(a, b),
    hours: (a, b) => ((b.hours || 0) - (a.hours || 0)) || byDept(a, b),
    submitted: (a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")) || byDept(a, b),
  };
  rows.sort(sorters[sort] || sorters.dept);
  const people = new Set(rows.map((r) => r.userId)).size;
  if (q.get("format") === "csv") {
    if (rows.length > 20000) return { status: 413, body: { error: "Too many rows (over 20,000). Narrow the filters and try again.", error_zh: "超过 20,000 行，请缩小筛选范围后再导出。", code: "too_many_rows" } };
    const L = OVP_TEXT[lang];
    const catL = (k) => CAT.categoryLabel(k, lang);
    const title = (r) => (lang === "zh" ? r.title_zh || r.title : r.title);
    const dt = (iso) => (iso ? String(TS.dayOf(iso) || iso).slice(0, 10) : "");
    let head, body;
    if (unit === "cell") {
      // 第四批 7：末尾加「来源 / Source」列（指派 / 自主学习）
      head = [L.name, L.employeeId, L.department, L.manager, L.course, L.category, L.enroll, L.mode, L.status, L.progress, L.assigned, L.due, L.doneAt, L.daysOverdue, L.best, L.source];
      body = rows.map((r) => [r.name, r.employeeId, r.department, r.managerName || "", title(r), catL(r.category), L.en[r.enrollType] || r.enrollType, L.md[r.mode] || r.mode, L.st[r.status] || r.status, r.progress, dt(r.assignedAt), r.dueAt || "", dt(r.doneAt), r.daysOverdue ?? "", r.bestPercent ?? "", L.src[r.source] || ""]);
    } else if (unit === "person") {
      head = [L.name, L.employeeId, L.department, L.manager, L.completed, L.assignedN, L.overdueN, L.hours];
      body = rows.map((r) => [r.name, r.employeeId, r.department, r.managerName || "", r.completed, r.assigned, r.overdue, r.hours]);
    } else {
      head = [L.name, L.employeeId, L.department, L.course, L.submitted, L.score, L.result];
      body = rows.map((r) => [r.name, r.employeeId, r.department, title(r), String(r.submittedAt || "").slice(0, 16).replace("T", " "), r.percent, r.passed ? L.pass : L.fail]);
    }
    return { csv: { filename: `training-${metric}-${today.replace(/-/g, "")}.csv`, rows: [head, ...body], count: body.length } };
  }
  const size = Math.min(200, Math.max(10, Number(q.get("size")) || 50));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(q.get("page")) || 1)));
  return { status: 200, body: { metric, unit, total: rows.length, people, page, size, ...(remindablePeople !== undefined ? { remindablePeople } : {}), rows: rows.slice((page - 1) * size, page * size) } };
}
// 全局搜索（GET /api/admin/training/search，设计 §4.3；每组最多 5 条，超出 more = true —— 与界面显示条数一致，UX 19）
const TRAINING_SEARCH_LIMIT = 5;
function trainingSearch(user, rawQ) {
  const q = String(rawQ || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 50);
  const cjk = /[㐀-鿿豈-﫿]/.test(q);
  if (q.length < (cjk ? 1 : 2)) return { q, tooShort: true, courses: [], people: [], depts: [], more: { courses: false, people: false, depts: false } };
  const take = (list) => { list.sort((a, b) => a.rank - b.rank || String(a.sortName).localeCompare(String(b.sortName))); return { items: list.slice(0, TRAINING_SEARCH_LIMIT).map(({ rank, sortName, ...r }) => r), more: list.length > TRAINING_SEARCH_LIMIT }; };
  const lc = (s) => String(s || "").normalize("NFKC").toLowerCase();
  // 人员：概览人群（范围内、在职、非服务账号）
  const ov = trainingOverviewBase(user, () => null);
  const qNoSp = q.replace(/\s+/g, "");
  const ppl = [];
  for (const u of ov.users) {
    const id = lc(u.employeeId), nm = lc(u.name);
    const rank = id === q ? 0 : id.startsWith(q) ? 1 : nm.startsWith(q) ? 2 : nm.includes(q) || nm.replace(/\s+/g, "").includes(qNoSp) ? 3 : -1;
    if (rank >= 0) ppl.push({ rank, sortName: u.name, userId: u.id, name: u.name, employeeId: u.employeeId, department: u.department || "" });
  }
  // 课程：全部课程（程序）；包装程序显示课程标题；Lark 编号 c043 ↔ lark-c043
  const crs = [];
  for (const p of PROGRAMS) {
    const m = programMetaOf(p);
    const c = m.courseId ? getCourse(m.courseId) : null;
    const t1 = lc(c ? c.title : p.title), t2 = lc(c ? c.title_zh : p.title_zh);
    const code = m.courseId && /^lark-c\d+$/i.test(m.courseId) ? m.courseId.toLowerCase() : "";
    const rank = t1.startsWith(q) || (t2 && t2.startsWith(q)) ? 0 : t1.includes(q) || (t2 && t2.includes(q)) ? 1 : code && (code === q || code === "lark-" + q || code.slice(5) === q) ? 2 : -1;
    if (rank >= 0) crs.push({ rank, sortName: c ? c.title : p.title, id: p.id, courseId: m.courseId, title: c ? c.title : p.title, title_zh: (c ? c.title_zh : p.title_zh) || null, category: m.category, enrollType: m.enrollType, mode: m.mode, status: m.status });
  }
  // 部门：范围内的部门选项（与 /api/admin/dept-tree 同源）
  const sc = scopePredicate(user);
  const pool = store.listUsers().filter((u) => !LC.isServiceAccount(u) && (!sc || sc(u)));
  const opts = ov.df.options(pool, {}).options || [];
  const dps = [];
  for (const o of opts) {
    if (!o || !o.id || o.id === "__none") continue;
    const nm = lc(o.name), path = lc(o.path);
    const rank = nm.startsWith(q) ? 0 : nm.includes(q) ? 1 : path.includes(q) ? 2 : -1;
    if (rank >= 0) dps.push({ rank, sortName: o.name, id: o.id, name: o.name, path: o.path || o.name });
  }
  const a = take(crs), b = take(ppl), c = take(dps);
  return { q, tooShort: false, courses: a.items, people: b.items, depts: c.items, more: { courses: a.more, people: b.more, depts: c.more } };
}
// ---------- 按部门 × 职级圈人（第三批 8.6，2026-10-08）----------
// 课程指派（POST /api/admin/assignments/bulk）与培养项目加学员（POST /api/admin/tprojects/:id/members）都可以不传 userIds，
// 改传 select：{ depts?: [部门 id…]（含下级，"__none" / "name:" 同部门筛选）, grades?: [职级代码…], gradeFrom?, gradeTo? }。
// 预览 GET /api/admin/assignments/preview 用同一个解析。口径：
//   只含在职的人（账号可用、未离职、不是纯服务账号）且在数据范围内；部门与职级同时给出时取交集；
//   给了职级条件时，没有职级的人不纳入，人数单独回 noGrade；职级段 gradeFrom–gradeTo：两端都在职级体系里且同一通道 →
//   按体系的 level 取闭区间；否则两端须同字母前缀（如 PD1–PD3）按数字取闭区间；都不满足 → 400 bad_grade_range。
const SELECT_MAX_DEPTS = 50, SELECT_MAX_GRADES = 100;
// 前端按部门 × 职级在名册里圈好人、照常传 userIds 时，另带 criteria { depts, grades, gradeFrom, gradeTo } 只用于审计（第三批 8.6）
function auditCriteria(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const out = { depts: listParam(c.depts, SELECT_MAX_DEPTS), grades: listParam(c.grades, SELECT_MAX_GRADES).map((g) => g.slice(0, 20)) };
  if (c.gradeFrom) out.gradeFrom = String(c.gradeFrom).slice(0, 20);
  if (c.gradeTo) out.gradeTo = String(c.gradeTo).slice(0, 20);
  return out.depts.length || out.grades.length || out.gradeFrom || out.gradeTo ? out : null;
}
const listParam = (v, max) => (Array.isArray(v) ? v : String(v == null ? "" : v).split(",")).map((x) => String(x).trim()).filter(Boolean).slice(0, max);
function gradeSortKey() {
  const order = new Map(jobGrades().map((r, i) => [String(r.rank).toUpperCase(), i]));
  return (a, b) => { const x = order.has(a) ? order.get(a) : 1e6, y = order.has(b) ? order.get(b) : 1e6; return x - y || a.localeCompare(b); };
}
function parseGradeSelect(user, raw) {
  const sel = raw && typeof raw === "object" ? raw : {};
  const deptIds = listParam(sel.depts, SELECT_MAX_DEPTS);
  const grades = listParam(sel.grades, SELECT_MAX_GRADES).map((g) => g.toUpperCase());
  const gFrom = String(sel.gradeFrom || "").trim().toUpperCase(), gTo = String(sel.gradeTo || "").trim().toUpperCase();
  if (!deptIds.length && !grades.length && !gFrom && !gTo)
    return { error: { status: 400, body: { error: "Choose at least one department or job grade.", error_zh: "请至少选择一个部门或职级。", code: "empty_select" } } };
  let deptMatch = null;
  if (deptIds.length) {
    const df = deptFilterFor(user);
    const ms = deptIds.map((id) => df.parse(id)).filter(Boolean);
    if (!ms.length) return { error: { status: 400, body: { error: "Department not found or outside your data scope.", error_zh: "部门不存在或不在你的数据范围内。", code: "bad_dept" } } };
    deptMatch = (name) => ms.some((m) => m(name));
  }
  let gradeMatch = null;
  if (grades.length || gFrom || gTo) {
    const set = new Set(grades);
    let inRange = null;
    if (gFrom || gTo) {
      const a = gFrom || gTo, b = gTo || gFrom;
      const cat = new Map(jobGrades().map((r) => [String(r.rank).toUpperCase(), r]));
      const ca = cat.get(a), cb = cat.get(b);
      if (ca && cb && ca.track === cb.track && Number.isFinite(Number(ca.level)) && Number.isFinite(Number(cb.level))) {
        const lo = Math.min(Number(ca.level), Number(cb.level)), hi = Math.max(Number(ca.level), Number(cb.level));
        inRange = (g) => { const r = cat.get(g); return !!r && r.track === ca.track && Number(r.level) >= lo && Number(r.level) <= hi; };
      } else {
        const ma = /^([A-Z]+)(\d+)$/.exec(a), mb = /^([A-Z]+)(\d+)$/.exec(b);
        if (!ma || !mb || ma[1] !== mb[1]) return { error: { status: 400, body: { error: "The job grade range must be within one grade family (e.g. P1–P3).", error_zh: "职级段须在同一职级序列内（如 P1–P3）。", code: "bad_grade_range" } } };
        const lo = Math.min(+ma[2], +mb[2]), hi = Math.max(+ma[2], +mb[2]);
        inRange = (g) => { const m = /^([A-Z]+)(\d+)$/.exec(g); return !!m && m[1] === ma[1] && +m[2] >= lo && +m[2] <= hi; };
      }
    }
    gradeMatch = (g) => set.has(g) || (!!inRange && inRange(g));
  }
  return { deptMatch, gradeMatch, echo: { depts: deptIds, grades, gradeFrom: gFrom || null, gradeTo: gTo || null } };
}
// → { users: 圈中的人, noGrade: 部门条件内但没有职级、因此不纳入的人数 }；opts.excludeAdmins：培养项目学员不收后台账号
function resolveGradeSelect(user, parsed, opts = {}) {
  const sc = scopePredicate(user);
  const out = [];
  let noGrade = 0;
  for (const u of store.listUsers()) {
    if (LC.isServiceAccount(u) || u.active === 0 || u.empStatus === "exited") continue;
    if (opts.excludeAdmins && u.role === "admin") continue;
    if (sc && !sc(u)) continue;
    if (parsed.deptMatch && !parsed.deptMatch(u.department)) continue;
    if (parsed.gradeMatch) {
      const g = String(u.jobLevel || "").trim().toUpperCase();
      if (!g) { noGrade++; continue; }
      if (!parsed.gradeMatch(g)) continue;
    }
    out.push(u);
  }
  return { users: out, noGrade };
}
// 预览可选的职级：范围内在职的人用到的职级代码，按职级体系顺序
function gradeOptionsFor(user) {
  const sc = scopePredicate(user);
  const n = new Map();
  for (const u of store.listUsers()) {
    if (LC.isServiceAccount(u) || u.active === 0 || u.empStatus === "exited" || (sc && !sc(u))) continue;
    const g = String(u.jobLevel || "").trim().toUpperCase();
    if (g) n.set(g, (n.get(g) || 0) + 1);
  }
  return [...n.keys()].sort(gradeSortKey()).map((g) => ({ grade: g, count: n.get(g) }));
}
// 第四批 6.1：能进卷的题 = 已知且已开放的题型；新题型另要求题型数据完整（QT.isUsable，坏 JSON 读出来的空题不进卷）。
// 旧四种题型照旧全收（与改动前的题量逐一相同）。unsupported（更新版本写入、本版本不认识的题型）一律跳过。
const LEGACY_QTYPES = new Set(["mcq", "multi", "fill", "open"]);
function examUsable(q) {
  return !!q && !q.unsupported && QT.isEnabled(q.type) && (LEGACY_QTYPES.has(q.type) || QT.isUsable(q));
}
// An exam's question pool: every question tagged to one of its linked courses.
function examQuestions(exam) {
  const ids = new Set(store.getExamCourseIds(exam.id));
  return store.listQuestions().filter((q) => ids.has(q.courseId) && examUsable(q));
}
// An exam unlocks when every linked course is fully complete (falls back to
// the whole program when an exam has no explicit course links).
function examUnlockedFor(userId, exam) {
  let courseIds = store.getExamCourseIds(exam.id);
  if (!courseIds.length) {
    const p = getProgram(exam.programId);
    courseIds = p ? p.courseIds : [];
  }
  for (const cid of courseIds) {
    const c = getCourse(cid);
    if (!c) continue;
    if (progressPercent(userId, c) < 100) return false;
  }
  return true;
}
// Client-safe copy of an attempt's questions: no accepted answers, no rubrics,
// no correct-option flags. 第四批 6.1：逐题型白名单（QT.clientQuestions → 各题型的 client()，不展开快照）；
// 每题分值 points 照旧随题下发（答题页题头显示）。
function clientQuestions(questions) {
  return QT.clientQuestions(questions);
}
// Employee's copy of a graded attempt's detail. When the exam hides answers,
// correct options / accepted answers / explanations are stripped (short answers
// keep their own feedback). The full detail stays stored for HR either way.
// 简答题一律经 clientOpenDetail：AI 建议分、评分依据、置信度与注入标记只给 HR（方案 2.5、4.3）
// 第四批 6.1：逐题型 learnerDetail（QT.clientDetail；简答仍经 clientOpenDetail，新题型在不显示答案时递归去掉 key 与讲解）
function clientDetail(detail, showAnswers) {
  return QT.clientDetail(detail, showAnswers);
}
// Server-authoritative deadline for a timed attempt (client countdown is
// display-only; submit re-checks the limit).
function attemptDeadline(attempt, timeLimitMinutes) {
  return timeLimitMinutes ? new Date(new Date(attempt.startedAt).getTime() + timeLimitMinutes * 60000).toISOString() : null;
}
// Employee-facing summary of one exam (no pool contents).
function examSummary(userId, exam) {
  const best = store.bestExamAttempt(userId, exam.id);
  const mine = store.listUserExamAttempts(userId, exam.id); // newest first
  const used = mine.length;
  // `best` is the HIGHEST-scoring attempt, which is not the one the cooldown runs
  // from. Without the latest attempt's timestamp the client could not tell that a
  // retake is still locked, so "Start exam" stayed clickable until /exam/start
  // answered 400 three screens later. retryAt may be in the PAST (cooldown已过) —
  // the client compares it with now rather than trusting its presence.
  const last = mine[0] || null;
  const lastAttemptAt = last ? last.submittedAt : null;
  const retryAt = last && exam.retakeCooldownHours
    ? new Date(new Date(last.submittedAt).getTime() + exam.retakeCooldownHours * 3600 * 1000).toISOString()
    : null;
  return {
    id: exam.id, title: exam.title, title_zh: exam.title_zh,
    // F58：HR 填写的考前须知（纯文本；员工端按界面语言取、该语言为空时取另一种语言，显示在系统固定须知之后）
    preNotice: exam.preNotice || null, preNotice_zh: exam.preNotice_zh || null,
    courseIds: store.getExamCourseIds(exam.id),
    passingScore: exam.passingScore,
    // 固定题目模式：题数按题目清单，不是抽题数。第四批：按题型分组计（客观题 / 简答 / 情境案例），itemCount = 小题总数（案例按小题展开）
    ...(() => { const f = fixedExamQuestions(exam); return f
      ? { mcqCount: f.filter((q) => QT.groupOf(q.type) === "objective").length, openCount: f.filter((q) => q.type === "open").length, caseCount: f.filter((q) => q.type === "case").length, itemCount: f.reduce((n, q) => n + QT.itemCount(q), 0) }
      : { mcqCount: exam.mcqCount, openCount: exam.openCount, caseCount: exam.caseCount || 0, itemCount: null }; })(),
    // 第四批 10.6：选项顺序（false = 固定，按题库顺序）；新题型按比例给分
    shuffleOptions: exam.shuffleOptions !== false, partialCredit: exam.partialCredit !== false,
    mode: exam.mode || "random",
    // 每题分值：考前说明显示卷面总分区间与题型分值；旧口径两者为 null
    typePoints: examTypePoints(exam), multiPartial: exam.multiPartial !== false, pointsRange: examPointsRange(exam),
    timeLimitMinutes: exam.timeLimitMinutes,
    maxAttempts: exam.maxAttempts, retakeCooldownHours: exam.retakeCooldownHours,
    showAnswersAfterExam: exam.showAnswersAfterExam,
    recordBlur: exam.recordBlur === undefined ? 1 : exam.recordBlur,
    attemptsUsed: used,
    unlocked: examUnlockedFor(userId, exam),
    best: best ? { percent: best.percent, passed: best.passed, submittedAt: best.submittedAt } : null,
    lastAttemptAt,
    retryAt,
    // 结论待定（评分中 / 待 HR 复核）的答卷：未结案前不能开始下一次（AI 治理方案 2.5；/api/exam/start 同口径回 409）
    pending: (() => { const pa = store.pendingExamAttempt(userId, exam.id); return pa ? { attemptId: pa.id, gradingStatus: pa.gradingStatus } : null; })(),
    // 第三批 10.9（2026-10-08）：考前说明只列本场实际出现的题型、写成「单选 20 题 × 1 分」，新老考试同一组规则（examTypeSummary）
    ...examTypeSummary(exam),
  };
}
// 考前说明的题型构成与卷面总分（第三批 10.9）：typeSummary = [{ type, count, points }]，只列本场会出现的题型（mcq/multi/fill/open 顺序）；
//   count：固定题目 = 卷面上的题数；随机抽题时客观题按题库里客观题的题型分布浮动 → 题库里只有一种客观题型时为确定值，否则 null；
//   points：该题型每题分值（题目自身分值 > 考试的题型默认分值 > 旧口径：客观题 1 分、简答题 maxPoints/10），同题型分值不一致时为 null。
// totalPoints：卷面总分，确定时为数字，随机抽题且分值不一致时为 { min, max }；旧考试（typePoints 为空）也按旧口径算出来。
// 第四批：题型顺序改按注册表目录（QT.order()：单选、多选、判断、填空、多空、排序、匹配、分类、简答、案例；旧四种的相对顺序不变）。
// 情境案例一行：{ type:"case", count: 组数, items: 小题总数（随机抽题且各组小题数不同时为 null）, points: 每组分值（不一致时 null） }，
// 每组分值 = 各小题分值之和（casePointsOf）。客观题池 = 全部客观题型（与 /api/exam/start 抽题同一分组）。
function examTypeSummary(exam) {
  const ptsOf = (q) => { if (q.type === "case") return casePointsOf(exam, q); const v = questionPoints(exam, q); return v != null ? v : q.type === "open" ? (Number(q.maxPoints) || 10) / 10 : 1; };
  const one = (vals) => (vals.length && vals.every((v) => v === vals[0]) ? vals[0] : null);
  // F56（10/9）：固定题目、同题型分值不一致（points 为 null）时另带 breakdown: [{ points, count }]（按分值升序），
  // 考前说明写成「判断 2 题，共 3 分（1 分 × 1、2 分 × 1）」。可选字段：分值一致或随机抽题（题数不定）时不带，旧字段不变。
  const mix = (vals) => {
    if (!vals.length || one(vals) != null) return null;
    const m = new Map();
    for (const v of vals) { const k = Math.round(v * 10) / 10; m.set(k, (m.get(k) || 0) + 1); }
    return [...m].sort((a, b) => a[0] - b[0]).map(([points, count]) => ({ points, count }));
  };
  const fixed = fixedExamQuestions(exam);
  if (fixed) {
    const typeSummary = QT.order().map((t) => {
      const qs = fixed.filter((q) => q.type === t);
      if (!qs.length) return null;
      const pts = qs.map(ptsOf), breakdown = mix(pts);
      const row = t === "case" ? { type: t, count: qs.length, items: qs.reduce((n, q) => n + QT.itemCount(q), 0), points: one(pts) } : { type: t, count: qs.length, points: one(pts) };
      if (breakdown) row.breakdown = breakdown;
      return row;
    }).filter(Boolean);
    return { typeSummary, totalPoints: Math.round(fixed.reduce((s, q) => s + ptsOf(q), 0) * 10) / 10 };
  }
  const pool = examQuestions(exam);
  const objPool = pool.filter((q) => QT.groupOf(q.type) === "objective"), opnPool = pool.filter((q) => q.type === "open"), casePool = pool.filter((q) => q.type === "case");
  const nObj = Math.min(exam.mcqCount || 0, objPool.length), nOpn = Math.min(exam.openCount || 0, opnPool.length), nCase = Math.min(exam.caseCount || 0, casePool.length);
  const objTypes = QT.order().filter((t) => QT.groupOf(t) === "objective" && objPool.some((q) => q.type === t));
  const typeSummary = [];
  if (nObj) for (const t of objTypes) typeSummary.push({ type: t, count: objTypes.length === 1 ? nObj : null, points: one(objPool.filter((q) => q.type === t).map(ptsOf)) });
  if (nOpn) typeSummary.push({ type: "open", count: nOpn, points: one(opnPool.map(ptsOf)) });
  if (nCase) { const per = one(casePool.map((q) => QT.itemCount(q))); typeSummary.push({ type: "case", count: nCase, items: per != null ? per * nCase : null, points: one(casePool.map(ptsOf)) }); }
  const take = (arr, n, dir) => arr.slice().sort((a, b) => (dir === "min" ? a - b : b - a)).slice(0, n).reduce((x, y) => x + y, 0);
  const o = objPool.map(ptsOf), p = opnPool.map(ptsOf), k = casePool.map(ptsOf);
  const r1 = (x) => Math.round(x * 10) / 10;
  const min = r1(take(o, nObj, "min") + take(p, nOpn, "min") + take(k, nCase, "min")), max = r1(take(o, nObj, "max") + take(p, nOpn, "max") + take(k, nCase, "max"));
  return { typeSummary, totalPoints: min === max ? min : { min, max } };
}
// 学员课程列表的考试状态（第三批 5.4 / 10.8，2026-10-08）：已学完但考试未通过 → 「待补考」，并给剩余次数与何时可以再考。
// 返回 { learnStatus, attemptsLeft, retakeAvailableAt, retakeExamId, retake }：
//   learnStatus：done | result_pending（成绩待定）| retake_pending（未通过、还能再考，含重考等待期中）| failed（未通过且次数已用完）|
//                exam_pending（学完、还没考）| in_progress | not_started；
//   attemptsLeft：null = 不限次数，0 = 用完；retakeAvailableAt：重考等待期结束时间（ISO），null = 现在就能考；
//   retake：{ examId, state: ready | waiting | usedUp | pending, retryAt, attemptsLeft }（设计 §4.8；没有未通过 / 待定的考试时为 null）。
// 单场考试的补考状态（CX-003 复测修正，2026-10-09）：与 learnerExamState 同一口径，但不看课程整体是否 done ——
// 多场考试的课程里别的考试已通过时，这一场未通过的仍要能「去补考」。{ examId, state ready|waiting|usedUp|pending, retryAt, attemptsLeft }
function examRetakeState(userId, e) {
  const pa = store.pendingExamAttempt(userId, e.id);
  const mine = store.listUserExamAttempts(userId, e.id);
  const used = mine.length, last = mine[0] || null, nowT = nowMs();
  const retryT = last && e.retakeCooldownHours ? new Date(last.submittedAt).getTime() + e.retakeCooldownHours * 3600 * 1000 : null;
  const left = e.maxAttempts ? Math.max(0, e.maxAttempts - used) : null;
  const state = pa ? "pending" : e.maxAttempts && used >= e.maxAttempts ? "usedUp" : retryT && retryT > nowT ? "waiting" : "ready";
  return { examId: e.id, state, retryAt: retryT && retryT > nowT ? new Date(retryT).toISOString() : null, attemptsLeft: left };
}
function learnerExamState(userId, p) {
  const progress = programProgress(userId, p).percent;
  const done = programDone(userId, p);
  const base = { attemptsLeft: null, retakeAvailableAt: null, retakeExamId: null, retake: null };
  if (done) return { learnStatus: "done", ...base };
  const nowT = nowMs();
  let pick = null;
  for (const e of publishedProgramExams(p.id)) {
    const pa = store.pendingExamAttempt(userId, e.id);
    const best = store.bestExamAttempt(userId, e.id);
    if (!pa && !(best && !best.passed)) continue;
    const mine = store.listUserExamAttempts(userId, e.id);
    const used = mine.length;
    const last = mine[0] || null;
    const retryT = last && e.retakeCooldownHours ? new Date(last.submittedAt).getTime() + e.retakeCooldownHours * 3600 * 1000 : null;
    const left = e.maxAttempts ? Math.max(0, e.maxAttempts - used) : null;
    const state = pa ? "pending" : e.maxAttempts && used >= e.maxAttempts ? "usedUp" : retryT && retryT > nowT ? "waiting" : "ready";
    pick = { examId: e.id, state, retryAt: retryT && retryT > nowT ? new Date(retryT).toISOString() : null, attemptsLeft: left };
    if (state === "pending") break;
    if (state !== "usedUp") break;   // 先找还能考的；全都用完才回 usedUp
  }
  if (pick) {
    const learnStatus = pick.state === "pending" ? "result_pending" : pick.state === "usedUp" ? "failed" : "retake_pending";
    return { learnStatus, attemptsLeft: pick.attemptsLeft, retakeAvailableAt: pick.retryAt, retakeExamId: pick.examId, retake: pick };
  }
  const hasExam = publishedProgramExams(p.id).length > 0;
  return { learnStatus: hasExam && progress >= 100 ? "exam_pending" : progress > 0 ? "in_progress" : "not_started", ...base };
}
// Default due date for a fresh assignment: program.defaultDueDays from today
// (date only, LOCAL day — a due date is a calendar date HR and the employee
// both read in Manila time; the UTC day made it one day short before 08:00).
function defaultDueAt(program) {
  const days = program.defaultDueDays || 30;
  return dateLocalOffset(days);
}
// Assign courses to a (usually new) user. `ids` undefined → the legacy
// default, every published mandatory course; an array (possibly empty) →
// exactly what HR picked in the create/import dialog.
function assignPrograms(userId, ids) {
  const chosen = Array.isArray(ids)
    ? ids.map(getProgram).filter((p) => p && (p.status || "published") === "published")
    : PROGRAMS.filter((p) =>
        (p.status || "published") === "published" && (p.enrollType || "mandatory") !== "elective");
  const out = [];
  for (const p of chosen) {
    const due = defaultDueAt(p);
    store.setAssignment(userId, p.id, due);
    out.push({ programId: p.id, dueAt: due });
  }
  return out;
}
// ---------- training projects (Phase B) ----------
// Structure lives as a JSON doc (content kind 'tproject'): { id, code, title(s),
// category, sponsor, ownerId, status, cohorts:[{ id, name, startAt, endAt,
// capacity, open, classes:[{id,name,headId}], phases:[{ id, name(s), activities:
// [{ id, type: course|exam|offline|online (+ legacy program, read-only), refId?,
//    title(s)?, required, dueAt?, startAt?, location?, trainerId? }] }] }] }.
// The five activity categories (负责人 2026-10-06): 线上课程 and 线下课程 are both
// type course — online vs in-person is DERIVED from the referenced course's mode;
// 线上活动 = type online { title(s), url, startAt, durationMin, completion
// click|self|trainer, trainerId (trainer mode only), dueAt }; 线下活动 = offline;
// 结业考试 = exam. Legacy program activities still render but can't be created.
// Per-person state is relational: online completion lives in activity_state as
// status completed|excused (offline attendance: attended|late|excused|absent).
function getTProject(id) {
  return TPROJECTS.find((p) => p.id === id) || null;
}
function tpCohort(doc, cohortId) {
  return (doc.cohorts || []).find((c) => c.id === cohortId) || null;
}
function tpActivities(cohort) {
  const out = [];
  for (const ph of cohort.phases || []) for (const a of ph.activities || []) out.push({ ...a, phaseId: ph.id });
  return out;
}
// Program ids a cohort's content-referencing activities (course / exam / legacy
// program) reference, for auto-assignment. Online activities (type 'online')
// reference nothing and assign nothing.
// A course's owning program comes from the reverse index (its invisible
// wrapper) — the legacy `course.programId` field is undefined on every course
// created after packages were retired, which used to silently assign nothing.
// 推导本身在 modules/learning/completion.js（cohortProgramIds）：「退训后不再提醒」的判定（定时脚本也用）
// 必须与这里派课用的是同一份推导（2026-10-07）。
function tpProgramIds(cohort) {
  return LC.cohortProgramIds(cohort, { getCourse, programsOfCourse: programsContaining, getExam: (id) => store.getExam(id) });
}
// CX-120：项目活动的截止日是学习截止日的唯一口径。一个活动可能通过
// course wrapper 或 exam 指向 program；同一 program 被多个活动引用时取
// 最早的明确截止日，避免较晚活动掩盖先到期的学习任务。
function tpProgramDueMap(cohort) {
  const due = new Map();
  const put = (pid, value) => {
    if (!pid || !value) return;
    const day = String(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    if (!due.has(pid) || day < due.get(pid)) due.set(pid, day);
  };
  for (const a of tpActivities(cohort)) {
    if (!a || !a.refId || !a.dueAt) continue;
    if (a.type === "course") {
      for (const pid of programsContaining(a.refId, getCourse(a.refId))) put(pid, a.dueAt);
    } else if (a.type === "exam") {
      const exam = store.getExam(a.refId);
      if (exam) put(exam.programId, a.dueAt);
    } else if (a.type === "program") put(a.refId, a.dueAt);
  }
  return due;
}
// Joining a cohort assigns every referenced (published) program so the normal
// learning/exam flows just work. Activity due date wins; cohort end/default is
// only a fallback. Existing cohort assignments are updated too, so editing an
// activity deadline cannot leave the learner assignment on an older date.
function tpAssignPrograms(userId, cohort) {
  const dueByProgram = tpProgramDueMap(cohort);
  for (const pid of tpProgramIds(cohort)) {
    const p = getProgram(pid);
    if (!p || (p.status || "published") !== "published") continue;
    store.setAssignment(userId, pid, dueByProgram.get(pid) || cohort.endAt || defaultDueAt(p));
  }
}
// Everything that would break if this course disappeared. Used to refuse
// destructive deletes (and to show HR exactly what is in the way).
function courseUsage(courseId) {
  const projects = [];
  for (const doc of TPROJECTS) {
    for (const cohort of doc.cohorts || []) {
      const acts = tpActivities(cohort).filter((a) => a.type === "course" && a.refId === courseId);
      if (!acts.length) continue;
      const learners = store.listProjectMembers(doc.id)
        .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === cohort.id).length;
      projects.push({ id: doc.id, title: doc.title, title_zh: doc.title_zh || null, cohort: cohort.name, activities: acts.length, learners });
    }
  }
  const pids = programsContaining(courseId, getCourse(courseId));
  const exams = [];
  for (const pid of pids) for (const e of store.listProgramExams(pid)) exams.push({ id: e.id, title: e.title, title_zh: e.title_zh || null, status: e.status });
  const learnersWithProgress = store.countCourseProgressUsers(courseId);
  let attempts = 0;
  for (const e of exams) attempts += store.listExamAttempts(e.id).length;
  const assigned = pids.reduce((n, pid) => n + store.countProgramAssignees(pid), 0);
  return {
    projects, exams, learnersWithProgress, attempts, assigned,
    // "Blocking" = deleting would destroy history or strand a cohort.
    blocking: projects.length > 0 || learnersWithProgress > 0 || attempts > 0,
  };
}
// Course library tag (负责人 2026-10-06「不清楚哪些是项目的、哪些不是项目的」): for every
// course, the 培养项目 whose activities reference it — same rule as courseUsage
// (type "course" activities by refId), but ONE pass over the cached TPROJECTS for
// the whole list and no per-course store queries, so GET /api/admin/content stays
// cheap. A project counts once however many cohorts / activities use the course.
// Order: active projects first (running, planning, closing), then closed / other,
// stored order within a rank. Read-only: the course PUT strips the field.
const TP_TAG_RANK = { running: 0, planning: 1, closing: 2, draft: 3, closed: 4 };
function courseProjectsIndex() {
  const idx = new Map();
  for (const doc of TPROJECTS) {
    const seen = new Set();
    for (const cohort of doc.cohorts || []) {
      for (const a of tpActivities(cohort)) {
        if (a.type !== "course" || !a.refId || seen.has(a.refId)) continue;
        seen.add(a.refId);
        if (!idx.has(a.refId)) idx.set(a.refId, []);
        idx.get(a.refId).push({ id: doc.id, title: doc.title || "", title_zh: doc.title_zh || null, status: doc.status || null });
      }
    }
  }
  const rank = (p) => TP_TAG_RANK[p.status] ?? 5;
  for (const list of idx.values()) list.sort((a, b) => rank(a) - rank(b));
  return idx;
}
// A course that only becomes assignable later (draft → published, or created
// after people were already enrolled) must reach the cohorts referencing it —
// otherwise learners open the activity and get "course not found".
function tpSyncCourseAssignments(courseId) {
  let n = 0;
  for (const doc of TPROJECTS) {
    for (const cohort of doc.cohorts || []) {
      if (!tpActivities(cohort).some((a) => a.type === "course" && a.refId === courseId)) continue;
      for (const m of store.listProjectMembers(doc.id)) {
        if (m.role !== "learner" || m.state !== "active" || m.cohortId !== cohort.id) continue;
        tpAssignPrograms(m.userId, cohort);
        n++;
      }
    }
  }
  return n;
}
// Everything one activity can say about itself, from ONE round of queries:
// whether it is done, how far along it is, and (for an exam) the mark.
// These used to be three separate passes — tpActivityDone, tpActivityPercent and
// an exam block in the route — so a single exam activity hit bestExamAttempt three
// times and a package hit programProgress twice (and that one queries every course
// inside it). /api/me/tprojects/:id is called every time an employee opens a
// project page, so the duplication was paid on every visit.
// The `done` rules below are the old ones except one change of rule: excused
// (请假) no longer counts as done for offline activities and in-person courses
// (owner decision 2026-10-06; ATTENDED_STATES). Only the fetching is shared.
function tpActivityProgress(userId, a, states) {
  const clamp = (x) => Math.max(0, Math.min(100, Math.round(x || 0)));
  if (a.type === "offline") {
    const st = states[a.id];
    const done = !!st && ATTENDED_STATES.includes(st.status);   // 请假不算完成（负责人 2026-10-06）
    return { done, percent: done ? 100 : 0 };
  }
  if (a.type === "exam") {
    const b = store.bestExamAttempt(userId, a.refId);
    const passed = !!(b && b.passed);
    // The score is kept apart from the percent: a passed exam is 100% done while
    // the mark it was passed with may be 62.
    return { done: passed, percent: passed ? 100 : (b ? clamp(b.percent) : 0), examScore: b ? Math.round(b.percent) : null, examPassed: passed };
  }
  if (a.type === "course") {
    const c = getCourse(a.refId);
    if (!c) return { done: false, percent: 0 }; // broken ref: no progress possible
    // In-person course referenced by a project: attendance IS completion.
    if ((c.mode || "online") === "offline") {
      // 与 progressPercent 对线下课的规则相同（出勤 / 迟到即完成；请假不算，需补课，负责人 2026-10-06），顺带带出出勤状态：
      // 出勤记在 course:<id> 上而不在活动行，学员端据此显示「已请假」「迟到」，不再一律「已签到」。
      const st = courseAttendance(userId, c.id);
      const done = ATTENDED_STATES.includes(st);
      return { done, percent: done ? 100 : 0, state: st };
    }
    if (!c.modules.length) return { done: false, percent: 0 };
    const doneMap = userProgress(userId, c.id);
    // Counting CURRENT modules, not progress rows: progressPercent() divides the
    // number of rows by the module count, and a course that was re-cut can hold
    // rows for modules that no longer exist — which would read 100% on a course
    // whose `done` rule (every current module finished) is still false.
    const n = c.modules.filter((m) => doneMap[m.id]).length;
    return { done: n === c.modules.length, percent: clamp((n / c.modules.length) * 100) };
  }
  if (a.type === "program") {
    const p = getProgram(a.refId);
    if (!p) return { done: false, percent: 0 };
    const roll = programProgress(userId, p);
    // 进度未满 100% 一律未完成（与原规则一致）；满了再按 programDone 看考试
    const done = roll.percent >= 100 && programDone(userId, p);
    // A package with a published exam can have every module finished and still not
    // be done. Reporting 100% next to "not finished" reads as a bug, so the content
    // roll-up stops one short until the exam is passed.
    return { done, percent: done ? 100 : Math.min(clamp(roll.percent), 99) };
  }
  // 线上活动：完成行记在本活动 id 上（只有 completed 算完成，请假不算）；states 来自 tpUserStates，不另查库。
  if (a.type === "online") {
    const st = states[a.id];
    const done = !!st && TP_ONLINE_DONE.includes(st.status);
    return { done, percent: done ? 100 : 0 };
  }
  return { done: false, percent: 0 };
}
// Kept as the boolean-only entry point: the admin analytics path (project
// dashboard) only ever needs `done`, and calling it through here keeps that call
// site unchanged.
function tpActivityDoneOnly(userId, a, states) {
  return tpActivityProgress(userId, a, states).done;
}
// Per-user view of a cohort: phases with per-activity done flags. Gate rule is
// per phase: 'completion' (default — every required activity of the previous
// phase done) or 'time' (opens on the phase's startAt date, independent of
// earlier progress; no startAt = open immediately).
// A learner's activity states for one cohort. Keyed by activity id — the same
// key the roll-call (listActivityStates) reads — so completion, the funnel and
// "x/N 完成" always agree with the attendance list, including rows whose
// projectId column doesn't match (those used to show as present in 签到管理 yet
// count as not done everywhere else). The projectId lookup is kept and merged
// so nothing that counted before stops counting.
function tpUserStates(userId, projectId, cohort) {
  return {
    ...store.getUserActivityStates(userId, projectId),
    ...store.getUserStatesForActivities(userId, tpActivities(cohort).map((a) => a.id)),
  };
}
function tpPhaseView(userId, projectId, cohort) {
  const states = tpUserStates(userId, projectId, cohort);
  // LOCAL day: ph.startAt is a local calendar date, so a UTC "today" kept a
  // phase that starts today locked until 08:00 Manila time.
  const today = todayLocal();
  let prevComplete = true;
  const phases = [];
  for (const ph of cohort.phases || []) {
    const unlocked = (ph.gateMode === "time")
      ? (!ph.startAt || String(ph.startAt).slice(0, 10) <= today)
      : prevComplete;
    // An activity whose referenced course/exam no longer exists can never be
    // completed. Flag it and keep it OUT of the required-set, otherwise the
    // phase (and every phase after it) stays locked forever with no clue why.
    const acts = (ph.activities || []).map((a) => {
      const view = tpActivityView(a);
      // done / percent / exam mark all come out of one call — see tpActivityProgress.
      const prog = tpActivityProgress(userId, a, states);
      return {
        ...a, broken: !!view.broken, done: prog.done, percent: prog.percent,
        examScore: prog.examScore === undefined ? null : prog.examScore,
        examPassed: prog.examPassed === undefined ? null : prog.examPassed,
        state: (states[a.id] || {}).status || prog.state || null,
      };
    });
    const gating = acts.filter((a) => a.required !== false && !a.broken);
    const complete = acts.length > 0 && gating.every((a) => a.done);
    phases.push({ id: ph.id, name: ph.name, name_zh: ph.name_zh || null, gateMode: ph.gateMode || "completion", startAt: ph.startAt || null, endAt: ph.endAt || null, unlocked, complete, activities: acts });
    prevComplete = complete;
  }
  return phases;
}
function tpProgressPercent(phases) {
  let req = 0, done = 0;
  // Broken references are excluded — they can never be done, and counting them
  // would peg every learner below 100% forever.
  for (const ph of phases) for (const a of ph.activities) if (a.required !== false && !a.broken) { req++; if (a.done) done++; }
  return req ? Math.round((done / req) * 100) : 0;
}
// Enrich an activity with the referenced object's display info + link targets.
function tpActivityView(a) {
  const v = { id: a.id, type: a.type, required: a.required !== false, dueAt: a.dueAt || null, startAt: a.startAt || null, location: a.location || null, title: a.title || null, title_zh: a.title_zh || null, refId: a.refId || null };
  if (a.type === "program") { const p = getProgram(a.refId); if (p) { v.title = v.title || p.title; v.title_zh = v.title_zh || p.title_zh; v.programId = p.id; } }
  if (a.type === "course") {
    const c = getCourse(a.refId);
    if (c) {
      v.title = v.title || c.title;
      v.title_zh = v.title_zh || c.title_zh;
      v.courseId = c.id;
      v.programId = programsContaining(c.id, c)[0] || c.programId || null;
      // Delivery details so the employee UI can tell an in-person session
      // from self-paced content (and offer check-in instead of "study").
      v.mode = c.mode || "online";
      v.sessionAt = c.sessionAt || null;
      v.location = v.location || c.location || null;
      v.sessionNote = c.sessionNote || null;
      v.trainerId = c.trainerId || null;
      v.courseStatus = c.status || "published";
    } else v.broken = true; // referenced course is gone
  }
  if (a.type === "exam") {
    const e = store.getExam(a.refId);
    if (e) { v.title = v.title || e.title; v.title_zh = v.title_zh || e.title_zh; v.examId = e.id; v.programId = e.programId; }
    else v.broken = true;
  }
  if (a.type === "program" && !getProgram(a.refId)) v.broken = true;
  // 线上活动：链接只认 http(s)，完成方式缺省 self，指定讲师只在「讲师或 HR 登记」方式下有效。
  if (a.type === "online") {
    v.url = TP_URL_RE.test(String(a.url || "")) ? String(a.url) : null;
    v.durationMin = Number.isInteger(a.durationMin) && a.durationMin > 0 ? a.durationMin : null;
    v.completion = TP_COMPLETION_MODES.includes(a.completion) ? a.completion : "self";
    v.trainerId = v.completion === "trainer" ? (a.trainerId || null) : null;
  }
  // 五类活动的统一分类词（服务端与各端共用）：课程活动按所引用课程的 mode 现算线上 / 线下，
  // 引用的课程已不存在时为 null。
  v.category = a.type === "offline" ? "offline_activity"
    : a.type === "online" ? "online_activity"
    : a.type === "exam" ? "exam"
    : a.type === "program" ? "program"
    : a.type === "course" ? (v.broken ? null : (v.mode === "offline" ? "offline_course" : "online_course"))
    : null;
  return v;
}
// PUT /api/admin/tprojects/:id 的活动结构校验（负责人 2026-10-06 五类活动）。逐个活动检查，
// 第一处不合格就返回 { error, error_zh, code }，全部通过返回 null。
// - 已有活动（同 id 在库里的文档中）不能改类型（type_locked）；线上活动也不能改完成方式（completion_locked）。
// - 新活动只能是 TP_CREATABLE_TYPES；旧 program 活动随文档原样回传可以，新建不行（type_retired）。
// - 新加的线上 / 线下活动不能用已被占用的 id（id_in_use），见下方 idInUse。
// - 只对线上活动做字段校验并就地规整；course / exam / offline 不加新校验，导入脚本与测试夹具的旧形状照常通过。
function tpCheckActivities(cohorts, prevDoc) {
  const prev = new Map();
  for (const c of (prevDoc && prevDoc.cohorts) || []) {
    for (const ph of (c && c.phases) || []) {
      for (const a of (ph && ph.activities) || []) if (a && a.id) prev.set(String(a.id), a);
    }
  }
  const bad = (code, error, error_zh) => ({ error, error_zh, code });
  // 线上活动的完成、线下活动的签到都记在 activity_state 的 (活动 id, 学员) 行上，且按活动 id 合并
  // （tpUserStates 不看 projectId），所以这两类的 id 必须全库唯一。新加的线上 / 线下活动若用了别的
  // 培养项目已在用的 id、本次保存里重复的 id，或已删除活动仍留有记录的 id（删掉再同 id 加回，可绕过
  // type_locked / completion_locked），一律拒绝。课程 / 考试活动不读活动行，不在此列（导入脚本按序号生成 id）。
  let usedElsewhere = null;
  const freshIds = new Set();
  const idInUse = (id) => {
    if (!usedElsewhere) {
      usedElsewhere = new Set();
      for (const d of TPROJECTS) {
        if (prevDoc && d.id === prevDoc.id) continue;
        for (const c of d.cohorts || []) for (const ph of (c && c.phases) || []) for (const x of (ph && ph.activities) || []) if (x && x.id) usedElsewhere.add(String(x.id));
      }
    }
    return usedElsewhere.has(id) || freshIds.has(id) || store.listActivityStates(id).length > 0;
  };
  for (const c of cohorts || []) {
    for (const ph of (c && c.phases) || []) {
      for (const a of (ph && ph.activities) || []) {
        if (!a || typeof a !== "object" || !a.id) return bad("bad_activity", "Every activity needs an id.", "每个活动都需要 id。");
        // 没有类型（或类型不是字符串）是数据不完整，不是「类型已停用」
        if (typeof a.type !== "string" || !a.type) return bad("bad_activity", "Every activity needs a type.", "每个活动都需要类型。");
        const before = prev.get(String(a.id));
        if (before && before.type !== a.type) {
          return bad("type_locked",
            `Activity "${a.title || a.id}": an existing activity's type can't be changed. Remove it and add a new one.`,
            `活动「${a.title_zh || a.title || a.id}」：已创建的活动不能更改类型，请删除后重新添加。`);
        }
        if (!before && !TP_CREATABLE_TYPES.includes(a.type)) {
          return bad("type_retired",
            "This activity type can no longer be added. Use an online course, in-person course, online activity, in-person activity or final exam.",
            "该活动类型已不能新建，请改用线上课程、线下课程、线上活动、线下活动或结业考试。");
        }
        if (!before && (a.type === "online" || a.type === "offline")) {
          const id = String(a.id);
          if (idInUse(id)) {
            return bad("id_in_use",
              `Activity "${a.title || a.title_zh || id}": this ID is already used by another program or still holds records from a removed activity. Reload the page and add the activity again so it gets a new ID.`,
              `活动「${a.title_zh || a.title || id}」：该活动 ID 已被其他发展项目使用，或仍留有已删除活动的记录。请刷新页面后重新添加该活动，系统会生成新的 ID。`);
          }
          freshIds.add(id);
        }
        if (a.type !== "online") continue;
        const t = a.title == null ? "" : String(a.title).trim();
        const tz = a.title_zh == null ? "" : String(a.title_zh).trim();
        if (!t && !tz) return bad("title_required", "An online activity needs a name.", "线上活动须填写名称。");
        // 已有线上活动没传完成方式时沿用库里的；新活动缺省 self
        const was = before ? (TP_COMPLETION_MODES.includes(before.completion) ? before.completion : "self") : null;
        const mode = a.completion == null || a.completion === "" ? (was || "self") : a.completion;
        if (!TP_COMPLETION_MODES.includes(mode)) return bad("bad_completion", "Unknown completion method.", "完成方式无效。");
        // 完成方式创建后固定：学员已有的完成记录是按原方式产生的（负责人 2026-10-06）
        if (was && mode !== was) return bad("completion_locked", "An existing online activity's completion method can't be changed.", "已创建的线上活动不能更改完成方式。");
        const url = a.url == null ? "" : String(a.url).trim();
        if (url && (url.length > 2000 || !TP_URL_RE.test(url))) return bad("bad_url", "The link must start with http:// or https://.", "链接须以 http:// 或 https:// 开头。");
        if (!url && mode === "click") return bad("url_required", "Opening-the-link completion needs a link.", "「打开链接即完成」须填写链接。");
        let dur = null;
        if (a.durationMin != null && a.durationMin !== "") {
          // 接受数字或数字字符串（API 调用方可能传 "60"），统一存成 Number
          const n = typeof a.durationMin === "number" || typeof a.durationMin === "string" ? Number(a.durationMin) : NaN;
          if (!Number.isInteger(n) || n < 1 || n > 1440) return bad("bad_duration", "Duration must be 1–1440 minutes.", "时长须为 1–1440 分钟。");
          dur = n;
        }
        const startAt = a.startAt == null ? "" : String(a.startAt).trim();
        if (startAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startAt)) return bad("bad_datetime", "Start time must be YYYY-MM-DDTHH:mm.", "开始时间格式应为 YYYY-MM-DDTHH:mm。");
        const dueAt = a.dueAt == null ? "" : String(a.dueAt).trim();
        if (dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) return bad("bad_dates", "Due date must be YYYY-MM-DD.", "截止日期格式应为 YYYY-MM-DD。");
        a.title = t || tz;
        a.title_zh = tz || null;
        a.url = url || null;
        a.startAt = startAt || null;
        a.dueAt = dueAt || null;
        a.durationMin = dur;
        a.completion = mode;
        a.trainerId = mode === "trainer" ? (a.trainerId || null) : null;
        delete a.refId;
        delete a.location;
      }
    }
  }
  return null;
}
// Rotating offline check-in code: 6 digits per 1-minute window (previous
// window still accepted, so a code on the big screen stays valid ~2 minutes).
function checkinSlot() { return Math.floor(Date.now() / 60000); }
// CX-078（负责人 2026-10-11「只在当天」）：员工输码签到只在活动当天（马尼拉日，测试时钟生效）开放；活动没有排时间的不限制。
// 返回活动日期（不是当天时）或 null（可以签到）。讲师 / 班主任 / HR 登记出勤不受影响（补签照旧）。
function checkinNotToday(sessionAt) {
  const t = sessionAt ? Date.parse(sessionAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const day = manilaDay(t);
  return day === appealToday() ? null : day;
}
function checkinCode(activityId, slot) {
  const h = crypto.createHmac("sha256", store.getCheckinSecret()).update(activityId + "|" + slot).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, "0");
}
function tpNextCode() { return "TP-" + new Date().getFullYear() + "-" + String(TPROJECTS.length + 1).padStart(2, "0"); }

// ---------- derived roles: 讲师 / 班主任 / 经理 ----------
// People whose manager field points at me (→ 经理).
function directReports(userId) {
  return store.listUsers().filter((u) => u.managerId === userId && u.role !== "admin");
}
/* ---- P3 / D8: the whole reporting LINE, not just the direct reports ----
   directReports() above is one hop; D8 (RBAC-DESIGN.md §8.2) put a manager's
   visible range at the ENTIRE subtree beneath them, skip-levels included, so
   a director doing a headcount review no longer has to go through HR.
   Three properties this has to hold, all of them load-bearing:
   · CYCLE-PROOF. users.managerId is guarded against loops on PUT
     /api/admin/employees/:id (managerCycle) and, since 2026-09-25, on
     bulk-update (whole-batch reject) — but imported/legacy rows were never
     checked at all. A→B→A would spin a naive
     walk forever, so every node passes through `visited` exactly once.
   · O(n). One listUsers() scan builds a managerId → children adjacency map,
     then a BFS walks it. On the 925-person database that is one pass, not one
     scan per person (the shape directReports() would have had if called in a
     loop). isInReportingLine() reuses it rather than forking a second rule.
   · SYSTEM ACCOUNTS AND SELF EXCLUDED. role === "admin" rows never enter the
     adjacency map (same exclusion directReports() makes), and the root is
     pre-seeded into `visited` so a self-referencing row can't return itself.
   Inactive / exited people are deliberately KEPT (same as directReports): the
   team view labels them with `active`, and a leaver still belongs to the line
   the manager is accountable for.
   Returns [{ user, depth }] in breadth-first order; depth 1 = direct report. */
// The one BFS. `stopAtId` turns it into a single-subject check that returns as
// soon as it meets that person (and materializes no list); without it the whole
// line comes back. ONE resolver on purpose: a second copy of the rule is
// exactly how "the list hides them but the detail page doesn't" happens.
function walkReportingLine(managerUserId, stopAtId) {
  const empty = { list: [], hit: null };
  if (!managerUserId) return empty;
  const kids = new Map();
  for (const u of store.listUsers()) {
    if (u.role === "admin" || !u.managerId) continue;
    if (!kids.has(u.managerId)) kids.set(u.managerId, []);
    kids.get(u.managerId).push(u);
  }
  const list = [];
  const visited = new Set([managerUserId]); // the root itself is never a report
  let frontier = kids.get(managerUserId) || [];
  let depth = 1;
  while (frontier.length) {
    const next = [];
    for (const u of frontier) {
      if (visited.has(u.id)) continue; // loop, or two paths to the same person
      visited.add(u.id);
      if (stopAtId) { if (u.id === stopAtId) return { list, hit: { user: u, depth } }; }
      else list.push({ user: u, depth });
      for (const k of kids.get(u.id) || []) if (!visited.has(k.id)) next.push(k);
    }
    frontier = next;
    depth += 1;
  }
  return { list, hit: null };
}
function reportingSubtree(managerUserId) {
  return walkReportingLine(managerUserId, null).list;
}
// Single-subject form for the read-only profile route: { user, depth } or null.
function reportingLineEntry(managerUserId, targetUserId) {
  if (!managerUserId || !targetUserId || managerUserId === targetUserId) return null;
  return walkReportingLine(managerUserId, targetUserId).hit;
}
function isInReportingLine(managerUserId, targetUserId) {
  return !!reportingLineEntry(managerUserId, targetUserId);
}
// The chain from just below the viewing manager down to the target's own
// manager — what makes a skip-level row readable ("under 张三 → 李四"). Every
// hop is inside the caller's own subtree by construction, so it leaks nothing
// the caller cannot already see. `seen` keeps a looped chain finite.
function reportingChain(managerUserId, targetUser) {
  const chain = [];
  const seen = new Set([targetUser.id]);
  let cur = targetUser.managerId;
  while (cur && cur !== managerUserId && !seen.has(cur)) {
    seen.add(cur);
    const m = store.getUserById(cur);
    if (!m) break;
    chain.unshift({ name: m.name, position: m.position || null });   /* 第三批 9.1：员工端不下发工号 */ 
    cur = m.managerId;
  }
  return chain;
}
// ---------- 组织层级与 HoD（3+3 行为实践的 TMS 侧准备；规则与口径见 modules/core/org.js 文件头）----------
// 部门只用两层：一级部门（parentId 为空）与二级部门；三级及更深并入所属二级；直接挂在一级
// 部门的人在二级维度记为「本部」。HoD = 员工所属一级部门的负责人：部门页的「负责人」
// （departments.ownerId）在职则用它，未填或已离职则按汇报线推算。
//
// 不做进程内缓存：users 表的本进程写（改上级、调部门、离职）没有 epoch 信号（store.js 的
// SCOPE_EPOCH 只管 departments/roles），按 data_version 缓存会漏掉本进程自己的写 ——
// 那正是「刚调岗的人 HoD 还是旧的」这类错。一次快照 = listDepartments + listUsers + O(n)
// 推算（2026-09 在 925 人 / 272 部门的库副本上实测：推算本身约 2–3ms，整条 GET 接口约 15ms；
// 4,000 人规模的耗时与线性增长由 test/org-hod.test.js 断言）；一次要问很多人的调用方先
// orgSnapshot()，再把快照传给 hodOf / deptLevelsOf。
function orgSnapshot() {
  return orgLib.createOrgResolver(store.listDepartments(true), store.listUsers());
}
// 某部门名所属一级部门的 HoD：{ id, name, employeeId, department, position, direct, source,
// level1, level1Id }（source 为 "owner" 或 "derived"），或 null —— 部门为空/不在部门表、
// 一级部门已停用、需确认（多个顶端或汇报线成环）、无在职人员。
// 给 culture 适配层用：「周五真事」等档案内容的可见人是本人、HR、汇报线上所有上级（含 HoD）；
// HoD 可能不在汇报线上（负责人是部门页指定的），所以可见性要同时看 isInReportingLine 与这里。

// ---------- 组织绩效（迁移 95，负责人 2026-10-10）：一级部门负责人互评 + 季度组织绩效结果 ----------
// 一级部门与负责人取组织快照（deriveHods：部门页填的负责人，没填时按汇报线推算；需确认 / 无人时没有负责人）。
// 匿名：读接口不把答卷与评分人对应；评分人名单只用于「谁已提交」与催办。规则见 modules/performance/orgperf.js。
function orgDept1List() {
  return orgSnapshot().hods.items.map((it) => ({ dept1Id: it.deptId, dept1: it.deptName, memberCount: it.memberCount || 0, source: it.source, hod: it.hod && (it.source === "owner" || it.source === "derived") ? it.hod : null }));
}
function orgRatingOptions() {
  const o = perfRatingOptions();
  return Array.isArray(o) && o.length ? o : ["A+", "A", "B+", "B", "C", "D"];
}
function orgRoundView(r, withDetail, viewer) {
  const targets = store.listOrgTargets(r.id), raters = store.listOrgRaters(r.id);
  const base = { id: r.id, quarter: r.quarter, name: r.name, status: r.status, dueOn: r.dueOn, createdAt: r.createdAt, openedAt: r.openedAt, closedAt: r.closedAt, publishedAt: r.publishedAt || null, issueRequired: !!r.issueRequired,
    targetCount: targets.length, raterCount: raters.length, submittedCount: raters.filter((x) => x.submittedAt).length };
  if (!withDetail) return base;
  const submitted = raters.filter((x) => x.submittedAt).map((x) => x.dept1Id);
  const nameOf = new Map(targets.map((t) => [t.dept1Id, t.dept1]));
  return { ...base, dims: r.dims, issuePrompt: OP.ISSUE,
    raters: raters.map((x) => { const u = store.getUserById(x.raterId); return { dept1Id: x.dept1Id, dept1: nameOf.get(x.dept1Id) || null, raterId: x.raterId, name: u ? u.name : null, submittedAt: x.submittedAt || null, remindedAt: x.remindedAt || null }; })
      .sort((a, b) => String(a.dept1 || "").localeCompare(String(b.dept1 || ""))),
    summary: orgHideOwnRow(OP.summarize(targets, store.listOrgAnswers(r.id), submitted, r.dims), r, raters, viewer) };
}
// 代码审查 10/11：HR 后台的轮次汇总不受匿名门槛限制；但查看的人自己就是某被评部门的评分人或现任负责人时，
// 本部门那一行与员工端同口径 —— 评分部门少于 MIN_RATERS_VISIBLE 时不给分数与卡点（hidden: true），以免在提交过程中推出是谁给的分
function orgHideOwnRow(summary, r, raters, viewer) {
  if (!viewer) return summary;
  const own = new Set(raters.filter((x) => x.raterId === viewer.id).map((x) => x.dept1Id));
  for (const d of orgDept1List()) if (d.hod && d.hod.id === viewer.id) own.add(d.dept1Id);
  // 10/12：结果发布后负责人在员工端本来就能看到本部门得分，这里不再隐藏
  return summary.map((row) => (own.has(row.dept1Id) && !r.publishedAt && row.raters < OP.MIN_RATERS_VISIBLE
    ? { ...row, hidden: true, overall: null, issues: [], dims: Object.fromEntries(Object.keys(row.dims).map((k) => [k, { avg: null, n: 0 }])) }
    : row));
}
function hodOf(deptName, snap) {
  return (snap || orgSnapshot()).hodOf(deptName);
}
// ---------- 绩效流程 v2（迁移 65，2026-10-06 负责人决定）----------
// 配额：百分比按一级部门人数折算名额（向下取整），只对 A+ / A / B+ 设上限；C、D 合并为 C/D 档只作展示。
// 人数少于 REVIEW_QUOTA_MIN_HC 的部门超额只提示、不拦提交。
const REVIEW_DEFAULT_QUOTA = { "A+": 2, "A": 8, "B+": 15, "B": 70, "C/D": 5 };
const REVIEW_QUOTA_CAPPED = ["A+", "A", "B+"];
const REVIEW_QUOTA_MIN_HC = 10;
const REVIEW_HIGHLIGHT_RATINGS = ["A+", "A", "C", "D"];   // 这几档上级须写关键亮点
function reviewQuotaOf(cycle) {
  try { const q = cycle && cycle.quota ? JSON.parse(cycle.quota) : null; if (q && typeof q === "object") return q; } catch {}
  return { ...REVIEW_DEFAULT_QUOTA };
}
const reviewBucket = (r) => (r === "C" || r === "D" ? "C/D" : r);
const reviewEffective = (i) => i.finalRating || i.managerRating || null;
// 把一个周期的评估项按一级部门分组。每组：{ dept1Id, dept1, hod, items, quotaItems（计入配额的人：不含 HoD 本人与离职者），
// departedItems（离职 / 停用的参与者）, counts（按档）, allowed, over[], small, headcount, quotaBase, status }。
// HoD 本人的评估项留在组里给 HR，但不计入配额、不归 HoD 校准。
// 第二批 2.7（2026-10-08）：离职 / 停用的参与者（reviewPersonGone）不计入配额、不阻断提交与确认；仍可评级，
// 有评级的关闭周期时照常归档。headcount = 现在计入的人数；quotaBase = 折算名额与「小部门」用的人数（见下）。
function reviewGroups(cycle, items, snap) {
  snap = snap || orgSnapshot();
  const quota = reviewQuotaOf(cycle);
  // 第二批波次 3（W3-S，2026-10-08）：已关闭周期的各档人数（以及据此算的超额）按档案里的评级计 —— 2.6 改过的取改后的值，
  // 归档记录已被删的算无评级；与看板、整期导出、部门明细同一口径（部门行 counts / over、周期详情的 distribution、列表的已归档人数
  // 都跟着）。进行中的周期仍按生效评级（上级评级或 HoD / HR 校准）。快照比对 reviewSnapDiff 不经过这里，仍看生效评级。
  const rateOf = cycle.status === "closed" ? (i) => reviewRecordRatingOf(i).recordRating : reviewEffective;
  const statusOf = new Map(store.listReviewDeptStatus(cycle.id).map((r) => [r.dept1Id, r]));
  const groups = new Map();
  const userOf = new Map();
  for (const i of items) {
    const u = store.getUserById(i.userId);
    userOf.set(i.userId, u);
    const lv = u ? snap.levelsOf(u.department) : null;
    const key = lv && lv.level1Id ? lv.level1Id : "__none";
    if (!groups.has(key)) {
      const hod = u && lv ? snap.hodOf(u.department) : null;
      const hodUnresolved = reviewHodUnresolved(snap, lv, hod);
      groups.set(key, { dept1Id: key, dept1: lv ? lv.level1 : null, hod: hod ? { id: hod.id, name: hod.name, employeeId: hod.employeeId, source: hod.source } : null,
        hodUnresolved, deptInactive: hodUnresolved && reviewDeptInactive(snap, lv), items: [] });
    }
    groups.get(key).items.push(i);
  }
  for (const g of groups.values()) {
    const notHod = (i) => !g.hod || i.userId !== g.hod.id;
    g.departedItems = g.items.filter((i) => notHod(i) && reviewPersonGone(userOf.get(i.userId)));
    g.quotaItems = g.items.filter((i) => notHod(i) && !reviewPersonGone(userOf.get(i.userId)));
    const hc = g.quotaItems.length;
    g.status = statusOf.get(g.dept1Id) || null;
    // 审查 P1-1：已提交 / 已确认的组，配额基数 = 现在计入的人 + 提交或确认快照里有、现在已离职的人。提交后有人离职，
    // 名额不跟着变少 —— 否则 HR 确认时突然超额，而 HoD 已被锁定改不了。退回之后按现在的人数重算。
    // 按快照里的人数（不管离职者现在归到哪个组）：离职后再被改了部门的人同样留在基数里（审查）
    let base = hc;
    if (reviewDeptLocked(g.status)) {
      const sn = reviewSnapGet(cycle.id, g.dept1Id);
      const was = new Set([...((sn.submit && Array.isArray(sn.submit.ids) && sn.submit.ids) || []), ...((sn.confirm && Array.isArray(sn.confirm.ids) && sn.confirm.ids) || [])]);
      const now = new Set(g.quotaItems.map((i) => i.userId));
      for (const id of was) {
        if (now.has(id)) continue;
        if (!userOf.has(id)) userOf.set(id, store.getUserById(id));
        if (reviewPersonGone(userOf.get(id))) base++;
      }
    }
    g.counts = {};
    // 波次 3 复核：口径记在组上，reviewOverIds 按同一口径挑人（否则已关闭周期的超额档与 ids 各按一种评级）
    g.rateOf = rateOf;
    for (const i of g.quotaItems) { const r = rateOf(i); if (r) { const b = reviewBucket(r); g.counts[b] = (g.counts[b] || 0) + 1; } }
    g.allowed = reviewAllowedFor(quota, base);   // 第二批 2.8：抽成函数，申诉详情的名额分布用同一公式
    g.over = REVIEW_QUOTA_CAPPED.filter((t) => quota[t] != null && (g.counts[t] || 0) > g.allowed[t]).map((t) => ({ tier: t, count: g.counts[t] || 0, allowed: g.allowed[t] }));
    // P0 E4：「__none」（部门为空 / 不在部门表）是把互不相关的人凑成的一组，按小部门处理 —— 超额只提示、不拦确认
    g.small = base < REVIEW_QUOTA_MIN_HC || g.dept1Id === "__none";
    g.headcount = hc;
    g.quotaBase = base;
  }
  return [...groups.values()].sort((a, b) => String(a.dept1 || "~").localeCompare(String(b.dept1 || "~")));
}
// 本人担任 HoD 的、进行中 v2 周期的部门组 [{ cycle, g, snap }]（snap 可由调用方传入，一次请求只建一份组织快照）
function hodGroupsFor(user, snapIn) {
  const out = [];
  const snap = snapIn || orgSnapshot();
  const byCycle = new Map();
  for (const i of store.listOpenCycleItems()) {
    if (i.cycleFlow !== "v2") continue;
    if (!byCycle.has(i.cycleId)) byCycle.set(i.cycleId, []);
    byCycle.get(i.cycleId).push(i);
  }
  for (const [cid, items] of byCycle) {
    const cycle = store.getReviewCycle(cid);
    for (const g of reviewGroups(cycle, items, snap)) if (g.hod && g.hod.id === user.id) out.push({ cycle, g, snap });
  }
  return out;
}
// 全公司一级部门负责人（部门页指定的负责人优先，其次推算的 HoD）→ Map(userId → hod)。
// U1（负责人 2026-10-06）：HoD 没有个人绩效、只有组织绩效（另一套），v2 周期不给他们生成评估条目。
function reviewHodIdSet(snap) {
  snap = snap || orgSnapshot();
  const ids = new Map();
  const seen = new Set();
  for (const u of store.listUsers()) {
    const d = u.department;
    if (!d || seen.has(d)) continue;
    seen.add(d);
    const h = snap.hodOf(d);
    if (h && h.id) ids.set(h.id, h);
  }
  return ids;
}
// 该部门组当前是否已被 HoD 提交、尚未被退回（锁定上级与 HoD 的修改）
const reviewDeptLocked = (st) => !!(st && (st.hrConfirmedAt || st.hodSubmittedAt));
// U3（负责人 2026-10-06）：员工的自评与目标在本部门「提交过校准」后锁定 —— HoD 已提交、HR 已确认，
// 或曾提交后被 HR 退回（退回只回到 HoD 手里，员工侧仍锁定）。只对 v2 周期生效。
// P0 E4：没有一级部门的人归「__none」组，HR 确认该组后同样锁定（原先直接返回 false，确认过的结果还能被改）。
function reviewSelfLocked(cycleId, target) {
  if (!cycleId || !target) return false;
  const lv = orgSnapshot().levelsOf(target.department);
  const st = store.getReviewDeptStatus(cycleId, lv && lv.level1Id ? lv.level1Id : "__none");
  return !!(st && (st.hodSubmittedAt || st.hrConfirmedAt || st.returnedAt));
}
// HoD 提交前的阻断项（只看计入配额的人；每条带 ids = 条目 id，部门校准页点阻断项即筛出这些人）：
//   季度 rating_missing  没有生效评级（上级评级或 HoD 评级任一即可，与 HR 确认同一口径）
//        self_missing    还没交自评、且自评截止日（dueAt）未过 —— HoD 一提交员工的自评就锁定，不能提前把人锁死（审查 P0-3）；
//                        没有设自评截止日的周期须等所有人交了自评（HR 可补设截止日）。自评已锁定的组（退回过）不再检查
//   年度 hod_rating_missing  没有 HoD 评级
//   over_quota  超额（10 人以下与 __none 只提示）；ids = 落在超额档的人
// 第二批 2.1（2026-10-08，负责人已定面谈不作为 HoD 提交前提）：面谈未经双方登记改为 notices（不阻断），见 reviewSubmitNotices。
function reviewSubmitIssues(cycle, g) {
  // 波次 3 复核：已关闭的周期没有可提交的东西，不出阻断项（部门明细原先在已关闭周期上照样列出「超额」等）
  if (cycle.status !== "open") return [];
  const issues = [];
  const annual = cycle.kind === "annual";
  const list = g.quotaItems;
  const miss = list.filter((i) => (annual ? !i.finalRating : !reviewEffective(i)));
  if (miss.length) issues.push({ code: annual ? "hod_rating_missing" : "rating_missing", n: miss.length, ids: miss.map((i) => i.id) });
  // 自评已锁定的组（提交过、被退回过，与 reviewSelfLocked 同一判定）不再等自评：那些人交不了（self_locked），
  // 拦着只会让退回后增补的人、提交后调入的人把部门卡到截止日（审查）
  const selfLocked = !!(g.status && (g.status.hodSubmittedAt || g.status.hrConfirmedAt || g.status.returnedAt));
  if (!annual && !selfLocked) {
    const today = todayLocal();
    const due = cycle.dueAt ? String(cycle.dueAt).slice(0, 10) : null;
    const noSelf = list.filter((i) => !i.selfAt && (!due || today <= due));
    if (noSelf.length) issues.push({ code: "self_missing", n: noSelf.length, ids: noSelf.map((i) => i.id) });
  }
  if (g.over.length && !g.small) issues.push({ code: "over_quota", over: g.over, ids: reviewOverIds(g) });
  return issues;
}
// 落在超额档的人（条目 id）；按 reviewGroups 记在组上的口径（已关闭周期 = 档案评级，进行中 = 生效评级）
function reviewOverIds(g) {
  const tiers = new Set((g.over || []).map((o) => o.tier));
  if (!tiers.size) return [];
  const rate = g.rateOf || reviewEffective;
  return g.quotaItems.filter((i) => { const r = rate(i); return r && tiers.has(reviewBucket(r)); }).map((i) => i.id);
}
// 不阻断提交的提示（第二批 2.1 / 2.7）：one_on_one_unconfirmed 面谈未经双方登记（季度）；participants_departed 已离职、不计入的人
function reviewSubmitNotices(cycle, g) {
  const out = [];
  if (cycle.kind !== "annual") {
    const one = g.quotaItems.filter((i) => !(i.oneOnOneAt && i.employeeOneOnOneAt));
    if (one.length) out.push({ code: "one_on_one_unconfirmed", n: one.length, ids: one.map((i) => i.id) });
  }
  const gone = g.departedItems || [];
  if (gone.length) out.push({ code: "participants_departed", n: gone.length, ids: gone.map((i) => i.id) });
  return out;
}
// ---------- P0 第一组 1.1 / 1.2（负责人 2026-10-07）：v2 周期里 HR 对 HoD 校准只读、确认时同样检查配额 ----------
// 「HoD 待确认」（E1）：一级部门存在但推算不出 HoD —— 多个顶端 / 汇报环（source ambiguous）、部门页负责人已离职或停用
// 且推算也没有结果、或一级部门已停用。这类组不算「无 HoD」：HR 仍然只读，确认返回 hod_unresolved，引导去部门页指定负责人
// （一级部门已停用时返回 dept_inactive，引导重新启用或调整人员）。
// 只有「__none」组（部门为空 / 不在部门表 / 父链成环）与在职成员为 0 的一级部门（source none）才是真的无 HoD。
function reviewHodUnresolved(snap, lv, hod) {
  if (hod || !lv || !lv.level1Id) return false;
  const it = snap.hodItemOf(lv.level1Id);
  return !it || it.source === "ambiguous" || !!it.ownerInactive;
}
// 一级部门已停用（「HoD 待确认」里单独的一种）：deriveHods 跳过停用的一级部门，在部门页指定负责人解决不了，
// 只能重新启用部门或把人调到在用的部门（审查：原先也提示「指定负责人」，HR 照做后仍然卡住）。
function reviewDeptInactive(snap, lv) {
  if (!lv || !lv.level1Id || !snap.index || !snap.index.byId) return false;
  const d = snap.index.byId.get(lv.level1Id);
  return !!d && !d.active;
}
// 部门组是否「归 HoD」（E1 / 审查 H1）：现在有 HoD，或 HoD 已提交（未退回），或曾由 HoD 提交、退回后 HoD 待确认。
// 只看「现在的 HoD」的话，HoD 一消失（清负责人、停用部门、推算变成多个顶端），已提交的部门就变成 HR 可改。
// 退回后的部门（st.hodId 还在、hodSubmittedAt 已清）一级部门里已没有在职成员（真的无 HoD，不是待确认）→ 交回 HR：
// 已经没人能重新提交，不交回就永远确认不了、周期也关不掉（审查：退回后死锁）。
// HR 只读拦截、详情的 hrCalibratable / hodOwned、确认时的 not_submitted 都用这一个判定。
function reviewHodOwned(g, st) {
  return !!((g && g.hod) || (st && st.hodSubmittedAt) || (st && st.hodId && g && g.hodUnresolved));
}
// HR 能否校准这一条（v2）："ok" | "confirmed" | "readonly"（HoD 校准的组）| "unresolved"（HoD 待确认）。
// HoD 本人的评估项留给 HR（reviewGroups 注释）。HoD 已提交的组只认提交人（st.hodId）：HR 临时改部门负责人
// 不能把一名员工变成「HoD 本人的评估项」再改他的评级（审查：负责人对调）。
function reviewHrCalibAccess(g, st, userId) {
  if (st && st.hrConfirmedAt) return "confirmed";
  const hodId = st && st.hodSubmittedAt ? st.hodId || null : g && g.hod ? g.hod.id : (st && st.hodId) || null;
  if (hodId && userId === hodId) return "ok";
  if (reviewHodOwned(g, st)) return "readonly";
  if (g && g.hodUnresolved) return "unresolved";
  return "ok";
}
const REVIEW_HOD_UNRESOLVED_ERR = {
  error: "This department's HoD can't be determined yet (several possible heads or an inactive owner). Set the department owner on the Departments page first. 该部门的 HoD 尚未确定（推算出多个负责人或负责人已离职），请先在部门页指定负责人。",
  code: "hod_unresolved",
};
const REVIEW_DEPT_INACTIVE_ERR = {
  error: "This level-1 department is inactive, so it has no HoD. Reactivate it on the Departments page, or move these people to an active department. 该一级部门已停用，没有 HoD。请在部门页重新启用该部门，或把这些人员调到在用的部门。",
  code: "dept_inactive",
};
const reviewUnresolvedErr = (g) => (g && g.deptInactive ? REVIEW_DEPT_INACTIVE_ERR : REVIEW_HOD_UNRESOLVED_ERR);
// 确认人 / 退回人不能是该组的 HoD（E2）：现在的 HoD、提交人，或在归 HoD 的组里以 HoD 身份校准过评级的人
// （HR 临时把自己设成部门负责人、在 HoD 校准页改了评级再换回去 —— 审查）。HR 在无 HoD 的组里评级同样写 hodId，
// 所以第三条只看归 HoD 的组。
function reviewSelfActor(g, st, userId) {
  if (!userId) return false;
  if ((g.hod && g.hod.id === userId) || (st && st.hodId === userId)) return true;
  return reviewHodOwned(g, st) && g.quotaItems.some((i) => i.hodId === userId && i.hodAt);
}
// 成员快照（E3 / 审查 H3）：reviewGroups 每次按员工**当前**部门分组，调部门、改上级、Lark 同步都不受锁限制。
// HoD 提交与 HR 确认时各存一份配额成员（quotaItems 的 userId、人数与每人的生效评级），存 meta（不加迁移）：
//   键 review.snap:<cycleId>:<dept1Id>，值 { submit: { ids, n, ratings, at }, confirm: { ids, n, ratings, at } }。
// 确认时成员与提交快照不一致 → 阻断项 membership_changed，评级不一致 → ratings_changed；关闭时已确认部门的成员或评级
// 与确认快照不一致 → depts_changed。评级也要比：只比成员的话，把人调出已提交的部门、在别的组里改了评级再调回来，
// 两份 id 一模一样，确认和关闭都看不出来（审查）。
const reviewSnapKey = (cycleId, dept1Id) => `review.snap:${cycleId}:${dept1Id}`;
function reviewSnapGet(cycleId, dept1Id) {
  try { const v = JSON.parse(store.getMeta(reviewSnapKey(cycleId, dept1Id)) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function reviewSnapPut(cycleId, g, which) {
  const cur = reviewSnapGet(cycleId, g.dept1Id);
  const ids = g.quotaItems.map((i) => i.userId).sort();
  const ratings = {};
  for (const i of g.quotaItems) ratings[i.userId] = reviewEffective(i);
  // 审查 P2（2026-10-08）：离职者另记 departedIds 并一并锁定（reviewSnapLocks）—— 否则把离职者调去别的部门就能再改他的评级
  const departedIds = (g.departedItems || []).map((i) => i.userId).sort();
  cur[which] = { ids, n: ids.length, ratings, departedIds, at: new Date().toISOString() };
  store.setMeta(reviewSnapKey(cycleId, g.dept1Id), JSON.stringify(cur));
}
// 快照与当前的差异：{ added, removed, changed, addedIds, changedIds }（人数；changed = 两边都在、生效评级变了的人，旧快照没有
// ratings 时不比；addedIds / changedIds 是条目 id，阻断项的 ids 用），没有快照或一致 → null。
// 第二批 2.7：快照里有、现在已离职的人不算移出，也不比评级 —— 提交或确认之后有人离职，不触发 membership_changed /
// ratings_changed / depts_changed（离职者的评级由 departedIds 锁定）。
function reviewSnapDiff(entry, g) {
  if (!entry || !Array.isArray(entry.ids)) return null;
  const was = new Set(entry.ids);
  const now = new Set(g.quotaItems.map((i) => i.userId));
  const addedIds = [], changedIds = [];
  let removed = 0;
  for (const i of g.quotaItems) if (!was.has(i.userId)) addedIds.push(i.id);
  for (const id of was) if (!now.has(id) && !reviewPersonGone(store.getUserById(id))) removed++;
  if (entry.ratings && typeof entry.ratings === "object")
    for (const i of g.quotaItems) if (was.has(i.userId) && (entry.ratings[i.userId] || null) !== reviewEffective(i)) changedIds.push(i.id);
  const added = addedIds.length, changed = changedIds.length;
  return added || removed || changed ? { added, removed, changed, addedIds, changedIds } : null;
}
// 本周期已锁定（HoD 已提交 / HR 已确认）的部门组快照里的人 → Map(userId → 该组状态行)，不管这个人现在在哪个部门。
// 评级的三个写入口（HR 校准、HoD 校准、上级评级）都按这个拒绝：按「现在的部门」判断锁定的话，把人调出已锁定的部门
// 就能在别的组里改评级（审查）。已确认的组看确认快照，只提交未确认的看提交快照。
function reviewSnapLocks(cycleId) {
  const out = new Map();
  for (const st of store.listReviewDeptStatus(cycleId)) {
    if (!reviewDeptLocked(st)) continue;
    const snap = reviewSnapGet(cycleId, st.dept1Id);
    const entry = (st.hrConfirmedAt && snap.confirm) || snap.submit;
    // 快照里的离职者（departedIds，2026-10-08 起记录）同样锁定
    if (entry && Array.isArray(entry.ids))
      for (const id of [...entry.ids, ...(Array.isArray(entry.departedIds) ? entry.departedIds : [])]) if (!out.has(id)) out.set(id, st);
  }
  return out;
}
const REVIEW_SNAP_LOCKED_ERR = {
  error: "This person's rating is locked with a department that has already been submitted or confirmed. Return or reopen that department first. 此人的评级已随所在部门提交或确认，不能再修改；请先退回或撤销确认该部门。",
  code: "dept_locked",
};
// HR 确认前的阻断项（与 HoD 提交同一口径：10 人以下超额只提示）。不检查面谈（负责人已定面谈不作为前提）。
//   hod_unresolved     HoD 待确认且没有提交过（一级部门已停用时是 dept_inactive）
//   rating_missing     有人没有生效评级（关闭周期时会被跳过）
//   over_quota         超额（g.over / g.small）
//   membership_changed HoD 提交后部门成员变了（调部门 / 改上级 / 同步）
//   ratings_changed    HoD 提交后有人的生效评级变了
function reviewConfirmIssues(cycle, g) {
  // 波次 3 复核：已关闭的周期不能再确认，不出阻断项（前端 HR 模式按 confirmIssues 摆阻断提示）
  if (cycle.status !== "open") return [];
  const issues = [];
  const submitted = !!(g.status && g.status.hodSubmittedAt);
  if (g.hodUnresolved && !submitted) issues.push({ code: g.deptInactive ? "dept_inactive" : "hod_unresolved" });
  // 与人有关的阻断项带 ids（条目 id）：rating_missing、over_quota、membership_changed（ids = 提交后新加入的人；
  // 移出的人已不在本组，只给人数）、ratings_changed
  const miss = g.quotaItems.filter((i) => !reviewEffective(i));
  if (miss.length) issues.push({ code: "rating_missing", n: miss.length, ids: miss.map((i) => i.id) });
  if (g.over.length && !g.small) issues.push({ code: "over_quota", over: g.over, ids: reviewOverIds(g) });
  if (submitted) {
    const d = reviewSnapDiff(reviewSnapGet(cycle.id, g.dept1Id).submit, g);
    if (d && (d.added || d.removed)) issues.push({ code: "membership_changed", added: d.added, removed: d.removed, ids: d.addedIds });
    if (d && d.changed) issues.push({ code: "ratings_changed", n: d.changed, ids: d.changedIds });
  }
  return issues;
}
// ---------- P0 1.5：评估周期按部门圈人与筛选包含下级部门 ----------
// 部门链用 org.js chainOf（一级 → 本部门，全深度，集团层不算祖先）。范围受限时链上范围外的部门一律去掉
// （不把范围外的部门名带出去，与 GET /departments 同一口径）。部门名不在部门表、或部门父链成环的人
// 用 "name:<部门名小写>" 伪 id（选它 = 按部门名不分大小写匹配）。部门为空的人没有部门路径，只在「全部」里出现。
function reviewDeptPredMemo(pred) {
  if (!pred) return null;
  const memo = new Map();
  return (name) => { if (!memo.has(name)) memo.set(name, !!pred(name)); return memo.get(name); };
}
// 第二批 3.1（2026-10-08）：两个函数名字保留，实现委托 org.js 的全站部门筛选口径（deptFilterFor 同一套）。
function reviewDeptPath(u, ix, allow) {
  return orgLib.deptPathOf(ix, u && u.department, allow);
}
// 部门选项 [{ id, name, parentId, path, level, inactive? }]：把 users 每个人的部门链合在一起；parentId = 链上最近一个
// 保留下来的祖先；path = 保留下来的链拼成「Finance › AP」；按链逐段排序（父级排在子级前）。评估周期不限级数
// （maxLevel: Infinity，四级部门照样成选项，review-dept-filter 测试要它）；部门已停用的另带 inactive:true。
function reviewDeptOptions(users, ix, pred, allowMemo) {
  const allow = allowMemo || reviewDeptPredMemo(pred);
  return orgLib.deptOptionsOf(ix, (users || []).map((u) => u && u.department), allow, { maxLevel: Infinity }).options;
}
// ---------- 评估按阶段批量提醒（2026-10-07 批量操作第二批 B6，POST /api/admin/review-reminders）----------
// 四个阶段：self 自评未交（提醒员工）、one_on_one 面谈未确认（提醒员工）、manager 上级未评级（提醒直属上级，同一上级的
// 多个条目合并成一条通知）、hod 部门校准未提交（提醒 HoD）。适用：self / manager = 旧流程与 v2 季度；one_on_one = 只有
// v2 季度；hod = v2 季度与年度。
// 节流与上级的单条 nudge 共用 nudgedAt（1 小时，进程内，重启清空）：自评的键就是评估条目 id，所以上级刚提醒过的人，
// HR 再按「自评」提醒会报 cooldown，反之亦然；其余阶段的键带阶段名与收件人。
const REVIEW_REMIND_STAGES = ["self", "one_on_one", "manager", "hod"];
const REVIEW_REMIND_BY = ["cycle", "dept", "item"];
const REVIEW_REMIND_COOLDOWN_MS = 60 * 60 * 1000;
function reviewStageApplies(cycle, stage) {
  const v2 = cycle.flow === "v2", annual = cycle.kind === "annual";
  if (stage === "hod") return v2;
  if (stage === "one_on_one") return v2 && !annual;
  return !annual;                                            // self / manager：旧流程与 v2 季度
}
const reviewRecipientOk = (u) => !!u && u.active !== 0 && u.empStatus !== "exited";
// ---------- 第二批 2.1 / 2.2 / 2.7（2026-10-08，波次 1）：全站同名同义的行状态 ----------
// 团队名单行（GET /api/me/reviews 的 teamRows）、部门校准行（reviewCalibView）、后台周期详情 items 用同一组字段，不再各自判定：
//   notCounted     null | "departed"（离职 / 停用 / 已删除）| "hod_self"（HoD 本人的评估项，留给 HR）
//   managerStatus  "active" | "departed" | "none"（按 item.managerId，即发起周期时的上级快照）
//   hodProxy       null | "manager_pending"（上级在职未评、已过评级截止日，HoD 代评）| "manager_departed"（上级不在职或没有上级）
//   oneState       "both" | "mgr" | "emp" | "none"（oneOnOneAt = 上级一侧，employeeOneOnOneAt = 员工一侧）
//   locked         所在部门已提交 / 已确认，或此人在本周期已锁定部门的快照里（只对 v2）
//   overdue        [] 或含 "self"（季度：过了 dueAt 未交自评）/ "rate"（过了 dueRateAt 没有生效评级）
const reviewPersonGone = (u) => !reviewRecipientOk(u);
// 一次请求内按 id 记住用户（行状态要反复查上级与本人）
function reviewUserMemo() {
  const m = new Map();
  return (id) => { if (!id) return null; if (!m.has(id)) m.set(id, store.getUserById(id)); return m.get(id); };
}
function reviewManagerStatus(item, userOf) {
  if (!item || !item.managerId) return "none";
  return reviewPersonGone((userOf || store.getUserById)(item.managerId)) ? "departed" : "active";
}
const reviewOneState = (i) => (i.oneOnOneAt && i.employeeOneOnOneAt ? "both" : i.oneOnOneAt ? "mgr" : i.employeeOneOnOneAt ? "emp" : "none");
// review_items.hodProxy（迁移 69）：{ by, at, reason }
function reviewHodProxyRec(item) {
  if (!item || !item.hodProxy) return null;
  try { const p = JSON.parse(item.hodProxy); return p && typeof p === "object" ? p : null; } catch { return null; }
}
// HoD 代评（审查 P0-2：显式记录，不推导）：季度周期、上级没评、有 HoD 评级，且 hodProxy.by = 现在的 hodId
// （HR 事后改评级会换掉 hodId，标记随之失效）。类型按上级现在的状态给。
function reviewHodProxyOf(cycle, item, userOf) {
  if (!cycle || cycle.kind === "annual" || !item || item.managerRating || !item.finalRating) return null;
  const p = reviewHodProxyRec(item);
  if (!p || !p.by || p.by !== item.hodId) return null;
  return reviewManagerStatus(item, userOf) === "active" ? "manager_pending" : "manager_departed";
}
// 自评已逾期（季度：过了 dueAt 仍未交）。上级在员工交自评之后、或自评逾期之后评级（D1）；批量提醒按同一口径
function reviewSelfOverdue(cycle, item, today) {
  return !!(cycle && cycle.kind !== "annual" && cycle.dueAt && !item.selfAt && (today || todayLocal()) > String(cycle.dueAt).slice(0, 10));
}
function reviewOverdueOf(cycle, item, today) {
  const out = [];
  if (reviewSelfOverdue(cycle, item, today)) out.push("self");
  if (cycle && cycle.dueRateAt && today > String(cycle.dueRateAt).slice(0, 10) && !reviewEffective(item)) out.push("rate");
  return out;
}
// 锁定（v2）：false | "dept"（此人现在所在的一级部门组已提交 / 已确认）| "snap"（此人在本周期已锁定部门的快照里，
// 例如调部门过来的人，或快照里的离职者）。上级评级、上级一侧撤销面谈、HoD 校准都按它拒绝（审查：调出再调回绕过锁定）。
function reviewItemLocked(cycle, item, opts) {
  if (!cycle || cycle.flow !== "v2" || !item) return false;
  let st = opts && opts.st;
  if (st === undefined) {
    const t = store.getUserById(item.userId);
    const lv = t ? ((opts && opts.snap) || orgSnapshot()).levelsOf(t.department) : null;
    // P0 E4：没有一级部门的人归「__none」组，HR 确认后同样锁定
    st = store.getReviewDeptStatus(cycle.id, lv && lv.level1Id ? lv.level1Id : "__none");
  }
  if (reviewDeptLocked(st)) return "dept";
  return ((opts && opts.locks) || reviewSnapLocks(cycle.id)).has(item.userId) ? "snap" : false;
}
// 代评资格（审查 P0-3）：季度 v2、上级没评、HoD 不是此人的直属上级（那要走上级评级入口，关键亮点规则才生效），
// 且上级已离职 / 停用 / 没有上级，或已过评级截止日（dueRateAt）。
function reviewProxyEligible(cycle, item, hodId, userOf, today) {
  if (!cycle || cycle.flow !== "v2" || cycle.kind === "annual" || item.managerRating) return false;
  if (item.managerId && hodId && item.managerId === hodId) return false;
  return reviewManagerStatus(item, userOf) !== "active" || !!(cycle.dueRateAt && (today || todayLocal()) > String(cycle.dueRateAt).slice(0, 10));
}
// 职级索引：jobLevel（职级代码，如 PB2）→ { grade 职等, track 通道 M/P }
function reviewGradeIndex() {
  return new Map(jobGrades().map((r) => [String(r.rank).toUpperCase(), r]));
}
// 自评正文（部门校准里 HR 一律可见；HoD 只对可代评 / 已代评的行可见，审查 P1-5）
function reviewSelfOf(i) {
  const pj3 = (s2, d2) => { try { return s2 ? JSON.parse(s2) : d2; } catch { return d2; } };
  return {
    prevGoals: pj3(i.prevGoals, []), selfOutcomes: pj3(i.selfOutcomes, []), selfChallenges: i.selfChallenges || "",
    selfFeedback: i.selfFeedback || "", selfExtra: i.selfExtra || "", goalsNext: pj3(i.goalsNext, []),
  };
}
// 后台「部门确认」列表的一行（GET /review-cycles/:id 的 depts[] 与部门明细的 row 共用）。partial = 组里还有范围外的人。
function reviewDeptRow(cycle, g, viewer, partial) {
  // P0 E3：已确认的部门成员 / 评级与确认快照不一致（关闭周期会被 depts_changed 拦住）
  const changed = !partial && g.status && g.status.hrConfirmedAt ? reviewSnapDiff(reviewSnapGet(cycle.id, g.dept1Id).confirm, g) : null;
  return {
    dept1Id: g.dept1Id, dept1: g.dept1, hod: g.hod, headcount: g.headcount, counts: g.counts, allowed: g.allowed, over: g.over, small: g.small,
    selfDone: g.quotaItems.filter((i) => i.selfAt).length, oneDone: g.quotaItems.filter((i) => i.oneOnOneAt && i.employeeOneOnOneAt).length,
    rated: g.quotaItems.filter((i) => i.managerRating).length,
    // 第二批 2.7：离职 / 停用、不计入的人数；quotaBase = 折算名额用的人数（提交后才离职的人仍算在内）
    departedN: g.departedItems.length, quotaBase: g.quotaBase,
    // hodId = 提交人（退回后仍保留）；hodOwned = 服务端 reviewHodOwned，前端直接用，不再自己推（审查：退回后 HoD 消失时两边不一致）
    // hrId / hrName = 确认人（第二批 O1：部门确认列表的已确认行显示「已确认 · 时间 · 确认人」）；退回或未确认时为 null
    status: g.status ? {
      hodSubmittedAt: g.status.hodSubmittedAt, hrConfirmedAt: g.status.hrConfirmedAt, returnedAt: g.status.returnedAt, returnReason: g.status.returnReason, hodId: g.status.hodId || null,
      hrId: g.status.hrConfirmedAt && g.status.hrId ? g.status.hrId : null,
      hrName: g.status.hrConfirmedAt && g.status.hrId ? ((store.getUserById(g.status.hrId) || {}).name || null) : null,
    } : null,
    hodOwned: reviewHodOwned(g, g.status),
    ...(partial ? { scopePartial: true } : {}),
    // P0 1.2：HR 确认前的阻断项（与确认接口同一函数）；范围不全的部门本来就不能确认 → null。
    // 看的人就是该组 HoD（含以 HoD 身份校准过的人）时另加 self_confirm（E2：确认 / 退回接口对他返回 409），前端据此置灰按钮
    confirmIssues: partial ? null : [
      ...reviewConfirmIssues(cycle, g),
      ...(viewer && reviewSelfActor(g, g.status, viewer.id) ? [{ code: "self_confirm" }] : []),
    ],
    ...(g.hodUnresolved ? { hodUnresolved: true } : {}),
    ...(g.deptInactive ? { deptInactive: true } : {}),
    ...(changed && (changed.added || changed.removed) ? { membershipChanged: { added: changed.added, removed: changed.removed } } : {}),
    ...(changed && changed.changed ? { ratingsChanged: changed.changed } : {}),
  };
}
// 部门校准视图（第二批 2.2）：员工端 HoD「部门校准」与后台 HR「部门明细」共用一个序列化函数，前端共用 DeptCalibration 组件。
//   opts.mode "hod"：rows = 计入的人 + 离职者（不含 HoD 本人）；editable = 周期进行中、未锁定、计入
//   opts.mode "hr" ：rows = 全组（opts.rowItems 收窄到范围内时只含范围内的人），HoD 本人标 hod_self；
//                    editable = hrCalibratable 且看的人有绩效写权限（opts.canEdit）；另带部门行字段与面谈要点。
//   opts.partial（hr）：组里有范围外的人 —— 人数、各档人数、名额、超额、阻断项、提示一律给 null（审查 P1-2），只给范围内的行。
//   opts.allow：范围裁剪的部门名判定（reviewDeptPredMemo），deptPath 去掉范围外的部门。
// deptPath / deptOptions 按 id 去掉本一级部门（不按位置截断：范围裁剪后第一个元素不一定是一级部门，审查 P1-3）。
function reviewCalibView(cycle, g, snap, opts) {
  const hr = opts.mode === "hr";
  const viewer = opts.viewer || null;
  const partial = !!(hr && opts.partial);
  const allow = opts.allow || null;
  const userOf = reviewUserMemo();
  const today = todayLocal();
  const locks = cycle.flow === "v2" ? reviewSnapLocks(cycle.id) : new Map();
  const grades = reviewGradeIndex();
  const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
  const quota = reviewQuotaOf(cycle);
  const quarter = cycle.kind !== "annual";
  const hodId = g.hod ? g.hod.id : null;
  const deptLocked = reviewDeptLocked(g.status);
  const open = cycle.status === "open";
  const closed = cycle.status === "closed";
  const departed = new Set(g.departedItems.map((i) => i.id));
  const overTiers = new Set(g.over.map((o) => o.tier));
  const list = hr ? (opts.rowItems || g.items) : g.items.filter((i) => (!hodId || i.userId !== hodId) && (!viewer || i.userId !== viewer.id));
  const rows = list.map((i) => {
    const u = userOf(i.userId);
    const m = i.managerId ? userOf(i.managerId) : null;
    const notCounted = departed.has(i.id) || reviewPersonGone(u) ? "departed" : hodId && i.userId === hodId ? "hod_self" : null;
    const managerStatus = reviewManagerStatus(i, userOf);
    const hodProxy = reviewHodProxyOf(cycle, i, userOf);
    const oneState = reviewOneState(i);
    const locked = deptLocked || locks.has(i.userId);
    const effective = reviewEffective(i);
    const bucket = effective ? reviewBucket(effective) : null;
    // 已关闭周期：组的各档人数与超额按档案评级算（reviewGroups），行上的超额标记同一口径（W3-S）；recordRating 本身只给 hr 行
    const fileRec = closed ? reviewRecordRatingOf(i) : null;
    const quotaBucket = fileRec ? (fileRec.recordRating ? reviewBucket(fileRec.recordRating) : null) : bucket;
    // 范围不全（hr partial）：超额是按整组算的，按行给出等于透露范围外的人的分布 → null
    const overQuota = partial ? null : !notCounted && !!quotaBucket && overTiers.has(quotaBucket);
    const gr = u && u.jobLevel ? grades.get(String(u.jobLevel).toUpperCase()) : null;
    const proxyEligible = open && !locked && !notCounted && reviewProxyEligible(cycle, i, hodId, userOf, today);
    const hrCalibratable = hr && open && !locks.has(i.userId) && reviewHrCalibAccess(g, g.status, i.userId) === "ok";
    const row = {
      // 第三批 9.1：employeeId 只供部门校准页按工号查找 / 排序，界面不显示；另给 position（员工端只显示姓名、职位、职级、汇报关系）
      id: i.id, userId: i.userId, name: u ? u.name : "?", employeeId: u ? u.employeeId : "?", position: u ? u.position || null : null,
      department: u ? u.department || null : null,
      deptPath: reviewDeptPath(u, snap.index, allow).filter((id) => id !== g.dept1Id),
      jobLevel: u ? u.jobLevel || null : null, jobGrade: gr && gr.grade != null ? gr.grade : null, jobTrack: gr ? gr.track || null : null,
      managerId: i.managerId || null, manager: m ? m.name : null, managerStatus,
      selfAt: i.selfAt || null, oneOnOneAt: i.oneOnOneAt || null, employeeOneOnOneAt: i.employeeOneOnOneAt || null, oneState,
      managerRating: i.managerRating || null, managerText: i.managerText || "", highlights: i.highlights || "",
      finalRating: i.finalRating || null, hodText: i.hodText || "", hodProxy, effective, bucket,
      adjusted: !!(i.managerRating && i.finalRating && i.finalRating !== i.managerRating),
      overQuota, notCounted, overdue: reviewOverdueOf(cycle, i, today),
      pending: !notCounted && ((quarter && oneState !== "both") || !effective || overQuota),
      locked, editable: hr ? !!(hrCalibratable && opts.canEdit) : open && !locked && !notCounted,
      proxyEligible,
      selfReview: hr || proxyEligible || hodProxy ? reviewSelfOf(i) : null,
    };
    // 第二批 2.6（波次 2 复核修正）：已关闭周期的 hr 行另带 recordRating / amendedFrom（与周期详情 items[] 同一口径），
    // 部门明细与「导出本部门」才和看板、整期导出一致。只在 hr（后台）模式；HoD 视图（员工端）不给
    if (hr) Object.assign(row, { oneOnOneNotes: i.oneOnOneNotes || "", hodAt: i.hodAt || null, hrCalibratable, ...(fileRec || {}) });
    return row;
  });
  const st = g.status;
  const dept = {
    unit: g.dept1Id, dept1: g.dept1, hod: g.hod ? { id: g.hod.id, name: g.hod.name } : null,
    headcount: partial ? null : g.headcount, quotaBase: partial ? null : g.quotaBase,
    counts: partial ? null : g.counts, allowed: partial ? null : g.allowed, over: partial ? null : g.over, small: partial ? null : g.small,
    status: st ? { hodSubmittedAt: st.hodSubmittedAt || null, hrConfirmedAt: st.hrConfirmedAt || null, returnedAt: st.returnedAt || null, returnReason: st.returnReason || null, hodId: st.hodId || null } : null,
    locked: deptLocked,
    issues: partial ? null : reviewSubmitIssues(cycle, g),
    notices: partial ? null : reviewSubmitNotices(cycle, g),
    departedN: partial ? null : g.departedItems.length,
  };
  if (hr) {
    const r = reviewDeptRow(cycle, g, viewer, partial);
    Object.assign(dept, {
      confirmIssues: r.confirmIssues, hodOwned: r.hodOwned, hodUnresolved: !!g.hodUnresolved, deptInactive: !!g.deptInactive,
      scopePartial: partial, membershipChanged: r.membershipChanged || null, ratingsChanged: r.ratingsChanged || null,
    });
    // 确认人（第二批 O1，波次 3 W3-S）：部门明细头部「已确认 · 时间 · 确认人」与部门确认列表同一来源（reviewDeptRow 的 status）；只在 hr 模式
    if (dept.status && r.status) Object.assign(dept.status, { hrId: r.status.hrId || null, hrName: r.status.hrName || null });
  }
  const users = list.map((i) => userOf(i.userId)).filter(Boolean);
  const deptOptions = reviewDeptOptions(users, snap.index, null, allow).filter((o) => o.id !== g.dept1Id && (o.level == null || o.level >= 2));
  return {
    mode: hr ? "hr" : "hod",
    cycle: { id: cycle.id, name: cycle.name, kind: cycle.kind || "quarter", flow: cycle.flow || null, dueAt: cycle.dueAt || null, dueRateAt: cycle.dueRateAt || null, dueCalibAt: cycle.dueCalibAt || null, status: cycle.status, quota },
    dept, rows, deptOptions,
    ratingOptions: ratingField ? ratingField.options : [], ratingOptions_zh: ratingField ? optionsZhOf(ratingField) : [],
    ratingOptions_desc: ratingField ? ratingField.options_desc || [] : [], ratingOptions_desc_zh: ratingField ? ratingField.options_desc_zh || [] : [],
    highlightRatings: REVIEW_HIGHLIGHT_RATINGS, quotaMinHeadcount: REVIEW_QUOTA_MIN_HC, today,
    // 配额档（审查 P2）：C、D 合并为一档「C/D」；bucketOf = 评级 → 配额档（不在表里的评级档名就是它自己）。地址栏写 tier 时要 encodeURIComponent
    tiers: Object.keys(quota), bucketOf: { C: "C/D", D: "C/D" },
  };
}
// ---- HoD 校准的校验与写入（单行 PUT /hod/items/:id 与批量 PUT /hod/items 共用）----
function reviewHodCtx(cycle, g, user) {
  const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
  return {
    cycle, g, user, userOf: reviewUserMemo(), today: todayLocal(), locks: reviewSnapLocks(cycle.id),
    ratingField, opts: ratingField ? ratingField.options : [],
    member: new Set(g.items.map((i) => i.id)), departed: new Set(g.departedItems.map((i) => i.id)),
  };
}
// 一行的校验 → { code } 或 { item, rating, reason, proxy }。码与 reviewcodes.js 的 err 一致：
//   not_found（不在本组 / HoD 本人）、participant_departed（离职者不计入，HoD 不评）、dept_locked（在已锁定部门的快照里）、
//   rating_required、stale（带了 expect 而上级评级或 HoD 评级已变，审查 P1-4）、
//   季度：上级已评且改了评级 → reason_required；上级未评 → 代评：HoD 是直属上级 use_manager_entry、上级在职且未过评级截止日
//   manager_not_overdue（审查 P0-3）、没写理由 proxy_reason_required。年度：HoD 的评级就是提议，理由选填。rating null = 清空。
function reviewHodChange(ctx, item, ch) {
  const { cycle, g, user } = ctx;
  if (!item || !ctx.member.has(item.id) || item.userId === user.id || (g.hod && item.userId === g.hod.id)) return { code: "not_found" };
  if (ctx.departed.has(item.id)) return { code: "participant_departed" };
  if (ctx.locks.has(item.userId)) return { code: "dept_locked", snap: true };
  if (!ch || ch.rating === undefined) return { code: "rating_required" };
  const raw = ch.rating === null || ch.rating === "" ? null : String(ch.rating).trim();
  const rating = raw === null ? null : canonOption(ctx.ratingField || {}, raw);
  if (raw !== null && (!rating || (ctx.opts.length && !ctx.opts.includes(rating)))) return { code: "rating_required" };
  if (ch.expect && typeof ch.expect === "object") {
    const nz = (x) => (x === undefined || x === null || x === "" ? null : String(x));
    if (("managerRating" in ch.expect && nz(ch.expect.managerRating) !== nz(item.managerRating))
      || ("finalRating" in ch.expect && nz(ch.expect.finalRating) !== nz(item.finalRating))) return { code: "stale" };
  }
  const reason = String(ch.reason || "").trim().slice(0, 1000);
  let proxy = null;
  if (cycle.kind !== "annual" && rating) {
    if (!item.managerRating) {
      if (item.managerId && item.managerId === user.id) return { code: "use_manager_entry" };
      const ms = reviewManagerStatus(item, ctx.userOf);
      if (ms === "active" && !(cycle.dueRateAt && ctx.today > String(cycle.dueRateAt).slice(0, 10))) return { code: "manager_not_overdue" };
      if (!reason) return { code: "proxy_reason_required" };
      proxy = ms === "active" ? "manager_pending" : "manager_departed";
    } else if (rating !== item.managerRating && !reason) return { code: "reason_required" };
  }
  return { item, rating, reason, proxy };
}
// 写一行（在调用方的事务里）：finalRating / hodText / hodAt / hodId，代评另写 hodProxy（其余情况置 NULL）；
// 审计与评级同一笔事务（审查 P1-13：带理由的审计不能在提交之后才补）。代评记 review.hod.proxy，其余 review.hod.calibrate。
function reviewHodWrite(ctx, v, audit) {
  const now = new Date().toISOString();
  const updated = store.updateReviewItem(v.item.id, {
    finalRating: v.rating, hodText: v.reason || null, hodAt: now, hodId: ctx.user.id,
    hodProxy: v.proxy ? JSON.stringify({ by: ctx.user.id, at: now, reason: v.reason }) : null,
  });
  if (v.proxy) audit("review.hod.proxy", v.item.id, { finalRating: v.item.finalRating || null }, { finalRating: v.rating, reason: v.reason, proxy: v.proxy });
  else audit("review.hod.calibrate", v.item.id, { finalRating: v.item.finalRating || null }, { finalRating: v.rating, reason: v.reason || null });
  return updated;
}
// 代评之后通知在职的直属上级（审查 P0-3）：只说「HoD 已代你评级」，不带评级值
function reviewNotifyProxied(cycle, list) {
  for (const v of list) {
    if (v.proxy !== "manager_pending" || !v.item.managerId) continue;
    const t = store.getUserById(v.item.userId);
    const name = t ? t.name : "";
    notify(v.item.managerId, {
      type: "review", link: "/review?view=team",
      title: `The HoD rated ${name} on your behalf for ${cycle.name}`,
      title_zh: `HoD 已代你为 ${name} 评定「${cycle.name}」绩效评级`,
      body: "The rating deadline had passed. You can no longer rate this person in this cycle; talk to the HoD if you disagree.",
      body_zh: "评级截止日已过，本周期你不能再为此人评级；如有不同意见，请与 HoD 沟通。",
    });
  }
}
const REVIEW_HOD_ERRS = {
  not_found: [404, "Review record not found. 未找到该评估记录。"],
  participant_departed: [409, "This person has left and isn't counted, so the HoD doesn't rate them. 此人已离职，不计入配额，HoD 不为其评级。"],
  rating_required: [400, "Select a valid performance rating. 请选择有效的绩效评级。"],
  stale: [409, "The manager or HoD rating has changed since you opened the page. Refresh and check again. 上级评级或 HoD 评级在你打开页面后已有变动，请刷新后重新确认。"],
  reason_required: [400, "Give a reason for changing the manager rating. 调整上级评级须填写理由。"],
  proxy_reason_required: [400, "Give a reason for rating on behalf of the manager. 代上级评级须填写理由。"],
  manager_not_overdue: [409, "The direct manager is still active and the rating deadline hasn't passed, so the HoD can't rate on their behalf yet. 直属上级仍在职且未过评级截止日，HoD 暂不能代评。"],
  use_manager_entry: [409, "You are this person's direct manager. Rate them under Team reviews, where the key-highlight rules apply. 你是此人的直属上级，请在「团队评估」中评级（关键亮点规则同样适用）。"],
};
function sendReviewHodErr(res, v) {
  if (v.code === "dept_locked") return send(res, 400, REVIEW_SNAP_LOCKED_ERR);
  const [status, error] = REVIEW_HOD_ERRS[v.code] || [400, "This change can't be saved. 该修改不能保存。"];
  return send(res, status, { error, code: v.code });
}
// ---- 上级的团队名单（GET /api/me/reviews 的 teamRows / teamStats，第二批 2.1）----
// 只列 managerId = 本人的条目（发起周期时的上级快照）；本人已离职或停用时为空。离职的下属标 left、不进分母。
// tags ⊂ self（未交自评、计入）/ one（面谈未经双方登记、计入、未锁定，v2）/ rate（上级未评、未被代评、计入、未锁定，且自评已交或
//        已逾期 —— 与 todo.rate、单人页的 D1 评级门槛同一口径，首页「待评级下属 N」点进来的名单才对得上，波次 2 复核修正）/
//        rated（上级已评或 HoD 已代评）/ locked / left —— 名单筛选与计数共用。
// teamStats（每个周期一条，分母都去掉离职者）：oneOnOneDone = 双方都登记；oneMgrOnly / oneEmpOnly 只有一侧登记；
//   rated = 上级已评或 HoD 已代评；distribution = 上级本人给的评级（按评级值）；todo.rate = 待你评级（自评已交或已逾期）；
//   todo.oneOnOne = 你这一侧还没登记面谈（v2）。都排除已离职、已锁定、已代评的人。
function reviewTeamPayload(user, snap) {
  if (reviewPersonGone(user)) return { teamRows: [], teamStats: [] };
  const userOf = reviewUserMemo();
  const today = todayLocal();
  const cycles = new Map(), statuses = new Map(), lockMaps = new Map();
  const cycleOf = (id) => { if (!cycles.has(id)) cycles.set(id, store.getReviewCycle(id)); return cycles.get(id); };
  const statusOf = (cid, key) => {
    if (!statuses.has(cid)) statuses.set(cid, new Map(store.listReviewDeptStatus(cid).map((r) => [r.dept1Id, r])));
    return statuses.get(cid).get(key) || null;
  };
  const locksOf = (cid) => { if (!lockMaps.has(cid)) lockMaps.set(cid, reviewSnapLocks(cid)); return lockMaps.get(cid); };
  const rows = [];
  for (const i of store.listTeamReviewItems(user.id)) {
    const c = cycleOf(i.cycleId);
    if (!c) continue;
    const u = userOf(i.userId);
    const v2 = c.flow === "v2";
    const lv = u ? snap.levelsOf(u.department) : null;
    const hod = v2 && u && lv ? snap.hodOf(u.department) : null;
    const notCounted = reviewPersonGone(u) ? "departed" : hod && hod.id === i.userId ? "hod_self" : null;
    const counted = !notCounted;
    const locked = v2 && (reviewDeptLocked(statusOf(c.id, lv && lv.level1Id ? lv.level1Id : "__none")) || locksOf(c.id).has(i.userId));
    const hodProxied = !!reviewHodProxyOf(c, i, userOf);
    const oneState = reviewOneState(i);
    const selfOverdue = reviewSelfOverdue(c, i, today);
    const tags = [];
    if (!i.selfAt && counted) tags.push("self");
    if (v2 && counted && !locked && oneState !== "both") tags.push("one");
    if (!i.managerRating && !hodProxied && counted && !locked && (i.selfAt || selfOverdue)) tags.push("rate");
    if (i.managerRating || hodProxied) tags.push("rated");
    if (locked) tags.push("locked");
    if (notCounted === "departed") tags.push("left");
    rows.push({
      id: i.id, cycleId: c.id, cycle: c.name, flow: c.flow || null, kind: c.kind || "quarter",
      userId: i.userId, name: u ? u.name : "?", employeeId: u ? u.employeeId : "?",
      department: u ? u.department || null : null, position: u ? u.position || null : null, jobLevel: u ? u.jobLevel || null : null,
      selfAt: i.selfAt || null, dueAt: c.dueAt || null, dueRateAt: c.dueRateAt || null,
      oneOnOneAt: i.oneOnOneAt || null, employeeOneOnOneAt: i.employeeOneOnOneAt || null, oneState,
      managerAt: i.managerAt || null, managerRating: i.managerRating || null,
      highlightsMissing: !!(v2 && i.managerRating && REVIEW_HIGHLIGHT_RATINGS.includes(i.managerRating) && !String(i.highlights || "").trim()),
      locked, notCounted, hodProxied, overdue: reviewOverdueOf(c, i, today), selfOverdue, tags,
    });
  }
  const stats = new Map();
  for (const r of rows) {
    if (!stats.has(r.cycleId)) {
      const c = cycleOf(r.cycleId);
      stats.set(r.cycleId, {
        cycleId: c.id, cycle: c.name, flow: c.flow || null, kind: c.kind || "quarter", dueAt: c.dueAt || null, dueRateAt: c.dueRateAt || null,
        counted: 0, excluded: 0, selfDone: 0, oneOnOneDone: 0, oneMgrOnly: 0, oneEmpOnly: 0, rated: 0, proxied: 0, distribution: {},
        byStatus: { all: 0, self: 0, one: 0, rate: 0, rated: 0, locked: 0, left: 0 }, todo: { rate: 0, oneOnOne: 0 },
      });
    }
    const s = stats.get(r.cycleId);
    s.byStatus.all++;
    for (const t of r.tags) s.byStatus[t]++;
    if (r.notCounted) { s.excluded++; continue; }
    s.counted++;
    if (r.selfAt) s.selfDone++;
    if (r.oneState === "both") s.oneOnOneDone++;
    else if (r.oneState === "mgr") s.oneMgrOnly++;
    else if (r.oneState === "emp") s.oneEmpOnly++;
    if (r.managerRating || r.hodProxied) s.rated++;
    if (r.hodProxied) s.proxied++;
    if (r.managerRating) s.distribution[r.managerRating] = (s.distribution[r.managerRating] || 0) + 1;
    if (!r.locked && !r.managerRating && !r.hodProxied && (r.selfAt || r.selfOverdue)) s.todo.rate++;
    if (r.flow === "v2" && !r.locked && !r.oneOnOneAt) s.todo.oneOnOne++;
  }
  return { teamRows: rows, teamStats: [...stats.values()] };
}
// 自评提醒的通知：单条 nudge 与批量共用。senderName 有值 = 直属上级发起（单条，正文逐字不变）；
// null = HR 批量发起（标题相同，正文改为中性说法）。
function reviewSelfReminderMsg(cycle, senderName) {
  const due = cycle.dueAt ? String(cycle.dueAt).slice(0, 10) : "";
  return {
    type: "review",
    title: `Reminder: please submit your self-review for ${cycle.name}`,
    title_zh: `提醒：请提交「${cycle.name}」自评`,
    body: senderName ? `Your manager ${senderName} has asked you to submit your self-review for ${cycle.name}${due ? `, due ${due}` : ""}.`
      : `Please submit your self-review for ${cycle.name} under Performance Reviews${due ? ` by ${due}` : ""}.`,
    body_zh: senderName ? `你的直属上级 ${senderName} 提醒你提交「${cycle.name}」自评${due ? `，截止日期 ${due}` : ""}。`
      : `请${due ? `在 ${due} 前` : ""}在「绩效评估」中提交「${cycle.name}」自评。`,
    // 第二批 2.5（2026-10-08）：通知直达对应页签
    link: "/review?view=mine",
  };
}
// 其余三个阶段的通知。manager：n = 这位上级在该周期（操作者范围内）全部待评级的人数，不只是这次勾选的人
function reviewReminderMsg(stage, cycle, n, g) {
  // 第二批 2.5（2026-10-08）：通知直达对应页签 —— 员工 ?view=mine，上级 ?view=team，HoD ?view=hod&cycle=&unit=
  if (stage === "one_on_one") return {
    type: "review", link: "/review?view=mine",
    title: `Reminder: please confirm your 1-on-1 for ${cycle.name}`, title_zh: `提醒：请确认「${cycle.name}」1 对 1 面谈`,
    body: "After the 1-on-1 with your manager, log it under Performance Reviews.", body_zh: "与直属上级完成 1 对 1 面谈后，请在「绩效评估」中登记。",
  };
  if (stage === "manager") {
    const d = cycle.dueRateAt || "";
    return {
      type: "review", link: "/review?view=team",
      title: `Reminder: ${n} direct report(s) awaiting your rating for ${cycle.name}${d ? ` (due ${d})` : ""}`,
      title_zh: `提醒：「${cycle.name}」还有 ${n} 位下属待你评级${d ? `（截止 ${d}）` : ""}`,
      // 第二批 2.1：面谈与评级各自登记，面谈不是评级的前提
      body: "Open Performance Reviews › Team reviews to rate them. Log the 1-on-1 separately; it isn't required for the rating.",
      body_zh: "请在「绩效评估 › 团队评估」中评级；1 对 1 面谈单独登记，不是评级的前提。",
    };
  }
  const d = cycle.dueCalibAt || "";                          // hod
  const hodLink = `/review?view=hod&cycle=${encodeURIComponent(cycle.id)}${g && g.dept1Id ? `&unit=${encodeURIComponent(g.dept1Id)}` : ""}`;
  if (cycle.kind === "annual") return {
    type: "review", link: hodLink,
    title: `Reminder: please propose annual ratings for ${cycle.name}${d ? ` by ${d}` : ""}`,
    title_zh: `提醒：请${d ? `在 ${d} 前` : ""}提交「${cycle.name}」本部门年度评级`,
    body: "Open Performance Reviews › Department Calibration.", body_zh: "请在「绩效评估 › 部门校准」中操作。",
  };
  return {
    type: "review", link: hodLink,
    title: `Reminder: please submit the calibration of ${(g && g.dept1) || "your department"} for ${cycle.name}${d ? ` by ${d}` : ""}`,
    title_zh: `提醒：请${d ? `在 ${d} 前` : ""}提交 ${(g && g.dept1) || "本部门"} 在「${cycle.name}」的校准结果`,
    body: "Open Performance Reviews › Department Calibration.", body_zh: "请在「绩效评估 › 部门校准」中操作。",
  };
}
// 提交后的副作用：发通知 + 写审计（e.to 是收件人 id 字符串）。两个动作名都写字面量（审计标签测试只认字面量）：
// 自评复用单条的 review.nudge（审计载荷逐字相同），其余阶段 review.remind。
function emitReviewReminder(audit, e) {
  notify(e.to, e.msg);
  if (e.kind === "nudge") audit("review.nudge", e.target, null, e.after);
  else audit("review.remind", e.target, null, e.after);
}
// 计划：只读业务数据，当场写节流表 nudgedAt；返回逐项结果、待发的 effects 与跳过的人数。
//   stage / by / ids 已校验；fixedCycle = 请求带的 cycleId 对应的周期（已校验存在且进行中），没带为 null；
//   scope = scopePredicate(操作者)（null = 不受限）。by:"item" / by:"dept" 的越界整批拒绝在调用方先做完。
function planReviewReminders({ stage, by, ids, fixedCycle, scope }) {
  const now = Date.now();
  let snap = null;
  const users = new Map();
  const userOf = (id) => { if (!id) return null; if (!users.has(id)) users.set(id, store.getUserById(id)); return users.get(id); };
  const inScope = (i) => !scope || scope(userOf(i.userId));
  const ctxs = new Map();
  const ctxOf = (cycle) => {
    if (ctxs.has(cycle.id)) return ctxs.get(cycle.id);
    snap = snap || orgSnapshot();
    const all = store.listCycleItems(cycle.id);
    const groups = reviewGroups(cycle, all, snap);
    const groupOf = new Map();
    for (const g of groups) for (const i of g.items) groupOf.set(i.id, g);
    const ctx = { cycle, all, byId: new Map(all.map((i) => [i.id, i])), groups, groupOf, v2: cycle.flow === "v2" };
    ctxs.set(cycle.id, ctx);
    return ctx;
  };
  // 部门锁只看 v2。P0 E4：「__none」组（未归部门）被 HR 确认后同样锁定，与 reviewSelfLocked / 上级评级的锁同一口径
  const statusOf = (ctx, i) => { const g = ctx.groupOf.get(i.id); return ctx.v2 && g ? g.status : null; };
  // 这位上级在该周期、操作者范围内全部「等他评级」的人数（员工已交自评或自评已逾期、尚未评级、没被 HoD 代评、仍在职、部门未锁）
  const today = todayLocal();
  const awaitingRating = (ctx, managerId) => ctx.all.filter((i) => i.managerId === managerId && !i.managerRating && (i.selfAt || reviewSelfOverdue(ctx.cycle, i, today))
    && !reviewHodProxyOf(ctx.cycle, i, userOf) && reviewRecipientOk(userOf(i.userId)) && inScope(i) && !reviewDeptLocked(statusOf(ctx, i))).length;
  // 条目判定（self / one_on_one / manager）→ { code } 或 { to, key }
  const judgeItem = (ctx, i) => {
    const st = statusOf(ctx, i);
    if (stage === "self") {
      if (i.selfAt) return { code: "not_pending" };
      if (st && (st.hodSubmittedAt || st.hrConfirmedAt || st.returnedAt)) return { code: "dept_locked" };   // = reviewSelfLocked
      if (!reviewRecipientOk(userOf(i.userId))) return { code: "recipient_inactive" };
      return { to: i.userId, key: i.id };
    }
    if (stage === "one_on_one") {
      if (i.employeeOneOnOneAt) return { code: "not_pending" };
      // 第二批 2.1（2026-10-08）：面谈与评级各自独立登记，员工登记面谈不再以自评为前提；上级这一侧还没登记时，
      // 催员工登记为时过早（面谈可能还没开），先提醒上级（负责人 2026-10-07）
      if (!i.oneOnOneAt) return { code: "manager_pending" };
      if (reviewDeptLocked(st)) return { code: "dept_locked" };
      if (!reviewRecipientOk(userOf(i.userId))) return { code: "recipient_inactive" };
      return { to: i.userId, key: "one_on_one|" + i.id };
    }
    // manager（HoD 已代评 = 这一步已完成；参与者已离职 → participant_departed，第二批 2.7）
    if (i.managerRating || reviewHodProxyOf(ctx.cycle, i, userOf)) return { code: "not_pending" };
    if (!reviewRecipientOk(userOf(i.userId))) return { code: "participant_departed" };
    // 「没有在职的直属上级」：快照上级已离职 / 停用或为空（HoD 页提示可由 HoD 代评）—— 没有人可提醒，先于自评判定
    if (!i.managerId || !reviewRecipientOk(userOf(i.managerId))) return { code: "no_manager" };
    // 上级在员工交自评之后、或自评逾期之后评级（D1）
    if (!i.selfAt && !reviewSelfOverdue(ctx.cycle, i, todayLocal())) return { code: "self_pending" };
    if (ctx.v2 && reviewDeptLocked(st)) return { code: "dept_locked" };
    return { to: i.managerId, key: `manager|${ctx.cycle.id}|${i.managerId}` };
  };
  // 部门判定（hod）
  const judgeGroup = (ctx, g) => {
    if (g.status && (g.status.hodSubmittedAt || g.status.hrConfirmedAt)) return { code: "not_pending" };
    if (!g.hod) return { code: "no_hod" };
    // 第二批（负责人 G5，2026-10-08）：HoD 可以代评，不再等部门内都评完才提醒 HoD（hod_not_ready 不再产生）
    if (!reviewRecipientOk(userOf(g.hod.id))) return { code: "recipient_inactive" };
    return { to: g.hod.id, key: `hod|${ctx.cycle.id}|${g.dept1Id}` };
  };
  // 第一步：逐项判定，收集「行 → 若干条目」
  const rows = [];   // { id, kind: "item" | "group", entries: [{ ctx, i | g, verdict }], pre: code | null }
  const entryOf = (ctx, x, isGroup) => ({ ctx, x, isGroup, verdict: isGroup ? judgeGroup(ctx, x) : judgeItem(ctx, x) });
  if (by === "item") {
    for (const id of ids) {
      const i = store.getReviewItem(id);
      if (!i || (fixedCycle && i.cycleId !== fixedCycle.id)) { rows.push({ id, pre: "not_found" }); continue; }
      const cycle = fixedCycle || store.getReviewCycle(i.cycleId);
      if (!cycle) { rows.push({ id, pre: "not_found" }); continue; }
      if (cycle.status !== "open") { rows.push({ id, pre: "cycle_closed" }); continue; }
      if (!reviewStageApplies(cycle, stage)) { rows.push({ id, pre: "stage_not_applicable" }); continue; }
      const ctx = ctxOf(cycle);
      rows.push({ id, single: true, entries: [entryOf(ctx, ctx.byId.get(i.id) || i, false)] });
    }
  } else if (by === "cycle") {
    for (const id of ids) {
      const cycle = store.getReviewCycle(id);
      if (!cycle) { rows.push({ id, pre: "not_found" }); continue; }
      if (cycle.status !== "open") { rows.push({ id, pre: "cycle_closed" }); continue; }
      if (!reviewStageApplies(cycle, stage)) { rows.push({ id, pre: "stage_not_applicable" }); continue; }
      const ctx = ctxOf(cycle);
      // 按周期选：收窄到范围内，不整批拒绝（与周期列表、逾期一键提醒同口径）；HoD 阶段只提醒整组都在范围内的部门，
      // 组里还有范围外人员的部门（周期详情的 scopePartial）尚未提交时记为跳过 hod_scope_partial，不并入「没有待完成的人」；
      // 整组都在范围外的部门不出现
      const entries = stage === "hod"
        ? ctx.groups.flatMap((g) => g.items.every(inScope) ? [entryOf(ctx, g, true)]
          : g.items.some(inScope) ? [{ ctx, x: g, isGroup: true, verdict: { code: g.status && (g.status.hodSubmittedAt || g.status.hrConfirmedAt) ? "not_pending" : "hod_scope_partial" } }]
          : [])
        : ctx.all.filter(inScope).map((i) => entryOf(ctx, i, false));
      rows.push({ id, entries });
    }
  } else {
    const ctx = ctxOf(fixedCycle);
    const applies = reviewStageApplies(fixedCycle, stage);
    for (const id of ids) {
      const g = ctx.groups.find((x) => x.dept1Id === id);
      if (!g) { rows.push({ id, pre: "not_found" }); continue; }
      if (!applies) { rows.push({ id, pre: "stage_not_applicable" }); continue; }
      if (stage === "hod") { rows.push({ id, entries: [entryOf(ctx, g, true)] }); continue; }   // 越界的组调用方已整批拒绝
      // 自评 / 面谈 / 上级评级：按部门选时收窄到范围内的人（与按周期同口径，负责人 2026-10-07）
      const mine = g.items.filter(inScope);
      if (!mine.length) { rows.push({ id, pre: "not_found" }); continue; }
      rows.push({ id, entries: mine.map((i) => entryOf(ctx, i, false)) });
    }
  }
  // 第二步：按节流键合并（同一上级的多个条目 = 一条通知），逐键判节流；没被节流的键当场记下时间，生成 effect
  const byKey = new Map();
  for (const r of rows) for (const e of r.entries || []) if (e.verdict.key) { if (!byKey.has(e.verdict.key)) byKey.set(e.verdict.key, []); byKey.get(e.verdict.key).push(e); }
  const effects = [];
  for (const [key, list] of byKey) {
    const last = nudgedAt.get(key);
    if (last && now - last < REVIEW_REMIND_COOLDOWN_MS) { for (const e of list) e.verdict = { code: "cooldown" }; continue; }
    nudgedAt.set(key, now);
    const { ctx, x } = list[0];
    const cycle = ctx.cycle;
    const to = list[0].verdict.to;
    if (stage === "self") effects.push({ id: key, kind: "nudge", to, msg: reviewSelfReminderMsg(cycle, null), target: x.id, after: { userId: x.userId, cycle: cycle.name } });
    else if (stage === "one_on_one") effects.push({ id: key, kind: "remind", to, msg: reviewReminderMsg(stage, cycle), target: x.id, after: { stage, userId: to, items: 1, cycle: cycle.name } });
    else if (stage === "manager") {
      const n = Math.max(awaitingRating(ctx, to), list.length);
      effects.push({ id: key, kind: "remind", to, msg: reviewReminderMsg(stage, cycle, n), target: cycle.id, after: { stage, userId: to, items: n, cycle: cycle.name } });
    } else effects.push({ id: key, kind: "remind", to, msg: reviewReminderMsg(stage, cycle, 0, x), target: cycle.id, after: { stage, userId: to, items: x.quotaItems.length, cycle: cycle.name, dept1: x.dept1 } });
  }
  // 第三步：逐行结果。「这一步已完成」= 未改动（bulkUnchanged，统一规则）；被跳过的人数不含已完成的
  let skippedPeople = 0;
  const results = rows.map((r) => {
    if (r.pre) { skippedPeople++; return bulkSkip(r.id, r.pre); }
    if (r.single) {
      const v = r.entries[0].verdict;
      if (v.code === "not_pending") return bulkUnchanged(r.id);
      if (v.code) { skippedPeople++; return bulkSkip(r.id, v.code); }
      return { id: r.id, ok: true };
    }
    const pending = r.entries.filter((e) => e.verdict.code !== "not_pending");
    if (!pending.length) return bulkUnchanged(r.id);                        // 这一步没有待完成的人
    const skippedBy = {};
    for (const e of pending) if (e.verdict.code) skippedBy[e.verdict.code] = (skippedBy[e.verdict.code] || 0) + 1;
    const skipped = Object.values(skippedBy).reduce((a, b) => a + b, 0);
    skippedPeople += skipped;
    const reminded = pending.length - skipped;
    if (!reminded) {
      const top = Object.entries(skippedBy).sort((a, b) => b[1] - a[1])[0][0];
      return bulkSkip(r.id, top, { pending: pending.length, skippedBy });
    }
    return { id: r.id, ok: true, pending: pending.length, reminded, skippedBy };
  });
  return { results, effects, skippedPeople };
}
// { level1, level2, level3, isDirect, isDirect2, level1Id, level2Id, level3Id }。level2 为 null 且
// isDirect = true 即二级「本部」（三级不适用）；level3 为 null 且 isDirect2 = true 即三级「本部」
// （展示文案 orgLib.DIRECT_LABEL）；四级及更深并入三级祖先；部门为空/不在部门表/父链成环 →
// 名称皆 null、两个标记皆 false。只读部门表（不传快照时不会去读 users）。
function deptLevelsOf(user, snap) {
  const levelsOf = snap ? snap.levelsOf : orgLib.buildOrgIndex(store.listDepartments(true)).levelsOf;
  const lv = user ? levelsOf(user.department) : null;
  if (!lv) return { level1: null, level2: null, level3: null, isDirect: false, isDirect2: false, level1Id: null, level2Id: null, level3Id: null };
  return { level1: lv.level1, level2: lv.level2, level3: lv.level3, isDirect: lv.isDirect, isDirect2: lv.isDirect2, level1Id: lv.level1Id, level2Id: lv.level2Id, level3Id: lv.level3Id };
}
// GET /api/admin/departments/hods(.csv) 的载荷。
// P2 范围：范围受限的角色只看到**整棵子树都在范围内**的一级部门。一行里的成员数、候选人、
// 推算出的 HoD 都由整棵子树导出；子树只有一部分在范围内时（范围是「一级部门、不含下级」，
// 或只含其中某个二级部门），这一行会带出范围外的人名与人数；而按范围内的人重算又会让同一个
// 一级部门在不同人眼里有不同的 HoD（hodOf 只有一个答案）。所以那一行整条不返回，与「不存在」
// 同形；summary 在过滤之后重算，分母与表格行对得上。负责人（ownerId）本人在范围外时仍显示
// 姓名与工号 —— 与 GET /departments 的 ownerName / ownerEmployeeId、org-chart 方案 B 同一条取舍：
// 他就是这个范围的上级线；但**他所在的部门与职位**不给（那会报出一个范围外部门的名字，
// GET /departments 也只给姓名与工号）：范围受限时，部门不在范围内的人，department / position
// 置空（与 org-chart 骨架节点同一做法）。推算出的 HoD 与候选人都是子树成员，行可见时天然在范围内。
// 负责人状态对范围受限的角色只分「在职 / 不在职」：missing（账号已删）并入 inactive，
// 不透露范围外某个账号是否还存在；ownerInactive 这个布尔值才是界面要的信号。
// 未归属人员（部门为空、不在部门表、父链成环、所属一级部门已停用）按其部门名过滤：前三种对
// 范围受限的角色天然为空（范围只由部门表里在树上的部门构成）；第四种的 level1（那个停用的一级
// 部门名）只在它本身也在范围内时才给。部门名只差大小写的重名组
// （duplicateNames）只给不受范围限制的角色 —— 范围按名称解析，区分不了同名的两条部门。
// scoped 告诉前端「这份名单按你的数据范围裁过」：空名单时说清楚原因，而不是显示「暂无一级部门」。
function hodListFor(user) {
  const snap = orgSnapshot();
  const { items, unassignedPeople, duplicateNames } = snap.hods;
  const deptScope = scopeDeptPredicate(user);
  if (!deptScope) return { generatedAt: new Date().toISOString(), scoped: false, summary: orgLib.summarize(items, unassignedPeople), items, unassignedPeople, duplicateNames };
  const person = (p) => (!p || deptScope(p.department) ? p : { ...p, department: null, position: null });
  const visible = items.filter((it) => snap.index.subtreeOf(it.deptId).every((d) => deptScope(d.name))).map((it) => ({
    ...it,
    hod: person(it.hod),
    candidates: it.candidates.map(person),
    owner: it.owner && it.owner.status === "missing" ? { ...it.owner, status: "inactive" } : it.owner,
  }));
  // 所属一级部门已停用（inactive_level1）的人：他本人的部门在范围内，那个一级部门却可能不在（范围
  // 只含其下某个二级部门）—— 那时不报它的名字（level1 置空），与上面「范围外的部门名不进载荷」同一条线。
  const unassigned = unassignedPeople.filter((p) => deptScope(p.department))
    .map((p) => (p.level1 && !deptScope(p.level1) ? { ...p, level1: null } : p));
  return { generatedAt: new Date().toISOString(), scoped: true, summary: orgLib.summarize(visible, unassigned), items: visible, unassignedPeople: unassigned, duplicateNames: [] };
}
// CSV：表头与「来源」单元格中英双语（与 records.csv 同一取舍：CSV 是交换面，不跟界面语言走）。
// 防公式注入与 BOM 由 sendCsv / csvEscape 负责。
const HOD_SOURCE_CSV = {
  owner: "负责人 Owner",
  derived: "自动推算 Derived",
  ambiguous: "需确认 Needs review",
  none: "无在职人员 No active members",
};
function hodCsvRows(list) {
  const rows = [["一级部门 Level-1 department", "HoD 姓名 HoD name", "工号 Employee ID", "来源 Source", "候选人 Candidates", "成员数 Members"]];
  for (const it of list.items) {
    const src = [HOD_SOURCE_CSV[it.source] + (it.reason === "loop" || it.reason === "loop_with_top" ? "（汇报线成环 reporting loop）" : "")];
    if (it.ownerInactive) {
      const o = it.owner || {};
      src.push("负责人已离职 Owner inactive" + (o.name ? `: ${o.name}${o.employeeId ? ` (${o.employeeId})` : ""}` : ""));
    }
    rows.push([
      it.deptName,
      it.hod ? it.hod.name : "",
      it.hod ? it.hod.employeeId : "",
      src.join("; "),
      it.candidates.map((c) => (c.employeeId ? `${c.name} (${c.employeeId})` : c.name)).join("; "),
      it.memberCount,
    ]);
  }
  return rows;
}
// Classes I am the head of (→ 班主任). Draft projects don't count.
function myClasses(userId) {
  const out = [];
  for (const doc of TPROJECTS) {
    if (doc.status === "draft") continue;
    for (const cohort of doc.cohorts || []) {
      for (const cls of cohort.classes || []) {
        if (cls.headId === userId) out.push({ doc, cohort, cls });
      }
    }
  }
  return out;
}
function classSummary(c) {
  const learners = store.listProjectMembers(c.doc.id)
    .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === c.cohort.id && m.classId === c.cls.id);
  return {
    projectId: c.doc.id, cohortId: c.cohort.id, classId: c.cls.id,
    project: c.doc.title, project_zh: c.doc.title_zh || null,
    cohort: c.cohort.name, className: c.cls.name,
    startAt: c.cohort.startAt || null, endAt: c.cohort.endAt || null,
    learnerCount: learners.length,
  };
}
// Sessions I teach (→ 讲师): project activities and standalone in-person courses
// whose trainerId is me. `key` identifies a session across both kinds.
function mySessions(userId) {
  const out = [];
  for (const doc of TPROJECTS) {
    if (doc.status === "draft") continue;
    for (const cohort of doc.cohorts || []) {
      for (const a of tpActivities(cohort)) {
        if (a.trainerId !== userId) continue;
        // 线上活动只有「讲师或 HR 登记」方式才是讲师的场次；没有名单的活动（考试、线上课程、学习包）也不算
        if (a.type === "online" && tpActivityView(a).completion !== "trainer") continue;
        if (!tpRosterTarget(a, doc, cohort)) continue;
        out.push({ kind: "activity", key: `a.${doc.id}.${cohort.id}.${a.id}`, doc, cohort, act: a });
      }
    }
  }
  for (const c of COURSES) {
    if (c.trainerId !== userId) continue;
    if ((c.status || "draft") === "draft") continue;
    out.push({ kind: "course", key: `c.${c.id}`, course: c });
  }
  return out;
}
function sessionSummary(s) {
  if (s.kind === "course") {
    const c = s.course;
    return {
      key: s.key, kind: "course",
      title: c.title, title_zh: c.title_zh || null,
      startAt: c.sessionAt || null, location: c.location || null,
      context: null, context_zh: null,
      mode: c.mode || "online",
      category: (c.mode || "online") === "offline" ? "offline_course" : "online_course",
    };
  }
  const v = tpActivityView(s.act);
  return {
    key: s.key, kind: "activity",
    title: v.title, title_zh: v.title_zh,
    startAt: v.startAt, location: v.location,
    context: `${s.doc.title} · ${s.cohort.name}`,
    context_zh: `${s.doc.title_zh || s.doc.title} · ${s.cohort.name}`,
    mode: v.type === "online" ? "online" : (v.mode || "offline"),
    category: v.category,
    completion: v.completion || null,
    url: v.url || null,
    durationMin: v.durationMin || null,
  };
}
// Resolve a session key back to its attendee list, with the ownership check —
// returns null when the caller is not that session's trainer.
function trainerSessionScope(userId, key) {
  const s = mySessions(userId).find((x) => x.key === key);
  if (!s) return null;
  if (s.kind === "course") {
    const pids = programsContaining(s.course.id, s.course);
    const attendees = [];
    for (const u of store.listUsers()) {
      // 只排除纯服务账号（与培训概览、逾期提醒同一人群，2026-10-07）：后台账号同时是员工的也在名单上，讲师能为其登记出勤
      if (LC.isServiceAccount(u) || u.active === 0) continue;
      const asg = store.getUserAssignments(u.id);
      if (!pids.some((pid) => asg[pid])) continue;
      attendees.push({ userId: u.id, name: u.name, employeeId: u.employeeId, department: u.department || null, className: null });
    }
    return { ...s, checkinId: courseCkId(s.course.id), projectId: "__course__", cohortId: s.course.id, rollKind: "checkin", attendees };
  }
  // Everyone in the cohort attends the session the trainer runs, whatever class
  // they belong to — that is exactly what distinguishes this from a class head.
  const attendees = store.listProjectMembers(s.doc.id)
    .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === s.cohort.id)
    .map((m) => {
      const u = store.getUserById(m.userId);
      if (!u || u.active === 0) return null;
      const cls = (s.cohort.classes || []).find((c) => c.id === m.classId);
      return { userId: m.userId, name: u.name, employeeId: u.employeeId, department: u.department || null, className: cls ? cls.name : null };
    }).filter(Boolean);
  // 签到类场次与「讲师或 HR 登记」的线上活动才有名单；其余返回 null（路由回 404）
  const tgt = tpRosterTarget(s.act, s.doc, s.cohort);
  if (!tgt) return null;
  return { ...s, checkinId: tgt.ckId, projectId: tgt.projectId, cohortId: tgt.cohortId, rollKind: tgt.rollKind, attendees };
}
// Class-head roll-call scope for one activity of their cohort: own class only.
function trainerActivityScope(userId, projectId, activityId) {
  for (const c of myClasses(userId)) {
    if (c.doc.id !== projectId) continue;
    const act = tpActivities(c.cohort).find((a) => a.id === activityId);
    if (!act) continue;
    const learners = store.listProjectMembers(c.doc.id)
      .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === c.cohort.id && m.classId === c.cls.id);
    return { doc: c.doc, cohort: c.cohort, cls: c.cls, act, learners };
  }
  return null;
}
// Validate + whitelist a record's detail against the FIELD CONFIG of its type
// (typeKey "user" = custom employee fields stored in users.extras). Unknown
// keys are dropped so garbage can never enter the JSON. → {detail}|{error,code,field}
// The `error` strings stay as they are (import reports and existing tests print
// them), but they glue an English field label into a half-Chinese sentence, which
// can never be localized server-side — the server does not know the reader's
// language. So every failure also names WHAT went wrong (code) and WHICH field
// (field.key), which is enough for the client to build the message from its own
// dictionary plus the label_zh it already has in the field config.
// `fields` 可选：批量导入在一个同步事务里逐行调用，字段配置不会中途变化，调用方按类型
// 只读一次传进来，免得每行都把 record_fields 整表读一遍、解析一遍。
function buildRecordDetail(typeKey, src, fields) {
  const detail = {};
  for (const f of fields || store.listRecordFields(typeKey)) {
    let v = src ? src[f.key] : undefined;
    if (f.input === "checkbox") { if (v) detail[f.key] = true; continue; }
    if (v === undefined || v === null || String(v).trim() === "") {
      if (f.required) return { error: `"${f.label}" is required 必填`, code: "field_required", field: f.key };
      continue;
    }
    if (f.input === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `"${f.label}" must be a number 需为数字`, code: "field_number", field: f.key };
      detail[f.key] = n;
    } else if (f.input === "date") {
      v = String(v).slice(0, 10);
      if (!validDateStr(v)) return { error: `"${f.label}" must be YYYY-MM-DD`, code: "field_date", field: f.key };
      detail[f.key] = v;
    } else if (f.input === "select") {
      v = String(v).trim();
      // Accept either language and store the canonical value: HR imports CSVs
      // exported from a Chinese screen, so rejecting "通过" would fail an import
      // of data the UI itself produced — and accepting it verbatim would leave
      // two spellings of one option in the table.
      const canon = canonOption(f, v);
      // `value` travels so the client never has to parse the sentence to find out
      // WHICH value was rejected — that regex broke the moment anyone reworded this.
      if (canon === null) return { error: `"${f.label}": "${v}" is not one of the configured options 不在可选项中`, code: "field_option", field: f.key, value: v };
      detail[f.key] = String(canon).slice(0, 500);
    } else if (f.input === "level" || f.input === "department") {
      // Catalog-backed selects in the UI; the server stays lenient so
      // historical imports with retired ranks/departments still load.
      detail[f.key] = String(v).trim().slice(0, 100);
    } else {
      // A `suggest` field also carries a configured list, but free text must keep
      // passing — so an unmatched value is stored as typed, while one that matches
      // the Chinese half becomes its canonical twin. Without this the same option
      // has two spellings depending on the entry path (dropdown vs Chinese CSV)
      // and the facet list shows it twice.
      const typed = String(v).trim();
      const canon = (f.options || []).length ? canonOption(f, typed) : null;
      detail[f.key] = String(canon === null ? typed : canon).slice(0, f.input === "textarea" ? 2000 : 500);
    }
  }
  return { detail };
}
function deriveRecordTitle(typeKey, detail) {
  // CX-135：缺一侧时写「—」（原来写「?」，像数据出错）。标题会存库且没有 title_zh，所以不写「未设」这类带语言的词。
  if (typeKey === "promotion" && (detail.fromLevel || detail.toLevel)) return `${detail.fromLevel || "—"} → ${detail.toLevel || "—"}`;
  if (typeKey === "transfer" && (detail.fromDept || detail.toDept)) return `${detail.fromDept || "—"} → ${detail.toDept || "—"}`;
  if (typeKey === "performance" && detail.period) return `${detail.period} performance`;
  if (typeKey === "training" && detail.programName) return String(detail.programName);
  if (typeKey === "award" && detail.awardName) return String(detail.awardName);
  // Nothing data-derived left to name it with. Return EMPTY rather than the type
  // label: the label has a language, talent_records has no title_zh, and whatever
  // goes in here is frozen forever — a record created from a Chinese screen would
  // read "Note" for the rest of its life. Every surface that prints a title also
  // has the record's type at hand, so an empty title renders as the type name in
  // the reader's own language instead.
  return "";
}
// Resolve a record type by key OR by either of its labels — bulk imports and
// talent searches carry human names in whichever language HR typed (培训 or
// Training). Both languages must be tried: the labels used to be one bilingual
// string ("培训 Training"), and matching only `label` after the split left every
// Chinese type name unresolvable — an import full of "unknown type 未知类型".
function resolveRecordType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  const direct = store.getRecordType(s);
  if (direct) return direct;
  for (const t of store.listRecordTypes(true)) {
    for (const name of [t.label, t.label_zh]) {
      if (!name) continue;
      const L = String(name).toLowerCase();
      if (L === s || L.split(/\s+/).includes(s)) return t;
    }
  }
  return null;
}
// 记录类型的所属模块（2026-09-28 负责人拍板）。culture-program「行为实践」由 core 的数据迁移 51 种入（core 订阅
// culture.program.completed 写它，所以没有开启 culture 的部署里它同样存在），但只在 culture 开启时出现在「字段设置」与
// 新建记录（单条、批量导入）的类型选择里；已有记录照常显示（档案时间线、「我的记录」、导出）；人才检索不列出该类型，接口返回 400 record_type_unavailable（R-363）。
// 所属模块关闭时：配置接口给该类型标 moduleOff: true（界面据此不列出，见 recordTypesOut）；新建该类型的记录、把已有记录
// 改成该类型一律拒绝（400 record_type_unavailable，批量导入逐行 skipped）；编辑已有的该类型记录照常。
// 开关现读（modulesOn，值为真才算开 —— 与 serveStatic 的模块门同一判定）。键是类型 key，值是可售模块 id。
const RECORD_TYPE_MODULE = Object.freeze({ "culture-program": "culture" });
function recordTypeModuleOff(key, mods) {
  const m = RECORD_TYPE_MODULE[key];
  return !!m && !(mods || modulesOn())[m];
}
// 下发给后台界面的记录类型清单（字段设置、档案页 config、批量导入与人才检索的类型下拉）：每个类型多一个 moduleOff。
function recordTypesOut(mods) {
  const on = mods || modulesOn();
  return store.listRecordTypes(true).map((t) => ({ ...t, moduleOff: recordTypeModuleOff(t.key, on) }));
}
const RECORD_TYPE_UNAVAILABLE = Object.freeze({
  error: "This record type belongs to a module that is switched off. 该记录类型所属的模块未开启。",
  code: "record_type_unavailable",
});
// Record side effects — lifecycle records sync the employee master data when
// their checkbox field is ticked (入转调离 + 晋级 all flow through here):
//   promotion + syncLevel       → jobLevel = toLevel (only if result is a pass)
//   transfer + syncDept         → department = toDept (+ position; auto-registers dept)
//   regularization + syncStatus → empStatus = regular (only if result is a pass)
//   exit + syncStatus           → empStatus = exited + account deactivated
// Result matching is by keyword so it survives HR renaming the options.
// onSessionsRevoked: optional access-log hook. An 离职 record with 同步状态 on
// deactivates the account and cuts its live sessions, and that kick has to show
// up in the trail like every other one — but this function has no request scope,
// so the caller hands in the logger instead of it reaching for a global.
// P2 范围：记录副作用里唯一会改变「这个人属于哪个部门」的是 transfer + syncDept。
// 返回它将写进 users.department 的部门名，没有则 null。调用方（records 的 POST 与
// PUT）必须在 applyRecordSideEffects **之前**用它过一次 scopeAllowsDeptFor，口径与
// PUT /employees/:id 的 department 双校验一致；条件只写在这里一处，防止与下面那张
// 副作用表分叉（分叉处就是漏洞）。
function recordSyncsDepartment(typeKey, detail) {
  return typeKey === "transfer" && detail && detail.syncDept && detail.toDept ? String(detail.toDept) : null;
}
// 登记部门（ensureDepartment：已有则取已有的，没有则新建为一级）并返回部门表里的**规范写法**：
// 输入「sales」而表里已有「Sales」时存「Sales」。写 users.department 的每条路径（PUT
// employees/:id、bulk-update、POST employees、employees/bulk、调动记录的副作用）都经过这里，
// 库里同一个部门只留一种写法 —— 改名级联、删除前的人数校验、范围解析与 HoD 推算虽然都已按
// 「不区分大小写」对齐（store.usersResolvingTo / org.js deptOf），规范写法仍是最稳的一层。
// 空值原样返回。
function canonicalDept(name) {
  if (name === null || name === undefined || String(name).trim() === "") return name;
  const row = store.ensureDepartment(name);
  return row ? row.name : String(name).trim();
}
// 「结果算不算通过」：与 web/src/pages/admin/People.jsx 的 PASS_RE / FAIL_RE 逐字同一对正则（test/sync-hint.test.js 钉住）。
const passOk = (v) => /通过|passed|按期|on time/i.test(String(v || "")) && !/未通过|failed/i.test(String(v || ""));
// 一条记录会把主数据改成什么 —— 副作用的「签名」；null = 这条记录不改主数据。上面那张副作用表
// 的触发条件只写在这里一处：applyRecordSideEffects 据它决定做不做，PUT records/:rid 据它决定
// 这次编辑要不要**重新**同步（签名没变 = 同步的内容没变，不重跑）。
//   promotion       syncLevel + toLevel + 结果为通过   → 签名含 toLevel
//   transfer        syncDept + toDept                → 签名含 toDept（按部门匹配口径：去空白、不分大小写）
//   regularization  syncStatus + 结果为通过           → 固定签名
//   exit            syncStatus                       → 固定签名
// 调动记录的「调入岗位」不进签名：只改岗位就重跑，会连部门一起写回 toDept —— 人后来又调走了的话，
// 等于把他调回去。主数据里的岗位请在员工档案里改。
function recordSyncSignature(typeKey, detail) {
  const d = detail || {};
  if (typeKey === "promotion") return d.syncLevel && d.toLevel && passOk(d.result) ? "promotion|" + String(d.toLevel).trim() : null;
  if (typeKey === "transfer") return d.syncDept && d.toDept ? "transfer|" + String(d.toDept).trim().toLowerCase() : null;
  if (typeKey === "regularization") return d.syncStatus && passOk(d.result) ? "regularization" : null;
  if (typeKey === "exit") return d.syncStatus ? "exit" : null;
  return null;
}
// 调用方必须把它与写记录本身包在同一个 store.transaction 里（见 records 的 POST / PUT）：
// 主数据改动、会话吊销、事件行与记录行一起提交或一起回滚；事件在提交之后才分发，订阅方收到
// employee.transferred / terminated 时对应的记录已经在库里。onSessionsRevoked 只收集，审计
// 由调用方在提交之后写。
function applyRecordSideEffects(userId, typeKey, detail, onSessionsRevoked) {
  if (!recordSyncSignature(typeKey, detail)) return;
  if (typeKey === "promotion") {
    store.updateUser(userId, { jobLevel: String(detail.toLevel) });
  } else if (typeKey === "transfer") {
    const fields = { department: canonicalDept(String(detail.toDept)) };
    if (detail.toPosition) fields.position = String(detail.toPosition);
    store.updateUser(userId, fields);
  } else if (typeKey === "regularization") {
    store.updateUser(userId, { empStatus: "regular" });
  } else if (typeKey === "exit") {
    store.updateUser(userId, { empStatus: "exited", active: false });
    store.deleteUserSessions(userId);
    if (onSessionsRevoked) onSessionsRevoked(userId);
  }
  detail.synced = true;
}
// Resolve the manager reference on each matrix line so the client never has to
// hold the whole roster to render "谁 · 什么岗位".
function decorateSecondaryLines(rows) {
  return rows.map((r) => {
    const m = r.managerId ? store.getUserById(r.managerId) : null;
    return {
      id: r.id, userId: r.userId, kind: r.kind,
      managerId: r.managerId || null,
      managerName: m ? m.name : null,
      managerEmployeeId: m ? m.employeeId : null,
      position: r.position || null, department: r.department || null,
      note: r.note || null, createdAt: r.createdAt,
    };
  });
}
// Merged development timeline: manual talent records + LMS-derived events.
// LMS noise is deliberately excluded (assignment stamps, per-attempt spam):
// one synthesized event per program with real activity, plus the hire anchor.
function buildTalentTimeline(u) {
  const records = store.listTalentRecords(u.id);
  // No per-event Chinese copy of `detail` here: this response also carries the
  // full field config, and the admin client pairs value → options_zh by index
  // itself (People.jsx optLabel). Shipping a second map meant every profile open
  // paid for a payload nothing read.
  const events = records.map((r) => ({ source: "record", ...r }));
  const asg = store.getUserAssignments(u.id);
  let lmsPassed = 0;
  for (const p of PROGRAMS) {
    // 结论待定（grading / pending_review）的答卷不计入最好成绩与同期排名，定稿后计入（方案 2.5）
    const attempts = store.listUserAttempts(u.id, p.id).filter((a) => a.gradingStatus !== "grading" && a.gradingStatus !== "pending_review");
    const prog = programProgress(u.id, p);
    if (!attempts.length && prog.percent === 0) continue;
    const best = attempts.length ? attempts.reduce(QT.betterAttempt) : null;
    if (programDone(u.id, p)) lmsPassed++; // 无考试的课程：进度 100% 即算完成
    let rank = null, cohort = 0;
    if (best) {
      const bests = store.listProgramBestScores(p.id);
      cohort = bests.length;
      rank = 1 + bests.filter((r) => r.best > best.percent).length; // competition ranking, ties share
    }
    const firstPass = attempts.filter((a) => a.passed).sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1))[0];
    let date = firstPass ? firstPass.submittedAt : best ? best.submittedAt : null;
    if (!date) {
      for (const c of coursesInProgram(p))
        for (const iso of Object.values(userProgress(u.id, c.id))) if (!date || iso > date) date = iso;
    }
    if (!date) continue;
    events.push({
      source: "lms", type: "training", date: String(date).slice(0, 10), title: p.title, title_zh: p.title_zh || null,
      lms: {
        programId: p.id, progress: prog.percent, attemptCount: attempts.length,
        best: best ? { percent: best.percent, passed: best.passed } : null,
        rank, cohort, blurMax: attempts.reduce((m, a) => Math.max(m, a.blurCount || 0), 0),
        dueAt: asg[p.id] ? asg[p.id].dueAt : null,
        // 第四批 7：指派来源（assigned / self 自主学习；没有指派行的历史记录为 null）
        source: asg[p.id] ? (asg[p.id].source === "self" ? "self" : "assigned") : null,
      },
    });
  }
  // Both titles ship separately so the client localizes with loc(); they used to
  // be glued together ("Account created 建号") and rendered that way in both
  // languages.
  // No department on file → fall back to the (configurable) brand name, per
  // language — the default deployment must never render the word DigiPlus.
  const b = brandCfg();
  const where = u.department || null;
  // source "profile": derived from the employee record itself. Not "lms" (that
  // badge means auto-imported from a course) and not a talent_records row (those
  // carry an id and can be edited) — so it shows with neither AUTO nor edit/delete.
  if (u.hireDate) events.push({ source: "profile", type: "hired", date: u.hireDate, title: "Joined " + (where || b.name), title_zh: "加入 " + (where || b.name_zh) });
  else events.push({ source: "profile", type: "hired", date: String(u.createdAt || "").slice(0, 10), title: "Account created", title_zh: "账号创建" });
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt || "") < (b.createdAt || "") ? 1 : -1));
  const stats = {
    trainingsPassed: lmsPassed + records.filter((r) => r.type === "training").length,
    awards: records.filter((r) => r.type === "award").length,
    violations: records.filter((r) => r.type === "violation").length,
    promotions: records.filter((r) => r.type === "promotion").length,
  };
  return { events, stats };
}
// 9-box helpers (Phase 2 talent review). The performance axis derives from the
// employee's LATEST performance record's rating, bucketed by the rating's
// POSITION in the configured options list (top third = high …). HR reorders or
// renames options in Settings and the grid follows — no hardcoded scale.
// opts：评级选项（调用方在循环外取一次传进来；不传时现读）—— 简化 10/11：九宫格原来每人读一次字段定义
function perfRatingOptions() {
  const f = store.listRecordFields("performance").find((x) => x.key === "rating");
  return f ? f.options : [];
}
function perfBucketOf(rating, opts = perfRatingOptions()) {
  if (!rating) return null;
  const i = opts.indexOf(String(rating));
  if (i === -1 || !opts.length) return null;
  const third = opts.length / 3;
  return i < third ? 2 : i < 2 * third ? 1 : 0; // 2=high 1=mid 0=low
}
const POT_BUCKET = { High: 2, Medium: 1, Low: 0 };
// 九宫格的人员行（12.2 从 GET /api/admin/talent-review 抽出，九宫格页与工作台共用一份口径）。trCycle = 已关闭的评估周期
// （绩效轴取该周期归档进档案的评级）或 null（每人最近一条绩效记录）。人群 = 范围内、在职账号、非系统账号。
// extra(u)（可选）→ 并入每行的附加字段（九宫格页用它带 F60 的 inScope）
function nineBoxRows(user, trCycle, extra) {
  const latestPerf = {};
  if (trCycle) {
    for (const i of store.listCycleItems(trCycle.id)) {
      if (!i.recordId || latestPerf[i.userId]) continue;
      const rec = store.getTalentRecord(i.recordId);
      if (rec && rec.type === "performance") latestPerf[i.userId] = rec;
    }
  } else {
    for (const r of store.listTalentRecordsByType("performance")) {
      if (!latestPerf[r.userId]) latestPerf[r.userId] = r; // list is date DESC
    }
  }
  // P2 范围：九宫格是**过滤**，格子里的数字跟着自然重算 —— 分桶完全由 rows 导出
  // （perfBucket/potBucket 逐行算，前端按这两个字段计数），所以过滤基础人群这一处
  // 就够了，没有第二个分母要改。九宫格是全后台人员密度最高的一屏（姓名/工号/部门/
  // 职级/岗位/标签/评级/潜力八个字段一行），漏过滤等于把全公司人才盘点摊开。
  const trScope = scopePredicate(user);
  // 第二批 2.4 九宫格筛选用的字段：直属上级（工号只在上级也在范围内时给，范围外人员的工号不出响应）、入职日期、
  // 员工状态、职等 / 通道（职级体系索引，同评估周期）、直属下属人数（在职，一次遍历建好）、潜力评定日期（迁移 67）。
  const trAll = store.listUsers();
  const trById = new Map(trAll.map((x) => [x.id, x]));
  const trReports = new Map();
  for (const x of trAll) if (x.managerId && orgLib.isInService(x)) trReports.set(x.managerId, (trReports.get(x.managerId) || 0) + 1);
  const trGrades = reviewGradeIndex();
  const trRatingOpts = perfRatingOptions();
  return trAll
    .filter((u) => u.role !== "admin" && u.active !== 0 && (!trScope || trScope(u)))
    .map((u) => {
      const perf = latestPerf[u.id] || null;
      const rating = perf ? perf.detail.rating ?? null : null;
      const m = u.managerId ? trById.get(u.managerId) || null : null;
      const gr = u.jobLevel ? trGrades.get(String(u.jobLevel).toUpperCase()) : null;
      return {
        id: u.id, name: u.name, employeeId: u.employeeId,
        department: u.department || null, jobLevel: u.jobLevel || null, position: u.position || null,
        talentTags: tagsForViewer(user, u),
        rating, perfDate: perf ? perf.date : null, perfBucket: perfBucketOf(rating, trRatingOpts),
        potential: u.potential || null, potBucket: u.potential ? POT_BUCKET[u.potential] ?? null : null,
        potentialAt: u.potentialAt || null,
        managerId: u.managerId || null, managerName: m ? m.name : null,
        managerEmployeeId: m && (!trScope || trScope(m)) ? m.employeeId : null,
        hireDate: u.hireDate || null, empStatus: u.empStatus || null,
        jobGrade: gr && gr.grade != null ? gr.grade : null, jobTrack: gr ? gr.track || null : null,
        directReports: trReports.get(u.id) || 0,
        ...(extra ? extra(u) : {}),
      };
    });
}
// 12.2 / §13：「流失风险」对本人不可见 —— 后台各处给某人的标签时，看的人就是这个人本人（且不是超管）时去掉 flight 的 canonical 值。
// 上级视图（GET /api/me/reports/:userId）一律去掉（tagsForLine）。员工本人的接口（/api/me、/api/me/growth）本就不下发标签。
function tagsForViewer(viewer, u) {
  const tags = parseTags(u);
  if (!viewer || !u || viewer.id !== u.id || isSuperAdmin(viewer)) return tags;
  return tags.filter((t) => CT.keyOf(t) !== "flight");
}
function tagsForLine(u) {
  return parseTags(u).filter((t) => CT.keyOf(t) !== "flight");
}
// ---------- 第二批 2.6：周期关闭后修改档案里的绩效评级（2026-10-08，负责人 10/7 定）----------
// 周期归档的记录 = review_items.recordId 指向它。原评级 = 归档时的 finalRating || managerRating（关闭后 review_items 不再改）；
// 新旧评级、理由、操作人写在审计 talent.record.rating-amend，与改记录同一笔事务（审查 P1-13）。「已改动（原评级 X）」标记与
// 理由只在后台下发（档案 GET /api/admin/employees/:id/profile、周期详情 GET /api/admin/review-cycles/:id），员工端（本人、
// 上级、HoD）的每个接口只给最终评级 —— test/perf-record-amend.test.js 逐个接口检查。
const PERF_AMEND_ACTION = "talent.record.rating-amend";
// 后台档案时间线：周期归档的绩效记录带 reviewLinked:true（前端据此隐藏「删除」）；当前评级 ≠ 归档时评级的另带
//   amend: { from, at, by: { name, employeeId }, reason, count }（at / by / reason 取最近一次修改；count = 修改次数）。
// 改回原评级（G9）不带 amend。只在后台 handler 里调用，不改 buildTalentTimeline / rowToTalentRecord（员工端共用它们）。
// scopeOk（可选）：看的人的数据范围判定；操作人不在范围内时不给其工号（范围外人员的工号不出响应）。
function perfAmendDecorate(events, scopeOk) {
  const ids = events.filter((e) => e.source === "record" && e.type === "performance" && e.id).map((e) => e.id);
  if (!ids.length) return events;
  const linked = store.mapReviewItemsByRecordIds(ids);
  const amended = [];
  for (const e of events) {
    const L = e.source === "record" && e.id ? linked.get(e.id) : null;
    if (!L) continue;
    e.reviewLinked = true;
    const cur = e.detail && e.detail.rating != null && e.detail.rating !== "" ? String(e.detail.rating) : null;
    if (L.archived && cur !== L.archived) amended.push([e, L]);
  }
  if (!amended.length) return events;
  const byTarget = new Map();
  for (const r of store.listAuditByTargets(PERF_AMEND_ACTION, amended.map(([e]) => e.id))) {
    if (!byTarget.has(r.target)) byTarget.set(r.target, []);
    byTarget.get(r.target).push(r);
  }
  for (const [e, L] of amended) {
    const list = byTarget.get(e.id) || [];
    const last = list.length ? list[list.length - 1] : null;
    let after = null;
    try { after = last && last.afterJson ? JSON.parse(last.afterJson) : null; } catch {}
    const actor = last && last.actorId ? store.getUserById(last.actorId) : null;
    e.amend = {
      from: L.archived,
      at: last ? last.createdAt : null,
      by: last ? { name: actor ? actor.name : last.actorName || null, employeeId: actor && (!scopeOk || scopeOk(actor)) ? actor.employeeId : null } : null,
      // 第二批 2.8（安全审查 1）：经申诉调整的评级不在档案里给理由 —— 申诉的内部说明只留在申诉记录里，档案只标「经申诉复核调整」
      reason: after && after.reason && after.via !== "appeal" ? String(after.reason) : null,
      count: list.length,
      ...(after && after.via === "appeal" ? { via: "appeal", appealId: after.appealId || null } : {}),
    };
  }
  return events;
}
// 周期归档那条档案记录现在的评级（后台周期详情用）：{ recordRating, amendedFrom }。记录已被删 → recordRating null；
// 与归档时评级不同时 amendedFrom = 归档时评级，否则 null（改回原值不标，G9）。
function reviewRecordRatingOf(item) {
  const rec = item && item.recordId ? store.getTalentRecord(item.recordId) : null;
  const recordRating = rec && rec.type === "performance" && rec.detail && rec.detail.rating != null && rec.detail.rating !== "" ? String(rec.detail.rating) : null;
  const archived = item ? item.finalRating || item.managerRating || null : null;
  return { recordRating, amendedFrom: recordRating && archived && recordRating !== archived ? archived : null };
}
// 2.6 带理由的评级修改审计（与改记录同一笔事务调用）。字面量 "talent.record.rating-amend" 写在这里，audit-labels 测试按字面量扫描。
// extra 覆盖默认字段（PUT 传 period = 表单里的期间；申诉调整传 via:'appeal'、appealId）。
function perfRatingAmendAudit(audit, rec, oldRating, newRating, reason, cycleItem, extra) {
  const owner = store.getUserById(rec.userId);
  audit("talent.record.rating-amend", rec.id, { rating: oldRating }, {   // = PERF_AMEND_ACTION
    rating: newRating, reason, userId: rec.userId, employeeId: owner ? owner.employeeId : null,
    period: rec.detail && rec.detail.period != null ? rec.detail.period : null,
    reviewItemId: cycleItem ? cycleItem.id : null, cycleId: cycleItem ? cycleItem.cycleId : null,
    ...(extra || {}),
  });
}
// 只改评级（申诉调整用）：沿用 detail 其余字段（含 summary / summaryAuthor），必须在 runBatch 内调用。
function perfApplyRatingAmend(audit, rec, newRating, reason, cycleItem, extra) {
  const before = { type: rec.type, date: rec.date, title: rec.title, detail: rec.detail };
  const detail = { ...(rec.detail || {}), rating: newRating };
  const updated = store.updateTalentRecord(rec.id, { type: rec.type, date: rec.date, title: rec.title, detail, programId: rec.programId || null });
  perfRatingAmendAudit(audit, rec, appealRecRating(rec), newRating, reason, cycleItem, extra);
  return { before, updated };
}
// ---------- 第二批 2.8：绩效申诉与部门 → HRBP 分工（2026-10-08，负责人已定）----------
// 负责人决定：申诉在系统内提出（取代 Lark）；部门 → HRBP 分工是独立设置、不是角色（一个账号仍只有一个后台角色）；HRBP 只看、
// 只处理所负责部门员工的申诉；申诉期限 = 结果正式告知之日起 5 个菲律宾工作日；HRBP 答复时限 10 个工作日，逾期只提醒、
// 从不自动关闭；没有二级复核；员工只看到结论、HRBP 的答复与最终评级。逾期申诉不予处理：上线前已告知的周期不开放（迁移 70）。
// 设计：会话 scratchpad 的 appeal-design.md（§ 号下同）与三份审查（安全 / 制度 / 可行性）；改动点与理由见 docs/HANDOVER-STATUS.md 1.47。
//   状态：submitted → in_review（HRBP 开始处理）→ maintained | adjusted；submitted → withdrawn（员工撤回）。open / expired / none 是推算的。
//   访问（reviewAppealAccess）：负责的 HRBP（或无 HRBP 时的兜底处理人）= full；绩效可读且范围覆盖申诉人 = meta（只有状态，没有内容）；
//   利益相关的人（申诉人、上级、汇报线上下、虚线上级、HoD、评级 / 校准 / 代评的人、之前改过这条评级的人）一律与「不存在」同形 404。
const APPEAL_WINDOW_WORKDAYS = 5, APPEAL_SLA_WORKDAYS = 10, APPEAL_SOON_WORKDAYS = 2, APPEAL_OVERDUE_REPEAT = 5;
const APPEAL_REASON_MIN = 50, APPEAL_REASON_MAX = 4000, APPEAL_REPLY_MIN = 20, APPEAL_REPLY_MAX = 4000, APPEAL_NOTE_MAX = 4000;
const APPEAL_ADJUST_NOTE_MIN = 10, APPEAL_ADJUST_NOTE_MAX = 1000, APPEAL_OPINION_MIN = 10, APPEAL_OPINION_MAX = 4000;
const APPEAL_QUESTION_MAX = 1000, APPEAL_REASSIGN_NOTE_MAX = 500;
const APPEAL_FILE_MAX = 10 * 1024 * 1024, APPEAL_FILES_MAX = 5, APPEAL_UPLOADS_PER_DAY = 10, APPEAL_CONSULTS_MAX = 4, APPEAL_HRBPS_MAX = 5;
const APPEAL_CONSULT_RECENT_DAYS = 90;
// 绩效看板第二期（负责人 2026-10-10「原因可分类」，迁移 97）：申诉原因分类。员工提交时选（界面必选；接口为兼容旧客户端可不带，记为未分类），
// HRBP 处理时可改正（POST /api/admin/review-appeals/:id/category）。顺序即界面顺序；键一经使用不改名。
const APPEAL_CATEGORIES = Object.freeze([
  { key: "rating_mismatch", zh: "评级与实际工作表现不符", en: "The rating does not reflect my actual performance" },
  { key: "unclear_criteria", zh: "目标或评估标准不清晰", en: "Goals or assessment criteria were unclear" },
  { key: "process", zh: "评估过程不规范（如未面谈、反馈不足）", en: "The review process was not followed (e.g. no 1-on-1, little feedback)" },
  { key: "wrong_facts", zh: "依据的事实或数据有误", en: "The facts or data used were wrong" },
  { key: "calibration", zh: "校准或名额限制影响了评级", en: "Calibration or the rating quota affected my rating" },
  { key: "other", zh: "其他", en: "Other" },
]);
const APPEAL_CATEGORY_KEYS = new Set(APPEAL_CATEGORIES.map((c) => c.key));
const APPEAL_LIMITS = Object.freeze({ reasonMin: APPEAL_REASON_MIN, reasonMax: APPEAL_REASON_MAX, fileMaxBytes: APPEAL_FILE_MAX, filesMax: APPEAL_FILES_MAX, types: ["pdf", "png", "jpg"] });
// 错误码与文案（§4.8；「书面说明」按制度审查 16 的用语）。前端按 code 取自己的词典。
const APPEAL_ERRORS = {
  not_found: [404, "Appeal not found.", "未找到该申诉。"],
  appeal_not_found: [404, "Appeal not found.", "未找到该申诉。"],
  appeal_unavailable: [409, "Appeals are not available for this review cycle.", "此评估周期不开放申诉。"],
  appeal_window_closed: [409, "The appeal deadline has passed; the rating is deemed acknowledged.", "已过申诉期限，视为认可评级。"],
  appeal_exists: [409, "An appeal has already been filed for this cycle.", "本周期已提出过申诉，不能再次申诉。"],
  not_in_service: [403, "Employees who have left cannot file an appeal.", "已离职员工不能提出申诉。"],
  appeal_reason: [400, "The written explanation must be 50–4,000 characters.", "书面说明需 50–4000 字。"],
  appeal_category: [400, "Choose a valid reason category.", "请选择有效的申诉原因分类。"],
  appeal_attachment: [400, "One or more supporting documents are invalid. Upload them again.", "佐证材料无效或已失效，请重新上传。"],
  appeal_file_type: [422, "Only PDF, PNG and JPG files are accepted.", "只支持 PDF、PNG、JPG 文件。"],
  appeal_file_too_large: [413, "Each file must be 10 MB or smaller.", "单个文件不能超过 10 MB。"],
  appeal_upload_rate: [429, "Too many uploads. Try again tomorrow.", "上传次数过多，请明天再试。"],
  appeal_in_review: [409, "HR has started the review; the appeal can no longer be withdrawn.", "HR 已开始处理，不能撤回申诉。"],   // CX-219：不点名 HRBP（无 HRBP 部门由其他 HR 兜底）
  appeal_state: [409, "The appeal status has changed. Refresh and try again.", "申诉状态已变化，请刷新后重试。"],
  appeal_no_permission: [403, "You do not have permission to act on this appeal.", "你没有处理这条申诉的权限。"],
  appeal_reply: [400, "The reply to the employee must be 20–4,000 characters.", "给员工的答复需 20–4000 字。"],
  appeal_note: [400, "A reason for the adjustment is required (10–1,000 characters); internal notes are limited to 4,000 characters.", "调整评级须写明调整理由（10–1000 字）；内部说明最多 4000 字。"],
  rating_invalid: [400, "Choose a valid rating that differs from the current one.", "请选择一个与当前评级不同的有效评级。"],
  rating_changed: [409, "This employee's rating has changed. Refresh before deciding.", "该员工的评级已被修改，请刷新后再作结论。"],
  record_missing: [409, "The performance record could not be found.", "找不到对应的绩效记录。"],
  consultee_invalid: [400, "You can consult only the employee's direct manager or head of department.", "只能征询该员工的直属上级或部门负责人。"],
  consult_exists: [409, "This person has already been consulted.", "已向此人征询过意见。"],
  consult_limit: [400, "You can consult at most 4 people per appeal.", "每条申诉最多征询 4 人。"],
  consult_answered: [409, "You have already submitted your opinion; it cannot be changed.", "你已提交过意见，不能修改。"],
  consult_closed: [409, "This appeal has been decided; the consultation is closed.", "该申诉已有结论，征询已关闭。"],
  opinion_length: [400, "The opinion must be 10–4,000 characters.", "意见需 10–4000 字。"],
  assignee_invalid: [400, "You can reassign only to a handler who covers this department and has no conflict of interest.", "只能转交给负责该部门且无利益冲突的处理人。"],
  super_admin_only: [403, "Only the super-admin can change HRBP coverage.", "只有超级管理员可以修改 HRBP 分工。"],
  hrbp_not_eligible: [400, "Only active employees with a console role can be assigned.", "只能指定在职、拥有后台角色的账号。"],
  dept_not_found: [404, "Department not found.", "未找到该部门。"],
  dept_inactive: [400, "You cannot add an HRBP to a deactivated department.", "已停用的部门不能新增 HRBP。"],
  too_many_hrbps: [400, "A department can have at most 5 HRBPs.", "每个部门最多指定 5 名 HRBP。"],
  bad_body: [400, "The request is not valid.", "请求内容无效。"],
  cycle_not_found: [404, "Review cycle not found.", "未找到该评估周期。"],
  cycle_open: [400, "Results can be communicated only after the cycle is closed.", "周期关闭后才能通知结果。"],
  results_communicated: [409, "Results for this cycle have already been communicated.", "本周期结果已通知员工。"],
  results_hidden: [409, "Performance records are hidden from employees. Make them visible in Talent settings first.", "「绩效记录」目前对员工不可见，请先在人才设置中开启员工可见。"],
  // 2.6 修改评级的护栏（安全审查 2、制度审查 2）
  rating_self_amend: [403, "You cannot add, change or delete your own performance rating.", "不能新增、修改或删除本人的绩效评级。"],   // CX-168：新增与删除同一护栏
  rating_under_appeal: [409, "This rating is under appeal. Decide it on the appeal desk.", "该评级正在申诉处理中，请在绩效申诉台作出结论。"],
  rating_appeal_closed: [409, "This rating has a final appeal decision. Only the super-admin can change it.", "该评级已经申诉复核作出最终结论，只有超级管理员可以再修改。"],
};
function appealErr(res, code, extra) {
  const e = APPEAL_ERRORS[code] || [500, "Something went wrong. Try again.", "处理失败，请重试。"];
  // CX-174：中英文分开（error 英文、error_zh 中文），前端按界面语言取（api.js），不再中英混排
  return send(res, e[0], { error: e[1], error_zh: e[2], code, ...(extra || {}) });
}
function appealTagged(code, extra) { const e = new Error(code); e.appealCode = code; e.extra = extra || null; return e; }
// runBatch 失败的应答：带 appealCode 的按错误码；itemId 唯一约束 = 已申诉过；其余同单条记录保存失败（原始异常只进 stderr）
function appealSaveFailed(res, what, saved) {
  const e = saved && saved.error;
  if (e && e.appealCode) return appealErr(res, e.appealCode, e.extra || undefined);
  if (/UNIQUE constraint failed: review_appeals\.itemId/.test(String(e && e.message))) return appealErr(res, "appeal_exists");
  return sendRecordSaveFailed(res, what, e);
}
// 测试缝 LMS_TEST_FAIL_APPEAL_DECIDE=1（可行性审查 6）：申诉调整在改完评级、写完 2.6 审计之后、改申诉状态之前抛异常，验证整笔回滚。
// 与 LMS_TEST_FAIL_BULK_AT 同样的门：只在临时目录里的测试库、非生产模式下生效。
const TEST_FAIL_APPEAL_DECIDE = process.env.LMS_TEST_FAIL_APPEAL_DECIDE === "1" && dbPathIsTemp() && !store.isProduction();
if (TEST_FAIL_APPEAL_DECIDE) console.warn("[test seam] LMS_TEST_FAIL_APPEAL_DECIDE=1: appeal ADJUST will throw after the rating amend");
// 调用者能看到的全部申诉行（列表、角标、统计共用；利益相关与申诉人本人的行不出现）
function appealVisibleRows(user, ctx, today) {
  const out = [];
  for (const ap of store.listReviewAppeals()) {
    const a = reviewAppealAccess(user, ap, ctx);
    if (!a.view) continue;
    out.push(reviewAppealRow(ap, user, ctx, today, a));
  }
  return out;
}
const appealClosedStatus = (s) => s === "withdrawn" || s === "maintained" || s === "adjusted";
function appealCounts(rows) {
  return {
    submitted: rows.filter((r) => r.status === "submitted").length,
    in_review: rows.filter((r) => r.status === "in_review").length,
    overdue: rows.filter((r) => r.overdue).length,
    closed: rows.filter((r) => appealClosedStatus(r.status)).length,
    all: rows.length,
    actionable: rows.filter((r) => r.actionable).length,
  };
}
const appealRecRating = (rec) => (rec && rec.type === "performance" && rec.detail && rec.detail.rating != null && rec.detail.rating !== "" ? String(rec.detail.rating) : null);
// 附件可读判定的短缓存（审查：PDF 分段请求每次都重建组织快照）：userId|appealId → { ok, at }；任何申诉 / 分工写入都清空
const APPEAL_ACCESS_CACHE = new Map();
const APPEAL_VIEW_SEEN = new Map();
function appealCacheClear() { APPEAL_ACCESS_CACHE.clear(); }

// ---- HRBP 分工（§2）----
// 可指定 / 生效：有后台角色、在职、非系统账号（role admin）
function hrbpEligible(u) {
  return !!u && u.active !== 0 && u.empStatus !== "exited" && u.role !== "admin" && u.adminRoleId != null;
}
function hrbpIssuesOf(u) {
  if (!u) return ["missing"];
  const out = [];
  if (u.role === "admin") out.push("system");
  if (u.active === 0) out.push("inactive");
  if (u.empStatus === "exited") out.push("exited");
  if (u.adminRoleId == null && u.role !== "admin") out.push("no_console");
  return out;
}
const appealDeptKey = (s) => (s === null || s === undefined ? "" : String(s).trim().toLowerCase());
// 分工解析（一次请求一份）：按原始 parentId 向上找最近的、有生效 HRBP 的部门（不与上级合并）；父链成环有 seen 兜底。
// 部门名 → id：不区分大小写只有一条时用它；多条时取原文完全相同的唯一一条，否则 null（审查：同名部门不能把申诉路由给别的部门的 HRBP）。
// 没有部门 / 名称对不上（deptId null）：只有一个根部门且它有生效 HRBP 时归它（制度审查 12），否则无人覆盖 → 兜底。
function hrbpCoverage(userOf) {
  const depts = store.listDepartments(true);
  const byId = new Map(depts.map((d) => [d.id, d]));
  const byKey = new Map();
  for (const d of depts) { const k = appealDeptKey(d.name); if (!k) continue; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(d.id); }
  const ambiguousNames = [];
  for (const ids of byKey.values()) if (ids.length > 1) ambiguousNames.push(byId.get(ids[0]).name);
  const raw = new Map();
  for (const a of store.listHrbpAssignments()) { if (!raw.has(a.deptId)) raw.set(a.deptId, []); raw.get(a.deptId).push(a.userId); }
  const effective = new Map();
  for (const [d, ids] of raw) {
    if (!byId.has(d)) continue;
    const eff = ids.filter((id) => hrbpEligible(userOf(id)));
    if (eff.length) effective.set(d, eff);
  }
  const deptIdOfName = (name) => {
    const k = appealDeptKey(name);
    if (!k) return null;
    const ids = byKey.get(k);
    if (!ids) return null;
    if (ids.length === 1) return ids[0];
    const exact = ids.filter((id) => String(byId.get(id).name).trim() === String(name).trim());
    return exact.length === 1 ? exact[0] : null;
  };
  const roots = depts.filter((d) => !d.parentId || !byId.has(d.parentId));
  const memo = new Map();
  const coverOf = (deptId) => {
    if (!deptId) return roots.length === 1 && roots[0].id ? coverOf(roots[0].id) : null;
    if (memo.has(deptId)) return memo.get(deptId);
    let out = null;
    const seen = new Set();
    for (let id = deptId; id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) {
      seen.add(id);
      if (effective.has(id)) { out = { deptId: id, ids: effective.get(id) }; break; }
    }
    memo.set(deptId, out);
    return out;
  };
  const coveredDeptIds = (userId) => {
    const s = new Set();
    for (const d of depts) { const c = coverOf(d.id); if (c && c.ids.includes(userId)) s.add(d.id); }
    return s;
  };
  return { byId, depts, raw, effective, deptIdOfName, coverOf, coveredDeptIds, ambiguousNames, roots };
}
// 一次请求一份的上下文：用户、组织快照、分工、权限、利益回避、处理人都按需建一次（不逐行查角色，§12.2）
function reviewAppealCtx() {
  const users = store.listUsers();
  const byId = new Map(users.map((u) => [u.id, u]));
  const userOf = (id) => (id ? byId.get(id) || null : null);
  let cov = null, snap = null, kids = null, H = null, ratingField;
  const permMemo = new Map(), conflictMemo = new Map(), handlerMemo = new Map(), itemMemo = new Map(), cycleMemo = new Map();
  const recMemo = new Map(), unitMaps = new Map(), oversightMemo = new Map(), subtreeMemo = new Map();
  const memo = (m, k, f) => { if (!m.has(k)) m.set(k, f()); return m.get(k); };
  const ctx = {
    users, user: userOf,
    get cov() { return cov || (cov = hrbpCoverage(userOf)); },
    get snap() { return snap || (snap = orgLib.createOrgResolver(store.listDepartments(true), users)); },
    get holidays() { return H || (H = reviewHolidaySet()); },
    get ratingField() { if (ratingField === undefined) ratingField = store.listRecordFields("performance").find((x) => x.key === "rating") || null; return ratingField; },
    item: (id) => (id ? memo(itemMemo, id, () => store.getReviewItem(id)) : null),
    cycle: (id) => (id ? memo(cycleMemo, id, () => store.getReviewCycle(id)) : null),
    record: (id) => (id ? memo(recMemo, id, () => store.getTalentRecord(id)) : null),
    // 权限按角色记一次：{ admin, sa, read, write, scope(target) }（与 canRead / canWrite / scopeAllowsFor 同一口径）
    perm(u) {
      const key = !u ? "none" : u.adminRoleId != null ? "r:" + u.adminRoleId : u.role === "admin" ? "legacy" : "none";
      return memo(permMemo, key, () => {
        if (key === "none") return { admin: false, sa: false, read: false, write: false, scope: () => false };
        const sa = isSuperAdmin(u);
        const g = resolveGrants(u);
        const role = sa ? null : actingRole(u);
        const names = sa ? null : store.resolveScopeDepartmentNames(role);
        return {
          admin: true, sa,
          read: sa || g.performance === "read" || g.performance === "manage",
          write: sa || g.performance === "manage",
          scope: names === null ? () => true : (t) => store.scopeAllowsUser(role, t),
        };
      });
    },
    // 某人汇报线以下的全部人（与 walkReportingLine 同一口径：系统账号不算、成环有 visited）
    subtreeIds(rootId) {
      return memo(subtreeMemo, rootId, () => {
        if (!kids) {
          kids = new Map();
          for (const u of users) { if (u.role === "admin" || !u.managerId) continue; if (!kids.has(u.managerId)) kids.set(u.managerId, []); kids.get(u.managerId).push(u.id); }
        }
        const out = new Set(), seen = new Set([rootId]);
        let frontier = kids.get(rootId) || [];
        while (frontier.length) {
          const next = [];
          for (const id of frontier) { if (seen.has(id)) continue; seen.add(id); out.add(id); for (const k of kids.get(id) || []) next.push(k); }
          frontier = next;
        }
        return out;
      });
    },
    // 申诉人确认时所在的一级部门（v2：确认 / 提交快照；其余按现在的部门）
    unitOfItem(item) {
      if (!item) return "__none";
      const cyc = ctx.cycle(item.cycleId);
      if (cyc && cyc.flow === "v2") {
        const m = memo(unitMaps, cyc.id, () => {
          const map = new Map();
          for (const st of store.listReviewDeptStatus(cyc.id)) {
            const sn = reviewSnapGet(cyc.id, st.dept1Id);
            const entry = sn.confirm || sn.submit;
            if (!entry) continue;
            for (const id of [...(Array.isArray(entry.ids) ? entry.ids : []), ...(Array.isArray(entry.departedIds) ? entry.departedIds : [])]) if (!map.has(id)) map.set(id, st.dept1Id);
          }
          return map;
        });
        if (m.has(item.userId)) return m.get(item.userId);
      }
      const u = userOf(item.userId);
      const lv = u ? ctx.snap.levelsOf(u.department) : null;
      return lv && lv.level1Id ? lv.level1Id : "__none";
    },
    conflicts(ap) {
      return memo(conflictMemo, ap.id, () => {
        const s = appealLiveConflicts(ap.userId, ctx.item(ap.itemId), ctx);
        let snapIds = [];
        try { snapIds = JSON.parse(ap.conflictIds || "[]"); } catch {}
        for (const id of Array.isArray(snapIds) ? snapIds : []) if (id) s.add(String(id));
        // 兜底（集成复核 10/8）：回避后所负责的 HRBP 与绩效管理员都没人了（例如超管做过旧流程校准或 2.6 改评级），
        // 超级管理员（申诉人本人除外）解除回避作为最后处理人，保证「不会出现无人处理的申诉」；handlers 带 lastResort 标记。
        const cover = ctx.cov.coverOf(ap.deptId);
        const anyLeft = (cover && cover.ids.some((id) => !s.has(id))) || ctx.oversightIds(userOf(ap.userId), true).some((id) => !s.has(id));
        if (!anyLeft) {
          for (const u of users) if (u.id !== ap.userId && s.has(u.id) && isSuperAdmin(u) && reviewRecipientOk(u)) { s.delete(u.id); s.lastResort = true; }
        }
        return s;
      });
    },
    // 处理人：{ route: 'hrbp'|'fallback', ids, coverDeptId }
    handlers(ap) {
      return memo(handlerMemo, ap.id, () => {
        const c = ctx.conflicts(ap);
        const cover = ctx.cov.coverOf(ap.deptId);
        const hrbps = cover ? cover.ids.filter((id) => !c.has(id)) : [];
        if (hrbps.length) return { route: "hrbp", ids: hrbps, coverDeptId: cover.deptId };
        return { route: "fallback", ids: ctx.oversightIds(userOf(ap.userId), true).filter((id) => !c.has(id)), coverDeptId: cover ? cover.deptId : null, ...(c.lastResort ? { lastResort: true } : {}) };
      });
    },
    // 绩效可读（write = 可管理）且数据范围覆盖申诉人的在职后台账号
    oversightIds(appellant, write) {
      return memo(oversightMemo, (write ? "w:" : "r:") + (appellant ? appellant.id : "-"), () => users.filter((u) => {
        if (!reviewRecipientOk(u) || !isAdmin(u)) return false;
        const p = ctx.perm(u);
        return (write ? p.write : p.read) && p.scope(appellant);
      }).map((u) => u.id));
    },
  };
  return ctx;
}
// 现在的利益相关人（§3.3 + 安全审查 4）：申诉人本人、直属上级与其上全部上级、申诉人汇报线以下的全部人、虚线上级、
// 现在的 HoD、本周期的上级（评级人）、校准人（hodId）、代评人、本周期部门的 HoD（提交人）。HR 确认人不算。
function appealLiveConflicts(appellantId, item, ctx) {
  const s = new Set();
  const add = (id) => { if (id) s.add(String(id)); };
  add(appellantId);
  const appellant = ctx.user(appellantId);
  if (appellant) {
    const seen = new Set([appellantId]);
    for (let m = appellant.managerId; m && !seen.has(m);) { seen.add(m); add(m); const mu = ctx.user(m); m = mu ? mu.managerId : null; }
    for (const id of ctx.subtreeIds(appellantId)) add(id);
    for (const r of store.listSecondaryLines(appellantId)) add(r.managerId);
    const h = appellant.department ? ctx.snap.hodOf(appellant.department) : null;
    if (h) add(h.id);
  }
  if (item) {
    add(item.managerId);
    add(item.hodId);
    const p = reviewHodProxyRec(item);
    if (p) add(p.by);
    const st = store.getReviewDeptStatus(item.cycleId, ctx.unitOfItem(item));
    if (st) add(st.hodId);
  }
  return s;
}
// 提交时的利益回避快照：现在的名单 + 审计里的评级决定人（制度审查 6）——改过此人旧流程评级的 HR（review.calibrate 的结果与上级评级
// 不同）与之前用 2.6 改过这条评级的人。之后只增不减（安全审查 3）。
function appealSubmitConflicts(appellantId, item, ctx) {
  const s = appealLiveConflicts(appellantId, item, ctx);
  if (item) {
    for (const r of store.listAuditByTargetsAny(["review.calibrate", "talent.record.rating-amend"], [item.id, item.recordId])) {
      let a = null;
      try { a = r.afterJson ? JSON.parse(r.afterJson) : null; } catch {}
      if (r.action === "review.calibrate" && r.target === item.id && a && a.finalRating && a.finalRating !== item.managerRating && r.actorId) s.add(r.actorId);
      if (r.action === "talent.record.rating-amend" && r.target === item.recordId && !(a && a.via === "appeal") && r.actorId) s.add(r.actorId);
    }
  }
  return [...s];
}
// 后台申诉台闸门（§3.5）：绩效可读，或有生效中的 HRBP 分工
function reviewAppealConsoleOk(user) {
  return isAdmin(user) && (canRead(user, "performance") || (hrbpEligible(user) && store.listHrbpDeptIdsOfUser(user.id).length > 0));
}
// → { view: 'full'|'meta'|null, act, reassign, role }
function reviewAppealAccess(user, ap, ctx) {
  const NONE = { view: null, act: false, reassign: false, role: null };
  if (!user || !isAdmin(user) || !ap || ap.userId === user.id) return NONE;
  if (ctx.conflicts(ap).has(user.id)) return NONE;
  const h = ctx.handlers(ap);
  if (h.ids.includes(user.id)) return { view: "full", act: true, reassign: true, role: h.route };
  const p = ctx.perm(user);
  if (p.read && p.scope(ctx.user(ap.userId))) return { view: "meta", act: false, reassign: p.write, role: "oversight" };
  return NONE;
}
const appealOpen = (ap) => ap.status === "submitted" || ap.status === "in_review";
const appealStale = (ap, h) => ap.status === "in_review" && !h.ids.includes(ap.handlerId);
// 申诉期限（§5.2、制度审查 3 / 4）：截止日存库，不随节假日调整而变。
//   → { communicatedOn, deadline } 或 { none: 'not_communicated' | 'pre_feature' }
//   2.6 在告知之后改过评级（且没有申诉）→ 以修改时刻重新起算（item.appealFrom / appealDeadline）。
function reviewAppealWindow(item, cycle) {
  if (!cycle || cycle.status !== "closed") return { none: "not_communicated" };
  if (item && item.appealFrom && item.appealDeadline) return { communicatedOn: manilaDay(Date.parse(item.appealFrom)), deadline: item.appealDeadline };
  if (!cycle.resultsAt) return { none: "not_communicated" };
  if (!cycle.appealDeadline) return { none: "pre_feature" };
  return { communicatedOn: manilaDay(Date.parse(cycle.resultsAt)), deadline: cycle.appealDeadline };
}
// 资格（§5.2；制度审查 5a：已有申诉时先给申诉状态，结果后来被隐藏也照样看得到结论）
//   o = { appeal, cycle, perfVisible, rec } → { state, reasonCode?, window }
function reviewAppealEligibility(appellant, item, o) {
  const win = reviewAppealWindow(item, o.cycle);
  const window = win.none ? null : { communicatedOn: win.communicatedOn, deadline: win.deadline };
  if (o.appeal) return { state: o.appeal.status, window: window || { communicatedOn: null, deadline: o.appeal.windowDeadline } };
  if (!o.perfVisible) return { state: "none", reasonCode: "results_hidden", window: null };
  if (win.none) return { state: "none", reasonCode: win.none, window: null };
  if (!item || !item.recordId || !o.rec || o.rec.userId !== item.userId || !appealRecRating(o.rec)) return { state: "none", reasonCode: "no_record", window: null };
  if (!reviewRecipientOk(appellant)) return { state: "none", reasonCode: "not_in_service", window };
  return { state: appealToday() <= win.deadline ? "open" : "expired", window };
}
const appealPerfVisible = () => { const t = store.getRecordType("performance"); return !!(t && t.active && t.employeeVisible); };
// 员工本人看到的申诉（§4.1 EmployeeAppeal）：不含评级、内部说明、处理人、征询
function employeeAppealOut(ap) {
  if (!ap) return null;
  const decided = ap.status === "maintained" || ap.status === "adjusted";
  return {
    // CX-065：员工看到的是自己提交时选的原因；HRBP 的改正只影响统计（reasonCategory），不显示给员工
    id: ap.id, status: ap.status, reason: ap.reason, category: (ap.reasonCategorySubmitted !== undefined ? ap.reasonCategorySubmitted : ap.reasonCategory) || null,
    attachments: store.listAttachmentsByOwner("review_appeal", ap.id).filter((a) => a.uploadedBy === ap.userId)
      .map((a) => ({ id: a.id, name: a.originalName, kind: a.kind, size: a.size, url: "/api/attachments/" + a.id })),
    submittedAt: ap.submittedAt, withdrawnAt: ap.withdrawnAt || null, startedAt: ap.startedAt || null, decidedAt: ap.decidedAt || null,
    outcome: ap.status === "maintained" ? "maintain" : ap.status === "adjusted" ? "adjust" : null,
    reply: decided ? ap.reply : null,
  };
}
// 路由部门（制度审查 7）：关闭归档时的部门，没有（上线前归档的）用现在的部门
function appealRouteDept(item, appellant, cov) {
  const name = (item && item.closeDept) || (appellant && appellant.department) || null;
  return { deptName: name, deptId: name ? cov.deptIdOfName(name) : null };
}
// 通知（§7）：只发给在职的人；正文从不带答复、内部说明、意见或书面说明
function appealNotify(uid, n) {
  const u = uid ? store.getUserById(uid) : null;
  if (!reviewRecipientOk(u)) return;
  notify(uid, { type: "review_appeal", ...n });
}
const appealAdminLink = (ap) => "/admin/review-appeals?appeal=" + ap.id;
const appealEmpLink = (ap) => "/review?view=history&item=" + ap.itemId;
const appealJoin = (names, zh) => names.filter(Boolean).join(zh ? "、" : ", ");
// 列表行（§4.3 Row）：两种视图同一形状，不含任何内容字段
function reviewAppealRow(ap, user, ctx, today, access) {
  const a = access || reviewAppealAccess(user, ap, ctx);
  const u = ctx.user(ap.userId);
  const cyc = ctx.cycle(ap.cycleId);
  const h = ctx.handlers(ap);
  const H = ctx.holidays;
  const open = appealOpen(ap);
  const overdue = open && today > ap.slaDueOn;
  const stale = appealStale(ap, h);
  const handler = ap.handlerId ? ctx.user(ap.handlerId) : null;
  return {
    id: ap.id, itemId: ap.itemId, cycleId: ap.cycleId, cycle: cyc ? cyc.name : null, kind: cyc ? cyc.kind || "quarter" : "quarter",
    userId: ap.userId, name: u ? u.name : "?", employeeId: u ? u.employeeId : null, department: u ? u.department || null : null,
    deptPath: orgLib.deptPathOf(ctx.snap.index, u && u.department, null),
    status: ap.status, overdue,
    overdueWorkdays: overdue ? workdaysBetween(ap.slaDueOn, today, H) : 0,
    workdaysLeft: open && !overdue ? workdaysBetween(today, ap.slaDueOn, H) : null,
    slaDueOn: ap.slaDueOn, submittedAt: ap.submittedAt, startedAt: ap.startedAt || null, decidedAt: ap.decidedAt || null,
    ratingAtSubmit: ap.ratingAtSubmit, currentRating: appealRecRating(ctx.record(ap.recordId)), reasonCategory: ap.reasonCategory || null,
    outcome: ap.status === "maintained" ? "maintain" : ap.status === "adjusted" ? "adjust" : null,
    route: h.route, handler: ap.handlerId ? { id: ap.handlerId, name: handler ? handler.name : null } : null, handlerStale: stale,
    view: a.view, actionable: !!(a.act && open && (ap.status === "submitted" || ap.handlerId === user.id || stale)),
  };
}
// 调整后的名额分布（§4.3 distribution；安全审查 12：小部门不给各档人数）
function reviewAllowedFor(quota, quotaBase) {
  const out = {};
  for (const [tier, pct] of Object.entries(quota || {})) out[tier] = Math.floor((quotaBase * Number(pct || 0)) / 100);
  return out;
}
function appealDistribution(ap, item, cycle, ctx) {
  const quota = reviewQuotaOf(cycle);
  const cur = appealRecRating(ctx.record(ap.recordId));
  const base = { tiers: Object.keys(quota), capped: REVIEW_QUOTA_CAPPED.slice(), quota, appellantBucket: cur ? reviewBucket(cur) : null };
  const unit = ctx.unitOfItem(item);
  let out = null;
  if (cycle.flow === "v2") {
    const sn = reviewSnapGet(cycle.id, unit);
    const entry = sn.confirm || sn.submit;
    if (entry && Array.isArray(entry.ids)) {
      const ids = new Set(entry.ids);
      const counts = {};
      for (const i of store.listCycleItems(cycle.id)) {
        if (!ids.has(i.userId)) continue;
        const r = reviewRecordRatingOf(i).recordRating;
        if (r) { const b = reviewBucket(r); counts[b] = (counts[b] || 0) + 1; }
      }
      const st = store.getReviewDeptStatus(cycle.id, unit);
      const quotaBase = entry.ids.length;
      out = { source: "confirm_snapshot", quotaApplies: true, unit, dept1: st ? st.dept1Name || null : null, headcount: entry.ids.length, quotaBase,
        small: quotaBase < REVIEW_QUOTA_MIN_HC || unit === "__none", allowed: reviewAllowedFor(quota, quotaBase), counts };
    }
  }
  if (!out) {
    const g = reviewGroups(cycle, store.listCycleItems(cycle.id), ctx.snap).find((x) => x.dept1Id === unit) || null;
    out = { source: "current", quotaApplies: cycle.flow === "v2", unit, dept1: g ? g.dept1 : null, headcount: g ? g.headcount : 0, quotaBase: g ? g.quotaBase : 0,
      small: g ? g.small : true, allowed: g ? g.allowed : reviewAllowedFor(quota, 0), counts: g ? g.counts : {} };
  }
  if (out.small) { out.counts = null; out.allowed = null; }
  return { ...out, ...base };
}
// 后台申诉详情（§4.3 A3）。完整视图带内容；meta 视图只有状态行
function reviewAppealDetail(ap, user, ctx) {
  const today = appealToday();
  const a = reviewAppealAccess(user, ap, ctx);
  if (!a.view) return null;
  const row = reviewAppealRow(ap, user, ctx, today, a);
  const h = ctx.handlers(ap);
  const stale = appealStale(ap, h);
  const canReassign = ap.status === "in_review" && (ap.handlerId === user.id || (a.role === "oversight" && a.reassign) || (a.act && stale));
  const reassignOptions = h.ids.filter((id) => id !== ap.handlerId).map((id) => { const u = ctx.user(id); return { id, name: u ? u.name : null, me: id === user.id }; });
  if (a.view === "meta") return { view: "meta", today, appeal: row, permissions: { canReassign }, ...(canReassign ? { reassignOptions } : {}) };
  const item = ctx.item(ap.itemId) || {};
  const cycle = ctx.cycle(ap.cycleId) || {};
  const appellant = ctx.user(ap.userId);
  const nm = (id) => { const u = ctx.user(id); return u ? { id, name: u.name } : null; };
  const cover = ap.deptId || h.coverDeptId ? h.coverDeptId : null;
  const coverDept = cover && ctx.cov.byId.get(cover) ? { id: cover, name: ctx.cov.byId.get(cover).name } : null;
  const consults = store.listReviewAppealConsults(ap.id);
  const decided = ap.status === "maintained" || ap.status === "adjusted";
  const snap = ctx.snap;
  const curHod = appellant && appellant.department ? snap.hodOf(appellant.department) : null;
  const unit = ctx.unitOfItem(item);
  const st = cycle.id ? store.getReviewDeptStatus(cycle.id, unit) : null;
  const rf = ctx.ratingField;
  const gr = appellant && appellant.jobLevel ? reviewGradeIndex().get(String(appellant.jobLevel).toUpperCase()) : null;
  const win = reviewAppealWindow(item, cycle);
  const proxy = reviewHodProxyRec(item);
  const recState = reviewRecordRatingOf(item);
  const audits = store.listAuditByTargetsAny(["review.calibrate", "review.hod.calibrate", "review.hod.proxy"], [item.id]);
  // 征询对象候选（§4.3）：现在 / 本周期的直属上级，现在 / 本周期的 HoD；在职、不是申诉人、不是调用者
  const cand = new Map();
  const addCand = (id, relation, label) => {
    if (!id || id === ap.userId || id === user.id) return;
    const u = ctx.user(id);
    if (!reviewRecipientOk(u)) return;
    const k = id + "|" + relation;
    if (!cand.has(k)) cand.set(k, { id, name: u.name, position: u.position || null, relation, labels: [], consulted: consults.some((c) => c.consulteeId === id) });
    if (!cand.get(k).labels.includes(label)) cand.get(k).labels.push(label);
  };
  addCand(appellant && appellant.managerId, "manager", "current");
  addCand(item.managerId, "manager", "cycle");
  addCand(curHod && curHod.id, "hod", "current");
  addCand(st && st.hodId, "hod", "cycle");
  // 同一人既是上级又是 HoD 时只列一次（按上级）
  const consultCandidates = [];
  const seenIds = new Set();
  for (const c of cand.values()) { if (seenIds.has(c.id)) { const prev = consultCandidates.find((x) => x.id === c.id); for (const l of c.labels) if (!prev.labels.includes(l)) prev.labels.push(l); continue; } seenIds.add(c.id); consultCandidates.push(c); }
  const permissions = {
    canStart: a.act && ap.status === "submitted",
    canCategorize: !!a.act && (ap.status === "submitted" || (ap.status === "in_review" && ap.handlerId === user.id)),   // 改正申诉原因分类（POST …/category）；代码审查 10/11：结论后与非处理人不能改
    canConsult: a.act && ap.status === "in_review" && ap.handlerId === user.id,
    canDecide: a.act && ap.status === "in_review" && ap.handlerId === user.id,
    canReassign,
    canTakeOver: !!(a.act && stale && ap.handlerId !== user.id),
    readOnlyReason: decided ? "decided" : ap.status === "in_review" && ap.handlerId !== user.id ? "not_handler" : null,
  };
  return {
    view: "full", today,
    appeal: {
      ...row, reason: ap.reason,
      attachments: store.listAttachmentsByOwner("review_appeal", ap.id).filter((x) => x.uploadedBy === ap.userId)
        .map((x) => ({ id: x.id, name: x.originalName, kind: x.kind, size: x.size, url: "/api/attachments/" + x.id, uploadedAt: x.createdAt })),
      windowDeadline: ap.windowDeadline, ratingBefore: ap.ratingBefore || null, newRating: ap.newRating || null,
      reply: ap.reply || null, internalNote: ap.internalNote || null,
      decidedBy: ap.decidedBy ? nm(ap.decidedBy) || { id: ap.decidedBy, name: null } : null,
      coverDept, hrbps: h.route === "hrbp" ? h.ids.map((id) => nm(id)).filter(Boolean) : [],
      deptAtRating: ap.deptName || null,
      consults: consults.map((c) => {
        const cu = ctx.user(c.consulteeId), ab = ctx.user(c.askedBy);
        return { id: c.id, consultee: { id: c.consulteeId, name: cu ? cu.name : null, position: cu ? cu.position || null : null }, relation: c.relation,
          askedBy: { name: ab ? ab.name : null }, askedAt: c.askedAt, question: c.question || null, opinion: c.opinion || null, answeredAt: c.answeredAt || null };
      }),
      events: store.listReviewAppealEvents(ap.id).filter((e) => e.kind !== "view").map((e) => {
        const au = e.actorId ? ctx.user(e.actorId) : null;
        return { at: e.at, actor: e.actorId ? { name: au ? au.name : null } : null, kind: e.kind, data: e.data };
      }),
    },
    appellant: appellant ? {
      id: appellant.id, name: appellant.name, employeeId: appellant.employeeId, department: appellant.department || null,
      deptPath: orgLib.deptPathOf(snap.index, appellant.department, null), position: appellant.position || null, jobLevel: appellant.jobLevel || null,
      jobGrade: gr && gr.grade != null ? gr.grade : null, empStatus: appellant.empStatus || null, inService: reviewRecipientOk(appellant),
      manager: nm(appellant.managerId), hod: curHod ? { id: curHod.id, name: curHod.name } : null,
      departmentAtRating: item.closeDept || null,
    } : null,
    cycle: { id: cycle.id, name: cycle.name, kind: cycle.kind || "quarter", flow: cycle.flow || null, closedAt: cycle.closedAt || null,
      resultsAt: cycle.resultsAt || null, communicatedOn: win.none ? null : win.communicatedOn, quota: cycle.flow === "v2" ? reviewQuotaOf(cycle) : null },
    review: {
      itemId: item.id, prevGoals: reviewSelfOf(item).prevGoals, self: cycle.kind === "annual" ? null : reviewSelfOf(item), selfAt: item.selfAt || null,
      oneOnOneAt: item.oneOnOneAt || null, employeeOneOnOneAt: item.employeeOneOnOneAt || null, oneOnOneNotes: item.oneOnOneNotes || "",
      manager: item.managerId ? { id: item.managerId, name: (ctx.user(item.managerId) || {}).name || null, status: reviewManagerStatus(item, ctx.user) } : null,
      managerRating: item.managerRating || null, managerText: item.managerText || "", managerAt: item.managerAt || null, highlights: item.highlights || "",
      finalRating: item.finalRating || null, hodText: item.hodText || "", hodAt: item.hodAt || null, hod: nm(item.hodId),
      hodProxy: proxy ? { by: (nm(proxy.by) || {}).name || null, at: proxy.at || null, reason: proxy.reason || null } : null,
      archivedRating: item.finalRating || item.managerRating || null, recordRating: recState.recordRating, amendedFrom: recState.amendedFrom, recordId: item.recordId || null,
    },
    deptStatus: st && cycle.flow === "v2" ? {
      dept1Id: st.dept1Id, dept1Name: st.dept1Name || null, hod: st.hodId ? { name: (ctx.user(st.hodId) || {}).name || null } : null,
      hodSubmittedAt: st.hodSubmittedAt || null, hrConfirmedAt: st.hrConfirmedAt || null, hr: st.hrId ? { name: (ctx.user(st.hrId) || {}).name || null } : null,
      returnedAt: st.returnedAt || null, returnReason: st.returnReason || null,
    } : null,
    // CX-175：第一次校准前还没有最终评级（before.finalRating 为空），起点取上级评级（「A → B+」而不是「— → B+」）
    calibrationLog: audits.map((r, i) => {
      let b = null, af = null;
      try { b = r.beforeJson ? JSON.parse(r.beforeJson) : null; af = r.afterJson ? JSON.parse(r.afterJson) : null; } catch {}
      const au = r.actorId ? ctx.user(r.actorId) : null;
      return { at: r.createdAt, action: r.action, by: { name: au ? au.name : r.actorName || null }, from: (b && (b.finalRating || b.managerRating)) || (i === 0 ? item.managerRating || null : null), to: af ? af.finalRating || null : null, reason: af ? af.reason || null : null };
    }),
    distribution: cycle.id ? appealDistribution(ap, item, cycle, ctx) : null,
    ratingOptions: rf ? rf.options : [], ratingOptions_zh: rf ? optionsZhOf(rf) : [],
    ratingOptions_desc: rf ? rf.options_desc || [] : [], ratingOptions_desc_zh: rf ? rf.options_desc_zh || [] : [],
    consultCandidates,
    reassignOptions: canReassign ? reassignOptions : [],
    permissions,
  };
}
// 敏感内容的读取留痕（安全审查 7）：每人每申诉每个马尼拉日记一次 review.appeal.view
function appealLogView(user, ap, audit) {
  const day = appealToday();
  const k = user.id + "|" + ap.id;
  if (APPEAL_VIEW_SEEN.get(k) === day) return;
  if (APPEAL_VIEW_SEEN.size > 5000) APPEAL_VIEW_SEEN.clear();
  APPEAL_VIEW_SEEN.set(k, day);
  if (store.hasReviewAppealEvent(ap.id, "view", user.id, { day })) return;
  store.addReviewAppealEvent({ appealId: ap.id, actorId: user.id, kind: "view", data: { day }, at: new Date(nowMs()).toISOString() });
  audit("review.appeal.view", ap.itemId, null, { appealId: ap.id, view: "full" });
}
// 申诉材料的内容判型（§4.1 E5；安全审查 9）：PDF = 前 8 字节内（可有 BOM / 空白）以 %PDF- 开头、末尾 1 KB 内有 %%EOF；PNG / JPG 按魔数；
// 其余（含 SVG）一律不收
function appealFileKind(buf) {
  if (!buf || !buf.length) return null;
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < 8 && i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  if (buf.slice(i, i + 5).toString("latin1") === "%PDF-" && buf.slice(Math.max(0, buf.length - 1024)).toString("latin1").includes("%%EOF"))
    return { ext: ".pdf", kind: "pdf" };
  const img = sniffImage(buf);
  if (img === "png") return { ext: ".png", kind: "image" };
  if (img === "jpg") return { ext: ".jpg", kind: "image" };
  return null;
}
const APPEAL_UPLOAD_INFLIGHT = new Set();
// POST /api/me/reviews/appeal-files?item=<itemId>&name=<文件名>（原始请求体 = 文件字节；读体之前分发，自查 401 与改密）
function handleReviewAppealFileUpload(req, res, user, query) {
  // 提前应答前先把请求体放掉（审查：否则还在上传的客户端拿不到 JSON 错误，只会连接被重置）
  const early = (code, status, body) => { req.resume(); return code ? appealErr(res, code) : send(res, status, body); };
  if (!user) return early(null, 401, { error: "Not logged in" });
  if (user.mustChangePassword) return early(null, 403, { error: "Please change your temporary password first.", code: "password_change_required" });
  const item = store.getReviewItem(String(query.get("item") || ""));
  if (!item || item.userId !== user.id) return early("not_found");
  const cycle = store.getReviewCycle(item.cycleId);
  const appeal = store.getReviewAppealByItem(item.id);
  const el = reviewAppealEligibility(user, item, { appeal, cycle, perfVisible: appealPerfVisible(), rec: item.recordId ? store.getTalentRecord(item.recordId) : null });
  if (el.state !== "open") {
    if (appeal) return early("appeal_exists");
    if (el.state === "expired") return early("appeal_window_closed");
    if (el.reasonCode === "not_in_service") return early("not_in_service");
    return early("appeal_unavailable");
  }
  if (APPEAL_UPLOAD_INFLIGHT.has(user.id)) return early("appeal_upload_rate");
  const since = () => new Date(nowMs() - 86400e3).toISOString();
  if (store.countUnboundAttachments("review_appeal", user.id, since()) >= APPEAL_UPLOADS_PER_DAY) return early("appeal_upload_rate");
  APPEAL_UPLOAD_INFLIGHT.add(user.id);
  let released = false;
  const release = () => { if (!released) { released = true; APPEAL_UPLOAD_INFLIGHT.delete(user.id); } };
  const chunks = [];
  let size = 0, tooLarge = false, failed = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > APPEAL_FILE_MAX) {
      if (!tooLarge) { tooLarge = true; chunks.length = 0; release(); appealErr(res, "appeal_file_too_large"); }
      if (size > 4 * APPEAL_FILE_MAX) req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("error", () => { release(); if (!tooLarge && !failed) { failed = true; send(res, 500, { error: "Upload failed. 上传失败。" }); } });
  req.on("close", () => { if (!req.complete) release(); });
  req.on("end", () => {
    if (tooLarge || failed) return;
    try {
      const buf = Buffer.concat(chunks);
      const t = appealFileKind(buf);
      if (!t) return appealErr(res, "appeal_file_type");
      const id = "att-" + newToken().slice(0, 12);
      const tmpDir = ATTACH_DIR + ".appeal-tmp";
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(ATTACH_DIR, { recursive: true });
      const tmp = path.join(tmpDir, id + t.ext), dest = path.join(ATTACH_DIR, id + t.ext);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      // 写库前再数一次（同步，与插入之间没有让出事件循环；审查：并发上传都在读体之前通过了第一次检查）
      if (store.countUnboundAttachments("review_appeal", user.id, since()) >= APPEAL_UPLOADS_PER_DAY) {
        try { fs.unlinkSync(dest); } catch {}
        return appealErr(res, "appeal_upload_rate");
      }
      const base = path.basename(String(query.get("name") || "").replace(/\\/g, "/"));
      // 去掉控制字符与双向排版控制字符（安全审查 9），最多 120 字
      const clean = base.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, 120);
      const originalName = clean || "file" + t.ext;
      store.createOwnedAttachment({ id, ownerKind: "review_appeal", kind: t.kind, storageKey: id + t.ext, originalName, mime: MIME[t.ext], size: buf.length, uploadedBy: user.id, createdAt: new Date(nowMs()).toISOString() });
      return send(res, 200, { ok: true, id, name: originalName, kind: t.kind, size: buf.length, url: "/api/attachments/" + id });
    } catch (e) {
      console.error("[review-appeal] upload failed: " + ((e && e.message) || e));
      return send(res, 500, { error: "Failed to save the file. 文件保存失败。" });
    } finally {
      release();
    }
  });
}
// 每日提醒（§5.4）：每天 08:00（马尼拉）之后的第一次检查执行一次；周末与菲律宾假期不提醒；申诉从不自动关闭
function reviewAppealDaily() {
  if (!modulesOn().performance) return;
  const now = nowMs();
  if (new Date(now + 8 * 3600e3).getUTCHours() < 8) return;
  const day = manilaDay(now);
  if (store.getMeta("reviewAppealDay") === day) return;
  store.setMeta("reviewAppealDay", day);
  const H = reviewHolidaySet();
  if (!isWorkday(day, H)) return;
  try {
    const ctx = reviewAppealCtx();
    const nowIso = new Date(now).toISOString();
    for (const ap of store.listOpenReviewAppeals()) {
      const h = ctx.handlers(ap);
      const stale = appealStale(ap, h);
      const to = ap.status === "in_review" && !stale ? [ap.handlerId] : h.ids;
      const u = ctx.user(ap.userId), cyc = ctx.cycle(ap.cycleId);
      const name = u ? u.name : "?", c = cyc ? cyc.name : "";
      const link = appealAdminLink(ap);
      if (day <= ap.slaDueOn) {
        const left = workdaysBetween(day, ap.slaDueOn, H);
        if (left > APPEAL_SOON_WORKDAYS || ap.remindSoonAt) continue;
        if (!store.setReviewAppealMarker(ap.id, "remindSoonAt", nowIso, { expect: null })) continue;
        store.addReviewAppealEvent({ appealId: ap.id, at: nowIso, actorId: null, kind: "remind_soon", data: { workdaysLeft: left } });
        for (const uid of to) appealNotify(uid, {
          title: `Appeal response due soon: ${name}, ${c}`, title_zh: `申诉答复即将到期：${name}「${c}」`,
          body: `Response due ${ap.slaDueOn}; ${left} working day(s) left.`, body_zh: `答复时限为 ${ap.slaDueOn}，还剩 ${left} 个工作日。`, link,
        });
        continue;
      }
      const n = workdaysBetween(ap.slaDueOn, day, H);
      if (ap.remindOverdueOn && workdaysBetween(ap.remindOverdueOn, day, H) < APPEAL_OVERDUE_REPEAT) continue;
      if (!store.setReviewAppealMarker(ap.id, "remindOverdueOn", day, { expect: ap.remindOverdueOn || null })) continue;
      store.addReviewAppealEvent({ appealId: ap.id, at: nowIso, actorId: null, kind: "remind_overdue", data: { overdueWorkdays: n } });
      for (const uid of to) appealNotify(uid, {
        title: `Appeal response overdue: ${name}, ${c}`, title_zh: `申诉答复已逾期：${name}「${c}」`,
        body: `The response was due ${ap.slaDueOn} and is ${n} working day(s) overdue. Please reach a decision; the appeal does not close automatically.`,
        body_zh: `答复时限 ${ap.slaDueOn} 已过 ${n} 个工作日，请尽快作出结论。申诉不会因逾期自动关闭。`, link,
      });
      if (ap.escalatedAt || !store.setReviewAppealMarker(ap.id, "escalatedAt", nowIso, { expect: null })) continue;
      const conf = ctx.conflicts(ap);
      const skip = new Set([...to, ...h.ids]);
      const esc = ctx.oversightIds(u, true).filter((id) => !conf.has(id) && !skip.has(id));
      store.addReviewAppealEvent({ appealId: ap.id, at: nowIso, actorId: null, kind: "escalate", data: { recipients: esc.length } });
      const hu = ap.status === "in_review" ? ctx.user(ap.handlerId) : null;
      for (const uid of esc) appealNotify(uid, {
        title: `Overdue appeal: ${name}, ${c}`, title_zh: `申诉答复逾期：${name}「${c}」`,
        body: `Handled by: ${hu ? hu.name : "not started yet"}; response was due ${ap.slaDueOn}.`,
        body_zh: `处理人：${hu ? hu.name : "尚未开始处理"}；答复时限 ${ap.slaDueOn}。`, link,
      });
    }
  } catch (e) {
    console.warn("[review-appeal] daily reminders failed: " + ((e && e.message) || e));
  }
}
// N1：结果告知通知（关闭时类型可见，或 communicate 补发）。收件人与原来的关闭通知相同；申诉一句只给在职的人（制度审查 10）。
function reviewResultsNotify(uid, cycle, deadline) {
  const u = store.getUserById(uid);
  const appealable = !!(deadline && reviewRecipientOk(u));
  notify(uid, {
    type: "review",
    title: `Your ${cycle.name} review result has been added to your Development Record`,
    title_zh: `「${cycle.name}」评估结果已记入你的成长档案`,
    body: `The review cycle ${cycle.name} has closed. See your final rating under Performance Reviews › My performance.`
      + (appealable ? ` If you disagree with it, you may file an appeal in the system by the end of ${deadline}.` : ""),
    body_zh: `评估周期「${cycle.name}」已关闭，最终评级可在「绩效评估 › 我的绩效」查看。`
      + (appealable ? `如对最终评级有异议，可在系统内提出申诉，截止日为 ${deadline}（含当日）。` : ""),
    link: "/review?view=history",
  });
}
// 后台周期详情的 results / appeals（§4.5；安全审查 5：利益相关的申诉不计入）
function reviewCycleResultsOf(cycle, user, scopeOk) {
  if (cycle.status !== "closed") return { results: null, appeals: null };
  const H = reviewHolidaySet();
  const today = appealToday();
  const items = store.listCycleItems(cycle.id);
  let recipients = 0;
  for (const i of items) { if (!i.recordId) continue; const u = store.getUserById(i.userId); if (reviewRecipientOk(u) && (!scopeOk || scopeOk(u))) recipients++; }
  const deadline = cycle.appealDeadline || null;
  const results = {
    at: cycle.resultsAt || null, communicatedOn: cycle.resultsAt ? manilaDay(Date.parse(cycle.resultsAt)) : null, deadline,
    windowOpen: !!(deadline && today <= deadline), preFeature: !!(cycle.resultsAt && !deadline),
    employeeVisible: appealPerfVisible(), deadlineIfNow: workdayAdd(today, APPEAL_WINDOW_WORKDAYS, H), recipients,
  };
  const list = store.listReviewAppeals({ cycleId: cycle.id });
  const appeals = { total: 0, open: 0, decided: 0, adjusted: 0 };
  if (list.length) {
    const ctx = reviewAppealCtx();
    for (const ap of list) {
      if (scopeOk && !scopeOk(ctx.user(ap.userId))) continue;
      if (ctx.conflicts(ap).has(user.id)) continue;
      appeals.total++;
      if (appealOpen(ap)) appeals.open++;
      if (ap.status === "maintained" || ap.status === "adjusted") appeals.decided++;
      if (ap.status === "adjusted") appeals.adjusted++;
    }
  }
  return { results, appeals };
}
// 分工设置页（§4.4 S1）
function hrbpCoveragePayload() {
  const ctx = reviewAppealCtx();
  const cov = ctx.cov;
  const users = ctx.users;
  const counted = users.filter((u) => orgLib.isInService(u) && !orgLib.isSystemAccount(u));
  const direct = new Map();
  let noDept = 0;
  const unmatched = new Map();
  for (const u of counted) {
    const name = u.department ? String(u.department).trim() : "";
    if (!name) { noDept++; continue; }
    const id = cov.deptIdOfName(name);
    if (!id) { unmatched.set(name, (unmatched.get(name) || 0) + 1); continue; }
    direct.set(id, (direct.get(id) || 0) + 1);
  }
  const children = new Map();
  for (const d of cov.depts) if (d.parentId && cov.byId.has(d.parentId)) { if (!children.has(d.parentId)) children.set(d.parentId, []); children.get(d.parentId).push(d.id); }
  const subMemo = new Map();
  const subtreeCount = (id) => {
    if (subMemo.has(id)) return subMemo.get(id);
    let n = 0;
    const seen = new Set(), stack = [id];
    while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); n += direct.get(x) || 0; for (const c of children.get(x) || []) stack.push(c); }
    subMemo.set(id, n);
    return n;
  };
  const pathOf = (id) => {
    const out = [], seen = new Set();
    for (let x = id; x && cov.byId.has(x) && !seen.has(x); x = cov.byId.get(x).parentId) { seen.add(x); out.unshift(cov.byId.get(x).name); }
    return out;
  };
  const person = (id) => { const u = ctx.user(id); return { id, name: u ? u.name : null, employeeId: u ? u.employeeId : null, effective: hrbpEligible(u), issues: hrbpIssuesOf(u) }; };
  const nm = (id) => { const u = ctx.user(id); return { id, name: u ? u.name : null }; };
  const departments = cov.depts.map((d) => {
    const c = cov.coverOf(d.id);
    const p = pathOf(d.id);
    return {
      id: d.id, name: d.name, parentId: d.parentId || null, active: !!d.active, group: !!d.group, level: p.length, path: p,
      headcount: direct.get(d.id) || 0, subtreeHeadcount: subtreeCount(d.id),
      assigned: (cov.raw.get(d.id) || []).map(person),
      cover: c ? { fromDeptId: c.deptId, fromDeptName: cov.byId.get(c.deptId).name, inherited: c.deptId !== d.id, hrbps: c.ids.map(nm) } : null,
    };
  });
  const noCover = cov.coverOf(null);
  const coverOut = (c) => (c ? { fromDeptId: c.deptId, fromDeptName: cov.byId.get(c.deptId).name, inherited: true, hrbps: c.ids.map(nm) } : null);
  const orphans = [...cov.raw.entries()].filter(([d]) => !cov.byId.has(d)).map(([deptId, userIds]) => ({ deptId, userIds }));
  const open = store.listOpenReviewAppeals();
  const roleMemo = new Map();
  const roleOf = (u) => { if (!u || u.adminRoleId == null) return null; if (!roleMemo.has(u.adminRoleId)) roleMemo.set(u.adminRoleId, store.getRole(u.adminRoleId)); return roleMemo.get(u.adminRoleId); };
  const hrbpIds = [...new Set([...cov.raw.values()].flat())];
  const hrbps = hrbpIds.map((id) => {
    const u = ctx.user(id);
    const role = roleOf(u);
    const depts = store.listHrbpDeptIdsOfUser(id);
    const names = role ? store.resolveScopeDepartmentNames(role) : null;
    const covered = cov.coveredDeptIds(id);
    return {
      ...person(id), roleName: role ? role.name : null, roleName_zh: role ? role.name_zh || null : null,
      outsideScopeDeptIds: names === null ? [] : depts.filter((d) => cov.byId.has(d) && !store.scopeAllowsDepartment(role, cov.byId.get(d).name)),
      depts: depts.filter((d) => cov.byId.has(d)).map((d) => ({ id: d, name: cov.byId.get(d).name })),
      coveredHeadcount: [...covered].reduce((n, d) => n + (direct.get(d) || 0), 0),
      openAppeals: open.filter((ap) => ctx.handlers(ap).ids.includes(id)).length,
      handlingAppeals: open.filter((ap) => ap.status === "in_review" && ap.handlerId === id).length,
    };
  });
  const uncoveredIds = departments.filter((d) => !d.cover && d.headcount > 0).map((d) => d.id);
  const unmatchedCount = [...unmatched.values()].reduce((a, b) => a + b, 0);
  return {
    departments,
    noDepartment: { headcount: noDept, cover: coverOut(noCover) },
    unmatched: { headcount: unmatchedCount, names: [...unmatched.keys()].sort(), cover: coverOut(noCover) },
    ambiguousNames: cov.ambiguousNames,
    orphans, hrbps,
    uncovered: {
      deptCount: uncoveredIds.length,
      headcount: uncoveredIds.reduce((n, id) => n + (direct.get(id) || 0), 0) + (noCover ? 0 : noDept + unmatchedCount),
      deptIds: uncoveredIds,
    },
    candidates: users.filter(hrbpEligible).map((u) => { const r = roleOf(u); return { id: u.id, name: u.name, employeeId: u.employeeId, department: u.department || null, roleName_zh: r ? r.name_zh || null : null, roleName: r ? r.name : null, roleName_zh: r ? r.name_zh || null : null }; }),
  };
}
// 员工本人能否看到上级评语 —— 唯一判定处（第二批 L2，2026-10-08）。负责人对 docs/DECISIONS-batch2-20261008.md 第 1 项的默认
// 答复是「保留评语，员工照常看得到」；若改为不给，只改这一个常量。读它的三处用同一口径（波次 2 复核修正）：
//   · 「我的绩效」（GET /api/me/reviews/history 的 managerText）—— 每一条都是周期结果；
//   · 成长档案（GET /api/me/growth）—— 周期归档的绩效记录（review_items.recordId 指向它）的评语行。按「是不是周期归档的记录」判，
//     不只看 detail.summaryAuthor：HR 改过评语后这个标记会被去掉，但那仍是这一期的评估评语，两处不能一隐一显；
//   · 进行中的旧流程周期（GET /api/me/reviews 的 mine[].managerText；v2 进行中本来就不给）。
// LMS_TEST_HIDE_MANAGER_COMMENT=1 只在测试里设（与 LMS_FAKE_NOW 同一类的测试缝），验证「不给」时三处一起隐藏；生产不设。
const EMPLOYEE_SEES_MANAGER_COMMENT = process.env.LMS_TEST_HIDE_MANAGER_COMMENT !== "1";
function employeeSeesManagerComment() { return EMPLOYEE_SEES_MANAGER_COMMENT; }
// 周期发起日 = createdAt 的本地日历日（不能截 createdAt 前 10 位：那是 UTC 日，马尼拉 08:00 前发起的周期会早一天；波次 2 复核修正）。
// 面谈补登记的最早日期按它判；GET /api/me/reviews 的 mine[] 与单人评估页另带 cycleStartedAt，给日期选择器作下限。
function reviewCycleStartDay(cycle) {
  const t = cycle && cycle.createdAt ? new Date(cycle.createdAt) : null;
  return t && !Number.isNaN(t.getTime()) ? ymdLocal(t) : "";
}

// Job-grade catalog (职级体系): rank → {grade, level, track}. The promotion
// ladder is DERIVED per track: ascending numeric level, higher rank-suffix
// first on ties (…MC3 → MC2 → MC1 → MB3…), exactly like the official table.
// 第五批起「下一职级」由 modules/talent/filter-engine.js buildLadder 按同一排序在每次请求建一次（原 nextRankOf 逐人读 meta，已删除）。
function jobGrades() {
  try { return (JSON.parse(store.getMeta("jobGradeConfig") || "null") || {}).ranks || []; } catch { return []; }
}

/* ---------- 第五批 8.1 / 8.2 人才筛选与继任导入（2026-10-09，A 组集成；设计 b5-design 第 3–7、9.4 节）----------
   条件模型与引擎是纯函数（modules/talent/filter-model.js、filter-engine.js），这里只做：把 store 的数据包成 loaders、
   范围、权限、审计与应答。晋升评审候选（promotion-config / promotion-candidates / 工作台 promotionPool）改由引擎跑内置筛选
   （builtinKey = 'promotion'，数据迁移 81 生成），三处同一口径：必修课程全部完成（选修、自主学习不计）；近 N 个月无违纪记录
   不限严重度（除非只看重大违纪）；司龄按日历满月（原 monthsSince 按每月 30.44 天近似，边界日期最多差 1 天）。
   数据范围：基础人群只在 tfContext().population 一处按 scopePredicate 过滤；结果行、总数、命中、unmapped、可选值、导出都由它导出。
   部门值经 deptParse 解析，范围外或不存在 → 值不可用（不匹配任何人），不是「不筛选」；"name:" 伪 id 也按范围判定。 */
const FM = require("./modules/talent/filter-model.js");
const FE = require("./modules/talent/filter-engine.js");
const SUCC_IMPORT = require("./modules/talent/succession-import.js");
// 12.2 工作台改版（设计 b12-design）：受控人才标签、关键岗位清单、工作台指标口径（纯函数库，组 1）
const CT = require("./modules/talent/controlled-tags.js");
const KP = require("./modules/talent/key-positions.js");
const WB = require("./modules/core/workbench.js");
const AI_TF = require("./modules/ai/talent-filter.js");
// F60（负责人 10/9）：人才盘点顶部筛选 = 整页人群范围，判定只在 modules/talent/review-scope.js 一处。九宫格（GET talent-review 每行 inScope）、
// 晋升评审候选、继任计划、人才筛选的 run / idsOnly / export、批量加入继任名单与人工名单都用同一组参数（GET 走地址栏参数，POST 走 body.scope）。
// 数据范围先行：部门值只按当前管理员可见的部门解析（范围外、不存在 → 不匹配任何人）；谓词只在各端点已按 scopePredicate 取到的人群上再收窄。
const TR_SCOPE = require("./modules/talent/review-scope.js");
function trPageScope(user, f, df) {
  if (!TR_SCOPE.isActive(f)) return { f, active: false, pred: null };
  const d = df || deptFilterFor(user);
  const grades = reviewGradeIndex();
  const pred = TR_SCOPE.compileScope(f, {
    deptParse: (id) => {
      const s = String(id === null || id === undefined ? "" : id).trim();
      if (s.startsWith("name:") && d.allow && !d.allow(s.slice(5))) return null;
      return d.parse(s);
    },
    gradeOf: (lv) => grades.get(String(lv).toUpperCase()) || null,
    today: todayLocal(),
    dayOf: (v) => { const s = String(v || ""); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const t = new Date(s); return Number.isNaN(t.getTime()) ? s.slice(0, 10) : ymdLocal(t); },
  });
  return { f, active: !!pred, pred };
}
const trScopeOfQuery = (user, query) => trPageScope(user, TR_SCOPE.readScope((k) => query.get(k)));
const trScopeOfBody = (user, body) => trPageScope(user, TR_SCOPE.scopeFromObject(body && body.scope));
// 批量操作的页面范围：选中的人有不在当前范围内的 → 逐人跳过（code: out_of_view），不整批拒绝（他们仍在数据范围内，不涉及越权）。
function trScopeSplit(sc, users) {
  if (!sc || !sc.pred) return { users, skipped: [] };
  const keep = [], skipped = [];
  for (const u of users) { if (sc.pred(u)) keep.push(u); else skipped.push({ userId: u.id, employeeId: u.employeeId || null, code: "out_of_view" }); }
  return { users: keep, skipped };
}
// 旧五项晋升规则的默认值（原在本文件，迁移 81 也要用，所以移到 filter-model.js，两边共用一份）
const PROMO_DEFAULTS = FM.PROMO_DEFAULTS;
const TF_BUILTIN_PROMO = "promotion";
function promotionFilter() { return store.getTalentFilterByKey(TF_BUILTIN_PROMO); }
// 旧五项配置：从内置筛选带标签的叶子推算（迁移 81 之前的库没有这条筛选时，读 meta，与旧版同口径）
function promotionConfig() {
  const f = promotionFilter();
  if (f) return FM.promotionConfigOf(f.definition);
  try { return { ...PROMO_DEFAULTS, ...JSON.parse(store.getMeta("promotionConfig") || "{}") }; }
  catch { return { ...PROMO_DEFAULTS }; }
}
// 一次请求的筛选上下文：字段目录（范围内的可选值）、引擎 ctx 与 loaders（每类数据第一次用到时才读、只读一次）、基础人群。
// opts.page = trPageScope(...) 的结果（F60）：只收窄基础人群（population），字段目录的可选值、上级是否可选仍按数据范围。
function tfContext(user, opts) {
  const mods = modulesOn();
  const scope = scopePredicate(user);
  const pagePred = opts && opts.page && opts.page.pred ? opts.page.pred : null;
  const popScope = pagePred ? (u) => (!scope || scope(u)) && pagePred(u) : scope;
  const all = store.listUsers();
  const byId = new Map(all.map((u) => [u.id, u]));
  const people = all.filter((u) => !LC.isServiceAccount(u));
  const scoped = scope ? people.filter(scope) : people;
  const scopedIds = new Set(scoped.map((u) => u.id));
  const df = deptFilterFor(user);
  const recCache = new Map();
  const records = (type) => { if (!recCache.has(type)) recCache.set(type, store.listTalentRecordsByType(type)); return recCache.get(type); };
  let succCache = null;
  const succession = () => succCache || (succCache = store.listSuccession());
  const active = FE.basePopulation(people, { inScope: scope });
  const activeIds = new Set(active.map((u) => u.id));
  // 字段目录：记录类型与自定义字段读一次全表再分组；部门、标签、奖项名、继任岗位只取范围内的值（设计 3.4）
  const fieldsByType = new Map();
  for (const f of store.listRecordFields(null)) { if (!fieldsByType.has(f.typeKey)) fieldsByType.set(f.typeKey, []); fieldsByType.get(f.typeKey).push(f); }
  const fieldOut = (f) => ({ key: f.key, label: f.label, label_zh: f.label_zh || null, input: f.input, options: f.options || [], options_zh: optionsZhOf(f), filterable: !!f.filterable });
  const recordTypes = store.listRecordTypes().filter((x) => x.key !== "user").map((x) => ({
    key: x.key, label: x.label, label_zh: x.label_zh || null, moduleOff: recordTypeModuleOff(x.key, mods), fields: (fieldsByType.get(x.key) || []).map(fieldOut),
  }));
  const deptOptions = df.options(scoped).options.filter((o) => o && o.id !== orgLib.DEPT_NONE);
  const tags = new Set();
  for (const u of active) for (const tg of parseTags(u)) if (String(tg || "").trim()) tags.add(String(tg).trim());
  const lazyAwardNames = () => [...new Set(records("award").filter((r) => activeIds.has(r.userId)).map((r) => r.detail && r.detail.awardName).filter(Boolean).map(String))];
  const catalog = FM.buildCatalog({
    modules: mods, ranks: jobGrades(),
    jobLevelsInUse: [...new Set(active.map((u) => u.jobLevel).filter(Boolean))],
    recordTypes, customFields: (fieldsByType.get("user") || []).map(fieldOut),
    deptOptions, programs: PROGRAMS.map((p) => ({ id: p.id, title: p.title, title_zh: p.title_zh || null })),
    talentTags: [...tags], awardNames: lazyAwardNames(),
    successionPositions: [...new Set(succession().filter((s) => scopedIds.has(s.userId)).map((s) => s.positionName))],
  });
  const pathMemo = new Map();
  const ctx = {
    today: todayLocal(),
    // 范围外 / 不存在的部门 id → null（值不可用）；"name:" 伪 id 自带部门名，受限管理员只认范围内的名字
    deptParse: (id) => {
      const s = String(id === null || id === undefined ? "" : id).trim();
      if (s.startsWith("name:") && df.allow && !df.allow(s.slice(5))) return null;
      return df.parse(s);
    },
    inScope: scope,
    deptLabel: (u) => {
      const d = u.department || "";
      if (!d) return null;
      if (!pathMemo.has(d)) {
        const names = df.pathOf(u).map((id) => (df.ix.byId.get(id) || {}).name).filter(Boolean);
        pathMemo.set(d, names.length ? names.join(" / ") : d);
      }
      return pathMemo.get(d);
    },
  };
  const loaders = {
    records,
    periodKinds: () => {
      const m = new Map();
      for (const c of store.listReviewCycles()) {
        if (c.status !== "closed") continue;
        for (const i of store.listCycleItems(c.id)) if (i.recordId) m.set(i.recordId, c.kind || "quarter");
      }
      return m;
    },
    // 与培训概览同一写法的请求级快照；mandatory = 课程报名方式为必修，self = 自主学习（不算指派）
    training: () => {
      const snap = TS.createSnapshotStore(store);
      const C = LC.createCompletion({ store: snap, getCourse, memoExams: true, listProjects: () => TPROJECTS, programsOfCourse: (cid, c) => programsContaining(cid, c) });
      return {
        assignments(uid) {
          const asg = snap.getUserAssignments(uid) || {};
          const out = [];
          for (const pid of Object.keys(asg)) {
            const p = getProgram(pid);
            if (!p) continue;
            out.push({ programId: pid, mandatory: (p.enrollType || "mandatory") === "mandatory", self: asg[pid].source === "self", done: C.programDone(uid, p) });
          }
          return out;
        },
        programDone(uid, pid) { const p = getProgram(pid); return !!p && C.programDone(uid, p); },
      };
    },
    succession,
    users: () => all,
  };
  return {
    user, mods, scope, all, byId, people, scopedIds, df, catalog, ctx, loaders,
    viewer: { id: user.id, isSuper: isSuperAdmin(user), canWrite: canWrite(user, "talent") },
    population: (def) => FE.basePopulation(people, { inScope: popScope, includeExited: !!(def && def.includeExited) }),
    page: opts && opts.page ? opts.page : null,
    sources: () => ({
      dept: deptOptions.map((o) => ({ id: o.id, label: o.path || o.name })),
      trainingProgram: PROGRAMS.map((p) => ({ id: p.id, label: p.title, label_zh: p.title_zh || null })),
      talentTag: [...tags].map((x) => ({ id: x, label: x })),
    }),
  };
}
// 受限管理员看到的筛选定义：去掉范围外的部门 id、全部 "name:" 伪 id、范围外的上级（redactForViewer）；全公司范围原样返回
function tfRedact(t, def) {
  if (!t.scope) return { definition: def, redactedValues: 0 };
  return FM.redactForViewer(def, (id) => { const d = t.df.ix.byId.get(id); return !!d && (!t.df.allow || t.df.allow(d.name)); },
    { allowUserId: (id) => { const u = t.byId.get(id); return !!u && t.scope(u); } });
}
function tfFilterOut(t, f, full) {
  const owner = f.ownerId ? t.byId.get(f.ownerId) : null;
  const { definition, redactedValues } = tfRedact(t, f.definition);
  const out = {
    id: f.id, name: f.name, name_zh: f.name_zh, builtinKey: f.builtinKey, visibility: f.visibility,
    owner: owner ? { id: owner.id, name: owner.name } : null, mine: !!f.ownerId && f.ownerId === t.viewer.id,
    canEdit: FM.canEditFilter(f, t.viewer), canDelete: FM.canDeleteFilter(f, t.viewer),
    version: f.version, updatedAt: f.updatedAt,
    summary: FM.summarize(definition, t.catalog, "en"), summary_zh: FM.summarize(definition, t.catalog, "zh"),
  };
  // F62：迁移 92 没有改写被 HR 改过的内置筛选 → 界面提示「默认条件已更新，可恢复默认」
  if (f.builtinKey === TF_BUILTIN_PROMO) out.defaultsPending = store.getMeta("promotionDefaultsPending") === "92";
  if (full) Object.assign(out, { definition, columns: f.columns, sort: f.sort, createdAt: f.createdAt });
  return { filter: out, redactedValues };
}
// 看不到的筛选 id 一律 null（调用方回 404，不区分「不存在」与「无权查看」）
function tfVisible(t, id) {
  const f = store.getTalentFilter(id);
  return f && FM.canSeeFilter(f, t.viewer) ? f : null;
}
function tfInvalid(res, errors) {
  return send(res, 400, { error: "Some filter conditions are not valid — check the highlighted conditions.", error_zh: "部分筛选条件有误，请检查标出的条件。", code: "filter_invalid", errors });
}
function tfSortOf(t, raw) {
  if (!raw || typeof raw !== "object" || typeof raw.col !== "string") return null;
  const ok = (t.catalog.columns || []).some((c) => c.id === raw.col);
  return ok ? { col: raw.col, dir: raw.dir === "desc" ? "desc" : "asc" } : null;
}
// 引擎运行（facts 先建好再传入：explain 的组内叶子补算与主运行共用同一份事实，每类数据仍只读一次）
function tfExecute(t, def, o) {
  const population = t.population(def);
  const facts = FE.createFacts(population, t.loaders, t.ctx);
  const r = FE.run({ ...o, population, filter: def, catalog: t.catalog, ctx: t.ctx, facts });
  if (o.explain && Array.isArray(r.rows) && r.rows.length) {
    // 条件组里的每条叶子也给命中（前端「每条顶层条件一列」的组列按组逻辑合成）
    const inner = [];
    for (const it of def.items || []) if (it && Array.isArray(it.items)) for (const leaf of it.items) inner.push([leaf.id, FE.compile({ v: 1, logic: "and", items: [leaf] }, t.catalog, t.ctx, facts)]);
    if (inner.length) {
      const byId = new Map(population.map((u) => [u.id, u]));
      for (const row of r.rows) {
        const u = byId.get(row.id);
        if (!u) continue;
        row.hits = row.hits || {};
        for (const [id, c] of inner) row.hits[id] = c.explain(u)[id];
      }
    }
  }
  return r;
}
// 列值下发形状：规范值照给；司龄、上级、完成率、潜力、人工调整另附中英文显示文字（{ value?, label, label_zh }）
const TF_LABEL_COLS = new Set(["tenure", "manager", "trainingCompletion", "potential", "member"]);
function tfRowOut(t, row) {
  const cells = {};
  for (const [col, raw] of Object.entries(row.values || {})) {
    if (raw === null || raw === undefined || !TF_LABEL_COLS.has(col)) { cells[col] = raw === undefined ? null : raw; continue; }
    const label = FE.columnText(col, raw, t.catalog, "en"), label_zh = FE.columnText(col, raw, t.catalog, "zh");
    cells[col] = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw, label, label_zh } : { value: raw, label, label_zh };
  }
  const u = t.byId.get(row.id);
  return {
    id: row.id, name: row.name, employeeId: row.employeeId, matched: row.matched, member: row.member || null,
    active: !!u && u.active !== 0 && u.empStatus !== "exited", cells, ...(row.hits ? { explain: row.hits } : {}),
  };
}
// 前端字段目录的形状（D 组按此编码）：group = 分组显示名、valueKind 用界面的取值集合、range → min/max、可选参数值并入 paramOptions
const TF_VALUE_KIND = { dept: "dept", jobLevel: "level", options: "enum", rating: "rating", user: "user", program: "program", tag: "tag", text: "text", date: "date", none: "bool" };
function tfCatalogOut(catalog) {
  const fields = catalog.fields.map((f) => {
    let vk = TF_VALUE_KIND[f.valueKind] || f.valueKind;
    if (f.valueKind === "number") vk = f.id === "tenureMonths" ? "months" : f.id === "trainingCompletion" ? "percent" : "number";
    if (f.valueKind === "count") vk = f.id === "record" ? "record" : "count";
    const o = { ...f, groupId: f.group, group: f.group_label, group_zh: f.group_label_zh, valueKind: vk };
    if (Array.isArray(f.range)) { o.min = f.range[0]; o.max = f.range[1]; }
    const po = {};
    if (f.awardOptions) po.names = f.awardOptions;
    if (f.severityOptions) po.severity = f.severityOptions;
    if (f.positionOptions) po.positions = f.positionOptions;
    if (Object.keys(po).length) o.paramOptions = po;
    return o;
  });
  return { ...catalog, fields };
}
// 内置晋升筛选：库里的定义按宽松模式归一（已删的自定义字段、关闭模块的记录类型降为警告，叶子由引擎忽略）后运行，带人工名单
function tfPromotionRun(t, o) {
  const f = promotionFilter();
  if (!f) return null;
  const v = FM.validateFilter(f.definition, t.catalog, { lenient: true });
  const def = v.filter || v.normalized || { v: 1, logic: "and", items: [], includeExited: false };
  const members = store.listTalentFilterMembers(f.id);
  return { f, def, members, r: tfExecute(t, def, { ...o, members }) };
}
// 晋升评审候选的入选人数（工作台计数与候选页同一口径：不在职级体系内的人不列入，除非被手动加入）
function tfPromotionEligible(t) {
  const p = tfPromotionRun(t, { columns: ["name"], all: true, computeUnmapped: true });
  if (!p) return null;
  const unmapped = new Set((p.r.unmapped || []).map((u) => u.id));
  return new Set(p.r.rows.filter((r) => r.matched && (!unmapped.has(r.id) || r.member === "include")).map((r) => r.id));
}
// 选中人员 → 去重的 id 数组；空 → 400 no_items；超过 cap → 400 over_cap（返回 null 表示已应答）
function tfIdList(res, raw, cap) {
  const ids = Array.isArray(raw) ? [...new Set(raw.map((x) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : "")).filter(Boolean))] : [];
  if (!ids.length) { send(res, 400, { error: "Nothing selected.", error_zh: "未选择任何人员。", code: "no_items" }); return null; }
  if (ids.length > cap) { send(res, 400, { error: `Select at most ${cap} people at a time.`, error_zh: `一次最多选择 ${cap} 人。`, code: "over_cap", cap }); return null; }
  return ids;
}
// 选中人员整批范围预检：查无此人、后台账号、范围外一律计入越界条数（设计选择①：有一人就整批拒绝）
function tfScopeCheck(t, ids) {
  const users = [];
  let bad = 0;
  for (const id of ids) {
    const u = t.byId.get(id);
    if (!u || u.role === "admin" || LC.isServiceAccount(u) || (t.scope && !t.scope(u))) bad++;
    else users.push(u);
  }
  return { users, bad };
}
const SUCC_READINESS = ["ready", "oneYear", "twoYears"];
// 继任导入 / 批量加入用的查找表：范围内员工的职位 + 范围内的继任行（岗位名比对只在范围内进行，设计 16 第 4 条）
function succLookups(t) {
  const existing = store.listSuccession().filter((s) => t.scopedIds.has(s.userId));
  // 12.2（设计 4.2）：关键岗位清单（范围内）的岗位名排在前面，新加的继任行沿用关键岗位的写法（已有继任行的写法仍优先）
  const knownPositions = [...kpVisible(t.user).map((p) => p.name), ...t.people.filter((u) => t.scopedIds.has(u.id) && u.role !== "admin" && u.position).map((u) => u.position)];
  return {
    getUserByEmployeeId: (eid) => { const u = store.getUserByEmployeeId(eid); return u && u.role !== "admin" && !LC.isServiceAccount(u) ? u : null; },
    scopeAllows: (u) => !t.scope || t.scope(u),
    knownPositions, existing,
  };
}
// ---------- 12.2 关键岗位清单（设计 b12-design 第 4 节；校验与覆盖口径在 modules/talent/key-positions.js）----------
// 岗位所属部门名：deptId 仍在部门表里 → 现名（部门改名后跟着变）；否则用写入时记下的 deptName。
function kpDeptNameOf(p, ix) { const d = p.deptId && ix ? ix.byId.get(p.deptId) : null; return d ? d.name : p.deptName || null; }
// 查看者范围内的关键岗位（含 isKey = 0 的）：按所属部门名过滤；没有部门的只对全公司范围可见。行上的 deptName 换成现名。
function kpVisible(user, ix) {
  const ox = ix || orgLib.buildOrgIndex(store.listDepartments(true));
  const dp = scopeDeptPredicate(user);
  return store.listKeyPositions().map((p) => ({ ...p, deptName: kpDeptNameOf(p, ox) })).filter((p) => !dp || (!!p.deptName && dp(p.deptName)));
}
// 一行关键岗位是否在查看者范围内（PUT / DELETE / 导入改写已有行用）
function kpRowAllows(user, ix) {
  const dp = scopeDeptPredicate(user);
  return (p) => !dp || (!!kpDeptNameOf(p, ix) && dp(kpDeptNameOf(p, ix)));
}
// 计入继任覆盖的继任人：在职、不是系统账号、在查看者范围内（与 GET /api/admin/succession 的 rows 同口径）
function kpSuccessorOk(user, byId) {
  const sc = scopePredicate(user);
  return (s) => { const u = byId.get(s.userId); return !!u && u.role !== "admin" && orgLib.isInService(u) && (!sc || sc(u)); };
}
// 部门：按 id（新增 / 编辑）。→ { dept } | { code }（dept_required / dept_unknown / dept_out_of_scope）
function kpDeptById(user, ix, deptId) {
  const id = deptId === null || deptId === undefined ? "" : String(deptId).trim();
  if (!id) return { code: "dept_required" };
  const d = ix.byId.get(id);
  if (!d) return { code: "dept_unknown" };
  if (!scopeAllowsDeptFor(user, d.name)) return { code: "dept_out_of_scope" };
  return { dept: { id: d.id, name: d.name } };
}
// 导入用的部门解析：部门名，或「一级 / 二级 / 本部门」路径（按最后一段找部门，再核对上级链的名字，不分大小写）
function kpResolveDept(ix, text) {
  const raw = String(text === null || text === undefined ? "" : text).trim();
  if (!raw) return null;
  const direct = ix.deptOf(raw);
  if (direct) return { id: direct.id, name: direct.name };
  const parts = raw.split(/\s*[/>›»]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const d = ix.deptOf(parts[parts.length - 1]);
  if (!d) return null;
  const chain = (ix.chainOf(d.name) || []).map((c) => c.name.trim().toLowerCase());
  const want = parts.map((x) => x.toLowerCase());
  const tail = chain.slice(-want.length);
  return tail.length === want.length && tail.every((n, i) => n === want[i]) ? { id: d.id, name: d.name } : null;
}
const KP_ERRORS = {
  name_required: "Enter the position name. 请填写岗位名称。",
  name_too_long: `The position name can be at most ${KP.NAME_MAX} characters. 岗位名称最多 ${KP.NAME_MAX} 字。`,
  is_key_invalid: "Key position must be yes or no. 「是否关键」只能填是或否。",
  note_too_long: `Notes can be at most ${KP.NOTE_MAX} characters. 备注最多 ${KP.NOTE_MAX} 字。`,
  dept_required: "Choose the department. 请选择所属部门。",
  dept_unknown: "Department not found. 未找到该部门。",
};
function kpErr(res, code) {
  if (code === "dept_out_of_scope") return sendScopeDeptReject(res);
  const msg = KP_ERRORS[code] || "The request is not valid. 请求内容无效。";
  const i = msg.indexOf(". ");
  return send(res, 400, { error: i > 0 ? msg.slice(0, i + 1) : msg, error_zh: i > 0 ? msg.slice(i + 2) : msg, code });
}
// 继任页「空缺岗位」改用清单（设计 4.2 / 待定 5 默认）：清单里有 isKey = 1 的岗位时，空缺 = 范围内的关键岗位中没有在职、范围内继任者的；
// 行形状不变，另带 keyPositionId；在任者 = positionKey(users.position) 相同的第一位范围内在职员工。清单为空 → null（调用方沿用推断）。
function keyPositionVacancies(user, scopedUsers, directCount) {
  if (!store.listKeyPositions().some((p) => p.isKey)) return null;
  const kps = kpVisible(user).filter((p) => p.isKey);
  const byId = new Map(store.listUsers().map((u) => [u.id, u]));
  const cov = KP.coverageByKey(store.listSuccession(), kpSuccessorOk(user, byId));
  const holderBy = new Map();
  for (const u of scopedUsers) {
    if (u.role === "admin" || !orgLib.isInService(u) || !u.position) continue;
    const k = FM.positionKey(u.position);
    if (k && !holderBy.has(k)) holderBy.set(k, u);
  }
  const vacancies = kps.filter((p) => !(cov.get(p.nameKey) && cov.get(p.nameKey).total)).map((p) => {
    const h = holderBy.get(p.nameKey) || null;
    return { positionName: p.name, holder: h ? h.name : null, holderId: h ? h.id : null, department: p.deptName || (h && h.department) || null,
      directs: h ? directCount.get(h.id) || 0 : 0, successors: 0, keyPositionId: p.id };
  });
  return { vacancies, keyRoleCount: kps.length };
}

/* ---------- 12.2 工作台（设计 b12-design 第 1–3、6.4、6.6 节）----------
   四个接口（todo / risk / structure / people）共用一个请求级上下文 wbContext(user)：基础人群、部门归属、各类记录只读一次。
   每个数字由同一个函数先算出「主体集合」（WB_METRICS[k].run → { kind, rows, … }），计数 = rows 的条数（或 rows 导出的分子 / 分母），
   名单接口调用同一个函数返回明细，所以「卡片数 = 名单 total」不靠两份代码碰巧一致（6.6 第 3 条）。
   两道闸：先模块开关 + 能力域（每块的 ok()；无权 → 字段整块不下发、名单 404），再数据范围（基础人群按 scopePredicate 过滤，
   以部门为主体的按 scopeDeptPredicate，以「事」为主体的按所属员工）。快照（上期）按快照时记下的部门名在读取时用查看者的范围过滤。
   口径纯函数：modules/core/workbench.js（WB）、modules/talent/key-positions.js（KP，继任覆盖）、modules/talent/controlled-tags.js（CT，保留与流失风险）。
   名单行只给 id、姓名、工号、部门、岗位、职级与该指标必需的字段；不带评级原文、申诉内容、答卷、打标理由（6.6 第 8 条）。 */
const WB_SNAP_SENTINEL = "__taken";   // 每次快照都写一行哨兵，区分「那天拍过、但没有主体」与「没拍过」（读取时去掉）
function wbDay(v) { const s = v ? String(v).slice(0, 10) : ""; return TS.isDay(s) ? s : null; }
function wbContext(user) {
  const mods = modulesOn();
  const grants = isSuperAdmin(user) ? null : resolveGrants(user);
  const can = (d) => !grants || grants[d] === "read" || grants[d] === "manage";
  const cfg = WB.configOf(store.getMeta("workbenchConfig"));
  const today = todayLocal();
  const period = WB.periodFor(today);
  const sc = scopePredicate(user);
  const dp = scopeDeptPredicate(user);
  const dAllow = (name) => !dp || (!!name && dp(name));
  const all = store.listUsers();
  const byId = new Map(all.map((u) => [u.id, u]));
  // 基础人群（6.1.3）：范围内、非系统账号（含已离职 / 停用，离职类指标要用）；active = 其中在职的
  const people = all.filter((u) => u.role !== "admin" && !LC.isServiceAccount(u) && (!sc || sc(u)));
  const active = people.filter((u) => orgLib.isInService(u));
  const memo = new Map();
  const once = (k, fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); };
  const deptRows = store.listDepartments(true);
  const df = deptFilterFor(user, { deptRows });
  const ix = df.ix;
  // 部门健康度的行 = 范围内最上层的部门（一级部门；范围只到更深部门时取链上最浅的那个），没有部门的人归 "__none"
  const deptOpts = once("deptOpts", () => df.options(all.filter((u) => !LC.isServiceAccount(u) && (!sc || sc(u))), { maxLevel: 1 }));
  const rowKeyOf = (u) => { const own = u && u.department ? deptOpts.idByName[u.department] : null; return (own && (deptOpts.chainById[own] || [])[0]) || "__none"; };
  const rowNameOf = (id) => {
    if (id === "__none") return null;
    const o = deptOpts.options.find((x) => x.id === id);
    if (o) return o.name;
    const d = ix.byId.get(id);
    return d ? d.name : String(id).startsWith("name:") ? String(id).slice(5) : null;
  };
  const recsBy = (type) => once("rec:" + type, () => {
    const m = new Map();
    for (const r of store.listTalentRecordsByType(type)) { if (!m.has(r.userId)) m.set(r.userId, []); m.get(r.userId).push(r); }
    return m;
  });
  // 离职日与离职类型：只对已离职 / 停用的人（与 exitDateOf 同口径：最近一条离职记录的 lastDay，没有则记录日期）
  const exitInfo = (u) => {
    if (!u || (u.active !== 0 && u.empStatus !== "exited")) return { day: null, type: null };
    const ex = (recsBy("exit").get(u.id) || []).slice().sort((x, y) => (x.date < y.date ? 1 : -1))[0];
    return ex ? { day: wbDay((ex.detail && ex.detail.lastDay) || ex.date), type: (ex.detail && ex.detail.exitType) || null } : { day: null, type: null };
  };
  const person = (u, extra) => ({ id: u.id, name: u.name, employeeId: u.employeeId || null, department: u.department || null, position: u.position || null, jobLevel: u.jobLevel || null, ...(extra || {}) });
  const snapRows = (key, metric) => once("snap:" + key + metric, () => {
    const rows = store.listWorkbenchSnapshots(key, metric);
    return { taken: rows.length > 0, rows: rows.filter((r) => r.subjectId !== WB_SNAP_SENTINEL) };
  });
  const snapSince = (metric) => { const d = store.firstWorkbenchSnapshotDay(metric); return d ? d.slice(0, 7) : null; };
  const reviewCycles = () => once("cycles", () => store.listReviewCycles());
  const cycleItems = (c) => once("items:" + c.id, () => store.listCycleItems(c.id).filter((i) => { const u = byId.get(i.userId); return !!u && (!sc || sc(u)) && !reviewPersonGone(u); }));
  const ovAll = () => once("ovAll", () => trainingOverviewBase(user, () => null));
  const ovQ = () => once("ovQ", () => trainingOverviewBase(user, (k) => (k === "period" ? "quarter" : null)));
  const tagEventsBy = () => once("tagEv", () => { const m = new Map(); for (const e of store.listAllTagEvents()) { if (!m.has(e.userId)) m.set(e.userId, []); m.get(e.userId).push(e); } return m; });
  const ownerIds = () => once("owners", () => new Set(deptRows.filter((d) => d.ownerId && d.active).map((d) => d.ownerId)));
  return { user, mods, can, cfg, today, period, sc, dp, dAllow, all, byId, people, active, once, deptRows, df, ix, deptOpts, rowKeyOf, rowNameOf,
    recsBy, exitInfo, person, snapRows, snapSince, reviewCycles, cycleItems, ovAll, ovQ, tagEventsBy, ownerIds };
}
// 按人汇总一组格子（培训类名单：一人一行，未完成门数与最早截止日）
function wbCellsByPerson(X, cells) {
  const m = new Map();
  for (const c of cells) {
    let r = m.get(c.userId);
    if (!r) { r = { u: c.u, count: 0, earliestDue: null }; m.set(c.userId, r); }
    r.count++;
    if (c.dueDay && (!r.earliestDue || c.dueDay < r.earliestDue)) r.earliestDue = c.dueDay;
  }
  return [...m.values()].sort((a, b) => String(a.earliestDue || "9").localeCompare(String(b.earliestDue || "9")) || String(a.u.name).localeCompare(String(b.u.name)))
    .map((r) => X.person(r.u, { missingCount: r.count, count: r.count, earliestDue: r.earliestDue, dueOn: r.earliestDue,
      overdueDays: r.earliestDue && r.earliestDue < X.today ? WB.daysBetween(r.earliestDue, X.today) : 0 }));
}
// 进行中周期里截止日已过、某阶段未完成的评估项（自评 / 上级评级待办）
function wbReviewOverdue(X, dueKey, doneKey, stage) {
  const rows = [];
  const cycles = [];
  for (const c of X.reviewCycles().filter((x) => x.status === "open")) {
    const due = wbDay(c[dueKey]);
    if (!due || !(due < X.today)) continue;
    let n = 0;
    for (const i of X.cycleItems(c)) {
      if (i[doneKey]) continue;
      n++;
      rows.push(X.person(X.byId.get(i.userId), { key: i.id, stage, cycleId: c.id, cycleName: c.name, dueOn: due, overdueDays: WB.daysBetween(due, X.today) }));
    }
    if (n) cycles.push(c.id);
  }
  return { kind: "person", rows, link: cycles.length === 1 ? `/admin/reviews?cycle=${encodeURIComponent(cycles[0])}` : "/admin/reviews" };
}
// 评估按时：一个周期的已到期阶段实例（2.4）
function wbReviewInstances(X, c) {
  return X.once("inst:" + c.id, () => {
    const items = X.cycleItems(c);
    let calibDepts = [];
    if (c.flow === "v2") {
      calibDepts = reviewGroups(c, items).filter((g) => g.dept1Id !== "__none" && X.dAllow(g.dept1))
        .map((g) => ({ dept1Id: g.dept1Id, dept1Name: g.dept1, hodSubmittedAt: g.status ? g.status.hodSubmittedAt || null : null }));
    }
    return WB.reviewStageInstances({ cycle: c, items, calibDepts, today: X.today });
  });
}
function wbInstanceRow(X, x) {
  if (x.stage === "calib") return { id: x.dept1Id, name: x.dept1Name, deptId: x.dept1Id, deptName: x.dept1Name, stage: "calib", dueOn: x.dueOn, completedOn: x.doneOn || null };
  const u = X.byId.get(x.userId);
  return X.person(u, { key: x.itemId + ":" + x.stage, stage: x.stage, dueOn: x.dueOn, completedOn: x.doneOn || null });
}
function wbComplianceCells(X) {
  return X.once("complCells", () => { const ov = X.ovQ(); return ov.cells().filter((c) => c.mandatory && ov.inS(c)); });
}
function wbComplianceByRow(X) {
  return X.once("complByRow", () => {
    const ov = X.ovQ();
    const m = new Map();
    for (const c of wbComplianceCells(X)) {
      const k = X.rowKeyOf(c.u);
      if (!m.has(k)) m.set(k, { deptId: k, deptName: X.rowNameOf(k), num: 0, den: 0 });
      const g = m.get(k);
      g.den++;
      if (TS.statusAt(c, ov.asOf) === "done") g.num++;
    }
    return m;
  });
}
function wbTagHolders(X, key) {
  return X.active.filter((u) => CT.controlledKeysOf(parseTags(u)).includes(key));
}
function wbRetention(X, which) {
  return X.once("ret:" + which, () => {
    const ev = X.tagEventsBy();
    const p = X.period;
    const win = which === "prev" ? { from: p.prevFrom, to: p.prevTo } : { from: p.from, to: X.today };
    return CT.retentionMetric(X.people, { exitDayOf: (u) => X.exitInfo(u).day, exitTypeOf: (u) => X.exitInfo(u).type, eventsOf: (u) => ev.get(u.id) || [] }, win);
  });
}
function wbProbation(X, which) {
  return X.once("prob:" + which, () => {
    const p = X.period;
    const win = which === "prev" ? { from: p.prevFrom, to: p.prevTo } : { from: p.from, to: X.today };
    return WB.probationOutcomes(X.people, { recordsOf: (u) => X.recsBy("regularization").get(u.id) || [], exitDayOf: (u) => X.exitInfo(u).day }, win, X.cfg);
  });
}
function wbSpan(X) {
  return X.once("span", () => WB.spanOfControl(X.active, { ranks: jobGrades(), ownerIds: X.ownerIds() }, X.cfg));
}
function wbSuccession(X) {
  return X.once("succ", () => KP.successionCoverage(kpVisible(X.user, X.ix).filter((p) => p.isKey), store.listSuccession(), kpSuccessorOk(X.user, X.byId)));
}
function wbClosedCycles(X) {
  return X.once("closed", () => X.reviewCycles().filter((c) => c.status === "closed")
    .sort((a, b) => String(b.closedAt || b.createdAt || "").localeCompare(String(a.closedAt || a.createdAt || ""))));
}
function wbNineCells(rows) {
  const cells = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let unrated = 0;
  for (const r of rows) { if (r.perfBucket == null || r.potBucket == null) unrated++; else cells[r.perfBucket][r.potBucket]++; }
  return { cells, unrated };
}
function wbPromotionCandidates(X) {
  return X.once("cand", () => { const ids = tfPromotionEligible(tfContext(X.user)); return ids || new Set(); });
}
function wbPromotion12m(X) {
  return X.once("promo", () => WB.promotionRate12m(X.active, (u) => X.recsBy("promotion").get(u.id) || [], X.today));
}
// 名单接口的指标表：ok(X) = 模块开关 + 能力域；run(X, q) → { kind, rows, link? }（q = URLSearchParams：dept / cell / stage / period）
const WB_PERIOD = (q) => (q && q.get("period") === "prev" ? "prev" : "cur");
// CX-126：各项「去处理」link 必须是前端存在的后台路由（员工名单 = /admin/employees，组织诊断 = /admin/org-chart?tab=diag）；
// test/cx126-workbench-links.test.js 逐条核对 link 能匹配 web/src/App.jsx 的路由。
const WB_METRICS = {
  // ---- 第一层 待办 ----
  probationDue: { ok: (X) => X.can("people"), run: (X) => {
    const regs = X.recsBy("regularization");
    const r = WB.probationDue(X.active, { hasRegularization: (u) => (regs.get(u.id) || []).length > 0 }, X.today, X.cfg, 30);
    return { kind: "person", link: "/admin/employees", rows: r.map((x) => { const u = X.byId.get(x.userId); return X.person(u, { hireDate: u.hireDate || null, dueOn: x.dueOn, overdue: x.overdue, overdueDays: x.overdue ? WB.daysBetween(x.dueOn, X.today) : 0 }); }) };
  } },
  reviewSelfOverdue: { ok: (X) => X.mods.performance && X.can("performance"), run: (X) => wbReviewOverdue(X, "dueAt", "selfAt", "self") },
  reviewRateOverdue: { ok: (X) => X.mods.performance && X.can("performance"), run: (X) => wbReviewOverdue(X, "dueRateAt", "managerAt", "rate") },
  reviewHrConfirm: { ok: (X) => X.mods.performance && X.can("performance"), run: (X) => {
    const rows = [], cycles = [];
    const snap = X.once("orgSnap", () => orgSnapshot());
    for (const c of X.reviewCycles().filter((x) => x.status === "open" && x.flow === "v2")) {
      const items = X.cycleItems(c);
      let n = 0;
      for (const st of store.listReviewDeptStatus(c.id)) {
        if (!st.hodSubmittedAt || st.hrConfirmedAt) continue;
        const name = st.dept1Name || (X.ix.byId.get(st.dept1Id) || {}).name || null;
        if (!X.dAllow(name)) continue;
        const hc = items.filter((i) => { const u = X.byId.get(i.userId); const lv = u ? snap.levelsOf(u.department) : null; return lv && lv.level1Id === st.dept1Id; }).length;
        rows.push({ key: c.id + ":" + st.dept1Id, deptId: st.dept1Id, deptName: name, headcount: hc, cycleId: c.id, cycleName: c.name, submittedOn: wbDay(st.hodSubmittedAt) });
        n++;
      }
      if (n) cycles.push(c.id);
    }
    return { kind: "dept", rows, link: cycles.length === 1 ? `/admin/reviews?cycle=${encodeURIComponent(cycles[0])}` : "/admin/reviews" };
  } },
  appealsDue: { ok: (X) => X.mods.performance && reviewAppealConsoleOk(X.user), run: (X) => {
    const list = appealVisibleRows(X.user, reviewAppealCtx(), appealToday())
      .filter((r) => r.actionable && (r.overdue || (r.workdaysLeft !== null && r.workdaysLeft <= 2)));
    return { kind: "person", link: "/admin/review-appeals?status=overdue", rows: list.map((r) => {
      const u = X.byId.get(r.userId) || { id: r.userId, name: r.name, employeeId: r.employeeId, department: r.department };
      return X.person(u, { key: r.id, dueOn: r.slaDueOn, overdue: !!r.overdue, overdueDays: r.overdue ? r.overdueWorkdays : 0, workdaysLeft: r.workdaysLeft, cycleName: r.cycle });
    }) };
  } },
  trainingOverdue: { ok: (X) => X.mods.learning && X.can("learning"), run: (X) => {
    const ov = X.ovAll();
    return { kind: "person", link: "/admin/training-overview", rows: wbCellsByPerson(X, ov.cells().filter((c) => ov.inS(c) && TS.statusAt(c, ov.today) === "overdue")) };
  } },
  trainingDueSoon: { ok: (X) => X.mods.learning && X.can("learning"), run: (X) => {
    const ov = X.ovAll();
    return { kind: "person", link: "/admin/training-overview", rows: wbCellsByPerson(X, ov.cells().filter((c) => ovDueSoon(ov, c))) };
  } },
  approvals: { ok: (X) => X.mods.learning && X.can("learning"), run: (X) => {
    const okU = (u) => !!u && (!X.sc || X.sc(u));
    const rows = [];
    for (const r of store.listPendingRequests()) { const u = X.byId.get(r.userId); if (okU(u)) rows.push(X.person(u, { key: r.id, type: "enroll", requestedOn: wbDay(r.requestedAt) })); }
    for (const a of store.listApprovals("nomination", "pending")) { const u = X.byId.get(a.targetUserId); if (okU(u)) rows.push(X.person(u, { key: a.id, type: "nomination", requestedOn: wbDay(a.requestedAt) })); }
    return { kind: "person", link: "/admin/requests", rows };
  } },
  grading: { ok: (X) => X.mods.learning && X.can("learning"), run: (X) => {
    const okU = (u) => !!u && (!X.sc || X.sc(u));
    const rows = store.listAttemptsByGradingStatus(["pending_review", "manual_pending"]).filter((a) => okU(X.byId.get(a.userId)))
      .map((a) => X.person(X.byId.get(a.userId), { key: a.id, status: a.gradingStatus, submittedOn: wbDay(a.submittedAt), overdue: reviewOverdue(a) }));
    return { kind: "person", link: "/admin/results", rows };
  } },
  noJobLevel: { ok: (X) => X.can("people"), run: (X) => ({ kind: "person", link: "/admin/employees", rows: X.active.filter((u) => !String(u.jobLevel || "").trim()).map((u) => X.person(u)) }) },
  noManager: { ok: (X) => X.can("people"), run: (X) => {
    // 一级部门（及集团层）负责人本就没有直属上级，不算缺失
    const exempt = new Set(X.deptRows.filter((d) => d.ownerId && (d.group || X.ix.levelOf(d.name) === 1)).map((d) => d.ownerId));
    return { kind: "person", link: "/admin/employees", rows: X.active.filter((u) => !u.managerId && !exempt.has(u.id)).map((u) => X.person(u)) };
  } },
  deptNoHrbp: { ok: (X) => X.mods.performance && X.can("people"), run: (X) => {
    const p = hrbpCoveragePayload();
    const byD = new Map(p.departments.map((d) => [d.id, d]));
    const rows = p.uncovered.deptIds.map((id) => byD.get(id)).filter((d) => d && X.dAllow(d.name)).map((d) => ({ deptId: d.id, deptName: d.name, headcount: d.headcount || 0 }));
    return { kind: "dept", link: isSuperAdmin(X.user) ? "/admin/hrbp-coverage" : null, rows };
  } },
  // ---- 第二层 组织风险 ----
  succession: { ok: (X) => X.mods.talent && X.can("talent"), run: (X, q) => {
    let cov;
    if (WB_PERIOD(q) === "prev") { const s = X.snapRows(X.period.prevKey, "succession"); cov = s.taken ? KP.successionFromSnapshot(s.rows, X.dAllow) : { rows: [] }; }
    else cov = wbSuccession(X);
    let rows = cov.rows.map((r) => ({ id: r.id, name: r.name, deptName: r.deptName || null, readiness: r.best, successors: r.total, readySuccessors: r.ready + r.oneYear, covered: r.covered }))
      .sort((a, b) => Number(a.covered) - Number(b.covered) || a.successors - b.successors || String(a.name).localeCompare(String(b.name)));
    if (q && q.get("cell") === "noSuccessor") rows = rows.filter((r) => !r.successors);
    return { kind: "position", link: "/admin/talent-review/key-positions", rows };
  } },
  retention: { ok: (X) => X.mods.talent && X.can("talent"), run: (X, q) => {
    const r = wbRetention(X, WB_PERIOD(q));
    const vol = new Set(r.voluntaryIds);
    const ev = X.tagEventsBy();
    let ids = r.exitedIds;
    if (q && q.get("cell") === "voluntary") ids = ids.filter((id) => vol.has(id));
    return { kind: "person", link: "/admin/employees", rows: ids.map((id) => {
      const u = X.byId.get(id), xi = X.exitInfo(u);
      const tags = CT.RETENTION_KEYS.filter((k) => CT.heldOn(ev.get(id) || [], k, xi.day, CT.heldKeysOf(u.talentTags).includes(k)));
      return X.person(u, { exitDate: xi.day, exitType: xi.type, tags });
    }) };
  } },
  flight: { ok: (X) => X.mods.talent && X.can("talent"), run: (X, q) => {
    const ev = X.tagEventsBy();
    if (WB_PERIOD(q) === "prev") {
      const s = X.snapRows(X.period.prevKey, "flight");
      return { kind: "person", link: "/admin/employees", rows: (s.taken ? WB.snapshotIds(s.rows, X.dAllow) : []).map((id) => { const u = X.byId.get(id); return u ? X.person(u) : { id, name: null }; }) };
    }
    return { kind: "person", link: "/admin/employees", rows: CT.flightRiskIds(X.people).map((id) => {
      const u = X.byId.get(id);
      const adds = (ev.get(id) || []).filter((e) => e.tagKey === "flight" && e.action === "add");
      const last = adds[adds.length - 1] || null;   // 打标日期与打标人；理由不进名单
      return X.person(u, { taggedOn: last ? CT.eventDay(last) : null, taggedBy: last ? last.actorName || null : null });
    }) };
  } },
  compliance: { ok: (X) => X.mods.learning && X.can("learning"), run: (X) => {
    const ov = X.ovQ();
    return { kind: "person", link: "/admin/training-overview?period=quarter", rows: wbCellsByPerson(X, wbComplianceCells(X).filter((c) => TS.statusAt(c, ov.asOf) !== "done")) };
  } },
  reviewOnTime: { ok: (X) => X.mods.performance && X.can("performance"), run: (X, q) => {
    const pk = WB.pickReviewCycles(X.reviewCycles());
    const c = WB_PERIOD(q) === "prev" ? pk.prev : pk.current;
    if (!c) return { kind: "stage", rows: [], link: "/admin/reviews" };
    const stage = q && ["self", "rate", "calib"].includes(q.get("stage")) ? q.get("stage") : null;
    const rows = wbReviewInstances(X, c).filter((x) => !x.onTime && (!stage || x.stage === stage)).map((x) => wbInstanceRow(X, x));
    return { kind: "stage", rows, link: `/admin/reviews?cycle=${encodeURIComponent(c.id)}` };
  } },
  probation: { ok: (X) => X.can("people"), run: (X, q) => {
    const r = wbProbation(X, WB_PERIOD(q));
    return { kind: "person", link: "/admin/employees", rows: r.rows.map((x) => X.person(X.byId.get(x.userId), { hireDate: x.hireDate, decidedOn: x.outcomeDay, result: x.result })) };
  } },
  span: { ok: (X) => X.can("people"), run: (X, q) => {
    let r;
    if (WB_PERIOD(q) === "prev") { const s = X.snapRows(X.period.prevKey, "span"); r = s.taken ? WB.spanFromSnapshot(s.rows, X.dAllow, X.cfg) : { rows: [] }; }
    else r = wbSpan(X);
    const cell = q ? q.get("cell") : null;
    return { kind: "person", link: "/admin/org-chart?tab=diag", rows: r.rows.filter((x) => !cell || (cell === "zero" ? x.type === "none" : cell === "over" ? x.type === "wide" : true)).map((x) => {
      const u = X.byId.get(x.userId);
      return u ? X.person(u, { directs: x.directs, anomaly: x.type === "none" ? "zero" : "over" }) : { id: x.userId, name: null, directs: x.directs, anomaly: x.type === "none" ? "zero" : "over" };
    }) };
  } },
  // ---- 第三层 ----
  nineBox: { ok: (X) => X.mods.talent && X.can("talent"), run: (X, q) => {
    const cid = q ? String(q.get("cycle") || "") : "";
    const cyc = cid ? wbClosedCycles(X).find((c) => c.id === cid) || null : null;
    if (cid && (!cyc || !X.mods.performance)) return null;
    const cell = q ? String(q.get("cell") || "") : "";
    const m = /^([0-2])-([0-2])$/.exec(cell);
    const rows = nineBoxRows(X.user, cyc).filter((r) => (cell === "unrated" ? r.perfBucket == null || r.potBucket == null : m ? r.perfBucket === Number(m[1]) && r.potBucket === Number(m[2]) : true));
    return { kind: "person", link: "/admin/talent-review", rows: rows.map((r) => X.person(X.byId.get(r.id))) };
  } },
  perfQuota: { ok: (X) => X.mods.performance && X.can("performance"), run: (X, q) => {
    const c = wbClosedCycles(X)[0];
    if (!c) return { kind: "person", rows: [], link: "/admin/reviews" };
    const g = reviewGroups(c, X.cycleItems(c)).find((x) => x.dept1Id === String(q.get("dept") || ""));
    if (!g || (g.dept1Id === "__none" ? !!X.dp : !X.dAllow(g.dept1))) return null;
    const tier = String(q.get("cell") || "");
    const rows = g.quotaItems.filter((i) => { const r = g.rateOf(i); return !!r && (!tier || reviewBucket(r) === tier); }).map((i) => X.person(X.byId.get(i.userId)));
    return { kind: "person", rows, link: `/admin/reviews?cycle=${encodeURIComponent(c.id)}` };
  } },
  "pipeline.candidates": { ok: (X) => X.mods.talent && X.can("talent"), run: (X) => {
    const ids = wbPromotionCandidates(X);
    return { kind: "person", link: "/admin/talent-review", rows: X.active.filter((u) => ids.has(u.id)).map((u) => X.person(u)) };
  } },
  "pipeline.promoted": { ok: (X) => X.mods.talent && X.can("talent"), run: (X) => ({ kind: "person", link: "/admin/talent-review", rows: wbPromotion12m(X).ids.map((id) => X.person(X.byId.get(id))) }) },
};
// 部门健康度表（3.4）：行 = 范围内最上层的部门；每列按能力域裁剪（无权的列不下发）。headcount 是数字，其余列是 healthCell。
const WB_HEALTH_COLS = {
  headcount: (X) => X.can("people"),
  probation: (X) => X.can("people"),
  compliance: (X) => X.mods.learning && X.can("learning"),
  reviewOnTime: (X) => X.mods.performance && X.can("performance"),
  hipo: (X) => X.mods.talent && X.can("talent"),
};
function wbDeptHealth(X) {
  return X.once("health", () => {
    const columns = Object.keys(WB_HEALTH_COLS).filter((k) => WB_HEALTH_COLS[k](X));
    const rowsBy = new Map();
    const rowOf = (k) => { if (!rowsBy.has(k)) rowsBy.set(k, { deptId: k, deptName: X.rowNameOf(k), people: [], num: {}, den: {} }); return rowsBy.get(k); };
    for (const u of X.active) rowOf(X.rowKeyOf(u)).people.push(u);
    const add = (k, col, num, den) => { if (!rowsBy.has(k)) return; const r = rowsBy.get(k); r.num[col] = (r.num[col] || 0) + num; r.den[col] = (r.den[col] || 0) + den; };
    for (const r of rowsBy.values()) {
      add(r.deptId, "probation", r.people.filter((u) => u.empStatus === "probation").length, r.people.length);
      add(r.deptId, "hipo", r.people.filter((u) => CT.controlledKeysOf(parseTags(u)).includes("hipo")).length, r.people.length);
    }
    if (columns.includes("compliance")) for (const g of wbComplianceByRow(X).values()) add(g.deptId, "compliance", g.num, g.den);
    let cycle = null;
    if (columns.includes("reviewOnTime")) {
      cycle = WB.pickReviewCycles(X.reviewCycles()).current;
      if (cycle) for (const x of wbReviewInstances(X, cycle)) {
        const k = x.stage === "calib" ? x.dept1Id : X.rowKeyOf(X.byId.get(x.userId));
        add(k, "reviewOnTime", x.onTime ? 1 : 0, 1);
      }
    }
    const tot = { num: {}, den: {} };
    for (const r of rowsBy.values()) for (const col of Object.keys(r.den)) { tot.num[col] = (tot.num[col] || 0) + (r.num[col] || 0); tot.den[col] = (tot.den[col] || 0) + r.den[col]; }
    const LAG = { compliance: true, reviewOnTime: true };   // 试用期占比、高潜占比只展示不标落后（3.4）
    const total = { headcount: X.active.length, cells: {} };
    for (const col of columns) {
      if (col === "headcount") { total.cells.headcount = X.active.length; continue; }
      total.cells[col] = WB.healthCell({ num: tot.num[col] || 0, den: tot.den[col] || 0 }, null, X.cfg, { lag: false });
    }
    const rows = [...rowsBy.values()].map((r) => {
      const cells = {};
      for (const col of columns) {
        if (col === "headcount") { cells.headcount = r.people.length; continue; }
        cells[col] = WB.healthCell({ num: r.num[col] || 0, den: r.den[col] || 0, headcount: r.people.length }, total.cells[col].value, X.cfg, { lag: !!LAG[col] });
      }
      return { deptId: r.deptId, deptName: r.deptName, headcount: r.people.length, cells, people: r.people };
    });
    return { columns, rows: WB.sortHealthRows(rows), total, cycle: cycle ? { id: cycle.id, name: cycle.name } : null, config: { lagPp: X.cfg.lagPp, minDeptHeadcount: X.cfg.minDeptHeadcount } };
  });
}
// 部门健康度格子的名单：metric = dept.<列>，dept = 行 id（不在表里 → 404）
function wbDeptDrill(X, col, q) {
  if (!X.can("people") || !WB_HEALTH_COLS[col] || !WB_HEALTH_COLS[col](X)) return null;
  const h = wbDeptHealth(X);
  const row = h.rows.find((r) => r.deptId === String(q.get("dept") || ""));
  if (!row) return null;
  const link = "/admin/people";
  if (col === "headcount") return { kind: "person", link, rows: row.people.map((u) => X.person(u)) };
  if (col === "probation") return { kind: "person", link, rows: row.people.filter((u) => u.empStatus === "probation").map((u) => X.person(u, { hireDate: u.hireDate || null })) };
  if (col === "hipo") return { kind: "person", link, rows: row.people.filter((u) => CT.controlledKeysOf(parseTags(u)).includes("hipo")).map((u) => X.person(u)) };
  if (col === "compliance") {
    const ov = X.ovQ();
    return { kind: "person", link: "/admin/training-overview?period=quarter", rows: wbCellsByPerson(X, wbComplianceCells(X).filter((c) => X.rowKeyOf(c.u) === row.deptId && TS.statusAt(c, ov.asOf) !== "done")) };
  }
  if (col === "reviewOnTime") {
    if (!h.cycle) return { kind: "stage", rows: [], link: "/admin/reviews" };
    const c = X.reviewCycles().find((x) => x.id === h.cycle.id);
    const rows = wbReviewInstances(X, c).filter((x) => !x.onTime && (x.stage === "calib" ? x.dept1Id === row.deptId : X.rowKeyOf(X.byId.get(x.userId)) === row.deptId)).map((x) => wbInstanceRow(X, x));
    return { kind: "stage", rows, link: `/admin/reviews?cycle=${encodeURIComponent(c.id)}` };
  }
  return null;
}
const WB_TODO = [
  ["probationDue", "people", "core"], ["reviewSelfOverdue", "performance", "performance"], ["reviewRateOverdue", "performance", "performance"],
  ["reviewHrConfirm", "performance", "performance"], ["appealsDue", "performance", "performance"], ["trainingOverdue", "learning", "learning"],
  ["trainingDueSoon", "learning", "learning"], ["approvals", "learning", "learning"], ["grading", "learning", "learning"],
  ["noJobLevel", "people", "core"], ["noManager", "people", "core"], ["deptNoHrbp", "people", "performance"],
];
// GET /api/admin/workbench/todo：可见的待办条目（count 可为 0，前端决定是否显示）；按严重度 → 截止日 → 数量排序。
function wbTodo(X) {
  const items = [];
  for (const [key, domain, module] of WB_TODO) {
    const m = WB_METRICS[key];
    if (!m.ok(X)) continue;
    const r = m.run(X, null);
    const rows = r.rows;
    const dues = rows.map((x) => x.dueOn).filter(Boolean).sort();
    let overdueCount;
    if (key === "probationDue" || key === "appealsDue") overdueCount = rows.filter((x) => x.overdue).length;
    else if (key === "grading") overdueCount = rows.filter((x) => x.overdue).length;
    let severity = "normal";
    if (["reviewSelfOverdue", "reviewRateOverdue", "trainingOverdue"].includes(key) && rows.length) severity = "overdue";
    else if (overdueCount) severity = "overdue";
    else if (key === "trainingDueSoon" && rows.length) severity = "soon";
    else if (key === "appealsDue" && rows.length) severity = "soon";
    else if (key === "probationDue" && dues.length && dues[0] <= WB.addDays(X.today, 7)) severity = "soon";
    items.push({ key, domain, module, count: rows.length, dueOn: dues[0] || null, severity, link: r.link || null, drill: { metric: key },
      ...(overdueCount !== undefined ? { overdueCount } : {}) });
  }
  return { items: WB.sortTodo(items), asOf: X.today };
}
// GET /api/admin/workbench/risk：六项指标（2.7 形状 + drill / link；无权的项不出现）
function wbRisk(X) {
  const p = X.period;
  const period = { from: p.from, to: p.to, prevFrom: p.prevFrom, prevTo: p.prevTo };
  const metrics = [];
  if (WB_METRICS.succession.ok(X)) {
    const c = wbSuccession(X);
    const s = X.snapRows(p.prevKey, "succession");
    const prev = s.taken ? KP.successionFromSnapshot(s.rows, X.dAllow).value : null;
    metrics.push({ ...WB.buildMetric({ key: "succession", domain: "talent", module: "talent", unit: "pct", num: c.num, den: c.den, value: c.value, prev, better: "up", period,
      extra: { noSuccessor: c.noSuccessor }, empty: c.empty }), drill: { metric: "succession" }, link: "/admin/talent-review/key-positions", snapshotSince: X.snapSince("succession") });
  }
  if (WB_METRICS.retention.ok(X)) {
    const cur = wbRetention(X, "cur"), prv = wbRetention(X, "prev");
    const flightNow = CT.flightRiskIds(X.people).length;
    const fs = X.snapRows(p.prevKey, "flight");
    const flightPrev = fs.taken ? WB.snapshotIds(fs.rows, X.dAllow).length : null;
    metrics.push({ ...WB.buildMetric({ key: "retention", domain: "talent", module: "talent", unit: "count", num: cur.num, den: null, value: cur.num, prev: prv.num, better: "down", period,
      extra: { rate: cur.value, rateDen: cur.den, prevRate: prv.value, voluntary: cur.voluntaryIds.length,
        flight: { value: flightNow, prev: flightPrev, delta: WB.deltaOf(flightNow, flightPrev), better: "down", drill: { metric: "flight" }, snapshotSince: X.snapSince("flight") } } }),
      drill: { metric: "retention" }, link: "/admin/employees" });
  }
  if (WB_METRICS.compliance.ok(X)) {
    const ov = X.ovQ();
    const k = TS.computeKpis({ cells: ov.cells(), H: ov.users.length, wins: ov.wins, today: ov.today, attemptsIn: () => ({ passed: 0, total: 0 }) }).requiredCompletion;
    const low = WB.lowestRate([...wbComplianceByRow(X).values()].filter((g) => g.deptId !== "__none"), X.cfg.minComplianceDen);
    const notDone = WB_METRICS.compliance.run(X, null).rows.length;
    metrics.push({ ...WB.buildMetric({ key: "compliance", domain: "learning", module: "learning", unit: "pct", num: k.num, den: k.den, value: k.value, prev: k.prev, better: "up", period,
      extra: { lowestDept: low ? { id: low.deptId, name: low.deptName, value: low.value, num: low.num, den: low.den } : null, notDonePeople: notDone }, empty: k.den ? null : "no_data" }),
      drill: { metric: "compliance" }, link: "/admin/training-overview?period=quarter" });
  }
  if (WB_METRICS.reviewOnTime.ok(X)) {
    const pk = WB.pickReviewCycles(X.reviewCycles());
    const sum = (c) => (c ? WB.onTimeSummary(wbReviewInstances(X, c)) : null);
    const cur = sum(pk.current), prv = sum(pk.prev);
    metrics.push({ ...WB.buildMetric({ key: "reviewOnTime", domain: "performance", module: "performance", unit: "pct", num: cur ? cur.num : null, den: cur ? cur.den : null,
      value: cur ? cur.value : null, prev: prv ? prv.value : null, better: "up", period,
      extra: { cycle: pk.current ? { id: pk.current.id, name: pk.current.name } : null, prevCycle: pk.prev ? { id: pk.prev.id, name: pk.prev.name } : null,
        stages: cur ? { self: cur.byStage.self.value, rate: cur.byStage.rate.value, calib: cur.byStage.calib.value } : { self: null, rate: null, calib: null },
        lateCount: cur ? cur.den - cur.num : 0 },
      empty: pk.current ? (cur.den ? null : "no_data") : "no_cycle" }), drill: { metric: "reviewOnTime" },
      link: pk.current ? `/admin/reviews?cycle=${encodeURIComponent(pk.current.id)}` : "/admin/reviews" });
  }
  if (WB_METRICS.probation.ok(X)) {
    const cur = wbProbation(X, "cur"), prv = wbProbation(X, "prev");
    metrics.push({ ...WB.buildMetric({ key: "probation", domain: "people", module: "core", unit: "pct", num: cur.num, den: cur.den, value: cur.value, prev: prv.value, better: "up", period,
      extra: { avgMonths: cur.avgMonths, prevAvgMonths: prv.avgMonths }, empty: cur.den ? null : "no_data" }), drill: { metric: "probation" }, link: "/admin/employees" });
  }
  if (WB_METRICS.span.ok(X)) {
    const cur = wbSpan(X);
    const s = X.snapRows(p.prevKey, "span");
    const prv = s.taken ? WB.spanFromSnapshot(s.rows, X.dAllow, X.cfg) : null;
    metrics.push({ ...WB.buildMetric({ key: "span", domain: "people", module: "core", unit: "count", num: cur.count, value: cur.count, prev: prv ? prv.count : null, better: "down", period,
      extra: { zero: cur.none, over: cur.wide, spanMax: X.cfg.spanMax } }), drill: { metric: "span" }, link: "/admin/org-chart?tab=diag", snapshotSince: X.snapSince("span") });
  }
  return { period: { ...period, key: p.key, prevKey: p.prevKey, asOf: X.today }, metrics };
}
// GET /api/admin/workbench/structure：九宫格缩略、绩效配额偏离、晋升与梯队、部门健康度（无权的块不出现）
function wbStructure(X) {
  const out = {};
  if (X.mods.talent && X.can("talent")) {
    const nb = wbNineCells(nineBoxRows(X.user, null));
    const closed = X.mods.performance ? wbClosedCycles(X) : [];
    out.nineBox = { cells: nb.cells, unrated: nb.unrated, drill: { metric: "nineBox" } };
    if (closed.length >= 2) {
      const a = wbNineCells(nineBoxRows(X.user, closed[0])), b = wbNineCells(nineBoxRows(X.user, closed[1]));
      out.nineBox.compare = { latest: { id: closed[0].id, name: closed[0].name, cells: a.cells, unrated: a.unrated }, previous: { id: closed[1].id, name: closed[1].name, cells: b.cells, unrated: b.unrated } };
    }
    const cand = wbPromotionCandidates(X), promo = wbPromotion12m(X);
    out.pipeline = { candidates: X.active.filter((u) => cand.has(u.id)).length, promotionRate: promo.value, promoted: promo.num, headcount: promo.den,
      gaps: WB.pipelineGaps(jobGrades(), X.active, cand).map((g) => ({ track: g.track, grade: g.grade, lowerGrade: g.lowerGrade, headcount: g.headcount })) };
  }
  if (X.mods.performance && X.can("performance")) {
    const c = wbClosedCycles(X)[0] || null;
    if (!c) out.perfQuota = { cycle: null, depts: [] };
    else {
      const groups = reviewGroups(c, X.cycleItems(c)).filter((g) => (g.dept1Id === "__none" ? !X.dp : X.dAllow(g.dept1)));
      const dev = WB.quotaDeviation(groups, reviewQuotaOf(c), { minHc: REVIEW_QUOTA_MIN_HC });
      out.perfQuota = { cycle: { id: c.id, name: c.name }, depts: dev.map((d) => ({ dept1Id: d.dept1Id, dept1: d.dept1, headcount: d.headcount, small: d.small, over: d.over,
        bands: Object.fromEntries(d.tiers.map((t) => [t.tier, { actual: t.actualPct, quota: t.quotaPct, count: t.count, deviation: t.deviationPp }])) })) };
    }
  }
  if (X.can("people")) {
    const h = wbDeptHealth(X);
    out.deptHealth = { columns: h.columns, rows: h.rows.map(({ people, ...r }) => ({ ...r, lagCount: WB.lagCount(r) })), total: h.total, config: h.config, cycle: h.cycle };
  }
  return out;
}
// GET /api/admin/workbench/people：名单。未知或无权的 metric、不在表里的部门 → null（handler 回 404）
const WB_PEOPLE_CAP = 500;
function wbPeople(X, q) {
  const metric = String(q.get("metric") || "");
  let r = null;
  if (metric.startsWith("dept.")) r = wbDeptDrill(X, metric.slice(5), q);
  else if (Object.prototype.hasOwnProperty.call(WB_METRICS, metric) && WB_METRICS[metric].ok(X)) r = WB_METRICS[metric].run(X, q);
  if (!r) return null;
  const total = r.rows.length;
  return { metric, kind: r.kind, total, rows: r.rows.slice(0, WB_PEOPLE_CAP), truncated: total > WB_PEOPLE_CAP, period: WB_PERIOD(q), ...(r.link ? { link: r.link } : {}) };
}
// 每日快照（2.8）：马尼拉 01:00 之后第一次检查执行（meta workbenchSnapDay 一天一次）；服务启动时当天未跑也执行一次。
// 全公司口径按主体存行；同一季度每天整体替换，季度最后一次即期末状态；只保留最近 8 个季度。
function workbenchSnapshotDaily(opts) {
  try {
    const now = nowMs();
    if (!WB.snapshotDue(now, store.getMeta("workbenchSnapDay"), opts)) return;
    const today = WB.manilaDay(now);
    store.setMeta("workbenchSnapDay", today);
    const key = WB.quarterOf(today).key;
    const all = store.listUsers();
    const byId = new Map(all.map((u) => [u.id, u]));
    const users = all.filter((u) => u.role !== "admin" && !LC.isServiceAccount(u));
    const live = users.filter((u) => orgLib.isInService(u));
    const deptRows = store.listDepartments(true);
    const ix = orgLib.buildOrgIndex(deptRows);
    const owners = new Set(deptRows.filter((d) => d.ownerId && d.active).map((d) => d.ownerId));
    const S = { subjectId: WB_SNAP_SENTINEL, deptName: null, data: {} };
    const positions = store.listKeyPositions().map((p) => ({ ...p, deptName: kpDeptNameOf(p, ix) }));
    store.replaceWorkbenchSnapshots(key, "succession", [S, ...KP.successionSnapshotRows(positions, store.listSuccession(), { userById: (id) => byId.get(id) || null, inService: (u) => u.role !== "admin" && orgLib.isInService(u) })], today);
    store.replaceWorkbenchSnapshots(key, "span", [S, ...WB.spanSnapshotRows(live, { ranks: jobGrades(), ownerIds: owners })], today);
    store.replaceWorkbenchSnapshots(key, "flight", [S, ...CT.flightSnapshotRows(users)], today);
    store.pruneWorkbenchSnapshots(WB.oldestKeptPeriod(today));
  } catch (e) {
    console.error("[workbench-snapshot] " + ((e && e.message) || e));
  }
}


// CSV 正文（与 sendCsv 同一规则，模块的 services.csv / csvLines 也用它们 —— CONTRACT.md 4.9）：
// csvText(rows) = BOM + 各行（第一行通常是表头），行间 CRLF；csvLinesText(rows) = 只有数据行、不带 BOM 与末尾换行，
// 分批生成的导出每批调用一次，最后拼成 csvText([headers]) + CRLF + 各批结果按 CRLF 连接。
function csvLinesText(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}
function csvText(rows) {
  // BOM so Excel opens UTF-8 (Chinese names) correctly.
  return "\uFEFF" + csvLinesText(rows);
}
function sendCsv(res, filename, rows) {
  const body = csvText(rows);
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
  });
  res.end(body);
}
// ---------- AI 辅助：路由共用的工具（服务商、开关、调用记录、限流与预算在 modules/ai/，见文件头 AI 一节） ----------
// 错误码 → HTTP 状态与双语文案（方案 3.4）。响应只有错误码与通用文案，不含任何上游原文（P-7.6、P-7.10）；
// 后台页面按 code 另给处理建议，员工端只显示通用文案。
const AI_UNAVAILABLE = ["The AI service is temporarily unavailable. Please try again later.", "AI 服务暂时不可用，请稍后再试。"];
const AI_INCOMPLETE = ["The AI response was incomplete. Please retry.", "AI 生成内容不完整，请重试。"];
const AI_ERRORS = {
  ai_timeout: [504, "The AI service timed out. Please try again later.", "AI 服务响应超时，请稍后再试。"],
  ai_upstream_error: [502, ...AI_UNAVAILABLE],
  ai_auth_failed: [502, ...AI_UNAVAILABLE],
  ai_model_not_found: [502, ...AI_UNAVAILABLE],
  ai_bad_request: [502, ...AI_UNAVAILABLE],
  ai_refused: [422, "The AI could not process this request. Please rephrase.", "AI 无法处理此请求，请换一种问法。"],
  ai_output_truncated: [502, ...AI_INCOMPLETE],
  ai_output_invalid: [502, ...AI_INCOMPLETE],
  ai_input_too_large: [413, "The content is too long. Please shorten it.", "内容过长，请缩短后重试。"],
  ai_not_configured: [503, "The AI service is not connected yet.", "AI 服务尚未接入。"],
};
function sendAiError(res, e) {
  const code = e && AI_ERRORS[e.code] ? e.code : "ai_upstream_error";
  const [status, en, zh] = AI_ERRORS[code];
  return send(res, status, { error: en, error_zh: zh, code, ...(e && e.reason ? { reason: e.reason } : {}) });
}
function sendAiState(res, st) {
  const r = AI.stateResponse(st);
  return send(res, r.status, r.body);
}
function sendAiRateLimited(res, retryAfterSec) {
  const n = Math.max(1, Math.ceil(retryAfterSec / 60));
  return send(res, 429, { error: `Too many requests. Please try again in ${n} min.`, error_zh: `提问过于频繁，请 ${n} 分钟后再试。`, code: "ai_rate_limited", retryAfterSec }, { "retry-after": String(retryAfterSec) });
}
// 花名册全名（脱敏 R5 / R5c 的匹配表）：60 秒缓存
let aiRosterCache = { at: 0, names: [] };
function aiRoster() {
  if (Date.now() - aiRosterCache.at > 60000) aiRosterCache = { at: Date.now(), names: store.listUsers().map((u) => u.name).filter(Boolean) };
  return aiRosterCache.names;
}
// 实线上级与虚线上级的姓名（替换为 [上级]，画像输出中还原）
function aiManagersOf(u) {
  const out = [];
  if (u.managerId) { const m = store.getUserById(u.managerId); if (m) out.push(m.name); }
  for (const l of store.listSecondaryLines(u.id)) if (l.managerId) { const m = store.getUserById(l.managerId); if (m) out.push(m.name); }
  return out;
}
// 学习助手：员工有覆盖当前课程的「进行中」考试时拒绝（方案 4.1 第 1 条）。「进行中」只算两类：有时限且仍在
// startedAt + 时限 + 2 分钟之内；无时限且最近 examIdleHours（默认 3）小时内有保存 —— 遗弃的答卷不会让助手永久不可用。
// 中途离开 = 重新开始（/api/exam/start 会删掉未交卷的旧答卷），所以遗留的未交卷答卷只来自「离开后没再回来」，
// 由上面的时间规则自然过期；答题页每 60 秒发一次心跳（PUT …/draft）刷新 lastSavedAt，无时限考试也保持准确。
function examInProgressForCourse(userId, courseId) {
  const idleMs = AI.limits().assistant.examIdleHours * 3600000;
  for (const a of store.listOpenAttemptsForUser(userId)) {
    const exam = a.examId ? store.getExam(a.examId) : null;
    let cids = exam ? store.getExamCourseIds(exam.id) : [];
    if (!cids.length) { const p = getProgram(a.programId); cids = (p && p.courseIds) || []; }
    if (!cids.includes(courseId)) continue;
    if (exam && exam.timeLimitMinutes) {
      if (Date.now() <= new Date(a.startedAt).getTime() + (exam.timeLimitMinutes + 2) * 60000) return true;
    } else if (Date.now() - new Date(a.lastSavedAt || a.startedAt).getTime() <= idleMs) return true;
  }
  return false;
}

// ---------- 简答题：交卷即落库、后台排队评分（方案 2.5） ----------
// 计分口径与改动前一致：单选 / 填空 1 分，多选全对 1 分、部分对 0.5 分，每道简答题按 maxPoints/10 折算。
// 未评分（score 为空）的简答题按 0 计，percent 是下限值（员工端与导出都不把它当最终得分）。
// 每题分值（2026-10-06 需求单 #4）：答卷里每题带 points 时按分值计（客观题答对得满分、多选部分正确得一半、简答按 score/maxPoints 折算到分值）；
// 没有 points 的旧答卷沿用旧口径。两种明细可以混在一张卷里（不会发生，但计算上安全）。
// 第四批 6.1：计分走注册表（QT.scoreTotals）—— 先问各题型的 totals()（新题型：分值 × 得分比例 credit，没有分值按 1 分；
// 案例：各小题之和），旧四种题型返回 null，走上面这套原口径，逐字照旧（旧答卷、旧题型新开的卷分数与改动前相同）。
function scoreTotals(detail) {
  return QT.scoreTotals(detail);
}
function scoreDetail(detail) {
  return QT.scoreDetail(detail);
}
// 一道题在某场考试里的分值：题目自身的 points 优先，否则取考试的题型默认分值；都没有 = 旧口径（返回 null，不写 points）。
function examTypePoints(exam) { const tp = exam && exam.typePoints; return tp && typeof tp === "object" ? tp : null; }
// 第四批：考试设了题型默认分值、但没有某个新题型的键（旧考试只存了四个键）→ 该题型的目录默认分值（spec defaultPoints）。
// 旧四种题型的口径不变（有 typePoints 时四个键总是齐的）。案例题组的分值不在这里：见 casePointsOf。
function questionPoints(exam, q) {
  if (q && q.points != null) return Number(q.points);
  const tp = examTypePoints(exam);
  if (tp && tp[q.type] != null) return Number(tp[q.type]);
  if (tp && q && !LEGACY_QTYPES.has(q.type) && q.type !== "case") { const d = QT.defaultPoints(q.type); return d != null ? Number(d) : null; }
  return null;
}
// 案例小题的题型默认分值（开考快照 ctx.pointsFor 用）：考试设了题型分值 → 该题型的值或目录默认；旧口径 → null（快照按每小题 1 分）
function caseSubPointsFor(exam) {
  const tp = examTypePoints(exam);
  return (sub) => (tp ? (tp[sub.type] != null ? Number(tp[sub.type]) : QT.defaultPoints(sub.type)) : null);
}
// 一组情境案例的分值 = 各小题分值之和（小题自己的 points > 考试的题型默认分值 > 1），与开考快照（case.js subPoints）同一口径
function casePointsOf(exam, q) {
  const pf = caseSubPointsFor(exam);
  return (q.items || []).filter((sub) => sub && QT.get(sub.type) && QT.isEnabled(sub.type)).reduce((n, sub) => {
    if (sub.points != null && Number.isFinite(Number(sub.points))) return n + Number(sub.points);
    const v = pf(sub);
    return n + (v != null && Number.isFinite(Number(v)) ? Number(v) : 1);
  }, 0);
}
// 题目请求体 → 题库条目。新建（POST）与原地修改（PUT）共用同一套校验；返回 { item } 或 { error }。
// 第四批 6.1：按题型走注册表（QT.itemFromBody → 各题型 validate）。旧四种题型的错误文字与条目逐字照旧；
// 另带 error_zh 与 code（未知 / 未开放的题型 → bad_type）。
function questionItemFromBody(q) {
  return QT.itemFromBody(q, { bulk: false });
}
// 固定题目模式：整卷 = exam.questionIds 里仍存在于题库的题，按设定顺序
function fixedExamQuestions(exam) {
  if (!exam || exam.mode !== "fixed") return null;
  const byId = new Map(store.listQuestions().map((q) => [q.id, q]));
  return (exam.questionIds || []).map((id) => byId.get(id)).filter(examUsable);   // 第四批：不认识 / 未开放的题型不进卷
}
// 考前说明用：按当前题库与抽题数估算卷面总分区间（随机抽题时分值不同的题会让总分浮动）。旧口径返回 null。
function examPointsRange(exam) {
  const fixed = fixedExamQuestions(exam);
  if (fixed) {
    const pts = fixed.map((q) => (q.type === "case" ? casePointsOf(exam, q) : questionPoints(exam, q)));
    if (pts.some((v) => v == null)) return null;
    const sum = pts.reduce((a, b) => a + b, 0);
    return { min: sum, max: sum };
  }
  const pool = examQuestions(exam);
  // 第四批：客观题 = 全部客观题型；情境案例每组按小题分值之和（casePointsOf）
  const obj = pool.filter((q) => QT.groupOf(q.type) === "objective").map((q) => questionPoints(exam, q));
  const opn = pool.filter((q) => q.type === "open").map((q) => questionPoints(exam, q));
  const kas = pool.filter((q) => q.type === "case").map((q) => casePointsOf(exam, q));
  if ([...obj, ...opn].some((v) => v == null)) return null;
  const take = (arr, n, dir) => arr.slice().sort((a, b) => (dir === "min" ? a - b : b - a)).slice(0, n).reduce((x, y) => x + y, 0);
  const nObj = Math.min(exam.mcqCount || 0, obj.length), nOpn = Math.min(exam.openCount || 0, opn.length), nCase = Math.min(exam.caseCount || 0, kas.length);
  return { min: take(obj, nObj, "min") + take(opn, nOpn, "min") + take(kas, nCase, "min"), max: take(obj, nObj, "max") + take(opn, nOpn, "max") + take(kas, nCase, "max") };
}
function examRulesOf(a) {
  const p = getProgram(a.programId);
  const exam = a.examId ? store.getExam(a.examId) : null;
  const rules = exam || { passingScore: p ? p.passingScore : 80, timeLimitMinutes: p ? p.examTimeLimitMinutes || null : null, showAnswersAfterExam: p ? p.showAnswersAfterExam !== false : true };
  return { p, exam, rules };
}
// 自动重修（重修重考）：受限次数的考试最后一次仍未通过 → 作废历史、清空课程进度、通知员工。只在「结论确定」时判定。
function autoRetrainIfExhausted(u, exam, p, requestId) {
  if (!exam || !exam.maxAttempts || exam.autoRetrain === false) return false;
  const used = store.listUserExamAttempts(u.id, exam.id).length; // incl. this one
  if (used < exam.maxAttempts) return false;
  store.voidUserExamAttempts(u.id, exam.id);
  let cids = store.getExamCourseIds(exam.id);
  if (!cids.length) cids = (p && p.courseIds) || [];
  for (const cid of cids) store.clearCourseProgress(u.id, cid);
  store.addAudit({ actorId: u.id, actorName: u.name, action: "exam.auto-retrain", target: exam.id, before: null, after: { employeeId: u.employeeId, attempts: used }, requestId: requestId || null });
  notify(u.id, {
    type: "exam.retrain",
    title: `"${exam.title || exam.title_zh || ""}" not passed after ${used} attempts — course reset for a re-study`,
    title_zh: `《${exam.title_zh || exam.title}》${used} 次未通过，课程已重置，请重修后再考`,
    body: "Your course progress was cleared and your attempts reset. Finish the modules again to unlock the exam.",
    body_zh: "课程进度与考试次数已自动重置，重新完成课程模块后即可再次参加考试。",
    link: `#/program/${exam.programId}`,
  });
  return true;
}
// 定稿：按决定性复核规则确定评分状态（方案 2.5）。
//   undecided = 由 AI 初评（ai_provisional）或尚未评分的简答题；分别按 0 分和满分重算，「是否通过」结论不同即为决定性情形。
//   决定性 → pending_review（passed 暂存 0，结论待定；AI 初评不予采用，改为待复核）；
//   非决定性但仍有未评分的题 → manual_pending（结论已确定，不受该题影响）；其余 → final。
// o: { prevStatus, atSubmit, requestId }。离开「结论待定」时执行暂缓的自动重修判定，并通知员工。
function settleAttempt(a, o = {}) {
  const { p, exam, rules } = examRulesOf(a);
  const detail = a.detail || [];
  const opens = detail.filter((q) => q.type === "open");
  const undecided = opens.filter((q) => q.score == null || q.review === "ai_provisional");
  // F57：是否通过一律走 QT.passedOfDetail（未四舍五入的得分比例 ≥ 及格线），百分比仍存整数
  const passesAt = (v) => QT.passedOfDetail(detail.map((q) => (undecided.includes(q) ? { ...q, score: v === "max" ? q.maxPoints : 0 } : q)), rules.passingScore);
  const decisive = undecided.length > 0 && passesAt(0) !== passesAt("max");
  if (decisive) for (const q of undecided) if (q.review === "ai_provisional") { q.review = "pending"; q.score = null; q.feedback = null; }
  const percent = scoreDetail(detail);
  let status, passed;
  if (decisive) { status = "pending_review"; passed = false; }
  else { passed = QT.passedOfDetail(detail, rules.passingScore); status =opens.some((q) => q.score == null) ? "manual_pending" : "final"; }
  store.updateAttemptGrading(a.id, { percent, passed, detail, gradingStatus: status });
  const u = store.getUserById(a.userId);
  const wasPending = o.prevStatus === "grading" || o.prevStatus === "pending_review";
  const concluded = status !== "pending_review";
  let autoRetrained = false;
  if (u && concluded && !passed && (o.atSubmit || wasPending)) autoRetrained = autoRetrainIfExhausted(u, exam, p, o.requestId);
  if (u && wasPending && status !== o.prevStatus) {
    const title = exam ? exam.title : p ? p.title : "Exam";
    const titleZh = exam ? exam.title_zh || exam.title : p ? p.title_zh || p.title : "考试";
    notify(u.id, status === "pending_review" ? {
      type: "exam.graded",
      title: `"${title}": your short answer is awaiting HR review`,
      title_zh: `《${titleZh}》简答题待 HR 复核`,
      body: "Whether you pass will be confirmed after the review; you will be notified.",
      body_zh: "复核后确定是否通过，完成后会通知你。",
      link: `#/result/${a.id}`,
    } : {
      type: "exam.graded",
      title: `Result ready: "${title}" — ${percent}%, ${passed ? "passed" : "not passed"}`,
      title_zh: `《${titleZh}》成绩已出：${percent}%，${passed ? "已通过" : "未通过"}`,
      body: status === "manual_pending" ? "Your pass/fail result is final. One short answer is still awaiting HR scoring." : null,
      body_zh: status === "manual_pending" ? "是否通过已确定；有简答题待 HR 评分。" : null,
      link: `#/result/${a.id}`,
    });
  }
  return { status, percent, passed, autoRetrained };
}
// 评分队列：进程内、按 attemptId 去重，使用独立的并发池（ai.limits.gradingConcurrency）。
// 排队超过 ai.limits.gradingMaxWaitMin（默认 30 分钟）仍未评完的题，按 AI 不可用处理（转 HR）。
const GRADING_QUEUE = new Set();
// prevStatus：HR 手动「AI 重新初评」时传入答卷原来的状态（pending_review / manual_pending），
// 评完按原状态结算 —— manual_pending 的通过与否早已定稿，不能再触发一次通知或自动重修。
function enqueueGrading(attemptId, enqueuedAt, prevStatus) {
  if (GRADING_QUEUE.has(attemptId)) return;
  GRADING_QUEUE.add(attemptId);
  gradeAttempt(attemptId, enqueuedAt || Date.now(), prevStatus)
    .catch((e) => console.warn("[ai] grading job failed: attempt=" + attemptId + " " + ((e && e.code) || (e && e.message) || e)))
    .finally(() => GRADING_QUEUE.delete(attemptId));
}
function markOpenUnavailable(d, code) {
  d.score = null;
  d.review = "pending";
  d.feedback = null;
  d.ai = { errorCode: code, at: new Date().toISOString() };
}
async function gradeAttempt(attemptId, enqueuedAt, prevStatus) {
  const a = store.getAttempt(attemptId);
  if (!a || a.gradingStatus !== "grading") return;
  const u = store.getUserById(a.userId);
  const deadline = enqueuedAt + AI.limits().gradingMaxWaitMin * 60000;
  const bank = new Map();
  for (const d of a.detail || []) {
    if (d.type !== "open" || (d.ai && !d.ai.errorCode)) continue; // 已有 AI 结果的题不重评（重启恢复）
    const st = AI.featureState("grading");
    if (st.state !== "on") { markOpenUnavailable(d, st.state === "budget_exhausted" ? "ai_budget_exhausted" : "ai_not_configured"); continue; }
    if (Date.now() > deadline) { markOpenUnavailable(d, "ai_timeout"); continue; }
    const src = (a.questions || []).find((q) => q.id === d.id) || {};
    if (!bank.has(d.id)) bank.set(d.id, store.getQuestion(d.id));
    const qb = bank.get(d.id) || {};
    const built = aiFeatures.buildGrading({
      question: src.question || d.question, question_zh: src.question_zh || d.question_zh || null,
      rubric: src.rubric || qb.rubric || "", rubric_zh: qb.rubric_zh || null, maxPoints: d.maxPoints, answer: d.answer,
      self: u ? { name: u.name, employeeId: u.employeeId } : {}, roster: aiRoster(),
    });
    try {
      const r = await AI.call("grading", {
        actorId: a.userId, actorKind: "system", subjectUserId: a.userId, refId: a.id,
        system: built.system, messages: built.messages, schema: built.schema, semantic: built.semantic, redactions: built.redactions,
      });
      const j = r.json;
      const injected = built.injection || (j.flags || []).includes("possible_injection");
      d.ai = {
        ...r.provenance, confidence: j.confidence, suggestedScore: j.score, injectionFlag: injected, flags: j.flags || [],
        criteria: j.criteria || [], feedback: aiFeatures.gradingFeedback(j.feedback),
      };
      // AI 分数不予采用：模型自报低置信度、疑似注入，或服务端确定性检测命中注入句式 —— 建议分与评语只给 HR 看
      if (injected || j.confidence === "low") { d.score = null; d.review = "pending"; d.feedback = null; }
      else { d.score = j.score; d.review = "ai_provisional"; d.feedback = d.ai.feedback; }
    } catch (e) {
      markOpenUnavailable(d, (e && e.code) || "ai_upstream_error");
    }
    // 逐题落库：进程中途重启时，已评完的题不会重评
    store.updateAttemptGrading(a.id, { percent: a.percent, passed: false, detail: a.detail, gradingStatus: "grading" });
  }
  const fresh = store.getAttempt(a.id);
  if (!fresh || fresh.gradingStatus !== "grading") return;
  fresh.detail = a.detail;
  settleAttempt(fresh, { prevStatus: prevStatus || "grading" });
}
// 员工端看到的答卷明细：简答题只给员工该看的字段 —— AI 建议分、评分依据、置信度、注入标记只给 HR（方案 2.5、4.3）
// 第四批 6.1：函数体移到 modules/learning/qtypes/open.js（逐字移植，clientDetail 经注册表调用它），这里只做委托。
function clientOpenDetail(d) {
  return QT.get("open").clientOpenDetail(d);
}

// ---------- AI 人才画像（方案 2.5「画像流程」、4.4） ----------
function portraitTypeLabels(k) {
  if (k === "training") return { en: "Training", zh: "培训" };
  if (k === "hired") return { en: "Joined", zh: "入职" };
  const t = store.getRecordType(k);
  return t ? { en: t.label, zh: t.label_zh || t.label } : { en: k, zh: k };
}
function portraitArgs(u) {
  const { events } = buildTalentTimeline(u);
  const fieldsByType = {};
  for (const f of store.listRecordFields(null)) (fieldsByType[f.typeKey] = fieldsByType[f.typeKey] || []).push(f);
  return {
    brand: brandCfg().name, user: u, events, fieldsByType,
    typeLabel: (k) => portraitTypeLabels(k).en,
    managers: aiManagersOf(u), roster: aiRoster(),
    departments: store.listDepartments(true).map((d) => d.name).filter(Boolean),
    nowMs: Date.now(),
  };
}
function portraitOut(p) {
  if (!p) return null;
  const nameOf = (id) => { if (!id) return null; const x = store.getUserById(id); return x ? x.name : null; };
  return {
    id: p.id, userId: p.userId, status: p.status, content: p.content, unsupportedCount: p.unsupportedCount, demo: !!p.demo,
    provenance: { providerId: p.providerId, protocol: p.protocol, model: p.model, modelReturned: p.modelReturned, promptVersion: p.promptVersion, generatedAt: p.generatedAt, callId: p.callId },
    generatedBy: nameOf(p.generatedBy), generatedAt: p.generatedAt,
    confirmedBy: nameOf(p.confirmedBy), confirmedAt: p.confirmedAt,
    discardedBy: nameOf(p.discardedBy), discardedAt: p.discardedAt, discardReason: p.discardReason,
    objections: (p.objections || []).map((x) => ({ at: x.at, by: nameOf(x.by), summary: x.summary, outcome: x.outcome })),
    inputDigest: p.inputDigest,
  };
}
// 旧前端兼容：扁平的中文字段
function portraitFlat(content) {
  if (!content) return null;
  const j = (arr) => (arr || []).map((x) => x.text_zh || x.text).join(" ");
  return { summary: content.summary ? content.summary.text_zh || content.summary.text : "", strengths: j(content.strengths), risks: j(content.risks), development: j(content.development), readiness: content.readiness ? content.readiness.text_zh || content.readiness.text : "" };
}
// 离职员工画像的删除期限（方案 2.5 第 8 条、待确认事项 8.7：建议 12 个月，由负责人确定）
function portraitRetentionMonths() {
  const v = Number(((readConfig().ai || {}).portraitRetentionMonthsAfterExit));
  return Number.isInteger(v) && v >= 1 && v <= 120 ? v : 12;
}
function exitDateOf(u) {
  if (u.active !== 0 && u.empStatus !== "exited") return null;
  const ex = store.listTalentRecords(u.id).filter((r) => r.type === "exit").sort((x, y) => (x.date < y.date ? 1 : -1))[0];
  return ex ? (ex.detail && ex.detail.lastDay) || ex.date : null;
}

// ---------- AI 治理：调用记录的可见范围（方案 2.3.2，列表与 CSV 共用） ----------
// ---------- 待复核答卷的复核时限（3 个工作日，扣除周末与菲律宾公共假期） ----------
// 负责人 2026-09-28 定 3 个工作日（AI 治理方案 8.5），2026-09-30 定扣除菲律宾公共假期。只作提示（成绩列表「复核超期」），不改变答卷状态。
// 从交卷次日（马尼拉时间）起计，周一至周五且不是公共假期的日子才算工作日。
// 假期清单以 config.json 的 holidays（"YYYY-MM-DD" 数组）为准；没配置时用下面的内置清单：2026 年按 Proclamation No. 1006 (s. 2025)
// 的常规假日与特别非工作日；2027 年只含法定固定日期与按复活节推算的圣周（公告尚未发布）。开斋节、宰牲节由 NCMF 另行公告，未列入。
// IT 每年按总统府公告在 config.json 里更新整份清单（HANDOVER-IT 配置字段表 holidays 一行）。
const REVIEW_LIMIT_WORKDAYS = 3;
const DEFAULT_PH_HOLIDAYS = Object.freeze(["2026-01-01","2026-02-17","2026-04-02","2026-04-03","2026-04-04","2026-04-09","2026-05-01","2026-06-12","2026-08-21","2026-08-31","2026-10-31","2026-11-01","2026-11-30","2026-12-08","2026-12-24","2026-12-25","2026-12-30","2026-12-31","2027-01-01","2027-02-06","2027-03-25","2027-03-26","2027-03-27","2027-04-09","2027-05-01","2027-06-12","2027-08-21","2027-08-30","2027-11-01","2027-11-30","2027-12-08","2027-12-24","2027-12-25","2027-12-30","2027-12-31"]);
// 简化 10/11：同一段同步代码里只读一次 config.json（成绩列表、待办计数按行调用 reviewOverdue，原来每行读一次文件）。
// 缓存在当前同步执行结束时（微任务）清掉，所以改了 config.json 的假期清单，下一个请求立即生效。调用方只读不改这个 Set。
let reviewHolidayMemo = null;
function reviewHolidaySet() {
  if (reviewHolidayMemo) return reviewHolidayMemo;
  const h = readConfig().holidays;
  reviewHolidayMemo = new Set(Array.isArray(h) ? h.map(String).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) : DEFAULT_PH_HOLIDAYS);
  queueMicrotask(() => { reviewHolidayMemo = null; });
  return reviewHolidayMemo;
}
// 简化 10/11：改用申诉的 workdaysBetween（同一套工作日口径）；「今天」经 nowMs()，原来直接取 Date.now()，测试时钟对它不生效
function reviewWorkdaysSince(iso, holidays) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return workdaysBetween(manilaDay(t), appealToday(), holidays);
}
function reviewOverdue(a) {
  return a.gradingStatus === "pending_review" && !!a.submittedAt && reviewWorkdaysSince(a.submittedAt, reviewHolidaySet()) > REVIEW_LIMIT_WORKDAYS;
}

function aiCallVisibleFn(user) {
  if (isSuperAdmin(user)) return () => true;
  const pred = scopePredicate(user);
  if (!pred) return () => true; // 没有数据范围限制
  return (row) => {
    if (row.subjectUserId) return pred(store.getUserById(row.subjectUserId));
    if (row.actorKind === "employee") return pred(store.getUserById(row.actorId));
    return false; // 后台账号且没有数据主体（出题、连接测试）：只对超级管理员与无范围限制的账号可见
  };
}
function aiCallOut(r) {
  const who = (id) => { if (!id) return null; const x = store.getUserById(id); return x ? { name: x.name, employeeId: x.employeeId } : { name: "(deleted)", employeeId: null }; };
  let red = null;
  try { red = r.redactions ? JSON.parse(r.redactions) : null; } catch { red = null; }
  return {
    id: r.id, createdAt: r.createdAt, feature: r.feature, status: r.status, errorCode: r.errorCode, actorKind: r.actorKind,
    actor: who(r.actorId), subject: who(r.subjectUserId), refId: r.refId, providerId: r.providerId, protocol: r.protocol,
    endpointHost: r.endpointHost, configHash: r.configHash, modelRequested: r.modelRequested, modelReturned: r.modelReturned,
    promptVersion: r.promptVersion, httpStatus: r.httpStatus, attempts: r.attempts, latencyMs: r.latencyMs,
    inChars: r.inChars, outChars: r.outChars, inTokens: r.inTokens, outTokens: r.outTokens, tokensEstimated: !!r.tokensEstimated, redactions: red,
  };
}
// 数据流向（治理页第 ④ 块）：按当前实际配置列出每个字段是否发给 AI，并标出与上线基线（迁移 59）不同的字段
const AI_SHARE_BASELINE = {
  performance: { period: "send", rating: "send", score: "send", summary: "omit" },
  training: { programName: "send", period: "send", result: "send", score: "send", rank: "send" },
  award: { awardName: "send", programName: "send", issuer: "omit" },
  violation: { severity: "send", description: "omit", action: "omit" },
  promotion: { fromLevel: "send", toLevel: "send", method: "send", result: "send", score: "send", comments: "omit", syncLevel: "omit" },
  regularization: { result: "send", review: "omit", syncStatus: "omit" },
  transfer: { fromDept: "mask", toDept: "mask", fromPosition: "send", toPosition: "send", reason: "omit", syncDept: "omit" },
};
const AI_SHARE_VALUES = new Set(["send", "mask", "omit"]);
const AI_SHARE_RANK = { omit: 0, mask: 1, send: 2 };
const AI_SHARE_NONE = new Set(["culture-program", "user"]); // 行为实践（3+3 不涉及 AI）与员工自定义字段：不显示、不写、不读
function fieldOut(f) {
  if (!f || !AI_SHARE_NONE.has(f.typeKey)) return f;
  const { aiShare, ...rest } = f;
  return rest;
}
function aiShareBaseline(f) { return (AI_SHARE_BASELINE[f.typeKey] || {})[f.key] || "omit"; }
function aiDataflow() {
  const types = new Map(store.listRecordTypes(true).map((t) => [t.key, t]));
  return store.listRecordFields(null, true)
    .filter((f) => f.typeKey !== "culture-program" && f.typeKey !== "user" && f.input !== "checkbox")
    .map((f) => {
      const t = types.get(f.typeKey);
      const hardExcluded = aiFeatures.PORTRAIT_EXCLUDED_TYPES.has(f.typeKey);
      return {
        id: f.id, typeKey: f.typeKey, typeLabel: t ? t.label : f.typeKey, typeLabel_zh: t ? t.label_zh || t.label : f.typeKey,
        key: f.key, label: f.label, label_zh: f.label_zh || f.label, active: f.active,
        aiShare: hardExcluded ? "omit" : f.aiShare, baseline: aiShareBaseline(f), hardExcluded,
        differs: !hardExcluded && f.aiShare !== aiShareBaseline(f),
      };
    });
}
// AI 调用记录列表与 CSV（GET /api/admin/ai-governance/calls、calls.csv）：同一套筛选与可见范围
function sendAiCalls(res, user, query, asCsv, audit) {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  const fromD = day(query.get("from")), toD = day(query.get("to"));
  const from = fromD ? new Date(fromD + "T00:00:00+08:00").toISOString() : null;
  const to = toD ? new Date(new Date(toD + "T00:00:00+08:00").getTime() + 86400000).toISOString() : null;
  const feature = ["assistant", "questionGen", "grading", "portrait", "translate", "talentFilter", "test"].includes(query.get("feature")) ? query.get("feature") : null;
  const status = ["ok", "error", "demo", "blocked"].includes(query.get("status")) ? query.get("status") : null;
  let actorId = null;
  if (query.get("actor")) {
    const a = store.getUserByEmployeeId(String(query.get("actor")).trim());
    actorId = a ? a.id : "(no such employee)"; // 查无此工号 → 空结果（列表与 CSV 同一口径）
  }
  const visible = aiCallVisibleFn(user);
  const rows = store.listAiCalls({ from, to, feature, status, actorId }).filter(visible);
  if (asCsv) {
    const header = ["id", "time", "feature", "status", "errorCode", "actorKind", "actorEmployeeId", "actorName", "subjectEmployeeId", "subjectName", "provider", "protocol", "host", "configHash", "modelRequested", "modelReturned", "promptVersion", "httpStatus", "attempts", "latencyMs", "inChars", "outChars", "inTokens", "outTokens", "tokensEstimated", "redactions"];
    const lines = rows.map(aiCallOut).map((r) => [r.id, r.createdAt, r.feature, r.status, r.errorCode || "", r.actorKind, r.actor ? r.actor.employeeId || "" : "", r.actor ? r.actor.name : "", r.subject ? r.subject.employeeId || "" : "", r.subject ? r.subject.name : "",
      r.providerId || "", r.protocol || "", r.endpointHost || "", r.configHash || "", r.modelRequested || "", r.modelReturned || "", r.promptVersion || "", r.httpStatus || "", r.attempts, r.latencyMs, r.inChars, r.outChars, r.inTokens, r.outTokens, r.tokensEstimated ? "yes" : "", r.redactions ? JSON.stringify(r.redactions) : ""]);
    audit("ai.calls.export", null, null, { rows: lines.length, from: fromD, to: toD, feature, status });
    return sendCsv(res, "ai-calls.csv", [header, ...lines]);
  }
  const pageSize = Math.min(200, Math.max(10, Number(query.get("pageSize")) || 50));
  const page = Math.max(1, Number(query.get("page")) || 1);
  return send(res, 200, { total: rows.length, page, pageSize, rows: rows.slice((page - 1) * pageSize, page * pageSize).map(aiCallOut) });
}
// 每日维护（在每小时的定时器里，每天只执行一次）：调用记录保留期清理；画像草稿 30 天未处理自动失效（清空正文）；
// 离职满 N 个月的员工画像删除
function aiDailyMaintenance() {
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (store.getMeta("aiMaintenanceDay") === day) return;
  store.setMeta("aiMaintenanceDay", day);
  try {
    AI.retentionSweep();
    const now = new Date().toISOString();
    for (const d of store.listPortraitDraftsBefore(new Date(Date.now() - 30 * 86400000).toISOString())) {
      store.updatePortrait(d.id, { status: "discarded", content: null, discardedAt: now, discardReason: "expired" });
      const u = store.getUserById(d.userId);
      store.addAudit({ actorId: null, actorName: null, action: "talent.portrait.discard", target: u ? u.employeeId : d.userId, before: null, after: { draftId: d.id, reason: "expired" }, requestId: null });
    }
    const months = portraitRetentionMonths();
    for (const uid of store.listPortraitUserIds()) {
      const u = store.getUserById(uid);
      const exit = u ? exitDateOf(u) : null;
      if (u && (!exit || Date.now() - new Date(exit).getTime() <= months * 30.44 * 86400000)) continue;
      const n = store.deletePortraitsForUser(uid);
      if (n) store.addAudit({ actorId: null, actorName: null, action: "talent.portrait.purge", target: u ? u.employeeId : uid, before: null, after: { count: n }, requestId: null });
    }
  } catch (e) {
    console.warn("[ai] daily maintenance failed: " + e.message);
  }
}

// ---------- 功能模块开关页（GET/PUT /api/admin/modules-config） ----------
function forcedOffModules() {
  return new Set(String(process.env.LMS_MODULES_OFF || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function modulesConfigOut() {
  const cfg = readConfig();
  const raw = cfg.modules && typeof cfg.modules === "object" && !Array.isArray(cfg.modules) ? cfg.modules : {};
  const on = modulesOn();
  const forced = forcedOffModules();
  // 可售模块清单取 modulesOn() 的键（与注册表 SELLABLE 同源），默认开关取各自 manifest 的 defaultOn
  const modules = Object.keys(on).map((id) => {
    let mf = {};
    try { mf = require("./modules/" + id + "/manifest.js"); } catch { mf = {}; }
    return { id, name: mf.name || { zh: id, en: id }, on: !!on[id], configured: typeof raw[id] === "boolean" ? raw[id] : null, defaultOn: mf.defaultOn !== false, forcedOff: forced.has(id) };
  });
  const aiCfg = cfg.ai && typeof cfg.ai === "object" && !Array.isArray(cfg.ai) ? cfg.ai : {};
  const fRaw = aiCfg.features && typeof aiCfg.features === "object" ? aiCfg.features : {};
  const st = AI.status();
  return {
    modules,
    ai: {
      features: AI.CATALOG.map((c) => ({ id: c.id, name: c.name, owner: c.owner, humanReview: c.humanReview, enabled: AI.featureEnabled(c.id, cfg), configured: typeof fRaw[c.id] === "boolean" ? fRaw[c.id] : null, defaultOn: c.defaultOn !== false, state: AI.featureState(c.id).state })),
      providerConfigured: !!(st.provider && st.provider.configured), providerReason: st.provider && !st.provider.configured ? st.provider.reason : null, demo: st.demo,
    },
  };
}
// 原子改写 config.json：读 → mutate(cfg) → 写临时文件 → rename。与 writeBrandConfig 同一规则：文件存在但无法解析时抛错，
// 不覆盖（里面可能有可恢复的 Lark / AI 密钥）；mutate 只改自己负责的键，其余键原样写回。
function writeConfigPatch(mutate) {
  const file = configPath();
  let cfg = {};
  let raw = null;
  try { raw = fs.readFileSync(file, "utf8"); } catch { raw = null; }
  if (raw !== null) cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
  mutate(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + crypto.randomBytes(6).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------- request plumbing ----------
function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body);
}
// 请求体上限（按字符计，≈ 字节）。默认 2,000,000，与改动前一致。
// 批量导入路径（BULK_BODY_PATHS，且调用者是已登录的后台账号）放宽到 BULK_BODY_MAX：
// 默认 20,000,000，环境变量 LMS_BULK_BODY_MAX 可调（按字符计）。1 万行花名册的 JSON
// 大约 2–4MB，老上限会让它在进 handler 之前就被拒。放宽只给后台账号：匿名请求打到
// 批量路径照样是 2,000,000，未登录的人不能让服务端缓冲 20MB。
const BODY_MAX = 2_000_000;
const BULK_BODY_MAX = (() => {
  const v = Math.floor(Number(process.env.LMS_BULK_BODY_MAX));
  return Number.isFinite(v) && v > 0 ? v : 20_000_000;
})();
const BULK_BODY_PATHS = new Set([
  "/api/admin/employees/bulk",
  "/api/admin/employees/bulk-reset",
  "/api/admin/employees/bulk-update",
  "/api/admin/records/bulk",
  "/api/admin/secondary-lines/bulk",
  "/api/admin/questions/bulk",
  "/api/admin/assignments/bulk",
]);
// 超限 → 413 + code "body_too_large" + 中英双语（路由的 catch 读 e.status / e.code）。
// 以前是 reject(new Error("body too large")) → 路由回 500，且连接上的剩余数据没人读，
// 浏览器那头多半看到的是连接被重置而不是任何提示。现在：一超限就停止累积（不再占内存），
// 但把剩余数据读完（丢弃）再应答，客户端才能稳定地收到这条 413；超出上限 4 倍以上
// 仍在灌数据的，直接断开连接（不值得为它读下去）。
// setEncoding("utf8")：用 StringDecoder 解码，跨 chunk 被切开的多字节字符（中文姓名）
// 不会被解成乱码 —— 原来的 `raw += chunk` 在 64KB 边界上会把一个汉字切成两个 U+FFFD。
function bodyTooLargeError(limit) {
  const mb = (limit / 1_000_000).toFixed(limit >= 10_000_000 ? 0 : 1);
  const e = new Error(
    `Request is too large (limit about ${mb} MB) — split the data and import in smaller batches. `
    + `请求内容过大（上限约 ${mb} MB）：请拆分数据后分批导入。`);
  e.status = 413;
  e.code = "body_too_large";
  e.limit = limit;
  return e;
}
function readBody(req, limit = BODY_MAX) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let over = false, seen = 0;
    req.setEncoding("utf8");
    req.on("data", (c) => {
      seen += c.length;
      if (over) {
        if (seen > limit * 4) req.destroy();
        return;
      }
      raw += c;
      if (raw.length > limit) { over = true; raw = ""; }
    });
    req.on("end", () => {
      if (over) return reject(bodyTooLargeError(limit));
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        // Tagged so the router answers 400 (client error) rather than 500 — a
        // malformed body must not register as a server fault in monitoring.
        const e = new Error("invalid JSON");
        e.badRequest = true;
        e.invalidJson = true;   // gate 内（带 handler 路由的模块）由外层 catch 改回 400 bad_body（CONTRACT.md 3.5 第 3 步）
        reject(e);
      }
    });
    // 客户端中途断开 / 上面 destroy() 掉的连接不会再有 'end'：在这里收尾，别让 Promise
    // 永远挂着（已 resolve/reject 过的 Promise 再 reject 是空操作）。
    req.on("close", () => {
      if (over) return reject(bodyTooLargeError(limit));
      if (!req.complete) { const e = new Error("request aborted"); e.badRequest = true; reject(e); }
    });
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const VIDEO_EXT = new Set([".mp4", ".webm", ".m4v", ".mov"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".ogg"]);
const DOC_EXT = new Set([".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx"]);
// Everything HR can attach to a course section.
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...DOC_EXT]);
function kindOfExt(ext) {
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if (DOC_EXT.has(ext)) return "doc";
  return null;
}
// Streamed with HTTP Range support so video/audio players can seek.
function serveVideo(req, res, full, extraHeaders = {}) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("Not found"); return; }
    const type = MIME[path.extname(full)] || "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        ...extraHeaders,
      });
      fs.createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes", ...extraHeaders });
      fs.createReadStream(full).pipe(res);
    }
  });
}

// ---------- HTML sanitizer for HR-authored course content (spec 6.6) ----------
// Allowlist approach: simple formatting survives, everything else — scripts,
// styles, iframes, event handlers, javascript: URLs — is stripped server-side.
const HTML_ALLOWED = new Set(["p", "br", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "code", "pre", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "hr", "span", "div"]);
function sanitizeHtml(html) {
  let s = String(html || "");
  // Remove dangerous element blocks including their contents.
  s = s.replace(/<(script|style|iframe|object|embed|form|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<\/?(script|style|iframe|object|embed|form|link|meta|noscript)\b[^>]*>/gi, "");
  // Rebuild every remaining tag from scratch, keeping only allowlisted tags
  // and (for <a>/<img>) safe href/src values.
  s = s.replace(/<\s*(\/?)\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, close, tag, attrs) => {
    tag = tag.toLowerCase();
    if (!HTML_ALLOWED.has(tag)) return "";
    if (close) return `</${tag}>`;
    let keep = "";
    if (tag === "a") {
      const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const url = ((href && (href[1] ?? href[2])) || "").trim();
      if (/^(https?:|mailto:|\/(?!\/))/i.test(url)) keep = ` href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener"`;
    } else if (tag === "img") {
      const src = /src\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const url = ((src && (src[1] ?? src[2])) || "").trim();
      if (!/^(https?:|\/(?!\/))/i.test(url)) return "";
      keep = ` src="${url.replace(/"/g, "&quot;")}" style="max-width:100%" alt=""`;
    }
    return `<${tag}${keep}>`;
  });
  return s;
}
// Authorization for /videos/* (S1). serveStatic used to serve uploaded training
// videos to anybody who knew the URL — static files never pass handleApi's 401
// gate — so this reproduces the /api/attachments/:id model for them:
//   · no session, or a deactivated (offboarded) one → denied;
//   · a console identity that can READ the learning domain → allowed (the same
//     preview privilege that lets a learning-admin open the course being built;
//     the auditor, whose learning grant is none, gets nothing extra);
//   · otherwise the file must be referenced by a course reachable through a
//     PUBLISHED package assigned to this employee — canAccessCourse's rule,
//     spelled out here because that closure lives inside handleApi;
//   · a video no course references (an orphan upload, or one whose section was
//     deleted) → back office only, never a learner.
// Deliberately cheap — one PRAGMA, one cached-index lookup, one assignments read
// — because a learner dragging the progress bar fires a Range request per seek.
function videoAccessAllowed(req, norm) {
  // Fail CLOSED: serveStatic is a bare callback (no promise catch, no
  // uncaughtException handler), so an exception raised while deciding — a busy
  // database, a malformed cookie, a half-written content row — would crash the
  // process instead of refusing one request. Deny and stay up.
  try {
    return videoAccessDecision(req, norm);
  } catch (e) {
    console.warn("video gate denied after an internal error: " + e.message);
    return false;
  }
}
function videoAccessDecision(req, norm) {
  // serveStatic runs outside handleApi, so the cross-process cache check that
  // guards every API request has to be repeated here: a course edited by another
  // process must not be judged against a stale video index.
  if (store.dataVersion() !== CACHE_DATA_VERSION) refreshContent();
  const user = getSessionUser(req);
  if (!user || user.active === 0) return false;
  if (canRead(user, "learning")) return true;
  const name = videoFileName(norm);
  if (!name) return false;
  // EXACT file name only. A case-insensitive fallback used to widen this to the
  // union of every course referencing any case-variant, which on a
  // case-SENSITIVE filesystem (production is Linux) authorises the learner by a
  // DIFFERENT file: /videos/clip.mp4 (an orphan upload) would be granted because
  // an assigned course references /videos/Clip.mp4. A miss here is not a hole —
  // it falls through to the stricter orphan branch (learning readers only), and
  // on Windows the player only ever requests the spelling stored in the course.
  const courseIds = VIDEO_COURSES[name] || [];
  if (!courseIds.length) return false;
  const assignments = store.getUserAssignments(user.id);
  return courseIds.some((cid) => {
    const c = getCourse(cid);
    return !!c && programsContaining(c.id, c).some((pid) => {
      const p = getProgram(pid);
      return !!p && (p.status || "published") === "published" && !!assignments[pid];
    });
  });
}
function serveStatic(req, res, pathname) {
  // /videos/* is the one static branch holding protected content, so both gates
  // below must be decided on the SAME shape as the file lookup further down:
  // on Windows "/VIDEOS/x.mp4" and "/videos\\x.mp4" also resolve into
  // public/videos, so a case- or separator-sensitive prefix test would be a way
  // around them. normalize() also collapses "/videos/../x", which must NOT be
  // gated — the file served there is public/x, no video involved.
  const norm = path.normalize(pathname).replace(/\\/g, "/");
  const normLower = norm.toLowerCase();
  // 路径里的 NUL（%00 解码而来）交给 fs 会同步抛错，而这个回调外面没有 catch：一个匿名的 GET /x%00.js 就能让进程
  // 退出（2026-09-25 实测）。按不存在处理。
  if (norm.includes("\0")) { res.writeHead(404).end("Not found"); return; }
  const isVideoPath = normLower === "/videos" || normLower.startsWith("/videos/");
  // Course videos are learning-module content, so a direct link must stop
  // working when learning is switched off — the one module gate that lives
  // outside handleApi (MODULES.md §6.3). M0: which prefixes are gated and by
  // which module comes from the manifests' `static` lists (learning declares
  // "/videos"), decided on the same normalized lower-case shape as isVideoPath.
  const staticModule = REGISTRY.moduleOfStatic(normLower);
  if (staticModule && !modulesOn()[staticModule]) {
    res.writeHead(404).end("Not found");
    return;
  }
  // 模块自带的静态目录（manifest static 的 dir / entry，如 /culture/ → modules/culture/public/；CONTRACT.md 9.1）。
  // 与上面的模块门同一判定形状（normLower）：Windows 上 /CULTURE/app.js、/culture\app.js 也落到这里，
  // 大小写或分隔符敏感的前缀判断会被绕过。模块关闭时上面已回 404。文件查找、穿越防护与登录跳转见 serveModuleStatic。
  const mount = MODULE_HOST.staticMountOf(normLower);
  if (mount) return serveModuleStatic(req, res, mount, norm);
  // …and it must not serve without a session either (S1). 404 rather than 401 on
  // purpose: a static URL is guessable, and an answer that differs from "no such
  // file" would let an anonymous prober enumerate which videos exist — the same
  // reasoning /api/attachments/:id already applies to an id one may not read.
  if (isVideoPath && !videoAccessAllowed(req, norm)) {
    res.writeHead(404).end("Not found");
    return;
  }
  // 第三批 5.6：课程视频直链不许在地址栏 / 新标签打开（video 元素发 Sec-Fetch-Dest: video，照常播放），不缓存
  if (isVideoPath && blockDirectOpen(req)) {
    res.writeHead(404).end("Not found");
    return;
  }
  // The React app (Vite build in public/dist) is the only UI: "/" and every
  // extensionless miss serve its shell. 老前端已移除，回滚请从备份取 — the old
  // vanilla app and its LMS_LEGACY_UI=1 switch are gone, so there is nothing
  // left to fall back to at runtime.
  // /next/* still resolves into the same build because vite's base is '/next/',
  // which is what the shell's own asset URLs use. Every other path is served
  // straight out of public/ — notably /vendor/pdfjs/*, which PdfViewer pulls in
  // with a plain <script src>, so it must never be routed to the SPA shell.
  const isNext = pathname === "/next" || pathname.startsWith("/next/");
  let file;
  if (pathname === "/next" || pathname === "/next/") file = "/dist/index.html";
  else if (isNext) file = "/dist/" + pathname.slice(6); // strip leading "/next/"
  else if (pathname === "/") file = "/dist/index.html";
  else file = pathname;

  let full = path.join(ROOT, "public", path.normalize(file).replace(/^([.][.][/\\])+/, ""));
  if (!full.startsWith(path.join(ROOT, "public"))) {
    res.writeHead(403).end();
    return;
  }
  // CX-071：品牌图片在数据目录（见 brandUploadDir）；那里没有时退回 public/ 下的旧位置
  const brandFile = full.toLowerCase().startsWith(BRAND_UPLOAD_PREFIX);
  if (brandFile) {
    const dir = brandUploadDir();
    const inData = path.join(dir, path.relative(BRAND_UPLOAD_PUBLIC, full));
    if (inData.startsWith(dir + path.sep) && fs.existsSync(inData)) full = inData;
  }
  if (VIDEO_EXT.has(path.extname(full).toLowerCase())) return serveVideo(req, res, full, isVideoPath ? { "cache-control": "private, no-store" } : {});
  fs.readFile(full, (err, data) => {
    if (err) {
      // A missing hashed asset must 404 — never return HTML for a .js/.css
      // request, or the browser tries to execute "<" as script. An extensionless
      // miss is a client route -> serve the active app's shell.
      if (path.extname(pathname)) { res.writeHead(404).end("Not found"); return; }
      const shell = path.join(ROOT, "public", "dist", "index.html");
      fs.readFile(shell, (e2, d2) => {
        if (e2) return res.writeHead(404).end("Not found");
        // The SPA shell must always revalidate so a new build's hashed asset
        // references reach returning visitors immediately.
        // CX-094：页面外壳 no-store —— 不进浏览器前进后退缓存，退出登录后「后退」看不到上一位用户的页面
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" }).end(d2);
      });
      return;
    }
    // Content-hashed build assets are immutable → cache hard; HTML/other files
    // revalidate so updates are never stuck behind a stale cache. (Brand
    // uploads are timestamp-named, so immutable is correct for them too.)
    const immutable = /\/assets\//.test(pathname) && path.extname(full).toLowerCase() !== ".html";
    const headers = {
      "content-type": MIME[path.extname(full)] || "application/octet-stream",
      // CX-094：.html（页面外壳）no-store，见上
      "cache-control": immutable ? "public, max-age=31536000, immutable" : path.extname(full).toLowerCase() === ".html" ? "no-store" : "no-cache",
    };
    // Uploaded brand images: an <img> context never executes SVG script, but a
    // user can be linked STRAIGHT to the file URL — a scriptless CSP closes
    // that direct-navigation hole (belt-and-braces with sanitizeSvg on upload).
    // Compared on the resolved path, lower-cased: Windows paths are
    // case-insensitive, so /ASSETS/… must get the header too.
    if (brandFile)
      headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, headers).end(data);
  });
}
// 模块自带的静态目录（CONTRACT.md 9.1）。mount = { prefix, module, dir(绝对路径), entry }，norm = normalize 之后、
// 反斜杠换成正斜杠的请求路径（保留大小写；挂载判定已在 serveStatic 里按小写做过）。
//   · /culture（无尾斜杠）→ 302 /culture/；/culture/ → 入口文件（entry）。
//   · 只提供 dir 下真实存在的普通文件，且扩展名在 MIME 表里；目录、穿越（解析后的真实路径不在 dir 内，含符号链接）、
//     以 . 开头的路径段、不存在的文件一律纯文本 404，不回退到 TMS 的单页应用外壳。content/、test/、migrations/
//     等模块目录都在 dir 之外，任何路径都到不了。
//   · 入口文件（学员端页面）要求登录：没有有效会话（或账号已停用）→ 302 到 TMS 登录并带 next 回跳；在 Lark 客户端里
//     （UA 含 Lark / Feishu）且配置了 Lark 登录时直接走 /api/auth/lark/start。其余静态资源不含个人数据，不校验会话。
//   · cache-control: no-cache（学员端不带内容哈希，每次重新校验）。
const MODULE_STATIC_ROOTS = new Map();   // mount.dir -> 真实路径（启动后不变，缓存）
function serveModuleStatic(req, res, mount, norm) {
  const notFound = () => { res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" }).end("Not found"); };
  const prefix = mount.prefix;
  // 挂载判定用的是小写形状；这里从保留大小写的 norm 取剩余部分，两者的前缀必须逐字对应（防大小写折叠改变长度的字符）。
  if (norm.length < prefix.length || norm.slice(0, prefix.length).toLowerCase() !== prefix) return notFound();
  const rest = norm.slice(prefix.length);
  if (rest === "") { res.writeHead(302, { location: prefix + "/", "cache-control": "no-store" }).end(); return; }
  const rel = rest.slice(1) || mount.entry;
  // 控制字符（含 %00 解出来的 NUL）一律 404：带 NUL 的路径交给 fs 会同步抛错，在这个没有 catch 的回调里等于让进程退出。
  if (/[\x00-\x1f\x7f]/.test(rel)) return notFound();
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s.startsWith("."))) return notFound();
  const ext = path.extname(rel).toLowerCase();
  if (!MIME[ext]) return notFound();
  let root = MODULE_STATIC_ROOTS.get(mount.dir);
  if (!root) {
    try { root = fs.realpathSync(mount.dir); } catch { return notFound(); }
    MODULE_STATIC_ROOTS.set(mount.dir, root);
  }
  const full = path.resolve(root, ...segments);
  if (!full.startsWith(root + path.sep)) return notFound();
  if (rel.toLowerCase() === String(mount.entry).toLowerCase()) {
    let user = null;
    try { user = getSessionUser(req); } catch { user = null; }
    if (!user || user.active === 0) {
      const next = encodeURIComponent(prefix + "/");
      const inLark = /lark|feishu/i.test(String(req.headers["user-agent"] || ""));
      let lark = false;
      try { lark = inLark && !!larkCfg(); } catch { lark = false; }
      res.writeHead(302, { location: lark ? "/api/auth/lark/start?next=" + next : "/#/login?next=" + next, "cache-control": "no-store" }).end();
      return;
    }
  }
  // CX-166：先查该模块数据目录下的同名文件（HR 上传的替换图，如 3+3 勋章），存在就用它；没有再读代码目录的原文件。
  // 两边都按 realpath 校验必须落在各自根目录内（防目录穿越、防符号链接逃逸）。
  const serveReal = (real) => {
    fs.stat(real, (e2, st) => {
      if (e2 || !st.isFile()) return notFound();
      if (VIDEO_EXT.has(ext)) return serveVideo(req, res, real, { "cache-control": "no-cache" });
      fs.readFile(real, (e3, data) => {
        if (e3) return notFound();
        // CX-094：模块入口页（.html，如 /culture/）同样 no-store
        res.writeHead(200, { "content-type": MIME[ext], "cache-control": ext === ".html" ? "no-store" : "no-cache" }).end(data);
      });
    });
  };
  const fromCode = () => fs.realpath(full, (err, real) => {
    if (err || !real.startsWith(root + path.sep)) return notFound();
    serveReal(real);
  });
  const overDir = mount.module ? path.join(moduleDataDir(mount.module), "public") : null;
  if (!overDir) return fromCode();
  fs.realpath(overDir, (eo, overRoot) => {
    if (eo) return fromCode();   // 数据目录还没建 = 没有替换文件
    const over = path.resolve(overRoot, ...segments);
    if (!over.startsWith(overRoot + path.sep)) return fromCode();
    fs.realpath(over, (e1, real) => {
      if (e1 || !real.startsWith(overRoot + path.sep)) return fromCode();
      fs.stat(real, (e2, st) => (e2 || !st.isFile() ? fromCode() : serveReal(real)));
    });
  });
}

// ---------- API routes ----------
// Raw video upload: the request body IS the file bytes (no multipart parsing).
// Handled before readBody() so we stream to disk instead of buffering JSON.
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
function handleVideoUpload(req, res, user, query) {
  if (!user || !canWrite(user, "learning")) return send(res, 403, { error: "Admin only" });
  const raw = String(query.get("name") || "video.mp4");
  const ext = path.extname(raw).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return send(res, 400, { error: "Only .mp4, .webm, .m4v or .mov files are supported." });
  const base = path.basename(raw, ext).replace(/[^\w一-鿿-]+/g, "_").slice(0, 60) || "video";
  const dir = path.join(ROOT, "public", "videos");
  fs.mkdirSync(dir, { recursive: true });
  let name = base + ext, i = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${i++}${ext}`;
  const dest = path.join(dir, name);
  const out = fs.createWriteStream(dest);
  let size = 0, aborted = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_VIDEO_BYTES && !aborted) {
      aborted = true;
      out.destroy();
      fs.unlink(dest, () => {});
      send(res, 413, { error: "Video too large (max 500 MB)." });
      req.destroy();
    }
  });
  req.pipe(out);
  out.on("finish", () => { if (!aborted) send(res, 200, { ok: true, url: "/videos/" + name, name, size }); });
  out.on("error", () => { if (!aborted) send(res, 500, { error: "Failed to save the video file." }); });
}

// Protected attachment upload (Batch 4): the file lands OUTSIDE public/, in
// data/attachments/, and is only reachable through the authenticated
// GET /api/attachments/:id below. Raw request body = file bytes.
// LMS_ATTACH_DIR lets tests keep their uploads in a throwaway directory.
const ATTACH_DIR = process.env.LMS_ATTACH_DIR
  ? path.resolve(process.env.LMS_ATTACH_DIR)
  : path.join(ROOT, "data", "attachments");
// Office files (ppt/word/excel) are converted to PDF on upload (LibreOffice
// headless) so learners view them online, view-only, exactly like a PDF.
// P0 1.3 / 1.4 (owner, 2026-10-07): an Office original is NEVER offered as a
// download. If the file can't be converted — LibreOffice is not installed, or the
// conversion fails / times out — the upload is refused with a clear message
// instead of silently falling back to "original file + download button".
// LibreOffice is therefore a required component (docs/HANDOVER-IT.md 2.6).
// 转换不了就拒绝上传；LMS_DISABLE_OFFICE_CONVERT=1 视同未安装。
const OFFICE_EXT = new Set([".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx"]);
let SOFFICE_BIN; // undefined = not probed; null = unavailable; string = path
function findSoffice() {
  if (SOFFICE_BIN !== undefined) return SOFFICE_BIN;
  // Windows is the deployment target, so the Program Files entries below are not
  // an extra nicety: without them the probe never matches, every office upload
  // silently degrades to a plain download, and the only way out is an LMS_SOFFICE
  // nobody knows to set. Derived from the env vars instead of a hard-coded drive
  // letter (the system drive is not always C:); the literals are the last resort
  // for a stripped environment where neither variable is present.
  const progDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const winDirs = progDirs.length ? progDirs : ["C:\\Program Files", "C:\\Program Files (x86)"];
  const candidates = [
    process.env.LMS_SOFFICE, // explicit configuration outranks any guess
    ...winDirs.map((d) => path.join(d, "LibreOffice", "program", "soffice.exe")),
    "/usr/bin/soffice", "/usr/bin/libreoffice", "/opt/libreoffice/program/soffice",
    "/opt/homebrew/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ].filter(Boolean);
  SOFFICE_BIN = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  return SOFFICE_BIN;
}
// 转换引擎（modules/learning/office-convert.js，与离线脚本 scripts/convert-office-attachments.js 共用）：
// 独立配置目录、自带超时并按进程树杀、产物校验 %PDF-、上传与批量补转各走各的通道、临时目录在
// <ATTACH_DIR>.convert-tmp（附件目录的兄弟目录）。探测只用上面的 findSoffice —— force 时丢掉缓存重新找，
// 这样 IT 装好 LibreOffice 后不用重启服务（没找到时最多每 60 秒重新探测一次）。
const OFFICE_CONV = require("./modules/learning/office-convert.js").create({
  attachDir: ATTACH_DIR,
  probe: (force) => { if (force) SOFFICE_BIN = undefined; return findSoffice(); },
  disabled: () => process.env.LMS_DISABLE_OFFICE_CONVERT === "1",
  officeExt: OFFICE_EXT,
  store,
  log: (m) => console.warn("[office] " + m),
  // 批量补转以发起人的身份写库，不沿用触发它的那个请求的上下文（审查 M3）
  runInContext: (ctx, fn) => domainEvents.runWithContext(ctx, fn),
  // 第三批 5.7：批量补转的 .pptx 在原文件进待删清单之前，先抽取内嵌视频（VIDEO_TC 在下面定义，调用时已就绪）
  afterConvert: (att, srcPath, pdfPath) => (/\.pptx$/i.test(String(srcPath || "")) ? VIDEO_TC.ingestDeck({ attachment: att, srcPath, pdfPath }) : null),
});
// ---------- PPT 内嵌视频转码（第三批 5.7，modules/learning/video-transcode.js；迁移 72 attachment_media）----------
// 上传 .pptx 转成 PDF 后抽取视频（ingestDeck），后台单通道、低优先级转码为网页可播的 MP4；没装 ffmpeg 时视频留 pending，
// 装好后 60 秒内自动开始（或「重新检测」）。系统身份的审计与失败通知经下面两个钩子写（字面量动作名，见 Audit.jsx）。
function videoMediaAudit(action, target, before, after, by) {
  const row = { actorId: by ? by.id : null, actorName: by ? by.name : null, target, before: before || null, after: after || null, requestId: null };
  if (action === "attachment.media.transcode") store.addAudit({ ...row, action: "attachment.media.transcode" });
  else if (action === "attachment.media.transcode.fail") store.addAudit({ ...row, action: "attachment.media.transcode.fail" });
}
const VIDEO_TC = require("./modules/learning/video-transcode.js").create({
  attachDir: ATTACH_DIR,
  store,
  log: (m) => console.warn("[video] " + m),
  runInContext: (ctx, fn) => domainEvents.runWithContext(ctx, fn),
  hooks: {
    audit: videoMediaAudit,
    // 一份课件一轮任务一条通知，发给上传人（仍在职时）；正文点名课件、页码与视频（前 3 段，其余「等 n 段」）
    notifyFailures: ({ attachment, message }) => {
      const up = attachment && attachment.uploadedBy ? store.getUserById(attachment.uploadedBy) : null;
      if (!up || up.active === 0 || !message) return;
      notify(up.id, { type: "system", title: message.en.title, title_zh: message.zh.title, body: message.en.body, body_zh: message.zh.body, link: "#/admin/content?office=1" });
    },
  },
});
// 直接在地址栏 / 新标签打开受保护的课件与视频 → 404（第三批 5.6 水印的服务端配合）：Sec-Fetch-Dest 为文档类时拒绝；
// 没有这个头（旧 Safari、curl、node 测试）放行。pdf.js 发 empty，video / audio 元素发 video / audio。
const DIRECT_OPEN_DESTS = new Set(["document", "iframe", "frame", "embed", "object"]);
function blockDirectOpen(req) {
  return DIRECT_OPEN_DESTS.has(String(req.headers["sec-fetch-dest"] || "").toLowerCase());
}
// 课件内视频：管理员视图的一行（设计 §4.10）。deck = 课件原文件名；refs = 引用这份附件的课程小节；detail（ffmpeg 输出尾部）只给 learning 写权限
function mediaAdminItem(m, att, refsOf, withDetail) {
  return {
    id: m.id, attachmentId: m.attachmentId, deck: att ? att.originalName : null, refs: refsOf ? refsOf(m.attachmentId) : [],
    seq: m.seq, kind: m.kind, source: m.source, name: m.name, url: m.url || null,
    slides: m.slides || [], srcExt: m.srcExt || null, srcSize: m.srcSize == null ? null : m.srcSize,
    status: m.status, reason: m.reason || null, ...(withDetail && m.detail ? { detail: m.detail } : {}),
    attempts: m.attempts || 0, updatedAt: m.updatedAt,
    retryable: VIDEO_TC.isRetryable(m),   // 只有能重试的行显示「重试」（链接文件、格式不支持等失败行不能重试）
  };
}
const MEDIA_SUM0 = () => ({ total: 0, ready: 0, pending: 0, transcoding: 0, failed: 0, external: 0, skipped: 0 });
function mediaSummary(rows) { const s = MEDIA_SUM0(); for (const r of rows || []) { s.total++; if (s[r.status] !== undefined) s[r.status]++; } return s; }
// 附件 id → 引用它的课程小节（与 office-status 的 pending[].refs 同形：courseId, courseTitle(_zh), courseStatus,
// moduleTitle(_zh), sectionTitle(_zh), sectionNo "模块序号.小节序号"）；空 = 没被任何小节使用
function attachmentRefsIndex() {
  const idx = new Map();
  for (const c of COURSES) (c.modules || []).forEach((m, mi) => (m.sections || []).forEach((s, si) => {
    for (const a of Array.isArray(s.attachments) ? s.attachments : []) {
      if (!a || !a.id) continue;
      if (!idx.has(a.id)) idx.set(a.id, []);
      idx.get(a.id).push({
        courseId: c.id, courseTitle: c.title || "", courseTitle_zh: c.title_zh || "", courseStatus: c.status || null,
        moduleTitle: m.title || "", moduleTitle_zh: m.title_zh || "", sectionTitle: s.title || "", sectionTitle_zh: s.title_zh || "",
        sectionNo: `${mi + 1}.${si + 1}`,
      });
    }
  }));
  return idx;
}
// 学员端：课件 PDF 的 slideMedia（设计 §4.9）。只给视频；跳过的、音频不发；原因与文件名不发。
function learnerSlideMedia(attachmentId, rowsByAtt) {
  const rows = (rowsByAtt ? rowsByAtt.get(attachmentId) : store.listAttachmentMedia({ attachmentId })) || [];
  const out = [];
  for (const m of rows) {
    if (m.kind !== "video" || m.status === "skipped") continue;
    const pages = (m.slides || []).map((s) => s && s.pageNo).filter((n) => Number.isFinite(n));
    if (!pages.length) continue;
    const status = m.status === "ready" ? "ready" : m.status === "external" ? "external" : m.status === "failed" ? "unavailable" : "processing";
    const item = { id: m.id, kind: "video", status, pages };
    if (status === "ready") item.src = "/api/attachments/" + m.attachmentId + "/media/" + m.id;
    if (status === "external" && m.url) item.url = m.url;
    out.push(item);
  }
  return out;
}
const OFFICE_UNAVAILABLE_ERR = {
  error: "PowerPoint, Word and Excel files can't be uploaded right now: the PDF converter (LibreOffice) is not installed on the server. Save the file as PDF and upload the PDF, or ask IT to install LibreOffice. 服务器未安装课件转换组件（LibreOffice），PPT / Word / Excel 暂不能上传。请先另存为 PDF 再上传，或请 IT 安装 LibreOffice。",
  code: "office_converter_unavailable",
};

// 附件取文字（AI 出题「从所选课程内容生成」）：PDF / Word / PPT 交给 modules/ai/extract-text.js 子进程解析
// （吃 CPU 的解析不放主进程；60 秒超时直接杀掉）。结果缓存在附件旁边的 <storageKey>.txt —— 附件内容不会变
// （换文件 = 新附件 id），同一份附件只解析一次。读不出文字（扫描件、视频等）得到空串。
const ATTACH_TEXT_EXT = new Set([".pdf", ".docx", ".pptx"]);
function attachmentText(att, maxChars) {
  return new Promise((resolve) => {
    if (!att || !att.storageKey) return resolve("");
    const src = path.join(ATTACH_DIR, att.storageKey);
    if (!ATTACH_TEXT_EXT.has(path.extname(src).toLowerCase()) || !fs.existsSync(src)) return resolve("");
    const cache = src + ".txt";
    try { if (fs.existsSync(cache)) return resolve(fs.readFileSync(cache, "utf8").slice(0, maxChars)); } catch { /* 重新解析 */ }
    execFile(process.execPath, [path.join(ROOT, "modules", "ai", "extract-text.js"), src, "120000"],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
        if (err) { console.warn("[ai] attachment text failed: " + att.id + " " + ((err && err.code) || (err && err.message) || err)); return resolve(""); }
        const text = String(stdout || "");
        try { fs.writeFileSync(cache, text); } catch { /* 缓存写不了不影响本次 */ }
        resolve(text.slice(0, maxChars));
      });
  });
}

function handleAttachmentUpload(req, res, user, query, audit) {
  if (!user || !canWrite(user, "learning")) return send(res, 403, { error: "Admin only" });
  const rawName = String(query.get("name") || "file");
  const courseId = String(query.get("courseId") || "");
  if (!getCourse(courseId)) return send(res, 400, { error: "Unknown course for this attachment." });
  const ext = path.extname(rawName).toLowerCase();
  const kind = kindOfExt(ext);
  if (!kind) return send(res, 400, { error: "Unsupported file type. Allowed: video, audio, PDF, PPT, Word, Excel." });
  const originalName = path.basename(rawName).slice(0, 120);
  const id = "att-" + newToken().slice(0, 12);
  const isOffice = OFFICE_EXT.has(ext);
  // P0 1.3：转换器不可用 → 上传前就拒绝，不写盘。请求体读完丢弃（resume），浏览器才能正常拿到响应。
  // 不写审计；控制台日志与 lastConversion 只记真正发生过的转换（设计 §6-7）。
  if (isOffice && !OFFICE_CONV.available()) {
    req.resume();
    return send(res, 422, OFFICE_UNAVAILABLE_ERR);
  }
  // Office 原文件与 .pdf 写进转换工作目录（<ATTACH_DIR>.convert-tmp/w-…），不进附件目录：转换失败、不是有效 PDF 时
  // 附件目录里什么也不留，校验通过才挪进去（审查：服务运行中不在附件目录里删文件 —— 03:00 的备份正在复制这个目录时，
  // 列出后又消失的文件会让 cpSync 报错、当晚整份附件备份被丢掉）。
  const staged = isOffice || ext === ".pdf";
  let workDir = null;
  try {
    if (staged) workDir = OFFICE_CONV.makeWorkDir();
    else fs.mkdirSync(ATTACH_DIR, { recursive: true });
  } catch (e) {
    req.resume();
    return send(res, 500, { error: "Failed to save the file. 文件保存失败。" });
  }
  const dest = path.join(workDir || ATTACH_DIR, id + ext);
  // 413 / 写盘出错 / 客户端中途断开都清掉写了一半的文件与工作目录（审查 M5）
  const discard = () => { if (workDir) OFFICE_CONV.rmWorkDir(workDir); else fs.unlink(dest, () => {}); };
  const out = fs.createWriteStream(dest);
  let size = 0, aborted = false, clientGone = false;
  // 客户端断开（代理超时、关页面）→ 中止排队中 / 进行中的转换，不让走掉的请求占着上传通道（审查）
  const gone = new AbortController();
  res.on("close", () => { if (!res.writableFinished) { clientGone = true; gone.abort(); } });
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_VIDEO_BYTES && !aborted) {
      aborted = true;
      out.destroy();
      discard();
      send(res, 413, { error: "File too large (max 500 MB)." });
      req.destroy();
    }
  });
  req.on("close", () => {
    if (req.complete || aborted) return;
    aborted = true;
    clientGone = true;
    gone.abort();
    out.destroy();
    discard();
  });
  req.pipe(out);
  out.on("finish", async () => {
    if (aborted) return;
    if (!isOffice) {
      if (ext !== ".pdf") {
        store.createAttachment({ id, courseId, kind, storageKey: id + ext, originalName, mime: MIME[ext] || "application/octet-stream", size, uploadedBy: user.id });
        return send(res, 200, { ok: true, id, url: "/api/attachments/" + id, kind, originalName, size });
      }
      try {
        // 审查 M6：改了扩展名的 .docx 等不能冒充 PDF 按 inline 返回（学员只会看到加载失败的阅读器）。
        // 与 pdf.js / Acrobat 同一口径：%PDF- 在前 1024 字节里即可（前面多个 BOM / 换行的 PDF 照收）
        if (!OFFICE_CONV.hasPdfMagic(dest, { within: 1024 }))
          return send(res, 422, { error: "This file isn't a valid PDF (it may be another file type renamed to .pdf). Open it and save it as PDF, then upload it again. 该文件不是有效的 PDF（可能是其他格式改了扩展名），请打开后另存为 PDF 再上传。", code: "pdf_invalid" });
        const placed = await OFFICE_CONV.storePdf(dest, id + ext);
        store.createAttachment({ id, courseId, kind, storageKey: id + ext, originalName, mime: MIME[ext] || "application/octet-stream", size: placed.size, uploadedBy: user.id });
        return send(res, 200, { ok: true, id, url: "/api/attachments/" + id, kind, originalName, size: placed.size });
      } catch (e) {
        return send(res, 500, { error: "Failed to save the file. 文件保存失败。" });
      } finally {
        OFFICE_CONV.rmWorkDir(workDir);
      }
    }
    try {
      // 上传有自己的转换通道，不排在批量补转后面（审查 M2）；产物挪进附件目录（rename 带重试，审查 M1）。
      // 客户端断开 → gone 中止：排队中不启动、转换中杀进程、放进附件目录之前也会再看一次（reason cancelled）
      const r = await OFFICE_CONV.convertUpload(dest, { workDir, storageKey: id + ".pdf", signal: gone.signal });
      // PDF 放好之后客户端才断开（极短的窗口）：照常建记录，不在附件目录里删文件；多出的一条附件不被任何小节引用，无害
      store.createAttachment({ id, courseId, kind: "pdf", storageKey: r.storageKey, originalName, mime: "application/pdf", size: r.size, uploadedBy: user.id });
      // 第三批 5.7：.pptx 抽取内嵌视频（工作目录里的原文件此时还在，finally 才删）；出错不影响上传（PDF 已经好了）。旧版 .ppt 不解析。
      let media = null;
      if (ext === ".pptx") {
        try {
          const mr = await VIDEO_TC.ingestDeck({ attachment: store.getAttachment(id), srcPath: dest, pdfPath: path.join(ATTACH_DIR, r.storageKey) });
          const refs = attachmentRefsIndex();
          media = { ...mediaSummary(mr.items), transcoder: mr.transcoder, mapping: mr.mapping || null, ...(mr.error ? { error: mr.error } : {}),
            items: (mr.items || []).map((m) => mediaAdminItem(m, { originalName }, (aid) => refs.get(aid) || [], true)) };
        } catch (e) {
          console.warn("[video] ingest failed for " + id + ": " + ((e && e.message) || e));
          media = { ...MEDIA_SUM0(), transcoder: VIDEO_TC.state(), mapping: null, error: "pptx_unreadable", items: [] };
        }
        if (audit) audit("attachment.media.extract", id, null, { total: media.total, pending: media.pending, external: media.external, skipped: media.skipped, failed: media.failed, mapping: media.mapping, ...(media.error ? { error: media.error } : {}) });
      } else if (ext === ".ppt") media = { ...MEDIA_SUM0(), transcoder: VIDEO_TC.state(), mapping: null, error: "ppt_binary", items: [] };
      if (clientGone) return;
      send(res, 200, { ok: true, id, url: "/api/attachments/" + id, kind: "pdf", originalName, size: r.size, converted: true, ...(media ? { media } : {}) });
    } catch (e) {
      const reason = (e && e.reason) || "error";
      // 客户端已经断开（代理超时等）：没人收得到回应，也没建记录 —— 否则用户重传会产生重复附件（审查 M2）
      if (reason === "cancelled" || clientGone) return;
      // 探测时还在、转换前没了（卸载 / 启动失败）：与「未安装」同一提示
      if (reason === "unavailable") return send(res, 422, OFFICE_UNAVAILABLE_ERR);
      send(res, 422, {
        error: "This file couldn't be converted to a view-only PDF, so it wasn't uploaded (PowerPoint, Word and Excel files are never offered as downloads). Check that the file opens normally, or save it as PDF and upload the PDF. 该文件无法转换为在线只读的 PDF，未上传（PPT / Word / Excel 不提供下载）。请确认文件能正常打开，或先另存为 PDF 再上传。",
        code: "office_convert_failed", reason,
      });
    } finally {
      OFFICE_CONV.rmWorkDir(workDir);
    }
  });
  out.on("error", () => {
    if (aborted) return;
    aborted = true;
    discard();
    send(res, 500, { error: "Failed to save the file. 文件保存失败。" });
  });
}

// Brand image upload (logo / logoLight / favicon). Raw request body = image
// bytes, same no-multipart contract as the two handlers above, but buffered in
// memory — the cap is 512 KB, these are logos, not media. The filename is
// SERVER-generated (slot + timestamp + sniffed extension): the client's
// filename never touches the path, so it cannot traverse or smuggle an
// executable extension. Old files stay behind on re-upload — the admin may
// want to switch back, and a few KB of images is not worth delete logic.
function handleBrandAssetUpload(req, res, user, query) {
  if (!user || !canWrite(user, "brand")) return send(res, 403, { error: "Admin only" });
  const slot = String(query.get("slot") || "");
  if (!BRAND_SLOTS.has(slot)) return send(res, 400, { error: "slot must be logo, logoLight or favicon" });
  const chunks = [];
  let size = 0, aborted = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > BRAND_UPLOAD_MAX && !aborted) {
      aborted = true;
      send(res, 413, { error: "Image too large (max 512 KB)." });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (!buf.length) return send(res, 400, { error: "Empty upload." });
    const kind = sniffImage(buf);
    if (!kind) return send(res, 400, { error: "Unsupported image. Allowed: PNG, JPG or SVG (checked by content, not by filename).", error_zh: "不支持的图片格式。仅支持 PNG、JPG 或 SVG（按文件内容判断，不看文件名）。", code: "bad_image" });   // CX-131
    const data = kind === "svg" ? Buffer.from(sanitizeSvg(buf.toString("utf8")), "utf8") : buf;
    const name = `${slot}-${Date.now()}.${kind}`;
    try {
      fs.mkdirSync(brandUploadDir(), { recursive: true });
      fs.writeFileSync(path.join(brandUploadDir(), name), data);
    } catch {
      return send(res, 500, { error: "Failed to save the image." });
    }
    // The url is directly configurable as brand.logo / logoLight / favicon.
    return send(res, 200, { ok: true, slot, url: "/assets/brand/uploads/" + name, size: data.length });
  });
  req.on("error", () => { if (!aborted) { aborted = true; send(res, 500, { error: "Upload failed." }); } });
}

// 模块路由分发的接线（逻辑在 kernel/module-host.js dispatch）：urlPath 为已解码一次的路径（捕获组不再二次解码），
// user 为已通过 401 / 改密闸门的完整用户行。返回 true = 已应答（gate 内的请求一律在这里应答，含固定正文的 404）；
// false = 不在任何带 handler 路由的模块的 gate 内，交回 handleApi 原有分支。异常在宿主内部按 CONTRACT.md 3.4
// 应答（不会落到外层 catch 把 e.message 原文回给客户端）。参数刻意不叫 pathname（M0 路由守卫的扫描约定）。
function dispatchModuleRoute(req, res, urlPath, query, body, user, requestId) {
  const out = MODULE_HOST.dispatch({ method: req.method, path: urlPath, query, headers: req.headers, body, user, requestId });
  if (!out) return false;
  res.writeHead(out.status, out.headers);
  res.end(out.body);
  return true;
}

// 简化 10/11：接口处理按模块拆到 modules/<模块>/routes.js（原样搬出，见各文件开头说明）。SRV 把本文件的模块级函数与常量
// 交给路由文件（getter，取调用当时的值）；ROUTE_NEXT 表示「这一段没有匹配到」，handleApi 接着往下匹配。
const ROUTE_NEXT = Symbol("route-next");
const SRV = {
  get parseCookies() { return parseCookies; },   // CX-093：自助改密保留当前会话
  get AI() { return AI; },
  get AI_SHARE_NONE() { return AI_SHARE_NONE; },
  get AI_SHARE_RANK() { return AI_SHARE_RANK; },
  get AI_SHARE_VALUES() { return AI_SHARE_VALUES; },
  get AI_TF() { return AI_TF; },
  get APPEAL_ACCESS_CACHE() { return APPEAL_ACCESS_CACHE; },
  get APPEAL_ADJUST_NOTE_MAX() { return APPEAL_ADJUST_NOTE_MAX; },
  get APPEAL_ADJUST_NOTE_MIN() { return APPEAL_ADJUST_NOTE_MIN; },
  get APPEAL_CATEGORIES() { return APPEAL_CATEGORIES; },
  get APPEAL_CATEGORY_KEYS() { return APPEAL_CATEGORY_KEYS; },
  get APPEAL_CONSULTS_MAX() { return APPEAL_CONSULTS_MAX; },
  get APPEAL_CONSULT_RECENT_DAYS() { return APPEAL_CONSULT_RECENT_DAYS; },
  get APPEAL_FILES_MAX() { return APPEAL_FILES_MAX; },
  get APPEAL_HRBPS_MAX() { return APPEAL_HRBPS_MAX; },
  get APPEAL_LIMITS() { return APPEAL_LIMITS; },
  get APPEAL_NOTE_MAX() { return APPEAL_NOTE_MAX; },
  get APPEAL_OPINION_MAX() { return APPEAL_OPINION_MAX; },
  get APPEAL_OPINION_MIN() { return APPEAL_OPINION_MIN; },
  get APPEAL_QUESTION_MAX() { return APPEAL_QUESTION_MAX; },
  get APPEAL_REASON_MAX() { return APPEAL_REASON_MAX; },
  get APPEAL_REASON_MIN() { return APPEAL_REASON_MIN; },
  get APPEAL_REASSIGN_NOTE_MAX() { return APPEAL_REASSIGN_NOTE_MAX; },
  get APPEAL_REPLY_MAX() { return APPEAL_REPLY_MAX; },
  get APPEAL_REPLY_MIN() { return APPEAL_REPLY_MIN; },
  get APPEAL_SLA_WORKDAYS() { return APPEAL_SLA_WORKDAYS; },
  get APPEAL_WINDOW_WORKDAYS() { return APPEAL_WINDOW_WORKDAYS; },
  get ATTACH_DIR() { return ATTACH_DIR; },
  get BOOTED_AT() { return BOOTED_AT; },
  get CACHE_REFRESHED_AT() { return CACHE_REFRESHED_AT; },
  get CAT() { return CAT; },
  get COMPLETION() { return COMPLETION; },
  get COURSES() { return COURSES; },
  get CPKG() { return CPKG; },
  get CT() { return CT; },
  get DEPT_TREE_READ_DOMAINS() { return DEPT_TREE_READ_DOMAINS; },
  get EMAIL_RE() { return EMAIL_RE; },
  get EMPLOYEE_ID_HINT() { return EMPLOYEE_ID_HINT; },
  get EMPLOYEE_ID_RE() { return EMPLOYEE_ID_RE; },
  get FE() { return FE; },
  get FM() { return FM; },
  get INSTANCE_ID() { return INSTANCE_ID; },
  get KP() { return KP; },
  get LC() { return LC; },
  get MODULE_HOST() { return MODULE_HOST; },
  get OFFICE_CONV() { return OFFICE_CONV; },
  get OP() { return OP; },
  get PROGRAMS() { return PROGRAMS; },
  get PROMO_DEFAULTS() { return PROMO_DEFAULTS; },
  get PUBC() { return PUBC; },
  get QT() { return QT; },
  get RECORDS_EXPORT_FORBIDDEN() { return RECORDS_EXPORT_FORBIDDEN; },
  get RECORD_TYPE_UNAVAILABLE() { return RECORD_TYPE_UNAVAILABLE; },
  get REVIEW_DEFAULT_QUOTA() { return REVIEW_DEFAULT_QUOTA; },
  get REVIEW_HIGHLIGHT_RATINGS() { return REVIEW_HIGHLIGHT_RATINGS; },
  get REVIEW_QUOTA_MIN_HC() { return REVIEW_QUOTA_MIN_HC; },
  get REVIEW_REMIND_BY() { return REVIEW_REMIND_BY; },
  get REVIEW_REMIND_STAGES() { return REVIEW_REMIND_STAGES; },
  get REVIEW_SNAP_LOCKED_ERR() { return REVIEW_SNAP_LOCKED_ERR; },
  get ROOT() { return ROOT; },
  get SUCC_IMPORT() { return SUCC_IMPORT; },
  get SUCC_READINESS() { return SUCC_READINESS; },
  get TEST_FAIL_APPEAL_DECIDE() { return TEST_FAIL_APPEAL_DECIDE; },
  get TF_BUILTIN_PROMO() { return TF_BUILTIN_PROMO; },
  get TPROJECTS() { return TPROJECTS; },
  get TP_ONLINE_DONE() { return TP_ONLINE_DONE; },
  get TS() { return TS; },
  get VIDEO_EXT() { return VIDEO_EXT; },
  get VIDEO_TC() { return VIDEO_TC; },
  get VURL() { return VURL; },
  get afterCommit() { return afterCommit; },
  get aiDataflow() { return aiDataflow; },
  get aiFeatures() { return aiFeatures; },
  get aiManagersOf() { return aiManagersOf; },
  get aiRoster() { return aiRoster; },
  get appealAdminLink() { return appealAdminLink; },
  get appealCacheClear() { return appealCacheClear; },
  get appealClosedStatus() { return appealClosedStatus; },
  get appealCounts() { return appealCounts; },
  get appealEmpLink() { return appealEmpLink; },
  get appealErr() { return appealErr; },
  get appealJoin() { return appealJoin; },
  get appealLogView() { return appealLogView; },
  get appealNotify() { return appealNotify; },
  get appealOpen() { return appealOpen; },
  get appealPerfVisible() { return appealPerfVisible; },
  get appealRecRating() { return appealRecRating; },
  get appealRouteDept() { return appealRouteDept; },
  get appealSaveFailed() { return appealSaveFailed; },
  get appealStale() { return appealStale; },
  get appealSubmitConflicts() { return appealSubmitConflicts; },
  get appealTagged() { return appealTagged; },
  get appealToday() { return appealToday; },
  get appealVisibleRows() { return appealVisibleRows; },
  get applyEnrollDecision() { return applyEnrollDecision; },
  get applyMemberMove() { return applyMemberMove; },
  get applyMemberWithdraw() { return applyMemberWithdraw; },
  get applyNominationDecision() { return applyNominationDecision; },
  get applyRecordSideEffects() { return applyRecordSideEffects; },
  get applyRosterClear() { return applyRosterClear; },
  get applyRosterMark() { return applyRosterMark; },
  get assignPrograms() { return assignPrograms; },
  get attachmentRefsIndex() { return attachmentRefsIndex; },
  get attachmentText() { return attachmentText; },
  get attemptDeadline() { return attemptDeadline; },
  get auditCriteria() { return auditCriteria; },
  get bestAttempt() { return bestAttempt; },
  get blockDirectOpen() { return blockDirectOpen; },
  get brandCfg() { return brandCfg; },
  get buildOverviewV2() { return buildOverviewV2; },
  get buildRecordDetail() { return buildRecordDetail; },
  get buildTalentTimeline() { return buildTalentTimeline; },
  get bulkCap() { return bulkCap; },
  get bulkEnrollRequest() { return bulkEnrollRequest; },
  get bulkExamPools() { return bulkExamPools; },
  get bulkFaultPoint() { return bulkFaultPoint; },
  get bulkIdList() { return bulkIdList; },
  get bulkNominationSubject() { return bulkNominationSubject; },
  get bulkOutOfScope() { return bulkOutOfScope; },
  get bulkPoolWarnings() { return bulkPoolWarnings; },
  get bulkSkip() { return bulkSkip; },
  get bulkUnchanged() { return bulkUnchanged; },
  get bulkUserSubject() { return bulkUserSubject; },
  get canExportTalentRecords() { return canExportTalentRecords; },
  get canRead() { return canRead; },
  get canWrite() { return canWrite; },
  get canonOption() { return canonOption; },
  get canonicalDept() { return canonicalDept; },
  get caseSubPointsFor() { return caseSubPointsFor; },
  get catalogItemOf() { return catalogItemOf; },
  get catalogListed() { return catalogListed; },
  get checkPassword() { return checkPassword; },
  get checkinCode() { return checkinCode; },
  get checkinNotToday() { return checkinNotToday; },
  get checkinSlot() { return checkinSlot; },
  get clampText() { return clampText; },
  get classSummary() { return classSummary; },
  get clientDetail() { return clientDetail; },
  get clientQuestions() { return clientQuestions; },
  get courseAttendance() { return courseAttendance; },
  get courseCkId() { return courseCkId; },
  get courseProjectsIndex() { return courseProjectsIndex; },
  get courseUsage() { return courseUsage; },
  get courseWrapperOf() { return courseWrapperOf; },
  get coursesInProgram() { return coursesInProgram; },
  get crypto() { return crypto; },
  get csvText() { return csvText; },
  get dateLocalOffset() { return dateLocalOffset; },
  get decorateSecondaryLines() { return decorateSecondaryLines; },
  get deptAuditShape() { return deptAuditShape; },
  get deptFilterFor() { return deptFilterFor; },
  get deriveRecordTitle() { return deriveRecordTitle; },
  get directReports() { return directReports; },
  get dispatchModuleRoute() { return dispatchModuleRoute; },
  get emitBulkEffects() { return emitBulkEffects; },
  get emitEnrollDecision() { return emitEnrollDecision; },
  get emitExamReset() { return emitExamReset; },
  get emitMemberOp() { return emitMemberOp; },
  get emitNominationDecision() { return emitNominationDecision; },
  get emitReviewReminder() { return emitReviewReminder; },
  get emitRosterOp() { return emitRosterOp; },
  get employeeAppealOut() { return employeeAppealOut; },
  get employeeSeesManagerComment() { return employeeSeesManagerComment; },
  get enqueueGrading() { return enqueueGrading; },
  get examInProgressForCourse() { return examInProgressForCourse; },
  get examQuestions() { return examQuestions; },
  get examRetakeState() { return examRetakeState; },
  get examRulesOf() { return examRulesOf; },
  get examSummary() { return examSummary; },
  get examUnlockedFor() { return examUnlockedFor; },
  get examUsable() { return examUsable; },
  get exitDateOf() { return exitDateOf; },
  get fieldOut() { return fieldOut; },
  get findUserByEmail() { return findUserByEmail; },
  get fixedExamQuestions() { return fixedExamQuestions; },
  get fs() { return fs; },
  get getCourse() { return getCourse; },
  get getProgram() { return getProgram; },
  get getTProject() { return getTProject; },
  get gradeOptionsFor() { return gradeOptionsFor; },
  get hashPassword() { return hashPassword; },
  get hashPasswordsAsync() { return hashPasswordsAsync; },
  get hodCsvRows() { return hodCsvRows; },
  get hodGroupsFor() { return hodGroupsFor; },
  get hodListFor() { return hodListFor; },
  get hrbpCoveragePayload() { return hrbpCoveragePayload; },
  get hrbpEligible() { return hrbpEligible; },
  get isAdmin() { return isAdmin; },
  get isInReportingLine() { return isInReportingLine; },
  get isSuperAdmin() { return isSuperAdmin; },
  get jobGrades() { return jobGrades; },
  get keyPositionVacancies() { return keyPositionVacancies; },
  get kpDeptById() { return kpDeptById; },
  get kpDeptNameOf() { return kpDeptNameOf; },
  get kpErr() { return kpErr; },
  get kpResolveDept() { return kpResolveDept; },
  get kpRowAllows() { return kpRowAllows; },
  get kpSuccessorOk() { return kpSuccessorOk; },
  get kpVisible() { return kpVisible; },
  get larkSyncCfg() { return larkSyncCfg; },
  get larkSyncRunning() { return larkSyncRunning; },
  get larksync() { return larksync; },
  get learnerExamState() { return learnerExamState; },
  get learnerSlideMedia() { return learnerSlideMedia; },
  get makePassword() { return makePassword; },
  get managerCycle() { return managerCycle; },
  get manilaDay() { return manilaDay; },
  get markOpenUnavailable() { return markOpenUnavailable; },
  get mediaAdminItem() { return mediaAdminItem; },
  get mediaSummary() { return mediaSummary; },
  get mirrorCourseWrapper() { return mirrorCourseWrapper; },
  get modulesConfigOut() { return modulesConfigOut; },
  get modulesOn() { return modulesOn; },
  get myClasses() { return myClasses; },
  get mySessions() { return mySessions; },
  get newPasswordProblem() { return newPasswordProblem; },
  get newToken() { return newToken; },
  get nineBoxRows() { return nineBoxRows; },
  get normalizeEmail() { return normalizeEmail; },
  get notify() { return notify; },
  get notifyAdmins() { return notifyAdmins; },
  get nowMs() { return nowMs; },
  get nudgedAt() { return nudgedAt; },
  get offlineAttended() { return offlineAttended; },
  get optionZh() { return optionZh; },
  get optionsZhOf() { return optionsZhOf; },
  get orgDept1List() { return orgDept1List; },
  get orgLib() { return orgLib; },
  get orgRatingOptions() { return orgRatingOptions; },
  get orgRoundView() { return orgRoundView; },
  get orgSnapshot() { return orgSnapshot; },
  get ovRemindable() { return ovRemindable; },
  get overviewPeople() { return overviewPeople; },
  get parseExtras() { return parseExtras; },
  get parseGradeSelect() { return parseGradeSelect; },
  get parseOptionsZh() { return parseOptionsZh; },
  get parseTags() { return parseTags; },
  get path() { return path; },
  get pendingCountsFor() { return pendingCountsFor; },
  get perfAmendDecorate() { return perfAmendDecorate; },
  get perfApplyRatingAmend() { return perfApplyRatingAmend; },
  get perfRatingAmendAudit() { return perfRatingAmendAudit; },
  get planReviewReminders() { return planReviewReminders; },
  get portraitArgs() { return portraitArgs; },
  get portraitFlat() { return portraitFlat; },
  get portraitOut() { return portraitOut; },
  get portraitTypeLabels() { return portraitTypeLabels; },
  get profileTabsFor() { return profileTabsFor; },
  get programCourseId() { return programCourseId; },
  get programDone() { return programDone; },
  get programHasExam() { return programHasExam; },
  get programHours() { return programHours; },
  get programMetaOf() { return programMetaOf; },
  get programProgress() { return programProgress; },
  get programsContaining() { return programsContaining; },
  get progressPercent() { return progressPercent; },
  get promotionConfig() { return promotionConfig; },
  get promotionFilter() { return promotionFilter; },
  get publicCloseApply() { return publicCloseApply; },
  get publicOpenApply() { return publicOpenApply; },
  get publicOpenNotify() { return publicOpenNotify; },
  get publishedProgramExams() { return publishedProgramExams; },
  get questionItemFromBody() { return questionItemFromBody; },
  get questionPoints() { return questionPoints; },
  get rbacGate() { return rbacGate; },
  get readConfig() { return readConfig; },
  get recordSyncSignature() { return recordSyncSignature; },
  get recordSyncsDepartment() { return recordSyncsDepartment; },
  get recordTypeModuleOff() { return recordTypeModuleOff; },
  get recordTypesOut() { return recordTypesOut; },
  get refreshContent() { return refreshContent; },
  get reportingChain() { return reportingChain; },
  get reportingLineEntry() { return reportingLineEntry; },
  get reportingSubtree() { return reportingSubtree; },
  get resolveGradeSelect() { return resolveGradeSelect; },
  get resolveGrants() { return resolveGrants; },
  get resolveRecordType() { return resolveRecordType; },
  get revalidateBulkActor() { return revalidateBulkActor; },
  get reviewAppealAccess() { return reviewAppealAccess; },
  get reviewAppealConsoleOk() { return reviewAppealConsoleOk; },
  get reviewAppealCtx() { return reviewAppealCtx; },
  get reviewAppealDetail() { return reviewAppealDetail; },
  get reviewAppealEligibility() { return reviewAppealEligibility; },
  get reviewBucket() { return reviewBucket; },
  get reviewCalibView() { return reviewCalibView; },
  get reviewConfirmIssues() { return reviewConfirmIssues; },
  get reviewCycleResultsOf() { return reviewCycleResultsOf; },
  get reviewCycleStartDay() { return reviewCycleStartDay; },
  get reviewDeptInactive() { return reviewDeptInactive; },
  get reviewDeptLocked() { return reviewDeptLocked; },
  get reviewDeptOptions() { return reviewDeptOptions; },
  get reviewDeptPath() { return reviewDeptPath; },
  get reviewDeptPredMemo() { return reviewDeptPredMemo; },
  get reviewDeptRow() { return reviewDeptRow; },
  get reviewGradeIndex() { return reviewGradeIndex; },
  get reviewGroups() { return reviewGroups; },
  get reviewHodChange() { return reviewHodChange; },
  get reviewHodCtx() { return reviewHodCtx; },
  get reviewHodIdSet() { return reviewHodIdSet; },
  get reviewHodOwned() { return reviewHodOwned; },
  get reviewHodProxyOf() { return reviewHodProxyOf; },
  get reviewHodUnresolved() { return reviewHodUnresolved; },
  get reviewHodWrite() { return reviewHodWrite; },
  get reviewHolidaySet() { return reviewHolidaySet; },
  get reviewHrCalibAccess() { return reviewHrCalibAccess; },
  get reviewItemLocked() { return reviewItemLocked; },
  get reviewManagerStatus() { return reviewManagerStatus; },
  get reviewNotifyProxied() { return reviewNotifyProxied; },
  get reviewOneState() { return reviewOneState; },
  get reviewOverdue() { return reviewOverdue; },
  get reviewOverdueOf() { return reviewOverdueOf; },
  get reviewPersonGone() { return reviewPersonGone; },
  get reviewQuotaOf() { return reviewQuotaOf; },
  get reviewRecipientOk() { return reviewRecipientOk; },
  get reviewRecordRatingOf() { return reviewRecordRatingOf; },
  get reviewResultsNotify() { return reviewResultsNotify; },
  get reviewSelfActor() { return reviewSelfActor; },
  get reviewSelfLocked() { return reviewSelfLocked; },
  get reviewSelfOf() { return reviewSelfOf; },
  get reviewSelfOverdue() { return reviewSelfOverdue; },
  get reviewSelfReminderMsg() { return reviewSelfReminderMsg; },
  get reviewSnapDiff() { return reviewSnapDiff; },
  get reviewSnapGet() { return reviewSnapGet; },
  get reviewSnapLocks() { return reviewSnapLocks; },
  get reviewSnapPut() { return reviewSnapPut; },
  get reviewSubmitIssues() { return reviewSubmitIssues; },
  get reviewTeamPayload() { return reviewTeamPayload; },
  get reviewUnresolvedErr() { return reviewUnresolvedErr; },
  get reviewUserMemo() { return reviewUserMemo; },
  get runBatch() { return runBatch; },
  get runLarkSync() { return runLarkSync; },
  get sanitizeBrandInput() { return sanitizeBrandInput; },
  get sanitizeGrants() { return sanitizeGrants; },
  get sanitizeHtml() { return sanitizeHtml; },
  get scopeAllowsDeptFor() { return scopeAllowsDeptFor; },
  get scopeAllowsFor() { return scopeAllowsFor; },
  get scopeDeptPredicate() { return scopeDeptPredicate; },
  get scopePredicate() { return scopePredicate; },
  get scoreDetail() { return scoreDetail; },
  get scoreTotals() { return scoreTotals; },
  get selfRowsOf() { return selfRowsOf; },
  get send() { return send; },
  get sendAiCalls() { return sendAiCalls; },
  get sendAiError() { return sendAiError; },
  get sendAiRateLimited() { return sendAiRateLimited; },
  get sendAiState() { return sendAiState; },
  get sendBatchFailed() { return sendBatchFailed; },
  get sendBulkResult() { return sendBulkResult; },
  get sendBulkScopeReject() { return sendBulkScopeReject; },
  get sendCsv() { return sendCsv; },
  get sendDeptCycle() { return sendDeptCycle; },
  get sendDeptOccupied() { return sendDeptOccupied; },
  get sendRecordSaveFailed() { return sendRecordSaveFailed; },
  get sendReviewHodErr() { return sendReviewHodErr; },
  get sendScopeBulkReject() { return sendScopeBulkReject; },
  get sendScopeDeptReject() { return sendScopeDeptReject; },
  get serveVideo() { return serveVideo; },
  get sessionSummary() { return sessionSummary; },
  get settleAttempt() { return settleAttempt; },
  get shuffle() { return shuffle; },
  get store() { return store; },
  get succLookups() { return succLookups; },
  get tagsForLine() { return tagsForLine; },
  get tagsForViewer() { return tagsForViewer; },
  get tfCatalogOut() { return tfCatalogOut; },
  get tfContext() { return tfContext; },
  get tfExecute() { return tfExecute; },
  get tfFilterOut() { return tfFilterOut; },
  get tfIdList() { return tfIdList; },
  get tfInvalid() { return tfInvalid; },
  get tfPromotionEligible() { return tfPromotionEligible; },
  get tfPromotionRun() { return tfPromotionRun; },
  get tfRedact() { return tfRedact; },
  get tfRowOut() { return tfRowOut; },
  get tfScopeCheck() { return tfScopeCheck; },
  get tfSortOf() { return tfSortOf; },
  get tfVisible() { return tfVisible; },
  get todayLocal() { return todayLocal; },
  get tpActivities() { return tpActivities; },
  get tpActivityDoneOnly() { return tpActivityDoneOnly; },
  get tpActivityView() { return tpActivityView; },
  get tpAssignPrograms() { return tpAssignPrograms; },
  get tpCheckActivities() { return tpCheckActivities; },
  get tpCheckinOpen() { return tpCheckinOpen; },
  get tpCheckinTarget() { return tpCheckinTarget; },
  get tpCohort() { return tpCohort; },
  get tpCohortEnded() { return tpCohortEnded; },
  get tpCohortSummary() { return tpCohortSummary; },
  get tpCompletionOpen() { return tpCompletionOpen; },
  get tpNextCode() { return tpNextCode; },
  get tpPhaseView() { return tpPhaseView; },
  get tpProgramIds() { return tpProgramIds; },
  get tpProgressPercent() { return tpProgressPercent; },
  get tpRosterTarget() { return tpRosterTarget; },
  get tpSetCompletion() { return tpSetCompletion; },
  get tpSyncCourseAssignments() { return tpSyncCourseAssignments; },
  get tpUserStates() { return tpUserStates; },
  get trScopeOfBody() { return trScopeOfBody; },
  get trScopeOfQuery() { return trScopeOfQuery; },
  get trScopeSplit() { return trScopeSplit; },
  get trainerActivityScope() { return trainerActivityScope; },
  get trainerSessionScope() { return trainerSessionScope; },
  get trainingOverviewBase() { return trainingOverviewBase; },
  get trainingSearch() { return trainingSearch; },
  get userProgress() { return userProgress; },
  get validDateStr() { return validDateStr; },
  get wbContext() { return wbContext; },
  get wbPeople() { return wbPeople; },
  get wbRisk() { return wbRisk; },
  get wbStructure() { return wbStructure; },
  get wbTodo() { return wbTodo; },
  get workdayAdd() { return workdayAdd; },
  get workdaysBetween() { return workdaysBetween; },
  get writeBrandConfig() { return writeBrandConfig; },
  get writeConfigPatch() { return writeConfigPatch; },
  ROUTE_NEXT, require, __dirname, __filename,
};
const TMS_ROUTES = {
  core: require("./modules/core/routes.js")(SRV),
  performance: require("./modules/performance/routes.js")(SRV),
  learning: require("./modules/learning/routes.js")(SRV),
  talent: require("./modules/talent/routes.js")(SRV),
};
async function handleApi(req, res, pathname, query) {
  // 跨进程缓存失效（商业化 P0）。PRAGMA data_version 只在**别的连接**提交后才 +1：
  // 脚本直写 lms.db、或另一个进程动了库，下一个请求在这里发现基线不一致，先重建
  // PROGRAMS/COURSES/TPROJECTS 缓存再继续。为什么放在请求入口而不是定时器 ——
  // 请求驱动：空闲实例零开销，而有请求时读一条 PRAGMA 是内存读（微秒级），且保证
  // 「脚本提交之后的第一个请求」就已经看到新数据，没有轮询间隔的空窗。
  // 与 9 处手动 refreshContent() 互补而非替代：本进程自己写库**不会**改变自己连接的
  // data_version，所以各写点的手动刷新一处都不能删 —— 这里只兜外部写入。
  if (store.dataVersion() !== CACHE_DATA_VERSION) refreshContent();
  let user = getSessionUser(req);
  if (user && user.active === 0) user = null; // deactivated (offboarded) accounts are treated as logged out
  // CSRF guard for state-changing requests: when the browser sends an Origin,
  // it must match the host we're serving on (SameSite=Lax covers the rest).
  if (["POST", "PUT", "DELETE"].includes(req.method) && req.headers.origin) {
    let originHost = null;
    try { originHost = new URL(req.headers.origin).host; } catch {}
    if (originHost !== req.headers.host)
      return send(res, 403, { error: "Cross-origin request rejected." });
  }
  // Correlates audit entries produced by one request.
  const requestId = "r-" + newToken().slice(0, 8);
  // 领域事件的 actorId：本请求此后（含所有 await 之后）经 store.js 写函数产生的事件都记这个人；
  // 未登录的请求记 null。必须在任何写库之前。Lark 回调（首登自动建号）不看这里解析出的会话，
  // 在自己的分支里重新进入 actorId null 的上下文（浏览器里残留的别人的会话 cookie 不算数）。
  domainEvents.enterContext({ actorId: user ? user.id : null, requestId });
  const audit = (action, target, before, after) =>
    store.addAudit({ actorId: user && user.id, actorName: user && user.name, action, target, before, after, requestId });
  // ---------- access log (sign-in / sign-out trail) ----------
  // Rides the SAME audit_logs table as every other action — a second table would
  // need a migration, a second reader and a second retention story to answer the
  // one question ops actually asks ("who signed in, and is anyone guessing
  // passwords"), which the existing append-only log already answers.
  // Why not reuse `audit` above: that closure takes its actor from THIS request's
  // session, which is exactly what an auth event does not have (a login has no
  // session yet) — so the actor is passed in explicitly here.
  // SECURITY: `after` carries a reason CODE and nothing else. The submitted
  // password never reaches this function, and `target` is put through
  // safeLoginTarget() below so a password typed into the employee-ID box can
  // never be persisted verbatim either.
  const auditAuth = (action, actor, target, after) =>
    store.addAudit({ actorId: actor && actor.id, actorName: actor && actor.name, action, target, before: null, after: after || null, requestId });
  // Module gate: a switched-off module's routes answer the same 404 body an
  // unknown route would, so probing can't tell "off" from "never existed".
  // Sits before the upload handlers so those two learning routes are covered;
  // the public routes below (/api/env, /api/auth/*) are all core, never listed.
  const gatedModule = moduleOfPath(pathname);
  if (gatedModule && !modulesOn()[gatedModule])
    return send(res, 404, { error: "Not found" });
  if (pathname === "/api/admin/upload-video" && req.method === "POST")
    return handleVideoUpload(req, res, user, query);
  if (pathname === "/api/admin/attachments" && req.method === "POST")
    return handleAttachmentUpload(req, res, user, query, audit);
  if (pathname === "/api/admin/brand-assets" && req.method === "POST")
    return handleBrandAssetUpload(req, res, user, query);
  // 第二批 2.8：申诉佐证材料（原始请求体，读体之前分发；handler 自查 401 与改密，见 handleReviewAppealFileUpload）
  if (pathname === "/api/me/reviews/appeal-files" && req.method === "POST")
    return handleReviewAppealFileUpload(req, res, user, query);
  // Deployment mode for the login page (no auth required, no secrets).
  // demo=false hides the demo-credentials hint; with LMS_NO_DEMO_USERS the
  // DEMO-ADMIN account doesn't exist, so advertising it would only mislead.
  if (pathname === "/api/env" && req.method === "GET")
    // modules here lets the login page / app shell trim navigation before any
    // session exists; which modules are on is not a secret, so it fits this
    // endpoint's no-auth/no-secrets contract.
    // brand: resolved white-label block (defaults merged, colors sanitized) —
    // the login page needs it pre-auth; nothing in it is a secret.
    // instance: 8-hex fingerprint of WHICH database this process serves (see
    // INSTANCE_ID) — a monitoring probe / support screenshot can tell two
    // deployments apart at a glance. The fingerprint only; never the path.
    // passwordResetEnabled: whether self-service password reset is offered at
    // all, i.e. whether config.json has a usable email block (emailConfigured()).
    // The front end hides the "forgot password" flow when it is false, so the
    // system never answers "we've sent you a link" on an install that cannot
    // send mail. A GLOBAL capability flag: it says nothing about any particular
    // employee id, so it is not an enumeration surface.
    return send(res, 200, { demo: !store.isProduction() && process.env.LMS_NO_DEMO_USERS !== "1", demoHint: process.env.LMS_DEMO_HINT || undefined, lark: !!larkCfg(), cookieSecure: store.isProduction() || requestIsHttps(req), session: !!store.getSessionUser(parseCookies(req).sid), passwordResetEnabled: emailConfigured(), modules: modulesOn(), brand: brandCfg(), instance: INSTANCE_ID });
  // 批量导入路径 + 已登录后台账号 → 放宽的请求体上限（见 BULK_BODY_MAX）；其余一律 2,000,000。
  const bodyLimit = BULK_BODY_PATHS.has(pathname) && isAdmin(user) ? BULK_BODY_MAX : BODY_MAX;
  const body = ["POST", "PUT", "DELETE"].includes(req.method) ? await readBody(req, bodyLimit) : {};

  // --- auth ---
  if (pathname === "/api/auth/login" && req.method === "POST") {
    const { employeeId, password } = body;
    const key = loginKey(req, employeeId);
    const lockMs = loginLockRemaining(key);
    const logTarget = safeLoginTarget(employeeId);
    if (lockMs > 0) {
      const mins = Math.ceil(lockMs / 60000);
      // Logged too: the lockout hits are the tail of a password-guessing run,
      // and leaving them out would make the log undercount the attack. ONCE per
      // lock period, though — see claimLockoutLog() for why logging every
      // refused request would let the attacker flood the log at will.
      if (claimLockoutLog(key))
        auditAuth("auth.login_failed", null, logTarget, { reason: "locked", method: "password", minutes: mins });
      // `code`/`minutes` let the login page show a properly localized message.
      return send(res, 429, { error: `Too many failed attempts. Please try again in about ${mins} minute(s).`, code: "locked", minutes: mins });
    }
    const u = store.getUserByEmployeeId(employeeId);
    if (!u || !checkPassword(password || "", u.passwordHash)) {
      recordLoginFail(key);
      // The RESPONSE stays deliberately identical for both cases (no account
      // enumeration for the caller); the log separates them, because "someone
      // is walking through IDs that don't exist" and "someone is guessing one
      // real person's password" are different incidents. actor = the account
      // when we know it, so the log can be filtered by victim.
      auditAuth("auth.login_failed", u || null, logTarget, { reason: u ? "bad_password" : "unknown_id", method: "password" });
      return send(res, 401, { error: "Wrong employee ID or password.", code: "auth" });
    }
    if (u.active === 0) {
      auditAuth("auth.login_failed", u, u.employeeId, { reason: "disabled", method: "password" });
      return send(res, 401, { error: "This account has been deactivated. Please contact HR.", code: "disabled" });
    }
    loginFails.delete(key);
    store.setLastLogin(u.id, new Date().toISOString());
    const token = newToken();
    store.createSession(token, u.id);
    auditAuth("auth.login", u, u.employeeId, { method: "password" });
    // 登录回跳（CONTRACT.md 9.5）：登录页把 next 一并提交时，回一个经服务端白名单核过的回跳地址 ——
    // 只接受落在开启中的模块静态挂载下的站内相对路径（如 culture 开启时的 /culture/），其余一律回 "/"（模块关闭时
    // 它的挂载回 404，next 落回 TMS 首页）。没提交 next 时应答形状不变。
    const loginReply = body && body.next !== undefined ? { ok: true, role: u.role, next: MODULE_HOST.pageLink(body.next) || "/" } : { ok: true, role: u.role };
    return send(res, 200, loginReply, { "set-cookie":`sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${store.isProduction() || requestIsHttps(req) ? "; Secure" : ""}` });
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    // Only this session — signing out on your phone must not kick you out of
    // the console you have open on the desktop. `all: true` opts into the
    // global sign-out (e.g. "lost my device").
    if (user) {
      const all = !!(body && body.all === true);
      if (all) store.deleteUserSessions(user.id);
      else {
        const cookies = parseCookies(req);
        if (cookies.sid) store.deleteSession(cookies.sid); else store.deleteUserSessions(user.id);
      }
      // scope tells the two apart in the log: "signed out" vs "signed out
      // everywhere" (the lost-device path) are different events for support.
      auditAuth("auth.logout", user, user.employeeId, { scope: all ? "all" : "session" });
    }
    return send(res, 200, { ok: true }, { "set-cookie": "sid=; Path=/; Max-Age=0" });
  }
  // --- self-service password reset (B1): "forgot" issues a mailed token,
  // "reset" spends it. Both are pre-auth (they sit above the `if (!user)` gate).
  //
  // The security contract of /api/auth/forgot is SAY NOTHING: an unauthenticated
  // caller must not learn whether an employee id exists, has an email on file, or
  // is still active. Two things enforce that here:
  //   1. the reply is the frozen FORGOT_REPLY constant — byte-identical for every
  //      input, so a diff of two responses carries zero bits of information;
  //   2. all of the real work runs in a setImmediate AFTER send(), so the
  //      "known" branch cannot be slower than the "unknown" one — no DB lookup,
  //      no scrypt, no mail on the response path. Mail is fire-and-forget: a slow
  //      or dead provider must not turn into a timing signal either.
  if (pathname === "/api/auth/forgot" && req.method === "POST") {
    const submitted = String((body && body.employeeId) || "").trim().slice(0, 64);
    if (forgotThrottled(req, submitted)) {
      const mins = Math.ceil(FORGOT_WINDOW_MS / 60000);
      return send(res, 429, { error: `Too many reset requests. Please try again in about ${mins} minute(s).`, code: "rate_limited", minutes: mins });
    }
    send(res, 200, FORGOT_REPLY);
    setImmediate(() => {
      // The message of any failure here is our own (DB/mail plumbing), never the
      // token: issuePasswordReset never puts one in an Error.
      try { issuePasswordReset(req, submitted, auditAuth); }
      catch (e) { console.error("password reset request:", (e && e.message) || e); }
    });
    return;
  }
  if (pathname === "/api/auth/reset" && req.method === "POST") {
    if (resetThrottled(req)) {
      const mins = Math.ceil(FORGOT_WINDOW_MS / 60000);
      return send(res, 429, { error: `Too many attempts. Please try again in about ${mins} minute(s).`, code: "rate_limited", minutes: mins });
    }
    // ONE failure answer for every reason there is — no such token, expired,
    // already used, account since deactivated. A caller holding a dead link
    // learns nothing about WHY it is dead, so "this link was already spent"
    // (someone got there first) is indistinguishable from a typo.
    const dead = () => send(res, 400, { error: "This reset link is invalid or has expired.", code: "invalid_token" });
    const token = String((body && body.token) || "");
    if (!token || token.length > 200) return dead();
    const row = store.getPasswordResetByHash(sha256Hex(token));
    if (!row || row.usedAt) return dead();
    if (new Date(row.expiresAt).getTime() <= Date.now()) return dead();
    const u = store.getUserById(row.userId);
    if (!u || u.active === 0) return dead();
    const np = String((body && body.newPassword) || "");
    // Same 8-character floor as /api/auth/change-password. The extra rule is
    // specific to this path: whoever holds the link already knows the employee
    // id (it is what they typed to get the mail), and "password = my employee
    // number" is the single most common weak choice in this system — so that one
    // is refused outright rather than merely discouraged in the UI.
    const bad = newPasswordProblem(np, { employeeId: u.employeeId, currentHash: u.passwordHash });
    if (bad) return send(res, 400, bad);
    // Spend the token BEFORE writing the password: the UPDATE's `usedAt IS NULL`
    // is the single-use gate, so two requests racing with the same link cannot
    // both set a password (the loser gets the same dead-link answer).
    if (!store.markPasswordResetUsed(row.id, new Date().toISOString())) return dead();
    store.setUserPassword(u.id, hashPassword(np), false); // false = clears mustChangePassword
    // Every existing session of this account dies. The whole reason this flow
    // exists is "I may have lost control of my credentials", so leaving a
    // logged-in browser somewhere alive would defeat it. No cookie is issued
    // either: the user signs in with the new password.
    store.deleteUserSessions(u.id);
    auditAuth("auth.password_reset", u, u.employeeId, { method: "email_token" });
    return send(res, 200, { ok: true });
  }

  // ---------- Lark (Feishu) SSO — sign in with Lark, auto-provision on first login ----------
  // config.json:
  //   { "lark": { "appId": "cli_…", "appSecret": "…",
  //               "base": "larksuite",              // "larksuite" (international) | "feishu" (CN)
  //               "redirectUri": "https://tms.digiplus.example/api/auth/lark/callback" } }
  //   redirectUri 可省略 —— 省略时按本次请求的 Host 推导（见 larkRedirect）。完整模板见 config.json.example。
  // Matching order on callback: previously-linked Lark identity → employeeId
  // equal to the tenant's Lark user_id (works when Lark user ids ARE the
  // employee numbers) → email. No match → a fresh employee account is created
  // (JIT) and the default mandatory courses are assigned.
  if (pathname === "/api/auth/lark/start" && req.method === "GET") {
    const cfg = larkCfg();
    if (!cfg) return send(res, 404, { error: "Lark sign-in isn't configured." });
    const state = newToken().slice(0, 24);
    // 登录回跳（CONTRACT.md 9.5）：next 只收开启中的模块静态挂载下的站内相对路径（MODULE_HOST.pageLink），其余不存。
    // 值是 { exp, next }：清理循环读 .exp（以前值是过期时间数字，改成对象后若仍按数字比较，过期的 state 永不清理）。
    larkStates.set(state, { exp: Date.now() + 10 * 60 * 1000, next: MODULE_HOST.pageLink(query ? query.get("next") : null) });
    for (const [k, v] of larkStates) if (!v || !(v.exp >= Date.now())) larkStates.delete(k);
    const authUrl = `${larkHost(cfg)}/open-apis/authen/v1/authorize?app_id=${encodeURIComponent(cfg.appId)}` +
      `&redirect_uri=${encodeURIComponent(larkRedirect(cfg, req))}&state=${state}`;
    res.writeHead(302, { location: authUrl });
    return res.end();
  }
  if (pathname === "/api/auth/lark/callback" && req.method === "GET") {
    // 这条回调是**未经本站登录**的流程：Lark 把浏览器 302 回来时，SameSite=Lax 的 sid cookie
    // 照样会带上 —— 同一浏览器里还登着 HR 管理员（测 Lark 登录）、或共用电脑上一个人没退出时，
    // 入口处解析出的 user 是**那个人**，不是正在首登的这位。本分支里的写（首登自动建号的
    // employee.hired 事件、auth.lark.jit 审计）一律记为系统（actorId null），不借用那个会话。
    domainEvents.enterContext({ actorId: null, requestId });
    const sysAudit = (action, target, before, after) =>
      store.addAudit({ actorId: null, actorName: null, action, target, before, after, requestId });
    const cfg = larkCfg();
    // next：start 时存下的回跳地址（已按白名单核过）。成功跳 next（没有则 "/"）；失败仍跳登录页，带上 next。
    let next = null;
    const fail = (reason) => {
      res.writeHead(302, { location: "/#/login?sso=" + encodeURIComponent(reason) + (next ? "&next=" + encodeURIComponent(next) : "") });
      return res.end();
    };
    if (!cfg) return fail("off");
    const code = query ? query.get("code") : null;
    const state = query ? query.get("state") : null;
    const pending = state ? larkStates.get(state) : undefined;
    if (!code || !state || !pending) return fail("failed");
    larkStates.delete(state);
    // 回调时再按白名单核一次：start 到回调之间（最长 10 分钟）模块可能已被关闭 —— 那时它的挂载回 404，落回首页。
    next = MODULE_HOST.pageLink(pending.next) || null;
    if (!(pending.exp >= Date.now())) return fail("failed");   // 过期的 state（10 分钟）不再认
    try {
      const info = await larkExchange(cfg, code);
      if (!info) return fail("failed");
      const larkId = info.union_id || info.open_id;
      const email = (info.enterprise_email || info.email || "").trim().toLowerCase();
      // 开启了 Masterlist Base 同步（lark.sync）时：只认同步登记过的 Lark user_id（users.larkUserId）——
      // 即 BIPO 在职的 DigiPlus 员工，以及按规则放行的无 EID Lark 账号；其余一律拒绝，不自动建号。
      let u;
      if (larkSyncCfg()) {
        if (!info.user_id) console.error("lark sso: user_info has no user_id — grant the app contact:user.employee_id:readonly");
        u = info.user_id ? store.getUserByLarkId(String(info.user_id)) : null;
        if (!u) {
          auditAuth("auth.login_failed", null, String(info.user_id || larkId || "").slice(0, 40), { reason: "not_allowed", method: "lark" });
          return fail("notallowed");
        }
      } else {
        // 1) already linked; 2) employeeId == Lark user_id; 3) email match.
        u = store.getUserByLarkId(larkId);
        if (!u && info.user_id) u = store.getUserByEmployeeId(String(info.user_id));
        if (!u && email) u = store.listUsers().find((x) => (x.email || "").trim().toLowerCase() === email);
      }
      if (u && u.active === 0) {
        auditAuth("auth.login_failed", u, u.employeeId, { reason: "disabled", method: "lark" });
        return fail("disabled");
      }
      if (!u) {
        // JIT provisioning: first Lark sign-in creates the account.
        let employeeId = String(info.user_id || "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,19}$/.test(employeeId) || store.employeeIdExists(employeeId)) {
          do { employeeId = "LK-" + newToken().slice(0, 6).toUpperCase(); } while (store.employeeIdExists(employeeId));
        }
        u = store.createUser({
          id: "u-" + newToken().slice(0, 8),
          employeeId,
          name: String(info.name || info.en_name || "Lark User").slice(0, 80),
          role: "employee",
          passwordHash: hashPassword(newToken()), // never used — Lark is the credential
          department: null,
          email: email || null,
          managerId: null,
          larkUserId: larkId,
          mustChangePassword: 0,
        });
        assignPrograms(u.id); // default: every published mandatory course
        sysAudit("auth.lark.jit", u.employeeId, null, { name: u.name, email: u.email || null });
        notifyAdmins({
          type: "lark.jit",
          title: `${u.name} signed in with Lark — account auto-created`,
          title_zh: `${u.name} 通过 Lark 首次登录，已自动开通账号`,
          body: `Employee ID ${u.employeeId}. Set their department/manager under Employees.`,
          body_zh: `工号 ${u.employeeId}。请在「员工」中补充部门与经理。`,
          // 第二批 2.5：直达此人的编辑资料整页（People.jsx 的 ?edit=1），不再落到名册
          link: `#/admin/people/${u.id}?edit=1`,
        // domain "people", not "accounts": the account already exists (Lark made
        // it): the action this notice asks for is filling in department/manager,
        // which lives on the people-domain routes (employees/:id/profile,
        // bulk-update). accounts is ungrantable (super-admin only), so tagging it
        // accounts would hide the follow-up from the HRBP who owes the follow-up.
        // write:true（第二批 2.3）：补资料是写动作，people 只读的角色（绩效与人才管理员）不收。
        }, "people", { write: true });
      } else if (!u.larkUserId) {
        store.setUserLarkId(u.id, larkId); // link once, match instantly next time
        sysAudit("auth.lark.link", u.employeeId, null, { larkId });
      }
      store.setLastLogin(u.id, new Date().toISOString());
      const token = newToken();
      store.createSession(token, u.id);
      auditAuth("auth.login", u, u.employeeId, { method: "lark" });
      res.writeHead(302, {
        location: next || "/",
        "set-cookie": `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${store.isProduction() || requestIsHttps(req) ? "; Secure" : ""}`,
      });
      return res.end();
    } catch (e) {
      console.error("lark sso:", (e && e.message) || e);
      return fail("failed");
    }
  }

  if (!user) return send(res, 401, { error: "Not logged in" });

  // A temporary (HR-issued) password must be changed before anything else —
  // enforced server-side, not just by hiding buttons in the UI.
  // code 供学员端等前端按 code 分支（CONTRACT.md 附录 B）；error 正文不变。
  { const routeResult = await TMS_ROUTES.core.meCore1({ user, pathname, res, req, query, body, requestId, auditAuth }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js

  // --- performance reviews (DigiPlus 4-step flow: outcomes vs last goals →
  // next goals → manager 1-on-1 → rating; HR calibrates & closes) ---
  const pj = (s2, d2) => { try { return s2 ? JSON.parse(s2) : d2; } catch { return d2; } };
  // 评估条目的完整形状（上级的 TeamCard、单人评估页用；员工本人的 mine[] 在此基础上删字段）。i 带 cycleName 等联表列
  { const routeResult = await TMS_ROUTES.performance.mePerformance1({ pj, pathname, req, user, res, body, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/performance/routes.js

  // Step 1+2 (employee): outcomes against last quarter's goals, challenges,
  // required feedback to the manager, optional exceptional contributions, and
  // 1-3 next-quarter goals. Editable until the cycle closes.
  { const routeResult = await TMS_ROUTES.core.meCore2({ pathname, req, user, res, pj, body, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js

  // --- programs (employee) ---
  // Employees see only PUBLISHED programs assigned to them; admins who can read
  // the learning domain see everything (that preview privilege is what lets a
  // learning-admin open the course they are building; the auditor, whose
  // learning grant is none, still sees only their own assignments).
  // Programs without a status (pre-Batch-1 data) count as published.
  const myAssignments = store.getUserAssignments(user.id);
  const isPublished = (p) => (p.status || "published") === "published";
  const isAssigned = (pid) => {
    const p = getProgram(pid);
    if (!p) return false;
    if (canRead(user, "learning")) return true;
    // 第四批 9.2：方案 B / C 时，已不公开的自主学习课程在这里挡住（负责人选 A：selfAccessBlockedFor 恒为 false）
    return isPublished(p) && !!myAssignments[pid] && !selfAccessBlockedFor(user.id, p, myAssignments[pid]);
  };
  { const routeResult = await TMS_ROUTES.learning.meLearning1({ pathname, user, res, isAssigned, myAssignments, isPublished, req, query, audit, body }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js
  // --- training projects: employee side (Phase B) ---
  const myMemberships = () => store.getUserMemberships(user.id).filter((m) => m.role === "learner");
  { const routeResult = await TMS_ROUTES.learning.meLearning2({ pathname, req, myMemberships, user, res }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js
  { const routeResult = await TMS_ROUTES.core.meCore3({ pathname, req, myMemberships, res, user, body, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
  // TRAINER: the sessions I teach — project activities and standalone in-person
  // courses whose trainerId is me. A trainer owns the SESSION (its attendees may
  // span several classes), which is what separates them from a class head.
  if (pathname === "/api/me/sessions" && req.method === "GET") {
    return send(res, 200, { sessions: mySessions(user.id).map((s) => sessionSummary(s)) });
  }
  { const routeResult = await TMS_ROUTES.core.meCore4({ pathname, req, user, res, body, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
  /* MANAGER (D3 + D8): ONE report's profile, READ-ONLY.
     RBAC-DESIGN.md D3 lets a manager read a report's full record (identity,
     lifecycle records, the complete performance history, training) and D8 says
     "report" means anyone in their reporting line, skip-levels included.
     Hard constraints, each one enforced right here:
     · READ-ONLY. GET is the only method this path answers; a POST/PUT/DELETE
       to /api/me/reports/* falls through to the generic 404 at the end of
       handleApi. There is deliberately no write sibling anywhere on this route
       family — a manager who wants a record changed goes to HR.
     · OUT OF LINE → 404, byte-identical to "no such person", so this is not an
       existence oracle for the roster (same wording as /api/me/classes).
     · NO BACK-OFFICE DOOR. Manager is a DERIVED identity (data, not a grant);
       it hands out no adminRoleId and no /api/admin/* reach. It is orthogonal
       to the 9 capability domains and must stay that way.
     · AUDITED. A senior manager can pull hundreds of profiles, so every open
       writes one manager.view_profile row (who read whom). One insert on the
       existing audit() path — no extra query, no measurable latency.
     WHAT THIS DROPS relative to GET /api/admin/employees/:id/profile, and why:
       · suggestions{} — that block is a company-wide directory (every active
         person's id+name, every department, every position). It exists to feed
         the admin EDIT form; on a read-only route it would be a second roster.
       · config{} (record types + field definitions) — also edit-form fuel. The
         timeline is instead rendered server-side into label/value pairs, the
         same shape /api/me/growth ships, so the client has nothing to edit with.
       · record ids / createdBy / source flags — nothing here addresses a row for
         mutation, so the id is dead weight that only suggests an edit affordance.
       · secondaryReports[] — the people who dotted-line INTO this person. Those
         are arbitrary others, frequently outside the caller's line; the caller's
         range is their own subtree, not this person's matrix team.
       · type=note records (备注) — HR's own free-text remarks on the person,
         employeeVisible=false out of the box. The other record types are facts
         about the file (transfer / regularization / exit / violation / award);
         a note is HR's commentary ON it, and D8 would push it to every manager
         above the person. Withheld — see the one-line skip in the loop below.
       · extras{} (HR's custom employee fields) — free-form, HR-defined, with no
         per-field visibility flag. D8 bars compensation and a custom field is
         exactly where a comp-shaped value would live. Withheld until fields
         carry a visibility flag; HR keeps seeing them in the console.
       · lastLoginAt / createdAt / role / adminRoleId — account-domain facts (D6
         split accounts out for a reason). A manager is not an account admin;
         login surveillance is not part of "read your report's profile".
       · self-review prose from OPEN cycles (selfOutcomes / selfChallenges /
         selfFeedback / selfExtra / goalsNext / oneOnOneNotes) — selfFeedback is
         literally "feedback to your manager", and the 1-on-1 notes are that
         conversation. D3 grants the rating and the appraisal, not the report's
         private half of it; publishing it up the line would end candid
         self-reviews. The direct manager still reads it via /api/me/reviews.
         (An ARCHIVED cycle is different: closing writes a permanent
         type=performance record whose summary HR blessed as the file copy, and
         D3 grants the performance history in full — so those ship as stored.)
     Module switches: this is a cross-domain aggregate, so — like
     /api/admin/dashboard — it trims sections instead of 404-ing wholesale;
     closing it entirely would take identity+lifecycle down with learning. */
  { const routeResult = await TMS_ROUTES.learning.meLearning3({ pathname, req, user, res, audit, body, isAssigned, myAssignments }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js

  // --- courses (employee) ---
  // Server-side access rule (spec 8.5): a course is only readable/completable
  // by admins or by employees assigned its (published) program.
  // A course is reachable when ANY package containing it is assigned to me.
  const canAccessCourse = (c) => c && programsContaining(c.id, c).some((pid) => isAssigned(pid));
  { const routeResult = await TMS_ROUTES.learning.meLearning4({ pathname, canAccessCourse, myAssignments, res, isAssigned, user, req, body, audit, isPublished, query }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js

  // 考试进行中的心跳（只更新 lastSavedAt）。答卷不再恢复（离开即重新开始），但学习助手的
  // 「考试进行中」判定（examInProgressForCourse，无时限考试看最近一次保存）仍靠它保持准确。
  // 旧前端仍会带 answers 过来，照存无害——重新开始时整份答卷连同草稿一起被丢弃。
  { const routeResult = await TMS_ROUTES.core.meCore5({ pathname, req, user, res, body, requestId, canAccessCourse }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js

  // --- admin ---
  if (pathname.startsWith("/api/admin/")) {
    if (!isAdmin(user)) return send(res, 403, { error: "Admin only" });
    // RBAC P1 domain gate: super-admins bypass; everyone else is checked against
    // the route matrix (keyed by path pattern — RBAC-ROUTE-MATRIX.md). Runs in
    // parallel with the module switch above; both must pass.
    { const routeResult = await TMS_ROUTES.core.adminCore1({ user, pathname, req, res, body, audit, query, requestId }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js

    // --- programs (first-class management; content routes remain for courses) ---
    { const routeResult = await TMS_ROUTES.learning.adminLearning1({ pathname, req, res, body, user, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js

    // --- exams (first-class objects) ---
    // Shared validation for create/update. Publishing requires a big-enough
    // question pool so an exam can never go live half-empty (spec 6.7).
    const validateExam = (payload, program, examId) => {
      // CX-154：中英文名至少填一个；英文留空就存空（显示时回落中文名，见 store rowToExam），不再用中文名填英文
      const title = String(payload.title || "").trim();
      if (!title && !String(payload.title_zh || "").trim()) return { error: "Enter the exam name in Chinese or English.", error_zh: "请填写考试名称（中文或英文至少一个）。", code: "title_required" };
      const status = ["draft", "published", "archived"].includes(payload.status) ? payload.status : "published";
      let courseIds = Array.isArray(payload.courseIds) ? payload.courseIds.filter((c, i, a) => a.indexOf(c) === i) : [];
      const invalid = courseIds.filter((cid) => !(program.courseIds || []).includes(cid));
      if (invalid.length) return { error: `These courses don't belong to the program: ${invalid.join(", ")}` };
      if (!courseIds.length) return { error: "Link at least one course — the exam draws its questions from the linked courses." };
      // Every numeric rule is rounded as well as clamped — a fractional pass
      // mark or question count has no meaning and shows up oddly in the UI.
      const int = (v, def, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || def));
      // F58（负责人 10/9 定）：考前须知（选填）中英文两栏，纯文本、保留换行，各不超过 1000 字（按字符计，去首尾空白后）。
      //   换行统一为 \n，去掉换行与制表符以外的控制字符；空 = null（员工端只显示系统须知）。超长整单 400 pre_notice_too_long，不截断。
      //   修改时请求里没有这个键 = 保留原值（列表行的发布 / 下线按钮不回传）。
      const preNotice = {};
      for (const [k, label, label_zh] of [["preNotice", "English", "英文"], ["preNotice_zh", "Chinese", "中文"]]) {
        if (!Object.prototype.hasOwnProperty.call(payload, k)) {
          if (examId) { const prev = store.getExam(examId); preNotice[k] = prev ? prev[k] || null : null; } else preNotice[k] = null;
          continue;
        }
        const raw = payload[k];
        if (raw != null && typeof raw !== "string")
          return { error: `The ${label} pre-exam notice must be plain text.`, error_zh: `考前须知（${label_zh}）须为纯文本。`, code: "pre_notice_invalid" };
        const text = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
        const len = Array.from(text).length;
        if (len > 1000)
          return { error: `The ${label} pre-exam notice is ${len} characters; the limit is 1000.`, error_zh: `考前须知（${label_zh}）共 ${len} 字，超过 1000 字上限。`, code: "pre_notice_too_long" };
        preNotice[k] = text || null;
      }
      const e = {
        title: clampText(title, 120), titleEn: clampText(title, 120), title_zh: payload.title_zh ? clampText(payload.title_zh, 120) : null, status,
        ...preNotice,
        passingScore: int(payload.passingScore, 80, 1, 100),
        mcqCount: int(payload.mcqCount, 8, 1, 50),
        openCount: Math.min(10, Math.max(0, Math.round(Number(payload.openCount ?? 1)) || 0)),
        timeLimitMinutes: payload.timeLimitMinutes ? int(payload.timeLimitMinutes, 30, 1, 240) : null,
        maxAttempts: Math.min(20, Math.max(0, Math.round(Number(payload.maxAttempts)) || 0)),
        retakeCooldownHours: Math.min(720, Math.max(0, Math.round(Number(payload.retakeCooldownHours)) || 0)),
        showAnswersAfterExam: payload.showAnswersAfterExam !== false,
        autoRetrain: payload.autoRetrain !== false,
        // 每题分值（需求单 #4）：题型默认分值 1–100 的整数；不传或全部无效 = 旧口径（null）
        typePoints: (() => {
          const tp = payload.typePoints;
          if (!tp || typeof tp !== "object" || Array.isArray(tp)) return null;
          const out = {};
          // 第四批：键 = 注册表里已开放、除案例外的全部题型（QT.typePointsKeys；案例分值 = 各小题之和）。旧四个键缺省照旧补默认值，
          // 新题型的键只在传了有效值时存（没存的按目录默认分值，见 questionPoints），所以旧考试原样往返。
          for (const k of QT.typePointsKeys()) { const v = Math.round(Number(tp[k])); if (Number.isFinite(v) && v >= 1 && v <= 100) out[k] = v; }
          if (!Object.keys(out).length) return null;
          const res = { mcq: out.mcq ?? 1, multi: out.multi ?? 1, fill: out.fill ?? 1, open: out.open ?? 10 };
          for (const k of QT.typePointsKeys()) if (!LEGACY_QTYPES.has(k) && out[k] != null) res[k] = out[k];
          return res;
        })(),
        multiPartial: payload.multiPartial !== false,
        // 第四批 10.6 / 6.1：选项顺序（默认每次随机）、新题型按比例给分（默认开）、随机抽题的情境案例组数（0–10，默认 0）。
        // 修改时请求里没有这个键 = 保留原值（旧版考试编辑器不回传），新建缺省 = 默认值。
        ...(() => {
          const prev = examId ? store.getExam(examId) : null;
          const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
          const flag = (k) => (has(k) ? payload[k] !== false : prev ? prev[k] !== false : true);
          const cc = has("caseCount") ? Math.min(10, Math.max(0, Math.round(Number(payload.caseCount)) || 0)) : prev ? prev.caseCount || 0 : 0;
          return { shuffleOptions: flag("shuffleOptions"), partialCredit: flag("partialCredit"), caseCount: cc };
        })(),
        // 固定题目模式（2026-10-06）：questionIds 只收关联课程题库里存在的题，去重、保序
        mode: payload.mode === "fixed" ? "fixed" : "random",
        questionIds: [],
      };
      if (e.mode === "fixed") {
        const ids = new Set(courseIds);
        const linked = store.listQuestions().filter((q) => ids.has(q.courseId));
        const want = Array.isArray(payload.questionIds) ? payload.questionIds.map(String) : [];
        // 第四批：卷面上有未开放 / 不认识的题型 → 400 type_disabled（界面上选不到，只防手工请求）
        const wantSet = new Set(want);
        if (linked.some((q) => wantSet.has(q.id) && (q.unsupported || !QT.isEnabled(q.type))))
          return { error: "This paper contains a question type that is not available yet.", error_zh: "试卷中含有尚未开放的题型。", code: "type_disabled" };
        const poolIds = new Set(linked.filter(examUsable).map((q) => q.id));
        e.questionIds = want.filter((id, i, a) => poolIds.has(id) && a.indexOf(id) === i).slice(0, 200);
        if (status === "published" && !e.questionIds.length)
          return { error: "A fixed-question exam needs at least one question from the linked courses before it can be published." };
      }
      if (status === "published" && e.mode !== "fixed") {
        const ids = new Set(courseIds);
        const pool = store.listQuestions().filter((q) => ids.has(q.courseId) && examUsable(q));
        // 第四批：按题型分组（客观题 = 全部客观题型），另查情境案例组数
        const obj = pool.filter((q) => QT.groupOf(q.type) === "objective").length;
        const open = pool.filter((q) => q.type === "open").length;
        const kase = pool.filter((q) => q.type === "case").length;
        if (obj < e.mcqCount || open < e.openCount)
          return { error: `Not enough questions to publish: the linked courses have ${obj} objective (need ${e.mcqCount}) and ${open} open (need ${e.openCount}). Add questions or lower the draw counts.` };
        if (kase < e.caseCount)
          return { error: `Not enough scenario cases to publish: the linked courses have ${kase} (need ${e.caseCount}). Add cases or lower the case count.`, error_zh: `情境案例不足，无法发布：关联课程共 ${kase} 组（需要 ${e.caseCount} 组）。请添加案例或减少案例组数。`, code: "pool_case" };
      }
      return { exam: e, courseIds };
    };
    // 第四批：题池按题型的细分 { poolCase: 情境案例组数, poolByType: { 题型: 题数 } }（只计能进卷的题）
    const examPoolBreakdown = (pool) => {
      const poolByType = {};
      for (const q of pool) poolByType[q.type] = (poolByType[q.type] || 0) + 1;
      return { poolCase: poolByType.case || 0, poolByType };
    };
    { const routeResult = await TMS_ROUTES.learning.adminLearning2({ pathname, req, res, examPoolBreakdown, body, validateExam, user, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js
    { const routeResult = await TMS_ROUTES.core.adminCore2({ pathname, req, res, examPoolBreakdown, validateExam, body, user, audit, query }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js

    // Light people list for the Employees page and every "pick people" UI —
    // no per-course progress computation (that's what made the heavy endpoint
    // slow at 3000 staff).
    { const routeResult = await TMS_ROUTES.learning.adminLearning3({ pathname, req, user, res }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js
    // 全站部门筛选的部门树（第二批 3.1，2026-10-08）：前端 DeptFilter 的选项来源（web/src/deptfilter.js useDeptTree）。
    // 走后台闸门里的手写规则 W1c（先于 rbacGate；people / learning / performance / talent 任一可读即放行，否则 404 —— 修掉 K1：培训管理员、
    // 绩效与人才管理员打开培训概览时部门下拉为空，因为 /api/admin/departments 归 people 域）。
    // 部门来源 = 范围内全部人员（含离职、停用；纯服务账号除外）的部门链；count = 含下级的在职人数；不返回负责人姓名。
    // 返回 { options, idByName, chainById, hasNone }：hasNone = 范围内有人没有部门（前端据此显示「无部门」）。
    { const routeResult = await TMS_ROUTES.core.adminCore3({ pathname, req, user, res, body, audit, auditAuth, requestId }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
    // AI 人才画像：生成草稿（方案 2.5「画像权限」「画像流程」、4.4）。判定顺序：
    //   ai 模块或 portrait 功能所属模块关闭 → 与不存在相同的 404；没有员工档案（people）读权限 → 403（与 id 无关）；
    //   取员工，范围外与不存在同为裸 404（排在演示分支与任何状态检查之前）；为本人生成 → 403 ai_self_subject（超级管理员同样）；
    //   功能关闭 / 未接入 / 预算用尽 → 403 / 503 / 429；演示 → 只列真实记录统计的演示草稿；限流 → 429；然后最小化输入并调用。
    // 结果一律保存为草稿（talent_portraits），经 HR 确认后才是人才材料；成功和失败都写审计 talent.portrait。
    { const routeResult = await TMS_ROUTES.talent.adminTalent1({ pathname, req, res, user, requestId, audit, query, body }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/talent/routes.js
    // 绩效记录的「期间」（detail.period）与此人某个已关闭评估周期归档的记录同期（按记录现在的 period，另认周期名；
    // 去空白、不分大小写）→ true。没填期间的记录不拦。
    // memo（可选）：导入时按人缓存归档记录，几千行每人只查一次。
    // excludeId（可选）：编辑时排除记录本身（编辑归档记录本身照常）。
    const recordPeriodKey = (detail) => (detail && detail.period != null ? String(detail.period).trim().toLowerCase() : "");
    const recordPeriodHasCycleRecord = (userId, detail, memo, excludeId) => {
      const p = recordPeriodKey(detail);
      if (!p) return false;
      let list = memo ? memo.get(userId) : null;
      if (!list) { list = store.listCycleArchivedRecords(userId); if (memo) memo.set(userId, list); }
      return list.some((r) => r.recordId !== excludeId && [r.period, r.cycleName].some((x) => x != null && String(x).trim().toLowerCase() === p));
    };
    const RECORD_PERIOD_HAS_CYCLE_ERR = {
      error: "This person already has a performance record for this period, archived from a review cycle. Edit that record and give a reason instead of adding another. 此人这一期已有评估周期归档的绩效记录，请编辑原记录并写明理由，不要另建一条。",
      code: "period_has_cycle_record",
    };
    // 第二批 2.6 的三个新码（PUT / DELETE /api/admin/records/:id）
    const RATING_REASON_REQUIRED_ERR = {
      error: "Give a reason for changing the rating (up to 1,000 characters). It is recorded in the audit log and not shown to the employee. 修改评级须填写理由（不超过 1000 字），理由写入审计，员工不可见。",
      code: "rating_reason_required",
    };
    const RECORD_TYPE_LOCKED_ERR = {
      error: "This record was archived from a review cycle, so its type can't be changed. 该记录由评估周期归档，不能更改类型。",
      code: "record_type_locked",
    };
    const RECORD_FROM_CYCLE_ERR = {
      error: "This record was archived from a review cycle and can't be deleted. To correct the rating, edit it and give a reason. 该记录由评估周期归档，不能删除；如需更正评级，请编辑并写明理由。",
      code: "record_from_review_cycle",
    };
    // Create a talent record for one employee (side effects sync master data).
    { const routeResult = await TMS_ROUTES.talent.adminTalent2({ pathname, req, res, user, body, recordPeriodHasCycleRecord, RECORD_PERIOD_HAS_CYCLE_ERR, auditAuth, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/talent/routes.js
    // Edit / delete one record.
    { const routeResult = await TMS_ROUTES.core.adminCore4({ pathname, req, res, user, body, RECORD_TYPE_LOCKED_ERR, recordPeriodKey, recordPeriodHasCycleRecord, RECORD_PERIOD_HAS_CYCLE_ERR, RATING_REASON_REQUIRED_ERR, audit, auditAuth, RECORD_FROM_CYCLE_ERR }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
    { const routeResult = await TMS_ROUTES.performance.adminPerformance1({ pathname, req, res, user, body, audit, query }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/performance/routes.js
    const cycleMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)$/);
    { const routeResult = await TMS_ROUTES.performance.adminPerformance2({ cycleMatch, req, res, user, pathname, body, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/performance/routes.js
    // Calibration: HR sets the final rating (overrides the manager's).
    { const routeResult = await TMS_ROUTES.core.adminCore5({ pathname, req, res, user, body, audit, cycleMatch, query }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js

    // --- job-grade catalog 职级体系 ---
    { const routeResult = await TMS_ROUTES.performance.adminPerformance3({ pathname, req, res, body, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/performance/routes.js

    // --- promotion pipeline & succession (Phase 4) ---
    { const routeResult = await TMS_ROUTES.talent.adminTalent3({ pathname, req, res, body, user, audit, query, requestId }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/talent/routes.js
    // 人工名单（只用于内置晋升筛选）：include 手动加入 / exclude 排除（必须写理由）/ remove 移出名单。所涉人员有一人在范围外整批拒绝。
    { const routeResult = await TMS_ROUTES.core.adminCore6({ pathname, req, user, res, body, audit, query }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js

    // 第三批 8.6：按部门 × 职级圈人的预览（确认框里的人数）。query：depts、grades（逗号分隔）、gradeFrom、gradeTo，
    // 以及 programId（课程指派：扣除已指派的人）或 projectId（培养项目加学员：扣除该项目在训学员，后台账号不计）。
    // 回 { matched, noGrade, alreadyAssigned, toAdd, gradeOptions:[{grade,count}], select }；只给 select 之外的字段时（都没传）回 400 empty_select，
    // 但 gradeOptions 总在（?options=1 只要选项）。
    { const routeResult = await TMS_ROUTES.learning.adminLearning4({ pathname, req, user, query, res, body, audit, requestId }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js
    { const routeResult = await TMS_ROUTES.core.adminCore7({ pathname, req, body, res, user, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
    // All pending project nominations across projects (the unified approvals
    // center shows them next to elective-course requests).
    { const routeResult = await TMS_ROUTES.learning.adminLearning5({ pathname, req, user, res, body, audit, query }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js
    { const routeResult = await TMS_ROUTES.core.adminCore8({ pathname, req, res, user, body, audit, auditAuth }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
    // Nudge everyone with an overdue assignment, in one action (design 16:
    // "42 人逾期未完成 … 一键提醒"). HR was otherwise chasing them by hand off a
    // CSV. Uses the existing notify() path, so each person gets an in-app
    // notification and — where an address is on file — an email.
    { const routeResult = await TMS_ROUTES.learning.adminLearning6({ pathname, req, body, user, audit, res, query, requestId }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js

    // --- CSV exports (audit / compliance records) ---
    // Completion report: one row per employee × assigned program.
    { const routeResult = await TMS_ROUTES.core.adminCore9({ pathname, user, query, audit, res }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
    { const routeResult = await TMS_ROUTES.learning.adminLearning7({ pathname, user, res, req, body, audit }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/learning/routes.js
    { const routeResult = await TMS_ROUTES.core.adminCore10({ pathname, req, res, body, audit, requestId, user }); if (routeResult !== ROUTE_NEXT) return routeResult; }   // → modules/core/routes.js
  }

  return send(res, 404, { error: "Not found: " + pathname });
}

// ---------- server ----------
store.init({ hashPassword });
// 模块（接入方式 B）的启动顺序固定（CONTRACT.md 3.1、第 8 节；PHASE2-KERNEL.md 4.1）：
//   store.init()（TMS 结构迁移 → 种子 → 数据迁移）→ 模块迁移（有待执行文件时先做一次迁移前备份）
//   → 为每个带 handler 路由的模块组装 services → 调用工厂 → 启动校验 → …… → 启动任务调度 → listen。
// 模块关闭时同样迁移、同样调用工厂（关闭只关入口）。任何一步失败（迁移出错、已执行的迁移文件被改动、工厂抛错、
// handlers / jobs 与 manifest 对不上）都打印原因并以退出码 1 拒绝启动，不带着半套模块对外服务。
try {
  const ranModuleMigrations = MODULE_HOST.migrate();
  if (ranModuleMigrations.length) console.log(`[modules] applied module migration(s): ${ranModuleMigrations.join(", ")}`);
} catch (e) {
  console.error("[modules] 模块迁移失败，拒绝启动 / module migration failed, refusing to start:\n" + (e && e.message));
  process.exit(1);
}
try {
  MODULE_HOST.init();
} catch (e) {
  console.error("[modules] 模块工厂启动失败，拒绝启动 / module factory failed, refusing to start:\n" + (e && e.message));
  process.exit(1);
}
refreshContent();
// 启动引用完整性体检：悬空引用是绕过服务直写库最典型的后遗症（audit 观测到的
// 「课程库 3 门草稿但员工端在学第 4 门」就是这一类），这里让它自我暴露 —— 启动日志
// 每类一行 console.warn，并给所有管理员发一条双语站内信。明细随时可用
// GET /api/admin/integrity 重查，不必翻日志。体检失败绝不拦启动：这是诊断，不是闸门。
try {
  // checkReferences 永远报满五个类目（干净库 = 全零）；启动告警只看 count>0 的。
  const integrityIssues = store.checkReferences().filter((i) => i.count > 0);
  if (integrityIssues.length) {
    for (const i of integrityIssues)
      console.warn(`[integrity] ${i.kind}: ${i.count} dangling reference(s), e.g. ${i.sample.join(", ")}`);
    const total = integrityIssues.reduce((s, i) => s + i.count, 0);
    const brief = integrityIssues.map((i) => `${i.kind}: ${i.count}`).join(" · ");
    notifyAdmins({
      type: "integrity",
      title: `Data integrity: ${total} dangling reference(s) found — see the startup log`,
      title_zh: `数据完整性：发现 ${total} 处悬空引用，详见启动日志`,
      body: `${brief}. Details: GET /api/admin/integrity. Usual cause: a script wrote the database directly while content was edited elsewhere.`,
      body_zh: `${brief}。明细可查 GET /api/admin/integrity。常见成因：脚本绕过服务直写数据库。`,
    // No domain on purpose: dangling references span content/assignments/people,
    // and /api/admin/integrity is an RBAC_SHELL route open to EVERY admin role
    // (see RBAC_SHELL above). A startup diagnostic belongs to no single domain,
    // so every admin — auditor included — gets it, exactly as before RBAC P1.
    });
  }
} catch (e) {
  console.warn("integrity check failed (continuing): " + e.message);
}
// 写库脚本护栏锁：<db>.server.lock 放在库文件旁（JSON: pid/port/bootedAt）。随包交付
// 的写库脚本（convert-office-attachments / reset-for-uat）启动时看到它且 pid 仍活着
// 就拒绝直写。退出钩子（下方 exit/SIGINT/SIGTERM）尽力删除；kill -9 / 断电必然留下
// 孤锁 —— 无妨，脚本端以 pid 存活（process.kill(pid, 0)）为准，孤锁不拦人。
const SERVER_LOCK_PATH = store.dbPath() + ".server.lock";
try {
  fs.writeFileSync(SERVER_LOCK_PATH, JSON.stringify({ pid: process.pid, port: PORT, bootedAt: BOOTED_AT }));
} catch (e) {
  console.warn("server lock not written (continuing): " + e.message); // 只读盘等边角环境不拦启动
}
function removeServerLock() { try { fs.unlinkSync(SERVER_LOCK_PATH); } catch {} }
process.on("exit", removeServerLock); // SIGINT/SIGTERM 下方 process.exit(0) 也会走到这里
// P0 1.3 / 1.4：退出时同步杀掉正在跑的 LibreOffice 转换进程树（不留孤儿 soffice.bin 占着文件）
process.on("exit", () => { try { OFFICE_CONV.shutdown(); } catch {} });
// 第三批 5.7：同步杀掉正在跑的 ffmpeg（不留孤儿进程）
process.on("exit", () => { try { VIDEO_TC.shutdown(); } catch {} });
// 开始监听之前（审查 H5 / H6）：清 <ATTACH_DIR>.convert-tmp 里超过 1 小时的残留（崩溃 / 强杀留下的工作目录与
// LibreOffice 配置目录）、删掉上次在线补转留下的原 Office 文件与 .txt 缓存（补转途中不删，免得撞上 03:00 的备份）、
// 把上次没跑完的补转任务标成 interrupted。引擎内部全部 try/catch，失败只打日志，不拦启动。
try {
  const oc = OFFICE_CONV.startupCleanup();
  if (oc.tmpRemoved || oc.orphansRemoved || oc.orphansKept || oc.interrupted)
    console.log(`[office] startup cleanup: ${oc.tmpRemoved} temp entr(ies), ${oc.orphansRemoved} converted original(s) removed${oc.orphansKept ? `, ${oc.orphansKept} kept (in use)` : ""}${oc.interrupted ? "; the last conversion run was interrupted" : ""}`);
  const ocState = OFFICE_CONV.state();
  if (ocState !== "ok") console.warn(ocState === "disabled"
    ? "[office] LMS_DISABLE_OFFICE_CONVERT=1: treated as not installed — PowerPoint / Word / Excel uploads will be refused."
    : "[office] LibreOffice not found: PowerPoint / Word / Excel uploads will be refused until IT installs it (docs/HANDOVER-IT.md 2.6; LMS_SOFFICE for a custom path).");
} catch (e) {
  console.warn("[office] startup check failed (continuing): " + ((e && e.message) || e));
}
// 第三批 5.7：视频转码的启动恢复（上次遗留的 ffmpeg、transcoding → pending、清理已转码的源文件、开重探测），探测完自动接着转。
try {
  VIDEO_TC.startupRecover();
  VIDEO_TC.ready().then(() => {
    const vs = VIDEO_TC.state();
    if (vs === "missing") console.warn("[video] ffmpeg not found — PPT videos will wait for transcoding (HANDOVER-IT 2.7; LMS_FFMPEG for a custom path).");
    else if (vs === "no_encoder") console.warn("[video] the installed ffmpeg lacks the H.264 / AAC encoders — PPT videos will wait for transcoding (HANDOVER-IT 2.7).");
  }).catch(() => {});
} catch (e) {
  console.warn("[video] startup check failed (continuing): " + ((e && e.message) || e));
}
// Sweep expired sessions and stale login-fail records hourly.
// 每天一次的 AI 维护（调用记录保留期、画像草稿到期、离职员工画像删除）也挂在这里（meta aiMaintenanceDay 保证一天一次）。
// 第二批 2.8：绩效申诉的每日提醒（08:00 马尼拉之后的第一次检查，meta reviewAppealDay 保证一天一次）也挂在这里。
// 12.2：工作台每日快照（马尼拉 01:00 之后的第一次检查，meta workbenchSnapDay 一天一次；启动时当天未跑也执行一次）。
workbenchSnapshotDaily({ startup: true });
setInterval(() => { store.cleanupExpiredSessions(); pruneLoginFails(); aiDailyMaintenance(); reviewAppealDaily(); workbenchSnapshotDaily(); }, 60 * 60 * 1000).unref();
// Masterlist Base 每日同步（lark.sync.hour 点之后、当天未跑过时执行）。
setInterval(larkSyncTick, 10 * 60 * 1000).unref();
// Checkpoint + close SQLite cleanly on Ctrl+C / shutdown.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { store.close(); process.exit(0); });
// 模块定时任务（kernel/jobs.js）：按 +08:00 解释 manifest 的 cron，每分钟检查一次（定时器 unref），启动后的第一次
// 检查补跑今天已错过的任务（catchup）；模块关闭时跳过，上次运行时刻记在 meta 的 job:<模块>.<任务>。
MODULE_HOST.startJobs();
const server = http.createServer((req, res) => {
  // Baseline security headers on every response.
  // referrer-policy must NOT be "same-origin": embedded players (YouTube etc.)
  // validate the embedding site via the Referer header and error out ("153")
  // when it is stripped. strict-origin-when-cross-origin sends just the origin.
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "SAMEORIGIN");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  // A malformed percent-escape in the request target — "/videos/%", "/%zz",
  // "/api/%e0%a4%a" — makes decodeURIComponent throw. This callback has no
  // try/catch above it and the process installs no uncaughtException handler, so
  // ONE anonymous request used to kill the whole server (对抗复核实测：GET /videos/%
  // 之后端口直接没了). Answer the plain 400 a garbage request line deserves and
  // keep serving; nothing downstream can use a target we cannot even decode.
  let url, pathname;
  try {
    url = new URL(req.url, "http://x");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("Bad request");
    return;
  }
  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname, url.searchParams)
      .catch((e) => {
        // 请求体超限（readBody 打的标记）：413 + 稳定 code + 双语文案，前端导入处直接显示 error。
        if (e && e.status === 413) return send(res, 413, { error: e.message, code: e.code || "body_too_large", limit: e.limit });
        // gate 内（带 handler 路由的模块）的非法 JSON：固定的双语 bad_body 正文（CONTRACT.md 3.4 / 3.5 第 3 步）；gate 外原样。
        if (e && e.invalidJson && MODULE_HOST.isHandlerPath(pathname)) return send(res, 400, MODULE_HOST.FIXED.badBody, { "cache-control": "no-store" });
        send(res, e && e.badRequest ? 400 : 500, { error: e.message });
      });
  } else {
    serveStatic(req, res, pathname);
  }
});
// Bind to loopback by default so the app port is never directly exposed — the
// reverse proxy (Caddy) and the dev tunnel both reach it via localhost. Set
// LMS_HOST=0.0.0.0 only for a deliberate direct-access deployment without a proxy.
const HOST = process.env.LMS_HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  // Brand-driven, not hard-coded: the banner is the operator's first sight of
  // the product, and the generic default must not surface DigiPlus anywhere.
  console.log(`${brandCfg().name} (TMS) running:  http://localhost:${PORT}`);
  // CX-041（2026-10-10 验收）：上线核对用 —— 会话 cookie 何时带 Secure
  console.log(`[cookie] Secure: ${store.isProduction() ? "always (production)" : "only on https requests (x-forwarded-proto / TLS); plain http dev stays non-Secure"}; Max-Age 7d`);
  // AI：启动日志（方案 10.5 第 3 步，不含密钥）；配置指纹基线；「有密钥但模块未开启」时给后台发一次站内通知；
  // 重启恢复：gradingStatus = grading 的答卷重新入队（已评完的题不重评）；当天的维护补跑一次。
  const aiBoot = AI.startupLog();
  AI.checkConfigChange();
  if (aiBoot.keyWithoutModule && store.getMeta("aiKeyWithoutModuleNotified") !== "1") {
    store.setMeta("aiKeyWithoutModuleNotified", "1");
    notifyAdmins({ type: "ai.config", title: "An AI key is configured but the AI module is off", title_zh: "检测到 AI 密钥，但 AI 模块未开启",
      body: 'Add "ai": true to the modules block of config.json (or turn it on under System settings › Modules) — see HANDOVER-IT §10.',
      body_zh: "在 config.json 的 modules 中写 \"ai\": true，或由超级管理员在「系统设置 › 功能模块」开启（见 HANDOVER-IT §10）。", link: "#/admin/modules" }, "audit");
  }
  for (const a of store.listAttemptsByGradingStatus(["grading"])) enqueueGrading(a.id);
  aiDailyMaintenance();
  reviewAppealDaily();
});
