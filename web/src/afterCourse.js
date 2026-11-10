// 学完一门课之后去哪里（F44，2026-10-09）：课程页 Course.jsx 的「完成并继续」与完成横幅「前往考试」共用。
// 不 import 任何东西（test/after-course.test.js 用 vm 直接跑）。
//
// `prog` 是进入课程页时取的学习包快照，刚学完的这门课在快照里还不是 100%，考试的 `unlocked` 也可能是旧的。
// 所以：当前这门课按「已学完」计，其他课程按快照的进度判断；考试只在服务端已解锁，或它要求的课程全部学完时才可去。
// 考试不写 courseIds 时覆盖整个学习包（与 server.js examUnlockedFor 一致）。

const same = (a, b) => String(a) === String(b);

// 某门课是否学完（当前课按 currentDone 计）
function courseFinished(c, currentId, currentDone) {
  if (same(c.id, currentId)) return !!currentDone;
  return (c.progress || 0) >= 100;
}

// 考试要求的课程：显式 courseIds，否则学习包全部课程
export function examRequiredCourses(exam, courses) {
  const ids = Array.isArray(exam && exam.courseIds) ? exam.courseIds : [];
  const list = Array.isArray(courses) ? courses : [];
  if (!ids.length) return list;
  return list.filter((c) => ids.some((x) => same(x, c.id)));
}

// 考试现在能不能去：服务端已解锁，或它要求的课程（当前课按 currentDone 计）全部学完。
// 要求的课程在快照里一门都找不到时无法确认，按不可去处理。
export function examReachable(exam, courses, currentId, currentDone) {
  if (!exam) return false;
  if (exam.unlocked) return true;
  const req = examRequiredCourses(exam, courses);
  if (!req.length) return false;
  return req.every((c) => courseFinished(c, currentId, currentDone));
}

// 学完当前课之后的去向：
//   { kind: 'course', id }  学习包里还有没学完的课：优先当前课之后的，其次之前的；
//   { kind: 'exam', id }    全部学完且有可去的考试；
//   { kind: 'list' }        只有一门课的单课包装且没有可去的考试：回课程列表；
//   { kind: 'program' }     其余情况（含考试未解锁或无法确认）：回学习路径页。
export function nextAfterCourse(prog, currentId, currentDone = true) {
  const courses = prog && Array.isArray(prog.courses) ? prog.courses : null;
  if (!courses) return { kind: 'program' };
  const idx = courses.findIndex((c) => same(c.id, currentId));
  const pending = (c) => !courseFinished(c, currentId, currentDone);
  const after = idx >= 0 ? courses.slice(idx + 1) : courses;
  const before = idx >= 0 ? courses.slice(0, idx) : [];
  const next = after.find(pending) || before.find(pending);
  if (next) return { kind: 'course', id: next.id };
  if (courses.some(pending)) return { kind: 'program' };
  const exams = Array.isArray(prog.exams) ? prog.exams : [];
  const exam = exams.find((e) => examReachable(e, courses, currentId, currentDone));
  if (exam) return { kind: 'exam', id: exam.id };
  // 单课包装（学习路径页会直接跳回本课）：回课程列表
  if (courses.length === 1) return { kind: 'list' };
  return { kind: 'program' };
}
