// 绩效看板第三期（负责人 2026-10-10 开工）：员工「我的绩效」概要的计算。纯函数、无 import（test/perf-dashboard-phase23.test.js 用 vm 跑）。
// 负责人定：员工不看分布、不看他人评级与名次 —— 这里只用本人的数据：/api/me/reviews 的 mine（进行中的季度周期条目）与
// /api/me/reviews/history 的 items（已关闭周期的档案评级与申诉状态）。
//
//   stepsOf(item)        本期进度：自评 → 1 对 1 面谈 → 上级评级 → 部门校准与 HR 确认 → 结果告知；
//                        返回 { steps:[{ key, state:'done'|'current'|'todo'|'missed'|'late' }], current, who, due }
//                        late = 上级已评级后还没做的自评 / 面谈，仍可补交 / 补登记（不再是当前步）
//                        who = 下一步由谁做：'me' 我 | 'both' 我和直属上级 | 'manager' 直属上级 | 'hod' 部门负责人与 HR
//   recentResults(items, n)   最近 n 期季度结果（从早到晚）与最近一期（含年度）
//   activeAppeals(items)      进行中或还能提出的申诉

export const STEP_KEYS = ['self', 'one', 'rate', 'calib', 'result'];

export function stepsOf(item) {
  if (!item) return null;
  const v2 = item.flow === 'v2';
  const selfDone = !!item.selfAt;
  const empOne = !!item.employeeOneOnOneAt, mgrOne = !!item.oneOnOneAt;
  const oneDone = v2 ? empOne && mgrOne : mgrOne;
  const rateDone = !!item.managerDone;
  const state = {
    self: selfDone ? 'done' : item.selfLocked ? 'missed' : 'todo',
    one: oneDone ? 'done' : 'todo',
    rate: rateDone ? 'done' : 'todo',
    calib: 'todo',
    result: 'todo',
  };
  let current = null, who = null, due = null;
  // QA 34-2（10/10）：v2 里面谈与自评都不是上级评级的前提 —— 上级已评级时，没做完的面谈 / 自评标「可补」（late），当前步直接到部门校准
  if (rateDone) {
    if (!selfDone && !item.selfLocked) state.self = 'late';
    if (!oneDone) state.one = 'late';
    state.calib = 'current';
    return { steps: STEP_KEYS.map((key) => ({ key, state: state[key] })), current: 'calib', who: 'hod', due: item.dueCalibAt || null };
  }
  if (!selfDone && !item.selfLocked) { current = 'self'; who = 'me'; due = item.dueAt || null; }
  else if (!oneDone) { current = 'one'; who = v2 ? (empOne ? 'manager' : mgrOne ? 'me' : 'both') : 'manager'; due = null; }
  else if (!rateDone) { current = 'rate'; who = item.managerGone ? 'hod' : 'manager'; due = item.dueRateAt || null; }
  else { current = 'calib'; who = 'hod'; due = item.dueCalibAt || null; }
  if (state[current] === 'todo') state[current] = 'current';
  return { steps: STEP_KEYS.map((key) => ({ key, state: state[key] })), current, who, due };
}

export function recentResults(items, n = 4) {
  const list = (items || []).filter((i) => i && i.rating).slice()
    .sort((a, b) => String(a.closedAt || '').localeCompare(String(b.closedAt || '')));
  const quarters = list.filter((i) => i.kind !== 'annual').slice(-n);
  return { latest: list.length ? list[list.length - 1] : null, quarters };
}

export function activeAppeals(items) {
  return (items || []).filter((i) => {
    const a = i && i.appeal;
    if (!a) return false;
    if (a.state === 'open') return true;   // 还能提出
    return !!a.submittedAt && !a.withdrawnAt && !a.decidedAt;   // 已提出、还没结论
  });
}
