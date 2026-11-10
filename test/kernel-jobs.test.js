// 第二段内核 · kernel/jobs.js 模块定时任务调度（modules/culture/CONTRACT.md 第 7 节；PHASE2-KERNEL.md 3.2）：
//   读注册表 JOBS 与工厂返回的 jobs；cron 按 services.tz（+08:00）解释、时间取 services.now()；今天的计划时刻已过且
//   今天没跑过才跑（启动时 trigger "catchup"，定时检查 "schedule"）；上次运行时刻记 meta（job:<module>.<id>）；
//   模块关闭跳过且不记时刻；同一任务不重叠；执行时清空操作人上下文；异常只记日志。
// 纯内存：假 services、假 meta、注入的定时器，不开库、不起服务。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const events = require("../kernel/events.js");
const jobsLib = require("../kernel/jobs.js");
const registry = require("../kernel/registry.js");

const at = (iso) => Date.parse(iso);
const JOBS = [
  { module: "demo", id: "program.daily", minute: 30, hour: 0 },
  { module: "demo", id: "leaderboard.nightly", minute: 0, hour: 2 },
  { module: "demo", id: "witness.remind", minute: 0, hour: 9 },
];
// 一套可调的假环境
function rig(opts = {}) {
  const clock = { now: at(opts.now || "2026-10-20T10:00:00+08:00") };
  const meta = new Map(Object.entries(opts.meta || {}));
  const calls = [];
  const logs = [];
  let on = opts.on !== undefined ? opts.on : true;
  const fns = {};
  for (const j of opts.jobs || JOBS) {
    fns[j.id] = (ctx) => {
      const c = events.currentContext();
      calls.push({ id: j.id, trigger: ctx.trigger, now: ctx.now, lastRunAt: ctx.lastRunAt, actorId: c && c.actorId, requestId: c && c.requestId, frozen: Object.isFrozen(ctx), jobId: ctx.jobId });
      return { rows: 1 };
    };
  }
  Object.assign(fns, opts.fns || {});
  const services = Object.freeze({ now: () => clock.now, tz: Object.freeze({ offsetMinutes: 480, label: "+08:00" }) });
  const timers = { intervals: [], immediates: [], cleared: [] };
  const sched = jobsLib.createScheduler({
    jobs: opts.jobs || JOBS,
    jobFns: opts.jobFns || ((id) => (id === "demo" ? fns : null)),
    services: opts.services || ((id) => (id === "demo" ? services : null)),
    isModuleOn: (id) => (typeof on === "function" ? on(id) : on),
    getMeta: (k) => (meta.has(k) ? meta.get(k) : null),
    setMeta: (k, v) => meta.set(k, String(v)),
    log: (line) => logs.push(line),
    timers: {
      setInterval: (fn, ms) => { const h = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; timers.intervals.push(h); return h; },
      clearInterval: (h) => timers.cleared.push(h),
      setImmediate: (fn) => timers.immediates.push({ fn, ctx: events.currentContext() }),
    },
  });
  return { sched, clock, meta, calls, logs, fns, timers, setOn: (v) => { on = v; }, set: (iso) => { clock.now = at(iso); } };
}

test("jobs: cron times are read in +08:00 — a job is due once today's local time has passed and it has not run since", () => {
  const job = { minute: 0, hour: 2 };
  const off = 480;
  assert.equal(new Date(jobsLib.scheduledToday(at("2026-10-20T01:59:59+08:00"), job, off)).toISOString(), "2026-10-19T18:00:00.000Z");
  assert.equal(new Date(jobsLib.scheduledToday(at("2026-10-20T23:30:00+08:00"), job, off)).toISOString(), "2026-10-19T18:00:00.000Z", "late evening is still the same local day");
  assert.equal(new Date(jobsLib.scheduledToday(at("2026-10-19T16:30:00Z"), { minute: 30, hour: 0 }, off)).toISOString(), "2026-10-19T16:30:00.000Z", "00:30 +08:00 is 16:30 UTC the day before");
  assert.equal(jobsLib.isDue(at("2026-10-20T01:59:59+08:00"), job, off, null), false);
  assert.equal(jobsLib.isDue(at("2026-10-20T02:00:00+08:00"), job, off, null), true);
  assert.equal(jobsLib.isDue(at("2026-10-20T02:00:30+08:00"), job, off, at("2026-10-19T02:00:05+08:00")), true, "yesterday's run does not count for today");
  assert.equal(jobsLib.isDue(at("2026-10-20T09:00:00+08:00"), job, off, at("2026-10-20T02:00:10+08:00")), false, "already ran today");
  assert.equal(jobsLib.isDue(at("2026-10-20T09:00:00+08:00"), job, off, at("2026-11-02T02:00:00+08:00")), true, "a clock set back before the last run: today counts as not run");
  assert.equal(jobsLib.metaKeyOf("culture", "leaderboard.nightly"), "job:culture.leaderboard.nightly");
});

