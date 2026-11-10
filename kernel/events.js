// 内核 · 领域事件（ARCHITECTURE-MODULAR.md §5.3，第一阶段：进程内、同步分发、带发件箱）。
//
// 本文件只放**与业务无关**的机制：事件信封、请求上下文（谁在操作）、分发总线。
// 「哪一种数据变化算哪一个事件、data 里放什么」是 core 的业务规则，写在 store.js 的
// 「领域事件」一节（createUser / updateUser / 部门写函数里集中捕获变更前后值）；
// 「谁订阅什么」写在各模块的 manifest（publishes / subscribes）与 modules/<id>/hooks.js，
// 由 kernel/registry.js 校验。
//
// ===== 一个事件的完整生命周期 =====
//   1. 数据变化发生在 store.js 的写函数里（必在一个事务中：调用方已开事务就并进去，
//      没开就由写函数自己开一个）。同一事务里：写业务表 → createEnvelope() → 写一行
//      event_outbox，并把信封放进 store 的待分发队列。
//   2. 事务回滚：业务行、发件箱行一起消失，待分发队列里本层之后的信封一起丢弃 —— 不分发。
//   3. 最外层事务提交成功之后，store 把这批信封交给 publish()（server.js 在启动时用
//      store.setEventSink 接上）。publish 按 manifest 登记顺序逐个调用订阅方的处理函数，
//      然后把每个事件的结果交给 record() 写回发件箱（dispatchedAt / attempts / lastError）。
//      没有任何订阅方的事件类型（hasSubscribers 为 false）不进这一步：store 在写入时就把它记为
//      已分发（dispatchedAt = occurredAt、attempts = 0），省掉无事可做的分发与整批回写。
//   4. 处理函数抛异常：只记一行 stderr（[events] 前缀，只含事件类型、事件 id、模块 id 与异常类名，
//      不含 data 明细与异常文本），异常文本写进该事件的 lastError，请求照常返回 ——
//      数据此刻已经提交，订阅方的失败不能把这次请求变成 500。
//
// ===== 信封 =====
//   { id, type, occurredAt, actorId, subject: { userId?, deptId? }, data, version: 1 }
//   id          "ev-" + UUIDv7 形状（按时间有序，见 newEventId）
//   type        "<实体>.<动作>"，小写，如 employee.transferred（TYPE_RE）
//   occurredAt  ISO 8601（UTC，带 Z）
//   actorId     发起这次变更的登录用户 id；没有登录用户（Lark 首登自动建号、脚本）时为 null
//   subject     事件的主体：人事事件带 userId，部门事件带 deptId；两者都可缺省
//   data        只放 id、部门名、状态等必要字段。safeClone 拒绝密码/令牌/会话/联系方式
//               一类的键名，encodeData 拒绝超过 MAX_DATA_BYTES 的 data —— 事件不是整行快照，
//               订阅方需要更多字段时按 subject 的 id 去读 core。
//   信封与 data 深冻结：同一个事件会依次交给多个订阅方，谁也不能改掉后面的人看到的内容。
//
// ===== 请求上下文 =====
// actorId 来自 AsyncLocalStorage（node:async_hooks，内置）：server.js handleApi 在解析出会话之后
// 调用 enterContext({ actorId, requestId })，此后这个请求里任何 await 之后的写库都带着同一个
// actorId，并发请求互不串（test/events-bus.test.js 有交错 await 的用例）。脚本与测试可用
// runWithContext(ctx, fn) 显式指定。
//
// ===== 已知边界 =====
//   · 绕过 store.js 直接写库的脚本（scripts/ 下多数维护脚本用裸 SQL）**不会产生事件**；
//     经 store.js 写函数的脚本会写发件箱行，但脚本进程没有接分发器，这些行保持
//     dispatchedAt = NULL、attempts = 0（「从未分发」），与「分发失败」可区分。
//   · 处理函数必须是同步函数：返回 Promise 的按失败记（异步部分已无法与事务/结果对齐）。
//   · 失败不自动重试：attempts / lastError 留给后续的补发任务或 Webhook 中继（M3）。
"use strict";
const crypto = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const EVENT_VERSION = 1;
const TYPE_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_]*)+$/;
// data 里禁止出现的键名（任意层级）。按「子串、不分大小写」匹配，宁可误拒：
// 误拒在开发期就会以异常暴露，漏放则是把敏感字段写进一张会被外部系统读取的表。
const FORBIDDEN_KEY_RE = /pass(word|wd)?(hash)?$|secret|token|session|cookie|credential|e[-_]?mail|phone|mobile|address|salt/i;
const MAX_DATA_BYTES = 4096;
const MAX_DATA_DEPTH = 4;
const DEFAULT_MAX_ROUNDS = 8;

