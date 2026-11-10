"use strict";
// 工作台 · 指标口径纯函数（12.2 工作台改版 组 1，2026-10-09；设计 scratchpad/b12-design.md 第 2、3、6.4 节）
// 纯函数，零依赖，不读库、不 require 其它模块：人群、记录、范围判定都由 server.js（组 2）以参数注入。
// 人才相关口径在 talent 模块的纯函数库里（core 不依赖 talent）：
//   继任覆盖率（2.1）→ modules/talent/key-positions.js 的 successionCoverage / successionSnapshotRows / successionFromSnapshot；
//   高潜与关键人才保留、流失风险、标签状态重建（2.2）→ modules/talent/controlled-tags.js 的 retentionMetric / flightRiskIds / heldOn。
// 日期一律是马尼拉本地日 "YYYY-MM-DD"（服务器时区 = 马尼拉，无夏令时）；ISO 时间先经 manilaDay 转成日。
//
// ───────────────────────────── 导出 API ─────────────────────────────
// 配置
//   DEFAULT_CONFIG = { probationMonths:6, spanMax:10, lagPp:10, minDeptHeadcount:5, minComplianceDen:5 }
//   configOf(raw) → 配置对象      raw = meta workbenchConfig 的 JSON 字符串或对象；每项须为正整数，否则取缺省值
// 日期与统计期（2.0）
//   manilaDay(msOrIso) → "YYYY-MM-DD" | null     毫秒数或 ISO 时间 → +08:00 的日；"YYYY-MM-DD" 原样返回；无效 → null
//   addDays(day, n)、daysBetween(a, b)（b − a 的天数）
//   addMonths(day, n) → day                      目标月没有该日 → 目标月最后一天（1/31 + 1 个月 = 2/28 或 2/29）
//   quarterOf(day) → { key:"2026-Q4", from:"2026-10-01", to:"2026-12-31" }
//   prevQuarterOf(day) → 上一季度（同形；Q1 的上一季度是上一年 Q4）
//   periodFor(today) → { from, to, prevFrom, prevTo, key, prevKey, asOf }
//       from / to = 本季度整季（与 TS.periodWindows period=quarter 相同）；asOf = today（本期截至今天）；
//       前四个字段即 2.7 metric.period 的形状。
// 数值与卡片形状（2.7）
//   round1(x)、pct(num, den)（百分比一位小数；den 0 → null）、deltaOf(value, prev)（一位小数；任一为 null → null）
//   buildMetric({ key, domain, module, unit:"pct"|"count", num, den, value?, prev, better:"up"|"down", period, extra, empty }) →
//       { key, domain, module, value, unit, num, den, prev, delta, better, period, extra, empty }
//       unit pct：value 缺省 = pct(num, den)；unit count：value 缺省 = num（den 缺省 null）。prev 缺省 null（界面显示「上期暂无数据」）。
//       empty 缺省 null；取值 null | "no_key_positions" | "no_cycle" | "no_data"。
// 第一层 待办（6.4）
//   SEVERITY_ORDER = { overdue:0, soon:1, normal:2 }
//   sortTodo(items) → 新数组        严重度 → dueOn 升序（无 dueOn 排后）→ count 降序 → key
//   probationEndOf(hireDate, months) → day | null     到期日 = 入职日 + months 个月 − 1 天（目标月没有该日 → 目标月最后一天）
//   probationDue(people, { hasRegularization(u) }, today, cfg, horizonDays = 30) → [{ userId, dueOn, overdue }]
//       在职、empStatus = "probation"、有合法 hireDate、没有任何转正记录、到期日 ≤ today + horizonDays（含已过期）；
//       overdue = 到期日 < today。按 dueOn 升序。
// 第二层 组织风险
//   probationOutcomes(people, { recordsOf(u), exitDayOf(u) }, win, cfg) →（2.5）
//       { rows:[{ userId, hireDate, outcomeDay, result:"onTime"|"extended"|"failed"|"exitedInProbation", passed, days }],
//         num, den, value, avgDays, avgMonths, ids }
//       recordsOf(u) = 该人的人才记录 [{ type, date, detail:{ result | exitType | lastDay } }]（只看 regularization）；
//       ① 本期内日期的转正记录（同一人取最近一条）；② 否则离职日 ∈ 本期、离职日 ≤ 试用期到期日、离职日及以前没有通过的转正记录
//       → exitedInProbation。passed = result ∈ { On time, Extended }。days = 转正记录日期 − 入职日（只给通过者）；
//       avgDays 为通过者均值（一位小数），avgMonths = avgDays ÷ 30.4375（一位小数）；没有通过者 → null。
//   isManagementGrade(jobLevel, ranks) → bool          职级在职级体系里属管理序列（track = "M"），不分大小写
//   spanOfControl(people, { ranks, ownerIds }, cfg) →（2.6）
//       { rows:[{ userId, directs, managerial, owner, type:"none"|"wide" }], none, wide, count, ids }
//       people = 查看者范围内的在职员工（直属人数只数这群人里 managerId 指向他的人，范围外下属不计）；
//       管理者 = 管理序列职级、或 ownerIds（Set / 数组，部门负责人）中的人、或有 ≥ 1 名直属；
//       none = 直属 0 人且（管理序列或部门负责人）；wide = 直属 >= cfg.spanMax。rows 只含异常者，count = rows.length。
//   spanSnapshotRows(people, { ranks, ownerIds, deptNameOf? }) → [{ subjectId, deptName, data:{ managerial, directsByDept } }]
//       快照 metric = "span"（2.8），people = 全公司在职员工；收录管理序列 / 部门负责人 / 有直属者；managerial = 管理序列或负责人。
//   spanFromSnapshot(rows, deptAllows, cfg) → 与 spanOfControl 同形
//       管理者本人按 row.deptName 过滤；直属人数 = directsByDept 中 deptAllows 为真的部门求和后再判异常。
//   snapshotIds(rows, deptAllows) → [subjectId]          通用：按 deptName 过滤快照行（flight 上期数用）
//   pickReviewCycles(cycles) → { current, prev }（2.4）
//       current = 进行中（status open）里 createdAt 最新的；没有则最近关闭的（closedAt，其次 createdAt）；
//       prev = 与 current 同 kind（缺省 quarter）、createdAt 早于 current 的最近一个。没有 → null。
//   reviewStageInstances({ cycle, items, calibDepts, today }) → [{ stage, itemId, userId, dept1Id, dept1Name, dueOn, doneOn, onTime }]
//       只返回计入分母的实例（截止日 < today）。items = 已按范围过滤、已去掉离职 / 停用参与者的评估项 [{ id, userId, selfAt, managerAt }]；
//       stage self：截止 cycle.dueAt，完成 selfAt；stage rate：截止 cycle.dueRateAt（没有该值 = 旧流程，不计），完成 managerAt；
//       stage calib：仅 cycle.flow = "v2" 且有 dueCalibAt；calibDepts = 范围内一级部门 [{ dept1Id, dept1Name, hodSubmittedAt }]。
//       完成时刻取马尼拉日；onTime = doneOn ≤ dueOn（截止日当天完成算按时）；未完成 doneOn = null、onTime = false。
//   onTimeSummary(instances) → { num, den, value, byStage:{ self, rate, calib: { num, den, value } }, lateIds:[实例下标] }
//   lowestRate(groups, minDen) → { ...group, value } | null     （2.3 最低一级部门）groups = [{ deptId, deptName, num, den }]；
//       只看 den ≥ minDen；比率最低者，平局取 den 大者，再按名称。
// 第三层
//   quotaDeviation(groups, quota, { minHc = 10 }) →（3.2）
//       [{ dept1Id, dept1, headcount, small, tiers:[{ tier, count, actualPct, quotaPct, deviationPp }], over:{ tier, pp } | null }]
//       groups = reviewGroups() 的结果（用 dept1Id、dept1、counts、headcount）；actualPct = counts[tier] ÷ headcount；
//       over = A+ / A / B+ 中偏离 > 0 的最大者；small（headcount < minHc 或 dept1Id = "__none"）不标 over。
//   promotionRate12m(people, recordsOf, today) → { num, den, value, ids }（3.3）
//       people = 范围内在职员工（分母）；分子 = 其中近 12 个月（addMonths(today,−12) < date ≤ today）有 result = Passed 的晋升记录的人。
//   pipelineGaps(ranks, people, candidateIds) → [{ track, grade, lowerGrade, headcount, lowerCandidates:0 }]（3.3）
//       每个序列按职等最高级别降序；职等 G 有在职人员、而紧邻的下一职等中候选人数为 0 → 断层。people = 范围内在职员工。
//   healthCell({ num, den, headcount }, totalValue, cfg, { lag = true }) →（3.4）
//       { value, num, den, state:"ok"|"lag"|"small"|"empty" }
//       headcount < minDeptHeadcount → small（value = null，不标落后）；den 0 → empty（value null）；
//       lag 开启且 totalValue 非空、value ≤ totalValue − lagPp → lag。合计行自身传 { lag:false }。
//   sortHealthRows(rows) → 新数组     rows = [{ deptName, headcount, cells:{ [col]: healthCell } }]；落后项数降序 → 人数降序 → 名称
//   lagCount(row) → 落后项数
// 快照（2.8）
//   SNAPSHOT_KEEP = 8
//   snapshotDue(nowMs, lastDay, { startup }) → bool       马尼拉时间 ≥ 01:00 且 lastDay ≠ 今天；startup 为真时不看钟点
//   oldestKeptPeriod(today, keep = 8) → "YYYY-Qn"         periodKey 小于它的行可删（含本季度共 keep 个季度）
// 其它
//   isInService(u)（与 modules/core/org.js 同口径）