test("jobs: at startup every job whose time already passed today runs once as catchup (with the last run time), and a second check runs nothing", () => {
  const r = rig({ now: "2026-10-20T10:00:00+08:00", meta: { "job:demo.leaderboard.nightly": "2026-10-19T02:00:03.000Z" } });
  const out = r.sched.check("catchup");
  assert.deepEqual(out.map((x) => [x.id, x.trigger, x.ran, x.ok]), [
    ["program.daily", "catchup", true, true], ["leaderboard.nightly", "catchup", true, true], ["witness.remind", "catchup", true, true],
  ]);
  assert.deepEqual(r.calls.map((c) => [c.id, c.trigger, c.lastRunAt]), [
    ["program.daily", "catchup", null], ["leaderboard.nightly", "catchup", "2026-10-19T02:00:03.000Z"], ["witness.remind", "catchup", null],
  ]);
  for (const c of r.calls) { assert.equal(c.now, r.clock.now); assert.equal(c.frozen, true); }
  for (const j of JOBS) assert.equal(r.meta.get("job:demo." + j.id), "2026-10-20T02:00:00.000Z", "run time = services.now() as ISO");
  assert.deepEqual(r.sched.check("schedule"), []);
  assert.equal(r.calls.length, 3);
  assert.ok(r.logs.some((l) => /^\[jobs\] demo\.leaderboard\.nightly done in \d+ms \(catchup\) \{"rows":1\}$/.test(l)), r.logs.join("\n"));
});

test("jobs: before a job's time nothing runs; the minute check after it runs it as schedule; the next day it runs again", () => {
  const r = rig({ now: "2026-10-20T00:10:00+08:00" });
  assert.deepEqual(r.sched.check("catchup"), [], "00:10 — every job's time is still ahead today");
  r.set("2026-10-20T00:30:00+08:00");
  assert.deepEqual(r.sched.check().map((x) => [x.id, x.trigger]), [["program.daily", "schedule"]]);
  r.set("2026-10-20T02:00:59+08:00");
  assert.deepEqual(r.sched.check().map((x) => x.id), ["leaderboard.nightly"]);
  r.set("2026-10-20T08:59:00+08:00");
  assert.deepEqual(r.sched.check(), []);
  r.set("2026-10-20T09:03:00+08:00");   // 检查错过了 09:00 整点（事件循环被占住）：09:03 照样跑
  assert.deepEqual(r.sched.check().map((x) => x.id), ["witness.remind"]);
  r.set("2026-10-21T00:31:00+08:00");
  assert.deepEqual(r.sched.check().map((x) => [x.id, x.trigger]), [["program.daily", "schedule"]]);
  assert.equal(r.calls.at(-1).lastRunAt, "2026-10-19T16:30:00.000Z", "lastRunAt is the previous day's run");
});

test("jobs: a module that is off is skipped and its run time is not recorded; switched back on, today's missed job runs at the next check", () => {
  const r = rig({ now: "2026-10-20T10:00:00+08:00", on: false });
  assert.deepEqual(r.sched.check("catchup"), []);
  assert.equal(r.calls.length, 0);
  assert.equal(r.meta.size, 0, "nothing recorded while off");
  assert.deepEqual(r.sched.run("demo", "leaderboard.nightly"), { skipped: "module_off" });
  r.setOn(() => { throw new Error("config unreadable"); });   // 读开关出错按开启处理（与事件总线同一口径）
  assert.equal(r.sched.check().length, 3);
});

test("jobs: every run clears the operator — actorId null and requestId job-<module>.<id>, even when the check is triggered inside a request's context", () => {
  const r = rig({ now: "2026-10-20T10:00:00+08:00" });
  events.runWithContext({ actorId: "u-hr", requestId: "req-7" }, () => r.sched.check("catchup"));
  assert.deepEqual(r.calls.map((c) => [c.actorId, c.requestId]), [
    [null, "job-demo.program.daily"], [null, "job-demo.leaderboard.nightly"], [null, "job-demo.witness.remind"],
  ]);
  assert.equal(r.calls[0].jobId, "program.daily");
});

