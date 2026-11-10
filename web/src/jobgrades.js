// 按职级选人（第三批 8.6，2026-10-08）：课程指派、培养项目加学员共用的纯函数。
//
// 职级目录来自 GET /api/admin/job-grades → { ranks: [{ rank, grade, level, track }] }（rank 如 P1、M2；level 数字越大越高）。
// 员工的职级是 roster 行的 jobLevel（与 rank 同一套写法）。目录之外但有人在用的值（旧数据，如 V4）也列为可选项。
//   gradeOptions(ranks, inUse)       下拉选项 [{ label, value, track }]：按序列（P / M / 其他）、职级从高到低
//   ranksInRange(ranks, from, to)    职级段：两端之间（含两端）的全部职级。同一序列内按 level 取；两端不在同一序列时两个序列都取
//   splitByGrade(people, grades)     { match, noGrade }：grades 为空时不按职级筛（match = 全部，noGrade = []）；
//                                    否则 match = 职级在所选之内的人，noGrade = 没有设职级的人（不纳入，界面提示人数）
// 无依赖，测试用 vm 直接跑。

const keyOf = (v) => String(v == null ? '' : v).trim();

export function gradeOptions(ranks, inUse = []) {
  const list = (Array.isArray(ranks) ? ranks : []).filter((r) => r && keyOf(r.rank));
  const known = new Set(list.map((r) => keyOf(r.rank)));
  const sorted = list.slice().sort((a, b) => keyOf(a.track).localeCompare(keyOf(b.track)) || ((Number(b.level) || 0) - (Number(a.level) || 0)) || keyOf(a.rank).localeCompare(keyOf(b.rank)));
  const out = sorted.map((r) => ({ label: keyOf(r.rank), value: keyOf(r.rank), track: keyOf(r.track) || '' }));
  const extra = [...new Set((inUse || []).map(keyOf).filter((v) => v && !known.has(v)))].sort();
  for (const v of extra) out.push({ label: v, value: v, track: '' });
  return out;
}

export function ranksInRange(ranks, from, to) {
  const list = Array.isArray(ranks) ? ranks : [];
  const a = list.find((r) => keyOf(r.rank) === keyOf(from));
  const b = list.find((r) => keyOf(r.rank) === keyOf(to));
  if (!a || !b) return [from, to].map(keyOf).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
  const lo = Math.min(Number(a.level) || 0, Number(b.level) || 0);
  const hi = Math.max(Number(a.level) || 0, Number(b.level) || 0);
  const tracks = new Set([keyOf(a.track), keyOf(b.track)]);
  return list
    .filter((r) => tracks.has(keyOf(r.track)) && (Number(r.level) || 0) >= lo && (Number(r.level) || 0) <= hi)
    .map((r) => keyOf(r.rank));
}

export function splitByGrade(people, grades) {
  const list = Array.isArray(people) ? people : [];
  const want = new Set((grades || []).map(keyOf).filter(Boolean));
  if (!want.size) return { match: list, noGrade: [] };
  const match = [], noGrade = [];
  for (const p of list) {
    const g = keyOf(p && p.jobLevel);
    if (!g) noGrade.push(p);
    else if (want.has(g)) match.push(p);
  }
  return { match, noGrade };
}