const DEFAULT_CONFIG = Object.freeze({ probationMonths: 6, spanMax: 10, lagPp: 10, minDeptHeadcount: 5, minComplianceDen: 5 });
function configOf(raw) {
  let o = raw;
  if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { o = null; } }
  const out = { ...DEFAULT_CONFIG };
  if (o && typeof o === "object") {
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      const v = Number(o[k]);
      if (Number.isInteger(v) && v > 0) out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 日期
const p2 = (x) => String(x).padStart(2, "0");
const isDay = (v) => {   // 真实存在的日期（2026-02-30 不算：Date.parse 会把它滚到 3 月，所以做往返比较）
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(v + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const ymdUTC = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
const dayMs = (day) => Date.parse(day + "T00:00:00Z");
function manilaDay(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return isDay(v) ? v : null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t + 8 * 3600e3).toISOString().slice(0, 10) : null;
}
const dueDayOf = (v) => { const s = v ? String(v).slice(0, 10) : ""; return isDay(s) ? s : null; };
function addDays(day, n) { return ymdUTC(new Date(dayMs(day) + n * 86400e3)); }
function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400e3); }
function addMonths(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return ymdUTC(t);
}
function quarterOf(day) {
  const [y, m] = day.split("-").map(Number);
  const q = Math.floor((m - 1) / 3);
  return { key: `${y}-Q${q + 1}`, from: ymdUTC(new Date(Date.UTC(y, q * 3, 1))), to: ymdUTC(new Date(Date.UTC(y, q * 3 + 3, 0))) };
}
function prevQuarterOf(day) { return quarterOf(addDays(quarterOf(day).from, -1)); }
function periodFor(today) {
  const c = quarterOf(today), p = prevQuarterOf(today);
  return { from: c.from, to: c.to, prevFrom: p.from, prevTo: p.to, key: c.key, prevKey: p.key, asOf: today };
}

