"use strict";
// 培训概览的统计引擎（第三批 4.1 / 4.2，2026-10-08）。零依赖。
//   1. createSnapshotStore(store)：一次请求预读整表（进度、课程出勤、答卷、考试、指派），实现 completion.js 用到的那几个
//      store 方法。规则代码（modules/learning/completion.js）不变，只是换了数据来源；test/training-snapshot-parity 保证两者一致。
//   2. 时间段（period）与统计窗口、「本期应完成」集合 S(W)、按某日的格子状态、指标与环比、风险排序 —— 纯函数，test/training-stats 覆盖。
// 「格子」（cell）= 一个人 × 一个课程（程序）的指派：
//   { userId, programId, dueDay, refDay, done, doneDay, started, published, mandatory, hours }
//   doneDay = 完成日期（本地日，completion.programDoneAt）；done 但日期未知时 doneDay = "0000-00-00"（视为很早以前完成）。

// ---------- 日期（本地日 YYYY-MM-DD，服务器时区 = 马尼拉）----------
const p2 = (x) => String(x).padStart(2, "0");
function ymd(d) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v + "T00:00:00").getTime());
function parseDay(s) { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(day, n) { const d = parseDay(day); d.setDate(d.getDate() + n); return ymd(d); }
function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); }
// ISO 时间 → 本地日；无效 → null
function dayOf(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? ymd(new Date(t)) : null;
}
// 课程开课时间 sessionAt（本地 "YYYY-MM-DDTHH:mm"，不带时区）→ 本地日
function sessionDay(sessionAt) {
  const s = String(sessionAt || "").slice(0, 10);
  return isDay(s) ? s : null;
}

// ---------- 时间段与窗口 ----------
// period = all | month | quarter | year | custom。没传 period、只传 from/to（旧接口）→ custom。
// custom：from、to 都合法、from ≤ to、跨度不超过 3 年 → 窗口 [from, to]，上期 = 紧挨 from 之前的同样天数；
//         只给一端 → 开口窗口（另一端不限），没有上期；不合法 → all。
// all：窗口不设边界，没有上期（环比为 null）。
// 返回 { period, win:{from,to}, prevWin:{from,to}|null, base }，base = 环比文案用的上期名（month/quarter/year/custom）。
function periodWindows({ period, from, to, today }) {
  const f = isDay(from) ? from : null, t = isDay(to) ? to : null;
  let per = ["all", "month", "quarter", "year", "custom"].includes(period) ? period : null;
  if (!per) per = f || t ? "custom" : "all";
  const [y, m] = today.split("-").map(Number);
  const mk = (a, b) => ({ from: ymd(a), to: ymd(b) });
  if (per === "month") {
    return { period: per, base: "month", win: mk(new Date(y, m - 1, 1), new Date(y, m, 0)), prevWin: mk(new Date(y, m - 2, 1), new Date(y, m - 1, 0)) };
  }
  if (per === "quarter") {
    const q0 = Math.floor((m - 1) / 3) * 3;
    return { period: per, base: "quarter", win: mk(new Date(y, q0, 1), new Date(y, q0 + 3, 0)), prevWin: mk(new Date(y, q0 - 3, 1), new Date(y, q0, 0)) };
  }
  if (per === "year") {
    return { period: per, base: "year", win: mk(new Date(y, 0, 1), new Date(y, 11, 31)), prevWin: mk(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)) };
  }
  if (per === "custom") {
    if (f && t) {
      if (f > t || daysBetween(f, t) > 3 * 366) return { period: "all", base: null, win: { from: null, to: null }, prevWin: null };
      const span = daysBetween(f, t) + 1;
      return { period: per, base: "custom", win: { from: f, to: t }, prevWin: { from: addDays(f, -span), to: addDays(f, -1) } };
    }
    if (f || t) return { period: per, base: null, win: { from: f, to: t }, prevWin: null };
    return { period: "all", base: null, win: { from: null, to: null }, prevWin: null };
  }
  return { period: "all", base: null, win: { from: null, to: null }, prevWin: null };
}
// 窗口内按哪一天看状态：窗口结束日与今天较早者（本期未结束 → 今天）
function asOfDay(win, today) { return win && win.to && win.to < today ? win.to : today; }
// day 是否落在窗口内（边界含）；窗口一端为空 = 那一端不限
function inWin(day, win) {
  if (!day || !win) return false;
  if (win.from && day < win.from) return false;
  if (win.to && day > win.to) return false;
  return true;
}
// 窗口还没开始（from 在今天之后）：本期应完成为空、环比为 null
const winFuture = (win, today) => !!(win && win.from && win.from > today);