// ---------- 请求上下文 ----------
const als = new AsyncLocalStorage();
function normalizeContext(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  return { actorId: c.actorId == null || c.actorId === "" ? null : String(c.actorId), requestId: c.requestId == null ? null : String(c.requestId) };
}
// 从调用点起、本次异步调用链的剩余部分都带着这个上下文（handleApi 用）。
function enterContext(ctx) { als.enterWith(normalizeContext(ctx)); }
// 只在 fn（及其异步延续）里生效（脚本、测试用）。
function runWithContext(ctx, fn) { return als.run(normalizeContext(ctx), fn); }
function currentContext() { return als.getStore() || null; }

// ---------- 信封 ----------
function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
// 校验 data 并按 JSON 语义复制、冻结（一次遍历）：拒绝禁用键名、非普通对象、函数/symbol/bigint、
// 超过 MAX_DATA_DEPTH 的嵌套；对象里的 undefined 去掉，数组里的 undefined 与非有限数字变 null。
// 复制断开与调用方对象的引用；冻结保证同一事件依次交给多个订阅方时谁也改不了它。
// path 只在报错时拼成文字（4,000 行批量里每个事件都要走一遍，不为正常路径拼字符串）。
const pathText = (path) => "data" + path.map((p) => (typeof p === "number" ? `[${p}]` : "." + p)).join("");
function safeClone(v, path, depth) {
  if (depth > MAX_DATA_DEPTH) throw new Error(`event ${pathText(path)}: nested deeper than ${MAX_DATA_DEPTH} levels`);
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) { path.push(i); out[i] = v[i] === undefined ? null : safeClone(v[i], path, depth + 1); path.pop(); }
    return Object.freeze(out);
  }
  if (v === null || typeof v !== "object") {
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error(`event ${pathText(path)}: ${typeof v} is not JSON data`);
    return typeof v === "number" && !Number.isFinite(v) ? null : v;
  }
  if (!isPlainObject(v)) throw new Error(`event ${pathText(path)}: only plain objects are allowed`);
  const o = {};
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEY_RE.test(k)) throw new Error(`event ${pathText(path)}: key "${k}" is not allowed in event data (credentials / contact details stay out of events)`);
    if (v[k] === undefined) continue;
    path.push(k); o[k] = safeClone(v[k], path, depth + 1); path.pop();
  }
  return Object.freeze(o);
}
// 只校验、不要副本时用（对外导出，便于模块自检自己的 data）。
function assertSafeData(data) { safeClone(data, [], 0); }
// 事件 id：「ev-」+ UUIDv7 形状（前 48 位是毫秒时间戳，随后 12 位是同一毫秒内的递增序号）。
// 按时间有序，发件箱主键索引的插入总落在 B 树末端 —— 随机 UUID 在表长到几万行后每批 4,000 行
// 的插入会从约 40ms 涨到 200ms 以上（2026-09 实测）。本进程内严格递增（时钟回拨也不倒退）；
// 末尾 62 个随机位取自 randomUUID，不同进程（服务与脚本）同一毫秒生成的 id 也不会撞。
let lastIdMs = 0;
let idSeq = 0;
function newEventId() {
  let ms = Date.now();
  if (ms <= lastIdMs) {
    ms = lastIdMs;
    if (++idSeq > 0xfff) { ms = ++lastIdMs; idSeq = 0; }
  } else { lastIdMs = ms; idSeq = 0; }
  const r = crypto.randomUUID();   // xxxxxxxx-xxxx-4xxx-Vxxx-xxxxxxxxxxxx（V = RFC 9562 变体位）
  const t = ms.toString(16).padStart(12, "0");
  return `ev-${t.slice(0, 8)}-${t.slice(8, 12)}-7${idSeq.toString(16).padStart(3, "0")}-${r.slice(19, 23)}-${r.slice(24)}`;
}
// createEnvelope({ type, subject, data, actorId?, occurredAt? }) → 冻结的信封。
// actorId 缺省取当前请求上下文；显式传 null 表示「系统」。
function createEnvelope({ type, subject, data, actorId, occurredAt } = {}) {
  if (typeof type !== "string" || !TYPE_RE.test(type)) throw new Error(`event type ${JSON.stringify(type)} must look like "entity.action" (${TYPE_RE})`);
  const s = subject == null ? {} : subject;
  if (!isPlainObject(s)) throw new Error("event subject must be an object { userId?, deptId? }");
  for (const k of Object.keys(s)) if (k !== "userId" && k !== "deptId") throw new Error(`event subject: unknown key "${k}"`);
  const subj = {};
  if (s.userId != null && s.userId !== "") subj.userId = String(s.userId);
  if (s.deptId != null && s.deptId !== "") subj.deptId = String(s.deptId);
  const d = data == null ? {} : data;
  if (!isPlainObject(d)) throw new Error("event data must be a plain object");
  const frozenData = safeClone(d, [], 0);
  const ctx = currentContext();
  const actor = actorId !== undefined ? actorId : ctx ? ctx.actorId : null;
  return Object.freeze({
    id: newEventId(),
    type,
    occurredAt: occurredAt || new Date().toISOString(),
    actorId: actor == null || actor === "" ? null : String(actor),
    subject: Object.freeze(subj),
    data: frozenData,
    version: EVENT_VERSION,
  });
}
// 发件箱 data 列的 JSON 文本；超过 MAX_DATA_BYTES 抛错（调用方在事务里，整笔回滚）。
function encodeData(envelope) {
  const s = JSON.stringify(envelope.data);
  if (Buffer.byteLength(s, "utf8") > MAX_DATA_BYTES)
    throw new Error(`event ${envelope.type}: data is larger than ${MAX_DATA_BYTES} bytes — put ids in the event, not whole records`);
  return s;
}

