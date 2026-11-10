"use strict";
// 「这门课（程序）算不算完成」的唯一口径（programDone），以及「这一对人 × 课程该不该收培训提醒」的资格判定。
// 服务端（server.js）与定时脚本 scripts/notify-due.js 共用（2026-10-07：定时提醒原先只认考试通过，没有考试的
// 线下 / 线上课程学完了仍天天收「已逾期」；考试通过但线下课程请假的人反而不提醒）。
// 零依赖，不 require store.js：调用方注入 store 与 getCourse（服务端读 COURSES 缓存；定时脚本读一次 listContent("course")）。

// 出勤类（线下活动、线下课程）的「完成」只认出席 / 迟到。请假（excused）与缺勤一样不算完成、需补课
// （负责人 2026-10-06）：不计进度、不满足按完成解锁的下一阶段、线下课程不算学完、不解锁挂在课程上的考试。
// 出勤率另算（看板 attendance：请假不进分母），与这里的「完成」口径分开。
const ATTENDED_STATES = ["attended", "late"];
// Offline-course attendance lives in activity_state under a reserved namespace
// (projectId "__course__", activityId "course:<id>") — same statuses and the
// same rotating-code mechanics as project offline activities.
const courseCkId = (courseId) => "course:" + courseId;
// 课程（程序）是否已发布：未写 status 的旧数据按已发布
const isPublishedProgram = (p) => !!p && (p.status || "published") === "published";
// 纯服务账号 = 后台角色、且没有任何任职信息（部门、职位、入职日都空）：不是员工，不进培训看板、不收培训提醒。
// 也是员工的管理员（例如 HR 自己）照常统计、照常收提醒（负责人 2026-10-07，与员工名册 Employees.jsx 同一条规则）。
const isServiceAccount = (u) => !!u && u.role === "admin" && !u.department && !u.position && !u.hireDate;
// 能收培训提醒的人：不是纯服务账号、账号可用、未离职（定时任务、一键提醒、看板 remindable 同一口径）
const isRemindableUser = (u) => !!u && !isServiceAccount(u) && u.active !== 0 && u.empStatus !== "exited";
// 截止日当天 23:59:59 之后算逾期
const isOverdue = (dueAt, now) => !!dueAt && new Date(dueAt + "T23:59:59") < (now || new Date());

// 培养项目期次引用的课程（程序）id：线上 / 线下课程活动 → 含这门课的程序（包装程序；旧版课程包也算），
// 结业考试 → 考试所属程序，旧版 program 活动 → 该程序；线上活动（type online）不引用内容。
// server.js 的 tpProgramIds（加入期次时派课）委托这里，退训判定（withdrawnOnly）用同一推导。
// getCourse(id) → 课程或 null；programsOfCourse(courseId, course) → [programId…]；getExam(id) → 考试或 null。
function cohortProgramIds(cohort, { getCourse, programsOfCourse, getExam }) {
  const ids = new Set();
  for (const ph of (cohort && cohort.phases) || []) {
    for (const a of ph.activities || []) {
      if (!a || !a.refId) continue;
      if (a.type === "program") ids.add(a.refId);
      else if (a.type === "exam") { const e = getExam(a.refId); if (e) ids.add(e.programId); }
      else if (a.type === "course") {
        const c = getCourse(a.refId);
        if (c) for (const pid of programsOfCourse(c.id, c)) ids.add(pid);
      }
    }
  }
  ids.delete(undefined);
  ids.delete(null);
  return [...ids];
}
// 课程 → 含它的程序（courseIds 反查；旧课程文档带 programId 的兜底）。与 server.js 的 programsContaining 同一规则，
// 给没有服务端缓存的定时脚本用：programsOfCourseFrom(store.listContent("program"))。
function programsOfCourseFrom(programs) {
  const idx = new Map();
  for (const p of programs || []) for (const cid of p.courseIds || []) { if (!idx.has(cid)) idx.set(cid, []); idx.get(cid).push(p.id); }
  return (courseId, course) => {
    const hit = idx.get(courseId);
    if (hit && hit.length) return hit;
    return course && course.programId ? [course.programId] : [];
  };
}
// 退训后不再提醒（负责人 2026-10-07）：指派时间落在学员待在某个期次的那一段之内（进入该期次前 5 分钟起、到离开这一段为止），
// 且该期次引用这门课，才算「由该项目派出」。加入 / 调入期次时先写成员、随后派课，两者相差毫秒；放宽 5 分钟只为吸收时钟与顺序差。
// 加入前 HR 已派的课：setAssignment 冲突时保留原 assignedAt，早于进入时间 → 不算项目派出，退训后照常提醒；
// 退训（或调走）之后 HR 删掉重派的课：assignedAt 晚于这一段的结束 → 也不算。
// 期次轨迹见 store.js 迁移 66（project_members.cohortLog）；没有轨迹的旧行按「当前期次、addedAt 起、未结束」一段处理。
const WITHDRAWN_ASSIGN_GRACE_MS = 5 * 60 * 1000;
const NO_REFS = new Set();
// 成员记录的期次轨迹：store.listUserMemberships 给的 cohorts；没有时（旧行、单元测试的假 store）= 当前期次、addedAt 起、未结束
const memberStints = (m) => (Array.isArray(m.cohorts) && m.cohorts.length ? m.cohorts : [{ cohortId: m.cohortId, enteredAt: m.addedAt, leftAt: null }]);