// 「本期应完成」S(W)：参考日 ≤ 窗口结束，且（参考日 ≥ 窗口开始，或窗口开始时仍未完成 —— 之前到期、本期还拖着的）
function inWindowSet(cell, win, today) {
  if (!win || (!win.from && !win.to)) return true;
  if (winFuture(win, today)) return false;
  if (win.to && cell.refDay && cell.refDay > win.to) return false;
  if (win.from && (!cell.refDay || cell.refDay < win.from)) return !(cell.done && cell.doneDay < win.from);
  return true;
}
// 某一天的格子状态：done | overdue | inprog | notstarted。逾期只算已发布的课程（与学习记录、提醒同一口径），
// 截止日当天 23:59:59 之后算逾期 ⇔ 截止日 < 当天。
function statusAt(cell, day) {
  if (cell.done && cell.doneDay <= day) return "done";
  if (cell.published && cell.dueDay && cell.dueDay < day) return "overdue";
  return cell.started ? "inprog" : "notstarted";
}

// ---------- 指标 ----------
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (num, den) => (den ? round1((num / den) * 100) : null);
// 一组格子按某天汇总
function tally(cells, day, win) {
  const t = { assigned: 0, done: 0, overdue: 0, inprog: 0, notstarted: 0, hoursDone: 0 };
  const overPeople = new Set();
  for (const c of cells) {
    t.assigned++;
    const st = statusAt(c, day);
    t[st]++;
    if (st === "overdue") overPeople.add(c.userId);
    if (win && c.done && c.doneDay !== "0000-00-00" && inWin(c.doneDay, win)) t.hoursDone += c.hours || 0;
  }
  t.hoursDone = round1(t.hoursDone);
  t.overduePeople = overPeople.size;
  t.completion = pct(t.done, t.assigned);
  return t;
}
// 五个指标卡。cells = P 内全部指派格子；H = 人数；attemptsIn(win) → { passed, total }（已出结论、未作废、窗口内提交）。
function computeKpis({ cells, H, wins, today, attemptsIn }) {
  const { win, prevWin, period } = wins;
  const one = (w, isPrev) => {
    const future = winFuture(w, today);
    const day = asOfDay(w, today);
    const doneIn = (c) => c.done && c.doneDay !== "0000-00-00" && (w.from || w.to ? inWin(c.doneDay, w) : true) && c.doneDay <= today;
    const covered = new Set(); let hours = 0;
    // 第四批 7：按来源拆分（指派 / 自主学习）。同一人两边都有完成的，两边各算一次，合计仍只算一次
    const covA = new Set(), covS = new Set(); let hoursA = 0, hoursS = 0;
    let reqNum = 0, reqDen = 0; const overP = new Set(); let overRows = 0;
    for (const c of cells) {
      if (!future && doneIn(c)) {
        covered.add(c.userId); hours += c.hours || 0;
        if (c.self) { covS.add(c.userId); hoursS += c.hours || 0; } else { covA.add(c.userId); hoursA += c.hours || 0; }
      }
      if (future || !inWindowSet(c, w, today)) continue;
      const st = statusAt(c, day);
      if (c.mandatory) { reqDen++; if (st === "done") reqNum++; }
      if (st === "overdue") { overP.add(c.userId); overRows++; }
    }
    const at = future ? { passed: 0, total: 0 } : attemptsIn(w);
    return {
      coverage: { value: pct(covered.size, H), num: covered.size, den: H },
      hoursPerHead: { value: H ? round1(hours / H) : null, num: round1(hours), den: H },
      requiredCompletion: { value: pct(reqNum, reqDen), num: reqNum, den: reqDen },
      overduePeople: { value: overP.size, rows: overRows },
      passRate: { value: pct(at.passed, at.total), num: at.passed, den: at.total },
      covSplit: { assigned: { num: covA.size, value: pct(covA.size, H) }, self: { num: covS.size, value: pct(covS.size, H) } },
      hoursSplit: { assigned: { num: round1(hoursA), value: H ? round1(hoursA / H) : null }, self: { num: round1(hoursS), value: H ? round1(hoursS / H) : null } },
      isPrev,
    };
  };
  const cur = one(win, false);
  const prev = period !== "all" && prevWin ? one(prevWin, true) : null;
  const d = (a, b) => (a == null || b == null ? null : round1(a - b));
  const rate = (k) => {
    const c = cur[k], p = prev && prev[k];
    return { value: c.value, num: c.num, den: c.den,
      prev: p ? p.value : null, prevNum: p ? p.num : null, prevDen: p ? p.den : null,
      delta: p && p.den ? d(c.value, p.value) : null };
  };
  return {
    // split（第四批 7）：本期按来源拆分 { assigned:{num,value}, self:{num,value} }，覆盖率的 value 为占人数的百分比，人均学时的 num 为学时合计
    coverage: { ...rate("coverage"), split: cur.covSplit },
    hoursPerHead: { value: cur.hoursPerHead.value, num: cur.hoursPerHead.num, den: H, prev: prev ? prev.hoursPerHead.value : null, delta: prev && H ? d(cur.hoursPerHead.value, prev.hoursPerHead.value) : null, split: cur.hoursSplit },
    requiredCompletion: rate("requiredCompletion"),
    overduePeople: { value: cur.overduePeople.value, rows: cur.overduePeople.rows, prev: prev ? prev.overduePeople.value : null, prevRows: prev ? prev.overduePeople.rows : null, delta: prev ? cur.overduePeople.value - prev.overduePeople.value : null },
    passRate: rate("passRate"),
  };
}
// 风险排序：逾期人数降序 → 完成率升序 → 指派人次降序；逾期 > 0 的标 reason "overdue"；不足 limit 条时，
// 用指派 ≥ minAssigned、完成率 < maxCompletion 且 eligible(row) 的行按完成率升序补齐，标 "lowCompletion"。
function rankRisk(rows, { limit = 5, minAssigned = 10, maxCompletion = 80, eligible = () => true } = {}) {
  const cmp = (a, b) => (b.overduePeople - a.overduePeople) || ((a.completion ?? 101) - (b.completion ?? 101)) || (b.assigned - a.assigned);
  const sorted = rows.filter((r) => r.assigned > 0).slice().sort(cmp);
  const out = sorted.filter((r) => r.overduePeople > 0).slice(0, limit).map((r) => ({ ...r, reason: "overdue" }));
  if (out.length < limit) {
    const have = new Set(out.map((r) => r));
    const low = sorted.filter((r) => !have.has(r) && r.overduePeople === 0 && r.assigned >= minAssigned && r.completion != null && r.completion < maxCompletion && eligible(r))
      .sort((a, b) => (a.completion - b.completion) || (b.assigned - a.assigned));
    for (const r of low) { if (out.length >= limit) break; out.push({ ...r, reason: "lowCompletion" }); }
  }
  return out;
}
// 热力格完成率分档：0 <50，1 50–69，2 70–84，3 85–94，4 ≥95
function bucketOf(p) { if (p == null) return null; return p >= 95 ? 4 : p >= 85 ? 3 : p >= 70 ? 2 : p >= 50 ? 1 : 0; }
// 近 12 周（周一起算，本地日）
function mondayOf(day) { const d = parseDay(day); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return ymd(d); }
function weekBuckets(today, n = 12) {
  const thisMon = mondayOf(today);
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) weeks.push(addDays(thisMon, -7 * i));
  const first = weeks[0];
  const idxOf = (day) => { if (!day) return -1; const i = Math.floor(daysBetween(first, day) / 7); return i >= 0 && i < n && day <= addDays(thisMon, 6) ? i : -1; };
  return { weeks, idxOf };
}

