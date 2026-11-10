"use strict";
// 日期与工作日（简化 10/11 从 server.js 抽出，函数与注释原样搬）。「今天」一律按马尼拉日（UTC+8，无夏令时）；
// nowMs() 是测试时钟的唯一入口（LMS_FAKE_NOW，只在测试里设）。纯函数：不读库、不读配置。

// ---- "today" is the LOCAL calendar day, never the UTC one ------------------
// Machine and business both sit at GMT+0800 (Manila), so
// `new Date().toISOString().slice(0, 10)` is the UTC date: between local 00:00
// and 08:00 it hands back YESTERDAY. Everything it fed compares against a
// stored YYYY-MM-DD that a human typed as a LOCAL calendar date, so for those
// eight hours every such comparison was a day early:
//   * a time-gated phase whose startAt is today stayed LOCKED until 08:00 —
//     the employee read "unlocks after the previous phase" and could not open
//     anything (the bug that started this);
//   * default due dates came out a day short;
//   * "overdue today" and "last 30 days" counters dropped a day of rows every
//     morning.
// Build the string out of the local Y/M/D parts instead. validDateStr() keeps
// using toISOString on purpose — there it is a UTC round-trip of a
// UTC-parsed string, i.e. an "is this a real date" check, not a "which day is
// it today" question.
// 简化 10/11：「本地日」统一按马尼拉日算（与申诉、绩效用的 manilaDay 同一口径），不再随服务器时区变化。
function ymdLocal(d) {
  return manilaDay(d.getTime());
}
// 「现在」经过这一个口子，时区相关的行为才可测：本地日与 UTC 日只在每天
// 00:00–08:00（马尼拉）之间不同，等真到那个时段才发现问题就太晚了。
// LMS_FAKE_NOW 只在测试里设（与 LMS_DISABLE_AI / LMS_NO_DEMO_USERS 同一类的测试缝）；
// 不设时行为与直接 new Date() 完全一致。
function nowMs() {
  const fake = process.env.LMS_FAKE_NOW;
  if (fake) {
    const t = Date.parse(fake);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
function todayLocal() {
  return ymdLocal(new Date(nowMs()));
}
// The local calendar day `days` from today (negative = in the past), for
// "since" windows whose edge must be a local date too. Manila has no DST, so
// plain millisecond arithmetic is exact here.
function dateLocalOffset(days) {
  return ymdLocal(new Date(nowMs() + days * 24 * 60 * 60 * 1000));
}
// ---------- talent layer (TMS): people profiles, lifecycle records, config ----------
function validDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// 马尼拉日（固定 +08:00，无夏令时）；LMS_FAKE_NOW 生效
function manilaDay(ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); }
function appealToday() { return manilaDay(nowMs()); }
function isWorkday(ymd, H) { const w = new Date(ymd + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6 && !H.has(ymd); }
// ymd 之后（不含当日）的第 n 个工作日（n ≥ 1）；最多走 400 天
function workdayAdd(ymd, n, H) {
  let d = Date.parse(ymd + "T00:00:00Z"), k = 0;
  for (let i = 0; i < 400; i++) { d += 86400e3; const s = new Date(d).toISOString().slice(0, 10); if (isWorkday(s, H) && ++k === n) return s; }
  return new Date(d).toISOString().slice(0, 10);
}
// (from, to] 之间的工作日数；to ≤ from 为 0
function workdaysBetween(fromYmd, toYmd, H) {
  let n = 0;
  for (let d = Date.parse(fromYmd + "T00:00:00Z") + 86400e3, end = Date.parse(toYmd + "T00:00:00Z"), i = 0; d <= end && i < 800; d += 86400e3, i++) {
    const s = new Date(d).toISOString().slice(0, 10);
    if (isWorkday(s, H)) n++;
  }
  return n;
}

module.exports = { nowMs, manilaDay, ymdLocal, todayLocal, dateLocalOffset, appealToday, isWorkday, workdayAdd, workdaysBetween, validDateStr };