// ---------------------------------------------------------------- 数值与卡片
function round1(x) { return x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10) / 10; }
function pct(num, den) { return den > 0 ? round1((num / den) * 100) : null; }
function deltaOf(value, prev) { return value === null || value === undefined || prev === null || prev === undefined ? null : round1(value - prev); }
function buildMetric(spec) {
  const s = spec || {};
  const unit = s.unit === "count" ? "count" : "pct";
  const num = s.num === undefined ? null : s.num;
  const den = s.den === undefined ? null : s.den;
  let value = s.value;
  if (value === undefined) value = unit === "pct" ? (num === null || den === null ? null : pct(num, den)) : num;
  const prev = s.prev === undefined ? null : s.prev;
  return { key: s.key, domain: s.domain || null, module: s.module || null, value, unit, num, den, prev, delta: deltaOf(value, prev),
    better: s.better === "down" ? "down" : "up", period: s.period || null, extra: s.extra || {}, empty: s.empty || null };
}

// ---------------------------------------------------------------- 待办
const SEVERITY_ORDER = Object.freeze({ overdue: 0, soon: 1, normal: 2 });
function sortTodo(items) {
  const sev = (x) => (x && SEVERITY_ORDER[x.severity] !== undefined ? SEVERITY_ORDER[x.severity] : 3);
  return [...(items || [])].sort((a, b) => sev(a) - sev(b)
    || (a.dueOn ? 0 : 1) - (b.dueOn ? 0 : 1)
    || (a.dueOn && b.dueOn ? (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0) : 0)
    || (Number(b.count) || 0) - (Number(a.count) || 0)
    || String(a.key || "").localeCompare(String(b.key || "")));
}
function isInService(u) {
  return !!u && u.active !== 0 && u.active !== false && u.active !== "0" && u.empStatus !== "exited";
}
function probationEndOf(hireDate, months) {
  if (!isDay(hireDate)) return null;
  const n = Number(months) > 0 ? Math.floor(Number(months)) : DEFAULT_CONFIG.probationMonths;
  const [y, m, d] = hireDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  if (d > last) { t.setUTCDate(last); return ymdUTC(t); }   // 目标月没有该日 → 该月最后一天
  t.setUTCDate(d);
  return addDays(ymdUTC(t), -1);
}
function probationDue(people, fns, today, cfg, horizonDays) {
  const has = fns && typeof fns.hasRegularization === "function" ? fns.hasRegularization : () => false;
  const c = configOf(cfg);
  const until = addDays(today, horizonDays === undefined ? 30 : Number(horizonDays));
  const out = [];
  for (const u of people || []) {
    if (!isInService(u) || u.empStatus !== "probation" || !isDay(u.hireDate) || has(u)) continue;
    const due = probationEndOf(u.hireDate, c.probationMonths);
    if (due && due <= until) out.push({ userId: u.id, dueOn: due, overdue: due < today });
  }
  return out.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0) || String(a.userId).localeCompare(String(b.userId)));
}

