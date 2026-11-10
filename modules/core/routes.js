"use strict";
// 组织、账号、系统设置与工作台 的接口处理（简化 10/11：从 server.js 的 handleApi 原样搬出，代码不改；按原顺序分段，server.js 在原位置依次调用）。
// 每段是一个方法：C = 本段用到的 handleApi 局部变量（req、res、user、body、audit 等）；S = server.js 的模块级函数与常量
// （getter，取调用当时的值；require / __dirname 也是 server.js 的，相对路径照旧以仓库根目录为准）。
// 段内匹配到接口时照原样 return；都没匹配到时返回 S.ROUTE_NEXT，server.js 接着往下匹配。改接口就在这里改。
module.exports = function routes(S) {
  return {
    // server.js handleApi 原第 8098–8134 行（登录后的员工端接口）
    async meCore1(C) {
      const { user, pathname, res, req, query, body, requestId, auditAuth } = C;
      const { send, dispatchModuleRoute, store, AI, isAdmin, canRead, modulesOn, hrbpEligible, brandCfg, resolveGrants, isSuperAdmin, checkPassword, newPasswordProblem, hashPassword, parseCookies } = S;
  if (user.mustChangePassword && !["/api/me", "/api/auth/change-password", "/api/auth/logout"].includes(pathname))
    return send(res, 403, { error: "Please change your temporary password first.", code: "password_change_required" });

  // ---------- 模块路由分发（接入方式 B，modules/culture/CONTRACT.md 3.5）----------
  // 写了 handler 路由的模块（culture）的 gate 内请求在这里交给内核分发，前面的 Origin 同源、模块开关 404、
  // 请求体读取（含非法 JSON → 外层 catch 回 bad_body）、401 与改密 403 都已做完。gate 外的路径原样往下走。
  if (dispatchModuleRoute(req, res, pathname, query, body, user, requestId)) return;

  if (pathname === "/api/me") {
    // modules: the logged-in front end (useAuth) reads its switches from here;
    // an old server without this field means "treat everything as on".
    // brand: same resolved object as /api/env — the app shell must never
    // disagree with the login page on branding.
    // RBAC: the front end (useAuth) trims navigation from grants + isSuperAdmin;
    // an old server without these fields is treated as super-admin (show all).
    const meRole = user.adminRoleId != null ? store.getRole(user.adminRoleId) : null;
    // ai：各项 AI 功能的状态（on / demo / off_* / not_configured / budget_exhausted）与告知确认情况；后台账号另含出题、画像，
    // 有审计读权限的另含 history（是否已有调用记录，模块关闭后仍显示「AI 治理」页）。aiEnabled 保留给旧前端。
    const meAi = AI.meAi(user, { isAdmin: isAdmin(user), canAudit: isAdmin(user) && canRead(user, "audit") });
    // appealDesk（第二批 2.8）：绩效模块开启时带 { hrbp }（生效中的 HRBP 分工），前端据此显示「绩效申诉」；模块关闭时不带
    const meMods = modulesOn();
    // CX-014（2026-10-10）：eligible = 有 HRBP 资格（后台角色）但可能未分工 —— 前端守卫对这种人放行申诉台页面，由页面显示「尚未分工」横幅
    const meAppealDesk = meMods.performance ? { appealDesk: { hrbp: hrbpEligible(user) && store.listHrbpDeptIdsOfUser(user.id).length > 0, eligible: hrbpEligible(user) } } : {};
    return send(res, 200, { id: user.id, name: user.name, employeeId: user.employeeId, role: user.role, ai: meAi, aiEnabled: meAi.assistant === "on" || meAi.assistant === "demo", mustChangePassword: !!user.mustChangePassword, modules: meMods, brand: brandCfg(), grants: resolveGrants(user), isSuperAdmin: isSuperAdmin(user), adminRoleId: user.adminRoleId != null ? user.adminRoleId : null, adminRoleName: meRole ? meRole.name : null, adminRoleName_zh: meRole ? meRole.name_zh : null, ...meAppealDesk });
  }

  // --- self-service password change ---
  if (pathname === "/api/auth/change-password" && req.method === "POST") {
    // 公开试用站（scripts/demo-start.js 设 LMS_DEMO_LOCK_PASSWORDS=1）：员工账号是大家共用的，
    // 任何一位访客改了密码，后面的人就都登录不了 —— 所以只许后台账号改密。正式部署不设此变量。
    if (process.env.LMS_DEMO_LOCK_PASSWORDS === "1" && !isAdmin(user))
      return send(res, 403, { error: "This is a shared demo account; its password can't be changed. 这是公共演示账号，不能修改密码。", code: "demo_password_locked" });
    const { currentPassword, newPassword } = body;
    if (!checkPassword(currentPassword || "", user.passwordHash))
      return send(res, 400, { error: "Current password is incorrect. 原密码不正确。", code: "current_password_incorrect" });
    const np = String(newPassword || "");
    const bad = newPasswordProblem(np, { employeeId: user.employeeId, currentPlain: String(currentPassword || "") });
    if (bad) return send(res, 400, bad);
    store.setUserPassword(user.id, hashPassword(np), false);
    // CX-093：与管理员重置、邮件找回同一口径 —— 其他设备上的会话一律作废（当前这台保留，免得改完密码就被踢出）
    const revoked = store.deleteOtherSessions(user.id, parseCookies(req).sid);
    if (revoked) auditAuth("auth.sessions_revoked", user, user.employeeId, { reason: "password_change", count: revoked });
    return send(res, 200, { ok: true });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 8760–8982 行（登录后的员工端接口）
    async meCore2(C) {
      const { pathname, req, user, res, pj, body, audit } = C;
      const { store, send, reviewSelfLocked, getProgram, notifyAdmins, reviewPersonGone, nudgedAt, notify, reviewSelfReminderMsg, canonOption, REVIEW_HIGHLIGHT_RATINGS, reviewItemLocked, REVIEW_SNAP_LOCKED_ERR, reviewHodProxyOf, buildTalentTimeline, employeeSeesManagerComment, optionZh, profileTabsFor } = S;
  const selfMatch = pathname.match(/^\/api\/me\/reviews\/([\w-]+)\/self$/);
  if (selfMatch && req.method === "POST") {
    const item = store.getReviewItem(selfMatch[1]);
    if (!item || item.userId !== user.id) return send(res, 404, { error: "Review record not found. 未找到该评估记录。", code: "not_found" });
    const cycle = store.getReviewCycle(item.cycleId);
    if (!cycle || cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
    // U3：部门已提交校准（含之后被退回）→ 自评与目标锁定
    if (cycle.flow === "v2" && reviewSelfLocked(cycle.id, user))
      return send(res, 409, { error: "Your department's calibration has been submitted, so the self-review is locked. 部门已提交校准，自评已锁定。", code: "self_locked" });
    const clean = (x, n) => String(x || "").trim().slice(0, n);
    const prevGoals = pj(item.prevGoals, []);
    const outcomes = (Array.isArray(body.outcomes) ? body.outcomes : []).map((x) => clean(x, 3000));
    // The bilingual one-liners below are kept verbatim as a fallback, but a
    // hard-coded "English 中文" sentence is wrong in both languages. `code` is the
    // localizable half: the self-review form owns the wording for each rule.
    if (prevGoals.length && !clean(outcomes[0], 3000))
      return send(res, 400, { error: "Key outcomes for previous cycle goal 1 are required. 上一周期目标 1 的关键成果为必填项。", code: "self_outcomes_required" });
    const feedback = clean(body.feedback, 2000);
    if (!feedback) return send(res, 400, { error: "Suggestions for the team/company are required. 请填写对团队/公司的建议。", code: "self_feedback_required" });
    const goalsNext = (Array.isArray(body.goalsNext) ? body.goalsNext : []).map((x) => clean(x, 2000)).filter(Boolean).slice(0, 3);
    if (!goalsNext.length) return send(res, 400, { error: "Set at least one goal for the next cycle. 请至少填写一个下一周期目标。", code: "self_goals_required" });
    store.updateReviewItem(item.id, {
      selfOutcomes: JSON.stringify(outcomes),
      selfChallenges: clean(body.challenges, 2000) || null,
      selfFeedback: feedback,
      selfExtra: clean(body.extra, 3000) || null,
      goalsNext: JSON.stringify(goalsNext),
      selfAt: new Date().toISOString(),
    });
    return send(res, 200, { ok: true });
  }
  // Step 3+4 (manager): the rating requires the 1-on-1 to be confirmed.
  // --- exam-grade appeals (申诉): the employee's side ---
  // Someone who believes a paper was mis-marked can say so once per attempt.
  // HR then either accepts it (and regrades) or rejects it with a reason.
  const appealMatch = pathname.match(/^\/api\/me\/attempts\/([\w-]+)\/appeal$/);
  if (appealMatch && req.method === "POST") {
    const attempt = store.getAttempt(appealMatch[1]);
    if (!attempt || attempt.userId !== user.id || !attempt.submittedAt)
      return send(res, 404, { error: "Attempt not found" });
    if (attempt.voided) return send(res, 400, { error: "This attempt was voided." });
    const reason = String(body.reason || "").trim().slice(0, 1000);
    if (reason.length < 10) return send(res, 400, { error: "Please describe what you think is wrong (at least 10 characters).", code: "reason" });
    if (store.getOpenAppeal(attempt.id)) return send(res, 409, { error: "You already have an open appeal on this attempt.", code: "duplicate" });
    // An accepted appeal has already been actioned, so there is nothing left to
    // dispute. A rejected one may be answered again with better evidence.
    const prior = store.listAppealsForAttempts([attempt.id]).get(attempt.id);
    if (prior && prior.status === "accepted") return send(res, 409, { error: "This appeal was already accepted.", code: "settled" });
    const ap = store.addAppeal({ attemptId: attempt.id, userId: user.id, reason });
    const p = getProgram(attempt.programId);
    notifyAdmins({
      type: "appeal",
      title: "New grade appeal",
      title_zh: "新的成绩申诉",
      body: `${user.name} appealed their result for ${p ? p.title : attempt.programId}.`,
      body_zh: `${user.name} 对「${p ? (p.title_zh || p.title) : attempt.programId}」的成绩提出了申诉。`,
      // 第二批 2.5：直达这份答卷（Results.jsx 读 ?attempt=）
      link: `/admin/results?attempt=${encodeURIComponent(attempt.id)}`,
    }, "learning");
    audit("attempt.appeal", attempt.id, null, { appealId: ap.id, reason });
    return send(res, 200, { ok: true, appeal: ap });
  }

  // A manager can't rate a report who hasn't submitted their self-review, so give
  // them one action instead of a dead end: nudge the report. Rate-limited to one
  // nudge per hour per item so it can't be used to spam a direct report.
  const nudgeMatch = pathname.match(/^\/api\/me\/reviews\/([\w-]+)\/nudge$/);
  if (nudgeMatch && req.method === "POST") {
    const item = store.getReviewItem(nudgeMatch[1]);
    if (!item || item.managerId !== user.id) return send(res, 404, { error: "Review record not found. 未找到该评估记录。", code: "not_found" });
    // 第二批 2.7：上级本人已离职或停用 → 409；对象已离职或停用 → 400（与 HR 批量提醒同一口径）
    if (reviewPersonGone(user))
      return send(res, 409, { error: "Your account is no longer active, so you can't act on this review. 你的账号已不在职，不能再操作这条评估。", code: "manager_inactive" });
    const cycle = store.getReviewCycle(item.cycleId);
    if (!cycle || cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
    if (reviewPersonGone(store.getUserById(item.userId)))
      return send(res, 400, { error: "This person has left, so reminders are no longer sent. 此人已离职，不再发送提醒。", code: "recipient_inactive" });
    if (item.selfAt) return send(res, 400, { error: "This employee has already submitted their self-review. 该员工已提交自评。", code: "already_submitted" });
    const last = nudgedAt.get(item.id);
    if (last && Date.now() - last < 60 * 60 * 1000)
      return send(res, 429, { error: "A reminder was already sent in the last hour. 一小时内已发送过提醒，请稍后再试。", code: "cooldown" });
    nudgedAt.set(item.id, Date.now());
    // 文案与 HR 批量提醒（POST /api/admin/review-reminders 的自评阶段）共用 reviewSelfReminderMsg；上级发起时正文写上级姓名
    notify(item.userId, reviewSelfReminderMsg(cycle, user.name));
    audit("review.nudge", item.id, null, { userId: item.userId, cycle: cycle.name });
    return send(res, 200, { ok: true });
  }

  // 上级评级。第二批 2.1（2026-10-08）：v2 周期不再以面谈为前提、也不再自动登记面谈（面谈走 POST /:id/one-on-one；
  // body.oneOnOneDone === true 时仍照写上级一侧，兼容现在的评估页）；旧流程不变（仍须先勾选面谈）。
  // 补丁语义（审查 P0-1）：没传的字段保持原值 —— rating 不传沿用已有评级、text 不传保留上级评语、highlights 不传保留关键亮点、
  // oneOnOneNotes 不传保留面谈要点；只保存评级不会清掉别的内容。
  // 2.7：上级本人已离职或停用 → 409 manager_inactive；2.2：HoD 已代评 → 409 hod_proxied（HoD 清空代评后恢复）。
  const mgrMatch = pathname.match(/^\/api\/me\/reviews\/([\w-]+)\/manager$/);
  if (mgrMatch && req.method === "POST") {
    const item = store.getReviewItem(mgrMatch[1]);
    if (!item || item.managerId !== user.id) return send(res, 404, { error: "Review record not found. 未找到该评估记录。", code: "not_found" });
    const cycle = store.getReviewCycle(item.cycleId);
    if (!cycle || cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
    if (reviewPersonGone(user))
      return send(res, 409, { error: "Your account is no longer active, so you can't rate this person. 你的账号已不在职，不能再为此人评级。", code: "manager_inactive" });
    const v2 = cycle.flow === "v2";
    if (!v2 && !item.oneOnOneAt && !body.oneOnOneDone)
      // Same reasoning as the self-review above: text kept, `code` added so the
      // manager form can print its own sentence.
      return send(res, 400, { error: "Complete the 1-on-1 performance conversation and tick to confirm first. 请先完成 1 对 1 绩效面谈并勾选确认。", code: "oneonone_required" });
    const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
    const opts = ratingField ? ratingField.options : [];
    // Normalized, not just validated: a zh screen may post the Chinese name, and
    // storing that would fork the scale — distribution counts and perfBucketOf()
    // both key off the canonical value.
    const rating = canonOption(ratingField || {}, String(body.rating === undefined ? item.managerRating || "" : body.rating || "").trim());
    if (!rating || (opts.length && !opts.includes(rating)))
      return send(res, 400, { error: "Select a valid performance rating. 请选择有效的绩效评级。", code: "rating_required" });
    // 绩效流程 v2：A+/A 与 C/D 须写关键亮点（没传就看已存的）；部门已由 HoD 提交（未退回）后上级不能再改
    const highlights = body.highlights === undefined ? String(item.highlights || "") : String(body.highlights || "").trim().slice(0, 2000);
    if (v2) {
      if (REVIEW_HIGHLIGHT_RATINGS.includes(rating) && !highlights.trim())
        return send(res, 400, { error: "Key highlights are required for A+, A, C and D. A+/A 与 C/D 须填写关键亮点。", code: "highlights_required" });
      // P0 E4：没有一级部门的人归「__none」组，HR 确认后上级同样不能再改；此人还在另一个已提交 / 已确认部门的快照里
      // （调部门过来的）同样不能改（审查）
      const lock = reviewItemLocked(cycle, item);
      if (lock === "dept") return send(res, 400, { error: "The HoD has already submitted this department. HoD 已提交本部门，不能再修改。", code: "dept_locked" });
      if (lock === "snap") return send(res, 400, REVIEW_SNAP_LOCKED_ERR);
      if (reviewHodProxyOf(cycle, item))
        return send(res, 409, { error: "The HoD has already rated this person on your behalf. Ask the HoD to clear it first if you need to rate. HoD 已代你为此人评级；如需由你评级，请先请 HoD 清除代评。", code: "hod_proxied" });
    }
    const fields = { highlights: highlights.trim() || item.highlights || null, managerRating: rating, managerAt: new Date().toISOString() };
    if (body.text !== undefined) fields.managerText = String(body.text || "").trim().slice(0, 4000) || null;
    if (body.oneOnOneNotes !== undefined) fields.oneOnOneNotes = String(body.oneOnOneNotes || "").trim().slice(0, 2000) || item.oneOnOneNotes || null;
    if (!v2 || body.oneOnOneDone === true) fields.oneOnOneAt = item.oneOnOneAt || new Date().toISOString();
    store.updateReviewItem(item.id, fields);
    return send(res, 200, { ok: true });
  }

  // --- my growth profile (Phase 5: the employee's own trajectory) ---
  // Server-side rendering of the SAME timeline HR sees, filtered to the record
  // types HR marked employee-visible, with display lines pre-built from the
  // field config (the employee never receives the admin config or hidden data).
  if (pathname === "/api/me/growth" && req.method === "GET") {
    const { events } = buildTalentTimeline(user);
    const types = Object.fromEntries(store.listRecordTypes(true).map((t) => [t.key, t]));
    const fieldsByType = {};
    for (const f of store.listRecordFields(null)) (fieldsByType[f.typeKey] = fieldsByType[f.typeKey] || []).push(f);
    const out = [];
    // 第二批 L2：开关关闭时，周期归档的绩效记录（与「我的绩效」同一批）的评语行不给本人
    const cycleRecs = employeeSeesManagerComment() ? null
      : store.mapReviewItemsByRecordIds(events.filter((e) => e.source === "record" && e.type === "performance").map((e) => e.id));
    for (const e of events) {
      // The hire milestone is DERIVED from the employee's own record, not a
      // talent_records row, so there is no record type and no employeeVisible
      // flag to consult — your own start date is always yours to see. Keying this
      // off e.source silently dropped it the moment the source stopped being "lms".
      if (e.type === "hired") {
        out.push({ kind: "hired", date: e.date, title: e.title, title_zh: e.title_zh || null });
        continue;
      }
      if (e.source === "lms") {
        out.push({ kind: "lms", date: e.date, title: e.title, title_zh: e.title_zh || null, lms: e.lms });
        continue;
      }
      const t = types[e.type];
      if (!t || !t.employeeVisible) continue; // sensitive types stay HR-only
      // 周期归档的绩效记录的评语给不给本人看，与「我的绩效」同一处开关、同一口径（第二批 L2）：按「是不是周期归档的记录」判；
      // summaryAuthor = "manager" 的（周期已被删、记录还在）照旧算上级评语
      const hideMgrComment = !!(cycleRecs && e.type === "performance" && ((e.id && cycleRecs.has(e.id)) || (e.detail && e.detail.summaryAuthor === "manager")));
      const lines = [];
      for (const f of fieldsByType[e.type] || []) {
        if (!f.active || !f.showInTimeline || f.input === "checkbox") continue;
        if (hideMgrComment && f.key === "summary") continue;
        const v = e.detail[f.key];
        if (v === undefined || v === null || v === "") continue;
        // Both languages: the employee's own UI picks one with loc(). The value
        // needs the same treatment as the label — it is stored canonical, so a
        // Chinese employee would otherwise read "Passed" on their own timeline.
        // Non-select values are language-neutral, but value_zh still ships so
        // the client can call loc() unconditionally.
        const sv = String(v);
        // Gate on having a configured list, not on input === "select": two of the
        // built-in option fields are `suggest` (training.result, award.awardName),
        // and their values are canonical English too.
        lines.push({ label: f.label, label_zh: f.label_zh || f.label, value: sv, value_zh: (f.options || []).length ? String(optionZh(f, sv)) : sv });
      }
      out.push({
        kind: "record", date: e.date, title: e.title,
        typeLabel: t.label, typeLabel_zh: t.label_zh || t.label,
        color: t.color, lines,
      });
    }
    const visRecords = out.filter((e) => e.kind === "record");
    return send(res, 200, {
      me: {
        name: user.name,   /* 第三批 9.1：员工端不下发工号 */ 
        department: user.department || null, position: user.position || null, jobLevel: user.jobLevel || null,
        hireDate: user.hireDate || null, empStatus: user.empStatus || null,
        // Where I sit in the org. Names only — no ids, no potential rating, no
        // talent tags: the same rule the timeline follows.
        managerName: (() => {
          const m = user.managerId ? store.getUserById(user.managerId) : null;
          return m ? m.name : null;
        })(),
        dottedManagers: store.listSecondaryLines(user.id)
          .filter((r) => r.kind === "dotted" && r.managerId)
          .map((r) => {
            const m = store.getUserById(r.managerId);
            return { name: m ? m.name : null, scope: r.position || null };
          })
          .filter((x) => x.name),
        concurrentPosts: store.listSecondaryLines(user.id)
          .filter((r) => r.kind === "concurrent")
          .map((r) => ({ position: r.position, department: r.department || null })),
      },
      stats: {
        records: visRecords.length,
        awards: visRecords.filter((e) => e.typeLabel === (types.award && types.award.label)).length,
        promotions: visRecords.filter((e) => e.typeLabel === (types.promotion && types.promotion.label)).length,
      },
      events: out,
      // 模块页签（§5.4，见 profileTabsFor）：本人位置。Record.jsx 的档案数据来自这里（learning-record 属
      // learning 模块、随模块关闭而 404），所以本人页签的清单挂在这个 core 常驻接口上。
      tabs: profileTabsFor(user, "self"),
    });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 9243–9403 行（登录后的员工端接口）
    async meCore3(C) {
      const { pathname, req, myMemberships, res, user, body, audit } = C;
      const { getTProject, send, tpCohort, tpPhaseView, tpActivityView, tpProgressPercent, tpActivities, tpCheckinTarget, tpCheckinOpen, checkinSlot, checkinCode, store, tpCompletionOpen, TP_ONLINE_DONE, tpSetCompletion, tpRosterTarget, newToken, notifyAdmins, AI, MODULE_HOST, myClasses, mySessions, directReports, isAdmin, isSuperAdmin, checkinNotToday } = S;
  const tpMine = pathname.match(/^\/api\/me\/tprojects\/([\w-]+)$/);
  if (tpMine && req.method === "GET") {
    const doc = getTProject(tpMine[1]);
    const m = myMemberships().find((x) => x.projectId === tpMine[1]);
    if (!doc || !m || doc.status === "draft") return send(res, 404, { error: "Project not found", error_zh: "未找到该发展项目。", code: "not_found" });   // CX-119：带中文
    const cohort = tpCohort(doc, m.cohortId);
    if (!cohort) return send(res, 404, { error: "Project not found", error_zh: "未找到该发展项目。", code: "not_found" });
    const phases = tpPhaseView(user.id, doc.id, cohort).map((ph) => ({
      ...ph, activities: ph.activities.map((a) => {
        const v = { ...tpActivityView(a), done: a.done, state: a.state, broken: !!a.broken };
        // Only where the number says something `done` cannot: an online course or a
        // package needs "3 of 4 modules in", while an exam says it with examScore and
        // an in-person session is all-or-nothing. tpPhaseView already computed it.
        if (a.type === "course" || a.type === "program") v.progressPercent = a.percent;
        if (a.type === "exam") { v.examScore = a.examScore; v.examPassed = a.examPassed; }
        // 线上活动的链接跟着阶段解锁走：未解锁的阶段不下发链接
        if (a.type === "online" && !ph.unlocked) v.url = null;
        return v;
      }),
    }));
    const cls = (cohort.classes || []).find((c) => c.id === m.classId) || null;
    return send(res, 200, {
      id: doc.id, code: doc.code, title: doc.title, title_zh: doc.title_zh, status: doc.status,
      cohort: cohort.name, class: cls ? cls.name : null, startAt: cohort.startAt || null, endAt: cohort.endAt || null,
      progress: tpProgressPercent(phases), phases,
    });
  }
  const tpCheckin = pathname.match(/^\/api\/me\/tprojects\/([\w-]+)\/checkin$/);
  if (tpCheckin && req.method === "POST") {
    const doc = getTProject(tpCheckin[1]);
    const m = myMemberships().find((x) => x.projectId === tpCheckin[1]);
    if (!doc || !m) return send(res, 404, { error: "Project not found", error_zh: "未找到该发展项目。", code: "not_found" });   // CX-119：带中文
    const cohort = tpCohort(doc, m.cohortId);
    const act = cohort && tpActivities(cohort).find((a) => a.id === String(body.activityId || ""));
    const tgt = tpCheckinTarget(act, doc, cohort);   // 线下活动，或引用线下课程的课程活动（记在课程出勤上）
    if (!tgt) return send(res, 404, { error: "Activity not found", error_zh: "未找到该活动。", code: "not_found" });   // CX-189
    if (doc.status !== "running")
      return send(res, 409, { error: "Check-in is only open while the program is in progress.", error_zh: "发展项目进行中才能签到。", code: "not_running" });
    // CX-025：期次已结束（结束日已过）不再接受签到。写入前就拒绝，所以已有的出勤 / 请假记录原样保留。
    // 未结束的期次里，学员本人输码签到仍按负责人 2026-10-06 的规则覆盖「请假」（excused-not-done.test.js F5）。
    if (!tpCheckinOpen(doc, cohort))
      return send(res, 409, { error: "This cohort has ended, so check-in is closed.", error_zh: "期次已结束，不能签到。", code: "cohort_ended" });
    const notToday = checkinNotToday(tgt.sessionAt);
    if (notToday) return send(res, 409, { error: `Check-in is open only on the day of the session (${notToday}).`, error_zh: `签到只在活动当天开放（活动日期 ${notToday}）。`, code: "checkin_not_today", sessionDay: notToday });
    const code = String(body.code || "").trim();
    const slot = checkinSlot();
    if (code !== checkinCode(tgt.ckId, slot) && code !== checkinCode(tgt.ckId, slot - 1))
      return send(res, 400, { error: "Wrong or expired code. Check the screen and try again.", code: "badcode" });
    // Late = checking in more than 15 minutes after the scheduled start.
    let status = "attended";
    if (tgt.sessionAt && Date.now() > new Date(tgt.sessionAt).getTime() + 15 * 60 * 1000) status = "late";
    store.setActivityState({ projectId: tgt.projectId, cohortId: tgt.cohortId, activityId: tgt.ckId, userId: user.id, status, by: user.id });
    return send(res, 200, { ok: true, status });
  }
  // 学员完成线上活动（负责人 2026-10-06 五类活动）：click = 在培养项目页打开链接即完成，self = 学员点
  // 「我已完成」；trainer 方式只能由讲师（我的授课）或 HR（完成登记）登记。
  // 校验顺序：项目 → 活动 → 完成方式 → 项目状态（进行中 / 收尾中）→ 阶段已解锁。重复调用幂等，
  // 已有的完成行（含讲师、HR 登记的）原样保留、不降级；请假行被学员本人的完成覆盖（请假不算完成、需补课，
  // 负责人 2026-10-06）。与学员自助签到一样不记审计。
  const tpDone = pathname.match(/^\/api\/me\/tprojects\/([\w-]+)\/complete$/);
  if (tpDone && req.method === "POST") {
    const doc = getTProject(tpDone[1]);
    const m = myMemberships().find((x) => x.projectId === tpDone[1]);
    if (!doc || !m || doc.status === "draft") return send(res, 404, { error: "Project not found", error_zh: "未找到该发展项目。", code: "not_found" });
    const cohort = tpCohort(doc, m.cohortId);
    const act = cohort && tpActivities(cohort).find((a) => a.id === String(body.activityId || ""));
    if (!act || act.type !== "online") return send(res, 404, { error: "Activity not found", error_zh: "未找到该活动。", code: "not_found" });
    const mode = tpActivityView(act).completion;
    if (mode === "trainer")
      return send(res, 409, { error: "This activity is marked complete by the trainer or HR.", error_zh: "该活动由讲师或 HR 登记完成。", code: "trainer_only" });
    if (body.via !== mode)
      return send(res, 409, { error: "This activity is not completed that way.", error_zh: "该活动的完成方式不是这一种。", code: "mode_mismatch" });
    if (!tpCompletionOpen(doc))
      return send(res, 409, { error: "Online activities can only be completed while the program is in progress or wrapping up.", error_zh: "发展项目进行中或收尾中才能完成线上活动。", code: "not_running" });
    // 按活动所在阶段判断（不按 phaseId：旧夹具的阶段可能没有 id）
    const ph = tpPhaseView(user.id, doc.id, cohort).find((p) => p.activities.some((x) => x.id === act.id));
    if (!ph || !ph.unlocked)
      return send(res, 409, { error: "This phase is not open yet.", error_zh: "该阶段尚未开放。", code: "phase_locked" });
    // 幂等：本项目已有完成行就原样返回（请假行不算，照常改写为完成）。活动 id 假定全库唯一（activity_state 主键只有
    // activityId + userId）；若这一行的 projectId 不是本项目，说明 id 与别的项目撞了 —— 不拿它当
    // 本项目的完成，由 tpSetCompletion 按本项目重写。
    const prev = store.getActivityState(act.id, user.id);
    if (prev && prev.projectId === doc.id && TP_ONLINE_DONE.includes(prev.status)) return send(res, 200, { ok: true, status: prev.status });
    tpSetCompletion(tpRosterTarget(act, doc, cohort), user.id, "completed", user.id, mode);
    return send(res, 200, { ok: true, status: "completed" });
  }
  const tpApply = pathname.match(/^\/api\/me\/tprojects\/([\w-]+)\/apply$/);
  if (tpApply && req.method === "POST") {
    const doc = getTProject(tpApply[1]);
    if (!doc || !["planning", "running"].includes(doc.status)) return send(res, 404, { error: "Project not found", error_zh: "未找到该发展项目。", code: "not_found" });
    const cohort = (doc.cohorts || []).find((c) => c.open);
    if (!cohort) return send(res, 400, { error: "This project isn't open for applications.", error_zh: "该发展项目暂不接受申请。", code: "not_open" });
    if (myMemberships().some((x) => x.projectId === doc.id)) return send(res, 400, { error: "You're already in this project.", error_zh: "你已在这个发展项目中。", code: "already_member" });
    // CX-116：后台管理员账号不作为学员（与加学员接口同口径），申请入口同样拦截
    if (user.role === "admin") return send(res, 400, { error: "Back-office admin accounts can't join a development program as learners.", error_zh: "后台管理员账号不能作为学员参加发展项目。", code: "admin_not_learner" });
    const newId = "nm-" + newToken().slice(0, 10);
    const a = store.createApproval({
      id: newId, kind: "nomination",
      subject: { projectId: doc.id, cohortId: cohort.id },
      requesterId: user.id, targetUserId: user.id,
      note: body.note ? String(body.note).slice(0, 500) : null,
    });
    // CX-122：同一员工重复申请时 createApproval 返回已有的待审申请 —— 只在新建时记审计、通知管理员
    if (a.id !== newId) return send(res, 200, { ok: true, status: a.status, existing: true });
    audit("tproject.apply", doc.id, null, { by: user.employeeId });
    notifyAdmins({
      type: "tproject.apply",
      title: `${user.name} applied to join the development program “${doc.title || doc.title_zh || ""}”`,
      title_zh: `${user.name} 申请参加发展项目《${doc.title_zh || doc.title}》`,
      body: "Review it on the program's Pending Applications tab or on the Application Approvals page.",
      body_zh: "请在「发展项目 › 〈项目名〉」的「待审申请」页签或「申请审批」页处理。",
      // 第二批 2.5：直达该项目的「待审申请」页签（Projects.jsx 读 ?project=&tab= 之前，这条链接只落到列表）
      link: `#/admin/projects?project=${encodeURIComponent(doc.id)}&tab=nom`,
    }, "learning");
    return send(res, 200, { ok: true, status: a.status });
  }

  // In-app notifications for the signed-in user.
  // 员工确认 AI 告知（方案 2.6）：服务端记一行（用户、告知、版本、时间）；浏览器 localStorage 只作缓存
  if (pathname === "/api/me/ai-notice-ack" && req.method === "POST") {
    const notice = String(body.notice || "");
    const version = Number(body.version);
    if (!Object.prototype.hasOwnProperty.call(AI.NOTICE_VERSIONS, notice) || !Number.isInteger(version) || version < 1 || version > AI.NOTICE_VERSIONS[notice])
      return send(res, 400, { error: "Unknown notice", error_zh: "未知的告知。", code: "bad_notice" });
    store.ackAiNotice(user.id, notice, version);
    return send(res, 200, { ok: true });
  }
  if (pathname === "/api/me/notifications" && req.method === "GET") {
    // fullPage：link 指向模块自带的页面（如学员端 /culture/#/home，不在 SPA 路由里）时为 true，
    // 通知铃据此整页跳转（location.href），其余照旧走前端路由。判定与登录回跳的 next 白名单是同一个函数（模块关闭时
    // 指向它的链接为 false，开关整张列表只读一次）。
    const pageLink = MODULE_HOST.pageLinker();
    const items = store.listNotifications(user.id, 40).map((n) => ({
      id: n.id, type: n.type, title: n.title, title_zh: n.title_zh, body: n.body, body_zh: n.body_zh,
      link: n.link, read: !!n.readAt, createdAt: n.createdAt, fullPage: !!pageLink(n.link),
    }));
    return send(res, 200, { items, unread: store.countUnreadNotifications(user.id) });
  }
  if (pathname === "/api/me/notifications/read" && req.method === "POST") {
    store.markNotificationsRead(user.id, body && body.id ? String(body.id) : null);
    return send(res, 200, { ok: true, unread: store.countUnreadNotifications(user.id) });
  }

  // ---------- roles beyond admin/employee ----------
  // 讲师 (trainer), 班主任 (class head) and 经理 (manager) are DERIVED from data
  // that already exists — who teaches a session, who heads a class, who is
  // someone's manager — instead of a second role column. One source of truth,
  // and HR never has to keep a separate role list in sync. They are distinct
  // jobs: a trainer delivers a session, a class head shepherds a class, and one
  // person can hold several of these at once.
  if (pathname === "/api/me/roles" && req.method === "GET") {
    const cls = myClasses(user.id);
    const sessions = mySessions(user.id);
    const reports = directReports(user.id);
    return send(res, 200, {
      // admin: kept as-is for every existing caller, but now true for any admin
      // role (legacy flag OR an assigned RBAC role). isSuperAdmin is the new,
      // narrower flag for callers that need "can do everything" specifically.
      admin: isAdmin(user),
      isSuperAdmin: isSuperAdmin(user),
      trainer: sessions.length > 0,     // 讲师:被指定为某场次/课程的讲师
      classHead: cls.length > 0,        // 班主任:被指定为某班级的班主任
      manager: reports.length > 0,      // 经理:有直接下属
      sessionCount: sessions.length,
      classCount: cls.length,
      reportCount: reports.length,
    });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 9410–9577 行（登录后的员工端接口）
    async meCore4(C) {
      const { pathname, req, user, res, body, audit } = C;
      const { trainerSessionScope, send, store, sessionSummary, checkinSlot, tpCheckinOpen, checkinCode, tpCohortEnded, tpSetCompletion, reportingSubtree, todayLocal, PROGRAMS, programProgress, bestAttempt, programDone } = S;
  const sesCk = pathname.match(/^\/api\/me\/sessions\/([\w.-]+)\/checkin$/);
  if (sesCk && req.method === "GET") {
    const scope = trainerSessionScope(user.id, decodeURIComponent(sesCk[1]));
    if (!scope) return send(res, 404, { error: "Session not found" });
    const states = {};
    for (const st of store.listActivityStates(scope.checkinId)) states[st.userId] = st;
    // 第三批 9.1：讲师端名单不下发工号（保留部门）
    const list = scope.attendees.map(({ employeeId, ...a }) => ({ ...a, status: states[a.userId] ? states[a.userId].status : null, at: states[a.userId] ? states[a.userId].at : null }));
    // 线上活动（讲师或 HR 登记方式）：没有签到码，名单只分已完成 / 请假 / 未完成
    if (scope.rollKind === "completion") {
      return send(res, 200, {
        ...sessionSummary(scope),
        rollKind: "completion",
        code: null,
        checkinOpen: false,
        secondsLeft: null,
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
    const sesOpen = scope.kind === "course" || tpCheckinOpen(scope.doc, scope.cohort);   // 项目场次：进行中且期次未结束才出码（CX-025）
    return send(res, 200, {
      ...sessionSummary(scope),
      rollKind: "checkin",
      code: sesOpen ? checkinCode(scope.checkinId, slot) : null,
      checkinOpen: sesOpen,
      cohortEnded: scope.kind !== "course" && tpCohortEnded(scope.cohort),   // CX-025
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
  const sesMark = pathname.match(/^\/api\/me\/sessions\/([\w.-]+)\/checkin\/mark$/);
  if (sesMark && req.method === "POST") {
    const scope = trainerSessionScope(user.id, decodeURIComponent(sesMark[1]));
    if (!scope) return send(res, 404, { error: "Session not found" });
    const targetId = String(body.userId || "");
    if (!scope.attendees.some((a) => a.userId === targetId)) return send(res, 403, { error: "That learner is not in this session.", error_zh: "该学员不在本场次。" });
    // 线上活动的完成登记：只记完成或请假；讲师不能给自己登记（讲师本人也可能是本期学员）。
    if (scope.rollKind === "completion") {
      if (targetId === user.id) return send(res, 403, { error: "You can't record your own completion.", error_zh: "不能为自己登记完成。", code: "self_mark" });
      const status = body.status === "excused" ? "excused" : ["completed", "attended", "late"].includes(body.status) ? "completed" : null;
      if (!status) return send(res, 400, { error: "Invalid status", error_zh: "状态无效。", code: "bad_status" });
      tpSetCompletion({ ckId: scope.checkinId, projectId: scope.projectId, cohortId: scope.cohortId }, targetId, status, user.id);
      const t = store.getUserById(targetId);
      audit("trainer.activity.mark", scope.key, null, { by: user.employeeId, employeeId: t ? t.employeeId : targetId, status });
      return send(res, 200, { ok: true });
    }
    const status = ["attended", "late", "excused", "absent"].includes(body.status) ? body.status : "attended";
    store.setActivityState({ projectId: scope.projectId, cohortId: scope.cohortId, activityId: scope.checkinId, userId: targetId, status, by: user.id });
    const t = store.getUserById(targetId);
    audit("trainer.checkin.mark", scope.key, null, { by: user.employeeId, employeeId: t ? t.employeeId : targetId, status });
    return send(res, 200, { ok: true });
  }
  // MANAGER (D8): my whole reporting LINE and how their training is going.
  // Read-only. This used to be direct reports only; D8 (RBAC-DESIGN.md §8.2)
  // widened a manager's range to the entire subtree beneath them so a director
  // running a headcount/training review no longer has to go through HR.
  // Every pre-existing field on a DIRECT report is byte-for-byte what it was
  // (MyTeam.jsx — the one and only consumer; Home.jsx's `team` comes from
  // /api/me/reviews, not from here); relation / depth / managerId /
  // managerName / directCount are purely additive, so the client can nest
  // skip-levels under their own manager instead of a flat list.
  /* COST (F2). D8 widened the line, and the first cut ran the per-person
     PROGRAMS loop over ALL of it. Measured on the 925-person roster, a
     924-person line: 750KB and ~630ms per request, and 8 concurrent calls
     pinned the single-threaded process for ~5s — a light /api/me sat behind
     them the whole time. That is any tree-top manager's ordinary page load,
     not an attack, so it had to go.
     THE SPLIT — depth is the whole rule:
       · depth === 1 (direct reports) — the object below is byte-for-byte the
         one that shipped before, field for field, in the same order. This is
         the page's actual job (「下属的培训状态」) and MyTeam.jsx renders every
         one of those fields, so nothing here may be trimmed.
       · depth > 1 (skip-levels) — identity + org + lineage ONLY. A skip-level
         row exists so the manager can SEE the person and click through to
         their profile (D8/D3); the training detail on that row was never
         read by anything but the two roll-up counters at the top of MyTeam.
         Everyone stays in the list and every profile stays reachable, so D8
         visibility is not narrowed one bit — only the payload is.
     WHY NOT A LIGHT SUMMARY (done/overdue counts) FOR SKIP-LEVELS: there is
     no cheap way to compute one. `passed` needs the module-completion rows
     AND the best attempt per program, i.e. exactly the loop we are avoiding,
     and the store exposes no batched per-line query (one call per person is
     the same 900× fan-out). A count that costs what the detail costs saves
     nothing, so the skip-level row carries no training numbers at all and
     MyTeam.jsx labels its two counters as direct-report counters.
     If a future view genuinely needs a skip-level's training detail, load it
     on demand: GET /api/me/reports/:userId already serves exactly that, one
     person at a time, for anyone in the line.
     Also gone: the per-row store.getUserById(managerId) — every manager in a
     line is either the root or another member of that same line (the BFS
     builds its adjacency map by managerId), so the name resolves from the
     rows we already hold. ~924 point queries → 0, with a getUserById
     fallback kept for a row whose manager somehow is not in the line. */
  if (pathname === "/api/me/team" && req.method === "GET") {
    const line = reportingSubtree(user.id);
    const nameById = new Map([[user.id, user.name]]);
    for (const { user: u } of line) nameById.set(u.id, u.name);
    const uplineName = (managerId) => {
      if (!managerId) return null;
      if (nameById.has(managerId)) return nameById.get(managerId) || null;
      const m = store.getUserById(managerId);          // out-of-line manager
      nameById.set(managerId, m ? m.name : null);
      return m ? m.name : null;
    };
    const today = todayLocal(); // local day: dueAt is a local calendar date
    const rows = line.map(({ user: u, depth }) => {
      // --- skip-level: identity + org + lineage, no PROGRAMS loop ---
      if (depth !== 1) {
        return {
          userId: u.id, name: u.name,   /* 第三批 9.1：员工端不下发工号 */ 
          department: u.department || null, active: u.active !== 0,
          position: u.position || null, jobLevel: u.jobLevel || null,
          empStatus: u.empStatus || null,
          relation: "indirect",
          depth,
          managerId: u.managerId || null,
          managerName: uplineName(u.managerId),
        };
      }
      const asg = store.getUserAssignments(u.id);
      const items = [];
      // 第四批 7：assigned / done / overdue 只计指派的课程；自主学习的课程照常列出（带 source），完成数另记 selfDone
      let overdue = 0, done = 0, selfDone = 0, assignedN = 0;
      for (const p of PROGRAMS) {
        if (!asg[p.id]) continue;
        const prog = programProgress(u.id, p).percent;
        const best = bestAttempt(u.id, p.id);
        const passed = programDone(u.id, p);
        const due = asg[p.id].dueAt;
        const isOverdue = !passed && due && due < today;
        const self = asg[p.id].source === "self";
        if (self) { if (passed) selfDone++; }
        else { assignedN++; if (passed) done++; if (isOverdue) overdue++; }
        items.push({
          id: p.id, title: p.title, title_zh: p.title_zh,
          progress: prog, dueAt: due || null, passed, overdue: isOverdue,
          bestPercent: best ? best.percent : null,
          source: self ? "self" : "assigned",
        });
      }
      return {
        userId: u.id, name: u.name,   /* 第三批 9.1：员工端不下发工号 */
        department: u.department || null, active: u.active !== 0,
        position: u.position || null, jobLevel: u.jobLevel || null,
        empStatus: u.empStatus || null,
        assigned: assignedN, done, overdue, selfDone, items,
        // --- D8 additions (nothing above this line changed) ---
        relation: "direct",
        depth,
        managerId: u.managerId || null,
        managerName: uplineName(u.managerId),
      };
    });
    return send(res, 200, { count: rows.length, directCount: line.filter((r) => r.depth === 1).length, rows });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 10256–10379 行（登录后的员工端接口）
    async meCore5(C) {
      const { pathname, req, user, res, body, requestId, canAccessCourse } = C;
      const { store, send, examRulesOf, attemptDeadline, QT, AI, aiFeatures, markOpenUnavailable, scoreDetail, enqueueGrading, settleAttempt, clientDetail, sendAiState, getCourse, examInProgressForCourse, sendAiRateLimited, brandCfg, aiManagersOf, aiRoster, sendAiError } = S;
  const draftMatch = pathname.match(/^\/api\/exam-attempts\/([\w-]+)\/draft$/);
  if (draftMatch && req.method === "PUT") {
    const attempt = store.getAttempt(draftMatch[1]);
    if (!attempt || attempt.userId !== user.id) return send(res, 404, { error: "Attempt not found" });
    if (attempt.submittedAt) return send(res, 400, { error: "Already submitted" });
    const savedAt = store.saveAttemptDraft(attempt.id, body.answers || {});
    return send(res, 200, { ok: true, savedAt });
  }
  // 交卷（方案 2.5「交卷即落库，后台排队评分」）。整个 handler 没有任何 await：截止判定、「未提交 → 已提交」的状态切换
  // 与客观题计分都在同一个同步段里完成（Node 单线程），同一答卷的第二次提交必然看到已提交 → 409 already_submitted。
  // 含简答题且 grading 功能可用（on）时，答卷以 gradingStatus = grading 落库并进入评分队列，立即返回；
  // 功能关闭、未接入、演示、预算用尽时不入队，简答题按「AI 不可用」处理，交卷时即按决定性复核规则定稿（不再按 0 分计，
  // 演示估分只作展示、任何情况下都不计分）。
  const submitMatch = pathname.match(/^\/api\/exam\/([\w-]+)\/submit$/);
  if (submitMatch && req.method === "POST") {
    const attempt = store.getAttempt(submitMatch[1]);
    if (!attempt || attempt.userId !== user.id) return send(res, 404, { error: "Attempt not found" });
    if (attempt.submittedAt)
      return send(res, 409, { error: "This attempt has already been submitted.", error_zh: "该答卷已提交。", code: "already_submitted", gradingStatus: attempt.gradingStatus || "final" });
    const { p, exam, rules } = examRulesOf(attempt);
    // Enforce the time limit server-side, with a 2-minute grace window for the
    // client countdown's auto-submit and network delay.
    if (rules.timeLimitMinutes) {
      const elapsed = Date.now() - new Date(attempt.startedAt).getTime();
      if (elapsed > (rules.timeLimitMinutes + 2) * 60 * 1000)
        return send(res, 400, { error: "Time limit exceeded — this attempt has expired. Please start a new exam." });
    }
    // Time limit is enforced HERE, not by the client countdown: a submission
    // that arrives after the deadline (page left open, clock tampered with) is
    // refused so the limit actually means something. 截止判定在任何 AI 评分之前（修复 P-7.9）。
    const deadline = attemptDeadline(attempt, rules.timeLimitMinutes);
    if (deadline && Date.now() > new Date(deadline).getTime() + 30_000) { // 30s grace for slow networks
      return send(res, 400, {
        error: "Time is up — this attempt can no longer be submitted. Please start a new one.",
        code: "timeup", deadline,
      });
    }
    const answers = body.answers || {};
    const blurCount = Math.max(0, Math.min(999, Number(body.blurCount) || 0));
    // 第四批 6.1：逐题按快照的题型评分（QT.gradeOne → parseAnswer + grade）。旧四种题型逐字照旧（单选 / 多选含半分 / 填空 / 简答待评），
    // 开考于改动前的答卷也按同样的快照形状评分；新题型的作答只认下标与字符串，越界、长度不对、不是排列一律当未作答（0 分）。
    // 不认识的题型按旧代码的 else 分支（简答）处理。
    const detail = attempt.questions.map((q) => QT.gradeOne(q, answers));
    // 每题分值：明细带上开考时快照的分值，scoreTotals 按它计分；旧答卷没有这个字段 → 旧口径
    for (const d of detail) { const src = attempt.questions.find((q) => q.id === d.id); if (src && src.points != null) d.points = src.points; }
    const opens = detail.filter((d) => d.type === "open");
    const gst = opens.length ? AI.featureState("grading") : { state: "none" };
    if (gst.state === "demo") {
      // 演示估分：只作展示（detail.demoEstimate），标注「演示估分，不计分」
      for (const d of opens) {
        const src = attempt.questions.find((q) => q.id === d.id) || {};
        d.demoEstimate = aiFeatures.demoEstimate(src.rubric || "", d.maxPoints, d.answer);
        d.ai = { demo: true, at: new Date().toISOString() };
      }
      AI.recordLocal("grading", { requestId, actorId: user.id, actorKind: "system", subjectUserId: user.id, refId: attempt.id, status: "demo" });
    } else if (opens.length && gst.state !== "on") {
      for (const d of opens) markOpenUnavailable(d, gst.state === "budget_exhausted" ? "ai_budget_exhausted" : "ai_not_configured");
    }
    const submittedAt = new Date().toISOString();
    const queued = opens.length > 0 && gst.state === "on";
    const lower = scoreDetail(detail);
    if (!store.submitAttempt(attempt.id, { submittedAt, answers, percent: lower, passed: false, detail, blurCount, gradingStatus: queued ? "grading" : "final" }))
      return send(res, 409, { error: "This attempt has already been submitted.", error_zh: "该答卷已提交。", code: "already_submitted" });
    let outcome;
    if (queued) {
      outcome = { status: "grading", percent: lower, passed: false, autoRetrained: false };
      enqueueGrading(attempt.id);
    } else {
      outcome = settleAttempt({ ...attempt, submittedAt, detail }, { atSubmit: true, requestId });
    }
    // When the exam hides answers afterwards (protects the question bank),
    // the employee's copy of the review omits correct answers and explanations.
    // The full detail is stored for HR either way.
    const showAnswers = rules.showAnswersAfterExam !== false;
    // Same title pair as GET /api/me/attempts/:id — the result page is rendered
    // from this response first and from that endpoint after a refresh, so sending
    // only English here made the exam name flip language on reload.
    return send(res, 200, { attemptId: attempt.id, percent: outcome.percent, passed: outcome.passed, gradingStatus: outcome.status, passingScore: rules.passingScore, showAnswers, autoRetrained: outcome.autoRetrained,
      detail: clientDetail(store.getAttempt(attempt.id).detail, showAnswers), name: user.name, submittedAt,
      programId: p ? p.id : null, programTitle: p ? p.title : null, programTitle_zh: p ? p.title_zh || null : null,
      examTitle: exam ? exam.title : null, examTitle_zh: exam ? exam.title_zh || null : null });
  }

  // --- AI study assistant（learning 路由；是否可用由 aiFeatureState 判定，方案 4.1） ---
  // 顺序：模块关闭 → 与不存在相同的 404；课程无权访问 → 404；功能关闭 / 未接入 / 预算用尽 → 403 / 503 / 429；
  // 考试进行中 → 409；演示模式 → 演示回复（不计限额）；限流 → 429；然后脱敏、放进数据区块、调用、记录。
  if (pathname === "/api/ai/assistant" && req.method === "POST") {
    const st = AI.featureState("assistant");
    if (st.state === "off_module" || st.state === "off_owner") return sendAiState(res, st);
    const c = getCourse(String(body.courseId || ""));
    if (!canAccessCourse(c)) return send(res, 404, { error: "Course not found" });
    const module = c.modules.find((m) => m.id === String(body.moduleId || "")) || c.modules[0];
    if (!module) return send(res, 404, { error: "Module not found" });
    if (!(body.messages || []).some((m) => String((m && m.content) || "").trim())) return send(res, 400, { error: "No message" });
    if (st.state !== "on" && st.state !== "demo") {
      if (st.state !== "off_feature") AI.recordLocal("assistant", { requestId, actorId: user.id, actorKind: "employee", refId: c.id, status: "blocked", errorCode: st.state === "budget_exhausted" ? "ai_budget_exhausted" : "ai_not_configured" });
      return sendAiState(res, st);
    }
    if (examInProgressForCourse(user.id, c.id)) {
      AI.recordLocal("assistant", { requestId, actorId: user.id, actorKind: "employee", refId: c.id, status: "blocked", errorCode: "ai_exam_in_progress" });
      return send(res, 409, { error: "The study assistant is unavailable during an exam.", error_zh: "考试进行中，学习助手暂不可用。", code: "ai_exam_in_progress" });
    }
    if (st.state === "demo") {
      const d = aiFeatures.assistantDemo(module);
      AI.recordLocal("assistant", { requestId, actorId: user.id, actorKind: "employee", refId: c.id, status: "demo" });
      return send(res, 200, { reply: d.en + "\n\n" + d.zh, demo: true });
    }
    const rl = AI.rateHit("assistant", user.id);
    if (!rl.ok) {
      AI.recordLocal("assistant", { requestId, actorId: user.id, actorKind: "employee", refId: c.id, status: "blocked", errorCode: "ai_rate_limited" });
      return sendAiRateLimited(res, rl.retryAfterSec);
    }
    const built = aiFeatures.buildAssistant({
      brand: brandCfg().name, course: c, module, messages: body.messages,
      self: { name: user.name, employeeId: user.employeeId }, managers: aiManagersOf(user), roster: aiRoster(),
    });
    if (!built.messages.length) return send(res, 400, { error: "No message" });
    try {
      const out = await AI.call("assistant", { requestId, actorId: user.id, actorKind: "employee", refId: c.id, system: built.system, messages: built.messages, redactions: built.redactions });
      return send(res, 200, { reply: out.text, model: out.provenance.modelReturned || out.provenance.model });
    } catch (e) {
      return sendAiError(res, e);
    }
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 10387–10555 行（/api/admin/ 块内）
    async adminCore1(C) {
      const { user, pathname, req, res, body, audit, query, requestId } = C;
      const { isSuperAdmin, DEPT_TREE_READ_DOMAINS, canRead, reviewAppealConsoleOk, rbacGate, send, INSTANCE_ID, store, BOOTED_AT, CACHE_REFRESHED_AT, readConfig, brandCfg, sanitizeBrandInput, writeBrandConfig, AI, aiDataflow, sendAiCalls, sendAiState, sendAiRateLimited, larkSyncCfg, larkSyncRunning, larksync, runLarkSync, modulesConfigOut, modulesOn, writeConfigPatch, require } = S;
    if (!isSuperAdmin(user)) {
      // M0 之后新增的 rbac:"custom" 后台路由的手写规则写在这里、先于 rbacGate 判定：rbacGate 必须与 M0 冻结的源码逐字相同
      // （test/m0-registry-equivalence 钉住），不能再往里加分支。undefined = 不归这里管，照旧走 rbacGate。
      //   W1c（第二批 3.1，2026-10-08）GET /api/admin/dept-tree：全站部门筛选的部门树，与 roster 同一批读者 —— people / learning /
      //   performance / talent 任一可读即放行，否则 404（与 none 域一致，不暴露端点存在）；其余方法交给 rbacGate（没有登记 → 403）。
      //   W2.8（第二批 2.8，2026-10-08）/api/admin/review-appeals*：绩效申诉台。生效中的 HRBP 分工（至少一个部门）或绩效可读 →
      //   放行；逐条可见性、可操作性在 handler 里按分工、数据范围与利益回避再判。否则 404（与 none 域一致）。其余方法不归这里管 → rbacGate（未登记 → 403）。
      //   动作路径用通配 /:id/:action（注册表的 samplePath 不接受「|」择一），动作在 handler 里判定。
      const raGateOne = pathname.match(/^\/api\/admin\/review-appeals\/([\w-]+)$/);
      const raGateAct = pathname.match(/^\/api\/admin\/review-appeals\/([\w-]+)\/([\w-]+)$/);
      let raGate = false;
      if (pathname === "/api/admin/review-appeals" && req.method === "GET") raGate = true;
      if (pathname === "/api/admin/review-appeals/coverage" && req.method === "PUT") raGate = true;
      if (raGateOne && req.method === "GET") raGate = true;
      if (raGateAct && req.method === "POST") raGate = true;
      const customErr = pathname === "/api/admin/dept-tree" && req.method === "GET"
        ? (DEPT_TREE_READ_DOMAINS.some((d) => canRead(user, d)) ? null : { status: 404, error: "Not found" })
        : raGate ? (reviewAppealConsoleOk(user) ? null : { status: 404, error: "Not found" })
        : undefined;
      const rbacErr = customErr !== undefined ? customErr : rbacGate(user, pathname, req.method);
      if (rbacErr) return send(res, rbacErr.status, { error: rbacErr.error });
    }

    // --- instance & integrity introspection（core，永不进 MODULE_ROUTES 关门清单） ---
    // /api/env 只给 8 位指纹；这里给全量：真实库路径、schema 版本、启动时刻、Node
    // 版本、内容缓存最后一次重建时刻 —— 「你连的是哪个库」一屏答完。
    if (pathname === "/api/admin/instance" && req.method === "GET") {
      return send(res, 200, {
        instance: INSTANCE_ID,
        dbPath: store.dbPath(),
        schemaVersion: store.schemaVersion(),
        bootedAt: BOOTED_AT,
        node: process.version,
        cacheRefreshedAt: CACHE_REFRESHED_AT,
      });
    }
    // 按需重跑启动时那套引用完整性体检，返回结构化明细（每类 kind/count/前 3 个样本）。
    // 站内信只说「发现 N 处」，明细在这里查 —— 不用翻启动日志。
    if (pathname === "/api/admin/integrity" && req.method === "GET") {
      return send(res, 200, { issues: store.checkReferences(), checkedAt: new Date().toISOString() });
    }

    // --- brand settings (white-label, admin-editable at runtime) ---
    // Returns ONLY brand material: the resolved values the UI is showing
    // (defaults merged, colors sanitized) plus the raw configured block, so the
    // settings page can tell "configured" from "default". NEVER the whole
    // config — config.json also holds Lark and AI secrets.
    if (pathname === "/api/admin/brand-config" && req.method === "GET") {
      const raw = readConfig().brand;
      const configured = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return send(res, 200, { brand: brandCfg(), configured });
    }
    if (pathname === "/api/admin/brand-config" && req.method === "PUT") {
      const src = body && typeof body.brand === "object" && !Array.isArray(body.brand) ? body.brand : body;
      const next = sanitizeBrandInput(src);
      const rawBefore = readConfig().brand;
      const before = rawBefore && typeof rawBefore === "object" && !Array.isArray(rawBefore) ? rawBefore : {};
      try {
        writeBrandConfig(next);
      } catch (e) {
        // Refuse rather than clobber: see writeBrandConfig on unparsable files.
        return send(res, 500, { error: "Could not update the config file: " + e.message });
      }
      audit("brand.update", null, before, next);
      // brandCfg() reads the config live, so the change is already in effect on
      // /api/env; echo the merged result so the page can refresh its preview.
      return send(res, 200, { ok: true, brand: brandCfg(), configured: next });
    }

    // --- AI 治理（方案 2.3、5.1）：状态、用量、调用记录属于 core（audit 域），ai 模块关闭后仍可只读查看；
    // 连接测试会产生真实调用，归 ai 模块（关闭即 404），并只限超级管理员。任何响应都不含密钥、请求头与查询参数的值。
    if (pathname === "/api/admin/ai-governance/status" && req.method === "GET") {
      return send(res, 200, { ...AI.status(), dataflow: aiDataflow(), canTest: isSuperAdmin(user) });
    }
    if (pathname === "/api/admin/ai-governance/usage" && req.method === "GET") {
      return send(res, 200, AI.usage());
    }
    if (pathname === "/api/admin/ai-governance/calls" && req.method === "GET") return sendAiCalls(res, user, query, false, audit);
    if (pathname === "/api/admin/ai-governance/calls.csv" && req.method === "GET") return sendAiCalls(res, user, query, true, audit);
    if (pathname === "/api/admin/ai-governance/test" && req.method === "POST") {
      if (!isSuperAdmin(user)) return send(res, 403, { error: "Only a super admin can run the connection test.", error_zh: "只有超级管理员可以运行连接测试。", code: "super_admin_only" });
      const st = AI.featureState("test");
      if (st.state === "demo") {
        AI.recordLocal("test", { requestId, actorId: user.id, actorKind: "admin", status: "demo" });
        return send(res, 200, { demo: true, results: [] });
      }
      if (st.state !== "on") return sendAiState(res, st);
      const rl = AI.rateHit("test", user.id);
      if (!rl.ok) return sendAiRateLimited(res, rl.retryAfterSec);
      const models = [...new Set(Object.entries(AI.status().provider.models || {}).filter(([k]) => k !== "test").map(([, v]) => v).filter(Boolean))];
      const results = [];
      for (const model of models) {
        const t0 = Date.now();
        try {
          const out = await AI.call("test", { requestId, actorId: user.id, actorKind: "admin", model, system: require("./modules/ai/prompts.js").TEST_SYSTEM, messages: [{ role: "user", content: "ping" }], schema: require("./modules/ai/prompts.js").TEST_SCHEMA });
          results.push({ model, ok: true, modelReturned: out.modelReturned || null, latencyMs: Date.now() - t0, usage: out.usage, structuredOutput: !!(out.json && out.json.ok === true) });
        } catch (e) {
          results.push({ model, ok: false, errorCode: (e && e.code) || "ai_upstream_error", reason: (e && e.reason) || null, redirectHost: (e && e.redirectHost) || null, latencyMs: Date.now() - t0 });
        }
      }
      audit("ai.test", null, null, { models, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.errorCode) });
      return send(res, 200, { results, url: AI.status().provider.url || null });
    }

    // --- 功能模块开关（负责人 9/28 决定，取代方案 8.3「开关只在配置文件」）：roles 域 = 只限超级管理员。
    // 可开关 learning / performance / talent / culture / ai 与 AI 的各项功能；写回 config.json（原子写、其它键原样保留，
    // 做法同品牌设置页）；每次修改记审计 module.config.change。密钥类（AI 密钥、culture.raterKey）不在页面上编辑。
    // 环境变量 LMS_MODULES_OFF 强制关闭的模块在页面上只读显示（优先于 config.json，改后需重启）。
    // Masterlist Base 同步：GET 看配置与上次报告；POST 立即执行（{ dryRun: true } 只预览不写库；{ force: true } 越过停用上限）。
    if (pathname === "/api/admin/lark-sync" && req.method === "GET") {
      if (!isSuperAdmin(user)) return send(res, 403, { error: "Super admin only" });
      const cfg = larkSyncCfg();
      let lastError = null;
      try { lastError = JSON.parse(store.getMeta("larksync.lastError") || "null"); } catch {}
      return send(res, 200, { configured: !!cfg, hour: cfg ? cfg.hour : null, running: !!larkSyncRunning, lastReport: larksync.lastReport(store), lastError });
    }
    if (pathname === "/api/admin/lark-sync" && req.method === "POST") {
      if (!isSuperAdmin(user)) return send(res, 403, { error: "Super admin only" });
      try {
        const rep = await runLarkSync({ dryRun: !!body.dryRun, force: !!body.force, actor: user, trigger: body.dryRun ? "preview" : "manual" });
        return send(res, 200, rep);
      } catch (e) {
        const code = (e && e.code) || "sync_failed";
        return send(res, code === "not_configured" ? 404 : code === "running" ? 409 : 502, {
          error: (e && e.message) || String(e), code,
          error_zh: code === "not_configured" ? "未配置 Lark 同步（config.json 的 lark.sync）。" : code === "running" ? "同步正在进行中。" : "同步失败：" + ((e && e.message) || e),
        });
      }
    }
    if (pathname === "/api/admin/modules-config" && req.method === "GET") {
      if (!isSuperAdmin(user)) return send(res, 403, { error: "Super admin only" });
      return send(res, 200, modulesConfigOut());
    }
    if (pathname === "/api/admin/modules-config" && req.method === "PUT") {
      if (!isSuperAdmin(user)) return send(res, 403, { error: "Super admin only" });
      const cur = readConfig();
      const rawMods = cur.modules && typeof cur.modules === "object" && !Array.isArray(cur.modules) ? { ...cur.modules } : {};
      const rawFeat = cur.ai && typeof cur.ai === "object" && cur.ai.features && typeof cur.ai.features === "object" ? { ...cur.ai.features } : {};
      const modsIn = body.modules && typeof body.modules === "object" ? body.modules : {};
      const featIn = body.aiFeatures && typeof body.aiFeatures === "object" ? body.aiFeatures : {};
      const nextMods = { ...rawMods }, nextFeat = { ...rawFeat };
      for (const [k, v] of Object.entries(modsIn)) {
        if (!Object.prototype.hasOwnProperty.call(modulesOn(), k)) return send(res, 400, { error: `Unknown module "${k}".`, error_zh: `没有「${k}」这个模块。`, code: "unknown_module" });
        if (typeof v !== "boolean") return send(res, 400, { error: "Module switches must be true or false.", error_zh: "模块开关只能是开或关。", code: "bad_value" });
        nextMods[k] = v;
      }
      for (const [k, v] of Object.entries(featIn)) {
        if (!AI.FEATURE_IDS.includes(k)) return send(res, 400, { error: `Unknown AI feature "${k}".`, error_zh: `没有「${k}」这项 AI 功能。`, code: "unknown_feature" });
        if (typeof v !== "boolean") return send(res, 400, { error: "Feature switches must be true or false.", error_zh: "功能开关只能是开或关。", code: "bad_value" });
        nextFeat[k] = v;
      }
      const changed = JSON.stringify(nextMods) !== JSON.stringify(rawMods) || JSON.stringify(nextFeat) !== JSON.stringify(rawFeat);
      if (!changed) return send(res, 200, { ok: true, unchanged: true, ...modulesConfigOut() });
      try {
        writeConfigPatch((cfg) => {
          cfg.modules = { ...(cfg.modules && typeof cfg.modules === "object" && !Array.isArray(cfg.modules) ? cfg.modules : {}), ...nextMods };
          if (Object.keys(featIn).length) {
            const ai = cfg.ai && typeof cfg.ai === "object" && !Array.isArray(cfg.ai) ? cfg.ai : {};
            ai.features = { ...(ai.features && typeof ai.features === "object" ? ai.features : {}), ...nextFeat };
            cfg.ai = ai;
          }
        });
      } catch (e) {
        return send(res, 500, { error: "Could not update the config file: " + e.message, error_zh: "无法写入配置文件。", code: "config_write_failed" });
      }
      audit("module.config.change", null, { modules: rawMods, aiFeatures: rawFeat }, { modules: nextMods, aiFeatures: Object.keys(featIn).length ? nextFeat : rawFeat });
      AI.checkConfigChange();
      return send(res, 200, { ok: true, ...modulesConfigOut() });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 10758–11125 行（/api/admin/ 块内）
    async adminCore2(C) {
      const { pathname, req, res, examPoolBreakdown, validateExam, body, user, audit, query } = C;
      const { store, send, examQuestions, QT, getProgram, refreshContent, TPROJECTS, tpActivities, scopePredicate, isSuperAdmin, getCourse } = S;
    const examRoute = pathname.match(/^\/api\/admin\/exams\/([\w-]+)$/);
    if (examRoute && req.method === "GET") {
      const e = store.getExam(examRoute[1]);
      if (!e) return send(res, 404, { error: "Exam not found" });
      // Pool sizes so the editor can warn about an impossible draw count while
      // you type, rather than rejecting it on save. Same derivation as the list.
      const ePool = examQuestions(e);
      return send(res, 200, {
        ...e,
        courseIds: store.getExamCourseIds(e.id),
        poolObjective: ePool.filter((q) => QT.groupOf(q.type) === "objective").length,
        poolOpen: ePool.filter((q) => q.type === "open").length,
        ...examPoolBreakdown(ePool),   // 第四批：poolCase、poolByType
      });
    }
    if (examRoute && req.method === "PUT") {
      const e = store.getExam(examRoute[1]);
      if (!e) return send(res, 404, { error: "Exam not found" });
      const program = getProgram(e.programId);
      const v = validateExam(body, program, e.id);
      if (v.error) return send(res, 400, { error: v.error, ...(v.error_zh ? { error_zh: v.error_zh } : {}), ...(v.code ? { code: v.code } : {}) });
      const beforeExam = { ...e, courseIds: store.getExamCourseIds(e.id) };
      store.updateExam(e.id, v.exam);
      store.setExamCourses(e.id, v.courseIds);
      store.snapshotContent("exam", e.id, { ...v.exam, courseIds: v.courseIds }, user.id);
      audit("exam.update", e.id, beforeExam, { ...v.exam, courseIds: v.courseIds });
      return send(res, 200, { ok: true });
    }
    const examQsRoute = pathname.match(/^\/api\/admin\/exams\/([\w-]+)\/questions$/);
    if (examQsRoute && req.method === "GET") {
      const e = store.getExam(examQsRoute[1]);
      if (!e) return send(res, 404, { error: "Exam not found" });
      const ids = new Set(store.getExamCourseIds(e.id));
      return send(res, 200, store.listQuestions().filter((q) => ids.has(q.courseId)));
    }
    // 课程编辑器右栏「需要结业考试」开关（考试规则本身只在「考试」页编辑）。
    // 关：把这门课（包装程序）下所有已发布考试改为「已下线」，历史答卷保留；有未结束的培养项目
    //     以「考试」活动引用这些考试时拒绝，并列出项目。noExam 只是界面状态，完成口径看的是
    //     「有没有已发布考试」（programDone）。
    // 开：重新发布最近下线的那场考试（照常过 validateExam 的题量校验）；没有可恢复的考试时提示去考试页新建。
    const examReqRoute = pathname.match(/^\/api\/admin\/programs\/([\w-]+)\/exam-required$/);
    if (examReqRoute && req.method === "POST") {
      const p = getProgram(examReqRoute[1]);
      if (!p) return send(res, 404, { error: "Program not found" });
      const required = body.required === true;
      const all = store.listProgramExams(p.id);
      const setNoExam = (flag) => {
        if (!!p.noExam === flag) return;
        const updated = { ...p, noExam: flag };
        store.putContent("program", p.id, updated);
        store.snapshotContent("program", p.id, updated, user.id);
        audit("program.update", p.id, { noExam: !!p.noExam }, { noExam: flag });
        refreshContent();
      };
      if (!required) {
        const live = all.filter((e) => e.status === "published");
        const liveIds = new Set(live.map((e) => e.id));
        // A published exam that reaches past this one course — owned by another
        // package (e.g. a multi-course onboarding exam), or also covering other
        // courses — cannot be switched off from a single course: archiving it would
        // silently drop the exam for every other course too, and leaving it would
        // keep the switch stuck "on". Send HR to the Exams page instead.
        const ownCourses = new Set(Array.isArray(p.courseIds) ? p.courseIds : []);
        const shared = store.listExams().filter((e) => {
          if (e.status !== "published") return false;
          const cids = store.getExamCourseIds(e.id);
          if (!cids.some((cid) => ownCourses.has(cid))) return false;
          return e.programId !== p.id || cids.some((cid) => !ownCourses.has(cid));
        });
        if (shared.length) {
          const names = (zh) => shared.map((e) => (zh ? e.title_zh || e.title : e.title || e.title_zh) || e.id).join(zh ? "、" : "; ");
          return send(res, 409, {
            error: `This course is also covered by exams shared with other courses: ${names(false)}. Remove this course from them on the Exams page instead.`,
            error_zh: `本课程还被与其他课程共用的考试覆盖：${names(true)}。请到「考试」页把本课程从这些考试中移除。`,
            code: "exam_shared", exams: shared.map((e) => e.id),
          });
        }
        const projects = [];
        for (const doc of TPROJECTS) {
          if (doc.status === "closed") continue; // 已结束的项目只剩历史，下线考试不影响已有成绩
          for (const cohort of doc.cohorts || []) {
            const acts = tpActivities(cohort).filter((a) => a.type === "exam" && liveIds.has(a.refId));
            if (acts.length) projects.push({ id: doc.id, title: doc.title, title_zh: doc.title_zh || null, cohort: cohort.name || null, activities: acts.length });
          }
        }
        if (projects.length) {
          const names = (zh) => projects.map((x) => `${(zh ? x.title_zh || x.title : x.title || x.title_zh)}${x.cohort ? ` · ${x.cohort}` : ""}`).join(zh ? "、" : "; ");
          return send(res, 409, {
            error: `This course's exam is used by development programs: ${names(false)}. Remove the exam activity from them first.`,
            error_zh: `本课程的考试正被发展项目引用：${names(true)}。请先在发展项目中移除该考试活动，再关闭结业考试。`,
            code: "exam_in_project", projects,
          });
        }
        for (const e of live) {
          store.updateExam(e.id, { ...e, status: "archived" });
          audit("exam.update", e.id, { status: e.status }, { status: "archived", via: "course.no-exam" });
        }
        setNoExam(true);
        return send(res, 200, { ok: true, required: false, archived: live.map((e) => e.id) });
      }
      // 开
      if (all.some((e) => e.status === "published")) { setNoExam(false); return send(res, 200, { ok: true, required: true, republished: null }); }
      const archived = all.filter((e) => e.status === "archived")
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      const last = archived[0];
      if (!last) {
        const draft = all.find((e) => e.status === "draft") || null;
        setNoExam(false);
        return send(res, 200, {
          ok: true, required: true, republished: null, needsExam: true, draftExamId: draft ? draft.id : null,
          message: draft ? "There is a draft exam for this course — publish it on the Exams page." : "This course has no exam yet — create one on the Exams page.",
          message_zh: draft ? "本课程有一场草稿考试，请到「考试」页发布。" : "本课程还没有考试，请到「考试」页新建。",
        });
      }
      const v = validateExam({ ...last, status: "published", courseIds: store.getExamCourseIds(last.id) }, p, last.id);
      if (v.error) return send(res, 400, { error: v.error, error_zh: "无法重新发布原考试：" + v.error, code: "republish_invalid", examId: last.id });
      store.updateExam(last.id, v.exam);
      store.setExamCourses(last.id, v.courseIds);
      audit("exam.update", last.id, { status: last.status }, { status: "published", via: "course.exam-required" });
      setNoExam(false);
      return send(res, 200, { ok: true, required: true, republished: last.id });
    }

    // Append-only audit trail — read-only even for admins.
    if (pathname === "/api/admin/audit" && req.method === "GET") {
      // F1：审计窗口稀释的修复。原先本端点**只有 limit**，筛选全在浏览器做，于是
      // 「最近 2000/5000 行」就是可见性的天花板：manager.view_profile（P3 起经理每翻
      // 一个下属就落一行）与 auth.* 同为高频行，足以把 auth.login_failed（撞密码）与
      // employee.update（档案变更）挤出窗口——「谁看过谁」查得到了，别的反而更难查。
      // 所以筛选下推到服务端：action / actor / since / until 在**全表**上筛，limit+offset
      // 只决定取哪一段，total 永远是「筛过 + 范围过」的真实可见条数。
      // 兼容红线：不带任何新参数（无 action/actor/since/until、offset=0）时，走的是与
      // 改动前一字不差的老路径（listAudit(limit) + countAudit()），既有调用方与冒烟无感。
      const auditLimit = Math.min(Math.max(parseInt(query.get("limit") || "2000", 10) || 2000, 1), 5000);
      const auditOffset = Math.max(parseInt(query.get("offset") || "0", 10) || 0, 0);
      // action：按**点分段**匹配——action=auth 命中 auth.login / auth.lark.jit；
      // action=auth.login_failed 只命中它自己（不会连带 auth.login_failed_x 之类）。
      // 前缀式让「只看登录相关」与「只看某一个动作」用同一个参数表达。
      const auditAction = String(query.get("action") || "").trim();
      // actor：操作人。工号/actorId 精确命中，或操作人姓名子串（不分大小写）——
      // 后台记的 actorId 是 users.id，actorName 是当时的姓名，两者都可能是人要找的那个。
      const auditActor = String(query.get("actor") || "").trim();
      const auditActorLc = auditActor.toLowerCase();
      // since / until：createdAt 是 toISOString() 的 UTC 串，字典序 == 时间序，所以
      // 直接字符串比较即可。只给日期（YYYY-MM-DD）时 until 补到当日末尾，否则
      // until=2026-09-03 会把 9 月 3 日整天都排除掉（含头不含尾的老坑）。
      // ⚠ **读不出来的时间参数一律当作没给**，绝不能让它去参与字符串比较：createdAt 是
      // "2026-…" 开头，拿它跟 "garbage" 比大小不抛错、但按字节序 "2026…" < "garbage"
      // 恒成立，于是 ?since=garbage 会把**每一行**都筛掉，页面静悄悄空一片——一个打错的
      // 筛选参数看起来就像「这段时间没有任何审计记录」，这在审计页上是最坏的失败方式。
      // 所以先 Date 解析，解析不出就退化成不按时间筛（宁可多给、不可假空）。顺带把
      // 带时区偏移的写法（…T00:00+08:00）也归一成 UTC ISO，否则同样是拿本地串跟 UTC
      // 串比字节序。归一后与旧式的纯 ISO / YYYY-MM-DD 输入逐字等价。
      const auditIso = (s) => { const t = new Date(s).getTime(); return Number.isNaN(t) ? "" : new Date(t).toISOString(); };
      const auditSince = auditIso(String(query.get("since") || "").trim());
      const auditUntilRaw = String(query.get("until") || "").trim();
      // 只给日期（YYYY-MM-DD）时补到当日末尾，否则 until=2026-09-03 会把 9 月 3 日
      // 整天都排除掉（含头不含尾的老坑）。
      const auditUntil = /^\d{4}-\d{2}-\d{2}$/.test(auditUntilRaw)
        ? auditUntilRaw + "T23:59:59.999Z"
        : auditIso(auditUntilRaw);
      // 便宜筛（纯字段比较，零 DB 查询）。范围过滤要解析目标员工、要查 users，是贵的那层。
      const auditCheap = (r) => {
        if (auditAction) {
          const a = String(r.action || "");
          if (a !== auditAction && !a.startsWith(auditAction + ".")) return false;
        }
        if (auditActorLc) {
          const hit = String(r.actorId || "") === auditActor
            || String(r.actorName || "").toLowerCase().includes(auditActorLc);
          if (!hit) return false;
        }
        // 时间比较只在**读得出**的时间戳上做：createdAt 空/缺的行照旧可见——审计行
        // 绝不能因为时间戳读不出来就消失（与 Audit.jsx 原先的前端筛一个口径）。
        if (auditSince && r.createdAt && String(r.createdAt) < auditSince) return false;
        if (auditUntil && r.createdAt && String(r.createdAt) > auditUntil) return false;
        return true;
      };
      // 只看**生效**的筛选（读不出的时间参数已归零），所以一个打错的 until 不会白白
      // 把请求推离 SQL 快路径去扫全表。
      const auditFiltered = !!(auditAction || auditActor || auditSince || auditUntil);
      // since 的提前收尾：audit_logs 按 id DESC 取，而 addAudit 是插入当刻打 createdAt，
      // 所以 id 序 == 时间序，扫到比 since 更早的行之后就再无命中，可以停。**留 24 小时
      // 的余量**才停：万一宿主机对过一次时钟（NTP 回跳几秒），严格按 since 停会把回跳
      // 窗口里的行整段丢掉——审计行宁可多扫一天也不能丢。默认的「近 7 天」正是靠这条
      // 把全表扫描收敛成「7 天 + 1 天」，否则每次开页都要走完整张只增不减的表。
      // auditSince 到这里已经是归一过的 ISO 串或空串（读不出的已当作没给），所以
      // 减 24 小时这步不会再碰到 NaN——曾经这行无条件求值，new Date(NaN).toISOString()
      // 抛 RangeError("Invalid time value")，?since=garbage 就是个 500。
      const auditStopBefore = auditSince
        ? new Date(new Date(auditSince).getTime() - 86400000).toISOString()
        : null;
      const auditPastSince = (r) => !!(auditStopBefore
        && r.createdAt && String(r.createdAt) < auditStopBefore);
      // The stored target is an internal id. Resolve the ones we can into a
      // label a person recognises, keeping the raw id alongside for support.
      // Returns the BILINGUAL pair { label, label_zh } the log table needs. The
      // only piece of any label that really has two languages is an exam title
      // (exams carry title_zh); people's names, employee ids, department names
      // and review-cycle names are single-language strings as typed, so for
      // those label_zh is deliberately the SAME text — loc() then renders it in
      // either language instead of falling back to the raw id.
      const one = (s) => (s ? { label: s, label_zh: s } : null);
      // Per-request memo for employee-ID → user. store.getUserByEmployeeId()
      // compares lower(employeeId), which SQLite cannot answer from the UNIQUE
      // index, so every call is a full SCAN of users (measured: 2000 lookups
      // over 927 people = 114 ms, vs 22 ms on the index). Harmless while
      // employee.* rows were a handful; auth.* rows now dominate the 2000-row
      // window, so one lookup per DISTINCT id instead of per row keeps this
      // page's cost where it was. Same rows in, same labels out.
      const userByEmpId = new Map();
      const lookupEmpId = (id) => {
        if (!userByEmpId.has(id)) userByEmpId.set(id, store.getUserByEmployeeId(id));
        return userByEmpId.get(id);
      };
      const courseGoneName = new Map();   // CX-208：已删除课程 id → 删除时记下的名称（每个请求查一次）
      const labelForTarget = (action, target, row) => {
        if (!target) return null;
        const kind = String(action || "").split(".")[0];
        try {
          // CX-206：删除课程 / 随课程删除题目的对象是课程 id —— 课程还在就用现名，已删除则取这一行审计里记下的课程名
          // CX-208：课程的其他审计行（创建、更新、发布…）在课程删除后同样取名称：本行记下的名称 → 该课程删除时记下的名称
          if (kind === "course" || action === "question.course-deleted") {
            const c = getCourse(target);
            if (c) return { label: c.title || c.title_zh || target, label_zh: c.title_zh || c.title || target };
            const nameIn = (r0) => {
              let b = null, af = null;
              try { b = r0 && r0.beforeJson ? JSON.parse(r0.beforeJson) : null; af = r0 && r0.afterJson ? JSON.parse(r0.afterJson) : null; } catch { /* ignore */ }
              const en = (af && af.title) || (b && b.title) || null, zh = (af && af.title_zh) || (b && b.title_zh) || en;
              return en || zh ? { label: en || zh, label_zh: zh || en } : null;
            };
            const own = nameIn(row);
            if (own) return own;
            if (!courseGoneName.has(target)) courseGoneName.set(target, store.listAuditByTargetsAny(["course.delete", "question.course-deleted"], [target]).map(nameIn).find(Boolean) || null);
            return courseGoneName.get(target);
          }
          if (kind === "employee") {
            const u = store.getUserById(target) || lookupEmpId(target);
            return u ? one(`${u.name} (${u.employeeId})`) : null;
          }
          // auth.* (login / login_failed / logout / sessions_revoked / lark.*)
          // stores the submitted or resolved EMPLOYEE ID. Resolving it puts a
          // name on the row; a failed attempt on an id nobody owns — or the
          // "(malformed)" placeholder — resolves to nothing and the raw string
          // is shown as-is, which is exactly what the incident is.
          if (kind === "auth") {
            const u = lookupEmpId(target);
            return u ? one(`${u.name} (${u.employeeId})`) : null;
          }
          // manager.* (P3/D8: a manager reading a report's profile) stores the
          // VIEWED person's employee id — same shape as auth.*, so the row reads
          // "who read whom" instead of a bare id.
          if (kind === "manager") {
            const u = lookupEmpId(target);
            return u ? one(`${u.name} (${u.employeeId})`) : null;
          }
          // CX-086（10/11 上线前测试）：行为实践查看他人档案摘要 / 任务（culture.people.*）存的是被查看者的 userId
          if (/^culture\.people\./.test(String(action || ""))) {
            const u = store.getUserById(target);
            return u ? one(`${u.name} (${u.employeeId})`) : null;
          }
          if (kind === "attempt") {
            const a = store.getAttempt(target);
            if (!a) return null;
            const u = store.getUserById(a.userId);
            const ex = a.examId ? store.getExam(a.examId) : null;
            const join = (t) => [u && u.name, t].filter(Boolean).join(" · ") || null;
            const en = join(ex && ex.title);
            if (!en) return null;
            // The exam may have no title_zh — fall back to its English title so
            // the Chinese row still names the exam instead of dropping it.
            return { label: en, label_zh: join(ex && (ex.title_zh || ex.title)) || en };
          }
          if (kind === "review") {
            const c = store.getReviewCycle(target);
            if (c) return one(c.name);
            const it = store.getReviewItem && store.getReviewItem(target);
            if (it) { const u = store.getUserById(it.userId); return u ? one(u.name) : null; }
            return null;
          }
          if (kind === "department") {
            const d = store.listDepartments(true).find((x) => x.id === target);
            return d ? one(d.name) : null;
          }
        } catch { /* a resolvable-looking id that no longer exists is not an error */ }
        return null;
      };
      // D7：审计按范围过滤。判据 = 一行审计的**目标解析出的员工**是否在范围内。
      // 解析口径必须与 labelForTarget 一字不差（同一份 memo、同一套 try/catch、同样的
      // kind 分派），否则「显示的名字」与「能不能看见这行」会在分叉处泄露。这里只返回
      // user（或 null），scopeAllowsUser 用它做 O(1) 判定——不新起任何全表 SCAN。
      // 无员工主体的行（配置/品牌/角色/部门/review-cycle 等）resolve 为 null。
      const resolveTargetUser = (action, target) => {
        if (!target) return null;
        const kind = String(action || "").split(".")[0];
        try {
          if (kind === "employee") return store.getUserById(target) || lookupEmpId(target);
          if (kind === "auth") return lookupEmpId(target);
          // manager.*：主体是被查看的员工（存 employeeId）。必须与上面 labelForTarget
          // 的 manager 分支一字同口径，否则「显示的名字」与「看不看得见这行」会分叉。
          if (kind === "manager") return lookupEmpId(target);
          if (/^culture\.people\./.test(String(action || ""))) return store.getUserById(target);   // CX-086：与 labelForTarget 同口径
          if (kind === "attempt") { const a = store.getAttempt(target); return a ? store.getUserById(a.userId) : null; }
          if (kind === "review") {
            // review cycle（周期）无员工主体；review item（某人的一条）才有。
            if (store.getReviewCycle(target)) return null;
            const it = store.getReviewItem && store.getReviewItem(target);
            return it ? store.getUserById(it.userId) : null;
          }
          // department / config / brand / role / …：无员工主体 → null。
          // 注意 role.assign 的 target 虽是某员工的 employeeId，但 kind=role，
          // labelForTarget 也不解析它（无 role 分支，向来显示裸 id），这里同口径按
          // 无主体隐藏——它是提权面（谁被授了后台角色），对范围受限审计员保守屏蔽，
          // 与设计稿「角色…无员工主体的操作→隐藏」一字相合。
        } catch { /* 悬空 id 不是错误，当作无主体处理 */ }
        return null;
      };
      const mapRow = (r) => {
        const lb = labelForTarget(r.action, r.target, r);
        return {
          id: r.id, actor: r.actorName, actorId: r.actorId, action: r.action, target: r.target,
          // Sent as a pair so the log table can loc() it. Both null when the id
          // resolved to nothing — the table then shows the raw target, as before.
          targetLabel: lb ? lb.label : null,
          targetLabel_zh: lb ? lb.label_zh : null,
          before: r.beforeJson ? JSON.parse(r.beforeJson) : null,
          after: r.afterJson ? JSON.parse(r.afterJson) : null,
          requestId: r.requestId, createdAt: r.createdAt,
        };
      };
      const auditScope = scopePredicate(user); // null = 超管/空范围 = 不按范围过滤
      // 第二批 2.8（安全审查 1）：本人回避 —— 非超级管理员看不到以自己为主体的申诉审计、本人评级修改审计（理由、原评级）
      // 与本人绩效记录的修改审计。只有这个人确实有这类审计行时才逐行判定（否则仍走下面的原样快路径）。
      const auditSelfHide = !isSuperAdmin(user) && store.auditHasSelfSensitive(user.id) ? (r) => {
        if (String(r.action).startsWith("review.appeal.")) { const t = resolveTargetUser(r.action, r.target); return !!t && t.id === user.id; }
        if (r.action === "talent.record.rating-amend") { try { const a = JSON.parse(r.afterJson || "null"); return !!a && a.userId === user.id; } catch { return false; } }
        if (r.action === "talent.record.update") { const rec = store.getTalentRecord(r.target); return !!rec && rec.userId === user.id && rec.type === "performance"; }
        return false;
      } : null;
      if (!auditScope && !auditFiltered && !auditSelfHide) {
        // 老路径，一字不变：超管/空范围角色 + 不带任何筛选参数。窗口取 auditLimit 行
        // （offset 默认 0 时与改动前完全相同），total 报库内真实总数（countAudit）。
        // offset>0 时也走这里：SQL 自己会 OFFSET，不必扫表——total 仍是库内总数，因为
        // 没有任何过滤，「可见总数」就是「库内总数」。
        const auditRows = store.listAudit(auditLimit, auditOffset).map(mapRow);
        const auditTotal = store.countAudit();
        return send(res, 200, {
          rows: auditRows, total: auditTotal, limit: auditLimit, offset: auditOffset,
          truncated: auditTotal > auditOffset + auditRows.length,
        });
      }
      // ——— 两层过滤：便宜筛(action/actor/时间) → 范围筛(D7) ———
      // 顺序与理由：两层都是 AND，**结果集与顺序无关**（可交换），所以顺序纯粹是成本问题。
      // 便宜筛只比字段（零 DB 查询）；范围筛要 resolveTargetUser() 去 users 里解析目标员工。
      // 先便宜后昂贵 ⇒ 筛得越窄，这趟全表扫描要付的用户解析越少（action=auth.login_failed
      // 时几乎不解析）。**范围筛永远是最后那道无条件的闸**：任何 action/actor/时间参数都
      // 只可能让结果更少，绝无可能让范围受限角色多看到一行范围外的记录（这一点由
      // test/audit-filter.test.js 的「两层叠加」用例钉住）。auditScope 为 null（超管/空范围）
      // 时该闸退化为放行，于是本分支同时也是「超管 + 带筛选」的路径。
      //
      // total 必须 =「筛过 + 范围过」之后的**全表**真实可见条数，不能只数窗口内的：
      // D7 时踩过一次「total 报的是取回条数」，让「共 N 条」变成谎话、页码档位永远空。
      // 所以照旧扫全表来数，内存钉在「原始行一页 + 已物化 ≤auditLimit 行」上。
      // rows 则是这条筛过的序列里 [offset, offset+limit) 那一段——offset 数的是**筛过后**
      // 的序号（不是库里的行号），这才让翻页不重不漏：第 n 页永远接着第 n-1 页。
      const AUDIT_PAGE = 2000;
      const auditRows = [];
      let auditTotal = 0;
      for (let off = 0; ; off += AUDIT_PAGE) {
        const batch = store.listAudit(AUDIT_PAGE, off);
        if (batch.length === 0) break;
        let auditDone = false;
        for (const r of batch) {
          if (auditPastSince(r)) { auditDone = true; break; } // 已越过 since（含余量）→ 收尾
          if (!auditCheap(r)) continue;                 // 第一层：便宜筛
          if (auditSelfHide && auditSelfHide(r)) continue;   // 本人回避（第二批 2.8）
          if (auditScope) {                              // 第二层：范围筛（无条件）
            const u = resolveTargetUser(r.action, r.target);
            if (!u || !auditScope(u)) continue;          // 无员工主体 or 范围外 → 隐藏
          }
          // 通过两层的第 auditTotal 行（0 基）——落在本页窗口里才物化（labelForTarget 才跑）。
          if (auditTotal >= auditOffset && auditRows.length < auditLimit) auditRows.push(mapRow(r));
          auditTotal += 1;
        }
        if (auditDone || batch.length < AUDIT_PAGE) break;
      }
      return send(res, 200, {
        rows: auditRows, total: auditTotal, limit: auditLimit, offset: auditOffset,
        truncated: auditTotal > auditOffset + auditRows.length,
      });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 11159–11833 行（/api/admin/ 块内）
    async adminCore3(C) {
      const { pathname, req, user, res, body, audit, auditAuth, requestId } = C;
      const { scopePredicate, store, deptFilterFor, send, isSuperAdmin, canWrite, scopeAllowsDeptFor, sendScopeDeptReject, sendScopeBulkReject, isAdmin, runBatch, canonicalDept, bulkFaultPoint, sendBatchFailed, afterCommit, getProgram, LC, programProgress, PROGRAMS, programHasExam, bestAttempt, tagsForViewer, scopeAllowsFor, CT, appealToday, nowMs, parseTags, clampText, normalizeEmail, EMAIL_RE, findUserByEmail, managerCycle, validDateStr, buildRecordDetail, programDone, programMetaOf, COMPLETION, coursesInProgram, userProgress, scopeDeptPredicate, buildTalentTimeline, perfAmendDecorate, modulesOn, canRead, parseExtras, decorateSecondaryLines, recordTypesOut, jobGrades, profileTabsFor } = S;
    if (pathname === "/api/admin/dept-tree" && req.method === "GET") {
      const dtScope = scopePredicate(user);
      const pool = store.listUsers().filter((u) => !(u.role === "admin" && !u.department && !u.position && !u.hireDate) && (!dtScope || dtScope(u)));
      const tree = deptFilterFor(user).options(pool, { counts: true });
      return send(res, 200, { ...tree, hasNone: pool.some((u) => !u.department || !String(u.department).trim()) });
    }
    // Bulk edit of people fields: department / manager / active.
    if (pathname === "/api/admin/employees/bulk-update" && req.method === "POST") {
      const userIds = Array.isArray(body.userIds) ? body.userIds : [];
      const f = body.fields || {};
      if (!userIds.length) return send(res, 400, { error: "No employees selected." });
      // Cap like bulk-reset (LMS_RESET_CAP): NEVER truncate silently — the old
      // slice(0, 3000) dropped the tail of a big selection with no signal.
      // Tunable via LMS_BULK_CAP (default 10000 — the whole ~4,000-person company
      // must fit in one batch with headroom). The same knob also caps the three
      // people imports: employees/bulk, records/bulk, secondary-lines/bulk.
      const bulkCapRaw = Math.floor(Number(process.env.LMS_BULK_CAP));
      const bulkCap = Number.isFinite(bulkCapRaw) && bulkCapRaw > 0 ? bulkCapRaw : 10000;
      if (userIds.length > bulkCap)
        return send(res, 400, {
          error: `Selected ${userIds.length} people, but one batch is capped at ${bulkCap} — filter (e.g. by department) and update in smaller batches. `
            + `本次选中 ${userIds.length} 人，单次上限 ${bulkCap} 人：请按部门筛选分批更新。`,
          code: "over_cap", selected: userIds.length, cap: bulkCap,
        });
      // Field-level guard (design §5 ④⑤, D6 细化): role / adminRoleId are the
      // privilege-escalation face → super-admin only (else the domain model is
      // bypassed by a single field). active is now the accounts domain → needs
      // accounts=manage. potential is the talent 9-box axis → needs talent=manage.
      // department / managerId are people and already gated by the route matrix.
      // Per-target scope for active is enforced by the batch scope check below
      // (any out-of-scope target → whole-batch reject), so an accounts-manager can
      // only toggle people inside their scope.
      if (!isSuperAdmin(user)) {
        if (f.role !== undefined || f.adminRoleId !== undefined
            || body.role !== undefined || body.adminRoleId !== undefined)
          return send(res, 403, { error: "Only a super-admin can change role or admin role. 仅超级管理员可修改账号类型/后台角色。" });
        if (f.active !== undefined && !canWrite(user, "accounts"))
          return send(res, 403, { error: "Changing active status requires manage rights on the accounts domain. 修改在职/停用状态需要员工账号域的管理权限。" });
        if (f.potential !== undefined && !canWrite(user, "talent"))
          return send(res, 403, { error: "Changing potential requires manage rights on the talent domain. 修改潜力需要人才发展域的管理权限。" });
      }
      const fields = {};
      if (f.department !== undefined) fields.department = String(f.department || "").trim() || null;
      if (f.managerId !== undefined) {
        const mid = String(f.managerId || "");
        if (mid && !store.getUserById(mid)) return send(res, 400, { error: "Manager not found" });
        fields.managerId = mid || null;
      }
      if (f.active !== undefined) fields.active = f.active ? 1 : 0;
      // Potential is the 9-box's vertical axis and it is a judgement HR makes in
      // a talent-review meeting — for a whole department at once, not one profile
      // page at a time. Without a bulk path the grid stays empty however much
      // performance data the review cycles produce.
      if (f.potential !== undefined) {
        const v = String(f.potential || "").trim();
        if (v && !["High", "Medium", "Low"].includes(v)) return send(res, 400, { error: "potential must be High, Medium or Low" });
        fields.potential = v || null;
      }
      if (!Object.keys(fields).length) return send(res, 400, { error: "Nothing to update." });
      // P2 范围：**逐条**校验（§9 ② 的两层危险都要堵）。
      //  (a) 每个目标员工的**现**部门必须在范围内 → 任一越界即整批拒绝（设计选择①）；
      //  (b) 目标部门 fields.department 本身也必须在范围内，否则一个范围受限的角色能把
      //      自己范围内的 3000 人「推出」范围——推出去之后他自己再也看不到，谁干的都查不出，
      //      只剩审计日志一行 count。这是提权，不是可用性问题。
      const bulkScope = scopePredicate(user);
      if (bulkScope) {
        // 含**清空为 null**：没有部门的人在范围生效时不可见，所以「清空」与「调到范围外」
        // 是同一个动作（把人推出自己的可见范围），与 PUT /employees/:id 逐字同口径。
        if (fields.department !== undefined && !scopeAllowsDeptFor(user, fields.department))
          return sendScopeDeptReject(res);
        let outOfScope = 0;
        for (const uid of userIds) {
          const t = store.getUserById(uid);
          if (t && !bulkScope(t)) outOfScope++;   // 查无此人仍按原样（下面 continue）
        }
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      // D6 fix (account-integrity): mirror the single-PUT guard — a non-super
      // accounts-manager must not deactivate ADMIN accounts in bulk either.
      // Whole-batch reject if any target is an admin account, so the caller never
      // "thinks they deactivated 50" while admin rows were silently skipped.
      if (fields.active === 0 && !isSuperAdmin(user)) {
        let adminsHit = 0;
        for (const uid of userIds) {
          const t = store.getUserById(uid);
          if (t && t.id !== user.id && isAdmin(t)) adminsHit++;
        }
        if (adminsHit) return send(res, 403, { error: "Only a super-admin can deactivate an admin account; this batch includes " + adminsHit + ". 仅超级管理员可停用管理员账号，本次包含 " + adminsHit + " 个。" });
      }
      // D6 fix: same last-active-super-admin invariant as PUT /employees/:id — a
      // non-super accounts-manager can deactivate in bulk, so refuse a batch that
      // would drop the last active super-admin to zero. Self is never deactivated
      // (stripped per-row below), so it is excluded from the tally and stays active.
      if (fields.active === 0) {
        let supersHit = 0;
        for (const uid of userIds) {
          const t = store.getUserById(uid);
          if (t && t.id !== user.id && isSuperAdmin(t) && t.active !== 0) supersHit++;
        }
        if (supersHit && store.countActiveSuperAdmins() - supersHit < 1)
          return send(res, 400, { error: "That would deactivate the last active super-admin — assign another first. 这会停用最后一个活跃超级管理员，请先指派其他人。" });
      }
      // Reporting-loop guard (2026-09-25, Chelsea: 整批拒绝). Same rule as the
      // single PUT's managerCycle(), for a whole selection S getting manager M:
      // every member of S (except M, whose self-assignment is skipped below) will
      // report to M, so a loop exists iff walking UP from M's current manager
      // reaches a member of S. `seen` also stops on loops already in the data.
      if (fields.managerId) {
        const sel = new Set(userIds.map(String));
        const mgr = store.getUserById(fields.managerId);
        const seen = new Set([mgr.id]);
        const chain = [mgr.name || mgr.employeeId];
        let hit = 0;
        for (let cur = mgr.managerId || null; cur && !seen.has(cur); ) {
          seen.add(cur);
          const u = store.getUserById(cur);
          if (!u) break;
          chain.push(u.name || u.employeeId);
          if (sel.has(u.id)) { hit++; break; }
          cur = u.managerId || null;
        }
        if (hit)
          return send(res, 400, {
            error: `That would create a reporting loop (${chain.join(" → ")} → ${chain[0]}) — nothing was changed. Remove that person from the selection or pick a different manager. `
              + `这会形成循环汇报（${chain.join(" → ")} → ${chain[0]}），本次未做任何修改。请把该员工移出选择，或换一位上级。`,
            code: "reporting_loop",
          });
      }
      // 原子性：整批一个事务（runBatch），以上全部校验（over_cap、字段级权限、范围整批拒绝、
      // 「把人推出范围」、管理员 / 最后一个超管、循环汇报）都在写库之前。逐个跳过的口径不变（查无此人、
      // 停用自己、自己做自己上级）；任何一人抛异常 → 整批回滚、回 batch_failed + 第几个人。
      // 停用时吊销该人全部会话（与 PUT /employees/:id 同口径），会话吊销是库写、随事务一起
      // 提交或回滚；审计在提交之后（afterCommit）。
      const batch = runBatch((cur) => {
        let n = 0, skippedSelf = 0, revoked = 0;
        // 与单人 PUT /employees/:id 同口径：新部门名登记进部门表（成为一级部门，事件与 HoD 名单
        // 才解析得出它的一级/二级），存部门表里的规范写法。在同一事务里：整批回滚时新部门一起消失。
        if (fields.department) fields.department = canonicalDept(fields.department);
        for (let i = 0; i < userIds.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const uid = userIds[i];
          const t = store.getUserById(uid);
          if (!t) continue;
          const fx = { ...fields };
          if (fx.active === 0 && t.id === user.id) { skippedSelf++; delete fx.active; } // never disable yourself
          if (fx.managerId && fx.managerId === t.id) delete fx.managerId;               // no self-manager
          if (!Object.keys(fx).length) continue;
          store.updateUser(t.id, fx);
          if (fx.active === 0) { store.deleteUserSessions(t.id); revoked++; }
          n++;
        }
        return { n, skippedSelf, revoked };
      });
      if (!batch.ok) return sendBatchFailed(res, "employees/bulk-update", batch, { selection: true });
      const { n, skippedSelf, revoked } = batch.value;
      afterCommit("employees/bulk-update", () => {
        audit("employee.bulk-update", null, null, { count: n, fields: Object.keys(fields) });
        // 一条汇总行（与 bulk-reset 同口径），不是每人一行。
        if (revoked) auditAuth("auth.sessions_revoked", user, null, { reason: "bulk_deactivated", count: revoked });
      });
      return send(res, 200, { ok: true, count: n, skippedSelf });
    }
    // Who is assigned a course (wrapper program) — powers the course-side
    // assign dialog in the course library.
    const progAssignees = pathname.match(/^\/api\/admin\/programs\/([\w-]+)\/assignees$/);
    if (progAssignees && req.method === "GET") {
      const p = getProgram(progAssignees[1]);
      if (!p) return send(res, 404, { error: "Not found" });
      // P2 范围（learning）：课程是内容对象、**不**受约束（范围外的角色照样看得到这门课），
      // 但「谁被指派了」是一串人 —— 载荷主体是员工，范围外整行不返回。count 跟着 list
      // 走（这是「范围内被指派了几个人」，不是全公司分母）。
      const asgScope = scopePredicate(user);
      const list = [];
      for (const u of store.listUsers()) {
        if (LC.isServiceAccount(u)) continue;   // 与培训概览同一人群：只排除纯服务账号（2026-10-07）
        if (asgScope && !asgScope(u)) continue;
        const asg = store.getUserAssignments(u.id)[p.id];
        if (!asg) continue;
        list.push({
          userId: u.id, name: u.name, employeeId: u.employeeId,
          department: u.department || null, active: u.active !== 0,
          dueAt: asg.dueAt || null, progress: programProgress(u.id, p).percent,
        });
      }
      return send(res, 200, { count: list.length, list });
    }
    if (pathname === "/api/admin/employees" && req.method === "GET") {
      // P2 范围过滤：载荷是**培训报表**（域 = learning，裁定①），但每一行仍然是一个人，
      // 还带 talentTags/potential —— 主体是员工，所以受范围约束（清点文档 §2）。
      const empScope = scopePredicate(user);
      // 每门课有没有已发布考试只算一次（programDone 的同一口径，免得 人数 × 课程数 次查询）
      const hasExamOf = {};
      for (const p of PROGRAMS) hasExamOf[p.id] = programHasExam(p.id);
      return send(
        res, 200,
        store.listUsers().filter((u) => !empScope || empScope(u)).map((u) => {
          const per = {};
          const asg = store.getUserAssignments(u.id);
          for (const p of PROGRAMS) {
            const best = bestAttempt(u.id, p.id);
            const progress = programProgress(u.id, p).percent;
            per[p.id] = {
              progress,
              hasExam: hasExamOf[p.id],
              done: hasExamOf[p.id] ? !!(best && best.passed) : progress >= 100,
              best: best ? { percent: best.percent, passed: best.passed } : null,
              assigned: !!asg[p.id],
              dueAt: asg[p.id] ? asg[p.id].dueAt : null,
            };
          }
          return {
            id: u.id, name: u.name, employeeId: u.employeeId, role: u.role,
            department: u.department || null, email: u.email || null, managerId: u.managerId || null,
            position: u.position || null, jobLevel: u.jobLevel || null,
            hireDate: u.hireDate || null, empStatus: u.empStatus || null,
            talentTags: tagsForViewer(user, u), potential: u.potential || null,   // 12.2：本人那一行不给「流失风险」
            active: u.active !== 0, lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt, programs: per,
          };
        })
      );
    }
    // 12.2 受控人才标签（设计 b12-design 5.4 第 1 条）：逐个打上 / 取消「高潜 / 关键人才 / 流失风险」，理由必填（去空白后 4–300 字）。
    // 权限 talent=manage（RBAC order 112，与档案页写标签同一闸）；目标不存在或不在范围内 → 404（同形）；talent 模块关闭随 gate 404。
    // 已持有再 add / 未持有再 remove → 200 { unchanged:true }，不写事件、不写审计。标签与事件同一事务（store.setControlledTag），提交后写审计。
    const ctMatch = pathname.match(/^\/api\/admin\/employees\/([\w-]+)\/controlled-tags$/);
    if (ctMatch && req.method === "POST") {
      const target = store.getUserById(ctMatch[1]);
      if (!target || target.role === "admin" || !scopeAllowsFor(user, target)) return send(res, 404, { error: "Not found" });
      if (!CT.KEYS.includes(body.tag) || !["add", "remove"].includes(body.action))
        return send(res, 400, { error: "Choose one of the controlled talent tags and an action.", error_zh: "请选择受控标签与操作。", code: "bad_tag" });
      const reason = CT.reasonOf(String(body.reason == null ? "" : body.reason));
      if (!reason)
        return send(res, 400, { error: "Enter a reason of 4–300 characters.", error_zh: "请填写理由（4–300 字）。", code: "reason_required" });
      const r = store.setControlledTag(target.id, body.tag, body.action, { reason, actorId: user.id, actorName: user.name, requestId, effectiveOn: appealToday(), at: new Date(nowMs()).toISOString() });
      if (!r) return send(res, 404, { error: "Not found" });
      if (r.unchanged) return send(res, 200, { ok: true, unchanged: true, talentTags: tagsForViewer(user, target) });
      audit(body.action === "add" ? "talent.tag.add" : "talent.tag.remove", target.employeeId, { tags: parseTags(target) }, { tag: CT.CANONICAL[body.tag], reason });
      return send(res, 200, { ok: true, talentTags: tagsForViewer(user, store.getUserById(target.id)), event: r.event });
    }
    // Edit profile / role / active flag. HR can't demote or deactivate themself.
    const empPut = pathname.match(/^\/api\/admin\/employees\/([\w-]+)$/);
    if (empPut && req.method === "PUT") {
      const target = store.getUserById(empPut[1]);
      if (!target) return send(res, 404, { error: "Not found" });
      // P2 范围：**现**部门越界 → 与上一行「不存在」逐字同形的 404（不暴露存在性）。
      if (!scopeAllowsFor(user, target)) return send(res, 404, { error: "Not found" });
      // Field-level guard (design §5 ④, D6 细化): role / adminRoleId are the
      // real privilege-escalation face (change account type / grant a back-office
      // role) → super-admin only, rejected outright (never silently stripped).
      // active (deactivate/reactivate an account) is now the accounts domain —
      // needs accounts=manage, not super. Its per-target scope is already
      // enforced above (scopeAllowsFor → 404 for an out-of-scope target), so an
      // accounts-manager can only toggle people inside their scope.
      if (!isSuperAdmin(user) && (body.role !== undefined || body.adminRoleId !== undefined))
        return send(res, 403, { error: "Only a super-admin can change role or admin role. 仅超级管理员可修改账号类型/后台角色。" });
      if (body.active !== undefined && !canWrite(user, "accounts"))
        return send(res, 403, { error: "Changing active status requires manage rights on the accounts domain. 修改在职/停用状态需要员工账号域的管理权限。" });
      // Field-level guard (talent domain, design §5⑤): potential (the 9-box
      // vertical axis) and talentTags are talent-development data. This endpoint
      // is homed to the people domain, so a people-only editor reaches it — they
      // must additionally hold talent=manage to write these, exactly as
      // bulk-update requires. canWrite short-circuits true for super-admins.
      if ((body.potential !== undefined || body.talentTags !== undefined) && !canWrite(user, "talent"))
        return send(res, 403, { error: "Changing potential or talent tags requires manage rights on the talent domain. 修改潜力或人才标签需要人才发展域的管理权限。" });
      const fields = {};
      if (body.name !== undefined) {
        if (!String(body.name).trim()) return send(res, 400, { error: "Name can't be empty." });
        fields.name = clampText(body.name, 60);
      }
      if (body.department !== undefined) fields.department = clampText(body.department, 60) || null;
      // P2 范围：**新**部门也必须在范围内（清点文档 §2 的双校验）。清空部门（null）
      // 同样拒绝——没有部门的人在范围生效时不可见（store.js parseScope 一节），所以
      // 「清空」和「调到范围外」是同一个动作：把人推出自己的可见范围。
      if (fields.department !== undefined && !scopeAllowsDeptFor(user, fields.department))
        return sendScopeDeptReject(res);
      if (body.phone !== undefined) fields.phone = clampText(body.phone, 30) || null;
      if (body.email !== undefined) {
        const em = normalizeEmail(body.email);
        if (em && !EMAIL_RE.test(em)) return send(res, 400, { error: "Please enter a valid email address." });
        const other = em && findUserByEmail(em);
        if (other && other.id !== target.id) return send(res, 400, { error: `That email is already used by ${other.name} (${other.employeeId}).` });
        fields.email = em || null;
      }
      if (body.managerId !== undefined) {
        const mid = String(body.managerId || "").trim();
        if (mid) {
          if (mid === target.id) return send(res, 400, { error: "An employee can't be their own manager." });
          if (!store.getUserById(mid)) return send(res, 400, { error: "Manager not found." });
          // Walk up the chain: A→B→A (or any longer loop) would make every
          // manager-based traversal recurse forever.
          const cyc = managerCycle(target.id, mid);
          if (cyc) return send(res, 400, { error: `That would create a reporting loop (${cyc}). Pick a different manager.` });
        }
        fields.managerId = mid || null;
      }
      // Talent / HRIS master-data fields. Department names auto-register in the
      // managed departments table (the talent layer's master list), and the user
      // row stores that table's spelling ("sales" under an existing "Sales" is
      // saved as "Sales").
      if (fields.department) fields.department = canonicalDept(fields.department);
      if (body.position !== undefined) fields.position = String(body.position || "").trim() || null;
      if (body.jobLevel !== undefined) fields.jobLevel = String(body.jobLevel || "").trim() || null;
      if (body.hireDate !== undefined) {
        const hd = String(body.hireDate || "").slice(0, 10);
        if (hd && !validDateStr(hd)) return send(res, 400, { error: "Hire date must be YYYY-MM-DD" });
        fields.hireDate = hd || null;
      }
      if (body.empStatus !== undefined) {
        if (body.empStatus && !["probation", "regular", "exited"].includes(body.empStatus))
          return send(res, 400, { error: "Invalid employment status" });
        fields.empStatus = body.empStatus || null;
      }
      if (body.talentTags !== undefined) {
        if (!Array.isArray(body.talentTags)) return send(res, 400, { error: "talentTags must be an array" });
        fields.talentTags = body.talentTags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 12);
        // 12.2 受控标签（设计 5.4 第 2 条）：自由标签里不许出现能映射到受控标签的写法（手输「HiPo」）→ 400 tag_reserved；
        // 受控标签集合必须与当前一致（只能经 POST /employees/:id/controlled-tags 逐个打上或取消、填写理由）→ 400 controlled_tags_use_endpoint。
        // 本人编辑自己的资料：档案里本就不给自己「流失风险」（tagsForViewer），当前持有的原样保留，不算改动
        const tgCur = parseTags(target);
        if (target.id === user.id && !isSuperAdmin(user) && CT.heldKeysOf(tgCur).includes("flight") && !CT.controlledKeysOf(fields.talentTags).includes("flight")
          && !fields.talentTags.some((t) => CT.isReservedSpelling(t))) fields.talentTags.push(CT.CANONICAL.flight);
        const tgChk = CT.checkTagSubmission(tgCur, fields.talentTags);
        if (!tgChk.ok && tgChk.code === "tag_reserved")
          return send(res, 400, { error: `"${tgChk.field}" is a controlled talent tag. Choose it in the controlled tags section above.`, error_zh: `「${tgChk.field}」是受控标签，请在上方「受控标签」区选择。`, code: "tag_reserved", field: tgChk.field });
        if (!tgChk.ok)
          return send(res, 400, { error: "Add or remove controlled tags one at a time in the controlled tags section, with a reason.", error_zh: "受控标签请在「受控标签」区逐个打上或取消，并填写理由。", code: "controlled_tags_use_endpoint" });
        fields.talentTags = tgChk.tags;
      }
      if (body.potential !== undefined) fields.potential = String(body.potential || "").trim().slice(0, 20) || null;
      if (body.extras !== undefined) {
        // Custom employee fields — validated against the reserved 'user' config.
        const built = buildRecordDetail("user", body.extras || {});
        if (built.error) return send(res, 400, { error: built.error, code: built.code, field: built.field });
        fields.extras = built.detail;
      }
      if (body.role !== undefined) {
        if (!["admin", "employee"].includes(body.role)) return send(res, 400, { error: "Invalid role" });
        if (target.id === user.id && body.role !== "admin") return send(res, 400, { error: "You can't remove your own admin access." });
        fields.role = body.role;
      }
      if (body.active !== undefined) {
        if (target.id === user.id && !body.active) return send(res, 400, { error: "You can't deactivate your own account." });
        // D6 fix (account-integrity): active is now grantable to the accounts
        // domain, but a non-super must NOT be able to deactivate an ADMIN account
        // (super or delegated). Mirrors the "only a super-admin can reset an admin
        // account's password" guard — otherwise a department HRBP could lock out
        // higher-privileged admins one by one (the last-super guard below only
        // stops the tally hitting zero, not the act of disabling an admin).
        if (!body.active && !isSuperAdmin(user) && isAdmin(target))
          return send(res, 403, { error: "Only a super-admin can deactivate an admin account. 仅超级管理员可停用管理员账号。" });
        // D6 fix: active became grantable to the accounts domain, so a non-super
        // accounts-manager can now reach this path. The last-active-super-admin
        // invariant (previously automatic — only supers could toggle active) must
        // be enforced here too, mirroring the adminRoleId branch below. Applies to
        // every actor: if only one active super remains it must be self (blocked
        // above), so a super actor never trips it.
        if (!body.active && isSuperAdmin(target) && target.active !== 0 && store.countActiveSuperAdmins() <= 1)
          return send(res, 400, { error: "This is the last active super-admin — assign another first. 这是最后一个活跃超级管理员，请先指派其他人。" });
        fields.active = !!body.active;
        if (!body.active) {
          store.deleteUserSessions(target.id);
          // Separate row from the employee.update diff: "the account was
          // deactivated" and "their live sessions were cut" come from the same
          // click but are different facts, and only the second one explains a
          // user's sudden 401 mid-task.
          auditAuth("auth.sessions_revoked", user, target.employeeId, { reason: "deactivated" });
        }
      }
      // Admin-role assignment (super-admin only, enforced by the §5 ④ guard above).
      // Guard: never drop the last active super-admin by reassigning them.
      let roleAssignFrom, roleAssignTo, roleAssignChanged = false;
      if (body.adminRoleId !== undefined) {
        const before = target.adminRoleId != null ? target.adminRoleId : null;
        let next = null;
        if (body.adminRoleId !== null && body.adminRoleId !== "") {
          const rid = Number(body.adminRoleId);
          if (!Number.isInteger(rid) || !store.getRole(rid)) return send(res, 400, { error: "Unknown role. 后台角色不存在。" });
          next = rid;
        }
        if (before !== next) {
          const said = store.superAdminRoleId();
          // Super-admin status matched to countActiveSuperAdmins' exact definition:
          // adminRoleId === super-admin role, OR a legacy admin (role='admin' with
          // adminRoleId null). Keying only on `before === said` let a legacy super
          // (before === null) be demoted past the last-super guard down to zero.
          const wasSuper = before === said || (before == null && target.role === "admin");
          // `willBeSuper` must read the request's END state, not the stored row:
          // one PUT can carry both role and adminRoleId. Reading target.role made
          // "promote to role=admin AND clear adminRoleId" look like a demotion to
          // nobody and raised a bogus last-super 400. Fall back to the stored role
          // only when this request does not set one.
          const nextRole = fields.role !== undefined ? fields.role : target.role;
          const willBeSuper = next === said || (next == null && nextRole === "admin");
          if (wasSuper && !willBeSuper && target.active !== 0 && store.countActiveSuperAdmins() <= 1)
            return send(res, 400, { error: "This is the last active super-admin — assign another first. 这是最后一个活跃超级管理员，请先指派其他人。" });
          roleAssignFrom = before; roleAssignTo = next; roleAssignChanged = true;
        }
      }
      const updated = store.updateUser(target.id, fields);
      if (roleAssignChanged) {
        store.setUserAdminRole(target.id, roleAssignTo);
        audit("role.assign", target.employeeId, { roleId: roleAssignFrom }, { roleId: roleAssignTo });
      }
      // potential 进 before / after（第二批 2.4：潜力评定的变更也要在审计里看得到，评定日期另存 users.potentialAt）
      audit("employee.update", target.employeeId,
        { name: target.name, department: target.department, position: target.position, jobLevel: target.jobLevel, hireDate: target.hireDate, empStatus: target.empStatus, role: target.role, active: target.active !== 0, potential: target.potential || null },
        { name: updated.name, department: updated.department, position: updated.position, jobLevel: updated.jobLevel, hireDate: updated.hireDate, empStatus: updated.empStatus, role: updated.role, active: updated.active !== 0, potential: updated.potential || null });
      return send(res, 200, { ok: true, user: { id: updated.id, name: updated.name, department: updated.department, email: updated.email || null, managerId: updated.managerId || null, position: updated.position, jobLevel: updated.jobLevel, hireDate: updated.hireDate, empStatus: updated.empStatus, talentTags: tagsForViewer(user, updated), potential: updated.potential || null, role: updated.role, active: updated.active !== 0, adminRoleId: roleAssignChanged ? roleAssignTo : (updated.adminRoleId != null ? updated.adminRoleId : null) } });
    }
    // Full record for the employee-detail page: module-level progress + exam history.
    const empDetail = pathname.match(/^\/api\/admin\/employees\/([\w-]+)\/detail$/);
    if (empDetail && req.method === "GET") {
      const u = store.getUserById(empDetail[1]);
      if (!u) return send(res, 404, { error: "Not found" });
      // P2 范围（learning）：阶段 A 明文记下的遗留泄露 —— 这条抽屉里除了培训进度还带
      // attempts[]（含姓名/工号/整份答卷），主体是**一个员工**，越界一律裸 404，与上面
      // 那行「不存在」逐字同形（同一 handler 的两个出口必须不可区分，否则 :id 就成了
      // 越界探测器）。
      if (!scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      const asg = store.getUserAssignments(u.id);
      // Every display name here is read with loc() in the employee drawer, so the
      // Chinese half has to travel with it at all four levels — programme, course,
      // programme label. Sending only `title` meant the drawer's training list
      // stayed English no matter the UI language.
      const programs = PROGRAMS.map((p) => {
        // 学习记录整页（2026-10-07）的状态用服务端口径：done = programDone；overdue = 已指派、未完成、截止日已过、课程仍在发布
        // （已下线的课程三条提醒路径都不提醒，这里也不标逾期）
        const done = programDone(u.id, p);
        return {
        id: p.id, title: p.title, title_zh: p.title_zh || null,
        assigned: !!asg[p.id], dueAt: asg[p.id] ? asg[p.id].dueAt : null,
        // 第四批 7：来源与加入时间（assigned / self；未指派为 null）
        source: asg[p.id] ? (asg[p.id].source === "self" ? "self" : "assigned") : null,
        assignedAt: asg[p.id] ? asg[p.id].assignedAt || null : null,
        progress: programProgress(u.id, p).percent,
        done, hasExam: programHasExam(p.id),
        overdue: !!asg[p.id] && !done && LC.isPublishedProgram(p) && LC.isOverdue(asg[p.id].dueAt),
        passingScore: p.passingScore,
        // 第三批 3.3 培训概览「员工培训记录」整页：类别、修读类型、授课方式、学时、完成日期（programDoneAt）、最好成绩
        ...(() => { const m = programMetaOf(p); const b = bestAttempt(u.id, p.id); return { category: m.category, enrollType: m.enrollType, mode: m.mode, hours: m.hours, doneAt: done ? COMPLETION.programDoneAt(u.id, p) : null, bestPercent: b ? b.percent : null }; })(),
        // No title_zh below the programme level: the drawer renders one row per
        // programme (loc(p,"title") + progress + whether any attempt passed) and has
        // no course or module list to localize. Add it back next to the UI that
        // needs it rather than shipping it to every drawer open.
        courses: coursesInProgram(p).map((c) => {
          const done = userProgress(u.id, c.id);
          return { id: c.id, title: c.title, modules: c.modules.map((m) => ({ id: m.id, title: m.title, doneAt: done[m.id] || null })) };
        }),
        attempts: store.listUserAttempts(u.id, p.id).map((a) => ({ id: a.id, startedAt: a.startedAt, submittedAt: a.submittedAt, percent: a.percent, passed: a.passed, blurCount: a.blurCount || 0, detail: a.detail, name: u.name, employeeId: u.employeeId, program: p.title })),
        };
      });
      return send(res, 200, {
        user: { id: u.id, name: u.name, employeeId: u.employeeId, role: u.role, department: u.department || "", email: u.email || "", managerId: u.managerId || null, active: u.active !== 0, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, empStatus: u.empStatus || null, position: u.position || null },
        programs,
      });
    }
    // --- talent profile & records (People module) ---
    // Full profile: identity + stats + merged timeline + field config + suggestions.
    const profMatch = pathname.match(/^\/api\/admin\/employees\/([\w-]+)\/profile$/);
    if (profMatch && req.method === "GET") {
      const u = store.getUserById(profMatch[1]);
      if (!u) return send(res, 404, { error: "Not found" });
      // P2 范围：主体越界 → 404（同上，与「不存在」同形）。
      if (!scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      // 档案页里还有两个**全员名录**：suggestions.managers（全员 id+姓名+工号）与
      // suggestions.departments（全部部门名）。不过滤它们，档案页就成了绕过 roster 的
      // 第二条全员名单（清点文档 §2）。secondaryReports 同理：那是一串人。
      const profScope = scopePredicate(user);
      const profDeptScope = scopeDeptPredicate(user);
      const { events, stats } = buildTalentTimeline(u);
      perfAmendDecorate(events, profScope);   // 第二批 2.6：周期归档的绩效记录带 reviewLinked，改过评级的另带 amend（只在后台这里附加）
      // 第二批 2.8（安全审查 1）：看本人档案时不给修改标记（原评级、理由）—— 员工本人从不看到原评级；超级管理员除外
      if (u.id === user.id && !isSuperAdmin(user)) for (const e of events) delete e.amend;
      // 12.2（设计 5.6）：受控标签的打标 / 取消事件，只给 talent 可读的查看者（talent 模块开启时）；本人看自己不给「流失风险」事件。
      // 只在后台这里附加，不改 buildTalentTimeline（员工端与上级视图共用它）。
      if (modulesOn().talent && canRead(user, "talent")) {
        const selfView = u.id === user.id && !isSuperAdmin(user);
        for (const ev of store.listTagEvents(u.id)) {
          if (selfView && ev.tagKey === "flight") continue;
          events.push({ source: "tag", type: "tag", id: ev.id, date: ev.effectiveOn || String(ev.at || "").slice(0, 10), createdAt: ev.at,
            tagKey: ev.tagKey, action: ev.action, reason: ev.reason, actor: { name: ev.actorName || null },
            dateUnknown: ev.effectiveOn == null && ev.source === "migration" });
        }
        events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt || "") < (b.createdAt || "") ? 1 : -1));
      }
      const mgr = u.managerId ? store.getUserById(u.managerId) : null;
      return send(res, 200, {
        user: {
          id: u.id, name: u.name, employeeId: u.employeeId, role: u.role,
          department: u.department || "", position: u.position || "", jobLevel: u.jobLevel || "",
          hireDate: u.hireDate || "", talentTags: tagsForViewer(user, u), potential: u.potential || "",   // 12.2：本人看自己不给「流失风险」
          potentialAt: u.potentialAt || null,   // 潜力评定日期（迁移 67；迁移前评定的为 null =「评定日期不详」）
          empStatus: u.empStatus || "", extras: parseExtras(u),
          managerId: u.managerId || null, managerName: mgr ? mgr.name : null,
          active: u.active !== 0, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
          // The profile's 编辑资料 sheet assigns the 后台角色 too (same field the
          // roster already exposes); without it the picker could not show the
          // current role.
          adminRoleId: u.adminRoleId != null ? u.adminRoleId : null,
        },
        stats, events,
        // Everything assigned to them, including the ones never opened — the
        // timeline omits those by design, which left the learning card unable to
        // show a "not started" row at all.
        assignments: Object.entries(store.getUserAssignments(u.id)).map(([pid, a]) => {
          const p = getProgram(pid);
          if (!p) return null;
          const prog = programProgress(u.id, p);
          const best = bestAttempt(u.id, pid);
          return {
            programId: pid, title: p.title, title_zh: p.title_zh || null,
            enrollType: p.enrollType || "mandatory",
            source: a.source === "self" ? "self" : "assigned",   // 第四批 7
            dueAt: a.dueAt || null,
            progress: prog.percent,
            moduleTotal: prog.total, moduleDone: prog.done,
            bestPercent: best ? best.percent : null,
            passed: programDone(u.id, p),
            hasExam: programHasExam(pid),
          };
        }).filter(Boolean),
        // Matrix layer: this person's dotted lines / concurrent posts, plus the
        // people who dotted-report to THEM (their matrix team).
        secondaryLines: decorateSecondaryLines(store.listSecondaryLines(u.id)),
        secondaryReports: store.listSecondaryReports(u.id).filter((r) => {
          if (!profScope) return true;
          const who = store.getUserById(r.userId);
          return !!who && profScope(who);
        }).map((r) => {
          const who = store.getUserById(r.userId);
          return {
            id: r.id, kind: r.kind, userId: r.userId,
            name: who ? who.name : "?", employeeId: who ? who.employeeId : "?",
            department: who ? who.department || null : null,
            position: r.position || null,
          };
        }),
        // types 带 moduleOff（见 recordTypesOut）：所属模块关闭的类型照常下发 —— 已有记录的时间线要用它的名称与颜色，
        // 只是新建记录的类型选择里不列出。
        config: { types: recordTypesOut(), fields: store.listRecordFields(null, true) },
        suggestions: {
          positions: store.listDistinctUserField("position"),
          jobLevels: store.listDistinctUserField("jobLevel"),
          jobRanks: jobGrades(),
          departments: store.listDepartments().filter((d) => !profDeptScope || profDeptScope(d.name)).map((d) => d.name),
          managers: store.listUsers().filter((x) => x.active !== 0 && x.id !== u.id && (!profScope || profScope(x))).map((x) => ({ id: x.id, name: x.name, employeeId: x.employeeId })),
        },
        // 模块页签（§5.4，见 profileTabsFor）：后台位置。
        tabs: profileTabsFor(user, "admin"),
      });
    }
    /* ---- secondary reporting lines 虚线汇报 / 兼任 ----
       The solid line (users.managerId) stays exactly one manager per person.
       These are the matrix relationships on top: a dotted-line manager in
       another function, or a concurrent post someone also holds. */
    const secListMatch = pathname.match(/^\/api\/admin\/employees\/([\w-]+)\/secondary-lines$/);
    if (secListMatch && req.method === "GET") {
      const u = store.getUserById(secListMatch[1]);
      if (!u) return send(res, 404, { error: "Not found" });
      if (!scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" }); // P2：按主体
      return send(res, 200, decorateSecondaryLines(store.listSecondaryLines(u.id)));
    }
    if (secListMatch && req.method === "POST") {
      const u = store.getUserById(secListMatch[1]);
      if (!u) return send(res, 404, { error: "Not found" });
      // P2 范围：**只校验主体**（这条线是谁的线），故意**允许** body.managerId 指向范围
      // 外的上级——虚线汇报的全部用途就是跨部门，两端都卡就等于这个功能对范围受限的
      // 角色永久不可用（清点文档 §2 的建议）。范围外上级的姓名会出现在响应里，与
      // org-chart 方案 B 同一条取舍：自己的上级链本来就是自己知道的信息。
      if (!scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      const kind = body.kind === "concurrent" ? "concurrent" : "dotted";
      const managerId = String(body.managerId || "").trim() || null;
      const position = clampText(body.position, 80) || null;
      const department = clampText(body.department, 60) || null;
      // A dotted line is defined by WHO you also report to; a concurrent post is
      // defined by WHICH post you also hold. Each needs its own key field.
      if (kind === "dotted" && !managerId) return send(res, 400, { error: "A dotted line needs a manager 虚线汇报必须选择上级" });
      if (kind === "concurrent" && !position) return send(res, 400, { error: "A concurrent post needs a position 兼任必须填写岗位" });
      if (managerId) {
        if (managerId === u.id) return send(res, 400, { error: "Someone cannot report to themselves 不能选择自己" });
        const m = store.getUserById(managerId);
        if (!m) return send(res, 400, { error: "Manager not found 上级不存在" });
        if (m.role === "admin") return send(res, 400, { error: "System accounts hold no reporting line 系统账号不参与汇报关系" });
        // A dotted line duplicating the solid line carries no information.
        if (kind === "dotted" && u.managerId === managerId)
          return send(res, 400, { error: "That is already the solid-line manager 该上级已是实线上级" });
      }
      if (department) store.ensureDepartment(department);
      const row = store.addSecondaryLine({
        userId: u.id, managerId, kind, position, department,
        note: clampText(body.note, 200) || null, createdBy: user.id,
      });
      if (!row) return send(res, 400, { error: "That line already exists 该关系已存在" });
      audit("secondary.line.add", u.employeeId, null, { kind, managerId, position, department });
      return send(res, 200, { ok: true, line: decorateSecondaryLines([row])[0] });
    }
    const secDelMatch = pathname.match(/^\/api\/admin\/secondary-lines\/([\w-]+)$/);
    if (secDelMatch && req.method === "DELETE") {
      const row = store.getSecondaryLine(secDelMatch[1]);
      if (!row) return send(res, 404, { error: "Not found" });
      // P2 范围：这一行归属于 row.userId（主体），按他的部门判 → 越界回 404，与上一行
      // 「这一行不存在」同形。
      const secOwner = store.getUserById(row.userId);
      if (!scopeAllowsFor(user, secOwner)) return send(res, 404, { error: "Not found" });
      store.deleteSecondaryLine(row.id);
      const owner = store.getUserById(row.userId);
      audit("secondary.line.delete", owner ? owner.employeeId : row.userId, null, { kind: row.kind, managerId: row.managerId, position: row.position });
      return send(res, 200, { ok: true });
    }
    // Bulk paste, so an existing 兼任 roster can be loaded in one go.
    if (pathname === "/api/admin/secondary-lines/bulk" && req.method === "POST") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return send(res, 400, { error: "No rows to import 没有可导入的数据" });
      // Cap like bulk-update: NEVER truncate silently (this used to slice(0, 2000)
      // and drop the tail of the paste with a 200). Over the cap → whole batch
      // rejected before anything is written. Shares LMS_BULK_CAP (default 10000).
      const secCapRaw = Math.floor(Number(process.env.LMS_BULK_CAP));
      const secCap = Number.isFinite(secCapRaw) && secCapRaw > 0 ? secCapRaw : 10000;
      if (rows.length > secCap)
        return send(res, 400, {
          error: `Pasted ${rows.length} rows, but one import is capped at ${secCap} — split the sheet and import in smaller batches. `
            + `本次粘贴 ${rows.length} 行，单次上限 ${secCap} 行：请拆分表格分批导入。`,
          code: "over_cap", selected: rows.length, cap: secCap,
        });
      const byEmpId = new Map(store.listUsers().map((u) => [String(u.employeeId).toLowerCase(), u]));
      // P2 范围：**逐条**解析主体后校验，任一越界 → 整批拒绝（设计选择①）。前置一整趟，
      // 一行都不写就返回——写到一半再拒绝就是最糟的那种「部分执行」。指向范围外的
      // **上级**（managerEmployeeId）不拦，与单条 POST 的口径一致。
      const secBulkScope = scopePredicate(user);
      if (secBulkScope) {
        let outOfScope = 0;
        for (const r of rows) {
          const who = byEmpId.get(String((r || {}).employeeId || "").trim().toLowerCase());
          if (who && !secBulkScope(who)) outOfScope++;   // 工号不存在仍按原样逐行 skipped
        }
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      // 原子性：整批一个事务（runBatch）。逐行校验问题照旧 skipped；任何一行抛异常 →
      // 整批回滚、回 batch_failed + 行号。
      const batch = runBatch((cur) => {
        const results = [];
        let created = 0;
        for (let i = 0; i < rows.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const r = rows[i] || {};
          const who = byEmpId.get(String(r.employeeId || "").trim().toLowerCase());
          const kind = String(r.kind || "").trim() === "concurrent" ? "concurrent" : "dotted";
          const mgr = r.managerEmployeeId ? byEmpId.get(String(r.managerEmployeeId).trim().toLowerCase()) : null;
          const position = clampText(r.position, 80) || null;
          const fail = (why) => { results.push({ line: i + 1, employeeId: r.employeeId || "", status: "skipped", reason: why }); };
          if (!who) { fail("employee not found 工号不存在"); continue; }
          if (r.managerEmployeeId && !mgr) { fail("manager not found 上级工号不存在"); continue; }
          if (kind === "dotted" && !mgr) { fail("dotted line needs a manager 虚线需上级"); continue; }
          if (kind === "concurrent" && !position) { fail("concurrent post needs a position 兼任需岗位"); continue; }
          if (mgr && mgr.id === who.id) { fail("self-reference 不能选择自己"); continue; }
          if (mgr && kind === "dotted" && who.managerId === mgr.id) { fail("already the solid-line manager 已是实线上级"); continue; }
          const dept = clampText(r.department, 60) || null;
          if (dept) store.ensureDepartment(dept);
          const row = store.addSecondaryLine({
            userId: who.id, managerId: mgr ? mgr.id : null, kind, position, department: dept,
            note: clampText(r.note, 200) || null, createdBy: user.id,
          });
          if (!row) { fail("duplicate 已存在"); continue; }
          created++;
          results.push({ line: i + 1, employeeId: who.employeeId, name: who.name, status: "created", kind, manager: mgr ? mgr.name : null, position });
        }
        return { results, created };
      });
      if (!batch.ok) return sendBatchFailed(res, "secondary-lines/bulk", batch);
      const { results, created } = batch.value;
      afterCommit("secondary-lines/bulk", () => audit("secondary.line.bulk", null, null, { created, skipped: results.length - created }));
      return send(res, 200, { ok: true, created, skipped: results.length - created, results });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 12140–12503 行（/api/admin/ 块内）
    async adminCore4(C) {
      const { pathname, req, res, user, body, RECORD_TYPE_LOCKED_ERR, recordPeriodKey, recordPeriodHasCycleRecord, RECORD_PERIOD_HAS_CYCLE_ERR, RATING_REASON_REQUIRED_ERR, audit, auditAuth, RECORD_FROM_CYCLE_ERR } = C;
      const { store, send, scopeAllowsFor, recordTypeModuleOff, RECORD_TYPE_UNAVAILABLE, validDateStr, getProgram, buildRecordDetail, isSuperAdmin, appealErr, appealOpen, appealPerfVisible, nowMs, workdayAdd, appealToday, APPEAL_WINDOW_WORKDAYS, reviewHolidaySet, recordSyncSignature, recordSyncsDepartment, scopeAllowsDeptFor, sendScopeDeptReject, runBatch, applyRecordSideEffects, deriveRecordTitle, perfRatingAmendAudit, sendRecordSaveFailed, afterCommit, reviewRecipientOk, notify, recordTypesOut, fieldOut, newToken, AI_SHARE_VALUES, AI_SHARE_NONE, parseOptionsZh, AI_SHARE_RANK, orgLib, scopeDeptPredicate, sendDeptOccupied, scopePredicate, sendDeptCycle, deptAuditShape, hodListFor, sendCsv, todayLocal, hodCsvRows } = S;
    const recMatch = pathname.match(/^\/api\/admin\/records\/([\w-]+)$/);
    if (recMatch && req.method === "PUT") {
      const rec = store.getTalentRecord(recMatch[1]);
      if (!rec) return send(res, 404, { error: "Record not found" });
      // P2 范围：按 rec.userId 的部门判（这条记录是谁的记录）。越界回与上一行逐字相同的
      // 404「Record not found」—— 记录的存在性同样不该泄露。同样在副作用之前。
      if (!scopeAllowsFor(user, store.getUserById(rec.userId))) return send(res, 404, { error: "Record not found" });
      const t = store.getRecordType(String(body.type || rec.type));
      if (!t) return send(res, 400, { error: "Unknown record type" });
      // 改成所属模块关闭的类型 = 变相新建，拒绝；编辑本来就是该类型的已有记录照常（见 RECORD_TYPE_MODULE）。
      if (t.key !== rec.type && recordTypeModuleOff(t.key)) return send(res, 400, RECORD_TYPE_UNAVAILABLE);
      const date = String(body.date || rec.date).slice(0, 10);
      if (!validDateStr(date)) return send(res, 400, { error: "Date must be YYYY-MM-DD" });
      if (body.programId && !getProgram(body.programId)) return send(res, 400, { error: "Unknown program" });
      const built = buildRecordDetail(t.key, body.fields || {});
      if (built.error) return send(res, 400, { error: built.error, code: built.code, field: built.field });
      // 第二批 2.6（负责人 10/7 定）：周期归档的记录（review_items.recordId 指向它）不能改类型 —— 改了类型，「我的绩效」、
      // 九宫格与「已改动」标记就都找不到这一期了。
      const recCycleItem = store.getReviewItemByRecordId(rec.id);
      if (recCycleItem && t.key !== rec.type) return send(res, 409, RECORD_TYPE_LOCKED_ERR);
      // 绩效记录改了评级 → 必须写理由（G6：所有绩效记录都要，不只周期归档的）。理由只进审计（与改记录同一事务），
      // 员工端任何接口都不下发。
      const ratingOf = (d) => (d && d.rating != null && d.rating !== "" ? String(d.rating) : null);
      const ratingChanged = rec.type === "performance" && t.key === "performance" && ratingOf(built.detail) !== ratingOf(rec.detail);
      const ratingReason = ratingChanged ? String(body.ratingReason == null ? "" : body.ratingReason).trim() : null;
      // 第二批 2.6 护栏（审查 P0-5，编辑口径）：把一条记录改成（或改类型成）某个已关闭周期归档的那一期 = 变相新建第二条，
      // 同样拒绝。只在期间或类型真的变了时检查（期间没变的旧记录照常能改），并排除归档记录本身。先于「缺理由」判定：
      // 这一条写了理由也不能保存，先告诉 HR 去编辑原记录。
      if (t.key === "performance" && (rec.type !== "performance" || recordPeriodKey(rec.detail) !== recordPeriodKey(built.detail))
        && recordPeriodHasCycleRecord(rec.userId, built.detail, null, rec.id))
        return send(res, 409, RECORD_PERIOD_HAS_CYCLE_ERR);
      // 第二批 2.8 护栏（安全审查 2、制度审查 2）：不能改本人的评级；申诉处理中只能由负责的 HRBP 在申诉结论里调整；
      // 申诉已有结论（HRBP 的结论为最终结论）后只有超级管理员能再改，审计另带 afterAppeal。
      let recAppeal = null;
      if (ratingChanged) {
        if (rec.userId === user.id && !isSuperAdmin(user)) return appealErr(res, "rating_self_amend");
        recAppeal = store.getReviewAppealByRecord(rec.id);
        if (recAppeal && appealOpen(recAppeal)) return appealErr(res, "rating_under_appeal");
        if (recAppeal && (recAppeal.status === "maintained" || recAppeal.status === "adjusted") && !isSuperAdmin(user)) return appealErr(res, "rating_appeal_closed");
      }
      if (ratingChanged && (!ratingReason || ratingReason.length > 1000)) return send(res, 400, RATING_REASON_REQUIRED_ERR);
      // 制度审查 3：结果已正式告知之后修改周期归档的评级 = 重新告知。员工收到不含评级的通知；还没有申诉过的，申诉期限从今天起算。
      const recCycle = ratingChanged && recCycleItem ? store.getReviewCycle(recCycleItem.cycleId) : null;
      const recRecommunicate = !!(recCycle && recCycle.status === "closed" && recCycle.resultsAt && appealPerfVisible());
      const recReopen = recRecommunicate && !recAppeal && !store.getReviewAppealByItem(recCycleItem.id);
      const recReopenAt = new Date(nowMs()).toISOString();
      const recReopenDeadline = recReopen ? workdayAdd(appealToday(), APPEAL_WINDOW_WORKDAYS, reviewHolidaySet()) : null;
      // 编辑只在「同步的内容」变了时才重跑副作用：新勾上同步、换了调入部门 / 目标职级、结果改成
      // 通过、换了记录类型。只改日期、标题、备注时不重跑 —— 否则修一条旧调动记录的错字会把人
      // 调回 toDept（他后来可能已经调走），修一条旧离职记录的备注会把已经复职的人再次离职、踢下线，
      // 还各发一条假的 employee.transferred / terminated。签名没变时沿用原记录的 synced 标记
      // （界面回传的表单里没有这个字段）。历史导入（records/bulk）的记录从未同步过，编辑它们的
      // 非同步字段同样不会补做同步。
      const oldSig = recordSyncSignature(rec.type, rec.detail);
      const newSig = recordSyncSignature(t.key, built.detail);
      const resync = newSig !== null && newSig !== oldSig;
      if (!resync && newSig !== null && rec.detail && rec.detail.synced) built.detail.synced = true;
      // 周期归档记录的评语作者标记（summaryAuthor，AI 画像与 employeeSeesManagerComment 都看它；表单里没有这个字段）：
      // 评语没改就沿用 —— 否则 2.6 只改评级也会把它冲掉（第二批 2.6，2026-10-08）。
      if (rec.detail && rec.detail.summaryAuthor && t.key === rec.type && String(built.detail.summary == null ? "" : built.detail.summary) === String(rec.detail.summary == null ? "" : rec.detail.summary))
        built.detail.summaryAuthor = rec.detail.summaryAuthor;
      // P2 范围：同 POST —— 改一条记录同样能触发调动副作用（只在确实要重跑时才校验目标部门）。
      const recPutSyncDept = resync ? recordSyncsDepartment(t.key, built.detail) : null;
      if (recPutSyncDept !== null && !scopeAllowsDeptFor(user, recPutSyncDept)) return sendScopeDeptReject(res);
      const revoked = [];
      const saved = runBatch(() => {
        if (resync) applyRecordSideEffects(rec.userId, t.key, built.detail, (uid) => revoked.push(uid));
        const upd = store.updateTalentRecord(rec.id, {
          type: t.key, date,
          title: String(body.title || "").trim().slice(0, 200) || deriveRecordTitle(t.key, built.detail),
          detail: built.detail, programId: body.programId || null,
        });
        // 2.6：带理由的评级修改审计与记录同一笔事务（审查 P1-13：不能在提交之后才补，进程中途退出也不会留下没有理由的改动）。
        // 不发通知、不发事件。target = 记录 id；原有的 talent.record.update 照常在提交后另记一行。
        if (ratingChanged) {
          // 第二批 2.8：审计写法抽成 perfRatingAmendAudit（申诉调整共用）；期间取表单里的值，行为不变
          perfRatingAmendAudit(audit, rec, ratingOf(rec.detail), ratingOf(built.detail), ratingReason, recCycleItem, {
            period: built.detail.period != null ? built.detail.period : null,
            ...(recAppeal ? { afterAppeal: recAppeal.id } : {}),
          });
          if (recReopen) store.updateReviewItem(recCycleItem.id, { appealFrom: recReopenAt, appealDeadline: recReopenDeadline });
        }
        return upd;
      });
      if (!saved.ok) return sendRecordSaveFailed(res, "records/update", saved.error);
      const updated = saved.value;
      afterCommit("records/update", () => {
        for (const uid of revoked) {
          const kicked = store.getUserById(uid);
          auditAuth("auth.sessions_revoked", user, kicked ? kicked.employeeId : uid, { reason: "exited" });
        }
        audit("talent.record.update", rec.id, { type: rec.type, date: rec.date, title: rec.title, detail: rec.detail }, { type: updated.type, date: updated.date, title: updated.title, detail: updated.detail });
        // 制度审查 3：重新告知（通知里不写评级）
        if (recRecommunicate && reviewRecipientOk(store.getUserById(rec.userId))) notify(rec.userId, {
          type: "review",
          title: `Your final rating for ${recCycle.name} has been updated`,
          title_zh: `你「${recCycle.name}」的最终评级已更新`,
          body: `See it under Performance Reviews › My performance.` + (recReopen ? ` If you disagree with it, the appeal deadline is ${recReopenDeadline} (inclusive).` : ""),
          body_zh: `可在「绩效评估 › 我的绩效」查看。` + (recReopen ? `如有异议，申诉截止日为 ${recReopenDeadline}（含当日）。` : ""),
          link: "/review?view=history",
        });
      });
      return send(res, 200, { ok: true, record: updated });
    }
    if (recMatch && req.method === "DELETE") {
      const rec = store.getTalentRecord(recMatch[1]);
      if (!rec) return send(res, 404, { error: "Record not found" });
      if (!scopeAllowsFor(user, store.getUserById(rec.userId))) return send(res, 404, { error: "Record not found" }); // P2：按 rec.userId
      // 第二批 2.6（默认 G7）：周期归档的记录不能删除 —— 删了，员工「我的绩效」这一期就没了，九宫格按周期取评级也落空。
      // 要更正评级请编辑并写明理由。
      if (store.getReviewItemByRecordId(rec.id)) return send(res, 409, RECORD_FROM_CYCLE_ERR);
      // CX-168：不能删除本人的绩效记录（同修改与新增；超级管理员例外）
      if (rec.type === "performance" && rec.userId === user.id && !isSuperAdmin(user)) return appealErr(res, "rating_self_amend");
      // Deleting a synced record does NOT revert master data — state and
      // history are decoupled (the UI copy says so).
      store.deleteTalentRecord(rec.id);
      audit("talent.record.delete", rec.id, { userId: rec.userId, type: rec.type, date: rec.date, title: rec.title }, null);
      return send(res, 200, { ok: true });
    }
    // --- record type & field configuration (Settings) ---
    if (pathname === "/api/admin/config/records" && req.method === "GET") {
      // moduleOff 的类型（所属模块关闭，见 recordTypesOut）照常在清单里，由字段设置与批量导入自己不列出。
      // aiShare（是否发给 AI）：行为实践（3+3 不涉及 AI）与员工自定义字段（任何功能都不发）不返回该键
      return send(res, 200, { types: recordTypesOut(), fields: store.listRecordFields(null, true).map(fieldOut) });
    }
    if (pathname === "/api/admin/config/record-types" && req.method === "POST") {
      const label = String(body.label || "").trim().slice(0, 60);
      if (!label) return send(res, 400, { error: "Type label is required" });
      const existing = body.key ? store.getRecordType(body.key) : null;
      const key = existing ? existing.key : "ct-" + newToken().slice(0, 6);
      // CX-137：记录类型名（中文或英文，不分大小写）不能与其他类型重名（含已停用的），否则下拉无法区分
      {
        const nk = (x) => String(x || "").trim().toLowerCase();
        const zh0 = body.label_zh !== undefined ? body.label_zh : (existing ? existing.label_zh : "");
        // 只在新建或名称确实变更时校验（同一个接口也用于改图标、开关等，库里已有的重名不妨碍这些修改）
        const renamed = !existing || nk(existing.label) !== nk(label) || nk(existing.label_zh) !== nk(zh0);
        const clash = renamed && store.listRecordTypes(true).find((t) => t.key !== key && ((nk(t.label) && nk(t.label) === nk(label)) || (nk(zh0) && nk(t.label_zh) === nk(zh0))));
        if (clash) return send(res, 400, { error: `A record type named "${clash.label}" already exists.`, error_zh: `已有同名的记录类型「${clash.label_zh || clash.label}」。`, code: "type_name_taken" });
      }
      // The client posts the whole type back for any edit (an icon change, a
      // toggle), so label_zh has to be read here — dropping it meant
      // upsertRecordType fell back to `zh = en` and every toggle silently
      // replaced the Chinese label with the English one.
      const labelZh = body.label_zh !== undefined
        ? String(body.label_zh || "").trim().slice(0, 60)
        : (existing ? existing.label_zh : "");
      // 第二批 8.3（迁移 71）：经理可见。只收布尔或 0 / 1；没带时保留原值（新建默认可见）。前端同时带的 mgrVis 不读。
      const mv = body.managerVisible;
      if (mv !== undefined && mv !== true && mv !== false && mv !== 0 && mv !== 1)
        return send(res, 400, { error: "managerVisible must be true or false. 「经理可见」只能为开或关。", code: "bad_body" });
      const t = store.upsertRecordType({
        key, label, label_zh: labelZh,
        color: String(body.color || "#86909c").slice(0, 24),
        builtin: existing ? existing.builtin : false,
        active: body.active !== false,
        sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : (existing ? existing.sort : store.listRecordTypes(true).length),
        employeeVisible: body.employeeVisible !== undefined ? !!body.employeeVisible : (existing ? existing.employeeVisible : false),
        managerVisible: mv !== undefined ? !!mv : (existing ? existing.managerVisible : true),
      });
      audit("talent.config.type", key, existing, t);
      // 第二批 8.3：「经理可见」变化另记一行（决定上级能看到哪些记录，审计页单独可筛）
      if (existing && existing.managerVisible !== t.managerVisible)
        audit("talent.record-type.mgrvis", key, { managerVisible: existing.managerVisible }, { managerVisible: t.managerVisible });
      return send(res, 200, { ok: true, type: t });
    }
    const typeDel = pathname.match(/^\/api\/admin\/config\/record-types\/([\w-]+)$/);
    if (typeDel && req.method === "DELETE") {
      const t = store.getRecordType(typeDel[1]);
      if (!t) return send(res, 404, { error: "Type not found" });
      if (t.builtin) return send(res, 400, { error: "Built-in types can't be deleted (deactivate instead) 内置类型不可删除,可停用" });
      store.deleteRecordType(t.key);
      audit("talent.config.type-delete", t.key, t, null);
      return send(res, 200, { ok: true });
    }
    if (pathname === "/api/admin/config/record-fields" && req.method === "POST") {
      // typeKey "user" is reserved for CUSTOM EMPLOYEE FIELDS (HRIS groundwork):
      // rendered on the employee edit form, stored into users.extras.
      const typeKey = String(body.typeKey || "");
      if (typeKey !== "user" && !store.getRecordType(typeKey)) return send(res, 400, { error: "Unknown record type" });
      const label = String(body.label || "").trim().slice(0, 60);
      if (!label) return send(res, 400, { error: "Field label is required" });
      const input = ["text", "number", "date", "select", "suggest", "textarea", "checkbox"].includes(body.input) ? body.input : "text";
      // Same trap as record-types above: the create dialog posts both halves of the
      // label, and ignoring label_zh here made upsertRecordField fall back to
      // zh = en, so a brand-new field could never be given its Chinese name in one
      // go — it had to be created and then immediately edited (the PUT below does
      // read it). Leaving it blank keeps the store's zh = en fallback, which is the
      // right default for a field HR only ever names in English.
      const labelZh = body.label_zh !== undefined ? String(body.label_zh || "").trim().slice(0, 60) : "";
      // CX-137：同一类型下字段名（中文或英文，不分大小写）不能重名
      {
        const nk = (x) => String(x || "").trim().toLowerCase();
        const clash = store.listRecordFields(typeKey, true).find((f) => nk(f.label) === nk(label) || (nk(labelZh) && nk(f.label_zh) === nk(labelZh)));
        if (clash) return send(res, 400, { error: `This type already has a field named "${clash.label}".`, error_zh: `该类型下已有同名字段「${clash.label_zh || clash.label}」。`, code: "field_name_taken" });
      }
      const { id, key } = store.nextRecordFieldId();
      const maxSort = store.listRecordFields(typeKey, true).reduce((m, f) => Math.max(m, f.sort), -1);
      // options = stored value + English name; options_zh = Chinese names only.
      // Same trap as label_zh: dropping it here would force HR to create the
      // field and immediately edit it to name its choices in Chinese.
      const options = Array.isArray(body.options) ? body.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 50) : [];
      // 是否发给 AI（方案 2.2.1 第 5 条）：新建默认 omit；放宽（mask / send）只限超级管理员
      const shareIn = body.aiShare === undefined ? undefined : String(body.aiShare);
      if (shareIn !== undefined && !AI_SHARE_VALUES.has(shareIn)) return send(res, 400, { error: "aiShare must be send, mask or omit", code: "bad_ai_share" });
      if (shareIn !== undefined && AI_SHARE_NONE.has(typeKey) && shareIn !== "omit") return send(res, 400, { error: "This record type is never sent to AI.", error_zh: "该类记录不发送给 AI。", code: "ai_share_not_applicable" });
      if (shareIn && shareIn !== "omit" && !isSuperAdmin(user)) return send(res, 403, { error: "Only a super admin can widen what is sent to AI.", error_zh: "只有超级管理员可以扩大发送给 AI 的范围。", code: "ai_share_super_admin" });
      const f = store.upsertRecordField({
        aiShare: AI_SHARE_NONE.has(typeKey) ? undefined : shareIn || "omit",
        id, typeKey, key, label, label_zh: labelZh, input,
        options, options_zh: parseOptionsZh(body.options_zh, options),
        // 选项说明（迁移 56，IA 4.8）：与 options 按位置对齐，store 负责截齐
        options_desc: Array.isArray(body.options_desc) ? body.options_desc : undefined,
        options_desc_zh: Array.isArray(body.options_desc_zh) ? body.options_desc_zh : undefined,
        required: !!body.required, showInTimeline: body.showInTimeline !== false, filterable: !!body.filterable,
        sort: maxSort + 1, active: true,
      });
      audit("talent.config.field", f.id, null, f);
      if (!AI_SHARE_NONE.has(typeKey) && f.aiShare !== "omit") audit("ai.datashare.change", f.id, null, { typeKey, key: f.key, from: null, to: f.aiShare });
      return send(res, 200, { ok: true, field: fieldOut(f) });
    }
    const fieldMatch = pathname.match(/^\/api\/admin\/config\/record-fields\/([\w-]+)$/);
    if (fieldMatch && req.method === "PUT") {
      const f = store.getRecordField(fieldMatch[1]);
      if (!f) return send(res, 404, { error: "Field not found" });
      let shareNext = f.aiShare;
      if (body.aiShare !== undefined) {
        const v = String(body.aiShare);
        if (!AI_SHARE_VALUES.has(v)) return send(res, 400, { error: "aiShare must be send, mask or omit", code: "bad_ai_share" });
        if (AI_SHARE_NONE.has(f.typeKey)) return send(res, 400, { error: "This record type is never sent to AI.", error_zh: "该类记录不发送给 AI。", code: "ai_share_not_applicable" });
        // 放宽（omit→mask/send、mask→send）只限超级管理员（每次变更记审计 ai.datashare.change）；改严不限
        if (AI_SHARE_RANK[v] > AI_SHARE_RANK[f.aiShare] && !isSuperAdmin(user)) return send(res, 403, { error: "Only a super admin can widen what is sent to AI.", error_zh: "只有超级管理员可以扩大发送给 AI 的范围。", code: "ai_share_super_admin" });
        shareNext = v;
      }
      const input = ["text", "number", "date", "select", "suggest", "textarea", "checkbox"].includes(body.input) ? body.input : f.input;
      // CX-137：改名时同一类型下不能与其他字段重名
      {
        const nk = (x) => String(x || "").trim().toLowerCase();
        // 只在名称确实变更时校验（库里已有的重名不妨碍改其他设置）
        const nl0 = body.label !== undefined ? String(body.label).trim() : "", nz0 = body.label_zh !== undefined ? String(body.label_zh).trim() : "";
        const nl = nk(nl0) !== nk(f.label) ? nl0 : "", nz = nk(nz0) !== nk(f.label_zh) ? nz0 : "";
        const clash = (nl || nz) && store.listRecordFields(f.typeKey, true).find((x) => x.id !== f.id && ((nl && nk(x.label) === nk(nl)) || (nz && nk(x.label_zh) === nk(nz))));
        if (clash) return send(res, 400, { error: `This type already has a field named "${clash.label}".`, error_zh: `该类型下已有同名字段「${clash.label_zh || clash.label}」。`, code: "field_name_taken" });
      }
      const options = body.options !== undefined
        ? (Array.isArray(body.options) ? body.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 50) : [])
        : f.options;
      const updated = store.upsertRecordField({
        ...f,
        label: body.label !== undefined ? String(body.label).trim().slice(0, 60) || f.label : f.label,
        label_zh: body.label_zh !== undefined ? String(body.label_zh).trim().slice(0, 60) || f.label_zh : f.label_zh,
        input,
        options,
        // Re-align even when only `options` was edited: the two arrays pair by
        // index, so keeping the stored zh list unchanged after an option was
        // added or removed would relabel the wrong choices. Positional re-align
        // is a guess, but a guess that keeps the arrays the same length.
        options_zh: parseOptionsZh(body.options_zh !== undefined ? body.options_zh : f.options_zh, options),
        // 选项说明（迁移 56）：没带时沿用库里的说明（按位置对齐到新的 options）
        options_desc: Array.isArray(body.options_desc) ? body.options_desc : f.options_desc,
        options_desc_zh: Array.isArray(body.options_desc_zh) ? body.options_desc_zh : f.options_desc_zh,
        required: body.required !== undefined ? !!body.required : f.required,
        showInTimeline: body.showInTimeline !== undefined ? !!body.showInTimeline : f.showInTimeline,
        filterable: body.filterable !== undefined ? !!body.filterable : f.filterable,
        sort: body.sort !== undefined && Number.isFinite(Number(body.sort)) ? Number(body.sort) : f.sort,
        active: body.active !== undefined ? !!body.active : f.active,
        aiShare: AI_SHARE_NONE.has(f.typeKey) ? undefined : shareNext,
      });
      audit("talent.config.field", f.id, f, updated);
      if (!AI_SHARE_NONE.has(f.typeKey) && shareNext !== f.aiShare) audit("ai.datashare.change", f.id, null, { typeKey: f.typeKey, key: f.key, from: f.aiShare, to: shareNext });
      return send(res, 200, { ok: true, field: fieldOut(updated) });
    }
    if (fieldMatch && req.method === "DELETE") {
      const f = store.getRecordField(fieldMatch[1]);
      if (!f) return send(res, 404, { error: "Field not found" });
      // Old values stay in record JSON harmlessly; they simply stop rendering.
      store.deleteRecordField(f.id);
      audit("talent.config.field-delete", f.id, f, null);
      return send(res, 200, { ok: true });
    }
    // --- departments (managed org dimension, HRIS groundwork) ---
    if (pathname === "/api/admin/departments" && req.method === "GET") {
      // One GROUP BY, not one COUNT per department: at 272 departments × 8.8k
      // employees the per-department query scanned the table 272 times and made
      // this the slowest endpoint in the console (~1.4s).
      // 人数按部门 id 归并，匹配口径与 org.js / 范围解析相同（先原文、再不区分大小写）：
      // 「sales」下的人算进「Sales」，与 HoD 名单的成员数、删除前的人数校验说同一个数。
      const deptRows = store.listDepartments(true);
      const deptIdx = orgLib.buildOrgIndex(deptRows);
      const counts = new Map();
      // CX-127：页头与每行的人数只计在职（在职判定同 orgLib.isInService：账号可用、未离职），与员工档案的「在职」一致
      for (const r of store.countByDepartment({ inService: true })) {
        const hit = deptIdx.deptOf(r.name);
        if (hit) counts.set(hit.id, (counts.get(hit.id) || 0) + r.n);
      }
      // P2 范围：只回范围子树内的部门。headcount 不需要另做「重算」—— 过滤之后剩下的
      // 每个部门**整体**都在范围内，所以它自己的人数天然就是范围内人数（users.department
      // 是部门名，名字在范围内 ⇒ 该行所有人都在范围内）。清点文档 §2 要求的「重算」在
      // 这条端点上由过滤本身满足；ownerName 同理（负责人若在范围外仍会显示姓名，与
      // org-chart 方案 B 同一条取舍：他就是这个范围的直接上级线）。
      // 这一条也是「把人调到范围外部门」这个操作在界面上自然消失的地方（§7.1 的取舍）。
      const deptScope = scopeDeptPredicate(user);
      return send(res, 200, deptRows.filter((d) => !deptScope || deptScope(d.name)).map((d) => {
        const owner = d.ownerId ? store.getUserById(d.ownerId) : null;
        return { ...d, headcount: counts.get(d.id) || 0, ownerName: owner ? owner.name : null, ownerEmployeeId: owner ? owner.employeeId : null };
      }));
    }
    if (pathname === "/api/admin/departments" && req.method === "POST") {
      // Compat: the Employees page's manage-departments modal still posts the
      // pre-departments-table shape {action:'rename'|'delete', name}.
      // P2 范围（清点文档 §7.1）：部门写 = 对该部门**全体员工**的一次批量写 ——
      // 改名走 UPDATE users SET department、删除走 clearDepartment 置 NULL。所以这三种
      // 形态（rename / delete / create）全部按目标部门校验，否则一个范围限定在「研发
      // 中心」的 HRBP 能改名/删除「财务部」，等于绕过范围过滤改到了范围外的人。
      // 改名只校验**旧**名：范围按部门 **id** 配置，改完名字范围自动跟随（store.js
      // 的 SCOPE_EPOCH 保证下一次解析就是新名称），所以新名不需要、也不可能预先在范围里。
      if (body.action === "rename") {
        const from = String(body.name || "").trim();
        const to = String(body.newName || "").trim().slice(0, 80);
        if (!from || !to) return send(res, 400, { error: "Department name is required" });
        if (!scopeAllowsDeptFor(user, from)) return sendScopeDeptReject(res);
        const dup = store.getDepartmentByName(to);
        const row = store.getDepartmentByName(from);
        if (dup && (!row || dup.id !== row.id)) return send(res, 400, { error: "That department already exists.", error_zh: "部门已存在。", code: "dept_exists" });   // CX-131：中英文分开
        let changed;
        if (row) { store.updateDepartment(row.id, { name: to }); changed = store.countUsersInDepartment(to); }
        else changed = store.renameDepartment(from, to);
        audit("department.rename", row ? row.id : null, { name: from }, { name: to, employees: changed });
        return send(res, 200, { ok: true, changed });
      }
      if (body.action === "delete") {
        const name = String(body.name || "").trim();
        if (!name) return send(res, 400, { error: "Department name is required" });
        if (!scopeAllowsDeptFor(user, name)) return sendScopeDeptReject(res); // P2：见上
        const row = store.getDepartmentByName(name);
        // Same guard as DELETE /api/admin/departments/:id. This legacy shape used
        // to skip it and go straight to clearDepartment(), which NULLs the
        // department on every member — hundreds of rows, no undo. Two endpoints
        // deleting the same thing must not disagree about whether it is allowed.
        const occupied = store.countUsersInDepartment(name);
        if (occupied > 0) return sendDeptOccupied(res, occupied);
        const n = store.clearDepartment(name);
        if (row) store.deleteDepartment(row.id);
        audit("department.delete", row ? row.id : null, { name, employees: n }, null);
        return send(res, 200, { ok: true, changed: n });
      }
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) return send(res, 400, { error: "Department name is required" });
      const parent = body.parentId ? store.listDepartments(true).find((x) => x.id === body.parentId) : null;
      if (body.parentId && !parent) return send(res, 400, { error: "Parent department not found 上级部门不存在" });
      // parentName ("上级 > 子部门" bulk syntax) creates the parent on demand.
      // P2 范围：建部门必须挂在一个**范围内的上级**下面。范围受限的角色不能建根部门
      // —— 新部门的 id 不在任何人的 scope 里，建完谁也看不见（自己第一个看不见），
      // 那不是「创建」而是「凭空造出一个范围外部门」。挂到范围内的父级下则天然继承
      // includeChildren 的可见性。parentName 也必须指向**已存在**的部门：这条路径原本
      // 会按需 ensureDepartment 造父级，对范围受限的角色等于绕过上面这条判定。
      if (scopePredicate(user)) {
        const pByName = !parent && body.parentName ? store.getDepartmentByName(String(body.parentName).trim().slice(0, 80)) : null;
        const parentInScope = parent || pByName;
        if (!parentInScope || !scopeAllowsDeptFor(user, parentInScope.name)) return sendScopeDeptReject(res);
      }
      const parentByName = !parent && body.parentName ? store.ensureDepartment(String(body.parentName).trim().slice(0, 80)) : null;
      const pid = parent ? parent.id : parentByName ? parentByName.id : null;
      const existing = store.getDepartmentByName(name);
      if (existing) {
        // 「认领孤儿部门」这一支是对一个**已存在**部门的写（改它的 parentId），所以
        // 它自己也必须在范围内 —— 否则等于把一个范围外部门拽进自己的子树。
        if (!scopeAllowsDeptFor(user, existing.name)) return sendScopeDeptReject(res);
        if (pid && !existing.parentId && pid !== existing.id) {
          // 与 PUT /departments/:id 同一条规则：不能挂到自己的子树下。一个带下级的根部门被
          // 「认领」到它自己的某个下级名下会形成 parentId 环 —— 环上的部门全部掉出一级部门树，
          // 整个一级部门从 HoD 名单消失、成员变成未归属（store.ensureDepartment 也拦，这里先回 400）。
          if (store.departmentWouldCycle(existing.id, pid)) return sendDeptCycle(res);
          const d2 = store.ensureDepartment(name, pid); // adopt the orphan into the tree
          audit("department.update", name, deptAuditShape(existing), deptAuditShape(d2));
          return send(res, 200, { ok: true, department: d2, adopted: true });
        }
        return send(res, 400, { error: "That department already exists.", error_zh: "部门已存在。", code: "dept_exists" });
      }
      const d = store.ensureDepartment(name, pid);
      audit("department.create", name, null, { id: d.id, name, parentId: pid });
      return send(res, 200, { ok: true, department: d });
    }
    // --- HoD 名单：每个在用一级部门的负责人（部门页「负责人」优先，否则按汇报线推算）---
    // 规则见 modules/core/org.js；范围口径见 hodListFor。两条都是 people 域的读，排在
    // departments/:id 通配之前（manifest order 172/174 < 180）。
    if (pathname === "/api/admin/departments/hods" && req.method === "GET") return send(res, 200, hodListFor(user));
    if (pathname === "/api/admin/departments/hods.csv" && req.method === "GET") {
      const hodList = hodListFor(user);
      audit("export.hods-csv", null, null, { rows: hodList.items.length });
      return sendCsv(res, `hod-list-${todayLocal()}.csv`, hodCsvRows(hodList));
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 13589–14050 行（/api/admin/ 块内）
    async adminCore5(C) {
      const { pathname, req, res, user, body, audit, cycleMatch, query } = C;
      const { store, send, scopeAllowsFor, canonOption, orgSnapshot, reviewHodUnresolved, reviewDeptInactive, reviewSnapLocks, reviewHrCalibAccess, reviewUnresolvedErr, appealErr, appealPerfVisible, scopePredicate, sendScopeBulkReject, nowMs, manilaDay, workdayAdd, APPEAL_WINDOW_WORKDAYS, reviewHolidaySet, reviewRecipientOk, reviewResultsNotify, todayLocal, reviewGroups, reviewSnapDiff, reviewSnapGet, newToken, wbTodo, wbContext, wbRisk, wbStructure, wbPeople, modulesOn, dateLocalOffset, PROGRAMS, programDone, canRead, tfPromotionEligible, tfContext, scopeDeptPredicate, isSuperAdmin, resolveGrants, jobGrades, CT, parseTags } = S;
    const riMatch = pathname.match(/^\/api\/admin\/review-items\/([\w-]+)$/);
    if (riMatch && req.method === "PUT") {
      const item = store.getReviewItem(riMatch[1]);
      if (!item) return send(res, 404, { error: "Review record not found. 未找到该员工的评估记录。", code: "not_found" });
      // P2 范围：单人主体（按 item.userId 校准某个人的最终评级）→ 裸 404，与上一行
      // 「不存在」逐字同形，不暴露「这条 review item 确实存在，只是不归你管」。
      if (!scopeAllowsFor(user, store.getUserById(item.userId))) return send(res, 404, { error: "Review record not found. 未找到该员工的评估记录。", code: "not_found" });
      const cycle = store.getReviewCycle(item.cycleId);
      if (!cycle || cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
      const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
      const opts = ratingField ? ratingField.options : [];
      // Clearing the override (null/"") and sending an unrecognized value are
      // different outcomes, and only the raw value tells them apart: canonOption
      // returns null both for "not on the scale" and for "nothing sent", so
      // reading a typo as a clear would wipe a calibrated rating without a word.
      const rawFinal = body.finalRating === null || body.finalRating === "" ? null : String(body.finalRating).trim();
      const rating = rawFinal === null ? null : canonOption(ratingField || {}, rawFinal);
      if (rawFinal !== null && (rating === null || (opts.length && !opts.includes(rating))))
        return send(res, 400, { error: "Select a valid performance rating. 请选择有效的绩效评级。", code: "rating_required" });
      if (cycle.flow === "v2") {
        const snapRi = orgSnapshot();
        const t = store.getUserById(item.userId); const lv = t ? snapRi.levelsOf(t.department) : null;
        const key = lv && lv.level1Id ? lv.level1Id : "__none";
        const st = store.getReviewDeptStatus(cycle.id, key);
        // 先查已确认（review-v2.test 依赖这个顺序），再查 HoD 只读
        if (st && st.hrConfirmedAt) return send(res, 400, { error: "This department has been confirmed. 该部门已确认，不能再修改。", code: "dept_confirmed" });
        // P0 1.1：与 HoD 校准路由同一口径取 HoD；组的 HoD 状态用 reviewGroups 的同一套判定（reviewHrCalibAccess）
        const hod = t && lv ? snapRi.hodOf(t.department) : null;
        const hodUnresolved = reviewHodUnresolved(snapRi, lv, hod);
        const g = { dept1Id: key, hod: hod ? { id: hod.id } : null, hodUnresolved, deptInactive: hodUnresolved && reviewDeptInactive(snapRi, lv) };
        const readonlyErr = {
          error: "In this cycle the HoD calibrates this department; HR can only confirm or return it. 本周期由 HoD 校准该部门，HR 只能确认或退回。",
          code: "hod_calibration_readonly",
        };
        // 此人还在另一个已提交 / 已确认部门的快照里（调出已锁定的部门再改 —— 审查）：按那个部门的状态拒绝
        const lockedBy = reviewSnapLocks(cycle.id).get(item.userId);
        if (lockedBy) return lockedBy.hrConfirmedAt ? send(res, 400, { error: "This department has been confirmed. 该部门已确认，不能再修改。", code: "dept_confirmed" }) : send(res, 409, readonlyErr);
        const access = reviewHrCalibAccess(g, st, item.userId);
        if (access === "readonly") return send(res, 409, readonlyErr);
        if (access === "unresolved") return send(res, 409, reviewUnresolvedErr(g));
        // 无 HoD 的组（含 __none）与 HoD 本人的评估项：沿用 HoD 规则 —— 季度周期改了上级评级须写理由，年度选填（D4）；
        // 理由写进 hodText，hodAt / hodId 记录谁做的校准
        const reason = String(body.reason || "").trim().slice(0, 1000);
        if (cycle.kind !== "annual" && rating && item.managerRating && rating !== item.managerRating && !reason)
          return send(res, 400, { error: "Give a reason for changing the manager rating. 调整上级评级须填写理由。", code: "reason_required" });
        audit("review.calibrate", item.id, { finalRating: item.finalRating }, { finalRating: rating, reason: reason || null });
        return send(res, 200, { ok: true, item: store.updateReviewItem(item.id, { finalRating: rating, hodText: reason || null, hodAt: new Date().toISOString(), hodId: user.id }) });
      }
      // 旧流程不动：只写 finalRating，不要求理由
      audit("review.calibrate", item.id, { finalRating: item.finalRating }, { finalRating: rating });
      return send(res, 200, { ok: true, item: store.updateReviewItem(item.id, { finalRating: rating }) });
    }
    // Close: every rated item becomes a performance record on the profile —
    // the flow feeds the timeline and the 9-box automatically.
    // Discard a cycle launched by mistake (wrong scope, typo in the name).
    // Only while it is open AND nobody has put anything into it — once a single
    // self-review, rating or profile record exists the cycle is history and can
    // only be closed, never erased.
    if (cycleMatch && req.method === "DELETE") {
      const cycle = store.getReviewCycle(cycleMatch[1]);
      if (!cycle) return send(res, 404, { error: "Review cycle not found. 未找到该评估周期。", code: "cycle_not_found" });
      if (cycle.status !== "open") return send(res, 400, { error: "A closed review cycle cannot be deleted. 已关闭的评估周期不能删除。", code: "cycle_closed" });
      const p = store.countReviewCycleProgress(cycle.id) || {};
      if (p.selfDone || p.rated || p.written) {
        return send(res, 400, {
          error: "This cycle already has submissions; close it instead of deleting it. 该评估周期已有提交内容，只能关闭，不能删除。", code: "has_submissions",
          selfDone: p.selfDone || 0, rated: p.rated || 0,
        });
      }
      store.deleteReviewCycle(cycle.id);
      audit("review.cycle.delete", cycle.id, null, { name: cycle.name, participants: p.total || 0 });
      return send(res, 200, { ok: true, removed: p.total || 0 });
    }
    // 第二批 2.8（§4.5 R1）：已关闭、关闭时结果对员工隐藏（从未通知过）的周期补发结果通知并开放申诉。上线前已通知过的周期
    // （迁移 70 回填了 resultsAt）不能再开放（负责人：逾期申诉不予处理）。整周期范围判定与关闭相同。
    const cycleCommMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)\/communicate$/);
    if (cycleCommMatch && req.method === "POST") {
      const cycle = store.getReviewCycle(cycleCommMatch[1]);
      if (!cycle) return appealErr(res, "cycle_not_found");
      if (cycle.status !== "closed") return appealErr(res, "cycle_open");
      if (cycle.resultsAt) return appealErr(res, "results_communicated");
      if (!appealPerfVisible()) return appealErr(res, "results_hidden");
      const commScope = scopePredicate(user);
      if (commScope) {
        const outOfScope = store.listCycleItems(cycle.id).filter((i) => !commScope(store.getUserById(i.userId))).length;
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      const atIso = new Date(nowMs()).toISOString();
      const communicatedOn = manilaDay(nowMs());
      const deadline = workdayAdd(communicatedOn, APPEAL_WINDOW_WORKDAYS, reviewHolidaySet());
      if (!store.setReviewCycleResultsAt(cycle.id, atIso, deadline)) return appealErr(res, "results_communicated");
      let notified = 0;
      for (const i of store.listCycleItems(cycle.id)) {
        if (!i.recordId || !reviewRecipientOk(store.getUserById(i.userId))) continue;
        reviewResultsNotify(i.userId, cycle, deadline);
        notified++;
      }
      audit("review.cycle.communicate", cycle.id, null, { notified, deadline });
      return send(res, 200, { ok: true, notified, communicatedOn, deadline });
    }
    const cycleCloseMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)\/close$/);
    if (cycleCloseMatch && req.method === "POST") {
      const cycle = store.getReviewCycle(cycleCloseMatch[1]);
      if (!cycle) return send(res, 404, { error: "Review cycle not found. 未找到该评估周期。", code: "cycle_not_found" });
      if (cycle.status !== "open") return send(res, 400, { error: "This review cycle is already closed. 该评估周期已关闭。", code: "cycle_closed" });
      // LOCAL day: this one is written INTO the record (createTalentRecord.date below),
      // so a UTC day does not merely display wrong for a morning — it freezes the wrong
      // calendar date into a performance record that promotion eligibility and the
      // timeline order then read.
      const today = todayLocal();
      /* ===== P2 范围 —— 唯一一条按「**整周期**」判定的端点（清单 §9 ①）=====
         关账逐条把每个人的评级写成 talent_records 里一条 type=performance 的**永久档案**，
         写完无条件 closeReviewCycle，而 status !== "open" 的周期一律 400 —— 关了就再也
         打不开。所以「跳过越界项」在这里不是降级，是**不可逆的数据缺失**：范围外员工的
         绩效史上会留下一个永久空洞，而 i.recordId 的幂等保护只防重复写、**不防漏写**，
         事后没有任何补写路径。全部 112 条里只有这一条有这个性质。
         因此口径是：周期里只要含一个范围外参与者 → **整周期拒绝**，一条档案都不写，
         周期保持 open（HR 可以让有全公司范围的人来关，或先把周期拆开）。回报越界人数，
         沿用批量端点的同一个应答（404 + code:'out_of_scope' + outOfScope:n）—— 不给数字
         的 404 等于让 HR 在几百个参与者里盲找。
         注：DELETE /review-cycles/:id 按清单 §7.3 维持不约束（它有硬门：任何提交/评级/
         落档非零即 400，所以能删的时候周期里没有任何员工产出）。 */
      const closeScope = scopePredicate(user);
      if (closeScope) {
        const outOfScope = store.listCycleItems(cycle.id).filter((i) => !closeScope(store.getUserById(i.userId))).length;
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      // 绩效流程 v2：所有一级部门组都须 HR 已确认
      if (cycle.flow === "v2") {
        const closeGroups = reviewGroups(cycle, store.listCycleItems(cycle.id));
        const pending = closeGroups.filter((g) => !(g.status && g.status.hrConfirmedAt));
        if (pending.length) return send(res, 400, {
          error: `${pending.length} department(s) are not confirmed yet. 还有 ${pending.length} 个部门未确认。`, code: "depts_unconfirmed",
          depts: pending.map((g) => g.dept1 || "—").slice(0, 50),
        });
        // P0 E3：确认之后部门成员或评级又变了（调进来的人没人确认过、配额也可能悄悄超了）→ 拒绝关闭，须退回 / 撤销确认后重新确认
        const changed = closeGroups.filter((g) => reviewSnapDiff(reviewSnapGet(cycle.id, g.dept1Id).confirm, g));
        if (changed.length) return send(res, 400, {
          error: `The members or ratings of ${changed.length} confirmed department(s) changed after confirmation; return or reopen and confirm them again. 有 ${changed.length} 个已确认部门的人员或评级在确认后发生了变动，请退回或撤销确认后重新确认。`,
          code: "depts_changed", depts: changed.map((g) => g.dept1 || "—").slice(0, 50),
        });
      }
      let written = 0, skipped = 0;
      const archivedUsers = [];
      for (const i of store.listCycleItems(cycle.id)) {
        const rating = i.finalRating || i.managerRating;
        if (!rating) { skipped++; continue; }
        if (i.recordId) continue; // idempotence safety
        const rec = store.createTalentRecord({
          id: "tr-" + newToken().slice(0, 10), userId: i.userId, type: "performance", date: today,
          title: cycle.name,
          // 评语只写上级评语，没有则留空（IA B-F02、D-16 ①）：员工写给公司的建议不是「评语」，
          // 记进本人档案的「评语」位置与字段含义不符。
          detail: { period: cycle.name, rating, summary: i.managerText || "", ...(i.managerText ? { summaryAuthor: "manager" } : {}) },
          programId: null, createdBy: user.id,
        });
        // 第二批 2.8（制度审查 7）：记下归档时所在部门，申诉按它路由
        const closeOwner = store.getUserById(i.userId);
        store.updateReviewItem(i.id, { recordId: rec.id, closeDept: closeOwner && closeOwner.department ? closeOwner.department : null });
        written++;
        archivedUsers.push(i.userId);
      }
      // 第二批 2.8：关闭时刻与结果告知时刻取同一个 nowMs()（制度审查 18）
      const closeAtIso = new Date(nowMs()).toISOString();
      store.closeReviewCycle(cycle.id, closeAtIso);
      // B-F07：结果对员工可见时（「绩效记录」类型开了员工可见）通知本人；不可见时不发，避免指向看不到的内容
      // 第二批 2.8：可见时这就是结果的正式告知 —— 先写 resultsAt 与申诉截止日（5 个工作日），再发通知（N1，带截止日）
      const perfType = store.getRecordType("performance");
      if (perfType && perfType.active && perfType.employeeVisible) {
        const closeDeadline = workdayAdd(manilaDay(Date.parse(closeAtIso)), APPEAL_WINDOW_WORKDAYS, reviewHolidaySet());
        store.setReviewCycleResultsAt(cycle.id, closeAtIso, closeDeadline);
        for (const uid of archivedUsers) reviewResultsNotify(uid, cycle, closeDeadline);
      }
      audit("review.cycle.close", cycle.id, null, { written, skipped });
      return send(res, 200, { ok: true, written, skipped });
    }

    // --- cross-domain dashboard (工作台): the console opens on PEOPLE, not
    // training. One aggregate so the page is a single fetch. ---
    // ---------- 12.2 工作台（外壳路由，RBAC_SHELL order 6–9：任何后台角色可进；每块在 wbTodo / wbRisk / wbStructure 里按模块开关 + 能力域裁剪，
    // 无权的块整块不下发，与 dashboard W4 同法；名单接口对未知或无权的 metric 一律 404，与 none 档同形）。实现见 wbContext 一节。
    if (pathname === "/api/admin/workbench/todo" && req.method === "GET") return send(res, 200, wbTodo(wbContext(user)));
    if (pathname === "/api/admin/workbench/risk" && req.method === "GET") return send(res, 200, wbRisk(wbContext(user)));
    if (pathname === "/api/admin/workbench/structure" && req.method === "GET") return send(res, 200, wbStructure(wbContext(user)));
    if (pathname === "/api/admin/workbench/people" && req.method === "GET") {
      const out = wbPeople(wbContext(user), query);
      if (!out) return send(res, 404, { error: "Not found" });
      return send(res, 200, out);
    }
    if (pathname === "/api/admin/dashboard" && req.method === "GET") {
      // This aggregate never closes with a module (the console home must keep
      // working); instead each domain's queries are skipped and its fields come
      // back empty. `modules` rides along so the UI hides the matching cards
      // from the switch state rather than guessing from empty arrays.
      // M0: modulesOn() keys = REGISTRY.SELLABLE (manifest sellable:true), so the
      // switch set trimmed here is the registry's, not a hand-kept list.
      const mods = modulesOn();
      // P2 范围：人员域字段按范围**重算**，不是「算完再过滤」也不是「过滤后不改分母」。
      // 做法是在**基础人群**上过滤一次，下面每个计数自然就是范围内的计数（headcount /
      // probation / exitedTotal / newHires30d / recentHires / byDept 全部由这两个数组导出）。
      // 与 P1 的 W4 字段裁剪是**两层**，顺序不能颠倒：先按 grants 决定字段在不在（下面
      // 那段 delete），再按范围决定字段的值（这里）—— 一个 people=none 的角色连
      // headcount 这个键都不该有，那与范围是几个部门无关。
      // ⚠ 一并落在过滤后人群上的还有 training[] 与 promotionPool（它们由同一个 active
      // 数组导出，清点文档 §6.5 也要求重算）。cycles[]（走 listCycleItems）与
      // succession 不由 active 导出，各自单独重算 —— 见下面那两处；阶段 C 补齐后，
      // 工作台上的每一个数字都与它对应的列表页（/review-cycles、/succession、
      // /promotion-candidates、/pending-counts）同口径，不再有「首页说 12、点进去 3」。
      const dashScope = scopePredicate(user);
      const users = store.listUsers().filter((u) => u.role !== "admin" && (!dashScope || dashScope(u)));
      const active = users.filter((u) => u.active !== 0);
      const byDept = {};
      for (const u of active) {
        const d = u.department || "—";
        byDept[d] = (byDept[d] || 0) + 1;
      }
      // Local day: hireDate is a local calendar date, so a UTC window edge
      // quietly moved the "last 30 days" boundary before 08:00 Manila time.
      const monthAgo = dateLocalOffset(-30);
      // The KPI is a count of everyone hired in the window; the card below it
      // only lists the newest few. Deriving the count from the truncated list
      // capped the KPI at 6 forever, so the two are computed separately.
      const hiredInWindow = active
        .filter((u) => u.hireDate && u.hireDate >= monthAgo)
        .sort((a, b) => (a.hireDate < b.hireDate ? 1 : -1));
      const newHires30dCount = hiredInWindow.length;
      const recentHires = hiredInWindow.slice(0, 6)
        .map((u) => ({ id: u.id, name: u.name, hireDate: u.hireDate, department: u.department || null }));
      // Training completion per program (assigned actives vs passed).
      const training = !mods.learning ? [] : PROGRAMS.map((p) => {
        let assigned = 0, passed = 0;
        for (const u of active) {
          // 第四批 7：只计指派（不含自主学习，卡片副标题写明）
          const a = store.getUserAssignments(u.id)[p.id];
          if (!a || a.source === "self") continue;
          assigned++;
          if (programDone(u.id, p)) passed++;
        }
        // 培训完成率 card labels each bar with loc(p,'title'); without title_zh the
        // whole card read English inside an otherwise Chinese dashboard.
        return { id: p.id, title: p.title, title_zh: p.title_zh || null, assigned, passed };
      });
      // P2 范围（阶段 C）：与 GET /api/admin/review-cycles 逐字同口径 —— 分母 total 也
      // 按范围重算，否则首页卡片与绩效列表页的同一个周期会显示两个进度。
      const cycles = !mods.performance ? [] : store.listReviewCycles().filter((c) => c.status === "open").map((c) => {
        const items = store.listCycleItems(c.id).filter((i) => !dashScope || dashScope(store.getUserById(i.userId)));
        return { id: c.id, name: c.name, total: items.length, selfDone: items.filter((i) => i.selfAt).length, mgrDone: items.filter((i) => i.managerAt).length };
      });
      // Promotion pool size. 第五批：由引擎对内置筛选「晋升评审候选」计数（按范围），与 GET /promotion-candidates 的
      // eligible 同一口径、同一人群（原先这里手写一份、候选页另写一份，两处人数会不一致）。
      // talent off → the whole computation is skipped and the tile hides; 没有 talent 读权限也不算（字段随后会被删掉）。
      let pool = 0;
      if (mods.talent && canRead(user, "talent")) {
        const ids = tfPromotionEligible(tfContext(user));
        pool = ids ? ids.size : 0;
      }
      const dash = {
        headcount: active.length,
        probation: active.filter((u) => u.empStatus === "probation").length,
        exitedTotal: users.filter((u) => u.empStatus === "exited").length,
        newHires30d: newHires30dCount,
        recentHires,
        byDept: Object.entries(byDept).sort((a, b) => b[1] - a[1]).slice(0, 8),
        // Total so the card's "all N departments" link states the real figure
        // rather than the 8 it happens to be showing.
        deptTotal: (() => { const p = scopeDeptPredicate(user); return p ? store.listDepartments(true).filter((d) => p(d.name)).length : store.listDepartments(true).length; })(),
        training, cycles,
        promotionPool: pool,
        // P2 范围（阶段 C）：按继任人的部门重算，与 GET /api/admin/succession 的 rows[] 同口径。
        succession: mods.talent ? store.listSuccession().filter((sx) => !dashScope || dashScope(store.getUserById(sx.userId))).length : 0,
        modules: mods,
      };
      // RBAC W4: on top of the module trim above, drop each domain's fields when
      // the viewer's role can't read that domain (field→domain map = MODULES 4.2).
      if (!isSuperAdmin(user)) {
        const g = resolveGrants(user);
        const has = (d) => g[d] === "read" || g[d] === "manage";
        if (!has("people")) for (const k of ["headcount", "probation", "exitedTotal", "newHires30d", "recentHires", "byDept", "deptTotal"]) delete dash[k];
        if (!has("learning")) delete dash.training;
        if (!has("performance")) delete dash.cycles;
        if (!has("talent")) { delete dash.promotionPool; delete dash.succession; }
      }
      return send(res, 200, dash);
    }

    // --- org chart 组织架构: nodes + reporting edges (managerId) ---
    // System/admin accounts are not part of the org tree (they hold no position).
    if (pathname === "/api/admin/org-chart" && req.method === "GET") {
      const all = store.listUsers().filter((u) => u.active !== 0 && u.role !== "admin");
      /* ---- P2 范围 —— 设计选择②：范围内的人 + **祖先链骨架节点**（清点文档 §8 方案 B）----
         问题：只回范围内的人会把树打断 —— 范围内某人的 managerId 指向范围外的上级，
         前端画树时该节点成孤儿（或整棵子树浮空），组织图的全部价值（连通）就没了。
         选 B 不选 A（只画范围内子树）：A 零泄露但「我们部门挂在谁下面」这个信息消失，
         组织图看起来像一家独立公司，而这恰是组织诊断第一个要看的东西。
         选 B 不选 C（骨架脱敏成「（上级部门）」）：C 泄露最小但界面难懂，前端要为骨架
         节点单独写一套渲染分支，而收益只是隐去**自己直属上级链**的姓名 —— 那是员工
         本人也知道的信息，不构成新泄露面。
         代价（明确接受）：范围外员工的**姓名 + 部门**会出现在骨架节点上，但仅限于
         范围内人员的直属上级链，且骨架节点带 `outOfScope: true` 显式标记 + 其余字段
         一律 null。标记是硬要求：没有它前端会拿骨架节点去调 /employees/:id/profile，
         然后吃一个 404，看起来像 bug（现在那个 404 是范围校验的正确行为）。
         注意 org-diagnostics 的 spans[]/matrix 不适用本方案：那是统计，范围外经理必须
         整条剔除（见下一条端点）。 */
      const chartScope = scopePredicate(user);
      const skeleton = new Set();
      let people = all;
      if (chartScope) {
        const byId = new Map(all.map((u) => [u.id, u]));
        const keep = new Map();
        for (const u of all) if (chartScope(u)) keep.set(u.id, u);
        for (const u of [...keep.values()]) {
          // 上溯到第一个已在集合里的祖先即止（它的祖先上一轮已走过），hops 防环。
          let cur = u.managerId, hops = 0;
          while (cur && hops++ < 100 && !keep.has(cur)) {
            const m = byId.get(cur);
            if (!m) break;
            keep.set(m.id, m);
            skeleton.add(m.id);
            cur = m.managerId;
          }
        }
        people = [...keep.values()];
      }
      const inTree = new Set(people.map((u) => u.id));
      return send(res, 200, {
        nodes: people.map((u) => (skeleton.has(u.id)
          // 骨架节点：只有连通性需要的最小信息，其余字段 null（不是省略 —— 前端按字段
          // 存在与否画表格，省略会让列错位）。
          // CX-013（2026-10-10 验收）：范围外上级不下发姓名（前端用「范围外上级」占位）；部门保留 —— 它回答的是「我们挂在哪个部门下面」，
          // 不是个人信息（既有设计，rbac-scope-people 锁定）；只留 id 与 managerId 保证树连通
          ? {
            id: u.id, name: null, employeeId: null, role: null,
            department: u.department || null, position: null, jobLevel: null,
            managerId: u.managerId || null, empStatus: null, outOfScope: true,
          }
          : {
            id: u.id, name: u.name, employeeId: u.employeeId, role: u.role,
            department: u.department || null, position: u.position || null, jobLevel: u.jobLevel || null,
            managerId: u.managerId || null, empStatus: u.empStatus || null,
          })),
        // The matrix layer, drawn as dashed cross-links over the solid tree.
        // Only lines whose BOTH ends are nodes in the tree can be drawn.
        // P2：再加一条 —— 边的**主体**（userId）不能是骨架节点。骨架节点是为连通性借来
        // 的范围外员工，他自己的矩阵关系不属于这个视图（那是「另一个人的数据」）。
        secondary: store.listAllSecondaryLines()
          .filter((r) => r.managerId && inTree.has(r.userId) && inTree.has(r.managerId) && !skeleton.has(r.userId))
          .map((r) => ({ id: r.id, userId: r.userId, managerId: r.managerId, kind: r.kind, position: r.position || null })),
      });
    }

    // --- org diagnostics 组织诊断: span of control, depth, composition,
    // talent coverage, and auto-generated health findings ---
    if (pathname === "/api/admin/org-diagnostics" && req.method === "GET") {
      // P2 范围：**重算**。基础人群先过滤，之后 byId / kids / roots / BFS 深度 / spans /
      // avgSpan / tracks / grades / depts / matrix / findings **全部**由 users 导出，
      // 所以一次过滤就是在过滤后的子图上重算 —— 这正是清点文档 §2 要的口径。
      // 与 org-chart 的方案 B 刻意不同：这里**不借**祖先骨架节点。spans[] 与
      // matrix.overloaded[] 带姓名/工号，是统计而不是连通性，范围外经理必须整条剔除；
      // 借进来的骨架经理会以「一个人数被砍半的下属数」出现在跨度统计里，那是**错的
      // 数字**，比不出现更糟。副作用：范围内的根节点变多（上级在范围外的人成了新根），
      // 所以 findings.multiRoots 对范围受限的角色会更响 —— 那是范围的真实含义。
      const diagScope = scopePredicate(user);
      const users = store.listUsers().filter((u) => u.active !== 0 && u.role !== "admin" && (!diagScope || diagScope(u)));
      const byId = new Map(users.map((u) => [u.id, u]));
      const kids = new Map();
      const roots = [];
      for (const u of users) {
        if (u.managerId && byId.has(u.managerId)) {
          if (!kids.has(u.managerId)) kids.set(u.managerId, []);
          kids.get(u.managerId).push(u);
        } else roots.push(u);
      }
      // Depth via BFS from roots (cycle-safe).
      let maxDepth = users.length ? 1 : 0;
      const seen = new Set();
      let frontier = roots.map((r) => [r.id, 1]);
      while (frontier.length) {
        const next = [];
        for (const [id, d] of frontier) {
          if (seen.has(id)) continue;
          seen.add(id);
          maxDepth = Math.max(maxDepth, d);
          for (const k of kids.get(id) || []) next.push([k.id, d + 1]);
        }
        frontier = next;
      }
      const managers = users.filter((u) => (kids.get(u.id) || []).length > 0);
      const spans = managers.map((m) => {
        const directs = (kids.get(m.id) || []).length;
        return { id: m.id, name: m.name, department: m.department || null, jobLevel: m.jobLevel || null, directs, flag: directs >= 10 ? "wide" : directs === 1 ? "narrow" : "ok" };
      }).sort((a, b) => b.directs - a.directs);
      const avgSpan = managers.length ? Math.round((spans.reduce((a, x) => a + x.directs, 0) / managers.length) * 10) / 10 : 0;
      // Composition from the job-grade catalog.
      const catalog = Object.fromEntries(jobGrades().map((r) => [r.rank, r]));
      const tracks = { M: 0, P: 0, none: 0 };
      const grades = {};
      for (const u of users) {
        if (u.role === "admin") continue;
        const g = u.jobLevel ? catalog[u.jobLevel] : null;
        if (!g) { tracks.none++; continue; }
        tracks[g.track] = (tracks[g.track] || 0) + 1;
        grades[g.grade] = (grades[g.grade] || 0) + 1;
      }
      const deptSizes = {};
      for (const u of users) if (u.role !== "admin") deptSizes[u.department || "—"] = (deptSizes[u.department || "—"] || 0) + 1;
      // 12.2（设计 5.5）：高潜人数只计受控标签「高潜 HiPo」（与工作台同一函数），不再用正则匹配自由标签
      const hipo = users.filter((u) => CT.controlledKeysOf(parseTags(u)).includes("hipo")).length;
      // 继任条目的主体是**继任人**（sx.userId），所以这里也按范围过滤 —— 否则
      // talent.successionEntries / successionPositions 会是全公司数字，与同一屏上已经
      // 重算过的 headcount 自相矛盾。talent 域自己的 /succession 端点留给阶段 B。
      const succession = store.listSuccession().filter((sx) => !diagScope || diagScope(byId.get(sx.userId) || store.getUserById(sx.userId)));
      // Findings — structured; the client localizes by key.
      const findings = [];
      if (roots.length > 1) findings.push({ level: "info", key: "multiRoots", params: { n: roots.length, names: roots.slice(0, 5).map((r) => r.name) } });
      for (const sx of spans.filter((x) => x.flag === "wide").slice(0, 5)) findings.push({ level: "warn", key: "wideSpan", params: { name: sx.name, n: sx.directs } });
      const narrowN = spans.filter((x) => x.flag === "narrow").length;
      if (narrowN) findings.push({ level: "info", key: "narrowSpan", params: { n: narrowN } });
      if (maxDepth > 6) findings.push({ level: "warn", key: "deepOrg", params: { n: maxDepth } });
      if (tracks.none > 0) findings.push({ level: "info", key: "unmappedLevels", params: { n: tracks.none } });
      const probMgrs = managers.filter((m) => m.empStatus === "probation");
      if (probMgrs.length) findings.push({ level: "warn", key: "probationManagers", params: { n: probMgrs.length, names: probMgrs.slice(0, 3).map((m) => m.name) } });
      /* Matrix layer: dotted lines and concurrent posts. A manager's REAL load is
         solid directs + dotted reports, so someone who looks fine on the tree can
         still be over-extended once the matrix is counted. */
      const secLines = store.listAllSecondaryLines().filter((r) => byId.has(r.userId));
      const dottedIn = new Map();     // managerId → dotted reports
      for (const r of secLines) {
        if (r.kind !== "dotted" || !r.managerId || !byId.has(r.managerId)) continue;
        dottedIn.set(r.managerId, (dottedIn.get(r.managerId) || 0) + 1);
      }
      const concurrentHolders = new Set(secLines.filter((r) => r.kind === "concurrent").map((r) => r.userId));
      const matrix = {
        dottedLines: secLines.filter((r) => r.kind === "dotted").length,
        concurrentPosts: secLines.filter((r) => r.kind === "concurrent").length,
        peopleWithDotted: new Set(secLines.filter((r) => r.kind === "dotted").map((r) => r.userId)).size,
        peopleWithConcurrent: concurrentHolders.size,
        matrixManagers: dottedIn.size,
        // Managers whose combined load crosses the same ≥10 threshold the solid
        // span check uses — but only flagged when the dotted part is what tips it.
        overloaded: [...dottedIn.entries()]
          .map(([id, dotted]) => ({ id, dotted, solid: (kids.get(id) || []).length }))
          .filter((x) => x.solid + x.dotted >= 10 && x.solid < 10)
          .map((x) => ({ name: (byId.get(x.id) || {}).name || "?", employeeId: (byId.get(x.id) || {}).employeeId || "", solid: x.solid, dotted: x.dotted, total: x.solid + x.dotted }))
          .sort((a, b) => b.total - a.total).slice(0, 8),
      };
      for (const m of matrix.overloaded.slice(0, 3)) {
        findings.push({ level: "warn", key: "matrixOverload", params: { name: m.name, solid: m.solid, dotted: m.dotted, total: m.total } });
      }
      const keyPositions = [...new Set(succession.map((sx) => sx.positionName))];
      return send(res, 200, {
        kpis: {
          headcount: users.filter((u) => u.role !== "admin").length,
          managers: managers.length,
          ics: users.filter((u) => u.role !== "admin" && !(kids.get(u.id) || []).length).length,
          avgSpan, maxDepth, roots: roots.length,
        },
        spans, tracks, grades, matrix,
        depts: Object.entries(deptSizes).sort((a, b) => b[1] - a[1]).slice(0, 10),
        talent: { hipo, potentialSet: users.filter((u) => u.potential).length, successionPositions: keyPositions.length, successionEntries: succession.length },
        findings,
      });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 14706–14876 行（/api/admin/ 块内）
    async adminCore6(C) {
      const { pathname, req, user, res, body, audit, query } = C;
      const { tfContext, tfVisible, send, FM, tfIdList, tfScopeCheck, sendScopeBulkReject, store, tfPromotionEligible, trScopeSplit, trScopeOfBody, runBatch, sendBatchFailed, afterCommit, tfFilterOut, PROMO_DEFAULTS, tfInvalid, tfSortOf, TF_BUILTIN_PROMO, canExportTalentRecords, RECORDS_EXPORT_FORBIDDEN, scopePredicate, optionZh, todayLocal, sendCsv } = S;
    const tfMembersMatch = pathname.match(/^\/api\/admin\/talent-filters\/([\w-]+)\/members$/);
    if (tfMembersMatch && req.method === "POST") {
      const t = tfContext(user);
      const f = tfVisible(t, tfMembersMatch[1]);
      if (!f) return send(res, 404, { error: "Filter not found.", error_zh: "未找到该筛选。", code: "not_found" });
      if (!f.builtinKey) return send(res, 400, { error: "Manual adjustments apply only to Promotion Panel Candidates.", error_zh: "人工调整只适用于「晋升评审候选」。", code: "members_not_supported" });
      if (!FM.canEditFilter(f, t.viewer)) return send(res, 403, { error: "You can't change this filter.", error_zh: "你没有修改此筛选的权限。", code: "filter_forbidden" });
      const action = body.action;
      if (!["include", "exclude", "remove"].includes(action)) return send(res, 400, { error: "Unknown action.", error_zh: "未知的操作。", code: "bad_action" });
      const note = String(body.note || "").trim();
      if (note.length > FM.LIMITS.noteLength) return send(res, 400, { error: `The note can be at most ${FM.LIMITS.noteLength} characters.`, error_zh: `说明最多 ${FM.LIMITS.noteLength} 字。`, code: "note_too_long" });
      if (action === "exclude" && !note) return send(res, 400, { error: "Give a reason for excluding these employees.", error_zh: "排除须填写理由。", code: "note_required" });
      const ids = tfIdList(res, body.userIds, FM.LIMITS.memberBatch);
      if (!ids) return;
      const chk = tfScopeCheck(t, ids);
      if (chk.bad) return sendScopeBulkReject(res, chk.bad);
      const cur = new Map(store.listTalentFilterMembers(f.id).map((m) => [m.userId, m]));
      // 「已在名单中」= 已手动加入，或已满足条件（加入这些人不改变结果，跳过并告知）
      const eligible = action === "include" ? (tfPromotionEligible(t) || new Set()) : new Set();
      // F60：页面顶部筛选（body.scope）之外的人逐人跳过（out_of_view）
      const view = trScopeSplit(trScopeOfBody(user, body), chk.users);
      const skipped = view.skipped.slice(), done = [];
      for (const u of view.users) {
        const m = cur.get(u.id);
        const skip = (code) => skipped.push({ userId: u.id, employeeId: u.employeeId || null, code });
        if (action === "include") {
          if (u.active === 0 || u.empStatus === "exited") skip("inactive");
          else if ((m && m.mode === "include") || (!m && eligible.has(u.id))) skip("already_listed");
          else done.push(u);
        } else if (action === "exclude") {
          if (m && m.mode === "exclude" && (m.note || "") === note) skip("already_excluded");
          else done.push(u);
        } else if (!m) skip("not_member");
        else done.push(u);
      }
      const batch = runBatch((c) => {
        for (const u of done) {
          c.line++;
          if (action === "remove") store.removeTalentFilterMember(f.id, u.id);
          else store.setTalentFilterMember({ filterId: f.id, userId: u.id, mode: action, note: note || null, addedBy: user.id });
        }
        return done.length;
      });
      if (!batch.ok) return sendBatchFailed(res, "talent.filter.members", batch, { selection: true, split: true });
      afterCommit("talent.filter.members audit", () => audit("talent.filter.members", f.id, null, { filterId: f.id, action, employeeIds: done.map((u) => u.employeeId), note: note || null }));
      return send(res, 200, { ok: true, done: done.length, skipped });
    }
    const tfMatch = pathname.match(/^\/api\/admin\/talent-filters\/([\w-]+)$/);
    if (tfMatch && req.method === "GET") {
      const t = tfContext(user);
      const f = tfVisible(t, tfMatch[1]);
      if (!f) return send(res, 404, { error: "Filter not found.", error_zh: "未找到该筛选。", code: "not_found" });
      const out = tfFilterOut(t, f, true);
      return send(res, 200, { filter: out.filter, redactedValues: out.redactedValues });
    }
    // 修改（乐观锁：version 不一致回 409 filter_conflict）。内置筛选：只改条件、列、排序，不能改名称与可见范围；{reset:true} 恢复默认。
    if (tfMatch && req.method === "PUT") {
      const t = tfContext(user);
      const f = tfVisible(t, tfMatch[1]);
      if (!f) return send(res, 404, { error: "Filter not found.", error_zh: "未找到该筛选。", code: "not_found" });
      if (!FM.canEditFilter(f, t.viewer)) return send(res, 403, { error: "Only the owner or a super-admin can change this filter — save a copy instead.", error_zh: "只有创建人或超级管理员可以修改此筛选，你可以另存为。", code: "filter_forbidden" });
      const conflict = () => send(res, 409, { error: "This filter was changed by someone else — refresh and try again.", error_zh: "此筛选已被他人修改，请刷新后再改。", code: "filter_conflict" });
      if (Number(body.version) !== f.version) return conflict();
      const patch = {};
      if (body.reset === true) {
        if (!f.builtinKey) return send(res, 400, { error: "Only the built-in filter can be reset.", error_zh: "只有内置筛选可以恢复默认。", code: "reset_not_supported" });
        const rf = store.listRecordFields("performance").find((x) => x.key === "rating");
        const row = FM.promotionFilterRow(PROMO_DEFAULTS, rf ? rf.options : []);
        Object.assign(patch, { definition: row.definition, columns: row.columns, sort: row.sort });
      } else {
        if (body.definition !== undefined) {
          const v = FM.validateFilter(body.definition, t.catalog);
          if (!v.ok) return tfInvalid(res, v.errors);
          patch.definition = v.filter;
        }
        if (body.columns !== undefined) patch.columns = FM.normalizeColumns(body.columns, t.catalog).filter((c) => f.builtinKey || c !== "member");
        if (body.sort !== undefined) patch.sort = tfSortOf(t, body.sort);
        if (!f.builtinKey) {
          if (body.name !== undefined || body.name_zh !== undefined) {
            const name = String(body.name !== undefined ? body.name || "" : f.name).trim(), name_zh = String(body.name_zh !== undefined ? body.name_zh || "" : f.name_zh || "").trim();
            if (!name && !name_zh) return send(res, 400, { error: "Give the filter a name.", error_zh: "请填写筛选名称。", code: "name_required" });
            if (name.length > FM.LIMITS.nameLength || name_zh.length > FM.LIMITS.nameLength) return send(res, 400, { error: `A name can be at most ${FM.LIMITS.nameLength} characters.`, error_zh: `名称最多 ${FM.LIMITS.nameLength} 字。`, code: "name_too_long" });
            patch.name = name || name_zh; patch.name_zh = name_zh || null;
          }
          if (body.visibility !== undefined) patch.visibility = body.visibility === "shared" ? "shared" : "private";
          const list = store.listTalentFilters();
          if (patch.visibility && patch.visibility !== f.visibility) {
            const full = patch.visibility === "shared" ? list.filter((x) => !x.builtinKey && x.visibility === "shared").length >= FM.LIMITS.sharedTotal
              : list.filter((x) => !x.builtinKey && x.visibility === "private" && x.ownerId === f.ownerId).length >= FM.LIMITS.privatePerUser;
            if (full) return send(res, 400, { error: "The limit of saved filters has been reached — delete some first.", error_zh: "已保存的筛选已达上限，请先删除不用的筛选。", code: "too_many_filters" });
          }
          const clash = FM.nameConflict(list, { id: f.id, name: patch.name || f.name, name_zh: patch.name_zh !== undefined ? patch.name_zh : f.name_zh, visibility: patch.visibility || f.visibility, ownerId: f.ownerId }, t.viewer);
          if (clash) return send(res, 400, { error: "A filter with this name already exists.", error_zh: "已有同名的筛选。", code: "name_taken", field: clash });
        }
      }
      const saved = store.updateTalentFilter(f.id, patch, f.version, user.id);
      if (!saved) return conflict();
      // 内置晋升筛选：meta promotionConfig 同步一份（与 PUT /promotion-config 一致，回退版本时还能用）
      if (saved.builtinKey === TF_BUILTIN_PROMO) {
        store.setMeta("promotionConfig", JSON.stringify(FM.promotionConfigOf(saved.definition)));
        // F62：恢复默认（或保存的定义已与新默认相同）→ 清掉迁移 92 留下的「默认条件已更新」提示
        if (body.reset === true || FM.isPromotionDefault(saved.definition, (store.listRecordFields("performance").find((x) => x.key === "rating") || {}).options || []))
          store.setMeta("promotionDefaultsPending", "");
      }
      audit("talent.filter.update", f.id,
        { name: f.name, visibility: f.visibility, summary: FM.summarize(f.definition, t.catalog, "en") },
        { name: saved.name, visibility: saved.visibility, summary: FM.summarize(saved.definition, t.catalog, "en"), ...(body.reset === true ? { reset: true } : {}) });
      return send(res, 200, { filter: tfFilterOut(t, saved, true).filter });
    }
    if (tfMatch && req.method === "DELETE") {
      const t = tfContext(user);
      const f = tfVisible(t, tfMatch[1]);
      if (!f) return send(res, 404, { error: "Filter not found.", error_zh: "未找到该筛选。", code: "not_found" });
      if (f.builtinKey) return send(res, 400, { error: "The built-in filter can't be deleted.", error_zh: "内置筛选不能删除。", code: "builtin_locked" });
      if (!FM.canDeleteFilter(f, t.viewer)) return send(res, 403, { error: "Only the owner or a super-admin can delete this filter.", error_zh: "只有创建人或超级管理员可以删除此筛选。", code: "filter_forbidden" });
      store.deleteTalentFilter(f.id);
      audit("talent.filter.delete", f.id, { name: f.name, name_zh: f.name_zh, visibility: f.visibility }, null);
      return send(res, 200, { ok: true });
    }
    // Records export — columns follow the CURRENT field config, so an edited
    // export round-trips through the bulk import.
    if (pathname === "/api/admin/export/records.csv") {
      // 第二批 2.3（M1 方案 A）：谁能导出人才记录 CSV 只在 canExportTalentRecords 一处判定（待负责人回复 Q2 后可能收紧为 people 写）
      if (!canExportTalentRecords(user)) return send(res, 403, RECORDS_EXPORT_FORBIDDEN);
      // ?userId=... exports one person — that is what the button on their profile
      // means. Without it the export stays company-wide (used by the roster page).
      const onlyUser = query.get("userId");
      const fields = store.listRecordFields(null).filter((f) => f.input !== "checkbox" && f.typeKey !== "user");
      // Bilingual headers on purpose: a CSV is an interchange surface, not the UI.
      // One cell carrying both names means an HR reading either language knows the
      // column, and the importer — which splits a header on whitespace — matches the
      // file it just exported. Same shape as the fixed "Type 类型" columns.
      const headerOf = (f) => (f.label_zh && f.label_zh !== f.label ? `${f.label_zh} ${f.label}` : f.label);
      const labels = [...new Set(fields.map(headerOf))];
      const rows = [["Employee ID", "Name", "Type 类型", "Date 日期", "Title 标题", ...labels]];
      // P2 范围：带 ?userId= 时是**校验**（越界 → 404「Employee not found」，与下面那行
      // 「查无此人」逐字同形）；不带时是**过滤**（全员导出收窄成范围内全员）。CSV 是
      // 最容易被忘掉的一条泄露面：一次下载就是一份完整名单。
      const csvScope = scopePredicate(user);
      const exportUsers = onlyUser
        ? [store.getUserById(onlyUser)].filter(Boolean).filter((u) => !csvScope || csvScope(u))
        : store.listUsers().filter((u) => !csvScope || csvScope(u));
      if (onlyUser && !exportUsers.length) return send(res, 404, { error: "Employee not found" });
      for (const u of exportUsers) {
        for (const r of store.listTalentRecords(u.id)) {
          const t = store.getRecordType(r.type);
          // Key by the SAME string the header uses. Keying by f.label while the
          // header said headerOf(f) meant every config-driven column exported blank —
          // invisible in the fixture because the only asserted value also appeared in
          // the title column.
          const byLabel = {};
          for (const f of fields) {
            if (f.typeKey !== r.type || r.detail[f.key] === undefined) continue;
            const v = r.detail[f.key];
            // A stored option value is canonical (English). Export both names so an
            // HR reading either language recognises it; re-importing normalizes the
            // Chinese half back to canonical, so the round trip is closed.
            const zh = (f.options || []).length ? optionZh(f, String(v)) : null;
            byLabel[headerOf(f)] = zh && zh !== String(v) ? `${zh} ${v}` : v;
          }
          // An auto-derived record has no stored title (see deriveRecordTitle) — the
          // type name stands in, so the column is never blank in the file.
          rows.push([u.employeeId, u.name, t ? t.label : r.type, r.date, r.title || (t ? t.label : r.type), ...labels.map((l) => byLabel[l] ?? "")]);
        }
      }
      // Name the file after the person when it is one person's record.
      const csvName = onlyUser
        ? `talent-records-${exportUsers[0].employeeId}-${todayLocal()}.csv`
        : `talent-records-${todayLocal()}.csv`;
      // CX-139：人才记录含违纪等敏感内容，导出与其他 CSV 一样写审计（单人导出记对象工号）
      audit("export.records-csv", onlyUser ? exportUsers[0].employeeId : null, null, { rows: rows.length - 1, ...(onlyUser ? { employeeId: exportUsers[0].employeeId } : {}) });
      return sendCsv(res, csvName, rows);
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 15157–15360 行（/api/admin/ 块内）
    async adminCore7(C) {
      const { pathname, req, body, res, user, audit } = C;
      const { send, EMPLOYEE_ID_RE, EMPLOYEE_ID_HINT, store, normalizeEmail, EMAIL_RE, findUserByEmail, validDateStr, clampText, scopeAllowsDeptFor, sendScopeDeptReject, canonicalDept, makePassword, newToken, hashPassword, assignPrograms, scopeDeptPredicate, sendScopeBulkReject, hashPasswordsAsync, revalidateBulkActor, runBatch, bulkFaultPoint, sendBatchFailed, afterCommit, pendingCountsFor } = S;
    if (pathname === "/api/admin/employees" && req.method === "POST") {
      const { name, employeeId, department, position, jobLevel, hireDate } = body;
      if (!name || !employeeId) return send(res, 400, { error: "Name and employee ID are required." });
      if (!EMPLOYEE_ID_RE.test(String(employeeId).trim()))
        return send(res, 400, { error: EMPLOYEE_ID_HINT });
      if (store.employeeIdExists(employeeId.trim()))
        return send(res, 400, { error: "That employee ID already exists." });
      const email = normalizeEmail(body.email);
      if (email && !EMAIL_RE.test(email)) return send(res, 400, { error: "Please enter a valid email address." });
      const dupEmail = email && findUserByEmail(email);
      if (dupEmail) return send(res, 400, { error: `That email is already used by ${dupEmail.name} (${dupEmail.employeeId}).` });
      const managerId = String(body.managerId || "").trim() || null;
      if (managerId && !store.getUserById(managerId)) return send(res, 400, { error: "Manager not found." });
      const hd = String(hireDate || "").slice(0, 10);
      if (hd && !validDateStr(hd)) return send(res, 400, { error: "Hire date must be YYYY-MM-DD" });
      let dept = clampText(department, 60) || null;
      // D6 范围：建号是 accounts 域写操作，受部门范围约束 —— 新号的部门必须在范围内。
      // 空部门（null）在范围生效时同样拒绝：没有部门的人在范围内不可见（store.js
      // parseScope），建一个自己看不见的号是「把人建到范围外」。超管/空范围短路放行，
      // 一行行为不变。落在 ensureDepartment 之前：不为一个越界的部门名建目录项。
      if (!scopeAllowsDeptFor(user, dept)) return sendScopeDeptReject(res);
      if (dept) dept = canonicalDept(dept);
      const pw = makePassword();
      const u = store.createUser({
        id: "u-" + newToken().slice(0, 8), employeeId: employeeId.trim(), name: clampText(name, 60), role: "employee",
        passwordHash: hashPassword(pw), department: dept, email: email || null, managerId, phone: clampText(body.phone, 30) || null,
        position: String(position || "").trim() || null, jobLevel: String(jobLevel || "").trim() || null, hireDate: hd || null,
      });
      const assigned = assignPrograms(u.id, Array.isArray(body.programIds) ? body.programIds.slice(0, 100).map(String) : undefined);
      audit("employee.create", u.employeeId, null, { name: u.name, department: u.department || null, position: u.position || null, jobLevel: u.jobLevel || null, assigned: assigned.length });
      return send(res, 200, { ok: true, password: pw, employeeId: u.employeeId, assigned });
    }
    if (pathname === "/api/admin/employees/bulk" && req.method === "POST") {
      // Bulk import — designed for rosters exported from an HR system (e.g. BIPO).
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return send(res, 400, { error: "No rows to import." });
      // Cap like bulk-update: NEVER truncate silently (this used to slice(0, 500),
      // so a 4,000-person roster created 500 accounts and returned 200). Over the
      // cap → whole batch rejected before anything is written. Shares LMS_BULK_CAP
      // (default 10000).
      const empCapRaw = Math.floor(Number(process.env.LMS_BULK_CAP));
      const empCap = Number.isFinite(empCapRaw) && empCapRaw > 0 ? empCapRaw : 10000;
      if (rows.length > empCap)
        return send(res, 400, {
          error: `Pasted ${rows.length} rows, but one import is capped at ${empCap} — split the roster and import in smaller batches. `
            + `本次导入 ${rows.length} 行，单次上限 ${empCap} 行：请拆分名单分批导入。`,
          code: "over_cap", selected: rows.length, cap: empCap,
        });
      // D6 范围：批量建号受部门范围约束。设计选择①（整批拒绝，非静默跳过）：任一行的
      // 目标部门越界（含空部门）→ 整批拒绝并回越界行数，与 bulk-update / bulk-reset 同
      // 口径。角色只解析一次（scopeDeptPredicate）。超管/空范围 → null，走原样路径。
      const createDeptScope = scopeDeptPredicate(user);
      if (createDeptScope) {
        let oos = 0;
        for (const r of rows) {
          const dep = String(r.department || "").trim() || null;
          if (!dep || !createDeptScope(dep)) oos++;
        }
        if (oos) return sendScopeBulkReject(res, oos);
      }
      // Optional course selection for the whole batch (undefined = legacy
      // default: every published mandatory course).
      const batchProgramIds = Array.isArray(body.programIds) ? body.programIds.slice(0, 100).map(String) : undefined;
      // 性能与原子性（4,000 人一次导入）：
      //   ① 事务外：逐行规范化 + 预检（与库无关的格式校验 + 按当时的库做一遍查重），只给
      //      「看起来会被创建」的行生成初始密码，并用线程池异步算哈希 —— 事件循环不被
      //      scrypt 卡住，导入期间整站照常响应。
      //   ② 事务内：异步阶段期间别的请求可能改了库，所以**全部**逐行判断（重复工号/邮箱、
      //      入职日期、上级）在事务里对最新的库重新做一遍，口径与改动前逐字相同（逐行
      //      skipped）；再在同一个同步事务里完成全部写入。任何一行抛异常 → 整批回滚。
      //   查重不再逐行扫全表：工号/邮箱各建一次 Map（行数 × 用户数 → 行数 + 用户数），
      //   本批刚建的人随即加进 Map，所以批内重复与库内重复同样被识别。
      // 工号的大小写口径与 store.employeeIdExists（SQLite lower()，只折叠 ASCII）一致。
      const empKey = (s) => String(s || "").replace(/[A-Z]/g, (c) => c.toLowerCase());
      const buildIndex = () => {
        const byEmp = new Map(), byEmail = new Map();
        for (const u of store.listUsers()) {
          byEmp.set(empKey(u.employeeId), u);
          const e = normalizeEmail(u.email);
          if (e && !byEmail.has(e)) byEmail.set(e, u);   // 与 findUserByEmail 同：按 createdAt 取第一个
        }
        return { byEmp, byEmail };
      };
      // CX-129：逐行原因与提示另给中文（reason_zh / warning_zh），页面按界面语言显示
      const importZh = (t) => {
        if (!t) return null;
        let m;
        if (t === "missing name or employee ID") return "缺少姓名或工号";
        if (t.startsWith("invalid employee ID format")) return "工号格式无效（3–20 位字母、数字或连字符）";
        if (t === "invalid email") return "邮箱格式无效";
        if (t === "already exists") return "工号已存在";
        if ((m = /^email already used by (.+)$/.exec(t))) return `邮箱已被 ${m[1]} 使用`;
        if (t.startsWith("invalid hire date")) return "入职日期无效（格式 YYYY-MM-DD）";
        return t.split("; ").map((p) => {
          let w;
          if ((w = /^manager "(.+)" not found — left empty$/.exec(p))) return `直属上级「${w[1]}」不存在，已留空`;
          if (p === "department head flag ignored — no department") return "未填部门，「部门负责人」标记未生效";
          return p;
        }).join("；");
      };
      const norm = rows.map((r0) => {
        const r = r0 && typeof r0 === "object" ? r0 : {};
        const employeeId = String(r.employeeId || "").trim();
        const name = String(r.name || "").trim();
        const department = String(r.department || "").trim() || null;
        const email = normalizeEmail(r.email);
        let reason = null;
        if (!employeeId || !name) reason = "missing name or employee ID";
        else if (!EMPLOYEE_ID_RE.test(employeeId)) reason = "invalid employee ID format (3–20 letters/digits/hyphens)";
        else if (email && !EMAIL_RE.test(email)) reason = "invalid email";
        return { r, employeeId, name, department, email, hd: String(r.hireDate || "").slice(0, 10), reason };
      });
      // 与库有关的逐行判定（事务内外共用同一个函数，口径只有一份）。idx 会被就地更新：
      // 判定为 created 的行立刻登记进 Map，后面的行据此识别批内重复。
      const dbReason = (n, idx) => {
        if (idx.byEmp.has(empKey(n.employeeId))) return "already exists";
        const dupE = n.email && idx.byEmail.get(n.email);
        if (dupE) return `email already used by ${dupE.employeeId}`;
        if (n.hd && !validDateStr(n.hd)) return "invalid hire date (YYYY-MM-DD)";
        return null;
      };
      // ① 预检 + 异步哈希
      const pre = buildIndex();
      const pending = [];                          // 预计会创建的行下标
      for (let i = 0; i < norm.length; i++) {
        const n = norm[i];
        if (n.reason || dbReason(n, pre)) continue;
        const ghost = { employeeId: n.employeeId };
        pre.byEmp.set(empKey(n.employeeId), ghost);
        if (n.email) pre.byEmail.set(n.email, ghost);
        pending.push(i);
      }
      const pwByRow = new Map();
      const pendingPw = pending.map(() => makePassword());
      const pendingHash = await hashPasswordsAsync(pendingPw);
      pending.forEach((i, k) => pwByRow.set(i, { pw: pendingPw[k], hash: pendingHash[k] }));
      // 客户端在算哈希期间断开了：初始密码只在这个响应里出现一次，没人收得到 —— 一行都
      // 不写，免得建出一批谁也登不进去、也查不到密码的账号。
      if (res.destroyed || (req.socket && req.socket.destroyed)) return;
      // 异步阶段结束：用**当下**的会话重新核对调用者与范围（从这里到事务提交之间没有
      // 任何 await，别的请求插不进来）。
      const actor = revalidateBulkActor(req, res, pathname);
      if (!actor) return;
      const createDeptScope2 = scopeDeptPredicate(actor);
      if (createDeptScope2) {
        let oos = 0;
        for (const n of norm) if (!n.department || !createDeptScope2(n.department)) oos++;
        if (oos) return sendScopeBulkReject(res, oos);
      }
      // ② 事务：重新判定 + 全部写入
      const batch = runBatch((cur) => {
        const idx = buildIndex();
        const results = [];
        const deptEnsured = new Map();   // 本批出现的部门名 → 部门表里的规范写法
        for (let i = 0; i < norm.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const n = norm[i];
          const { employeeId, name, department, email, hd, r } = n;
          const reason = n.reason || dbReason(n, idx);
          if (reason) { results.push({ employeeId, name, status: "skipped", reason, reason_zh: importZh(reason) }); continue; }
          // Optional column: the manager's employee ID (must already exist —
          // list managers above their reports, or set managers in a second pass).
          // A miss used to be swallowed; now it comes back as a warning so HR
          // doesn't believe a reporting line was created when it wasn't.
          // （本批前面刚建的人也算「已存在」—— 与改动前逐行提交时的行为一致。）
          let managerId = null, warning = null;
          const mgrEmp = String(r.managerEmployeeId || "").trim();
          if (mgrEmp) {
            const m = idx.byEmp.get(empKey(mgrEmp));
            if (m) managerId = m.id;
            else warning = `manager "${mgrEmp}" not found — left empty`;
          }
          // 同一个部门名在本批里只登记一次（4,000 行通常只有几十个部门）；事务内别人插不进来，
          // 登记过就一定还在。存进 users 的是部门表里的规范写法（canonicalDept）。
          const deptRaw = clampText(department, 60) || null;
          if (deptRaw && !deptEnsured.has(deptRaw)) deptEnsured.set(deptRaw, canonicalDept(deptRaw));
          const deptName = deptRaw ? deptEnsured.get(deptRaw) : null;
          // 预检时判为 skipped、事务里却变成可创建（异步阶段有人删了撞车的账号）的行没有
          // 预算好的哈希：这种行极少，就地同步算一次。
          const pre1 = pwByRow.get(i);
          const pw = pre1 ? pre1.pw : makePassword();
          const nu = store.createUser({
            id: "u-" + newToken().slice(0, 8), employeeId, name: clampText(name, 60), role: "employee",
            passwordHash: pre1 ? pre1.hash : hashPassword(pw), department: deptName, email: email || null, managerId,
            position: String(r.position || "").trim() || null, jobLevel: String(r.jobLevel || "").trim() || null, hireDate: hd || null,
          });
          idx.byEmp.set(empKey(nu.employeeId), nu);
          if (email) idx.byEmail.set(email, nu);
          assignPrograms(nu.id, batchProgramIds);
          // 第 6 列「部门负责人」（2026-10-06 负责人决定：名单里带每个部门的负责人）：真值 → 此人成为所在部门的负责人
          //（departments.ownerId）。部门页随后可改；组织架构部门卡与 3+3 的 HoD 都以此为准，不再推定。
          if (r.deptHead === true || /^(是|y|yes|1|✓|true)$/i.test(String(r.deptHead || "").trim())) {
            const dep = deptName ? store.getDepartmentByName(deptName) : null;
            if (dep) store.updateDepartment(dep.id, { ownerId: nu.id });
            else warning = (warning ? warning + "; " : "") + "department head flag ignored — no department";
          }
          results.push({ employeeId, name, department, status: "created", password: pw, warning, warning_zh: importZh(warning) });
        }
        return results;
      });
      if (!batch.ok) return sendBatchFailed(res, "employees/bulk", batch);
      const results = batch.value;
      // 副作用：提交成功之后。
      afterCommit("employees/bulk", () => audit("employee.bulk-import", null, null, { created: results.filter((r) => r.status === "created").length, skipped: results.filter((r) => r.status === "skipped").length }));
      return send(res, 200, { results });
    }
    // (The old free-text departments POST handler was superseded by the
    // departments-table API above, which also answers its action shapes.)
    // Pending elective-enrollment requests for HR to review.
    // Pending-approval counts for the admin nav badges (one call, all kinds).
    if (pathname === "/api/admin/pending-counts" && req.method === "GET") {
      // P2 范围：这几个数字是侧栏角标，必须与 /nominations、/enroll-requests 两条列表
      // **逐条同源**地重算 —— 不重算就会出现「角标 12、列表 3 条」的对不上（清点文档
      // §6.5 的告警）。范围生效时走与列表一样的过滤再数，空范围/超管仍走 countApprovals 计数查询。
      // 简答题：待 HR 复核（pending_review）与待 HR 评分（manual_pending），按答卷主体的范围过滤（方案 5.1）。
      // 第三批（2026-10-08）：与培训概览「待处理」同一个 pendingCountsFor；另回 appeals（未结的考试成绩申诉，范围内，
      // 仅 learning 可读的角色计数）与 reviewOverdue（待复核超过 3 个工作日）。
      const pc = pendingCountsFor(user, null);
      return send(res, 200, { enroll: pc.enroll, nominations: pc.nominations, gradingReview: pc.gradingReview, gradingManual: pc.gradingManual, reviewOverdue: pc.reviewOverdue, appeals: pc.appeals });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 16030–16173 行（/api/admin/ 块内）
    async adminCore8(C) {
      const { pathname, req, res, user, body, audit, auditAuth } = C;
      const { store, send, scopeAllowsFor, applyNominationDecision, emitNominationDecision, isSuperAdmin, isAdmin, makePassword, hashPassword, scopePredicate, sendScopeBulkReject, hashPasswordsAsync, revalidateBulkActor, runBatch, bulkFaultPoint, sendBatchFailed, afterCommit } = S;
    const nomDecide = pathname.match(/^\/api\/admin\/nominations\/([\w-]+)\/decide$/);
    if (nomDecide && req.method === "POST") {
      const a = store.getApproval(nomDecide[1]);
      if (!a || a.kind !== "nomination") return send(res, 404, { error: "Not found" });
      // P2 范围（learning）：主体是 a.targetUserId（批准即入班 + 派课 + 发通知）。
      // 同 appeals / enroll-decide：排在 status 检查之前，与「不存在」逐字同形。
      if (!scopeAllowsFor(user, store.getUserById(a.targetUserId))) return send(res, 404, { error: "Not found" });
      if (a.status !== "pending") return send(res, 400, { error: "This request was already decided.", error_zh: "该申请已处理。", code: "already_decided" });   // CX-119 / CX-212：与选修课申请同一句
      const decision = body.decision;
      if (!["approve", "reject"].includes(decision)) return send(res, 400, { error: "Choose approve or reject.", error_zh: "请选择通过或驳回。", code: "bad_decision" });
      // CX-113：驳回必须填写理由（员工可见），与批量 bulk-decide 同口径
      if (decision === "reject" && !String(body.note || "").trim())
        return send(res, 400, { error: "Enter a reason to reject — it is shown to the employee.", error_zh: "驳回必须填写理由（员工可见）。", code: "note_required" });
      const s = JSON.parse(a.subjectJson || "{}");
      // 写库 + 审计 + 通知与批量 bulk-decide 同一组函数（applyNominationDecision / emitNominationDecision）
      const out = applyNominationDecision(user, a, s, decision, body.note ? String(body.note).slice(0, 500) : null, { force: body.force === true, classId: body.classId || null });
      if (out.fail) return send(res, out.fail.status, out.fail.body);
      emitNominationDecision(audit, out.eff);
      return send(res, 200, { ok: true, status: out.eff.updated.status });
    }
    const resetMatch = pathname.match(/^\/api\/admin\/employees\/([\w-]+)\/reset$/);
    if (resetMatch && req.method === "POST") {
      const u = store.getUserById(resetMatch[1]);
      if (!u) return send(res, 404, { error: "Not found" });
      // D6 范围：重置是 accounts 域写操作，受部门范围约束 —— 范围外的目标一律裸 404，
      // 与「不存在」逐字同形（不把每个 :id 变成越界探测器）。超管/空范围短路放行。
      if (!scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      // D6 fix: password reset RETURNS the plaintext temp password, so resetting a
      // back-office admin's password = taking over that admin (log in with the temp
      // password, then change it). accounts=manage is for EMPLOYEE accounts; only a
      // super-admin may reset another admin account. 403, matching the role/adminRoleId
      // field guards — the roster already exposes who is an admin, so this leaks nothing.
      if (!isSuperAdmin(user) && isAdmin(u))
        return send(res, 403, { error: "Only a super-admin can reset an admin account's password. 仅超级管理员可重置管理员账号的密码。" });
      const pw = makePassword();
      store.setUserPassword(u.id, hashPassword(pw), true);
      store.deleteUserSessions(u.id);
      audit("employee.reset-password", u.employeeId, null, null);
      auditAuth("auth.sessions_revoked", user, u.employeeId, { reason: "password_reset" });
      return send(res, 200, { ok: true, password: pw });
    }
    // Bulk temporary passwords. Onboarding a department (let alone the whole
    // company) one click at a time is not a workflow — and the imported roster
    // shares a single unusable hash, so a batch issue is how anyone gets in at
    // all. Every password is shown ONCE, in the response, for HR to distribute;
    // nothing is stored in clear text and each one forces a change on first use.
    if (pathname === "/api/admin/employees/bulk-reset" && req.method === "POST") {
      const userIds = Array.isArray(body.userIds) ? body.userIds : [];
      if (!userIds.length) return send(res, 400, { error: "No employees selected 未选择员工" });
      // Cap = performance guard: every issued password is one scrypt hash (tens of
      // ms each). Hashes now run on the libuv pool (hashPasswordsAsync), so the event
      // loop stays free, but an unbounded batch would still hold the pool for a long
      // time. Tunable via LMS_RESET_CAP (default 10000) for tests and ops.
      // NEVER truncate silently — this used to slice(0, 3000), which with the whole
      // 3,417-employee roster selected (3,419 users minus the 2 admin accounts)
      // quietly left 417 people without a password, and since clear text is never
      // stored there was no way to find out who.
      const capRaw = Math.floor(Number(process.env.LMS_RESET_CAP));
      const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 10000;
      if (userIds.length > cap) {
        return send(res, 400, {
          error: `Selected ${userIds.length} people, but one batch is capped at ${cap} — filter (e.g. by department) and reset in smaller batches. `
            + `本次选中 ${userIds.length} 人，单次上限 ${cap} 人：请按部门筛选分批重置。`,
          code: "over_cap", selected: userIds.length, cap,
        });
      }
      // D6 范围：批量重置受部门范围约束。设计选择①（整批拒绝）：任一选中的目标在范围外
      // → 整批拒绝并回越界行数，与 bulk-update 逐字同口径（查无此人仍按原样逐行 skip）。
      const resetScope = scopePredicate(user);
      if (resetScope) {
        let oos = 0;
        for (const uid of userIds) {
          const t = store.getUserById(uid);
          if (t && !resetScope(t)) oos++;
        }
        if (oos) return sendScopeBulkReject(res, oos);
      }
      // 性能与原子性：与 employees/bulk 同一套两段式。
      //   ① 事务外：按当时的库挑出会被重置的人，生成临时密码，线程池异步算哈希（每人一次
      //      scrypt，4,000 人同步算会卡死整站数分钟）。
      //   ② 事务内：逐人按**最新**的库重新判定（查无此人 / 自己 / 管理员 / 已停用，口径逐字
      //      不变，逐行 skipped），改密 + 吊销会话同一事务提交；任何一人抛异常 → 整批回滚，
      //      谁的密码都没改、谁的会话都没被踢。审计在提交成功之后写。
      // skipReason(u, actor)：null = 该重置；否则是 skipped 的 reason。事务内外共用。
      const skipReason = (u, actor) => {
        if (!u) return "not found";
        // Never reset your own login out from under yourself mid-session.
        if (u.id === actor.id) return "self";
        // D6 fix: never hand a non-super the temp password of a back-office admin
        // (account takeover — see the single-reset guard). Skip, don't reset.
        if (!isSuperAdmin(actor) && isAdmin(u)) return "admin";
        if (u.empStatus === "exited" || u.active === 0) return "inactive";
        return null;
      };
      const preIds = [];
      for (const uid of userIds) if (!skipReason(store.getUserById(uid), user)) preIds.push(uid);
      const prePw = preIds.map(() => makePassword());
      const preHash = await hashPasswordsAsync(prePw);
      const preById = new Map(preIds.map((id, k) => [id, { pw: prePw[k], hash: preHash[k] }]));
      // 客户端已断开：临时密码只在这个响应里出现一次 —— 不改任何人的密码。
      if (res.destroyed || (req.socket && req.socket.destroyed)) return;
      // 异步阶段结束：按当下的会话重新核对调用者与范围（此后到提交没有 await）。
      const actor = revalidateBulkActor(req, res, pathname);
      if (!actor) return;
      const resetScope2 = scopePredicate(actor);
      if (resetScope2) {
        let oos = 0;
        for (const uid of userIds) {
          const t = store.getUserById(uid);
          if (t && !resetScope2(t)) oos++;
        }
        if (oos) return sendScopeBulkReject(res, oos);
      }
      const batch = runBatch((cur) => {
        const issued = [], skipped = [];
        for (let i = 0; i < userIds.length; i++) {
          cur.line = i + 1;
          bulkFaultPoint(cur.line);
          const uid = userIds[i];
          const u = store.getUserById(uid);
          const why = skipReason(u, actor);
          if (why === "not found") { skipped.push({ userId: uid, reason: why }); continue; }
          if (why) { skipped.push({ employeeId: u.employeeId, name: u.name, reason: why }); continue; }
          // 同一个 id 在 userIds 里出现两次：第二次拿不到预算好的哈希（已用掉），就地同步
          // 算一次 —— 与改动前一样，最后一次发出的密码生效。
          const p = preById.get(u.id);
          if (p) preById.delete(u.id);
          const pw = p ? p.pw : makePassword();
          store.resetUserPasswordAndSessions(u.id, p ? p.hash : hashPassword(pw));
          issued.push({ userId: u.id, employeeId: u.employeeId, name: u.name, department: u.department || null, password: pw });
        }
        return { issued, skipped };
      });
      if (!batch.ok) return sendBatchFailed(res, "employees/bulk-reset", batch);
      const { issued, skipped } = batch.value;
      // 副作用：提交成功之后。
      afterCommit("employees/bulk-reset", () => {
        audit("employee.bulk-reset-password", null, null, { issued: issued.length, skipped: skipped.length });
        // ONE aggregate row, not one per person: a 925-person batch reset would
        // otherwise bury the whole log under a single click. The per-person detail
        // is in the response HR distributes, not in the trail.
        if (issued.length) auditAuth("auth.sessions_revoked", user, null, { reason: "bulk_password_reset", count: issued.length });
      });
      // count = exact number of passwords issued, so callers can assert nothing
      // was dropped (the whole point of refusing over-cap requests above).
      return send(res, 200, { ok: true, count: issued.length, issued, skipped });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 16941–17013 行（/api/admin/ 块内）
    async adminCore9(C) {
      const { pathname, user, query, audit, res } = C;
      const { trainingOverviewBase, QT, LC, nowMs, CAT, TS, sendCsv, todayLocal, store, scopePredicate, getProgram } = S;
    if (pathname === "/api/admin/export/completion.csv") {
      // 第三批（2026-10-08）：末尾加三列 Category、Requirement、Completed on；筛选解析改走 trainingOverviewBase（与看板、名单、
      // 一键提醒同一份：dept 含下级、programs、cat、enroll、mode、tp、cohort、period / from / to —— 时间段按「本期应完成」口径，
      // 设计 §1.5），只是保留停用账号（Active 列为 NO，includeInactive）。「Passed at」与「Completed on」都取 programDoneAt，
      // 与看板的完成日期同源。
      const rows = [["Employee ID", "Name", "Department", "Position", "Job level", "Hire date", "Emp status", "Active", "Program", "Assigned", "Due date", "Status", "Progress %", "Best score %", "Passed", "Passed at", "Attempts", "Last login", "Category", "Requirement", "Completed on", "Source"]];   // 第四批 7：末尾 Source（Assigned / Self-directed）
      // P2 范围（learning）：导出是最容易漏的一面 —— 一个 CSV 一次性把全公司的部门/
      // 职级/入职日/最后登录带出系统。按人过滤（trainingOverviewBase 的人群），范围外的人一行都不写。
      const ov = trainingOverviewBase(user, (k) => query.get(k), { includeInactive: true });
      const S = ov.snap();
      for (const c of ov.cells()) {
        if (!ov.inS(c)) continue;
        const u = c.u, p = c.p, m = ov.meta(p);
        const prog = c.progress;
        const mine = S.attemptsOf(u.id, p.id);
        const best = mine.length ? mine.reduce(QT.betterAttempt) : null;
        const passedAttempt = mine.some((a) => a.passed && S.isSettled(a));
        const due = c.asg.dueAt;
        const examless = !m.examCount;
        // 完成与否只认 programDone（2026-10-07，与逾期提醒、看板同一口径）
        const completed = c.done;
        const overdue = due && !completed && c.published && LC.isOverdue(due, new Date(nowMs()));
        const status = completed ? (examless ? "COMPLETED" : "PASSED") : overdue ? "OVERDUE" : passedAttempt ? "IN PROGRESS" : prog >= 100 ? "EXAM PENDING" : prog > 0 ? "IN PROGRESS" : "NOT STARTED";
        const doneAtIso = completed ? c.doneAt : null;
        rows.push([
          u.employeeId, u.name, u.department || "", u.position || "", u.jobLevel || "", u.hireDate || "", u.empStatus || "", u.active === 0 ? "NO" : "YES", p.title,
          (c.asg.assignedAt || "").slice(0, 10), due || "",
          status, prog,
          best ? best.percent : "", completed ? "YES" : "NO",
          doneAtIso ? String(doneAtIso).slice(0, 16).replace("T", " ") : "",
          mine.length, u.lastLoginAt ? u.lastLoginAt.slice(0, 16).replace("T", " ") : "never",
          CAT.categoryLabel(m.category, "en"), m.enrollType === "elective" ? "Elective" : "Required", doneAtIso ? TS.dayOf(doneAtIso) : "",
          c.self ? "Self-directed" : "Assigned",
        ]);
      }
      audit("export.completion-csv", null, null, { rows: rows.length - 1 });
      return sendCsv(res, `training-completion-${todayLocal()}.csv`, rows);
    }
    // Attempts log: every submitted exam attempt.
    if (pathname === "/api/admin/export/attempts.csv") {
      const examTitles = Object.fromEntries(store.listExams().map((e) => [e.id, e.title]));
      const examTitlesZh = Object.fromEntries(store.listExams().map((e) => [e.id, e.title_zh || e.title]));
      // CX-152：开始 / 提交时间按马尼拉时间（UTC+8，与界面一致；原来是 UTC 且没标时区）；末尾加课程、考试的中文名两列
      // （放在末尾：已有导入与用例按前几列的位置读）。文件带 UTF-8 BOM（csvText），Excel 打开中文不乱码。
      const manila = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : ""; };
      // Grading status（AI 治理方案 2.5）：grading 评分中 / pending_review 待 HR 复核 / manual_pending 待 HR 评分（Score % 为不含该题的下限）/ final
      const rows = [["Employee ID", "Name", "Program", "Exam", "Attempt #", "Started (UTC+8 Manila)", "Submitted (UTC+8 Manila)", "Duration (min)", "Score %", "Passed", "Adjusted by HR", "Grading status", "课程（中文）", "考试（中文）", "Voided 已作废"]];   // CX-202：重置作废的答卷单独标出
      // Attempt # is per employee × exam, in chronological order.
      const all = store.listSubmittedAttempts().slice().sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
      const counters = new Map(), seq = new Map();
      for (const a of all) {
        const key = a.userId + "|" + (a.examId || a.programId);
        const n = (counters.get(key) || 0) + 1;
        counters.set(key, n);
        seq.set(a.id, n);
      }
      // P2 范围（learning）：按提交人过滤，范围外的答卷一行不导。刻意放在**输出**这一
      // 步而不是上面的 counters —— 「第 N 次」是每人 × 每场考试自己的序号，用未过滤的
      // 全集算才准确，而过滤它只会让范围内的人凭空从「第 3 次」变成「第 1 次」。
      const attCsvScope = scopePredicate(user);
      for (const a of all) {
        const u = store.getUserById(a.userId);
        if (attCsvScope && !attCsvScope(u)) continue;
        const p = getProgram(a.programId);
        const mins = Math.round((new Date(a.submittedAt) - new Date(a.startedAt)) / 60000 * 10) / 10;
        const adjusted = (a.detail || []).some((d) => d.overridden);
        rows.push([
          u ? u.employeeId : "?", u ? u.name : "?", p ? p.title : a.programId,
          (a.examId && examTitles[a.examId]) || "",
          seq.get(a.id),
          manila(a.startedAt), manila(a.submittedAt),
          mins, a.percent, a.gradingStatus === "grading" || a.gradingStatus === "pending_review" ? "PENDING" : a.passed ? "YES" : "NO", adjusted ? "YES" : "", a.gradingStatus || "final",
          p ? p.title_zh || p.title : a.programId, (a.examId && examTitlesZh[a.examId]) || "",
          a.voided ? "YES" : "",
        ]);
      }
      audit("export.attempts-csv", null, null, { rows: rows.length - 1 });
      return sendCsv(res, `exam-attempts-${todayLocal()}.csv`, rows);
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 17213–17403 行（/api/admin/ 块内）
    async adminCore10(C) {
      const { pathname, req, res, body, audit, requestId, user } = C;
      const { store, send, questionItemFromBody, QT, AI, sendAiState, aiFeatures, getCourse, attachmentText, sendAiRateLimited, aiRoster, sendAiError, sanitizeGrants } = S;
    const delQ = pathname.match(/^\/api\/admin\/questions\/([\w-]+)$/);
    // 原地修改题目（2026-10-06）：保留题目 id —— 固定题目模式的考试按 id 引用题目，旧做法「新建再删旧」会让这些考试悄悄少一题。
    // 表单不编辑的字段沿用原值：讲解（请求体不带 explanation / explanation_zh 时）、所属模块（不带 moduleId 且课程没变时）、AI 来源。
    if (delQ && req.method === "PUT") {
      const old = store.getQuestion(delQ[1]);
      if (!old) return send(res, 404, { error: "Question not found. 题目不存在。", code: "not_found" });
      const built = questionItemFromBody(body);
      if (built.error) return send(res, 400, { error: built.error, ...(built.error_zh ? { error_zh: built.error_zh } : {}), ...(built.code ? { code: built.code } : {}) });
      const item = built.item;
      const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
      if (!has("moduleId")) item.moduleId = item.courseId === old.courseId ? old.moduleId || null : null;
      // 讲解沿用原值：简答以外的题型（第四批：按注册表分组，新题型同样适用）
      if (QT.groupOf(item.type) !== "open" && !has("explanation") && !has("explanation_zh")) { item.explanation = old.explanation || ""; item.explanation_zh = old.explanation_zh || null; }
      if (old.origin) item.origin = old.origin;
      store.updateQuestion(delQ[1], item);
      audit("question.update", delQ[1], null, { courseId: item.courseId, type: item.type });
      return send(res, 200, { ok: true, id: delQ[1] });
    }
    if (delQ && req.method === "DELETE") {
      // CX-060（10/11 上线前测试）：不存在的题目回 404、不写审计，与更新接口和其他删除接口同一口径
      if (!store.getQuestion(delQ[1])) return send(res, 404, { error: "Question not found. 题目不存在。", code: "not_found" });
      // CX-146：已发布的固定题目考试正在用这道题时不许删（删了卷面少题、总分变、考试列表题量对不上）。
      // 未发布的考试不拦：编辑页会提示「有题已不在题库中」，发布前改卷即可。题库页逐题调用本接口做批量删除，同样拦截。
      const usedBy = store.listExams().filter((e) => e.status === "published" && e.mode === "fixed" && (e.questionIds || []).includes(delQ[1]));
      if (usedBy.length) {
        const en = usedBy.map((e) => e.title || e.title_zh || e.id).join(", ");
        const zh = usedBy.map((e) => `《${e.title_zh || e.title || e.id}》`).join("、");
        return send(res, 409, {
          error: `This question is used by published fixed-question exam(s): ${en}. Remove it from those exams first.`,
          error_zh: `这道题正被已发布的固定题目考试使用：${zh}。请先在考试中移除该题，再删除。`,
          code: "question_in_use", exams: usedBy.map((e) => ({ id: e.id, title: e.title, title_zh: e.title_zh || null })),
        });
      }
      audit("question.delete", delQ[1], null, null);
      store.deleteQuestion(delQ[1]);
      return send(res, 200, { ok: true });
    }
    // AI 出题（learning 路由；方案 4.2）。请求体 { source: "paste"|"course", material?, courseId?, moduleId?,
    // counts: { single, multi, truefalse, fill, open } }，兼容旧的 mcqCount / openCount。材料经 R1–R5c 脱敏、放进数据区块；
    // 题型计数与每题的正确项个数由本地语义校验保证（不符时一次补救调用）。响应每题带 sourceQuote、difficulty，
    // 与题库比对标出疑似重复（similarTo），附 callId —— 采纳时带回 aiCallId，服务端核对后写入题目来源（origin）。
    if (pathname === "/api/admin/ai/generate" && req.method === "POST") {
      const st = AI.featureState("questionGen");
      if (st.state === "off_module" || st.state === "off_owner") return sendAiState(res, st);
      let counts;
      if (body.counts && typeof body.counts === "object") counts = aiFeatures.normCounts(body.counts);
      else counts = aiFeatures.normCounts({ single: body.mcqCount ?? 5, open: body.openCount ?? 1 });
      // 第四批：每个已开放题型各自计数，情境案例每组按 3 题计（aiFeatures.countTotal）
      const total = typeof aiFeatures.countTotal === "function" ? aiFeatures.countTotal(counts) : Object.values(counts).reduce((n, x) => n + x, 0);
      if (total < 1 || total > 20) return send(res, 400, { error: "Ask for between 1 and 20 questions.", error_zh: "请生成 1 至 20 道题。", code: "bad_counts" });
      let material = "";
      let courseId = body.courseId ? String(body.courseId) : null;
      if (body.source === "course") {
        const c = getCourse(courseId || "");
        if (!c) return send(res, 400, { error: "Unknown course", error_zh: "课程不存在。", code: "unknown_course" });
        const mods = body.moduleId ? c.modules.filter((m) => m.id === String(body.moduleId)) : c.modules;
        if (!mods.length) return send(res, 400, { error: "Unknown module", error_zh: "模块不存在。", code: "unknown_module" });
        material = mods.map((m) => aiFeatures.moduleText(m)).join("\n\n");
        // 小节附件（PDF / Word / PPT）的文字也作为材料 —— 很多课程只上传了讲义、没有正文。总长控制在 60,000 字以内。
        const seen = new Set();
        for (const m of mods) for (const sec of m.sections || []) for (const x of sec.attachments || []) {
          if (!x || seen.has(x.id) || material.length >= 59000) continue;
          seen.add(x.id);
          const att = store.getAttachment(x.id);
          if (!att || att.courseId !== c.id) continue;
          const text = (await attachmentText(att, 60000)).trim();
          if (text) material += `\n\n### 附件 / Attachment: ${att.originalName}\n` + text.slice(0, Math.max(0, 59500 - material.length));
        }
      } else {
        material = String(body.material || "");
      }
      if (material.trim().length < 100 && body.source === "course")
        return send(res, 400, { error: "Not enough text in this course to write questions from: its sections and PDF / Word / PPT attachments hold fewer than 100 characters (scanned PDFs and videos have no readable text). Paste the material instead.", error_zh: "这门课的正文和附件（PDF / Word / PPT）里能读到的文字不足 100 字（扫描版 PDF、视频读不出文字），请改用「粘贴材料」。", code: "material_too_short", source: "course" });
      if (material.trim().length < 100) return send(res, 400, { error: "Please paste at least a few paragraphs of training material.", error_zh: "请粘贴至少几段培训材料。", code: "material_too_short" });
      if (material.length > 60000) return send(res, 413, { error: "The content is too long. Please shorten it.", error_zh: "内容过长，请缩短后重试。", code: "ai_input_too_large" });
      if (st.state !== "on" && st.state !== "demo") return sendAiState(res, st);
      // 与题库比对：题干词集的 Jaccard 相似度 ≥ 0.6 视为疑似重复（只作提示）
      const words = (s) => new Set(String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
      const bank = store.listQuestions().filter((q) => !courseId || q.courseId === courseId).map((q) => ({ id: q.id, w: words(q.question) }));
      const similar = (text) => {
        const w = words(text);
        if (!w.size) return null;
        for (const b of bank) {
          let inter = 0;
          for (const x of w) if (b.w.has(x)) inter++;
          const uni = w.size + b.w.size - inter;
          if (uni && inter / uni >= 0.6) return b.id;
        }
        return null;
      };
      if (st.state === "demo") {
        const callId = AI.recordLocal("questionGen", { requestId, actorId: user.id, actorKind: "admin", refId: courseId, status: "demo" });
        const questions = aiFeatures.questionGenDemo(material, counts).map((q) => ({ ...q, similarTo: similar(q.question) }));
        const cases = typeof aiFeatures.questionGenDemoCases === "function" ? aiFeatures.questionGenDemoCases(material, counts) : [];
        return send(res, 200, { demo: true, callId, questions, cases });
      }
      const rl = AI.rateHit("questionGen", user.id);
      if (!rl.ok) {
        AI.recordLocal("questionGen", { requestId, actorId: user.id, actorKind: "admin", refId: courseId, status: "blocked", errorCode: "ai_rate_limited" });
        return sendAiRateLimited(res, rl.retryAfterSec);
      }
      const built = aiFeatures.buildQuestionGen({ material, counts, roster: aiRoster() });
      try {
        const out = await AI.call("questionGen", { requestId, actorId: user.id, actorKind: "admin", refId: courseId, system: built.system, messages: built.messages, schema: built.schema, semantic: built.semantic, redactions: built.redactions });
        // 第四批：{ questions, cases }（processQuestionGen 把旧结构的回复补成完整形状）；案例里的小题也比对疑似重复
        const pj = typeof aiFeatures.processQuestionGen === "function" ? aiFeatures.processQuestionGen(out.json) : { questions: out.json.questions || [], cases: [] };
        const questions = (pj.questions || []).map((q) => ({ ...q, similarTo: similar(q.question) }));
        const cases = (pj.cases || []).map((k) => ({ ...k, questions: (k.questions || []).map((q) => ({ ...q, similarTo: similar(q.question) })) }));
        return send(res, 200, { callId: out.callId, model: out.provenance.modelReturned || out.provenance.model, questions, cases });
      } catch (e) {
        return sendAiError(res, e);
      }
    }

    // AI 翻译（learning 路由，2026-10-06）。请求体 { to: "en"|"zh", refId?, items: [{ key, text, format?: "text"|"html" }] }。
    // 只返回译文草稿，不写库 —— 由页面填进表单，HR 审阅后照常保存。每次调用记一行 ai_calls（功能 translate）。
    if (pathname === "/api/admin/ai/translate" && req.method === "POST") {
      const st = AI.featureState("translate");
      if (st.state === "off_module" || st.state === "off_owner") return sendAiState(res, st);
      const to = body.to === "zh" ? "zh" : body.to === "en" ? "en" : null;
      if (!to) return send(res, 400, { error: "Choose the target language (en or zh).", error_zh: "请选择目标语言。", code: "bad_target" });
      const items = (Array.isArray(body.items) ? body.items : [])
        .map((it, i) => ({ key: String((it && it.key) || i), text: String((it && it.text) || ""), format: it && it.format === "html" ? "html" : "text" }))
        .filter((it) => it.text.trim());
      if (!items.length) return send(res, 400, { error: "Nothing to translate.", error_zh: "没有需要翻译的内容。", code: "nothing_to_translate" });
      if (items.length > 80) return send(res, 400, { error: "Translate at most 80 fields at a time.", error_zh: "一次最多翻译 80 个字段。", code: "too_many_items" });
      const totalLen = items.reduce((n, it) => n + it.text.length, 0);
      if (totalLen > 60000) return send(res, 413, { error: "The content is too long. Translate it in parts.", error_zh: "内容过长，请分批翻译。", code: "ai_input_too_large" });
      if (st.state !== "on" && st.state !== "demo") return sendAiState(res, st);
      const refId = body.refId ? String(body.refId).slice(0, 80) : null;
      if (st.state === "demo") {
        const callId = AI.recordLocal("translate", { requestId, actorId: user.id, actorKind: "admin", refId, status: "demo" });
        return send(res, 200, { demo: true, callId, to, items: aiFeatures.translateDemo(items, to) });
      }
      const rl = AI.rateHit("translate", user.id);
      if (!rl.ok) {
        AI.recordLocal("translate", { requestId, actorId: user.id, actorKind: "admin", refId, status: "blocked", errorCode: "ai_rate_limited" });
        return sendAiRateLimited(res, rl.retryAfterSec);
      }
      const built = aiFeatures.buildTranslate({ items, to, roster: aiRoster() });
      try {
        const out = await AI.call("translate", { requestId, actorId: user.id, actorKind: "admin", refId, system: built.system, messages: built.messages, schema: built.schema, semantic: built.semantic, redactions: built.redactions });
        return send(res, 200, { callId: out.callId, model: out.provenance.modelReturned || out.provenance.model, to, items: aiFeatures.processTranslate(out.json, built) });
      } catch (e) {
        return sendAiError(res, e);
      }
    }

    // --- roles & authorization (roles domain — super-admin only, D6; the RBAC
    // gate above already 403s any non-super before reaching here) ---
    if (pathname === "/api/admin/roles" && req.method === "GET") {
      return send(res, 200, { roles: store.listRoles() });
    }
    if (pathname === "/api/admin/roles" && req.method === "POST") {
      const name = String(body.name || "").trim();
      if (!name) return send(res, 400, { error: "Role name is required. 请填写角色名称。" });
      if ((body.grants || {}).roles === "manage")
        return send(res, 400, { error: "The roles domain is reserved for super-admins and can't be granted. 角色与授权域为超级管理员专属，不可授予。" });
      const grants = sanitizeGrants(body.grants);
      const scope = body.scope && typeof body.scope === "object" && !Array.isArray(body.scope) ? body.scope : {};
      const id = store.createRole({ name, name_zh: String(body.name_zh || "").trim(), grants, scope, builtin: 0 });
      const created = store.getRole(id);
      audit("role.create", String(id), null, { name: created.name, name_zh: created.name_zh, grants: created.grants });
      return send(res, 200, { ok: true, role: { ...created, memberCount: 0 } });
    }
    const roleId = pathname.match(/^\/api\/admin\/roles\/(\d+)$/);
    if (roleId && req.method === "PUT") {
      const id = Number(roleId[1]);
      const role = store.getRole(id);
      if (!role) return send(res, 404, { error: "Not found" });
      if (role.builtin && role.key === "super-admin")
        return send(res, 400, { error: "The super-admin role is locked and can't be edited. 超级管理员角色已锁定，不可编辑。" });
      const patch = {};
      if (body.name !== undefined) {
        const nm = String(body.name || "").trim();
        if (!nm) return send(res, 400, { error: "Role name can't be empty. 角色名称不能为空。" });
        patch.name = nm;
      }
      if (body.name_zh !== undefined) patch.name_zh = String(body.name_zh || "").trim();
      if (body.grants !== undefined) {
        if ((body.grants || {}).roles === "manage")
          return send(res, 400, { error: "The roles domain is reserved for super-admins and can't be granted. 角色与授权域为超级管理员专属，不可授予。" });
        patch.grants = sanitizeGrants(body.grants);
      }
      if (body.scope !== undefined) patch.scope = body.scope && typeof body.scope === "object" && !Array.isArray(body.scope) ? body.scope : {};
      store.updateRole(id, patch);
      const after = store.getRole(id);
      audit("role.update", String(id),
        { name: role.name, name_zh: role.name_zh, grants: role.grants },
        { name: after.name, name_zh: after.name_zh, grants: after.grants });
      return send(res, 200, { ok: true, role: { ...after, memberCount: store.roleMemberCount(id) } });
    }
    if (roleId && req.method === "DELETE") {
      const id = Number(roleId[1]);
      const role = store.getRole(id);
      if (!role) return send(res, 404, { error: "Not found" });
      if (role.builtin && role.key === "super-admin")
        return send(res, 400, { error: "The super-admin role can't be deleted. 超级管理员角色不可删除。" });
      const members = store.roleMemberCount(id);
      if (members > 0)
        return send(res, 400, { error: `${members} member(s) still have this role — reassign them first. 仍有 ${members} 人使用此角色，请先改派后再删除。`, code: "in_use", memberCount: members });
      audit("role.delete", String(id), { name: role.name, name_zh: role.name_zh, grants: role.grants }, null);
      store.deleteRole(id);
      return send(res, 200, { ok: true });
    }
      return S.ROUTE_NEXT;
    },
  };
};
