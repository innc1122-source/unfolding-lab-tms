"use strict";
// 绩效（评估、申诉、组织绩效） 的接口处理（简化 10/11：从 server.js 的 handleApi 原样搬出，代码不改；按原顺序分段，server.js 在原位置依次调用）。
// 每段是一个方法：C = 本段用到的 handleApi 局部变量（req、res、user、body、audit 等）；S = server.js 的模块级函数与常量
// （getter，取调用当时的值；require / __dirname 也是 server.js 的，相对路径照旧以仓库根目录为准）。
// 段内匹配到接口时照原样 return；都没匹配到时返回 S.ROUTE_NEXT，server.js 接着往下匹配。改接口就在这里改。
module.exports = function routes(S) {
  return {
    // server.js handleApi 原第 8140–8755 行（登录后的员工端接口）
    async mePerformance1(C) {
      const { pj, pathname, req, user, res, body, audit } = C;
      const { store, OP, orgDept1List, send, reviewPersonGone, reviewUserMemo, reviewHodProxyOf, reviewRecordRatingOf, reviewQuotaOf, reviewBucket, orgSnapshot, reviewCycleStartDay, reviewTeamPayload, reviewSelfLocked, employeeSeesManagerComment, reviewManagerStatus, optionsZhOf, hodGroupsFor, nowMs, APPEAL_CONSULT_RECENT_DAYS, todayLocal, reviewOneState, reviewItemLocked, reviewOverdueOf, reviewSelfOverdue, REVIEW_HIGHLIGHT_RATINGS, validDateStr, modulesOn, reviewAppealEligibility, appealToday, appealErr, appealPerfVisible, reviewAppealCtx, appealRouteDept, appealRecRating, employeeAppealOut, APPEAL_LIMITS, APPEAL_CATEGORIES, reviewRecipientOk, APPEAL_REASON_MIN, APPEAL_REASON_MAX, APPEAL_CATEGORY_KEYS, APPEAL_FILES_MAX, appealSubmitConflicts, workdayAdd, manilaDay, APPEAL_SLA_WORKDAYS, runBatch, appealTagged, appealSaveFailed, appealCacheClear, afterCommit, appealNotify, appealEmpLink, appealAdminLink, reviewSelfOf, APPEAL_OPINION_MIN, APPEAL_OPINION_MAX, reviewDeptLocked, reviewCalibView, bulkCap, reviewHodCtx, reviewHodChange, reviewHodWrite, sendBatchFailed, reviewNotifyProxied, reviewGroups, sendReviewHodErr, bulkIdList, planReviewReminders, emitBulkEffects, emitReviewReminder, bulkSkip, sendBulkResult, reviewSubmitIssues, reviewSnapPut, notifyAdmins } = S;
  const reviewShape = (i) => ({
    id: i.id, cycle: i.cycleName, dueAt: i.cycleDueAt || null,
    prevGoals: pj(i.prevGoals, []), selfOutcomes: pj(i.selfOutcomes, []),
    selfChallenges: i.selfChallenges || "", selfFeedback: i.selfFeedback || "", selfExtra: i.selfExtra || "",
    goalsNext: pj(i.goalsNext, []), selfAt: i.selfAt,
    oneOnOneAt: i.oneOnOneAt, oneOnOneNotes: i.oneOnOneNotes || "",
    managerRating: i.managerRating, managerText: i.managerText || "", managerAt: i.managerAt,
    // 绩效流程 v2（迁移 65）：员工确认面谈、关键亮点、周期是否走新流程
    employeeOneOnOneAt: i.employeeOneOnOneAt || null, highlights: i.highlights || "",
    flow: i.cycleFlow || null, dueRateAt: i.cycleDueRateAt || null,
    // 绩效看板第三期（10/10）：「我的绩效」概要的「本期进度」要写部门校准截止日（只有本人条目的查询带这一列，团队条目为 undefined）
    ...(i.cycleDueCalibAt !== undefined ? { dueCalibAt: i.cycleDueCalibAt || null } : {}),
  });

  // 组织绩效 · 员工端（负责人 2026-10-10）：一级部门负责人的互评与本部门结果
  //   GET  /api/me/reviews/orgperf                 → { dims, bands, issuePrompt, rounds:[我是评分人的轮次（进行中 + 最近关闭的）], mine:[我负责的一级部门：近 4 季度结果 + 最近关闭轮次的互评汇总] }
  //   PUT  /api/me/reviews/orgperf/rounds/:id      { dept1Id?, answers:{ 被评部门 id: { scores, issue } }, submit? } → 保存草稿；submit = 提交（之后不能改，HR 可退回）
  if (pathname === "/api/me/reviews/orgperf" && req.method === "GET") {
    const myRows = store.listOrgRatersOfUser(user.id);
    const rounds = [];
    for (const rr of myRows) {
      const r = store.getOrgRound(rr.roundId);
      if (!r || r.status === "draft") continue;
      // 代码审查 10/11：同一人兼任多个一级部门负责人时，不评自己负责的任何一个部门
      const ownInRound = new Set(myRows.filter((x) => x.roundId === r.id).map((x) => x.dept1Id));
      const targets = store.listOrgTargets(r.id).filter((t) => !ownInRound.has(t.dept1Id));
      const answers = {};
      for (const a of store.listOrgAnswersOf(r.id, rr.dept1Id)) answers[a.targetDept1Id] = { scores: a.scores, issue: a.issue || "" };
      const myDeptName = (store.listOrgTargets(r.id).find((t) => t.dept1Id === rr.dept1Id) || {}).dept1 || null;
      rounds.push({ id: r.id, quarter: r.quarter, name: r.name, status: r.status, dueOn: r.dueOn, issueRequired: !!r.issueRequired, dept1Id: rr.dept1Id, dept1: myDeptName, submittedAt: rr.submittedAt || null, targets, answers,
        dims: Array.isArray(r.dims) && r.dims.length ? r.dims : OP.DIMS });   // 代码审查 10/11：按本轮的维度渲染（校验与汇总用的也是本轮的）
    }
    const byQ = (a, b) => String(b.quarter).localeCompare(String(a.quarter));
    const openRounds = rounds.filter((x) => x.status === "open").sort(byQ), closedRounds = rounds.filter((x) => x.status === "closed").sort(byQ).slice(0, 1);
    // 我负责的一级部门（按组织快照的当前负责人）
    const myDepts = orgDept1List().filter((d) => d.hod && d.hod.id === user.id);
    const closedAll = store.listOrgRounds().filter((r) => r.status === "closed");
    const mine = myDepts.map((d) => {
      const results = store.listOrgResults().filter((x) => x.dept1Id === d.dept1Id).slice(0, 4).map((x) => ({ quarter: x.quarter, rating: x.rating, note: x.note || null }));
      // 负责人 10/12：只看 HR 已发布结果的最近一轮；发布后各维度都给平均（不再按 3 个评分部门门槛隐藏），卡点只有文字、已排序（匿名）。
      // 最近结束的一轮还没发布时，另给 pending 提示。
      const inRound = (r) => store.listOrgTargets(r.id).some((t) => t.dept1Id === d.dept1Id);
      const latestClosed = closedAll.find(inRound);
      const last = closedAll.find((r) => r.publishedAt && inRound(r));
      let peer = null;
      if (last) {
        const raters = store.listOrgRaters(last.id);
        const sum = OP.summarize(store.listOrgTargets(last.id).filter((t) => t.dept1Id === d.dept1Id), store.listOrgAnswers(last.id), raters.filter((x) => x.submittedAt).map((x) => x.dept1Id), last.dims)[0];
        peer = sum ? { roundId: last.id, quarter: last.quarter, name: last.name, publishedAt: last.publishedAt, raters: sum.raters, dims: sum.dims, overall: sum.overall, issues: sum.issues }
          : { roundId: last.id, quarter: last.quarter, name: last.name, publishedAt: last.publishedAt, raters: 0, dims: {}, overall: null, issues: [] };
      }
      const pending = latestClosed && !latestClosed.publishedAt ? { roundId: latestClosed.id, name: latestClosed.name } : null;
      return { dept1Id: d.dept1Id, dept1: d.dept1, results, peer, pending };
    });
    return send(res, 200, { dims: OP.DIMS, bands: OP.BANDS, issuePrompt: OP.ISSUE, rounds: [...openRounds, ...closedRounds], mine });
  }
  const opMeRound = pathname.match(/^\/api\/me\/reviews\/orgperf\/rounds\/([\w-]+)$/);
  if (opMeRound && req.method === "PUT") {
    const r = store.getOrgRound(opMeRound[1]);
    const rows = store.listOrgRatersOfUser(user.id).filter((x) => x.roundId === (r && r.id));
    if (!r || !rows.length) return send(res, 404, { error: "Not found", error_zh: "未找到该互评。", code: "not_found" });
    const rr = body.dept1Id ? rows.find((x) => x.dept1Id === String(body.dept1Id)) : rows[0];
    if (!rr) return send(res, 404, { error: "Not found", error_zh: "未找到该互评。", code: "not_found" });
    if (r.status !== "open") return send(res, 409, { error: "This peer review is not open.", error_zh: "该互评未开放或已结束。", code: "round_not_open" });
    if (rr.submittedAt) return send(res, 409, { error: "Already submitted. Ask HR to return it if you need to change it.", error_zh: "已提交，不能再改；如需修改请联系 HR 退回。", code: "submitted" });
    const ownInRound = new Set(rows.map((x) => x.dept1Id));   // 代码审查 10/11：兼任多个一级部门负责人时，都不能评
    const targets = store.listOrgTargets(r.id).filter((t) => !ownInRound.has(t.dept1Id));
    const tIds = new Set(targets.map((t) => t.dept1Id));
    const submit = body.submit === true;   // 代码审查 10/11：只认布尔 true（字符串 "false" 不算提交）
    const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
    const checked = [];
    for (const [tid, a] of Object.entries(answers)) {
      if (!tIds.has(tid)) return send(res, 400, { error: "Unknown department in the answers.", error_zh: "作答里有不在本轮的部门。", code: "bad_target", dept1Id: tid });
      const c = OP.checkAnswer(a, r.dims);
      if (!c.ok && c.code === "bad_issue") return send(res, 400, { error: "The blocker must be text.", error_zh: "卡点须为文字。", code: "bad_issue", dept1Id: tid });
      if (!c.ok) return send(res, 400, { error: c.code === "bad_score" ? "Scores must be whole numbers from 0 to 10." : `Keep it within ${OP.ISSUE_MAX} characters.`, error_zh: c.code === "bad_score" ? "分数须为 0–10 的整数。" : `不超过 ${OP.ISSUE_MAX} 字。`, code: c.code, dept1Id: tid, dim: c.dim || null });
      checked.push([tid, c]);
    }
    // 负责人 10/10：没打分的部门 = 跳过（按不适用，不拦提交）；轮次设了「卡点题必填」时，打了分的部门须填卡点
    if (submit && r.issueRequired) {
      const done = new Map(store.listOrgAnswersOf(r.id, rr.dept1Id).map((a) => [a.targetDept1Id, OP.checkAnswer(a, r.dims)]));
      for (const [tid, c] of checked) done.set(tid, c);
      const missing = targets.filter((t) => { const c = done.get(t.dept1Id); return c && c.scored && !c.issue; }).map((t) => ({ dept1Id: t.dept1Id, dept1: t.dept1 }));
      if (missing.length) return send(res, 400, { error: "Write the blocker for every department you scored.", error_zh: "打了分的部门都要填写「最需解决的卡点」。", code: "issue_required", missing });
    }
    store.transaction(() => {
      for (const [tid, c] of checked) store.upsertOrgAnswer({ roundId: r.id, raterDept1Id: rr.dept1Id, targetDept1Id: tid, scores: c.scores, issue: c.issue });
      if (submit) store.updateOrgRater(r.id, rr.dept1Id, { submittedAt: new Date(nowMs()).toISOString() });
    });
    if (submit) audit("orgperf.submit", r.id, null, { quarter: r.quarter });   // 只记谁提交了哪一轮，不记内容（匿名）
    return send(res, 200, { ok: true, submitted: submit, saved: checked.length });
  }
  // 绩效看板第一期（负责人 2026-10-10）：经理「我的团队」看板。人群 = 本人作为发起时直属上级的条目（与团队名单同一人群：主管只看自己团队）。
  //   cycles[]：最近的进行中周期 + 最近 4 个已关闭周期（负责人定趋势看 4 期），每期：计入人数、本人给的评级分布 mine、配额 quota（v2）；
  //             已关闭周期另给最终（档案）评级分布 final 与「我给的 → 最终」变动 moves（HoD 代评不计）；people 为每人一行（姓名、我给的、最终）。
  //   attention[]：当前团队里近两个已关闭周期的档案评级 —— 连续两期 C / D（low2）、较上期降两档及以上（drop2）。
  //   只读；不下发自评正文、评语与人才标签（离职风险等受控标签只给 HR）。
  if (pathname === "/api/me/reviews/team-dashboard" && req.method === "GET") {
    const rf = store.listRecordFields("performance").find((x) => x.key === "rating");
    const scale = rf && Array.isArray(rf.options) && rf.options.length ? rf.options : ["A+", "A", "B+", "B", "C", "D"];
    if (reviewPersonGone(user)) return send(res, 200, { scale, cycles: [], attention: [] });
    const userOfT = reviewUserMemo();
    const rankT = (r) => { const k = scale.indexOf(r); return k < 0 ? null : scale.length - k; };
    const byCycle = new Map();
    for (const i of store.listManagedReviewItems(user.id)) {
      const c = store.getReviewCycle(i.cycleId);
      if (!c) continue;
      if (!byCycle.has(c.id)) byCycle.set(c.id, { c, items: [] });
      byCycle.get(c.id).items.push(i);
    }
    const all = [...byCycle.values()].sort((a, b) => String(b.c.createdAt || "").localeCompare(String(a.c.createdAt || "")));
    const openOne = all.find((x) => x.c.status !== "closed");
    const closedFour = all.filter((x) => x.c.status === "closed").slice(0, 4);
    const pick = [...(openOne ? [openOne] : []), ...closedFour];
    const cycles = pick.map(({ c, items }) => {
      const closedC = c.status === "closed";
      const people = [], mine = {}, final = {}, moves = { up: 0, down: 0, same: 0 };
      for (const i of items) {
        const u = userOfT(i.userId);
        if (reviewPersonGone(u)) continue;
        const proxiedT = !!reviewHodProxyOf(c, i, userOfT);
        // 代码审查 10/11：有归档记录时只认档案评级（HR 删了记录 = 没有评级，不退回归档前的评级），与后台看板、员工「我的绩效」同口径
        const fin = closedC ? (i.recordId ? reviewRecordRatingOf(i).recordRating : (i.finalRating || i.managerRating || null)) : null;
        if (i.managerRating && !proxiedT) mine[i.managerRating] = (mine[i.managerRating] || 0) + 1;
        if (fin) final[fin] = (final[fin] || 0) + 1;
        let move = null;
        if (closedC && i.managerRating && !proxiedT && fin) {
          const a = rankT(i.managerRating), b = rankT(fin);
          move = a == null || b == null || a === b ? "same" : b > a ? "up" : "down";
          moves[move]++;
        }
        people.push({ userId: i.userId, name: u ? u.name : "?", position: u ? u.position || null : null, mine: proxiedT ? null : i.managerRating || null, proxied: proxiedT, final: fin, move });
      }
      return { cycleId: c.id, name: c.name, kind: c.kind || "quarter", flow: c.flow || null, status: c.status, createdAt: c.createdAt || null,
        counted: people.length, quota: c.flow === "v2" ? reviewQuotaOf(c) : null, mine, final: closedC ? final : null, moves: closedC ? moves : null, people };
    });
    // 关注名单：当前直属下属（users.managerId = 本人、在职）× 近两个已关闭周期。不按最近一期的参与名单：进行中的周期可能只拉了部分人
    const cur = new Set(store.listUsers().filter((u) => u.managerId === user.id && !reviewPersonGone(u)).map((u) => u.id));
    const c0 = cycles.filter((x) => x.status === "closed")[0], c1 = cycles.filter((x) => x.status === "closed")[1];
    const finOf = (cy, uid) => { const p = cy && cy.people.find((x) => x.userId === uid); return p ? p.final : null; };
    const attention = [];
    for (const uid of cur) {
      const r0 = finOf(c0, uid), r1 = finOf(c1, uid);
      const reasons = [];
      if (r0 && r1 && reviewBucket(r0) === "C/D" && reviewBucket(r1) === "C/D") reasons.push("low2");
      if (r0 && r1 && rankT(r0) != null && rankT(r1) != null && rankT(r1) - rankT(r0) >= 2) reasons.push("drop2");
      if (!reasons.length) continue;
      const u = userOfT(uid);
      attention.push({ userId: uid, name: u ? u.name : "?", position: u ? u.position || null : null, reasons, latest: r0, previous: r1 });
    }
    return send(res, 200, { scale, cycles, attention, closedCycles: [c0, c1].filter(Boolean).map((x) => ({ cycleId: x.cycleId, name: x.name })) });
  }
  if (pathname === "/api/me/reviews" && req.method === "GET") {
    const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
    const perfType = store.getRecordType("performance");
    const snapMe = orgSnapshot();
    const meUserOf = reviewUserMemo();
    const myHod = user.department ? snapMe.hodOf(user.department) : null;
    const startOfMe = new Map();
    const cycleStartOf = (cid) => { if (!startOfMe.has(cid)) startOfMe.set(cid, reviewCycleStartDay(store.getReviewCycle(cid))); return startOfMe.get(cid); };
    // 第二批 2.1：上级的团队名单是轻量的 teamRows 与每周期统计 teamStats（口径见 reviewTeamPayload）；单人的完整内容（自评正文、
    // 面谈要点、评语、关键亮点）只在 GET team/:id 给。原来的完整形状 team[] 已在波次 3 删掉（W3-S，2026-10-08：前端已不读，grep 核对过）。
    const teamNew = reviewTeamPayload(user, snapMe);
    return send(res, 200, {
      // 面谈要点只给上级与 HR（D-17）：员工本人的评估不下发
      mine: store.listMyReviewItems(user.id).map((i) => {
        const o = { ...reviewShape(i), managerDone: !!i.managerAt };
        delete o.oneOnOneNotes;
        // U5：v2 周期进行中不给员工本人上级原评级（HoD 可能调整，员工只看关闭后的最终评级）；hodText / finalRating 本来就不在 shape 里。
        // 第二批 2.1：上级评语、关键亮点（A+/A/C/D 才必填，有无本身就透露档位）与评级时间同样不给，只留 managerDone
        if (i.cycleFlow === "v2") {
          delete o.managerRating; delete o.managerText; delete o.highlights; delete o.managerAt;
          o.selfLocked = reviewSelfLocked(i.cycleId, user);
        } else if (!employeeSeesManagerComment()) {
          // 第二批 L2：旧流程进行中，上级评完员工就看得到评语 —— 同样由 employeeSeesManagerComment() 一处决定
          o.managerText = "";
        }
        o.cycleStartedAt = cycleStartOf(i.cycleId);   // 周期发起日（本地日），面谈日期的下限
        // 第二批 2.7：直属上级（发起时的快照）已离职 / 停用或没有上级 → managerGone；由谁补评：v2 且本人所在一级部门有 HoD →
        // "hod"（HoD 代评），否则 "hr"（旧流程、未归部门、无 HoD 的组由 HR 定评级）
        o.managerGone = reviewManagerStatus(i, meUserOf) !== "active";
        o.managerGoneBy = o.managerGone ? (i.cycleFlow === "v2" && myHod && myHod.id !== user.id ? "hod" : "hr") : null;
        o.notCounted = reviewPersonGone(user) ? "departed" : i.cycleFlow === "v2" && myHod && myHod.id === user.id ? "hod_self" : null;
        return o;
      }),
      teamRows: teamNew.teamRows,
      teamStats: teamNew.teamStats,
      ratingOptions: ratingField ? ratingField.options : [],
      // Values stay canonical (they are what gets submitted and stored); the zh
      // list is display-only and index-paired with it.
      ratingOptions_zh: ratingField ? optionsZhOf(ratingField) : [],
      // 评级刻度说明（迁移 56，IA 4.8）：与 ratingOptions 按位置对齐，没有说明的项为空串
      ratingOptions_desc: ratingField ? ratingField.options_desc || [] : [],
      ratingOptions_desc_zh: ratingField ? ratingField.options_desc_zh || [] : [],
      // 周期关闭后的结果是否对员工本人可见（G-10，IA 4.6）：跟「绩效记录」类型的「员工可见」开关
      resultVisibleToEmployee: !!(perfType && perfType.active && perfType.employeeVisible),
      // 上级评语是否对员工本人显示（第二批 L2，employeeSeesManagerComment() 一处决定）：团队评估页的评级表单据此写提示（W3-S）
      commentVisibleToEmployee: employeeSeesManagerComment(),
      // 绩效流程 v2：本人是否担任某个进行中 v2 周期里的 HoD（显示「部门校准」页签）、是否有已关闭周期的结果（「我的绩效」）
      isHod: hodGroupsFor(user, snapMe).length > 0,
      // 组织绩效（2026-10-10）：一级部门负责人、或有过互评任务的人，显示「组织互评」视图
      orgView: store.listOrgRatersOfUser(user.id).length > 0 || orgDept1List().some((d) => d.hod && d.hod.id === user.id),
      hasHistory: store.listMyClosedReviewItems(user.id).length > 0,
      // 第二批 2.8：申诉征询（征询人看到「申诉征询」页签：total > 0）
      appealConsults: store.countReviewAppealConsultsFor(user.id, new Date(nowMs() - APPEAL_CONSULT_RECENT_DAYS * 86400e3).toISOString()),
    });
  }
  // 上级的单人评估页（第二批 2.1）：只对 item.managerId = 本人（发起时的上级快照）、本人仍在职、周期进行中的季度条目返回，
  // 其余一律 404。返回 TeamCard 的全部字段 + 行状态；HoD 已代评时只给 hodProxied，不给评级值。
  const teamItemMatch = pathname.match(/^\/api\/me\/reviews\/team\/([\w-]+)$/);
  if (teamItemMatch && req.method === "GET") {
    const it = store.getReviewItem(teamItemMatch[1]);
    const cycle = it ? store.getReviewCycle(it.cycleId) : null;
    if (!it || !cycle || it.managerId !== user.id || reviewPersonGone(user) || cycle.status !== "open" || cycle.kind === "annual")
      return send(res, 404, { error: "Review record not found. 未找到该评估记录。", code: "not_found" });
    const i = { ...it, cycleName: cycle.name, cycleDueAt: cycle.dueAt, cycleFlow: cycle.flow, cycleDueRateAt: cycle.dueRateAt };
    const userOfT = reviewUserMemo();
    const u = userOfT(i.userId);
    const snapT = orgSnapshot();
    const hodT = cycle.flow === "v2" && u && u.department ? snapT.hodOf(u.department) : null;
    const today = todayLocal();
    const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
    return send(res, 200, {
      item: {
        ...reviewShape(i), cycleId: cycle.id, kind: cycle.kind || "quarter", cycleStartedAt: reviewCycleStartDay(cycle),
        userId: i.userId, name: u ? u.name : "?",   /* 第三批 9.1：员工端不下发工号 */
        department: u ? u.department || null : null, position: u ? u.position || null : null, jobLevel: u ? u.jobLevel || null : null,
        notCounted: reviewPersonGone(u) ? "departed" : hodT && hodT.id === i.userId ? "hod_self" : null,
        managerStatus: "active", oneState: reviewOneState(i), locked: !!reviewItemLocked(cycle, i, { snap: snapT }),
        overdue: reviewOverdueOf(cycle, i, today), selfOverdue: reviewSelfOverdue(cycle, i, today),
        hodProxied: !!reviewHodProxyOf(cycle, i, userOfT),
        highlightsMissing: !!(cycle.flow === "v2" && i.managerRating && REVIEW_HIGHLIGHT_RATINGS.includes(i.managerRating) && !String(i.highlights || "").trim()),
      },
      ratingOptions: ratingField ? ratingField.options : [], ratingOptions_zh: ratingField ? optionsZhOf(ratingField) : [],
      ratingOptions_desc: ratingField ? ratingField.options_desc || [] : [], ratingOptions_desc_zh: ratingField ? ratingField.options_desc_zh || [] : [],
      highlightRatings: REVIEW_HIGHLIGHT_RATINGS,
      commentVisibleToEmployee: employeeSeesManagerComment(),   // 同 GET /api/me/reviews（W3-S）
    });
  }
  // 1 对 1 面谈登记（第二批 2.1，2026-10-08）：员工与上级各自登记自己这一侧，可以补登记过去的日期，与评级互不为前提。
  //   body { done: boolean, date?: "YYYY-MM-DD", notes?: string（只有上级一侧有效）}
  //   item.userId = 本人 → 员工一侧 employeeOneOnOneAt；item.managerId = 本人 → 上级一侧 oneOnOneAt / oneOnOneNotes（只限 v2；
  //   旧流程的面谈随上级评级一起勾选 → 400 flow_unsupported）；都不是 → 404。v2 不再要求先交自评（旧流程的员工一侧仍要求）。
  //   日期：不能晚于今天，不能早于周期发起日（400 date_invalid）；今天或不填 = 当前时间，补登记写 <date>T12:00:00.000Z
  //   （各时区截前 10 位都是同一天）；不带日期再登记一次保持原时间。
  //   撤销（done:false）：员工一侧部门提交校准后 409 self_locked（P0 S7）；上级一侧锁定后 400 dept_locked。
  //   上级本人已离职或停用 → 409 manager_inactive。审计 review.one-on-one { side, done, date, backfill }（时间有变化时才记）。
  const empOneMatch = pathname.match(/^\/api\/me\/reviews\/([\w-]+)\/one-on-one$/);
  if (empOneMatch && req.method === "POST") {
    const item = store.getReviewItem(empOneMatch[1]);
    const side = item && item.userId === user.id ? "employee" : item && item.managerId === user.id ? "manager" : null;
    if (!side) return send(res, 404, { error: "Review record not found. 未找到该评估记录。", code: "not_found" });
    const cycle = store.getReviewCycle(item.cycleId);
    if (!cycle || cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
    const v2 = cycle.flow === "v2";
    if (side === "manager" && !v2)
      return send(res, 400, { error: "In this cycle the 1-on-1 is confirmed together with the manager rating. 本周期的 1 对 1 面谈随上级评级一起确认。", code: "flow_unsupported" });
    if (side === "manager" && reviewPersonGone(user))
      return send(res, 409, { error: "Your account is no longer active, so you can't act on this review. 你的账号已不在职，不能再操作这条评估。", code: "manager_inactive" });
    if (side === "employee" && !v2 && !item.selfAt) return send(res, 400, { error: "Submit your self-review first. 请先提交自评。", code: "self_required" });
    const done = body.done !== false;
    const today = todayLocal();
    let date = null;
    if (done && body.date !== undefined && body.date !== null && body.date !== "") {
      const d = String(body.date).trim();
      const start = reviewCycleStartDay(cycle);
      if (!validDateStr(d) || d > today || (start && d < start))
        return send(res, 400, { error: "The date can't be in the future or before the cycle started. 日期不能晚于今天，也不能早于周期发起日。", code: "date_invalid" });
      date = d;
    }
    if (!done) {
      // P0 S7：部门已提交校准（含之后被退回）后员工不能再取消面谈确认 —— 否则已提交的部门会在 HR 确认时被拦住。登记（done:true）仍放行。
      if (side === "employee" && v2 && reviewSelfLocked(cycle.id, user))
        return send(res, 409, { error: "Your department's calibration has been submitted, so the 1-on-1 confirmation can't be withdrawn. 部门已提交校准，不能再取消面谈确认。", code: "self_locked" });
      if (side === "manager" && reviewItemLocked(cycle, item))
        return send(res, 400, { error: "This person's department has been submitted, so the 1-on-1 can't be withdrawn. 此人所在部门已提交校准，不能再撤销面谈登记。", code: "dept_locked" });
    }
    const col = side === "employee" ? "employeeOneOnOneAt" : "oneOnOneAt";
    const backfill = !!(date && date < today);
    const at = !done ? null : backfill ? `${date}T12:00:00.000Z` : date ? new Date(nowMs()).toISOString() : item[col] || new Date(nowMs()).toISOString();
    const fields = { [col]: at };
    const notesChanged = side === "manager" && body.notes !== undefined;
    if (notesChanged) fields.oneOnOneNotes = String(body.notes || "").trim().slice(0, 2000) || null;
    store.updateReviewItem(item.id, fields);
    if ((item[col] || null) !== at)
      audit("review.one-on-one", item.id, { at: item[col] || null }, { side, done, date: done ? date || today : null, backfill });
    return send(res, 200, { ok: true, side, at });
  }
  // 我的绩效：已关闭周期的最终评级与上级评语（跟「绩效记录」类型的员工可见开关）。
  // 第二批（审查 P0-4，2026-10-08）：关键亮点一律不下发 —— 亮点只有 A+/A/C/D 才必填、按上级原评级写，最终评级是 A 却没有亮点
  // （或有亮点的档位与最终评级对不上）就能推断出被 HoD 调整或代评过。
  // 第二批 2.6（2026-10-08）：评级与评语改读周期归档进档案的那条记录（review_items.recordId → talent_records.detail.rating /
  // summary），与成长档案（/api/me/growth）一致 —— HR 关闭后改过的评级只以最终值出现，原评级、修改标记与理由一概不下发。
  // 没有 recordId 的（关闭时没有评级、没写档案）回退到 finalRating || managerRating；归档记录已被删除的这一期不列（G7）。
  // 上级评语给不给员工由 employeeSeesManagerComment() 一处决定（负责人 Q1 待定，默认给）。
  if (pathname === "/api/me/reviews/history" && req.method === "GET") {
    const perfType = store.getRecordType("performance");
    const visible = !!(perfType && perfType.active && perfType.employeeVisible);
    if (!visible) return send(res, 200, { visible: false, items: [] });
    const seeComment = employeeSeesManagerComment();
    const items = [];
    // 第二批 2.8：每条带 appeal（null = 不开放申诉；否则 { state, communicatedOn, deadline, submittedAt?, withdrawnAt?, decidedAt? }），顶层带 today
    const myClosed = store.listMyClosedReviewItems(user.id);
    const appealsOfMine = modulesOn().performance ? store.mapReviewAppealsByItems(myClosed.map((i) => i.id)) : new Map();
    for (const i of myClosed) {
      let rating, comment;
      if (i.recordId) {
        const rec = store.getTalentRecord(i.recordId);
        if (!rec || rec.type !== "performance" || rec.userId !== user.id) continue;
        rating = rec.detail && rec.detail.rating != null && rec.detail.rating !== "" ? String(rec.detail.rating) : null;
        comment = rec.detail && rec.detail.summary ? String(rec.detail.summary) : "";
      } else {
        rating = i.finalRating || i.managerRating || null;
        comment = i.managerText || "";
      }
      if (!rating) continue;
      const ap = appealsOfMine.get(i.id) || null;
      const el = reviewAppealEligibility(user, i, {
        appeal: ap, perfVisible: true, rec: i.recordId ? store.getTalentRecord(i.recordId) : null,
        cycle: { status: i.cycleStatus, resultsAt: i.cycleResultsAt, appealDeadline: i.cycleAppealDeadline },
      });
      items.push({
        id: i.id, cycleId: i.cycleId, cycle: i.cycleName, kind: i.cycleKind || "quarter",
        year: String(i.closedAt || i.cycleCreatedAt || "").slice(0, 4),
        closedAt: i.closedAt, rating, managerText: seeComment ? comment : "",
        appeal: el.state === "none" ? null : {
          state: el.state, communicatedOn: el.window ? el.window.communicatedOn : null, deadline: el.window ? el.window.deadline : null,
          ...(ap ? { submittedAt: ap.submittedAt, withdrawnAt: ap.withdrawnAt || null, decidedAt: ap.decidedAt || null } : {}),
        },
      });
    }
    return send(res, 200, { visible: true, items, today: appealToday() });
  }
  // ---- 第二批 2.8：员工申诉（§4.1 E2–E4）与征询人（§4.2 C1–C3），都在 gate「/api/me/reviews」之下 ----
  // 员工只看到结论、HRBP 的答复与最终评级；申诉时的评级、调整前的评级、内部说明、处理人、征询一概不下发。
  const meAppealMatch = pathname.match(/^\/api\/me\/reviews\/([\w-]+)\/appeal$/);
  if (meAppealMatch && req.method === "GET") {
    const item = store.getReviewItem(meAppealMatch[1]);
    if (!item || item.userId !== user.id) return appealErr(res, "not_found");
    const cycle = store.getReviewCycle(item.cycleId);
    const ap = store.getReviewAppealByItem(item.id);
    const rec = item.recordId ? store.getTalentRecord(item.recordId) : null;
    const perfVisible = appealPerfVisible();
    const el = reviewAppealEligibility(user, item, { appeal: ap, cycle, perfVisible, rec });
    let recipients = null;
    if (el.state === "open") {
      const ctx = reviewAppealCtx();
      const { deptId } = appealRouteDept(item, user, ctx.cov);
      const h = ctx.handlers({ id: "preview:" + item.id, userId: user.id, itemId: item.id, deptId, conflictIds: "[]" });
      recipients = h.route === "hrbp" ? { kind: "hrbp", names: h.ids.map((id) => (ctx.user(id) || {}).name).filter(Boolean) } : { kind: "hr" };
    }
    return send(res, 200, {
      today: appealToday(),
      // 结果对员工隐藏时（制度审查 5a）仍给申诉状态与答复，但不给评级
      item: { id: item.id, cycleId: item.cycleId, cycle: cycle ? cycle.name : null, kind: cycle ? cycle.kind || "quarter" : "quarter", closedAt: cycle ? cycle.closedAt || null : null, rating: perfVisible ? appealRecRating(rec) : null },
      state: el.state, ...(el.state === "none" ? { reasonCode: el.reasonCode } : {}),
      window: el.window || null, ...(recipients ? { recipients } : {}),
      appeal: employeeAppealOut(ap), limits: APPEAL_LIMITS, categories: APPEAL_CATEGORIES,
    });
  }
  if (meAppealMatch && req.method === "POST") {
    const item = store.getReviewItem(meAppealMatch[1]);
    if (!item || item.userId !== user.id) return appealErr(res, "not_found");
    if (!reviewRecipientOk(user)) return appealErr(res, "not_in_service");
    const cycle = store.getReviewCycle(item.cycleId);
    const existing = store.getReviewAppealByItem(item.id);
    if (existing) return appealErr(res, "appeal_exists");
    const rec = item.recordId ? store.getTalentRecord(item.recordId) : null;
    const el = reviewAppealEligibility(user, item, { appeal: null, cycle, perfVisible: appealPerfVisible(), rec });
    if (el.state === "none") return appealErr(res, el.reasonCode === "not_in_service" ? "not_in_service" : "appeal_unavailable");
    if (el.state !== "open") return appealErr(res, "appeal_window_closed");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < APPEAL_REASON_MIN || reason.length > APPEAL_REASON_MAX) return appealErr(res, "appeal_reason");
    const category = body.category === undefined || body.category === null || body.category === "" ? null : String(body.category);
    if (category !== null && !APPEAL_CATEGORY_KEYS.has(category)) return appealErr(res, "appeal_category");
    const ids = body.attachmentIds === undefined || body.attachmentIds === null ? [] : body.attachmentIds;
    if (!Array.isArray(ids) || ids.length > APPEAL_FILES_MAX || ids.some((x) => typeof x !== "string" || !x) || new Set(ids).size !== ids.length)
      return appealErr(res, "appeal_attachment");
    const ctx = reviewAppealCtx();
    const { deptId, deptName } = appealRouteDept(item, user, ctx.cov);
    const conflictIds = appealSubmitConflicts(user.id, item, ctx);
    const nowIso = new Date(nowMs()).toISOString();
    const slaDueOn = workdayAdd(manilaDay(nowMs()), APPEAL_SLA_WORKDAYS, ctx.holidays);
    const saved = runBatch(() => {
      const ap = store.createReviewAppeal({ itemId: item.id, cycleId: item.cycleId, userId: user.id, recordId: item.recordId, deptId, deptName,
        ratingAtSubmit: appealRecRating(rec), reason, submittedAt: nowIso, windowDeadline: el.window.deadline, slaDueOn, conflictIds, reasonCategory: category });
      for (const aid of ids) if (!store.bindAttachmentOwner(aid, "review_appeal", ap.id, user.id)) throw appealTagged("appeal_attachment");
      store.addReviewAppealEvent({ appealId: ap.id, actorId: user.id, kind: "submit", at: nowIso, data: { attachments: ids.length } });
      audit("review.appeal.submit", item.id, null, { appealId: ap.id, cycleId: item.cycleId, userId: user.id, employeeId: user.employeeId, deptId,
        route: ctx.handlers(ap).route, attachments: ids.length, attachmentIds: ids, reasonLength: reason.length, category });
      return ap;
    });
    if (!saved.ok) return appealSaveFailed(res, "review-appeal/submit", saved);
    appealCacheClear();
    const ap = saved.value;
    afterCommit("review-appeal/submit", () => {
      const c = cycle ? cycle.name : "";
      appealNotify(user.id, {
        title: `Your appeal against the ${c} final rating has been submitted`, title_zh: `你对「${c}」评级的申诉已提交`,
        body: "HR will review it and reply. You can withdraw it under My performance until HR starts the review.",
        body_zh: "HR 会复核并答复你。HR 开始处理前，你可以在「我的绩效」撤回申诉。", link: appealEmpLink(ap),
      });
      const h = ctx.handlers(ap);
      const fb = h.route === "fallback";
      for (const uid of h.ids) appealNotify(uid, {
        title: `${user.name} has appealed the final rating for ${c}`, title_zh: `${user.name} 对「${c}」最终评级提出申诉`,
        body: `Please reach a decision by ${ap.slaDueOn} (10-working-day response time).` + (fb ? " No HRBP is available for this employee's department, so the appeal has been routed to you." : ""),
        body_zh: `请在 ${ap.slaDueOn} 前作出结论（答复时限 10 个工作日）。` + (fb ? "该员工所在部门没有可处理的 HRBP，申诉已转给你。" : ""),
        link: appealAdminLink(ap),
      });
    });
    return send(res, 201, { ok: true, appeal: employeeAppealOut(ap) });
  }
  const meAppealWithdrawMatch = pathname.match(/^\/api\/me\/reviews\/([\w-]+)\/appeal\/withdraw$/);
  if (meAppealWithdrawMatch && req.method === "POST") {
    const item = store.getReviewItem(meAppealWithdrawMatch[1]);
    if (!item || item.userId !== user.id) return appealErr(res, "not_found");
    const ap = store.getReviewAppealByItem(item.id);
    if (!ap) return appealErr(res, "not_found");
    const ctx = reviewAppealCtx();
    const recips = ctx.handlers(ap).ids;
    const nowIso = new Date(nowMs()).toISOString();
    const saved = runBatch(() => {
      if (!store.transitionReviewAppeal(ap.id, { from: "submitted" }, { status: "withdrawn", withdrawnAt: nowIso })) {
        const cur = store.getReviewAppeal(ap.id);
        throw appealTagged(cur && cur.status === "in_review" ? "appeal_in_review" : "appeal_state");
      }
      store.addReviewAppealEvent({ appealId: ap.id, actorId: user.id, kind: "withdraw", at: nowIso });
      audit("review.appeal.withdraw", item.id, { status: "submitted" }, { status: "withdrawn", appealId: ap.id });
    });
    if (!saved.ok) return appealSaveFailed(res, "review-appeal/withdraw", saved);
    appealCacheClear();
    afterCommit("review-appeal/withdraw", () => {
      const cyc = store.getReviewCycle(ap.cycleId), c = cyc ? cyc.name : "";
      for (const uid of recips) appealNotify(uid, {
        title: `${user.name} has withdrawn the appeal against the ${c} final rating`, title_zh: `${user.name} 已撤回「${c}」评级申诉`,
        body: "No action is needed.", body_zh: "无需处理。", link: appealAdminLink(ap),
      });
    });
    return send(res, 200, { ok: true, appeal: employeeAppealOut(store.getReviewAppeal(ap.id)) });
  }
  // 征询人：只列申诉处理中、或 90 天内作出结论的征询；open 在前，再按征询时间倒序
  if (pathname === "/api/me/reviews/appeal-consults" && req.method === "GET") {
    const since = new Date(nowMs() - APPEAL_CONSULT_RECENT_DAYS * 86400e3).toISOString();
    const rows = store.listReviewAppealConsultsFor(user.id).filter((c) => c.appealStatus === "in_review" || (c.appealDecidedAt && c.appealDecidedAt >= since));
    const items = rows.map((c) => {
      const u = store.getUserById(c.appealUserId), cyc = store.getReviewCycle(c.appealCycleId);
      const state = c.appealStatus !== "in_review" ? "closed" : c.answeredAt ? "answered" : "open";
      return { id: c.id, name: u ? u.name : "?", position: u ? u.position || null : null, cycle: cyc ? cyc.name : null, kind: cyc ? cyc.kind || "quarter" : "quarter",
        relation: c.relation, askedAt: c.askedAt, answeredAt: c.answeredAt || null, state };
    }).sort((a, b) => (a.state === "open") !== (b.state === "open") ? (a.state === "open" ? -1 : 1) : String(b.askedAt).localeCompare(String(a.askedAt)));
    return send(res, 200, { items });
  }
  const meConsultMatch = pathname.match(/^\/api\/me\/reviews\/appeal-consults\/([\w-]+)$/);
  if (meConsultMatch && req.method === "GET") {
    const c = store.getReviewAppealConsult(meConsultMatch[1]);
    const ap = c && c.consulteeId === user.id ? store.getReviewAppeal(c.appealId) : null;
    if (!ap) return appealErr(res, "not_found");
    const item = store.getReviewItem(ap.itemId) || {};
    const cycle = store.getReviewCycle(ap.cycleId) || {};
    const u = store.getUserById(ap.userId);
    const state = ap.status !== "in_review" ? "closed" : c.answeredAt ? "answered" : "open";
    const out = {
      consult: { id: c.id, relation: c.relation, askedAt: c.askedAt, question: c.question || null, opinion: c.opinion || null, answeredAt: c.answeredAt || null, state },
      employee: { name: u ? u.name : "?", department: u ? u.department || null : null, position: u ? u.position || null : null, jobLevel: u ? u.jobLevel || null : null },   /* 第三批 9.1：员工端不下发工号 */ 
      cycle: { name: cycle.name || null, kind: cycle.kind || "quarter", flow: cycle.flow || null },
    };
    if (state === "closed") return send(res, 200, { ...out, closedNote: true });
    const annual = cycle.kind === "annual";
    // 可行性审查 7（方案 a）：不给上级原评级（与 2.6「员工端只给最终评级」同一口径）；附件、别人的意见、内部说明、面谈要点一概不给
    return send(res, 200, {
      ...out,
      appeal: { submittedAt: ap.submittedAt, reason: ap.reason },
      record: {
        selfReview: annual ? null : reviewSelfOf(item),
        managerText: annual ? null : item.managerText || "",
        highlights: annual ? null : item.highlights || "",
        finalRating: appealRecRating(item.recordId ? store.getTalentRecord(item.recordId) : null),
        ...(c.relation === "hod" ? { hodText: item.hodText || "" } : {}),
      },
    });
  }
  const meOpinionMatch = pathname.match(/^\/api\/me\/reviews\/appeal-consults\/([\w-]+)\/opinion$/);
  if (meOpinionMatch && req.method === "POST") {
    const c = store.getReviewAppealConsult(meOpinionMatch[1]);
    const ap = c && c.consulteeId === user.id ? store.getReviewAppeal(c.appealId) : null;
    if (!ap) return appealErr(res, "not_found");
    const opinion = typeof body.opinion === "string" ? body.opinion.trim() : "";
    if (opinion.length < APPEAL_OPINION_MIN || opinion.length > APPEAL_OPINION_MAX) return appealErr(res, "opinion_length");
    const nowIso = new Date(nowMs()).toISOString();
    const saved = runBatch(() => {
      const ap2 = store.getReviewAppeal(ap.id);
      if (!ap2 || ap2.status !== "in_review") throw appealTagged("consult_closed");
      if (!store.answerReviewAppealConsult(c.id, opinion, nowIso)) throw appealTagged("consult_answered");
      store.addReviewAppealEvent({ appealId: ap.id, actorId: user.id, kind: "opinion", at: nowIso, data: { consultId: c.id } });
      audit("review.appeal.opinion", ap.itemId, null, { appealId: ap.id, consultId: c.id });
      return ap2;
    });
    if (!saved.ok) return appealSaveFailed(res, "review-appeal/opinion", saved);
    afterCommit("review-appeal/opinion", () => {
      const u = store.getUserById(ap.userId);
      const handler = saved.value.handlerId;
      if (handler) appealNotify(handler, {
        title: `${user.name} has submitted an opinion on ${u ? u.name : "?"}'s appeal`, title_zh: `${user.name} 已就 ${u ? u.name : "?"} 的申诉提交意见`,
        body: "See it on the appeal page.", body_zh: "请在申诉详情中查看。", link: appealAdminLink(ap),
      });
    });
    const c2 = store.getReviewAppealConsult(c.id);
    return send(res, 200, { ok: true, consult: { id: c2.id, relation: c2.relation, askedAt: c2.askedAt, question: c2.question || null, opinion: c2.opinion, answeredAt: c2.answeredAt, state: "answered" } });
  }
  // ---- HoD 部门校准（绩效流程 v2）----
  // 返回第二批的部门校准视图：{ v: 2, groups: [{ cycleId, unit, dept1, cycle: { id, name, kind }, locked, view }] }，
  // view = reviewCalibView(mode:"hod")。原来不带 ?v=2 时的 groups[].items 旧形状已在波次 3 删掉（W3-S，2026-10-08：前端只请求
  // ?v=2，grep 核对过）；现在带不带 v=2 都返回这一形状，前端照旧带着。
  if (pathname === "/api/me/reviews/hod" && req.method === "GET") {
    return send(res, 200, {
      v: 2,
      groups: hodGroupsFor(user).map(({ cycle, g, snap }) => ({
        cycleId: cycle.id, unit: g.dept1Id, dept1: g.dept1, cycle: { id: cycle.id, name: cycle.name, kind: cycle.kind || "quarter" },
        locked: reviewDeptLocked(g.status), view: reviewCalibView(cycle, g, snap, { mode: "hod", viewer: user }),
      })),
    });
  }
  // HoD 一次保存多行（第二批 2.2，F19 ①）：全部成功或全部不写。
  //   body { cycleId, dept1Id, changes: [{ id, rating | null, reason, expect?: { managerRating, finalRating } }] }
  //   组按 hodGroupsFor 定位（不是本人担任 HoD 的组 → 404）；部门已提交 → 整批 400 dept_locked；
  //   逐行校验（reviewHodChange），任一行不通过 → 400 { code: "bulk_invalid", errors: [{ id, code }] }，一行都不写。
  //   写入与审计在同一笔事务（runBatch）；代评成功后通知在职的上级。返回 { ok, saved, view }（view = 保存后的部门校准视图）。
  if (pathname === "/api/me/reviews/hod/items" && req.method === "PUT") {
    const hit = hodGroupsFor(user).find(({ cycle, g }) => cycle.id === body.cycleId && g.dept1Id === body.dept1Id);
    if (!hit) return send(res, 404, { error: "Department not found. 未找到该部门。", code: "not_found" });
    const { cycle, g, snap } = hit;
    if (reviewDeptLocked(g.status)) return send(res, 400, { error: "This department has been submitted. 该部门已提交，不能再修改。", code: "dept_locked" });
    const changes = Array.isArray(body.changes) ? body.changes : [];
    if (!changes.length) return send(res, 400, { error: "Nothing to save. 没有要保存的修改。", code: "no_items" });
    if (changes.length > bulkCap()) return send(res, 400, { error: `Too many rows in one save (cap ${bulkCap()}). 单次保存的行数超过上限（${bulkCap()}）。`, code: "over_cap", selected: changes.length, cap: bulkCap() });
    const ctx = reviewHodCtx(cycle, g, user);
    const errors = [], valid = [], seen = new Set();
    for (const ch of changes) {
      const id = ch && (typeof ch.id === "string" || typeof ch.id === "number") ? String(ch.id) : "";
      if (seen.has(id)) { errors.push({ id, code: "duplicate" }); continue; }
      seen.add(id);
      const v = reviewHodChange(ctx, g.items.find((x) => x.id === id) || null, ch);
      if (v.code) errors.push({ id, code: v.code }); else valid.push(v);
    }
    if (errors.length)
      return send(res, 400, { error: `${errors.length} row(s) can't be saved, so nothing was changed. 有 ${errors.length} 行不能保存，本次未做任何修改。`, code: "bulk_invalid", errors });
    const saved = runBatch((cur) => { for (const v of valid) { cur.line++; reviewHodWrite(ctx, v, audit); } return valid.length; });
    if (!saved.ok) return sendBatchFailed(res, "review-hod-items", saved);
    afterCommit("review-hod-items notify", () => reviewNotifyProxied(cycle, valid));
    const fresh = reviewGroups(cycle, store.listCycleItems(cycle.id), snap).find((x) => x.dept1Id === g.dept1Id);
    return send(res, 200, { ok: true, saved: valid.length, view: fresh ? reviewCalibView(cycle, fresh, snap, { mode: "hod", viewer: user }) : null });
  }
  // HoD 单行校准（与批量保存共用 reviewHodChange / reviewHodWrite）。前端部门校准已改用一次保存多行（PUT /hod/items），
  // 单行接口保留给接口调用与测试（W3-S 核对：web/src 里已没有调用）。
  const hodItemMatch = pathname.match(/^\/api\/me\/reviews\/hod\/items\/([\w-]+)$/);
  if (hodItemMatch && req.method === "PUT") {
    const item = store.getReviewItem(hodItemMatch[1]);
    const cycle = item ? store.getReviewCycle(item.cycleId) : null;
    const nf = () => send(res, 404, { error: "Review record not found. 未找到该评估记录。", code: "not_found" });
    if (!item || !cycle || cycle.flow !== "v2") return nf();
    const snap = orgSnapshot();
    const g = reviewGroups(cycle, store.listCycleItems(cycle.id), snap).find((x) => x.items.some((i) => i.id === item.id));
    if (!g || !g.hod || g.hod.id !== user.id || item.userId === user.id) return nf();
    if (cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
    if (reviewDeptLocked(g.status))
      return send(res, 400, { error: "This department has been submitted. 该部门已提交，不能再修改。", code: "dept_locked" });
    const ctx = reviewHodCtx(cycle, g, user);
    const v = reviewHodChange(ctx, g.items.find((x) => x.id === item.id), body);
    if (v.code) return sendReviewHodErr(res, v);
    const saved = runBatch(() => reviewHodWrite(ctx, v, audit));
    if (!saved.ok) return sendBatchFailed(res, "review-hod-item", saved);
    afterCommit("review-hod-item notify", () => reviewNotifyProxied(cycle, [v]));
    return send(res, 200, { ok: true, item: saved.value });
  }
  // HoD「提醒他们的上级」（第二批 2.2，F19 ②）：body { cycleId, dept1Id, itemIds }，每个条目都须属于本组（否则整批 404）。
  // 与 HR 批量提醒的上级评级阶段同一套计划与副作用（同一上级合并一条通知、1 小时节流键 manager|周期|上级）；审计 review.remind
  // 的 after 另带 by:"hod"。跳过码：participant_departed（员工已离职）、no_manager（没有在职上级，可由 HoD 代评）、
  // self_pending（员工未交自评且未逾期）、cooldown、dept_locked、hod_is_manager（HoD 本人就是直属上级）；已评级或已代评 = 未改动。
  if (pathname === "/api/me/reviews/hod/remind" && req.method === "POST") {
    const hit = hodGroupsFor(user).find(({ cycle, g }) => cycle.id === body.cycleId && g.dept1Id === body.dept1Id);
    if (!hit) return send(res, 404, { error: "Department not found.", error_zh: "未找到该部门。", code: "not_found" });
    const { cycle, g } = hit;
    const ids = bulkIdList(res, body.itemIds); if (!ids) return;
    const member = new Set(g.items.filter((i) => !g.hod || i.userId !== g.hod.id).map((i) => i.id));
    const outside = ids.filter((id) => !member.has(id)).length;
    if (outside) return send(res, 404, { error: `${outside} of the selected people are not in this department — nothing was sent.`, error_zh: `所选人员中有 ${outside} 人不在本部门，未发送任何提醒。`, code: "not_found", outside });
    // HoD 本人就是直属上级的人：不提醒（只会发给自己、还占掉 1 小时节流），记 hod_is_manager
    const own = new Set(g.items.filter((i) => i.managerId === user.id).map((i) => i.id));
    const plan = planReviewReminders({ stage: "manager", by: "item", ids: ids.filter((id) => !own.has(id)), fixedCycle: cycle, scope: null });
    for (const e of plan.effects) e.after = { ...e.after, by: "hod" };
    emitBulkEffects("review-hod-remind", plan.effects, (e) => emitReviewReminder(audit, e));
    const planned = new Map(plan.results.map((r) => [r.id, r]));
    const results = ids.map((id) => (own.has(id) ? bulkSkip(id, "hod_is_manager") : planned.get(id) || bulkSkip(id, "not_found")));
    return sendBulkResult(res, results, { stage: "manager", reminded: plan.effects.length, skippedPeople: plan.skippedPeople + ids.filter((id) => own.has(id)).length });
  }
  if (pathname === "/api/me/reviews/hod/submit" && req.method === "POST") {
    const hit = hodGroupsFor(user).find(({ cycle, g }) => cycle.id === body.cycleId && g.dept1Id === body.dept1Id);
    if (!hit) return send(res, 404, { error: "Department not found. 未找到该部门。", code: "not_found" });
    const { cycle, g } = hit;
    if (reviewDeptLocked(g.status)) return send(res, 400, { error: "Already submitted. 已提交。", code: "dept_locked" });
    // 第二批口径（2026-10-08）：不再以面谈为前提；离职者不计入；季度另有 self_missing（自评截止前未交自评的人）
    const issues = reviewSubmitIssues(cycle, g);
    if (issues.length) return send(res, 400, { error: "This department cannot be submitted yet. 该部门还不能提交。", code: "submit_blocked", issues });
    store.upsertReviewDeptStatus(cycle.id, g.dept1Id, { dept1Name: g.dept1, hodId: user.id, hodSubmittedAt: new Date(nowMs()).toISOString(), returnedAt: null, returnReason: null });
    reviewSnapPut(cycle.id, g, "submit");   // P0 E3：提交时的配额成员快照（HR 确认时核对）；第二批起另记离职者 departedIds
    audit("review.hod.submit", cycle.id, null, { dept1: g.dept1, headcount: g.headcount, counts: g.counts });
    // 第二批 2.5：通知直达该部门明细（后台评估周期 › 部门确认 › 本部门）
    notifyAdmins({
      type: "review", link: `/admin/reviews?cycle=${encodeURIComponent(cycle.id)}&view=depts&unit=${encodeURIComponent(g.dept1Id)}`,
      title: `${user.name} submitted ${g.dept1 || "a department"} for ${cycle.name}`,
      title_zh: `${user.name} 已提交 ${g.dept1 || "本部门"} 在「${cycle.name}」的校准结果`,
      body: "Open the department detail to confirm or return it.", body_zh: "点击打开该部门明细，确认或退回。",
    }, "performance");
    return send(res, 200, { ok: true });
  }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 12504–13259 行（/api/admin/ 块内）
    async adminPerformance1(C) {
      const { pathname, req, res, user, body, audit, query } = C;
      const { store, send, scopeAllowsDeptFor, sendScopeDeptReject, sendDeptCycle, deptAuditShape, sendDeptOccupied, reviewAppealCtx, appealToday, appealVisibleRows, appealClosedStatus, hrbpEligible, appealCounts, orgLib, APPEAL_CATEGORIES, scopePredicate, reviewAppealAccess, reviewRecipientOk, exitDateOf, workdaysBetween, manilaDay, appealOpen, isSuperAdmin, appealErr, hrbpCoveragePayload, APPEAL_HRBPS_MAX, appealStale, nowMs, runBatch, appealTagged, appealSaveFailed, appealCacheClear, afterCommit, appealNotify, appealAdminLink, appealJoin, reviewAppealDetail, appealLogView, APPEAL_CATEGORY_KEYS, appealEmpLink, APPEAL_CONSULTS_MAX, APPEAL_QUESTION_MAX, APPEAL_REPLY_MIN, APPEAL_REPLY_MAX, APPEAL_NOTE_MAX, APPEAL_ADJUST_NOTE_MIN, APPEAL_ADJUST_NOTE_MAX, appealRecRating, perfApplyRatingAmend, TEST_FAIL_APPEAL_DECIDE, orgSnapshot, optionZh, isInReportingLine, APPEAL_REASSIGN_NOTE_MAX, orgRoundView, OP, clampText, newToken, orgDept1List, notify, sendCsv, orgRatingOptions, todayLocal, reviewGroups, reviewRecordRatingOf, reviewHodIdSet, sendScopeBulkReject, reviewDeptOptions, scopeDeptPredicate, REVIEW_DEFAULT_QUOTA } = S;
    const deptMatch = pathname.match(/^\/api\/admin\/departments\/([\w-]+)$/);
    if (deptMatch && req.method === "PUT") {
      const before = store.listDepartments(true).find((x) => x.id === deptMatch[1]);
      if (!before) return send(res, 404, { error: "Department not found" });
      // P2 范围：目标部门必须在范围内。这里回 **404**（与上一行「部门不存在」同形）
      // 而不是 sendScopeDeptReject 的 400：这条路径的键是部门 **id**，回 400 就等于
      // 承认「这个 id 确实是个部门」，把 :id 变成部门枚举器；GET /departments 现在也
      // 过滤，部门 id 不再是可枚举信息，两处口径必须一致。
      if (!scopeAllowsDeptFor(user, before.name)) return send(res, 404, { error: "Department not found" });
      const fields = {};
      if (body.name !== undefined) {
        const nm = String(body.name).trim().slice(0, 80);
        if (!nm) return send(res, 400, { error: "Department name can't be empty" });
        const dup = store.getDepartmentByName(nm);
        if (dup && dup.id !== deptMatch[1]) return send(res, 400, { error: "That name is already used by another department.", error_zh: "该名称已被其他部门使用。", code: "dept_exists" });   // CX-131
        fields.name = nm;
      }
      if (body.parentId !== undefined) {
        const pid = body.parentId || null;
        if (pid) {
          // Reject unknown parents and reparenting under one's own subtree.
          const all = store.listDepartments(true);
          const byId = new Map(all.map((x) => [x.id, x]));
          if (!byId.has(pid)) return send(res, 400, { error: "Parent department not found 上级部门不存在" });
          // P2 范围：**新父级**也必须在范围内，否则可以把自己的子树整棵挂到范围外去
          // （挂出去之后 includeChildren 解析不到它，自己第一个看不见 —— 与
          // bulk-update 的「把人推出范围」是同一类不可逆动作）。
          if (!scopeAllowsDeptFor(user, byId.get(pid).name)) return sendScopeDeptReject(res);
          if (store.departmentWouldCycle(deptMatch[1], pid)) return sendDeptCycle(res);
        }
        fields.parentId = pid;
      }
      if (body.active !== undefined) fields.active = !!body.active;
      // "" clears the head; an unknown id is rejected rather than stored dangling.
      if (body.ownerId !== undefined) {
        const oid = String(body.ownerId || "").trim();
        if (oid && !store.getUserById(oid)) return send(res, 400, { error: "Employee not found 负责人不存在" });
        fields.ownerId = oid || null;
      }
      if (body.sort !== undefined && Number.isFinite(Number(body.sort))) fields.sort = Number(body.sort);
      const d = store.updateDepartment(deptMatch[1], fields);
      // before / after 同一形状（含负责人 id 与姓名）：设负责人、换人、清空都在审计里看得出
      // 「从谁变成谁」—— 一级部门的负责人就是 HoD，决定谁能看到下属的「周五真事」等档案内容，
      // 这类覆盖必须可追溯。以前 after 只有 name / active，设负责人在审计页上一行变更都不出。
      audit("department.update", d.name, deptAuditShape(before), deptAuditShape(d));
      return send(res, 200, { ok: true, department: d });
    }
    if (deptMatch && req.method === "DELETE") {
      const d = store.listDepartments(true).find((x) => x.id === deptMatch[1]);
      if (!d) return send(res, 404, { error: "Department not found" });
      if (!scopeAllowsDeptFor(user, d.name)) return send(res, 404, { error: "Department not found" }); // P2：同 PUT，按 id 的路径回 404
      const n = store.countUsersInDepartment(d.name);
      if (n > 0) return sendDeptOccupied(res, n);
      store.deleteDepartment(d.id);
      audit("department.delete", d.name, d, null);
      return send(res, 200, { ok: true });
    }
    // --- 第二批 2.8：绩效申诉台（§4.3 A1–A8）与 HRBP 分工（§4.4 S1–S2）。闸门 W2.8 在上面（rbac:"custom"）---
    // 单条的拒绝一律 404 appeal_not_found（不存在、看不到、利益相关同形）；能看不能做 → 403 appeal_no_permission；状态不对 → 409 appeal_state。
    if (pathname === "/api/admin/review-appeals" && req.method === "GET") {
      const ctx = reviewAppealCtx();
      const today = appealToday();
      const rows = appealVisibleRows(user, ctx, today);
      const fCycle = String(query.get("cycle") || ""), fStatus = String(query.get("status") || ""), fMine = query.get("mine") === "1";
      const items = rows.filter((r) => (!fCycle || r.cycleId === fCycle)
        && (!fStatus || fStatus === "all" || (fStatus === "overdue" ? r.overdue : fStatus === "closed" ? appealClosedStatus(r.status) : r.status === fStatus))
        && (!fMine || (r.handler && r.handler.id === user.id))).slice(0, 2000);
      const cycles = [];
      const seenC = new Set();
      for (const r of rows) if (!seenC.has(r.cycleId)) { seenC.add(r.cycleId); cycles.push({ id: r.cycleId, name: r.cycle }); }
      const hrbp = hrbpEligible(user) && store.listHrbpDeptIdsOfUser(user.id).length > 0;
      return send(res, 200, {
        today, items, counts: appealCounts(rows), cycles,
        deptOptions: orgLib.deptOptionsOf(ctx.snap.index, rows.map((r) => r.department), null, {}).options,
        me: { hrbp, coverDepts: hrbp ? store.listHrbpDeptIdsOfUser(user.id).filter((d) => ctx.cov.byId.has(d)).map((d) => ({ id: d, name: ctx.cov.byId.get(d).name })) : [] },
        caps: { stats: ctx.perm(user).read || rows.some((r) => r.view === "full") },
        categories: APPEAL_CATEGORIES,
      });
    }
    if (pathname === "/api/admin/review-appeals/summary" && req.method === "GET") {
      const c = appealCounts(appealVisibleRows(user, reviewAppealCtx(), appealToday()));
      return send(res, 200, { actionable: c.actionable, overdue: c.overdue });
    }
    if (pathname === "/api/admin/review-appeals/stats" && req.method === "GET") {
      // 绩效可读：范围内申诉人的申诉（scope all / scoped）；只有分工：自己有完整视图的申诉（scope hrbp，不给归档人数）。
      // 利益相关的申诉一律不计（安全审查 5）。申诉率分母 = 可申诉人数（告知时已离职的不算，制度审查 14）。
      const ctx = reviewAppealCtx();
      const p = ctx.perm(user);
      const H = ctx.holidays;
      const today = appealToday();
      const pred = p.read ? scopePredicate(user) : null;
      const scope = !p.read ? "hrbp" : pred ? "scoped" : "all";
      const mine = store.listReviewAppeals().filter((ap) => {
        if (ap.userId === user.id || ctx.conflicts(ap).has(user.id)) return false;
        if (p.read) return !pred || pred(ctx.user(ap.userId));
        return reviewAppealAccess(user, ap, ctx).view === "full";
      });
      const rnd = (x) => Math.round(x * 10) / 10;
      const cycles = store.listReviewCycles().filter((c) => c.status === "closed" && c.resultsAt && c.appealDeadline)
        .sort((a, b) => String(b.resultsAt).localeCompare(String(a.resultsAt))).map((c) => {
          const aps = mine.filter((ap) => ap.cycleId === c.id);
          let archived = null, eligible = null;
          if (scope !== "hrbp") {
            archived = 0; eligible = 0;
            for (const i of store.listCycleItems(c.id)) {
              if (!i.recordId) continue;
              const u = ctx.user(i.userId);
              if (pred && !pred(u)) continue;
              archived++;
              const ex = u && !reviewRecipientOk(u) ? exitDateOf(u) : null;
              if (u && (reviewRecipientOk(u) || (ex && String(ex).slice(0, 10) > c.appealDeadline))) eligible++;
            }
          }
          const decided = aps.filter((ap) => ap.status === "maintained" || ap.status === "adjusted");
          const adjusted = aps.filter((ap) => ap.status === "adjusted").length;
          const wd = decided.map((ap) => workdaysBetween(manilaDay(Date.parse(ap.submittedAt)), manilaDay(Date.parse(ap.decidedAt)), H));
          const cd = decided.map((ap) => (Date.parse(ap.decidedAt) - Date.parse(ap.submittedAt)) / 86400e3);
          return {
            cycleId: c.id, name: c.name, kind: c.kind || "quarter", flow: c.flow || null, closedAt: c.closedAt || null, resultsAt: c.resultsAt,
            communicatedOn: manilaDay(Date.parse(c.resultsAt)), deadline: c.appealDeadline, windowOpen: today <= c.appealDeadline,
            // CX-170：申诉率不含已撤回的申诉，与绩效看板同一口径
            // CX-223：appeals 保留含撤回的总数（绩效看板按 appeals − withdrawn 计，已有用例锁定）；另给 appealsExclWithdrawn = 不含撤回，申诉统计页用它
            archived, eligible, appeals: aps.length, appealsExclWithdrawn: aps.filter((ap) => ap.status !== "withdrawn").length, appealRate: eligible ? rnd((aps.filter((ap) => ap.status !== "withdrawn").length / eligible) * 1000) / 1000 : null,
            withdrawn: aps.filter((ap) => ap.status === "withdrawn").length,
            open: aps.filter(appealOpen).length,
            overdue: aps.filter((ap) => appealOpen(ap) && today > ap.slaDueOn).length,
            maintained: decided.length - adjusted, adjusted,
            adjustRate: decided.length ? rnd((adjusted / decided.length) * 1000) / 1000 : null,
            avgHandleWorkdays: wd.length ? rnd(wd.reduce((a, b) => a + b, 0) / wd.length) : null,
            avgHandleDays: cd.length ? rnd(cd.reduce((a, b) => a + b, 0) / cd.length) : null,
            withinSla: decided.filter((ap) => manilaDay(Date.parse(ap.decidedAt)) <= ap.slaDueOn).length,
          };
        });
      return send(res, 200, { scope, cycles });
    }
    if (pathname === "/api/admin/review-appeals/coverage" && req.method === "GET") {
      if (!isSuperAdmin(user)) return appealErr(res, "super_admin_only");
      return send(res, 200, hrbpCoveragePayload());
    }
    if (pathname === "/api/admin/review-appeals/coverage" && req.method === "PUT") {
      // 只有超级管理员（D5）。body (a) { deptId, userIds } 或 (b) { userId, deptIds }；dryRun:true 只算「会有几条处理中的申诉需要转交」
      // （制度审查 8：设置弹窗保存前提示），不写库。
      if (!isSuperAdmin(user)) return appealErr(res, "super_admin_only");
      const strArr = (a) => Array.isArray(a) && a.length <= 500 && a.every((x) => typeof x === "string" && x);
      const shapeA = typeof body.deptId === "string" && !!body.deptId && strArr(body.userIds) && body.userId === undefined && body.deptIds === undefined;
      const shapeB = typeof body.userId === "string" && !!body.userId && strArr(body.deptIds) && body.deptId === undefined && body.userIds === undefined;
      if (shapeA === shapeB) return appealErr(res, "bad_body");
      const ctx0 = reviewAppealCtx();
      const cov0 = ctx0.cov;
      const plan = new Map();
      if (shapeA) {
        const want = [...new Set(body.userIds)];
        // 指向已不存在部门的旧行（§2.7）只能清空
        if (!cov0.byId.has(body.deptId) && !(want.length === 0 && (cov0.raw.get(body.deptId) || []).length)) return appealErr(res, "dept_not_found");
        plan.set(body.deptId, want);
      } else {
        const want = new Set(body.deptIds);
        const cur = new Set(store.listHrbpDeptIdsOfUser(body.userId));
        for (const d of new Set([...want, ...cur])) {
          if (want.has(d) === cur.has(d)) continue;
          if (want.has(d) && !cov0.byId.has(d)) return appealErr(res, "dept_not_found");
          const ids = cov0.raw.get(d) || [];
          plan.set(d, want.has(d) ? [...ids, body.userId] : ids.filter((x) => x !== body.userId));
        }
      }
      const notEligible = new Set();
      for (const [d, ids] of plan) {
        const cur = new Set(cov0.raw.get(d) || []);
        const added = ids.filter((x) => !cur.has(x));
        const dept = cov0.byId.get(d);
        if (added.length && dept && !dept.active) return appealErr(res, "dept_inactive");
        for (const x of added) if (!hrbpEligible(ctx0.user(x))) notEligible.add(x);
      }
      if (notEligible.size) return appealErr(res, "hrbp_not_eligible", { ids: [...notEligible] });
      if ([...plan.values()].some((ids) => ids.length > APPEAL_HRBPS_MAX)) return appealErr(res, "too_many_hrbps");
      const openBefore = store.listOpenReviewAppeals();
      const staleBefore = new Set(openBefore.filter((ap) => appealStale(ap, ctx0.handlers(ap))).map((ap) => ap.id));
      const nowIso = new Date(nowMs()).toISOString();
      const names = (ids) => ids.map((id) => (ctx0.user(id) || {}).name || null);
      const dry = body.dryRun === true;
      const saved = runBatch(() => {
        const changed = [];
        for (const [d, ids] of plan) {
          const r = store.replaceDeptHrbps(d, ids, user.id, nowIso);
          if (r.before.join("|") === r.after.join("|")) continue;
          changed.push(d);
          if (!dry) audit("department.hrbp", d, { hrbpIds: r.before, hrbpNames: names(r.before) }, { hrbpIds: r.after, hrbpNames: names(r.after) });
        }
        if (dry) {
          const ctxD = reviewAppealCtx();
          const n = store.listOpenReviewAppeals().filter((ap) => !staleBefore.has(ap.id) && appealStale(ap, ctxD.handlers(ap))).length;
          throw appealTagged("__dry_run", { wouldStale: n });
        }
        return changed;
      });
      if (!saved.ok && saved.error && saved.error.appealCode === "__dry_run") return send(res, 200, { ok: true, dryRun: true, wouldStale: saved.error.extra.wouldStale });
      if (!saved.ok) return appealSaveFailed(res, "review-appeal/coverage", saved);
      appealCacheClear();
      afterCommit("review-appeal/coverage", () => {
        const ctx1 = reviewAppealCtx();
        const open = store.listOpenReviewAppeals();
        const newlyStale = open.filter((ap) => !staleBefore.has(ap.id) && appealStale(ap, ctx1.handlers(ap)));
        const strandedBy = new Map();
        for (const ap of newlyStale) {
          strandedBy.set(ap.handlerId, (strandedBy.get(ap.handlerId) || 0) + 1);
          const u = ctx1.user(ap.userId), cyc = ctx1.cycle(ap.cycleId);
          for (const uid of ctx1.handlers(ap).ids) appealNotify(uid, {
            title: `The appeal from ${u ? u.name : "?"} against the ${cyc ? cyc.name : ""} final rating needs a new handler`,
            title_zh: `${u ? u.name : "?"} 的「${cyc ? cyc.name : ""}」评级申诉需要接手处理`,
            body: `Response due: ${ap.slaDueOn}.`, body_zh: `答复时限：${ap.slaDueOn}。`, link: appealAdminLink(ap),
          });
        }
        const added = new Map(), removed = new Map();
        for (const d of saved.value) {
          const b = new Set(cov0.effective.get(d) || []), a = new Set(ctx1.cov.effective.get(d) || []);
          const dn = (ctx1.cov.byId.get(d) || cov0.byId.get(d) || { name: d }).name;
          for (const x of a) if (!b.has(x)) { if (!added.has(x)) added.set(x, []); added.get(x).push(dn); }
          for (const x of b) if (!a.has(x)) { if (!removed.has(x)) removed.set(x, []); removed.get(x).push(dn); }
        }
        for (const [uid, depts] of added) {
          const n = open.filter((ap) => ctx1.handlers(ap).ids.includes(uid)).length;
          appealNotify(uid, {
            title: `You have been assigned as HRBP for ${appealJoin(depts, false)}`, title_zh: `你已被指定为 ${appealJoin(depts, true)} 的 HRBP`,
            body: `You will handle performance appeals from employees in this department and its sub-departments. ${n} appeal(s) currently need attention.`,
            body_zh: `你将处理该部门（含下级部门）员工的绩效申诉。当前有 ${n} 条申诉待处理。`, link: "/admin/review-appeals",
          });
        }
        for (const [uid, depts] of removed) {
          const n = strandedBy.get(uid) || 0;
          appealNotify(uid, {
            title: `You are no longer the HRBP for ${appealJoin(depts, false)}`, title_zh: `你已不再担任 ${appealJoin(depts, true)} 的 HRBP`,
            body: "Performance appeals from this department will no longer be routed to you." + (n ? ` ${n} appeal(s) you were handling will be taken over by the new HRBP.` : ""),
            body_zh: "该部门员工的绩效申诉将不再发送给你。" + (n ? `你正在处理的 ${n} 条申诉需由新的 HRBP 接手。` : ""), link: "/admin/review-appeals",
          });
        }
      });
      return send(res, 200, { ok: true, coverage: hrbpCoveragePayload() });
    }
    const raOne = pathname.match(/^\/api\/admin\/review-appeals\/([\w-]+)$/);
    if (raOne && req.method === "GET") {
      const ap = store.getReviewAppeal(raOne[1]);
      const detail = ap ? reviewAppealDetail(ap, user, reviewAppealCtx()) : null;
      if (!detail) return appealErr(res, "appeal_not_found");
      if (detail.view === "full") appealLogView(user, ap, audit);
      return send(res, 200, detail);
    }
    const raAct = pathname.match(/^\/api\/admin\/review-appeals\/([\w-]+)\/([\w-]+)$/);
    if (raAct && req.method === "POST") {
      const [, raId, raVerb] = raAct;
      if (!["start", "consult", "decide", "reassign", "category"].includes(raVerb)) return appealErr(res, "appeal_not_found");
      const ap = store.getReviewAppeal(raId);
      const ctx = reviewAppealCtx();
      const acc = ap ? reviewAppealAccess(user, ap, ctx) : null;
      if (!ap || !acc.view) return appealErr(res, "appeal_not_found");
      const nowIso = new Date(nowMs()).toISOString();
      const appellant = ctx.user(ap.userId), cyc = ctx.cycle(ap.cycleId);
      const aName = appellant ? appellant.name : "?", cName = cyc ? cyc.name : "";
      const reply = () => { const d = reviewAppealDetail(store.getReviewAppeal(ap.id), user, reviewAppealCtx()); return send(res, 200, { ok: true, ...(d || { appeal: null }) }); };
      // 事务里再读一次申诉、再判一次利益回避（安全审查 3 / 10：两个进程、或期间改了上级与部门负责人）
      const recheck = (from, handlerId) => {
        const ap2 = store.getReviewAppeal(ap.id);
        if (!ap2 || ap2.status !== from || (handlerId !== undefined && ap2.handlerId !== handlerId)) throw appealTagged("appeal_state");
        if (reviewAppealCtx().conflicts(ap2).has(user.id)) throw appealTagged("appeal_not_found");
        return ap2;
      };
      // 绩效看板第二期：HRBP（有处理权的人）改正原因分类；已撤回的不改。只改分类，不动状态与处理人
      if (raVerb === "category") {
        if (!acc.act) return appealErr(res, "appeal_no_permission");
        if (ap.status !== "submitted" && ap.status !== "in_review") return appealErr(res, "appeal_state");
        if (ap.status === "in_review" && ap.handlerId !== user.id) return appealErr(res, "appeal_no_permission");
        const cat = typeof body.category === "string" ? body.category : "";
        if (!APPEAL_CATEGORY_KEYS.has(cat)) return appealErr(res, "appeal_category");
        if ((ap.reasonCategory || null) !== cat) {
          store.setReviewAppealCategory(ap.id, cat);
          audit("review.appeal.category", ap.itemId, { category: ap.reasonCategory || null }, { category: cat, appealId: ap.id });
          appealCacheClear();
        }
        return reply();
      }
      if (raVerb === "start") {
        if (!acc.act) return appealErr(res, "appeal_no_permission");
        if (ap.status !== "submitted") return appealErr(res, "appeal_state");
        const saved = runBatch(() => {
          recheck("submitted");
          if (!store.transitionReviewAppeal(ap.id, { from: "submitted" }, { status: "in_review", handlerId: user.id, startedAt: nowIso })) throw appealTagged("appeal_state");
          store.addReviewAppealEvent({ appealId: ap.id, actorId: user.id, kind: "start", at: nowIso });
          audit("review.appeal.start", ap.itemId, { status: "submitted" }, { status: "in_review", appealId: ap.id, handlerId: user.id });
        });
        if (!saved.ok) return appealSaveFailed(res, "review-appeal/start", saved);
        appealCacheClear();
        afterCommit("review-appeal/start", () => appealNotify(ap.userId, {
          // CX-219：不点名 HRBP（CX-227：注释原先写在行中间，把 title_zh 注释掉了）
          title: `HR has started reviewing your appeal against the ${cName} final rating`, title_zh: `你的「${cName}」评级申诉已开始处理`,
          body: "The appeal can no longer be withdrawn. You will be notified of the outcome.", body_zh: "处理期间不能撤回申诉，结论会通过通知告诉你。", link: appealEmpLink(ap),
        }));
        return reply();
      }
      if (raVerb === "consult") {
        if (!acc.act || ap.handlerId !== user.id) return appealErr(res, "appeal_no_permission");
        if (ap.status !== "in_review") return appealErr(res, "appeal_state");
        const consulteeId = typeof body.consulteeId === "string" ? body.consulteeId : "";
        const det = reviewAppealDetail(ap, user, ctx);
        const cand = det && det.consultCandidates ? det.consultCandidates.find((c) => c.id === consulteeId) : null;
        if (!cand) return appealErr(res, "consultee_invalid");
        const existing = store.listReviewAppealConsults(ap.id);
        if (existing.some((c) => c.consulteeId === consulteeId)) return appealErr(res, "consult_exists");
        if (existing.length >= APPEAL_CONSULTS_MAX) return appealErr(res, "consult_limit");
        const question = typeof body.question === "string" ? body.question.trim().slice(0, APPEAL_QUESTION_MAX) || null : null;
        const saved = runBatch(() => {
          recheck("in_review", user.id);
          if (store.listReviewAppealConsults(ap.id).some((c) => c.consulteeId === consulteeId)) throw appealTagged("consult_exists");
          const c = store.createReviewAppealConsult({ appealId: ap.id, consulteeId, relation: cand.relation, askedBy: user.id, askedAt: nowIso, question });
          store.addReviewAppealEvent({ appealId: ap.id, actorId: user.id, kind: "consult", at: nowIso, data: { consultId: c.id, consulteeId, consulteeName: cand.name, relation: cand.relation } });
          // 安全审查 1：审计不带征询对象姓名
          audit("review.appeal.consult", ap.itemId, null, { appealId: ap.id, consulteeId, relation: cand.relation });
          return c;
        });
        if (!saved.ok) return appealSaveFailed(res, "review-appeal/consult", saved);
        afterCommit("review-appeal/consult", () => appealNotify(consulteeId, {
          title: `An HRBP is asking for your opinion on ${aName}'s appeal against the ${cName} final rating`,
          title_zh: `HRBP 就 ${aName} 的「${cName}」评级申诉征询你的意见`,
          body: "Your opinion is for the HRBP only and is not shown to the employee.", body_zh: "你的意见仅供 HRBP 参考，员工看不到。",
          link: "/review?view=consult&item=" + saved.value.id,
        }));
        return reply();
      }
      if (raVerb === "decide") {
        if (!acc.act || ap.handlerId !== user.id) return appealErr(res, "appeal_no_permission");
        if (ap.status !== "in_review") return appealErr(res, "appeal_state");
        const outcome = body.outcome;
        if (outcome !== "maintain" && outcome !== "adjust") return appealErr(res, "bad_body");
        const replyText = typeof body.reply === "string" ? body.reply.trim() : "";
        if (replyText.length < APPEAL_REPLY_MIN || replyText.length > APPEAL_REPLY_MAX) return appealErr(res, "appeal_reply");
        const note = typeof body.internalNote === "string" ? body.internalNote.trim() : "";
        if (outcome === "maintain" ? note.length > APPEAL_NOTE_MAX : note.length < APPEAL_ADJUST_NOTE_MIN || note.length > APPEAL_ADJUST_NOTE_MAX) return appealErr(res, "appeal_note");
        // expectRating 两种结论都必填（安全审查 2、制度审查 2b）：结论针对的必须是 HRBP 看到的那个评级
        if (typeof body.expectRating !== "string" || !body.expectRating) return appealErr(res, "rating_invalid");
        const opts = ctx.ratingField ? ctx.ratingField.options : [];
        const newRating = outcome === "adjust" ? (typeof body.newRating === "string" ? body.newRating : "") : null;
        if (outcome === "adjust" && (!opts.includes(newRating) || newRating === body.expectRating)) return appealErr(res, "rating_invalid");
        const saved = runBatch(() => {
          const ap2 = recheck("in_review", user.id);
          const rec = store.getTalentRecord(ap2.recordId);
          if (!rec || rec.type !== "performance" || rec.userId !== ap2.userId) throw appealTagged("record_missing");
          const cur = appealRecRating(rec);
          if (body.expectRating !== cur) throw appealTagged("rating_changed");
          if (outcome === "adjust" && newRating === cur) throw appealTagged("rating_invalid");
          const item = store.getReviewItem(ap2.itemId);
          const owner = store.getUserById(ap2.userId);
          const employeeId = owner ? owner.employeeId : null;
          let amend = null;
          if (outcome === "adjust") {
            // 安全审查 1：2.6 审计的理由写固定文字，内部说明只留在申诉记录里（档案、审计页看不到）
            amend = perfApplyRatingAmend(audit, rec, newRating, `经申诉复核调整（${ap2.id}）/ Adjusted after appeal review (${ap2.id})`, item, { via: "appeal", appealId: ap2.id });
            if (TEST_FAIL_APPEAL_DECIDE) throw new Error("injected failure after the rating amend (LMS_TEST_FAIL_APPEAL_DECIDE)");
          }
          if (!store.transitionReviewAppeal(ap2.id, { from: "in_review", handlerId: user.id }, {
            status: outcome === "adjust" ? "adjusted" : "maintained", decidedAt: nowIso, decidedBy: user.id,
            ratingBefore: cur, newRating: outcome === "adjust" ? newRating : null, reply: replyText, internalNote: note || null,
          })) throw appealTagged("appeal_state");
          store.addReviewAppealEvent({ appealId: ap2.id, actorId: user.id, kind: outcome, at: nowIso, data: { rating: outcome === "adjust" ? newRating : cur } });
          // 制度审查 9：申诉人已离职，系统不会发结论通知 —— 记一笔，详情页提示 HRBP 另行书面告知
          if (!reviewRecipientOk(owner)) store.addReviewAppealEvent({ appealId: ap2.id, actorId: null, kind: "appellant_exited", at: nowIso });
          if (outcome === "adjust")
            audit("review.appeal.adjust", ap2.itemId, { status: "in_review", rating: cur }, { status: "adjusted", appealId: ap2.id, rating: newRating, cycleId: ap2.cycleId, userId: ap2.userId, employeeId });
          else
            audit("review.appeal.maintain", ap2.itemId, { status: "in_review", rating: cur }, { status: "maintained", appealId: ap2.id, rating: cur, cycleId: ap2.cycleId, userId: ap2.userId, employeeId });
          return { amend, rec, item };
        });
        if (!saved.ok) return appealSaveFailed(res, "review-appeal/decide", saved);
        appealCacheClear();
        afterCommit("review-appeal/decide", () => {
          const { amend, rec, item } = saved.value;
          if (amend) audit("talent.record.update", rec.id, amend.before, { type: amend.updated.type, date: amend.updated.date, title: amend.updated.title, detail: amend.updated.detail });
          appealNotify(ap.userId, {
            title: `Your appeal against the ${cName} final rating has been decided`, title_zh: `你的「${cName}」评级申诉已有结论`,
            body: "See the outcome and HR's reply under My performance.", body_zh: "请在「我的绩效」查看结论与 HR 答复。", link: appealEmpLink(ap),
          });
          if (amend) {
            // N9：HoD 与直属上级（现在的与本周期的），正文带调整后的评级（D10）
            const snap = orgSnapshot();
            const cur = appellant;
            const hodNow = cur && cur.department ? snap.hodOf(cur.department) : null;
            const st = item ? store.getReviewDeptStatus(item.cycleId, ctx.unitOfItem(item)) : null;
            const to = new Set([cur && cur.managerId, item && item.managerId, hodNow && hodNow.id, st && st.hodId].filter(Boolean));
            to.delete(ap.userId); to.delete(user.id);
            const rz = ctx.ratingField ? String(optionZh(ctx.ratingField, newRating)) : newRating;
            for (const uid of to) appealNotify(uid, {
              title: `${aName}'s final rating for ${cName} has been adjusted after an appeal review`,
              title_zh: `${aName} 的「${cName}」最终评级经申诉复核已调整`,
              body: `The final rating is now ${newRating}. Please speak with ${user.name} (HR) for details of the review. The direct manager should hold a performance discussion with the employee about the adjusted rating.`,
              body_zh: `调整后的最终评级为 ${rz}。如需了解复核情况，请与 HR ${user.name} 沟通。请直属上级就调整后的评级与员工进行绩效沟通。`,
              link: isInReportingLine(uid, ap.userId) ? "/team/" + ap.userId : null,
            });
          }
          for (const c of store.listReviewAppealConsults(ap.id)) if (!c.answeredAt) appealNotify(c.consulteeId, {
            title: `The appeal from ${aName} has been decided; the consultation is closed`, title_zh: `${aName} 的评级申诉已有结论，征询已关闭`,
            body: "No opinion is needed.", body_zh: "无需再提交意见。", link: "/review?view=consult&item=" + c.id,
          });
        });
        return reply();
      }
      // reassign：处理人转给同组的人；绩效可管理的监督者转给可处理的人；处理人失效时可处理的人接手（toUserId = 自己）
      if (ap.status !== "in_review") return appealErr(res, "appeal_state");
      const h = ctx.handlers(ap);
      const stale = appealStale(ap, h);
      if (!(ap.handlerId === user.id || (acc.role === "oversight" && acc.reassign) || (acc.act && stale))) return appealErr(res, "appeal_no_permission");
      const toUserId = typeof body.toUserId === "string" ? body.toUserId : "";
      const target = ctx.user(toUserId);
      if (!toUserId || toUserId === ap.handlerId || !h.ids.includes(toUserId) || (h.route === "hrbp" ? !hrbpEligible(target) : !reviewRecipientOk(target)))
        return appealErr(res, "assignee_invalid");
      // 转交说明只进内部处理记录（安全审查 7），不进审计与通知
      const rnote = typeof body.note === "string" ? body.note.trim().slice(0, APPEAL_REASSIGN_NOTE_MAX) : "";
      const prev = ap.handlerId ? ctx.user(ap.handlerId) : null;
      const saved = runBatch(() => {
        recheck("in_review", ap.handlerId);
        if (!store.transitionReviewAppeal(ap.id, { from: "in_review", handlerId: ap.handlerId }, { handlerId: toUserId })) throw appealTagged("appeal_state");
        store.addReviewAppealEvent({ appealId: ap.id, actorId: user.id, kind: "reassign", at: nowIso, data: { from: ap.handlerId, fromName: prev ? prev.name : null, to: toUserId, toName: target.name, ...(rnote ? { note: rnote } : {}) } });
        audit("review.appeal.reassign", ap.itemId, { handlerId: ap.handlerId, handlerName: prev ? prev.name : null }, { handlerId: toUserId, handlerName: target.name, appealId: ap.id });
      });
      if (!saved.ok) return appealSaveFailed(res, "review-appeal/reassign", saved);
      appealCacheClear();
      afterCommit("review-appeal/reassign", () => {
        if (toUserId !== user.id) appealNotify(toUserId, {
          title: `The appeal from ${aName} against the ${cName} final rating has been reassigned to you`, title_zh: `${aName} 的「${cName}」评级申诉已转交给你`,
          body: `Response due: ${ap.slaDueOn}.`, body_zh: `答复时限：${ap.slaDueOn}。`, link: appealAdminLink(ap),
        });
        if (prev && prev.id !== user.id) appealNotify(prev.id, {
          title: `The appeal from ${aName} against the ${cName} final rating has been reassigned to ${target.name}`, title_zh: `${aName} 的「${cName}」评级申诉已转交给 ${target.name}`,
          body: "No action is needed.", body_zh: "无需处理。", link: "/admin/review-appeals",
        });
      });
      return reply();
    }
    // --- performance review cycles (Phase 3): HR runs the flow ---

    // 组织绩效 · 后台（负责人 2026-10-10）：互评轮次与季度结果。绩效读 = 查看，绩效写 = 开轮 / 关闭 / 催办 / 退回 / 导入。
    // 部门级数据，不按人员数据范围裁剪；受数据范围限制的角色只读（写操作 403 scope_limited），以免只管部分部门的人改全公司的组织绩效。
    if (pathname === "/api/admin/orgperf/rounds" && req.method === "GET") {
      return send(res, 200, { rounds: store.listOrgRounds().map((r) => orgRoundView(r, false)), dims: OP.DIMS });
    }
    const opScoped = () => { if (!scopePredicate(user)) return false; send(res, 403, { error: "Roles limited to part of the organisation can only view organisational performance.", error_zh: "数据范围受限的角色只能查看组织绩效。", code: "scope_limited" }); return true; };
    if (pathname === "/api/admin/orgperf/rounds" && req.method === "POST") {
      if (opScoped()) return;
      const quarter = String(body.quarter || "").trim();
      if (!OP.QUARTER_RE.test(quarter)) return send(res, 400, { error: "Quarter must look like 2026-Q3.", error_zh: "季度格式为 2026-Q3。", code: "bad_quarter" });
      // CX-179：同一季度已有已结束的互评时也不再新建（结果已回写档案，再建一轮会产生同一季度两份组织绩效）
      if (store.listOrgRounds().some((x) => x.quarter === quarter && x.status === "closed"))
        return send(res, 409, { error: "This quarter already has a finished peer review.", error_zh: "该季度的互评已经结束，不能再新建。", code: "round_exists" });
      if (store.listOrgRounds().some((x) => x.quarter === quarter && x.status !== "closed")) return send(res, 409, { error: "This quarter already has a peer review that is not closed.", error_zh: "该季度已有未结束的互评。", code: "round_exists" });
      const dueOn = body.dueOn ? String(body.dueOn).slice(0, 10) : null;
      if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return send(res, 400, { error: "Invalid due date.", error_zh: "截止日期无效。", code: "bad_due" });
      const name = clampText(body.name, 80) || `${quarter} 一级部门互评`;
      const r = store.createOrgRound({ id: "opr-" + newToken().slice(0, 10), quarter, name, dueOn, dims: OP.DIMS, createdBy: user.id, issueRequired: body.issueRequired === true });
      audit("orgperf.round.create", r.id, null, { quarter, name, issueRequired: r.issueRequired });
      return send(res, 200, { round: orgRoundView(r, true) });
    }
    const opRoundM = pathname.match(/^\/api\/admin\/orgperf\/rounds\/([\w-]+)$/);
    const opRoundOf = () => { const r = store.getOrgRound(opRoundM[1]); if (!r) send(res, 404, { error: "Not found", error_zh: "未找到该互评。", code: "not_found" }); return r; };
    if (opRoundM && req.method === "GET") {
      const r = opRoundOf();
      if (!r) return;
      return send(res, 200, { round: orgRoundView(r, true, user) });
    }
    if (opRoundM && req.method === "DELETE") {
      if (opScoped()) return;
      const r = opRoundOf();
      if (!r) return;
      {
        if (r.status !== "draft") return send(res, 409, { error: "Only a draft can be deleted.", error_zh: "只能删除未开放的草稿。", code: "not_draft" });
        store.deleteOrgRound(r.id);
        audit("orgperf.round.delete", r.id, { quarter: r.quarter, name: r.name }, null);
        return send(res, 200, { ok: true });
      }
    }
    if (opRoundM && req.method === "PUT") {
      if (opScoped()) return;
      const r = opRoundOf();
      if (!r) return;
      {
        const patch = {};
        if (body.name !== undefined) patch.name = clampText(body.name, 80) || r.name;
        if (body.issueRequired !== undefined) { if (r.status !== "draft") return send(res, 409, { error: "The blocker setting can only change before opening.", error_zh: "「卡点题必填」只能在开放前修改。", code: "not_draft" }); patch.issueRequired = body.issueRequired === true; }
        if (body.dueOn !== undefined) { const d = body.dueOn ? String(body.dueOn).slice(0, 10) : null; if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return send(res, 400, { error: "Invalid due date.", error_zh: "截止日期无效。", code: "bad_due" }); patch.dueOn = d; }
        if (body.action === "open") {
          if (r.status !== "draft") return send(res, 409, { error: "Already opened.", error_zh: "该互评已开放过。", code: "not_draft" });
          // 被评部门只算有在职人员的一级部门（空部门不评；10/10 用 lms.db 副本核对：78 个一级部门里 33 个没有人）
          const list = orgDept1List().filter((d) => d.memberCount > 0);
          const raters = list.filter((d) => d.hod).map((d) => ({ dept1Id: d.dept1Id, raterId: d.hod.id }));
          if (raters.length < 2) return send(res, 400, { error: "At least two top-level departments need a head before the peer review can open.", error_zh: "至少两个一级部门有负责人才能开放互评。", code: "too_few_raters" });
          store.transaction(() => {
            store.setOrgRoundSnapshot(r.id, list.map((d) => ({ dept1Id: d.dept1Id, dept1: d.dept1 })), raters);
            store.updateOrgRound(r.id, { ...patch, status: "open", openedAt: new Date(nowMs()).toISOString() });
          });
          const fresh = store.getOrgRound(r.id);
          for (const x of raters) notify(x.raterId, { type: "orgperf.open", title: `Peer review open: ${fresh.name}`, title_zh: `一级部门互评已开放：${fresh.name}`,
            body: fresh.dueOn ? `Please complete it by ${fresh.dueOn}.` : "Please complete it in Performance Reviews › Organizational performance.", body_zh: fresh.dueOn ? `请在 ${fresh.dueOn} 前完成。` : "请在「绩效评估 › 组织绩效」完成。", link: "#/review?view=org" });
          audit("orgperf.round.open", r.id, null, { quarter: r.quarter, raters: raters.length, targets: list.length });
          return send(res, 200, { round: orgRoundView(fresh, true) });
        }
        if (body.action === "close") {
          if (r.status !== "open") return send(res, 409, { error: "Only an open peer review can be closed.", error_zh: "只能结束进行中的互评。", code: "not_open" });
          store.updateOrgRound(r.id, { ...patch, status: "closed", closedAt: new Date(nowMs()).toISOString() });
          audit("orgperf.round.close", r.id, null, { quarter: r.quarter, submitted: store.listOrgRaters(r.id).filter((x) => x.submittedAt).length });
          return send(res, 200, { round: orgRoundView(store.getOrgRound(r.id), true) });
        }
        // 负责人 10/12：发布结果 —— 只能在结束后；发布后被评部门负责人看到本部门得分（不受 3 个部门门槛限制，卡点匿名）
        if (body.action === "publish") {
          if (r.status !== "closed") return send(res, 409, { error: "End the peer review before publishing the results.", error_zh: "请先结束互评，再发布结果。", code: "not_closed" });
          if (r.publishedAt) return send(res, 409, { error: "The results are already published.", error_zh: "结果已经发布过。", code: "already_published" });
          store.updateOrgRound(r.id, { publishedAt: new Date(nowMs()).toISOString() });
          const fresh = store.getOrgRound(r.id);
          const heads = [...new Set(store.listOrgRaters(r.id).map((x) => x.raterId).filter(Boolean))];
          for (const uid of heads) notify(uid, { type: "orgperf.publish", title: `Peer review results published: ${fresh.name}`, title_zh: `一级部门互评结果已发布：${fresh.name}`,
            body: "See your department's scores under Performance Reviews › Organizational performance.", body_zh: "可在「绩效评估 › 组织绩效 › 组织绩效查看」查看本部门得分。", link: "#/review?view=orgres" });
          audit("orgperf.round.publish", r.id, null, { quarter: r.quarter, notified: heads.length });
          return send(res, 200, { round: orgRoundView(fresh, true) });
        }
        if (body.action) return send(res, 400, { error: "Unknown action.", error_zh: "未知操作。", code: "bad_action" });
        const fresh = store.updateOrgRound(r.id, patch);
        audit("orgperf.round.update", r.id, { name: r.name, dueOn: r.dueOn, issueRequired: r.issueRequired }, { name: fresh.name, dueOn: fresh.dueOn, issueRequired: fresh.issueRequired });
        return send(res, 200, { round: orgRoundView(fresh, true) });
      }
    }
    const opRemind = pathname.match(/^\/api\/admin\/orgperf\/rounds\/([\w-]+)\/remind$/);
    if (opRemind && req.method === "POST") {
      if (opScoped()) return;
      const r = store.getOrgRound(opRemind[1]);
      if (!r) return send(res, 404, { error: "Not found", error_zh: "未找到该互评。", code: "not_found" });
      if (r.status !== "open") return send(res, 409, { error: "Only an open peer review can be reminded.", error_zh: "只有进行中的互评可以提醒。", code: "not_open" });
      const want = Array.isArray(body.dept1Ids) && body.dept1Ids.length ? new Set(body.dept1Ids.map(String)) : null;
      // CX-178：与评估周期提醒同样 1 小时去重 —— 1 小时内提醒过的部门跳过（skipped）
      const now = new Date(nowMs()).toISOString();
      const hourAgo = nowMs() - 3600e3;
      const due = store.listOrgRaters(r.id).filter((x) => !x.submittedAt && (!want || want.has(x.dept1Id)));
      // CX-217：开放互评时已给全部评价人发过通知，开放后 1 小时内同样算「已提醒」
      const openedRecently = !!(r.openedAt && Date.parse(r.openedAt) > hourAgo);
      const pending = openedRecently ? [] : due.filter((x) => !(x.remindedAt && Date.parse(x.remindedAt) > hourAgo));
      const skipped = due.length - pending.length;
      for (const x of pending) {
        notify(x.raterId, { type: "orgperf.remind", title: `Reminder: ${r.name}`, title_zh: `提醒：${r.name}`, body: r.dueOn ? `Please complete the peer review by ${r.dueOn}.` : "Please complete the peer review.", body_zh: r.dueOn ? `请在 ${r.dueOn} 前完成一级部门互评。` : "请完成一级部门互评。", link: "#/review?view=org" });
        store.updateOrgRater(r.id, x.dept1Id, { remindedAt: now });
      }
      audit("orgperf.round.remind", r.id, null, { reminded: pending.length, skipped });
      return send(res, 200, { ok: true, reminded: pending.length, skipped });
    }
    const opReturn = pathname.match(/^\/api\/admin\/orgperf\/rounds\/([\w-]+)\/return$/);
    if (opReturn && req.method === "POST") {
      if (opScoped()) return;
      const r = store.getOrgRound(opReturn[1]);
      if (!r) return send(res, 404, { error: "Not found", error_zh: "未找到该互评。", code: "not_found" });
      if (r.status !== "open") return send(res, 409, { error: "Only an open peer review can be returned.", error_zh: "只有进行中的互评可以退回。", code: "not_open" });
      const rr = store.listOrgRaters(r.id).find((x) => x.dept1Id === String(body.dept1Id || ""));
      if (!rr || !rr.submittedAt) return send(res, 409, { error: "Nothing to return.", error_zh: "该部门还没有提交。", code: "not_submitted" });
      store.updateOrgRater(r.id, rr.dept1Id, { submittedAt: null });
      notify(rr.raterId, { type: "orgperf.return", title: `Peer review returned: ${r.name}`, title_zh: `互评已退回：${r.name}`, body: "HR returned your peer review so you can change it. Submit again when done.", body_zh: "HR 已退回你的互评，可修改后重新提交。", link: "#/review?view=org" });
      audit("orgperf.round.return", r.id, null, { dept1Id: rr.dept1Id });
      return send(res, 200, { ok: true });
    }
    const opCsv = pathname.match(/^\/api\/admin\/orgperf\/rounds\/([\w-]+)\/export\.csv$/);
    if (opCsv && req.method === "GET") {
      const r = store.getOrgRound(opCsv[1]);
      if (!r) return send(res, 404, { error: "Not found", error_zh: "未找到该互评。", code: "not_found" });
      const v = orgRoundView(r, true);
      const keys = OP.dimKeys(r.dims);
      // CX-180：表头中英双语（英文在前，与人才记录导出「Type 类型」同一格式）
      const rows = [["Quarter 季度", "Department 部门", "Raters 评价人数", ...r.dims.map((d) => `${d.en} ${d.zh}`), "Overall 综合", "Blockers 主要问题"]];
      for (const x of v.summary) rows.push([r.quarter, x.dept1 || "", x.raters, ...keys.map((k) => (x.dims[k].avg == null ? "" : x.dims[k].avg)), x.overall == null ? "" : x.overall, x.issues.join(" | ")]);
      audit("orgperf.round.export", r.id, null, { rows: v.summary.length });
      return sendCsv(res, `org-peer-review-${r.quarter}.csv`, rows);
    }
    // 季度结果：GET ?quarter= → { quarters, quarter, rows, depts, ratingOptions }；导入 POST { quarter, rows:[{ dept, rating, note }], dryRun }
    if (pathname === "/api/admin/orgperf/results" && req.method === "GET") {
      const all = store.listOrgResults();
      const quarters = [...new Set(all.map((x) => x.quarter))].sort().reverse();
      const quarter = query.get("quarter") && OP.QUARTER_RE.test(query.get("quarter")) ? query.get("quarter") : quarters[0] || null;
      const rows = quarter ? all.filter((x) => x.quarter === quarter).map((x) => { const h = x.hodId ? store.getUserById(x.hodId) : null; return { ...x, hodName: h ? h.name : null }; }) : [];
      const recent = quarters.slice(0, 4);
      const trend = orgDept1List().map((d) => ({ dept1Id: d.dept1Id, dept1: d.dept1, byQuarter: Object.fromEntries(recent.map((q) => [q, (all.find((x) => x.quarter === q && x.dept1Id === d.dept1Id) || {}).rating || null])) }));
      return send(res, 200, { quarters, quarter, rows, recent, trend, depts: orgDept1List().map((d) => ({ dept1Id: d.dept1Id, dept1: d.dept1, hod: d.hod ? d.hod.name : null })), ratingOptions: orgRatingOptions() });
    }
    if (pathname === "/api/admin/orgperf/results/import" && req.method === "POST") {
      if (opScoped()) return;
      const quarter = String(body.quarter || "").trim();
      if (!OP.QUARTER_RE.test(quarter)) return send(res, 400, { error: "Quarter must look like 2026-Q3.", error_zh: "季度格式为 2026-Q3。", code: "bad_quarter" });
      const rowsIn = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
      if (!rowsIn.length) return send(res, 400, { error: "No rows to import.", error_zh: "没有要导入的行。", code: "no_rows" });
      const list = orgDept1List();
      const byName = new Map(list.map((d) => [String(d.dept1).trim().toLowerCase(), d]));
      const opts = orgRatingOptions();
      const seen = new Set();
      const out = rowsIn.map((x, k) => {
        const dept = String((x && x.dept) || "").trim();
        const d = byName.get(dept.toLowerCase()) || list.find((y) => y.dept1Id === dept) || null;
        // 代码审查 10/11：不区分大小写匹配评级选项，存选项原值（选项含小写时不再整列报错）
        const raw = String((x && x.rating) || "").trim();
        const rating = opts.find((o) => String(o).toLowerCase() === raw.toLowerCase()) || raw;
        const row = { line: k + 1, dept, rating, note: clampText(x && x.note, 300) || null, dept1Id: d ? d.dept1Id : null, dept1: d ? d.dept1 : null, hod: d && d.hod ? d.hod.name : null, prev: d ? ((store.getOrgResult(quarter, d.dept1Id) || {}).rating || null) : null, error: null };
        if (!d) row.error = "unknown_dept";
        else if (!opts.includes(rating)) row.error = "bad_rating";
        else if (seen.has(d.dept1Id)) row.error = "duplicate";
        if (d) seen.add(d.dept1Id);
        return row;
      });
      const bad = out.filter((x) => x.error).length;
      // 代码审查 10/11：导入只更新本次出现的部门；本季度之前导入过、这次没出现的部门保留原评级 —— 预览里列出来，免得以为整季被替换
      const inBatch = new Set(out.map((x) => x.dept1Id).filter(Boolean));
      const kept = store.listOrgResults().filter((x) => x.quarter === quarter && !inBatch.has(x.dept1Id)).map((x) => ({ dept1Id: x.dept1Id, dept1: x.dept1, rating: x.rating }));
      if (body.dryRun) return send(res, 200, { quarter, rows: out, ok: out.length - bad, bad, ratingOptions: opts, kept });
      if (bad) return send(res, 400, { error: "Fix the rows marked in the preview first.", error_zh: "预览里有标出的问题行，修正后再导入。", code: "bad_rows", rows: out });
      let written = 0, records = 0;
      const today = todayLocal();
      store.transaction(() => {
        for (const x of out) {
          const d = list.find((y) => y.dept1Id === x.dept1Id);
          const prev = store.getOrgResult(quarter, x.dept1Id);
          let recordId = prev ? prev.recordId : null;
          // 代码审查 10/11：重导同一季度时，原记录还在就改写原记录（属于首次导入时的负责人），负责人后来换了也不另建、不留过期评级
          const oldRec = recordId ? store.getTalentRecord(recordId) : null;
          const hodId = oldRec ? oldRec.userId : d && d.hod ? d.hod.id : null;
          // 负责人 10/10 定：组织绩效结果写进当时负责人本人的绩效档案（重复导入同一季度时改写同一条记录）
          if (hodId) {
            const title = `组织绩效 ${quarter}`;
            const detail = { period: `${quarter} Org performance`, rating: x.rating, summary: x.note || "", source: "orgperf", dept1: x.dept1 };
            const old = oldRec;
            if (old && old.userId === hodId) store.updateTalentRecord(old.id, { type: "performance", date: old.date || today, title, detail, programId: null });
            else recordId = store.createTalentRecord({ id: "tr-" + newToken().slice(0, 10), userId: hodId, type: "performance", date: today, title, detail, programId: null, createdBy: user.id }).id;
            records++;
          } else recordId = null;
          store.upsertOrgResult({ quarter, dept1Id: x.dept1Id, dept1: x.dept1, rating: x.rating, note: x.note, hodId, recordId, importedBy: user.id });
          written++;
        }
      });
      audit("orgperf.results.import", quarter, null, { rows: written, records });
      return send(res, 200, { ok: true, quarter, written, records });
    }
    if (pathname === "/api/admin/review-cycles" && req.method === "GET") {
      /* P2 范围（阶段 C：performance 域）—— **重算**，不是「算完再过滤」：
         total 是分母。不重算的话一个只管一个部门的 HRBP 永远看到「12/300 已自评」，
         进度条与他点进去看到的名单（下面 GET :id 已过滤）永远对不上，而对不上的进度条
         会被当成「系统在丢数据」。已删的参与者（getUserById=null）在范围生效时 fail
         closed 消失 —— 与 store.scopeAllowsUser 的既定口径一致。 */
      const rcScope = scopePredicate(user);
      return send(res, 200, store.listReviewCycles().map((c) => {
        const items = store.listCycleItems(c.id).filter((i) => !rcScope || rcScope(store.getUserById(i.userId)));
        // 绩效流程 v2（迁移 65）：列表显示五阶段 —— 面谈双方确认人数、HoD 已提交 / HR 已确认的部门数
        const v2 = c.flow === "v2" ? reviewGroups(c, items) : null;
        return {
          ...c, total: items.length,
          selfDone: items.filter((i) => i.selfAt).length,
          mgrDone: items.filter((i) => i.managerAt).length,
          // 已关闭周期 = 档案里现在有评级的人数（W3-S：与部门行、看板同按档案评级；归档记录已被删的不算）
          finalDone: c.status === "closed" ? items.filter((i) => reviewRecordRatingOf(i).recordRating).length : items.filter((i) => i.finalRating || i.managerRating).length,
          ...(v2 ? {
            oneDone: items.filter((i) => i.oneOnOneAt && i.employeeOneOnOneAt).length,
            deptTotal: v2.length,
            deptSubmitted: v2.filter((g) => g.status && (g.status.hodSubmittedAt || g.status.hrConfirmedAt)).length,
            deptConfirmed: v2.filter((g) => g.status && g.status.hrConfirmedAt).length,
          } : {}),
        };
      }));
    }
    if (pathname === "/api/admin/review-cycles" && req.method === "POST") {
      const name = String(body.name || "").trim().slice(0, 80);
      // dryRun（发起对话框预览人数）：只算人数与排除名单，不建周期、不发通知、不记审计
      const dryRun = body.dryRun === true;
      if (!name && !dryRun) return send(res, 400, { error: "Enter a cycle name. 请填写周期名称。", code: "name_required" });
      // A todo without a date is not actionable, so the cycle carries the
      // self-review deadline every surface then shows ("截止 2026-08-25").
      const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueAt || "")) ? body.dueAt : null;
      /* P2 范围：三个圈人分支各有各的口径，且**全部在建周期之前**判定 —— createReviewCycle
         原本是这条 handler 的第一句，越界拒绝若发生在它之后就会留下一个空壳周期（列表里
         多一行谁也删不掉的噪音）。所以这里把建周期挪到了选人之后，语义不变。
           · 显式 userIds → 逐条校验，部分越界 = **整批拒绝**（设计选择①）；
           · body.department → 目标部门必须在范围内（这是「圈一个部门的人」，
             不在范围内就是在给范围外的人开绩效）；
           · 默认「全员在职」→ 收窄成「**范围内**全员」（不是拒绝：这是默认值不是请求）。 */
      const rcNewScope = scopePredicate(user);
      // 绩效流程 v2（迁移 65）：flow:'v2' 才走 HoD 校准与 HR 确认；kind 季度/年度（年度一律 v2）
      const kind = body.kind === "annual" ? "annual" : "quarter";
      const v2 = body.flow === "v2" || kind === "annual";
      const snapC = orgSnapshot();
      const hodIds = v2 ? reviewHodIdSet(snapC) : null;   // U1：v2 周期排除一级部门负责人
      // Leavers are never rated, even if their account has not been disabled yet.
      const inServiceUsers = () => store.listUsers().filter((u) => u.role !== "admin" && u.active !== 0 && u.empStatus !== "exited");
      // Participants: explicit userIds, a department, or every active employee.
      let targets = [];
      let skippedNoLevel = 0;
      // P0 1.5：noLevel = 所选范围内没有职级的人数（不受 includeNoLevel 影响，v2 已去掉 HoD）；
      // pool = 范围内全部在职员工（不受所选部门影响），发起对话框的部门选项 deptOptions 由它生成。
      let noLevel = 0;
      let pool = null;
      if (Array.isArray(body.userIds) && body.userIds.length) {
        targets = body.userIds.map((x) => store.getUserById(x)).filter(Boolean);
        if (rcNewScope) {
          const outOfScope = targets.filter((t) => !rcNewScope(t)).length;
          if (outOfScope) return sendScopeBulkReject(res, outOfScope);
        }
      } else {
        targets = inServiceUsers();
        // P0 1.5：departmentId（部门 id，或 "name:<部门名>" 伪选项）优先于 department（部门名，继续兼容）；
        // 选上级部门 = 含全部下级部门（org.js chainOf / descendantIdsOf，集团层不算祖先）。
        const ixC = snapC.index;
        let sel = null;
        if (body.departmentId !== undefined && body.departmentId !== null && body.departmentId !== "") {
          const raw = String(body.departmentId).trim();
          sel = raw.startsWith("name:") ? (raw.slice(5).trim() ? { pseudo: raw.slice(5).trim() } : null) : ixC.byId.get(raw) || null;
          if (!sel) return send(res, 400, { error: "Department not found. 未找到该部门。", code: "dept_not_found" });
        } else if (body.department) {
          // 不在部门表的旧名字 → 退回按名匹配
          sel = ixC.deptOf(String(body.department)) || { pseudo: String(body.department).trim() };
        }
        const selName = sel ? sel.pseudo || sel.name : null;
        if (sel && !scopeAllowsDeptFor(user, selName)) return sendScopeDeptReject(res);
        // 下级部门中范围外的人在这里被收窄（不报错），与「默认全员」一支同一口径
        if (rcNewScope) targets = targets.filter(rcNewScope);
        pool = targets;
        if (sel) {
          const ids = sel.pseudo ? null : ixC.descendantIdsOf(sel.id);
          const nk = (s) => String(s || "").trim().toLowerCase();
          // 部门父链成环时 descendantIdsOf 为空 → 退回按部门名匹配（不然连直属成员都圈不到）
          targets = targets.filter((u) => {
            const h = ixC.deptOf(u.department);
            return ids && ids.size && h ? ids.has(h.id) : nk(u.department) === nk(selName);
          });
        }
        noLevel = targets.filter((u) => !String(u.jobLevel || "").trim() && !(hodIds && hodIds.has(u.id))).length;
        // Agency and externally-hired staff are carried in the roster so they show
        // up on the org chart, but they are not on the job-grade ladder and are not
        // rated. "No job level" is the marker for them. HR can override per cycle
        // with includeNoLevel, so this is a default and not a hard rule.
        if (!body.includeNoLevel) {
          const before = targets.length;
          targets = targets.filter((u) => String(u.jobLevel || "").trim());
          skippedNoLevel = before - targets.length;
        }
      }
      if (!pool) { pool = inServiceUsers(); if (rcNewScope) pool = pool.filter(rcNewScope); }
      const deptOptions = reviewDeptOptions(pool, snapC.index, scopeDeptPredicate(user));
      // 三个截止日；配额
      const dOk = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || "")) ? x : null);
      let quota = null;
      if (body.quota && typeof body.quota === "object") {
        quota = {};
        for (const k of Object.keys(REVIEW_DEFAULT_QUOTA)) { const v = Number(body.quota[k]); if (Number.isFinite(v) && v >= 0 && v <= 100) quota[k] = Math.round(v * 10) / 10; }
      }
      // U1：v2 周期排除一级部门负责人（显式名单里的也排除，并在响应里说明）
      let excludedHods = [];
      if (v2) {
        excludedHods = targets.filter((t) => hodIds.has(t.id));
        if (excludedHods.length) targets = targets.filter((t) => !hodIds.has(t.id));
      }
      if (dryRun) return send(res, 200, { ok: true, dryRun: true, participants: targets.length, skippedNoLevel, noLevel, excludedHods: excludedHods.length, excludedHodNames: excludedHods.slice(0, 30).map((u) => u.name), deptOptions });
      const cycle = store.createReviewCycle(name, dueAt, v2 ? { kind, flow: "v2", quota: quota || { ...REVIEW_DEFAULT_QUOTA }, dueRateAt: dOk(body.dueRateAt), dueCalibAt: dOk(body.dueCalibAt) } : {});
      store.addReviewItemsBulk(cycle.id, targets);
      // 年度周期：员工与上级不填，HoD 提评级 —— 只通知各部门 HoD
      if (kind === "annual") {
        const snap = orgSnapshot(); const hods = new Map();
        for (const t of targets) { const h = snap.hodOf(t.department); if (h) hods.set(h.id, h); }
        // 第二批 2.5：通知直达该 HoD 的部门校准（一级部门 = HoD 所负责的那个）
        for (const h of hods.values()) notify(h.id, {
          type: "review", link: `/review?view=hod&cycle=${encodeURIComponent(cycle.id)}${h.level1Id ? `&unit=${encodeURIComponent(h.level1Id)}` : ""}`,
          title: `Please propose annual ratings for ${name}${cycle.dueCalibAt ? ` by ${cycle.dueCalibAt}` : ""}`,
          title_zh: `请${cycle.dueCalibAt ? `在 ${cycle.dueCalibAt} 前` : ""}提交「${name}」本部门年度评级`,
          body: "Open Performance Reviews › Department Calibration.", body_zh: "请在「绩效评估 › 部门校准」中操作。",
        });
        audit("review.cycle.create", cycle.id, null, { name, kind, participants: targets.length, skippedNoLevel, excludedHods: excludedHods.length });
        return send(res, 200, { ok: true, cycle, participants: targets.length, skippedNoLevel, noLevel, excludedHods: excludedHods.length, deptOptions });
      }
      // B-F07：通知参与者提交自评（带截止日期）
      for (const t of targets) notify(t.id, {
        type: "review",
        title: `Please submit your self-review for ${name}${dueAt ? ` by ${dueAt}` : ""}`,
        title_zh: `请${dueAt ? `在 ${dueAt} 前` : ""}提交「${name}」自评`,
        body: `The review cycle ${name} has started. Submit your self-review under Performance Reviews${dueAt ? ` by ${dueAt}` : ""}.`,
        body_zh: `评估周期「${name}」已发起，请${dueAt ? `在 ${dueAt} 前` : ""}在「绩效评估」中提交自评。`,
        link: "/review?view=mine",
      });
      audit("review.cycle.create", cycle.id, null, { name, participants: targets.length, skippedNoLevel, excludedHods: excludedHods.length });
      return send(res, 200, { ok: true, cycle, participants: targets.length, skippedNoLevel, noLevel, excludedHods: excludedHods.length, deptOptions });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 13261–13587 行（/api/admin/ 块内）
    async adminPerformance2(C) {
      const { cycleMatch, req, res, user, pathname, body, audit } = C;
      const { store, send, scopePredicate, orgSnapshot, reviewDeptPredMemo, scopeDeptPredicate, reviewUserMemo, reviewGradeIndex, todayLocal, reviewSnapLocks, reviewItemLocked, reviewDeptPath, reviewManagerStatus, reviewOneState, reviewHodProxyOf, reviewPersonGone, reviewOverdueOf, reviewRecordRatingOf, reviewGroups, modulesOn, canRead, isSuperAdmin, CT, parseTags, reviewHrCalibAccess, reviewDeptRow, reviewDeptOptions, reviewCycleResultsOf, reviewQuotaOf, REVIEW_QUOTA_MIN_HC, optionsZhOf, sendScopeBulkReject, reviewHodIdSet, reviewDeptLocked, REVIEW_DEFAULT_QUOTA, reviewSelfActor, reviewUnresolvedErr, reviewHodOwned, reviewConfirmIssues, reviewSnapPut, notify, notifyAdmins, reviewCalibView, canWrite, REVIEW_REMIND_STAGES, REVIEW_REMIND_BY, bulkIdList, bulkOutOfScope, sendBulkScopeReject, planReviewReminders, emitBulkEffects, emitReviewReminder, sendBulkResult, nowMs } = S;
    if (cycleMatch && req.method === "GET") {
      const cycle = store.getReviewCycle(cycleMatch[1]);
      if (!cycle) return send(res, 404, { error: "Review cycle not found. 未找到该评估周期。", code: "cycle_not_found" });
      const ratingField = store.listRecordFields("performance").find((x) => x.key === "rating");
      // P2 范围：items[] **过滤**（每行含姓名/工号/部门/上级/自评正文/评级，是范围外
      // 员工最完整的一份绩效原文），distribution 跟着**重算** —— 它由过滤后的 items
      // 导出，所以分布自然只统计范围内的人，不需要第二处口径。
      const rcOneScope = scopePredicate(user);
      // P0 1.5：一次组织快照供部门链、一级部门分组、范围不全的部门共用；部门链上范围外的部门去掉
      const snapD = orgSnapshot();
      const allowD = reviewDeptPredMemo(scopeDeptPredicate(user));
      // 第二批 2.3（2026-10-08）：items 另带 managerId、managerStatus、notCounted、hodProxy、oneState、jobGrade、jobTrack（看板筛选用）。
      // 不给上级的工号（managerEmployeeId）：范围外人员的工号不能出现在响应里（test/rbac-scope-systemwide）。
      const userOfD = reviewUserMemo();
      const gradesD = reviewGradeIndex();
      // 统一行状态里的 locked / overdue（与团队名单、部门校准同口径）；部门锁定状态按一级部门缓存，快照锁一次取
      const todayD = todayLocal();
      const locksD = cycle.flow === "v2" ? reviewSnapLocks(cycle.id) : null;
      const deptStD = new Map();
      const lockedOfD = (i, u) => {
        if (cycle.flow !== "v2") return false;
        const lv = u ? snapD.levelsOf(u.department) : null;
        const k = lv && lv.level1Id ? lv.level1Id : "__none";
        if (!deptStD.has(k)) deptStD.set(k, store.getReviewDeptStatus(cycle.id, k));
        return !!reviewItemLocked(cycle, i, { st: deptStD.get(k), locks: locksD });
      };
      const items = store.listCycleItems(cycle.id).filter((i) => !rcOneScope || rcOneScope(store.getUserById(i.userId))).map((i) => {
        const u = store.getUserById(i.userId);
        const m = i.managerId ? store.getUserById(i.managerId) : null;
        const gr = u && u.jobLevel ? gradesD.get(String(u.jobLevel).toUpperCase()) : null;
        const pj2 = (s2, d2) => { try { return s2 ? JSON.parse(s2) : d2; } catch { return d2; } };
        return {
          id: i.id, userId: i.userId,
          name: u ? u.name : "?", employeeId: u ? u.employeeId : "?",
          department: u ? u.department || null : null, jobLevel: u ? u.jobLevel || null : null,
          // 部门 id 链（一级 → 本部门）；不在部门表时 ["name:<部门名小写>"]；没有部门时 []。按部门筛选 = deptPath.includes(选中的 id)
          deptPath: reviewDeptPath(u, snapD.index, allowD),
          manager: m ? m.name : null,
          selfAt: i.selfAt, selfFeedback: i.selfFeedback || "",
          // HR 校准依据（B-F06）：自评全文；面谈要点（D-17：上级与 HR 可见，不写入员工档案）
          prevGoals: pj2(i.prevGoals, []), selfOutcomes: pj2(i.selfOutcomes, []), selfChallenges: i.selfChallenges || "", selfExtra: i.selfExtra || "",
          oneOnOneNotes: i.oneOnOneNotes || "",
          goalsNext: pj2(i.goalsNext, []), oneOnOneAt: i.oneOnOneAt,
          managerRating: i.managerRating, managerText: i.managerText || "", managerAt: i.managerAt,
          finalRating: i.finalRating, recordId: i.recordId,
          // 绩效流程 v2
          employeeOneOnOneAt: i.employeeOneOnOneAt || null, highlights: i.highlights || "", hodText: i.hodText || "", hodAt: i.hodAt || null,
          managerId: i.managerId || null, managerStatus: reviewManagerStatus(i, userOfD), oneState: reviewOneState(i),
          hodProxy: reviewHodProxyOf(cycle, i, userOfD), notCounted: reviewPersonGone(u) ? "departed" : null,
          jobGrade: gr && gr.grade != null ? gr.grade : null, jobTrack: gr ? gr.track || null : null,
          locked: lockedOfD(i, u), overdue: reviewOverdueOf(cycle, i, todayD),
          // 第二批 2.6：已关闭周期另带归档记录现在的评级 recordRating 与 amendedFrom（改过评级时 = 归档时的评级；改回原值为 null）。
          // 只在后台（绩效读权限）下发，员工端不给。
          ...(cycle.status === "closed" ? reviewRecordRatingOf(i) : {}),
        };
      });
      // 一级部门组（v2）：人数、各档人数、配额名额、超额、HoD、提交 / 确认状态
      const allCycleItems = store.listCycleItems(cycle.id);
      const rawItems = allCycleItems.filter((i) => !rcOneScope || rcOneScope(store.getUserById(i.userId)));
      const groups = cycle.flow === "v2" ? reviewGroups(cycle, rawItems, snapD) : [];
      // 范围受限时，组里还有范围外的人的一级部门（2026-10-07 B6）：按部门批量提醒 HoD 要求整组都在范围内，
      // 部门面板据此把这些行的勾选框置灰（scopePartial: true）。只标记，不透露范围外的人数与姓名。
      const partialDepts = new Set();
      if (rcOneScope && cycle.flow === "v2") {
        for (const i of allCycleItems) {
          const u = store.getUserById(i.userId);
          if (rcOneScope(u)) continue;
          const lv = u ? snapD.levelsOf(u.department) : null;
          partialDepts.add(lv && lv.level1Id ? lv.level1Id : "__none");
        }
      }
      const deptOfItem = new Map(); for (const g of groups) for (const i of g.items) deptOfItem.set(i.id, g.dept1Id);
      // 绩效看板第三期（2026-10-10）：「高绩效保留」要看流失风险标签与是否已列为继任人 —— 只给有人才发展读权限、且人才模块开着的人
      // （流失风险对上级与员工本人不可见，见 12.2）；没有权限时不带这两个键。
      if (modulesOn().talent && canRead(user, "talent")) {
        const succIds = new Set(store.listSuccession().map((x) => x.userId));
        for (const it of items) {
          const u = store.getUserById(it.userId);
          // 代码审查 10/11：本人且非超级管理员不带 flight（与 tagsForViewer 同口径，流失风险对员工本人不可见）
          if (it.userId !== user.id || isSuperAdmin(user)) it.flight = !!(u && CT.controlledKeysOf(parseTags(u)).includes("flight"));
          it.successor = succIds.has(it.userId);
        }
      }
      for (const it of items) it.dept1Id = deptOfItem.get(it.id) || null;
      // 绩效看板验收（2026-10-10，QA 第 31 节）：旧流程周期没有部门组，按员工所属一级部门补 dept1Id 与 dept1 名称，
      // 看板的部门进度与「上级评分尺度」的部门平均才不会整期落到「未归入一级部门」。v2 的 dept1Id 仍以部门组为准。
      if (cycle.flow !== "v2") for (const it of items) { const lv = snapD.levelsOf(it.department); if (lv && lv.level1Id && (!allowD || allowD(lv.level1))) { it.dept1Id = lv.level1Id; it.dept1 = lv.level1 || null; } }
      else { const nm = new Map(groups.map((g) => [g.dept1Id, g.dept1])); for (const it of items) it.dept1 = it.dept1Id ? nm.get(it.dept1Id) || null : null; }
      // HoD 本人的评估项（留给 HR、不计入配额）
      const hodOfDept = new Map(groups.map((g) => [g.dept1Id, g.hod ? g.hod.id : null]));
      for (const it of items) if (!it.notCounted && it.dept1Id && hodOfDept.get(it.dept1Id) === it.userId) it.notCounted = "hod_self";
      // P0 1.1：HR 现在能否改这一条的评级 —— 旧流程 = 周期进行中；v2 = 进行中、未确认、且该组不归 HoD 校准
      // （无 HoD 的组，或 HoD 本人的评估项；「HoD 待确认」的组也只读）。前端只认这个字段，不再自己重算规则。
      const cycleOpen = cycle.status === "open";
      const groupById = new Map(groups.map((g) => [g.dept1Id, g]));
      const snapLocks = cycle.flow === "v2" ? reviewSnapLocks(cycle.id) : null;
      for (const it of items) {
        if (cycle.flow !== "v2") { it.hrCalibratable = cycleOpen; continue; }
        const g = groupById.get(it.dept1Id);
        // 还在另一个已锁定部门快照里的人（调部门过来的）同样不能改（与 PUT 同一口径）
        it.hrCalibratable = cycleOpen && !!g && reviewHrCalibAccess(g, g.status, it.userId) === "ok" && !snapLocks.has(it.userId);
      }
      // 部门行由 reviewDeptRow 生成（与部门明细接口共用）；第二批起多 departedN、quotaBase
      const depts = groups.map((g) => reviewDeptRow(cycle, g, user, partialDepts.has(g.dept1Id)));
      // P0 1.5：部门筛选选项由所有可见条目的部门链汇总（已按范围裁掉范围外的部门，含 "name:" 伪选项）
      const deptOptions = reviewDeptOptions(rawItems.map((i) => store.getUserById(i.userId)).filter(Boolean), snapD.index, null, allowD);
      // 已关闭周期按档案评级（items 已带 recordRating，W3-S）；进行中按生效评级
      const distribution = {};
      for (const i of items) {
        const r = cycle.status === "closed" ? i.recordRating : i.finalRating || i.managerRating;
        if (r) distribution[r] = (distribution[r] || 0) + 1;
      }
      const perfType = store.getRecordType("performance");
      // 第二批 2.8（§4.5）：已关闭周期带 results（告知与申诉期限）与 appeals（范围内、本人不利益相关的申诉数）；进行中的周期两者为 null
      const cycleAppealInfo = modulesOn().performance ? reviewCycleResultsOf(cycle, user, rcOneScope) : { results: null, appeals: null };
      return send(res, 200, {
        cycle: { ...cycle, quota: cycle.flow === "v2" ? reviewQuotaOf(cycle) : null, results: cycleAppealInfo.results, appeals: cycleAppealInfo.appeals }, items, depts, deptOptions, quotaMinHeadcount: REVIEW_QUOTA_MIN_HC,
        ratingOptions: ratingField ? ratingField.options : [], ratingOptions_zh: ratingField ? optionsZhOf(ratingField) : [], distribution,
        // 评级刻度说明（迁移 56）与结果是否对员工本人可见（G-10）
        ratingOptions_desc: ratingField ? ratingField.options_desc || [] : [], ratingOptions_desc_zh: ratingField ? ratingField.options_desc_zh || [] : [],
        resultVisibleToEmployee: !!(perfType && perfType.active && perfType.employeeVisible),
        // 绩效看板第三期（代码审查 10/11）：items 是否带 flight / successor（有人才发展读权限且人才模块开着）
        talentFlags: !!(modulesOn().talent && canRead(user, "talent")),
      });
    }
    const cyclePartMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)\/participants$/);
    if (cyclePartMatch && req.method === "POST") {
      const cycle = store.getReviewCycle(cyclePartMatch[1]);
      if (!cycle) return send(res, 404, { error: "Review cycle not found. 未找到该评估周期。", code: "cycle_not_found" });
      if (cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
      const ids = Array.isArray(body.userIds) ? body.userIds : [];
      // P2 范围：逐条校验，部分越界 → **整批拒绝**（设计选择①）。这条 handler 原本的
      // `if (!t) continue` 正是 §9 ② 点名的那种「天然引诱人写成跳过」的形状 —— 增补
      // 参与者一旦跳过，被漏掉的人不会出现在任何名单里，等到关账才发现已经来不及。
      const partScope = scopePredicate(user);
      if (partScope) {
        const outOfScope = ids.map((x) => store.getUserById(x)).filter((t) => t && !partScope(t)).length;
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      let n = 0, excluded = 0;
      const snapPa = cycle.flow === "v2" ? orgSnapshot() : null;
      const hodIds = snapPa ? reviewHodIdSet(snapPa) : null;   // U1：v2 周期不收一级部门负责人
      // P0 S4：v2 周期里，任一目标人员所在的一级部门组已提交 / 已确认（reviewDeptLocked）→ 整批拒绝
      // （写法同上面的越界整批拒绝）。加进已提交的部门，这个人上级和 HoD 都评不了，配额也悄悄变了；HR 须先退回该部门。
      if (snapPa) {
        const statusOf = new Map(store.listReviewDeptStatus(cycle.id).map((r) => [r.dept1Id, r]));
        const locked = new Set();
        for (const uid of ids) {
          const t = store.getUserById(uid);
          if (!t || hodIds.has(t.id)) continue;
          const lv = snapPa.levelsOf(t.department);
          const st = statusOf.get(lv && lv.level1Id ? lv.level1Id : "__none");
          if (reviewDeptLocked(st)) locked.add(st.dept1Name || (lv && lv.level1) || "—");
        }
        if (locked.size) return send(res, 400, {
          error: "This department's calibration has been submitted; return it before adding people. 该部门已提交校准，请先退回再增补人员。",
          code: "dept_locked", depts: [...locked],
        });
      }
      for (const uid of ids) {
        const t = store.getUserById(uid);
        if (!t) continue;
        if (hodIds && hodIds.has(t.id)) { excluded++; continue; }
        store.addReviewItem({ cycleId: cycle.id, userId: t.id, managerId: t.managerId || null, prevGoals: store.latestClosedReviewGoals(t.id) });
        n++;
      }
      return send(res, 200, { ok: true, added: n, excludedHods: excluded });
    }
    // A mistyped deadline used to mean rebuilding the whole cycle: that is a
    // several-thousand-row write, and once anyone has submitted, the cycle can no
    // longer be deleted at all — so the date has to be editable in place.
    // Same date rule as POST; null is a legitimate value meaning "no deadline".
    const cycleDueMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)\/due$/);
    if (cycleDueMatch && req.method === "PUT") {
      const cycle = store.getReviewCycle(cycleDueMatch[1]);
      if (!cycle) return send(res, 404, { error: "Review cycle not found. 未找到该评估周期。", code: "cycle_not_found" });
      // 三个截止日与配额都只在传了时改（P0 审查 M9：原先无条件写 dueAt，只传 {quota} 或 {dueCalibAt} 会清掉自评截止日）
      const dOk2 = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || "")) ? x : null);
      const v2c = cycle.flow === "v2";
      const extra = {};
      if (body.dueAt !== undefined) extra.dueAt = dOk2(body.dueAt);
      if (body.dueRateAt !== undefined) extra.dueRateAt = dOk2(body.dueRateAt);
      if (body.dueCalibAt !== undefined) extra.dueCalibAt = dOk2(body.dueCalibAt);
      if (body.quota && typeof body.quota === "object" && v2c) {
        // 与发起时同样取整到 0.1；归一后与当前值比较，只有真的改了才算改配额（前端原样回传未改动的配额不受影响）
        const norm = (src) => { const o = {}; for (const k of Object.keys(REVIEW_DEFAULT_QUOTA)) { const v = Number(src[k]); if (src[k] !== null && src[k] !== undefined && src[k] !== "" && Number.isFinite(v) && v >= 0 && v <= 100) o[k] = Math.round(v * 10) / 10; } return o; };
        const q = norm(body.quota), cur = norm(reviewQuotaOf(cycle));
        const changed = Object.keys(REVIEW_DEFAULT_QUOTA).some((k) => q[k] !== cur[k]);
        if (changed) {
          // P0 D3：任一部门已提交或已确认后不能改配额（否则 HR 改配额就能绕开 1.2 的确认检查）；日期仍可改
          if (store.listReviewDeptStatus(cycle.id).some(reviewDeptLocked))
            return send(res, 400, { error: "A department has already been submitted or confirmed, so the quota can't be changed. Dates can still be changed. 已有部门提交或确认校准，配额不能再改；日期仍可修改。", code: "quota_locked" });
          extra.quota = q;
        }
      }
      const pick = (c) => ({ dueAt: c.dueAt || null, dueRateAt: c.dueRateAt || null, dueCalibAt: c.dueCalibAt || null, ...(v2c ? { quota: reviewQuotaOf(c) } : {}) });
      const updated = Object.keys(extra).length ? store.setReviewCycleDates(cycle.id, extra) : store.getReviewCycle(cycle.id);
      // 审计挪到写入之后，before / after 都是完整的日期与配额（G 场景：原先配额变更不留痕）
      audit("review.cycle.due", cycle.id, pick(cycle), pick(updated));
      return send(res, 200, { ok: true, cycle: { ...updated, quota: v2c ? reviewQuotaOf(updated) : null } });
    }
    // HR 按一级部门确认 / 退回（绩效流程 v2）：两条路由共用一个处理函数；deptActMatch = [全串, cycleId, dept1Id, 动作]
    const reviewDeptAct = (deptActMatch) => {
      const cycle = store.getReviewCycle(deptActMatch[1]);
      if (!cycle || cycle.flow !== "v2") return send(res, 404, { error: "Review cycle not found. 未找到该评估周期。", code: "cycle_not_found" });
      if (cycle.status !== "open") return send(res, 400, { error: "This review cycle is closed. 该评估周期已关闭。", code: "cycle_closed" });
      const scope = scopePredicate(user);
      const g = reviewGroups(cycle, store.listCycleItems(cycle.id)).find((x) => x.dept1Id === deptActMatch[2]);
      if (!g || (scope && g.items.some((i) => !scope(store.getUserById(i.userId))))) return send(res, 404, { error: "Department not found. 未找到该部门。", code: "not_found" });
      const st = g.status;
      // P0 E2（审查 H2）：确认人 / 退回人就是该组的 HoD（现在的、提交时的，或以 HoD 身份校准过评级的）→ 须由另一名 HR 操作
      if (reviewSelfActor(g, st, user.id))
        return send(res, 409, { error: "You are this department's HoD, so another HR colleague must confirm or return it. 你是该部门的 HoD，须由另一名 HR 确认或退回。", code: "self_confirm" });
      if (deptActMatch[3] === "confirm") {
        // P0 S2 顺序：已确认 → HoD 待确认 / 未提交 → 阻断项（配额、未评级、成员变动）→ 写入 + 通知 HoD
        if (st && st.hrConfirmedAt) return send(res, 400, { error: "This department has already been confirmed. 该部门已确认。", code: "already_confirmed" });
        if (!(st && st.hodSubmittedAt)) {
          // 「HoD 待确认」不是「无 HoD」：HR 不能替 HoD 确认，先去部门页指定负责人（E1）；一级部门已停用 → dept_inactive
          if (g.hodUnresolved) return send(res, 409, reviewUnresolvedErr(g));
          // 归 HoD 的组（现在有 HoD，或 HoD 已提交 / 退回后待确认）须先由 HoD 提交；真正无 HoD 的组（__none、无在职成员）由 HR 直接确认
          if (reviewHodOwned(g, st)) return send(res, 400, { error: "The HoD has not submitted this department yet. HoD 尚未提交本部门。", code: "not_submitted" });
        }
        const issues = reviewConfirmIssues(cycle, g);
        if (issues.length) return send(res, 400, { error: "This department can't be confirmed yet. 该部门还不能确认。", code: "confirm_blocked", issues });
        store.upsertReviewDeptStatus(cycle.id, g.dept1Id, { dept1Name: g.dept1, hrConfirmedAt: new Date(nowMs()).toISOString(), hrId: user.id });
        reviewSnapPut(cycle.id, g, "confirm");   // P0 E3：确认时的成员快照（关闭周期时核对）
        audit("review.dept.confirm", cycle.id, null, { dept1: g.dept1, headcount: g.headcount, counts: g.counts });
        const hodTo = g.hod ? g.hod.id : (st && st.hodId) || null;
        const hodLink = `/review?view=hod&cycle=${encodeURIComponent(cycle.id)}&unit=${encodeURIComponent(g.dept1Id)}`;
        if (hodTo) notify(hodTo, {
          type: "review", link: hodLink,
          title: `HR confirmed the calibration of ${g.dept1 || "your department"} for ${cycle.name}`,
          title_zh: `HR 已确认 ${g.dept1 || "本部门"} 在「${cycle.name}」的校准结果`,
          body: "The ratings are final for this cycle and will be recorded when the cycle closes.", body_zh: "本周期评级已定，周期关闭时写入员工档案。",
        });
        // 第二批 2.5（建议项）：全部一级部门都已确认 → 通知绩效管理员可以关闭周期
        const allGroups = reviewGroups(cycle, store.listCycleItems(cycle.id));
        if (allGroups.length && allGroups.every((x) => x.status && x.status.hrConfirmedAt)) notifyAdmins({
          type: "review", link: `/admin/reviews?cycle=${encodeURIComponent(cycle.id)}`,
          title: `All departments in "${cycle.name}" are confirmed. You can close the cycle.`,
          title_zh: `「${cycle.name}」所有部门已确认，可以关闭周期`,
          body: "Open the review cycle to close it; ratings are recorded on employee profiles when it closes.",
          body_zh: "打开评估周期即可关闭；关闭时评级写入员工档案。",
        }, "performance");
        return send(res, 200, { ok: true });
      }
      // P0 S3：部门既没提交、也没确认 → not_submitted（E 场景：未提交就退回会把员工自评提前锁住）。
      // 已确认的部门可以退回 = 撤销确认（无 HoD 的组也可以，只是不发通知）。
      if (!(st && (st.hodSubmittedAt || st.hrConfirmedAt)))
        return send(res, 400, { error: "This department hasn't been submitted or confirmed, so there is nothing to return. 该部门尚未提交或确认，无需退回。", code: "not_submitted" });
      const reason = String(body.reason || "").trim().slice(0, 1000);
      if (!reason) return send(res, 400, { error: "Give a reason for returning. 请填写退回理由。", code: "reason_required" });
      const wasConfirmed = !!st.hrConfirmedAt;
      store.upsertReviewDeptStatus(cycle.id, g.dept1Id, { dept1Name: g.dept1, hodSubmittedAt: null, hrConfirmedAt: null, hrId: null, returnedAt: new Date(nowMs()).toISOString(), returnReason: reason });
      audit("review.dept.return", cycle.id, null, { dept1: g.dept1, reason, wasConfirmed });
      if (g.hod) notify(g.hod.id, {
        type: "review", link: `/review?view=hod&cycle=${encodeURIComponent(cycle.id)}&unit=${encodeURIComponent(g.dept1Id)}`,
        title: `HR returned the calibration of ${g.dept1 || "your department"} for ${cycle.name}`, title_zh: `HR 退回了 ${g.dept1 || "本部门"} 在「${cycle.name}」的校准结果`,
        body: `Reason: ${reason}`, body_zh: `理由：${reason}`,
      });
      return send(res, 200, { ok: true });
    };
    // HR 部门明细（第二批 2.2，只读；performance 读）：同一个部门校准视图（reviewCalibView mode:"hr"）+ 部门确认列表的那一行。
    // 范围：先按 scopePredicate 收窄成员 —— 找不到该组、或整组都在范围外 → 404；部分在范围外 → 只给范围内的人，
    // view.dept.scopePartial = true，人数 / 名额 / 阻断项给 null（审查 P1-2），确认 / 退回仍由那两条接口按 404 拒绝。
    // 「校准」按钮只对 row.editable（hrCalibratable 且有绩效写权限）的行出现。
    const cycleDeptMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)\/depts\/([\w-]+)$/);
    if (cycleDeptMatch && req.method === "GET") {
      const cycle = store.getReviewCycle(cycleDeptMatch[1]);
      if (!cycle || cycle.flow !== "v2") return send(res, 404, { error: "Review cycle not found. 未找到该评估周期。", code: "cycle_not_found" });
      const snapU = orgSnapshot();
      const g = reviewGroups(cycle, store.listCycleItems(cycle.id), snapU).find((x) => x.dept1Id === cycleDeptMatch[2]);
      const scopeU = scopePredicate(user);
      const inScope = g ? (scopeU ? g.items.filter((i) => scopeU(store.getUserById(i.userId))) : g.items) : [];
      if (!g || !inScope.length) return send(res, 404, { error: "Department not found. 未找到该部门。", code: "not_found" });
      const partial = inScope.length < g.items.length;
      const view = reviewCalibView(cycle, g, snapU, {
        mode: "hr", viewer: user, partial, rowItems: inScope, allow: reviewDeptPredMemo(scopeDeptPredicate(user)), canEdit: canWrite(user, "performance"),
      });
      // 部门行与周期详情的 depts[] 同一口径：范围不全时只按范围内的人分组再算（审查：原先用整组算，人数、各档人数、
      // 超额会把范围外的人一并带出去）
      const gRow = partial ? reviewGroups(cycle, inScope, snapU).find((x) => x.dept1Id === g.dept1Id) : g;
      if (!gRow) return send(res, 404, { error: "Department not found. 未找到该部门。", code: "not_found" });
      return send(res, 200, { view, row: reviewDeptRow(cycle, gRow, user, partial) });
    }
    const deptConfirmMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)\/depts\/([\w-]+)\/confirm$/);
    if (deptConfirmMatch && req.method === "POST") return reviewDeptAct([...deptConfirmMatch, "confirm"]);
    const deptReturnMatch = pathname.match(/^\/api\/admin\/review-cycles\/([\w-]+)\/depts\/([\w-]+)\/return$/);
    if (deptReturnMatch && req.method === "POST") return reviewDeptAct([...deptReturnMatch, "return"]);
    // 评估按阶段批量提醒（2026-10-07 批量操作第二批 B6）。请求 { stage, by, ids, cycleId? }：
    //   by:"cycle" ids = 周期 id；by:"dept" ids = 一级部门 id（dept1Id，须带 cycleId）；by:"item" ids = 评估条目 id（cycleId 可选），
    //   按条目选不提供 HoD 阶段。校验顺序：阶段 → 选择方式 → 周期（须存在且进行中）→ 选中项 → 范围 → 计划 → 提交后通知与审计。
    //   范围：按条目选，任一条目的员工在范围外 → 整批 404；按部门选 HoD 阶段，组里有范围外的人 → 整批 404；
    //   其余（按周期选、按部门选自评 / 面谈 / 上级评级）收窄到范围内的人。只发通知、不改业务数据，所以不走 runBatch。
    if (pathname === "/api/admin/review-reminders" && req.method === "POST") {
      const stage = body.stage, by = body.by;
      if (!REVIEW_REMIND_STAGES.includes(stage) || (by === "item" && stage === "hod"))
        return send(res, 400, { error: "Unknown step.", error_zh: "未知的提醒步骤。", code: "bad_stage" });
      if (!REVIEW_REMIND_BY.includes(by)) return send(res, 400, { error: "Unknown selection.", error_zh: "未知的选择方式。", code: "bad_by" });
      const cycleId = typeof body.cycleId === "string" || typeof body.cycleId === "number" ? String(body.cycleId).trim() : "";
      if (by === "dept" && !cycleId) return send(res, 400, { error: "Choose a review cycle.", error_zh: "请指定评估周期。", code: "cycle_required" });
      let fixedCycle = null;
      if (cycleId) {
        fixedCycle = store.getReviewCycle(cycleId);
        if (!fixedCycle) return send(res, 404, { error: "Review cycle not found.", error_zh: "未找到该评估周期。", code: "cycle_not_found" });
        if (fixedCycle.status !== "open") return send(res, 400, { error: "This review cycle is closed.", error_zh: "该评估周期已关闭。", code: "cycle_closed" });
      }
      const ids = bulkIdList(res, body.ids); if (!ids) return;
      const remScope = scopePredicate(user);
      if (remScope && by === "item") {
        const oos = bulkOutOfScope(user, ids, (id) => {
          const it = store.getReviewItem(id);
          if (!it || (fixedCycle && it.cycleId !== fixedCycle.id)) return undefined;
          return store.getUserById(it.userId) || null;
        });
        if (oos) return sendBulkScopeReject(res, oos);
      }
      if (remScope && by === "dept" && stage === "hod") {
        const groups = reviewGroups(fixedCycle, store.listCycleItems(fixedCycle.id));
        let oos = 0;
        for (const id of ids) { const g = groups.find((x) => x.dept1Id === id); if (g && g.items.some((i) => !remScope(store.getUserById(i.userId)))) oos++; }
        if (oos) return sendBulkScopeReject(res, oos);
      }
      const plan = planReviewReminders({ stage, by, ids, fixedCycle, scope: remScope });
      emitBulkEffects("review-reminders", plan.effects, (e) => emitReviewReminder(audit, e));
      return sendBulkResult(res, plan.results, { stage, reminded: plan.effects.length, skippedPeople: plan.skippedPeople });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 14053–14074 行（/api/admin/ 块内）
    async adminPerformance3(C) {
      const { pathname, req, res, body, audit } = C;
      const { send, jobGrades, store } = S;
    if (pathname === "/api/admin/job-grades" && req.method === "GET") {
      return send(res, 200, { ranks: jobGrades() });
    }
    if (pathname === "/api/admin/job-grades" && req.method === "PUT") {
      if (!Array.isArray(body.ranks)) return send(res, 400, { error: "ranks must be an array" });
      const seen = new Set();
      const ranks = [];
      for (const r of body.ranks.slice(0, 100)) {
        const rank = String(r.rank || "").trim().slice(0, 20);
        const grade = String(r.grade || "").trim().slice(0, 10);
        const level = Number(r.level);
        const track = r.track === "P" ? "P" : "M";
        // CX-131：中英文分开；缺职级代码时写「未填」，不写「?」
        // CX-193：有职级代码时点名该行；没填职级代码时写「有一行未填职级代码」
        if (!rank || !grade || !Number.isFinite(level)) return send(res, 400, rank
          ? { error: `Row ${rank} is incomplete: rank, grade and level are all required.`, error_zh: `职级「${rank}」这一行不完整：职级代码、职级与级别都必填。`, code: "bad_row" }
          : { error: "A row has no rank code. Rank, grade and level are all required.", error_zh: "有一行未填职级代码：职级代码、职级与级别都必填。", code: "bad_row" });
        if (seen.has(rank)) return send(res, 400, { error: `Duplicate rank: ${rank}.`, error_zh: `职级代码重复：${rank}。`, code: "dup_rank" });
        seen.add(rank);
        ranks.push({ rank, grade, level: Math.round(level), track });
      }
      const before = jobGrades();
      store.setMeta("jobGradeConfig", JSON.stringify({ ranks }));
      audit("jobgrades.update", null, { count: before.length }, { count: ranks.length });
      return send(res, 200, { ok: true, ranks });
    }
      return S.ROUTE_NEXT;
    },
  };
};