// ---------------------------------------------------------------- 2.5 试用期转正
const REG_RESULT = { "On time": "onTime", Extended: "extended", Failed: "failed" };
const inWin = (day, win) => !!day && !!win && (!win.from || day >= win.from) && (!win.to || day <= win.to);
function probationOutcomes(people, fns, win, cfg) {
  const F = fns || {};
  const recordsOf = typeof F.recordsOf === "function" ? F.recordsOf : () => [];
  const exitDayOf = typeof F.exitDayOf === "function" ? F.exitDayOf : () => null;
  const c = configOf(cfg);
  const rows = [];
  for (const u of people || []) {
    if (!u) continue;
    const regs = (recordsOf(u) || []).filter((r) => r && r.type === "regularization" && isDay(String(r.date || "").slice(0, 10)))
      .map((r) => ({ day: String(r.date).slice(0, 10), result: REG_RESULT[(r.detail && r.detail.result) || ""] || "failed" }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const inPeriod = regs.filter((r) => inWin(r.day, win));
    if (inPeriod.length) {
      const r = inPeriod[inPeriod.length - 1];
      const passed = r.result === "onTime" || r.result === "extended";
      const days = passed && isDay(u.hireDate) ? daysBetween(u.hireDate, r.day) : null;
      rows.push({ userId: u.id, hireDate: u.hireDate || null, outcomeDay: r.day, result: r.result, passed, days });
      continue;
    }
    const xd = exitDayOf(u);
    if (!xd || !inWin(xd, win) || !isDay(u.hireDate)) continue;
    const end = probationEndOf(u.hireDate, c.probationMonths);
    if (!end || xd > end) continue;
    if (regs.some((r) => r.day <= xd && (r.result === "onTime" || r.result === "extended"))) continue;
    rows.push({ userId: u.id, hireDate: u.hireDate, outcomeDay: xd, result: "exitedInProbation", passed: false, days: null });
  }
  const passers = rows.filter((r) => r.passed);
  const withDays = passers.filter((r) => r.days !== null);
  const avgDays = withDays.length ? round1(withDays.reduce((s, r) => s + r.days, 0) / withDays.length) : null;
  return { rows, num: passers.length, den: rows.length, value: pct(passers.length, rows.length), avgDays,
    avgMonths: avgDays === null ? null : round1(avgDays / 30.4375), ids: rows.map((r) => r.userId) };
}

// ---------------------------------------------------------------- 2.6 管理幅度
function isManagementGrade(jobLevel, ranks) {
  const lv = String(jobLevel || "").trim().toLowerCase();
  if (!lv) return false;
  const r = (ranks || []).find((x) => x && String(x.rank || "").trim().toLowerCase() === lv);
  return !!r && String(r.track || "").toUpperCase() === "M";
}
const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
function spanJudge(list, cfg) {
  const c = configOf(cfg);
  const rows = [];
  let none = 0, wide = 0;
  for (const x of list) {
    let type = null;
    if (x.directs === 0 && x.managerial) { type = "none"; none++; }
    else if (x.directs >= c.spanMax) { type = "wide"; wide++; }
    if (type) rows.push({ ...x, type });
  }
  return { rows, none, wide, count: rows.length, ids: rows.map((r) => r.userId) };
}
function spanOfControl(people, opts, cfg) {
  const o = opts || {};
  const owners = toSet(o.ownerIds);
  const list = (people || []).filter(isInService);
  const directs = new Map();
  for (const u of list) if (u.managerId) directs.set(u.managerId, (directs.get(u.managerId) || 0) + 1);
  const cand = [];
  for (const u of list) {
    const n = directs.get(u.id) || 0;
    const grade = isManagementGrade(u.jobLevel, o.ranks), owner = owners.has(u.id);
    if (!grade && !owner && n === 0) continue;
    cand.push({ userId: u.id, directs: n, managerial: grade || owner, owner });
  }
  return spanJudge(cand, cfg);
}
function spanSnapshotRows(people, opts) {
  const o = opts || {};
  const owners = toSet(o.ownerIds);
  const dn = typeof o.deptNameOf === "function" ? o.deptNameOf : (u) => u.department || null;
  const list = (people || []).filter(isInService);
  const by = new Map();
  for (const u of list) {
    if (!u.managerId) continue;
    if (!by.has(u.managerId)) by.set(u.managerId, {});
    const m = by.get(u.managerId), d = dn(u) || "";
    m[d] = (m[d] || 0) + 1;
  }
  const out = [];
  for (const u of list) {
    const grade = isManagementGrade(u.jobLevel, o.ranks), owner = owners.has(u.id);
    const d = by.get(u.id) || {};
    if (!grade && !owner && !Object.keys(d).length) continue;
    out.push({ subjectId: u.id, deptName: dn(u) || null, data: { managerial: grade || owner, directsByDept: d } });
  }
  return out;
}
function spanFromSnapshot(rows, deptAllows, cfg) {
  const allows = typeof deptAllows === "function" ? deptAllows : () => true;
  const cand = [];
  for (const r of rows || []) {
    if (!r || !r.data || !allows(r.deptName || null)) continue;
    let n = 0;
    for (const [d, k] of Object.entries(r.data.directsByDept || {})) if (allows(d || null)) n += Number(k) || 0;
    const managerial = !!r.data.managerial;
    if (!managerial && n === 0) continue;
    cand.push({ userId: r.subjectId, directs: n, managerial, owner: null });
  }
  return spanJudge(cand, cfg);
}
function snapshotIds(rows, deptAllows) {
  const allows = typeof deptAllows === "function" ? deptAllows : () => true;
  return (rows || []).filter((r) => r && allows(r.deptName || null)).map((r) => r.subjectId);
}

// ---------------------------------------------------------------- 2.4 评估按时
const ts = (v) => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : -Infinity; };
function pickReviewCycles(cycles) {
  const list = (cycles || []).filter(Boolean);
  const byCreated = (a, b) => ts(b.createdAt) - ts(a.createdAt) || String(b.id).localeCompare(String(a.id));
  const open = list.filter((c) => c.status === "open").sort(byCreated);
  let current = open[0] || null;
  if (!current) {
    current = list.filter((c) => c.status === "closed")
      .sort((a, b) => ts(b.closedAt) - ts(a.closedAt) || byCreated(a, b))[0] || null;
  }
  if (!current) return { current: null, prev: null };
  const kind = (c) => c.kind || "quarter";
  const prev = list.filter((c) => c.id !== current.id && kind(c) === kind(current) && ts(c.createdAt) < ts(current.createdAt)).sort(byCreated)[0] || null;
  return { current, prev };
}
function reviewStageInstances(args) {
  const a = args || {};
  const cycle = a.cycle || {}, today = a.today;
  const out = [];
  const push = (stage, due, doneAt, extra) => {
    if (!due || !(due < today)) return;
    const doneOn = doneAt ? manilaDay(doneAt) : null;
    out.push({ stage, itemId: null, userId: null, dept1Id: null, dept1Name: null, ...extra, dueOn: due, doneOn, onTime: !!doneOn && doneOn <= due });
  };
  const dueSelf = dueDayOf(cycle.dueAt), dueRate = dueDayOf(cycle.dueRateAt), dueCalib = dueDayOf(cycle.dueCalibAt);
  for (const i of a.items || []) {
    if (!i) continue;
    push("self", dueSelf, i.selfAt, { itemId: i.id, userId: i.userId });
    push("rate", dueRate, i.managerAt, { itemId: i.id, userId: i.userId });
  }
  if (cycle.flow === "v2") {
    for (const d of a.calibDepts || []) if (d) push("calib", dueCalib, d.hodSubmittedAt, { dept1Id: d.dept1Id, dept1Name: d.dept1Name || null });
  }
  return out;
}
function onTimeSummary(instances) {
  const list = instances || [];
  const byStage = {};
  for (const s of ["self", "rate", "calib"]) {
    const xs = list.filter((x) => x.stage === s);
    const num = xs.filter((x) => x.onTime).length;
    byStage[s] = { num, den: xs.length, value: pct(num, xs.length) };
  }
  const num = list.filter((x) => x.onTime).length;
  const lateIds = [];
  list.forEach((x, i) => { if (!x.onTime) lateIds.push(i); });
  return { num, den: list.length, value: pct(num, list.length), byStage, lateIds };
}
function lowestRate(groups, minDen) {
  const min = Number(minDen) > 0 ? Number(minDen) : DEFAULT_CONFIG.minComplianceDen;
  let best = null;
  for (const g of groups || []) {
    if (!g || !(g.den >= min)) continue;
    const v = pct(g.num, g.den);
    const cand = { ...g, value: v };
    if (!best || v < best.value || (v === best.value && (g.den > best.den || (g.den === best.den && String(g.deptName || "").localeCompare(String(best.deptName || "")) < 0)))) best = cand;
  }
  return best;
}

// ---------------------------------------------------------------- 第三层
const QUOTA_TIERS = ["A+", "A", "B+", "B", "C/D"];
const QUOTA_CAPPED = ["A+", "A", "B+"];
function quotaDeviation(groups, quota, opts) {
  const minHc = opts && Number(opts.minHc) > 0 ? Number(opts.minHc) : 10;
  const q = quota || {};
  return (groups || []).filter(Boolean).map((g) => {
    const hc = Number(g.headcount) || 0;
    const small = hc < minHc || g.dept1Id === "__none";
    const tiers = QUOTA_TIERS.map((tier) => {
      const count = (g.counts && g.counts[tier]) || 0;
      const actualPct = pct(count, hc);
      const quotaPct = q[tier] === undefined || q[tier] === null ? null : Number(q[tier]);
      return { tier, count, actualPct, quotaPct, deviationPp: actualPct === null || quotaPct === null ? null : round1(actualPct - quotaPct) };
    });
    let over = null;
    if (!small) {
      for (const t of tiers) {
        if (!QUOTA_CAPPED.includes(t.tier) || t.deviationPp === null || !(t.deviationPp > 0)) continue;
        if (!over || t.deviationPp > over.pp) over = { tier: t.tier, pp: t.deviationPp };
      }
    }
    return { dept1Id: g.dept1Id, dept1: g.dept1 || null, headcount: hc, small, tiers, over };
  });
}
function promotionRate12m(people, recordsOf, today) {
  const rec = typeof recordsOf === "function" ? recordsOf : () => [];
  const since = addMonths(today, -12);
  const list = (people || []).filter(Boolean);
  const ids = [];
  for (const u of list) {
    const hit = (rec(u) || []).some((r) => {
      if (!r || r.type !== "promotion" || !r.detail || r.detail.result !== "Passed") return false;
      const d = String(r.date || "").slice(0, 10);
      return isDay(d) && d > since && d <= today;
    });
    if (hit) ids.push(u.id);
  }
  return { num: ids.length, den: list.length, value: pct(ids.length, list.length), ids };
}
function pipelineGaps(ranks, people, candidateIds) {
  const cand = toSet(candidateIds);
  const rankOf = new Map();
  const grades = new Map();   // track → Map(grade → max level)
  for (const r of ranks || []) {
    if (!r || !r.rank || !r.grade || !r.track) continue;
    rankOf.set(String(r.rank).trim().toLowerCase(), r);
    if (!grades.has(r.track)) grades.set(r.track, new Map());
    const g = grades.get(r.track);
    g.set(r.grade, Math.max(g.get(r.grade) || 0, Number(r.level) || 0));
  }
  const head = new Map(), cands = new Map();
  for (const u of people || []) {
    const r = rankOf.get(String((u && u.jobLevel) || "").trim().toLowerCase());
    if (!r) continue;
    const k = r.track + "|" + r.grade;
    head.set(k, (head.get(k) || 0) + 1);
    if (cand.has(u.id)) cands.set(k, (cands.get(k) || 0) + 1);
  }
  const out = [];
  for (const track of [...grades.keys()].sort()) {
    const order = [...grades.get(track).entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
    for (let i = 0; i + 1 < order.length; i++) {
      const g = order[i], lower = order[i + 1];
      const hc = head.get(track + "|" + g) || 0;
      if (hc > 0 && !(cands.get(track + "|" + lower) > 0)) out.push({ track, grade: g, lowerGrade: lower, headcount: hc, lowerCandidates: 0 });
    }
  }
  return out;
}
function healthCell(cell, totalValue, cfg, opts) {
  const c = configOf(cfg);
  const x = cell || {};
  const num = Number(x.num) || 0, den = Number(x.den) || 0;
  const hc = x.headcount === undefined || x.headcount === null ? null : Number(x.headcount);
  if (hc !== null && hc < c.minDeptHeadcount) return { value: null, num, den, state: "small" };
  if (!den) return { value: null, num, den, state: "empty" };
  const value = pct(num, den);
  const lagOn = !opts || opts.lag !== false;
  const lag = lagOn && totalValue !== null && totalValue !== undefined && round1(totalValue - value) >= c.lagPp;
  return { value, num, den, state: lag ? "lag" : "ok" };
}
function lagCount(row) {
  return Object.values((row && row.cells) || {}).filter((c) => c && c.state === "lag").length;
}
function sortHealthRows(rows) {
  return [...(rows || [])].sort((a, b) => lagCount(b) - lagCount(a)
    || (Number(b.headcount) || 0) - (Number(a.headcount) || 0)
    || String(a.deptName || "").localeCompare(String(b.deptName || "")));
}

// ---------------------------------------------------------------- 快照
const SNAPSHOT_KEEP = 8;
function snapshotDue(nowMs, lastDay, opts) {
  const today = manilaDay(nowMs);
  if (!today || lastDay === today) return false;
  if (opts && opts.startup) return true;
  return new Date(nowMs + 8 * 3600e3).getUTCHours() >= 1;
}
function oldestKeptPeriod(today, keep) {
  const n = Number(keep) > 0 ? Math.floor(Number(keep)) : SNAPSHOT_KEEP;
  let q = quarterOf(today);
  for (let i = 1; i < n; i++) q = prevQuarterOf(q.from);
  return q.key;
}

module.exports = {
  DEFAULT_CONFIG, configOf,
  manilaDay, addDays, daysBetween, addMonths, quarterOf, prevQuarterOf, periodFor,
  round1, pct, deltaOf, buildMetric,
  SEVERITY_ORDER, sortTodo, probationEndOf, probationDue,
  probationOutcomes, isManagementGrade, spanOfControl, spanSnapshotRows, spanFromSnapshot, snapshotIds,
  pickReviewCycles, reviewStageInstances, onTimeSummary, lowestRate,
  quotaDeviation, promotionRate12m, pipelineGaps, healthCell, sortHealthRows, lagCount,
  SNAPSHOT_KEEP, snapshotDue, oldestKeptPeriod,
  isInService,
};
