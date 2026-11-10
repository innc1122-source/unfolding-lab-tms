"use strict";
// 学习（课程、考试、发展项目、签到） 的接口处理（简化 10/11：从 server.js 的 handleApi 原样搬出，代码不改；按原顺序分段，server.js 在原位置依次调用）。
// 每段是一个方法：C = 本段用到的 handleApi 局部变量（req、res、user、body、audit 等）；S = server.js 的模块级函数与常量
// （getter，取调用当时的值；require / __dirname 也是 server.js 的，相对路径照旧以仓库根目录为准）。
// 段内匹配到接口时照原样 return；都没匹配到时返回 S.ROUTE_NEXT，server.js 接着往下匹配。改接口就在这里改。
module.exports = function routes(S) {
  return {
    // server.js handleApi 原第 8999–9203 行（登录后的员工端接口）
    async meLearning1(C) {
      const { pathname, user, res, isAssigned, myAssignments, isPublished, req, query, audit, body } = C;
      const { store, getTProject, tpCohort, tpProgramIds, send, PROGRAMS, coursesInProgram, bestAttempt, publishedProgramExams, courseAttendance, programProgress, programDone, learnerExamState, programCourseId, getCourse, canRead, programHasExam, catalogListed, catalogItemOf, CAT, getProgram, PUBC, todayLocal, newToken, notifyAdmins } = S;
  if (pathname === "/api/programs") {
    // Which of my assigned programs arrived via a training project — the same
    // derivation /api/catalog does, hoisted here because My Learning renders this
    // list and needs to label the card's origin.
    const viaProjectSet = new Set();
    for (const m of store.getUserMemberships(user.id)) {
      if (m.role !== "learner") continue;
      const doc = getTProject(m.projectId);
      if (!doc || doc.status === "draft") continue;
      const c = tpCohort(doc, m.cohortId);
      if (c) for (const pid of tpProgramIds(c)) viaProjectSet.add(pid);
    }
    return send(
      res, 200,
      PROGRAMS.filter((p) => isAssigned(p.id)).map((p) => {
        const courses = coursesInProgram(p);
        const best = bestAttempt(user.id, p.id);
        const only = courses.length === 1 ? courses[0] : null;
        const pubExams = publishedProgramExams(p.id);
        return {
          id: p.id, title: p.title, title_zh: p.title_zh, description: p.description, description_zh: p.description_zh,
          enrollType: p.enrollType || "mandatory",
          viaProject: viaProjectSet.has(p.id),
          courseId: only ? only.id : null,
          mode: only ? only.mode || "online" : "online",
          sessionAt: only ? only.sessionAt || null : null,
          location: only ? only.location || null : null,
          // 单门线下课程的出勤记录（attended / late / excused / absent / null）：「课程」页卡片据此
          // 显示「已请假 · 需补课」（负责人 2026-10-06：请假不算完成、需补课）。
          attendance: only && (only.mode || "online") === "offline" ? courseAttendance(user.id, only.id) : null,
          courseCount: courses.length,
          moduleCount: courses.reduce((s, c) => s + c.modules.length, 0),
          minutes: courses.reduce((s, c) => s + c.modules.reduce((n, m) => n + m.minutes, 0), 0),
          passingScore: p.passingScore,
          progress: programProgress(user.id, p).percent,
          dueAt: myAssignments[p.id] ? myAssignments[p.id].dueAt : null,
          best: best ? { percent: best.percent, passed: best.passed } : null,
          // 无已发布考试 = 不需要结业考试：员工端按进度 100% 即「已完成」，不显示分数
          hasExam: pubExams.length > 0,
          done: programDone(user.id, p),
          // 有结论待定（评分中 / 待 HR 复核）的答卷：员工端显示「成绩待定」，不显示「未通过」（AI 治理方案 2.5）
          resultPending: pubExams.some((e) => !!store.pendingExamAttempt(user.id, e.id)),
          // 第三批 5.4 / 10.8：learnStatus、attemptsLeft、retakeAvailableAt、retakeExamId、retake（learnerExamState）
          ...learnerExamState(user.id, p),
          // 第四批 7：来源（assigned 指派 / self 自主学习；learning 读者预览未指派的课时为 null）、是否公开课程、
          // publicClosed = 自主学习且课程已不再公开（9.2 方案 A：仍可学完，卡片上提示）
          ...(() => {
            const a = myAssignments[p.id];
            const cid = programCourseId(p); const c = cid ? getCourse(cid) : null;
            const pub = !!(c && c.public === true);
            const source = a ? (a.source === "self" ? "self" : "assigned") : null;
            return { source, public: pub, publicClosed: source === "self" && !pub };
          })(),
        };
      })
    );
  }
  // Course catalog: ALL published programs with this employee's relationship to
  // each (assigned / pending request / rejected / none) — powers the home page.
  if (pathname === "/api/catalog") {
    const reqMap = store.getUserRequestMap(user.id);
    // Programs already covered by one of my training projects get a badge so
    // nobody applies twice for the same content.
    const viaSet = new Set();
    for (const m of store.getUserMemberships(user.id)) {
      if (m.role !== "learner") continue;
      const doc = getTProject(m.projectId);
      if (!doc || doc.status === "draft") continue;
      const c = tpCohort(doc, m.cohortId);
      if (c) for (const pid of tpProgramIds(c)) viaSet.add(pid);
    }
    const items = PROGRAMS.filter(isPublished).filter((p) => {
      // In-person courses don't belong in the browsing catalog — assigned
      // people see them under My Learning instead.
      const cs = coursesInProgram(p);
      return !(cs.length === 1 && (cs[0].mode || "online") === "offline");
    }).map((p) => {
      const courses = coursesInProgram(p);
      const assigned = canRead(user, "learning") || !!myAssignments[p.id];
      const rq = reqMap[p.id];
      let status = "none";
      if (assigned) status = "assigned";
      else if (rq && rq.status === "pending") status = "pending";
      else if (rq && rq.status === "rejected") status = "rejected";
      const best = assigned ? bestAttempt(user.id, p.id) : null;
      // Single-course wrappers ARE the course in every UI — pass the course id
      // for direct deep-links plus the delivery mode (online / offline session).
      const only = courses.length === 1 ? courses[0] : null;
      return {
        id: p.id, title: p.title, title_zh: p.title_zh, description: p.description, description_zh: p.description_zh,
        category: p.category || null,
        enrollType: p.enrollType || "mandatory",
        viaProject: viaSet.has(p.id),
        courseId: only ? only.id : null,
        mode: only ? only.mode || "online" : "online",
        sessionAt: only ? only.sessionAt || null : null,
        location: only ? only.location || null : null,
        courseCount: courses.length,
        moduleCount: courses.reduce((s, c) => s + c.modules.length, 0),
        minutes: courses.reduce((s, c) => s + c.modules.reduce((n, m) => n + m.minutes, 0), 0),
        passingScore: p.passingScore,
        status,
        progress: assigned ? programProgress(user.id, p).percent : 0,
        dueAt: myAssignments[p.id] ? myAssignments[p.id].dueAt : null,
        best: best ? { percent: best.percent, passed: best.passed } : null,
        hasExam: programHasExam(p.id),
        done: assigned ? programDone(user.id, p) : false,
        rejectNote: status === "rejected" ? (rq.decideNote || null) : null,
        // 第三批 5.4 / 10.7 / 10.8：首页课程区块的排序与「去补考」入口（只给已指派的）
        ...(assigned ? learnerExamState(user.id, p) : {}),
        // 第四批 7：公开课程（首页「可申请的选修课程」不再列它们，改在「课程目录」直接开始学习）
        public: (() => { const cid = programCourseId(p); const c = cid ? getCourse(cid) : null; return !!(c && c.public === true); })(),
      };
    });
    return send(res, 200, items);
  }
  // ---- 第四批 7（2026-10-08）：课程目录（公开课程，全员可自主学习，无需申请）。不含任何人员数据。 ----
  // GET /api/catalog/courses[?count=1]：{ items:[catalogItemOf…], categories:[在用的类别键] } 或 { count }（导航用）
  if (pathname === "/api/catalog/courses" && req.method === "GET") {
    const listed = [];
    for (const p of PROGRAMS) {
      const asg = myAssignments[p.id];
      if (!catalogListed(p, asg)) continue;
      listed.push({ p, c: getCourse(programCourseId(p)), asg });
    }
    if (query.get("count") === "1") return send(res, 200, { count: listed.length });
    const items = listed.map(({ p, c, asg }) => catalogItemOf(user.id, p, c, asg));
    const categories = [...new Set(items.map((x) => x.category).filter(Boolean))].sort(CAT.compareCategory);
    return send(res, 200, { items, categories });
  }
  // GET /api/catalog/courses/:programId：条目 + 简介全文、模块大纲（只有名称与时长）、考试规则、线下课程的讲师姓名。未收录 → 404 not_public
  const catCourse = pathname.match(/^\/api\/catalog\/courses\/([\w-]+)$/);
  if (catCourse && req.method === "GET") {
    const p = getProgram(catCourse[1]);
    const asg = p ? myAssignments[p.id] : null;
    if (!p || !catalogListed(p, asg)) return send(res, 404, { error: "This course is not among the public courses.", error_zh: "「公开课」里没有这门课程。", code: "not_public" });
    const c = getCourse(programCourseId(p));
    const ex = publishedProgramExams(p.id)[0] || null;
    const trainer = (c.mode || "online") === "offline" && c.trainerId ? store.getUserById(c.trainerId) : null;
    return send(res, 200, {
      ...catalogItemOf(user.id, p, c, asg),
      description: c.description || null, description_zh: c.description_zh || null,
      outline: (c.modules || []).map((m) => ({ title: m.title, title_zh: m.title_zh || null, minutes: Number(m.minutes) || 0 })),
      exam: ex ? { passingScore: ex.passingScore, timeLimitMinutes: ex.timeLimitMinutes || null } : null,
      trainerName: trainer ? trainer.name : null,
    });
  }
  // POST / DELETE /api/catalog/courses/:programId/enroll：自主加入 / 退出自主学习（幂等；不通知管理员、不建审批）
  const catEnroll = pathname.match(/^\/api\/catalog\/courses\/([\w-]+)\/enroll$/);
  if (catEnroll && req.method === "POST") {
    const p = getProgram(catEnroll[1]);
    const asg = p ? myAssignments[p.id] : null;
    const listed = !!p && catalogListed(p, asg);
    const c = listed ? getCourse(programCourseId(p)) : null;
    const d = PUBC.enrollDecision({ listed, asg, course: c, today: todayLocal(), active: user.active !== 0 });
    if (d.action === "reject") {
      if (d.code === "session_passed") return send(res, 409, { error: "This session has already taken place.", error_zh: "这门线下课程的开课日期已过，不能再加入。", code: "session_passed" });
      if (d.code === "inactive") return send(res, 403, { error: "Your account is inactive.", error_zh: "账号已停用。", code: "inactive" });
      return send(res, 404, { error: "This course is not among the public courses.", error_zh: "「公开课」里没有这门课程。", code: "not_public" });
    }
    if (d.action === "already") return send(res, 200, { ok: true, status: d.status, already: true, programId: p.id, courseId: c.id });
    store.selfEnroll(user.id, p.id);
    audit("course.self-enroll", p.id, null, { courseId: c.id });
    return send(res, 200, { ok: true, status: "self", programId: p.id, courseId: c.id });
  }
  if (catEnroll && req.method === "DELETE") {
    const p = getProgram(catEnroll[1]);
    if (!p) return send(res, 404, { error: "Course not found", error_zh: "课程不存在。", code: "not_found" });
    const asg = myAssignments[p.id];
    const d = PUBC.leaveDecision({ asg, done: asg ? programDone(user.id, p) : false });
    if (!d.ok) return send(res, 400, d.code === "already_done"
      ? { error: "You have already completed this course.", error_zh: "这门课程你已完成，不能退出。", code: "already_done" }
      : { error: "Only courses you joined yourself can be left.", error_zh: "只有自主加入的课程可以退出。", code: "not_self" });
    store.removeSelfEnrollment(user.id, p.id);
    audit("course.self-leave", p.id, null, { courseId: programCourseId(p) });
    return send(res, 200, { ok: true, status: "none", programId: p.id });
  }
  // Employee applies to enrol in an elective program (→ HR approval).
  if (pathname === "/api/me/enroll-requests" && req.method === "POST") {
    const { programId, note } = body;
    const p = getProgram(programId);
    if (!p || !isPublished(p)) return send(res, 404, { error: "Program not found" });
    // 第四批 7：公开课程不走申请，直接在「课程目录」开始学习
    if (catalogListed(p, myAssignments[p.id])) return send(res, 400, { error: "This is a public course. Start it directly from Public Courses.", error_zh: "该课程为公开课程，可在「公开课」直接开始学习。", code: "use_catalog", programId: p.id });
    if ((p.enrollType || "mandatory") !== "elective") return send(res, 400, { error: "This program isn't open for self-enrollment." });
    if (myAssignments[p.id]) return send(res, 400, { error: "You're already enrolled in this program." });
    const r = store.createEnrollmentRequest({ id: "er-" + newToken().slice(0, 10), userId: user.id, programId: p.id, note: note ? String(note).slice(0, 500) : null });
    audit("enroll.request", p.id, null, { by: user.employeeId, note: r.note || null });
    notifyAdmins({
      type: "enroll.request",
      title: `${user.name} applied for "${p.title || p.title_zh || ""}"`,
      title_zh: `${user.name} 申请学习《${p.title_zh || p.title}》`,
      body: "Pending your approval under Requests.",
      body_zh: "待你在「学习申请」中审批。",
      link: "#/admin/requests",
    }, "learning");
    return send(res, 200, { ok: true, status: r.status });
  }
  // Employee's own requests (for a "my applications" view).
  if (pathname === "/api/me/enroll-requests" && req.method === "GET") {
    return send(res, 200, store.listUserRequests(user.id).map((r) => {
      const p = getProgram(r.programId);
      return { id: r.id, programId: r.programId, program: p ? p.title : r.programId, program_zh: p ? p.title_zh : null, status: r.status, note: r.note, decideNote: r.decideNote, requestedAt: r.requestedAt, decidedAt: r.decidedAt };
    }));
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 9206–9242 行（登录后的员工端接口）
    async meLearning2(C) {
      const { pathname, req, myMemberships, user, res } = C;
      const { getTProject, tpCohort, tpPhaseView, tpActivityView, tpProgressPercent, store, TPROJECTS, send } = S;
  if (pathname === "/api/me/tprojects" && req.method === "GET") {
    const mine = [];
    for (const m of myMemberships()) {
      const doc = getTProject(m.projectId);
      if (!doc || doc.status === "draft") continue;
      const cohort = tpCohort(doc, m.cohortId);
      if (!cohort) continue;
      const phases = tpPhaseView(user.id, doc.id, cohort);
      const cur = phases.find((p) => p.unlocked && !p.complete) || null;
      // Never point "what's next" at a broken reference — it would render as a
      // raw type keyword and lead nowhere.
      const openActs = cur ? cur.activities.filter((a) => !a.broken) : [];
      const nextAct = cur ? openActs.filter((a) => a.required !== false).find((a) => !a.done) || openActs.find((a) => !a.done) || null : null;
      const cls = (cohort.classes || []).find((c) => c.id === m.classId) || null;
      mine.push({
        id: doc.id, code: doc.code, title: doc.title, title_zh: doc.title_zh, category: doc.category || null, status: doc.status,
        cohort: cohort.name, class: cls ? cls.name : null, endAt: cohort.endAt || null,
        phaseCount: phases.length, phaseDone: phases.filter((p) => p.complete).length,
        currentPhase: cur ? { name: cur.name, name_zh: cur.name_zh } : null,
        nextActivity: nextAct ? tpActivityView(nextAct) : null,
        progress: tpProgressPercent(phases),
      });
    }
    // Open-for-application cohorts (self-nomination), minus ones I'm in/applied.
    const myIds = new Set(myMemberships().map((m) => m.projectId));
    const myNoms = store.listApprovalsFor(user.id, "nomination");
    const open = [];
    for (const doc of TPROJECTS) {
      if (!["planning", "running"].includes(doc.status)) continue;
      if (myIds.has(doc.id)) continue;
      const cohort = (doc.cohorts || []).find((c) => c.open);
      if (!cohort) continue;
      const pending = myNoms.some((n) => n.status === "pending" && JSON.parse(n.subjectJson || "{}").projectId === doc.id);
      open.push({ id: doc.id, title: doc.title, title_zh: doc.title_zh, category: doc.category || null, cohort: cohort.name, applied: pending });
    }
    return send(res, 200, { mine, open });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 9631–9880 行（登录后的员工端接口）
    async meLearning3(C) {
      const { pathname, req, user, res, audit, body, isAssigned, myAssignments } = C;
      const { store, reportingLineEntry, send, modulesOn, buildTalentTimeline, optionZh, reviewOneState, tagsForLine, reportingChain, getProgram, programProgress, bestAttempt, programDone, programHasExam, profileTabsFor, myClasses, classSummary, tpPhaseView, tpProgressPercent, tpActivities, getCourse, tpActivityView, tpCheckinTarget, trainerActivityScope, checkinSlot, tpCheckinOpen, checkinCode, tpCohortEnded, catalogListed, publishedProgramExams, examSummary, coursesInProgram, progressPercent } = S;
  const mgrProf = pathname.match(/^\/api\/me\/reports\/([\w-]+)$/);
  if (mgrProf && req.method === "GET") {
    const t = store.getUserById(mgrProf[1]);
    const hit = t ? reportingLineEntry(user.id, t.id) : null;
    if (!hit) return send(res, 404, { error: "Not found" }); // not mine → same as missing
    const mods = modulesOn();
    const { events, stats } = buildTalentTimeline(t);
    const types = Object.fromEntries(store.listRecordTypes(true).map((x) => [x.key, x]));
    const fieldsByType = {};
    for (const f of store.listRecordFields(null)) (fieldsByType[f.typeKey] = fieldsByType[f.typeKey] || []).push(f);
    const timeline = [];
    for (const e of events) {
      if (e.type === "hired") { timeline.push({ kind: "hired", date: e.date, title: e.title, title_zh: e.title_zh || null }); continue; }
      if (e.source === "lms") { if (mods.learning) timeline.push({ kind: "lms", date: e.date, title: e.title, title_zh: e.title_zh || null, lms: e.lms }); continue; }
      const ty = types[e.type];
      if (!ty) continue;                                   // orphaned type key
      if (e.type === "performance" && !mods.performance) continue;
      // 备注 (type=note) stays with HR — the ONE type this route drops.
      // Every other type is a fact about the person's file: a transfer, a
      // regularization, an exit, a violation and its handling, an award. `note`
      // is not — it is HR's own free-text remark ("flagged for a PIP", "do not
      // rehire", an open investigation), which is why it ships employeeVisible=
      // false out of the box. D3 grants the manager the FILE (lifecycle records
      // + the whole performance history); it does not grant HR's notes ON the
      // file, and D8 widened this route to the WHOLE line, so keeping it would
      // put HR's scratchpad in front of every manager above the person — for a
      // director, hundreds of them. 宁可少给 (security audit 2026-09-03). HR keeps
      // reading it in the console.
      // 第二批 8.3（迁移 71）：原来写死的「跳过 note」改为按类型的「经理可见」开关 —— note 默认关（行为不变），HR 可以把
      // 别的类型（例如「测评结果」）也设为只在后台可见；关掉的类型在时间线、统计与绩效历史里都不出现。
      if (!ty.managerVisible) continue;
      // NOTE: no employeeVisible filter beyond that, unlike /api/me/growth. D3
      // gives the manager the FULL record — that flag hides types from the person
      // themselves (a violation, an exit), which is a different question from
      // what the manager accountable for them reads.
      const lines = [];
      for (const f of fieldsByType[e.type] || []) {
        if (!f.active || f.input === "checkbox") continue; // checkboxes are side-effect toggles (syncStatus), not content
        const v = e.detail[f.key];
        if (v === undefined || v === null || v === "") continue;
        const sv = String(v);
        lines.push({ label: f.label, label_zh: f.label_zh || f.label, value: sv, value_zh: (f.options || []).length ? String(optionZh(f, sv)) : sv });
      }
      timeline.push({
        kind: "record", type: e.type, date: e.date, title: e.title,
        typeLabel: ty.label, typeLabel_zh: ty.label_zh || ty.label, color: ty.color, lines,
      });
    }
    // 第二批 8.3：统计里对上级隐藏的类型不计数（否则「违规 2 条」本身就是信息）
    const mgrStats = { ...stats };
    const hiddenTypes = new Set(Object.values(types).filter((x) => !x.managerVisible).map((x) => x.key));
    if (hiddenTypes.size) {
      const recs = store.listTalentRecords(t.id);
      const cnt = (k) => recs.filter((r) => r.type === k).length;
      if (hiddenTypes.has("training")) mgrStats.trainingsPassed = Math.max(0, stats.trainingsPassed - cnt("training"));
      if (hiddenTypes.has("award")) mgrStats.awards = 0;
      if (hiddenTypes.has("violation")) mgrStats.violations = 0;
      if (hiddenTypes.has("promotion")) mgrStats.promotions = 0;
    }
    // Performance history in full (D3), from BOTH halves: the permanent records
    // a closed cycle archives, plus the ratings of cycles still open (which have
    // no record yet). Not limited to reviews this caller wrote.
    const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
    const zhOf = (v) => (v && ratingField && (ratingField.options || []).length ? String(optionZh(ratingField, v)) : v || null);
    const perfMgrVisible = !!(types.performance && types.performance.managerVisible);
    const performance = !mods.performance ? [] : [
      ...(perfMgrVisible ? store.listTalentRecords(t.id) : []).filter((r) => r.type === "performance").map((r) => ({
        source: "archived", date: r.date,
        cycle: r.detail.period || r.title || null,
        rating: r.detail.rating ?? null, rating_zh: zhOf(r.detail.rating),
        summary: r.detail.summary || "", pending: false,
      })),
      // 进行中的 v2 周期只给状态、不给评级（第二批默认 D8：HR 确认前 HoD 的调整不该沿汇报线往上传，评语同样不给）：
      //   { source:"open", flow:"v2", rating:null, rating_zh:null, summary:"", pending, status:{ self, one, rated } }
      //   self = 已交自评；one = 面谈登记状态 both|mgr|emp|none（reviewOneState）；rated = 已有上级评级或 HoD 评级。
      // 旧流程周期照原样（上级评完即是结果，HR 校准在后台）。
      ...store.listMyReviewItems(t.id).map((i) => (i.cycleFlow === "v2" ? {
        source: "open", flow: "v2", date: (i.managerAt || "").slice(0, 10) || null,
        cycle: i.cycleName, rating: null, rating_zh: null, summary: "",
        pending: !(i.managerRating || i.finalRating),
        status: { self: !!i.selfAt, one: reviewOneState(i), rated: !!(i.managerRating || i.finalRating) },
      } : {
        source: "open", date: (i.managerAt || "").slice(0, 10) || null,
        cycle: i.cycleName,
        rating: i.finalRating || i.managerRating || null, rating_zh: zhOf(i.finalRating || i.managerRating),
        summary: i.managerText || "", pending: !i.managerAt,
      })),
    ].sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")));
    const upline = t.managerId ? store.getUserById(t.managerId) : null;
    audit("manager.view_profile", t.employeeId, null, {
      name: t.name, department: t.department || null,
      relation: hit.depth === 1 ? "direct" : "indirect", depth: hit.depth,
    });
    return send(res, 200, {
      user: {
        id: t.id, name: t.name,   /* 第三批 9.1：员工端不下发工号 */ 
        department: t.department || "", position: t.position || "", jobLevel: t.jobLevel || "",
        hireDate: t.hireDate || "", empStatus: t.empStatus || "", active: t.active !== 0,
        managerId: t.managerId || null, managerName: upline ? upline.name : null,
        // 9-box axes ride the talent module, matching how the console hides them.
        // 12.2 / §13：「流失风险」对直属上级与汇报线上级不可见（高潜、关键人才照常）
        talentTags: mods.talent ? tagsForLine(t) : [],
        potential: mods.talent ? (t.potential || "") : "",
        relation: hit.depth === 1 ? "direct" : "indirect", depth: hit.depth,
      },
      // Who sits between me and them (empty for a direct report).
      chain: reportingChain(user.id, t),
      stats: mgrStats, events: timeline, performance,
      assignments: !mods.learning ? [] : Object.entries(store.getUserAssignments(t.id)).map(([pid, asg]) => {
        const p = getProgram(pid);
        if (!p) return null;
        const prog = programProgress(t.id, p);
        const best = bestAttempt(t.id, pid);
        return {
          programId: pid, title: p.title, title_zh: p.title_zh || null,
          enrollType: p.enrollType || "mandatory", dueAt: asg.dueAt || null,
          progress: prog.percent, moduleTotal: prog.total, moduleDone: prog.done,
          bestPercent: best ? best.percent : null, passed: programDone(t.id, p),
          hasExam: programHasExam(pid),
        };
      }).filter(Boolean),
      // Matrix lines this person sits ON (their dotted managers / concurrent
      // posts) — names and scope only, no ids and no HR note.
      secondaryLines: store.listSecondaryLines(t.id).map((r) => {
        const m = r.managerId ? store.getUserById(r.managerId) : null;
        return { kind: r.kind, managerName: m ? m.name : null, position: r.position || null, department: r.department || null };
      }),
      // 模块页签（§5.4，见 profileTabsFor）：汇报线位置。清单与看的是谁无关；能不能看这个人已由上面的
      // reportingLineEntry 判定，页签组件取数时由所属模块的接口再判一次。
      tabs: profileTabsFor(user, "line"),
    });
  }
  // CLASS HEAD (班主任): the classes I shepherd, across every project/cohort.
  if (pathname === "/api/me/classes" && req.method === "GET") {
    return send(res, 200, { classes: myClasses(user.id).map((c) => classSummary(c)) });
  }
  // One class: roster with progress + the cohort's offline sessions to run.
  // The negative lookahead keeps this three-segment route from swallowing
  // /classes/:projectId/checkin/:activityId below it.
  const clsOne = pathname.match(/^\/api\/me\/classes\/([\w-]+)\/(?!checkin(?:\/|$))([\w-]+)\/([\w-]+)$/);
  if (clsOne && req.method === "GET") {
    const found = myClasses(user.id).find((c) => c.doc.id === clsOne[1] && c.cohort.id === clsOne[2] && c.cls.id === clsOne[3]);
    if (!found) return send(res, 404, { error: "Class not found" }); // not mine → indistinguishable from missing
    const learners = store.listProjectMembers(found.doc.id)
      .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === found.cohort.id && m.classId === found.cls.id)
      .map((m) => {
        const u = store.getUserById(m.userId);
        if (!u || u.active === 0) return null;
        const phases = tpPhaseView(m.userId, found.doc.id, found.cohort);
        return {
          userId: m.userId, name: u.name, department: u.department || null,   /* 第三批 9.1：员工端不下发工号 */ 
          progress: tpProgressPercent(phases),
          phaseDone: phases.filter((p) => p.complete).length, phaseCount: phases.length,
        };
      }).filter(Boolean);
    const sessions = tpActivities(found.cohort)
      .filter((a) => a.type === "offline" || (a.type === "course" && (getCourse(a.refId) || {}).mode === "offline"))
      .map((a) => {
        const v = tpActivityView(a);
        const states = store.listActivityStates((tpCheckinTarget(a, found.doc, found.cohort) || { ckId: a.id }).ckId);
        const mine = new Set(learners.map((l) => l.userId));
        const present = states.filter((s) => mine.has(s.userId) && ["attended", "late"].includes(s.status)).length;
        return { id: a.id, title: v.title, title_zh: v.title_zh, startAt: v.startAt, location: v.location, present, total: learners.length };
      });
    return send(res, 200, { ...classSummary(found), learners, sessions });
  }
  // A class head can also take the roll for their OWN class at any session of
  // their cohort — the roll-call is limited to their class members (a trainer,
  // by contrast, sees every attendee of the session they teach).
  const clsCk = pathname.match(/^\/api\/me\/classes\/([\w-]+)\/checkin\/([\w-]+)$/);
  if (clsCk && req.method === "GET") {
    const scope = trainerActivityScope(user.id, clsCk[1], clsCk[2]);
    if (!scope) return send(res, 404, { error: "Session not found" });
    const ckT = tpCheckinTarget(scope.act, scope.doc, scope.cohort);
    if (!ckT) return send(res, 404, { error: "Session not found" });
    const states = {};
    for (const st of store.listActivityStates(ckT.ckId)) states[st.userId] = st;
    const list = scope.learners.map((m) => {
      const u = store.getUserById(m.userId);
      const st = states[m.userId];
      return { userId: m.userId, name: u ? u.name : "?", position: u ? u.position || null : null, status: st ? st.status : null, at: st ? st.at : null };   /* 第三批 9.1：员工端不下发工号 */ 
    });
    const slot = checkinSlot();
    const v = tpActivityView(scope.act);
    return send(res, 200, {
      title: v.title, title_zh: v.title_zh, startAt: v.startAt, location: v.location,
      className: scope.cls.name,
      code: tpCheckinOpen(scope.doc, scope.cohort) ? checkinCode(ckT.ckId, slot) : null,
      checkinOpen: tpCheckinOpen(scope.doc, scope.cohort),
      cohortEnded: tpCohortEnded(scope.cohort),   // CX-025
      secondsLeft: Math.ceil(((slot + 1) * 60000 - Date.now()) / 1000),
      stats: {
        attended: list.filter((x) => x.status === "attended").length,
        late: list.filter((x) => x.status === "late").length,
        excused: list.filter((x) => x.status === "excused").length,
        missing: list.filter((x) => !x.status).length,
      },
      list,
    });
  }
  const clsMark = pathname.match(/^\/api\/me\/classes\/([\w-]+)\/checkin\/([\w-]+)\/mark$/);
  if (clsMark && req.method === "POST") {
    const scope = trainerActivityScope(user.id, clsMark[1], clsMark[2]);
    if (!scope) return send(res, 404, { error: "Session not found" });
    const targetId = String(body.userId || "");
    // Hard scope check: a trainer may only mark people in their own class.
    if (!scope.learners.some((m) => m.userId === targetId)) return send(res, 403, { error: "That learner is not in your class." });
    const status = ["attended", "late", "excused", "absent"].includes(body.status) ? body.status : "attended";
    const ckT = tpCheckinTarget(scope.act, scope.doc, scope.cohort);
    if (!ckT) return send(res, 404, { error: "Session not found" });
    // CX-111：讲师把学员本人输码的「迟到」改为出席时保留 by = 学员本人（同管理端单条与批量）
    const prevMark = store.getActivityState(ckT.ckId, targetId);
    const keepSelf = !!prevMark && status === "attended" && prevMark.status === "late" && prevMark.by && prevMark.by === targetId;
    store.setActivityState({ projectId: ckT.projectId, cohortId: ckT.cohortId, activityId: ckT.ckId, userId: targetId, status, by: keepSelf ? targetId : user.id });
    const t = store.getUserById(targetId);
    audit("trainer.checkin.mark", scope.doc.id, null, { by: user.employeeId, employeeId: t ? t.employeeId : targetId, status, activityId: scope.act.id });
    return send(res, 200, { ok: true });
  }
  const programMatch = pathname.match(/^\/api\/programs\/([\w-]+)$/);
  if (programMatch) {
    const p = getProgram(programMatch[1]);
    if (!p || !isAssigned(p.id)) {
      // 第四批 7：没加入、但在课程目录里的公开课程 → 前端转到目录并打开课程简介
      if (p && catalogListed(p, myAssignments[p.id])) return send(res, 404, { error: "Program not found", code: "public_not_enrolled", programId: p.id });
      return send(res, 404, { error: "Program not found" });
    }
    const best = bestAttempt(user.id, p.id);
    const prog = programProgress(user.id, p);
    const exams = publishedProgramExams(p.id).map((e) => examSummary(user.id, e));
    // Legacy top-level exam fields mirror the primary exam so the current
    // employee UI keeps working; new UIs should read the exams array.
    const primary = exams[0] || null;
    return send(res, 200, {
      id: p.id, title: p.title, title_zh: p.title_zh, description: p.description, description_zh: p.description_zh,
      passingScore: primary ? primary.passingScore : p.passingScore,
      examMcqCount: primary ? primary.mcqCount : p.examMcqCount,
      examOpenCount: primary ? primary.openCount : p.examOpenCount,
      examTimeLimitMinutes: primary ? primary.timeLimitMinutes : p.examTimeLimitMinutes || null,
      dueAt: myAssignments[p.id] ? myAssignments[p.id].dueAt : null,
      progress: prog.percent,
      examUnlocked: primary ? primary.unlocked : prog.percent >= 100,
      hasExam: exams.length > 0,
      done: programDone(user.id, p),
      exams,
      best: best ? { percent: best.percent, passed: best.passed, submittedAt: best.submittedAt } : null,
      courses: coursesInProgram(p).map((c) => ({
        id: c.id, title: c.title, title_zh: c.title_zh, description: c.description, description_zh: c.description_zh,
        mode: c.mode || "online", sessionAt: c.sessionAt || null, location: c.location || null,
        moduleCount: c.modules.length, minutes: c.modules.reduce((s, m) => s + m.minutes, 0),
        progress: progressPercent(user.id, c),
      })),
    });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 9887–10251 行（登录后的员工端接口）
    async meLearning4(C) {
      const { pathname, canAccessCourse, myAssignments, res, isAssigned, user, req, body, audit, isPublished, query } = C;
      const { getCourse, courseWrapperOf, catalogListed, send, programsContaining, store, learnerSlideMedia, userProgress, courseAttendance, checkinSlot, courseCkId, checkinCode, modulesOn, APPEAL_ACCESS_CACHE, nowMs, reviewAppealAccess, reviewAppealCtx, appealLogView, serveVideo, path, ATTACH_DIR, isAdmin, canRead, blockDirectOpen, OFFICE_CONV, publishedProgramExams, programProgress, offlineAttended, programDone, PROGRAMS, coursesInProgram, QT, programHours, getProgram, learnerExamState, examRetakeState, scoreTotals, clientDetail, examUnlockedFor, fixedExamQuestions, examQuestions, shuffle, caseSubPointsFor, questionPoints, newToken, attemptDeadline, clientQuestions, checkinNotToday } = S;
  const courseMatch = pathname.match(/^\/api\/courses\/([\w-]+)$/);
  if (courseMatch) {
    const c = getCourse(courseMatch[1]);
    if (!canAccessCourse(c)) {
      // 第四批 7：同上，课程直链指向未加入的公开课程
      const pw = c ? courseWrapperOf(c.id) : null;
      if (pw && catalogListed(pw, myAssignments[pw.id])) return send(res, 404, { error: "Course not found", code: "public_not_enrolled", programId: pw.id });
      return send(res, 404, { error: "Course not found" });
    }
    // Navigation context: prefer a containing package that's assigned to me.
    const pids = programsContaining(c.id, c);
    const ctxPid = pids.find((pid) => isAssigned(pid)) || pids[0] || c.programId || null;
    // Reflect each attachment's CURRENT stored type — an office file uploaded as
    // .pptx may now be a converted view-only PDF — so the reader renders it right
    // regardless of the (possibly stale) kind snapshot in the course document.
    // 第三批 5.7：PDF 课件带 slideMedia（第几页有视频、能不能播；learnerSlideMedia，不含原因与文件名）
    const attIds = [];
    for (const m of c.modules || []) for (const s of m.sections || []) for (const a of Array.isArray(s.attachments) ? s.attachments : []) if (a && a.id) attIds.push(a.id);
    const mediaByAtt = new Map();
    for (const r of attIds.length ? store.listAttachmentMedia({ attachmentIds: attIds }) : []) { if (!mediaByAtt.has(r.attachmentId)) mediaByAtt.set(r.attachmentId, []); mediaByAtt.get(r.attachmentId).push(r); }
    const enriched = {
      ...c,
      modules: (c.modules || []).map((m) => ({
        ...m,
        sections: (m.sections || []).map((s) => ({
          ...s,
          attachments: (Array.isArray(s.attachments) ? s.attachments : []).map((a) => {
            const live = store.getAttachment(a.id);
            const out = live ? { ...a, kind: live.kind, size: live.size } : a;
            if (live && live.kind === "pdf" && mediaByAtt.has(a.id)) { const sm = learnerSlideMedia(a.id, mediaByAtt); if (sm.length) out.slideMedia = sm; }
            return out;
          }),
        })),
      })),
    };
    return send(res, 200, { ...enriched, programId: ctxPid, programIds: pids, done: userProgress(user.id, c.id), attendance: courseAttendance(user.id, c.id) });
  }
  // Employee self check-in for an in-person course (same rotating 6-digit code
  // as project offline activities; late = 15 minutes after the session start).
  const courseCkMatch = pathname.match(/^\/api\/courses\/([\w-]+)\/checkin$/);
  if (courseCkMatch && req.method === "POST") {
    const c = getCourse(courseCkMatch[1]);
    if (!canAccessCourse(c)) return send(res, 404, { error: "Course not found" });
    if ((c.mode || "online") !== "offline") return send(res, 400, { error: "This course has no check-in." });
    const notToday = checkinNotToday(c.sessionAt);
    if (notToday) return send(res, 409, { error: `Check-in is open only on the day of the session (${notToday}).`, error_zh: `签到只在活动当天开放（活动日期 ${notToday}）。`, code: "checkin_not_today", sessionDay: notToday });
    const code = String(body.code || "").trim();
    const slot = checkinSlot();
    const aid = courseCkId(c.id);
    if (code !== checkinCode(aid, slot) && code !== checkinCode(aid, slot - 1))
      return send(res, 400, { error: "Wrong or expired code. Check the screen and try again.", code: "badcode" });
    let status = "attended";
    if (c.sessionAt && Date.now() > new Date(c.sessionAt).getTime() + 15 * 60 * 1000) status = "late";
    store.setActivityState({ projectId: "__course__", cohortId: c.id, activityId: aid, userId: user.id, status, by: user.id });
    audit("course.checkin", c.id, null, { by: user.employeeId, status });
    return send(res, 200, { ok: true, status });
  }
  const completeMatch = pathname.match(/^\/api\/courses\/([\w-]+)\/modules\/([\w-]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const [, cid, mid] = completeMatch;
    const c = getCourse(cid);
    if (!canAccessCourse(c)) return send(res, 404, { error: "Course not found" });
    // The module must genuinely belong to this course.
    if (!c.modules.some((m) => m.id === mid)) return send(res, 400, { error: "Module does not belong to this course" });
    store.setModuleComplete(user.id, cid, mid, new Date().toISOString());
    return send(res, 200, { ok: true });
  }

  // --- protected attachments (Batch 4) ---
  // Access requires login. Course files: an admin who can read the learning
  // domain, or a published program assigned to this employee. Other kinds: admin.
  const attMatch = pathname.match(/^\/api\/attachments\/([\w-]+)$/);
  if (attMatch && req.method === "GET") {
    const a = store.getAttachment(attMatch[1]);
    if (!a) return send(res, 404, { error: "Attachment not found" });
    // Access is decided by the attachment's owner kind. Course files: the
    // learning-domain preview privilege (canRead) OR the original
    // assigned-employee rule. Other kinds (project/activity/closure, from
    // Phase B) stay admin-only until their modules wire in member-based checks —
    // there isAdmin() is the right bar, since the check is "is this a console
    // user at all", not "which domain does this file belong to".
    const ownerKind = a.ownerKind || "course";
    // 第二批 2.8：申诉佐证材料。未绑定的只有上传人能看；已绑定的只有申诉人本人与有完整视图的处理人能看（征询人、只有状态视图的
    // 管理员、利益相关人、其他后台账号一律与「不存在」同形 404）。绩效模块关闭 → 404。判定结果按人按申诉缓存 60 秒。
    if (ownerKind === "review_appeal") {
      const NF = () => send(res, 404, { error: "Attachment not found" });
      if (!modulesOn().performance || !user) return NF();
      if (!a.ownerId) { if (a.uploadedBy !== user.id) return NF(); }
      else {
        const ap = store.getReviewAppeal(a.ownerId);
        if (!ap || a.uploadedBy !== ap.userId) return NF();
        if (ap.userId !== user.id) {
          const key = user.id + "|" + ap.id;
          const hit = APPEAL_ACCESS_CACHE.get(key);
          let ok;
          if (hit && nowMs() - hit.at < 60000) ok = hit.ok;
          else { ok = reviewAppealAccess(user, ap, reviewAppealCtx()).view === "full"; APPEAL_ACCESS_CACHE.set(key, { ok, at: nowMs() }); }
          if (!ok) return NF();
          appealLogView(user, ap, audit);
        }
      }
      return serveVideo(req, res, path.join(ATTACH_DIR, a.storageKey), { "content-disposition": "inline", "cache-control": "private, no-store", "content-security-policy": "sandbox; default-src 'none'" });
    }
    if (ownerKind !== "course") {
      if (!isAdmin(user)) return send(res, 404, { error: "Attachment not found" });
    } else if (!canRead(user, "learning")) {
      const course = getCourse(a.courseId);
      if (!canAccessCourse(course)) return send(res, 404, { error: "Attachment not found" });
    }
    // 第三批 5.6：课程课件不许在地址栏 / 新标签直接打开（浏览器自带的 PDF 阅读器有下载与打印按钮，也没有水印）→ 与「不存在」同形 404。
    // 只管课程附件（申诉佐证材料在上面另有分支，照常可在新标签打开，可行性审查 4）。
    if (ownerKind === "course" && blockDirectOpen(req)) return send(res, 404, { error: "Attachment not found" });
    // P0 1.3：PPT / Word / Excel 原文件对任何人都不提供下载（含后台）—— 原文件只留给补转用。
    // 放在访问检查之后（审查 低-10）：没被指派课程的人得到的仍是 404，不会知道某个附件「正在等待转换」。
    // 只读的 .xlsx 导入模板走别的路由，不是课件，不受影响（审查 低-11）。
    if (OFFICE_CONV.isOfficeAttachment(a))
      return send(res, 409, { error: "This file is waiting to be converted for online viewing and can't be opened yet. 该课件正在等待转换为在线查看格式，暂时无法打开。", code: "pending_conversion" });
    // PDFs are explicitly inline (view-only in the UI). 课程课件不缓存（第三批 5.6）。
    const headers = { ...(a.kind === "pdf" ? { "content-disposition": "inline" } : {}), ...(ownerKind === "course" ? { "cache-control": "private, no-store" } : {}) };
    return serveVideo(req, res, path.join(ATTACH_DIR, a.storageKey), headers);
  }
  // 第三批 5.7：课件内视频的播放流（转码后的 MP4，支持 Range）。媒体行必须属于这份附件且已就绪（安全审查 1：
  // 不能拿 A 课附件的 id 去拉 B 课的视频），再按附件同一套访问规则判定；直接打开同样 404，不缓存。
  const attMediaMatch = pathname.match(/^\/api\/attachments\/([\w-]+)\/media\/([\w-]+)$/);
  if (attMediaMatch && req.method === "GET") {
    const NF = () => send(res, 404, { error: "Attachment not found" });
    const m = store.getAttachmentMedia(attMediaMatch[2]);
    if (!m || m.attachmentId !== attMediaMatch[1] || m.status !== "ready" || !m.storageKey) return NF();
    const a = store.getAttachment(attMediaMatch[1]);
    if (!a || (a.ownerKind || "course") !== "course") return NF();
    if (!canRead(user, "learning") && !canAccessCourse(getCourse(a.courseId))) return NF();
    if (blockDirectOpen(req)) return NF();
    const full = path.join(ATTACH_DIR, path.basename(String(m.storageKey)));
    if (path.resolve(path.dirname(full)) !== path.resolve(ATTACH_DIR)) return NF();
    return serveVideo(req, res, full, { "content-type": "video/mp4", "cache-control": "private, no-store" });
  }

  // --- learning record (always the SESSION user — no userId parameter) ---
  // Unified program status vocabulary (spec 5.2): notstarted | inprog |
  // ready (coursework completed) | passed | failed | overdue.
  const programStatusFor = (p, dueAt) => {
    const exams = publishedProgramExams(p.id);
    const prog = programProgress(user.id, p).percent;
    const bests = exams.map((e) => store.bestExamAttempt(user.id, e.id));
    // CX-130：「已通过」与成长轨迹、后台、经理视图同一口径 programDone（completion.js）：
    //   无考试 = 进度 100%；有考试 = 课程的最好成绩已通过、且线下课程已出席 / 迟到（2026-10-07：考试通过但线下课程请假或缺勤 = 待补课）。
    // 原来这里要求「每一场考试都通过」，一门课挂了两场考试、只过了一场时这里写「未通过」，别处写「已通过」。
    // 已通过优先于「逾期」—— 学完了就不算逾期。
    if (programDone(user.id, p)) return "passed";
    if (dueAt && new Date(dueAt + "T23:59:59") < new Date()) return "overdue";
    const bestAll = exams.length ? store.bestAttempt(user.id, p.id) : null;
    if (bestAll && bestAll.passed) return "inprog";   // 考试已过、线下课程待补出勤
    if (bests.some((b) => b && !b.passed)) return "failed";
    if (prog >= 100) return exams.length ? "ready" : "passed"; // examless program: 100% coursework = completed
    if (prog > 0) return "inprog";
    return "notstarted";
  };
  if (pathname === "/api/me/learning-record" && req.method === "GET") {
    const out = [];
    for (const p of PROGRAMS) {
      const asg = myAssignments[p.id];
      const attempts = store.listUserAttempts(user.id, p.id);
      const hasHistory = !!asg || attempts.some((a) => a.submittedAt) ||
        coursesInProgram(p).some((c) => Object.keys(userProgress(user.id, c.id)).length > 0);
      // Archiving a course must not erase a completed training record — that is
      // the compliance evidence. So: published courses, PLUS anything this
      // person has an assignment or real history on, whatever its status.
      if (!isPublished(p) && !hasHistory) continue;
      if (!asg && !canRead(user, "learning") && !hasHistory) continue;
      const dueAt = asg ? asg.dueAt : null;
      const passedAttempts = attempts.filter((a) => a.passed);
      const best = attempts.length ? attempts.reduce(QT.betterAttempt) : null;
      const progExams = publishedProgramExams(p.id);
      // 无考试且已学完：完成时间 = 最后一个模块的完成时间（没有「通过考试」这一刻）
      let doneAt = null;
      const isDone = programDone(user.id, p);
      if (!progExams.length && isDone)
        for (const c of coursesInProgram(p))
          for (const iso of Object.values(userProgress(user.id, c.id))) if (!doneAt || iso > doneAt) doneAt = iso;
      out.push({
        // 第四批 7：来源（assigned / self；没有指派行的历史记录为 null）、课程学时、是否已完成（累计学时 = 已完成的学时之和）
        source: asg ? (asg.source === "self" ? "self" : "assigned") : null,
        hours: programHours(p), done: isDone,
        id: p.id, title: p.title, title_zh: p.title_zh,
        hasExam: progExams.length > 0,
        status: programStatusFor(p, dueAt),
        progress: programProgress(user.id, p).percent,
        dueAt,
        courseCount: (p.courseIds || []).length,
        examCount: progExams.length,
        // The real pass line for this program's (primary) exam — the record page
        // colours scores against this instead of assuming a universal 80%.
        passingScore: progExams.length ? progExams[0].passingScore : null,
        attemptCount: attempts.length,
        bestPercent: best ? best.percent : null,
        // F57：最好成绩是否通过 —— 读已存的 passed，前端按它着色，不再用整数百分比和及格线重算
        bestPassed: best ? !!best.passed : null,
        passedAt: passedAttempts.length ? passedAttempts.map((a) => a.submittedAt).sort()[0] : doneAt,
      });
    }
    // 第四批 7（9.6）：?totals=1 → { items, totals: { hoursDone, hoursSelf } }（累计学时与其中自主学习的部分，只计已完成的课程）；
    // 不带参数时照旧回数组（旧前端与测试不变）。
    if (query.get("totals") === "1") {
      const r1 = (x) => Math.round(x * 10) / 10;
      const doneRows = out.filter((x) => x.done);
      return send(res, 200, { items: out, totals: { hoursDone: r1(doneRows.reduce((s, x) => s + (x.hours || 0), 0)), hoursSelf: r1(doneRows.filter((x) => x.source === "self").reduce((s, x) => s + (x.hours || 0), 0)) } });
    }
    return send(res, 200, out);
  }
  const myRecordMatch = pathname.match(/^\/api\/me\/programs\/([\w-]+)\/record$/);
  if (myRecordMatch && req.method === "GET") {
    const p = getProgram(myRecordMatch[1]);
    if (!p || !canRead(user, "learning") && (!myAssignments[p.id] || !isPublished(p))) return send(res, 404, { error: "Program not found" });
    const courses = coursesInProgram(p).map((c) => {
      const done = userProgress(user.id, c.id);
      return {
        id: c.id, title: c.title, title_zh: c.title_zh,
        modules: c.modules.map((m) => ({ id: m.id, title: m.title, title_zh: m.title_zh, doneAt: done[m.id] || null })),
      };
    });
    // Appeals for every attempt on this page, in one query.
    const myAppeals = store.listAppealsForAttempts(
      publishedProgramExams(p.id).flatMap((e) => store.listUserExamAttempts(user.id, e.id).map((a) => a.id))
    );
    const exams = publishedProgramExams(p.id).map((e) => {
      const list = store.listUserExamAttempts(user.id, e.id).slice().reverse(); // chronological
      return {
        id: e.id, title: e.title, title_zh: e.title_zh,
        passingScore: e.passingScore,
        showAnswersAfterExam: e.showAnswersAfterExam,
        attempts: list.map((a, i) => ({
          id: a.id, n: i + 1,
          startedAt: a.startedAt, submittedAt: a.submittedAt,
          durationMin: Math.round((new Date(a.submittedAt) - new Date(a.startedAt)) / 6000) / 10,
          percent: a.percent, passed: a.passed, gradingStatus: a.gradingStatus || "final",
          adjusted: (a.detail || []).some((d) => d.overridden),
          voided: !!a.voided,
          appeal: (() => { const ap = myAppeals.get(a.id); return ap ? { id: ap.id, status: ap.status, reason: ap.reason, resolution: ap.resolution, createdAt: ap.createdAt } : null; })(),
        })),
      };
    });
    return send(res, 200, {
      id: p.id, title: p.title, title_zh: p.title_zh,
      dueAt: myAssignments[p.id] ? myAssignments[p.id].dueAt : null,
      progress: programProgress(user.id, p).percent,
      status: programStatusFor(p, myAssignments[p.id] ? myAssignments[p.id].dueAt : null),
      courses, exams,
    });
  }
  // One of MY submitted attempts, honouring the exam's answer-visibility rule.
  const myAttemptMatch = pathname.match(/^\/api\/me\/attempts\/([\w-]+)$/);
  if (myAttemptMatch && req.method === "GET") {
    const a = store.getAttempt(myAttemptMatch[1]);
    if (!a || a.userId !== user.id || !a.submittedAt) return send(res, 404, { error: "Attempt not found" });
    const exam = a.examId ? store.getExam(a.examId) : null;
    const p = getProgram(a.programId);
    const showAnswers = exam ? exam.showAnswersAfterExam !== false : (p ? p.showAnswersAfterExam !== false : true);
    // CX-003（2026-10-09 验收）：结果页直接给「去补考」—— 带 learnerExamState 的 retake { examId, state, retryAt, attemptsLeft }
    const exState = p ? learnerExamState(user.id, p) : null;
    return send(res, 200, {
      id: a.id,
      examId: a.examId || null,
      learnStatus: exState ? exState.learnStatus : null,
      retake: exam ? examRetakeState(user.id, exam) : (exState ? exState.retake : null),
      examTitle: exam ? exam.title : null, examTitle_zh: exam ? exam.title_zh || null : null,
      programId: a.programId || null,
      programTitle: p ? p.title : null, programTitle_zh: p ? p.title_zh || null : null,
      startedAt: a.startedAt, submittedAt: a.submittedAt,
      percent: a.percent, passed: a.passed, gradingStatus: a.gradingStatus || "final",
      passingScore: exam ? exam.passingScore : p ? p.passingScore : null,
      showAnswers,
      // 每题分值：有分值的答卷附得分与卷面总分（保留一位小数），旧答卷为 null
      ...(() => { const t = scoreTotals(a.detail || []); return t.hasPoints ? { earned: Math.round(t.earned * 10) / 10, totalPoints: t.max } : { earned: null, totalPoints: null }; })(),
      detail: clientDetail(a.detail, showAnswers),
    });
  }

  // --- exam ---
  // Starts an attempt for a first-class exam. Accepts examId, or (legacy)
  // programId — which resolves to that program's single published exam.
  if (pathname === "/api/exam/start" && req.method === "POST") {
    let exam = null;
    if (body.examId) {
      exam = store.getExam(String(body.examId));
      if (exam && exam.status !== "published") exam = null;
    } else if (body.programId) {
      const list = publishedProgramExams(String(body.programId));
      if (list.length > 1)
        return send(res, 400, { error: "This program has several exams — please pick one from the program page." });
      exam = list[0] || null;
    }
    if (!exam) return send(res, 404, { error: "Exam not found" });
    const p = getProgram(exam.programId);
    if (!p || !isAssigned(p.id)) return send(res, 404, { error: "Exam not found" });
    // 结论待定（评分中 / 待 HR 复核）的答卷未结案前不能开始下一次：复核期间不会因新一次考试用尽次数而触发自动重修
    const pendingAtt = store.pendingExamAttempt(user.id, exam.id);
    if (pendingAtt)
      return send(res, 409, { error: "Your previous attempt is still being scored or reviewed. You can start again once the result is confirmed.", error_zh: "上一次答卷仍在评分或等待 HR 复核，结果确定后才能再次开始。", code: "result_pending", gradingStatus: pendingAtt.gradingStatus, attemptId: pendingAtt.id });
    // 中途离开考试（刷新、关页、跳走）：重新进入 = 重新开始。未交卷的答卷整份丢弃（不计次数、
    // 不计成绩、草稿不保留），下面照常抽一份新卷、重新计时。不再有「恢复上次作答」。
    store.discardOpenAttempts(user.id, exam.id);
    if (!examUnlockedFor(user.id, exam))
      return send(res, 400, { error: "Please complete all courses before taking the exam.", code: "incomplete" });
    // Retake policy: attempt limit + cooldown between attempts. Machine `code`s
    // let the employee UI show properly localized copy.
    const prior = store.listUserExamAttempts(user.id, exam.id);
    if (exam.maxAttempts && prior.length >= exam.maxAttempts)
      return send(res, 400, { error: `You have used all ${exam.maxAttempts} allowed attempts for this exam. Please contact HR.`, code: "exhausted", max: exam.maxAttempts });
    if (exam.retakeCooldownHours && prior.length) {
      const retryAt = new Date(new Date(prior[0].submittedAt).getTime() + exam.retakeCooldownHours * 3600 * 1000);
      const waitMs = retryAt.getTime() - Date.now();
      if (waitMs > 0)
        // minutesLeft stays (the current client still reads it), but a 24h cooldown
        // rendered as "1440 minutes"; retryAt lets the client phrase the wait in
        // whatever unit — or as a wall-clock time — makes sense.
        return send(res, 400, { error: `Please wait ${Math.ceil(waitMs / 3600000)} hour(s) before retaking the exam (cooldown: ${exam.retakeCooldownHours}h).`, code: "cooldown", minutesLeft: Math.ceil(waitMs / 60000), retryAt: retryAt.toISOString() });
    }
    const fixedList = fixedExamQuestions(exam);
    const pool = fixedList || examQuestions(exam);
    // 第四批 6.1：按题型注册表的分组抽题 —— 客观题（全部客观题型）按 mcqCount、简答按 openCount、情境案例按 caseCount（整组抽）。
    // 固定题目模式：不抽、按卷面顺序（组卷页排定的顺序，含简答与案例）；随机模式：客观题、简答、案例依次抽。
    const grp = (q) => QT.groupOf(q.type);
    const picked = fixedList ? fixedList.slice() : [
      ...shuffle(pool.filter((q) => grp(q) === "objective")).slice(0, exam.mcqCount),
      ...shuffle(pool.filter((q) => grp(q) === "open")).slice(0, exam.openCount),
      ...shuffle(pool.filter((q) => grp(q) === "case")).slice(0, exam.caseCount || 0),
    ];
    // 开考快照：各题型 snapshot()（旧四种逐字照旧）。分值、多选半分、新题型按比例给分与选项顺序（10.6）都快照进答卷，
    // 之后改题库或考试设置不影响已开出的卷。shuffle = 服务端的 crypto 洗牌；案例小题的分值按 caseSubPointsFor。
    const snapCtx = { shuffle, shuffleOptions: exam.shuffleOptions !== false, multiPartial: exam.multiPartial !== false, partialCredit: exam.partialCredit !== false, pointsFor: caseSubPointsFor(exam) };
    const snaps = picked.map((q) => QT.snapshot(q, { ...snapCtx, points: q.type === "case" ? null : questionPoints(exam, q) })).filter(Boolean);
    const attempt = {
      id: "a-" + newToken().slice(0, 10),
      userId: user.id, programId: p.id, examId: exam.id,
      startedAt: new Date().toISOString(), submittedAt: null,
      questions: snaps, answers: null,
      percent: null, passed: null, detail: null,
    };
    const nOf = (g) => snaps.filter((q) => grp(q) === g).length;
    // 卷面总分：有分值的卷 = 各题分值之和（没设分值的题按旧口径：客观题 1 分、简答 maxPoints/10）；旧口径的卷 = null（与改动前相同）
    const hasPts = snaps.some((q) => q.type !== "case" && q.points != null) || (snaps.length > 0 && snaps.every((q) => q.type === "case"));
    const totalPts = hasPts ? snaps.reduce((n, q) => n + (q.points != null ? Number(q.points) || 0 : q.type === "open" ? (Number(q.maxPoints) || 10) / 10 : 1), 0) : null;
    store.createAttempt(attempt);
    // client copy: strip answers/rubrics
    return send(res, 200, {
      attemptId: attempt.id,
      examId: exam.id,
      examTitle: exam.title,
      examTitle_zh: exam.title_zh || null,
      // The paper's shape, so the header can say what this exam consists of
      // instead of making the candidate count the answer sheet.
      programTitle: p.title,
      programTitle_zh: p.title_zh || null,
      objectiveCount: nOf("objective"),
      openCount: nOf("open"),
      // 第四批：情境案例组数与小题总数（案例按小题展开，答题卡与「共 n 题」用 itemCount）
      caseCount: nOf("case"),
      itemCount: snaps.reduce((n, q) => n + (q.type === "case" ? (q.items || []).length : 1), 0),
      totalPoints: totalPts,
      attemptNo: store.listUserExamAttempts(user.id, exam.id).length,
      maxAttempts: exam.maxAttempts || null,
      passingScore: exam.passingScore,
      timeLimitMinutes: exam.timeLimitMinutes || null,
      deadline: attemptDeadline(attempt, exam.timeLimitMinutes),
      resumed: false, // 恒为 false：中途离开后重新进入一律重新开始（保留字段兼容旧前端）
      questions: clientQuestions(attempt.questions),
    });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 10558–10621 行（/api/admin/ 块内）
    async adminLearning1(C) {
      const { pathname, req, res, body, user, audit } = C;
      const { send, PROGRAMS, store, newToken, refreshContent, getProgram } = S;
    if (pathname === "/api/admin/programs" && req.method === "GET") {
      return send(res, 200, PROGRAMS.map((p) => {
        const exams = store.listProgramExams(p.id);
        return {
          id: p.id, title: p.title, title_zh: p.title_zh,
          description: p.description, description_zh: p.description_zh,
          status: p.status || "published",
          category: p.category || null,
          enrollType: p.enrollType || "mandatory",
          defaultDueDays: p.defaultDueDays || 30,
          courseCount: (p.courseIds || []).length,
          examCount: exams.length,
        };
      }));
    }
    if (pathname === "/api/admin/programs" && req.method === "POST") {
      const title = String(body.title || "").trim();
      if (!title) return send(res, 400, { error: "Title is required." });
      const p = {
        id: "p-" + newToken().slice(0, 8), // system-generated, never typed by HR
        title, title_zh: String(body.title_zh || "").trim() || null,
        description: String(body.description || "").trim(),
        description_zh: String(body.description_zh || "").trim() || null,
        status: body.status === "published" ? "published" : "draft",
        category: String(body.category || "").trim() || null,
        enrollType: body.enrollType === "elective" ? "elective" : "mandatory",
        defaultDueDays: Math.min(365, Math.max(1, Number(body.defaultDueDays) || 30)),
        courseIds: [],
        // Legacy exam fields kept for compatibility with pre-Batch-1 readers.
        passingScore: 80, examMcqCount: 8, examOpenCount: 1,
        examTimeLimitMinutes: null, maxAttempts: 0, retakeCooldownHours: 0,
        showAnswersAfterExam: true,
      };
      store.putContent("program", p.id, p);
      store.snapshotContent("program", p.id, p, user.id);
      audit("program.create", p.id, null, { title: p.title, status: p.status });
      refreshContent();
      return send(res, 200, { ok: true, id: p.id });
    }
    const progBasicPut = pathname.match(/^\/api\/admin\/programs\/([\w-]+)$/);
    if (progBasicPut && req.method === "PUT") {
      const p = getProgram(progBasicPut[1]);
      if (!p) return send(res, 404, { error: "Program not found" });
      const title = String(body.title ?? p.title).trim();
      if (!title) return send(res, 400, { error: "Title is required." });
      const updated = {
        ...p,
        title,
        title_zh: body.title_zh !== undefined ? String(body.title_zh || "").trim() || null : p.title_zh,
        description: body.description !== undefined ? String(body.description || "").trim() : p.description,
        description_zh: body.description_zh !== undefined ? String(body.description_zh || "").trim() || null : p.description_zh,
        status: ["draft", "published", "archived"].includes(body.status) ? body.status : p.status || "published",
        category: body.category !== undefined ? (String(body.category || "").trim() || null) : (p.category || null),
        enrollType: body.enrollType !== undefined ? (body.enrollType === "elective" ? "elective" : "mandatory") : (p.enrollType || "mandatory"),
        defaultDueDays: body.defaultDueDays !== undefined ? Math.min(365, Math.max(1, Number(body.defaultDueDays) || 30)) : p.defaultDueDays || 30,
      };
      store.putContent("program", p.id, updated);
      store.snapshotContent("program", p.id, updated, user.id);
      audit("program.update", p.id,
        { title: p.title, status: p.status || "published", defaultDueDays: p.defaultDueDays },
        { title: updated.title, status: updated.status, defaultDueDays: updated.defaultDueDays });
      refreshContent();
      return send(res, 200, { ok: true });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 10726–10757 行（/api/admin/ 块内）
    async adminLearning2(C) {
      const { pathname, req, res, examPoolBreakdown, body, validateExam, user, audit } = C;
      const { send, store, getProgram, examUsable, QT, newToken } = S;
    if (pathname === "/api/admin/exams" && req.method === "GET") {
      return send(res, 200, store.listExams().map((e) => {
        const p = getProgram(e.programId);
        const courseIds = store.getExamCourseIds(e.id);
        const ids = new Set(courseIds);
        const pool = store.listQuestions().filter((q) => ids.has(q.courseId) && examUsable(q));
        const attempts = store.listExamAttempts(e.id);
        return {
          ...e,
          programTitle: p ? p.title : e.programId,
          courseIds,
          poolObjective: pool.filter((q) => QT.groupOf(q.type) === "objective").length,
          poolOpen: pool.filter((q) => q.type === "open").length,
          // 第四批：情境案例组数与各题型题量（组卷与抽题数提醒用）
          ...examPoolBreakdown(pool),
          attempts: attempts.length,
          passRate: attempts.length ? Math.round((attempts.filter((a) => a.passed).length / attempts.length) * 100) : null,
        };
      }));
    }
    if (pathname === "/api/admin/exams" && req.method === "POST") {
      const program = getProgram(String(body.programId || ""));
      if (!program) return send(res, 400, { error: "Choose a valid program for this exam." });
      const v = validateExam(body, program);
      if (v.error) return send(res, 400, { error: v.error, ...(v.error_zh ? { error_zh: v.error_zh } : {}), ...(v.code ? { code: v.code } : {}) });
      const id = "exam-" + newToken().slice(0, 8);
      store.createExam({ id, programId: program.id, ...v.exam });
      store.setExamCourses(id, v.courseIds);
      store.snapshotContent("exam", id, { ...v.exam, courseIds: v.courseIds }, user.id);
      audit("exam.create", id, null, { title: v.exam.title, program: program.title, status: v.exam.status });
      return send(res, 200, { ok: true, id });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 11130–11153 行（/api/admin/ 块内）
    async adminLearning3(C) {
      const { pathname, req, user, res } = C;
      const { scopePredicate, larksync, store, send } = S;
    if (pathname === "/api/admin/roster" && req.method === "GET") {
      // P2 范围过滤。⚠ 这一条走 W1 白名单（people/learning/performance/talent 任一
      // ≥只读都能读它），所以过滤必须挂在**端点**上，不能挂在 people 域的读路径上：
      // 否则培训/绩效/人才管理员的选人弹窗仍是全公司名单（清点文档 §9 ③）。
      // 空范围/超管 → rosterScope 为 null → 下面一行退化成原样的全公司 listUsers()。
      const rosterScope = scopePredicate(user);
      const lkNames = larksync.larkNames(store);   // { userId: Lark 显示名 }（每日同步写入）
      return send(res, 200, store.listUsers().filter((u) => !rosterScope || rosterScope(u)).map((u) => ({
        id: u.id, employeeId: u.employeeId, name: u.name, role: u.role,
        // Which admin role (if any) this person holds — the Roles page renders a
        // real member list from this. Filtering semantics of the roster itself
        // are untouched.
        adminRoleId: u.adminRoleId != null ? u.adminRoleId : null,
        department: u.department || null, email: u.email || null, phone: u.phone || null,
        managerId: u.managerId || null, active: u.active !== 0,
        // Talent columns the roster table renders (position column, job-level /
        // employment-status tags). Cheap scalars — no per-course computation.
        position: u.position || null, jobLevel: u.jobLevel || null,
        empStatus: u.empStatus || null, hireDate: u.hireDate || null,
        lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt,
        // 在用 Lark 账号的显示名（每日同步写入 meta larksync.larkNames）；选人下拉优先显示它
        larkName: lkNames[u.id] || null,
      })));
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 14882–15156 行（/api/admin/ 块内）
    async adminLearning4(C) {
      const { pathname, req, user, query, res, body, audit, requestId } = C;
      const { gradeOptionsFor, send, parseGradeSelect, getTProject, getProgram, resolveGradeSelect, store, scopePredicate, sendScopeBulkReject, runBatch, bulkFaultPoint, sendBatchFailed, afterCommit, auditCriteria, notify, bulkIdList, bulkOutOfScope, sendBulkScopeReject, bulkSkip, bulkUnchanged, emitBulkEffects, emitExamReset, sendBulkResult, scopeAllowsFor, settleAttempt, AI, sendAiState, enqueueGrading, PROGRAMS, COURSES, programsContaining } = S;
    if (pathname === "/api/admin/assignments/preview" && req.method === "GET") {
      const gradeOptions = gradeOptionsFor(user);
      if (query.get("options") === "1") return send(res, 200, { gradeOptions });
      const parsed = parseGradeSelect(user, { depts: query.get("depts"), grades: query.get("grades"), gradeFrom: query.get("gradeFrom"), gradeTo: query.get("gradeTo") });
      if (parsed.error) return send(res, parsed.error.status, { ...parsed.error.body, gradeOptions });
      const projectId = query.get("projectId"), programId = query.get("programId");
      const doc = projectId ? getTProject(projectId) : null;
      if (projectId && !doc) return send(res, 404, { error: "Not found" });
      const prog = programId ? getProgram(programId) : null;
      if (programId && !prog) return send(res, 404, { error: "Not found" });
      const { users, noGrade } = resolveGradeSelect(user, parsed, { excludeAdmins: !!doc });
      let already = 0;
      if (doc) { const inProj = new Set(store.listProjectMembers(doc.id).filter((m) => m.role === "learner" && m.state === "active").map((m) => m.userId)); already = users.filter((u) => inProj.has(u.id)).length; }
      else if (prog) { const asg = new Set(store.listAllAssignments().filter((a) => a.programId === prog.id && a.source !== "self").map((a) => a.userId)); already = users.filter((u) => asg.has(u.id)).length; }   // 第四批 7：自主学习不算已指派
      return send(res, 200, { matched: users.length, noGrade, alreadyAssigned: already, toAdd: users.length - already, gradeOptions, select: parsed.echo });
    }
    // Bulk assign/unassign one program for many employees at once.
    // 第三批 8.6：assign 可以不传 userIds、改传 select（部门 × 职级，见 parseGradeSelect）：圈中且尚未指派的人才指派（已指派的人不动，
    // 截止日也不改），回 count、alreadyAssigned、noGrade。
    if (pathname === "/api/admin/assignments/bulk" && req.method === "POST") {
      let { userIds, programId, dueAt, action } = body;
      const p = getProgram(programId);
      let selInfo = null;
      if (p && action === "assign" && !Array.isArray(userIds) && body.select) {
        const parsed = parseGradeSelect(user, body.select);
        if (parsed.error) return send(res, parsed.error.status, parsed.error.body);
        const { users, noGrade } = resolveGradeSelect(user, parsed);
        // 第四批 7：自主学习的人不算「已指派」—— 圈中后照常指派（改为指派、带截止日、收到通知）
        const have = new Set(store.listAllAssignments().filter((a) => a.programId === p.id && a.source !== "self").map((a) => a.userId));
        userIds = users.filter((u) => !have.has(u.id)).map((u) => u.id);
        selInfo = { alreadyAssigned: users.length - userIds.length, noGrade, select: parsed.echo };
        if (!userIds.length) return send(res, 200, { ok: true, count: 0, skippedInactive: 0, ...selInfo });
      }
      if (!p || !Array.isArray(userIds) || !userIds.length || !["assign", "unassign"].includes(action))
        return send(res, 400, { error: "Invalid request" });
      // P2 范围（learning）：批量指派/取消是「对一批人写」，按设计选择① **整批拒绝**。
      // 下面那句 `if (!tu) continue;` 正是清点文档 §9② 点名的「跳过」陷阱：静默的部分
      // 执行会让 HR 以为 3000 人都指派了。查无此人仍按原样 skip（口径不变），只有
      // **存在但越界**的才触发整批拒绝。
      const asgBulkScope = scopePredicate(user);
      if (asgBulkScope) {
        let outOfScope = 0;
        for (const uid of userIds) {
          const tu = store.getUserById(uid);
          if (tu && !asgBulkScope(tu)) outOfScope++;
        }
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      // 原子性：整批一个事务（runBatch），范围整批拒绝在写库之前。逐个跳过的口径不变
      // （查无此人、给已停用的人指派）；任何一人抛异常 → 整批回滚、回 batch_failed + 第几个人。
      // 通知（站内信 + 邮件）是副作用：事务里只收集收件人，提交之后再发 —— 回滚时一封都不发。
      const batch = runBatch((cur) => {
        let n = 0, skippedInactive = 0;
        const toNotify = [];
        for (let i = 0; i < userIds.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const uid = userIds[i];
          const tu = store.getUserById(uid);
          if (!tu) continue;
          // Never hand new coursework to someone who has left — they'd show up in
          // the to-do lists and overdue reports HR then has to clean by hand.
          if (action === "assign" && tu.active === 0) { skippedInactive++; continue; }
          if (action === "assign") {
            const a0 = store.getUserAssignments(tu.id)[programId];
            const already = !!a0 && a0.source !== "self";   // 第四批 7：自主学习 → 指派，照常通知
            store.setAssignment(tu.id, programId, dueAt ? String(dueAt).slice(0, 10) : null);
            if (!already) toNotify.push(tu.id);
          } else store.removeAssignment(tu.id, programId);
          n++;
        }
        return { n, skippedInactive, toNotify };
      });
      if (!batch.ok) return sendBatchFailed(res, "assignments/bulk", batch, { selection: true });
      const { n, skippedInactive, toNotify } = batch.value;
      afterCommit("assignments/bulk", () => audit("assignments.bulk", programId, null, { action, employees: n, skippedInactive, dueAt: dueAt || null, ...(selInfo ? { select: selInfo.select, alreadyAssigned: selInfo.alreadyAssigned, noGrade: selInfo.noGrade } : {}), ...(auditCriteria(body.criteria) ? { criteria: auditCriteria(body.criteria) } : {}) }));
      // notify() 自己吞掉写库失败；同一人在 userIds 里出现两次只通知一次（与改动前一致：
      // 第二次时 already 已为真）。
      // silent: true = 历史数据导入（scripts/import-course-attendance.js）：不给员工发「新指派」通知
      if (body.silent !== true) afterCommit("assignments/bulk notify", () => {
        for (const uid of toNotify) notify(uid, {
          type: "assigned",
          title: `New course assigned: "${p.title || p.title_zh || ""}"`,
          title_zh: `你被指派了新课程《${p.title_zh || p.title}》`,
          body: "Find it under Learning › My Courses.", body_zh: "可在「培训 › 我的课程」中查看。",
          link: `#/program/${p.id}`,
        });
      });
      return send(res, 200, { ok: true, count: n, skippedInactive, ...(selInfo || {}) });
    }
    // 考试成绩批量重置作答次数（2026-10-07 批量操作第二批 B7）。{ ids: [答卷 id] }：答卷换算成「员工 × 考试」，同一对只处理一次
    // （第二条记未改动）；结论待定、已通过的逐条跳过；作废 0 次记未改动、不写审计。审计与通知与单条逐字相同（emitExamReset）。
    // 任一答卷的员工在范围外 → 整批 404 out_of_scope（员工已删除时范围生效即算越界，与单条的 404 同口径）。
    if (pathname === "/api/admin/attempts/bulk-reset" && req.method === "POST") {
      const ids = bulkIdList(res, body.ids); if (!ids) return;
      const oos = bulkOutOfScope(user, ids, (id) => {
        const a = store.getAttempt(id);
        if (!a || !a.submittedAt) return undefined;
        return store.getUserById(a.userId) || null;
      });
      if (oos) return sendBulkScopeReject(res, oos);
      const batch = runBatch((cur) => {
        const results = [], effects = [], pairs = new Map();
        let voided = 0;
        for (let i = 0; i < ids.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const a = store.getAttempt(ids[i]);
          if (!a || !a.submittedAt) { results.push(bulkSkip(ids[i], "not_found")); continue; }
          const exam = a.examId ? store.getExam(a.examId) : null;
          if (!exam) { results.push(bulkSkip(a.id, "no_exam")); continue; }
          const target = store.getUserById(a.userId);
          if (!target) { results.push(bulkSkip(a.id, "not_found")); continue; }
          const pk = target.id + "|" + exam.id;
          if (pairs.has(pk)) { const prev = pairs.get(pk); results.push(prev.ok ? bulkUnchanged(a.id) : { ...prev, id: a.id }); continue; }
          let r;
          if (store.pendingExamAttempt(target.id, exam.id)) r = bulkSkip(a.id, "result_pending");
          else if ((store.bestExamAttempt(target.id, exam.id) || {}).passed) r = bulkSkip(a.id, "already_passed");
          else {
            const n = store.voidUserExamAttempts(target.id, exam.id);
            if (!n) r = bulkUnchanged(a.id);
            else { effects.push({ id: a.id, exam, target, n }); voided += n; r = { id: a.id, ok: true, voided: n }; }
          }
          pairs.set(pk, r);
          results.push(r);
        }
        return { results, effects, voided };
      });
      if (!batch.ok) return sendBatchFailed(res, "attempts/bulk-reset", batch, { selection: true, noun: "item", split: true });
      emitBulkEffects("attempts/bulk-reset", batch.value.effects, (e) => emitExamReset(audit, e));
      return sendBulkResult(res, batch.value.results, { voided: batch.value.voided });
    }
    // HR escape hatch for capped exams someone failed out of: void their past
    // attempts (limits/best reset for the employee; the papers stay visible,
    // flagged, in Results) and tell them they can retake.
    const resetAtt = pathname.match(/^\/api\/admin\/exams\/([\w-]+)\/reset-attempts$/);
    if (resetAtt && req.method === "POST") {
      const exam = store.getExam(resetAtt[1]);
      if (!exam) return send(res, 404, { error: "Exam not found" });
      const target = store.getUserById(String(body.userId || ""));
      if (!target) return send(res, 404, { error: "User not found" });
      // P2 范围（learning）：考试定义是内容对象（不约束），但作废**某个人**的考试次数
      // 是对这个人的写 —— 越界回与上面「User not found」逐字同形的 404。
      if (!scopeAllowsFor(user, target)) return send(res, 404, { error: "User not found" });
      if (store.pendingExamAttempt(target.id, exam.id))
        return send(res, 409, { error: "This employee has an attempt awaiting scoring or review. Finish the review first.", error_zh: "该员工有答卷仍在评分或待复核，请先完成复核。", code: "result_pending" });
      const n = store.voidUserExamAttempts(target.id, exam.id);
      emitExamReset(audit, { exam, target, n });   // 审计（n=0 也写）与通知（n>0 才发），与批量重置共用
      return send(res, 200, { ok: true, voided: n });
    }
    // HR score override on an open (AI-graded) question — recomputes the total.
    // HR resolves an appeal. Accepting it does NOT change the score on its own —
    // the regrade is a separate, audited action — so "accepted" means "we agree
    // this needs another look", and the reply tells the employee what happened.
    const apMatch = pathname.match(/^\/api\/admin\/appeals\/([\w-]+)\/resolve$/);
    if (apMatch && req.method === "POST") {
      const ap = store.getAppeal(apMatch[1]);
      if (!ap) return send(res, 404, { error: "Appeal not found" });
      // P2 范围（learning）：主体是 ap.userId（处理他的申诉 + 给他发通知）。越界必须与
      // 「这条申诉不存在」同形，且要排在 status 检查**之前** —— 先回 400「已处理过」
      // 就等于确认了这条申诉（连同背后那个人）确实存在。
      if (!scopeAllowsFor(user, store.getUserById(ap.userId))) return send(res, 404, { error: "Appeal not found" });
      if (ap.status !== "open") return send(res, 400, { error: "This appeal is already resolved." });
      const status = body.status === "accepted" ? "accepted" : body.status === "rejected" ? "rejected" : null;
      if (!status) return send(res, 400, { error: "status must be accepted or rejected" });
      const resolution = String(body.resolution || "").trim().slice(0, 1000);
      if (status === "rejected" && resolution.length < 5)
        return send(res, 400, { error: "A rejection needs a reason the employee can read.", code: "resolution" });
      const saved = store.resolveAppeal(ap.id, { status, resolution, resolvedBy: user.id });
      notify(ap.userId, {
        type: "appeal",
        title: status === "accepted" ? "Your appeal was upheld and HR has updated your score" : "Your appeal was rejected",
        title_zh: status === "accepted" ? "你的申诉成立，成绩已由 HR 更新" : "你的申诉已驳回",
        body: resolution || null,
        body_zh: resolution || null,
        link: "/record",
      });
      audit("attempt.appeal.resolve", ap.attemptId, { status: "open" }, { appealId: ap.id, status, resolution });
      return send(res, 200, { ok: true, appeal: saved });
    }

    // HR 给简答题定分：改分（score），或确认 AI 初评（confirm: true，方案 5.1）。null 分数显式按 0 计；
    // 全部简答题都有分后重新计算并定稿；从「待复核」转出时执行暂缓的自动重修判定，并通知员工（settleAttempt）。
    const regradeMatch = pathname.match(/^\/api\/admin\/attempts\/([\w-]+)\/regrade$/);
    if (regradeMatch && req.method === "POST") {
      const attempt = store.getAttempt(regradeMatch[1]);
      if (!attempt || !attempt.submittedAt) return send(res, 404, { error: "Attempt not found" });
      // P2 范围（learning）：主体是 attempt.userId —— 改分是对这个人成绩的写。
      if (!scopeAllowsFor(user, store.getUserById(attempt.userId))) return send(res, 404, { error: "Attempt not found" });
      if (attempt.gradingStatus === "grading")
        return send(res, 409, { error: "This attempt is still being scored by AI. Try again in a few minutes.", error_zh: "该答卷仍在 AI 评分中，请几分钟后再试。", code: "grading_in_progress" });
      // CX-203 / CX-209：先判作废（被重置的答卷不计入成绩，不能改分），再找题目
      if (attempt.voided) return send(res, 409, { error: "This attempt was voided (attempts were reset), so it can't be regraded.", error_zh: "该答卷已作废（作答次数已重置），不计入成绩，不能改分。", code: "attempt_voided" });
      const d = (attempt.detail || []).find((x) => x.id === body.questionId && x.type === "open");
      if (!d) return send(res, 400, { error: "Open question not found in this attempt.", error_zh: "这份答卷中没有该简答题。", code: "question_not_found" });
      const aiUsable = !!(d.ai && !d.ai.demo && !d.ai.errorCode && d.ai.suggestedScore != null);
      const prevStatus = attempt.gradingStatus || "final";
      if (body.confirm === true) {
        if (!aiUsable) return send(res, 400, { error: "There is no AI pre-score to confirm on this answer.", error_zh: "这道题没有可确认的 AI 初评。", code: "no_ai_score" });
        audit("attempt.ai.confirm", attempt.id, null, { questionId: d.id, score: d.ai.suggestedScore, callId: d.ai.callId || null });
        d.score = d.ai.suggestedScore;
        d.review = "confirmed";
        d.feedback = d.ai.feedback || null;
      } else {
        // CX-145：只收数字（或数字字符串）；null、空串、非数字回 400（原来 Number(null) = 0，被当作 0 分存下）
        const raw = body.score;
        const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        if (!Number.isFinite(num) || num < 0 || num > d.maxPoints)
          return send(res, 400, { error: `Enter a score from 0 to ${d.maxPoints}.`, error_zh: `请输入 0–${d.maxPoints} 之间的有效分数。`, code: "bad_score" });
        const newScore = Math.round(num);
        audit("attempt.regrade", attempt.id,
          { questionId: d.id, score: d.score, percent: attempt.percent, aiScore: d.ai && d.ai.suggestedScore != null ? d.ai.suggestedScore : null, aiModel: d.ai ? d.ai.modelReturned || d.ai.model || null : null },
          { questionId: d.id, score: newScore, note: String(body.note || "") || null });
        d.score = newScore;
        d.overridden = true;
        d.review = aiUsable ? "overridden" : "manual";
        if (body.feedback !== undefined) d.feedback = String(body.feedback || "").slice(0, 2000) || null;
      }
      const out = settleAttempt(attempt, { prevStatus, requestId });
      const fresh = store.getAttempt(attempt.id);
      return send(res, 200, { ok: true, percent: out.percent, passed: out.passed, gradingStatus: out.status, autoRetrained: out.autoRetrained, detail: fresh.detail });
    }
    // AI 重新初评：交卷时 AI 没接通 / 超时 / 出错（d.ai.errorCode）而还没人工给分的简答题，开 AI 后可以再评一次。
    // 只用于「待复核」「待评分」的答卷；已人工定分的题不动。评分在后台进行，答卷先回到「AI 评分中」。
    const aiRetryMatch = pathname.match(/^\/api\/admin\/attempts\/([\w-]+)\/ai-retry$/);
    if (aiRetryMatch && req.method === "POST") {
      const attempt = store.getAttempt(aiRetryMatch[1]);
      if (!attempt || !attempt.submittedAt) return send(res, 404, { error: "Attempt not found" });
      if (!scopeAllowsFor(user, store.getUserById(attempt.userId))) return send(res, 404, { error: "Attempt not found" });
      const prevStatus = attempt.gradingStatus || "final";
      if (prevStatus === "grading")
        return send(res, 409, { error: "This attempt is still being scored by AI. Try again in a few minutes.", error_zh: "该答卷仍在 AI 评分中，请几分钟后再试。", code: "grading_in_progress" });
      if (prevStatus !== "pending_review" && prevStatus !== "manual_pending")
        return send(res, 400, { error: "Only attempts awaiting review or scoring can be re-scored by AI.", error_zh: "只有待复核、待评分的答卷可以重新 AI 初评。", code: "not_retryable" });
      const todo = (attempt.detail || []).filter((d) => d.type === "open" && d.score == null && d.ai && d.ai.errorCode);
      if (!todo.length) return send(res, 400, { error: "No short answer here is waiting for an AI pre-score.", error_zh: "这份答卷没有需要 AI 重新初评的简答题。", code: "nothing_to_retry" });
      const st = AI.featureState("grading");
      if (st.state !== "on") return sendAiState(res, st);
      store.updateAttemptGrading(attempt.id, { percent: attempt.percent, passed: !!attempt.passed, detail: attempt.detail, gradingStatus: "grading" });
      audit("attempt.ai.retry", attempt.id, { gradingStatus: prevStatus }, { questions: todo.map((d) => d.id) });
      enqueueGrading(attempt.id, Date.now(), prevStatus);
      return send(res, 200, { ok: true, gradingStatus: "grading", questions: todo.length });
    }
    // Assign/unassign programs and set due dates for one employee.
    if (pathname === "/api/admin/assignments" && req.method === "POST") {
      const { userId, items } = body;
      // CX-059（10/11 上线前测试）：先校验再查库 —— 缺 userId 时 store.getUserById(undefined) 会抛 SQLite 绑定错误，回成 500
      if (typeof userId !== "string" || !userId || !Array.isArray(items)) return send(res, 400, { error: "Invalid request" });
      const target = store.getUserById(userId);
      if (!target) return send(res, 400, { error: "Invalid request" });
      // P2 范围（learning）：单人指派。这条 handler 的「查无此人」出口是 400
      // Invalid request（不是 404），所以越界必须复用**它**——同形的对象是同一个
      // handler 的不存在分支，不是别处的 404。回 404 反而会把「这个 id 存在」漏出来。
      if (!scopeAllowsFor(user, target)) return send(res, 400, { error: "Invalid request" });
      for (const it of items) {
        const pr = getProgram(it.programId);
        if (!pr) continue;
        const due = it.dueAt ? String(it.dueAt).slice(0, 10) : null;
        if (it.assigned) {
          const a0 = store.getUserAssignments(userId)[it.programId];
          const already = !!a0 && a0.source !== "self";   // 第四批 7：自主学习 → 指派，照常通知
          store.setAssignment(userId, it.programId, due);
          if (!already) notify(userId, {
            type: "assigned",
            title: `New course assigned: "${pr.title || pr.title_zh || ""}"`,
            title_zh: `你被指派了新课程《${pr.title_zh || pr.title}》`,
            body: "Find it under Learning › My Courses.", body_zh: "可在「培训 › 我的课程」中查看。",
            link: `#/program/${pr.id}`,
          });
        } else store.removeAssignment(userId, it.programId);
      }
      audit("assignments.update", target.employeeId, null, { items: items.map((x) => ({ programId: x.programId, assigned: !!x.assigned, dueAt: x.dueAt || null })) });
      return send(res, 200, { ok: true });
    }
    // Program/course catalog — used by the question-bank UI (dropdowns) and to label columns.
    if (pathname === "/api/admin/catalog" && req.method === "GET") {
      return send(res, 200, {
        programs: PROGRAMS.map((p) => ({ id: p.id, title: p.title, title_zh: p.title_zh })),
        // mode：培养项目据此给引用线下课程的活动开签到（2026-10-06）；modules：题库批量改所属模块的下拉（2026-10-06 B4）
        courses: COURSES.map((c) => ({ id: c.id, programId: c.programId, programIds: programsContaining(c.id, c), title: c.title, title_zh: c.title_zh, mode: c.mode || "online",
          modules: (c.modules || []).map((m) => ({ id: m.id, title: m.title, title_zh: m.title_zh || null })) })),
      });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 15363–16029 行（/api/admin/ 块内）
    async adminLearning5(C) {
      const { pathname, req, user, res, body, audit, query } = C;
      const { scopePredicate, send, store, getTProject, tpCohort, getProgram, bulkIdList, bulkOutOfScope, bulkEnrollRequest, sendBulkScopeReject, runBatch, bulkFaultPoint, bulkSkip, applyEnrollDecision, sendBatchFailed, emitBulkEffects, emitEnrollDecision, sendBulkResult, scopeAllowsFor, TPROJECTS, tpProgressPercent, tpPhaseView, todayLocal, newToken, tpNextCode, refreshContent, tpUserStates, tpActivities, tpActivityDoneOnly, tpActivityView, tpCheckActivities, tpAssignPrograms, parseGradeSelect, resolveGradeSelect, sendScopeBulkReject, notify, auditCriteria, emitMemberOp, applyMemberWithdraw, applyMemberMove, bulkUserSubject, bulkUnchanged, tpCohortSummary, tpRosterTarget, checkinSlot, tpCheckinOpen, checkinCode, tpCohortEnded, emitRosterOp, applyRosterClear, applyRosterMark, bulkNominationSubject, applyNominationDecision, emitNominationDecision } = S;
    if (pathname === "/api/admin/nominations" && req.method === "GET") {
      // P2 范围（learning）：按 a.targetUserId 的部门过滤 —— 每行带姓名/工号/部门。
      // 被提名人已删（u=null）时 scopePredicate 判 false（fail closed，与 store.js
      // parseScope 一节同口径），所以「(deleted)」行在范围生效时不出现。
      const nomScope = scopePredicate(user);
      return send(res, 200, store.listApprovals("nomination", "pending").filter((a) => !nomScope || nomScope(store.getUserById(a.targetUserId))).map((a) => {
        const u = store.getUserById(a.targetUserId);
        const s2 = JSON.parse(a.subjectJson || "{}");
        const doc = getTProject(s2.projectId);
        const cohort = doc ? tpCohort(doc, s2.cohortId) : null;
        return {
          id: a.id, userId: a.targetUserId,
          name: u ? u.name : "(deleted)", employeeId: u ? u.employeeId : "?", department: u ? (u.department || null) : null,
          projectId: s2.projectId, project: doc ? doc.title : s2.projectId, project_zh: doc ? (doc.title_zh || null) : null,
          cohort: cohort ? cohort.name : null,
          note: a.note, requestedAt: a.requestedAt,
        };
      }));
    }
    if (pathname === "/api/admin/enroll-requests" && req.method === "GET") {
      // P2 范围（learning）：按 r.userId 的部门过滤（每行带姓名/工号/部门）。
      const erScope = scopePredicate(user);
      return send(res, 200, store.listPendingRequests().filter((r) => !erScope || erScope(store.getUserById(r.userId))).map((r) => {
        const u = store.getUserById(r.userId);
        const p = getProgram(r.programId);
        return {
          id: r.id, userId: r.userId,
          employeeId: u ? u.employeeId : "?", name: u ? u.name : "(deleted)", department: u ? (u.department || null) : null,
          programId: r.programId, program: p ? p.title : r.programId, program_zh: p ? (p.title_zh || null) : null,
          note: r.note, requestedAt: r.requestedAt,
        };
      }));
    }
    // 批量通过 / 驳回选修课程申请（2026-10-06 B1）。驳回理由必填（所选申请共用一条，员工可见），存的值与单条
    // decide 相同（String(note).slice(0, 500)）。逐条的写库、审计、通知与单条同一组函数。
    if (pathname === "/api/admin/enroll-requests/bulk-decide" && req.method === "POST") {
      const decision = body.decision;
      if (!["approve", "reject"].includes(decision))
        return send(res, 400, { error: "Choose approve or reject.", error_zh: "请选择通过或驳回。", code: "bad_decision" });
      const note = body.note ? String(body.note).slice(0, 500) : null;
      if (decision === "reject" && !(note && note.trim()))
        return send(res, 400, { error: "Enter a reason to reject — it is shown to the employee.", error_zh: "驳回必须填写理由（员工可见）。", code: "note_required" });
      const ids = bulkIdList(res, body.ids);
      if (!ids) return;
      // 主体 = 申请人（批准即派课 + 发通知）；申请人已删时范围生效即算越界（与单条的 404 同口径）
      const erOut = bulkOutOfScope(user, ids, (id) => { const r = bulkEnrollRequest(id); return r ? store.getUserById(r.userId) : undefined; });
      if (erOut) return sendBulkScopeReject(res, erOut);
      const batch = runBatch((cur) => {
        const results = [], effects = [];
        for (let i = 0; i < ids.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const r = bulkEnrollRequest(ids[i]);   // 别的种类的审批 → null → not_found
          if (!r) { results.push(bulkSkip(ids[i], "not_found")); continue; }
          if (r.status !== "pending") { results.push(bulkSkip(r.id, "already_decided")); continue; }
          effects.push(applyEnrollDecision(user, r, decision, note));
          results.push({ id: r.id, ok: true });
        }
        return { results, effects };
      });
      if (!batch.ok) return sendBatchFailed(res, "enroll-requests/bulk-decide", batch, { selection: true, noun: "item", split: true });
      emitBulkEffects("enroll-requests/bulk-decide", batch.value.effects, (e) => emitEnrollDecision(audit, e));
      return sendBulkResult(res, batch.value.results);
    }
    // Approve (→ assign the program) or reject (with an optional reason).
    const decideMatch = pathname.match(/^\/api\/admin\/enroll-requests\/([\w-]+)\/decide$/);
    if (decideMatch && req.method === "POST") {
      const r = store.getEnrollmentRequest(decideMatch[1]);
      if (!r) return send(res, 404, { error: "Not found" });
      // P2 范围（learning）：主体是 r.userId（批准即给他派课 + 发通知）。同 appeals：
      // 排在 status 检查之前，越界与「这条申请不存在」逐字同形。
      if (!scopeAllowsFor(user, store.getUserById(r.userId))) return send(res, 404, { error: "Not found" });
      if (r.status !== "pending") return send(res, 400, { error: "This request was already decided.", error_zh: "该申请已处理。", code: "already_decided" });   // CX-186：与发展项目申请同口径
      const decision = body.decision;
      if (!["approve", "reject"].includes(decision)) return send(res, 400, { error: "Invalid decision." });
      // 写库 + 审计 + 通知与批量 bulk-decide 同一组函数（applyEnrollDecision / emitEnrollDecision）
      const e = applyEnrollDecision(user, r, decision, body.note ? String(body.note).slice(0, 500) : null);
      emitEnrollDecision(audit, e);
      return send(res, 200, { ok: true, status: e.updated.status });
    }
    // --- training projects: admin side (Phase B) ---
    if (pathname === "/api/admin/tprojects" && req.method === "GET") {
      // One query for every project's pending nominations instead of one per row.
      const pendingByProject = {};
      for (const a of store.listApprovals("nomination", "pending")) {
        let pid = null;
        try { pid = JSON.parse(a.subjectJson || "{}").projectId || null; } catch { /* malformed row */ }
        if (pid) pendingByProject[pid] = (pendingByProject[pid] || 0) + 1;
      }
      return send(res, 200, TPROJECTS.map((doc) => {
        const members = store.listProjectMembers(doc.id).filter((m) => m.role === "learner" && m.state === "active");
        // Overall progress = mean of the learners' own percentages, using the same
        // phase view the project page and the learner's own page use, so the card
        // and the detail can never disagree. A project with nobody in it has no
        // progress to report — null, not 0, so the card can say 未开营 instead of
        // implying a stalled cohort.
        let overall = null;
        if (members.length) {
          let sum = 0;
          for (const m of members) {
            const cohort = tpCohort(doc, m.cohortId);
            if (!cohort) continue;
            sum += tpProgressPercent(tpPhaseView(m.userId, doc.id, cohort));
          }
          overall = Math.round(sum / members.length);
        }
        const classCount = (doc.cohorts || []).reduce((n, c) => n + ((c.classes || []).length), 0);
        // 列表表格（12.1 / F53）：起止日期取各期次最早开始、最晚结束；当前期次 = 今天落在起止之间（无结束日视为未结束）的第几期；
        // 负责人姓名由服务端带出，不依赖前端花名册（花名册受数据范围限制，可能查不到负责人）。
        const cohortsList = doc.cohorts || [];
        const ymd = (v) => (v ? String(v).slice(0, 10) : null);
        const starts = cohortsList.map((c) => ymd(c.startAt)).filter(Boolean).sort();
        const ends = cohortsList.map((c) => ymd(c.endAt)).filter(Boolean).sort();
        const todayYmd = todayLocal();
        const curIdx = cohortsList.findIndex((c) => ymd(c.startAt) && ymd(c.startAt) <= todayYmd && (!ymd(c.endAt) || todayYmd <= ymd(c.endAt)));
        const owner = doc.ownerId ? store.getUserById(doc.ownerId) : null;
        return {
          id: doc.id, code: doc.code, title: doc.title, title_zh: doc.title_zh, category: doc.category || null,
          status: doc.status, ownerId: doc.ownerId || null, sponsor: doc.sponsor || null,
          cohortCount: cohortsList.length, classCount, memberCount: members.length,
          progress: overall,
          pendingNominations: pendingByProject[doc.id] || 0,
          startAt: starts[0] || null, endAt: ends.length ? ends[ends.length - 1] : null,
          currentCohort: curIdx >= 0 ? curIdx + 1 : null,
          ownerName: owner ? owner.name : null,
        };
      }));
    }
    if (pathname === "/api/admin/tprojects" && req.method === "POST") {
      const title = String(body.title || "").trim();
      if (!title) return send(res, 400, { error: "Title is required." });
      const doc = {
        id: "tp-" + newToken().slice(0, 8), code: tpNextCode(),
        title, title_zh: String(body.title_zh || "").trim() || null,
        description: String(body.description || "").trim() || null,
        description_zh: String(body.description_zh || "").trim() || null,
        category: String(body.category || "").trim() || null,
        sponsor: String(body.sponsor || "").trim() || null,
        ownerId: user.id, status: "draft", cohorts: [],
        createdAt: new Date().toISOString(),
      };
      store.putContent("tproject", doc.id, doc);
      store.snapshotContent("tproject", doc.id, doc, user.id);
      audit("tproject.create", doc.id, null, { title: doc.title });
      refreshContent();
      return send(res, 200, { ok: true, id: doc.id });
    }
    const tpAdmin = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)$/);
    if (tpAdmin && req.method === "GET") {
      const doc = getTProject(tpAdmin[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      /* P2 范围（learning）—— **混合主体**端点，这是本域唯一需要单独说清楚的形状：
         一个响应里同时装着「项目文档」（标题/期次/阶段/活动 = 内容对象）与
         「members[]」（一串人 = 员工主体）。规则：**只过滤员工那一半，项目文档本身
         一个字都不动**。把整个项目藏掉是错的 —— 项目是内容，范围受限的培训管理员本
         来就该看得见、编得动这个项目（否则 §6.3 的「授权了却用不了」以另一种形式回来）；
         反过来把 members[] 原样发出去，则等于用项目页做了一份全公司名单。
         actStats 直接建在过滤后的 members 上 —— 分母是「范围内的在册学员」，即
         清点文档要的**重算**（不是过滤后不改分母）。 */
      const tpScope = scopePredicate(user);
      const members = store.listProjectMembers(doc.id).map((m) => {
        const u = store.getUserById(m.userId);
        if (tpScope && !tpScope(u)) return null;
        let progress = 0;
        const cohort = tpCohort(doc, m.cohortId);
        if (cohort) progress = tpProgressPercent(tpPhaseView(m.userId, doc.id, cohort));
        // CX-028（2026-10-09 验收）：cohortLog = 期次轨迹 [{ cohortId, enteredAt, leftAt }]（迁移 66），期次成员表可查
        return { userId: m.userId, name: u ? u.name : "?", employeeId: u ? u.employeeId : "?", department: u ? u.department : null, active: u ? u.active !== 0 : false, cohortId: m.cohortId, classId: m.classId, role: m.role, state: m.state, progress, cohortLog: store.memberCohortLog(m) };
      }).filter(Boolean);
      // Per-activity completion counts (active learners of that cohort only).
      const actStats = {};
      for (const cohort of doc.cohorts || []) {
        const learners = members.filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === cohort.id && m.active);
        // States fetched once per learner (not once per learner × activity).
        const stateOf = new Map(learners.map((m) => [m.userId, tpUserStates(m.userId, doc.id, cohort)]));
        for (const a of tpActivities(cohort)) {
          let done = 0;
          for (const m of learners) {
            if (tpActivityDoneOnly(m.userId, a, stateOf.get(m.userId))) done++;
          }
          // Surface dead references so the admin phase list can flag them.
          actStats[a.id] = { done, total: learners.length, broken: !!tpActivityView(a).broken };
        }
      }
      return send(res, 200, { ...doc, members, actStats });
    }
    if (tpAdmin && req.method === "PUT") {
      const doc = getTProject(tpAdmin[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      const title = String(body.title ?? doc.title).trim();
      if (!title) return send(res, 400, { error: "Title is required." });
      // A closed project is the archived record of what happened — allow only
      // re-opening it (status change), never silent edits to its content.
      if (doc.status === "closed") {
        const touchesContent = ["title", "title_zh", "description", "description_zh", "category", "sponsor", "cohorts"]
          .some((k) => body[k] !== undefined);
        if (touchesContent && body.force !== true) {
          return send(res, 409, {
            error: "This project is closed. Re-open it before editing (closed projects are read-only records).",
            code: "closed",
          });
        }
      }
      // CX-115：删除期次（提交的 cohorts 里少了原有的期次）只允许没有学员（含已退训）、也没有签到 / 完成记录的期次
      if (Array.isArray(body.cohorts)) {
        const keep = new Set(body.cohorts.map((c) => c && c.id).filter(Boolean));
        const gone = (doc.cohorts || []).filter((c) => !keep.has(c.id));
        if (gone.length) {
          const mem = store.listProjectMembers(doc.id);
          const states = store.listActivityStatesByProject(doc.id);
          const busy = gone.find((c) => mem.some((m) => m.cohortId === c.id) || states.some((x) => x.cohortId === c.id));
          if (busy) return send(res, 409, { error: `Cohort "${busy.name || ""}" has learners or attendance / completion records and can't be deleted.`, error_zh: `期次「${busy.name || ""}」已有学员或签到、完成记录，不能删除。`, code: "cohort_in_use" });
        }
      }
      // Date sanity: a period that ends before it starts breaks scheduling,
      // gating and every report built on it.
      if (Array.isArray(body.cohorts)) {
        for (const c of body.cohorts) {
          if (c.startAt && c.endAt && String(c.startAt) > String(c.endAt))
            return send(res, 400, { error: `Cohort "${c.name || ""}": the end date must not be earlier than the start date.`, error_zh: `期次「${c.name || ""}」：结束日期不能早于开始日期。`, code: "bad_dates" });
          // Class head (班主任) and per-activity trainer (讲师) grant real, if
          // narrow, access — make sure they point at people who exist.
          for (const cl of c.classes || []) {
            if (cl.headId && !store.getUserById(cl.headId)) cl.headId = null;
          }
          for (const ph of c.phases || []) {
            if (ph.startAt && ph.endAt && String(ph.startAt) > String(ph.endAt))
              return send(res, 400, { error: `Phase "${ph.name_zh || ph.name || ""}": the end date must not be earlier than the start date.`, error_zh: `阶段「${ph.name_zh || ph.name || ""}」：结束日期不能早于开始日期。`, code: "bad_dates" });
            for (const a of ph.activities || []) {
              if (a.trainerId && !store.getUserById(a.trainerId)) a.trainerId = null;
            }
          }
        }
        // 活动结构校验（五类活动；线上活动就地规整）。放在讲师 id 清洗之后，规整看到的是清洗过的 trainerId。
        const actErr = tpCheckActivities(body.cohorts, doc);
        if (actErr) return send(res, 400, actErr);
      }
      const updated = {
        ...doc,
        title,
        title_zh: body.title_zh !== undefined ? (String(body.title_zh || "").trim() || null) : doc.title_zh,
        description: body.description !== undefined ? (String(body.description || "").trim() || null) : doc.description,
        description_zh: body.description_zh !== undefined ? (String(body.description_zh || "").trim() || null) : doc.description_zh,
        category: body.category !== undefined ? (String(body.category || "").trim() || null) : doc.category,
        sponsor: body.sponsor !== undefined ? (String(body.sponsor || "").trim() || null) : doc.sponsor,
        status: ["draft", "planning", "running", "closing", "closed"].includes(body.status) ? body.status : doc.status,
        cohorts: Array.isArray(body.cohorts) ? body.cohorts : doc.cohorts,
      };
      store.putContent("tproject", doc.id, updated);
      store.snapshotContent("tproject", doc.id, updated, user.id);
      audit("tproject.update", doc.id, { status: doc.status }, { status: updated.status, title: updated.title });
      refreshContent();
      // Structure may reference new programs — keep member assignments in sync.
      // CX-117：项目从草稿发布时，给草稿期间加入的在训学员补发「你已加入」通知（草稿期间加学员不发）
      const published = doc.status === "draft" && updated.status !== "draft";
      for (const m of store.listProjectMembers(doc.id)) {
        if (m.role !== "learner" || m.state !== "active") continue;
        const cohort = tpCohort(updated, m.cohortId);
        if (cohort) tpAssignPrograms(m.userId, cohort);
        // CX-187：每人只补发一次 —— 已收到过本项目「你已加入」的不再发（改回草稿再发布不重复通知）
        if (published && cohort && !store.hasNotificationSince(m.userId, "tproject.joined", `#/projects/${doc.id}`, "1970-01-01T00:00:00.000Z")) notify(m.userId, {
          type: "tproject.joined",
          title: `You've been added to the development program “${updated.title || updated.title_zh || ""}”`,
          title_zh: `你已加入发展项目《${updated.title_zh || updated.title}》`,
          body: `Cohort: ${cohort.name}. Find it under Learning › Development Programs.`,
          body_zh: `期次：${cohort.name}。可在「培训 › 发展项目」中查看。`,
          link: `#/projects/${doc.id}`,
        });
      }
      return send(res, 200, { ok: true });
    }
    // Delete a training project. Only for one that never actually ran: the moment
    // learners are enrolled or any attendance exists, that is real learning history
    // and the project must be CLOSED (status "closed") instead — the same shape as
    // departments refusing to delete while occupied, and courses archiving rather
    // than vanishing.
    const tpDel = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)$/);
    if (tpDel && req.method === "DELETE") {
      const doc = getTProject(tpDel[1]);
      if (!doc) return send(res, 404, { error: "Project not found" });
      // Count the same population the list endpoint's memberCount uses: ACTIVE
      // learners. Withdrawing is a soft update (state='withdrawn', row kept), so
      // without the state filter a fully-withdrawn project showed the delete
      // button (memberCount 0) yet this guard still counted the withdrawn rows
      // and 400'd forever. Real history stays protected by the attendance check.
      const learners = store.listProjectMembers(doc.id).filter((m) => m.role === "learner" && m.state === "active");
      const attendance = store.countActivityStates ? store.countActivityStates(doc.id) : 0;
      if (learners.length || attendance) {
        return send(res, 400, {
          // 线上活动的完成行（projectId = 本项目）同样算历史，一并挡住删除
          error: `${learners.length} learner(s) and ${attendance} attendance or completion record(s) belong to this program. Set its status to Closed instead of deleting it. 该发展项目已有学员或出勤 / 完成记录，请把状态改为「已关闭」。`,
          error_zh: "该发展项目已有学员或出勤 / 完成记录，请把状态改为「已关闭」。",
          code: "has_history", learners: learners.length, attendance,
        });
      }
      // Staff-only rows (class heads / trainers) and any pending nominations carry
      // no learning history and are meaningless once the project is gone.
      const staff = store.listProjectMembers(doc.id).length;
      let noms = 0;
      for (const a of store.listApprovals("nomination", "pending")) {
        let pid = null;
        try { pid = JSON.parse(a.subjectJson || "{}").projectId || null; } catch { /* malformed */ }
        if (pid === doc.id) { store.decideApproval(a.id, "rejected", user.id, "project deleted 项目已删除"); noms++; }
      }
      store.deleteProjectMembersFor(doc.id);
      store.deleteContent("tproject", doc.id);
      audit("tproject.delete", doc.id, { title: doc.title, status: doc.status, staff, nominations: noms }, null);
      refreshContent();
      return send(res, 200, { ok: true, staffRemoved: staff, nominationsRejected: noms });
    }
    const tpMembers = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/members$/);
    if (tpMembers && req.method === "POST") {
      const doc = getTProject(tpMembers[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      const cohort = tpCohort(doc, String(body.cohortId || ""));
      if (!cohort) return send(res, 400, { error: "Cohort not found" });
      let userIds = Array.isArray(body.userIds) ? body.userIds : [];
      // 第三批 8.6：可改传 select（部门 × 职级）。圈中的人扣除本项目已在训的学员（任一期次）后加入本期次；后台账号不收。
      let selInfo = null;
      if (!Array.isArray(body.userIds) && body.select) {
        const parsed = parseGradeSelect(user, body.select);
        if (parsed.error) return send(res, parsed.error.status, parsed.error.body);
        const { users, noGrade } = resolveGradeSelect(user, parsed, { excludeAdmins: true });
        const inProj = new Set(store.listProjectMembers(doc.id).filter((m) => m.role === "learner" && m.state === "active").map((m) => m.userId));
        userIds = users.filter((u) => !inProj.has(u.id)).map((u) => u.id);
        selInfo = { alreadyAssigned: users.length - userIds.length, noGrade, select: parsed.echo };
      }
      // P2 范围（learning）：加学员是「对一批人写」（派课 + 发通知）→ 整批拒绝口径。
      // 放在容量校验**之前**：越界的一批根本不该进到容量这一步。
      const tpAddScope = scopePredicate(user);
      if (tpAddScope) {
        let outOfScope = 0;
        for (const uid of userIds) {
          const tu = store.getUserById(uid);
          if (tu && tu.role !== "admin" && !tpAddScope(tu)) outOfScope++;
        }
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      // Capacity is a real constraint (rooms, catering), not decoration: count
      // who is already in and refuse the overflow unless HR forces it.
      // ⚠ P2：`already` 与 `fresh` 都刻意用**未过滤**的在册名单 —— 容量说的是这间教室
      // 里真实坐了多少人，按范围内人数算会把范围外的同班学员算漏，一路超容。
      const already = store.listProjectMembers(doc.id)
        .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === cohort.id).length;
      const fresh = userIds.filter((uid) => {
        const u = store.getUserById(uid);
        return u && u.role !== "admin" && !store.listProjectMembers(doc.id)
          .some((m) => m.userId === uid && m.cohortId === cohort.id && m.role === "learner" && m.state === "active");
      });
      if (cohort.capacity && already + fresh.length > cohort.capacity && body.force !== true) {
        return send(res, 409, {
          error: `Cohort capacity is ${cohort.capacity}; ${already} already enrolled, ${fresh.length} more would exceed it.`,
          code: "over_capacity", capacity: cohort.capacity, current: already, adding: fresh.length,
        });
      }
      let n = 0;
      for (const uid of userIds) {
        const u = store.getUserById(uid);
        // Admins run trainings, they don't sit in them — never enrol as learner
        // (they can still be a class head / mentor).
        if (!u || u.role === "admin") continue;
        store.addProjectMember({ projectId: doc.id, cohortId: cohort.id, userId: uid, role: "learner", classId: body.classId || null });
        tpAssignPrograms(uid, cohort);
        // silent: true = 历史参训导入：不发「已加入培养项目」通知；CX-117：草稿项目员工端看不到，先不发，发布（离开草稿）时补发
        if (body.silent !== true && doc.status !== "draft") notify(uid, {
          type: "tproject.joined",
          title: `You've been added to the development program “${doc.title || doc.title_zh || ""}”`,
          title_zh: `你已加入发展项目《${doc.title_zh || doc.title}》`,
          body: `Cohort: ${cohort.name}. Find it under Learning › Development Programs.`,
          body_zh: `期次：${cohort.name}。可在「培训 › 发展项目」中查看。`,
          link: `#/projects/${doc.id}`,
        });
        n++;
      }
      audit("tproject.members.add", doc.id, null, { cohortId: cohort.id, added: n, ...(selInfo ? { select: selInfo.select, alreadyAssigned: selInfo.alreadyAssigned, noGrade: selInfo.noGrade } : {}), ...(auditCriteria(body.criteria) ? { criteria: auditCriteria(body.criteria) } : {}) });
      return send(res, 200, { ok: true, count: n, ...(selInfo || {}) });
    }
    const tpMemberUpd = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/members\/update$/);
    if (tpMemberUpd && req.method === "POST") {
      const doc = getTProject(tpMemberUpd[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      const target = store.getUserById(String(body.userId || ""));
      if (!target) return send(res, 404, { error: "User not found" });
      // P2 范围（learning）：退出/调班的主体是这一个学员。
      if (!scopeAllowsFor(user, target)) return send(res, 404, { error: "User not found" });
      const action = body.action;
      // 写库与审计与批量 members/bulk-update 同一组函数（applyMember* / emitMemberOp）
      if (action === "withdraw") {
        emitMemberOp(audit, applyMemberWithdraw(doc, target));
        return send(res, 200, { ok: true });
      }
      if (action === "move") {
        emitMemberOp(audit, applyMemberMove(doc, target, body));
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: "Unknown action" });
    }
    // 批量调整期次 / 班级、批量退训（2026-10-06 B2）。只在本培养项目内调整（期次必须属于本项目、班级必须属于该期次）；
    // 退训与单条一致（state = 'withdrawn'，学习与签到记录保留）。调整不校验期次容量（与单条调整一致，负责人 2026-10-06）。
    const tpMemberBulk = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/members\/bulk-update$/);
    if (tpMemberBulk && req.method === "POST") {
      const doc = getTProject(tpMemberBulk[1]);
      if (!doc) return send(res, 404, { error: "Not found", error_zh: "未找到该发展项目。", code: "not_found" });
      const action = body.action;
      if (!["move", "withdraw"].includes(action)) return send(res, 400, { error: "Unknown action.", error_zh: "未知操作。", code: "bad_action" });
      let toCohort = null, classId = null;
      if (action === "move") {
        toCohort = tpCohort(doc, String(body.cohortId || ""));
        if (!toCohort) return send(res, 400, { error: "Pick a cohort of this program.", error_zh: "请选择本发展项目内的期次。", code: "bad_cohort" });
        classId = body.classId ? String(body.classId) : null;
        if (classId && !(toCohort.classes || []).some((c) => c.id === classId))
          return send(res, 400, { error: "That class is not in the chosen cohort.", error_zh: "所选班级不属于该期次。", code: "bad_class" });
      }
      const userIds = bulkIdList(res, body.userIds);
      if (!userIds) return;
      const mbOut = bulkOutOfScope(user, userIds, bulkUserSubject);
      if (mbOut) return sendBulkScopeReject(res, mbOut);
      const batch = runBatch((cur) => {
        const results = [], effects = [];
        // 成员表在事务里只读一次：同一批里每人只出现一次（已去重），前面的写不影响后面的判定
        const memberOf = new Map(store.listProjectMembers(doc.id).filter((m) => m.role === "learner").map((m) => [m.userId, m]));
        for (let i = 0; i < userIds.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const target = store.getUserById(userIds[i]);
          if (!target) { results.push(bulkSkip(userIds[i], "not_found")); continue; }
          const m = memberOf.get(target.id);
          if (!m) { results.push(bulkSkip(target.id, "not_member")); continue; }
          if (action === "withdraw") {
            if (m.state === "withdrawn") { results.push(bulkUnchanged(target.id)); continue; }
            effects.push(applyMemberWithdraw(doc, target));
          } else {
            if (m.state !== "active") { results.push(bulkSkip(target.id, "withdrawn")); continue; }
            if (m.cohortId === toCohort.id && (m.classId || null) === classId) { results.push(bulkUnchanged(target.id)); continue; }
            effects.push(applyMemberMove(doc, target, { cohortId: toCohort.id, classId }));
          }
          results.push({ id: target.id, ok: true });
        }
        return { results, effects };
      });
      if (!batch.ok) return sendBatchFailed(res, "tprojects/members/bulk-update", batch, { selection: true, split: true });
      emitBulkEffects("tprojects/members/bulk-update", batch.value.effects, (e) => emitMemberOp(audit, e));
      return sendBulkResult(res, batch.value.results);
    }
    const tpDash = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/dashboard$/);
    if (tpDash && req.method === "GET") {
      const doc = getTProject(tpDash[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      const cohort = tpCohort(doc, (query && query.get("cohort")) || "") || (doc.cohorts || [])[0];
      if (!cohort) return send(res, 200, { members: 0, phaseFunnel: [], attendance: null, risks: [] });
      // P2 范围（learning）：项目看板是聚合 + risks[]（带姓名/工号）。learners 先按范围
      // 过滤**再**算 —— phaseFunnel 的 total、progressAvg 的分母、risks 都长在这一个
      // 数组上，所以过滤这一处就是清点文档要的「重算」。attendance 走的是 activity
      // states（按活动而非按人聚合的百分比），不带任何身份字段，维持原样。
      const tpDashScope = scopePredicate(user);
      const learners = store.listProjectMembers(doc.id)
        .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === cohort.id)
        .map((m) => ({ ...m, u: store.getUserById(m.userId) }))
        .filter((m) => m.u && m.u.active !== 0) // deactivated staff leave the denominator
        .filter((m) => !tpDashScope || tpDashScope(m.u));
      // 计算本体在 tpCohortSummary（第三批：培训概览的「进行中的培养项目」卡片共用，2026-10-08）
      const sum = tpCohortSummary(doc, cohort, learners);
      return send(res, 200, {
        members: learners.length,
        progressAvg: sum.progressAvg,
        phaseFunnel: sum.phaseFunnel,
        attendance: sum.attendance.total ? Math.round((sum.attendance.present / sum.attendance.total) * 100) : null,
        risks: sum.risks.slice(0, 20).map(({ userId, ...r }) => r),
      });
    }
    const tpCheckAdmin = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)$/);
    if (tpCheckAdmin && req.method === "GET") {
      const doc = getTProject(tpCheckAdmin[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      let cohort = null, act = null;
      for (const c of doc.cohorts || []) { const a = tpActivities(c).find((x) => x.id === tpCheckAdmin[2]); if (a) { cohort = c; act = a; break; } }
      // 签到类（线下活动，或引用线下课程的课程活动 —— 读课程出勤）与线上活动（完成名单）；其余 404
      const tgt = tpRosterTarget(act, doc, cohort);
      if (!tgt) return send(res, 404, { error: "Activity not found", error_zh: "未找到该活动。", code: "not_found" });
      const states = {};
      for (const st of store.listActivityStates(tgt.ckId)) states[st.userId] = st;
      // P2 范围（learning）：出勤名单是一串人 → 过滤；下面的 stats 全部由 list 派生，
      // 所以过滤即重算。签到码 checkinCode() 是 HMAC 纯派生（活动 id + 时间片），
      // 与「谁在名单里」无关 —— 刻意不受范围影响。
      const ckScope = scopePredicate(user);
      const list = store.listProjectMembers(doc.id)
        .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === cohort.id)
        .filter((m) => !ckScope || ckScope(store.getUserById(m.userId)))
        .map((m) => {
          const u = store.getUserById(m.userId);
          const st = states[m.userId];
          const cls = (cohort.classes || []).find((c) => c.id === m.classId);
          // self = checked in with the code on their own phone (by = themself);
          // only the other rows (补签 / 请假 entered by staff) can be undone.
          // 线上活动：self = 学员自己打开链接 / 自行确认的行；HR 可撤销任何一行。
          return { userId: m.userId, name: u ? u.name : "?", employeeId: u ? u.employeeId : "?", class: cls ? cls.name : null, status: st ? st.status : null, at: st ? st.at : null, self: !!(st && st.by && st.by === m.userId) };
        });
      // 线上活动：没有签到码，名单只分已完成 / 请假 / 未完成
      if (tgt.rollKind === "completion") {
        return send(res, 200, {
          rollKind: "completion",
          completion: tpActivityView(act).completion,
          code: null,
          checkinOpen: false,
          projectStatus: doc.status,
          stats: {
            completed: list.filter((x) => x.status === "completed").length,
            excused: list.filter((x) => x.status === "excused").length,
            missing: list.filter((x) => !x.status).length,
            attended: 0, late: 0,   // 旧版前端读 attended + late，给 0 免得显示 NaN
          },
          list,
        });
      }
      const slot = checkinSlot();
      return send(res, 200, {
        rollKind: "checkin",
        code: tpCheckinOpen(doc, cohort) ? checkinCode(tgt.ckId, slot) : null,
        checkinOpen: tpCheckinOpen(doc, cohort),
        cohortEnded: tpCohortEnded(cohort),   // CX-025：进行中但期次已过结束日 → 不出码
        projectStatus: doc.status,
        secondsLeft: Math.ceil(((slot + 1) * 60000 - Date.now()) / 1000),
        stats: {
          attended: list.filter((x) => x.status === "attended").length,
          late: list.filter((x) => x.status === "late").length,
          excused: list.filter((x) => x.status === "excused").length,
          missing: list.filter((x) => !x.status).length,
        },
        list,
      });
    }
    const tpCheckMark = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)\/mark$/);
    if (tpCheckMark && req.method === "POST") {
      const doc = getTProject(tpCheckMark[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      let cohort = null, ckAct = null;
      for (const c of doc.cohorts || []) { const x = tpActivities(c).find((y) => y.id === tpCheckMark[2]); if (x) { cohort = c; ckAct = x; break; } }
      if (!cohort) return send(res, 404, { error: "Activity not found", error_zh: "未找到该活动。", code: "not_found" });
      // 有名单的活动才能登记：签到类（线下活动；引用线下课程的课程活动记在课程出勤上）与线上活动（完成登记）。
      // 考试、线上课程、学习包没有名单 → 404（原来会落到通用分支，往活动行里写一条没人读的记录）。
      const tgt = tpRosterTarget(ckAct, doc, cohort);
      if (!tgt) return send(res, 404, { error: "Activity not found", error_zh: "未找到该活动。", code: "not_found" });
      const completion = tgt.rollKind === "completion";
      // 先校验状态、再查人（顺序与原来一致：范围外与不存在的人应答逐字同形）
      let status = String(body.status || "");
      if (completion) {
        if (status === "attended" || status === "late") status = "completed";   // 「补签」类按钮发的是 attended
        if (!["completed", "excused", "clear"].includes(status)) return send(res, 400, { error: "Invalid status", error_zh: "状态无效。", code: "bad_status" });
      } else if (!["attended", "late", "excused", "absent", "clear"].includes(status)) {
        return send(res, 400, { error: "Invalid status", error_zh: "状态无效。", code: "bad_status" });
      }
      const target = store.getUserById(String(body.userId || ""));
      if (!target) return send(res, 404, { error: "User not found", error_zh: "未找到该员工。" });
      // P2 范围（learning）：标出勤是对这一个学员的写。
      if (!scopeAllowsFor(user, target)) return send(res, 404, { error: "User not found", error_zh: "未找到该员工。" });
      // 取消补签 / 取消请假：删掉这一行，学员回到「未签到」。只撤销别人代登记的
      // 记录（HR / 讲师 / 班主任补签、登记请假）。学员自己输码签到的（by = 本人）
      // 是现场到场的凭证，这里不给撤 —— 要纠正就改登记状态，而不是抹掉。
      // 写库与审计与批量 checkin/:act/bulk-mark 同一组函数（applyRoster* / emitRosterOp）
      if (status === "clear") {
        const prev = store.getActivityState(tgt.ckId, target.id);
        if (!prev) return send(res, 200, { ok: true });
        if (completion) {
          // 线上活动：HR 可撤销任何一行，包括学员自己打开链接 / 自行确认的（打开链接不等于真的参加了；负责人 2026-10-06）
          emitRosterOp(audit, applyRosterClear(doc, tgt, target, prev, tpCheckMark[2]));
          return send(res, 200, { ok: true });
        }
        if (prev.by && prev.by === target.id)
          return send(res, 409, { error: "This learner checked in with the code themselves; a self check-in can't be undone.", error_zh: "该学员是自己输码签到的，不能撤销。", code: "self_checkin" });
        emitRosterOp(audit, applyRosterClear(doc, tgt, target, prev, tpCheckMark[2]));
        return send(res, 200, { ok: true });
      }
      const note = body.note ? String(body.note).slice(0, 200) : null;
      // CX-111：「迟到」改为出席时，学员本人输码签到的行保留 by = 学员本人（仍是本人签到、不可撤销），与批量 bulk-mark 同口径
      const prevMark = completion ? null : store.getActivityState(tgt.ckId, target.id);
      const keepSelf = !!prevMark && status === "attended" && prevMark.status === "late" && prevMark.by && prevMark.by === target.id;
      emitRosterOp(audit, applyRosterMark(user, doc, tgt, target, status, note, tpCheckMark[2], keepSelf ? target.id : null));
      return send(res, 200, { ok: true });
    }
    // 签到 / 完成登记名单的批量登记与撤销（2026-10-06 B3）。签到名单：attended（补签）/ excused（请假）/ clear（撤销）；
    // 完成登记名单（线上活动）：completed / excused / clear，attended 按 completed 处理。迟到、缺勤不提供批量。
    // 批量登记只写空白行，不覆盖已有的不同登记（already_marked）；例外两条：
    //   1) 签到名单的 attended 把「迟到」改为出席（同单条「改为出席」）—— 改的是学员本人输码签到的行时保留 by = 学员本人，
    //      它仍是本人签到、仍不可撤销；
    //   2) 补课登记（负责人 2026-10-06：请假不算完成、需补课）：「请假」可直接改为出席（签到名单 attended）/ 完成
    //      （完成登记名单 completed，attended 按 completed），不必先撤销；by = 操作人，之后仍可撤销。
    // 批量撤销：签到名单跳过学员本人输码签到的行（self_checkin，同单条 409）；完成登记名单可撤销学员本人完成的行（同单条）；
    // 本来就没有登记的行算未改动（unchanged，同单条 200 {ok:true}）。
    // 引用线下课程的活动，这一行就是该课程的出勤：登记即课程完成，撤销即课程回到未完成（同单条）。
    const tpCheckBulk = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/checkin\/([\w-]+)\/bulk-mark$/);
    if (tpCheckBulk && req.method === "POST") {
      const doc = getTProject(tpCheckBulk[1]);
      if (!doc) return send(res, 404, { error: "Not found", error_zh: "未找到该发展项目。", code: "not_found" });
      let cohort = null, ckAct = null;
      for (const c of doc.cohorts || []) { const x = tpActivities(c).find((y) => y.id === tpCheckBulk[2]); if (x) { cohort = c; ckAct = x; break; } }
      const tgt = cohort ? tpRosterTarget(ckAct, doc, cohort) : null;
      if (!tgt) return send(res, 404, { error: "Activity not found", error_zh: "未找到该活动。", code: "not_found" });
      const completion = tgt.rollKind === "completion";
      let status = String(body.status || "");
      if (completion && status === "attended") status = "completed";   // 「补签」类按钮发的是 attended
      if (!(completion ? ["completed", "excused", "clear"] : ["attended", "excused", "clear"]).includes(status))
        return send(res, 400, { error: "Invalid status", error_zh: "状态无效。", code: "bad_status" });
      const userIds = bulkIdList(res, body.userIds);
      if (!userIds) return;
      const ckOut = bulkOutOfScope(user, userIds, bulkUserSubject);
      if (ckOut) return sendBulkScopeReject(res, ckOut);
      const note = body.note ? String(body.note).slice(0, 200) : null;
      const batch = runBatch((cur) => {
        const results = [], effects = [];
        const roster = new Set(store.listProjectMembers(doc.id)
          .filter((m) => m.role === "learner" && m.state === "active" && m.cohortId === cohort.id).map((m) => m.userId));
        for (let i = 0; i < userIds.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const target = store.getUserById(userIds[i]);
          if (!target) { results.push(bulkSkip(userIds[i], "not_found")); continue; }
          if (!roster.has(target.id)) { results.push(bulkSkip(target.id, "not_in_roster")); continue; }
          const prev = store.getActivityState(tgt.ckId, target.id);
          if (status === "clear") {
            if (!prev) { results.push(bulkUnchanged(target.id)); continue; }   // 本来就没有登记 = 已是目标状态（同单条 200）
            if (!completion && prev.by && prev.by === target.id) { results.push(bulkSkip(target.id, "self_checkin")); continue; }
            effects.push(applyRosterClear(doc, tgt, target, prev, tpCheckBulk[2]));
          } else {
            if (prev && prev.status === status) { results.push(bulkUnchanged(target.id)); continue; }
            const upgrade = !!prev && !completion && status === "attended" && prev.status === "late";
            // 补课：请假 → 出席 / 完成，直接改写（负责人 2026-10-06）
            const makeup = !!prev && prev.status === "excused" && status === (completion ? "completed" : "attended");
            if (prev && !upgrade && !makeup) { results.push(bulkSkip(target.id, "already_marked", { status: prev.status })); continue; }
            const keepSelf = upgrade && prev.by && prev.by === target.id;
            effects.push(applyRosterMark(user, doc, tgt, target, status, note, tpCheckBulk[2], keepSelf ? target.id : null));
          }
          results.push({ id: target.id, ok: true });
        }
        return { results, effects };
      });
      if (!batch.ok) return sendBatchFailed(res, "tprojects/checkin/bulk-mark", batch, { selection: true, split: true });
      emitBulkEffects("tprojects/checkin/bulk-mark", batch.value.effects, (e) => emitRosterOp(audit, e));
      return sendBulkResult(res, batch.value.results);
    }
    const tpNoms = pathname.match(/^\/api\/admin\/tprojects\/([\w-]+)\/nominations$/);
    if (tpNoms && req.method === "GET") {
      const doc = getTProject(tpNoms[1]);
      if (!doc) return send(res, 404, { error: "Not found" });
      // P2 范围（learning）：项目内提名同样带姓名/工号/部门 → 按 targetUserId 过滤，
      // 与全局 /nominations 一条口径。
      const tpNomScope = scopePredicate(user);
      const rows = store.listApprovals("nomination", "pending")
        .filter((a) => JSON.parse(a.subjectJson || "{}").projectId === doc.id)
        .filter((a) => !tpNomScope || tpNomScope(store.getUserById(a.targetUserId)))
        .map((a) => {
          const u = store.getUserById(a.targetUserId);
          const s = JSON.parse(a.subjectJson || "{}");
          return { id: a.id, userId: a.targetUserId, name: u ? u.name : "?", employeeId: u ? u.employeeId : "?", department: u ? u.department : null, cohortId: s.cohortId || null, note: a.note, requestedAt: a.requestedAt };
        });
      return send(res, 200, rows);
    }
    // 批量通过 / 驳回培养项目申请（2026-10-06 B1）。驳回理由必填，存的值与单条相同。期次容量逐条在事务里重数
    // （前面通过的人算进去），满员的逐条报 over_capacity；带 force:true 再提交一次即「仍然通过」（同单条）。
    // 不收 classId：申请审批页不选班级，且一批申请可跨多个培养项目。
    if (pathname === "/api/admin/nominations/bulk-decide" && req.method === "POST") {
      const decision = body.decision;
      if (!["approve", "reject"].includes(decision))
        return send(res, 400, { error: "Choose approve or reject.", error_zh: "请选择通过或驳回。", code: "bad_decision" });
      const note = body.note ? String(body.note).slice(0, 500) : null;
      if (decision === "reject" && !(note && note.trim()))
        return send(res, 400, { error: "Enter a reason to reject — it is shown to the employee.", error_zh: "驳回必须填写理由（员工可见）。", code: "note_required" });
      const ids = bulkIdList(res, body.ids);
      if (!ids) return;
      const nmOut = bulkOutOfScope(user, ids, (id) => { const a = store.getApproval(id); return a && a.kind === "nomination" ? store.getUserById(a.targetUserId) : undefined; });
      if (nmOut) return sendBulkScopeReject(res, nmOut);
      const force = body.force === true;
      const batch = runBatch((cur) => {
        const results = [], effects = [];
        for (let i = 0; i < ids.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const a = store.getApproval(ids[i]);
          if (!a || a.kind !== "nomination") { results.push(bulkSkip(ids[i], "not_found")); continue; }
          if (a.status !== "pending") { results.push(bulkSkip(a.id, "already_decided")); continue; }
          const s = bulkNominationSubject(a);
          if (!s) { results.push(bulkSkip(a.id, "not_found")); continue; }
          const out = applyNominationDecision(user, a, s, decision, note, { force });
          if (out.fail) { results.push(bulkSkip(a.id, out.fail.code, out.fail.extra)); continue; }
          effects.push(out.eff);
          results.push({ id: a.id, ok: true });
        }
        return { results, effects };
      });
      if (!batch.ok) return sendBatchFailed(res, "nominations/bulk-decide", batch, { selection: true, noun: "item", split: true });
      emitBulkEffects("nominations/bulk-decide", batch.value.effects, (e) => emitNominationDecision(audit, e));
      return sendBulkResult(res, batch.value.results);
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 16178–16937 行（/api/admin/ 块内）
    async adminLearning6(C) {
      const { pathname, req, body, user, audit, res, query, requestId } = C;
      const { trainingOverviewBase, TS, LC, ovRemindable, COMPLETION, store, notify, send, trainingSearch, overviewPeople, sendCsv, buildOverviewV2, getProgram, courseProjectsIndex, mediaSummary, scopePredicate, PROGRAMS, COURSES, courseWrapperOf, refreshContent, CAT, bulkIdList, runBatch, bulkSkip, programCourseId, bulkUnchanged, sendBatchFailed, emitBulkEffects, sendBulkResult, bulkFaultPoint, PUBC, mirrorCourseWrapper, publicOpenApply, publicCloseApply, programHasExam, tpSyncCourseAssignments, publicOpenNotify, getCourse, CPKG, clampText, sanitizeHtml, VURL, readConfig, programsContaining, userProgress, newToken, courseUsage, selfRowsOf, courseCkId, checkinSlot, checkinCode, scopeAllowsFor, canWrite, OFFICE_CONV, VIDEO_TC, mediaAdminItem, attachmentRefsIndex, path, ROOT, fs, VIDEO_EXT } = S;
    if (pathname === "/api/admin/training/remind-overdue" && req.method === "POST") {
      const only = String(body.programId || "").trim();     // optional: one course
      // 2026-10-07（负责人）：请求体可带培训概览的筛选条件，与 GET /api/admin/overview 同一份解析（trainingOverviewBase）——
      // 提醒的是看板名单里可提醒的那些人；不带筛选（{}）= 范围内全部逾期的人。programs 可以是逗号分隔的字符串，也可以是数组；
      // 其余类型按「没传」处理（与看板对非法值的处理一致）。
      // 第三批（2026-10-08）：另收 cat / enroll / mode / tp / period / from / to、名单的 ldept / lcat / lprog / lenroll（各自替换同名筛选），
      // 以及 metric："overdue"（默认，已逾期）| "dueSoon"（7 天内到期，提前提醒，文案与定时任务 notify-due 的 due_soon 相同；
      // 每人每天最多一条：今天已收到过 due_soon 的人计入 skippedToday；CX-114 起「已逾期」按同一门课每人每天一条去重）。同样筛选下 reminded + skippedToday = 名单的 remindablePeople。
      const metric = body.metric === "dueSoon" ? "dueSoon" : "overdue";
      // CX-188：dryRun = 只预演（弹窗预览用）：同一判定算出「将发送 / 今天已提醒」人数，不发通知、不写审计
      // CX-195：dryRun 接受 true / "true" / 1 / "1"（前端经查询串拼请求体时布尔会变成字符串）；其他非空值一律 400，
      // 绝不把一个看不懂的预演请求当成真实发送
      const dv = body.dryRun;
      if (dv !== undefined && dv !== null && dv !== false && dv !== "" && ![true, "true", 1, "1", "false", 0, "0"].includes(dv))
        return send(res, 400, { error: "dryRun must be true or false.", error_zh: "dryRun 只能为 true 或 false。", code: "bad_dry_run" });
      const dryRun = dv === true || dv === "true" || dv === 1 || dv === "1";
      const sendNote = (uid, n) => { if (!dryRun) notify(uid, n); };
      const pick = (k) => {
        const v = body[k];
        if (Array.isArray(v)) return v.filter((x) => typeof x === "string" || typeof x === "number").map(String).join(",") || null;
        return typeof v === "string" || typeof v === "number" ? String(v) : null;
      };
      const LOV = { dept: "ldept", cat: "lcat", programs: "lprog", enroll: "lenroll" };
      const ov = trainingOverviewBase(user, (k) => (LOV[k] && pick(LOV[k]) ? pick(LOV[k]) : pick(k)));
      // P2 范围（learning）：写方向是「给一批人发消息」——收件人集合按范围过滤，范围外
      // 的人不发、也不计入 reminded/sample。这里刻意**不**走整批拒绝：调用方没有提交
      // 任何 id（是「扫全员逾期」的一键动作），没有可以回报给他的越界行数；语义是
      // 「提醒我管的人」而不是「提醒这批人」。（范围过滤在 trainingOverviewBase 的人群里。）
      const sent = [];
      let skippedToday = 0;
      const since = TS.parseDay(ov.today).toISOString();     // 本地今天 00:00
      const S = ov.snap();
      for (const u of ov.users) {
        // 可提醒的人：不是纯服务账号、账号可用、未离职（也是员工的管理员照常提醒，负责人 2026-10-07）
        if (!LC.isRemindableUser(u)) continue;
        const asg = S.getUserAssignments(u.id);
        // 与看板名单同一判定（ovRemindable）：逾期 = 本期应完成、今天已逾期；提前提醒 = 7 天内到期；
        // 再排除课程已下线、无法完成、成绩待定、仅因已退训项目而有的指派（COMPLETION.reminderEligible）。
        // One reminder per person per run, even if several courses qualify — three notifications in a row reads as spam.
        // 提前提醒点名最早到期的那门课。
        let hit = null;
        for (const p of ov.programs) {
          if (only && p.id !== only) continue;
          const a = asg[p.id];
          if (!a) continue;
          const c = ov.cellOf(u, p, a);
          if (!ovRemindable(ov, c, metric)) continue;
          if (metric === "overdue") { hit = c; break; }
          if (!hit || c.dueDay < hit.dueDay) hit = c;
        }
        if (!hit) continue;
        const p = hit.p, a = hit.asg;
        // 落笔之前用实时口径再核一次（快照与实时口径由 test/training-snapshot-parity 保证一致，这里只是兜底）
        if (!COMPLETION.reminderEligible(u, p, a)) continue;
        if (metric === "dueSoon") {
          if (store.hasNotificationTypeSince(u.id, "due_soon", since)) { skippedToday++; continue; }
          const d = TS.daysBetween(ov.today, hit.dueDay);
          sendNote(u.id, {
            type: "due_soon",
            title: `Due soon: "${p.title || p.title_zh || ""}"`,
            title_zh: `即将截止：《${p.title_zh || p.title}》`,
            body: `Due in ${d} day(s) (${a.dueAt}).`,
            body_zh: `还有 ${d} 天截止（${a.dueAt}）。`,
            link: `#/program/${p.id}`,
          });
        } else {
          // CX-114：同一门课今天已收到过逾期提醒的人不重复发送，计入 skippedToday（原来同一天再点会收到两条相同通知）；type "training" 只有这里发
          if (store.hasNotificationLinkSince(u.id, "training", `#/program/${p.id}`, since)) { skippedToday++; continue; }
          sendNote(u.id, {
            type: "training",
            title: `Training overdue: ${p.title || p.title_zh || ""}`,
            title_zh: `培训已逾期：${p.title_zh || p.title}`,   // CX-123：中文全角标点
            body: `Due ${a.dueAt}. Please finish it as soon as you can.`,
            body_zh: `截止日期 ${a.dueAt}，请尽快完成。`,
            link: `#/program/${p.id}`,
          });
        }
        sent.push({ employeeId: u.employeeId, name: u.name, program: p.id, dueAt: a.dueAt });
      }
      // 审计带实际生效的筛选（安全审查 8：看日志能知道范围管理员给哪些人发了消息）
      const effFilters = { dept: ov.deptSet ? ov.qDept : null, programs: ov.qProgs, cat: ov.cat, enroll: ov.enroll, mode: ov.mode, tp: ov.tp, cohort: ov.cohort, period: ov.period, from: ov.win.from, to: ov.win.to };
      if (dryRun) return send(res, 200, { ok: true, dryRun: true, reminded: sent.length, skippedToday });
      const after = { reminded: sent.length, skippedToday, ...(ov.filtered ? { filtered: true, filters: effFilters } : {}) };
      if (metric === "dueSoon") audit("training.remind-due-soon", only || null, null, after);
      else audit("training.remind-overdue", only || null, null, after);
      return send(res, 200, { ok: true, reminded: sent.length, skippedToday, sample: sent.slice(0, 10) });
    }
    // --- training search & name list (第三批 4.2，2026-10-08) ---
    // 全局搜索：课程、员工（姓名或工号）、部门；人员与部门按数据范围，课程不受范围限制（设计 §4.3）
    if (pathname === "/api/admin/training/search" && req.method === "GET") {
      return send(res, 200, trainingSearch(user, query.get("q")));
    }
    // 名单：看板上每个数字的下钻（metric × 看板筛选 × ldept/lcat/lprog/lenroll 覆盖），可分页、排序、按姓名或工号查找、导出 CSV（设计 §4.2）
    if (pathname === "/api/admin/overview/people" && req.method === "GET") {
      const LOV = { dept: "ldept", cat: "lcat", programs: "lprog", enroll: "lenroll" };
      const ov = trainingOverviewBase(user, (k) => (LOV[k] && query.get(LOV[k]) ? query.get(LOV[k]) : query.get(k)));
      const out = overviewPeople(user, ov, query);
      if (out.csv) {
        const filters = { dept: ov.deptSet ? ov.qDept : null, programs: ov.qProgs, cat: ov.cat, enroll: ov.enroll, mode: ov.mode, tp: ov.tp, cohort: ov.cohort, period: ov.period, from: ov.win.from, to: ov.win.to };
        audit("export.training-people", null, null, { metric: query.get("metric") || "assigned", rows: out.csv.count, filters });
        return sendCsv(res, out.csv.filename, out.csv.rows);
      }
      return send(res, out.status, out.body);
    }
    // --- overview dashboard ---
    if (pathname === "/api/admin/overview" && req.method === "GET") {
      // P2 范围（learning）：整条端点是聚合 → **重算**，不是算完再裁。基础人群 users
      // 先过滤，perProgram 的各状态计数、byDept、overdueList 全部长在它上面；attempts
      // 同样按提交人过滤，因为 passRate/avgScore 的分母和 recent[]（带姓名/工号）都取
      // 自它 —— 分母不跟着范围走，进度条就永远对不上范围内的那份名单。
      //
      // 2026-10-06 看板重做（需求单 #10）：在范围之上再叠筛选——
      //   dept=<部门 id>（含全部下级）、programs=<课程 id,逗号分隔>、from/to=YYYY-MM-DD（按指派日期）、
      //   cohort=all|probation|new30（在职 / 试用期 / 近 30 天新入职）。
      // 另回 deptTree（每个部门自身的人数/指派/完成/逾期/考试，前端按树上卷）、matrix（课程 × 一级部门）、
      // trend（近 12 周指派 / 考试提交 / 通过）、overdueList 里带直属上级。不带参数时原字段与原口径一字不差。
      // 人群与筛选的解析、逐格状态在 trainingOverviewBase（与「一键提醒」共用，2026-10-07）。
      // 人群 = 范围内、账号可用、不是纯服务账号的人（2026-10-07 起也是员工的管理员照常统计，与员工名册同一规则）。
      // 第三批（2026-10-08）：v=2 = 风险优先看板的新载荷（buildOverviewV2，设计 §4.1）；不带 v 时原字段与原口径不变，
      // 只多 trend[].completed，trend[].week 改为本地周一（修掉 UTC+8 下标成周日的差一天）。
      const ovb = trainingOverviewBase(user, (k) => query.get(k));
      if (query.get("v") === "2") return send(res, 200, buildOverviewV2(user, ovb));
      const { depts, parentOf, topOf, userDeptId, qDept, deptSet, qProgs, progSet, from, to, cohort, users, programs, statusOf } = ovb;
      const userIds = new Set(users.map((u) => u.id));
      const attempts = store.listSubmittedAttempts()
        .filter((a) => userIds.has(a.userId))
        .filter((a) => !progSet || progSet.has(a.programId));
      // 每人的指派快照只取一次，下面几张表共用
      const asgOf = new Map(users.map((u) => [u.id, ovb.snap().getUserAssignments(u.id)]));
      const managerName = (u) => { const m = u.managerId ? store.getUserById(u.managerId) : null; return m ? m.name : null; };
      const perProgram = programs.map((p) => {
        const c = { done: 0, overdue: 0, inprog: 0, notstarted: 0, assigned: 0 };
        const overdueList = [];
        for (const u of users) {
          const asg = asgOf.get(u.id);
          const st = statusOf(u, p, asg);
          if (!st) continue;
          c.assigned++;
          c[st]++;
          // remindable（2026-10-07）：「一键提醒」会不会提醒这一行 —— 人未离职、课程已发布且能完成、没有待定的成绩、
          // 不是仅因已退训项目而有的指派（与 remind-overdue 同一判定 COMPLETION.reminderEligible）。只新增字段，计数口径不变。
          if (st === "overdue") overdueList.push({ name: u.name, employeeId: u.employeeId, department: u.department || "—", dueAt: asg[p.id].dueAt, managerName: managerName(u), userId: u.id, remindable: COMPLETION.reminderEligible(u, p, asg[p.id]) });
        }
        const subs = attempts.filter((a) => a.programId === p.id);
        const passRate = subs.length ? Math.round((subs.filter((a) => a.passed).length / subs.length) * 100) : null;
        const avgScore = subs.length ? Math.round(subs.reduce((s, a) => s + a.percent, 0) / subs.length) : null;
        return { id: p.id, title: p.title, title_zh: p.title_zh || null, ...c, attempts: subs.length, passRate, avgScore, overdueList };
      });
      const byDept = {};
      const zero = () => ({ headcount: 0, assigned: 0, done: 0, overdue: 0, overduePeople: 0, attempts: 0, passed: 0 });
      const agg = new Map(); const cell = new Map(); // deptId → 聚合；`topDeptId|programId` → 矩阵格
      const bump = (map, key, k, n = 1) => { const a = map.get(key) || zero(); a[k] += n; map.set(key, a); };
      for (const u of users) {
        const dept = u.department || "Unassigned";
        byDept[dept] = byDept[dept] || { headcount: 0, done: 0, overdue: 0 };
        byDept[dept].headcount++;
        const asg = asgOf.get(u.id);
        const sts = programs.map((p) => statusOf(u, p, asg)).filter(Boolean);
        if (sts.length && sts.every((s) => s === "done")) byDept[dept].done++;
        if (sts.includes("overdue")) byDept[dept].overdue++;
        const did = userDeptId(u) || "__none"; const top = did === "__none" ? "__none" : topOf(did);
        bump(agg, did, "headcount");
        let anyOver = false;
        for (const p of programs) {
          const st = statusOf(u, p, asg);
          if (!st) continue;
          bump(agg, did, "assigned"); bump(cell, top + "|" + p.id, "assigned");
          if (st === "done") { bump(agg, did, "done"); bump(cell, top + "|" + p.id, "done"); }
          if (st === "overdue") { bump(agg, did, "overdue"); bump(cell, top + "|" + p.id, "overdue"); anyOver = true; }
        }
        if (anyOver) bump(agg, did, "overduePeople");
      }
      for (const a of attempts) { const u = store.getUserById(a.userId); const did = u ? (userDeptId(u) || "__none") : "__none"; bump(agg, did, "attempts"); if (a.passed) bump(agg, did, "passed"); }
      // parentId：上级在范围内且不是集团层才填（第二批 3.1：集团层不算祖先，一级部门 = 集团层之下的第一层）
      const deptTree = depts.map((d) => ({ id: d.id, name: d.name, parentId: parentOf(d), ...(agg.get(d.id) || zero()) }));
      if (agg.has("__none")) deptTree.push({ id: "__none", name: null, parentId: null, ...agg.get("__none") });
      const matrix = [...cell.entries()].map(([k, v]) => { const [deptId, programId] = k.split("|"); return { deptId, programId, assigned: v.assigned, done: v.done, overdue: v.overdue }; });
      // 近 12 周（周一起算）：指派数（assignedAt）、考试提交数与通过数（submittedAt）
      // 周 = 本地周一（第三批：原来 toISOString 在 UTC+8 下标成前一天周日）；completed = 完成日期在该周的指派
      const wk = TS.weekBuckets(ovb.today);
      const weeks = wk.weeks.map((w) => ({ week: w, assigned: 0, completed: 0, submitted: 0, passed: 0 }));
      const weekIdx = (iso) => wk.idxOf(TS.dayOf(iso));
      for (const u of users) { const asg = asgOf.get(u.id); for (const p of programs) { const a = asg[p.id]; if (!a) continue; const i = weekIdx(a.assignedAt); if (i >= 0) weeks[i].assigned++; const c = ovb.cellOf(u, p, a); if (c.done && c.doneDay !== "0000-00-00") { const j = wk.idxOf(c.doneDay); if (j >= 0) weeks[j].completed++; } } }
      for (const a of attempts) { const i = weekIdx(a.submittedAt); if (i >= 0) { weeks[i].submitted++; if (a.passed) weeks[i].passed++; } }
      const recent = attempts.slice(0, 6).map((a) => {
        const u = store.getUserById(a.userId);
        const p = getProgram(a.programId);
        // program_zh too, or the Chinese console shows the English course name
        // (the client localizes with loc(row, 'program')).
        return { name: u ? u.name : "?", employeeId: u ? u.employeeId : "?", program: p ? p.title : a.programId, program_zh: p ? (p.title_zh || null) : null, submittedAt: a.submittedAt, percent: a.percent, passed: a.passed };
      });
      return send(res, 200, {
        employees: users.length, perProgram, byDept, recent,
        deptTree, matrix, trend: weeks,
        filters: { dept: deptSet ? qDept : null, programs: qProgs, from, to, cohort },
      });
    }

    // --- content management (courses & programs, edited by HR in the console) ---
    if (pathname === "/api/admin/content" && req.method === "GET") {
      // usedInProjects: derived, read-only (course library 「培养项目：…」/「独立课程」 tag).
      // A copy per course — the cached COURSES objects are never decorated.
      const projIdx = courseProjectsIndex();
      // 第三批 5.7：小节附件带课件内视频的计数 media { total, ready, pending, transcoding, failed, external, skipped }（没有视频时不带）
      const mediaByAtt = new Map();
      for (const r of store.listAttachmentMedia({})) { if (!mediaByAtt.has(r.attachmentId)) mediaByAtt.set(r.attachmentId, []); mediaByAtt.get(r.attachmentId).push(r); }
      const withMedia = (c) => (!mediaByAtt.size ? c : {
        ...c,
        modules: (c.modules || []).map((m) => ({ ...m, sections: (m.sections || []).map((s) => ({ ...s,
          attachments: (Array.isArray(s.attachments) ? s.attachments : []).map((a) => (a && mediaByAtt.has(a.id) ? { ...a, media: mediaSummary(mediaByAtt.get(a.id)) } : a)) })) })),
      });
      // 第四批 7：每门课 public（缺省 false）与 selfCount（数据范围内的自主学习人数，按包装程序的 source='self' 行计）
      const selfByProg = new Map();
      { const sc = scopePredicate(user); const uById = new Map();
        for (const r of store.listAllAssignments()) {
          if (r.source !== "self") continue;
          if (sc) { if (!uById.has(r.userId)) uById.set(r.userId, store.getUserById(r.userId)); const u = uById.get(r.userId); if (!u || !sc(u)) continue; }
          selfByProg.set(r.programId, (selfByProg.get(r.programId) || 0) + 1);
        } }
      return send(res, 200, {
        programs: PROGRAMS,
        courses: COURSES.map((c) => { const w = courseWrapperOf(c.id); return { ...withMedia(c), updatedAt: store.contentUpdatedAt("course", c.id), usedInProjects: projIdx.get(c.id) || [], public: c.public === true, selfCount: w ? selfByProg.get(w.id) || 0 : 0 }; }),
      });
    }
    const progPut = pathname.match(/^\/api\/admin\/content\/programs\/([\w-]+)$/);
    if (progPut && req.method === "PUT") {
      const p = body;
      if (!p || p.id !== progPut[1] || !p.title || !Array.isArray(p.courseIds))
        return send(res, 400, { error: "Invalid program" });
      p.passingScore = Math.min(100, Math.max(1, Number(p.passingScore) || 80));
      p.examMcqCount = Math.min(50, Math.max(1, Number(p.examMcqCount) || 8));
      p.examOpenCount = Math.min(10, Math.max(0, Number(p.examOpenCount) ?? 1));
      p.examTimeLimitMinutes = p.examTimeLimitMinutes ? Math.min(240, Math.max(1, Number(p.examTimeLimitMinutes))) : null;
      p.defaultDueDays = Math.min(365, Math.max(1, Number(p.defaultDueDays) || 30));
      p.maxAttempts = Math.min(20, Math.max(0, Number(p.maxAttempts) || 0));
      p.retakeCooldownHours = Math.min(720, Math.max(0, Number(p.retakeCooldownHours) || 0));
      p.showAnswersAfterExam = p.showAnswersAfterExam !== false;
      store.putContent("program", p.id, p);
      store.snapshotContent("program", p.id, p, user.id);
      audit("program.update", p.id, null, { title: p.title });
      refreshContent();
      return send(res, 200, { ok: true });
    }
    // 课程库批量发布 / 下线 / 改分类（2026-10-07 批量操作第二批 B5）。{ op: "publish"|"archive"|"category", ids, category? }
    // 每门课只改这一个字段（不重跑单条 PUT 的整份校验，旧文档未必过得了今天的校验 —— 同 B4 先例），写版本快照，
    // 同步包装程序；审计 course.update 与单条逐字相同；不发通知（与单条相同）。课程是内容对象，不受数据范围约束。
    // 发布时为引用这门课的培养项目在训学员补指派（与单条一样），与发布在同一事务里。线上课程 0 个模块又没有考试的
    // 不发布（逐条跳过 empty_course，负责人 2026-10-07：发布后补指派的人永远完成不了，会天天收逾期提醒）。
    // 第三批（2026-10-08，4.4 数据前置）：另有 op "hours"（{ hours: 数字 | null }，只改课程学时，null = 清除）与
    // op "programCategory"（给不是包装程序的旧版课程包改类别，如 nho；ids 是程序 id，审计 program.update）。
    // scripts/apply-course-metadata.js 用这两个与 "category"，不走整份文档的 PUT（避免顺带改动别的字段与补指派）。
    if (pathname === "/api/admin/content/bulk-update" && req.method === "POST") {
      const op = body.op;
      if (!["publish", "archive", "category", "hours", "programCategory", "public"].includes(op)) return send(res, 400, { error: "Unknown operation.", error_zh: "未知操作。", code: "bad_op" });
      // 第四批 7：op "public"（{ value: true | false }）= 批量设为公开 / 取消公开，副作用与单条 PUT 相同（同一事务内逐门执行，通知在提交后发）
      if (op === "public" && typeof body.value !== "boolean") return send(res, 400, { error: "Choose make public or make not public.", error_zh: "请选择设为公开或取消公开。", code: "bad_value" });
      let cat = null, hrs = null;
      if (op === "category" || op === "programCategory") {
        if (body.category != null && typeof body.category !== "string") return send(res, 400, { error: "Category must be text.", error_zh: "分类须为文字。", code: "bad_category" });
        cat = String(body.category || "").trim() || null;            // 空 = 清空所选课程的分类
        if (cat && cat.length > 60) return send(res, 400, { error: "Category is limited to 60 characters.", error_zh: "分类不超过 60 个字。", code: "bad_category" });
        cat = CAT.normalizeCategory(cat);
      }
      if (op === "hours") {
        if (body.hours !== null && body.hours !== undefined && body.hours !== "") {
          const h = Number(body.hours);
          if (!Number.isFinite(h) || h < 0 || h > 999) return send(res, 400, { error: "Learning hours must be a number from 0 to 999.", error_zh: "学时须为 0–999 之间的数字。", code: "bad_hours" });
          hrs = Math.round(h * 10) / 10;
        }
      }
      if (op === "programCategory") {
        const pids = bulkIdList(res, body.ids); if (!pids) return;
        const batchP = runBatch((cur) => {
          const results = [], effects = [];
          for (let i = 0; i < pids.length; i++) {
            cur.line = i + 1;
            const p = getProgram(pids[i]);
            if (!p) { results.push(bulkSkip(pids[i], "not_found")); continue; }
            if (programCourseId(p)) { results.push(bulkSkip(p.id, "is_course_wrapper")); continue; }   // 包装程序随课程改（op category）
            if ((p.category || null) === cat) { results.push(bulkUnchanged(p.id)); continue; }
            const next = { ...p, category: cat };
            store.putContent("program", p.id, next);
            store.snapshotContent("program", p.id, next, user.id);
            effects.push({ id: p.id, title: p.title });
            results.push({ id: p.id, ok: true });
          }
          refreshContent();
          return { results, effects };
        });
        if (!batchP.ok) { refreshContent(); return sendBatchFailed(res, "content/bulk-update", batchP, { selection: true, noun: "item", split: true }); }
        emitBulkEffects("content/bulk-update", batchP.value.effects, (e) => audit("program.update", e.id, null, { title: e.title }));
        return sendBulkResult(res, batchP.value.results, {});
      }
      const ids = bulkIdList(res, body.ids); if (!ids) return;
      const target = op === "publish" ? "published" : op === "archive" ? "archived" : null;
      const byId = new Map(COURSES.map((c) => [c.id, c]));
      const batch = runBatch((cur) => {
        const results = [], effects = [], published = [];
        for (let i = 0; i < ids.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const c = byId.get(ids[i]);
          if (!c) { results.push(bulkSkip(ids[i], "not_found")); continue; }
          const w = courseWrapperOf(c.id);
          if (op === "public") {
            const val = body.value === true;
            if ((c.public === true) === val && (!w || (w.public === true) === val)) { results.push(bulkUnchanged(c.id)); continue; }
            const pf = PUBC.applyPublicFlag(c, val, new Date().toISOString());
            const next = { ...c, public: pf.public };
            if (pf.publicSince) next.publicSince = pf.publicSince;
            if (pf.publicClosedAt) next.publicClosedAt = pf.publicClosedAt;
            store.putContent("course", c.id, next);
            store.snapshotContent("course", c.id, next, user.id);
            const nw = mirrorCourseWrapper(next, { public: pf.public });
            const eff = { id: c.id, title: next.title, modules: (next.modules || []).length, course: next, programId: nw.id, pub: null };
            if (pf.changed === "open") { const r = publicOpenApply(user, nw); eff.pub = { op: "open", pendingClosed: r.pendingClosed, notifyUserIds: r.notifyUserIds }; }
            else if (pf.changed === "close") { const r = publicCloseApply(nw); eff.pub = { op: "close", removed: r.removed, kept: r.kept, policy: r.policy }; }
            effects.push(eff);
            results.push({ id: c.id, ok: true });
            continue;
          }
          if (op === "hours") {
            // 学时只在课程上（包装程序不镜像）；null = 清除
            if ((typeof c.hours === "number" ? c.hours : null) === hrs) { results.push(bulkUnchanged(c.id)); continue; }
            const next = { ...c };
            if (hrs == null) delete next.hours; else next.hours = hrs;
            store.putContent("course", c.id, next);
            store.snapshotContent("course", c.id, next, user.id);
            effects.push({ id: c.id, title: next.title, modules: (next.modules || []).length });
            results.push({ id: c.id, ok: true });
            continue;
          }
          const field = target ? "status" : "category", val = target || cat;
          const same = target ? c.status === val && (!w || w.status === val)
            : (c.category || null) === val && (!w || (w.category || null) === val);
          if (same) { results.push(bulkUnchanged(c.id)); continue; }
          if (target === "published" && (c.mode || "online") !== "offline" && !(c.modules || []).length && !(w && programHasExam(w.id))) {
            results.push(bulkSkip(c.id, "empty_course"));
            continue;
          }
          const next = { ...c, [field]: val };                     // 只改这一个字段
          store.putContent("course", c.id, next);
          store.snapshotContent("course", c.id, next, user.id);
          mirrorCourseWrapper(next, { [field]: val });
          effects.push({ id: c.id, title: next.title, modules: (next.modules || []).length });
          if (target === "published") published.push(c.id);
          results.push({ id: c.id, ok: true });
        }
        refreshContent();                                          // 同一连接读得到本事务未提交的写入，补指派按新状态派课
        let synced = 0;
        for (const cid of published) synced += tpSyncCourseAssignments(cid);
        return { results, effects, synced };
      });
      if (!batch.ok) { refreshContent(); return sendBatchFailed(res, "content/bulk-update", batch, { selection: true, noun: "item", split: true }); }
      emitBulkEffects("content/bulk-update", batch.value.effects, (e) => {
        audit("course.update", e.id, null, { title: e.title, modules: e.modules });
        if (e.pub && e.pub.op === "open") { audit("course.public.open", e.id, null, { programId: e.programId, pendingClosed: e.pub.pendingClosed }); publicOpenNotify(e.course, e.pub.notifyUserIds); }
        else if (e.pub && e.pub.op === "close") audit("course.public.close", e.id, null, { programId: e.programId, removed: e.pub.removed, kept: e.pub.kept, policy: e.pub.policy });
      });
      // syncedMembers = 补指派时同步过的在训学员人次（其中已有指派的人不重复派课）
      return sendBulkResult(res, batch.value.results, { syncedMembers: batch.value.synced });
    }
    // CX-032（2026-10-09 验收，负责人拍板仍在范围）：课程包导出 —— 课程文档 + 附件清单打成 JSON（modules/learning/course-package.js）；
    // 附件文件本身不在包里。前端拿到 JSON 后存成 <课程名>.course.json。
    const courseExport = pathname.match(/^\/api\/admin\/content\/courses\/([\w-]+)\/export$/);
    if (courseExport && req.method === "GET") {
      const c = getCourse(courseExport[1]);
      if (!c) return send(res, 404, { error: "Course not found", error_zh: "未找到该课程。", code: "not_found" });
      const atts = [];
      for (const m of c.modules || []) for (const s of m.sections || []) for (const x of s.attachments || []) { const a = store.getAttachment(x.id); if (a) atts.push(a); }
      audit("course.export", c.id, null, { title: c.title || c.title_zh, modules: (c.modules || []).length });
      return send(res, 200, CPKG.packCourse(c, atts, new Date().toISOString()));
    }
    // 课程包导入：校验 → 按新 id 组装课程文档 → 与 PUT 同一条保存逻辑（saveCourseDoc：字段清洗、包装程序、审计 course.create）。
    // 坏文件 400 bad_package，不写库。响应另给 id 与去掉的附件数。
    const saveCourseDoc = (c, courseId, imported) => {
      // Courses are standalone now: programId is optional legacy context — when
      // present it must exist, but a course may belong to no package at all.
      // CX-036（2026-10-09 验收，D-5）：英文留空不再由前端复制中文；课程 / 模块 / 小节标题中英至少一个，显示层按语言回退。
      if (!c || c.id !== courseId || !Array.isArray(c.modules) || (c.programId && !getProgram(c.programId)))
        return [400, { error: "Invalid course" }];
      // Derived by GET /api/admin/content; a client that echoes the GET object back
      // must not persist it into the course document.
      delete c.usedInProjects;
      delete c.selfCount;   // 第四批 7：同为 GET 派生字段
      for (const m of c.modules) {
        m.title = clampText(m.title, 120);
        m.title_zh = clampText(m.title_zh, 120) || null;
        if (!m.id || !(m.title || m.title_zh) || !Array.isArray(m.sections)) return [400, { error: "Invalid module in course", error_zh: "模块名称（中文或英文）必填。", code: "module_title_required" }];
        m.minutes = Math.min(600, Math.max(1, Number(m.minutes) || 10));
        for (const [si, s] of m.sections.entries()) {
          // HR-authored HTML is sanitized server-side; embeds must be http(s);
          // section attachments must exist and belong to THIS course.
          s.heading = clampText(s.heading, 200);
          s.heading_zh = clampText(s.heading_zh, 200) || null;
          s.html = sanitizeHtml(s.html);
          s.html_zh = s.html_zh ? sanitizeHtml(s.html_zh) : null;
          // CX-079（10/11 上线前测试）：video 是本系统上传的视频（上传接口返回 /videos/<文件名>），员工端用 <video src> 直接播放 ——
          // 只接受这个形式；外部地址走 videoEmbed（来源白名单）。
          if (s.video !== undefined && s.video !== null && s.video !== "") {
            if (typeof s.video !== "string" || !/^\/videos\/[^/\\?#]+$/.test(s.video) || s.video.includes("..")) {
              const at = `${m.title || m.title_zh || m.id} / ${si + 1}`, atZh = `${m.title_zh || m.title || m.id} / ${si + 1}`;
              return [400, { error: `Section ${at}: the video must be a file uploaded to this system. Not saved.`, error_zh: `小节「${atZh}」的视频必须是本系统上传的视频文件，未保存。`, code: "bad_video_file" }];
            }
          }
          // CX-033 / 034 / 035（2026-10-09 验收）：外链视频按来源白名单校验（缺省 YouTube / Vimeo / bilibili + config.json videoEmbedHosts），
          // 不再静默丢弃：不接受的地址 400 bad_video_url 指明模块 / 小节；视频文件直链（mp4 / webm / m3u8）记 videoKind = "file"，员工端用带水印播放器。
          if (s.videoEmbed) {
            const vu = VURL.classifyVideoUrl(s.videoEmbed, (readConfig() || {}).videoEmbedHosts);
            if (!vu.kind) {
              const where = `${m.title || m.title_zh || m.id} / ${si + 1}`;
              const whereZh = `${m.title_zh || m.title || m.id} / ${si + 1}`;   // CX-075：中文提示用中文模块名
              return [400, vu.reason === "not_http"
                ? { error: `Section ${where}: the video link must start with http(s)://. Not saved.`, error_zh: `小节「${whereZh}」的视频链接必须以 http(s):// 开头，未保存。`, code: "bad_video_url", url: vu.url }
                : { error: `Section ${where}: "${vu.host}" is not an allowed video source. Use a YouTube / Vimeo / bilibili page, a direct video file (mp4 / webm / m3u8), or upload the video. Not saved.`, error_zh: `小节「${whereZh}」的视频来源「${vu.host}」不在允许范围：请用 YouTube / Vimeo / bilibili 页面、视频文件直链（mp4 / webm / m3u8），或直接上传视频。未保存。`, code: "bad_video_url", url: vu.url, host: vu.host }];
            }
            s.videoEmbed = vu.url;
            s.videoKind = vu.kind;
          } else { s.videoEmbed = null; s.videoKind = null; }
          s.attachments = (Array.isArray(s.attachments) ? s.attachments : [])
            .filter((x) => x && typeof x.id === "string")
            .map((x) => {
              const a = store.getAttachment(x.id);
              return a && a.courseId === c.id
                ? { id: a.id, kind: a.kind, name: a.originalName, size: a.size }
                : null;
            })
            .filter(Boolean);
        }
      }
      // Course-level presentation & enrollment fields (packages are invisible
      // now — these live on the course and are mirrored onto its wrapper).
      // Titles/descriptions are capped so long pastes can't wreck the course
      // list, learner cards or CSV exports.
      c.title = clampText(c.title, 120);
      c.title_zh = c.title_zh ? clampText(c.title_zh, 120) : null;
      c.description = c.description ? clampText(c.description, 1000) : null;
      c.description_zh = c.description_zh ? clampText(c.description_zh, 1000) : null;
      if (!c.title && !c.title_zh) return [400, { error: "Invalid course", error_zh: "课程名称（中文或英文）必填。", code: "title_required" }];
      // 第三批 1.1：类别按目录规范化（英文名 / 旧预设 → 中文键；目录外的值原样，≤60 字）
      c.category = CAT.normalizeCategory(c.category);
      // 第三批 1.2：学时 hours（小时，0–999，保留 1 位小数）。请求里没有这个键 = 保留原值（课程编辑器旧版本不回传它，
      // 不能因此把从 Lark 回填的学时清掉）；显式 null / "" = 清除（线上课程回到按模块时长计）；非数字或越界 → 400。
      if (!Object.prototype.hasOwnProperty.call(c, "hours")) {
        const prevC = getCourse(c.id);
        if (prevC && typeof prevC.hours === "number") c.hours = prevC.hours; else delete c.hours;
      } else if (c.hours === null || c.hours === "") delete c.hours;
      else {
        const h = Number(c.hours);
        if (!Number.isFinite(h) || h < 0 || h > 999) return [400, { error: "Learning hours must be a number from 0 to 999.", error_zh: "学时须为 0–999 之间的数字。", code: "bad_hours" }];
        c.hours = Math.round(h * 10) / 10;
      }
      c.enrollType = c.enrollType === "elective" ? "elective" : "mandatory";
      c.status = ["draft", "published", "archived"].includes(c.status) ? c.status : "draft";
      c.defaultDueDays = Math.min(365, Math.max(1, Number(c.defaultDueDays) || 30));
      c.mode = c.mode === "offline" ? "offline" : "online";
      c.location = c.mode === "offline" ? (String(c.location || "").trim() || null) : null;
      c.sessionAt = c.mode === "offline" && c.sessionAt ? String(c.sessionAt).slice(0, 16) : null;
      c.sessionNote = c.mode === "offline" ? (String(c.sessionNote || "").trim().slice(0, 500) || null) : null;
      // 讲师 for an in-person course: the person who delivers it. Gives them the
      // "my sessions" workbench (roll-call) without any admin rights.
      const cTrainer = String(c.trainerId || "").trim();
      c.trainerId = c.mode === "offline" && cTrainer && store.getUserById(cTrainer) ? cTrainer : null;
      const isNew = !getCourse(c.id);
      // CX-042（2026-10-09 验收）：乐观锁 —— 客户端带回它读到 / 上次保存得到的 updatedAt，与库里不一致说明别人已改过，409 stale，不覆盖
      const sentRev = typeof c.updatedAt === "string" ? c.updatedAt : null;
      delete c.updatedAt;
      if (!isNew && sentRev) {
        const curRev = store.contentUpdatedAt("course", c.id);
        if (curRev && curRev !== sentRev) return [409, { error: "This course was changed by someone else after you opened it. Reload the page and apply your change again.", error_zh: "这门课程在你打开后已被其他人修改，请刷新页面后重新修改。", code: "stale", updatedAt: curRev }];
      }
      // Adding modules to a live course silently pushes everyone who had
      // finished it back below 100%. Detect that and tell them, instead of
      // letting the completion figure quietly drop.
      const prev = getCourse(c.id);
      const newModuleIds = prev
        ? c.modules.map((m) => m.id).filter((id) => !prev.modules.some((pm) => pm.id === id))
        : [];
      // 第四批 7：公开课程。键缺省 = 保留原值（旧编辑器不回传）；变化时记 publicSince / publicClosedAt，并在下面执行副作用
      const pubF = PUBC.applyPublicFlag(prev, Object.prototype.hasOwnProperty.call(c, "public") ? c.public : undefined, new Date().toISOString());
      c.public = pubF.public;
      if (pubF.publicSince) c.publicSince = pubF.publicSince; else delete c.publicSince;
      if (pubF.publicClosedAt) c.publicClosedAt = pubF.publicClosedAt; else delete c.publicClosedAt;
      store.putContent("course", c.id, c);
      store.snapshotContent("course", c.id, c, user.id);
      audit(isNew ? "course.create" : "course.update", c.id, null, { title: c.title, modules: c.modules.length });
      if (isNew && c.programId) {
        // Creating "inside" a package links it there; standalone courses skip this.
        const p = getProgram(c.programId);
        if (p && !p.courseIds.includes(c.id)) {
          p.courseIds.push(c.id);
          store.putContent("program", p.id, p);
        }
      }
      // Invisible 1:1 wrapper: assignments / electives / exams / records all key
      // on programs, so every course keeps a wrapper program that mirrors its
      // display fields. The UI never shows it — people only ever see the course.
      // Only a program that contains EXACTLY this one course counts as its
      // wrapper; legacy multi-course packages are never touched (hijacking one
      // would rewrite the package's own title/status).
      // （与课程库批量操作共用 mirrorCourseWrapper，2026-10-07）
      const pubW = mirrorCourseWrapper(c);
      refreshContent();
      // 第四批 7 / 9.2：设为公开 → 关闭待审批的选修申请（申请人改为自主学习并通知）；取消公开 → 按 PUBLIC_CLOSE_POLICY 处理自主学习的人
      let publicChange = null;
      if (pubF.changed === "open") {
        const r = publicOpenApply(user, pubW);
        audit("course.public.open", c.id, null, { programId: pubW.id, pendingClosed: r.pendingClosed });
        publicOpenNotify(c, r.notifyUserIds);
        publicChange = { op: "open", pendingClosed: r.pendingClosed };
      } else if (pubF.changed === "close") {
        const r = publicCloseApply(pubW);
        audit("course.public.close", c.id, null, { programId: pubW.id, removed: r.removed, kept: r.kept, policy: r.policy });
        publicChange = { op: "close", removed: r.removed, kept: r.kept, policy: r.policy };
      }
      // Publishing (or fixing) a course must reach anyone already enrolled in a
      // project that references it.
      const synced = c.status === "published" ? tpSyncCourseAssignments(c.id) : 0;
      // Notify the people whose "completed" just became "incomplete".
      let notified = 0;
      if (newModuleIds.length) {
        const pids = programsContaining(c.id, c);
        for (const u of store.listUsers()) {
          // 只排除纯系统账号（与提醒、看板同一口径，负责人 2026-10-07）；同时是员工的管理员也会收到「新增模块待学」通知
          if (LC.isServiceAccount(u) || u.active === 0) continue;
          const asg = store.getUserAssignments(u.id);
          if (!pids.some((pid) => asg[pid])) continue;
          const done = userProgress(u.id, c.id);
          const finishedBefore = prev.modules.length > 0 && prev.modules.every((m) => done[m.id]);
          if (!finishedBefore) continue;
          notify(u.id, {
            type: "course.updated",
            title: `"${c.title || c.title_zh}" was updated — ${newModuleIds.length} new module(s) to complete`,
            title_zh: `《${c.title_zh || c.title}》已更新，新增 ${newModuleIds.length} 个模块待完成`,
            body: "Your progress reflects the new content. Please finish the added modules.",
            body_zh: "进度已按新内容重新计算，请完成新增模块。",
            link: `#/course/${c.id}`,
          });
          notified++;
        }
      }
      if (imported) return [200, { ok: true, id: c.id, title: c.title, title_zh: c.title_zh, modules: c.modules.length, attachmentsDropped: imported.attachmentsDropped }];
      return [200, { ok: true, syncedMembers: synced, notifiedOfUpdate: notified, publicChange, updatedAt: store.contentUpdatedAt("course", c.id) }];
    };
    if (pathname === "/api/admin/content/courses/import" && req.method === "POST") {
      const newId = "course-" + newToken().slice(0, 10);
      const r = CPKG.unpackCourse(body && body.package, { newId, moduleId: (i) => `m-${newToken().slice(0, 8)}-${i + 1}`, title: body ? body.title : undefined, title_zh: body ? body.title_zh : undefined });
      if (!r.ok) return send(res, 400, { error: r.error, error_zh: r.error_zh, code: r.code });
      const [st, out] = saveCourseDoc(r.course, newId, { attachmentsDropped: r.attachmentsDropped });
      return send(res, st, out);
    }
    const coursePut = pathname.match(/^\/api\/admin\/content\/courses\/([\w-]+)$/);
    if (coursePut && req.method === "PUT") {
      const [st, out] = saveCourseDoc(body, coursePut[1], null);
      return send(res, st, out);
    }
    if (coursePut && req.method === "DELETE") {
      const c = getCourse(coursePut[1]);
      if (!c) return send(res, 404, { error: "Course not found" });
      // Deleting a course that is still referenced used to cascade into silent
      // damage: project phases stuck forever on invisible activities, learning
      // records gone, orphaned exams. Refuse and hand back the impact list so
      // HR can archive instead.
      const usage = courseUsage(c.id);
      if (usage.blocking && body.force !== true) {
        return send(res, 409, {
          error: "This course is still in use — archive it instead of deleting.",
          code: "in_use",
          usage,
        });
      }
      store.snapshotContent("course", c.id, c, user.id); // last snapshot before delete
      audit("course.delete", c.id, { title: c.title, title_zh: c.title_zh || null, modules: c.modules.length }, { usage });
      store.deleteContent("course", c.id);
      for (const p of PROGRAMS) {
        if (p.courseIds.includes(c.id)) {
          p.courseIds = p.courseIds.filter((x) => x !== c.id);
          // A wrapper that just lost its only course is pure noise — drop it,
          // and archive the exams that hung off it so they don't linger as
          // "published" pointing at nothing.
          if (!p.courseIds.length && p.id.startsWith("pw-")) {
            for (const e of store.listProgramExams(p.id)) {
              if (e.status !== "archived") store.updateExam(e.id, { ...e, status: "archived" });
            }
            store.deleteContent("program", p.id);
          } else store.putContent("program", p.id, p);
        }
      }
      // CX-147：题库里归属这门课的题一并删除（原来残留，题库「关联课程」列显示内部编号）；
      // 仍被未归档的固定题目考试使用的题保留（考试卷面不缺题），计入 keptQuestions。上面已把本课程包装程序的考试归档。
      const inUse = new Set();
      for (const e of store.listExams()) if (e.status !== "archived" && e.mode === "fixed") for (const q of e.questionIds || []) inUse.add(q);
      let deletedQuestions = 0, keptQuestions = 0;
      for (const q of store.listQuestions()) {
        if (q.courseId !== c.id) continue;
        if (inUse.has(q.id)) { keptQuestions++; continue; }
        store.deleteQuestion(q.id); deletedQuestions++;
      }
      if (deletedQuestions || keptQuestions) audit("question.course-deleted", c.id, null, { title: c.title, title_zh: c.title_zh || null, questionsDeleted: deletedQuestions, questionsKept: keptQuestions });   // CX-206：带课程名
      refreshContent();
      return send(res, 200, { ok: true, deletedQuestions, keptQuestions });
    }
    // --- in-person course check-in (admin console) ---
    // Mirrors the project offline-activity check-in: rotating code + live
    // roll-call. Roster = every active employee (not a pure service account) assigned any
    // package containing this course.
    // 第四批 7 / 9.2：取消公开前的影响人数（课程编辑器与批量「取消公开」的确认框用）。learning 读；人数按数据范围计。
    // { courseId, programId, public, policy, selfLearning（自主学习中、未完成）, started（已开始，可继续学完）, notStarted（未开始，将被移出）, done（已完成，记录与学时保留） }
    const pubImpact = pathname.match(/^\/api\/admin\/courses\/([\w-]+)\/public-impact$/);
    if (pubImpact && req.method === "GET") {
      const c = getCourse(pubImpact[1]);
      if (!c) return send(res, 404, { error: "Course not found" });
      const w = courseWrapperOf(c.id);
      const sc = scopePredicate(user);
      const rows = w ? selfRowsOf(w).filter((r) => { if (!sc) return true; const u = store.getUserById(r.userId); return !!u && sc(u); }) : [];
      const plan = PUBC.planPublicClose(rows, PUBC.PUBLIC_CLOSE_POLICY);
      const done = rows.filter((r) => r.done).length;
      return send(res, 200, {
        courseId: c.id, programId: w ? w.id : null, public: c.public === true, policy: PUBC.PUBLIC_CLOSE_POLICY,
        selfLearning: rows.length - done, started: plan.keep.length - done, notStarted: plan.remove.length, done,
      });
    }
    const courseCkAdmin = pathname.match(/^\/api\/admin\/courses\/([\w-]+)\/checkin$/);
    if (courseCkAdmin && req.method === "GET") {
      const c = getCourse(courseCkAdmin[1]);
      if (!c || (c.mode || "online") !== "offline") return send(res, 404, { error: "Course not found" });
      const aid = courseCkId(c.id);
      const pids = programsContaining(c.id, c);
      const states = {};
      for (const st of store.listActivityStates(aid)) states[st.userId] = st;
      // P2 范围（learning）：线下课名单是一串人 → 过滤；stats 由 list 派生 = 重算。
      // 签到码同 tprojects：HMAC 纯派生，不受范围影响。
      const cckScope = scopePredicate(user);
      const list = [];
      for (const u of store.listUsers()) {
        // 只排除纯服务账号（与培训概览、逾期提醒同一人群，2026-10-07）：后台账号同时是员工的也在名单上，HR 能为其登记出勤
        if (LC.isServiceAccount(u) || u.active === 0) continue;
        if (cckScope && !cckScope(u)) continue;
        const asg = store.getUserAssignments(u.id);
        if (!pids.some((pid) => asg[pid])) continue;
        const st = states[u.id];
        list.push({ userId: u.id, name: u.name, employeeId: u.employeeId, department: u.department || null, status: st ? st.status : null, at: st ? st.at : null });
      }
      const slot = checkinSlot();
      return send(res, 200, {
        courseId: c.id, title: c.title, title_zh: c.title_zh,
        sessionAt: c.sessionAt || null, location: c.location || null,
        code: checkinCode(aid, slot),
        secondsLeft: Math.ceil(((slot + 1) * 60000 - Date.now()) / 1000),
        stats: {
          attended: list.filter((x) => x.status === "attended").length,
          late: list.filter((x) => x.status === "late").length,
          excused: list.filter((x) => x.status === "excused").length,
          missing: list.filter((x) => !x.status).length,
        },
        list,
      });
    }
    const courseCkMark = pathname.match(/^\/api\/admin\/courses\/([\w-]+)\/checkin\/mark$/);
    if (courseCkMark && req.method === "POST") {
      const c = getCourse(courseCkMark[1]);
      if (!c) return send(res, 404, { error: "Course not found" });
      const target = store.getUserById(String(body.userId || ""));
      if (!target) return send(res, 404, { error: "User not found" });
      // P2 范围（learning）：标出勤是对这一个学员的写。
      if (!scopeAllowsFor(user, target)) return send(res, 404, { error: "User not found" });
      const status = ["attended", "late", "excused", "absent"].includes(body.status) ? body.status : "attended";
      store.setActivityState({ projectId: "__course__", cohortId: c.id, activityId: courseCkId(c.id), userId: target.id, status, by: user.id });
      audit("course.checkin.mark", c.id, null, { employeeId: target.employeeId, status });
      return send(res, 200, { ok: true });
    }
    // ---- P0 1.4（负责人 2026-10-07）：LibreOffice 列为必装 —— 课件转换组件状态与待转换清单、在线补转存量 Office 课件 ----
    // 两条都在 learning 域（modules/learning/manifest.js order 225 / 226；/api/admin/attachments 前缀在 learning 的关门清单里，
    // 模块关闭时 404）。补转在服务进程里做（同一个库连接，没有第二个写入方），不必停服跑脚本。
    if (pathname === "/api/admin/attachments/office-status" && req.method === "GET") {
      // 安装路径只给培训写权限 / 超级管理员看；?refresh=1 由引擎节流（至少间隔 10 秒才真的重测，审查 M4）
      const ocWrite = canWrite(user, "learning");
      const converter = await OFFICE_CONV.status({ refresh: query.get("refresh") === "1", includePath: ocWrite });
      // 引用位置：遍历内存里的课程（模块 → 小节 → 附件）；空 = 没被任何小节使用
      const refsOf = new Map();
      for (const c of COURSES) (c.modules || []).forEach((m, mi) => (m.sections || []).forEach((s, si) => {
        for (const a of Array.isArray(s.attachments) ? s.attachments : []) {
          if (!a || !a.id) continue;
          if (!refsOf.has(a.id)) refsOf.set(a.id, []);
          refsOf.get(a.id).push({
            courseId: c.id, courseTitle: c.title || "", courseTitle_zh: c.title_zh || "", courseStatus: c.status || null,
            moduleTitle: m.title || "", moduleTitle_zh: m.title_zh || "", sectionTitle: s.title || "", sectionTitle_zh: s.title_zh || "",
            sectionNo: `${mi + 1}.${si + 1}`,
          });
        }
      }));
      const nameOf = new Map();
      const uploaderName = (uid) => {
        if (!uid) return null;
        if (!nameOf.has(uid)) { const u = store.getUserById(uid); nameOf.set(uid, u ? u.name : null); }
        return nameOf.get(uid);
      };
      const pending = OFFICE_CONV.pendingAttachments().map((p) => ({
        id: p.id, originalName: p.originalName, ext: p.ext, size: p.size, createdAt: p.createdAt,
        uploadedBy: p.uploadedBy, uploadedByName: uploaderName(p.uploadedBy),
        fileMissing: p.fileMissing, lastError: p.lastError, converting: !!p.converting,
        refs: refsOf.get(p.id) || [],
      }));
      // 第三批 5.7：视频转码组件状态（路径同样只给写权限）、待处理的课件内视频（除已就绪与外链之外的全部行）、各状态计数、当前任务
      const transcoder = await VIDEO_TC.status({ refresh: query.get("refresh") === "1", includePath: ocWrite });
      const mrows = store.listAttachmentMedia({ statuses: ["pending", "transcoding", "failed", "skipped"] });
      const attCache = new Map();
      const attOf = (aid) => { if (!attCache.has(aid)) attCache.set(aid, store.getAttachment(aid)); return attCache.get(aid); };
      const media = mrows.map((m) => mediaAdminItem(m, attOf(m.attachmentId), (aid) => refsOf.get(aid) || [], ocWrite));
      return send(res, 200, {
        converter, job: OFFICE_CONV.job(), pending,
        counts: { pending: pending.length, missingFiles: pending.filter((p) => p.fileMissing).length, unreferenced: pending.filter((p) => !p.refs.length).length },
        transcoder, media, mediaCounts: store.countAttachmentMediaByStatus(), mediaJob: VIDEO_TC.job(),
      });
    }
    // 第三批 5.7：一份课件的内嵌视频（learning 读；编辑器「课件内视频」列表轮询用）。未知附件 → 404。
    const attMediaAdmin = pathname.match(/^\/api\/admin\/attachments\/([\w-]+)\/media$/);
    if (attMediaAdmin && req.method === "GET") {
      const att = store.getAttachment(attMediaAdmin[1]);
      if (!att) return send(res, 404, { error: "Not found" });
      const rows = store.listAttachmentMedia({ attachmentId: att.id });
      const refs = attachmentRefsIndex();
      const mp = VIDEO_TC.mappingOf(att.id);
      return send(res, 200, {
        attachmentId: att.id, deck: att.originalName, transcoder: { state: VIDEO_TC.state() },
        summary: mediaSummary(rows), mapping: mp ? mp.mapping || null : null, pdfPages: mp ? mp.pdfPages ?? null : null, visibleSlides: mp ? mp.visibleSlides ?? null : null,
        items: rows.map((m) => mediaAdminItem(m, att, (aid) => refs.get(aid) || [], canWrite(user, "learning"))),
      });
    }
    // 第三批 5.7：手动转码 / 重试（learning 写）。{ ids?: string[] }，空 = 全部等待中与失败的。202 { job }。
    if (pathname === "/api/admin/attachments/media-transcode" && req.method === "POST") {
      let ids = null;
      if (body.ids !== undefined && body.ids !== null) {
        if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== "string") || body.ids.length > 5000)
          return send(res, 400, { error: "Choose videos from the list. 请从清单中选择视频。", code: "unknown_media" });
        ids = body.ids.length ? body.ids : null;
      }
      try {
        const job = VIDEO_TC.startJob(ids, { by: { id: user.id, name: user.name }, requestId });
        audit("attachment.media.retry", null, null, { count: job && job.total != null ? job.total : ids ? ids.length : null });
        return send(res, 202, { job });
      } catch (e) {
        const code = e && e.code;
        if (code === "unavailable") return send(res, 409, { error: "The video transcoder (ffmpeg) is not installed on the server, so nothing can be converted yet. Ask IT to install ffmpeg, then check again. 服务器未安装视频转码组件（ffmpeg），暂时无法转码。请 IT 安装后重新检测。", code: "video_transcoder_unavailable" });
        if (code === "running") return send(res, 409, { error: "A video conversion run is already in progress. 已有视频转码任务正在进行。", code: "video_transcode_running", job: VIDEO_TC.job() });
        if (code === "unknown_media") return send(res, 400, { error: "Some of the chosen videos are unknown or can't be converted. 所选视频中有的不存在或无法转码。", code: "unknown_media", ids: (e.ids || []).slice(0, 50) });
        if (code === "nothing_to_transcode") return send(res, 400, { error: "No videos are waiting for conversion. 没有等待转码的视频。", code: "nothing_to_transcode" });
        throw e;
      }
    }
    if (pathname === "/api/admin/attachments/office-convert" && req.method === "POST") {
      // { ids?: string[] }：不传 = 全部待转换。全局只有一个批量任务，与上传各走各的通道（上传优先）。
      let ids = null;
      if (body.ids !== undefined && body.ids !== null) {
        if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== "string" && typeof x !== "number") || body.ids.length > 5000)
          return send(res, 400, { error: "Choose files from the list of files waiting to be converted. 请从待转换清单中选择课件。", code: "unknown_attachment" });
        ids = body.ids.map(String);
      }
      try {
        const job = OFFICE_CONV.startJob(ids, {
          by: { id: user.id, name: user.name }, requestId,
          // 逐条审计，用本次请求的 audit 闭包（操作人 = 发起补转的人）
          onConverted: (att, r) => audit("attachment.convert", att.id, { storageKey: r.fromKey, kind: "doc" }, { storageKey: r.storageKey, kind: "pdf", size: r.size, originalName: att.originalName }),
          onFailed: (att, reason) => audit("attachment.convert.fail", att.id, null, { reason, originalName: att.originalName }),
        });
        return send(res, 202, { job });
      } catch (e) {
        const code = e && e.code;
        if (code === "unavailable") return send(res, 409, {
          error: "The PDF converter (LibreOffice) is not installed on the server, so nothing can be converted yet. Ask IT to install LibreOffice, then check again. 服务器未安装课件转换组件（LibreOffice），暂时无法转换。请 IT 安装后重新检测。",
          code: "office_converter_unavailable",
        });
        if (code === "running") return send(res, 409, { error: "A conversion run is already in progress. 已有转换任务正在进行。", code: "office_convert_running", job: OFFICE_CONV.job() });
        if (code === "unknown_attachment") return send(res, 400, {
          error: "Some of the chosen files are unknown or are not PowerPoint, Word or Excel files. 所选课件中有的不存在，或不是 PPT / Word / Excel 文件。",
          code: "unknown_attachment", ids: (e.ids || []).slice(0, 50),
        });
        if (code === "nothing_to_convert") return send(res, 400, { error: "There are no files waiting to be converted. 没有待转换的课件。", code: "nothing_to_convert" });
        throw e;
      }
    }
    if (pathname === "/api/admin/videos" && req.method === "GET") {
      const dir = path.join(ROOT, "public", "videos");
      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
          .map((f) => ({ name: f, url: "/videos/" + f, size: fs.statSync(path.join(dir, f)).size }));
      } catch {}
      return send(res, 200, files);
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 17014–17212 行（/api/admin/ 块内）
    async adminLearning7(C) {
      const { pathname, user, res, req, body, audit } = C;
      const { store, scopePredicate, getProgram, reviewOverdue, scoreTotals, send, questionItemFromBody, getCourse, runBatch, bulkFaultPoint, QT, sendBatchFailed, afterCommit, bulkIdList, bulkExamPools, bulkSkip, bulkUnchanged, emitBulkEffects, bulkPoolWarnings, sendBulkResult } = S;
    if (pathname === "/api/admin/attempts") {
      const allExams = store.listExams();
      const examTitles = Object.fromEntries(allExams.map((e) => [e.id, e.title]));
      const examById = Object.fromEntries(allExams.map((e) => [e.id, e]));
      const submitted = store.listSubmittedAttempts();
      // One query for every attempt's current appeal, rather than one per row.
      const appeals = store.listAppealsForAttempts(submitted.map((a) => a.id));
      // "第 2 次 / 共 3 次" needs each attempt's position within that person's
      // history for that exam. Built once here — a per-row query would be
      // thousands of lookups. Voided attempts still occupy a number: they
      // happened, and hiding them would make the sequence lie.
      const attemptSeq = new Map();
      for (const a of submitted) {
        if (!a.examId) continue;
        const key = a.userId + "|" + a.examId;
        if (!attemptSeq.has(key)) attemptSeq.set(key, { no: new Map(), total: 0 });
        attemptSeq.get(key).total++;
      }
      for (const [key, grp] of attemptSeq) {
        const [uid, eid] = key.split("|");
        const mine = submitted.filter((a) => a.userId === uid && a.examId === eid)
          .sort((x, y) => (x.startedAt < y.startedAt ? -1 : x.startedAt > y.startedAt ? 1 : 0));
        mine.forEach((a, i) => grp.no.set(a.id, i + 1));
      }
      // P2 范围（learning）：整卷明细（含答题内容 + 姓名/工号）按提交人过滤。同
      // attempts.csv：attemptSeq 用未过滤的全集算，序号才不会因为看的人不同而变。
      const attScope = scopePredicate(user);
      const rows = submitted
        .map((a) => {
          const u = store.getUserById(a.userId);
          if (attScope && !attScope(u)) return null;
          const p = getProgram(a.programId);
          const ap = appeals.get(a.id) || null;
          const ex = a.examId ? examById[a.examId] : null;
          const seq = a.examId ? attemptSeq.get(a.userId + "|" + a.examId) : null;
          return { id: a.id, userId: a.userId, examId: a.examId || null, name: u ? u.name : "?", employeeId: u ? u.employeeId : "?",
            department: u ? u.department || null : null,   // 第二批 3.1：考试成绩页的部门筛选按行过滤（DeptFilter + useDeptTree）
            program: p ? p.title : a.programId, exam: (a.examId && examTitles[a.examId]) || null, startedAt: a.startedAt, submittedAt: a.submittedAt, percent: a.percent, passed: a.passed, gradingStatus: a.gradingStatus || "final", reviewOverdue: reviewOverdue(a), blurCount: a.blurCount || 0, voided: !!a.voided, detail: a.detail,
            // `program`/`exam` are the long-standing keys (CSV export reads them),
            // so the Chinese halves are named to pair with THEM — loc(r,"program")
            // then works directly instead of the page assembling a throwaway object.
            // This row ships for every submitted attempt, so no duplicate namings.
            program_zh: p ? p.title_zh || null : null,
            exam_zh: ex ? ex.title_zh || null : null,
            // Each exam has its own pass line; the page was colouring against a
            // hardcoded 80 and showing no line at all in the review drawer.
            passingScore: ex ? ex.passingScore : null,
            drawCount: ex ? (ex.mcqCount || 0) + (ex.openCount || 0) + (ex.caseCount || 0) : null,
            // 第四批：卷面得分与总分（与员工端 GET /api/me/attempts/:id 同一口径，保留一位小数；旧口径答卷为 null）。
            // 逐题得分 = 题目的 points × credit（新题型）或旧口径（isRight / partial），见 web/src/qtypes/model.js earnedOf
            ...(() => { const t = scoreTotals(a.detail || []); return t.hasPoints ? { earned: Math.round(t.earned * 10) / 10, totalPoints: Math.round(t.max * 10) / 10 } : { earned: null, totalPoints: null }; })(),
            attemptNo: seq ? seq.no.get(a.id) || null : null,
            attemptTotal: seq ? seq.total : null,
            appeal: ap ? { id: ap.id, status: ap.status, reason: ap.reason, createdAt: ap.createdAt, resolution: ap.resolution, resolvedAt: ap.resolvedAt } : null };
        })
        .filter(Boolean)
        .sort((x, y) => (x.submittedAt < y.submittedAt ? 1 : -1));
      return send(res, 200, rows);
    }
    if (pathname === "/api/admin/questions" && req.method === "GET") {
      return send(res, 200, store.listQuestions());
    }
    if (pathname === "/api/admin/questions" && req.method === "POST") {
      const q = body;
      const built = questionItemFromBody(q);
      if (built.error) return send(res, 400, { error: built.error, ...(built.error_zh ? { error_zh: built.error_zh } : {}), ...(built.code ? { code: built.code } : {}) });
      const item = built.item;
      // AI 起草的题目（方案 2.4、4.2 第 6 条）：核对 aiCallId 存在、功能为 questionGen、调用人为同一账号，再写入来源信息
      let aiCall = null;
      if (q.aiCallId != null && q.aiCallId !== "") {
        aiCall = store.getAiCall(q.aiCallId);
        if (!aiCall || aiCall.feature !== "questionGen" || aiCall.actorId !== user.id)
          return send(res, 400, { error: "That AI draft does not belong to this account.", error_zh: "该 AI 草稿不属于当前账号。", code: "bad_ai_call" });
        item.origin = { kind: "ai", providerId: aiCall.providerId, protocol: aiCall.protocol, model: aiCall.modelRequested, modelReturned: aiCall.modelReturned, promptVersion: aiCall.promptVersion, generatedAt: aiCall.createdAt, callId: aiCall.id, adoptedBy: user.id, adoptedAt: new Date().toISOString() };
      }
      const id = store.addQuestion(item);
      audit("question.create", id, null, { courseId: item.courseId, type: item.type });
      if (aiCall) audit("question.ai.adopt", id, null, { callId: aiCall.id, model: aiCall.modelReturned || aiCall.modelRequested || null });
      return send(res, 200, { ok: true, id });
    }
    // Bulk import from a spreadsheet — same validation as the single POST,
    // per-row results so a bad row never blocks the rest.
    if (pathname === "/api/admin/questions/bulk" && req.method === "POST") {
      const courseId = String(body.courseId || "");
      if (!getCourse(courseId)) return send(res, 400, { error: "Unknown course" });
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return send(res, 400, { error: "No questions to import." });
      // Cap like bulk-update, but on its own knob: LMS_QUESTIONS_BULK_CAP (default
      // 200, matching the page's "up to 200 per batch" hint). This used to
      // slice(0, 200) and silently drop the rest; now over the cap → whole batch
      // rejected before any question is written.
      const qCapRaw = Math.floor(Number(process.env.LMS_QUESTIONS_BULK_CAP));
      const qCap = Number.isFinite(qCapRaw) && qCapRaw > 0 ? qCapRaw : 200;
      if (items.length > qCap)
        return send(res, 400, {
          error: `Pasted ${items.length} questions, but one import is capped at ${qCap} — import in smaller batches. `
            + `本次粘贴 ${items.length} 题，单次上限 ${qCap} 题：请分批导入。`,
          code: "over_cap", selected: items.length, cap: qCap,
        });
      // 原子性：整批一个事务（runBatch）。逐题校验问题照旧 ok:false；任何一题抛异常 →
      // 整批回滚、回 batch_failed + 题号（line，从 1 起）。
      const batch = runBatch((cur) => {
        const results = [];
        for (let qi = 0; qi < items.length; qi++) {
          cur.line = qi + 1;
          bulkFaultPoint(cur.line);
          const q = items[qi];
          const stem = String((q && q.question) || "").trim().slice(0, 40);
          // 第四批 6.1：逐行校验走注册表（QT.itemFromBody，ctx.bulk）—— 旧四种题型的原因文字与条目逐字照旧
          // （简答 maxPoints 夹到 1–100、moduleId 为空、题干去首尾空白）；新题型（含情境案例整组）同一入口。另带 reason_zh 与 code。
          const built = QT.itemFromBody(q, { bulk: true, courseId });
          if (built.error) { results.push({ ok: false, question: stem, reason: built.error, ...(built.error_zh ? { reason_zh: built.error_zh } : {}), ...(built.code ? { code: built.code } : {}) }); continue; }
          const id = store.addQuestion(built.item);
          results.push({ ok: true, id });
        }
        return results;
      });
      if (!batch.ok) return sendBatchFailed(res, "questions/bulk", batch);
      const results = batch.value;
      afterCommit("questions/bulk", () => audit("question.bulk-import", courseId, null, {
        created: results.filter((r) => r.ok).length,
        skipped: results.filter((r) => !r.ok).length,
      }));
      return send(res, 200, { results });
    }
    // 题库批量改分值、批量改所属课程与模块（2026-10-06 B4）。原地修改、题目 id 不变：只改 points 一列，或只改
    // courseId / moduleId 两列（store.updateQuestionPoints / updateQuestionPlacement），其余列一字不动（不经 questionItemFromBody：
    // 旧题可能过不了今天的校验，整行重写还会丢掉题型不用的列）。题库是内容对象，不受数据范围约束（同单题修改）。
    // 改课程的语义同单题修改：换课程且没选模块 → 模块清空；同课程且没选模块 → 各题保留自己的模块；选了模块 → 统一设为该模块。
    // 固定题目考试按 id 引用题目，但保存考试时只保留关联课程里的题：被某场固定题目考试使用、且新课程不在该考试关联课程里的题
    // 逐条跳过（in_fixed_exam，附考试清单），否则下次保存这场考试会悄悄丢题。随机抽题考试的题量因此低于抽题数的列在 warnings（不拦）。
    if (pathname === "/api/admin/questions/bulk-update" && req.method === "POST") {
      const op = body.op;
      if (!["points", "course"].includes(op)) return send(res, 400, { error: "Unknown operation.", error_zh: "未知操作。", code: "bad_op" });
      let points = null, course = null, moduleId = null;
      if (op === "points") {
        if (body.points !== null) {   // null = 恢复为按考试的题型默认分值
          const n = typeof body.points === "number" || (typeof body.points === "string" && body.points.trim()) ? Number(body.points) : NaN;
          if (!Number.isInteger(n) || n < 1 || n > 100)
            return send(res, 400, { error: "Points must be a whole number from 1 to 100 (or null to use the exam default).", error_zh: "分值须为 1–100 的整数（或恢复为按考试默认分值）。", code: "bad_points" });
          points = n;
        }
      } else {
        course = getCourse(String(body.courseId || ""));
        if (!course) return send(res, 400, { error: "Unknown course.", error_zh: "课程不存在。", code: "bad_course" });
        if (body.moduleId != null && body.moduleId !== "") {
          moduleId = String(body.moduleId);
          if (!(course.modules || []).some((m) => m.id === moduleId))
            return send(res, 400, { error: "That module is not in the chosen course.", error_zh: "所选模块不属于该课程。", code: "bad_module" });
        }
      }
      const ids = bulkIdList(res, body.ids);
      if (!ids) return;
      // 改课程：哪些固定题目考试引用了哪些题、各考试的关联课程（一次算好，不在逐题循环里查库）；随机抽题考试改前的题量
      const fixedUse = new Map();
      let poolsBefore = null;
      if (op === "course") {
        for (const e of store.listExams()) {
          if (e.mode !== "fixed" || !e.questionIds.length) continue;
          const ex = { id: e.id, title: e.title, title_zh: e.title_zh || null, courseIds: new Set(store.getExamCourseIds(e.id)) };
          for (const qid of e.questionIds) { if (!fixedUse.has(qid)) fixedUse.set(qid, []); fixedUse.get(qid).push(ex); }
        }
        try { poolsBefore = bulkExamPools(); } catch (err) { console.error("[questions/bulk-update] pool count:", (err && err.stack) || err); }
      }
      const batch = runBatch((cur) => {
        const results = [], effects = [];
        for (let i = 0; i < ids.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const old = store.getQuestionBrief(ids[i]);
          if (!old) { results.push(bulkSkip(ids[i], "not_found")); continue; }
          if (op === "points") {
            if (old.type === "case") { results.push(bulkSkip(old.id, "case_points")); continue; }   // 第四批：题组分值 = 小题合计
            if ((old.points == null ? null : Number(old.points)) === points) { results.push(bulkUnchanged(old.id)); continue; }
            store.updateQuestionPoints(old.id, points);
            effects.push({ id: old.id, courseId: old.courseId, type: old.type });
          } else {
            const mod = moduleId || (course.id === old.courseId ? old.moduleId || null : null);
            if (course.id === old.courseId && mod === (old.moduleId || null)) { results.push(bulkUnchanged(old.id)); continue; }
            if (course.id !== old.courseId) {
              const blocking = (fixedUse.get(old.id) || []).filter((e) => !e.courseIds.has(course.id));
              if (blocking.length) { results.push(bulkSkip(old.id, "in_fixed_exam", { exams: blocking.map((e) => ({ id: e.id, title: e.title, title_zh: e.title_zh })) })); continue; }
            }
            store.updateQuestionPlacement(old.id, course.id, mod);
            effects.push({ id: old.id, courseId: course.id, type: old.type });
          }
          results.push({ id: old.id, ok: true });
        }
        return { results, effects };
      });
      if (!batch.ok) return sendBatchFailed(res, "questions/bulk-update", batch, { selection: true, noun: "item", split: true });
      // 审计与单题修改同形：question.update，after = { courseId, type }（改后的值）
      emitBulkEffects("questions/bulk-update", batch.value.effects, (e) => audit("question.update", e.id, null, { courseId: e.courseId, type: e.type }));
      let warnings = [];
      if (op === "course" && poolsBefore && batch.value.effects.length) {
        try { warnings = bulkPoolWarnings(poolsBefore); } catch (err) { console.error("[questions/bulk-update] pool warnings:", (err && err.stack) || err); }
      }
      return sendBulkResult(res, batch.value.results, { warnings });
    }
      return S.ROUTE_NEXT;
    },
  };
};
