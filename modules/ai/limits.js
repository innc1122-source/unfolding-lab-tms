// 限流与并发（方案 2.7）。计数存在内存里：单进程部署下足够（HANDOVER-IT §1），重启后清零无害。
//   · 按用户、按功能的滑动窗口：assistant 每人每 10 分钟 20 次且每天 100 次；questionGen 每人每小时 20 次；
//     portrait 每人每小时 30 次；test 每人每小时 30 次；translate、talentFilter（人才筛选条件生成）每人每小时 60 次。grading 不按用户限（不能拦截交卷），走评分队列。
//   · 两个并发池互不占用：交互功能（assistant、questionGen、portrait、test）ai.limits.concurrency（默认 4）；
//     简答题评分 ai.limits.gradingConcurrency（默认 8）。超出的排队，受各功能总时限约束。
//   · 演示模式的调用不计入限额（调用方在演示分支之前不调用 hit()）。
"use strict";

const DEFAULTS = {
  assistant: { perUser10Min: 20, perUserDay: 100 },
  questionGen: { perUserHour: 20 },
  translate: { perUserHour: 60 },
  talentFilter: { perUserHour: 60 },
  portrait: { perUserHour: 30 },
  test: { perUserHour: 30 },
  concurrency: 4,
  gradingConcurrency: 8,
  gradingMaxWaitMin: 30,
};
const posInt = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
function limitsFrom(cfg) {
  const l = cfg && cfg.ai && cfg.ai.limits && typeof cfg.ai.limits === "object" ? cfg.ai.limits : {};
  const sub = (k) => (l[k] && typeof l[k] === "object" ? l[k] : {});
  return {
    assistant: { perUser10Min: posInt(sub("assistant").perUser10Min, DEFAULTS.assistant.perUser10Min), perUserDay: posInt(sub("assistant").perUserDay, DEFAULTS.assistant.perUserDay), examIdleHours: posInt(sub("assistant").examIdleHours, 3) },
    questionGen: { perUserHour: posInt(sub("questionGen").perUserHour, DEFAULTS.questionGen.perUserHour) },
    translate: { perUserHour: posInt(sub("translate").perUserHour, DEFAULTS.translate.perUserHour) },
    talentFilter: { perUserHour: posInt(sub("talentFilter").perUserHour, DEFAULTS.talentFilter.perUserHour) },
    portrait: { perUserHour: posInt(sub("portrait").perUserHour, DEFAULTS.portrait.perUserHour) },
    test: { perUserHour: posInt(sub("test").perUserHour, DEFAULTS.test.perUserHour) },
    concurrency: Math.min(64, posInt(l.concurrency, DEFAULTS.concurrency)),
    gradingConcurrency: Math.min(64, posInt(l.gradingConcurrency, DEFAULTS.gradingConcurrency)),
    gradingMaxWaitMin: Math.min(24 * 60, posInt(l.gradingMaxWaitMin, DEFAULTS.gradingMaxWaitMin)),
  };
}

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
function windowsOf(feature, lim) {
  if (feature === "assistant") return [[10 * MIN, lim.assistant.perUser10Min], [DAY, lim.assistant.perUserDay]];
  if (feature === "questionGen") return [[HOUR, lim.questionGen.perUserHour]];
  if (feature === "translate") return [[HOUR, lim.translate.perUserHour]];
  if (feature === "talentFilter") return [[HOUR, lim.talentFilter.perUserHour]];
  if (feature === "portrait") return [[HOUR, lim.portrait.perUserHour]];
  if (feature === "test") return [[HOUR, lim.test.perUserHour]];
  return [];
}

function createRateLimiter(now = () => Date.now()) {
  const hits = new Map(); // `${feature}:${userId}` → [ts…]
  return {
    // 判定并登记一次调用。超限返回 { ok:false, retryAfterSec }，不登记。
    hit(feature, userId, lim) {
      const wins = windowsOf(feature, lim);
      if (!wins.length) return { ok: true };
      const key = feature + ":" + userId;
      const t = now();
      const list = (hits.get(key) || []).filter((x) => t - x < DAY);
      for (const [span, max] of wins) {
        const inWin = list.filter((x) => t - x < span);
        if (inWin.length >= max) {
          hits.set(key, list);
          return { ok: false, retryAfterSec: Math.max(1, Math.ceil((inWin[0] + span - t) / 1000)) };
        }
      }
      list.push(t);
      hits.set(key, list);
      return { ok: true };
    },
    reset() { hits.clear(); },
  };
}

// 并发池：run(fn, deadlineAt) 取到空位才执行；排队超过 deadlineAt 仍没轮到就放弃（onTimeout 抛出的错误）。
function createPool(sizeFn) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < sizeFn() && waiting.length) {
      const w = waiting.shift();
      if (w.cancelled) continue;
      clearTimeout(w.timer);
      active++;
      w.start();
    }
  };
  return {
    run(fn, deadlineAt, onTimeout) {
      return new Promise((resolve, reject) => {
        const w = {
          cancelled: false,
          start: () => { Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); }); },
        };
        const wait = deadlineAt ? deadlineAt - Date.now() : null;
        if (wait != null) w.timer = setTimeout(() => { w.cancelled = true; reject(onTimeout ? onTimeout() : new Error("queue timeout")); }, Math.max(0, wait));
        waiting.push(w);
        pump();
      });
    },
    get active() { return active; },
    get queued() { return waiting.filter((w) => !w.cancelled).length; },
  };
}

module.exports = { DEFAULTS, limitsFrom, createRateLimiter, createPool };