// memoExams：一次运行内缓存「课程的已发布考试」（定时脚本用；服务端读实时数据，不开）
// listProjects() → 培养项目文档（服务端读 TPROJECTS 缓存；定时脚本读一次 listContent("tproject")）；
// programsOfCourse 见上。两者都不传时不做退训判定（withdrawnOnly 恒为 false，单元测试的假 store 用）。
function createCompletion({ store, getCourse, memoExams = false, listProjects = null, programsOfCourse = null }) {
  const examMemo = memoExams ? new Map() : null;
  const userProgress = (userId, courseId) => store.getCourseProgress(userId, courseId);
  // 旧版课程包可能没有 courseIds；已删的课程略过
  const coursesInProgram = (program) => (program.courseIds || []).map(getCourse).filter(Boolean);
  function courseAttendance(userId, courseId) {
    const st = store.getUserActivityStates(userId, "__course__")[courseCkId(courseId)];
    return st ? st.status : null;
  }
  function progressPercent(userId, course) {
    // For an in-person course, attendance IS completion.
    if ((course.mode || "online") === "offline")
      return ATTENDED_STATES.includes(courseAttendance(userId, course.id)) ? 100 : 0;
    if (!course.modules.length) return 0; // empty online course has no progress yet
    const done = Object.keys(userProgress(userId, course.id)).length;
    return Math.round((done / course.modules.length) * 100);
  }
  // Program progress rolls up module completion across all of the program's
  // courses; an offline course counts as one attendance-driven unit.
  function programProgress(userId, program) {
    let done = 0, total = 0;
    for (const c of coursesInProgram(program)) {
      if ((c.mode || "online") === "offline") {
        total += 1;
        if (progressPercent(userId, c) >= 100) done += 1;
        continue;
      }
      total += c.modules.length;
      done += Object.keys(userProgress(userId, c.id)).length;
    }
    return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
  }
  // Employees only ever see published exams; drafts/archived are HR-side.
  function publishedProgramExams(programId) {
    if (examMemo && examMemo.has(programId)) return examMemo.get(programId);
    const list = store.listProgramExams(programId).filter((e) => e.status === "published");
    if (examMemo) examMemo.set(programId, list);
    return list;
  }
  // 「这门课（程序）算不算完成」的唯一口径：有已发布考试 → 最好成绩已通过（且线下课程已出席）；
  // 无考试（未建或已关闭「需要结业考试」）→ 学习进度 100% 即完成。
  // 学习记录、总览、导出、逾期提醒（含定时任务）、晋升条件等都走这里，避免各处只看考试通过。
  function programHasExam(programId) {
    return publishedProgramExams(programId).length > 0;
  }
  // 课程里的线下课程是否都已出席 / 迟到（没有线下课程时恒为 true）
  function offlineAttended(userId, p) {
    return coursesInProgram(p).every((c) => (c.mode || "online") !== "offline" || ATTENDED_STATES.includes(courseAttendance(userId, c.id)));
  }
  function programDone(userId, p) {
    if (!p) return false;
    if (programHasExam(p.id)) {
      const b = store.bestAttempt(userId, p.id);
      if (!(b && b.passed)) return false;
      // 线下课程还须有出席 / 迟到记录（负责人 2026-10-06：请假需补课，线下课程请假不算学完）：
      // 考试通过后被改为请假、或请假前已通过考试的，在补课出席前都不算完成。
      return offlineAttended(userId, p);
    }
    return programProgress(userId, p).percent >= 100;
  }
  // 完成日期（第三批 1.4，培训概览的「本期完成」、名单与导出共用；未完成 → null）。返回 ISO 时间。
  //   有已发布考试：首次有效通过（已出结论、未作废、通过的答卷里最早的 submittedAt）与各线下课程出席日期中较晚者；
  //   没有考试：各线上课程最后一个模块的完成时间与各线下课程出席日期中较晚者。
  // 出席日期 = 出勤行的 at；课程设了开课时间（sessionAt，本地时间）且早于 at 时用开课时间 —— 场次那天才是学完的日子，
  // 点名常在事后补录（10/06 从 Lark 导入的出勤因此按场次日计）。
  function attendanceDoneAt(userId, c) {
    const st = store.getUserActivityStates(userId, "__course__")[courseCkId(c.id)];
    if (!st || !ATTENDED_STATES.includes(st.status)) return null;
    const at = Date.parse(st.at);
    const ses = c.sessionAt ? new Date(String(c.sessionAt).slice(0, 16)).getTime() : NaN;
    if (Number.isFinite(ses) && (!Number.isFinite(at) || ses < at)) return new Date(ses).toISOString();
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  const SETTLED_OK = (a) => !a.voided && !["grading", "pending_review"].includes(a.gradingStatus || "final");
  function programDoneAt(userId, p) {
    if (!p || !programDone(userId, p)) return null;
    let latest = null;
    const take = (iso) => { if (iso && (!latest || iso > latest)) latest = iso; };
    const courses = coursesInProgram(p);
    if (programHasExam(p.id)) {
      const passes = (store.listUserAttempts(userId, p.id) || []).filter((a) => a.passed && a.submittedAt && SETTLED_OK(a));
      let first = null;
      for (const a of passes) if (!first || a.submittedAt < first) first = a.submittedAt;
      take(first ? new Date(first).toISOString() : null);
      for (const c of courses) if ((c.mode || "online") === "offline") take(attendanceDoneAt(userId, c));
    } else {
      for (const c of courses) {
        if ((c.mode || "online") === "offline") { take(attendanceDoneAt(userId, c)); continue; }
        const prog = userProgress(userId, c.id);
        for (const iso of Object.values(prog)) if (iso) take(new Date(iso).toISOString());
      }
    }
    return latest;
  }
  // 进度分母（与人无关）：线下课程每门算 1，线上课程按模块数
  function programUnits(p) {
    let n = 0;
    for (const c of coursesInProgram(p)) n += (c.mode || "online") === "offline" ? 1 : (c.modules || []).length;
    return n;
  }
  // 能不能完成：有已发布考试，或进度分母大于 0。线上课程 0 个模块又没有考试、或一门课都不含的旧课程包，
  // 进度永远是 0%，提醒了也完成不了 —— 定时任务与一键提醒都跳过（负责人 2026-10-07）。
  const programCompletable = (p) => !!p && (programHasExam(p.id) || programUnits(p) > 0);
  // 成绩待定：本课程任一已发布考试有评分中 / 待 HR 复核的答卷。员工端此时显示「成绩待定」，
  // 三条提醒路径都不催（负责人 2026-10-07）。
  const resultPending = (userId, p) => !!p && publishedProgramExams(p.id).some((e) => !!store.pendingExamAttempt(userId, e.id));
  // 退训判定的两层缓存（看板逾期名单、定时任务都是逐行调用，不能每行重算期次）：
  //   项目列表 → 按 id 的索引（以 listProjects() 返回的数组为键）；期次 → 它引用的课程 id 集合（以期次对象为键）。
  // 服务端 refreshContent 整批换掉 TPROJECTS（课程、程序同时重读），旧对象连同缓存一起失效；定时脚本只读一次项目。
  const projectIndexMemo = new WeakMap();
  const cohortRefsMemo = new WeakMap();
  const getExamFn = (id) => store.getExam(id);
  function projectIndex() {
    const list = listProjects() || [];
    let idx = projectIndexMemo.get(list);
    if (!idx) { idx = new Map(list.map((d) => [d.id, d])); projectIndexMemo.set(list, idx); }
    return idx;
  }
  function cohortRefs(idx, projectId, cohortId) {
    const doc = idx.get(projectId);
    const cohort = doc && (doc.cohorts || []).find((c) => c.id === cohortId);
    if (!cohort) return NO_REFS;
    let s = cohortRefsMemo.get(cohort);
    if (!s) { s = new Set(cohortProgramIds(cohort, { getCourse, programsOfCourse, getExam: getExamFn })); cohortRefsMemo.set(cohort, s); }
    return s;
  }
  // 「仅因已退训项目而有的指派」（负责人 2026-10-07：退训后不再提醒）。三条同时成立才算：
  //   ① 这个人有一条已退训（state = 'withdrawn'）的学员成员记录，他在该项目里待过的某个期次（期次轨迹，含调期前的期次）引用这门课程（程序）；
  //   ② 没有任何在训（active）的学员成员记录，其当前期次也引用这门课程；
  //   ③ 这条指派由项目派出：assignedAt 落在 ① 那一段之内 —— 不早于进入该期次前 5 分钟、不晚于离开这一段（调走或退训）。
  // 指派与看板数据都不动（仍算逾期），只是三条提醒路径都不催。重新加入项目（成员记录恢复 active）后自动恢复提醒。
  // asg：调用方手上已有的这条指派（{ assignedAt }），传了就不再查库；不传（undefined）时自己查。
  function withdrawnOnly(userId, programId, asg) {
    if (!listProjects || !programsOfCourse) return false;
    const mine = (store.listUserMemberships(userId) || []).filter((m) => m.role === "learner");
    const left = mine.filter((m) => m.state === "withdrawn");
    if (!left.length) return false; // 绝大多数人到这里就结束（一次按人查询）
    const idx = projectIndex();
    const stints = [];
    for (const m of left) for (const s of memberStints(m)) if (cohortRefs(idx, m.projectId, s.cohortId).has(programId)) stints.push(s);
    if (!stints.length) return false;
    if (mine.some((m) => m.state === "active" && cohortRefs(idx, m.projectId, m.cohortId).has(programId))) return false;
    const a = asg !== undefined ? asg : store.getUserAssignments(userId)[programId];
    const at = a ? Date.parse(a.assignedAt) : NaN;
    if (!Number.isFinite(at)) return false; // 没有指派时间的旧数据：不能证明由项目派出，照常提醒
    return stints.some((s) => {
      const from = Date.parse(s.enteredAt);
      const to = s.leftAt ? Date.parse(s.leftAt) : Infinity; // 解析不了的结束时间按未结束
      return Number.isFinite(from) && at >= from - WITHDRAWN_ASSIGN_GRACE_MS && !(at > to);
    });
  }
  // 这一对人 × 课程此刻能不能收培训提醒（是否已完成、是否逾期由调用方另判）：
  // 人可提醒、课程已发布、课程能完成、没有待定的成绩、不是「仅因已退训项目而有的指派」。asg 见 withdrawnOnly。
  const reminderEligible = (u, p, asg) => isRemindableUser(u) && isPublishedProgram(p) && programCompletable(p) && !resultPending(u.id, p) && !withdrawnOnly(u.id, p.id, asg);
  return {
    userProgress, coursesInProgram, courseAttendance, progressPercent, programProgress,
    publishedProgramExams, programHasExam, offlineAttended, programDone, programDoneAt,
    programUnits, programCompletable, resultPending, withdrawnOnly, reminderEligible,
  };
}

module.exports = {
  ATTENDED_STATES, courseCkId, isPublishedProgram, isServiceAccount, isRemindableUser, isOverdue,
  cohortProgramIds, programsOfCourseFrom, WITHDRAWN_ASSIGN_GRACE_MS, createCompletion,
};
