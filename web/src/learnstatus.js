// learnstatus.js — 员工端课程状态的唯一推算处（第三批 5.4 / 10.4 / 10.7 / 10.8，2026-10-08）。
// 「课程」页（MyLearning.jsx）与首页「课程」区块（Home.jsx）共用，两处的状态、分组、排序与下一步按钮必须一致。
//
// 读取的接口字段（/api/programs 每项；/api/catalog 中 status === 'assigned' 的项）：
//   既有：done, progress, best{percent,passed}, resultPending, hasExam, mode, dueAt, attendance
//   第三批新增（G1）：
//     learnStatus | status   —— 服务端推算的学习状态；本文件只认 'retake_pending'（待补考）与 'failed'（次数用完），
//                              其余值按本地规则推算。/api/catalog 的 status 是申请关系（assigned/pending/…），所以先读 learnStatus。
//     attemptsLeft           —— 剩余考试次数；null = 不限次数；0 = 已用完
//     retakeAvailableAt      —— 可再次考试的时间（ISO）；null = 现在即可
//     retakeExamId           —— 补考对应的考试 id（有它时「去补考」直达考前说明页）
//   也兼容设计稿 §4.8 的 retake: { examId, state, retryAt, attemptsLeft }。
// 旧服务端没有这些字段时：未通过一律按「待补考」处理、按钮进课程详情（详情页会说明次数或等待期）。

const LEARN_STATUS_VALUES = ['retake_pending', 'failed'];

// 补考信息：{ examId, attemptsLeft (null = 不限), availableAt (Date|null), waiting, usedUp }
export function retakeInfo(p, now = Date.now()) {
  const r = (p && p.retake) || {};
  const examId = p.retakeExamId || r.examId || null;
  let left = p.attemptsLeft !== undefined ? p.attemptsLeft : r.attemptsLeft;
  if (left === undefined) left = null;
  if (left != null) left = Math.max(0, Number(left) || 0);
  const raw = p.retakeAvailableAt !== undefined ? p.retakeAvailableAt : r.retryAt;
  let availableAt = null;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) availableAt = d;
  }
  const usedUp = left === 0 || r.state === 'usedUp';
  const waiting = !usedUp && !!availableAt && availableAt.getTime() > now;
  return { examId, attemptsLeft: left, availableAt: waiting ? availableAt : null, waiting, usedUp };
}

// 统一学习状态：notstarted | inprog | ready（待考试）| retake（待补考）| failed（未通过、次数用完）
//               | pending（成绩待定）| overdue | passed
// 逾期优先显示（逾期 N 天），但逾期且可补考时仍给「去补考」—— 见 examAction()。
export function learnStatusOf(p) {
  const d = daysUntilLocal(p.dueAt);
  const late = d != null && d < 0;
  if (p.done === true) return 'passed';
  const notDone = p.done === false;
  const srv = LEARN_STATUS_VALUES.includes(p.learnStatus) ? p.learnStatus
    : LEARN_STATUS_VALUES.includes(p.status) ? p.status : null;
  const failedState = () => {
    if (srv === 'failed') return 'failed';
    if (srv === 'retake_pending') return 'retake';
    return retakeInfo(p).usedUp ? 'failed' : 'retake';
  };
  // 线下课程：出勤即完成，没有「待考试」；已出席但挂着没通过的结业考试 → 按考试口径
  if (p.mode === 'offline') {
    if (!notDone && (p.progress || 0) >= 100) return 'passed';
    if (!(notDone && p.hasExam !== false && (p.progress || 0) >= 100)) {
      return late ? 'overdue' : 'notstarted';
    }
  } else if (p.hasExam === false) {
    if (!notDone && (p.progress || 0) >= 100) return 'passed';
    if (late) return 'overdue';
    return (p.progress || 0) > 0 ? 'inprog' : 'notstarted';
  }
  if (!notDone && p.best && p.best.passed) return 'passed';
  if (p.resultPending) return 'pending';
  if (late) return 'overdue';
  if (srv || (p.best && !p.best.passed)) return failedState();
  if ((p.progress || 0) >= 100) return 'ready';
  if ((p.progress || 0) > 0) return 'inprog';
  return 'notstarted';
}

// 是否还有一场考试要去考（逾期也算）：'first'（学完未考）| 'retake'（未通过可补考，含等待期）| null
export function examAction(p, st = learnStatusOf(p)) {
  if (st === 'ready') return 'first';
  if (st === 'retake') return 'retake';
  if (st === 'overdue' && p.done !== true && !p.resultPending && p.hasExam !== false && p.mode !== 'offline') {
    if (p.best && !p.best.passed) return retakeInfo(p).usedUp ? null : 'retake';
    if ((p.progress || 0) >= 100) return 'first';
  }
  return null;
}

// 排序（10.7，首页与课程页同一口径）：逾期 → 待考试 / 待补考 → 进行中 → 成绩待定 / 未通过 → 未开始 → 线下 → 已完成
export function learnRank(p, st = learnStatusOf(p)) {
  if (st === 'overdue') return 0;
  if (st === 'passed') return 6;
  if (st === 'ready' || st === 'retake') return 1;
  if (p.mode === 'offline') return 5;
  if (st === 'inprog') return 2;
  if (st === 'pending' || st === 'failed') return 3;
  return 4;
}

// 同一档内：截止日近的在前，没有截止日的在后
export function cmpDue(a, b) {
  const da = daysUntilLocal(a.dueAt);
  const db = daysUntilLocal(b.dueAt);
  if (da == null) return db == null ? 0 : 1;
  if (db == null) return -1;
  return da - db;
}

export function sortForLearner(list) {
  return list
    .map((p) => ({ p, st: learnStatusOf(p) }))
    .sort((a, b) => learnRank(a.p, a.st) - learnRank(b.p, b.st) || cmpDue(a.p, b.p))
    .map((x) => x.p);
}

// 首页只放前 n 门：待考试 / 待补考的课程不能被挤出（10.7）。逾期课程占满前 n 位时，
// 把第一门待考试 / 待补考的课程换进最后一位。
export function pickTop(sorted, n = 4) {
  const top = sorted.slice(0, n);
  const hasExam = top.some((p) => examAction(p));
  if (!hasExam) {
    const idx = sorted.findIndex((p, i) => i >= n && examAction(p));
    if (idx >= n && top.length === n) top[n - 1] = sorted[idx];
  }
  const ids = new Set(top.map((p) => p.id));
  return { top, rest: sorted.filter((p) => !ids.has(p.id)) };
}

// 考前说明页路由（与 ProgramDetail 同一路径；考试 id 未知时回课程详情）
export function retakeHref(p) {
  const { examId } = retakeInfo(p);
  return examId ? `/exam-prep/${p.id}/${examId}` : `/program/${p.id}`;
}

// 「MM-DD HH:mm」；当天只写时刻
export function stampOf(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  const clock = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const now = new Date();
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return same ? clock : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${clock}`;
}

// 与 api.js daysUntil 同一算法（本地日历日）；放在这里免得纯函数测试要拉起 React
export function daysUntilLocal(dueAt) {
  if (!dueAt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dueAt));
  const due = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}