test("jobs: failures only log [jobs] <module>.<id> failed (<class>) — other jobs still run, the attempt is recorded (no retry every minute), async jobs count as failures", () => {
  const r = rig({
    now: "2026-10-20T10:00:00+08:00",
    fns: {
      "program.daily": () => { throw new RangeError("secret 0123456789abcdef0123456789abcdef"); },
      "leaderboard.nightly": async () => ({}),
    },
  });
  const out = r.sched.check("catchup");
  assert.deepEqual(out.map((x) => [x.id, x.ok]), [["program.daily", false], ["leaderboard.nightly", false], ["witness.remind", true]]);
  assert.ok(r.logs.includes("[jobs] demo.program.daily failed (RangeError)"));
  assert.ok(r.logs.includes("[jobs] demo.leaderboard.nightly failed (TypeError)"));
  assert.ok(!r.logs.join("\n").includes("secret"), "no exception text in the log");
  assert.equal(r.meta.get("job:demo.program.daily"), "2026-10-20T02:00:00.000Z");
  assert.deepEqual(r.sched.check(), [], "a failed job is not retried at the next minute");
  const st = r.sched.status().find((s) => s.id === "program.daily");
  assert.equal(st.lastError, "RangeError");
  assert.equal(st.lastRunAt, "2026-10-20T02:00:00.000Z");
});

test("jobs: the same job never overlaps itself — a trigger while it is running is skipped", () => {
  let inner = null;
  let r;
  r = rig({
    now: "2026-10-20T10:00:00+08:00",
    jobs: [{ module: "demo", id: "leaderboard.nightly", minute: 0, hour: 2 }],
    fns: { "leaderboard.nightly": () => { inner = r.sched.run("demo", "leaderboard.nightly"); return { ok: 1 }; } },
  });
  const out = r.sched.check("catchup");
  assert.equal(out[0].ok, true);
  assert.deepEqual(inner, { skipped: "running" });
  assert.equal(r.sched.status()[0].running, false, "released after the run");
  // 手动触发：跑一次，记时刻，trigger 为 manual
  r.fns["leaderboard.nightly"] = (ctx) => ({ trigger: ctx.trigger });
  assert.deepEqual(r.sched.run("demo", "leaderboard.nightly"), { ran: true, ok: true, summary: { trigger: "manual" } });
  assert.throws(() => r.sched.run("demo", "nope"), /no job demo\.nope/);
});

test("jobs: a missing job function or missing services is logged once and skipped (no time recorded)", () => {
  const r = rig({ now: "2026-10-20T10:00:00+08:00", jobFns: () => ({}) });
  assert.deepEqual(r.sched.check("catchup").map((x) => x.skipped), ["no_function", "no_function", "no_function"]);
  r.sched.check("catchup");
  assert.equal(r.logs.filter((l) => l.includes('returned no job function "program.daily"')).length, 1, "logged once");
  assert.equal(r.meta.size, 0);
  const r2 = rig({ services: () => null });
  assert.deepEqual(r2.sched.check("catchup"), []);
  r2.sched.check();
  assert.deepEqual(r2.logs, ["[jobs] module demo has no services yet; its jobs are skipped"]);
});

test("jobs: start() schedules one catch-up check on the next turn and a one-minute interval that does not keep the process alive, both outside any request context; stop() clears it", () => {
  const r = rig({ now: "2026-10-20T10:00:00+08:00" });
  events.runWithContext({ actorId: "u-hr", requestId: "req-1" }, () => r.sched.start());
  assert.equal(r.timers.intervals.length, 1);
  assert.equal(r.timers.intervals[0].ms, 60000);
  assert.equal(r.timers.intervals[0].unrefed, true);
  assert.equal(r.timers.immediates.length, 1);
  assert.deepEqual(r.timers.immediates[0].ctx, { actorId: null, requestId: null }, "timers are created in an operator-free context");
  assert.equal(r.calls.length, 0, "the catch-up waits for the next turn of the event loop");
  r.timers.immediates[0].fn();
  assert.deepEqual(r.calls.map((c) => c.trigger), ["catchup", "catchup", "catchup"]);
  r.set("2026-10-21T09:00:00+08:00");
  r.timers.intervals[0].fn();
  assert.deepEqual(r.calls.slice(3).map((c) => [c.id, c.trigger]), [["program.daily", "schedule"], ["leaderboard.nightly", "schedule"], ["witness.remind", "schedule"]]);
  assert.equal(r.sched.started, true);
  r.sched.start();
  assert.equal(r.timers.intervals.length, 1, "start() twice does not add a second interval");
  r.sched.stop();
  assert.deepEqual(r.timers.cleared, [r.timers.intervals[0]]);
  assert.equal(r.sched.started, false);
  const r2 = rig();
  r2.sched.start({ catchup: false });
  assert.equal(r2.timers.immediates.length, 0);
  r2.sched.stop();
});