// 写进 lastError 的异常文本：一行、截断、形如凭据的长 hex 串替换掉（与 server.js batchErrorLogText 同口径）。
const ERROR_TEXT_MAX = 500;
function errorText(e) {
  let s = e && typeof e === "object" ? `${e.name || "Error"}: ${e.message || ""}` : String(e);
  s = s.replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/[\r\n]+/g, " | ");
  return s.length > ERROR_TEXT_MAX ? s.slice(0, ERROR_TEXT_MAX) + "…" : s;
}
function errorName(e) {
  return e && typeof e === "object" && typeof e.name === "string" && /^[A-Za-z_$][\w$]{0,60}$/.test(e.name) ? e.name : "Error";
}

// ---------- 分发总线 ----------
// createBus({ subscriptions, services, moduleServices, isModuleOn, record, log, maxRounds })
//   subscriptions  [{ module, type, fn }]，kernel/registry.js 生成（modules/index.js 顺序）
//   services       交给处理函数的只读服务（ctx.services），由 server.js 提供。可以是对象（原样
//                  交出去），也可以是工厂函数 () => 对象：工厂在**每一轮分发**里第一次有处理函数
//                  要运行时调用一次，这一轮的所有事件、所有订阅方共用它的返回值；下一轮重新调用。
//                  server.js 用工厂让一轮里的 hodOf / deptLevelsOf 共用一个组织快照 —— 4,000 人的
//                  批量调动是一轮 4,000 个事件，逐个重建快照（全表读 users + 推算）会把这次请求
//                  卡住几十秒。处理函数里写库并触发了新事件（publish 在分发中被调用）时，本轮
//                  剩余的事件改用新的一份服务（快照随之作废重建），不会读到自己刚改掉的旧值。
//   moduleServices 可选，(moduleId) => 该模块自己的 services（第二段，CONTRACT.md 4.13 末段、6.2）。分发时按模块
//                  惰性调用（每一轮每个模块最多一次；EVENT_BUS 在 store.init() 之前创建，而模块的 services 要等
//                  模块迁移完成后才组装，所以只能在分发时取）。返回值：
//                    对象       ctx.services 就是它（同一引用：culture 的钩子与工厂拿到的是同一个冻结对象）；
//                    undefined  该模块没有自己的 services（core 与 M0 模块），照旧用上面的 services；
//                    其它（null）该模块的 services 尚未组装（启动失败的中间态）：跳过它的处理函数、按失败记
//                               （发件箱 lastError），**不回退**到共用的 services；每轮每个模块只记一行日志。
//                  调用本身抛异常按「尚未组装」处理。
//   isModuleOn     (moduleId) => boolean；可售模块被关掉时它的处理函数不运行（关掉的模块
//                  不做后台工作，与「关闭模块只关入口、不删数据」一致：数据原样留着）。
//                  每一轮每个模块只问一次（server.js 的实现要读 config.json）。
//   record         (results) => void，把 [{ id, type, ok, error, handlers }] 写回发件箱
//   log            一行文本的日志函数，默认 console.error
//   maxRounds      处理函数里再触发的事件算下一轮；超过这个轮数的不再分发、按失败记，
//                  防止两个订阅方互相触发成死循环
// publish(events, then?) 同步执行；在处理函数里触发的新事件排进同一个队列，本轮结束后再分发（不递归）。
//   then：可选，这批事件分发完之后要执行的回调（store.transaction 的 afterCommit 回调，CONTRACT.md 4.2）。
//   不在分发中时 publish 同步分发完整个队列才返回，then 不接手（返回 undefined，由调用方自己接着执行）；
//   正在分发中（处理函数里开的事务提交了）时事件只是排队，then 排在这批事件之后、由分发循环执行，publish 返回 true。
//   then 自己的异常由调用方的包装处理（store 的 runAfterCommit 只记日志），这里再兜一层，不打断分发。
function createBus(opts = {}) {
  const subscriptions = Array.isArray(opts.subscriptions) ? opts.subscriptions : [];
  const makeServices = typeof opts.services === "function" ? opts.services : null;
  const fixedServices = makeServices ? null : opts.services || {};
  const moduleServices = typeof opts.moduleServices === "function" ? opts.moduleServices : null;
  const isModuleOn = typeof opts.isModuleOn === "function" ? opts.isModuleOn : () => true;
  const record = typeof opts.record === "function" ? opts.record : null;
  const log = typeof opts.log === "function" ? opts.log : (line) => console.error(line);
  const maxRounds = Number.isInteger(opts.maxRounds) && opts.maxRounds >= 0 ? opts.maxRounds : DEFAULT_MAX_ROUNDS;
  const byType = new Map();
  for (const s of subscriptions) {
    if (!s || typeof s.fn !== "function") continue;
    if (!byType.has(s.type)) byType.set(s.type, []);
    byType.get(s.type).push(s);
  }
  // 一轮分发内的缓存：服务对象、每个模块的 ctx、每个模块的开关。每轮开始时清空（resetRound）；
  // 处理函数触发了新事件时只作废服务与 ctx（开关不会因写库而变）。
  let roundServices = null;
  let ctxByModule = new Map();
  let onByModule = new Map();
  let notReadyLogged = new Set();   // 本轮已记过「services 尚未组装」的模块
  const resetServices = () => { roundServices = null; ctxByModule = new Map(); };
  const resetRound = () => { resetServices(); onByModule = new Map(); notReadyLogged = new Set(); };
  const servicesNow = () => {
    if (!makeServices) return fixedServices;
    if (!roundServices) roundServices = makeServices() || {};
    return roundServices;
  };
  // → 冻结的 { moduleId, services }；该模块自己的 services 尚未组装时为 null（见 moduleServices）。
  const ctxFor = (moduleId) => {
    if (!ctxByModule.has(moduleId)) {
      let services;
      let own;
      if (moduleServices) { try { own = moduleServices(moduleId); } catch { own = null; } }
      if (own === undefined) services = servicesNow();
      else if (own && typeof own === "object") services = own;
      else { ctxByModule.set(moduleId, null); return null; }
      ctxByModule.set(moduleId, Object.freeze({ moduleId, services }));
    }
    return ctxByModule.get(moduleId);
  };
  const moduleOn = (id) => {
    if (!onByModule.has(id)) {
      let on;
      try { on = isModuleOn(id) !== false; } catch { on = true; }
      onByModule.set(id, on);
    }
    return onByModule.get(id);
  };

  function dispatchOne(event) {
    const subs = byType.get(event.type) || [];
    const errors = [];
    let ran = 0;
    for (const s of subs) {
      if (!moduleOn(s.module)) continue;
      const ctx = ctxFor(s.module);
      if (!ctx) {
        errors.push(`${s.module}: kernel: the module's services are not ready (handler not run)`);
        if (!notReadyLogged.has(s.module)) {
          notReadyLogged.add(s.module);
          log(`[events] handler skipped: ${event.type} ${event.id} (module ${s.module}, services not ready; logged once per round)`);
        }
        continue;
      }
      ran++;
      try {
        const r = s.fn(event, ctx);
        if (r && typeof r.then === "function") {
          if (typeof r.catch === "function") r.catch(() => {});
          throw new TypeError("event handlers must be synchronous (the handler returned a Promise)");
        }
      } catch (e) {
        errors.push(`${s.module}: ${errorText(e)}`);
        log(`[events] handler failed: ${event.type} ${event.id} (module ${s.module}, ${errorName(e)})`);
      }
    }
    return { id: event.id, type: event.type, ok: errors.length === 0, error: errors.length ? errors.join(" | ").slice(0, 1000) : null, handlers: ran };
  }

  const queue = [];
  let draining = false;
  let currentRound = 0;
  function publish(events, then) {
    if (!Array.isArray(events) || !events.length) return undefined;
    const round = draining ? currentRound + 1 : 0;
    for (const e of events) queue.push({ event: e, round });
    // 在处理函数里触发的：排队，由外层循环接着分发。它意味着处理函数刚提交了一笔写 ——
    // 本轮后面的事件换一份新服务（组织快照重建），别拿提交之前的快照回答。
    if (draining) {
      if (typeof then === "function") queue.push({ then });
      resetServices();
      return typeof then === "function" ? true : undefined;
    }
    draining = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0);
        resetRound();
        const results = [];
        for (const item of batch) {
          if (item.then) {   // 排在它前面的那批事件已分发完：执行那笔事务的 afterCommit 回调
            try { item.then(); } catch (e) { log(`[events] after-commit callback failed (${errorName(e)})`); }
            continue;
          }
          currentRound = item.round;
          if (item.round > maxRounds) {
            log(`[events] not dispatched: ${item.event.type} ${item.event.id} (chain deeper than ${maxRounds} rounds)`);
            results.push({ id: item.event.id, type: item.event.type, ok: false, error: `kernel: dispatch chain deeper than ${maxRounds} rounds`, handlers: 0 });
            continue;
          }
          results.push(dispatchOne(item.event));
        }
        currentRound = 0;
        if (record) {
          try { record(results); }
          catch (e) { log(`[events] outbox write-back failed for ${results.length} event(s) (${errorName(e)})`); }
        }
      }
    } finally {
      draining = false;
      currentRound = 0;
      resetRound();   // 不把快照留到下一次 publish：两次请求之间的写没有失效信号
    }
  }

  return Object.freeze({
    publish,
    // 该类型有没有订阅方（与模块开关无关）。store.setEventSink 的 needsDispatch 用它：没有订阅方的
    // 事件写入时即记为已分发，不进待分发队列。
    hasSubscribers: (type) => byType.has(type),
    subscribers: (type) => (byType.get(type) || []).map((s) => s.module),
  });
}

module.exports = {
  EVENT_VERSION, TYPE_RE, MAX_DATA_BYTES,
  createEnvelope, encodeData, assertSafeData, errorText,
  enterContext, runWithContext, currentContext,
  createBus,
};
