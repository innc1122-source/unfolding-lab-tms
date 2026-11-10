// 内核 · 模块定时任务调度（modules/culture/CONTRACT.md 第 7 节；PHASE2-KERNEL.md 3.2）。
//
// 模块只导出任务函数（工厂返回的 jobs，按 manifest jobs[].id 取），不自带定时器；什么时候跑由这里决定：
//   · 任务清单来自注册表的 JOBS：[{ module, id, minute, hour }]（manifest 的 cron 子集「分 时 * * *」）。
//   · cron 按该模块 services.tz（offsetMinutes，部署时区 +08:00 = 480）解释；「现在」取该模块的 services.now()，
//     所以 LMS_FAKE_NOW（非生产）同样驱动调度。
//   · 每分钟检查一次（setInterval，unref：不拖住进程退出）。某任务「今天」（按时区）的计划时刻已过、且上次运行
//     不在「今天的计划时刻 → 明天的计划时刻」之间，就运行一次：定时检查时 trigger 为 "schedule"，启动时的第一次
//     检查为 "catchup"（停机错过了今天的计划时刻就补跑一次；更早的日子不补 —— 任务函数每次都处理「到现在为止」
//     的全部事情，并且可以安全重复执行）。时钟倒退到上次运行之前的日子时照常按「今天没跑过」处理。
//   · 上次运行时刻记在 meta 表，键 job:<moduleId>.<jobId>，值为 ISO 字符串（取运行时的 services.now()）。
//     运行失败也记（不在下一分钟反复重试：失败日志每分钟一行、每次都占住事件循环；第二天照常再跑）。
//   · 模块关闭时跳过，不记时刻（关闭只关入口；重新打开后当天的计划时刻已过就在下一次检查时补跑）。
//   · 同一任务不重叠：正在运行时再被触发（手动触发、任务函数里间接触发）直接跳过。
//   · 每次执行都包在 runWithContext({ actorId: null, requestId: "job-<moduleId>.<jobId>" }) 里：定时器回调会继承
//     创建它时的异步上下文，若调度器是在某个请求里被首次启动的，任务写出的审计与事件就会记到那个用户名下。
//   · 任务函数同步执行、自己调用 services.transaction；返回小的 JSON 摘要（计数、耗时），这里记一行日志。
//     异常只记一行 [jobs] <moduleId>.<jobId> failed (<异常类名>)，不外抛、不影响别的任务。
//
// 用法（server.js，模块迁移与工厂调用之后、listen 之前）：
//   const scheduler = createScheduler({
//     jobs: REGISTRY.JOBS,
//     jobFns: (moduleId) => factories.get(moduleId).jobs,        // 工厂返回的 { jobId: fn }
//     services: (moduleId) => moduleServices.get(moduleId),      // 取 now() 与 tz
//     isModuleOn: (moduleId) => modulesOn()[moduleId] !== false,
//     getMeta: store.getMeta, setMeta: store.setMeta,
//   });
//   scheduler.start();   // 下一轮事件循环做一次 catchup 检查，之后每分钟检查一次
"use strict";
const events = require("./events.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OFFSET_MINUTES = 480;   // +08:00
const DEFAULT_INTERVAL_MS = 60 * 1000;
const SUMMARY_LOG_MAX = 300;

const metaKeyOf = (moduleId, jobId) => `job:${moduleId}.${jobId}`;
function offsetOf(services) {
  const tz = services && services.tz;
  return tz && typeof tz.offsetMinutes === "number" && Number.isFinite(tz.offsetMinutes) ? tz.offsetMinutes : DEFAULT_OFFSET_MINUTES;
}
// 按时区的「今天」00:00 对应的 UTC 毫秒。
function localDayStart(nowMs, offsetMinutes) {
  const off = offsetMinutes * 60000;
  return Math.floor((nowMs + off) / DAY_MS) * DAY_MS - off;
}
// 今天（按时区）该任务的计划时刻（UTC 毫秒）。
function scheduledToday(nowMs, job, offsetMinutes) {
  return localDayStart(nowMs, offsetMinutes) + (job.hour * 60 + job.minute) * 60000;
}
// 是否该跑：今天的计划时刻已过，且上次运行不在 [今天计划时刻, 明天计划时刻) 之间。
function isDue(nowMs, job, offsetMinutes, lastRunMs) {
  const at = scheduledToday(nowMs, job, offsetMinutes);
  if (nowMs < at) return false;
  if (lastRunMs == null || !Number.isFinite(lastRunMs)) return true;
  return !(lastRunMs >= at && lastRunMs < at + DAY_MS);
}
function errorName(e) {
  return e && typeof e === "object" && typeof e.name === "string" && /^[A-Za-z_$][\w$]{0,60}$/.test(e.name) ? e.name : "Error";
}
function summaryText(summary) {
  if (summary === undefined) return "";
  let s;
  try { s = JSON.stringify(summary); } catch { return " (summary not JSON)"; }
  if (typeof s !== "string") return "";
  s = s.replace(/[0-9a-f]{32,}/gi, "[redacted]");
  return " " + (s.length > SUMMARY_LOG_MAX ? s.slice(0, SUMMARY_LOG_MAX) + "…" : s);
}

// createScheduler(opts)
//   jobs        [{ module, id, minute, hour }]（注册表 JOBS）
//   jobFns      (moduleId) => { jobId: fn } | null，或直接给 { moduleId: { jobId: fn } }
//   services    (moduleId) => 该模块的 services（用 now() 与 tz），或直接给 { moduleId: services }
//   isModuleOn  (moduleId) => boolean（缺省恒开；抛异常按开启处理，与事件总线同一口径）
//   getMeta / setMeta   store.getMeta / store.setMeta（上次运行时刻）
//   log         一行文本的日志函数，缺省 console.error
//   intervalMs  检查间隔，缺省 60 秒
//   timers      { setInterval, clearInterval, setImmediate }（测试注入；缺省用全局的）
function createScheduler(opts = {}) {
  const jobs = Array.isArray(opts.jobs) ? opts.jobs.filter((j) => j && typeof j.module === "string" && typeof j.id === "string"
    && Number.isInteger(j.minute) && Number.isInteger(j.hour)) : [];
  const lookup = (src) => (typeof src === "function" ? src : (id) => (src && typeof src === "object" ? src[id] : undefined));
  const jobFnsOf = lookup(opts.jobFns);
  const servicesOf = lookup(opts.services);
  const isModuleOn = typeof opts.isModuleOn === "function" ? opts.isModuleOn : () => true;
  const getMeta = typeof opts.getMeta === "function" ? opts.getMeta : () => null;
  const setMeta = typeof opts.setMeta === "function" ? opts.setMeta : () => {};
  const log = typeof opts.log === "function" ? opts.log : (line) => console.error(line);
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const timers = {
    setInterval: (opts.timers && opts.timers.setInterval) || setInterval,
    clearInterval: (opts.timers && opts.timers.clearInterval) || clearInterval,
    setImmediate: (opts.timers && opts.timers.setImmediate) || setImmediate,
  };

  const running = new Set();
  const warned = new Set();          // 只记一次的告警（缺任务函数、缺 services）
  const state = new Map();           // key -> { lastResult, lastError, lastDurationMs, lastTrigger }
  let timer = null;
  const warnOnce = (key, line) => { if (!warned.has(key)) { warned.add(key); log(line); } };
  const moduleOn = (id) => { try { return isModuleOn(id) !== false; } catch { return true; } };
  const readLast = (key) => {
    let v = null;
    try { v = getMeta(key); } catch { v = null; }
    if (v == null || v === "") return { iso: null, ms: null };
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? { iso: String(v), ms } : { iso: null, ms: null };
  };

  // 执行一个任务（已判定该跑）。返回 { ran: true, ok, summary? } 或 { skipped: 原因 }。
  function execute(job, trigger, now, lastIso) {
    const key = `${job.module}.${job.id}`;
    if (running.has(key)) return { skipped: "running" };
    let fns = null;
    try { fns = jobFnsOf(job.module); } catch { fns = null; }
    const fn = fns && typeof fns === "object" ? fns[job.id] : null;
    if (typeof fn !== "function") {
      warnOnce("fn:" + key, `[jobs] ${key} skipped: the module's factory returned no job function "${job.id}"`);
      return { skipped: "no_function" };
    }
    running.add(key);
    const started = Date.now();
    let ok = false;
    let summary;
    try {
      const jobCtx = Object.freeze({ jobId: job.id, now, trigger, lastRunAt: lastIso });
      summary = events.runWithContext({ actorId: null, requestId: "job-" + key }, () => {
        const r = fn(jobCtx);
        if (r && typeof r.then === "function") {
          if (typeof r.catch === "function") r.catch(() => {});
          throw new TypeError("job functions must be synchronous (the job returned a Promise)");
        }
        return r;
      });
      ok = true;
      log(`[jobs] ${key} done in ${Date.now() - started}ms (${trigger})${summaryText(summary)}`);
      state.set(key, { lastTrigger: trigger, lastDurationMs: Date.now() - started, lastError: null, lastResult: summary === undefined ? null : summary });
    } catch (e) {
      log(`[jobs] ${key} failed (${errorName(e)})`);
      state.set(key, { lastTrigger: trigger, lastDurationMs: Date.now() - started, lastError: errorName(e), lastResult: null });
    } finally {
      running.delete(key);
      try { setMeta(metaKeyOf(job.module, job.id), new Date(now).toISOString()); }
      catch (e) { log(`[jobs] ${key}: could not record the run time (${errorName(e)})`); }
    }
    return ok ? { ran: true, ok: true, summary } : { ran: true, ok: false };
  }

  // 检查一遍全部任务，跑该跑的。trigger："schedule"（定时检查）或 "catchup"（启动时）。
  // 返回 [{ module, id, ... execute 的结果 }]，只含实际尝试运行的任务。
  function check(trigger = "schedule") {
    const out = [];
    const onCache = new Map();
    for (const job of jobs) {
      if (!onCache.has(job.module)) onCache.set(job.module, moduleOn(job.module));
      if (!onCache.get(job.module)) continue;             // 模块关闭：跳过，不记时刻
      let services = null;
      try { services = servicesOf(job.module); } catch { services = null; }
      if (!services || typeof services.now !== "function") {
        warnOnce("svc:" + job.module, `[jobs] module ${job.module} has no services yet; its jobs are skipped`);
        continue;
      }
      let now;
      try { now = Number(services.now()); } catch { now = NaN; }
      if (!Number.isFinite(now)) { warnOnce("now:" + job.module, `[jobs] module ${job.module}: services.now() did not return a time; its jobs are skipped`); continue; }
      const last = readLast(metaKeyOf(job.module, job.id));
      if (!isDue(now, job, offsetOf(services), last.ms)) continue;
      out.push({ module: job.module, id: job.id, trigger, ...execute(job, trigger, now, last.iso) });
    }
    return out;
  }

  // 手动触发一个任务（运维排障用；模块内的手动重算走模块自己的接口）。模块关闭时不跑。
  function run(moduleId, jobId, trigger = "manual") {
    const job = jobs.find((j) => j.module === moduleId && j.id === jobId);
    if (!job) throw new Error(`jobs: no job ${moduleId}.${jobId}`);
    if (!moduleOn(moduleId)) return { skipped: "module_off" };
    let services = null;
    try { services = servicesOf(moduleId); } catch { services = null; }
    if (!services || typeof services.now !== "function") return { skipped: "no_services" };
    const now = Number(services.now());
    return execute(job, trigger, now, readLast(metaKeyOf(moduleId, jobId)).iso);
  }

  function start(startOpts = {}) {
    if (timer) return;
    const tick = () => { try { check("schedule"); } catch (e) { log(`[jobs] scheduler check failed (${errorName(e)})`); } };
    // 在「无操作人」的上下文里建定时器与补跑：不继承调用 start() 时所在请求的上下文（执行时另有 runWithContext）。
    events.runWithContext({ actorId: null, requestId: null }, () => {
      timer = timers.setInterval(tick, intervalMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      if (startOpts.catchup !== false) {
        timers.setImmediate(() => { try { check("catchup"); } catch (e) { log(`[jobs] catch-up check failed (${errorName(e)})`); } });
      }
    });
  }
  function stop() {
    if (timer) { timers.clearInterval(timer); timer = null; }
  }
  function status() {
    return jobs.map((j) => {
      const key = `${j.module}.${j.id}`;
      const s = state.get(key) || {};
      return {
        module: j.module, id: j.id, minute: j.minute, hour: j.hour,
        lastRunAt: readLast(metaKeyOf(j.module, j.id)).iso, running: running.has(key),
        lastTrigger: s.lastTrigger || null, lastError: s.lastError || null, lastDurationMs: s.lastDurationMs == null ? null : s.lastDurationMs,
      };
    });
  }

  return Object.freeze({ check, run, start, stop, status, get started() { return timer !== null; } });
}

module.exports = { createScheduler, isDue, scheduledToday, localDayStart, metaKeyOf, DEFAULT_OFFSET_MINUTES };
