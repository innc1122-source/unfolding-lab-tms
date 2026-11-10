"use strict";
// 人才（档案记录、继任、关键岗位、人才盘点） 的接口处理（简化 10/11：从 server.js 的 handleApi 原样搬出，代码不改；按原顺序分段，server.js 在原位置依次调用）。
// 每段是一个方法：C = 本段用到的 handleApi 局部变量（req、res、user、body、audit 等）；S = server.js 的模块级函数与常量
// （getter，取调用当时的值；require / __dirname 也是 server.js 的，相对路径照旧以仓库根目录为准）。
// 段内匹配到接口时照原样 return；都没匹配到时返回 S.ROUTE_NEXT，server.js 接着往下匹配。改接口就在这里改。
module.exports = function routes(S) {
  return {
    // server.js handleApi 原第 11839–11970 行（/api/admin/ 块内）
    async adminTalent1(C) {
      const { pathname, req, res, user, requestId, audit, query, body } = C;
      const { AI, sendAiState, store, send, scopeAllowsFor, portraitArgs, aiFeatures, newToken, portraitOut, portraitFlat, sendAiRateLimited, portraitTypeLabels, sendAiError, canWrite } = S;
    const portraitMatch = pathname.match(/^\/api\/admin\/employees\/([\w-]+)\/ai-portrait$/);
    if (portraitMatch && req.method === "POST") {
      const st = AI.featureState("portrait");
      if (st.state === "off_module" || st.state === "off_owner") return sendAiState(res, st);
      // 负责人 2026-09-30 决定：有人才发展权限的 HR 即可使用画像，不再另要求员工档案（people）读权限（原 403 people_read_required）
      const u = store.getUserById(portraitMatch[1]);
      if (!u) return send(res, 404, { error: "Not found" });
      if (!scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      if (u.id === user.id) return send(res, 403, { error: "You cannot generate or confirm a talent portrait of yourself.", error_zh: "不能为本人生成或确认人才画像。", code: "ai_self_subject" });
      if (st.state !== "on" && st.state !== "demo") return sendAiState(res, st);
      const args = portraitArgs(u);
      const built = aiFeatures.buildPortrait(args);
      const now = new Date().toISOString();
      const draftId = "pt-" + newToken().slice(0, 10);
      if (st.state === "demo") {
        const stats = {};
        for (const r of store.listTalentRecords(u.id)) stats[r.type] = (stats[r.type] || 0) + 1;
        const callId = AI.recordLocal("portrait", { requestId, actorId: user.id, actorKind: "admin", subjectUserId: u.id, refId: draftId, status: "demo" });
        const draft = store.createPortrait({ id: draftId, userId: u.id, status: "draft", content: aiFeatures.portraitDemo(stats), unsupportedCount: 0, providerId: null, protocol: "demo", model: null, modelReturned: null, promptVersion: AI.VERSIONS.portrait, callId, inputDigest: built.digest, demo: 1, generatedBy: user.id, generatedAt: now });
        audit("talent.portrait", u.employeeId, null, { draftId, model: null, callId, status: "demo" });
        return send(res, 200, { demo: true, draft: portraitOut(draft), portrait: portraitFlat(draft.content) });
      }
      const rl = AI.rateHit("portrait", user.id);
      if (!rl.ok) {
        AI.recordLocal("portrait", { requestId, actorId: user.id, actorKind: "admin", subjectUserId: u.id, status: "blocked", errorCode: "ai_rate_limited" });
        return sendAiRateLimited(res, rl.retryAfterSec);
      }
      try {
        const r = await AI.call("portrait", { requestId, actorId: user.id, actorKind: "admin", subjectUserId: u.id, refId: draftId, system: built.system, messages: built.messages, schema: built.schema, redactions: built.redactions });
        const { content, unsupportedCount } = aiFeatures.processPortrait(r.json, built, portraitTypeLabels);
        const draft = store.createPortrait({
          id: draftId, userId: u.id, status: "draft", content, unsupportedCount,
          providerId: r.provenance.providerId, protocol: r.provenance.protocol, model: r.provenance.model, modelReturned: r.provenance.modelReturned,
          promptVersion: r.provenance.promptVersion, callId: r.callId, inputDigest: built.digest, demo: 0, generatedBy: user.id, generatedAt: now,
        });
        audit("talent.portrait", u.employeeId, null, { draftId, model: r.provenance.modelReturned || r.provenance.model, callId: r.callId, status: "ok" });
        return send(res, 200, { draft: portraitOut(draft), portrait: portraitFlat(content) });
      } catch (e) {
        audit("talent.portrait", u.employeeId, null, { draftId: null, model: null, callId: null, status: "error", code: (e && e.code) || "ai_upstream_error" });
        return sendAiError(res, e);
      }
    }
    // 画像的查看与处理（talent 新 gate：/api/admin/talent-portraits）。都要求 people 读权限；ai 模块或 portrait 关闭时，
    // 已确认与被替代的版本仍可只读查看，草稿不再显示，确认与丢弃返回 404。
    if (pathname === "/api/admin/talent-portraits" && req.method === "GET") {
      // 负责人 2026-09-30 决定：有人才发展权限的 HR 即可使用画像，不再另要求员工档案（people）读权限（原 403 people_read_required）
      const u = store.getUserById(String(query.get("userId") || ""));
      if (!u || !scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      const st = AI.featureState("portrait");
      const aiOn = st.state !== "off_module" && st.state !== "off_owner" && st.state !== "off_feature";
      const all = store.listPortraits(u.id);
      const current = all.find((x) => x.status === "confirmed") || null;
      let digestNow = null;
      try { digestNow = aiFeatures.portraitDigest(portraitArgs(u)); } catch { digestNow = null; }
      return send(res, 200, {
        // CX-103：AI 服务未接入 / 本月用量已满时 canGenerate=false（页面置灰并写明原因），只有 on / demo 可生成
        state: st.state, canGenerate: (st.state === "on" || st.state === "demo") && canWrite(user, "talent") && u.id !== user.id,
        self: u.id === user.id,
        current: current ? { ...portraitOut(current), inputChanged: !!(digestNow && current.inputDigest && current.inputDigest !== digestNow) } : null,
        drafts: aiOn ? all.filter((x) => x.status === "draft").map((x) => ({ ...portraitOut(x), inputChanged: !!(digestNow && x.inputDigest && x.inputDigest !== digestNow) })) : [],
        history: all.filter((x) => x.status === "superseded" || x.status === "discarded").map(portraitOut),
      });
    }
    const portraitAct = pathname.match(/^\/api\/admin\/talent-portraits\/([\w-]+)\/([\w-]+)$/);
    if (portraitAct && req.method === "POST") {
      const action = portraitAct[2];
      if (!["confirm", "discard", "objection"].includes(action)) return send(res, 404, { error: "Not found" });
      const st = AI.featureState("portrait");
      if (action !== "objection" && (st.state === "off_module" || st.state === "off_owner" || st.state === "off_feature")) return send(res, 404, { error: "Not found" });
      // 负责人 2026-09-30 决定：有人才发展权限的 HR 即可使用画像，不再另要求员工档案（people）读权限（原 403 people_read_required）
      const pt = store.getPortrait(portraitAct[1]);
      const u = pt ? store.getUserById(pt.userId) : null;
      // 先取画像、再取员工、再判范围：范围外与不存在同为裸 404，且排在任何状态检查之前
      if (!pt || !u || !scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      if (action === "confirm" && u.id === user.id) return send(res, 403, { error: "You cannot generate or confirm a talent portrait of yourself.", error_zh: "不能为本人生成或确认人才画像。", code: "ai_self_subject" });
      const now = new Date().toISOString();
      if (action === "objection") {
        if (pt.status !== "confirmed" && pt.status !== "superseded") return send(res, 409, { error: "Objections are recorded on a confirmed portrait.", error_zh: "异议记录在已确认的画像上。", code: "portrait_not_confirmed" });
        const summary = String(body.summary || "").trim().slice(0, 1000);
        const outcome = String(body.outcome || "").trim().slice(0, 500);
        if (summary.length < 2) return send(res, 400, { error: "Please summarise the employee's correction or objection.", error_zh: "请填写员工提出的更正或异议摘要。", code: "summary_required" });
        const objections = [...(pt.objections || []), { at: now, by: user.id, summary, outcome }];
        store.updatePortrait(pt.id, { objections });
        audit("talent.portrait.objection", u.employeeId, null, { portraitId: pt.id, outcome: outcome || null });
        return send(res, 200, { ok: true, portrait: portraitOut(store.getPortrait(pt.id)) });
      }
      if (pt.status !== "draft") return send(res, 409, { error: "This draft has already been handled.", error_zh: "该草稿已处理。", code: "portrait_not_draft" });
      if (action === "discard") {
        const reason = String(body.reason || "").trim().slice(0, 300) || null;
        store.updatePortrait(pt.id, { status: "discarded", content: null, discardedBy: user.id, discardedAt: now, discardReason: reason });
        audit("talent.portrait.discard", u.employeeId, null, { draftId: pt.id, reason });
        return send(res, 200, { ok: true, portrait: portraitOut(store.getPortrait(pt.id)) });
      }
      // confirm（可先编辑）：提交的正文与草稿逐条比对 —— 标为「无依据」且未改写的判断仍存在时不能确认
      if (!canWrite(user, "talent")) return send(res, 403, { error: "Forbidden" });
      let content = pt.content;
      const edited = [];
      if (body.content && typeof body.content === "object") {
        // 与草稿逐字相同的判断保留原来的依据与「无依据」标记；HR 改写或新增的判断标为 edited（由 HR 负责，不再算无依据）
        const src = body.content;
        const txt = (v) => String(v == null ? "" : v).slice(0, 4000);
        const sameAs = (o, it) => !!o && o.text === txt(it && it.text) && o.text_zh === txt(it && it.text_zh);
        const take = (it, candidates) => {
          const hit = candidates.find((o) => sameAs(o, it));
          return hit ? { ...hit } : { text: txt(it && it.text), text_zh: txt(it && it.text_zh), evidence: [], unsupported: false, edited: true };
        };
        for (const k of ["strengths", "risks", "development"]) {
          const orig = pt.content[k] || [];
          if (!Array.isArray(src[k])) continue;
          const next = src[k].slice(0, 12).map((it) => take(it, orig)).filter((x) => x.text.trim() || x.text_zh.trim());
          if (JSON.stringify(next.map((x) => [x.text, x.text_zh])) !== JSON.stringify(orig.map((x) => [x.text, x.text_zh]))) edited.push(k);
          content = { ...content, [k]: next };
        }
        if (src.summary) {
          const next = take(src.summary, [pt.content.summary]);
          if (next.edited) edited.push("summary");
          content = { ...content, summary: next };
        }
        if (src.readiness) {
          const levels = ["ready_now", "one_year", "two_years", "not_yet", "insufficient_evidence"];
          const next = { ...take(src.readiness, [pt.content.readiness]), level: levels.includes(src.readiness.level) ? src.readiness.level : pt.content.readiness.level };
          if (next.edited || next.level !== pt.content.readiness.level) edited.push("readiness");
          content = { ...content, readiness: next };
        }
      }
      const unsupported = [content.summary, content.readiness, ...(content.strengths || []), ...(content.risks || []), ...(content.development || [])].filter((x) => x && x.unsupported).length;
      if (unsupported > 0) return send(res, 400, { error: `${unsupported} judgement(s) have no supporting record. Delete or rewrite them before confirming.`, error_zh: `有 ${unsupported} 条判断没有依据，请先删除或改写后再确认。`, code: "portrait_unsupported", unsupported });
      store.updatePortrait(pt.id, { status: "confirmed", content, unsupportedCount: 0, confirmedBy: user.id, confirmedAt: now });
      store.supersedeConfirmedPortraits(u.id, pt.id);
      store.prunePortraitHistory(u.id, 5);
      audit("talent.portrait.confirm", u.employeeId, null, { draftId: pt.id, editedFields: edited, unsupported: pt.unsupportedCount || 0 });
      return send(res, 200, { ok: true, portrait: portraitOut(store.getPortrait(pt.id)) });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 12001–12138 行（/api/admin/ 块内）
    async adminTalent2(C) {
      const { pathname, req, res, user, body, recordPeriodHasCycleRecord, RECORD_PERIOD_HAS_CYCLE_ERR, auditAuth, audit } = C;
      const { store, send, scopeAllowsFor, resolveRecordType, recordTypeModuleOff, RECORD_TYPE_UNAVAILABLE, validDateStr, getProgram, buildRecordDetail, recordSyncsDepartment, scopeAllowsDeptFor, sendScopeDeptReject, runBatch, applyRecordSideEffects, newToken, deriveRecordTitle, sendRecordSaveFailed, afterCommit, scopePredicate, sendScopeBulkReject, modulesOn, bulkFaultPoint, sendBatchFailed, isSuperAdmin, appealErr } = S;
    const recPost = pathname.match(/^\/api\/admin\/employees\/([\w-]+)\/records$/);
    if (recPost && req.method === "POST") {
      const u = store.getUserById(recPost[1]);
      if (!u) return send(res, 404, { error: "Not found" });
      // P2 范围：这条端点有副作用（applyRecordSideEffects 会改 users 主数据、离职还会
      // 踢会话），所以必须在任何副作用之前卡住 —— 404，与「不存在」同形。
      if (!scopeAllowsFor(user, u)) return send(res, 404, { error: "Not found" });
      const t = resolveRecordType(body.type);
      if (!t || !t.active) return send(res, 400, { error: "Unknown record type" });
      if (recordTypeModuleOff(t.key)) return send(res, 400, RECORD_TYPE_UNAVAILABLE);   // 所属模块关闭（见 RECORD_TYPE_MODULE）
      const date = String(body.date || "").slice(0, 10);
      if (!validDateStr(date)) return send(res, 400, { error: "Date must be YYYY-MM-DD" });
      if (body.programId && !getProgram(body.programId)) return send(res, 400, { error: "Unknown program" });
      const built = buildRecordDetail(t.key, body.fields || {});
      if (built.error) return send(res, 400, { error: built.error, code: built.code, field: built.field });
      // 第二批 2.6 护栏（审查 P0-5，2026-10-08）：同一期已有评估周期归档的绩效记录 → 不能再新建一条（那等于不写理由、
      // 不留修改痕迹地改评级，员工端还会看到同一期两条）。请编辑原记录并写明理由。
      if (t.key === "performance" && recordPeriodHasCycleRecord(u.id, built.detail))
        return send(res, 409, RECORD_PERIOD_HAS_CYCLE_ERR);
      // CX-168：不能给本人新增绩效记录（与修改评级同一护栏 rating_self_amend；超级管理员例外，同现行规则）
      if (t.key === "performance" && u.id === user.id && !isSuperAdmin(user)) return appealErr(res, "rating_self_amend");
      // P2 范围：一条调动记录会把主体**搬到 toDept**（还会 ensureDepartment 造部门），
      // 所以目标部门必须在范围内 —— 否则「给自己范围内的人写一条调动」就是把人推出
      // 范围的第三条路径。不带 syncDept 的历史记录不受影响（它不改主数据）。
      const recSyncDept = recordSyncsDepartment(t.key, built.detail);
      if (recSyncDept !== null && !scopeAllowsDeptFor(user, recSyncDept)) return sendScopeDeptReject(res);
      // 主数据副作用与记录本身同一笔事务：记录写失败（例如脚本持写锁）时人不会已经被调走 /
      // 离职、事件也不会已经进了发件箱；事件在提交之后才分发，订阅方收到时记录已在库里。
      // 会话被吊销的审计在提交之后写（afterCommit）。
      const revoked = [];
      const saved = runBatch(() => {
        applyRecordSideEffects(u.id, t.key, built.detail, (uid) => revoked.push(uid));
        return store.createTalentRecord({
          id: "tr-" + newToken().slice(0, 10), userId: u.id, type: t.key, date,
          title: String(body.title || "").trim().slice(0, 200) || deriveRecordTitle(t.key, built.detail),
          detail: built.detail, programId: body.programId || null, createdBy: user.id,
        });
      });
      if (!saved.ok) return sendRecordSaveFailed(res, "records/create", saved.error);
      const rec = saved.value;
      afterCommit("records/create", () => {
        for (const uid of revoked) {
          const kicked = store.getUserById(uid);
          auditAuth("auth.sessions_revoked", user, kicked ? kicked.employeeId : uid, { reason: "exited" });
        }
        audit("talent.record.create", u.employeeId, null, { type: t.key, date, title: rec.title, synced: !!built.detail.synced });
      });
      return send(res, 200, { ok: true, record: rec });
    }
    // Bulk import of historical records (Excel paste, header-mapped by the UI).
    // MUST be matched before the records/:rid regex — "bulk" parses as an rid.
    if (pathname === "/api/admin/records/bulk" && req.method === "POST") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return send(res, 400, { error: "No rows to import." });
      // Cap like bulk-update: NEVER truncate silently (this used to slice(0, 1000)
      // and drop the tail of the paste with a 200). Over the cap → whole batch
      // rejected before anything is written. Shares LMS_BULK_CAP (default 10000).
      const recCapRaw = Math.floor(Number(process.env.LMS_BULK_CAP));
      const recCap = Number.isFinite(recCapRaw) && recCapRaw > 0 ? recCapRaw : 10000;
      if (rows.length > recCap)
        return send(res, 400, {
          error: `Pasted ${rows.length} rows, but one import is capped at ${recCap} — split the sheet and import in smaller batches. `
            + `本次粘贴 ${rows.length} 行，单次上限 ${recCap} 行：请拆分表格分批导入。`,
          code: "over_cap", selected: rows.length, cap: recCap,
        });
      // P2 范围：逐条解析主体（按工号）后校验，任一越界 → 整批拒绝（设计选择①）。
      const recBulkScope = scopePredicate(user);
      if (recBulkScope) {
        let outOfScope = 0;
        for (const r of rows) {
          const eid = String((r || {}).employeeId || "").trim();
          const who = eid ? store.getUserByEmployeeId(eid) : null;
          if (who && !recBulkScope(who)) outOfScope++;   // 查无此工号仍按原样逐行 skipped
        }
        if (outOfScope) return sendScopeBulkReject(res, outOfScope);
      }
      // 原子性：整批一个事务（runBatch）。逐行校验问题照旧 skipped；任何一行抛异常 →
      // 整批回滚、回 batch_failed + 行号。按工号查人走 lower(employeeId) 表达式索引
      // （migration 47），不再是每行一次全表扫描。
      const batch = runBatch((cur) => {
        const results = [];
        let line = 0;
        // 事务内（同步、无 await）记录类型与字段配置不会变化：按「类型写法」与类型 key 各
        // 只解析 / 读取一次。原来每行都要 listRecordTypes + listRecordFields 两次整表读取
        // 外加 JSON 解析，3,000 行的事务阶段因此多占事件循环一两秒。
        const typeMemo = new Map(), fieldMemo = new Map();
        const typeOf = (v) => {
          const k = String(v || "").trim().toLowerCase();
          if (!typeMemo.has(k)) typeMemo.set(k, resolveRecordType(v));
          return typeMemo.get(k);
        };
        const fieldsOf = (key) => {
          if (!fieldMemo.has(key)) fieldMemo.set(key, store.listRecordFields(key));
          return fieldMemo.get(key);
        };
        const bulkMods = modulesOn();   // 模块开关整批读一次（所属模块关闭的类型逐行 skipped，见 RECORD_TYPE_MODULE）
        const archivedMemo = new Map();   // 每人已归档的周期绩效记录（period_has_cycle_record 护栏）
        for (const r0 of rows) {
          line++;
          cur.line = line;
          bulkFaultPoint(line);
          const r = r0 && typeof r0 === "object" ? r0 : {};
          const employeeId = String(r.employeeId || "").trim();
          const u = employeeId ? store.getUserByEmployeeId(employeeId) : null;
          if (!u) { results.push({ line, employeeId, status: "skipped", reason: "no such employee 查无此工号" }); continue; }
          const t = typeOf(r.type);
          if (!t) { results.push({ line, employeeId, status: "skipped", reason: "unknown type 未知类型" }); continue; }
          if (recordTypeModuleOff(t.key, bulkMods)) { results.push({ line, employeeId, status: "skipped", reason: "record type's module is switched off 该记录类型所属的模块未开启", code: RECORD_TYPE_UNAVAILABLE.code }); continue; }
          const date = String(r.date || "").slice(0, 10);
          if (!validDateStr(date)) { results.push({ line, employeeId, status: "skipped", reason: "invalid date (YYYY-MM-DD)" }); continue; }
          const built = buildRecordDetail(t.key, r.fields || {}, fieldsOf(t.key));
          // Forward buildRecordDetail's machine-readable pair alongside the text:
          // `reason` stays the half-Chinese sentence the client prints today (and
          // the tests assert on), while code + field let the import report build a
          // properly localized message from its own dictionary + the field config.
          if (built.error) { results.push({ line, employeeId, status: "skipped", reason: built.error, code: built.code, field: built.field }); continue; }
          const title = String(r.title || "").trim().slice(0, 200) || deriveRecordTitle(t.key, built.detail);
          // 第二批 2.6 护栏（审查 P0-5）：同一期已有评估周期归档的绩效记录 → 逐行跳过（导入的统一口径），码 period_has_cycle_record
          if (t.key === "performance" && recordPeriodHasCycleRecord(u.id, built.detail, archivedMemo)) {
            results.push({ line, employeeId, status: "skipped", reason: RECORD_PERIOD_HAS_CYCLE_ERR.error, code: RECORD_PERIOD_HAS_CYCLE_ERR.code });
            continue;
          }
          if (store.talentRecordExists(u.id, t.key, date, title)) {
            results.push({ line, employeeId, status: "skipped", reason: "duplicate 重复" });
            continue;
          }
          // Historical import never touches current master data (no side effects).
          store.createTalentRecord({ id: "tr-" + newToken().slice(0, 10), userId: u.id, type: t.key, date, title, detail: built.detail, programId: null, createdBy: user.id });
          results.push({ line, employeeId, name: u.name, status: "created" });
        }
        return results;
      });
      if (!batch.ok) return sendBatchFailed(res, "records/bulk", batch);
      const results = batch.value;
      afterCommit("records/bulk", () => audit("talent.record.bulk-import", null, null, {
        created: results.filter((r) => r.status === "created").length,
        skipped: results.filter((r) => r.status === "skipped").length,
      }));
      return send(res, 200, { results });
    }
      return S.ROUTE_NEXT;
    },
    // server.js handleApi 原第 14077–14704 行（/api/admin/ 块内）
    async adminTalent3(C) {
      const { pathname, req, res, body, user, audit, query, requestId } = C;
      const { store, send, promotionConfig, optionsZhOf, canonOption, promotionFilter, FM, tfContext, trScopeOfQuery, tfPromotionRun, scopePredicate, keyPositionVacancies, scopeAllowsFor, SUCC_IMPORT, succLookups, sendScopeBulkReject, runBatch, sendBatchFailed, afterCommit, SUCC_READINESS, tfIdList, tfScopeCheck, trScopeSplit, trScopeOfBody, orgLib, KP, kpResolveDept, scopeAllowsDeptFor, kpRowAllows, kpSuccessorOk, kpVisible, canWrite, kpErr, kpDeptById, kpDeptNameOf, modulesOn, nineBoxRows, resolveRecordType, recordTypeModuleOff, RECORD_TYPE_UNAVAILABLE, tfCatalogOut, canExportTalentRecords, RECORDS_EXPORT_FORBIDDEN, tfVisible, tfInvalid, tfSortOf, tfExecute, tfRedact, FE, todayLocal, csvText, tfRowOut, AI, sendAiState, AI_TF, sendAiRateLimited, aiFeatures, aiRoster, sendAiError, tfFilterOut, crypto } = S;
    if (pathname === "/api/admin/promotion-config" && req.method === "GET") {
      const f = store.listRecordFields("performance").find((x) => x.key === "rating");
      return send(res, 200, { config: promotionConfig(), ratingOptions: f ? f.options : [], ratingOptions_zh: f ? optionsZhOf(f) : [] });
    }
    if (pathname === "/api/admin/promotion-config" && req.method === "PUT") {
      // 第五批：五项配置写回内置筛选「晋升评审候选」带标签的叶子（applyPromotionConfig 只增删改这几条，HR 在筛选里自己加的
      // 条件原样保留），version + 1；meta promotionConfig 同步写一份（回退版本时还能用）。校验与旧版相同。
      const cur = promotionConfig();
      // patch = 这次请求明确给出的键（applyPromotionConfig 只覆盖这些；HR 在筛选里调过的期数等其余参数保留）
      const patch = {};
      // `ladder` is gone: the next level is derived from the job-grade catalogue
      // (same track, next Level up), so a hand-maintained ladder could only ever
      // disagree with it. It was still accepted and stored here while nothing
      // read it — a setting that silently does nothing is worse than no setting.
      const ratingKey = (key) => {
        if (body[key] === undefined) return null;
        const f = store.listRecordFields("performance").find((x) => x.key === "rating");
        const opts = f ? f.options : [];
        // Stored in meta and later compared with opts.indexOf(), so it has to be
        // the canonical value even if the settings screen was in Chinese. "" means
        // "no minimum"; an unrecognized value must 400 rather than quietly become
        // "" and switch the whole gate off.
        const rawMin = String(body[key] || "").trim();
        const v = rawMin ? canonOption(f || {}, rawMin) : "";
        if (rawMin && (v === null || (opts.length && !opts.includes(v)))) return `${key} must be one of the configured rating options`;
        patch[key] = v;
        return null;
      };
      for (const key of ["minRating", "windowMinRating"]) { const err = ratingKey(key); if (err) return send(res, 400, { error: err }); }
      if (body.minTenureMonths !== undefined) patch.minTenureMonths = Math.max(0, Math.min(240, Number(body.minTenureMonths) || 0));
      if (body.requireTrainings !== undefined) patch.requireTrainings = !!body.requireTrainings;
      if (body.noMajorViolationMonths !== undefined) patch.noMajorViolationMonths = Math.max(0, Math.min(120, Number(body.noMajorViolationMonths) || 0));
      if (body.violationMajorOnly !== undefined) patch.violationMajorOnly = !!body.violationMajorOnly;
      // F62 新增：近 N 期（1–8）、过去 N 个月时间窗（0–120）、现职级任职时长（0–240）
      if (body.minRatingPeriods !== undefined) patch.minRatingPeriods = Math.max(1, Math.min(8, Math.round(Number(body.minRatingPeriods) || 1)));
      if (body.windowMonths !== undefined) patch.windowMonths = Math.max(0, Math.min(120, Number(body.windowMonths) || 0));
      if (body.minLevelTenureMonths !== undefined) patch.minLevelTenureMonths = Math.max(0, Math.min(240, Number(body.minLevelTenureMonths) || 0));
      const next = { ...cur, ...patch };
      delete next.ladder;
      const pf = promotionFilter();
      if (pf) {
        const def = FM.applyPromotionConfig(pf.definition, patch);
        const saved = store.updateTalentFilter(pf.id, { definition: def }, pf.version, user.id);
        if (!saved) return send(res, 409, { error: "The promotion conditions were changed by someone else — refresh and try again.", error_zh: "晋升评审候选条件已被他人修改，请刷新后再改。", code: "filter_conflict" });
        const out = FM.promotionConfigOf(saved.definition);
        store.setMeta("promotionConfig", JSON.stringify(out));
        audit("promotion.config", null, cur, out);
        return send(res, 200, { ok: true, config: out });
      }
      store.setMeta("promotionConfig", JSON.stringify(next));
      audit("promotion.config", null, cur, next);
      return send(res, 200, { ok: true, config: next });
    }
    // Who qualifies for their NEXT level under the current rule set — the
    // quantified entry gate to the defense (答辩) pool.
    // 第五批：由引擎跑内置筛选「晋升评审候选」（explain，基础人群每人一行），响应形状不变并多给 filterId、rows[].member、
    // rows[].explain（每条条件的命中：叶子 id → true / false / null，null = 该条被忽略）。checks 由带标签叶子的命中映射成旧键；
    // eligible = 最终结果，已计入人工名单（手动加入 / 排除）。不在职级体系内的人只进 unmapped，不进 rows（手动加入的除外）。
    // performance / learning 关闭时对应的叶子整条忽略（与旧版「门槛整条跳过」相同，MODULES.md §4.1/P8），gatesSkipped 照旧给出。
    // P2 范围：rows 与 unmapped 都来自同一个已按范围过滤的基础人群（tfContext.population），没有第二处口径。
    if (pathname === "/api/admin/promotion-candidates" && req.method === "GET") {
      const rf = store.listRecordFields("performance").find((x) => x.key === "rating");
      const ratingOptions = rf ? rf.options : [];
      const ratingOptions_zh = rf ? optionsZhOf(rf) : ratingOptions;
      // F60：顶部筛选（地址栏参数）收窄基础人群 → rows 与 unmapped 同时只含范围内的人
      const t = tfContext(user, { page: trScopeOfQuery(user, query) });
      // F62：候选名单按规则自己的时间范围算（近 2 期 / 近 12 个月），不跟随页面的「绩效来源」（trScopeOfQuery 只收窄人群，不带周期）
      const p = tfPromotionRun(t, { columns: ["nextLevel", "latestRating", "recentRatings", "tenure", "levelTenure", "trainingMandatory"], sort: FM.PROMO_SORT, all: true, explain: true, includeUnmatched: true, computeUnmapped: true });
      const defaultsPending = store.getMeta("promotionDefaultsPending") === "92";
      if (!p) return send(res, 200, { rows: [], unmapped: [], config: promotionConfig(), gatesSkipped: { rating: false, trainings: false, ratingWindow: false }, ratingOptions, ratingOptions_zh, filterId: null, defaultsPending });
      const tagId = {};
      FM.walkLeaves(p.def, (leaf) => { if (leaf.tag && !tagId[leaf.tag]) tagId[leaf.tag] = leaf.id; });
      const skippedIds = new Set((p.r.skipped || []).map((s) => s.id));
      const unmappedIds = new Set((p.r.unmapped || []).map((u) => u.id));
      // 没有这条带标签的叶子（HR 删了）或该叶子被忽略 → 视为通过，与旧版「未设门槛 / 门槛跳过」同义
      const ok = (row, tag) => { const id = tagId[tag]; if (!id) return true; const h = row.hits ? row.hits[id] : null; return h === null || h === undefined ? true : !!h; };
      const rows = p.r.rows.filter((row) => !unmappedIds.has(row.id) || row.member === "include").map((row) => {
        const u = t.byId.get(row.id) || {};
        const c = row.values || {};
        const tm = c.trainingMandatory || { done: 0, total: 0 };
        return {
          id: row.id, name: row.name, employeeId: row.employeeId, department: u.department || null,
          jobLevel: u.jobLevel || null, nextLevel: c.nextLevel === undefined ? null : c.nextLevel,
          eligible: !!row.matched, member: row.member || null, explain: row.hits || {},
          checks: {
            // CX-074：「近 N 期任一期 ≥ X」达标的可能是上一期 —— 同时给出规则涉及的近 N 期（N 取规则自己的期数），页面并列显示
            rating: { ok: ok(row, "rating"), value: c.latestRating === undefined ? null : c.latestRating, values: Array.isArray(c.recentRatings) ? c.recentRatings : null },
            // F62：过去 N 个月无低于 X；现职级任职时长（月）
            ratingWindow: { ok: ok(row, "ratingWindow") },
            levelTenure: { ok: ok(row, "levelTenure"), months: c.levelTenure === undefined ? null : c.levelTenure },
            tenure: { ok: ok(row, "tenure"), months: c.tenure === undefined ? null : c.tenure },
            trainings: { ok: ok(row, "trainings"), passed: tm.done, total: tm.total },
            violations: { ok: ok(row, "violations") },
          },
        };
      });
      const gatesSkipped = { rating: !!tagId.rating && skippedIds.has(tagId.rating), trainings: !!tagId.trainings && skippedIds.has(tagId.trainings),
        ratingWindow: !!tagId.ratingWindow && skippedIds.has(tagId.ratingWindow) };
      return send(res, 200, {
        rows, unmapped: p.r.unmapped || [], config: FM.promotionConfigOf(p.f.definition), gatesSkipped, ratingOptions, ratingOptions_zh,
        filterId: p.f.id, explainHeads: p.r.explainHeads || [], skipped: p.r.skipped || [], warnings: p.r.warnings || [], defaultsPending,
      });
    }
    // Succession plans: key position → candidates + readiness.
    if (pathname === "/api/admin/succession" && req.method === "GET") {
      /* P2 范围：这个响应有三个人员载荷，三个都要收 ——
           · rows[]      → 按继任人（sx.userId）的部门**过滤**；
           · vacancies[] → 按在任者（keyRoles 的 holder）的部门**过滤**（每条含在任者
                           姓名/部门/直属数，是「谁在管这个岗、手下几个人」的现成情报）；
           · keyRoleCount→ **重算**（它是 vacancies 的分母，不重算就是「12 个关键岗
                           有 1 个空缺」这种自相矛盾的卡片）。
         做法仍是在**基础人群**上过滤一次：directCount 与 keyRoles 都建在过滤后的 all 上，
         所以「关键岗 = 手下有人」这个定义在范围内重新成立（范围内的经理若直属全在范围外，
         他就不再算关键岗 —— 这是重算的应有之义，不是 bug）。 */
      const succScope = scopePredicate(user);
      // F60：顶部筛选按继任人收窄 rows[]；关键岗位一个不少（positions[]，只来自数据范围内的继任行），每个岗位给出范围内继任者人数。
      // vacancies / keyRoleCount 仍按数据范围（工作台口径），不随页面筛选变。
      const succPage = trScopeOfQuery(user, query);
      const succAll = store.listSuccession().filter((sx) => !succScope || succScope(store.getUserById(sx.userId)));
      const succPositions = new Map();
      for (const sx of succAll) {
        if (!succPositions.has(sx.positionName)) succPositions.set(sx.positionName, { positionName: sx.positionName, total: 0, inScope: 0 });
        const pz = succPositions.get(sx.positionName);
        pz.total++;
        if (!succPage.pred || succPage.pred(store.getUserById(sx.userId))) pz.inScope++;
      }
      const rows = succAll.filter((sx) => !succPage.pred || succPage.pred(store.getUserById(sx.userId))).map((sx) => {
        const u = store.getUserById(sx.userId);
        return {
          ...sx,
          name: u ? u.name : "?", employeeId: u ? u.employeeId : "?",
          jobLevel: u ? u.jobLevel || null : null, department: u ? u.department || null : null,
          active: u ? u.active !== 0 : false,
        };
      });
      // A succession plan earns its keep by showing the roles with NOBODY lined
      // up, and those produce no rows of their own. "Key role" = someone who
      // manages people; a vacancy is one with no active named successor.
      const named = new Map();
      for (const sx of succAll) { const su = store.getUserById(sx.userId); if (su && su.active !== 0) named.set(sx.positionName, (named.get(sx.positionName) || 0) + 1); }
      // One pass to count direct reports, then one pass to pick key roles —
      // nesting the two turned this into an O(n²) scan of the whole roster.
      const all = store.listUsers().filter((u) => !succScope || succScope(u));
      const directCount = new Map();
      for (const k of all) {
        if (!k.managerId || k.active === 0 || k.empStatus === "exited") continue;
        directCount.set(k.managerId, (directCount.get(k.managerId) || 0) + 1);
      }
      const keyRoles = new Map();
      for (const u of all) {
        if (u.role === "admin" || u.active === 0 || u.empStatus === "exited") continue;
        const directs = directCount.get(u.id) || 0;
        if (!directs) continue;
        const role = u.position || u.jobLevel || u.name;
        if (!keyRoles.has(role)) keyRoles.set(role, { positionName: role, holder: u.name, holderId: u.id, department: u.department || null, directs });
      }
      const vacancies = [...keyRoles.values()].filter((k) => !named.get(k.positionName)).map((k) => ({ ...k, successors: 0 }));
      // Array-shaped for the callers that already do `q.data || []`; the extra
      // analysis rides along as non-enumerable-ish extra properties on it, so
      // adding this could not break an existing consumer.
      // F60：?withPositions=1 时改回对象 { rows, positions, scoped }（人才盘点「继任计划」页签用：关键岗位行全部保留，
      // positions[].inScope = 范围内继任者人数）。不带这个参数的调用方照旧拿数组。
      // 12.2：关键岗位清单非空时空缺与分母改用清单（与工作台继任覆盖率同一分母）；清单为空沿用上面的推断。
      // 数组上的附加属性不会被 JSON.stringify 序列化，所以下面 payload.vacancies / keyRoleCount 实际到不了前端（既有问题）；
      // ?vacancies=1 时以对象 { vacancies, keyRoleCount, source } 返回（source = keyPositions | inferred），供继任页与测试读取。
      const kpVac = keyPositionVacancies(user, all, directCount);
      const vacOut = kpVac ? kpVac.vacancies : vacancies, keyRoleOut = kpVac ? kpVac.keyRoleCount : keyRoles.size;
      // CX-018（2026-10-09 验收第二轮）：withPositions=1 的对象也带 vacancies / keyRoleCount / source（原来提前返回把它们漏掉了）
      // CX-099：录入行的「关键岗位」下拉要能选到清单里的关键岗位（含空缺岗位）—— keyPositions = 数据范围内清单上标为关键的岗位名
      if (query.get("withPositions") === "1") return send(res, 200, { rows, positions: [...succPositions.values()], scoped: succPage.active, vacancies: vacOut, keyRoleCount: keyRoleOut, source: kpVac ? "keyPositions" : "inferred",
        keyPositions: kpVisible(user).filter((p) => p.isKey).map((p) => p.name) });
      if (query.get("vacancies") === "1") return send(res, 200, { vacancies: vacOut, keyRoleCount: keyRoleOut, source: kpVac ? "keyPositions" : "inferred" });
      const payload = rows.slice();
      payload.vacancies = vacOut;
      payload.keyRoleCount = keyRoleOut;
      return send(res, 200, payload);
    }
    if (pathname === "/api/admin/succession" && req.method === "POST") {
      // CX-106：超长回 400（原来静默截到 80 字），与 /succession/bulk 同一校验与文案；CX-098：同一「岗位 + 继任人」已在名单里回 409 already_listed
      // （导入按 update 处理、批量加入逐人跳过 already_listed，单条录入原来会再插一行）。岗位名按原写法保存（判重按 positionKey，只差大小写、空格、连字符算同一岗位）。
      const rawPos = String(body.positionName || "").replace(/\s+/g, " ").trim();
      if (!rawPos) return send(res, 400, { error: "Choose or enter a key position.", error_zh: "请选择或填写关键岗位。", code: "position_required" });
      if (rawPos.length > SUCC_IMPORT.POSITION_MAX) return send(res, 400, { error: `The key position can be at most ${SUCC_IMPORT.POSITION_MAX} characters.`, error_zh: `关键岗位最多 ${SUCC_IMPORT.POSITION_MAX} 字。`, code: "position_too_long" });
      const u = body.userId ? store.getUserById(body.userId) : null;
      const SUCC_NO_USER = { error: "Choose a successor. The employee was not found or is outside your data scope.", error_zh: "请选择继任人：找不到该员工，或其不在你的数据范围内。", code: "successor_not_found" };
      if (!u) return send(res, 400, SUCC_NO_USER);
      // P2 范围：单人主体（把某个人挂成继任人）。同形的对象必须是**这条 handler 自己的
      // 「查无此人」出口** —— 它是上面那句 400，不是别处的 404。回 404 反而与本 handler
      // 的任何分支都不同形，等于用应答码确认「这个 id 有人」。与 learning 域的
      // POST /api/admin/assignments 同一条推理。
      if (!scopeAllowsFor(user, u)) return send(res, 400, SUCC_NO_USER);
      if (!SUCC_READINESS.includes(body.readiness)) return send(res, 400, { error: "Choose a readiness level.", error_zh: "请选择就绪度。", code: "readiness_invalid" });
      const note = String(body.note || "").trim();
      if (note.length > SUCC_IMPORT.NOTE_MAX) return send(res, 400, { error: `Notes can be at most ${SUCC_IMPORT.NOTE_MAX} characters.`, error_zh: `备注最多 ${SUCC_IMPORT.NOTE_MAX} 字。`, code: "note_too_long" });
      const key = FM.positionKey(rawPos);
      const samePos = store.listSuccession().filter((sx) => FM.positionKey(sx.positionName) === key);
      const dup = samePos.find((sx) => sx.userId === u.id);
      if (dup) return send(res, 409, { error: "This employee is already on the succession list for this position. Change the readiness in the list instead.", error_zh: "该员工已在这个岗位的继任名单中，请在名单里调整就绪度。", code: "already_listed", id: dup.id });
      const positionName = rawPos;
      const row = store.addSuccession({ positionName, userId: u.id, readiness: body.readiness, note: note || null, createdBy: user.id, source: "manual" });
      audit("succession.add", positionName, null, { successor: u.employeeId, readiness: body.readiness });
      return send(res, 200, { ok: true, entry: row });
    }
    // ---------- 第五批 8.2 继任计划批量导入（设计 9.3、9.4）与 7.1 批量加入继任名单 ----------
    // 这三条必须写在 succMatch（/succession/:id，只接 PUT / DELETE）之前；RBAC order 705–707 也排在 710 之前。三条都要 talent 写。
    // 预览：服务端逐行校验（modules/talent/succession-import.js），返回每行的动作与校验码，不写库。范围外、查无此人的行只回填写的原文。
    if (pathname === "/api/admin/succession/import/preview" && req.method === "POST") {
      if (!Array.isArray(body.rows) || !body.rows.length) return send(res, 400, { error: "The file has no data rows.", error_zh: "文件中没有数据行。", code: "no_rows" });
      const t = tfContext(user);
      const v = SUCC_IMPORT.validateRows(body.rows, succLookups(t));
      if (v.error) return send(res, 400, { error: `At most ${v.error.cap} rows per import (this file has ${v.error.count}).`, error_zh: `每次最多导入 ${v.error.cap} 行（本文件 ${v.error.count} 行）。`, code: "over_cap", cap: v.error.cap, count: v.error.count });
      return send(res, 200, { rows: v.rows, summary: v.summary, previewHash: v.previewHash });
    }
    // 提交：重新校验 → 哈希与预览不一致回 409 preview_stale（预览后数据变了，页面自动重新预览）→ 有范围外的行整批拒绝 →
    // create / update 在一个事务里写入（error 行跳过，确认弹窗已写明数量）→ 审计 succession.import。
    if (pathname === "/api/admin/succession/import" && req.method === "POST") {
      if (!Array.isArray(body.rows) || !body.rows.length) return send(res, 400, { error: "The file has no data rows.", error_zh: "文件中没有数据行。", code: "no_rows" });
      const t = tfContext(user);
      const v = SUCC_IMPORT.validateRows(body.rows, succLookups(t));
      if (v.error) return send(res, 400, { error: `At most ${v.error.cap} rows per import (this file has ${v.error.count}).`, error_zh: `每次最多导入 ${v.error.cap} 行（本文件 ${v.error.count} 行）。`, code: "over_cap", cap: v.error.cap, count: v.error.count });
      if (String(body.previewHash || "") !== v.previewHash)
        return send(res, 409, { error: "The data changed after the preview — the preview has been refreshed. Check it and import again.", error_zh: "预览之后数据已有变化，请重新预览核对后再导入。", code: "preview_stale" });
      if (v.outOfScope > 0) return sendScopeBulkReject(res, v.outOfScope);
      const batch = runBatch((cur) => {
        let created = 0, updated = 0;
        for (const w of v.writes) {
          cur.line = w.line;
          if (w.action === "create") { store.addSuccession({ positionName: w.positionName, userId: w.userId, readiness: w.readiness, note: w.note, createdBy: user.id, source: "import" }); created++; }
          else if (w.action === "update") { store.updateSuccession(w.existingId, { readiness: w.readiness, note: w.note }); updated++; }
        }
        return { created, updated };
      });
      if (!batch.ok) return sendBatchFailed(res, "succession.import", batch);
      const out = { created: batch.value.created, updated: batch.value.updated, unchanged: v.summary.unchanged, skipped: v.summary.error };
      afterCommit("succession.import audit", () => audit("succession.import", null, null, {
        ...out, entries: v.rows.map((r) => ({ line: r.line, position: r.positionName, employeeId: r.employeeId, action: r.action })),
      }));
      return send(res, 200, out);
    }
    // 7.1 批量加入继任名单（人才筛选结果多选）：有一人在范围外（或查无此人）整批拒绝；同一岗位已有（岗位名按 positionKey 比较）
    // → already_listed，已离职或停用 → inactive，逐人跳过；其余在一个事务里写入，source = filter。
    if (pathname === "/api/admin/succession/bulk" && req.method === "POST") {
      const rawPos = String(body.positionName || "").replace(/\s+/g, " ").trim();
      if (!rawPos) return send(res, 400, { error: "Choose or enter a key position.", error_zh: "请选择或填写关键岗位。", code: "position_required" });
      if (rawPos.length > SUCC_IMPORT.POSITION_MAX) return send(res, 400, { error: `The key position can be at most ${SUCC_IMPORT.POSITION_MAX} characters.`, error_zh: `关键岗位最多 ${SUCC_IMPORT.POSITION_MAX} 字。`, code: "position_too_long" });
      if (!SUCC_READINESS.includes(body.readiness)) return send(res, 400, { error: "Choose a readiness level.", error_zh: "请选择就绪度。", code: "readiness_invalid" });
      const note = String(body.note || "").trim();
      if (note.length > SUCC_IMPORT.NOTE_MAX) return send(res, 400, { error: `Notes can be at most ${SUCC_IMPORT.NOTE_MAX} characters.`, error_zh: `备注最多 ${SUCC_IMPORT.NOTE_MAX} 字。`, code: "note_too_long" });
      const ids = tfIdList(res, body.userIds, FM.LIMITS.memberBatch);
      if (!ids) return;
      const t = tfContext(user);
      const chk = tfScopeCheck(t, ids);
      if (chk.bad) return sendScopeBulkReject(res, chk.bad);
      const lk = succLookups(t);
      // 与已有关键岗位只差大小写、空格或连字符时沿用已有写法（同导入的 position_merged）
      const key = FM.positionKey(rawPos);
      const canon = lk.existing.find((s) => FM.positionKey(s.positionName) === key) || null;
      const positionName = canon ? canon.positionName : rawPos;
      const listed = new Set(store.listSuccession().filter((s) => FM.positionKey(s.positionName) === key).map((s) => s.userId));
      // F60：页面顶部筛选（body.scope）之外的人逐人跳过（out_of_view）
      const view = trScopeSplit(trScopeOfBody(user, body), chk.users);
      const skipped = view.skipped.slice(), todo = [];
      for (const u of view.users) {
        if (listed.has(u.id)) skipped.push({ userId: u.id, employeeId: u.employeeId || null, code: "already_listed" });
        else if (u.active === 0 || u.empStatus === "exited") skipped.push({ userId: u.id, employeeId: u.employeeId || null, code: "inactive" });
        else todo.push(u);
      }
      const sourceFilterId = body.sourceFilterId ? String(body.sourceFilterId).slice(0, 40) : null;
      const batch = runBatch((cur) => {
        for (const u of todo) { cur.line++; store.addSuccession({ positionName, userId: u.id, readiness: body.readiness, note: note || null, createdBy: user.id, source: "filter" }); }
        return todo.length;
      });
      if (!batch.ok) return sendBatchFailed(res, "succession.bulk", batch, { selection: true, split: true });
      afterCommit("succession.bulk-add audit", () => audit("succession.bulk-add", positionName, null, {
        position: positionName, readiness: body.readiness, created: todo.map((u) => u.employeeId), skipped: skipped.map((s) => ({ employeeId: s.employeeId, code: s.code })), sourceFilterId,
      }));
      return send(res, 200, { ok: true, created: todo.length, positionName, skipped });
    }
    const succMatch = pathname.match(/^\/api\/admin\/succession\/([\w-]+)$/);
    if (succMatch && req.method === "PUT") {
      const cur = store.getSuccession(succMatch[1]);
      if (!cur) return send(res, 404, { error: "Not found" });
      // P2 范围：按 cur.userId（这条继任记录是谁的）→ 裸 404，与上一行同形。
      if (!scopeAllowsFor(user, store.getUserById(cur.userId))) return send(res, 404, { error: "Not found" });
      if (body.readiness !== undefined && !["ready", "oneYear", "twoYears"].includes(body.readiness))
        return send(res, 400, { error: "Invalid readiness" });
      const row = store.updateSuccession(cur.id, { readiness: body.readiness, note: body.note !== undefined ? String(body.note || "").trim().slice(0, 300) || null : undefined });
      audit("succession.update", cur.positionName, { readiness: cur.readiness }, { readiness: row.readiness });
      return send(res, 200, { ok: true, entry: row });
    }
    if (succMatch && req.method === "DELETE") {
      const cur = store.getSuccession(succMatch[1]);
      if (!cur) return send(res, 404, { error: "Not found" });
      if (!scopeAllowsFor(user, store.getUserById(cur.userId))) return send(res, 404, { error: "Not found" }); // P2：按 cur.userId
      store.deleteSuccession(cur.id);
      audit("succession.remove", cur.positionName, { userId: cur.userId }, null);
      return send(res, 200, { ok: true });
    }

    // ---------- 12.2 关键岗位清单（设计 b12-design 4.3 / 4.4）----------
    // 读 talent 读；写 talent 写（RBAC order 711–714）；talent 模块关闭随 gate 404。具体路径（import/preview、import）在 /:id 之前。
    // 范围：岗位按所属部门名判定；越界的行在列表里不出现、PUT / DELETE 回 404；新部门越界回 400 dept_out_of_scope；导入有越界行整批拒绝。
    if (pathname === "/api/admin/key-positions/import/preview" && req.method === "POST") {
      const ix = orgLib.buildOrgIndex(store.listDepartments(true));
      let rows = body.rows;
      const source = body.source === "succession" || body.fromSuccession === true ? "succession" : "import";
      // 「从继任计划带入」：没有传 rows 时由服务端生成预览行（范围内继任行里出现、清单里没有的岗位；在任者部门唯一时自动填）
      if (body.fromSuccession === true && !(Array.isArray(rows) && rows.length)) {
        const sc = scopePredicate(user);
        const users = store.listUsers();
        const byId = new Map(users.map((u) => [u.id, u]));
        const succ = store.listSuccession().filter((s) => { const u = byId.get(s.userId); return !!u && (!sc || sc(u)); });
        const unmatched = KP.unmatchedSuccessionPositions(succ, store.listKeyPositions());
        const holders = users.filter((u) => u.role !== "admin" && orgLib.isInService(u) && u.position && (!sc || sc(u))).map((u) => ({ position: u.position, deptName: u.department || null }));
        rows = KP.rowsFromSuccession(unmatched, holders);
        if (!rows.length) return send(res, 200, { rows: [], summary: { create: 0, update: 0, unchanged: 0, error: 0 }, previewHash: null, source });
      }
      if (!Array.isArray(rows) || !rows.length) return send(res, 400, { error: "The file has no data rows.", error_zh: "文件中没有数据行。", code: "no_rows" });
      const v = KP.validateRows(rows, { resolveDept: (t) => kpResolveDept(ix, t), deptAllows: (d) => scopeAllowsDeptFor(user, d.name), existing: store.listKeyPositions(), rowAllows: kpRowAllows(user, ix), source });
      if (v.error) return send(res, 400, { error: `At most ${v.error.cap} rows per import (this file has ${v.error.count}).`, error_zh: `每次最多导入 ${v.error.cap} 行（本文件 ${v.error.count} 行）。`, code: "over_cap", cap: v.error.cap, count: v.error.count });
      return send(res, 200, { rows: v.rows, summary: v.summary, previewHash: v.previewHash, outOfScope: v.outOfScope, source, input: body.fromSuccession === true ? rows : undefined });
    }
    if (pathname === "/api/admin/key-positions/import" && req.method === "POST") {
      if (!Array.isArray(body.rows) || !body.rows.length) return send(res, 400, { error: "The file has no data rows.", error_zh: "文件中没有数据行。", code: "no_rows" });
      const ix = orgLib.buildOrgIndex(store.listDepartments(true));
      const source = body.source === "succession" ? "succession" : "import";
      const v = KP.validateRows(body.rows, { resolveDept: (t) => kpResolveDept(ix, t), deptAllows: (d) => scopeAllowsDeptFor(user, d.name), existing: store.listKeyPositions(), rowAllows: kpRowAllows(user, ix), source });
      if (v.error) return send(res, 400, { error: `At most ${v.error.cap} rows per import (this file has ${v.error.count}).`, error_zh: `每次最多导入 ${v.error.cap} 行（本文件 ${v.error.count} 行）。`, code: "over_cap", cap: v.error.cap, count: v.error.count });
      if (String(body.previewHash || "") !== v.previewHash)
        return send(res, 409, { error: "The data changed after the preview — the preview has been refreshed. Check it and import again.", error_zh: "预览之后数据已有变化，请重新预览核对后再导入。", code: "preview_stale" });
      if (v.outOfScope > 0) return sendScopeBulkReject(res, v.outOfScope);
      const batch = runBatch((cur) => {
        let created = 0, updated = 0;
        for (const w of v.writes) {
          cur.line = w.line;
          if (w.action === "create") { store.createKeyPosition({ name: w.name, nameKey: w.nameKey, deptId: w.deptId, deptName: w.deptName, isKey: w.isKey, note: w.note, source: w.source || source, createdBy: user.id }); created++; }
          else if (w.action === "update") { store.updateKeyPosition(w.existingId, { deptId: w.deptId, deptName: w.deptName, isKey: w.isKey, note: w.note }, user.id); updated++; }
        }
        return { created, updated };
      });
      if (!batch.ok) return sendBatchFailed(res, "keyposition.import", batch);
      const out = { created: batch.value.created, updated: batch.value.updated, unchanged: v.summary.unchanged, skipped: v.summary.error };
      afterCommit("keyposition.import audit", () => audit("keyposition.import", null, null, {
        ...out, source, entries: v.rows.map((r) => ({ line: r.line, name: r.name, dept: r.dept, action: r.action })),
      }));
      return send(res, 200, out);
    }
    if (pathname === "/api/admin/key-positions" && req.method === "GET") {
      const ix = orgLib.buildOrgIndex(store.listDepartments(true));
      const users = store.listUsers();
      const byId = new Map(users.map((u) => [u.id, u]));
      const sc = scopePredicate(user);
      const okS = kpSuccessorOk(user, byId);
      const succ = store.listSuccession();
      const cov = KP.coverageByKey(succ, okS);
      // 在任人数：同名岗位（positionKey）的范围内在职员工
      const holders = new Map();
      for (const u of users) {
        if (u.role === "admin" || !orgLib.isInService(u) || !u.position || (sc && !sc(u))) continue;
        const k = FM.positionKey(u.position);
        if (k) holders.set(k, (holders.get(k) || 0) + 1);
      }
      // 展开行的继任者：只列范围内的继任人（含已离职的，带 inService 标记）
      const succBy = new Map();
      for (const s of succ) {
        const u = byId.get(s.userId);
        if (!u || (sc && !sc(u))) continue;
        const k = FM.positionKey(s.positionName);
        if (!succBy.has(k)) succBy.set(k, []);
        succBy.get(k).push({ id: s.id, userId: u.id, name: u.name, employeeId: u.employeeId, department: u.department || null, readiness: s.readiness, inService: orgLib.isInService(u) });
      }
      const rows = kpVisible(user, ix).map((p) => {
        const c = cov.get(p.nameKey) || { ready: 0, oneYear: 0, twoYears: 0, total: 0 };
        return {
          id: p.id, name: p.name, deptId: p.deptId || null, deptName: p.deptName || null, isKey: !!p.isKey, note: p.note || null, source: p.source || null,
          createdAt: p.createdAt, updatedAt: p.updatedAt || null,
          coverage: { ready: c.ready || 0, oneYear: c.oneYear || 0, twoYears: c.twoYears || 0, total: c.total || 0 },
          best: KP.bestReadiness(c), holders: holders.get(p.nameKey) || 0, successors: succBy.get(p.nameKey) || [],
        };
      });
      const unmatched = KP.unmatchedSuccessionPositions(succ.filter((s) => { const u = byId.get(s.userId); return !!u && (!sc || sc(u)); }), store.listKeyPositions());
      return send(res, 200, { rows, unmatchedSuccessionPositions: unmatched, canWrite: canWrite(user, "talent"), limits: { nameMax: KP.NAME_MAX, noteMax: KP.NOTE_MAX, maxRows: KP.MAX_ROWS } });
    }
    if (pathname === "/api/admin/key-positions" && req.method === "POST") {
      const ix = orgLib.buildOrgIndex(store.listDepartments(true));
      const vo = KP.validateOne(body, { partial: false });
      if (!vo.ok) return kpErr(res, vo.code);
      const dr = kpDeptById(user, ix, body.deptId);
      if (dr.code) return kpErr(res, dr.code);
      const dup = store.getKeyPositionByKey(vo.value.nameKey);
      if (dup) return send(res, 409, { error: "This key position is already on the list.", error_zh: "关键岗位清单里已有这个岗位（名称只差大小写或空格也算同一岗位）。", code: "position_exists", id: kpRowAllows(user, ix)(dup) ? dup.id : null, existing: dup.name });   // existing：清单里已有的写法（B-4 / CX-019）
      const row = store.createKeyPosition({ ...vo.value, deptId: dr.dept.id, deptName: dr.dept.name, source: "manual", createdBy: user.id });
      const sc = scopePredicate(user);
      const matchedSuccession = store.listSuccession().filter((s) => FM.positionKey(s.positionName) === row.nameKey && (!sc || sc(store.getUserById(s.userId)))).length;
      audit("keyposition.create", row.name, null, KP.auditView(row));
      return send(res, 200, { ok: true, position: row, matchedSuccession });
    }
    const kpMatch = pathname.match(/^\/api\/admin\/key-positions\/([\w-]+)$/);
    if (kpMatch && req.method === "DELETE") {
      const ix = orgLib.buildOrgIndex(store.listDepartments(true));
      const cur = store.getKeyPosition(kpMatch[1]);
      if (!cur || !kpRowAllows(user, ix)(cur)) return send(res, 404, { error: "Not found" });   // 继任行不受影响（硬删除只删清单行）
      store.deleteKeyPosition(cur.id);
      audit("keyposition.delete", cur.name, KP.auditView({ ...cur, deptName: kpDeptNameOf(cur, ix) }), null);
      return send(res, 200, { ok: true });
    }
    if (kpMatch && req.method === "PUT") {
      const ix = orgLib.buildOrgIndex(store.listDepartments(true));
      const cur = store.getKeyPosition(kpMatch[1]);
      if (!cur || !kpRowAllows(user, ix)(cur)) return send(res, 404, { error: "Not found" });
      const curView = { ...cur, deptName: kpDeptNameOf(cur, ix) };
      const vo = KP.validateOne(body, { partial: true });
      if (!vo.ok) return kpErr(res, vo.code);
      const patch = { ...vo.value };
      if (body.deptId !== undefined) {
        const dr = kpDeptById(user, ix, body.deptId);
        if (dr.code) return kpErr(res, dr.code);
        patch.deptId = dr.dept.id; patch.deptName = dr.dept.name;
      }
      if (patch.nameKey && patch.nameKey !== cur.nameKey) {
        const dup = store.getKeyPositionByKey(patch.nameKey);
        if (dup && dup.id !== cur.id) return send(res, 409, { error: "This key position is already on the list.", error_zh: "关键岗位清单里已有这个岗位（名称只差大小写或空格也算同一岗位）。", code: "position_exists", id: kpRowAllows(user, ix)(dup) ? dup.id : null, existing: dup.name });   // existing：清单里已有的写法（B-4 / CX-019）
      }
      const row = store.updateKeyPosition(cur.id, patch, user.id);
      const sc = scopePredicate(user);
      const matchedSuccession = store.listSuccession().filter((s) => FM.positionKey(s.positionName) === row.nameKey && (!sc || sc(store.getUserById(s.userId)))).length;
      audit("keyposition.update", row.name, KP.auditView(curView), KP.auditView({ ...row, deptName: kpDeptNameOf(row, ix) }));
      return send(res, 200, { ok: true, position: row, matchedSuccession });
    }

    // --- talent review (Phase 2): 9-box grid + cross-people record search ---
    // Grid rows: every non-admin active employee with their latest performance
    // rating (bucketed via the configured options order) and potential.
    if (pathname === "/api/admin/talent-review" && req.method === "GET") {
      // 第二批 2.4（2026-10-08）：?cycle= 选绩效来源。缺省或 latest = 每人最近一条绩效记录（原口径，M3）；否则须是已关闭的
      // 评估周期（不存在或未关闭 → 404 cycle_not_found），评级读该周期归档进档案的那条记录（review_items.recordId →
      // talent_records.detail.rating，不读 finalRating —— 2.6 改过的评级才会生效；归档记录已删的人这一期没有评级）。
      // performance 模块关闭时忽略这个参数（没有周期可选）。
      const trPerfOn = !!modulesOn().performance;
      const trCycleRaw = trPerfOn ? String(query.get("cycle") || "").trim() : "";
      let trCycle = null;
      if (trCycleRaw && trCycleRaw !== "latest") {
        trCycle = store.getReviewCycle(trCycleRaw);
        if (!trCycle || trCycle.status !== "closed")
          return send(res, 404, { error: "Review cycle not found, or it isn't closed yet. 未找到该评估周期，或该周期尚未关闭。", code: "cycle_not_found" });
      }
      // F60：顶部筛选由服务端判定（modules/talent/review-scope.js，与其余页签同一口径）。rows 仍是数据范围内的全部人员
      // （下拉选项、继任录入的人员列表都从它推出），每行 inScope 标明是否在页面范围内；九宫格与未定位名单只取 inScope 的行。
      const trPage = trScopeOfQuery(user, query);
      // 人员行与分桶：nineBoxRows（12.2 抽出，工作台九宫格缩略用同一函数；数据范围过滤的说明在函数里）
      const rows = nineBoxRows(user, trCycle, (u) => ({ inScope: !trPage.pred || trPage.pred(u) }));
      const f = store.listRecordFields("performance").find((x) => x.key === "rating");
      // source = 本次用的来源（"latest" 或周期 id）；sourceCycles = 可选的已关闭周期（新的在前；performance 关闭时为空）
      const sourceCycles = !trPerfOn ? [] : store.listReviewCycles().filter((c) => c.status === "closed")
        .sort((a, b) => String(b.closedAt || b.createdAt || "").localeCompare(String(a.closedAt || a.createdAt || "")))
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind || "quarter", flow: c.flow || null, closedAt: c.closedAt || null }));
      return send(res, 200, { rows, ratingOptions: f ? f.options : [], ratingOptions_zh: f ? optionsZhOf(f) : [], source: trCycle ? trCycle.id : "latest", sourceCycles, scoped: trPage.active });
    }
    // Cross-people search: employees having ≥1 record of `type` matching every
    // given field=value pair. Also returns per-field value facets for the type.
    if (pathname === "/api/admin/talent-search" && req.method === "POST") {
      const t = resolveRecordType(body.type);
      if (!t) return send(res, 400, { error: "Unknown record type" });
      // 所属模块关闭的类型（culture 关闭时的「行为实践」，见 RECORD_TYPE_MODULE）不能检索：界面的类型下拉按 moduleOff 不列出，
      // 直接调接口同样拒绝（2026-09-28 第三批 R-363 / G-15）。已有记录在档案时间线照常显示，不受影响。
      if (recordTypeModuleOff(t.key)) return send(res, 400, RECORD_TYPE_UNAVAILABLE);
      const want = body.fields && typeof body.fields === "object" ? body.fields : {};
      const wantKeys = Object.keys(want).filter((k) => want[k] !== undefined && want[k] !== null && want[k] !== "");
      /* P2 范围：一处过滤，三个出口同时收口 —— records 是 results[]、facets 与 total
         的**共同上游**，所以在这里按记录归属人过滤一次，results/total/facets 三个都
         自动按范围重算，不会出现「results 收窄了但 facets 还在列范围外记录的取值」
         这种分叉。facets 也过滤是刻意的：一个 filterable 字段的取值分布本身就是情报
         （比如「违规-严重度」里出现了 major，就说明范围外有人被记过重大违规）。
         这条是 POST 但按读判定（W3 白名单里的纯查询），范围口径与读端点一致。 */
      const tsScope = scopePredicate(user);
      const records = store.listTalentRecordsByType(t.key)
        .filter((r) => !tsScope || tsScope(store.getUserById(r.userId)));
      // Facet values stay CANONICAL (options[i]) — they are matched exactly
      // against detail below, so localizing them here would break every filter.
      // The display name is the client's job: pair the value with the field's
      // options/options_zh by index and show the one for the current language.
      const facets = {};
      for (const f of store.listRecordFields(t.key).filter((x) => x.filterable)) {
        facets[f.key] = [...new Set(records.map((r) => r.detail[f.key]).filter((v) => v !== undefined && v !== null && v !== "").map(String))];
      }
      // The posted filter value gets the same normalization as a write: details
      // hold canonical values, so a Chinese display name ("通过") would match
      // nothing at all — silently, which reads as "this search is broken".
      const fieldByKey = {};
      for (const f of store.listRecordFields(t.key)) fieldByKey[f.key] = f;
      const wantCanon = {};
      for (const k of wantKeys) {
        const f = fieldByKey[k];
        const raw = String(want[k]);
        const canon = f ? canonOption(f, raw) : raw;
        wantCanon[k] = canon === null ? raw : String(canon);
      }
      const byUser = new Map();
      for (const r of records) {
        if (!wantKeys.every((k) => String(r.detail[k] ?? "") === wantCanon[k])) continue;
        if (!byUser.has(r.userId)) byUser.set(r.userId, []);
        byUser.get(r.userId).push({ date: r.date, title: r.title });
      }
      const results = [];
      for (const [uid, matches] of byUser) {
        const u = store.getUserById(uid);
        if (!u) continue;
        results.push({
          id: u.id, name: u.name, employeeId: u.employeeId, department: u.department || null,
          jobLevel: u.jobLevel || null, active: u.active !== 0, matches: matches.slice(0, 5), matchCount: matches.length,
        });
      }
      results.sort((a, b) => b.matchCount - a.matchCount);
      return send(res, 200, { results, facets, total: results.length });
    }

    // ---------- 第五批 8.1 人才筛选（设计第 4、6、7、8 节；路由与 RBAC 见 modules/talent/manifest.js order 741–749）----------
    // 具体路径（catalog / run / export / ai-parse / members）写在 /talent-filters/:id 之前。看不到的筛选 id 一律 404。
    if (pathname === "/api/admin/talent-filters/catalog" && req.method === "GET") {
      const t = tfContext(user);
      return send(res, 200, tfCatalogOut(t.catalog));
    }
    // 运行（readonly：纯查询，不写库不落审计）。只带 filterId = 用库里保存的定义（宽松校验）；带 definition = 按它运行（严格校验），
    // 同时带了内置筛选的 filterId 时用它的人工名单（编辑未保存的内置筛选）。idsOnly = 「选择全部结果」，最多 200 个 id。
    const tfRunOrExport = (isExport) => {
      // isExport：POST /talent-filters/export（两条路由共用这段，分支见下面两行 pathname === …）
      // 导出与「人才记录 CSV」同一判定（people 读，canExportTalentRecords 唯一判定处；负责人 2026-10-08 确认）
      if (isExport && !canExportTalentRecords(user)) return send(res, 403, RECORDS_EXPORT_FORBIDDEN);
      // F60：结果 = 页面顶部筛选（body.scope）∩ 筛选条件；run、idsOnly、export 同一口径
      const page = trScopeOfBody(user, body);
      const t = tfContext(user, { page });
      let saved = null;
      if (body.filterId !== undefined && body.filterId !== null && body.filterId !== "") {
        saved = tfVisible(t, String(body.filterId));
        if (!saved) return send(res, 404, { error: "Filter not found.", error_zh: "未找到该筛选。", code: "not_found" });
      }
      let def;
      if (body.definition !== undefined && body.definition !== null) {
        const v = FM.validateFilter(body.definition, t.catalog);
        if (!v.ok) return tfInvalid(res, v.errors);
        def = v.filter;
      } else if (saved) {
        const v = FM.validateFilter(saved.definition, t.catalog, { lenient: true });
        def = v.filter || v.normalized;
      } else return send(res, 400, { error: "Send a filter definition or a saved filter id.", error_zh: "请提供筛选条件或已保存筛选的编号。", code: "filter_required" });
      const members = saved && saved.builtinKey ? store.listTalentFilterMembers(saved.id) : [];
      const columns = FM.normalizeColumns(Array.isArray(body.columns) && body.columns.length ? body.columns : saved ? saved.columns : null, t.catalog);
      const sort = tfSortOf(t, body.sort !== undefined ? body.sort : saved ? saved.sort : null);
      if (isExport) {
        const lang = body.lang === "en" ? "en" : "zh";
        const r = tfExecute(t, def, { members, columns, sort, all: true });
        const viewDef = tfRedact(t, def).definition;
        const summary = FM.summarize(viewDef, t.catalog, lang);
        const rows = FE.csvRows({ rows: r.rows, columns: r.columns, catalog: t.catalog, lang, summary, columnMeta: r.columnMeta });
        const nm = saved ? (lang === "en" ? saved.name || saved.name_zh : saved.name_zh || saved.name) : "adhoc";
        const base = String(nm || "adhoc").trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "adhoc";
        const fname = `talent-filter-${base}-${todayLocal().replace(/-/g, "")}.csv`;
        const ascii = fname.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
        audit("export.talent-filter", saved ? saved.id : null, null, { rows: r.rows.length, columns: r.columns, filterId: saved ? saved.id : null, summary, ...(page.active ? { pageScope: page.f } : {}) });
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fname)}` });
        return res.end(csvText(rows));
      }
      const r = tfExecute(t, def, { members, columns, sort, page: body.page, pageSize: body.pageSize, explain: !!body.explain, idsOnly: !!body.idsOnly });
      if (body.idsOnly) return send(res, 200, { ids: r.ids || [], total: r.matchedTotal, truncated: !!r.truncated, scoped: page.active });
      return send(res, 200, {
        scoped: page.active,
        total: r.total, matchedTotal: r.matchedTotal, page: r.page, pageSize: r.pageSize, columns: r.columns, columnMeta: r.columnMeta,
        rows: r.rows.map((row) => tfRowOut(t, row)), skipped: r.skipped, warnings: r.warnings,
        ...(r.unmapped ? { unmapped: r.unmapped } : {}), ...(r.explainHeads ? { explainHeads: r.explainHeads } : {}),
      });
    };
    if (pathname === "/api/admin/talent-filters/run" && req.method === "POST") {
      return tfRunOrExport(false);
    }
    if (pathname === "/api/admin/talent-filters/export" && req.method === "POST") {
      return tfRunOrExport(true);
    }
    // AI 一句话转条件（设计第 8 节；功能 talentFilter，按 talent 写判定）。发给模型的只有 HR 那句话（花名册脱敏）与字段目录；
    // 部门、培训项目、人才标签由服务端在当前管理员的范围内匹配；结果再过与手工条件同一个 validateFilter；不自动执行。原文不入库。
    if (pathname === "/api/admin/talent-filters/ai-parse" && req.method === "POST") {
      const st = AI.featureState("talentFilter");
      if (st.state === "off_module" || st.state === "off_owner") return sendAiState(res, st);
      const text = String(body.text || "").trim();
      if (!text) return send(res, 400, { error: "Describe the people you are looking for.", error_zh: "请描述要找的人员。", code: "text_required" });
      if (text.length > AI_TF.MAX_TEXT) return send(res, 400, { error: `Keep the description within ${AI_TF.MAX_TEXT} characters.`, error_zh: `描述请控制在 ${AI_TF.MAX_TEXT} 字以内。`, code: "text_too_long" });
      if (st.state !== "on" && st.state !== "demo") return sendAiState(res, st);
      const lang = body.lang === "zh" || body.lang === "en" ? body.lang : (/^zh/i.test(String(req.headers["accept-language"] || "")) ? "zh" : "en");
      const refId = body.filterId ? String(body.filterId).slice(0, 40) : null;
      const t = tfContext(user);
      const catalog = t.catalog;
      let processed, callId = null;
      if (st.state === "demo") {
        processed = AI_TF.talentFilterDemo(text, catalog, { lang });
        callId = AI.recordLocal("talentFilter", { requestId, actorId: user.id, actorKind: "admin", refId, status: "demo" });
      } else {
        const rl = AI.rateHit("talentFilter", user.id);
        if (!rl.ok) {
          AI.recordLocal("talentFilter", { requestId, actorId: user.id, actorKind: "admin", refId, status: "blocked", errorCode: "ai_rate_limited" });
          return sendAiRateLimited(res, rl.retryAfterSec);
        }
        const built = aiFeatures.buildTalentFilter({ text, catalog, roster: aiRoster() });
        try {
          const out = await AI.call("talentFilter", { requestId, actorId: user.id, actorKind: "admin", refId, system: built.system, messages: built.messages, schema: built.schema, semantic: built.semantic, redactions: built.redactions });
          callId = out.callId;
          processed = aiFeatures.processTalentFilter(out.json, catalog, { lang });
        } catch (e) {
          return sendAiError(res, e);
        }
      }
      const fin = aiFeatures.finalizeTalentFilter({ processed, sources: t.sources(), validate: (f) => FM.validateFilter(f, catalog), lang, catalog });
      return send(res, 200, {
        demo: st.state === "demo", callId, filter: FM.normalizeFilter(fin.filter, catalog),
        choices: fin.choices, unsupported: fin.unsupported, pendingLeafIds: fin.pendingLeafIds,
      });
    }
    if (pathname === "/api/admin/talent-filters" && req.method === "GET") {
      const t = tfContext(user);
      const filters = store.listTalentFilters().filter((f) => FM.canSeeFilter(f, t.viewer)).map((f) => tfFilterOut(t, f, false).filter);
      return send(res, 200, { filters });
    }
    // 新建 / 另存为：每人最多 50 条私有、全公司最多 200 条共享；名称在同一可见范围内不重复（不分大小写，中英文名分别判断）
    if (pathname === "/api/admin/talent-filters" && req.method === "POST") {
      const t = tfContext(user);
      const name = String(body.name || "").trim(), name_zh = String(body.name_zh || "").trim();
      if (!name && !name_zh) return send(res, 400, { error: "Give the filter a name.", error_zh: "请填写筛选名称。", code: "name_required" });
      if (name.length > FM.LIMITS.nameLength || name_zh.length > FM.LIMITS.nameLength) return send(res, 400, { error: `A name can be at most ${FM.LIMITS.nameLength} characters.`, error_zh: `名称最多 ${FM.LIMITS.nameLength} 字。`, code: "name_too_long" });
      const visibility = body.visibility === "shared" ? "shared" : "private";
      const v = FM.validateFilter(body.definition, t.catalog);
      if (!v.ok) return tfInvalid(res, v.errors);
      const list = store.listTalentFilters();
      const quota = visibility === "shared" ? list.filter((f) => !f.builtinKey && f.visibility === "shared").length >= FM.LIMITS.sharedTotal
        : list.filter((f) => !f.builtinKey && f.visibility === "private" && f.ownerId === user.id).length >= FM.LIMITS.privatePerUser;
      if (quota) return send(res, 400, { error: "You have reached the limit of saved filters — delete some first.", error_zh: "已保存的筛选已达上限，请先删除不用的筛选。", code: "too_many_filters" });
      const cand = { name: name || name_zh, name_zh: name_zh || null, visibility, ownerId: user.id };
      const clash = FM.nameConflict(list, cand, t.viewer);
      if (clash) return send(res, 400, { error: "A filter with this name already exists.", error_zh: "已有同名的筛选。", code: "name_taken", field: clash });
      const created = store.createTalentFilter({
        id: "tf-" + crypto.randomBytes(5).toString("hex"), ...cand, definition: v.filter,
        columns: FM.normalizeColumns(body.columns, t.catalog).filter((c) => c !== "member"), sort: tfSortOf(t, body.sort), updatedBy: user.id,
      });
      audit("talent.filter.create", created.id, null, { name: created.name, name_zh: created.name_zh, visibility, summary: FM.summarize(created.definition, t.catalog, "en") });
      return send(res, 200, { filter: tfFilterOut(t, created, true).filter });
    }
      return S.ROUTE_NEXT;
    },
  };
};