// ---------- 请求级快照（性能，设计 §1.4）----------
// 实现 completion.js 用到的 store 方法：getCourseProgress、getUserActivityStates、listProgramExams、getExam、bestAttempt、
// bestExamAttempt、pendingExamAttempt、listUserAttempts、listUserMemberships（委托 + 按人缓存）、getUserAssignments。
// bestAttempt 复现 store.js 的 SQL：已提交、未作废、COALESCE(gradingStatus,'final') NOT IN ('grading','pending_review')，percent 最高（同分取先插入的）。
function createSnapshotStore(store) {
  const progress = new Map();
  for (const r of store.listAllProgress()) {
    const k = r.userId + "|" + r.courseId;
    let o = progress.get(k); if (!o) { o = {}; progress.set(k, o); }
    o[r.moduleId] = r.completedAt;
  }
  const courseStates = new Map();
  for (const r of store.listActivityStatesByProject("__course__")) {
    let o = courseStates.get(r.userId); if (!o) { o = {}; courseStates.set(r.userId, o); }
    o[r.activityId] = r;
  }
  const exams = store.listExams();
  const examById = new Map(exams.map((e) => [e.id, e]));
  const examsByProgram = new Map();
  for (const e of exams) { if (!examsByProgram.has(e.programId)) examsByProgram.set(e.programId, []); examsByProgram.get(e.programId).push(e); }
  const byUserProg = new Map(), byUserExam = new Map();
  for (const a of store.listSubmittedAttemptsLite()) {
    const k1 = a.userId + "|" + a.programId; if (!byUserProg.has(k1)) byUserProg.set(k1, []); byUserProg.get(k1).push(a);
    if (a.examId) { const k2 = a.userId + "|" + a.examId; if (!byUserExam.has(k2)) byUserExam.set(k2, []); byUserExam.get(k2).push(a); }
  }
  const asg = new Map();
  for (const r of store.listAllAssignments()) {
    let o = asg.get(r.userId); if (!o) { o = {}; asg.set(r.userId, o); }
    o[r.programId] = { dueAt: r.dueAt, assignedAt: r.assignedAt, source: r.source || null };   // source：第四批迁移 74（'self' = 自主学习）
  }
  const settled = (a) => !a.voided && !["grading", "pending_review"].includes(a.gradingStatus || "final");
  const best = (list) => { let b = null; for (const a of list || []) if (settled(a) && (!b || a.percent > b.percent || (a.percent === b.percent && a.passed && !b.passed))) b = a; return b; };   // 同分时已通过的优先（F57，与 store.bestAttempt 同口径）
  const memo = (fn) => { const m = new Map(); return (k) => { if (!m.has(k)) m.set(k, fn(k)); return m.get(k); }; };
  const bestProg = memo((k) => best(byUserProg.get(k)));
  const bestExam = memo((k) => best(byUserExam.get(k)));
  const memberships = memo((uid) => store.listUserMemberships(uid));
  const EMPTY = Object.freeze({});
  return {
    getCourseProgress: (userId, courseId) => progress.get(userId + "|" + courseId) || EMPTY,
    getUserActivityStates: (userId, projectId) => (projectId === "__course__" ? courseStates.get(userId) || EMPTY : store.getUserActivityStates(userId, projectId)),
    listProgramExams: (programId) => examsByProgram.get(programId) || [],
    listExams: () => exams,
    getExam: (id) => examById.get(id) || null,
    bestAttempt: (userId, programId) => bestProg(userId + "|" + programId),
    bestExamAttempt: (userId, examId) => bestExam(userId + "|" + examId),
    pendingExamAttempt: (userId, examId) => {
      let hit = null;
      for (const a of byUserExam.get(userId + "|" + examId) || [])
        if (!a.voided && ["grading", "pending_review"].includes(a.gradingStatus) && (!hit || a.submittedAt > hit.submittedAt)) hit = a;
      return hit;
    },
    listUserAttempts: (userId, programId) => (byUserProg.get(userId + "|" + programId) || []).slice().sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0)),
    listUserMemberships: (userId) => memberships(userId),
    getUserAssignments: (userId) => asg.get(userId) || EMPTY,
    // 概览自己用：全部已提交答卷（轻量）
    attemptsOf: (userId, programId) => byUserProg.get(userId + "|" + programId) || [],
    allAttempts: () => { const out = []; for (const l of byUserProg.values()) out.push(...l); return out; },
    isSettled: settled,
  };
}

module.exports = {
  ymd, isDay, addDays, daysBetween, dayOf, sessionDay, parseDay,
  periodWindows, asOfDay, inWin, winFuture, inWindowSet, statusAt,
  round1, pct, tally, computeKpis, rankRisk, bucketOf, mondayOf, weekBuckets,
  createSnapshotStore,
};
